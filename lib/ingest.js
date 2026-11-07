import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MEDIA_DIR = process.env.MEDIA_DIR || path.join(root, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Only music that can legally be streamed without a label deal.
export const LICENSES = [
  'CC0',
  'CC-BY',
  'CC-BY-SA',
  'CC-BY-NC',
  'public-domain',
  'original', // uploaded by the artist who owns it
];

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed: ${err.trim().slice(-300)}`)),
    );
  });
}

async function probe(file) {
  let info;
  try {
    info = JSON.parse(
      await run('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration:format_tags=title,artist,album:stream=codec_type',
        '-of', 'json',
        file,
      ]),
    );
  } catch {
    throw new Error('File is not a valid audio file');
  }
  const hasAudio = (info.streams || []).some((s) => s.codec_type === 'audio');
  if (!hasAudio) throw new Error('File has no audio stream');
  const tags = Object.fromEntries(
    Object.entries(info.format?.tags || {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return { duration: Number(info.format?.duration) || 0, tags };
}

/**
 * Validate an audio file, transcode it to AAC (.m4a, 128 kbps) and register it
 * in the catalog. `inputPath` must be an absolute path.
 */
export async function ingest(inputPath, meta = {}) {
  const license = meta.license;
  if (!LICENSES.includes(license)) {
    throw new Error(`license must be one of: ${LICENSES.join(', ')}`);
  }

  const { duration, tags } = await probe(inputPath);
  if (duration <= 0) throw new Error('Could not read track duration');

  const title = (meta.title || tags.title || path.parse(inputPath).name).trim();
  const artist = (meta.artist || tags.artist || '').trim();
  if (!artist) throw new Error('artist is required');

  const id = crypto.randomBytes(8).toString('hex');
  const file = `${id}.m4a`;
  await run('ffmpeg', [
    '-nostdin', '-y', '-v', 'error',
    '-i', inputPath,
    '-vn', '-map_metadata', '-1',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    path.join(MEDIA_DIR, file),
  ]);

  db.prepare(
    `INSERT INTO tracks (id, title, artist, album, duration, license, source_url, file, uploader_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    title.slice(0, 200),
    artist.slice(0, 200),
    (meta.album || tags.album || '').slice(0, 200) || null,
    duration,
    license,
    meta.source_url ? String(meta.source_url).slice(0, 500) : null,
    file,
    meta.uploader_id ?? null,
  );

  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
}
