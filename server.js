/* Voxel Meadow relay server: serves the game and passes multiplayer messages between players in a room. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = +process.env.MAX_PLAYERS || 16;
const MAX_ROOMS = 300;
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const TOPIC_RE = /^[a-z][a-z0-9_.-]{0,47}$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/* world size must match the game (W, D, H) so saved block edits can be packed the same way */
const SW = 192, SD = 192, SH = 48;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const TOKEN_RE = /^[a-f0-9]{32}$/;
/* profile: a short bio and a skin (six colours and a hair style, e.g. "e3b88c,5a3a22,2e7d9a,3b3f6e,4a4a4a,2a6ad0,1") */
const SKIN_RE = /^[0-9a-f]{6}(,[0-9a-f]{6}){5},[0-3]$/;
function cleanBio(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120); }
function cleanSkin(s) { s = String(s == null ? '' : s).toLowerCase(); return SKIN_RE.test(s) ? s : null; }
const MAX_USERS = 5000, MAX_EDITS = 250000, PART = 3000;

/* accounts, friends and saved worlds. users: lowercase name -> { name, hash, friends[], inc[], out[], world } */
let db = { users: {} };
try { const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); if (j && j.users) db = j; } catch (e) { /* fresh start */ }
let saveT = null;
function saveSoon() {
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFile(DB_FILE + '.tmp', JSON.stringify(db), (err) => { if (!err) fs.rename(DB_FILE + '.tmp', DB_FILE, () => {}); });
    } catch (e) { console.log('could not save data: ' + e.message); }
  }, 3000);
}
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const online = new Map(); // lowercase name -> Set of clients
const roomMeta = new Map(); // room -> { owner: lowercase name of the world's owner, host: client id }

const indexFile = path.join(__dirname, 'index.html');
/* files that let the game be installed as a desktop app */
const STATIC = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'application/javascript'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png']
};
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  const st = STATIC[String(req.url).split('?')[0]];
  if (st) {
    fs.readFile(path.join(__dirname, st[0]), (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': st[1], 'Cache-Control': st[0] === 'sw.js' ? 'no-cache' : 'public, max-age=86400' });
      res.end(buf);
    });
    return;
  }
  fs.readFile(indexFile, (err, buf) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('index.html is missing'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

const ACCOUNT_MSGS = new Set(['reg', 'login', 'logout', 'search', 'prof', 'setpw', 'fr_add', 'fr_ok', 'fr_rm', 'wput', 'wpart', 'wget']);
const rooms = new Map(); // name -> Map(id -> client)
let nextId = 1;
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function send(c, o) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); }
function sendRoom(name, o, except) {
  const r = rooms.get(name); if (!r) return;
  const s = JSON.stringify(o);
  for (const c of r.values()) if (c !== except && c.ws.readyState === 1) c.ws.send(s);
}
function isOnline(l) { const o = online.get(l); return !!(o && o.size); }
function liveRoom(u) { return u && u.world && u.world.live && rooms.has(u.world.live) ? u.world.live : null; }
function socialOf(l) {
  const u = db.users[l]; if (!u) return null;
  const nm = (x) => db.users[x] && db.users[x].name;
  return {
    t: 'social', me: u.name, bio: u.bio || '', skin: u.skin || null, live: liveRoom(u), mine: !!(u.world && u.world.seed != null),
    friends: u.friends.map((f) => {
      const o = db.users[f]; if (!o) return null;
      return { name: o.name, online: isOnline(f), room: liveRoom(o), world: !!(o.world && o.world.seed != null), bio: o.bio || '', skin: o.skin || null };
    }).filter(Boolean),
    inc: u.inc.map(nm).filter(Boolean), out: u.out.map(nm).filter(Boolean)
  };
}
function pushSocial(l) { const set = online.get(l); const s = socialOf(l); if (!set || !s) return; for (const c of set) send(c, s); }
function pushWithFriends(l) { pushSocial(l); const u = db.users[l]; if (u) u.friends.forEach(pushSocial); }
function pull(arr, x) { const i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); }
function unlink(a, b) {
  const ua = db.users[a], ub = db.users[b];
  [[ua, b], [ub, a]].forEach(([u, o]) => { if (u) { pull(u.friends, o); pull(u.inc, o); pull(u.out, o); } });
}
function befriend(a, b) {
  unlink(a, b); db.users[a].friends.push(b); db.users[b].friends.push(a);
}
function worldEdits(u) { return u.world && u.world.edits ? u.world.edits : (u.world.edits = {}); }

function leave(c, name) {
  if (!c.rooms.has(name)) return;
  c.rooms.delete(name);
  const meta = roomMeta.get(name);
  const r = rooms.get(name); if (!r) return;
  r.delete(c.id);
  if (meta && meta.host === c.id) {
    roomMeta.delete(name);
    const u = db.users[meta.owner]; if (u && u.world && u.world.live === name) { u.world.live = null; saveSoon(); pushWithFriends(meta.owner); }
  }
  if (r.size === 0) {
    rooms.delete(name);
    const m2 = roomMeta.get(name);
    if (m2) { roomMeta.delete(name); const u = db.users[m2.owner]; if (u && u.world && u.world.live === name) { u.world.live = null; pushWithFriends(m2.owner); } }
  }
  else sendRoom(name, { t: 'pl', room: name, peer: c.id });
}

/* account and world messages that are not tied to a room */
function onAccount(c, m) {
  const me = c.user ? db.users[c.user] : null;
  switch (m.t) {
    case 'reg': {
      const name = String(m.name || '');
      if (!NAME_RE.test(name) || !TOKEN_RE.test(String(m.token || ''))) { send(c, { t: 'reg_err', code: 'bad' }); return; }
      const l = name.toLowerCase();
      if (db.users[l]) { send(c, { t: 'reg_err', code: 'taken' }); return; }
      if (Object.keys(db.users).length >= MAX_USERS) { send(c, { t: 'reg_err', code: 'full' }); return; }
      db.users[l] = { name, hash: sha(m.token), friends: [], inc: [], out: [], world: null, made: Date.now(), bio: cleanBio(m.bio), skin: cleanSkin(m.skin) };
      saveSoon(); signIn(c, l); send(c, { t: 'reg_ok', name, bio: db.users[l].bio, skin: db.users[l].skin });
      return;
    }
    case 'login': {
      const l = String(m.name || '').toLowerCase(), u = db.users[l];
      if (!u) { send(c, { t: 'login_err', code: 'unknown' }); return; }
      if (u.hash !== sha(m.token)) { send(c, { t: 'login_err', code: 'bad' }); return; }
      signIn(c, l); send(c, { t: 'login_ok', name: u.name, bio: u.bio || '', skin: u.skin || null, world: !!(u.world && u.world.seed != null) });
      return;
    }
    case 'logout': signOut(c); send(c, { t: 'social', me: null, friends: [], inc: [], out: [] }); return;
  }
  if (!me) { send(c, { t: 'need_login' }); return; }
  const l = c.user;
  switch (m.t) {
    case 'search': {
      const q = String(m.q || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16);
      const res = [];
      if (q.length >= 2) {
        const names = Object.keys(db.users).filter((k) => k !== l && k.includes(q) && !me.friends.includes(k));
        names.sort((a, b) => (b.startsWith(q) - a.startsWith(q)) || a.localeCompare(b));
        for (const k of names.slice(0, 8)) res.push({ name: db.users[k].name, bio: db.users[k].bio || '', state: me.out.includes(k) ? 'sent' : (me.inc.includes(k) ? 'inc' : '') });
      }
      send(c, { t: 'search_res', q, res });
      return;
    }
    case 'prof': {
      if (m.bio !== undefined) me.bio = cleanBio(m.bio);
      if (m.skin !== undefined) { const k = cleanSkin(m.skin); if (k) me.skin = k; }
      saveSoon(); pushWithFriends(l); send(c, { t: 'prof_ok' });
      return;
    }
    case 'setpw': {
      if (!TOKEN_RE.test(String(m.token || ''))) { send(c, { t: 'setpw_err' }); return; }
      me.hash = sha(m.token); saveSoon(); send(c, { t: 'setpw_ok' });
      return;
    }
    case 'fr_add': {
      const t = String(m.name || '').toLowerCase(), o = db.users[t];
      if (!o) { send(c, { t: 'fr_err', code: 'nouser', name: String(m.name || '').slice(0, 16) }); return; }
      if (t === l) { send(c, { t: 'fr_err', code: 'self' }); return; }
      if (me.friends.includes(t)) { send(c, { t: 'fr_err', code: 'already', name: o.name }); return; }
      if (me.out.includes(t)) return;
      if (me.inc.includes(t)) { befriend(l, t); }
      else {
        if (me.out.length >= 50 || o.inc.length >= 50) { send(c, { t: 'fr_err', code: 'full' }); return; }
        me.out.push(t); o.inc.push(l);
      }
      saveSoon(); pushSocial(l); pushSocial(t); return;
    }
    case 'fr_ok': {
      const t = String(m.name || '').toLowerCase();
      if (!me.inc.includes(t) || !db.users[t]) return;
      befriend(l, t); saveSoon(); pushSocial(l); pushSocial(t); return;
    }
    case 'fr_rm': {
      const t = String(m.name || '').toLowerCase(); if (!db.users[t]) return;
      unlink(l, t); saveSoon(); pushSocial(l); pushSocial(t); return;
    }
    case 'wput': { // header of an upload of my own world
      const n = m.n | 0, sid = m.sid | 0;
      const lr = liveRoom(me);
      if (lr && (roomMeta.get(lr) || {}).host !== c.id) { send(c, { t: 'wput_err', code: 'live' }); return; } // a friend is hosting it right now
      if (!(n >= 0 && n <= Math.ceil(MAX_EDITS / PART)) || !isFinite(m.seed)) return;
      c.up = { sid, n, got: 0, parts: {}, seed: +m.seed, mode: m.mode === 'creative' ? 'creative' : 'survival', tod: isFinite(m.tod) ? +m.tod : 0.28 };
      if (n === 0) finishUpload(c);
      return;
    }
    case 'wpart': {
      const up = c.up; if (!up || (m.sid | 0) !== up.sid || !Array.isArray(m.d)) return;
      const i = m.i | 0; if (i < 0 || i >= up.n || up.parts[i] || m.d.length > PART) return;
      up.parts[i] = m.d; up.got++;
      if (up.got === up.n) finishUpload(c);
      return;
    }
    case 'wget': {
      const t = String(m.owner || '').toLowerCase(), o = db.users[t];
      if (!o || (t !== l && !me.friends.includes(t))) { send(c, { t: 'wmeta', owner: String(m.owner || ''), has: false }); return; }
      const w = o.world;
      if (!w || w.seed == null) { send(c, { t: 'wmeta', owner: o.name, has: false }); return; }
      const live = liveRoom(o);
      const keys = Object.keys(w.edits || {}), n = Math.ceil(keys.length / PART), sid = ++sidCounter;
      send(c, { t: 'wmeta', owner: o.name, has: true, seed: w.seed, mode: w.mode, tod: w.tod, n, sid, live, by: w.by || o.name, ts: w.ts || 0 });
      if (live) return; // someone is hosting it right now: the player joins that room instead
      for (let i = 0; i < n; i++) {
        send(c, { t: 'wpart', sid, i, d: keys.slice(i * PART, (i + 1) * PART).map((k) => (+k) * 65536 + w.edits[k]) });
      }
      return;
    }
  }
}
let sidCounter = 0;
function finishUpload(c) {
  const up = c.up, u = c.user && db.users[c.user]; c.up = null;
  if (!u || !up) return;
  const edits = {};
  for (let i = 0; i < up.n; i++) {
    for (const v0 of (up.parts[i] || [])) {
      const v = +v0; if (!(v >= 0) || v !== Math.floor(v)) continue;
      const id = v % 65536, cell = (v - id) / 65536;
      if (cell >= SW * SD * SH) continue;
      edits[cell] = id;
    }
  }
  const live = u.world ? u.world.live : null;
  u.world = { seed: up.seed, mode: up.mode, tod: up.tod, edits, by: u.name, ts: Date.now(), live };
  saveSoon(); send(c, { t: 'wput_ok', ts: u.world.ts }); pushWithFriends(c.user);
}
function signIn(c, l) {
  signOut(c, true);
  c.user = l;
  if (!online.has(l)) online.set(l, new Set());
  online.get(l).add(c);
  pushWithFriends(l);
}
function signOut(c, quiet) {
  const l = c.user; if (!l) return;
  c.user = null;
  const set = online.get(l); if (set) { set.delete(c); if (!set.size) online.delete(l); }
  if (!quiet) pushWithFriends(l);
}
/* a block change in a room that belongs to a saved world is applied to the saved copy too */
function trackBlock(name, d) {
  const meta = roomMeta.get(name); if (!meta || !d) return;
  const u = db.users[meta.owner]; if (!u || !u.world) return;
  const x = d.x, y = d.y, z = d.z, id = d.id;
  if (![x, y, z, id].every((v) => Number.isInteger(v))) return;
  if (x < 0 || x >= SW || z < 0 || z >= SD || y < 1 || y >= SH || id < 0 || id >= 65536) return;
  const e = worldEdits(u), cell = (y * SD + z) * SW + x;
  if (!(cell in e) && Object.keys(e).length >= MAX_EDITS) return;
  e[cell] = id; u.world.ts = Date.now(); saveSoon();
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
    if (typeof m.t === 'string' && ACCOUNT_MSGS.has(m.t)) { onAccount(c, m); return; }
    const name = m.room;
    if (typeof name !== 'string' || !ROOM_RE.test(name)) return;

    if (m.t === 'join') {
      if (c.rooms.has(name)) return;
      if (c.rooms.size >= 2) { send(c, { t: 'err', room: name, code: 'limit_reached' }); return; }
      let r = rooms.get(name);
      let meta = null;
      if (!r) {
        if (!m.create) { send(c, { t: 'err', room: name, code: 'not_found' }); return; }
        if (rooms.size >= MAX_ROOMS) { send(c, { t: 'err', room: name, code: 'limit_reached' }); return; }
        if (typeof m.world === 'string' && m.world) { // a room that keeps a saved world up to date
          const ow = m.world.toLowerCase(), ou = db.users[ow], me = c.user && db.users[c.user];
          if (!me || !ou || (ow !== c.user && !me.friends.includes(ow))) { send(c, { t: 'err', room: name, code: 'not_allowed' }); return; }
          const live = liveRoom(ou);
          if (live) { send(c, { t: 'err', room: name, code: 'world_live', live }); return; }
          meta = { owner: ow, host: c.id };
        }
        r = new Map(); rooms.set(name, r);
        if (meta) {
          roomMeta.set(name, meta);
          const ou = db.users[meta.owner]; if (!ou.world) ou.world = { seed: null, mode: 'survival', tod: 0.28, edits: {}, by: null, ts: 0, live: null };
          ou.world.live = name; saveSoon(); pushWithFriends(meta.owner);
        }
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
      if (m.topic === 'block') trackBlock(name, m.data);
      for (const o of r.values()) if (o.ws.readyState === 1) o.ws.send(out);
    }
  });

  ws.on('close', () => { for (const name of Array.from(c.rooms.keys())) leave(c, name); signOut(c); });
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
