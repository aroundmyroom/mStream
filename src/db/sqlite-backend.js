import path from 'path';
import { DatabaseSync } from 'node:sqlite';

let db;

export function init(dbDirectory) {
  db = new DatabaseSync(path.join(dbDirectory, 'mstream.sqlite'));
  db.exec('PRAGMA journal_mode=WAL');
  // NORMAL skips per-write fsync (safe with WAL); prevents 50-200ms event-loop
  // stalls on slow storage (SD card, HDD) that would interrupt audio streaming.
  db.exec('PRAGMA synchronous = NORMAL');
  // Raise auto-checkpoint threshold so SQLite never triggers a blocking
  // checkpoint while a song is streaming. The WAL is cleaned up on DB close.
  db.exec('PRAGMA wal_autocheckpoint(10000)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      title TEXT, artist TEXT, year INTEGER, album TEXT,
      filepath TEXT NOT NULL, format TEXT, track INTEGER, disk INTEGER,
      modified REAL, hash TEXT, aaFile TEXT, vpath TEXT NOT NULL,
      ts INTEGER, sID TEXT, replaygainTrackDb REAL, genre TEXT, cuepoints TEXT
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
      rating INTEGER, pc INTEGER DEFAULT 0, lp INTEGER,
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

// File Operations
export function findFileByPath(filepath, vpath) {
  const row = db.prepare('SELECT rowid AS id, * FROM files WHERE filepath = ? AND vpath = ?').get(filepath, vpath);
  return row || null;
}

export function updateFileScanId(file, scanId) {
  db.prepare('UPDATE files SET sID = ? WHERE filepath = ? AND vpath = ?').run(scanId, file.filepath, file.vpath);
}

export function updateFileArt(filepath, vpath, aaFile, scanId) {
  db.prepare('UPDATE files SET aaFile = ?, sID = ? WHERE filepath = ? AND vpath = ?').run(aaFile, scanId, filepath, vpath);
}

export function updateFileCue(filepath, vpath, cuepoints) {
  // cuepoints is either a JSON string or '[]' (sentinel = checked, no cue)
  db.prepare('UPDATE files SET cuepoints = ? WHERE filepath = ? AND vpath = ?').run(cuepoints, filepath, vpath);
}

export function insertFile(fileData) {
  // If this hash already exists under a different vpath, inherit that ts so the
  // file doesn't appear as "newly added" just because a new vpath was created.
  let ts = fileData.ts ?? null;
  if (fileData.hash) {
    const existing = db.prepare('SELECT ts FROM files WHERE hash = ? AND ts IS NOT NULL LIMIT 1').get(fileData.hash);
    if (existing) { ts = existing.ts; }
  }
  const stmt = db.prepare(`INSERT INTO files (title, artist, year, album, filepath, format, track, disk, modified, hash, aaFile, vpath, ts, sID, replaygainTrackDb, genre, cuepoints)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const result = stmt.run(
    fileData.title ?? null, fileData.artist ?? null, fileData.year ?? null, fileData.album ?? null,
    fileData.filepath, fileData.format ?? null, fileData.track ?? null, fileData.disk ?? null,
    fileData.modified ?? null, fileData.hash ?? null, fileData.aaFile ?? null, fileData.vpath,
    ts, fileData.sID ?? null, fileData.replaygainTrackDb ?? null, fileData.genre ?? null, fileData.cuepoints ?? null
  );
  return { ...fileData, id: Number(result.lastInsertRowid) };
}

export function removeFileByPath(filepath, vpath) {
  db.prepare('DELETE FROM files WHERE filepath = ? AND vpath = ?').run(filepath, vpath);
}

export function getLiveArtFilenames() {
  return db.prepare('SELECT DISTINCT aaFile FROM files WHERE aaFile IS NOT NULL')
    .all().map(r => r.aaFile);
}

export function getLiveHashes() {
  return db.prepare('SELECT DISTINCT hash FROM files WHERE hash IS NOT NULL')
    .all().map(r => r.hash);
}

export function getStaleFileHashes(vpath, scanId) {
  return db.prepare('SELECT hash FROM files WHERE vpath = ? AND sID != ? AND hash IS NOT NULL')
    .all(vpath, scanId)
    .map(r => r.hash);
}

export function removeStaleFiles(vpath, scanId) {
  db.prepare('DELETE FROM files WHERE vpath = ? AND sID != ?').run(vpath, scanId);
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

  return {
    totalFiles,
    totalArtists,
    totalAlbums,
    totalGenres,
    withArt,
    withoutArt: totalFiles - withArt,
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

export function getRecentlyAdded(vpaths, username, limit, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql} AND f.ts > 0
    ORDER BY f.ts DESC
    LIMIT ?
  `).all(username, ...vIn.params, limit);
  return rows.map(mapFileRow);
}

export function getRecentlyPlayed(vpaths, username, limit, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.lp AS lastPlayed, um.pc AS playCount
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.lp > 0 AND ${vIn.sql}
    ORDER BY um.lp DESC
    LIMIT ?
  `).all(username, ...vIn.params, limit);
  return rows.map(mapFileRow);
}

export function getMostPlayed(vpaths, username, limit, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('f.vpath', filtered);
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating, um.lp AS lastPlayed, um.pc AS playCount
    FROM user_metadata um
    INNER JOIN files f ON f.hash = um.hash
    WHERE um.user = ? AND um.pc > 0 AND ${vIn.sql}
    ORDER BY um.pc DESC
    LIMIT ?
  `).all(username, ...vIn.params, limit);
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

export function getGenres(vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  return db.prepare(
    `SELECT genre, COUNT(*) AS cnt FROM files WHERE ${vIn.sql} AND genre IS NOT NULL AND genre != '' GROUP BY genre ORDER BY genre COLLATE NOCASE`
  ).all(...vIn.params);
}

export function getSongsByGenre(genre, vpaths, username, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) return [];
  const vIn = inClause('f.vpath', filtered);
  const rows = db.prepare(`
    SELECT f.rowid AS id, f.*, um.rating
    FROM files f
    LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
    WHERE ${vIn.sql} AND f.genre = ?
    ORDER BY f.artist COLLATE NOCASE, f.album COLLATE NOCASE, f.disk, f.track
  `).all(username, ...vIn.params, genre);
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
    db.prepare('UPDATE scan_errors SET last_seen = ?, count = count + 1 WHERE guid = ?').run(now, guid);
  } else {
    db.prepare(
      'INSERT INTO scan_errors (guid, filepath, vpath, error_type, error_msg, stack, first_seen, last_seen, count) VALUES (?,?,?,?,?,?,?,?,1)'
    ).run(guid, filepath, vpath, errorType, errorMsg || '', stack || '', now, now);
  }
}

export function getScanErrors() {
  return db.prepare('SELECT * FROM scan_errors ORDER BY last_seen DESC').all();
}

export function clearScanErrors() {
  db.prepare('DELETE FROM scan_errors').run();
}

/** Remove entries whose last_seen is older than retentionHours. */
export function pruneScanErrors(retentionHours) {
  const cutoff = Math.floor(Date.now() / 1000) - retentionHours * 3600;
  db.prepare('DELETE FROM scan_errors WHERE last_seen < ?').run(cutoff);
}

export function getScanErrorCount() {
  return db.prepare('SELECT COUNT(*) AS cnt FROM scan_errors').get().cnt;
}
