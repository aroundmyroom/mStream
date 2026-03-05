import child from 'child_process';
import path from 'path';
import fs from 'fs';
import winston from 'winston';
import { nanoid } from 'nanoid';
import jwt from 'jsonwebtoken';
import * as config from '../state/config.js';
import { getDirname } from '../util/esm-helpers.js';
import * as db from '../db/manager.js';
import * as scanProgress from '../state/scan-progress.js';

const __dirname = getDirname(import.meta.url);

const taskQueue = [];
const runningTasks = new Set();
const vpathLimiter = new Set();
const currentScanDirs = new Map(); // vpath → { dir: string, root: string }
let scanIntervalTimer = null; // This gets set after the server boots

function addScanTask(vpath) {
  const scanObj = { task: 'scan', vpath: vpath, id: nanoid(8) };
  if (runningTasks.size < config.program.scanOptions.maxConcurrentTasks) {
    runScan(scanObj);
  } else {
    taskQueue.push(scanObj);
  }
}

// Returns true if vpathB's root is a subdirectory of vpathA's root.
function isChildOf(vpathA, vpathB) {
  const a = config.program.folders[vpathA].root.replace(/\/?$/, '/');
  const b = config.program.folders[vpathB].root.replace(/\/?$/, '/');
  return b.startsWith(a) && a !== b;
}

// Vpaths whose root sits inside another vpath's root — they need no separate
// scan because the parent will cover them once otherRoots no longer skips them.
function childVpaths() {
  const keys = Object.keys(config.program.folders);
  return new Set(keys.filter(v => keys.some(other => other !== v && isChildOf(other, v))));
}

function scanAll() {
  const children = childVpaths();
  Object.keys(config.program.folders).forEach((vpath) => {
    if (!children.has(vpath)) { addScanTask(vpath); }
  });
}

function nextTask() {
  if (
    taskQueue.length > 0
    && runningTasks.size < config.program.scanOptions.maxConcurrentTasks
    && !vpathLimiter.has(taskQueue[taskQueue.length - 1].vpath))
  {
    runScan(taskQueue.pop());
  }
}

function runScan(scanObj) {
  const jsonLoad = {
    directory: config.program.folders[scanObj.vpath].root,
    vpath: scanObj.vpath,
    port: config.program.port,
    token: jwt.sign({ scan: true }, config.program.secret),
    albumArtDirectory: config.program.storage.albumArtDirectory,
    skipImg: config.program.scanOptions.skipImg,
    pause: config.program.scanOptions.pause,
    supportedFiles: config.program.supportedAudioFiles,
    scanId: scanObj.id,
    isHttps: config.getIsHttps(),
    compressImage: config.program.scanOptions.compressImage,
    otherRoots: Object.keys(config.program.folders)
      .filter(v => v !== scanObj.vpath && !isChildOf(scanObj.vpath, v))
      .map(v => config.program.folders[v].root)
  };

  const baseline = db.countFilesByVpath(scanObj.vpath) || 0;
  scanProgress.startScan(scanObj.id, scanObj.vpath, baseline > 0 ? baseline : null);

  const forkedScan = child.fork(path.join(__dirname, './scanner.mjs'), [JSON.stringify(jsonLoad)], { silent: true });
  winston.info(`File scan started on ${jsonLoad.directory}`);
  runningTasks.add(forkedScan);
  vpathLimiter.add(scanObj.vpath);

  forkedScan.on('message', (msg) => {
    if (msg?.dir) currentScanDirs.set(scanObj.vpath, { dir: msg.dir, root: jsonLoad.directory });
  });

  forkedScan.stdout.on('data', (data) => {
    winston.info(`File scan message: ${data}`);
  });

  forkedScan.stderr.on('data', (data) => {
    winston.error(`File scan error: ${data}`);
  });

  forkedScan.on('close', (code) => {
    winston.info(`File scan completed with code ${code}`);
    scanProgress.finish(scanObj.id);
    runningTasks.delete(forkedScan);
    vpathLimiter.delete(scanObj.vpath);
    currentScanDirs.delete(scanObj.vpath);
    nextTask();
    // When the last vpath finishes, clean up orphaned art and waveform files
    if (runningTasks.size === 0 && taskQueue.length === 0) {
      setImmediate(runOrphanCleanup);
    }
  });
}

async function runOrphanCleanup() {
  try {
    const artDir      = config.program.storage.albumArtDirectory;
    const waveformDir = config.program.storage.waveformDirectory;

    // Collect all live references from the DB
    const liveArt    = new Set(db.getLiveArtFilenames());   // aaFile values
    const liveHashes = new Set(db.getLiveHashes());         // hash values

    const COMPRESSED_RE = /^z[^-]+-(.+)$/;

    let deleted = 0;

    // --- Album art orphan cleanup ---
    if (artDir && fs.existsSync(artDir)) {
      for (const file of fs.readdirSync(artDir)) {
        if (file === 'README.md') continue;
        const m        = file.match(COMPRESSED_RE);
        const baseName = m ? m[1] : file;
        if (!liveArt.has(baseName)) {
          try { fs.unlinkSync(path.join(artDir, file)); deleted++; } catch (_e) { /* skip */ }
        }
      }
    }

    // --- Waveform orphan cleanup ---
    const WAVEFORM_RE = /^wf-(.+)\.json$/;
    if (waveformDir && fs.existsSync(waveformDir)) {
      for (const file of fs.readdirSync(waveformDir)) {
        const wfMatch = file.match(WAVEFORM_RE);
        if (!wfMatch) continue;
        if (!liveHashes.has(wfMatch[1])) {
          try { fs.unlinkSync(path.join(waveformDir, file)); deleted++; } catch (_e) { /* skip */ }
        }
      }
    }

    if (deleted > 0) winston.info(`Post-scan cleanup: removed ${deleted} orphaned file(s) from cache`);
  } catch (err) {
    winston.warn(`Post-scan orphan cleanup failed: ${err.message}`);
  }
}

export function scanVPath(vPath) {
  addScanTask(vPath);
}

export { scanAll };

export function isScanning() {
  return runningTasks.size > 0 ? true : false;
}

export function getAdminStats() {
  return {
    taskQueue,
    vpaths: [...vpathLimiter]
  };
}

export function getScanningVpaths() {
  return [...vpathLimiter].map(vpath => {
    const info = currentScanDirs.get(vpath);
    let dir = null;
    if (info) {
      const rel = info.dir.startsWith(info.root)
        ? info.dir.slice(info.root.length).replace(/^\//, '')
        : info.dir;
      dir = rel || null;
    }
    return { vpath, dir };
  });
}

export function runAfterBoot() {
  setTimeout(() => {
    // This only gets run once after boot. Will not be run on server restart b/c scanIntervalTimer is already set
    if (config.program.scanOptions.scanInterval > 0 && scanIntervalTimer === null) {
      scanAll();
      scanIntervalTimer = setInterval(() => scanAll(), config.program.scanOptions.scanInterval * 60 * 60 * 1000);
    }
  }, config.program.scanOptions.bootScanDelay * 1000);
}

export function reset() {
  for (const task of runningTasks) {
    task.kill();
  }
  runningTasks.clear();
  vpathLimiter.clear();
  taskQueue.length = 0;
  if (scanIntervalTimer) { clearInterval(scanIntervalTimer); }
  scanIntervalTimer = null;
}

export function resetScanInterval() {
  if (scanIntervalTimer) { clearInterval(scanIntervalTimer); }
  if (config.program.scanOptions.scanInterval > 0) {
    scanIntervalTimer = setInterval(() => scanAll(), config.program.scanOptions.scanInterval * 60 * 60 * 1000);
  }
}
