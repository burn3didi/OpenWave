import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db } from './lib/db.js';
import { ingest, LICENSES, MEDIA_DIR } from './lib/ingest.js';
import { HttpError } from './lib/errors.js';
import { currentUser, requireUser, register, login, logout, purgeExpiredSessions } from './lib/auth.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(root, 'public');
const MAX_UPLOAD = 100 * 1024 * 1024; // 100 MB
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // behind nginx/Caddy/Cloudflare

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

const send = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
};

const clientIp = (req) =>
  (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

// Reject cross-site state-changing requests (defence in depth on top of SameSite=Lax).
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Bad origin');
  }
  const expected = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host;
  if (host !== expected) throw new HttpError(403, 'Cross-site request blocked');
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (body === null || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

async function saveUpload(req) {
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_UPLOAD) throw new HttpError(413, 'File exceeds 100 MB');
  const tmp = path.join(os.tmpdir(), `openwave-${crypto.randomBytes(8).toString('hex')}`);
  const out = fs.createWriteStream(tmp);
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD) throw new HttpError(413, 'File exceeds 100 MB');
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r) => out.end(r));
    if (size === 0) throw new HttpError(400, 'Empty upload');
    return tmp;
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// Byte-range streaming so browsers can seek without downloading the whole file.
function streamFile(req, res, file, head) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new HttpError(404, 'Audio file missing');
  }
  const size = stat.size;
  const headers = {
    'Content-Type': 'audio/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    return head ? res.end() : fs.createReadStream(file).pipe(res);
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start;
  let end;
  if (m && (m[1] || m[2])) {
    if (m[1] === '') {
      start = Math.max(size - Number(m[2]), 0); // suffix range: last N bytes
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
  }
  if (start === undefined || start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    ...headers,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1,
  });
  return head ? res.end() : fs.createReadStream(file, { start, end }).pipe(res);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  let file;
  try {
    file = path.resolve(PUBLIC_DIR, decodeURIComponent(rel));
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new HttpError(404, 'Not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const publicTrack = ({ file, ...t }, user) => ({
  ...t,
  uploader_id: undefined,
  mine: !!user && t.uploader_id === user.id,
  stream_url: `/api/tracks/${t.id}/stream`,
});

const ownedPlaylist = (id, user) => {
  const pl = db.prepare('SELECT id, name, user_id FROM playlists WHERE id = ?').get(id);
  // Same answer for "missing" and "someone else's" so ids can't be probed.
  if (!pl || pl.user_id !== user.id) throw new HttpError(404, 'Playlist not found');
  return pl;
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const method = req.method;
  let m;

  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  // Health check for hosting platforms (no database access, no secrets).
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end('ok');
  }

  if (!pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    return serveStatic(req, res, pathname);
  }

  if (method !== 'GET' && method !== 'HEAD') checkOrigin(req);

  // ---- Accounts ----
  if (pathname === '/api/me' && method === 'GET') {
    return send(res, 200, { user: currentUser(req) });
  }
  if (pathname === '/api/register' && method === 'POST') {
    const b = await readJson(req);
    return send(res, 201, { user: await register(res, clientIp(req), b.email, b.password) });
  }
  if (pathname === '/api/login' && method === 'POST') {
    const b = await readJson(req);
    return send(res, 200, { user: await login(res, clientIp(req), b.email, b.password) });
  }
  if (pathname === '/api/logout' && method === 'POST') {
    logout(req, res);
    return send(res, 200, { ok: true });
  }

  // ---- Tracks ----
  if (pathname === '/api/tracks' && method === 'GET') {
    const user = currentUser(req);
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const rows = q
      ? db
          .prepare(
            `SELECT * FROM tracks
             WHERE title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\'
             ORDER BY artist, title LIMIT 200`,
          )
          .all(like, like, like)
      : db.prepare('SELECT * FROM tracks ORDER BY created_at DESC, title LIMIT 200').all();
    return send(res, 200, { tracks: rows.map((t) => publicTrack(t, user)), licenses: LICENSES });
  }

  if (pathname === '/api/tracks' && method === 'POST') {
    const user = requireUser(req);
    const p = url.searchParams;
    const tmp = await saveUpload(req);
    try {
      const track = await ingest(tmp, {
        title: p.get('title'),
        artist: p.get('artist'),
        album: p.get('album'),
        license: p.get('license'),
        source_url: p.get('source_url'),
        uploader_id: user.id,
      });
      return send(res, 201, publicTrack(track, user));
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(400, e.message);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  if ((m = pathname.match(/^\/api\/tracks\/([a-f0-9]{16})$/)) && method === 'DELETE') {
    const user = requireUser(req);
    const t = db.prepare('SELECT id, file, uploader_id FROM tracks WHERE id = ?').get(m[1]);
    if (!t) throw new HttpError(404, 'Track not found');
    if (t.uploader_id !== user.id) throw new HttpError(403, 'You can only delete your own uploads');
    db.prepare('DELETE FROM tracks WHERE id = ?').run(t.id);
    fs.rmSync(path.join(MEDIA_DIR, t.file), { force: true });
    return send(res, 200, { ok: true });
  }

  if ((m = pathname.match(/^\/api\/tracks\/([a-f0-9]{16})\/stream$/)) && (method === 'GET' || method === 'HEAD')) {
    const t = db.prepare('SELECT file FROM tracks WHERE id = ?').get(m[1]);
    if (!t) throw new HttpError(404, 'Track not found');
    return streamFile(req, res, path.join(MEDIA_DIR, t.file), method === 'HEAD');
  }

  // ---- Playlists (private to their owner) ----
  if (pathname === '/api/playlists' && method === 'GET') {
    const user = currentUser(req);
    if (!user) return send(res, 200, { playlists: [] });
    const rows = db
      .prepare(
        `SELECT p.id, p.name, COUNT(pt.track_id) AS track_count
         FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
         WHERE p.user_id = ? GROUP BY p.id ORDER BY p.created_at DESC`,
      )
      .all(user.id);
    return send(res, 200, { playlists: rows });
  }

  if (pathname === '/api/playlists' && method === 'POST') {
    const user = requireUser(req);
    const { name } = await readJson(req);
    if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'name is required');
    const clean = name.trim().slice(0, 100);
    const id = crypto.randomBytes(6).toString('hex');
    db.prepare('INSERT INTO playlists (id, name, user_id) VALUES (?, ?, ?)').run(id, clean, user.id);
    return send(res, 201, { id, name: clean, track_count: 0 });
  }

  if ((m = pathname.match(/^\/api\/playlists\/([a-f0-9]{12})$/))) {
    const user = requireUser(req);
    const pl = ownedPlaylist(m[1], user);
    if (method === 'GET') {
      const tracks = db
        .prepare(
          `SELECT t.* FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
           WHERE pt.playlist_id = ? ORDER BY pt.position`,
        )
        .all(pl.id);
      return send(res, 200, { id: pl.id, name: pl.name, tracks: tracks.map((t) => publicTrack(t, user)) });
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM playlists WHERE id = ?').run(pl.id);
      return send(res, 200, { ok: true });
    }
  }

  if ((m = pathname.match(/^\/api\/playlists\/([a-f0-9]{12})\/tracks(?:\/([a-f0-9]{16}))?$/))) {
    const user = requireUser(req);
    const [, playlistId, trackId] = m;
    ownedPlaylist(playlistId, user);
    if (method === 'POST' && !trackId) {
      const body = await readJson(req);
      if (typeof body.track_id !== 'string' || !db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(body.track_id)) {
        throw new HttpError(404, 'Track not found');
      }
      const { next } = db
        .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM playlist_tracks WHERE playlist_id = ?')
        .get(playlistId);
      db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)').run(
        playlistId,
        body.track_id,
        next,
      );
      return send(res, 201, { ok: true });
    }
    if (method === 'DELETE' && trackId) {
      db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(playlistId, trackId);
      return send(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'Not found');
}

const requestHandler = async (req, res) => {
  try {
    await handle(req, res);
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Internal error' });
  }
};

// Serves HTTPS when TLS_CERT and TLS_KEY (paths to PEM files) are set, plain HTTP otherwise.
export function createServer() {
  const { TLS_CERT, TLS_KEY } = process.env;
  if (TLS_CERT && TLS_KEY) {
    return https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, requestHandler);
  }
  return http.createServer(requestHandler);
}

// Start listening only when run directly (`node server.js`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tls = !!(process.env.TLS_CERT && process.env.TLS_KEY);
  const PORT = Number(process.env.PORT || (tls ? 8443 : 3000));
  createServer().listen(PORT, () => console.log(`OpenWave running at ${tls ? 'https' : 'http'}://localhost:${PORT}`));
  setInterval(purgeExpiredSessions, 3600 * 1000).unref();
  if (!tls && process.env.COOKIE_SECURE !== '1') {
    console.log('Note: phones can only install the app over HTTPS (see README, "Install on your phone").');
  }
}
