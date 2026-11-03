#!/usr/bin/env node
/*
 * deck-remote — phone remote control for a Google Slides / PDF deck open in Chrome.
 *
 * How it works:
 *   1. Attaches to Chrome over the DevTools protocol (--remote-debugging-port),
 *      or launches its own Chromium window if no debug port is open.
 *   2. Setup pass: flips through the whole deck once, screenshotting every slide.
 *      OCR (tesseract.js) turns the biggest text of each slide into keywords:
 *      1–7 words for a slide, 1 word used as the "next slide" hint.
 *   3. Runtime: polls the tab (URL fragment for PDFs, perceptual screenshot hash
 *      for Google Slides) so the phone stays in sync even if you advance from
 *      the laptop keyboard. Phone buttons dispatch real key events to the tab.
 *   4. Serves a mobile web app + WebSocket on the LAN and prints a QR code.
 *
 * Usage: node server.js [--url <substring-or-url>] [--port 8675] [--pin 1234]
 *                       [--debug-port 9222] [--headless] [--list-tabs]
 *                       [--chrome-path /path/to/chrome] [--user-data-dir DIR]
 */

'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const readline = require('readline');
const WebSocket = require('ws');
const sharp = require('sharp');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

/* ------------------------------- args ---------------------------------- */

function parseArgs(argv) {
  const A = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) A[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { A[a.slice(2)] = argv[i + 1]; i++; }
      else A[a.slice(2)] = true;
    } else A._.push(a);
  }
  return A;
}

const A = parseArgs(process.argv.slice(2));
const PORT = parseInt(A.port || '8675', 10);
const DEBUG_PORT = parseInt(A['debug-port'] || '9222', 10);
const PIN = typeof A.pin === 'string' && A.pin.length ? A.pin : null;

// --url can be: an absolute URL (http/https/file), a path to a local file
// (pdf/html), or a plain substring matched against open tab URLs.
const { pathToFileURL } = require('url');
function normalizeUrlArg(v) {
  if (!v || typeof v !== 'string') return null;
  if (/^(https?:|file:)/.test(v)) return v;
  const expanded = v.startsWith('~') ? path.join(os.homedir(), v.slice(1)) : v;
  for (const cand of [path.resolve(expanded)]) {
    try { if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return pathToFileURL(cand).href; } catch {}
  }
  return v;
}
const URL_FILTER = normalizeUrlArg(A.url || A._[0] || null);
const PROFILE_DIR = A['user-data-dir'] || path.join(os.homedir(), 'deck-remote-chrome-profile');

const HASH_MATCH_T = 16;   // hamming distance under which two dHashes are "same slide"
const HASH_DIFF_T = 16;    // distance above which two captures are "different"
// calibrated on title-style slides: same slide re-capture ≈ 0–4, different
// slides ≥ 21 at 16×16 (256-bit) dHash, so 16 splits both with margin
const TESS_CACHE = path.join(__dirname, '.tess-cache');

const log = (...m) => console.log(new Date().toTimeString().slice(0, 8), ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- state --------------------------------- */

const state = {
  mode: null,            // 'pdf' | 'deck'
  pdfOk: false,          // pdf fragment navigation verified working
  ready: false,
  indexing: false,
  progress: { done: 0, total: null },
  current: -1,
  total: 0,
  firstNextAt: null,     // timer starts on first "next" from a phone
  slides: [],            // { hashHex, shot(Buffer|null), keywords:[], next, ocr:'pending'|'done'|'fail' }
  tab: null,
};

let cdp = null;
let launchedChrome = null;
let tessWorker = null;
let lastActionAt = 0;
let vlm = null;

/* ------------------------------ CDP ------------------------------------ */

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.readyP = new Promise((res, rej) => {
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) {
          try { fn(msg.params || {}); } catch {}
        }
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function evalJS(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, returnByOnly: false });
  if (r.exceptionDetails) throw new Error('page eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
}

async function viewport() {
  const v = await evalJS('JSON.stringify([innerWidth, innerHeight])');
  const [w, h] = JSON.parse(v);
  return { w, h };
}

const KEYS = {
  ArrowRight: 39, ArrowLeft: 37, PageDown: 34, PageUp: 33, Home: 36, End: 35,
};

async function sendKey(name) {
  const vk = KEYS[name];
  if (!vk) throw new Error('unknown key ' + name);
  const base = { key: name, code: name, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function capture({ scale, quality }) {
  const vp = await viewport();
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'jpeg', quality,
    clip: { x: 0, y: 0, width: vp.w, height: vp.h, scale },
  });
  return Buffer.from(r.data, 'base64');
}

const smallShot = () => capture({ scale: 0.3, quality: 60 });   // for hashing
const bigShot = () => capture({ scale: 0.5, quality: 85 });     // for OCR

/* --------------------------- image hashing ----------------------------- */

const HASH_W = 16, HASH_H = 16; // 256-bit dHash

async function dhashOf(buf) {
  const { data } = await sharp(buf).removeAlpha().greyscale().resize(HASH_W + 1, HASH_H, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let hex = '';
  for (let r = 0; r < HASH_H; r++) {
    let b = 0;
    for (let c = 0; c < HASH_W; c++) b = (b << 1) | (data[r * (HASH_W + 1) + c] > data[r * (HASH_W + 1) + c + 1] ? 1 : 0);
    hex += b.toString(16).padStart(4, '0');
  }
  return hex;
}

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];

function hamming(aHex, bHex) {
  let d = 0;
  for (let i = 0; i < aHex.length; i += 2) d += POPCOUNT[(parseInt(aHex.substr(i, 2), 16) ^ parseInt(bHex.substr(i, 2), 16)) & 255];
  return d;
}

function nearestSlide(hashHex) {
  let best = -1, bestD = 1e9;
  for (let i = 0; i < state.slides.length; i++) {
    const d = hamming(hashHex, state.slides[i].hashHex);
    if (d < bestD) { bestD = d; best = i; }
  }
  return bestD <= HASH_MATCH_T ? best : -1;
}

/* ------------------------- screencast tracking -------------------------- */
/* Page.captureScreenshot makes fullscreen Chrome flash on macOS, so live
 * tracking uses Page.startScreencast instead: Chrome pushes a jpeg frame only
 * when the page repaints. Frames are the single hash/description source when
 * available; captureScreenshot is the fallback for browsers without it. */

const screen = {
  mode: 'unknown',      // 'frames' | 'captures'
  active: false,        // any frame received
  lastHash: null,
  lastFrameAt: 0,
  lastBuf: null,
  frameCount: 0,
};

async function startScreencast() {
  if (A['no-screencast']) { screen.mode = 'captures'; return; }
  cdp.on('Page.screencastFrame', (p) => {
    screen.frameCount++;
    screen.lastFrameAt = Date.now();
    screen.lastBuf = Buffer.from(p.data, 'base64');
    screen.active = true;
    dhashOf(screen.lastBuf).then((h) => { screen.lastHash = h; }).catch(() => {});
    cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  });
  try {
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1,
    });
  } catch {
    screen.mode = 'captures';
    log('Screencast not available — falling back to screenshot polling (may flash in fullscreen).');
    return;
  }
  // Chrome pushes one frame right away; wait briefly for it.
  for (let i = 0; i < 12 && !screen.active; i++) await sleep(250);
  screen.mode = screen.active ? 'frames' : 'captures';
  if (screen.active) log('Screencast tracking active — zero forced captures, no fullscreen flashing.');
  else {
    try { await cdp.send('Page.stopScreencast'); } catch {}
    log('No screencast frames — falling back to screenshot polling (may flash in fullscreen).');
  }
}

/* Hash of whatever is currently on screen. Passive in frames mode. */
async function pollHash() {
  if (screen.mode === 'frames') return screen.lastHash;
  return dhashOf(await smallShot());
}

/* In frames mode: wait until the frame stream has been quiet (stable slide).
 * Returns { hash, buf } for hashing and descriptions. */
async function stableView({ settleMs = 550, timeoutMs = 4000 } = {}) {
  if (screen.mode !== 'frames') {
    return { hash: await stableHash(), buf: await bigShot().catch(() => null) };
  }
  const t0 = Date.now();
  let lastSeen = -1;
  while (Date.now() - t0 < timeoutMs) {
    if (screen.frameCount !== lastSeen) { lastSeen = screen.frameCount; await sleep(settleMs); continue; }
    if (screen.lastHash && screen.lastBuf && Date.now() - screen.lastFrameAt >= settleMs - 150) {
      return { hash: screen.lastHash, buf: screen.lastBuf };
    }
    await sleep(120);
  }
  return screen.lastHash ? { hash: screen.lastHash, buf: screen.lastBuf } : null;
}

/* ------------------------------- OCR ----------------------------------- */

const STOPWORDS = new Set('the a an and or of to in on for with from by at as is are be been was were our your their we you it its this that these those will can shall not but if then than so such'.split(' '));

function extractWords(data) {
  const out = [];
  const push = (w) => {
    if (w && typeof w.text === 'string' && w.bbox) {
      const t = w.text.trim();
      if (t) out.push({ text: t, conf: w.confidence == null ? 100 : w.confidence, x: w.bbox.x0, y: w.bbox.y0, h: w.bbox.y1 - w.bbox.y0 });
    }
  };
  if (Array.isArray(data.words) && data.words.length) {
    data.words.forEach(push);
  } else if (Array.isArray(data.blocks)) {
    for (const b of data.blocks)
      for (const p of b.paragraphs || [])
        for (const l of p.lines || [])
          for (const w of l.words || []) push(w);
  }
  return out;
}

function describeSlide(words) {
  const cand = words
    .filter((w) => w.conf >= 50 && /[A-Za-z0-9]/.test(w.text))
    .map((w) => ({ ...w, t: w.text.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '') }))
    .filter((w) => w.t.length > 0);
  if (!cand.length) return { keywords: [], next: null };
  const hs = cand.map((w) => w.h).sort((a, b) => a - b);
  const mh = hs[Math.floor(hs.length / 2)] || 1;

  let big = cand.filter((w) => w.h >= mh * 1.35);
  if (big.length < 2) big = cand.slice().sort((a, b) => b.h - a.h).slice(0, 6);

  // cluster the big words into lines by vertical position
  big.sort((a, b) => a.y - b.y);
  const lines = [];
  for (const w of big) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(w.y - L.y) <= Math.max(mh * 0.7, 6)) { L.words.push(w); L.y = (L.y * (L.words.length - 1) + w.y) / L.words.length; }
    else lines.push({ y: w.y, words: [w] });
  }
  // title line = biggest average word height (ties → topmost)
  let best = null;
  for (const L of lines) {
    const avg = L.words.reduce((s, w) => s + w.h, 0) / L.words.length;
    const score = avg * 1000 - L.y;
    if (!best || score > best.score) best = { score, L };
  }
  const tw = best.L.words.slice().sort((a, b) => a.x - b.x).map((w) => w.t);
  const keywords = tw.slice(0, 4); // 1–4 words, same contract as the VLM describer
  const next = tw.find((t) => !STOPWORDS.has(t.toLowerCase())) || tw[0];
  return { keywords, next };
}

async function ocr(buf) {
  if (!tessWorker) {
    const { createWorker } = require('tesseract.js');
    fs.mkdirSync(TESS_CACHE, { recursive: true }); // tesseract's writeCache won't create it
    const cached = fs.existsSync(path.join(TESS_CACHE, 'eng.traineddata'));
    if (!cached) log('Loading OCR engine (first run downloads the language model, ~10 MB)…');
    tessWorker = await createWorker('eng', 1, { cachePath: TESS_CACHE });
  }
  const { data } = await tessWorker.recognize(buf, {}, { blocks: true, text: true });
  return extractWords(data);
}

async function ocrLoop() {
  for (;;) {
    if (vlm && !vlm.healthy) { await sleep(500); continue; } // gemma still loading — don't waste slides on fallback OCR
    let i = state.slides.findIndex((s) => s.ocr === 'pending' && s.shot);
    const cur = state.current; // prioritize whatever is on screen now
    if (state.slides[cur] && state.slides[cur].ocr === 'pending' && state.slides[cur].shot) i = cur;
    if (i < 0) { await sleep(400); continue; }
    const sl = state.slides[i];
    if (!sl.shot) { sl.ocr = 'fail'; continue; }
    let desc = null;
    if (vlm && vlm.healthy) {
      try {
        const text = await vlm.describeResilient(sl.shot);
        desc = { keywords: text.split(' '), next: text.split(' ')[0] };
        log(`Gemma described slide ${i + 1}: “${text}”`);
      } catch (e) {
        log(`VLM failed on slide ${i + 1} (${e.message}) — using built-in OCR.`);
      }
    }
    if (!desc) {
      try {
        desc = describeSlide(await ocr(sl.shot));
        log(`OCR described slide ${i + 1}: “${desc.keywords.join(' ')}”`);
      } catch {
        desc = { keywords: [], next: null };
      }
    }
    sl.keywords = desc.keywords;
    sl.next = desc.next || (desc.keywords[0] || null);
    sl.ocr = 'done';
    sl.shot = null;
    broadcast();
  }
}

/* ------------------------- deck indexing ------------------------------- */

async function stableHash() {
  let prev = null, h = null;
  for (let i = 0; i < 15; i++) {
    h = await dhashOf(await smallShot());
    if (prev !== null && hamming(h, prev) <= 3) return h;
    prev = h;
    await sleep(140);
  }
  return h;
}

async function captureSlide() {
  const v = await stableView();
  if (!v) { state.slides.push({ hashHex: 'x', shot: null, keywords: [], next: null, ocr: 'fail' }); return; }
  state.slides.push({ hashHex: v.hash, shot: v.buf, keywords: [], next: null, ocr: 'pending' });
}

async function advanceAndWaitChange(beforeHex) {
  await sendKey('ArrowRight');
  const t0 = Date.now();
  while (Date.now() - t0 < 1700) {
    await sleep(screen.mode === 'frames' ? 120 : 150);
    const h = await pollHash();
    if (h && hamming(h, beforeHex) > HASH_DIFF_T) return true;
  }
  return false;
}

async function readPdfPage() {
  try {
    const href = await evalJS('location.href');
    const m = /#page=(\d+)/.exec(href || '');
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

async function gotoPdfPage(p) {
  try { await evalJS(`location.hash = '#page=${p}'`); } catch {}
  for (let t = 0; t < 30; t++) {
    await sleep(30);
    if ((await readPdfPage()) === p) return true;
  }
  return false;
}

async function indexDeck() {
  state.indexing = true;
  state.progress = { done: 0, total: null };
  broadcast();
  log('Indexing deck (one automatic pass through all slides)…');

  if (state.mode === 'pdf') {
    // figure out page count by jumping to the last page
    await sendKey('End');
    await sleep(900);
    const last = await readPdfPage();
    if (last) {
      state.pdfOk = await gotoPdfPage(1);
      if (state.pdfOk && last >= 2) {
        // verify fragment navigation actually moves the view (not just the URL)
        const v1 = await stableView({ settleMs: 400 });
        await gotoPdfPage(2);
        const v2 = await stableView({ settleMs: 500, timeoutMs: 3000 });
        state.pdfOk = !!(v1 && v2 && hamming(v1.hash, v2.hash) > HASH_DIFF_T);
        if (!state.pdfOk) log('PDF fragment navigation does not move the view — falling back to keys.');
      }
      if (state.pdfOk) {
        state.total = last;
        for (let p = 1; p <= last; p++) {
          await gotoPdfPage(p);
          await sleep(160);
          await captureSlide();
          state.progress = { done: p, total: last };
          broadcast();
        }
        await gotoPdfPage(1);
        await sleep(250);
        state.current = 0;
        finishIndexing();
        return;
      }
      log('PDF fragment navigation not available — falling back to key navigation.');
    }
  }

  // sequential pass (Google Slides, HTML decks, PDF fallback)
  await sendKey('Home');
  await sleep(700);
  await captureSlide();
  for (let i = 1; i < 400; i++) {
    const before = state.slides[state.slides.length - 1].hashHex;
    if (!(await advanceAndWaitChange(before))) break;
    await captureSlide();
    state.progress = { done: state.slides.length, total: null };
    broadcast();
  }
  state.total = state.slides.length;

  // return to the first slide
  await sendKey('Home');
  await sleep(800);
  try {
    const h = await pollHash();
    if (h && hamming(h, state.slides[0].hashHex) > HASH_MATCH_T) {
      for (let i = 1; i < state.total; i++) { await sendKey('ArrowLeft'); await sleep(160); }
      await sleep(400);
    }
  } catch {}
  state.current = 0;
  finishIndexing();
}

function finishIndexing() {
  state.indexing = false;
  state.ready = true;
  log(`Deck ready: ${state.total} slides.`);
  broadcast();
}

/* --------------------------- runtime loop ------------------------------ */

async function pollLoop() {
  for (;;) {
    await sleep(650);
    try {
      let idx = -1;
      let frameIdx = -1;
      if (screen.mode === 'frames' && screen.lastHash) {
        frameIdx = nearestSlide(screen.lastHash); // frames arrive on every repaint; passive
      }
      if (state.mode === 'pdf' && state.pdfOk) {
        const p = await readPdfPage();
        if (p) idx = Math.min(p - 1, state.total - 1);
        if (frameIdx >= 0 && frameIdx !== idx) idx = frameIdx;
      } else if (frameIdx >= 0) {
        idx = frameIdx;
      } else if (screen.mode !== 'frames') {
        idx = nearestSlide(await dhashOf(await smallShot())); // fallback: active polling
      }
      if (idx >= 0 && idx !== state.current) {
        if (state.current >= 0) log(`Slide changed: ${state.current + 1} → ${idx + 1}`);
        state.current = idx;
        broadcast();
      }
    } catch (e) {
      // tab may be navigating; keep trying
    }
  }
}

/* ------------------------------ actions -------------------------------- */

async function doAdvance(dir) {
  if (state.mode === 'pdf' && state.pdfOk) {
    const cur = (await readPdfPage()) || state.current + 1 || 1;
    const target = Math.min(Math.max(cur + dir, 1), state.total || cur + dir);
    await gotoPdfPage(target);
    const p = await readPdfPage();
    if (p) { state.current = p - 1; broadcast(); }
    return;
  }
  await sendKey(dir > 0 ? 'ArrowRight' : 'ArrowLeft');
  const prev = state.current;
  const est = state.total ? Math.min(Math.max(prev + dir, 0), state.total - 1) : prev;
  if (est !== prev) { state.current = est; broadcast(); } // optimistic; frames correct within ~1s
  if (screen.mode === 'frames') {
    // confirm with the repaint frame the keypress should produce; revert if none
    const t0 = Date.now();
    (async () => {
      while (Date.now() - t0 < 1200) {
        if (screen.lastFrameAt > t0 && screen.lastHash) {
          const i = nearestSlide(screen.lastHash);
          if (i >= 0 && i !== state.current) { state.current = i; broadcast(); }
          return;
        }
        await sleep(100);
      }
      if (est !== prev && state.current === est) { state.current = prev; broadcast(); }
    })().catch(() => {});
  }
}

async function handleAction(a) {
  if (a === 'next' || a === 'back') {
    const now = Date.now();
    if (now - lastActionAt < 120) return;
    lastActionAt = now;
    if (a === 'next' && !state.firstNextAt) {
      state.firstNextAt = now;
      log('Talk timer started (first "next" from phone).');
    }
    try { await doAdvance(a === 'next' ? 1 : -1); } catch (e) { log('action failed:', e.message); }
    broadcast();
  } else if (a === 'reset') {
    state.firstNextAt = null;
    log('Talk timer reset.');
    broadcast();
  }
}

/* --------------------------- phone server ------------------------------ */

const wss = new WebSocket.Server({ noServer: true });

function payload() {
  const cur = state.slides[state.current] || null;
  const nxt = state.slides[state.current + 1] || null;
  return {
    type: 'state',
    mode: state.mode,
    ready: state.ready,
    indexing: state.indexing,
    progress: state.progress,
    current: state.current,
    total: state.total,
    keywords: cur ? cur.keywords : [],
    nextKeyword: nxt ? (nxt.next || (nxt.keywords[0] || null)) : null,
    firstNextAt: state.firstNextAt,
    serverNow: Date.now(),
    describer: vlm && vlm.healthy ? 'gemma-4-e4b' : 'ocr',
    tracking: screen.mode === 'frames' ? 'screencast' : 'captures',
    tabTitle: state.tab ? state.tab.title : null,
  };
}

function broadcast() {
  const s = JSON.stringify(payload());
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

function startHttpServer(listenUrls) {
  const phoneHtml = fs.readFileSync(path.join(__dirname, 'public', 'phone.html'));

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    try {
      if (u.pathname === '/' || u.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(phoneHtml);
      } else if (u.pathname === '/qr') {
        const png = await QRCode.toBuffer(listenUrls[0], { width: 480, margin: 2 });
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
      } else if (u.pathname === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...payload(), pinRequired: !!PIN }));
      } else {
        res.writeHead(404); res.end('not found');
      }
    } catch (e) {
      res.writeHead(500); res.end(String(e.message));
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname !== '/ws') return socket.destroy();
    if (PIN && u.searchParams.get('pin') !== PIN) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg && msg.a) handleAction(msg.a);
    });
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload()));
  });

  server.listen(PORT, '0.0.0.0', () => {
    log(`Phone remote listening on port ${PORT}${PIN ? ' (pin: ' + PIN + ')' : ''}`);
    for (const url of listenUrls) log('  → ' + url);
    qrcodeTerminal.generate(listenUrls[0], { small: true }, (q) => console.log(q));
    log('Scan the QR with your phone (same Wi‑Fi). Ctrl+C to quit.');
  });
}

function lanUrls() {
  const urls = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const f of ifaces[name] || []) {
      if (f.family !== 'IPv4' || f.internal) continue;
      urls.push(`http://${f.address}:${PORT}`);
    }
  }
  if (!urls.length) urls.push(`http://127.0.0.1:${PORT}`);
  // prefer typical LAN ranges first
  urls.sort((a, b) => {
    const score = (u) => /192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./.test(u) ? 0 : 1;
    return score(a) - score(b);
  });
  return urls.slice(0, 4);
}

/* --------------------------- chrome plumbing --------------------------- */

async function debugPortOpen() {
  try { const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

function findChrome() {
  if (A['chrome-path']) return A['chrome-path'];
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];
  for (const c of names) {
    try { return execFileSync('which', [c]).toString().trim(); } catch {}
  }
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/snap/bin/chromium',
  ];
  for (const p of paths) if (fs.existsSync(p)) return p;
  return null;
}

async function launchChrome() {
  const bin = findChrome();
  if (!bin) {
    console.error('No Chrome/Chromium found. Pass --chrome-path /path/to/chrome.');
    process.exit(1);
  }
  const flags = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-features=Translate',
    '--window-size=1600,900',
  ];
  if (process.platform === 'darwin') flags.push('--use-mock-keychain');
  if (A.headless) flags.push('--headless=new', '--disable-gpu', '--window-size=1280,800');
  if (URL_FILTER && /^(https?:|file:)/.test(URL_FILTER)) flags.push(URL_FILTER); // open the deck at launch (file:// can't be opened later via CDP)
  log(`Launching Chrome: ${bin}`);
  launchedChrome = spawn(bin, flags, { stdio: ['ignore', 'ignore', 'ignore'], detached: false });
  launchedChrome.on('exit', (code) => { log('Chrome exited (' + code + ').'); });
  for (let i = 0; i < 50; i++) {
    if (await debugPortOpen()) return;
    await sleep(400);
  }
  console.error('Chrome did not open the debug port in time.');
  process.exit(1);
}

async function listTabs() {
  const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const all = await r.json();
  return all.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
}

async function openTab(url) {
  let res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).catch(() => null);
  if (!res || !res.ok) res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'POST' }).catch(() => null);
  if (!res || !res.ok) throw new Error('could not open a new tab (is another Chrome using the port?)');
  await res.json();
}

async function pickTab() {
  let tabs = await listTabs();
  if (URL_FILTER && /^https?:|^file:/.test(URL_FILTER) && !tabs.some((t) => t.url === URL_FILTER || t.url.includes(URL_FILTER))) {
    if (/^file:/.test(URL_FILTER)) {
      console.error(`The file isn't open in the attached Chrome yet, and Chrome only allows\n` +
        `file:// tabs to be opened at launch. Quit Chrome fully and let deck-remote\n` +
        `launch it (don't start Chrome with the debug port yourself), or open the\n` +
        `file manually in that Chrome window and re-run deck-remote.`);
      process.exit(1);
    }
    try { await openTab(URL_FILTER); await sleep(1200); tabs = await listTabs(); }
    catch { console.error('Could not open a new tab for ' + URL_FILTER); }
  }
  if (URL_FILTER) {
    const m = tabs.filter((t) => t.url.includes(URL_FILTER));
    if (m.length) return m[0];
    console.error(`No open tab matches --url "${URL_FILTER}". Open tabs:`);
    tabs.forEach((t, i) => console.error(`  ${i + 1}. ${t.title} — ${t.url}`));
    process.exit(1);
  }
  tabs = tabs.filter((t) => !t.url.startsWith('chrome://') || t.url === 'chrome://newtab/');
  if (tabs.length === 1) return tabs[0];
  if (!process.stdin.isTTY) {
    console.error('Multiple tabs open; pass --url <part-of-url> to choose. Open tabs:');
    tabs.forEach((t, i) => console.error(`  ${i + 1}. ${t.title} — ${t.url}`));
    process.exit(1);
  }
  console.log('\nOpen tabs:');
  tabs.forEach((t, i) => console.log(`  ${i + 1}. ${t.title} — ${t.url}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const n = await new Promise((res) => rl.question('Which tab is the deck? [1] ', (a) => { rl.close(); res(parseInt(a || '1', 10)); }));
  return tabs[Math.min(Math.max(n - 1, 0), tabs.length - 1)];
}

/* ------------------------------- main ---------------------------------- */

async function main() {
  console.log('deck-remote — phone remote for Chrome decks\n');

  if (A['list-tabs']) {
    if (!(await debugPortOpen())) { console.error('Debug port not open on ' + DEBUG_PORT); process.exit(1); }
    (await listTabs()).forEach((t, i) => console.log(`  ${i + 1}. ${t.title} — ${t.url}`));
    return;
  }

  if (!(await debugPortOpen())) await launchChrome();
  else log(`Attaching to Chrome on debug port ${DEBUG_PORT}.`);

  const tab = await pickTab();
  state.tab = tab;
  log(`Controlling tab: ${tab.title}\n            ${tab.url}`);

  state.mode = /\.pdf(\?.*)?($|#)/i.test(tab.url) ? 'pdf' : 'deck';
  log(`Mode: ${state.mode === 'pdf' ? 'PDF' : 'web deck (keys + screenshots)'}`);
  if (/docs\.google\.com\/presentation/.test(tab.url) && !/\/present/.test(tab.url)) {
    log('⚠ Google Slides detected in EDIT mode. Start presentation mode (⌘/Ctrl+F5) and restart deck-remote.');
  }

  cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.readyP;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await startScreencast();

  startHttpServer(lanUrls());

  if (!A['no-vlm']) {
    const { Vlm } = require('./lib/vlm');
    vlm = new Vlm({
      url: typeof A['vlm-url'] === 'string' ? A['vlm-url'] : undefined,
      port: A['vlm-port'],
      binary: typeof A['llama-server'] === 'string' ? A['llama-server'] : undefined,
      model: typeof A['vlm-model'] === 'string' ? A['vlm-model'] : undefined,
      mmproj: typeof A['vlm-mmproj'] === 'string' ? A['vlm-mmproj'] : undefined,
      log,
    });
    vlm.start()
      .then(() => log('Slide descriptions: Gemma 4 E4B (llama.cpp, local) ready.'))
      .catch((e) => {
        log(`Gemma/llama.cpp unavailable: ${e.message}`);
        log('Descriptions fall back to built-in OCR (lower quality). Run: bash install.sh');
        vlm = null;
      });
  } else {
    log('VLM disabled (--no-vlm) — using built-in OCR.');
  }

  ocrLoop().catch((e) => log('ocr loop crashed:', e.message));
  await indexDeck();
  pollLoop().catch((e) => log('poll loop crashed:', e.message));
}

process.on('SIGINT', () => {
  log('Shutting down.');
  try { cdp && cdp.close(); } catch {}
  if (vlm) vlm.stop();
  if (launchedChrome) try { launchedChrome.kill(); } catch {}
  process.exit(0);
});

main().catch((e) => { console.error(e); process.exit(1); });
