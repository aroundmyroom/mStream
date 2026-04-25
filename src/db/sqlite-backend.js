import path from 'path';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'crypto';
import * as config from '../state/config.js';

const _workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../util/artist-rebuild-worker.mjs');

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

/**
 * Compute the "physical album directory" from a file's relative filepath.
 * Strips the filename, then collapses any trailing /CD N / Disc N / Side N
 * indicator so that multi-disc albums group together under one directory key.
 */
function _normalizeAlbumDir(filepath) {
  const lastSlash = filepath.lastIndexOf('/');
  let dir = lastSlash > 0 ? filepath.slice(0, lastSlash) : '';
  // Collapse trailing disc-indicator segment so CD 1 and CD 2 share the same key
  dir = dir.replace(/\/(CD|Disc|Disk|Side)\s*\d+\s*$/i, '');
  return dir;
}

let db;
let _dbPath = null;
let _rebuildInFlight = false;
const _s = {}; // cached prepared statements — populated in init(), reused on every call
// Dynamic statement cache: keyed by SQL string. Covers search queries whose SQL
// varies by vpath count. On a typical server the vpath set is stable, so the
// cache always hits after the first search — saves sqlite3_prepare_v2 overhead
// on every keystroke (6 queries × every search request).
const _stmtCache = new Map();
function _prepare(sql) {
  let s = _stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); _stmtCache.set(sql, s); }
  return s;
}

/** Expose raw DatabaseSync instance for modules (like DLNA) that need custom queries. */
export function getDB() { return db; }

export function init(dbDirectory) {
  mkdirSync(dbDirectory, { recursive: true });
  const dbPath = path.join(dbDirectory, 'mstream.sqlite');
  _dbPath = dbPath;
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  // NORMAL skips per-write fsync (safe with WAL); prevents 50-200ms event-loop
  // stalls on slow storage (SD card, HDD) that would interrupt audio streaming.
  db.exec('PRAGMA synchronous = NORMAL');
  // Wait up to 30 s for write locks before throwing "database is locked".
  // Needed when the acoustid worker thread also writes to the same DB.
  db.exec('PRAGMA busy_timeout = 30000');
  // Raise auto-checkpoint threshold so SQLite never triggers a blocking
  // checkpoint while a song is streaming. The WAL is cleaned up on DB close.
  db.exec('PRAGMA wal_autocheckpoint(10000)');
  // 32 MB page cache — default 2 MB is far too small for a 123K-song library;
  // keeps frequently-used B-tree pages (indexes, hot rows) in RAM.
  db.exec('PRAGMA cache_size = -32000');
  // Keep sort/temp B-trees in memory instead of spilling to disk.
  db.exec('PRAGMA temp_store = MEMORY');
  // Memory-mapped I/O (128 MB): reads map pages directly from the OS page cache
  // without an extra kernel→user memcpy. Especially useful on Docker bind mounts
  // and systems with multiple music roots where random page reads are frequent.
  db.exec('PRAGMA mmap_size = 134217728');
  // Migrate to 8 KB pages if still on the SQLite default 4 KB.
  // Larger pages = shallower B-trees = fewer reads per query on a 167 MB+ DB.
  // IMPORTANT: page_size cannot be changed while journal_mode=WAL is active.
  // We must temporarily switch to DELETE journal mode, VACUUM, then restore WAL.
  // Runs once on first boot after this change (~3–5 s for 167 MB); skipped on
  // all subsequent boots because page_size is already 8192.
  const currentPageSize = db.prepare('PRAGMA page_size').get().page_size;
  if (currentPageSize !== 8192) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');  // flush WAL before switching modes
    db.exec('PRAGMA journal_mode = DELETE');     // WAL must be off for page_size change
    db.exec('PRAGMA page_size = 8192');
    db.exec('VACUUM');                           // rebuilds file with new page size
    db.exec('PRAGMA journal_mode = WAL');        // restore WAL
    _stmtCache.clear();                          // invalidate any pre-migration stmts
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      title TEXT, artist TEXT, year INTEGER, album TEXT,
      filepath TEXT NOT NULL, format TEXT, track INTEGER, trackOf INTEGER, disk INTEGER,
      modified REAL, hash TEXT, audio_hash TEXT, aaFile TEXT, vpath TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_files_full_path ON files(vpath || '/' || filepath);

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

    CREATE TABLE IF NOT EXISTS scan_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id     TEXT,
      vpath       TEXT NOT NULL,
      started_at  INTEGER,
      finished_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scan_runs_finished_at ON scan_runs(finished_at);
    CREATE INDEX IF NOT EXISTS idx_scan_runs_vpath ON scan_runs(vpath);

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

    CREATE TABLE IF NOT EXISTS play_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT NOT NULL,
      file_hash    TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER,
      duration_ms  INTEGER,
      played_ms    INTEGER,
      completed    INTEGER DEFAULT 0,
      skipped      INTEGER DEFAULT 0,
      source       TEXT,
      session_id   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pe_user_started  ON play_events(user_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_pe_user_hash     ON play_events(user_id, file_hash);
    CREATE INDEX IF NOT EXISTS idx_pe_session       ON play_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_pe_user_completed ON play_events(user_id, completed);

    CREATE TABLE IF NOT EXISTS listening_sessions (
      session_id   TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER,
      total_tracks INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ls_user_started ON listening_sessions(user_id, started_at);

    CREATE TABLE IF NOT EXISTS radio_play_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT NOT NULL,
      station_id   INTEGER,
      station_name TEXT NOT NULL,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER,
      listened_ms  INTEGER DEFAULT 0,
      session_id   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rpe_user_started ON radio_play_events(user_id, started_at);

    CREATE TABLE IF NOT EXISTS podcast_play_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      episode_id  INTEGER NOT NULL,
      feed_id     INTEGER NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      played_ms   INTEGER DEFAULT 0,
      completed   INTEGER DEFAULT 0,
      session_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ppe_user_started ON podcast_play_events(user_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_ppe_user_feed    ON podcast_play_events(user_id, feed_id);
  `);
  // Migration: add cuepoints column for databases created before this feature
  try { db.exec('ALTER TABLE files ADD COLUMN cuepoints TEXT'); } catch (_e) {}
  // Migration: add fixed_at column for scan-error auto-fix feature
  try { db.exec('ALTER TABLE scan_errors ADD COLUMN fixed_at INTEGER'); } catch (_e) {}
  // Migration: add art_source column to track art provenance (embedded / directory / discogs)
  try { db.exec('ALTER TABLE files ADD COLUMN art_source TEXT'); } catch (_e) {}
  // Migration: add audio_hash column for dual-hash identity (prevents data loss on transcodes)
  try { db.exec('ALTER TABLE files ADD COLUMN audio_hash TEXT'); } catch (_e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_files_audio_hash ON files(audio_hash)'); } catch (_e) {}
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
  // Migration: add cover_file to store the original cover image filename (e.g. "cover.jpg") discovered during scan
  try { db.exec('ALTER TABLE files ADD COLUMN cover_file TEXT'); } catch (_e) {}
  // Migration: add pause_count to play_events to track user-initiated pauses
  try { db.exec('ALTER TABLE play_events ADD COLUMN pause_count INTEGER DEFAULT 0'); } catch (_e) {}
  // Migration: AcoustID fingerprinting columns
  try { db.exec('ALTER TABLE files ADD COLUMN acoustid_id TEXT'); }     catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN mbid TEXT'); }             catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN acoustid_score REAL'); }   catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN acoustid_status TEXT'); }  catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN acoustid_ts INTEGER'); }   catch (_e) {}
  // Migration: AcoustID v2 — canonical MB title/artist stored from recordings meta
  try { db.exec('ALTER TABLE files ADD COLUMN mb_title TEXT'); }         catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN mb_artist TEXT'); }        catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN mb_artist_id TEXT'); }     catch (_e) {}
  // Migration: Tag Workshop — MusicBrainz enrichment columns (Phase 2)
  try { db.exec('ALTER TABLE files ADD COLUMN mb_album TEXT'); }              catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN mb_year INTEGER'); }            catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN mb_track INTEGER'); }           catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN mb_release_id TEXT'); }         catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN mb_enrichment_status TEXT'); }  catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN mb_enriched_ts INTEGER'); }     catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN mb_enrichment_error TEXT'); }   catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN tag_status TEXT'); }            catch (_e) {}
  // Migration: Tag Workshop Phase 3 — per-physical-album grouping
  try { db.exec('ALTER TABLE files ADD COLUMN mb_album_dir TEXT'); }          catch (_e) {}
  // Migration: audio technical metadata — bitrate (kbps), sample_rate (Hz), channels
  try { db.exec('ALTER TABLE files ADD COLUMN bitrate INTEGER'); }             catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN sample_rate INTEGER'); }         catch (_e) {}
  try { db.exec('ALTER TABLE files ADD COLUMN channels INTEGER'); }            catch (_e) {}
  // Backfill mb_album_dir for all existing enriched rows (idempotent)
  try {
    const _bfDir = db.prepare(
      "SELECT filepath, vpath FROM files WHERE mb_release_id IS NOT NULL AND mb_album_dir IS NULL"
    ).all();
    if (_bfDir.length > 0) {
      const _bfDirUpd = db.prepare('UPDATE files SET mb_album_dir = ? WHERE filepath = ? AND vpath = ?');
      db.exec('BEGIN');
      for (const r of _bfDir) _bfDirUpd.run(_normalizeAlbumDir(r.filepath), r.filepath, r.vpath);
      db.exec('COMMIT');
    }
  } catch (_e) {}
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_mb_enrichment_status ON files(mb_enrichment_status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_tag_status ON files(tag_status)');
  // Reset any 'found' rows that have null mbid (processed with broken meta flag) so they re-queue
  try {
    const _fixCount = db.prepare("SELECT COUNT(*) AS n FROM files WHERE acoustid_status='found' AND mbid IS NULL").get().n;
    if (_fixCount > 0) {
      db.exec("UPDATE files SET acoustid_status = NULL, acoustid_ts = NULL WHERE acoustid_status = 'found' AND mbid IS NULL");
    }
  } catch (_e) {}
  // Ensure indexes exist (IF NOT EXISTS is idempotent — safe on every startup)
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_artist_id ON files(artist_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_album_id ON files(album_id)');
  // Covering index for getAaFileForDir: fast folder-art lookups by (vpath, filepath prefix)
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_vpath_filepath_aa ON files(vpath, filepath, aaFile)');
  // AcoustID: worker scans for NULL status to find unprocessed files
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_acoustid_status ON files(acoustid_status)');
  // Composite index for the MB enrichment worker queue (acoustid_status + mb_enrichment_status + mbid)
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_mb_enrich_queue ON files(acoustid_status, mb_enrichment_status, mbid)');
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
  // Migrations: add columns introduced after initial release
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN vpaths_json    TEXT DEFAULT '[]'"); } catch (_e) { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN bio           TEXT"); }             catch (_e) { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN image_file    TEXT"); }             catch (_e) { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN image_source  TEXT"); }             catch (_e) { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN last_fetched  INTEGER"); }          catch (_e) { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN image_flag_wrong INTEGER DEFAULT 0"); } catch (_e) { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN name_override INTEGER DEFAULT 0"); } catch (_e) { /* already exists */ }
  try { db.exec("ALTER TABLE artists_normalized ADD COLUMN song_count    INTEGER DEFAULT 0"); } catch (_e) { /* already exists */ }

  // ── Missing indexes (added post-initial-release) ──────────────────────────
  // Artist Home page: ORDER BY song_count DESC LIMIT 20 — was a full 18k-row
  // scan + temp B-TREE sort on every page load.
  db.exec('CREATE INDEX IF NOT EXISTS idx_an_song_count ON artists_normalized(song_count DESC)');
  // Audit queries: WHERE image_flag_wrong=1 — full scan without this index.
  db.exec('CREATE INDEX IF NOT EXISTS idx_an_image_flag ON artists_normalized(image_flag_wrong, song_count DESC)');
  // Artist browse: WHERE vpath=? AND artist=? — was hitting idx_files_vpath_sID
  // then scanning the entire vpath partition to match artist.
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_vpath_artist ON files(vpath, artist)');

  // ── Cache hot-path prepared statements ───────────────────────────────────
  // These functions are called once per file during scans (up to 123K times).
  // Caching avoids re-running sqlite3_prepare_v2 on every call.
  Object.assign(_s, {
    findFile:       db.prepare('SELECT rowid AS id, * FROM files WHERE filepath = ? AND vpath = ?'),
    updateScanId:   db.prepare('UPDATE files SET sID = ? WHERE filepath = ? AND vpath = ?'),
    updateArt:      db.prepare('UPDATE files SET aaFile = ?, sID = ?, art_source = ?, cover_file = ? WHERE filepath = ? AND vpath = ?'),
    countArtUsage:  db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE aaFile = ?'),
    updateCue:      db.prepare('UPDATE files SET cuepoints = ? WHERE filepath = ? AND vpath = ?'),
    updateDuration: db.prepare('UPDATE files SET duration = ? WHERE filepath = ? AND vpath = ?'),
    updateTechMeta: db.prepare('UPDATE files SET bitrate = ?, sample_rate = ?, channels = ? WHERE filepath = ? AND vpath = ?'),
    liveArt:        db.prepare('SELECT DISTINCT aaFile FROM files WHERE aaFile IS NOT NULL'),
    liveHashes:     db.prepare('SELECT DISTINCT hash FROM files WHERE hash IS NOT NULL'),
    staleHashes:    db.prepare('SELECT hash FROM files WHERE vpath = ? AND sID != ? AND hash IS NOT NULL'),
    removeStale:    db.prepare('DELETE FROM files WHERE vpath = ? AND (sID IS NULL OR sID != ?)'),
    removeByPath:   db.prepare('DELETE FROM files WHERE filepath = ? AND vpath = ?'),
    insertScanRun:  db.prepare('INSERT INTO scan_runs (scan_id, vpath, started_at, finished_at) VALUES (?, ?, ?, ?)'),
    getLastScanRun: db.prepare('SELECT MAX(finished_at) AS ts FROM scan_runs'),
    insertFileTs:   db.prepare('SELECT ts FROM files WHERE hash = ? AND ts IS NOT NULL LIMIT 1'),
    insertFileRow:  db.prepare(
      'INSERT INTO files (title, artist, year, album, filepath, format, track, trackOf, disk, modified, hash, audio_hash, aaFile, vpath, ts, sID, replaygainTrackDb, genre, cuepoints, art_source, duration, artist_id, album_id, cover_file, bitrate, sample_rate, channels) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    // FTS5 write statements — used in insert / remove / tag-update paths
    ftsInsert:  db.prepare('INSERT INTO fts_files(rowid, title, artist, album, filepath) VALUES (?, ?, ?, ?, ?)'),
    ftsDel:     db.prepare("INSERT INTO fts_files(fts_files, rowid, title, artist, album, filepath) VALUES ('delete', ?, ?, ?, ?, ?)"),
    ftsRebuild: db.prepare("INSERT INTO fts_files(fts_files) VALUES ('rebuild')"),
    // Metadata lookup — called on every queue restore; caching avoids repeated prepare overhead
    getFileWithMeta: db.prepare(`
      SELECT f.rowid AS id, f.*, um.rating
      FROM files f
      LEFT JOIN user_metadata um ON f.hash = um.hash AND um.user = ?
      WHERE f.filepath = ? AND f.vpath = ?`),
    // Artist search — static SQL (all vpath filtering done in JS); cached here
    // to avoid re-prepare on every keystroke.
    searchArtists: db.prepare(`
      SELECT an.id, an.artist_clean, an.artist_raw_variants, an.vpaths_json
      FROM artists_normalized an
      JOIN fts_artists fa ON an.id = fa.rowid
      WHERE fts_artists MATCH ?
      ORDER BY rank`),  // No LIMIT — full result set returned for accurate counts
  });
  // Run ANALYZE deferred so startup latency is not affected.
  // ANALYZE populates sqlite_stat1 with accurate row counts, letting the query
  // planner make optimal decisions for FTS JOIN queries and ORDER BY plans.
  // Critical for Docker deployments with multiple music roots.
  setImmediate(() => { try { db.exec('ANALYZE'); } catch (_e) { /* ignore */ } });
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
// Uses the smart buildArtistGroups() algorithm that:
//   • merges zero-padded duplicates ("01 DJ Deep" → "DJ Deep") when a clean
//     version exists with ≥50% as many songs
//   • preserves real digit-named artists ("2 Unlimited", "808 State", "50 Cent")
//   • preserves admin-set name_override, bio, image_file across rebuilds
// Queued callbacks to fire after the current in-flight rebuild completes.
const _rebuildDoneCallbacks = [];

/**
 * Rebuild the artists_normalized table in a worker_thread so the
 * CPU-intensive buildArtistGroups pass (~20 s on large libraries) never
 * blocks the main event loop or interrupts audio streaming.
 *
 * Fire-and-forget: returns immediately.  If a rebuild is already running,
 * the request is deduplicated — the optional onComplete callback is still
 * invoked once the current worker finishes.
 *
 * @param {Function} [onComplete]  Called (with no args) when the rebuild finishes.
 */
export function rebuildArtistIndex(onComplete) {
  if (typeof onComplete === 'function') _rebuildDoneCallbacks.push(onComplete);
  if (_rebuildInFlight) return; // already running — callback queued, will fire on completion
  _rebuildInFlight = true;

  // Compute the folder filter synchronously in the main thread (cheap — just reads config)
  const filter = getArtistFolderFilter();

  const worker = new Worker(_workerPath, {
    workerData: {
      dbPath: _dbPath,
      vpaths: filter.vpaths,
      includeFilepathPrefixes: filter.includeFilepathPrefixes,
      excludeFilepathPrefixes: filter.excludeFilepathPrefixes,
    },
  });

  worker.on('message', msg => {
    if (msg.error) {
      // Log but don't crash — the old data remains intact
      import('winston').then(w => w.default.error(`Artist index rebuild failed: ${msg.error}`)).catch(() => {});
    }
  });

  worker.on('exit', () => {
    _rebuildInFlight = false;
    const cbs = _rebuildDoneCallbacks.splice(0);
    for (const cb of cbs) { try { cb(); } catch (_) {} }
  });

  worker.on('error', err => {
    import('winston').then(w => w.default.error(`Artist rebuild worker error: ${err.message}`)).catch(() => {});
  });
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

function getArtistFolderFilter() {
  const folders = config.program?.folders || {};
  const entries = Object.entries(folders);

  function withSlash(p) {
    return String(p || '').replace(/\/?$/, '/');
  }

  function findParent(name) {
    const myRoot = withSlash(folders[name]?.root);
    let best = null;
    let bestLen = -1;
    for (const [other, folder] of entries) {
      if (other === name) continue;
      const otherRoot = withSlash(folder.root);
      if (myRoot === otherRoot) continue;
      if (!myRoot.startsWith(otherRoot)) continue;
      if (otherRoot.length > bestLen) {
        best = other;
        bestLen = otherRoot.length;
      }
    }
    return best;
  }

  function findRoot(name) {
    let cur = name;
    let parent = findParent(cur);
    while (parent) {
      cur = parent;
      parent = findParent(cur);
    }
    return cur;
  }

  const rootNames = entries.map(([name]) => name).filter(name => !findParent(name));
  const allowedRoots = new Set();
  const includeFilepathPrefixes = [];
  const excludeFilepathPrefixes = [];

  for (const rootName of rootNames) {
    const rootFolder = folders[rootName] || {};
    if (rootFolder.type === 'excluded') continue;

    const rootEnabled = rootFolder.artistsOn !== false;
    const rootPath = withSlash(rootFolder.root);
    const descendants = entries.filter(([name, folder]) => {
      if (name === rootName) return false;
      if ((folder.type || 'music') === 'excluded') return false;
      return findRoot(name) === rootName;
    });

    const enabledPrefixes = [];
    for (const [, folder] of descendants) {
      const prefix = withSlash(folder.root).slice(rootPath.length);
      if (!prefix) continue;
      if (folder.artistsOn === false) {
        excludeFilepathPrefixes.push({ vpath: rootName, prefix });
      } else if (!rootEnabled) {
        enabledPrefixes.push(prefix);
      }
    }

    if (rootEnabled) {
      allowedRoots.add(rootName);
      continue;
    }

    if (enabledPrefixes.length > 0) {
      allowedRoots.add(rootName);
      for (const prefix of enabledPrefixes) {
        includeFilepathPrefixes.push({ vpath: rootName, prefix });
      }
    }
  }

  return {
    vpaths: [...allowedRoots],
    includeFilepathPrefixes,
    excludeFilepathPrefixes,
  };
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

export function updateFileArt(filepath, vpath, aaFile, scanId, artSource = null, coverFile = null) {
  _s.updateArt.run(aaFile, scanId, artSource, coverFile, filepath, vpath);
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

export function updateFileTechMeta(filepath, vpath, bitrate, sampleRate, channels) {
  const r = _s.updateTechMeta.run(bitrate ?? null, sampleRate ?? null, channels ?? null, filepath, vpath);
  return r.changes;
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

export function updateFileModified(filepath, vpath, modifiedMs) {
  db.prepare('UPDATE files SET modified = ? WHERE filepath = ? AND vpath = ?').run(modifiedMs, filepath, vpath);
}

export function insertFile(fileData) {
  const normalizeEpochSec = (value) => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Accept both second and millisecond epoch inputs.
    return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  };

  // If this hash already exists under a different vpath, inherit that ts so the
  // file doesn't appear as "newly added" just because a new vpath was created.
  let ts = normalizeEpochSec(fileData.ts);
  if (fileData.hash) {
    const existing = _s.insertFileTs.get(fileData.hash);
    if (existing) { ts = normalizeEpochSec(existing.ts); }
  }
  const result = _s.insertFileRow.run(
    fileData.title ?? null, fileData.artist ?? null, fileData.year ?? null, fileData.album ?? null,
    fileData.filepath, fileData.format ?? null, fileData.track ?? null, fileData.trackOf ?? null, fileData.disk ?? null,
    fileData.modified ?? null, fileData.hash ?? null, fileData.audio_hash ?? null, fileData.aaFile ?? null, fileData.vpath,
    ts, fileData.sID ?? null, fileData.replaygainTrackDb ?? null, fileData.genre ?? null, fileData.cuepoints ?? null,
    fileData.art_source ?? null, fileData.duration ?? null,
    fileData.artist_id ?? _makeArtistId(fileData.artist), fileData.album_id ?? _makeAlbumId(fileData.artist, fileData.album),
    fileData.cover_file ?? null,
    fileData.bitrate ?? null, fileData.sample_rate ?? null, fileData.channels ?? null
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

// Migrate user_metadata and play_events rows from oldHash to newHash.
// Called when a file is re-inserted with a new hash (e.g. external tag editor rewrites
// bytes and mtime changes) so play counts, ratings, stars, and play history survive.
export function migrateHash(oldHash, newHash) {
  if (!oldHash || !newHash || oldHash === newHash) return;
  db.prepare('UPDATE user_metadata SET hash = ? WHERE hash = ?').run(newHash, oldHash);
  db.prepare('UPDATE play_events SET file_hash = ? WHERE file_hash = ?').run(newHash, oldHash);
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

export function removeFilesByPrefix(vpath, prefix) {
  const escaped = prefix.replace(/[%_\\]/g, '\\$&');
  db.prepare("DELETE FROM files WHERE vpath = ? AND filepath LIKE ? ESCAPE '\\'").run(vpath, escaped + '%');
  _s.ftsRebuild.run();
}

export function countFilesByVpath(vpath) {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE vpath = ?').get(vpath);
  return row.cnt;
}

// Batch version: one GROUP BY query instead of one query per vpath.
// Used by /api/v1/db/status to avoid N+1 on users with many vpaths.
export function countFilesByVpaths(vpaths) {
  if (!vpaths || vpaths.length === 0) return 0;
  const vIn = inClause('vpath', vpaths);
  const rows = db.prepare(
    `SELECT vpath, COUNT(*) AS cnt FROM files WHERE ${vIn.sql} GROUP BY vpath`
  ).all(...vIn.params);
  return rows.reduce((sum, r) => sum + r.cnt, 0);
}

export function recordCompletedScan(vpath, scanId, scanStartTs, finishedAtSec) {
  const toSec = (value) => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  };
  _s.insertScanRun.run(scanId || null, vpath, toSec(scanStartTs), toSec(finishedAtSec) || Math.floor(Date.now() / 1000));
}

export function getLastScannedMs() {
  const toEpochMs = (value) => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n >= 1e12 ? Math.floor(n) : Math.floor(n * 1000);
  };

  const row = _s.getLastScanRun.get();
  return toEpochMs(row?.ts);
}

export function getStats() {
  const toEpochMs = (value) => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n >= 1e12 ? Math.floor(n) : Math.floor(n * 1000);
  };

  const totalFiles      = db.prepare('SELECT COUNT(*) AS cnt FROM files').get().cnt;
  const totalArtists    = db.prepare("SELECT COUNT(DISTINCT artist) AS cnt FROM files WHERE artist IS NOT NULL AND artist != ''").get().cnt;
  const totalAlbums     = db.prepare("SELECT COUNT(DISTINCT album) AS cnt FROM files WHERE album IS NOT NULL AND album != ''").get().cnt;
  const totalGenres     = db.prepare("SELECT COUNT(DISTINCT genre) AS cnt FROM files WHERE genre IS NOT NULL AND genre != ''").get().cnt;

  // Collapse 11 scalar aggregate queries into one conditional-aggregate pass.
  const nowSec = Math.floor(Date.now() / 1000);
  const agg = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE aaFile IS NOT NULL AND aaFile != '')                                                 AS withArt,
      COUNT(*) FILTER (WHERE art_source = 'discogs')                                                             AS artFromDiscogs,
      COUNT(*) FILTER (WHERE art_source = 'embedded')                                                            AS artEmbedded,
      COUNT(*) FILTER (WHERE art_source = 'directory')                                                           AS artFromDirectory,
      COUNT(*) FILTER (WHERE replaygainTrackDb IS NOT NULL)                                                      AS withReplaygain,
      COUNT(*) FILTER (WHERE cuepoints IS NOT NULL AND cuepoints != '[]')                                        AS withCue,
      COUNT(*) FILTER (WHERE cuepoints IS NULL)                                                                   AS cueUnchecked,
      MIN(CASE WHEN year >= 1900 AND year <= 2030 THEN year END)                                                 AS oldestYear,
      MAX(CASE WHEN year >= 1900 AND year <= 2030 THEN year END)                                                 AS newestYear,
      SUM(CASE WHEN duration IS NOT NULL THEN duration END)                                                      AS totalDuration,
      COUNT(*) FILTER (WHERE (CASE WHEN ts >= 1000000000000 THEN CAST(ts/1000 AS INT) ELSE ts END) >= ?)        AS last7Days,
      COUNT(*) FILTER (WHERE (CASE WHEN ts >= 1000000000000 THEN CAST(ts/1000 AS INT) ELSE ts END) >= ?)        AS last30Days
    FROM files
  `).get(nowSec - 7 * 86400, nowSec - 30 * 86400);

  const withArt          = agg.withArt;
  const artFromDiscogs   = agg.artFromDiscogs;
  const artEmbedded      = agg.artEmbedded;
  const artFromDirectory = agg.artFromDirectory;
  const withReplaygain   = agg.withReplaygain;
  const withCue          = agg.withCue;
  const cueUnchecked     = agg.cueUnchecked;
  const last7Days        = agg.last7Days;
  const last30Days       = agg.last30Days;
  const totalDurationSec = agg.totalDuration ? Math.round(agg.totalDuration) : 0;

  const newestTsRow = _s.getLastScanRun.get();

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
    artFromDiscogs,
    artEmbedded,
    artFromDirectory,
    withReplaygain,
    withCue,
    cueUnchecked,
    oldestYear:  agg.oldestYear  || null,
    newestYear:  agg.newestYear  || null,
    lastScannedTs: toEpochMs(newestTsRow.ts),
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
  const row = _s.getFileWithMeta.get(username, filepath, vpath);

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
  // MAX(aaFile) ensures we pick a non-null art file when SQLite's indeterminate row
  // selection might otherwise return a NULL-aaFile row from the same group.
  const rows = db.prepare(`
    SELECT album AS name, MAX(year) AS year,
      MAX(aaFile) AS album_art_file,
      MAX(cover_file) AS cover_file,
      rtrim(filepath, replace(filepath, '/', '')) AS dir
    FROM files
    WHERE ${vIn.sql}${ep.sql}${ip.sql} AND ${aIn.sql}
    GROUP BY album, rtrim(filepath, replace(filepath, '/', ''))
    ORDER BY MAX(year) DESC
  `).all(...vIn.params, ...ep.params, ...ip.params, ...aIn.params);
  const albums = [], store = {};
  for (const row of rows) {
    if (row.name === null) {
      const key = 'null\x00' + _normaliseAlbumDir(row.dir);
      if (!store[key]) { albums.push({ name: null, year: null, album_art_file: row.album_art_file || null, dir: row.dir || '', normDir: _normaliseAlbumDir(row.dir) }); store[key] = true; }
    } else {
      const key = row.name + '\x00' + _normaliseAlbumDir(row.dir);
      if (!store[key]) {
        albums.push({ name: row.name, year: row.year, album_art_file: row.album_art_file || null, dir: row.dir || '', normDir: _normaliseAlbumDir(row.dir) });
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
    SELECT album AS name, MAX(year) AS year,
      MAX(aaFile) AS album_art_file,
      MAX(cover_file) AS cover_file,
      rtrim(filepath, replace(filepath, '/', '')) AS dir
    FROM files
    WHERE ${vIn.sql}${ep.sql}${ip.sql} AND artist = ?
    GROUP BY album, rtrim(filepath, replace(filepath, '/', ''))
    ORDER BY MAX(year) DESC
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

export function getFilesForAlbumsBrowse(sources) {
  // sources: array of { vpath, prefix } where prefix may be null (root vpath — include all)
  if (!sources || sources.length === 0) return [];
  const clauses = sources.map(s =>
    s.prefix
      ? `(vpath = ? AND filepath LIKE ?)`
      : `(vpath = ?)`
  );
  const params = [];
  for (const s of sources) {
    params.push(s.vpath);
    if (s.prefix) params.push(s.prefix.replace(/\/$/, '') + '/%');
  }
  return db.prepare(
    `SELECT filepath, title, artist, album, track, disk, year, duration, aaFile, vpath, cuepoints, cover_file
     FROM files WHERE ${clauses.join(' OR ')}`
  ).all(...params);
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

  if (opts.artists && Array.isArray(opts.artists) && opts.artists.length) {
    const aIn = inClause('f.artist', opts.artists.map(String));
    sql += ` AND ${aIn.sql}`;
    params.push(...aIn.params);
  } else if (opts.artist) {
    sql += ' AND f.artist = ?';
    params.push(opts.artist);
  }

  if (opts.year) {
    sql += ' AND f.year = ?';
    params.push(Number(opts.year));
  }

  // Directory-based filter: when albumDir is provided, restrict to that folder.
  // This is critical for albums whose album tag is generic (e.g. "Catalogue") —
  // the dir uniquely identifies the physical release folder in the library.
  // normDir is the normalised dir (disc sub-folders collapsed) so multi-disc
  // albums like "Album/CD 1" and "Album/CD 2" both fall under "Album".
  if (opts.albumDir) {
    const dirPrefix = opts.albumDir.replace(/\/$/, '') + '/';
    sql += ' AND f.filepath LIKE ?';
    params.push(dirPrefix + '%');
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
  // Wrap in double-quotes to form a phrase/literal query.
  // This prevents FTS5 syntax errors on names containing . ( ) * - etc.
  // Any literal " inside the input is escaped by doubling (FTS5 convention).
  const cleaned = String(raw).replace(/\s+/g, ' ').trim();
  if (cleaned.length < 3) return ''; // trigram needs at least 3 chars
  return '"' + cleaned.replace(/"/g, '""') + '"';
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
  if (!q) return []; // trigram needs at least 3 chars

  const vIn = inClause('f.vpath', filtered);
  const sql = `SELECT f.id, f.vpath, f.dirpath, f.folder_name
    FROM folders f
    JOIN fts_folders ft ON f.id = ft.rowid
    WHERE ${vIn.sql}
    AND fts_folders MATCH ?
    ORDER BY rank`;
  const rows = _prepare(sql).all(...vIn.params, q);
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
  if (!q) return [];

  // Compute the set of vpaths the user is allowed to see
  let filteredVpaths = null;
  if (Array.isArray(vpaths) && vpaths.length > 0) {
    filteredVpaths = vpathFilter(vpaths, ignoreVPaths);
    if (filteredVpaths.length === 0) return [];
  }

  // Uses cached prepared statement — static SQL, no dynamic parts.
  const rows = _s.searchArtists.all(q);

  return rows
    .filter(r => {
      if (!filteredVpaths) return true;
      try {
        const artistVpaths = JSON.parse(r.vpaths_json || '[]');
        return artistVpaths.some(v => filteredVpaths.includes(v));
      } catch { return true; }
    })
    .map(r => ({
      name:     r.artist_clean,
      variants: (() => { try { return JSON.parse(r.artist_raw_variants); } catch { return [r.artist_clean]; } })(),
    }));
}

// ── Artist browse / profile ───────────────────────────────────────────────

// Returns artists starting with a given letter (or '0' for all digit-starting names).
// Uses precomputed song_count — no join with files needed.
export function getArtistsByLetter(letter) {
  let rows;
  if (letter === '0') {
    // Digits: artist_clean starts with 0-9
    rows = db.prepare(
      "SELECT * FROM artists_normalized WHERE artist_clean != '' AND artist_clean GLOB '[0-9]*' ORDER BY artist_clean COLLATE NOCASE"
    ).all();
  } else {
    const l = letter.toUpperCase();
    rows = db.prepare(
      "SELECT * FROM artists_normalized WHERE artist_clean != '' AND upper(substr(artist_clean,1,1)) = ? ORDER BY artist_clean COLLATE NOCASE"
    ).all(l);
  }
  return rows.map(r => ({
    artistKey:    r.artist_clean.toLowerCase(),
    canonicalName: r.artist_clean,
    imageFile:    r.image_file || null,
    hasBio:       !!r.bio,
    songCount:    r.song_count || 0,
    rawVariants:  (() => { try { return JSON.parse(r.artist_raw_variants); } catch { return [r.artist_clean]; } })(),
  }));
}

// Returns home-page artist stats:
//   topArtists  — top 20 by song_count
//   recentArtists — up to 10 most recently played (from play_events + files join)
//   totalCount  — total number of distinct artists
export function getArtistHomeStats() {
  const totalRow = db.prepare("SELECT COUNT(*) AS c FROM artists_normalized WHERE artist_clean != ''").get();
  const totalCount = totalRow ? totalRow.c : 0;

  const topRows = db.prepare(
    "SELECT artist_clean, image_file, bio, song_count, artist_raw_variants FROM artists_normalized WHERE artist_clean != '' ORDER BY song_count DESC LIMIT 20"
  ).all();

  const topArtists = topRows.map(r => ({
    artistKey:    r.artist_clean.toLowerCase(),
    canonicalName: r.artist_clean,
    imageFile:    r.image_file || null,
    hasBio:       !!r.bio,
    songCount:    r.song_count || 0,
    rawVariants:  (() => { try { return JSON.parse(r.artist_raw_variants); } catch { return [r.artist_clean]; } })(),
  }));

  // Most played: aggregate play_events by raw file artist first, then map to canonical groups.
  const playedRawRows = db.prepare(`
    SELECT f.artist AS raw_artist, COUNT(*) AS plays
    FROM play_events pe
    JOIN files f ON f.hash = pe.file_hash
    WHERE f.artist IS NOT NULL AND f.artist != ''
    GROUP BY f.artist
    ORDER BY plays DESC
    LIMIT 500
  `).all();

  // Recent: join last N play_events with files to get the artist, deduplicated
  const recentRows = db.prepare(`
    SELECT DISTINCT f.artist
    FROM play_events pe
    JOIN files f ON f.hash = pe.file_hash
    WHERE f.artist IS NOT NULL AND f.artist != ''
    ORDER BY pe.started_at DESC
    LIMIT 50
  `).all();

  // Resolve ALL raw artist names in ONE CTE query instead of N individual lookups.
  // Collect unique raw artist values needed across both played and recent lists.
  const allRawArtists = [...new Set([
    ...playedRawRows.map(r => r.raw_artist),
    ...recentRows.map(r => r.artist),
  ])];

  // variantMap: rawArtist -> { artist_clean, image_file, bio, song_count, artist_raw_variants }
  const variantMap = new Map();
  if (allRawArtists.length > 0) {
    // SQLite default max params = 999; cap to stay safe
    const safeList = allRawArtists.slice(0, 900);
    const placeholders = safeList.map(() => '?').join(',');
    const cteRows = db.prepare(`
      WITH expanded AS (
        SELECT an.artist_clean, an.image_file, an.bio, an.song_count, an.artist_raw_variants,
               je.value AS raw_variant
        FROM artists_normalized an, json_each(an.artist_raw_variants) AS je
        WHERE an.artist_clean != ''
      )
      SELECT raw_variant, artist_clean, image_file, bio, song_count, artist_raw_variants
      FROM expanded
      WHERE raw_variant IN (${placeholders})
    `).all(...safeList);
    for (const row of cteRows) {
      variantMap.set(row.raw_variant, row);
    }
  }

  const playByCanonical = new Map();
  for (const row of playedRawRows) {
    const anRow = variantMap.get(row.raw_artist);
    if (!anRow) continue;
    const key = anRow.artist_clean.toLowerCase();
    const prev = playByCanonical.get(key);
    if (prev) {
      prev.playCount += Number(row.plays || 0);
      continue;
    }
    playByCanonical.set(key, {
      artistKey: key,
      canonicalName: anRow.artist_clean,
      imageFile: anRow.image_file || null,
      hasBio: !!anRow.bio,
      songCount: anRow.song_count || 0,
      playCount: Number(row.plays || 0),
      rawVariants: (() => { try { return JSON.parse(anRow.artist_raw_variants); } catch { return [anRow.artist_clean]; } })(),
    });
  }

  const mostPlayedArtists = Array.from(playByCanonical.values())
    .sort((a, b) => (b.playCount - a.playCount) || a.canonicalName.localeCompare(b.canonicalName))
    .slice(0, 20);

  // Map each raw artist to its canonical group
  const recentArtists = [];
  const seen = new Set();
  for (const row of recentRows) {
    const anRow = variantMap.get(row.artist);
    if (!anRow) continue;
    const key = anRow.artist_clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recentArtists.push({
      artistKey:    key,
      canonicalName: anRow.artist_clean,
      imageFile:    anRow.image_file || null,
      hasBio:       !!anRow.bio,
      songCount:    anRow.song_count || 0,
      rawVariants:  (() => { try { return JSON.parse(anRow.artist_raw_variants); } catch { return [anRow.artist_clean]; } })(),
    });
    if (recentArtists.length >= 10) break;
  }

  return { totalCount, topArtists, recentArtists, mostPlayedArtists };
}

// Returns all artists for the Artist Library grid, sorted by display name.
// Uses precomputed song_count (no expensive join with files).
export function getArtistsForBrowse(vpaths, ignoreVPaths) {
  // Legacy function — kept for any future bulk use.
  // For the home page, use getArtistHomeStats(). For letter browse, use getArtistsByLetter().
  const rows = db.prepare(
    'SELECT * FROM artists_normalized ORDER BY artist_clean COLLATE NOCASE'
  ).all();
  return rows.map(r => ({
    artistKey:    r.artist_clean.toLowerCase(),
    canonicalName: r.artist_clean,
    imageFile:    r.image_file || null,
    hasBio:       !!r.bio,
    songCount:    r.song_count || 0,
  }));
}

// Returns the full profile row for one artist by its artist_clean (case-insensitive).
// Returns null if not found.
export function getArtistRow(artistClean) {
  const row = db.prepare(
    "SELECT * FROM artists_normalized WHERE lower(artist_clean) = lower(?)"
  ).get(artistClean);
  if (!row) return null;
  return {
    artistKey:    row.artist_clean.toLowerCase(),
    canonicalName: row.artist_clean,
    bio:          row.bio || null,
    imageFile:    row.image_file || null,
    imageSource:  row.image_source || null,
    lastFetched:  row.last_fetched || null,
    nameOverride: row.name_override || 0,
    songCount:    row.song_count || 0,
    rawVariants:  (() => { try { return JSON.parse(row.artist_raw_variants); } catch { return [row.artist_clean]; } })(),
  };
}

/**
 * Find an artist row by either canonical name OR any raw variant tag value.
 * Used by the Playing Now image endpoint to resolve song artist tags that may
 * not match the canonical name exactly (e.g. featuring variants).
 */
export function getArtistRowByName(name) {
  if (!name) return null;
  // 1. Exact canonical match (fast — indexed)
  const direct = getArtistRow(name);
  if (direct) return direct;
  // 2. Search inside raw_variants JSON array for an exact match
  const row = db.prepare(
    `SELECT * FROM artists_normalized
     WHERE EXISTS (SELECT 1 FROM json_each(artist_raw_variants) WHERE value = ?)
     LIMIT 1`
  ).get(name);
  if (!row) return null;
  return {
    artistKey:    row.artist_clean.toLowerCase(),
    canonicalName: row.artist_clean,
    bio:          row.bio || null,
    imageFile:    row.image_file || null,
    imageSource:  row.image_source || null,
    lastFetched:  row.last_fetched || null,
    nameOverride: row.name_override || 0,
    songCount:    row.song_count || 0,
    rawVariants:  (() => { try { return JSON.parse(row.artist_raw_variants); } catch { return [row.artist_clean]; } })(),
  };
}

/**
 * Normalize an artist name for fuzzy matching.
 * Lowercases, converts ' & ' and '&' → ' and ', collapses spaces, trims.
 * Used to match Last.fm artist names (which may use 'and') against library
 * artist names (which may use '&') and vice versa.
 */
function _normArtist(name) {
  return name.toLowerCase()
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Given a list of artist names from an external source (e.g. Last.fm similar-artists),
 * resolve each against the library's artists_normalized table using fuzzy normalization.
 * Returns an array of raw artist tag values (as stored in files.artist) for all matched
 * library artists — suitable for use in an IN(...) filter on the files table.
 *
 * Matching strategy (in order):
 *   1. Exact case-insensitive match on artist_clean
 *   2. Normalized match: '&' ↔ 'and', whitespace collapsed (both sides normalized)
 *
 * Artists not found in the library are silently dropped so the caller gets only
 * names that will actually match rows in the files table.
 */
export function resolveArtistNamesForDJ(names) {
  if (!names || names.length === 0) return [];
  // Exact case-insensitive match on canonical artist name
  const exactStmt = db.prepare(
    `SELECT artist_raw_variants FROM artists_normalized WHERE lower(artist_clean) = lower(?)`
  );
  // Normalized match — normalize '&' variants and whitespace in both SQL and param
  // SQL: lower → replace ' & '→' and ' → replace '&'→' and ' → collapse '  '→' '
  const normStmt = db.prepare(
    `SELECT artist_raw_variants FROM artists_normalized
     WHERE replace(replace(replace(lower(trim(artist_clean)), ' & ', ' and '), '&', ' and '), '  ', ' ') = ?`
  );
  const result = new Set();
  for (const name of names) {
    if (!name || typeof name !== 'string') continue;
    let row = exactStmt.get(name.trim());
    if (!row) row = normStmt.get(_normArtist(name));
    if (!row) continue;
    try {
      const variants = JSON.parse(row.artist_raw_variants);
      for (const v of variants) result.add(v);
    } catch (_) {}
  }
  return [...result];
}

// Returns all file rows for an artist (by raw variant list) with their filepaths.
// Includes all columns needed to build release groups.
export function getArtistFiles(rawVariants, vpaths, ignoreVPaths) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0 || rawVariants.length === 0) return [];

  const vIn = inClause('vpath', filtered);
  const aIn = inClause('artist', rawVariants);
  return db.prepare(`
    SELECT filepath, vpath, title, artist, album, track, trackOf, disk, year,
           duration, aaFile, cover_file, genre, cuepoints
    FROM files
    WHERE ${vIn.sql} AND ${aIn.sql}
    ORDER BY filepath
  `).all(...vIn.params, ...aIn.params);
}

// Saves bio + image info fetched from an external service.
// Never overwrites name_override.
export function saveArtistInfo(artistClean, { bio, imageFile, imageSource }) {
  db.prepare(`
    UPDATE artists_normalized
    SET bio = ?, image_file = ?, image_source = ?, last_fetched = ?, image_flag_wrong = CASE WHEN ? IS NOT NULL THEN 0 ELSE image_flag_wrong END
    WHERE lower(artist_clean) = lower(?)
  `).run(bio || null, imageFile || null, imageSource || null, Date.now(), imageFile || null, artistClean);
}

// Admin: override the canonical display name for an artist.
export function setArtistNameOverride(artistClean, newName) {
  db.prepare(`
    UPDATE artists_normalized
    SET artist_clean = ?, name_override = 1
    WHERE lower(artist_clean) = lower(?)
  `).run(newName, artistClean);
}

// Admin: set a custom artist image (downloaded externally and stored in image-cache/artists/).
export function setArtistImage(artistClean, imageFile, imageSource) {
  db.prepare(`
    UPDATE artists_normalized
    SET image_file = ?, image_source = ?, last_fetched = ?, image_flag_wrong = 0
    WHERE lower(artist_clean) = lower(?)
  `).run(imageFile, imageSource || 'custom', Date.now(), artistClean);
}

export function setArtistImageWrongFlag(artistClean, isWrong) {
  db.prepare(`
    UPDATE artists_normalized
    SET image_flag_wrong = ?, last_fetched = CASE WHEN ? = 1 THEN NULL ELSE last_fetched END
    WHERE lower(artist_clean) = lower(?)
  `).run(isWrong ? 1 : 0, isWrong ? 1 : 0, artistClean);
}

export function markArtistFetchAttempt(artistClean) {
  db.prepare(`
    UPDATE artists_normalized
    SET last_fetched = ?
    WHERE lower(artist_clean) = lower(?)
  `).run(Date.now(), artistClean);
}

export function getArtistImageAudit(kind, limit = 200) {
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  let where = "artist_clean != ''";
  if (kind === 'missing') {
    where += " AND (image_file IS NULL OR image_file = '') AND last_fetched IS NULL";
  } else if (kind === 'no-image') {
    where += " AND (image_file IS NULL OR image_file = '') AND last_fetched IS NOT NULL";
  } else if (kind === 'wrong') {
    where += ' AND image_flag_wrong = 1';
  } else if (kind === 'with-image') {
    where += " AND image_file IS NOT NULL AND image_file != ''";
  }
  const rows = db.prepare(`
    SELECT artist_clean, image_file, image_source, song_count, image_flag_wrong, last_fetched
    FROM artists_normalized
    WHERE ${where}
    ORDER BY song_count DESC, artist_clean COLLATE NOCASE
    LIMIT ?
  `).all(n);
  return rows.map(r => ({
    artistKey: String(r.artist_clean || '').toLowerCase(),
    canonicalName: r.artist_clean,
    imageFile: r.image_file || null,
    imageSource: r.image_source || null,
    songCount: r.song_count || 0,
    wrongFlag: !!r.image_flag_wrong,
    lastFetched: r.last_fetched || null,
  }));
}

export function getArtistImageAuditCounts() {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN (image_file IS NULL OR image_file = '') AND last_fetched IS NULL THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN (image_file IS NULL OR image_file = '') AND last_fetched IS NOT NULL THEN 1 ELSE 0 END) AS no_image,
      SUM(CASE WHEN image_flag_wrong = 1 THEN 1 ELSE 0 END) AS wrong,
      SUM(CASE WHEN image_file IS NOT NULL AND image_file != '' THEN 1 ELSE 0 END) AS withImage
    FROM artists_normalized
    WHERE artist_clean != ''
  `).get() || { missing: 0, no_image: 0, wrong: 0, withImage: 0 };
  return {
    missing: Number(row.missing || 0),
    noImage: Number(row.no_image || 0),
    wrong: Number(row.wrong || 0),
    withImage: Number(row.withImage || 0),
  };
}

// Returns artist_clean values where last_fetched IS NULL (never fetched) — used
// by the auto-fetch queue after a scan completes.
export function getArtistsNeedingFetch() {
  return db.prepare(
    "SELECT artist_clean FROM artists_normalized WHERE last_fetched IS NULL ORDER BY artist_clean COLLATE NOCASE"
  ).all().map(r => r.artist_clean);
}

export function getArtistsForTadbRetry(limit = 500) {
  // Returns no-image artists (tried before but got no image) ordered by song count desc.
  // These will be retried via TheAudioDB only — Discogs was already tried.
  return db.prepare(
    `SELECT artist_clean FROM artists_normalized
     WHERE image_file IS NULL AND last_fetched IS NOT NULL
     ORDER BY song_count DESC NULLS LAST, artist_clean COLLATE NOCASE
     LIMIT ?`
  ).all(Math.max(1, Math.min(2000, Number(limit) || 500))).map(r => r.artist_clean);
}

export function searchFiles(searchCol, searchTerm, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes, negativeTerms = []) {
  const validCols = ['title', 'artist', 'album', 'filepath'];
  if (!validCols.includes(searchCol)) { return []; }

  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }

  const vIn = inClause('vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes);

  // Build FTS5 MATCH query: column-filtered prefix match + optional NOT exclusions
  const notClause = negativeTerms.map(t => ` NOT "${escapeFts(t)}"`).join('');
  const ftsQuery = `{${searchCol}} : "${escapeFts(searchTerm)}"*${notClause}`;

  const params = [...vIn.params, ...ep.params, ftsQuery];
  // fts_files is the outer (driving) table so SQLite uses the FTS5 index scan.
  // ORDER BY rank for relevance ordering. No LIMIT — the full result set is
  // returned so the client can show accurate counts per category.
  let sql = `SELECT f.rowid AS id, f.* FROM fts_files ft
    JOIN files f ON f.rowid = ft.rowid
    WHERE ${vIn.sql.replace(/\bvpath\b/g, 'f.vpath')}${ep.sql.replace(/\bvpath\b/g, 'f.vpath').replace(/\bfilepath\b/g, 'f.filepath')}
    AND ft.fts_files MATCH ?`;
  if (filepathPrefix && typeof filepathPrefix === 'string') {
    sql += " AND f.filepath LIKE ? ESCAPE '\\'";
    params.push(filepathPrefix.replace(/[%_\\]/g, '\\$&') + '%');
  }
  sql += ' ORDER BY rank';
  const rows = _prepare(sql).all(...params);
  return rows.map(mapFileRow);
}

// Artist→Album search: find unique albums whose ARTIST column matches the query.
// Unlike searchFiles('artist',...) which fetches 50 rows and deduplicates in JS
// (giving only the albums with the most tracks), this query groups at the SQL
// level so LIMIT 50 counts unique albums. This way "Cerrone" returns 50 Cerrone
// albums instead of the same 3-5 albums that happen to have the most tracks.
export function searchAlbumsByArtist(searchTerm, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes, negativeTerms = []) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }

  const vIn = inClause('vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes);

  const notClause = negativeTerms.map(t => ` NOT "${escapeFts(t)}"`).join('');
  const ftsQuery = `{artist} : "${escapeFts(searchTerm)}"*${notClause}`;

  const params = [...vIn.params, ...ep.params, ftsQuery];
  // GROUP BY album at SQL level: LIMIT 50 counts distinct albums, not rows.
  // MAX(aaFile) / MAX(cover_file) picks a non-null art file from the group.
  let sql = `SELECT f.album, MAX(f.aaFile) AS aaFile, MAX(f.cover_file) AS cover_file
    FROM fts_files ft
    JOIN files f ON f.rowid = ft.rowid
    WHERE ${vIn.sql.replace(/\bvpath\b/g, 'f.vpath')}${ep.sql.replace(/\bvpath\b/g, 'f.vpath').replace(/\bfilepath\b/g, 'f.filepath')}
    AND ft.fts_files MATCH ?`;
  if (filepathPrefix && typeof filepathPrefix === 'string') {
    sql += " AND f.filepath LIKE ? ESCAPE '\\'";
    params.push(filepathPrefix.replace(/[%_\\]/g, '\\$&') + '%');
  }
  sql += ' GROUP BY f.album';
  return _prepare(sql).all(...params);
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
  // Same optimizations as searchFiles: FTS as outer table, ORDER BY rank. No LIMIT.
  let sql = `SELECT f.rowid AS id, f.* FROM fts_files ft
    JOIN files f ON f.rowid = ft.rowid
    WHERE ${vIn.sql.replace(/\bvpath\b/g, 'f.vpath')}${ep.sql.replace(/\bvpath\b/g, 'f.vpath').replace(/\bfilepath\b/g, 'f.filepath')}
    AND ft.fts_files MATCH ?`;
  if (filepathPrefix && typeof filepathPrefix === 'string') {
    sql += " AND f.filepath LIKE ? ESCAPE '\\'";
    params.push(filepathPrefix.replace(/[%_\\]/g, '\\$&') + '%');
  }
  sql += ' ORDER BY rank';
  const rows = _prepare(sql).all(...params);
  return rows.map(mapFileRow);
}

// Paginated "list all songs" — used by Subsonic search3 with empty query.
// OpenSubsonic spec: "A blank query will return everything."
export function listAllSongs(vpaths, ignoreVPaths, excludeFilepathPrefixes, filepathPrefix, offset, limit) {
  const filtered = vpathFilter(vpaths, ignoreVPaths);
  if (filtered.length === 0) { return []; }
  const vIn = inClause('vpath', filtered);
  const ep = excludePrefixClauses(excludeFilepathPrefixes);
  const params = [...vIn.params, ...ep.params];
  let sql = `SELECT rowid AS id, * FROM files WHERE ${vIn.sql}${ep.sql}`;
  if (filepathPrefix && typeof filepathPrefix === 'string') {
    sql += " AND filepath LIKE ? ESCAPE '\\'";
    params.push(filepathPrefix.replace(/[%_\\]/g, '\\$&') + '%');
  }
  // NULLs/whitespace-only last so properly tagged songs are returned first in paginated sync
  // Use REPLACE to strip all whitespace types (tabs, newlines) before TRIM check
  const wsNull = c => `CASE WHEN TRIM(REPLACE(REPLACE(REPLACE(COALESCE(${c},''),CHAR(9),' '),CHAR(10),' '),CHAR(13),' '))='' THEN 1 ELSE 0 END`;
  sql += ` ORDER BY ${wsNull('artist')}, artist COLLATE NOCASE,` +
         ` ${wsNull('album')}, album COLLATE NOCASE, track LIMIT ? OFFSET ?`;
  params.push(limit, offset);
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
  // Normalize both sides: lowercase + strip dots so "M.C. Sar" == "MC Sar".
  if (opts.ignoreArtists && Array.isArray(opts.ignoreArtists) && opts.ignoreArtists.length > 0) {
    const placeholders = opts.ignoreArtists.map(() => '?').join(',');
    sql += ` AND (f.artist IS NULL OR REPLACE(LOWER(f.artist), '.', '') NOT IN (${placeholders}))`;
    params.push(...opts.ignoreArtists.map(a => String(a).toLowerCase().replace(/\./g, '')));
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
  // Normalize both sides: lowercase + strip dots so "M.C. Sar" == "MC Sar".
  if (opts.ignoreArtists && Array.isArray(opts.ignoreArtists) && opts.ignoreArtists.length > 0) {
    const placeholders = opts.ignoreArtists.map(() => '?').join(',');
    sql += ` AND (f.artist IS NULL OR REPLACE(LOWER(f.artist), '.', '') NOT IN (${placeholders}))`;
    params.push(...opts.ignoreArtists.map(a => String(a).toLowerCase().replace(/\./g, '')));
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
  // Split the stored full-path (vpath + '/' + filepath) into its two parts so
  // SQLite can use the existing (filepath, vpath) composite index instead of
  // doing a full-table concat scan on 130 k+ rows (was 7 s, now <5 ms).
  return db.prepare(`
    SELECT p.name,
           COUNT(f.rowid) AS songCount,
           CAST(COALESCE(SUM(f.duration), 0) AS INTEGER) AS totalDuration
    FROM playlists p
    LEFT JOIN playlists e ON e.user = p.user AND e.name = p.name AND e.filepath IS NOT NULL
    LEFT JOIN files f
      ON f.vpath   = SUBSTR(e.filepath, 1, INSTR(e.filepath, '/') - 1)
     AND f.filepath = SUBSTR(e.filepath, INSTR(e.filepath, '/') + 1)
    WHERE p.user = ? AND p.filepath IS NULL
    GROUP BY p.name
  `).all(username);
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
           MAX(year) AS year, MAX(aaFile) AS aaFile, COUNT(*) AS songCount,
           CAST(SUM(duration) AS INTEGER) AS totalDuration
    FROM files
    WHERE artist_id = ? AND ${vIn.sql}${pf.sql}
    GROUP BY album_id
    ORDER BY year DESC, album COLLATE NOCASE
  `).all(artistId, ...vIn.params, ...pf.params);
  return rows;
}

export function getAlbumStatsByIds(albumIds) {
  if (!albumIds || albumIds.length === 0) return {};
  const placeholders = albumIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT album_id, COUNT(*) AS songCount,
           CAST(SUM(duration) AS INTEGER) AS totalDuration
    FROM files
    WHERE album_id IN (${placeholders})
    GROUP BY album_id
  `).all(...albumIds);
  const map = {};
  for (const r of rows) map[r.album_id] = r;
  return map;
}

export function getAllAlbumIds(vpaths, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix);
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes);
  const limit  = opts.limit  != null ? opts.limit  : -1;  // -1 = no limit in SQLite
  const offset = opts.offset != null ? opts.offset :  0;
  const rows = db.prepare(`
    SELECT DISTINCT album_id, artist_id, album, artist,
           MAX(year) AS year, MAX(aaFile) AS aaFile, COUNT(*) AS songCount,
           CAST(SUM(duration) AS INTEGER) AS totalDuration, MAX(ts) AS ts
    FROM files
    WHERE ${vIn.sql}${pf.sql}${ep.sql} AND album IS NOT NULL AND TRIM(REPLACE(REPLACE(REPLACE(album, CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' ')) != ''
    GROUP BY album_id
    ORDER BY album COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...vIn.params, ...pf.params, ...ep.params, limit, offset);
  return rows;
}

export function getAllArtistIds(vpaths, opts = {}) {
  const filtered = vpathFilter(vpaths, null);
  if (filtered.length === 0) return [];
  const vIn = inClause('vpath', filtered);
  const pf = prefixClause(opts.filepathPrefix);
  const ep = excludePrefixClauses(opts.excludeFilepathPrefixes);
  const limit  = opts.limit  != null ? opts.limit  : -1;
  const offset = opts.offset != null ? opts.offset :  0;
  const rows = db.prepare(`
    SELECT DISTINCT artist_id, artist, MAX(aaFile) AS aaFile,
           COUNT(DISTINCT album_id) AS albumCount
    FROM files
    WHERE ${vIn.sql}${pf.sql}${ep.sql} AND artist IS NOT NULL AND TRIM(REPLACE(REPLACE(REPLACE(artist, CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' ')) != ''
    GROUP BY artist_id
    ORDER BY artist COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...vIn.params, ...pf.params, ...ep.params, limit, offset);
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

// ── Wrapped / Play Events ─────────────────────────────────────────────────

export function insertPlayEvent({ user_id, file_hash, started_at, duration_ms, source, session_id }) {
  const result = db.prepare(
    'INSERT INTO play_events (user_id, file_hash, started_at, duration_ms, source, session_id) VALUES (?,?,?,?,?,?)'
  ).run(user_id, file_hash, started_at, duration_ms ?? null, source ?? null, session_id ?? null);
  return Number(result.lastInsertRowid);
}

export function getPlayEventById(id, userId) {
  return db.prepare('SELECT id, user_id, duration_ms FROM play_events WHERE id=? AND user_id=?').get(id, userId) ?? null;
}

export function hasPlayEventBefore(userId, fileHash, beforeMs) {
  const row = db.prepare('SELECT 1 AS found FROM play_events WHERE user_id=? AND file_hash=? AND started_at < ? LIMIT 1').get(userId, fileHash, beforeMs);
  return !!row;
}

export function updatePlayEvent(id, userId, { ended_at, played_ms, completed, skipped }) {
  db.prepare(
    'UPDATE play_events SET ended_at=?, played_ms=?, completed=?, skipped=? WHERE id=? AND user_id=?'
  ).run(ended_at ?? Date.now(), played_ms ?? null, completed ? 1 : 0, skipped ? 1 : 0, id, userId);
}

export function incrementPauseCount(id, userId) {
  db.prepare('UPDATE play_events SET pause_count = pause_count + 1 WHERE id = ? AND user_id = ?').run(id, userId);
}

export function upsertListeningSession({ session_id, user_id, started_at }) {
  db.prepare(
    `INSERT INTO listening_sessions (session_id, user_id, started_at, total_tracks)
     VALUES (?,?,?,1)
     ON CONFLICT(session_id) DO UPDATE SET total_tracks = total_tracks + 1`
  ).run(session_id, user_id, started_at);
}

export function updateListeningSession(sessionId, userId, { ended_at }) {
  db.prepare(
    'UPDATE listening_sessions SET ended_at=? WHERE session_id=? AND user_id=?'
  ).run(ended_at ?? Date.now(), sessionId, userId);
}

export function getWrappedPeriods(userId) {
  // Returns distinct year-month buckets that have play_events for this user
  // (most recent first, max 36 months back)
  return db.prepare(`
    SELECT
      strftime('%Y', datetime(started_at/1000,'unixepoch','localtime')) AS year,
      strftime('%m', datetime(started_at/1000,'unixepoch','localtime')) AS month,
      COUNT(*) AS play_count
    FROM play_events
    WHERE user_id = ?
    GROUP BY year, month
    ORDER BY year DESC, month DESC
    LIMIT 36
  `).all(userId);
}

export function getWrappedDataInRange(userId, fromMs, toMs) {
  // Returns all play_events in range joined to file metadata
  // Used by wrapped-stats.mjs for aggregation
  return db.prepare(`
    SELECT
      pe.id, pe.file_hash, pe.started_at, pe.ended_at,
      pe.duration_ms, pe.played_ms, pe.completed, pe.skipped,
      pe.source, pe.session_id, pe.pause_count,
      f.title, f.artist, f.album, f.year, f.genre,
      f.aaFile, f.artist_id, f.album_id, f.filepath
    FROM play_events pe
    LEFT JOIN (SELECT hash, title, artist, album, year, genre, aaFile, artist_id, album_id, filepath FROM files GROUP BY hash) f ON f.hash = pe.file_hash
    WHERE pe.user_id = ? AND pe.started_at >= ? AND pe.started_at < ?
    ORDER BY pe.started_at ASC
  `).all(userId, fromMs, toMs);
}

export function getWrappedSessionsInRange(userId, fromMs, toMs) {
  return db.prepare(`
    SELECT session_id, started_at, ended_at, total_tracks
    FROM listening_sessions
    WHERE user_id = ? AND started_at >= ? AND started_at < ?
    ORDER BY started_at ASC
  `).all(userId, fromMs, toMs);
}

export function getTotalFileCount(vpaths) {
  if (!vpaths || vpaths.length === 0) return 0;
  const placeholders = vpaths.map(() => '?').join(',');
  return db.prepare(`SELECT COUNT(*) AS cnt FROM files WHERE vpath IN (${placeholders})`).get(...vpaths).cnt;
}

export function getWrappedAdminStats() {
  const total = db.prepare('SELECT COUNT(*) AS cnt FROM play_events').get().cnt;
  const totalRadio = db.prepare('SELECT COUNT(*) AS cnt FROM radio_play_events').get().cnt;
  const totalPodcast = db.prepare('SELECT COUNT(*) AS cnt FROM podcast_play_events').get().cnt;
  // Storage estimate via dbstat virtual table (available in SQLite 3.31+)
  let storageBytes = 0;
  try {
    const row = db.prepare("SELECT SUM(payload) AS sz FROM dbstat WHERE name IN ('play_events','listening_sessions','radio_play_events','podcast_play_events')").get();
    storageBytes = row?.sz ?? 0;
  } catch (_e) {}
  const perUser = db.prepare(`
    SELECT
      COALESCE(pe.user_id, re.user_id, pod.user_id) AS user_id,
      COALESCE(pe.event_count, 0)         AS event_count,
      COALESCE(pe.total_played_ms, 0)     AS total_played_ms,
      COALESCE(re.radio_sessions, 0)      AS radio_sessions,
      COALESCE(re.total_radio_ms, 0)      AS total_radio_ms,
      COALESCE(pod.podcast_episodes, 0)   AS podcast_episodes,
      COALESCE(pod.total_podcast_ms, 0)   AS total_podcast_ms
    FROM
      (SELECT user_id, COUNT(*) AS event_count, SUM(COALESCE(played_ms,0)) AS total_played_ms
       FROM play_events GROUP BY user_id) pe
    FULL OUTER JOIN
      (SELECT user_id, COUNT(*) AS radio_sessions, SUM(COALESCE(listened_ms,0)) AS total_radio_ms
       FROM radio_play_events GROUP BY user_id) re ON pe.user_id = re.user_id
    FULL OUTER JOIN
      (SELECT user_id, COUNT(*) AS podcast_episodes, SUM(COALESCE(played_ms,0)) AS total_podcast_ms
       FROM podcast_play_events GROUP BY user_id) pod ON COALESCE(pe.user_id, re.user_id) = pod.user_id
    ORDER BY event_count DESC
  `).all();
  return { total_events: total, total_radio: totalRadio, total_podcast: totalPodcast, storage_bytes: storageBytes, per_user: perUser };
}

export function purgePlayEvents(userId, fromMs, toMs) {
  // Delete events for a specific user within the [fromMs, toMs] time window (inclusive)
  const evRes = db.prepare('DELETE FROM play_events WHERE user_id = ? AND started_at >= ? AND started_at <= ?').run(userId, fromMs, toMs);
  // Prune sessions that have no remaining events
  db.prepare(`
    DELETE FROM listening_sessions
    WHERE user_id = ? AND session_id NOT IN (
      SELECT DISTINCT session_id FROM play_events WHERE session_id IS NOT NULL
    )
  `).run(userId);
  // Also purge radio and podcast events for the same user/period
  db.prepare('DELETE FROM radio_play_events WHERE user_id = ? AND started_at >= ? AND started_at <= ?').run(userId, fromMs, toMs);
  db.prepare('DELETE FROM podcast_play_events WHERE user_id = ? AND started_at >= ? AND started_at <= ?').run(userId, fromMs, toMs);
  return evRes.changes;
}

/**
 * Backfill artist / album / title for files whose tags are null.
 * Derives values from the folder name pattern "Artist - Release info".
 * Returns the number of rows updated.
 */
export function backfillFolderMetadata() {
  function _deriveArtist(filepath) {
    const parts = filepath.split('/');
    const folder = parts.length >= 2 ? parts[parts.length - 2] : null;
    if (!folder) return null;
    const m = folder.match(/^(.+?)\s+[-\u2013]\s+/);
    return m ? m[1].trim() : null;
  }
  function _deriveAlbum(filepath) {
    const parts = filepath.split('/');
    const folder = parts.length >= 2 ? parts[parts.length - 2] : null;
    if (!folder) return folder;
    // Strip trailing catalogue number / format tag
    return folder.replace(/\s*[-\u2013]\s*(SP\d[\d-]*|[A-Z]{2,}-\d[\w-]*|-cd-|-\d+)[^/]*$/i, '').trim();
  }
  function _deriveTitle(filepath) {
    const base = filepath.split('/').pop().replace(/\.[^.]+$/, '');
    return base.replace(/^[\d\s._-]+/, '').trim() || base;
  }

  const rows = db.prepare(
    "SELECT rowid, filepath, artist, album, title FROM files WHERE (artist IS NULL OR artist = '') AND filepath IS NOT NULL"
  ).all();

  const _md5 = s => createHash('md5').update((s || '').toLowerCase().trim()).digest('hex');

  const upd = db.prepare(
    'UPDATE files SET artist=?, album=?, title=?, artist_id=?, album_id=? WHERE rowid=?'
  );

  let updated = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const artist = _deriveArtist(row.filepath);
      if (!artist) continue; // can't derive — skip
      const album  = row.album  || _deriveAlbum(row.filepath);
      const title  = row.title  || _deriveTitle(row.filepath);
      const aid = _md5(artist).slice(0, 16);
      const alid = _md5(`${artist}|||${album || ''}`).slice(0, 16);
      upd.run(artist, album, title, aid, alid, row.rowid);
      updated++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return updated;
}

// ── Radio Play Events ─────────────────────────────────────────────────────────

export function insertRadioPlayEvent({ user_id, station_id, station_name, started_at, session_id }) {
  const result = db.prepare(
    'INSERT INTO radio_play_events (user_id, station_id, station_name, started_at, session_id) VALUES (?,?,?,?,?)'
  ).run(user_id, station_id ?? null, station_name, started_at, session_id ?? null);
  return Number(result.lastInsertRowid);
}

export function updateRadioPlayEvent(id, userId, { ended_at, listened_ms }) {
  db.prepare(
    'UPDATE radio_play_events SET ended_at=?, listened_ms=? WHERE id=? AND user_id=?'
  ).run(ended_at ?? Date.now(), listened_ms ?? 0, id, userId);
}

export function getRadioStatsInRange(userId, fromMs, toMs) {
  return db.prepare(`
    SELECT station_name, station_id,
           COUNT(*) AS sessions,
           SUM(listened_ms) AS total_ms
    FROM radio_play_events
    WHERE user_id = ? AND started_at >= ? AND started_at < ?
    GROUP BY station_name
    ORDER BY total_ms DESC
  `).all(userId, fromMs, toMs);
}

// ── Podcast Play Events ───────────────────────────────────────────────────────

export function insertPodcastPlayEvent({ user_id, episode_id, feed_id, started_at, session_id }) {
  const result = db.prepare(
    'INSERT INTO podcast_play_events (user_id, episode_id, feed_id, started_at, session_id) VALUES (?,?,?,?,?)'
  ).run(user_id, episode_id, feed_id, started_at, session_id ?? null);
  return Number(result.lastInsertRowid);
}

export function updatePodcastPlayEvent(id, userId, { ended_at, played_ms, completed }) {
  db.prepare(
    'UPDATE podcast_play_events SET ended_at=?, played_ms=?, completed=? WHERE id=? AND user_id=?'
  ).run(ended_at ?? Date.now(), played_ms ?? 0, completed ? 1 : 0, id, userId);
}

export function getPodcastStatsInRange(userId, fromMs, toMs) {
  return db.prepare(`
    SELECT ppe.feed_id,
           pf.title AS feed_title,
           pf.img   AS feed_img,
           COUNT(*) AS episodes_played,
           SUM(ppe.played_ms) AS total_ms,
           SUM(ppe.completed) AS completed_count
    FROM podcast_play_events ppe
    LEFT JOIN podcast_feeds pf ON pf.id = ppe.feed_id AND pf.user = ppe.user_id
    WHERE ppe.user_id = ? AND ppe.started_at >= ? AND ppe.started_at < ?
    GROUP BY ppe.feed_id
    ORDER BY total_ms DESC
  `).all(userId, fromMs, toMs);
}

// ── AcoustID Fingerprinting ───────────────────────────────────────────────────

/**
 * Returns a batch of up to `limit` files that need fingerprinting:
 *  - acoustid_status IS NULL (never attempted)
 *  - OR status='error' with a timestamp older than retryAfterSec seconds
 * Ordered oldest-indexed-first so newly scanned songs complete roughly in
 * library order rather than most-recently-added order.
 */
export function getAcoustidQueue(limit, retryAfterSec) {
  const cutoff = Math.floor(Date.now() / 1000) - retryAfterSec;
  return db.prepare(`
    SELECT filepath, vpath, duration
    FROM files
    WHERE format IS NOT NULL
      AND (
        acoustid_status IS NULL
        OR (acoustid_status = 'error' AND (acoustid_ts IS NULL OR acoustid_ts < ?))
      )
    ORDER BY ts ASC
    LIMIT ?
  `).all(cutoff, limit);
}

/** Mark a file as pending (in-progress) so a restart doesn't double-process it. */
export function setAcoustidPending(filepath, vpath) {
  db.prepare(
    `UPDATE files SET acoustid_status = 'pending', acoustid_ts = ? WHERE filepath = ? AND vpath = ?`
  ).run(Math.floor(Date.now() / 1000), filepath, vpath);
}

/** Persist the result of a successful AcoustID lookup. */
export function setAcoustidResult(filepath, vpath, { acoustid_id, mbid, score, status }) {
  db.prepare(
    `UPDATE files SET acoustid_id = ?, mbid = ?, acoustid_score = ?, acoustid_status = ?, acoustid_ts = ?
     WHERE filepath = ? AND vpath = ?`
  ).run(acoustid_id ?? null, mbid ?? null, score ?? null, status, Math.floor(Date.now() / 1000), filepath, vpath);
}

/** Reset any 'pending' rows back to NULL so they are retried on next worker start. */
export function resetAcoustidPending() {
  db.prepare(`UPDATE files SET acoustid_status = NULL WHERE acoustid_status = 'pending'`).run();
}

/** Return aggregate fingerprinting statistics for the admin UI. */
export function getAcoustidStats() {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN acoustid_status = 'found'     THEN 1 END) AS found,
      COUNT(CASE WHEN acoustid_status = 'not_found' THEN 1 END) AS not_found,
      COUNT(CASE WHEN acoustid_status = 'error'     THEN 1 END) AS errors,
      COUNT(CASE WHEN acoustid_status = 'pending'   THEN 1 END) AS pending,
      COUNT(CASE WHEN acoustid_status IS NULL        THEN 1 END) AS queued
    FROM files
    WHERE format IS NOT NULL
  `).get();
}

// ── Tag Workshop — MB Enrichment ──────────────────────────────────────────────

/** Fetch next batch of files awaiting MusicBrainz enrichment. */
export function getMbEnrichQueue(limit) {
  return db.prepare(`
    SELECT filepath, vpath, mbid, title, artist, album, year, track
    FROM files
    WHERE mbid IS NOT NULL
      AND mb_enrichment_status IS NULL
      AND acoustid_status = 'found'
    LIMIT ?
  `).all(limit);
}

/** Mark a row as pending for MB enrichment. */
export function setMbEnrichPending(filepath, vpath) {
  db.prepare(
    `UPDATE files SET mb_enrichment_status = 'pending', mb_enriched_ts = ? WHERE filepath = ? AND vpath = ?`
  ).run(Math.floor(Date.now() / 1000), filepath, vpath);
}

/** Persist the result of a MusicBrainz recording lookup. */
export function setMbEnrichResult(filepath, vpath, data) {
  db.prepare(`
    UPDATE files
    SET mb_album = ?, mb_year = ?, mb_track = ?, mb_release_id = ?,
        mb_enrichment_status = ?, mb_enriched_ts = ?, tag_status = ?
    WHERE filepath = ? AND vpath = ?
  `).run(
    data.mb_album ?? null, data.mb_year ?? null, data.mb_track ?? null, data.mb_release_id ?? null,
    data.status, Math.floor(Date.now() / 1000), data.tag_status ?? null,
    filepath, vpath
  );
}

/** Reset any rows stuck in 'pending' back to NULL so they are retried on next worker start. */
export function resetMbEnrichPending() {
  db.prepare(`UPDATE files SET mb_enrichment_status = NULL WHERE mb_enrichment_status = 'pending'`).run();
}

/** Aggregate MB enrichment statistics for the admin UI. */
export function getMbEnrichStats() {
  return db.prepare(`
    SELECT
      COUNT(CASE WHEN mbid IS NOT NULL AND acoustid_status = 'found' THEN 1 END) AS total,
      COUNT(CASE WHEN mb_enrichment_status = 'done'    THEN 1 END) AS done,
      COUNT(CASE WHEN mb_enrichment_status = 'error'   THEN 1 END) AS errors,
      COUNT(CASE WHEN mb_enrichment_status = 'no_data' THEN 1 END) AS no_data,
      COUNT(CASE WHEN mb_enrichment_status IS NULL AND mbid IS NOT NULL AND acoustid_status = 'found' THEN 1 END) AS queued,
      COUNT(CASE WHEN acoustid_status IS NOT NULL THEN 1 END) AS acoustid_attempted,
      COUNT(CASE WHEN acoustid_status = 'found' THEN 1 END) AS acoustid_found
    FROM files
  `).get();
}

/** Files that failed MB enrichment — filepath + mbid + error reason for diagnosis. */
export function getMbEnrichErrors(limit = 200) {
  return db.prepare(`
    SELECT filepath, vpath, mbid, mb_enriched_ts, mb_enrichment_error
    FROM files
    WHERE mb_enrichment_status = 'error' AND mbid IS NOT NULL
    ORDER BY mb_enriched_ts DESC
    LIMIT ?
  `).all(limit);
}

/** Reset all error rows back to NULL so they are retried on next worker run. */
export function retryMbEnrichErrors() {
  const r = db.prepare(`
    UPDATE files SET mb_enrichment_status = NULL, mb_enrichment_error = NULL
    WHERE mb_enrichment_status = 'error'
  `).run();
  return { reset: r.changes };
}

/** Combined status for the Tag Workshop dashboard. */
export function getTagWorkshopStatus() {
  const mb   = getMbEnrichStats();
  const tags = db.prepare(`
    SELECT
      COUNT(CASE WHEN tag_status = 'needs_review' THEN 1 END) AS needs_review,
      COUNT(CASE WHEN tag_status = 'confirmed'    THEN 1 END) AS confirmed,
      COUNT(CASE WHEN tag_status = 'accepted'     THEN 1 END) AS accepted,
      COUNT(CASE WHEN tag_status = 'skipped'      THEN 1 END) AS skipped
    FROM files
    WHERE mb_enrichment_status = 'done'
  `).get();
  return { mb, tags };
}

const _TWS_PAGE_SIZE = 40;

/** Paginated album cards grouped by mb_release_id. */
export function getTagWorkshopAlbums(filter = 'all', sort = 'broken', page = 1, search = '') {
  const offset = (Math.max(1, Number(page) || 1) - 1) * _TWS_PAGE_SIZE;

  const searchSql = search.trim()
    ? `AND (mb_album LIKE '%' || ? || '%' OR mb_artist LIKE '%' || ? || '%')`
    : '';
  const searchParams = search.trim() ? [search.trim(), search.trim()] : [];

  // Filter is a HAVING condition on aggregated values so track_count always
  // reflects the full album (not just the filtered subset of tracks).
  let havingSql;
  switch (filter) {
    case 'missing': havingSql = `HAVING SUM(CASE WHEN title IS NULL OR title = '' OR artist IS NULL OR artist = '' OR album IS NULL OR album = '' THEN 1 ELSE 0 END) > 0`; break;
    case 'year':    havingSql = `HAVING SUM(CASE WHEN mb_year IS NOT NULL AND (year IS NULL OR ABS(year - mb_year) > 1) THEN 1 ELSE 0 END) > 0`; break;
    case 'artist':  havingSql = `HAVING SUM(CASE WHEN mb_artist IS NOT NULL AND lower(REPLACE(COALESCE(artist,''),' ','')) != lower(REPLACE(mb_artist,' ','')) THEN 1 ELSE 0 END) > 0`; break;
    default:        havingSql = '';
  }

  let orderSql;
  switch (sort) {
    case 'tracks': orderSql = `track_count DESC, COALESCE(mb_artist,'') COLLATE NOCASE, COALESCE(mb_album,'') COLLATE NOCASE`; break;
    case 'alpha':  orderSql = `COALESCE(mb_artist,'') COLLATE NOCASE, COALESCE(mb_album,'') COLLATE NOCASE`; break;
    default:       orderSql = `tracks_needing_fix DESC, COALESCE(mb_artist,'') COLLATE NOCASE, COALESCE(mb_album,'') COLLATE NOCASE`;
  }

  const albums = db.prepare(`
    SELECT
      mb_release_id,
      COALESCE(mb_album_dir, '') AS mb_album_dir,
      mb_album,
      mb_artist,
      mb_year,
      COUNT(*) AS track_count,
      COUNT(CASE WHEN
        (mb_title IS NOT NULL AND lower(REPLACE(COALESCE(title,''),' ','')) != lower(REPLACE(mb_title,' ','')))
        OR (mb_artist IS NOT NULL AND lower(REPLACE(COALESCE(artist,''),' ','')) != lower(REPLACE(mb_artist,' ','')))
        OR (mb_album IS NOT NULL AND lower(REPLACE(COALESCE(album,''),' ','')) != lower(REPLACE(mb_album,' ','')))
        OR (mb_year IS NOT NULL AND ABS(COALESCE(year,0) - mb_year) > 1)
        THEN 1 END) AS tracks_needing_fix,
      MAX(aaFile) AS album_art
    FROM files
    WHERE tag_status = 'needs_review' AND mb_release_id IS NOT NULL ${searchSql}
    GROUP BY mb_release_id, COALESCE(mb_album_dir, '')
    ${havingSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `).all(...searchParams, _TWS_PAGE_SIZE, offset);

  const countRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM (
       SELECT mb_release_id, COALESCE(mb_album_dir,'') FROM files
       WHERE tag_status = 'needs_review' AND mb_release_id IS NOT NULL ${searchSql}
       GROUP BY mb_release_id, COALESCE(mb_album_dir, '')
       ${havingSql}
     )`
  ).get(...searchParams);

  return { albums, total: countRow.cnt, page: Number(page), pageSize: _TWS_PAGE_SIZE };
}

/** All tracks for one release card (side-by-side file vs MB comparison). */
export function getTagWorkshopAlbumTracks(mb_release_id, album_dir = null) {
  const dirFilter = album_dir != null ? `AND COALESCE(mb_album_dir, '') = '${album_dir.replace(/'/g, "''")}'` : '';
  return db.prepare(`
    SELECT filepath, vpath, title, artist, album, year, track, format,
           mb_title, mb_artist, mb_album, mb_year, mb_track,
           mb_release_id, tag_status, aaFile
    FROM files
    WHERE mb_release_id = ? ${dirFilter}
    ORDER BY COALESCE(mb_track, track, 0), filepath COLLATE NOCASE
  `).all(mb_release_id);
}

/** Return tracks needing tag updates for an accept operation. */
export function getTracksForAccept(mb_release_id, album_dir = null) {
  const dirFilter = album_dir != null ? `AND COALESCE(mb_album_dir, '') = '${album_dir.replace(/'/g, "''")}'` : '';
  return db.prepare(`
    SELECT filepath, vpath, mb_title, mb_artist, mb_album, mb_year, mb_track, title, artist, album, year, track, format
    FROM files
    WHERE mb_release_id = ? AND tag_status IN ('needs_review', 'confirmed') ${dirFilter}
  `).all(mb_release_id);
}

/** Single-track lookup by filepath + vpath for per-track accept operations. */
export function getTrackForAccept(filepath, vpath) {
  return db.prepare(`
    SELECT filepath, vpath, mb_title, mb_artist, mb_album, mb_year, mb_track, title, artist, album, year, track, format
    FROM files
    WHERE filepath = ? AND vpath = ? AND tag_status IN ('needs_review', 'confirmed')
  `).get(filepath, vpath);
}

/** Mark a single track's tag_status as accepted after a successful disk write. */
export function markTrackAccepted(filepath, vpath) {
  db.prepare(`UPDATE files SET tag_status = 'accepted' WHERE filepath = ? AND vpath = ?`).run(filepath, vpath);
}

/** Mark all tracks in a release as skipped. */
export function skipAlbumTags(mb_release_id, album_dir = null) {
  const dirFilter = album_dir != null ? `AND COALESCE(mb_album_dir, '') = '${album_dir.replace(/'/g, "''")}'` : '';
  db.prepare(`
    UPDATE files SET tag_status = 'skipped'
    WHERE mb_release_id = ? AND tag_status IN ('needs_review', 'confirmed') ${dirFilter}
  `).run(mb_release_id);
}

/** Move a shelved (skipped) album back into the review queue. */
export function unshelveAlbum(mb_release_id, album_dir = null) {
  const dirFilter = album_dir != null ? `AND COALESCE(mb_album_dir, '') = '${album_dir.replace(/'/g, "''")}'` : '';
  db.prepare(`
    UPDATE files SET tag_status = 'needs_review'
    WHERE mb_release_id = ? AND tag_status = 'skipped' ${dirFilter}
  `).run(mb_release_id);
}

/** Return paginated shelved (skipped) albums. */
export function getShelvedAlbums(page = 1) {
  const offset = (Math.max(1, Number(page) || 1) - 1) * _TWS_PAGE_SIZE;
  const albums = db.prepare(`
    SELECT mb_release_id, COALESCE(mb_album_dir,'') AS mb_album_dir, mb_album, mb_artist, mb_year,
           COUNT(*) AS track_count,
           MAX(aaFile) AS album_art
    FROM files
    WHERE tag_status = 'skipped' AND mb_release_id IS NOT NULL
    GROUP BY mb_release_id, COALESCE(mb_album_dir, '')
    ORDER BY mb_artist COLLATE NOCASE, mb_album COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(_TWS_PAGE_SIZE, offset);
  const countRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM (
       SELECT DISTINCT mb_release_id, COALESCE(mb_album_dir,'') FROM files WHERE tag_status = 'skipped' AND mb_release_id IS NOT NULL
     )`
  ).get();
  return { albums, total: countRow.cnt, page: Number(page), pageSize: _TWS_PAGE_SIZE };
}

/** Find tracks where normalised file tags already match MB tags (casing/punctuation only).
    Returns their rows; caller updates DB + disk. */
export function getCasingOnlyCandidates() {
  const rows = db.prepare(`
    SELECT filepath, vpath, title, artist, album, year, track,
           mb_title, mb_artist, mb_album, mb_year, mb_track
    FROM files
    WHERE tag_status = 'needs_review'
      AND mb_enrichment_status = 'done'
      AND mb_release_id IS NOT NULL
  `).all();

  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  return rows.filter(r => {
    const titleOk  = !r.mb_title  || norm(r.title)  === norm(r.mb_title);
    const artistOk = !r.mb_artist || norm(r.artist) === norm(r.mb_artist);
    const albumOk  = !r.mb_album  || norm(r.album)  === norm(r.mb_album);
    const yearOk   = !r.mb_year   || Math.abs((r.year || 0) - r.mb_year) <= 1;
    return titleOk && artistOk && albumOk && yearOk;
  });
}

export function getHomeSummary(userId, vpaths, todayStart, weekStart, timeWindows) {
  // songs played today
  const todayCount = db.prepare(
    'SELECT COUNT(*) AS c FROM play_events WHERE user_id=? AND started_at>=?'
  ).get(userId, todayStart).c;

  // songs played this week
  const weekCount = db.prepare(
    'SELECT COUNT(*) AS c FROM play_events WHERE user_id=? AND started_at>=?'
  ).get(userId, weekStart).c;

  // listening streak: consecutive calendar days (UTC midnight boundaries) with at least 1 play.
  // Single query fetches all distinct day-buckets descending — avoids up to 365 individual queries.
  const DAY_MS = 86400000;
  let streak = 0;
  {
    const dayBuckets = db.prepare(
      'SELECT DISTINCT CAST(started_at / 86400000 AS INTEGER) AS b FROM play_events WHERE user_id=? ORDER BY b DESC LIMIT 366'
    ).all(userId).map(r => r.b);
    const todayBucket = Math.floor(todayStart / DAY_MS);
    if (dayBuckets.length > 0) {
      const mostRecent = dayBuckets[0];
      // Only count a streak if the most recent play day is today or yesterday
      // (today may have no plays yet — still counts yesterday's streak as active)
      if (mostRecent === todayBucket || mostRecent === todayBucket - 1) {
        let expected = mostRecent;
        for (const b of dayBuckets) {
          if (b === expected) { streak++; expected--; }
          else break;
        }
      }
    }
  }

  // How many days of play history do we have?
  const earliestRow = db.prepare('SELECT MIN(started_at) AS t FROM play_events WHERE user_id=?').get(userId);
  const dataSpanDays = earliestRow?.t ? Math.floor((todayStart - earliestRow.t) / DAY_MS) : 0;

  // Temporal sections: query each eligible window for distinct songs played
  const vpathSet = new Set(vpaths);
  const stmtWindow = db.prepare(`
    SELECT DISTINCT pe.file_hash, f.title, f.artist, f.album, f.aaFile, f.filepath, f.vpath
    FROM play_events pe
    LEFT JOIN files f ON f.hash = pe.file_hash
    WHERE pe.user_id = ? AND pe.started_at >= ? AND pe.started_at < ?
    LIMIT 10
  `);
  const sections = [];
  for (const w of (timeWindows || [])) {
    if (dataSpanDays < (w.minDays || 0)) continue;
    const rows = stmtWindow.all(userId, w.from, w.to);
    const songs = rows.filter(r => r.vpath && vpathSet.has(r.vpath));
    if (songs.length) sections.push({ key: w.key, songs });
  }

  return { todayCount, weekCount, streak, dataSpanDays, sections };
}
