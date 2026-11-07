import crypto from 'node:crypto';
import { db } from './db.js';
import { HttpError } from './errors.js';

export const COOKIE_NAME = 'ow_session';
const SESSION_SECONDS = 30 * 24 * 3600;
// Secure cookies when HTTPS is on: directly (TLS_CERT) or via a proxy (COOKIE_SECURE=1).
const secureCookie = () => process.env.COOKIE_SECURE === '1' || !!process.env.TLS_CERT;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- Passwords (scrypt, per-user random salt) ----------
const scrypt = (password, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))),
  );

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [alg, saltHex, keyHex] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'));
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Used so a login for an unknown email takes as long as one for a real account.
const DUMMY_HASH = await hashPassword('timing-equalizer-password');

// ---------- Rate limiting (in memory, per process) ----------
const buckets = new Map();

function assertNotLimited(key, max) {
  const b = buckets.get(key);
  if (b && b.resetAt > Date.now() && b.count >= max) {
    throw new HttpError(429, 'Too many attempts, please try again later');
  }
}
function recordHit(key, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
}

// ---------- Sessions ----------
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const cookieHeader = (value, maxAge) =>
  `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie() ? '; Secure' : ''}`;

export function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), Math.floor(Date.now() / 1000));
  return row ? { id: row.id, email: row.email } : null;
}

export function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Please sign in');
  return user;
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    userId,
    Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  );
  res.setHeader('Set-Cookie', cookieHeader(token, SESSION_SECONDS));
}

export function logout(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', cookieHeader('', 0));
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Math.floor(Date.now() / 1000));
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

// ---------- Register / login ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanCredentials(email, password) {
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new HttpError(400, 'email and password are required');
  }
  const e = email.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new HttpError(400, 'Enter a valid email address');
  return { e, password };
}

export async function register(res, ip, email, password) {
  const { e } = cleanCredentials(email, password);
  if (password.length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
  if (password.length > 200) throw new HttpError(400, 'Password is too long');

  assertNotLimited(`reg:${ip}`, 10);
  recordHit(`reg:${ip}`, 3600 * 1000);

  const hash = await hashPassword(password);
  let id;
  try {
    id = Number(db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(e, hash).lastInsertRowid);
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw new HttpError(409, 'That email is already registered');
    throw err;
  }
  startSession(res, id);
  return { id, email: e };
}

export async function login(res, ip, email, password) {
  const { e } = cleanCredentials(email, password);
  if (password.length > 200) throw new HttpError(401, 'Incorrect email or password');

  const key = `login:${ip}`;
  assertNotLimited(key, 10);

  const row = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(e);
  const ok = await verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) {
    recordHit(key, 15 * 60 * 1000);
    throw new HttpError(401, 'Incorrect email or password');
  }
  buckets.delete(key);
  startSession(res, row.id);
  return { id: row.id, email: row.email };
}
