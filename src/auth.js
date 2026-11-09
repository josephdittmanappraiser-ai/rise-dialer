// Logins: email + password, session cookie. Admins manage users, numbers and settings.
const crypto = require('crypto');
const { all, get, run } = require('./db');
const { randomToken } = require('./util');
const config = require('./config');

const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

function makeIdentity(name) {
  const base = String(name || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'user';
  let identity = base;
  let i = 2;
  while (get('SELECT 1 FROM users WHERE identity = ?', identity)) identity = `${base}_${i++}`;
  return identity;
}

function createUser({ name, email, password, role = 'agent', cell_phone = null, default_number_id = null }) {
  const identity = makeIdentity(name);
  const r = run(
    'INSERT INTO users (name, email, password_hash, role, identity, cell_phone, default_number_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    name, email.trim(), hashPassword(password), role, identity, cell_phone, default_number_id,
  );
  return get('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid));
}

function ensureAdmin() {
  const count = get('SELECT COUNT(*) AS n FROM users').n;
  if (count > 0) return null;
  if (!config.admin.email || !config.admin.password) {
    console.warn('[auth] No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD to create the first admin login.');
    return null;
  }
  const u = createUser({ name: config.admin.name, email: config.admin.email, password: config.admin.password, role: 'admin' });
  console.log(`[auth] Created first admin user ${u.email}`);
  return u;
}

function createSession(userId) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString();
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expires);
  run("DELETE FROM sessions WHERE expires_at < ?", new Date().toISOString());
  return token;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const row = get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`,
    token, new Date().toISOString(),
  );
  return row || null;
}

function setSessionCookie(res, token) {
  const secure = config.publicUrl.startsWith('https');
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(req, res) {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function requireUser(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}

function listUsers() {
  return all('SELECT * FROM users ORDER BY name').map(publicUser);
}

module.exports = {
  hashPassword, verifyPassword, createUser, ensureAdmin, createSession, userFromRequest,
  setSessionCookie, clearSessionCookie, requireUser, requireAdmin, publicUser, listUsers,
};
