/**
 * rg-analysis.js
 *
 * ReplayGain 2.0 / EBU R128 measurement worker lifecycle + REST API.
 * All endpoints are admin-only.
 *
 *   POST /api/v1/admin/rg/start        — start measurement worker
 *   POST /api/v1/admin/rg/stop         — stop measurement worker
 *   GET  /api/v1/admin/rg/status       — worker status + DB counts
 *   GET  /api/v1/admin/rg/tool         — which tool is available (rsgain/ffmpeg)
 *   POST /api/v1/admin/rg/reset-failed — reset failed rows so they are retried
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { rsgainBin, rsgainAvailable, ensureRsgain } from '../util/rsgain-bootstrap.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const _workerPath = path.join(__dirname, '../util/rg-analysis-worker.mjs');

// ── Worker state ──────────────────────────────────────────────────────────────

let _worker         = null;
let _running        = false;
let _stopping       = false;
let _lastStats      = null;
let _startedAt      = null;
let _currentFile    = null;
let _processedCount = 0;

function _dbPath() {
  return path.join(config.program.storage.dbDirectory, 'mstream.sqlite');
}

function _rootFolders() {
  // Only ROOT vpaths are indexed in the DB.  A vpath is a root if no other
  // vpath's root is a strict prefix of its own root.
  const folders = config.program.folders || {};
  const roots = {};
  for (const [name, cfg] of Object.entries(folders)) {
    if (!cfg.root) continue;
    const myRoot = cfg.root.replace(/\/?$/, '/');
    const isChild = Object.entries(folders).some(([other, otherCfg]) => {
      if (other === name) return false;
      const otherRoot = (otherCfg.root || '').replace(/\/?$/, '/');
      return myRoot.startsWith(otherRoot) && myRoot !== otherRoot;
    });
    if (!isChild) roots[name] = cfg.root;
  }
  return roots;
}

function _spawnWorker() {
  if (_worker) return;

  const bin = rsgainAvailable() ? rsgainBin() : null;
  _worker    = new Worker(_workerPath, {
    workerData: {
      dbPath:    _dbPath(),
      folders:   _rootFolders(),
      rsgainBin: bin,
      ffmpegBin: ffmpegBin(),
    },
  });
  _running   = true;
  _stopping  = false;
  _startedAt = Date.now();

  _worker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'status' || msg.type === 'ready') {
      if (msg.stats) {
        // Strip the worker's own tool field — the API always serves the
        // authoritative rsgainAvailable() value via the top-level 'tool' key
        const { tool: _t, ...cleanStats } = msg.stats;
        _lastStats = cleanStats;
      }
      if (msg.processedCount != null) _processedCount = msg.processedCount;
    }
    if (msg.type === 'progress') {
      _currentFile = msg.vpath ? `${msg.vpath}/${msg.currentFile}` : msg.currentFile;
      if (msg.processedCount != null) _processedCount = msg.processedCount;
    }
    if (msg.type === 'stopped') {
      _running        = false;
      _stopping       = false;
      _startedAt      = null;
      _currentFile    = null;
      _worker         = null;
      winston.info('[rg-analysis] Worker stopped cleanly');
    }
    if (msg.type === 'error') {
      winston.error(`[rg-analysis] Worker error: ${msg.message}`);
      _running        = false;
      _stopping       = false;
      _startedAt      = null;
      _currentFile    = null;
      _worker         = null;
    }
  });

  _worker.on('error', err => {
    winston.error(`[rg-analysis] Worker thread error: ${err.message}`);
    _running   = false;
    _stopping  = false;
    _startedAt = null;
    _worker    = null;
  });

  _worker.on('exit', code => {
    if (code !== 0) winston.warn(`[rg-analysis] Worker exited with code ${code}`);
    _running        = false;
    _stopping       = false;
    _startedAt      = null;
    _currentFile    = null;
    _worker         = null;
  });

  winston.info(`[rg-analysis] Worker started (tool: ${bin ? 'rsgain' : 'ffmpeg'})`);
}

// ── Setup (called once at server start) ───────────────────────────────────────

export function setup(app) {
  // Deferred auto-start: wait 60s for the server to finish booting and for
  // other auto-starting workers (AcoustID at 15s) to settle first.
  setTimeout(async () => {
    try {
      await ensureRsgain();
      if (_running) return;
      const status = db.getRgStatus();
      if (status && status.queued > 0) {
        _spawnWorker();
      }
    } catch (_) {}
  }, 60_000);

  // ── POST /api/v1/admin/rg/start ───────────────────────────────────────────
  app.post('/api/v1/admin/rg/start', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    if (_running) return res.json({ status: 'already_running' });
    ensureRsgain().then(() => {
      _spawnWorker();
      res.json({ status: 'started' });
    }).catch(e => {
      winston.warn('[rg-analysis] rsgain prefetch failed: ' + e.message);
      _spawnWorker(); // start anyway — ffmpeg fallback will be used
      res.json({ status: 'started' });
    });
  });

  // ── POST /api/v1/admin/rg/stop ────────────────────────────────────────────
  app.post('/api/v1/admin/rg/stop', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    if (!_running || !_worker) return res.json({ status: 'not_running' });
    _stopping = true;
    _worker.postMessage({ type: 'stop' });
    res.json({ status: 'stopping' });
  });

  // ── GET /api/v1/admin/rg/status ───────────────────────────────────────────
  app.get('/api/v1/admin/rg/status', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    let dbStats;
    try { dbStats = db.getRgStatus(); } catch (_) { dbStats = null; }
    res.json({
      running:        _running,
      stopping:       _stopping,
      startedAt:      _startedAt,
      currentFile:    _currentFile,
      processedCount: _processedCount,
      stats:          _lastStats || dbStats,
      tool:           rsgainAvailable() ? 'rsgain' : 'ffmpeg',
    });
  });

  // ── GET /api/v1/admin/rg/tool ─────────────────────────────────────────────
  app.get('/api/v1/admin/rg/tool', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    res.json({ tool: rsgainAvailable() ? 'rsgain' : 'ffmpeg', available: rsgainAvailable() });
  });

  // ── POST /api/v1/admin/rg/reset-failed ───────────────────────────────────
  app.post('/api/v1/admin/rg/reset-failed', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    const count = db.resetRgFailed();
    res.json({ reset: count });
  });

  // ── POST /api/v1/admin/rg/reset-all ──────────────────────────────────────
  app.post('/api/v1/admin/rg/reset-all', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    if (_running) return res.status(409).json({ error: 'Stop the worker before resetting' });
    const count = db.resetRgAll();
    _lastStats      = null;
    _currentFile    = null;
    _processedCount = 0;
    res.json({ reset: count });
  });
}
