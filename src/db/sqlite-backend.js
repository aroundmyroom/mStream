import path from 'path';
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
  db = new DatabaseSync(path.join(dbDirectory, 'mstream.sqlite'));
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      title TEXT, artist TEXT, year INTEGER, album TEXT,
      filepath TEXT NOT NULL, format TEXT, track INTEGER, disk INTEGER,
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
      count      INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_se_last_seen ON scan_errors(last_seen);
    CREATE INDEX IF NOT EXISTS idx_se_vpath    ON scan_errors(vpath);
  `);
  // Migration: add cuepoints column for databases created before this feature
  try { db.exec('ALTER TABLE files ADD COLUMN cuepoints TEXT'); } catch (_e) {}
  // Migration: add fixed_at column for scan-error auto-fix feature
  try { db.exec('ALTER TABLE scan_errors ADD COLUMN fixed_at INTEGER'); } catch (_e) {}
  // Migration: add art_source column to track art provenance (embedded / directory / discogs)
  try { db.exec('ALTER TABLE files ADD COLUMN art_source TEXT'); } catch (_e) {}
  // Migration: add duration column (track length in seconds)
  try { db.exec('ALTER TABLE files ADD COLUMN duration REAL'); } catch (_e) {}
  // Migration: add artist_id / album_id columns for indexed Subsonic-style lookups
  try { db.exec('ALTER TABLE files ADD COLUMN artist_id TEXT'); } catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN album_id TEXT'); } catch (_e) {}
  // Migration: add starred column to user_metadata for Subsonic star/unstar
  try { db.exec('ALTER TABLE user_metadata ADD COLUMN starred INTEGER DEFAULT 0'); } catch (_e) {}
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
      'INSERT INTO files (title, artist, year, album, filepath, format, track, disk, modified, hash, aaFile, vpath, ts, sID, replaygainTrackDb, genre, cuepoints, art_source, duration, artist_id, album_id) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  });
}

export function close() {
  if (db) { db.close(); }
}

// Save operations (no-ops for SQLite - writes are immediate)
export function saveFilesDB() {}
export function saveUserDB() {}
export function saveShareDB() {}

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

// File Operations
export function findFileByPath(filepath, vpath) {
  const row = _s.findFile.get(filepath, vpath);
  return row || null;
}

export function updateFileScanId(file, scanId) {
  _s.updateScanId.run(scanId, file.filepath, file.vpath);
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
  values.push(filepath, vpath);
  db.prepare(`UPDATE files SET ${fields.join(', ')} WHERE filepath = ? AND vpath = ?`).run(...values);
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
    fileData.filepath, fileData.format ?? null, fileData.track ?? null, fileData.disk ?? null,
    fileData.modified ?? null, fileData.hash ?? null, fileData.aaFile ?? null, fileData.vpath,
    ts, fileData.sID ?? null, fileData.replaygainTrackDb ?? null, fileData.genre ?? null, fileData.cuepoints ?? null,
    fileData.art_source ?? null, fileData.duration ?? null,
    fileData.artist_id ?? _makeArtistId(fileData.artist), fileData.album_id ?? _makeAlbumId(fileData.artist, fileData.album)
  );
  return { ...fileData, id: Number(result.lastInsertRowid) };
}

export function removeFileByPath(filepath, vpath) {
  _s.removeByPath.run(filepath, vpath);
}

export function getLiveArtFilenames() {
  return _s.liveArt.all().map(r => r.aaFile);
}

export function getLiveHashes() {
  return _s.liveHashes.all().map(r => r.hash);
}

export function getStaleFileHashes(vpath, scanId) {
  return _s.staleHashes.all(vpath, scanId).map(r => r.hash);
}

export function removeStaleFiles(vpath, scanId) {
  _s.removeStale.run(vpath, scanId);
}

export function removeFilesByVpath(vpath) {
  db.prepare('DELETE FROM files WHERE vpath = ?').run(vpath);
}

export function countFilesByVpath(vpath) {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE vpath = ?').get(vpath);
  return row.cnt;
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

export function getArtists(vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const rows = db.prepare(`SELECT DISTINCT artist FROM files WHERE ${vIn.sql} AND artist IS NOT NULL ORDER BY artist COLLATE NOCASE`).all(...vIn.params);
  return rows.map(r => r.artist);
}

export function getArtistAlbums(artist, vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const rows = db.prepare(`
    SELECT DISTINCT album AS name, year, aaFile AS album_art_file
    FROM files
    WHERE ${vIn.sql} AND artist = ?
    ORDER BY year DESC
  `).all(...vIn.params, String(artist));

  // Deduplicate like Loki backend does (by album+year combo)
  const albums = [];
  const store = {};
  for (const row of rows) {
    if (row.name === null) {
      if (!store[null]) {
        albums.push({ name: null, year: null, album_art_file: row.album_art_file || null });
        store[null] = true;
      }
    } else if (!store[`${row.name}${row.year}`]) {
      albums.push({ name: row.name, year: row.year, album_art_file: row.album_art_file || null });
      store[`${row.name}${row.year}`] = true;
    }
  }
  return albums;
}

export function getAlbums(vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const rows = db.prepare(`
    SELECT DISTINCT album AS name, aaFile AS album_art_file, year
    FROM files
    WHERE ${vIn.sql} AND album IS NOT NULL
    ORDER BY album COLLATE NOCASE
  `).all(...vIn.params);

  const albums = [];
  const store = {};
  for (const row of rows) {
    if (!store[`${row.name}${row.year}`]) {
      albums.push({ name: row.name, album_art_file: row.album_art_file, year: row.year });
      store[`${row.name}${row.year}`] = true;
    }
  }
  return albums;
}

export function getAlbumSongs(album, vpaths, username, opts) {
  const filtered = vpathFilter(vpaths, opts.ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);

  let sql = `
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}
  `;
  const params = [username, ...vIn.params];

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

export function searchFiles(searchCol, searchTerm, vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }

  const validCols = ['artist', 'album', 'filepath', 'title'];
  if (!validCols.includes(searchCol)) { return []; }

  const vIn = inClause('vpath', filtered);
  const sql = `SELECT rowid AS id, * FROM files WHERE ${vIn.sql} AND ${searchCol} LIKE '%' || ? || '%' COLLATE NOCASE`;
  const rows = db.prepare(sql).all(...vIn.params, String(searchTerm));
  return rows.map(mapFileRow);
}

export function getRatedSongs(vpaths, username, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.rating > 0 AND ${vIn.sql}
    ORDER BY um.rating DESC
  `).all(username, ...vIn.params);
  return rows.map(mapFileRow);
}

export function getRecentlyAdded(vpaths, username, limit, ignoreVPaths, opts = {}) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}${pf.sql} AND f.ts > 0
    ORDER BY f.ts DESC
    LIMIT ?
  `).all(username, ...vIn.params, ...pf.params, limit);
  return rows.map(mapFileRow);
}

export function getRecentlyPlayed(vpaths, username, limit, ignoreVPaths, opts = {}) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.lp AS lastPlayed, um.pc AS playCount
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.lp > 0 AND ${vIn.sql}${pf.sql}
    ORDER BY um.lp DESC
    LIMIT ?
  `).all(username, ...vIn.params, ...pf.params, limit);
  return rows.map(mapFileRow);
}

export function getMostPlayed(vpaths, username, limit, ignoreVPaths, opts = {}) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix, 'f.filepath');
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.lp AS lastPlayed, um.pc AS playCount
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.pc > 0 AND ${vIn.sql}${pf.sql}
    ORDER BY um.pc DESC
    LIMIT ?
  `).all(username, ...vIn.params, ...pf.params, limit);
  return rows.map(mapFileRow);
}

export function getAllFilesWithMetadata(vpaths, username, opts) {
  const filtered = vpathFilter(vpaths, opts.ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);

  let sql = `
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql}
  `;
  const params = [username, ...vIn.params];

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
  let sql = `FROM files f LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ? WHERE ${vIn.sql}`;
  const params = [...vIn.params];

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

export function getAlbumsByDecade(decade, vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  // GROUP BY album+artist so SQLite deduplicates — no JS loop needed.
  // MIN(year) picks a representative year; MAX(aaFile) prefers a non-null art file.
  return db.prepare(`
    SELECT album AS name,
           MAX(aaFile) AS album_art_file,
           MIN(year)   AS year,
           artist
    FROM files
    WHERE ${vIn.sql} AND album IS NOT NULL AND year >= ? AND year <= ?
    GROUP BY album, artist
    ORDER BY MIN(year), album COLLATE NOCASE
  `).all(...vIn.params, decade, decade + 9);
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
    // Re-occurrence resets fixed_at so a re-broken file becomes unfixed again
    db.prepare('UPDATE scan_errors SET last_seen = ?, count = count + 1, fixed_at = NULL WHERE guid = ?').run(now, guid);
  } else {
    db.prepare(
      'INSERT INTO scan_errors (guid, filepath, vpath, error_type, error_msg, stack, first_seen, last_seen, count) VALUES (?,?,?,?,?,?,?,?,1)'
    ).run(guid, filepath, vpath, errorType, errorMsg || '', stack || '', now, now);
  }
}

export function getScanErrors() {
  return db.prepare('SELECT * FROM scan_errors ORDER BY fixed_at DESC NULLS LAST, last_seen DESC').all();
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

/** Mark a single error as fixed. */
export function markScanErrorFixed(guid) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE scan_errors SET fixed_at = ? WHERE guid = ?').run(now, guid);
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

/** Count only unfixed errors (used for the sidebar badge). */
export function getScanErrorCount() {
  return db.prepare('SELECT COUNT(*) AS cnt FROM scan_errors WHERE fixed_at IS NULL').get().cnt;
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
