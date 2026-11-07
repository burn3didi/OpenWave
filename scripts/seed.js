// Usage: node scripts/seed.js <folder> [license] [artist]
// Imports every audio file in a folder into the catalog (transcoded to AAC).
// Title/artist come from the file's tags unless you pass an artist fallback.
import fs from 'node:fs';
import path from 'node:path';
import { ingest, LICENSES } from '../lib/ingest.js';

const [, , folderArg, license = 'CC0', artist] = process.argv;
if (!folderArg) {
  console.error('Usage: node scripts/seed.js <folder> [license] [artist]');
  console.error(`Licenses: ${LICENSES.join(', ')}`);
  process.exit(1);
}

const folder = path.resolve(folderArg);
const exts = new Set(['.mp3', '.wav', '.flac', '.ogg', '.opus', '.m4a', '.aac']);
const files = fs
  .readdirSync(folder)
  .filter((f) => exts.has(path.extname(f).toLowerCase()))
  .sort();

let ok = 0;
for (const f of files) {
  try {
    const t = await ingest(path.join(folder, f), { license, artist });
    console.log(`+ ${t.artist} - ${t.title} (${Math.round(t.duration)}s)`);
    ok++;
  } catch (e) {
    console.error(`! ${f}: ${e.message}`);
  }
}
console.log(`Imported ${ok}/${files.length} tracks.`);
