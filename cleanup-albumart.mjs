/**
 * mStream — Orphan Album Art Cleanup
 *
 * Finds image files in image-cache/ that are no longer referenced by any
 * song in the SQLite database, and optionally deletes them.
 *
 * Usage:
 *   node --experimental-sqlite cleanup-albumart.mjs          # dry-run (safe)
 *   node --experimental-sqlite cleanup-albumart.mjs --delete  # actually delete
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DELETE_MODE = process.argv.includes('--delete');

// ── Paths (match defaults in src/state/config.js) ────────────────────────────
const DB_PATH      = path.join(__dirname, 'save/db/mstream.sqlite');
const ART_DIR      = path.join(__dirname, 'image-cache');

// ── Sanity checks ─────────────────────────────────────────────────────────────
if (!fs.existsSync(DB_PATH))  { console.error('DB not found:', DB_PATH);  process.exit(1); }
if (!fs.existsSync(ART_DIR))  { console.error('Art dir not found:', ART_DIR); process.exit(1); }

// ── Load referenced aaFile values from DB ─────────────────────────────────────
console.log('Reading database…');
const db = new DatabaseSync(DB_PATH, { open: true });
db.exec('PRAGMA journal_mode=WAL');

const artRows    = db.prepare('SELECT DISTINCT aaFile FROM files WHERE aaFile IS NOT NULL').all();
const hashRows   = db.prepare('SELECT DISTINCT hash  FROM files WHERE hash   IS NOT NULL').all();
const radioRows  = db.prepare('SELECT DISTINCT img   FROM radio_stations WHERE img IS NOT NULL AND img NOT LIKE "http%" AND img NOT LIKE "https%"').all();
db.close();

const referenced = new Set(artRows.map(r => r.aaFile));
const liveHashes = new Set(hashRows.map(r => r.hash));
// Also protect locally-cached radio station logos (radio-*.ext)
radioRows.map(r => r.img).forEach(f => referenced.add(f));
console.log(`  ${referenced.size.toLocaleString()} unique album-art filenames referenced in DB`);
console.log(`  ${liveHashes.size.toLocaleString()} unique file hashes in DB (for waveform cache)`);

// ── Scan image-cache directory ────────────────────────────────────────────────
console.log('Scanning image-cache…');
const allFiles = fs.readdirSync(ART_DIR).filter(f => f !== 'README.md');
console.log(`  ${allFiles.length.toLocaleString()} total files in image-cache`);

// ── Classify each file ────────────────────────────────────────────────────────
// Compressed art variants are named  z{X}-{original}  (e.g. "zl-abc123.jpeg")
// Waveform cache files are named     wf-{hash}.json
const COMPRESSED_RE = /^z[^-]+-(.+)$/;
const WAVEFORM_RE   = /^wf-(.+)\.json$/;

const orphans = [];
for (const file of allFiles) {
  const wfMatch = file.match(WAVEFORM_RE);
  if (wfMatch) {
    // Waveform cache — orphaned if the hash is no longer in the DB
    if (!liveHashes.has(wfMatch[1])) orphans.push(file);
    continue;
  }
  const m = file.match(COMPRESSED_RE);
  const baseName = m ? m[1] : file;          // strip "zl-" prefix if present
  if (!referenced.has(baseName)) {
    orphans.push(file);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const keptCount    = allFiles.length - orphans.length;
const orphanSize   = orphans.reduce((sum, f) => {
  try { return sum + fs.statSync(path.join(ART_DIR, f)).size; } catch { return sum; }
}, 0);

console.log(`\n  Orphaned files : ${orphans.length.toLocaleString()}`);
console.log(`  Space to free  : ${(orphanSize / 1024 / 1024).toFixed(1)} MB`);
console.log(`  Files to keep  : ${keptCount.toLocaleString()}`);

if (orphans.length === 0) {
  console.log('\nNothing to clean up.');
  process.exit(0);
}

// ── Delete (or dry-run) ───────────────────────────────────────────────────────
if (!DELETE_MODE) {
  console.log('\nDry-run complete. Run with --delete to remove orphaned files.');
  process.exit(0);
}

console.log('\nDeleting orphaned files…');
let deleted = 0, errors = 0;
for (const file of orphans) {
  try {
    fs.unlinkSync(path.join(ART_DIR, file));
    deleted++;
  } catch (e) {
    console.error(`  Failed to delete ${file}: ${e.message}`);
    errors++;
  }
}

console.log(`\nDone. Deleted ${deleted.toLocaleString()} files. Errors: ${errors}`);
