// Nebula — auth + rooms + sync Worker.
import { Hono } from 'hono';
import { yRoute } from 'y-durableobjects';
import { NebulaRoom } from './room.js';

const app = new Hono();

const ALLOWED_ORIGINS = ['https://articulate-english.github.io', 'http://localhost:8000', 'http://127.0.0.1:8000'];
function corsOrigin(req) {
  const o = req.header('Origin') || '';
  return ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0];
}
for (const p of ['/sync/*', '/auth/*', '/rooms/*', '/invites/*']) {
  app.use(p, async (c, next) => {
    c.res.headers.set('Access-Control-Allow-Origin', corsOrigin(c.req));
    c.res.headers.set('Vary', 'Origin');
    c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (c.req.method === 'OPTIONS') {
      c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      return c.body(null, 204);
    }
    await next();
  });
}

function uid() { return crypto.randomUUID(); }
function now() { return Date.now(); }

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const s = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 50000, hash: 'SHA-256' }, keyMaterial, 256);
  return 'pbkdf2:50000:' + b64url(salt) + ':' + b64url(bits);
}
async function verifyPassword(password, stored) {
  const parts = stored.split(':');
  if (parts[0] !== 'pbkdf2') return false;
  const iters = Number(parts[1]);
  const salt = b64urlDecode(parts[2]);
  const expected = parts[3];
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, keyMaterial, 256);
  return b64url(bits) === expected;
}

async function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = h + '.' + p;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return data + '.' + b64url(sig);
}
async function verifyJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = parts[0] + '.' + parts[1];
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(parts[2]), new TextEncoder().encode(data));
  if (!ok) return null;
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

async function authUser(c) {
  const h = c.req.header('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const payload = await verifyJwt(m[1], c.env.JWT_SECRET);
  if (!payload || !payload.sub) return null;
  const row = await c.env.nebula_db.prepare('SELECT id,email,created_at FROM users WHERE id=?').bind(payload.sub).first();
  return row || null;
}

function json(c, data, status = 200) { return c.json(data, status); }

app.get('/', (c) => c.json({ app: 'nebula-sync', status: 'ok' }));

app.post('/auth/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  if (!email || !password || password.length < 6) {
    return json(c, { error: 'email and password (>=6 chars) required' }, 400);
  }
  const existing = await c.env.nebula_db.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  if (existing) return json(c, { error: 'email already registered' }, 409);
  const id = uid();
  const hash = await hashPassword(password);
  await c.env.nebula_db.prepare('INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)').bind(id, email, hash, now()).run();
  const token = await signJwt({ sub: id, email, exp: Math.floor(Date.now()/1000) + 7*24*3600 }, c.env.JWT_SECRET);
  return json(c, { token, user: { id, email } });
});

app.post('/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const row = await c.env.nebula_db.prepare('SELECT id,email,password_hash FROM users WHERE email=?').bind(email).first();
  if (!row) return json(c, { error: 'invalid credentials' }, 401);
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return json(c, { error: 'invalid credentials' }, 401);
  const token = await signJwt({ sub: row.id, email: row.email, exp: Math.floor(Date.now()/1000) + 7*24*3600 }, c.env.JWT_SECRET);
  return json(c, { token, user: { id: row.id, email: row.email } });
});

app.get('/auth/me', async (c) => {
  const u = await authUser(c);
  if (!u) return json(c, { error: 'unauthorized' }, 401);
  return json(c, { user: { id: u.id, email: u.email } });
});

app.post('/rooms', async (c) => {
  const u = await authUser(c);
  if (!u) return json(c, { error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const name = (body.name || 'Shared Board').trim();
  const id = uid();
  await c.env.nebula_db.prepare('INSERT INTO rooms (id,name,owner_id,created_at) VALUES (?,?,?,?)').bind(id, name, u.id, now()).run();
  await c.env.nebula_db.prepare('INSERT INTO room_members (room_id,user_id,role,joined_at) VALUES (?,?,?,?)').bind(id, u.id, 'owner', now()).run();
  return json(c, { room: { id, name, role: 'owner' } });
});

app.get('/rooms', async (c) => {
  const u = await authUser(c);
  if (!u) return json(c, { error: 'unauthorized' }, 401);
  const res = await c.env.nebula_db.prepare(
    'SELECT r.id, r.name, m.role FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE m.user_id=? ORDER BY r.created_at DESC'
  ).bind(u.id).all();
  return json(c, { rooms: res.results || [] });
});

app.get('/rooms/:id/members', async (c) => {
  const u = await authUser(c);
  if (!u) return json(c, { error: 'unauthorized' }, 401);
  const roomId = c.req.param('id');
  const mem = await c.env.nebula_db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').bind(roomId, u.id).first();
  if (!mem) return json(c, { error: 'forbidden' }, 403);
  const res = await c.env.nebula_db.prepare(
    'SELECT u.id, u.email, m.role FROM room_members m JOIN users u ON u.id=m.user_id WHERE m.room_id=?'
  ).bind(roomId).all();
  return json(c, { members: res.results || [] });
});

app.post('/rooms/:id/invite', async (c) => {
  const u = await authUser(c);
  if (!u) return json(c, { error: 'unauthorized' }, 401);
  const roomId = c.req.param('id');
  const mem = await c.env.nebula_db.prepare('SELECT role FROM room_members WHERE room_id=? AND user_id=?').bind(roomId, u.id).first();
  if (!mem) return json(c, { error: 'forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const email = body.email ? String(body.email).trim().toLowerCase() : null;
  const token = uid();
  const expires = now() + 7*24*3600*1000;
  const id = uid();
  await c.env.nebula_db.prepare('INSERT INTO invites (id,room_id,email,token,expires_at) VALUES (?,?,?,?,?)').bind(id, roomId, email, token, expires).run();
  const origin = (c.req.header('Origin') || 'https://articulate-english.github.io').replace(/\/$/, '');
  const inviteUrl = origin + '/nebula/?invite=' + token;
  return json(c, { token, inviteUrl, expiresAt: expires });
});

app.post('/invites/:token/accept', async (c) => {
  const u = await authUser(c);
  if (!u) return json(c, { error: 'unauthorized' }, 401);
  const token = c.req.param('token');
  const inv = await c.env.nebula_db.prepare('SELECT * FROM invites WHERE token=?').bind(token).first();
  if (!inv) return json(c, { error: 'invalid invite' }, 404);
  if (inv.expires_at < now()) return json(c, { error: 'invite expired' }, 410);
  if (inv.email && inv.email !== u.email) return json(c, { error: 'invite is for another email' }, 403);
  if (inv.used_by && inv.used_by !== u.id) return json(c, { error: 'invite already used' }, 410);
  const existing = await c.env.nebula_db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').bind(inv.room_id, u.id).first();
  if (!existing) {
    await c.env.nebula_db.prepare('INSERT INTO room_members (room_id,user_id,role,joined_at) VALUES (?,?,?,?)').bind(inv.room_id, u.id, 'member', now()).run();
  }
  await c.env.nebula_db.prepare('UPDATE invites SET used_by=? WHERE token=?').bind(u.id, token).run();
  return json(c, { roomId: inv.room_id, joined: true });
});

app.post('/rooms/:id/ws-ticket', async (c) => {
  const u = await authUser(c);
  if (!u) return json(c, { error: 'unauthorized' }, 401);
  const roomId = c.req.param('id');
  const mem = await c.env.nebula_db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').bind(roomId, u.id).first();
  if (!mem) return json(c, { error: 'forbidden' }, 403);
  const ticket = await signJwt({ sub: u.id, room: roomId, exp: Math.floor(Date.now()/1000) + 300 }, c.env.JWT_SECRET);
  return json(c, { ticket });
});

app.use('/sync/*', async (c, next) => {
  if (c.req.path.endsWith('/state')) return next();
  const roomId = c.req.path.split('/').pop();
  const ticket = c.req.query('ticket');
  if (!ticket) return json(c, { error: 'ticket required' }, 401);
  const payload = await verifyJwt(ticket, c.env.JWT_SECRET);
  if (!payload || payload.room !== roomId) return json(c, { error: 'invalid ticket' }, 401);
  const mem = await c.env.nebula_db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').bind(roomId, payload.sub).first();
  if (!mem) return json(c, { error: 'forbidden' }, 403);
  return next();
});

app.get('/sync/:roomId/state', async (c) => {
  const roomId = c.req.param('roomId');
  const ticket = c.req.query('ticket');
  if (!ticket) return json(c, { error: 'ticket required' }, 401);
  const payload = await verifyJwt(ticket, c.env.JWT_SECRET);
  if (!payload || payload.room !== roomId) return json(c, { error: 'invalid ticket' }, 401);
  const mem = await c.env.nebula_db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').bind(roomId, payload.sub).first();
  if (!mem) return json(c, { error: 'forbidden' }, 403);
  const id = c.env.Y_DURABLE_OBJECTS.idFromName(roomId);
  const stub = c.env.Y_DURABLE_OBJECTS.get(id);
  const bytes = new Uint8Array(await stub.getYDoc());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return c.json({ roomId, bytes: bytes.length, state: btoa(binary) });
});

app.route('/sync', yRoute((env) => env.Y_DURABLE_OBJECTS));

export default app;
export { NebulaRoom };

