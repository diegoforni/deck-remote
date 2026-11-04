#!/usr/bin/env node
/*
 * deck-remote relay — lets phones on ANY network (cellular, guest Wi‑Fi…)
 * reach a deck-remote presenter that is behind NAT, without opening ports on
 * the presenting machine. The presenter connects OUT to this relay; phones
 * connect to this relay; the relay just shuttles small JSON messages between
 * them (never slide images).
 *
 * Run it on any host with a public address:
 *   node relay.js [--port 8676] [--pin none] [--ui-dir ./public] [--room-ttl-min 360]
 *
 * Protocol (all JSON over WebSocket):
 *   presenter → /hub/presenter  {t:'hello', code?, pin?}   → {t:'joined', code}
 *   phone     → /hub/phone?code=ABCDE[&pin=…]              → {t:'joined'}, then
 *               every presenter broadcast is forwarded verbatim; phone actions
 *               ({a:'next'|…}) are forwarded to the presenter.
 *   presenter receives {t:'phones', n} whenever phone membership changes.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

function parseArgs(argv) {
  const A = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) A[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { A[a.slice(2)] = argv[i + 1]; i++; }
      else A[a.slice(2)] = true;
    }
  }
  return A;
}
const A = parseArgs(process.argv.slice(2));
const PORT = parseInt(A.port || '8676', 10);
const UI_DIR = A['ui-dir'] || path.join(__dirname, 'public');
const ROOM_TTL_MS = parseInt(A['room-ttl-min'] || '360', 10) * 60 * 1000;

const log = (...m) => console.log(new Date().toTimeString().slice(0, 8), ...m);

/* -------------------------------- rooms -------------------------------- */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const newCode = () => Array.from({ length: 5 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

const rooms = new Map(); // code → { presenter: ws|null, presenterAt: ms, pin: string|null, phones: Set<ws> }

function sweepRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.presenter && now - room.presenterAt > ROOM_TTL_MS && room.phones.size === 0) rooms.delete(code);
  }
}
setInterval(sweepRooms, 10 * 60 * 1000).unref();

function notifyPhoneCount(room) {
  if (room.presenter && room.presenter.readyState === WebSocket.OPEN) {
    room.presenter.send(JSON.stringify({ t: 'phones', n: room.phones.size }));
  }
}

const send = (ws, obj) => { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch {} };

/* ------------------------------ http server ----------------------------- */

const phoneHtml = (() => {
  try { return fs.readFileSync(path.join(UI_DIR, 'phone.html')); } catch { return Buffer.from('deck-remote: phone UI (public/phone.html) not found'); }
})();

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() | 0 }));
  } else if (/^\/r\/[A-Za-z0-9]+\/?$/.test(u.pathname) || u.pathname === '/phone') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(phoneHtml);
  } else if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('deck-remote relay is running. Phone URL shape: /r/<CODE>\n');
  } else {
    res.writeHead(404); res.end('not found');
  }
});

/* ------------------------------ ws hub ---------------------------------- */

const wss = new WebSocket.Server({ noServer: true, maxPayload: 1 << 20 });

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/hub/presenter' || u.pathname === '/hub/phone') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, u));
  } else socket.destroy();
});

wss.on('connection', (ws, req, u) => {
  if (u.pathname === '/hub/presenter') {
    let room = null;
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'hello') {
        let code = typeof msg.code === 'string' ? msg.code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) : '';
        if (code) {
          room = rooms.get(code);
          if (room && room.presenter && room.presenter !== ws && Date.now() - room.presenterAt < 30 * 1000) {
            send(ws, { t: 'error', error: 'code in use' });
            return ws.close(4402, 'code in use');
          }
          if (!room) room = { code, presenter: null, presenterAt: 0, pin: null, phones: new Set() }; rooms.set(code, room);
        } else {
          do { code = newCode(); } while (rooms.has(code));
          room = { code, presenter: null, presenterAt: 0, pin: null, phones: new Set() };
          rooms.set(code, room);
        }
        room.presenter = ws;
        room.presenterAt = Date.now();
        if (typeof msg.pin === 'string' && msg.pin.length) room.pin = msg.pin;
        log(`presenter joined room ${code} (${room.phones.size} phone(s) waiting)`);
        send(ws, { t: 'joined', code });
        notifyPhoneCount(room);
        return;
      }
      if (!room) return;
      room.presenterAt = Date.now();
      // everything else from the presenter is a broadcast to its phones
      for (const phone of room.phones) send(phone, msg);
    });
    ws.on('close', () => {
      if (room && room.presenter === ws) {
        room.presenter = null;
        room.presenterAt = Date.now(); // keep the room for reconnection
        log(`presenter left room ${room.code}`);
      }
    });
    return;
  }

  /* phone */
  const code = (u.searchParams.get('code') || '').toUpperCase();
  const pin = u.searchParams.get('pin') || '';
  const room = rooms.get(code);
  if (!room) { ws.close(4404, 'unknown room'); return; }
  if (room.pin && pin !== room.pin) { ws.close(4401, 'bad pin'); return; }

  room.phones.add(ws);
  const codeLogged = code;
  log(`phone joined room ${codeLogged} (${room.phones.size} total)`);
  send(ws, { t: 'joined' });
  notifyPhoneCount(room);

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (room.presenter) send(room.presenter, msg);
  });
  ws.on('close', () => {
    room.phones.delete(ws);
    log(`phone left room ${codeLogged} (${room.phones.size} left)`);
    notifyPhoneCount(room);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`deck-remote relay listening on 0.0.0.0:${PORT}`);
  log(`phone URLs look like: http://<this-host>:${PORT}/r/<CODE>`);
});
