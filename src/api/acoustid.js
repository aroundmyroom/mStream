/**
 * acoustid.js
 *
 * AcoustID fingerprinting API and worker lifecycle manager.
 *
 * Endpoints (all admin-only, require req.user.admin === true):
 *   GET  /api/v1/acoustid/status  — progress stats + running state
 *   POST /api/v1/acoustid/start   — launch the worker thread
 *   POST /api/v1/acoustid/stop    — signal the worker to stop cleanly
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as admin from '../util/admin.js';
import { fpcalcBin, ensureFpcalc } from '../util/fpcalc-bootstrap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _workerPath = path.join(__dirname, '../util/acoustid-worker.mjs');

// ── Persist autostart flag to config file ────────────────────────────────────

async function _saveAutostart(value) {
  try {
    const loadConfig = await admin.loadFile(config.configFile);
    if (!loadConfig.acoustid) loadConfig.acoustid = {};
    loadConfig.acoustid.autostart = value;
    await admin.saveFile(loadConfig, config.configFile);
    if (!config.program.acoustid) config.program.acoustid = {};
    config.program.acoustid.autostart = value;
  } catch (err) {
    winston.warn(`[acoustid] Failed to save autostart flag: ${err.message}`);
  }
}

// ── Worker state ──────────────────────────────────────────────────────────────

let _worker   = null;
let _running  = false;
let _stopping = false;
let _lastStats = null;

function _workerData() {
  const apiKey  = config.program.acoustid?.apiKey?.trim() || '';
  // Build vpath → absolute-root-path mapping from config
  const folders = {};
  for (const [vpath, folderCfg] of Object.entries(config.program.folders || {})) {
    if (folderCfg.root) folders[vpath] = folderCfg.root;
  }
  return {
    dbPath:    path.join(config.program.storage.dbDirectory, 'mstream.sqlite'),
    apiKey,
    fpcalcBin: fpcalcBin(),
    folders,
  };
}

function _spawnWorker() {
  if (_worker) return;

  const data = _workerData();
  _worker  = new Worker(_workerPath, { workerData: data });
  _running  = true;
  _stopping = false;

  _worker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'status' || msg.type === 'ready') {
      if (msg.stats) _lastStats = msg.stats;
    }
    if (msg.type === 'stopped') {
      _running  = false;
      _stopping = false;
      _worker   = null;
      winston.info('[acoustid] Worker stopped cleanly');
    }
    if (msg.type === 'error') {
      winston.error(`[acoustid] Worker error: ${msg.message}`);
      _running  = false;
      _stopping = false;
      _worker   = null;
      // Restart after transient error (e.g. DB locked) unless user stopped it
      if (config.program.acoustid?.autostart === true) {
        winston.info('[acoustid] Restarting worker in 10s after error...');
        setTimeout(() => { if (!_running) _spawnWorker(); }, 10_000);
      }
    }
  });

  _worker.on('error', err => {
    winston.error(`[acoustid] Worker thread error: ${err.message}`);
    _running  = false;
    _stopping = false;
    _worker   = null;
    if (config.program.acoustid?.autostart === true) {
      winston.info('[acoustid] Restarting worker in 10s after thread error...');
      setTimeout(() => { if (!_running) _spawnWorker(); }, 10_000);
    }
  });

  _worker.on('exit', code => {
    if (code !== 0) {
      winston.warn(`[acoustid] Worker exited with code ${code}`);
    }
    _running  = false;
    _stopping = false;
    _worker   = null;
    // Only auto-restart on unexpected (non-zero) exits, not clean completion
    if (code !== 0 && config.program.acoustid?.autostart === true) {
      winston.info('[acoustid] Restarting worker in 10s after unexpected exit...');
      setTimeout(() => { if (!_running) _spawnWorker(); }, 10_000);
    }
  });

  winston.info('[acoustid] Worker started');
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export function setup(mstream) {

  // Guard — all endpoints are admin-only
  mstream.all('/api/v1/acoustid/{*path}', (req, res, next) => {
    if (req.user?.admin !== true) return res.status(403).json({ error: 'Admin only' });
    next();
  });

  // GET /api/v1/acoustid/status
  mstream.get('/api/v1/acoustid/status', (req, res) => {
    const stats = db.getAcoustidStats() || _lastStats || {
      total: 0, found: 0, not_found: 0, errors: 0, pending: 0, queued: 0,
    };

    const apiKey  = config.program.acoustid?.apiKey?.trim() || '';
    const enabled = config.program.acoustid?.enabled === true;
    const hasKey  = apiKey.length >= 4;

    res.json({
      enabled,
      hasKey,
      running:  _running,
      stopping: _stopping,
      stats: {
        total:     stats.total     || 0,
        found:     stats.found     || 0,
        not_found: stats.not_found || 0,
        errors:    stats.errors    || 0,
        pending:   stats.pending   || 0,
        queued:    stats.queued    || 0,
      },
    });
  });

  // POST /api/v1/acoustid/start
  mstream.post('/api/v1/acoustid/start', async (req, res) => {
    const apiKey  = config.program.acoustid?.apiKey?.trim() || '';
    const enabled = config.program.acoustid?.enabled === true;

    if (!enabled) {
      return res.status(400).json({ error: 'AcoustID is not enabled in settings' });
    }
    if (apiKey.length < 4) {
      return res.status(400).json({ error: 'No valid AcoustID API key configured' });
    }
    if (_running) {
      return res.json({ ok: true, message: 'Already running' });
    }

    // Ensure fpcalc binary is available (non-blocking check/download)
    const fpcalcReady = await ensureFpcalc();
    if (!fpcalcReady) {
      return res.status(500).json({ error: 'fpcalc binary is not available. Check server logs.' });
    }

    _spawnWorker();
    _saveAutostart(true);
    res.json({ ok: true });
  });

  // POST /api/v1/acoustid/stop
  mstream.post('/api/v1/acoustid/stop', (req, res) => {
    if (!_running || !_worker) {
      return res.json({ ok: true, message: 'Not running' });
    }
    if (_stopping) {
      return res.json({ ok: true, message: 'Already stopping' });
    }
    _stopping = true;
    _worker.postMessage({ type: 'stop' });
    _saveAutostart(false);
    // Force-terminate the worker if it hasn't stopped cleanly within 30 s
    // (e.g. stuck in fpcalc or a long DB retry loop)
    setTimeout(() => {
      if (_worker && _stopping) {
        winston.warn('[acoustid] Worker did not stop in 30 s — force-terminating');
        _worker.terminate();
        _running  = false;
        _stopping = false;
        _worker   = null;
      }
    }, 30_000);
    res.json({ ok: true });
  });

  // Auto-start on server boot only if user had previously started it
  const bootApiKey = config.program.acoustid?.apiKey?.trim() || '';
  if (config.program.acoustid?.enabled === true && bootApiKey.length >= 4 && config.program.acoustid?.autostart === true) {
    ensureFpcalc().then(ready => {
      if (ready) {
        _spawnWorker();
      } else {
        winston.warn('[acoustid] Auto-start skipped: fpcalc binary not available');
      }
    }).catch(err => winston.warn(`[acoustid] Auto-start skipped: ${err.message}`));
  }
}
