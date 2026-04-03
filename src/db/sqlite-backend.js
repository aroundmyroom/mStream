import path from 'path';
import { mkdirSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'crypto';

// ── Subsonic ID helpers ───────────────────────────────────────────────────────
// Artist ID = MD5(normalised artist name).slice(0,16)
// Album ID  = MD5(normalised "artist|||album").slice(0,16)
// 16 hex chars = 64 bits — collision-free for any practical library size.
function _makeArtistId(artist) {
  return createHash('md5').update((artist || '').toLowerCase().trim()).digest('hex').slice(0, 16);
}
function _makeAlbumId(artist, album) {
  return createHash('md5')
    .update(`${(artist || '').toLowerCase().trim()}|||${(album || '').toLowerCase().trim()}`)
    .digest('hex').slice(0, 16);
}

let db;
const _s = {}; // cached prepared statements — populated in init(), reused on every call

export function init(dbDirectory) {
  mkdirSync(dbDirectory, { recursive: true });
  const dbPath = path.join(dbDirectory, 'mstream.sqlite');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  // NORMAL skips per-write fsync (safe with WAL); prevents 50-200ms event-loop
  // stalls on slow storage (SD card, HDD) that would interrupt audio streaming.
  db.exec('PRAGMA synchronous = NORMAL');
  // Raise auto-checkpoint threshold so SQLite never triggers a blocking
  // checkpoint while a song is streaming. The WAL is cleaned up on DB close.
  db.exec('PRAGMA wal_autocheckpoint(10000)');
  // 32 MB page cache — default 2 MB is far too small for a 123K-song library;
  // keeps frequently-used B-tree pages (indexes, hot rows) in RAM.
  db.exec('PRAGMA cache_size = -32000');
  // Keep sort/temp B-trees in memory instead of spilling to disk.
  db.exec('PRAGMA temp_store = MEMORY');
  // Migrate to 8 KB pages if still on the SQLite default 4 KB.
  // Larger pages = shallower B-trees = fewer reads per query on a 167 MB+ DB.
  // PRAGMA page_size + VACUUM rebuilds the file in-place with the new page size.
  // Runs once on first boot after this change (~3–5 s for 167 MB); skipped on
  // all subsequent boots because page_size is already 8192.
  const currentPageSize = db.prepare('PRAGMA page_size').get().page_size;
  if (currentPageSize !== 8192) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA page_size = 8192');
    db.exec('VACUUM');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      title TEXT, artist TEXT, year INTEGER, album TEXT,
      filepath TEXT NOT NULL, format TEXT, track INTEGER, trackOf INTEGER, disk INTEGER,
      modified REAL, hash TEXT, aaFile TEXT, vpath TEXT NOT NULL,
      ts INTEGER, sID TEXT, replaygainTrackDb REAL, genre TEXT, cuepoints TEXT,
      duration REAL, artist_id TEXT, album_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_files_filepath_vpath ON files(filepath, vpath);
    CREATE INDEX IF NOT EXISTS idx_files_vpath ON files(vpath);
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
    CREATE INDEX IF NOT EXISTS idx_files_ts ON files(ts);
    CREATE INDEX IF NOT EXISTS idx_files_year ON files(year);
    CREATE INDEX IF NOT EXISTS idx_files_genre ON files(genre);
    CREATE INDEX IF NOT EXISTS idx_files_album ON files(album);
    CREATE INDEX IF NOT EXISTS idx_files_artist ON files(artist);

    CREATE TABLE IF NOT EXISTS user_metadata (
      hash TEXT NOT NULL, user TEXT NOT NULL,
      rating INTEGER, pc INTEGER DEFAULT 0, lp INTEGER, starred INTEGER DEFAULT 0,
      UNIQUE(hash, user)
    );
    CREATE INDEX IF NOT EXISTS idx_um_user ON user_metadata(user);

    CREATE TABLE IF NOT EXISTS playlists (
      name TEXT NOT NULL, filepath TEXT,
      user TEXT NOT NULL, live INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pl_user_name ON playlists(user, name);

    CREATE TABLE IF NOT EXISTS shared_playlists (
      playlistId TEXT NOT NULL UNIQUE,
      playlist TEXT NOT NULL,
      user TEXT NOT NULL, expires INTEGER, token TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sp_expires ON shared_playlists(expires);

    CREATE TABLE IF NOT EXISTS scan_errors (
      guid      TEXT NOT NULL PRIMARY KEY,
      filepath  TEXT NOT NULL,
      vpath     TEXT NOT NULL,
      error_type TEXT NOT NULL,
      error_msg  TEXT,
      stack      TEXT,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      count      INTEGER NOT NULL DEFAULT 1,
      fixed_at   INTEGER,
      fix_action TEXT,
      confirmed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_se_last_seen ON scan_errors(last_seen);
    CREATE INDEX IF NOT EXISTS idx_se_vpath    ON scan_errors(vpath);
    CREATE INDEX IF NOT EXISTS idx_se_fixed_at ON scan_errors(fixed_at);

    CREATE TABLE IF NOT EXISTS user_settings (
      username TEXT NOT NULL PRIMARY KEY,
      prefs    TEXT NOT NULL DEFAULT '{}',
      queue    TEXT NOT NULL DEFAULT 'null'
    );

    CREATE TABLE IF NOT EXISTS radio_stations (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      user    TEXT NOT NULL,
      name    TEXT NOT NULL,
      genre   TEXT,
      country TEXT,
      link_a  TEXT,
      link_b  TEXT,
      link_c  TEXT,
      img     TEXT,
      sort_order INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_rs_user ON radio_stations(user);

    CREATE TABLE IF NOT EXISTS podcast_feeds (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user         TEXT NOT NULL,
      url          TEXT NOT NULL,
      title        TEXT,
      description  TEXT,
      img          TEXT,
      author       TEXT,
      language     TEXT,
      last_fetched INTEGER,
      created_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pf_user ON podcast_feeds(user);

    CREATE TABLE IF NOT EXISTS podcast_episodes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id       INTEGER NOT NULL,
      guid          TEXT NOT NULL,
      title         TEXT,
      description   TEXT,
      audio_url     TEXT NOT NULL,
      pub_date      INTEGER,
      duration_secs INTEGER DEFAULT 0,
      img           TEXT,
      played        INTEGER DEFAULT 0,
      play_position REAL DEFAULT 0,
      created_at    INTEGER,
      UNIQUE(feed_id, guid)
    );
    CREATE INDEX IF NOT EXISTS idx_pe_feed_id ON podcast_episodes(feed_id);

    CREATE TABLE IF NOT EXISTS smart_playlists (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      user     TEXT NOT NULL,
      name     TEXT NOT NULL,
      filters  TEXT NOT NULL DEFAULT '{}',
      sort     TEXT NOT NULL DEFAULT 'artist',
      limit_n  INTEGER NOT NULL DEFAULT 100,
      created  INTEGER NOT NULL,
      UNIQUE(user, name)
    );
    CREATE INDEX IF NOT EXISTS idx_spl_user ON smart_playlists(user);

    CREATE TABLE IF NOT EXISTS genre_groups (
      id     INTEGER PRIMARY KEY DEFAULT 1,
      groups TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS radio_schedules (
      id           TEXT PRIMARY KEY,
      username     TEXT NOT NULL,
      station_name TEXT NOT NULL,
      stream_url   TEXT NOT NULL,
      art_file     TEXT,
      vpath        TEXT NOT NULL,
      start_time   TEXT NOT NULL,
      start_date   TEXT,
      duration_min INTEGER NOT NULL DEFAULT 60,
      recurrence   TEXT NOT NULL DEFAULT 'once',
      recur_days   TEXT,
      description  TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rsched_user    ON radio_schedules(username);
    CREATE INDEX IF NOT EXISTS idx_rsched_enabled ON radio_schedules(enabled);
  `);
  // Migration: add cuepoints column for databases created before this feature
  try { db.exec('ALTER TABLE files ADD COLUMN cuepoints TEXT'); } catch (_e) {}
  // Migration: add fixed_at column for scan-error auto-fix feature
  try { db.exec('ALTER TABLE scan_errors ADD COLUMN fixed_at INTEGER'); } catch (_e) {}
  // Migration: add art_source column to track art provenance (embedded / directory / discogs)
  try { db.exec('ALTER TABLE files ADD COLUMN art_source TEXT'); } catch (_e) {}
  // Migration: add duration column (track length in seconds)
  try { db.exec('ALTER TABLE files ADD COLUMN duration REAL'); } catch (_e) {}
  // Migration: add description column to radio_schedules
  try { db.exec('ALTER TABLE radio_schedules ADD COLUMN description TEXT'); } catch (_e) {}
  // Migration: add fix_action column to record what the fix button actually did
  try { db.exec('ALTER TABLE scan_errors ADD COLUMN fix_action TEXT'); } catch (_e) {}
  // Migration: add confirmed_at column to record when a rescan confirmed the file is OK
  try { db.exec('ALTER TABLE scan_errors ADD COLUMN confirmed_at INTEGER'); } catch (_e) {}
  // Migration: add artist_id / album_id columns for indexed Subsonic-style lookups
  try { db.exec('ALTER TABLE files ADD COLUMN artist_id TEXT'); } catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN album_id TEXT'); } catch (_e) {}
  // Migration: add starred column to user_metadata for Subsonic star/unstar
  try { db.exec('ALTER TABLE user_metadata ADD COLUMN starred INTEGER DEFAULT 0'); } catch (_e) {}
  // Migration: add sort_order to podcast_feeds for drag-to-reorder
  try { db.exec('ALTER TABLE podcast_feeds ADD COLUMN sort_order INTEGER DEFAULT 0'); } catch (_e) {}
  // Migration: add trackOf (track total) for complete-album detection
  try { db.exec('ALTER TABLE files ADD COLUMN trackOf INTEGER'); } catch (_e) {}
  // Ensure indexes exist (IF NOT EXISTS is idempotent — safe on every startup)
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_artist_id ON files(artist_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_album_id ON files(album_id)');
  // Covering index for getAaFileForDir: fast folder-art lookups by (vpath, filepath prefix)
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_vpath_filepath_aa ON files(vpath, filepath, aaFile)');
  // One-time backfill: compute artist_id / album_id for all records added before this migration
  const _bfCount = db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE artist_id IS NULL').get().cnt;
  if (_bfCount > 0) {
    const _bfRows = db.prepare('SELECT rowid, artist, album FROM files WHERE artist_id IS NULL').all();
    const _bfUpd  = db.prepare('UPDATE files SET artist_id = ?, album_id = ? WHERE rowid = ?');
    db.exec('BEGIN');
    for (const r of _bfRows) _bfUpd.run(_makeArtistId(r.artist), _makeAlbumId(r.artist, r.album), r.rowid);
    db.exec('COMMIT');
  }

  // ── Additional migration indexes (idempotent, safe on every startup) ──────
  // aaFile: used by countArtUsage (per-file during art cleanup) and getLiveArtFilenames
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_aaFile ON files(aaFile)');
  // (vpath, sID): used by getStaleFileHashes and removeStaleFiles after every scan pass
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_vpath_sID ON files(vpath, sID)');
  // user_metadata sort/filter indexes: Recently Played, Most Played, Rated, Starred
  db.exec('CREATE INDEX IF NOT EXISTS idx_um_user_lp      ON user_metadata(user, lp)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_um_user_pc      ON user_metadata(user, pc)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_um_user_rating  ON user_metadata(user, rating)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_um_user_starred ON user_metadata(user, starred)');

  // ── FTS5 full-text index (songs) ─────────────────────────────────────────
  // External-content table: FTS5 tokenises title/artist/album/filepath columns
  // from the `files` table without duplicating the raw data.
  // unicode61 tokenizer with remove_diacritics=1: café == cafe, case-insensitive.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_files USING fts5(
    title, artist, album, filepath,
    content='files', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 1'
  )`);
  // Rebuild the FTS index if it is empty (first start after introducing FTS).
  // External-content tables report COUNT(*) == files count even when hollow,
  // so we check fts_files_data (the real B-tree backing store) instead.
  const _ftsDataRows = db.prepare('SELECT COUNT(*) AS cnt FROM fts_files_data').get().cnt;
  if (_ftsDataRows < 5) {
    db.exec("INSERT INTO fts_files(fts_files) VALUES ('rebuild')");
  }

  // ── Folder index ─────────────────────────────────────────────────────────
  // One row per unique directory path extracted from files.filepath.
  // folder_name = the last path component (most information-dense part).
  db.exec(`CREATE TABLE IF NOT EXISTS folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vpath       TEXT NOT NULL,
    dirpath     TEXT NOT NULL,
    folder_name TEXT NOT NULL,
    UNIQUE(vpath, dirpath)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_folders_vpath ON folders(vpath)');
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_folders USING fts5(
    folder_name,
    content='folders', content_rowid='id',
    tokenize='trigram'
  )`);

  // ── Normalized artist index ───────────────────────────────────────────────
  // One row per unique normalized artist name. artist_raw_variants stores all
  // raw tag variants that normalize to the same name (JSON array).
  // The DB itself is NOT modified — normalization happens at index-build time.
  db.exec(`CREATE TABLE IF NOT EXISTS artists_normalized (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_clean        TEXT NOT NULL UNIQUE,
    artist_raw_variants TEXT NOT NULL DEFAULT '[]'
  )`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_artists USING fts5(
    artist_clean,
    content='artists_normalized', content_rowid='id',
    tokenize='trigram'
  )`);
  // Migration: add vpaths_json column if missing (introduced after initial release)
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN vpaths_json TEXT DEFAULT '[]'"); } catch (_e) { /* already exists */ }

  // ── Cache hot-path prepared statements ───────────────────────────────────
  // These functions are called once per file during scans (up to 123K times).
  // Caching avoids re-running sqlite3_prepare_v2 on every call.
  Object.assign(_s, {
    findFile:       db.prepare('SELECT rowid AS id, * FROM files WHERE filepath = ? AND vpath = ?'),
    updateScanId:   db.prepare('UPDATE files SET sID = ? WHERE filepath = ? AND vpath = ?'),
    updateArt:      db.prepare('UPDATE files SET aaFile = ?, sID = ?, art_source = ? WHERE filepath = ? AND vpath = ?'),
    countArtUsage:  db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE aaFile = ?'),
    updateCue:      db.prepare('UPDATE files SET cuepoints = ? WHERE filepath = ? AND vpath = ?'),
    updateDuration: db.prepare('UPDATE files SET duration = ? WHERE filepath = ? AND vpath = ?'),
    liveArt:        db.prepare('SELECT DISTINCT aaFile FROM files WHERE aaFile IS NOT NULL'),
    liveHashes:     db.prepare('SELECT DISTINCT hash FROM files WHERE hash IS NOT NULL'),
    staleHashes:    db.prepare('SELECT hash FROM files WHERE vpath = ? AND sID != ? AND hash IS NOT NULL'),
    removeStale:    db.prepare('DELETE FROM files WHERE vpath = ? AND sID != ?'),
    removeByPath:   db.prepare('DELETE FROM files WHERE filepath = ? AND vpath = ?'),
    insertFileTs:   db.prepare('SELECT ts FROM files WHERE hash = ? AND ts IS NOT NULL LIMIT 1'),
    insertFileRow:  db.prepare(
      'INSERT INTO files (title, artist, year, album, filepath, format, track, trackOf, disk, modified, hash, aaFile, vpath, ts, sID, replaygainTrackDb, genre, cuepoints, art_source, duration, artist_id, album_id) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    // FTS5 write statements — used in insert / remove / tag-update paths
    ftsInsert:  db.prepare('INSERT INTO fts_files(rowid, title, artist, album, filepath) VALUES (?, ?, ?, ?, ?)'),
    ftsDel:     db.prepare("INSERT INTO fts_files(fts_files, rowid, title, artist, album, filepath) VALUES ('delete', ?, ?, ?, ?, ?)"),
    ftsRebuild: db.prepare("INSERT INTO fts_files(fts_files) VALUES ('rebuild')"),
  });
}

export function close() {
  if (db) { db.close(); }
}

// Produce a clean, fully-checkpointed, WAL-free snapshot of the database at
// destPath. Uses SQLite's built-in VACUUM INTO which is safe to run while the
// database is live (no external lock required).
export function vacuumInto(destPath) {
  db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
}

// Save operations (no-ops for SQLite - writes are immediate)
export function saveFilesDB() {}

export function beginTransaction() {
  try { db.exec('BEGIN'); } catch (_e) { /* already in transaction */ }
}
export function commitTransaction() {
  try { db.exec('COMMIT'); } catch (_e) { /* nothing to commit */ }
}
export function saveUserDB() {}
export function saveShareDB() {}

// ── Artist name normalization ─────────────────────────────────────────────
// Server-side equivalent of the frontend cleanArtistDisplay() / normalizeArtist().
// Strip leading noise (symbols, zero-padded numbers like "01 ", "02 ") from
// artist tag values that were maltagged with track numbers.
// Genuinely numeric names (10cc, 2Pac, 808 State) are preserved because they
// don't match the zero-padded number pattern.
function _cleanArtist(name) {
  if (!name) return '';
  const noise = /^[\s#'"`()|[\]{}_.,\-\u2013\u2014*!/\\]+/;
  return String(name)
    .replace(noise, '')               // strip leading symbols
    .replace(/^\d{2,}[\s.,)\]]+/, '') // strip any 2-digit+ leading number ("01 ", "28 ", "100 ", etc.)
    .replace(noise, '')               // strip any newly-exposed leading symbols
    .trim();
}
function _normalizeArtist(name) {
  return _cleanArtist(name).toLowerCase();
}

// ── Rebuild folder index ──────────────────────────────────────────────────
// Called after every scan completes. Extracts all unique directory paths from
// the files table, populates the `folders` table, and rebuilds fts_folders.
export function rebuildFolderIndex() {
  // Extract unique (vpath, dirpath) combinations from files.filepath
  const rows = db.prepare(
    "SELECT vpath, filepath FROM files WHERE filepath IS NOT NULL"
  ).all();

  const seen = new Set();
  const toInsert = [];
  for (const row of rows) {
    // dirpath = everything except the filename (last path component)
    const slashIdx = row.filepath.lastIndexOf('/');
    if (slashIdx <= 0) continue; // file is directly at root of vpath, no folder
    const dirpath = row.filepath.slice(0, slashIdx);
    const key = `${row.vpath}\0${dirpath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // folder_name = the last component of the dirpath
    const lastSlash = dirpath.lastIndexOf('/');
    const folder_name = lastSlash >= 0 ? dirpath.slice(lastSlash + 1) : dirpath;
    toInsert.push({ vpath: row.vpath, dirpath, folder_name });
  }

  db.exec('BEGIN');
  db.exec('DELETE FROM folders');
  const ins = db.prepare('INSERT INTO folders (vpath, dirpath, folder_name) VALUES (?, ?, ?)');
  for (const r of toInsert) ins.run(r.vpath, r.dirpath, r.folder_name);
  db.exec('COMMIT');

  // Rebuild FTS from the freshly populated folders table
  db.exec("INSERT INTO fts_folders(fts_folders) VALUES ('rebuild')");
}

// ── Rebuild normalized artist index ──────────────────────────────────────
// Called after every scan completes. Groups all raw artist tag values by their
// normalized form and stores the grouping in artists_normalized.
export function rebuildArtistIndex() {
  // Fetch all distinct (artist, vpath) pairs in one pass
  const rows = db.prepare(
    "SELECT DISTINCT artist, vpath FROM files WHERE artist IS NOT NULL AND artist != ''"
  ).all();

  // Group by normalized key, collecting raw variants and vpaths
  const groupMap = new Map(); // normalizedKey → { clean, variantSet, vpathSet }
  for (const row of rows) {
    const key   = _normalizeArtist(row.artist);
    const clean = _cleanArtist(row.artist);
    if (!groupMap.has(key)) {
      groupMap.set(key, { clean, variantSet: new Set([row.artist]), vpathSet: new Set([row.vpath]) });
    } else {
      const g = groupMap.get(key);
      g.variantSet.add(row.artist);
      g.vpathSet.add(row.vpath);
      // Prefer a clean version that starts with a real letter for display
      if (!/^[a-zA-Z]/i.test(g.clean) && /^[a-zA-Z]/i.test(clean)) {
        g.clean = clean;
      }
    }
  }

  db.exec('BEGIN');
  db.exec('DELETE FROM artists_normalized');
  const ins = db.prepare('INSERT INTO artists_normalized (artist_clean, artist_raw_variants, vpaths_json) VALUES (?, ?, ?)');
  for (const g of groupMap.values()) {
    ins.run(g.clean, JSON.stringify([...g.variantSet]), JSON.stringify([...g.vpathSet]));
  }
  db.exec('COMMIT');

  // Rebuild FTS from freshly populated artists_normalized table
  db.exec("INSERT INTO fts_artists(fts_artists) VALUES ('rebuild')");
}

// Helper: build IN clause for variable-length arrays
function vpathFilter(vpaths, ignoreVPaths) {
  const filtered = [];
  for (const v of vpaths) {
    if (ignoreVPaths && typeof ignoreVPaths === 'object' && ignoreVPaths.includes(v)) {
      continue;
    }
    filtered.push(v);
  }
  return filtered;
}

function inClause(column, values) {
  if (values.length === 0) { return { sql: '1=0', params: [] }; }
  const placeholders = values.map(() => '?').join(',');
  return { sql: `${column} IN (${placeholders})`, params: values };
}

// Returns an additional AND clause that restricts filepath to a subfolder prefix.
// Used when a Subsonic client selects a child vpath (stored in DB under a parent vpath).
function prefixClause(prefix, col = 'filepath') {
  if (!prefix) return { sql: '', params: [] };
  const escaped = prefix.replace(/[%_\\]/g, '\\$&');
  return { sql: ` AND ${col} LIKE ? ESCAPE '\\'`, params: [escaped + '%'] };
}

// Generates NOT clauses to exclude filepath prefixes under specific vpaths.
// Used to exclude 'audio-books' child folders from music queries.
function excludePrefixClauses(excludeFilepathPrefixes, vpathCol = 'vpath', pathCol = 'filepath') {
  if (!Array.isArray(excludeFilepathPrefixes) || excludeFilepathPrefixes.length === 0) {
    return { sql: '', params: [] };
  }
  const parts = [];
  const params = [];
  for (const { vpath, prefix } of excludeFilepathPrefixes) {
    parts.push(`NOT (${vpathCol} = ? AND ${pathCol} LIKE ? ESCAPE '\\')`);
    params.push(vpath, prefix.replace(/[%_\\]/g, '\\$&') + '%');
  }
  return { sql: ' AND ' + parts.join(' AND '), params };
}

// Generates AND clauses to WHITELIST filepath prefixes under specific vpaths.
// Used for albumsOnly filtering: for each named parent vpath, only include rows
// where the filepath starts with one of the given prefixes.
// Other vpaths (not named here) are passed through unrestricted.
// Logic per parent: AND (vpath != 'parent' OR (filepath LIKE 'prefix1%' OR ...))
function includePrefixClauses(includeFilepathPrefixes, vpathCol = 'vpath', pathCol = 'filepath') {
  if (!Array.isArray(includeFilepathPrefixes) || includeFilepathPrefixes.length === 0) {
    return { sql: '', params: [] };
  }
  const byVpath = {};
  for (const { vpath, prefix } of includeFilepathPrefixes) {
    if (!byVpath[vpath]) byVpath[vpath] = [];
    byVpath[vpath].push(prefix);
  }
  const parts = [];
  const params = [];
  for (const [vpath, prefixes] of Object.entries(byVpath)) {
    const orParts = prefixes.map(() => `${pathCol} LIKE ? ESCAPE '\\'`);
    parts.push(`(${vpathCol} != ? OR (${orParts.join(' OR ')}))`);
    params.push(vpath, ...prefixes.map(p => p.replace(/[%_\\]/g, '\\$&') + '%'));
  }
  return { sql: ' AND ' + parts.join(' AND '), params };
}

// File Operations
export function findFileByPath(filepath, vpath) {
  const row = _s.findFile.get(filepath, vpath);
  return row || null;
}

// Batch lookup: returns a Map<filepath, row> for all matching filepaths.
// Uses the cached _s.findFile prepared statement in a read transaction —
// avoids building dynamic SQL with variable-length IN clauses, which can
// trigger SQLITE_MAX_VARIABLE_NUMBER errors in node:sqlite's DatabaseSync.
export function findFilesByPaths(filepaths, vpath) {
  const map = new Map();
  if (!filepaths.length) return map;
  for (const fp of filepaths) {
    const row = _s.findFile.get(fp, vpath);
    if (row) map.set(fp, row);
  }
  return map;
}

export function updateFileScanId(file, scanId) {
  _s.updateScanId.run(scanId, file.filepath, file.vpath);
}

// Batch scanId update: wraps all individual UPDATEs in a single transaction.
// Reduces 200 auto-commit transactions to 1, giving ~200x write throughput.
export function batchUpdateScanIds(filepaths, vpath, scanId) {
  db.exec('SAVEPOINT batchScanIds');
  try {
    for (const fp of filepaths) _s.updateScanId.run(scanId, fp, vpath);
    db.exec('RELEASE batchScanIds');
  } catch (e) {
    db.exec('ROLLBACK TO batchScanIds');
    throw e;
  }
}

export function updateFileArt(filepath, vpath, aaFile, scanId, artSource = null) {
  _s.updateArt.run(aaFile, scanId, artSource, filepath, vpath);
}

export function countArtUsage(aaFile) {
  return _s.countArtUsage.get(aaFile).cnt;
}

export function updateFileCue(filepath, vpath, cuepoints) {
  // cuepoints is either a JSON string or '[]' (sentinel = checked, no cue)
  _s.updateCue.run(cuepoints, filepath, vpath);
}

export function updateFileDuration(filepath, vpath, duration) {
  _s.updateDuration.run(duration, filepath, vpath);
}

export function getFileDuration(filepath) {
  const row = db.prepare('SELECT duration FROM files WHERE filepath = ? LIMIT 1').get(filepath);
  return row?.duration ?? null;
}

export function updateFileTags(filepath, vpath, tags) {
  const fields = [], values = [];
  if ('title'  in tags) { fields.push('title = ?');  values.push(tags.title  ?? null); }
  if ('artist' in tags) { fields.push('artist = ?'); values.push(tags.artist ?? null); }
  if ('album'  in tags) { fields.push('album = ?');  values.push(tags.album  ?? null); }
  if ('year'   in tags) { fields.push('year = ?');   values.push(tags.year   ?? null); }
  if ('genre'  in tags) { fields.push('genre = ?');  values.push(tags.genre  ?? null); }
  if ('track'  in tags) { fields.push('track = ?');  values.push(tags.track  ?? null); }
  if ('disk'   in tags) { fields.push('disk = ?');   values.push(tags.disk   ?? null); }
  if ('artist' in tags || 'album' in tags) {
    const cur = db.prepare('SELECT artist, album FROM files WHERE filepath = ? AND vpath = ?').get(filepath, vpath);
    const a = 'artist' in tags ? (tags.artist ?? null) : (cur?.artist ?? null);
    const b = 'album'  in tags ? (tags.album  ?? null) : (cur?.album  ?? null);
    fields.push('artist_id = ?'); values.push(_makeArtistId(a));
    fields.push('album_id = ?');  values.push(_makeAlbumId(a, b));
  }
  if (!fields.length) return;
  // Snapshot current FTS values before we overwrite them
  const ftsAffected = 'title' in tags || 'artist' in tags || 'album' in tags;
  let ftsOld = null;
  if (ftsAffected) {
    ftsOld = db.prepare('SELECT rowid, title, artist, album, filepath FROM files WHERE filepath = ? AND vpath = ?').get(filepath, vpath);
  }
  values.push(filepath, vpath);
  db.prepare(`UPDATE files SET ${fields.join(', ')} WHERE filepath = ? AND vpath = ?`).run(...values);
  // Keep FTS index in sync: delete old entry, insert updated one
  if (ftsAffected && ftsOld) {
    const updated = db.prepare('SELECT rowid, title, artist, album, filepath FROM files WHERE filepath = ? AND vpath = ?').get(filepath, vpath);
    if (updated) {
      _s.ftsDel.run(ftsOld.rowid, ftsOld.title ?? null, ftsOld.artist ?? null, ftsOld.album ?? null, ftsOld.filepath);
      _s.ftsInsert.run(updated.rowid, updated.title ?? null, updated.artist ?? null, updated.album ?? null, updated.filepath);
    }
  }
}

export function insertFile(fileData) {
  // If this hash already exists under a different vpath, inherit that ts so the
  // file doesn't appear as "newly added" just because a new vpath was created.
  let ts = fileData.ts ?? null;
  if (fileData.hash) {
    const existing = _s.insertFileTs.get(fileData.hash);
    if (existing) { ts = existing.ts; }
  }
  const result = _s.insertFileRow.run(
    fileData.title ?? null, fileData.artist ?? null, fileData.year ?? null, fileData.album ?? null,
    fileData.filepath, fileData.format ?? null, fileData.track ?? null, fileData.trackOf ?? null, fileData.disk ?? null,
    fileData.modified ?? null, fileData.hash ?? null, fileData.aaFile ?? null, fileData.vpath,
    ts, fileData.sID ?? null, fileData.replaygainTrackDb ?? null, fileData.genre ?? null, fileData.cuepoints ?? null,
    fileData.art_source ?? null, fileData.duration ?? null,
    fileData.artist_id ?? _makeArtistId(fileData.artist), fileData.album_id ?? _makeAlbumId(fileData.artist, fileData.album)
  );
  const rowId = Number(result.lastInsertRowid);
  _s.ftsInsert.run(rowId, fileData.title ?? null, fileData.artist ?? null, fileData.album ?? null, fileData.filepath);
  return { ...fileData, id: rowId };
}

export function removeFileByPath(filepath, vpath) {
  // Delete from FTS before removing the row (we need the old values)
  const old = db.prepare('SELECT rowid, title, artist, album, filepath FROM files WHERE filepath = ? AND vpath = ?').get(filepath, vpath);
  if (old) {
    _s.ftsDel.run(old.rowid, old.title ?? null, old.artist ?? null, old.album ?? null, old.filepath);
  }
  _s.removeByPath.run(filepath, vpath);
}

export function getLiveArtFilenames() {
  const musicArt = _s.liveArt.all().map(r => r.aaFile);
  // Protect locally-cached radio station logos — only for stations that still exist in the DB.
  // If a station is deleted, its img ref is gone from this query and the cached file
  // will be removed by runOrphanCleanup() after the next completed scan.
  const radioArt = db.prepare(
    "SELECT DISTINCT img FROM radio_stations WHERE img IS NOT NULL AND img NOT LIKE 'http%'"
  ).all().map(r => r.img);
  // Same logic for podcast feed artwork — art for deleted feeds is not protected
  // and will be cleaned up by runOrphanCleanup() after the next completed scan.
  const podcastArt = db.prepare(
    "SELECT DISTINCT img FROM podcast_feeds WHERE img IS NOT NULL AND img NOT LIKE 'http%'"
  ).all().map(r => r.img);
  return musicArt.concat(radioArt, podcastArt);
}

export function getLiveHashes() {
  return _s.liveHashes.all().map(r => r.hash);
}

export function getStaleFileHashes(vpath, scanId) {
  return _s.staleHashes.all(vpath, scanId).map(r => r.hash);
}

export function removeStaleFiles(vpath, scanId) {
  _s.removeStale.run(vpath, scanId);
  // Rebuild FTS after bulk delete — individual ftsDel on 10K+ rows would be slow
  _s.ftsRebuild.run();
}

export function removeFilesByVpath(vpath) {
  db.prepare('DELETE FROM files WHERE vpath = ?').run(vpath);
  _s.ftsRebuild.run();
}

export function countFilesByVpath(vpath) {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE vpath = ?').get(vpath);
  return row.cnt;
}

export function getLastScannedMs() {
  const row = db.prepare('SELECT MAX(ts) AS ts FROM files').get();
  return row?.ts ? row.ts * 1000 : null;
}

export function getStats() {
  const totalFiles      = db.prepare('SELECT COUNT(*) AS cnt FROM files').get().cnt;
  const totalArtists    = db.prepare("SELECT COUNT(DISTINCT artist) AS cnt FROM files WHERE artist IS NOT NULL AND artist != ''").get().cnt;
  const totalAlbums     = db.prepare("SELECT COUNT(DISTINCT album) AS cnt FROM files WHERE album IS NOT NULL AND album != ''").get().cnt;
  const totalGenres     = db.prepare("SELECT COUNT(DISTINCT genre) AS cnt FROM files WHERE genre IS NOT NULL AND genre != ''").get().cnt;
  const withArt         = db.prepare("SELECT COUNT(*) AS cnt FROM files WHERE aaFile IS NOT NULL AND aaFile != ''").get().cnt;
  const artFromDiscogs  = db.prepare("SELECT COUNT(*) AS cnt FROM files WHERE art_source = 'discogs'").get().cnt;
  const artEmbedded     = db.prepare("SELECT COUNT(*) AS cnt FROM files WHERE art_source = 'embedded'").get().cnt;
  const artFromDirectory= db.prepare("SELECT COUNT(*) AS cnt FROM files WHERE art_source = 'directory'").get().cnt;
  const withReplaygain  = db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE replaygainTrackDb IS NOT NULL').get().cnt;
  const withCue         = db.prepare("SELECT COUNT(*) AS cnt FROM files WHERE cuepoints IS NOT NULL AND cuepoints != '[]'").get().cnt;
  const cueUnchecked    = db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE cuepoints IS NULL').get().cnt;

  const yearRow         = db.prepare('SELECT MIN(year) AS oldest, MAX(year) AS newest FROM files WHERE year >= 1900 AND year <= 2030').get();
  const newestTsRow     = db.prepare('SELECT MAX(ts) AS ts FROM files').get();
  const nowSec    = Math.floor(Date.now() / 1000);
  const last7Days  = db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE ts >= ?').get(nowSec - 7  * 86400).cnt;
  const last30Days = db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE ts >= ?').get(nowSec - 30 * 86400).cnt;

  const formats = db.prepare(
    'SELECT LOWER(TRIM(format)) AS format, COUNT(*) AS cnt FROM files WHERE format IS NOT NULL AND TRIM(format) != \'\' GROUP BY LOWER(TRIM(format)) ORDER BY cnt DESC'
  ).all();

  const perVpath = db.prepare(
    'SELECT vpath, COUNT(*) AS cnt FROM files GROUP BY vpath ORDER BY cnt DESC'
  ).all();

  const topArtists = db.prepare(
    "SELECT artist, COUNT(*) AS cnt FROM files WHERE artist IS NOT NULL AND artist != '' GROUP BY artist ORDER BY cnt DESC LIMIT 5"
  ).all();

  const topGenres = db.prepare(
    "SELECT genre, COUNT(*) AS cnt FROM files WHERE genre IS NOT NULL AND genre != '' GROUP BY genre ORDER BY cnt DESC LIMIT 5"
  ).all();

  const decadeRows = db.prepare(
    'SELECT (year / 10 * 10) AS decade, COUNT(*) AS cnt FROM files WHERE year >= 1900 AND year <= 2030 GROUP BY decade ORDER BY decade'
  ).all();

  const durRow = db.prepare('SELECT SUM(duration) AS s FROM files WHERE duration IS NOT NULL').get();
  const totalDurationSec = durRow.s ? Math.round(durRow.s) : 0;

  return {
    totalFiles,
    totalArtists,
    totalAlbums,
    totalGenres,
    withArt,
    withoutArt: totalFiles - withArt,
    artFromDiscogs,
    artEmbedded,
    artFromDirectory,
    withReplaygain,
    withCue,
    cueUnchecked,
    oldestYear:  yearRow.oldest  || null,
    newestYear:  yearRow.newest  || null,
    lastScannedTs: newestTsRow.ts ? newestTsRow.ts * 1000 : null,
    addedLast7Days:  last7Days,
    addedLast30Days: last30Days,
    formats,
    perVpath,
    topArtists,
    topGenres,
    decades: decadeRows,
    totalDurationSec,
  };
}

// Metadata Queries
export function getFileWithMetadata(filepath, vpath, username) {
  const row = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE f.filepath = ? AND f.vpath = ?
  `).get(username, filepath, vpath);

  if (!row) { return null; }
  return mapFileRow(row);
}

function mapFileRow(row) {
  return {
    ...row,
    'replaygain-track-db': row.replaygainTrackDb
  };
}

export function getArtists(vpaths, ignoreVPaths, excludeFilepathPrefixes) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes);
  const rows = db.prepare(`SELECT DISTINCT artist FROM files WHERE ${vIn.sql}${ep.sql} AND artist IS NOT NULL ORDER BY artist COLLATE NOCASE`).all(...vIn.params, ...ep.params);
  return rows.map(r => r.artist);
}

// Multi-artist variant of getArtistAlbums — accepts an array of raw artist
// tag values and fetches all albums in a single SQL query using artist IN (...).
// Used from the normalized-artist search path to avoid N parallel HTTP calls.
// Strip trailing /CD1, /Disc 2, /Side A etc. so multi-disc albums group as one.
// rtrim() in SQL produces a trailing slash on the dir value, so strip that too.
function _normaliseAlbumDir(dir) {
  return (dir || '').replace(/[\/\\]$/, '').replace(/[\/\\](cd|disc|disk|side)\s*\d+\s*$/i, '');
}

export function getArtistAlbumsMulti(artists, vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes) {
  if (!Array.isArray(artists) || artists.length === 0) return [];
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const ep  = excludePrefixClauses(excludeFilepathPrefixes);
  const ip  = includePrefixClauses(includeFilepathPrefixes);
  const aIn = inClause('artist', artists.map(String));
  // GROUP BY album + physical dir so different pressings of the same album
  // each get their own entry. CD1/CD2 grouping is handled in JS via _normaliseAlbumDir.
  const rows = db.prepare(`
    SELECT album AS name, year, aaFile AS album_art_file,
      rtrim(filepath, replace(filepath, '/', '')) AS dir
    FROM files
    WHERE ${vIn.sql}${ep.sql}${ip.sql} AND ${aIn.sql}
    GROUP BY album, rtrim(filepath, replace(filepath, '/', ''))
    ORDER BY year DESC
  `).all(...vIn.params, ...ep.params, ...ip.params, ...aIn.params);
  const albums = [], store = {};
  for (const row of rows) {
    if (row.name === null) {
      const key = 'null\x00' + _normaliseAlbumDir(row.dir);
      if (!store[key]) { albums.push({ name: null, year: null, album_art_file: row.album_art_file || null }); store[key] = true; }
    } else {
      const key = row.name + '\x00' + _normaliseAlbumDir(row.dir);
      if (!store[key]) {
        albums.push({ name: row.name, year: row.year, album_art_file: row.album_art_file || null });
        store[key] = true;
      }
    }
  }
  return albums;
}

export function getArtistAlbums(artist, vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes);
  const ip = includePrefixClauses(includeFilepathPrefixes);
  const rows = db.prepare(`
    SELECT album AS name, year, aaFile AS album_art_file,
      rtrim(filepath, replace(filepath, '/', '')) AS dir
    FROM files
    WHERE ${vIn.sql}${ep.sql}${ip.sql} AND artist = ?
    GROUP BY album, rtrim(filepath, replace(filepath, '/', ''))
    ORDER BY year DESC
  `).all(...vIn.params, ...ep.params, ...ip.params, String(artist));

  const albums = [];
  const store = {};
  for (const row of rows) {
    if (row.name === null) {
      const key = 'null\x00' + _normaliseAlbumDir(row.dir);
      if (!store[key]) { albums.push({ name: null, year: null, album_art_file: row.album_art_file || null }); store[key] = true; }
    } else {
      const key = row.name + '\x00' + _normaliseAlbumDir(row.dir);
      if (!store[key]) {
        albums.push({ name: row.name, year: row.year, album_art_file: row.album_art_file || null });
        store[key] = true;
      }
    }
  }
  return albums;
}

export function getAlbums(vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes);
  const ip = includePrefixClauses(includeFilepathPrefixes);
  const rows = db.prepare(`
    SELECT album AS name, aaFile AS album_art_file, year,
      rtrim(filepath, replace(filepath, '/', '')) AS dir
    FROM files
    WHERE ${vIn.sql}${ep.sql}${ip.sql} AND album IS NOT NULL
    GROUP BY album, rtrim(filepath, replace(filepath, '/', ''))
    ORDER BY album COLLATE NOCASE
  `).all(...vIn.params, ...ep.params, ...ip.params);

  const albums = [];
  const store = {};
  for (const row of rows) {
    const key = row.name + '\x00' + _normaliseAlbumDir(row.dir);
    if (!store[key]) {
      albums.push({ name: row.name, album_art_file: row.album_art_file, year: row.year });
      store[key] = true;
    }
  }
  return albums;
}

export function getAlbumSongs(album, vpaths, username, opts) {
  const filtered = vpathFilter(vpaths, opts.ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const ep  = excludePrefixClauses(opts.excludeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const ip  = includePrefixClauses(opts.includeFilepathPrefixes, 'f.vpath', 'f.filepath');

  let sql = `
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}${ep.sql}${ip.sql}
  `;
  const params = [username, ...vIn.params, ...ep.params, ...ip.params];

  if (album === null) {
    sql += ' AND f.album IS NULL';
  } else {
    sql += ' AND f.album = ?';
    params.push(album);
  }

  if (opts.artist) {
    sql += ' AND f.artist = ?';
    params.push(opts.artist);
  }

  if (opts.year) {
    sql += ' AND f.year = ?';
    params.push(Number(opts.year));
  }

  sql += ' ORDER BY f.disk, f.track, f.filepath';

  const rows = db.prepare(sql).all(...params);
  return rows.map(mapFileRow);
}

// Escape a raw search term for use in an FTS5 MATCH expression.
// Double-quotes inside the term are escaped by doubling them.
function escapeFts(term) { return String(term).replace(/"/g, '""'); }

// Sanitize raw user input for FTS5 trigram queries:
// trigram doesn't use operators, but strip characters that could cause issues.
function sanitizeTrigram(raw) {
  return String(raw).replace(/["*\-()]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Folder search ─────────────────────────────────────────────────────────
// Searches folder names using the trigram FTS index.
// Returns folders the user has access to, ranked by match quality.
// Each result includes enough info for the frontend to open the file browser.
export function searchFolders(query, vpaths, ignoreVPaths) {
  if (!query || !query.trim()) return [];
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];

  const q = sanitizeTrigram(query);
  if (q.length < 3) return []; // trigram needs at least 3 chars

  const vIn = inClause('f.vpath', filtered);
  const rows = db.prepare(`
    SELECT f.id, f.vpath, f.dirpath, f.folder_name
    FROM folders f
    JOIN fts_folders ft ON f.id = ft.rowid
    WHERE ${vIn.sql}
    AND fts_folders MATCH ?
    ORDER BY rank
    LIMIT 50
  `).all(...vIn.params, q);
  return rows;
}

// ── Normalized artist search ───────────────────────────────────────────────
// Searches the normalized artist index using trigram FTS.
// Returns artist_clean (display name) + artist_raw_variants[] (all raw tag
// values that normalize to this name) — the variants are needed by the
// frontend to query artist-albums across all maltagged variants at once.
export function searchArtistsNormalized(query, vpaths, ignoreVPaths) {
  if (!query || !query.trim()) return [];

  const q = sanitizeTrigram(query);
  if (q.length < 3) return [];

  // Compute the set of vpaths the user is allowed to see
  let filteredVpaths = null;
  if (Array.isArray(vpaths) && vpaths.length > 0) {
    filteredVpaths = vpathFilter(vpaths, ignoreVPaths);
    if (filteredVpaths.length === 0) return [];
  }

  // Fetch more than 50 from FTS so we still have 50 after vpath filtering
  const rows = db.prepare(`
    SELECT an.id, an.artist_clean, an.artist_raw_variants, an.vpaths_json
    FROM artists_normalized an
    JOIN fts_artists fa ON an.id = fa.rowid
    WHERE fts_artists MATCH ?
    ORDER BY rank
    LIMIT 200
  `).all(q);

  return rows
    .filter(r => {
      if (!filteredVpaths) return true;
      try {
        const artistVpaths = JSON.parse(r.vpaths_json || '[]');
        return artistVpaths.some(v => filteredVpaths.includes(v));
      } catch { return true; }
    })
    .slice(0, 50)
    .map(r => ({
      name:     r.artist_clean,
      variants: (() => { try { return JSON.parse(r.artist_raw_variants); } catch { return [r.artist_clean]; } })(),
    }));
}

export function searchFiles(searchCol, searchTerm, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes, negativeTerms = []) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }

  const validCols = ['artist', 'album', 'filepath', 'title'];
  if (!validCols.includes(searchCol)) { return []; }

  const vIn = inClause('vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes);

  // Build FTS5 MATCH query: column-filtered prefix match + optional NOT exclusions
  const notClause = negativeTerms.map(t => ` NOT "${escapeFts(t)}"`).join('');
  const ftsQuery = `{${searchCol}} : "${escapeFts(searchTerm)}"*${notClause}`;

  const params = [...vIn.params, ...ep.params, ftsQuery];
  let sql = `SELECT f.rowid AS id, f.* FROM files f
    JOIN fts_files ft ON f.rowid = ft.rowid
    WHERE ${vIn.sql.replace(/\bvpath\b/g, 'f.vpath')}${ep.sql.replace(/\bvpath\b/g, 'f.vpath').replace(/\bfilepath\b/g, 'f.filepath')}
    AND ft.fts_files MATCH ?`;
  if (filepathPrefix && typeof filepathPrefix === 'string') {
    sql += " AND f.filepath LIKE ? ESCAPE '\\'";
    params.push(filepathPrefix.replace(/[%_\\]/g, '\\$&') + '%');
  }
  sql += ' ORDER BY bm25(fts_files) LIMIT 500';
  const rows = db.prepare(sql).all(...params);
  return rows.map(mapFileRow);
}

// Multi-word cross-field search: every positive token must appear somewhere
// across title/artist/album/filepath. Enables queries like "chaka khan fate"
// where artist words and title words are spread across columns.
export function searchFilesAllWords(tokens, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes, negativeTerms = []) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0 || tokens.length === 0) { return []; }

  const vIn = inClause('vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes);

  // Each positive token must match at least one column (prefix match)
  const posClause = tokens.map(t => `"${escapeFts(t)}"*`).join(' AND ');
  const notClause = negativeTerms.map(t => ` NOT "${escapeFts(t)}"`).join('');
  const ftsQuery = posClause + notClause;

  const params = [...vIn.params, ...ep.params, ftsQuery];
  let sql = `SELECT f.rowid AS id, f.* FROM files f
    JOIN fts_files ft ON f.rowid = ft.rowid
    WHERE ${vIn.sql.replace(/\bvpath\b/g, 'f.vpath')}${ep.sql.replace(/\bvpath\b/g, 'f.vpath').replace(/\bfilepath\b/g, 'f.filepath')}
    AND ft.fts_files MATCH ?`;
  if (filepathPrefix && typeof filepathPrefix === 'string') {
    sql += " AND f.filepath LIKE ? ESCAPE '\\'";
    params.push(filepathPrefix.replace(/[%_\\]/g, '\\$&') + '%');
  }
  sql += ' ORDER BY bm25(fts_files) LIMIT 500';
  const rows = db.prepare(sql).all(...params);
  return rows.map(mapFileRow);
}

export function getUserSettings(username) {
  const row = db.prepare('SELECT prefs, queue FROM user_settings WHERE username = ?').get(username);
  if (!row) return { prefs: {}, queue: null };
  return {
    prefs: JSON.parse(row.prefs || '{}'),
    queue: JSON.parse(row.queue || 'null'),
  };
}

export function saveUserSettings(username, patch) {
  const existing = getUserSettings(username);
  if (patch.prefs !== undefined) existing.prefs = Object.assign(existing.prefs, patch.prefs);
  if (patch.queue !== undefined) existing.queue = patch.queue;
  db.prepare(
    'INSERT INTO user_settings (username, prefs, queue) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET prefs = excluded.prefs, queue = excluded.queue'
  ).run(username, JSON.stringify(existing.prefs), JSON.stringify(existing.queue));
}

export function getRatedSongs(vpaths, username, ignoreVPaths, excludeFilepathPrefixes) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.rating > 0 AND ${vIn.sql}${ep.sql}
    ORDER BY um.rating DESC
  `).all(username, ...vIn.params, ...ep.params);
  return rows.map(mapFileRow);
}

export function getRecentlyAdded(vpaths, username, limit, ignoreVPaths, opts = {}) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}${pf.sql}${ep.sql} AND f.ts > 0
    ORDER BY f.ts DESC
    LIMIT ?
  `).all(username, ...vIn.params, ...pf.params, ...ep.params, limit);
  return rows.map(mapFileRow);
}

export function getRecentlyPlayed(vpaths, username, limit, ignoreVPaths, opts = {}) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.lp AS lastPlayed, um.pc AS playCount
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.lp > 0 AND ${vIn.sql}${pf.sql}${ep.sql}
    ORDER BY um.lp DESC
    LIMIT ?
  `).all(username, ...vIn.params, ...pf.params, ...ep.params, limit);
  return rows.map(mapFileRow);
}

export function getMostPlayed(vpaths, username, limit, ignoreVPaths, opts = {}) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes, 'f.vpath', 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.lp AS lastPlayed, um.pc AS playCount
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.pc > 0 AND ${vIn.sql}${pf.sql}${ep.sql}
    ORDER BY um.pc DESC
    LIMIT ?
  `).all(username, ...vIn.params, ...pf.params, ...ep.params, limit);
  return rows.map(mapFileRow);
}

export function getAllFilesWithMetadata(vpaths, username, opts) {
  const filtered = vpathFilter(vpaths, opts.ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes, 'f.vpath', 'f.filepath');

  let sql = `
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}${ep.sql}
  `;
  const params = [username, ...vIn.params, ...ep.params];

  // filepathPrefix: restrict to files inside a subdirectory of a vpath
  // (used by Auto-DJ when a child vpath is selected instead of creating
  // duplicate DB entries for the same physical files)
  if (opts.filepathPrefix && typeof opts.filepathPrefix === 'string') {
    sql += ' AND f.filepath LIKE ? ESCAPE \'\\\'';
    params.push(opts.filepathPrefix.replace(/[%_\\]/g, '\\$&') + '%');
  }

  const minRating = Number(opts.minRating);
  if (minRating && typeof minRating === 'number' && minRating <= 10 && !(minRating < 1)) {
    sql += ' AND um.rating >= ?';
    params.push(opts.minRating);
  }

  // Filter by specific artists (used by Similar-Artists Auto-DJ)
  if (opts.artists && Array.isArray(opts.artists) && opts.artists.length > 0) {
    const aIn = inClause('f.artist', opts.artists);
    sql += ` AND ${aIn.sql}`;
    params.push(...aIn.params);
  }

  // Exclude recently-heard artists (DJ cooldown window)
  if (opts.ignoreArtists && Array.isArray(opts.ignoreArtists) && opts.ignoreArtists.length > 0) {
    const placeholders = opts.ignoreArtists.map(() => '?').join(',');
    sql += ` AND (f.artist IS NULL OR f.artist NOT IN (${placeholders}))`;
    params.push(...opts.ignoreArtists);
  }

  const rows = db.prepare(sql).all(...params);
  return rows.map(mapFileRow);
}

// ── Lightweight random-pick helpers (used by Auto-DJ no-filter path) ──────────
// Avoid loading all 100k+ rows into heap just to pick one index.
// Strategy: COUNT(*) to get candidate size → caller picks a random offset →
// fetch LIMIT 1 OFFSET n.  The ignore list is a small array of previously-picked
// offsets; we skip any that map onto ignored offsets by advancing the offset by
// the number of ignored positions below it.
//
// Shared WHERE-clause builder (same filters as getAllFilesWithMetadata minus artists).
function _buildRandomWhere(opts, filtered) {
  const vIn = inClause('f.vpath', filtered);
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes, 'f.vpath', 'f.filepath');
  let sql = `FROM files f LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ? WHERE ${vIn.sql}${ep.sql}`;
  const params = [...vIn.params, ...ep.params];

  if (opts.filepathPrefix && typeof opts.filepathPrefix === 'string') {
    sql += ' AND f.filepath LIKE ? ESCAPE \'\\\'';
    params.push(opts.filepathPrefix.replace(/[%_\\]/g, '\\$&') + '%');
  }
  const minRating = Number(opts.minRating);
  if (minRating && minRating <= 10 && minRating >= 1) {
    sql += ' AND um.rating >= ?';
    params.push(minRating);
  }
  if (opts.ignoreArtists && Array.isArray(opts.ignoreArtists) && opts.ignoreArtists.length > 0) {
    const placeholders = opts.ignoreArtists.map(() => '?').join(',');
    sql += ` AND (f.artist IS NULL OR f.artist NOT IN (${placeholders}))`;
    params.push(...opts.ignoreArtists);
  }
  return { sql, params };
}

export function countFilesForRandom(vpaths, username, opts) {
  const filtered = vpathFilter(vpaths, opts.ignoreVPaths);
  if (filtered.length === 0) return 0;
  const { sql, params } = _buildRandomWhere(opts, filtered);
  const row = db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(username, ...params);
  return row ? row.n : 0;
}

// Returns the single row at the given 0-based offset within the same candidate set.
export function pickFileAtOffset(vpaths, username, opts, offset) {
  const filtered = vpathFilter(vpaths, opts.ignoreVPaths);
  if (filtered.length === 0) return null;
  const { sql, params } = _buildRandomWhere(opts, filtered);
  const row = db.prepare(
    `SELECT f.rowid AS id, f.*, um.rating ${sql} ORDER BY f.rowid LIMIT 1 OFFSET ?`
  ).get(username, ...params, offset);
  return row ? mapFileRow(row) : null;
}

export function getGenres(vpaths, ignoreVPaths, opts = {}) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix);
  return db.prepare(
    `SELECT genre, COUNT(*) AS cnt FROM files WHERE ${vIn.sql}${pf.sql} AND genre IS NOT NULL AND genre != '' GROUP BY genre ORDER BY genre COLLATE NOCASE`
  ).all(...vIn.params, ...pf.params);
}

export function getSongsByGenre(genre, vpaths, username, ignoreVPaths, opts = {}) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}${pf.sql} AND f.genre = ?
    ORDER BY f.artist COLLATE NOCASE, f.album COLLATE NOCASE, f.disk, f.track
  `).all(username, ...vIn.params, ...pf.params, genre);
  return rows.map(mapFileRow);
}

/**
 * Fetch songs matching any of the given raw DB genre strings.
 * rawGenres is the full Set/Array from mergeGenreRows().rawMap — it contains
 * the original multi-value strings (e.g. "House, Trance, Chillout") as well
 * as single-tag values so an exact IN clause is sufficient.
 */
export function getSongsByGenreRaw(rawGenres, vpaths, username, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const genreList = [...rawGenres];
  if (genreList.length === 0) return [];
  const vIn    = inClause('f.vpath', filtered);
  const gIn    = inClause('f.genre', genreList);
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql} AND ${gIn.sql}
    ORDER BY f.artist COLLATE NOCASE, f.album COLLATE NOCASE, f.disk, f.track
  `).all(username, ...vIn.params, ...gIn.params);
  return rows.map(mapFileRow);
}

export function getDecades(vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  return db.prepare(
    `SELECT (year / 10 * 10) AS decade, COUNT(*) AS cnt, COUNT(DISTINCT album) AS albums FROM files WHERE ${vIn.sql} AND year >= 1900 AND year <= 2030 GROUP BY decade ORDER BY decade`
  ).all(...vIn.params);
}

export function getAlbumsByDecade(decade, vpaths, ignoreVPaths, excludeFilepathPrefixes) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const ep  = excludePrefixClauses(excludeFilepathPrefixes);
  // GROUP BY album+artist so SQLite deduplicates — no JS loop needed.
  // MIN(year) picks a representative year; MAX(aaFile) prefers a non-null art file.
  return db.prepare(`
    SELECT album AS name,
           MAX(aaFile) AS album_art_file,
           MIN(year)   AS year,
           artist
    FROM files
    WHERE ${vIn.sql}${ep.sql} AND album IS NOT NULL AND year >= ? AND year <= ?
    GROUP BY album, artist
    ORDER BY MIN(year), album COLLATE NOCASE
  `).all(...vIn.params, ...ep.params, decade, decade + 9);
}

export function getSongsByDecade(decade, vpaths, username, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql} AND f.year >= ? AND f.year <= ?
    ORDER BY f.artist COLLATE NOCASE, f.album COLLATE NOCASE, f.disk, f.track
  `).all(username, ...vIn.params, decade, decade + 9);
  return rows.map(mapFileRow);
}

export function getAlbumsByGenre(rawGenres, vpaths, ignoreVPaths, excludeFilepathPrefixes) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const genreList = [...rawGenres];
  if (genreList.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const gIn = inClause('genre', genreList);
  const ep  = excludePrefixClauses(excludeFilepathPrefixes);
  return db.prepare(`
    SELECT album AS name,
           MAX(aaFile) AS album_art_file,
           MIN(year)   AS year,
           artist
    FROM files
    WHERE ${vIn.sql} AND ${gIn.sql}${ep.sql} AND album IS NOT NULL
    GROUP BY album, artist
    ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE
  `).all(...vIn.params, ...gIn.params, ...ep.params);
}


// User Metadata
export function findUserMetadata(hash, username) {
  const row = db.prepare('SELECT rowid AS id, * FROM user_metadata WHERE hash = ? AND user = ?').get(hash, username);
  return row || null;
}

export function insertUserMetadata(obj) {
  db.prepare('INSERT INTO user_metadata (hash, user, rating, pc, lp) VALUES (?, ?, ?, ?, ?)').run(
    obj.hash, obj.user, obj.rating ?? null, obj.pc ?? 0, obj.lp ?? null
  );
}

export function updateUserMetadata(obj) {
  db.prepare('UPDATE user_metadata SET rating = ?, pc = ?, lp = ? WHERE hash = ? AND user = ?').run(
    obj.rating ?? null, obj.pc ?? 0, obj.lp ?? null, obj.hash, obj.user
  );
}

export function removeUserMetadataByUser(username) {
  db.prepare('DELETE FROM user_metadata WHERE user = ?').run(username);
}

export function resetPlayCounts(username) {
  db.prepare('UPDATE user_metadata SET pc = 0 WHERE user = ?').run(username);
}

export function resetRecentlyPlayed(username) {
  db.prepare('UPDATE user_metadata SET lp = NULL WHERE user = ?').run(username);
}

// Playlists
export function getUserPlaylists(username) {
  return db.prepare('SELECT name FROM playlists WHERE user = ? AND filepath IS NULL').all(username);
}

export function findPlaylist(username, playlistName) {
  const row = db.prepare('SELECT rowid AS id, * FROM playlists WHERE user = ? AND name = ? LIMIT 1').get(username, playlistName);
  return row || null;
}

export function createPlaylistEntry(entry) {
  db.prepare('INSERT INTO playlists (name, filepath, user, live) VALUES (?, ?, ?, ?)').run(
    entry.name, entry.filepath ?? null, entry.user, entry.live ? 1 : 0
  );
}

export function deletePlaylist(username, playlistName) {
  db.prepare('DELETE FROM playlists WHERE user = ? AND name = ?').run(username, playlistName);
}

export function renamePlaylist(username, oldName, newName) {
  db.prepare('UPDATE playlists SET name = ? WHERE user = ? AND name = ?').run(newName, username, oldName);
}

export function getPlaylistEntryById(id) {
  const row = db.prepare('SELECT rowid AS id, * FROM playlists WHERE rowid = ?').get(id);
  return row || null;
}

export function removePlaylistEntryById(id) {
  db.prepare('DELETE FROM playlists WHERE rowid = ?').run(id);
}

export function loadPlaylistEntries(username, playlistName) {
  return db.prepare('SELECT rowid AS id, * FROM playlists WHERE user = ? AND name = ? AND filepath IS NOT NULL').all(username, playlistName);
}

export function removePlaylistsByUser(username) {
  db.prepare('DELETE FROM playlists WHERE user = ?').run(username);
}

// Shared Playlists
export function findSharedPlaylist(playlistId) {
  const row = db.prepare('SELECT rowid AS id, * FROM shared_playlists WHERE playlistId = ?').get(playlistId);
  if (!row) { return null; }
  row.playlist = JSON.parse(row.playlist);
  return row;
}

export function insertSharedPlaylist(item) {
  db.prepare('INSERT INTO shared_playlists (playlistId, playlist, user, expires, token) VALUES (?, ?, ?, ?, ?)').run(
    item.playlistId, JSON.stringify(item.playlist), item.user, item.expires ?? null, item.token
  );
}

export function getAllSharedPlaylists() {
  const rows = db.prepare('SELECT rowid AS id, * FROM shared_playlists').all();
  return rows.map(r => ({ ...r, playlist: JSON.parse(r.playlist) }));
}

export function removeSharedPlaylistById(playlistId) {
  db.prepare('DELETE FROM shared_playlists WHERE playlistId = ?').run(playlistId);
}

export function removeExpiredSharedPlaylists() {
  db.prepare('DELETE FROM shared_playlists WHERE expires IS NOT NULL AND expires < ?').run(Math.floor(Date.now() / 1000));
}

export function removeEternalSharedPlaylists() {
  db.prepare('DELETE FROM shared_playlists WHERE expires IS NULL').run();
}

export function removeSharedPlaylistsByUser(username) {
  db.prepare('DELETE FROM shared_playlists WHERE user = ?').run(username);
}

// ── Scan Errors ─────────────────────────────────────────────────────────────

/**
 * Upsert a scan error.  If an entry with the same guid already exists, its
 * last_seen timestamp and detection count are updated instead of creating a
 * duplicate row.  guid = md5(relativeFilePath + '|' + errorType) so the same
 * problem recurs as count increments rather than flooding the table.
 */
export function insertScanError(guid, filepath, vpath, errorType, errorMsg, stack) {
  const now = Math.floor(Date.now() / 1000);
  const existing = db.prepare('SELECT count FROM scan_errors WHERE guid = ?').get(guid);
  if (existing) {
    // Re-occurrence resets fixed_at and fix_action so a re-broken file becomes
    // unfixed again; also refresh error_msg/stack in case the message changed.
    db.prepare('UPDATE scan_errors SET last_seen = ?, count = count + 1, fixed_at = NULL, fix_action = NULL, error_msg = ?, stack = ? WHERE guid = ?').run(now, errorMsg || '', stack || '', guid);
  } else {
    db.prepare(
      'INSERT INTO scan_errors (guid, filepath, vpath, error_type, error_msg, stack, first_seen, last_seen, count) VALUES (?,?,?,?,?,?,?,?,1)'
    ).run(guid, filepath, vpath, errorType, errorMsg || '', stack || '', now, now);
  }
}

export function getScanErrors(limit = 500) {
  const rows = db.prepare(`
    SELECT se.*,
      CASE WHEN f.filepath IS NOT NULL THEN 1 ELSE 0 END AS file_in_db
    FROM scan_errors se
    LEFT JOIN files f ON f.filepath = se.filepath AND f.vpath = se.vpath
    ORDER BY se.fixed_at DESC NULLS LAST, se.last_seen DESC
    LIMIT ?
  `).all(limit);
  const total = db.prepare('SELECT COUNT(*) AS cnt FROM scan_errors').get().cnt;
  return { errors: rows, total };
}

export function getScanErrorByGuid(guid) {
  return db.prepare(`
    SELECT se.*,
      CASE WHEN f.filepath IS NOT NULL THEN 1 ELSE 0 END AS file_in_db
    FROM scan_errors se
    LEFT JOIN files f ON f.filepath = se.filepath AND f.vpath = se.vpath
    WHERE se.guid = ?
  `).get(guid) || null;
}

export function clearScanErrors() {
  db.prepare('DELETE FROM scan_errors').run();
}

/** Remove entries whose last_seen is older than retentionHours, plus fixed entries older than 48 h. */
export function pruneScanErrors(retentionHours) {
  const cutoff      = Math.floor(Date.now() / 1000) - retentionHours * 3600;
  const fixedCutoff = Math.floor(Date.now() / 1000) - 48 * 3600;
  db.prepare('DELETE FROM scan_errors WHERE last_seen < ?').run(cutoff);
  db.prepare('DELETE FROM scan_errors WHERE fixed_at IS NOT NULL AND fixed_at < ?').run(fixedCutoff);
}

/** Remove errors for this vpath that were NOT re-encountered in the current scan.
 *  Called at finish-scan — any error whose last_seen < scanStartTs was not triggered
 *  this run, meaning the underlying problem is resolved. */
export function clearResolvedErrors(vpath, scanStartTs) {
  db.prepare('DELETE FROM scan_errors WHERE vpath = ? AND last_seen < ?').run(vpath, scanStartTs);
}

/** Mark a single error as fixed, storing what action was taken. */
export function markScanErrorFixed(guid, fixAction) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE scan_errors SET fixed_at = ?, fix_action = ?, confirmed_at = NULL WHERE guid = ?').run(now, fixAction || null, guid);
}

/**
 * After a successful rescan of a previously-errored file, mark all fixed errors
 * for that filepath+vpath as confirmed OK.  Only touches rows where fixed_at IS
 * NOT NULL (i.e. someone already clicked Fix) — unfixed errors are untouched.
 */
export function confirmScanErrorOk(filepath, vpath) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'UPDATE scan_errors SET confirmed_at = ? WHERE filepath = ? AND vpath = ? AND fixed_at IS NOT NULL AND confirmed_at IS NULL'
  ).run(now, filepath, vpath);
}

/**
 * Mark a file's album-art lookup as "checked, none found" by setting aaFile = ''
 * (empty string). The scanner treats null as "never tried" and '' as "tried, nothing".
 */
export function markFileArtChecked(filepath, vpath) {
  db.prepare("UPDATE files SET aaFile = '' WHERE (aaFile IS NULL OR aaFile = '') AND filepath = ? AND vpath = ?").run(filepath, vpath);
}

/** Mark a file's cue-sheet check as done-with-nothing by setting cuepoints = '[]'. */
export function markFileCueChecked(filepath, vpath) {
  db.prepare("UPDATE files SET cuepoints = '[]' WHERE (cuepoints IS NULL) AND filepath = ? AND vpath = ?").run(filepath, vpath);
}

/** Count only actionable errors (unfixed AND file still in library) — used for the sidebar badge. */
export function getScanErrorCount() {
  return db.prepare(`
    SELECT COUNT(*) AS cnt FROM scan_errors se
    INNER JOIN files f ON f.filepath = se.filepath AND f.vpath = se.vpath
    WHERE se.fixed_at IS NULL
  `).get().cnt;
}

// ── Subsonic-specific queries ────────────────────────────────────────────────

export function getFilesByArtistId(artistId, vpaths, username, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE f.artist_id = ? AND ${vIn.sql}${pf.sql}
    ORDER BY f.album COLLATE NOCASE, f.disk, f.track, f.filepath
  `).all(username, artistId, ...vIn.params, ...pf.params);
  return rows.map(mapFileRow);
}

export function getFilesByAlbumId(albumId, vpaths, username, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE f.album_id = ? AND ${vIn.sql}${pf.sql}
    ORDER BY f.disk, f.track, f.filepath
  `).all(username, albumId, ...vIn.params, ...pf.params);
  return rows.map(mapFileRow);
}

export function getSongByHash(hash, username) {
  const row = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE f.hash = ?
    LIMIT 1
  `).get(username, hash);
  return row ? mapFileRow(row) : null;
}

/**
 * Resolve a raw coverArt/id string to an aaFile filename.
 * Handles album_id (16-char hex), artist_id (16-char hex), and song hash (32-char hex).
 * Returns null if nothing is found.
 */
export function getAaFileById(id) {
  if (!db || !id) return null;
  let row = db.prepare('SELECT MAX(aaFile) AS aaFile FROM files WHERE album_id = ? AND aaFile IS NOT NULL').get(id);
  if (row?.aaFile) return row.aaFile;
  row = db.prepare('SELECT MAX(aaFile) AS aaFile FROM files WHERE artist_id = ? AND aaFile IS NOT NULL').get(id);
  if (row?.aaFile) return row.aaFile;
  row = db.prepare('SELECT aaFile FROM files WHERE hash = ? AND aaFile IS NOT NULL LIMIT 1').get(id);
  return row?.aaFile || null;
}

// In-memory cache for getAaFileForDir — cleared on scan to stay consistent.
const _aaFileForDirCache = new Map();
export function clearAaFileForDirCache() { _aaFileForDirCache.clear(); }

export function getAaFileForDir(vpath, dirRelPath) {
  if (!db) return null;
  const cacheKey = vpath + '\0' + (dirRelPath || '');
  if (_aaFileForDirCache.has(cacheKey)) return _aaFileForDirCache.get(cacheKey);
  const prefix = dirRelPath ? dirRelPath + '/' : '';
  const escaped = prefix.replace(/[%_\\]/g, '\\$&');
  const row = db.prepare(
    `SELECT MAX(aaFile) AS aaFile FROM files WHERE vpath = ? AND filepath LIKE ? ESCAPE '\\' AND aaFile IS NOT NULL`
  ).get(vpath, escaped + '%');
  const result = row?.aaFile || null;
  _aaFileForDirCache.set(cacheKey, result);
  return result;
}

export function getStarredSongs(vpaths, username, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.starred = 1 AND ${vIn.sql}${pf.sql}
    ORDER BY f.artist COLLATE NOCASE, f.album COLLATE NOCASE, f.disk, f.track
  `).all(username, ...vIn.params, ...pf.params);
  return rows.map(mapFileRow);
}

export function getStarredAlbums(vpaths, username, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  // Return one representative row per album_id that has at least one starred song
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.starred
    FROM files f
    INNER JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE um.starred = 1 AND ${vIn.sql}${pf.sql}
    GROUP BY f.album_id
    ORDER BY f.album COLLATE NOCASE
  `).all(username, ...vIn.params, ...pf.params);
  return rows.map(mapFileRow);
}

export function setStarred(hash, username, starred) {
  const existing = db.prepare('SELECT rowid FROM user_metadata WHERE hash = ? AND user = ?').get(hash, username);
  if (existing) {
    db.prepare('UPDATE user_metadata SET starred = ? WHERE hash = ? AND user = ?').run(starred ? 1 : 0, hash, username);
  } else {
    db.prepare('INSERT INTO user_metadata (hash, user, rating, pc, lp, starred) VALUES (?, ?, NULL, 0, NULL, ?)').run(hash, username, starred ? 1 : 0);
  }
}

export function getRandomSongs(vpaths, username, opts) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const limit = Math.min(Number(opts.size) || 10, 500);

  // Build the FROM + WHERE clause shared by COUNT and row-fetch queries.
  const joinSql = `FROM files f LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?`;
  let whereSql = `WHERE ${vIn.sql}${pf.sql}`;
  const params = [username, ...vIn.params, ...pf.params];

  if (opts.genre) {
    whereSql += ' AND f.genre = ?';
    params.push(opts.genre);
  }
  if (opts.fromYear) {
    whereSql += ' AND f.year >= ?';
    params.push(Number(opts.fromYear));
  }
  if (opts.toYear) {
    whereSql += ' AND f.year <= ?';
    params.push(Number(opts.toYear));
  }

  // COUNT first — avoids loading all matching rows into heap.
  const count = db.prepare(`SELECT COUNT(*) AS n ${joinSql} ${whereSql}`).get(...params).n;
  if (count === 0) return [];

  // Prepare the single-row OFFSET fetch once, reuse for each pick.
  const rowStmt = db.prepare(
    `SELECT f.rowid AS id, f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount ` +
    `${joinSql} ${whereSql} ORDER BY f.rowid LIMIT 1 OFFSET ?`
  );

  const results = [];
  const pickedOffsets = new Set();
  for (let i = 0; i < limit && pickedOffsets.size < count; i++) {
    let offset = Math.floor(Math.random() * count);
    // Collision avoidance — practically never triggers at library scale
    let attempts = 0;
    while (pickedOffsets.has(offset) && attempts < count) {
      offset = Math.floor(Math.random() * count);
      attempts++;
    }
    if (pickedOffsets.has(offset)) break;
    pickedOffsets.add(offset);
    const row = rowStmt.get(...params, offset);
    if (row) results.push(mapFileRow(row));
  }
  return results;
}

export function getAlbumsByArtistId(artistId, vpaths, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix);
  const rows = db.prepare(`
    SELECT DISTINCT album_id, artist_id, album, artist,
           MAX(year) AS year, MAX(aaFile) AS aaFile, COUNT(*) AS songCount
    FROM files
    WHERE artist_id = ? AND ${vIn.sql}${pf.sql}
    GROUP BY album_id
    ORDER BY year DESC, album COLLATE NOCASE
  `).all(artistId, ...vIn.params, ...pf.params);
  return rows;
}

export function getAllAlbumIds(vpaths, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix);
  const rows = db.prepare(`
    SELECT DISTINCT album_id, artist_id, album, artist,
           MAX(year) AS year, MAX(aaFile) AS aaFile, COUNT(*) AS songCount, MAX(ts) AS ts
    FROM files
    WHERE ${vIn.sql}${pf.sql} AND album IS NOT NULL
    GROUP BY album_id
    ORDER BY album COLLATE NOCASE
  `).all(...vIn.params, ...pf.params);
  return rows;
}

export function getAllArtistIds(vpaths, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix);
  const rows = db.prepare(`
    SELECT DISTINCT artist_id, artist, MAX(aaFile) AS aaFile,
           COUNT(DISTINCT album_id) AS albumCount
    FROM files
    WHERE ${vIn.sql}${pf.sql} AND artist IS NOT NULL
    GROUP BY artist_id
    ORDER BY artist COLLATE NOCASE
  `).all(...vIn.params, ...pf.params);
  return rows;
}

/**
 * Return the immediate children of a directory within a single vpath.
 * dirRelPath: path relative to vpath root, NO trailing slash.
 *   ""                  → list root of vpath
 *   "12 inches A-Z/A"  → list that sub-folder
 * Returns { dirs: string[], files: row[] }
 */
export function getDirectoryContents(vpath, dirRelPath, username) {
  if (!db) return { dirs: [], files: [] };

  const prefix = dirRelPath ? dirRelPath + '/' : '';
  const escaped = prefix.replace(/[%_\\]/g, '\\$&');

  let dirRows, fileRows;

  if (prefix) {
    // Sub-directory names + one representative cover art per dir
    dirRows = db.prepare(`
      SELECT
        substr(filepath, length(?) + 1,
          instr(substr(filepath, length(?) + 1), '/') - 1
        ) AS subdir,
        MAX(aaFile) AS aaFile
      FROM files
      WHERE vpath = ?
        AND filepath LIKE ? ESCAPE '\\'
        AND instr(substr(filepath, length(?) + 1), '/') > 0
      GROUP BY subdir
      ORDER BY subdir COLLATE NOCASE
    `).all(prefix, prefix, vpath, escaped + '%', prefix);

    fileRows = db.prepare(`
      SELECT f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
      FROM files f
      LEFT JOIN user_metadata um ON um.hash = f.hash AND um.user = ?
      WHERE f.vpath = ?
        AND f.filepath LIKE ? ESCAPE '\\'
        AND instr(substr(f.filepath, length(?) + 1), '/') = 0
      ORDER BY f.track, f.title COLLATE NOCASE
    `).all(username || '', vpath, escaped + '%', prefix);
  } else {
    // Root of vpath: no LIKE filter needed
    dirRows = db.prepare(`
      SELECT
        substr(filepath, 1, instr(filepath, '/') - 1) AS subdir,
        MAX(aaFile) AS aaFile
      FROM files
      WHERE vpath = ?
        AND instr(filepath, '/') > 0
      GROUP BY subdir
      ORDER BY subdir COLLATE NOCASE
    `).all(vpath);

    fileRows = db.prepare(`
      SELECT f.*, um.rating, um.starred, um.lp AS lastPlayed, um.pc AS playCount
      FROM files f
      LEFT JOIN user_metadata um ON um.hash = f.hash AND um.user = ?
      WHERE f.vpath = ?
        AND instr(f.filepath, '/') = 0
      ORDER BY f.track, f.title COLLATE NOCASE
    `).all(username || '', vpath);
  }

  return {
    dirs: dirRows.map(r => r.subdir ? { name: r.subdir, aaFile: r.aaFile || null } : null).filter(Boolean),
    files: fileRows,
  };
}

// ── Radio Stations ────────────────────────────────────────────
export function getRadioStations(username) {
  return db.prepare('SELECT * FROM radio_stations WHERE user = ? ORDER BY sort_order, id').all(username);
}
export function createRadioStation(username, data) {
  const r = db.prepare(
    'INSERT INTO radio_stations (user, name, genre, country, link_a, link_b, link_c, img) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(username, data.name, data.genre || null, data.country || null, data.link_a || null, data.link_b || null, data.link_c || null, data.img || null);
  return r.lastInsertRowid;
}
export function updateRadioStation(id, username, data) {
  const r = db.prepare(
    'UPDATE radio_stations SET name=?, genre=?, country=?, link_a=?, link_b=?, link_c=?, img=? WHERE id=? AND user=?'
  ).run(data.name, data.genre || null, data.country || null, data.link_a || null, data.link_b || null, data.link_c || null, data.img || null, id, username);
  return r.changes > 0;
}
export function deleteRadioStation(id, username) {
  const r = db.prepare('DELETE FROM radio_stations WHERE id=? AND user=?').run(id, username);
  return r.changes > 0;
}
export function getRadioStationImgUsageCount(imgFilename) {
  return db.prepare('SELECT COUNT(*) AS cnt FROM radio_stations WHERE img=?').get(imgFilename)?.cnt ?? 0;
}
// ── Radio Schedules ──────────────────────────────────────────
export function getRadioSchedules(username) {
  return db.prepare('SELECT * FROM radio_schedules WHERE username=? ORDER BY created_at DESC').all(username);
}
export function createRadioSchedule(data) {
  db.prepare(
    'INSERT INTO radio_schedules (id,username,station_name,stream_url,art_file,vpath,start_time,start_date,duration_min,recurrence,recur_days,description,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)'
  ).run(data.id, data.username, data.station_name, data.stream_url, data.art_file || null, data.vpath, data.start_time, data.start_date || null, data.duration_min, data.recurrence, data.recur_days || null, data.description || null, data.created_at);
  return data.id;
}
export function deleteRadioSchedule(id, username) {
  return db.prepare('DELETE FROM radio_schedules WHERE id=? AND username=?').run(id, username).changes > 0;
}
export function toggleRadioSchedule(id, username, enabled) {
  return db.prepare('UPDATE radio_schedules SET enabled=? WHERE id=? AND username=?').run(enabled, id, username).changes > 0;
}
export function toggleRadioScheduleById(id, enabled) {
  return db.prepare('UPDATE radio_schedules SET enabled=? WHERE id=?').run(enabled, id).changes > 0;
}
export function getAllEnabledRadioSchedules() {
  return db.prepare('SELECT * FROM radio_schedules WHERE enabled=1').all();
}

export function reorderRadioStations(username, orderedIds) {
  const update = db.prepare('UPDATE radio_stations SET sort_order=? WHERE id=? AND user=?');
  db.exec('BEGIN');
  try {
    orderedIds.forEach((id, idx) => update.run(idx, id, username));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ── Podcast Feeds ─────────────────────────────────────────────
export function getPodcastFeeds(username) {
  return db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM podcast_episodes e WHERE e.feed_id = f.id) AS episode_count,
      (SELECT MAX(e.pub_date) FROM podcast_episodes e WHERE e.feed_id = f.id AND e.pub_date IS NOT NULL) AS latest_pub_date
    FROM podcast_feeds f WHERE f.user = ? ORDER BY f.sort_order ASC, f.created_at DESC
  `).all(username);
}

export function reorderPodcastFeeds(username, orderedIds) {
  const update = db.prepare('UPDATE podcast_feeds SET sort_order=? WHERE id=? AND user=?');
  db.exec('BEGIN');
  try {
    orderedIds.forEach((id, idx) => update.run(idx, id, username));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getPodcastFeed(id, username) {
  const row = db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM podcast_episodes e WHERE e.feed_id = f.id) AS episode_count,
      (SELECT MAX(e.pub_date) FROM podcast_episodes e WHERE e.feed_id = f.id AND e.pub_date IS NOT NULL) AS latest_pub_date
    FROM podcast_feeds f WHERE f.id = ? AND f.user = ?
  `).get(id, username);
  return row || null;
}

export function createPodcastFeed(username, data) {
  const now = Math.floor(Date.now() / 1000);
  const r = db.prepare(
    'INSERT INTO podcast_feeds (user, url, title, description, img, author, language, last_fetched, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(username, data.url, data.title || null, data.description || null, data.img || null, data.author || null, data.language || null, data.last_fetched || now, now);
  return Number(r.lastInsertRowid);
}

export function deletePodcastFeed(id, username) {
  db.prepare('DELETE FROM podcast_episodes WHERE feed_id = ?').run(id);
  db.prepare('DELETE FROM podcast_feeds WHERE id = ? AND user = ?').run(id, username);
}

export function updatePodcastFeedFetched(id, username, ts) {
  db.prepare('UPDATE podcast_feeds SET last_fetched = ? WHERE id = ? AND user = ?').run(ts, id, username);
}
export function updatePodcastFeedTitle(id, username, title) {
  db.prepare('UPDATE podcast_feeds SET title = ? WHERE id = ? AND user = ?').run(title, id, username);
}
export function updatePodcastFeedImg(id, username, img) {
  db.prepare('UPDATE podcast_feeds SET img = ? WHERE id = ? AND user = ?').run(img, id, username);
}
export function updatePodcastFeedUrl(id, username, url) {
  db.prepare('UPDATE podcast_feeds SET url = ? WHERE id = ? AND user = ?').run(url, id, username);
}

export function getPodcastFeedImgUsageCount(img) {
  return db.prepare('SELECT COUNT(*) AS cnt FROM podcast_feeds WHERE img = ?').get(img)?.cnt ?? 0;
}

// ── Podcast Episodes ──────────────────────────────────────────
export function getPodcastEpisode(id) {
  return db.prepare('SELECT * FROM podcast_episodes WHERE id = ?').get(id);
}

export function getPodcastEpisodes(feedId) {
  return db.prepare(
    'SELECT * FROM podcast_episodes WHERE feed_id = ? ORDER BY pub_date DESC, id DESC'
  ).all(feedId);
}

export function upsertPodcastEpisodes(feedId, episodes) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO podcast_episodes (feed_id, guid, title, description, audio_url, pub_date, duration_secs, img, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(feed_id, guid) DO UPDATE SET
      title=excluded.title, description=excluded.description,
      audio_url=excluded.audio_url, pub_date=excluded.pub_date,
      duration_secs=excluded.duration_secs, img=excluded.img
  `);
  db.exec('BEGIN');
  try {
    for (const ep of episodes) {
      stmt.run(feedId, ep.guid, ep.title || null, ep.description || null, ep.audio_url,
        ep.pub_date || null, ep.duration_secs || 0, ep.img || null, now);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function saveEpisodeProgress(episodeId, feedId, position, played) {
  db.prepare(
    'UPDATE podcast_episodes SET play_position = ?, played = ? WHERE id = ? AND feed_id = ?'
  ).run(position, played ? 1 : 0, episodeId, feedId);
}

// ── Smart Playlists ──────────────────────────────────────────────────────────

function _buildSmartPlaylistQuery(filters, vpaths, username, countOnly, ignoreVPaths, filepathPrefix) {
  const filtered = vpathFilter(vpaths, ignoreVPaths || null);
  if (filtered.length === 0) return null;
  const vIn = inClause('f.vpath', filtered);
  const params = [username, ...vIn.params];
  let whereSql = `WHERE ${vIn.sql}`;

  if (filepathPrefix && typeof filepathPrefix === 'string') {
    whereSql += " AND f.filepath LIKE ? ESCAPE '\\'";
    params.push(filepathPrefix.replace(/[%_\\]/g, '\\$&') + '%');
  }

  if (filters.genres && filters.genres.length > 0) {
    const gIn = inClause('f.genre', filters.genres);
    whereSql += ` AND ${gIn.sql}`;
    params.push(...gIn.params);
  }
  if (filters.yearFrom) { whereSql += ' AND f.year >= ?'; params.push(Number(filters.yearFrom)); }
  if (filters.yearTo)   { whereSql += ' AND f.year <= ?'; params.push(Number(filters.yearTo)); }
  if (filters.minRating > 0) {
    whereSql += ' AND COALESCE(um.rating,0) >= ?';
    params.push(Number(filters.minRating));
  }
  if (filters.playedStatus === 'never') {
    whereSql += ' AND (um.pc IS NULL OR um.pc = 0)';
  } else if (filters.playedStatus === 'played') {
    whereSql += ' AND um.pc > 0';
  } else if (filters.minPlayCount > 0) {
    whereSql += ' AND um.pc >= ?';
    params.push(Number(filters.minPlayCount));
  }
  if (filters.starred) { whereSql += ' AND um.starred = 1'; }
  if (filters.artistSearch && filters.artistSearch.trim()) {
    whereSql += ' AND f.artist LIKE ? COLLATE NOCASE';
    params.push(`%${filters.artistSearch.trim()}%`);
  }

  const joinSql = 'FROM files f LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?';
  return { joinSql, whereSql, params };
}

const _SORT_MAP = {
  artist:      'f.artist COLLATE NOCASE, f.album COLLATE NOCASE, COALESCE(f.disk,0), COALESCE(f.track,0)',
  album:       'f.album COLLATE NOCASE, COALESCE(f.disk,0), COALESCE(f.track,0)',
  year_asc:    'f.year ASC, f.artist COLLATE NOCASE',
  year_desc:   'f.year DESC, f.artist COLLATE NOCASE',
  rating:      'COALESCE(um.rating,0) DESC, f.artist COLLATE NOCASE',
  play_count:  'COALESCE(um.pc,0) DESC, f.artist COLLATE NOCASE',
  last_played: 'um.lp DESC, f.artist COLLATE NOCASE',
  random:      'RANDOM()',
};

export function runSmartPlaylist(filters, sort, limitN, vpaths, username, ignoreVPaths, filepathPrefix) {
  const q = _buildSmartPlaylistQuery(filters, vpaths, username, false, ignoreVPaths, filepathPrefix);
  if (!q) return [];
  const orderSql = 'ORDER BY ' + (_SORT_MAP[sort] || _SORT_MAP.artist);
  const limit = Math.min(Number(limitN) || 100, 1000);
  const rows = db.prepare(
    `SELECT f.rowid AS id, f.*, COALESCE(um.rating,0) AS rating, COALESCE(um.starred,0) AS starred, um.lp AS lastPlayed, COALESCE(um.pc,0) AS playCount ` +
    `${q.joinSql} ${q.whereSql} ${orderSql} LIMIT ?`
  ).all(...q.params, limit);
  return rows.map(mapFileRow);
}

export function countSmartPlaylist(filters, vpaths, username, ignoreVPaths, filepathPrefix) {
  const q = _buildSmartPlaylistQuery(filters, vpaths, username, true, ignoreVPaths, filepathPrefix);
  if (!q) return 0;
  return db.prepare(`SELECT COUNT(*) AS n ${q.joinSql} ${q.whereSql}`).get(...q.params).n;
}

export function getSmartPlaylists(username) {
  return db.prepare('SELECT * FROM smart_playlists WHERE user = ? ORDER BY name COLLATE NOCASE').all(username)
    .map(r => ({ ...r, filters: JSON.parse(r.filters) }));
}

export function getSmartPlaylist(id, username) {
  const r = db.prepare('SELECT * FROM smart_playlists WHERE id = ? AND user = ?').get(id, username);
  if (!r) return null;
  return { ...r, filters: JSON.parse(r.filters) };
}

export function saveSmartPlaylist(username, name, filters, sort, limitN) {
  const result = db.prepare(
    'INSERT INTO smart_playlists (user, name, filters, sort, limit_n, created) VALUES (?,?,?,?,?,?)'
  ).run(username, name, JSON.stringify(filters), sort, limitN, Math.floor(Date.now() / 1000));
  return result.lastInsertRowid;
}

export function updateSmartPlaylist(id, username, data) {
  const existing = db.prepare('SELECT id FROM smart_playlists WHERE id = ? AND user = ?').get(id, username);
  if (!existing) return false;
  db.prepare('UPDATE smart_playlists SET name = ?, filters = ?, sort = ?, limit_n = ? WHERE id = ? AND user = ?')
    .run(data.name, JSON.stringify(data.filters), data.sort, data.limit_n, id, username);
  return true;
}

export function deleteSmartPlaylist(id, username) {
  const result = db.prepare('DELETE FROM smart_playlists WHERE id = ? AND user = ?').run(id, username);
  return result.changes > 0;
}

// ── Genre Groups (admin-configured display groupings) ─────────────────────
export function getGenreGroups() {
  const row = db.prepare('SELECT groups FROM genre_groups WHERE id = 1').get();
  if (!row) return [];
  try { return JSON.parse(row.groups); } catch(_) { return []; }
}

export function saveGenreGroups(groups) {
  db.prepare('INSERT INTO genre_groups(id, groups) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET groups=excluded.groups')
    .run(JSON.stringify(groups));
}
