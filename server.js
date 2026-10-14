/* Voxel Meadow relay server: serves the game and passes multiplayer messages between players in a room. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = +process.env.MAX_PLAYERS || 16;
const MAX_ROOMS = 300;
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,47}$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

const indexFile = path.join(__dirname, 'index.html');
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  fs.readFile(indexFile, (err, buf) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('index.html is missing'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

const rooms = new Map(); // name -> Map(id -> client)
let nextId = 1;
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function send(c, o) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); }
function sendRoom(name, o, except) {
  const r = rooms.get(name); if (!r) return;
  const s = JSON.stringify(o);
  for (const c of r.values()) if (c !== except && c.ws.readyState === 1) c.ws.send(s);
}
function leave(c, name) {
  if (!c.rooms.has(name)) return;
  c.rooms.delete(name);
  const r = rooms.get(name); if (!r) return;
  r.delete(c.id);
  if (r.size === 0) rooms.delete(name);
  else sendRoom(name, { t: 'pl', room: name, peer: c.id });
}

wss.on('connection', (ws) => {
  const c = { ws, id: 'p' + (nextId++).toString(36) + Math.random().toString(36).slice(2, 6), rooms: new Map(), tokens: 300, last: Date.now() };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(c, { t: 'hello', id: c.id });

  ws.on('message', (raw) => {
    const now = Date.now();
    c.tokens = Math.min(300, c.tokens + (now - c.last) * 0.12); c.last = now; // 120 messages/s, burst 300
    if (c.tokens < 1) return;
    c.tokens -= 1;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ping') { send(c, { t: 'pong' }); return; }
    const name = m.room;
    if (typeof name !== 'string' || !ROOM_RE.test(name)) return;

    if (m.t === 'join') {
      if (c.rooms.has(name)) return;
      if (c.rooms.size >= 2) { send(c, { t: 'err', room: name, code: 'limit_reached' }); return; }
      let r = rooms.get(name);
      if (!r) {
        if (!m.create) { send(c, { t: 'err', room: name, code: 'not_found' }); return; }
        if (rooms.size >= MAX_ROOMS) { send(c, { t: 'err', room: name, code: 'limit_reached' }); return; }
        r = new Map(); rooms.set(name, r);
      }
      if (r.size >= MAX_PER_ROOM) { send(c, { t: 'err', room: name, code: 'limit_reached' }); return; }
      c.rooms.set(name, {});
      r.set(c.id, c);
      const peers = [];
      for (const o of r.values()) peers.push({ peer: o.id, presence: o.rooms.get(name) || {} });
      send(c, { t: 'joined', room: name, peers });
      sendRoom(name, { t: 'pj', room: name, peer: c.id, presence: {} }, c);
    } else if (m.t === 'leave') {
      leave(c, name);
    } else if (m.t === 'pres') {
      const cur = c.rooms.get(name); if (!cur || !m.p || typeof m.p !== 'object' || Array.isArray(m.p)) return;
      const next = Object.assign({}, cur);
      for (const k of Object.keys(m.p)) {
        if (!KEY_RE.test(k)) continue;
        if (m.p[k] === null) delete next[k]; else next[k] = m.p[k];
      }
      if (JSON.stringify(next).length > 4096) return;
      c.rooms.set(name, next);
      sendRoom(name, { t: 'pu', room: name, peer: c.id, presence: next }, c);
    } else if (m.t === 'ev') {
      if (!c.rooms.has(name) || typeof m.topic !== 'string' || !TOPIC_RE.test(m.topic)) return;
      const out = JSON.stringify({ t: 'ev', room: name, peer: c.id, topic: m.topic, data: m.data });
      if (out.length > 16 * 1024) return;
      const r = rooms.get(name); if (!r) return;
      for (const o of r.values()) if (o.ws.readyState === 1) o.ws.send(out);
    }
  });

  ws.on('close', () => { for (const name of Array.from(c.rooms.keys())) leave(c, name); });
  ws.on('error', () => { try { ws.terminate(); } catch (e) { /* ignore */ } });
});

// drop dead connections so a host who vanished closes their world for the guests
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 30000);

server.listen(PORT, () => console.log('Voxel Meadow listening on ' + PORT));
module.exports = { server, wss };
