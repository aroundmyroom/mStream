import { readFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';

const LOKI_PATH   = '/home/mStream/save/db/user-data.loki-v1.db';
const SQLITE_PATH = '/home/mStream/save/db/mstream.sqlite';

// ── Read Loki ──────────────────────────────────────────────────────────────
const loki = JSON.parse(readFileSync(LOKI_PATH, 'utf8'));
const col  = loki.collections.find(c => c.name === 'playlists');
if (!col) { console.error('No playlists collection found in Loki DB'); process.exit(1); }

// ── Open SQLite ────────────────────────────────────────────────────────────
const db = new DatabaseSync(SQLITE_PATH);
db.exec('PRAGMA journal_mode=WAL');

// ── Wipe any existing playlist rows to avoid duplicates ───────────────────
const existingCount = db.prepare('SELECT count(*) AS n FROM playlists').get().n;
if (existingCount > 0) {
  console.log(`Clearing ${existingCount} existing playlist rows…`);
  db.exec('DELETE FROM playlists');
}

// ── Insert ─────────────────────────────────────────────────────────────────
const insert = db.prepare(
  'INSERT INTO playlists (name, filepath, user, live) VALUES (?, ?, ?, 0)'
);

let insertedHeaders = 0;
let insertedSongs   = 0;

// Group Loki rows so we can report clearly
const byName = {};
for (const row of col.data) {
  const key = row.name;
  if (!byName[key]) byName[key] = { user: row.user, songs: [], hasHeader: false };
  if (row.filepath === null || row.filepath === undefined) {
    byName[key].hasHeader = true;
  } else {
    byName[key].songs.push(row.filepath);
  }
}

// Insert: header row first, then song rows — skip playlists with no songs
for (const [name, pl] of Object.entries(byName)) {
  if (pl.songs.length === 0) {
    console.log(`  Skipping empty playlist: "${name}"`);
    continue;
  }
  // Header row (filepath = NULL) — what getUserPlaylists() queries
  insert.run(name, null, pl.user);
  insertedHeaders++;
  // Song rows
  for (const fp of pl.songs) {
    insert.run(name, fp, pl.user);
    insertedSongs++;
  }
  console.log(`  ✓ "${name}"  (${pl.songs.length} songs, user: ${pl.user})`);
}

db.close();

console.log(`\nDone. Inserted ${insertedHeaders} playlists with ${insertedSongs} total songs.`);
