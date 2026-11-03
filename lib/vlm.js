'use strict';
/* llama.cpp / Gemma 4 E4B slide describer.
 * Finds (or spawns) a local llama-server with the Gemma 4 E4B model + vision
 * projector, and describes slide screenshots with 1–4 words via the
 * OpenAI-compatible /v1/chat/completions endpoint. */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.join(__dirname, '..');
const MODEL_REPO = 'google/gemma-4-E4B-it-qat-q4_0-gguf';
const MODEL_FILE = 'gemma-4-E4B_q4_0-it.gguf';
const MMPROJ_FILE = 'gemma-4-E4B-it-mmproj.gguf';
const MODEL_URL = `https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILE}`;
const MMPROJ_URL = `https://huggingface.co/${MODEL_REPO}/resolve/main/${MMPROJ_FILE}`;
const MODEL_SIZE = 5150000000;
const MMPROJ_SIZE = 990000000;

const PROMPT = [
  'You see one slide of a presentation.',
  'Read ALL of the text on the slide and consider any charts, numbers and images.',
  'Give the presenter the single most helpful short description of what THIS slide is about.',
  'Answer immediately with 1 to 4 words only.',
  'No punctuation, no quotes, no sentences, no explanations — just the words.',
].join(' ');

function findLlamaServer(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const local = [
    path.join(PROJECT, 'tools', 'llama.cpp', 'llama-server'),
    ...fs.existsSync(path.join(PROJECT, 'tools'))
      ? fs.readdirSync(path.join(PROJECT, 'tools')).filter((d) => d.startsWith('llama-')).map((d) => path.join(PROJECT, 'tools', d, 'llama-server'))
      : [],
  ];
  for (const p of local) try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  for (const c of ['llama-server']) {
    try { return execFileSync('which', [c]).toString().trim(); } catch {}
  }
  return null;
}

function clampWords(text, max = 4) {
  const cleaned = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')          // stray code fences
    .replace(/["'`*#_>|]/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^A-Za-z0-9ÀÖØöøÿ&%$€.\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/, '');
  const words = cleaned.split(' ').filter(Boolean);
  return words.slice(0, max).join(' ');
}

class Vlm {
  constructor({ url, port, binary, model, mmproj, log = () => {} } = {}) {
    this.url = url || `http://127.0.0.1:${port || 8128}`;
    this.binary = binary;
    this.model = model || path.join(PROJECT, 'models', MODEL_FILE);
    this.mmproj = mmproj || path.join(PROJECT, 'models', MMPROJ_FILE);
    this.log = log;
    this.child = null;
    this.healthy = false;
    this._consecutiveFailures = 0;
  }

  async health() {
    try {
      const r = await fetch(this.url + '/health', { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch { return false; }
  }

  /* Ensures a llama-server is reachable; spawns one if files are present. */
  async start({ loadTimeoutMs = 300000 } = {}) {
    if (await this.health()) { this.healthy = true; return { spawned: false }; }

    const bin = findLlamaServer(this.binary);
    if (!bin) throw new Error('llama-server not found (run: bash install.sh)');
    if (!fs.existsSync(this.model) || !fs.existsSync(this.mmproj)) {
      throw new Error(`model files missing in ${path.dirname(this.model)} (run: bash install.sh)`);
    }
    const port = Number(new URL(this.url).port || 8080);
    this.log(`Starting llama-server (${path.basename(bin)}) — loading Gemma 4 E4B, first load takes a minute…`);
    this.child = spawn(bin, [
      '-m', this.model,
      '--mmproj', this.mmproj,
      '--host', '127.0.0.1',
      '--port', String(port),
      '-c', '4096',
      '--parallel', '1',
      '--no-warmup',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    this.child.on('exit', (code) => { this.healthy = false; if (code) this.log(`llama-server exited (${code})`); });

    const t0 = Date.now();
    while (Date.now() - t0 < loadTimeoutMs) {
      await new Promise((r) => setTimeout(r, 2000));
      if (this.child.exitCode != null) throw new Error('llama-server died during startup');
      if (await this.health()) { this.healthy = true; return { spawned: true }; }
    }
    throw new Error('llama-server did not become healthy in time');
  }

  /* Describes a slide image; resolves to a 1–4 word string. */
  async describe(jpegBuf, { timeoutMs = 300000 } = {}) {
    const body = {
      model: 'gemma',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + jpegBuf.toString('base64') } },
        ],
      }],
      max_tokens: 256, // gemma may reason first; leave room for the answer
      temperature: 0,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    };
    const r = await fetch(this.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error('vlm http ' + r.status);
    const j = await r.json();
    const msg = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message : {};
    let text = msg.content || '';
    if (!text.trim() && msg.reasoning_content) {
      // all tokens went to reasoning — the answer is usually the tail of it
      const tail = String(msg.reasoning_content).split(/[\n.]+/).filter((l) => l.trim()).pop() || '';
      text = tail.replace(/^.*?(final answer|answer)\s*[:\-]?\s*/i, '');
    }
    const out = clampWords(text, 4);
    if (!out) throw new Error('empty vlm reply');
    this._consecutiveFailures = 0;
    return out;
  }

  /* describe() with one retry; throws if the model is unreachable twice. */
  async describeResilient(jpegBuf) {
    try {
      return await this.describe(jpegBuf);
    } catch (e) {
      this._consecutiveFailures++;
      if (this._consecutiveFailures >= 4) throw e;
      this.log(`VLM describe failed (${e.message}), retrying…`);
      await new Promise((r) => setTimeout(r, 1500));
      return await this.describe(jpegBuf);
    }
  }

  stop() {
    if (this.child) { try { this.child.kill(); } catch {} this.child = null; }
  }
}

module.exports = { Vlm, clampWords, PROMPT, MODEL_URL, MMPROJ_URL, MODEL_SIZE, MMPROJ_SIZE, MODEL_FILE, MMPROJ_FILE, findLlamaServer };
