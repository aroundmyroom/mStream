import child from 'child_process';
import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { nanoid } from 'nanoid';
import jwt from 'jsonwebtoken';
import * as config from '../state/config.js';
import { getDirname } from '../util/esm-helpers.js';

const __dirname = getDirname(import.meta.url);

const taskQueue = [];
const runningTasks = new Set();
const vpathLimiter = new Set();
let scanIntervalTimer = null; // This gets set after the server boots
let rustBinaryReady = false; // tracks whether the rust binary is available

function addScanTask(vpath) {
  const scanObj = { task: 'scan', vpath: vpath, id: nanoid(8) };
  if (runningTasks.size < config.program.scanOptions.maxConcurrentTasks) {
    runScan(scanObj);
  } else {
    taskQueue.push(scanObj);
  }
}

function scanAll() {
  Object.keys(config.program.folders).forEach((vpath) => {
    addScanTask(vpath);
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

const rustParserDir = path.join(__dirname, '../../rust-parser');
const ext = process.platform === 'win32' ? '.exe' : '';
const prebuiltBin = path.join(__dirname, `../../bin/rust-parser/rust-parser-${process.platform}-${process.arch}${ext}`);
const localBuildBin = path.join(rustParserDir, `target/release/rust-parser${ext}`);
let rustParserBin = null;

function buildRustParser() {
  if (rustBinaryReady) { return true; }

  // 1. Check for pre-built binary shipped with the project
  if (fs.existsSync(prebuiltBin)) {
    rustParserBin = prebuiltBin;
    rustBinaryReady = true;
    return true;
  }

  // 2. Check for locally compiled binary
  if (fs.existsSync(localBuildBin)) {
    rustParserBin = localBuildBin;
    rustBinaryReady = true;
    return true;
  }

  // 3. Try to build from source
  winston.info('Rust parser binary not found — building from source...');
  try {
    child.execSync('cargo build --release', { cwd: rustParserDir, stdio: 'pipe', timeout: 300000 });
    if (fs.existsSync(localBuildBin)) {
      rustParserBin = localBuildBin;
      rustBinaryReady = true;
      winston.info('Rust parser built successfully');
      return true;
    }
  } catch (err) {
    winston.warn(`Failed to build Rust parser: ${err.message}. Falling back to JS parser.`);
  }
  return false;
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
    compressImage: config.program.scanOptions.compressImage
  };

  let forkedScan;
  const useRust = config.program.scanOptions.rustParser && buildRustParser();
  if (useRust) {
    forkedScan = child.spawn(rustParserBin, [JSON.stringify(jsonLoad)], { stdio: ['ignore', 'pipe', 'pipe'] });
    winston.info(`File scan started (Rust) on ${jsonLoad.directory}`);
    forkedScan.on('error', (err) => {
      winston.error(`Rust parser failed to start: ${err.message}`);
      runningTasks.delete(forkedScan);
      vpathLimiter.delete(scanObj.vpath);
      nextTask();
    });
  } else {
    forkedScan = child.fork(path.join(__dirname, './scanner.mjs'), [JSON.stringify(jsonLoad)], { silent: true });
    winston.info(`File scan started on ${jsonLoad.directory}`);
  }

  runningTasks.add(forkedScan);
  vpathLimiter.add(scanObj.vpath);

  forkedScan.stdout.on('data', (data) => {
    winston.info(`File scan message: ${data}`);
  });

  forkedScan.stderr.on('data', (data) => {
    winston.error(`File scan error: ${data}`);
  });

  forkedScan.on('close', (code) => {
    winston.info(`File scan completed with code ${code}`);
    runningTasks.delete(forkedScan);
    vpathLimiter.delete(scanObj.vpath);
    nextTask();
  });
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

export function runAfterBoot() {
  setTimeout(() => {
    // This only gets run once after boot. Will not be run on server restart b/c scanIntervalTimer is already set
    if (config.program.scanOptions.scanInterval > 0 && scanIntervalTimer === null) {
      scanAll();
      scanIntervalTimer = setInterval(() => scanAll(), config.program.scanOptions.scanInterval * 60 * 60 * 1000);
    }
  }, config.program.scanOptions.bootScanDelay * 1000);
}

export function resetScanInterval() {
  if (scanIntervalTimer) { clearInterval(scanIntervalTimer); }
  if (config.program.scanOptions.scanInterval > 0) {
    scanIntervalTimer = setInterval(() => scanAll(), config.program.scanOptions.scanInterval * 60 * 60 * 1000);
  }
}
