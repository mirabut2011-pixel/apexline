// APEXLINE game server — online accounts, cloud saves, leaderboards.
// Runs on Node 18+. Needs a PostgreSQL database in DATABASE_URL (Render Postgres, Neon, …).
// Also serves the game itself (index.html) so the whole game lives on one address.
//
// Render setup:  Build command: npm install   Start command: npm start
// Env vars:      DATABASE_URL (required for persistence), ALLOWED_ORIGINS (optional, comma separated)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const VERSION = 1;
const PORT = Number(process.env.PORT) || 10000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const GAME_FILE = [path.join(ROOT, 'index.html'), path.join(ROOT, '..', 'index.html')].find((p) => fs.existsSync(p));
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'https://mirabut2011-pixel.github.io,https://apexline-708a.onrender.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Minimum plausible lap times (ms), from track length at the fastest possible speed with nitro, minus 10 %.
const MAPS = { harbor: 24500, canyon: 25000, alpine: 21100 };
const CARS = ['kestrel', 'vanta', 'mako', 'lumen', 'stratos', 'bastion', 'halcyon', 'oni', 'aurora'];
const NAME_RE = /^[A-Za-z0-9_\-. ]{3,16}$/;

// ───────────────────────────────────────────── storage
function createMemoryStore() {
  const users = new Map(); const sessions = new Map(); const laps = new Map();
  return {
    kind: 'memory',
    async init() {},
    async createUser(u) {
      for (const x of users.values()) {
        if (x.username_lc === u.username_lc) return 'name';
        if (u.email_lc && x.email_lc === u.email_lc) return 'email';
      }
      users.set(u.id, { ...u, created_at: new Date() }); return null;
    },
    async userByLogin(lc) { for (const u of users.values()) if (u.username_lc === lc || (u.email_lc && u.email_lc === lc)) return u; return null; },
    async userById(id) { return users.get(id) ?? null; },
    async nameTaken(lc, exceptId) { for (const u of users.values()) if (u.username_lc === lc && u.id !== exceptId) return true; return false; },
    async saveProfile(id, profile, username, pub) { const u = users.get(id); if (u) Object.assign(u, { profile, username, username_lc: username.toLowerCase(), public_profile: pub }); },
    async deleteUser(id) { users.delete(id); for (const [k, s] of sessions) if (s === id) sessions.delete(k); for (const k of laps.keys()) if (k.startsWith(id + '|')) laps.delete(k); },
    async createSession(hash, id) { sessions.set(hash, id); },
    async sessionUser(hash) { const id = sessions.get(hash); return id ? users.get(id) ?? null : null; },
    async deleteSession(hash) { sessions.delete(hash); },
    async upsertLap(id, mapId, lapMs, raceMs, carId) {
      const k = id + '|' + mapId; const cur = laps.get(k);
      if (!cur || lapMs < cur.lap_ms) laps.set(k, { user_id: id, map_id: mapId, lap_ms: lapMs, race_ms: raceMs, car_id: carId, created_at: new Date() });
    },
    async lapBoard(mapId, limit) {
      return [...laps.values()].filter((l) => l.map_id === mapId).sort((a, b) => a.lap_ms - b.lap_ms).slice(0, limit)
        .map((l) => { const u = users.get(l.user_id); return { ...l, username: u?.username, public_profile: u?.public_profile }; });
    },
    async lapRank(id, mapId) {
      const mine = laps.get(id + '|' + mapId); if (!mine) return null;
      return 1 + [...laps.values()].filter((l) => l.map_id === mapId && l.lap_ms < mine.lap_ms).length;
    },
    async leagueBoard(limit) {
      return [...users.values()].map((u) => ({ id: u.id, username: u.username, public_profile: u.public_profile, lp: u.profile.lp ?? 0, level: u.profile.level ?? 1 }))
        .sort((a, b) => b.lp - a.lp || b.level - a.level).slice(0, limit);
    },
    async leagueRank(id) { const me = users.get(id); if (!me) return null; return 1 + [...users.values()].filter((u) => (u.profile.lp ?? 0) > (me.profile.lp ?? 0)).length; },
    async playerCount() { return users.size; },
    async userLaps(id) { return [...laps.values()].filter((l) => l.user_id === id); },
  };
}

async function createPgStore(url) {
  const { default: pg } = await import('pg');
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const wantSsl = process.env.PGSSL ? process.env.PGSSL !== 'false' : host.includes('.') && host !== 'localhost' && host !== '127.0.0.1';
  const pool = new pg.Pool({ connectionString: url, ssl: wantSsl ? { rejectUnauthorized: false } : false, max: 5 });
  const q = async (text, params = []) => (await pool.query(text, params)).rows;
  return {
    kind: 'postgres',
    async init() {
      await q(`CREATE TABLE IF NOT EXISTS apex_users (
        id text PRIMARY KEY, username text NOT NULL, username_lc text NOT NULL UNIQUE, email text, email_lc text UNIQUE,
        pass_hash text NOT NULL, profile jsonb NOT NULL, public_profile boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS apex_sessions (
        token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES apex_users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS apex_laps (
        user_id text NOT NULL REFERENCES apex_users(id) ON DELETE CASCADE, map_id text NOT NULL, lap_ms integer NOT NULL,
        race_ms integer, car_id text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, map_id))`);
      await q(`CREATE INDEX IF NOT EXISTS apex_laps_board ON apex_laps (map_id, lap_ms)`);
      // sessions older than 180 days are removed on start
      await q(`DELETE FROM apex_sessions WHERE created_at < now() - interval '180 days'`);
    },
    async createUser(u) {
      try {
        await q(`INSERT INTO apex_users (id, username, username_lc, email, email_lc, pass_hash, profile, public_profile) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [u.id, u.username, u.username_lc, u.email, u.email_lc, u.pass_hash, JSON.stringify(u.profile), u.public_profile]);
        return null;
      } catch (e) {
        if (e.code === '23505') return String(e.constraint ?? e.detail ?? '').includes('email') ? 'email' : 'name';
        throw e;
      }
    },
    async userByLogin(lc) { return (await q(`SELECT * FROM apex_users WHERE username_lc = $1 OR email_lc = $1 LIMIT 1`, [lc]))[0] ?? null; },
    async userById(id) { return (await q(`SELECT * FROM apex_users WHERE id = $1`, [id]))[0] ?? null; },
    async nameTaken(lc, exceptId) { return (await q(`SELECT 1 FROM apex_users WHERE username_lc = $1 AND id <> $2`, [lc, exceptId])).length > 0; },
    async saveProfile(id, profile, username, pub) {
      await q(`UPDATE apex_users SET profile = $2, username = $3, username_lc = $4, public_profile = $5, updated_at = now() WHERE id = $1`,
        [id, JSON.stringify(profile), username, username.toLowerCase(), pub]);
    },
    async deleteUser(id) { await q(`DELETE FROM apex_users WHERE id = $1`, [id]); },
    async createSession(hash, id) { await q(`INSERT INTO apex_sessions (token_hash, user_id) VALUES ($1,$2)`, [hash, id]); },
    async sessionUser(hash) { return (await q(`SELECT u.* FROM apex_sessions s JOIN apex_users u ON u.id = s.user_id WHERE s.token_hash = $1`, [hash]))[0] ?? null; },
    async deleteSession(hash) { await q(`DELETE FROM apex_sessions WHERE token_hash = $1`, [hash]); },
    async upsertLap(id, mapId, lapMs, raceMs, carId) {
      await q(`INSERT INTO apex_laps (user_id, map_id, lap_ms, race_ms, car_id) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (user_id, map_id) DO UPDATE SET lap_ms = EXCLUDED.lap_ms, race_ms = EXCLUDED.race_ms, car_id = EXCLUDED.car_id, created_at = now()
        WHERE EXCLUDED.lap_ms < apex_laps.lap_ms`, [id, mapId, lapMs, raceMs, carId]);
    },
    async lapBoard(mapId, limit) {
      return q(`SELECT l.user_id, l.lap_ms, l.race_ms, l.car_id, l.created_at, u.username, u.public_profile
        FROM apex_laps l JOIN apex_users u ON u.id = l.user_id WHERE l.map_id = $1 ORDER BY l.lap_ms ASC, l.created_at ASC LIMIT $2`, [mapId, limit]);
    },
    async lapRank(id, mapId) {
      const r = await q(`SELECT 1 + (SELECT count(*) FROM apex_laps o WHERE o.map_id = m.map_id AND o.lap_ms < m.lap_ms)::int AS rank
        FROM apex_laps m WHERE m.user_id = $1 AND m.map_id = $2`, [id, mapId]);
      return r[0]?.rank ?? null;
    },
    async leagueBoard(limit) {
      return q(`SELECT id, username, public_profile, COALESCE((profile->>'lp')::int, 0) AS lp, COALESCE((profile->>'level')::int, 1) AS level
        FROM apex_users ORDER BY lp DESC, level DESC, created_at ASC LIMIT $1`, [limit]);
    },
    async leagueRank(id) {
      const r = await q(`SELECT 1 + (SELECT count(*) FROM apex_users o WHERE COALESCE((o.profile->>'lp')::int,0) > COALESCE((m.profile->>'lp')::int,0))::int AS rank
        FROM apex_users m WHERE m.id = $1`, [id]);
      return r[0]?.rank ?? null;
    },
    async playerCount() { return (await q(`SELECT count(*)::int AS n FROM apex_users`))[0].n; },
    async userLaps(id) { return q(`SELECT map_id, lap_ms, race_ms, car_id, created_at FROM apex_laps WHERE user_id = $1`, [id]); },
  };
}

// ───────────────────────────────────────────── helpers
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) { const salt = crypto.randomBytes(16); const key = await scrypt(pw, salt); return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`; }
async function checkPassword(pw, stored) {
  const [kind, saltHex, keyHex] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'));
  const ref = Buffer.from(keyHex, 'hex');
  return ref.length === key.length && crypto.timingSafeEqual(ref, key);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const strArr = (v, max, allowed) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.length <= 32 && (!allowed || allowed.includes(x))))].slice(0, max) : []);

/** Keep only known profile fields with sane ranges. The client stays the game authority for now. */
function sanitizeProfile(p, base) {
  const src = p && typeof p === 'object' ? p : {};
  const out = { ...base };
  out.level = clampInt(src.level, 1, 50, base.level);
  out.xp = clampInt(src.xp, 0, 10_000_000, 0);
  out.credits = clampInt(src.credits, 0, 50_000_000, base.credits);
  out.lp = clampInt(src.lp, 0, 1_000_000, 0);
  out.starterPicked = !!src.starterPicked;
  out.peakLeague = typeof src.peakLeague === 'string' ? src.peakLeague.slice(0, 16) : 'bronze';
  out.claimedPromos = strArr(src.claimedPromos, 10);
  out.ownedCars = strArr(src.ownedCars, 40, CARS);
  out.selectedCar = CARS.includes(src.selectedCar) ? src.selectedCar : out.ownedCars[0] ?? '';
  out.ownedPaints = strArr(src.ownedPaints, 40);
  out.paints = {}; for (const c of out.ownedCars) if (typeof src.paints?.[c] === 'string') out.paints[c] = src.paints[c].slice(0, 32);
  out.upgrades = {}; for (const c of out.ownedCars) { const u = src.upgrades?.[c]; if (u) out.upgrades[c] = { engine: clampInt(u.engine, 0, 3, 0), grip: clampInt(u.grip, 0, 3, 0), nitro: clampInt(u.nitro, 0, 3, 0) }; }
  out.bests = {}; for (const m of Object.keys(MAPS)) { const b = src.bests?.[m]; if (b) out.bests[m] = { lap: Number(b.lap) || 0, race: Number(b.race) || 0 }; }
  const st = src.stats ?? {};
  out.stats = { races: clampInt(st.races, 0, 1e7, 0), wins: clampInt(st.wins, 0, 1e7, 0), podiums: clampInt(st.podiums, 0, 1e7, 0), distanceKm: Math.max(0, Math.min(1e7, Number(st.distanceKm) || 0)) };
  out.history = Array.isArray(src.history) ? src.history.slice(0, 30).filter((h) => h && typeof h === 'object') : [];
  out.settings = src.settings && typeof src.settings === 'object' ? src.settings : base.settings;
  return out;
}

function baseProfile(id, username, email) {
  return {
    id, username, email: email || undefined, guest: false, createdAt: Date.now(), starterPicked: false,
    level: 1, xp: 0, credits: 5000, lp: 0, peakLeague: 'bronze', claimedPromos: [], ownedCars: [], selectedCar: '', paints: {},
    ownedPaints: ['ember', 'graphite', 'glacier', 'crimson'], upgrades: {}, bests: {}, stats: { races: 0, wins: 0, podiums: 0, distanceKm: 0 }, history: [],
    settings: { sound: true, volume: 0.6, units: 'kmh', quality: 'high', touch: 'auto', autoThrottle: true, reduceMotion: false, privacy: { publicProfile: true, friendRequests: false } },
  };
}

function profileOut(u) { return { ...u.profile, id: u.id, username: u.username, email: u.email ?? undefined, guest: false, createdAt: new Date(u.created_at).getTime() }; }
const publicName = (u) => (u.public_profile ? u.username : 'Anonymous driver');

// very small in-memory rate limiter
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs); arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return arr.length > max;
}

// ───────────────────────────────────────────── http
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 200_000) throw new HttpError(413, 'Request too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

const ip = (req) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();

async function main() {
  const store = process.env.DATABASE_URL ? await createPgStore(process.env.DATABASE_URL) : createMemoryStore();
  await store.init();
  if (store.kind === 'memory') console.warn('[apexline] DATABASE_URL is not set — using in-memory storage. Data is lost on restart!');

  const auth = async (req) => {
    const h = String(req.headers.authorization ?? '');
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!tok) throw new HttpError(401, 'Not signed in');
    const u = await store.sessionUser(sha(tok));
    if (!u) throw new HttpError(401, 'Session expired — please sign in again');
    return { u, tokHash: sha(tok) };
  };
  const newSession = async (id) => { const tok = crypto.randomBytes(32).toString('base64url'); await store.createSession(sha(tok), id); return tok; };

  const routes = {
    'GET /api/health': async () => ({ ok: true, version: VERSION, storage: store.kind, players: await store.playerCount() }),

    'POST /api/register': async (req) => {
      if (limited('reg:' + ip(req), 10, 3600_000)) throw new HttpError(429, 'Too many accounts created from this network. Try again later.');
      const b = await readJson(req);
      const username = String(b.username ?? '').trim(); const email = String(b.email ?? '').trim(); const password = String(b.password ?? '');
      if (!NAME_RE.test(username)) throw new HttpError(400, 'Driver name: 3–16 characters (letters, numbers, space, _ - .).');
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email or leave it empty.');
      if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
      const id = crypto.randomUUID();
      const base = baseProfile(id, username, email);
      const profile = b.profile ? sanitizeProfile(b.profile, base) : base;
      const pub = b.publicProfile !== false;
      profile.settings = { ...profile.settings, privacy: { ...(profile.settings?.privacy ?? {}), publicProfile: pub } };
      const err = await store.createUser({ id, username, username_lc: username.toLowerCase(), email: email || null, email_lc: email ? email.toLowerCase() : null, pass_hash: await hashPassword(password), profile, public_profile: pub });
      if (err === 'name') throw new HttpError(409, 'That driver name is already taken.');
      if (err === 'email') throw new HttpError(409, 'An account with this email already exists.');
      const u = await store.userById(id);
      return { token: await newSession(id), profile: profileOut(u) };
    },

    'POST /api/login': async (req) => {
      const b = await readJson(req);
      const who = String(b.who ?? '').trim().toLowerCase();
      if (limited('login:' + ip(req), 30, 600_000) || limited('loginu:' + who, 10, 600_000)) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
      const u = who ? await store.userByLogin(who) : null;
      if (!u || !(await checkPassword(String(b.password ?? ''), u.pass_hash))) throw new HttpError(401, 'Wrong driver name, email or password.');
      return { token: await newSession(u.id), profile: profileOut(u) };
    },

    'POST /api/logout': async (req) => { const { tokHash } = await auth(req); await store.deleteSession(tokHash); return { ok: true }; },

    'GET /api/me': async (req) => { const { u } = await auth(req); return { profile: profileOut(u) }; },

    'PUT /api/profile': async (req) => {
      const { u } = await auth(req);
      if (limited('save:' + u.id, 120, 60_000)) throw new HttpError(429, 'Saving too often');
      const b = await readJson(req);
      const profile = sanitizeProfile(b.profile, u.profile);
      let username = u.username; let nameError = null;
      const wanted = typeof b.profile?.username === 'string' ? b.profile.username.trim() : u.username;
      if (wanted !== u.username) {
        if (!NAME_RE.test(wanted)) nameError = 'Invalid driver name — name not changed.';
        else if (await store.nameTaken(wanted.toLowerCase(), u.id)) nameError = 'That driver name is already taken — name not changed.';
        else username = wanted;
      }
      const pub = profile.settings?.privacy?.publicProfile !== false;
      await store.saveProfile(u.id, profile, username, pub);
      return { ok: true, username, nameError };
    },

    'POST /api/laps': async (req) => {
      const { u } = await auth(req);
      const b = await readJson(req);
      const mapId = String(b.mapId ?? ''); const lapMs = Math.round(Number(b.lapMs)); const raceMs = Math.round(Number(b.raceMs)) || null;
      if (!(mapId in MAPS)) throw new HttpError(400, 'Unknown circuit');
      if (!Number.isFinite(lapMs) || lapMs < MAPS[mapId] || lapMs > 600_000) throw new HttpError(422, 'Lap time rejected');
      const carId = CARS.includes(b.carId) ? b.carId : null;
      await store.upsertLap(u.id, mapId, lapMs, raceMs, carId);
      return { ok: true, rank: await store.lapRank(u.id, mapId) };
    },

    'GET /api/leaderboard': async (req, url) => {
      const me = await auth(req).then((x) => x.u).catch(() => null);
      const kind = url.searchParams.get('board') ?? 'league';
      if (kind === 'league') {
        const rows = await store.leagueBoard(50);
        return { board: 'league', rows: rows.map((r, i) => ({ rank: i + 1, name: publicName(r), lp: r.lp, level: r.level, me: me?.id === r.id })), myRank: me ? await store.leagueRank(me.id) : null };
      }
      if (!(kind in MAPS)) throw new HttpError(400, 'Unknown board');
      const rows = await store.lapBoard(kind, 50);
      return { board: kind, rows: rows.map((r, i) => ({ rank: i + 1, name: publicName(r), lapMs: r.lap_ms, carId: r.car_id, me: me?.id === r.user_id })), myRank: me ? await store.lapRank(me.id, kind) : null };
    },

    'GET /api/export': async (req) => {
      const { u } = await auth(req);
      return { exportedAt: new Date().toISOString(), storage: 'APEXLINE server database', account: { id: u.id, username: u.username, email: u.email, publicProfile: u.public_profile, createdAt: u.created_at, profile: u.profile }, laps: await store.userLaps(u.id) };
    },

    'DELETE /api/account': async (req) => { const { u } = await auth(req); await store.deleteUser(u.id); return { ok: true }; },
  };

  const gameHtml = () => (GAME_FILE ? fs.readFileSync(GAME_FILE) : null);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    try {
      if (url.pathname.startsWith('/api/')) {
        cors(req, res);
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        const h = routes[`${req.method} ${url.pathname}`];
        if (!h) throw new HttpError(404, 'Not found');
        send(res, 200, await h(req, url));
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = gameHtml();
        if (!html) { send(res, 500, 'index.html not found next to server.mjs'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html);
        return;
      }
      send(res, 404, 'Not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[apexline]', e);
      send(res, status, { error: status === 500 ? 'Server error' : e.message });
    }
  });
  server.listen(PORT, () => console.log(`[apexline] listening on :${PORT} (storage: ${store.kind})`));
}

main().catch((e) => { console.error('[apexline] failed to start', e); process.exit(1); });
