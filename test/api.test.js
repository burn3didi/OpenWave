import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Isolated data + media so tests never touch a real library.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openwave-test-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.MEDIA_DIR = path.join(tmp, 'media');

const wav = path.join(tmp, 'tone.wav');
execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', wav]);
const wavBytes = fs.readFileSync(wav);

let server;
let base;

before(async () => {
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Minimal client with its own cookie jar.
function client() {
  let cookie = '';
  return async (p, { method = 'GET', json, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (json !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
}

const alice = client();
const bob = client();
const anon = client();
const PW = 'correct horse battery';
let trackId;
let aliceTrackFile;
let playlistId;

test('security headers are set', async () => {
  const r = await anon('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');

  const health = await anon('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.data, 'ok');
});

test('app is installable: manifest, service worker and icons are served correctly', async () => {
  const manifest = await anon('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
  assert.equal(manifest.data.display, 'standalone');

  // Every icon the manifest names must exist and be an image.
  for (const icon of manifest.data.icons) {
    const res = await fetch(base + icon.src);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.headers.get('content-type'), icon.type, icon.src);
    await res.arrayBuffer();
  }
  const sizes = manifest.data.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(manifest.data.icons.some((i) => i.purpose === 'maskable'));

  const sw = await anon('/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache'); // updates must reach users
  assert.match(sw.data, /startsWith\('\/api\/'\)/); // API and audio are never cached
});

test('static files cannot escape the public folder', async () => {
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/%2e%2e%2fdata%2fopenwave.db']) {
    const r = await anon(p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
});

test('registration validates input and sets an HttpOnly session', async () => {
  assert.equal((await anon('/api/register', { method: 'POST', json: { email: 'nope', password: PW } })).status, 400);
  assert.equal((await anon('/api/register', { method: 'POST', json: { email: 'a@x.io', password: 'short' } })).status, 400);

  const r = await alice('/api/register', { method: 'POST', json: { email: 'Alice@Example.com', password: PW } });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.email, 'alice@example.com'); // normalised
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.match(r.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal(JSON.stringify(r.data).includes('password'), false);

  assert.equal((await alice('/api/me')).data.user.email, 'alice@example.com');
  assert.equal((await anon('/api/me')).data.user, null);
});

test('duplicate email is rejected', async () => {
  const r = await anon('/api/register', { method: 'POST', json: { email: 'alice@example.com', password: PW } });
  assert.equal(r.status, 409);
});

test('login, logout and session invalidation', async () => {
  const bad = await anon('/api/login', { method: 'POST', json: { email: 'alice@example.com', password: 'wrong-password-1' } });
  const unknown = await anon('/api/login', { method: 'POST', json: { email: 'nobody@example.com', password: 'wrong-password-1' } });
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.data, unknown.data); // no account enumeration

  const second = client();
  assert.equal((await second('/api/login', { method: 'POST', json: { email: 'alice@example.com', password: PW } })).status, 200);
  assert.equal((await second('/api/me')).data.user.email, 'alice@example.com');
  await second('/api/logout', { method: 'POST' });
  assert.equal((await second('/api/me')).data.user, null);
});

test('uploads require sign-in, enforce licenses and validate audio', async () => {
  const q = '?title=Tone&artist=Alice&license=CC0';
  assert.equal((await anon(`/api/tracks${q}`, { method: 'POST', body: wavBytes })).status, 401);

  const noLicense = await alice('/api/tracks?title=Tone&artist=Alice&license=all-rights-reserved', { method: 'POST', body: wavBytes });
  assert.equal(noLicense.status, 400);

  const notAudio = await alice(`/api/tracks${q}`, { method: 'POST', body: Buffer.from('definitely not audio') });
  assert.equal(notAudio.status, 400);
  assert.equal(notAudio.data.error, 'File is not a valid audio file');

  const ok = await alice(`/api/tracks${q}`, { method: 'POST', body: wavBytes });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.mine, true);
  assert.equal(ok.data.file, undefined); // internal filename not leaked
  trackId = ok.data.id;
  aliceTrackFile = fs.readdirSync(process.env.MEDIA_DIR).find((f) => f.startsWith(trackId));
  assert.ok(aliceTrackFile);
});

test('catalog is public; "mine" is only true for the uploader', async () => {
  const anonList = await anon('/api/tracks');
  assert.equal(anonList.data.tracks.length, 1);
  assert.equal(anonList.data.tracks[0].mine, false);
  assert.equal(anonList.data.tracks[0].uploader_id, undefined);
  assert.equal((await alice('/api/tracks')).data.tracks[0].mine, true);
  assert.equal((await anon('/api/tracks?q=zzzz')).data.tracks.length, 0);
  assert.equal((await anon('/api/tracks?q=%25')).data.tracks.length, 0); // wildcards are escaped
});

test('streaming supports ranges', async () => {
  const full = await fetch(`${base}/api/tracks/${trackId}/stream`);
  const size = (await full.arrayBuffer()).byteLength;
  assert.equal(full.status, 200);

  const part = await fetch(`${base}/api/tracks/${trackId}/stream`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-99/${size}`);
  assert.equal((await part.arrayBuffer()).byteLength, 100);

  const tail = await fetch(`${base}/api/tracks/${trackId}/stream`, { headers: { Range: 'bytes=-50' } });
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 50);

  const bad = await fetch(`${base}/api/tracks/${trackId}/stream`, { headers: { Range: `bytes=${size + 10}-` } });
  assert.equal(bad.status, 416);
  await bad.arrayBuffer();
});

test('playlists are private to their owner', async () => {
  await bob('/api/register', { method: 'POST', json: { email: 'bob@example.com', password: PW } });

  assert.equal((await anon('/api/playlists', { method: 'POST', json: { name: 'x' } })).status, 401);
  const created = await alice('/api/playlists', { method: 'POST', json: { name: 'Mine' } });
  assert.equal(created.status, 201);
  playlistId = created.data.id;
  assert.equal((await alice(`/api/playlists/${playlistId}/tracks`, { method: 'POST', json: { track_id: trackId } })).status, 201);

  assert.equal((await alice('/api/playlists')).data.playlists[0].track_count, 1);
  assert.equal((await bob('/api/playlists')).data.playlists.length, 0);
  assert.equal((await anon('/api/playlists')).data.playlists.length, 0);

  // Bob can neither read, modify nor delete it, and the response doesn't reveal it exists.
  assert.equal((await bob(`/api/playlists/${playlistId}`)).status, 404);
  assert.equal((await bob(`/api/playlists/${playlistId}/tracks`, { method: 'POST', json: { track_id: trackId } })).status, 404);
  assert.equal((await bob(`/api/playlists/${playlistId}`, { method: 'DELETE' })).status, 404);
  assert.equal((await anon(`/api/playlists/${playlistId}`)).status, 401);
  assert.equal((await alice(`/api/playlists/${playlistId}`)).data.tracks.length, 1);
});

test('cross-site state-changing requests are blocked', async () => {
  const r = await alice('/api/playlists', { method: 'POST', json: { name: 'evil' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  const same = await alice('/api/playlists', { method: 'POST', json: { name: 'fine' }, headers: { Origin: base } });
  assert.equal(same.status, 201);
});

test('only the uploader can delete a track; deleting removes the file', async () => {
  assert.equal((await anon(`/api/tracks/${trackId}`, { method: 'DELETE' })).status, 401);
  assert.equal((await bob(`/api/tracks/${trackId}`, { method: 'DELETE' })).status, 403);
  assert.ok(fs.existsSync(path.join(process.env.MEDIA_DIR, aliceTrackFile)));

  assert.equal((await alice(`/api/tracks/${trackId}`, { method: 'DELETE' })).status, 200);
  assert.equal(fs.existsSync(path.join(process.env.MEDIA_DIR, aliceTrackFile)), false);
  assert.equal((await anon(`/api/tracks/${trackId}/stream`)).status, 404);
  assert.equal((await alice(`/api/playlists/${playlistId}`)).data.tracks.length, 0); // removed from playlists too
});

test('repeated failed logins are rate limited (runs last)', async () => {
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    statuses.push((await anon('/api/login', { method: 'POST', json: { email: 'alice@example.com', password: `wrong-password-${i}` } })).status);
  }
  assert.ok(statuses.includes(429), statuses.join(','));
  // Even the right password is refused while locked out.
  const right = await anon('/api/login', { method: 'POST', json: { email: 'alice@example.com', password: PW } });
  assert.equal(right.status, 429);
});
