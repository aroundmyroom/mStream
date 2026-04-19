/**
 * tagworkshop.js
 *
 * MusicBrainz enrichment worker lifecycle + Tag Workshop REST API.
 *
 * All endpoints are admin-only.
 *
 * MB Enrichment worker:
 *   POST /api/v1/tagworkshop/enrich/start  — start MB lookup worker
 *   POST /api/v1/tagworkshop/enrich/stop   — stop MB lookup worker
 *
 * Tag Workshop:
 *   GET  /api/v1/tagworkshop/status
 *   GET  /api/v1/tagworkshop/albums?page=N&filter=all|missing|year|artist&sort=broken|tracks|alpha
 *   GET  /api/v1/tagworkshop/album/:mb_release_id
 *   POST /api/v1/tagworkshop/accept        { mb_release_id, overrides? }
 *   POST /api/v1/tagworkshop/skip          { mb_release_id }
 *   POST /api/v1/tagworkshop/bulk-accept-casing
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const _workerPath  = path.join(__dirname, '../util/mb-enrich-worker.mjs');
const execFileAsync = promisify(execFile);

// ── Worker state ──────────────────────────────────────────────────────────────

let _worker   = null;
let _running  = false;
let _stopping = false;
let _lastStats = null;

function _dbPath() {
  return path.join(config.program.storage.dbDirectory, 'mstream.sqlite');
}

function _spawnWorker() {
  if (_worker) return;

  _worker   = new Worker(_workerPath, { workerData: { dbPath: _dbPath() } });
  _running  = true;
  _stopping = false;

  _worker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'status' || msg.type === 'ready') {
      if (msg.stats) _lastStats = msg.stats;
    }
    if (msg.type === 'stopped') {
      _running = false; _stopping = false; _worker = null;
      winston.info('[tagworkshop] MB enrichment worker stopped');
    }
    if (msg.type === 'error') {
      winston.error(`[tagworkshop] Worker error: ${msg.message}`);
      _running = false; _stopping = false; _worker = null;
    }
  });

  _worker.on('error', err => {
    winston.error(`[tagworkshop] Worker thread error: ${err.message}`);
    _running = false; _stopping = false; _worker = null;
  });

  _worker.on('exit', code => {
    if (code !== 0) winston.warn(`[tagworkshop] Worker exited with code ${code}`);
    _running = false; _stopping = false; _worker = null;
  });

  winston.info('[tagworkshop] MB enrichment worker started');
}

// ── Tag writing ───────────────────────────────────────────────────────────────

const WRITABLE_FORMATS = new Set(['mp3', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'wav', 'wma', 'aiff', 'aif']);

/**
 * Write audio tags to a file using ffmpeg stream copy.
 * Writes to a temp file first, then atomically renames over the original.
 * Returns null on success, error message on failure.
 */
async function writeTagsToFile(absolutePath, format, tags) {
  const fmt = (format || path.extname(absolutePath).slice(1) || '').toLowerCase();
  if (!WRITABLE_FORMATS.has(fmt)) {
    return `Unsupported format: ${fmt}`;
  }

  const ext    = path.extname(absolutePath);
  const tmpPath = absolutePath + '.tagtmp_' + Date.now() + ext;

  // WAV and AIFF muxers cannot hold video/picture streams (cover art).
  // Using '-map 0' on a file with embedded art causes:
  //   "[wav @ ...] wav muxer does not support any stream of type video"
  // Use audio-only mapping for those formats.
  const AUDIO_ONLY_FORMATS = new Set(['wav', 'aif', 'aiff']);
  const mapArg = AUDIO_ONLY_FORMATS.has(fmt) ? '0:a' : '0';

  const args = [
    '-y',
    '-i', absolutePath,
    '-c', 'copy',
    '-map', mapArg,
    '-map_metadata', '0',
  ];

  if (tags.title  != null) args.push('-metadata', `title=${tags.title}`);
  if (tags.artist != null) args.push('-metadata', `artist=${tags.artist}`);
  if (tags.album  != null) args.push('-metadata', `album=${tags.album}`);
  if (tags.year   != null) args.push('-metadata', `date=${tags.year}`);
  if (tags.track  != null) args.push('-metadata', `track=${tags.track}`);

  // MP3-specific: ensure ID3v2.3 compatibility
  if (fmt === 'mp3') {
    args.push('-id3v2_version', '3');
  }

  args.push(tmpPath);

  try {
    await execFileAsync(ffmpegBin(), args, { timeout: 60_000 });
    await fs.rename(tmpPath, absolutePath);
    return null;
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch (_) {}
    return err.message || String(err);
  }
}

/**
 * Resolve absolute path from vpath + relative filepath.
 * Returns null if vpath not found in config.
 */
function resolveAbsPath(vpath, filepath) {
  const root = config.program.folders?.[vpath]?.root;
  if (!root) return null;
  return path.join(root, filepath);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export function setup(mstream) {

  // Guard — all endpoints are admin-only
  mstream.all('/api/v1/tagworkshop/{*path}', (req, res, next) => {
    if (req.user?.admin !== true) return res.status(403).json({ error: 'Admin only' });
    next();
  });

  // ── MB Enrichment worker control ──────────────────────────────────────────

  // POST /api/v1/tagworkshop/enrich/start
  mstream.post('/api/v1/tagworkshop/enrich/start', (req, res) => {
    if (_running) return res.json({ ok: true, message: 'Already running' });
    _spawnWorker();
    res.json({ ok: true });
  });

  // POST /api/v1/tagworkshop/enrich/stop
  mstream.post('/api/v1/tagworkshop/enrich/stop', (req, res) => {
    if (!_running || !_worker) return res.json({ ok: true, message: 'Not running' });
    if (_stopping) return res.json({ ok: true, message: 'Already stopping' });
    _stopping = true;
    _worker.postMessage('stop');
    res.json({ ok: true });
  });

  // ── Tag Workshop endpoints ─────────────────────────────────────────────────

  // GET /api/v1/tagworkshop/status
  mstream.get('/api/v1/tagworkshop/status', (req, res) => {
    const status = db.getTagWorkshopStatus();
    res.json({
      ...status,
      enrich: { running: _running, stopping: _stopping },
    });
  });

  // GET /api/v1/tagworkshop/enrich/errors
  mstream.get('/api/v1/tagworkshop/enrich/errors', (req, res) => {
    const rows = db.getMbEnrichErrors(200);
    res.json({ errors: rows, total: rows.length });
  });

  // POST /api/v1/tagworkshop/enrich/retry-errors
  mstream.post('/api/v1/tagworkshop/enrich/retry-errors', (req, res) => {
    const result = db.retryMbEnrichErrors();
    res.json({ ok: true, ...result });
  });

  // GET /api/v1/tagworkshop/albums
  mstream.get('/api/v1/tagworkshop/albums', (req, res) => {
    const filter = ['all', 'missing', 'year', 'artist'].includes(req.query.filter) ? req.query.filter : 'all';
    const sort   = ['broken', 'tracks', 'alpha'].includes(req.query.sort)   ? req.query.sort   : 'broken';
    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const search = typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : '';
    const result = db.getTagWorkshopAlbums(filter, sort, page, search);
    res.json(result);
  });

  // GET /api/v1/tagworkshop/album/:mb_release_id
  mstream.get('/api/v1/tagworkshop/album/:mb_release_id', (req, res) => {
    const id = req.params.mb_release_id;
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid release ID' });
    const album_dir = typeof req.query.album_dir === 'string' ? req.query.album_dir : null;
    const tracks = db.getTagWorkshopAlbumTracks(id, album_dir);
    res.json({ tracks });
  });

  // POST /api/v1/tagworkshop/accept
  mstream.post('/api/v1/tagworkshop/accept', async (req, res) => {
    const { mb_release_id, album_dir, overrides } = req.body || {};
    if (!mb_release_id) return res.status(400).json({ error: 'mb_release_id required' });
    const albumDirFilter = typeof album_dir === 'string' ? album_dir : null;

    const tracks = db.getTracksForAccept(mb_release_id, albumDirFilter);
    if (tracks.length === 0) return res.json({ ok: true, accepted: 0, errors: [] });

    const results = { accepted: 0, dbOnly: 0, errors: [] };

    for (const t of tracks) {
      const finalTags = {
        title:  t.mb_title  ?? t.title,
        artist: overrides?.artist ?? t.mb_artist ?? t.artist,
        album:  overrides?.album  ?? t.mb_album  ?? t.album,
        year:   t.mb_year   ?? t.year,
        track:  t.mb_track  ?? t.track,
      };

      const absPath = resolveAbsPath(t.vpath, t.filepath);
      let diskErr = null;
      if (absPath) {
        diskErr = await writeTagsToFile(absPath, t.format, finalTags);
      } else {
        diskErr = 'vpath not found in config';
      }

      if (diskErr) {
        winston.warn(`[tagworkshop] Tag write failed ${t.filepath}: ${diskErr}`);
        results.errors.push({ filepath: t.filepath, error: diskErr });
        // Still update DB — user can retry disk write later
        results.dbOnly++;
      } else {
        results.accepted++;
      }

      // Update DB regardless of disk write result
      try {
        db.updateFileTags(t.filepath, t.vpath, finalTags);
        db.markTrackAccepted(t.filepath, t.vpath);
        // Sync modified timestamp so the scanner doesn't flag this as stale
        // and re-insert with a fresh ts (which floods Recently Added).
        if (!diskErr && absPath) {
          try { db.updateFileModified(t.filepath, t.vpath, (await fs.stat(absPath)).mtime.getTime()); } catch (_) {}
        }
      } catch (dbErr) {
        winston.error(`[tagworkshop] DB update failed ${t.filepath}: ${dbErr.message}`);
      }
    }

    res.json({ ok: true, ...results });
  });

  // POST /api/v1/tagworkshop/accept-track
  // Process a single track (used for per-track progress display from the UI).
  // Body: { mb_release_id, filepath, vpath, overrides?: { artist?, album? } }
  mstream.post('/api/v1/tagworkshop/accept-track', async (req, res) => {
    const { filepath, vpath, overrides } = req.body || {};
    if (!filepath || !vpath) return res.status(400).json({ error: 'filepath and vpath are required' });

    const t = db.getTrackForAccept(filepath, vpath);

    // Track not in review state (already accepted, or not found) — skip silently
    if (!t) return res.json({ ok: true, skipped: true });

    const finalTags = {
      title:  overrides?.title  || (t.mb_title  ?? t.title),
      artist: overrides?.artist || (t.mb_artist ?? t.artist),
      album:  overrides?.album  || (t.mb_album  ?? t.album),
      year:   overrides?.year !== undefined ? overrides.year : (t.mb_year ?? t.year),
      track:  t.mb_track  ?? t.track,
    };

    const absPath = resolveAbsPath(t.vpath, t.filepath);
    let diskErr = null;
    if (absPath) {
      diskErr = await writeTagsToFile(absPath, t.format, finalTags);
    } else {
      diskErr = 'vpath not found in config';
    }

    if (diskErr) {
      winston.warn(`[tagworkshop] Tag write failed ${t.filepath}: ${diskErr}`);
    }

    try {
      db.updateFileTags(t.filepath, t.vpath, finalTags);
      db.markTrackAccepted(t.filepath, t.vpath);
      if (!diskErr && absPath) {
        try { db.updateFileModified(t.filepath, t.vpath, (await fs.stat(absPath)).mtime.getTime()); } catch (_) {}
      }
    } catch (dbErr) {
      winston.error(`[tagworkshop] DB update failed ${t.filepath}: ${dbErr.message}`);
    }

    res.json({ ok: !diskErr, error: diskErr || null });
  });

  // POST /api/v1/tagworkshop/skip
  mstream.post('/api/v1/tagworkshop/skip', (req, res) => {
    const { mb_release_id, album_dir } = req.body || {};
    if (!mb_release_id) return res.status(400).json({ error: 'mb_release_id required' });
    db.skipAlbumTags(mb_release_id, typeof album_dir === 'string' ? album_dir : null);
    res.json({ ok: true });
  });

  // POST /api/v1/tagworkshop/unshelve
  mstream.post('/api/v1/tagworkshop/unshelve', (req, res) => {
    const { mb_release_id, album_dir } = req.body || {};
    if (!mb_release_id) return res.status(400).json({ error: 'mb_release_id required' });
    db.unshelveAlbum(mb_release_id, typeof album_dir === 'string' ? album_dir : null);
    res.json({ ok: true });
  });

  // GET /api/v1/tagworkshop/shelved
  mstream.get('/api/v1/tagworkshop/shelved', (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    res.json(db.getShelvedAlbums(page));
  });

  // POST /api/v1/tagworkshop/bulk-accept-casing
  mstream.post('/api/v1/tagworkshop/bulk-accept-casing', async (req, res) => {
    const candidates = db.getCasingOnlyCandidates();
    if (candidates.length === 0) return res.json({ ok: true, accepted: 0, dbOnly: 0, errors: [] });

    const results = { accepted: 0, dbOnly: 0, errors: [] };

    for (const t of candidates) {
      const finalTags = {
        title:  t.mb_title  ?? t.title,
        artist: t.mb_artist ?? t.artist,
        album:  t.mb_album  ?? t.album,
        year:   t.mb_year   ?? t.year,
        track:  t.mb_track  ?? t.track,
      };

      const absPath = resolveAbsPath(t.vpath, t.filepath);
      let diskErr = null;
      if (absPath) {
        diskErr = await writeTagsToFile(absPath, null, finalTags);
      } else {
        diskErr = 'vpath not found in config';
      }

      if (diskErr) {
        results.errors.push({ filepath: t.filepath, error: diskErr });
        results.dbOnly++;
      } else {
        results.accepted++;
      }

      try {
        db.updateFileTags(t.filepath, t.vpath, finalTags);
        db.markTrackAccepted(t.filepath, t.vpath);
        if (!diskErr && absPath) {
          try { db.updateFileModified(t.filepath, t.vpath, (await fs.stat(absPath)).mtime.getTime()); } catch (_) {}
        }
      } catch (_) {}
    }

    res.json({ ok: true, ...results });
  });
}
