/**
 * server-playback.js — mpv-based server-side audio playback
 *
 * Architecture:
 *   - Spawns mpv with --input-ipc-server (Unix socket) to control playback
 *   - Maintains a server-side queue mirror (relPath + metadata)
 *   - Exposes REST API under /api/v1/server-playback/* (auth required)
 *   - Serves the /server-remote SPA (before auth, no token needed for the page itself)
 *
 * mpv IPC protocol (JSON, one object per line):
 *   Send:    { "command": [...], "request_id": N }
 *   Receive: { "data": ..., "error": "success"|"...", "request_id": N }
 *   Events:  { "event": "end-file"|"file-loaded"|..., ... }
 */

import net from 'net';
import path from 'path';
import child_process from 'child_process';
import fs from 'fs';
import os from 'os';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';

// ── Socket path ────────────────────────────────────────────────────────────
const sockPath = path.join(os.tmpdir(), `mpv-mstream-${process.pid}.sock`);

// ── Process & IPC state ───────────────────────────────────────────────────
let mpvProc        = null;   // ChildProcess | null
let ipcSock        = null;   // net.Socket | null
let ipcBuf         = '';     // partial line buffer
let reqId          = 1;      // monotonic request_id counter
const pending      = new Map(); // request_id → { resolve, reject, timer }
let connectRetries = 0;

const SERVER_AUDIO_CTRL_CANDIDATES = ['Master', 'Speaker', 'PCM', 'Headphone'];

// ── Queue mirror ──────────────────────────────────────────────────────────
// Each entry: { relPath, title, artist, album, albumArt }
let serverQueue  = [];
let currentIndex = -1;

function runCmd(bin, args, timeout = 5000) {
  try {
    const res = child_process.spawnSync(bin, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
    });
    return {
      ok: !res.error && res.status === 0,
      status: res.status,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      error: res.error ? String(res.error.message || res.error) : null,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: '',
      error: String(err?.message || err),
    };
  }
}

function parseMixerState(output) {
  const text = String(output || '');
  const muteMatches = Array.from(text.matchAll(/\[(on|off)\]/g)).map(m => m[1]);
  const volumeMatches = Array.from(text.matchAll(/\[(\d{1,3})%\]/g)).map(m => Number(m[1]));
  const muted = muteMatches.length > 0 && muteMatches.every(v => v === 'off');
  return {
    muted,
    hasOn: muteMatches.includes('on'),
    hasOff: muteMatches.includes('off'),
    volumes: volumeMatches,
  };
}

function getLinuxAudioHealth() {
  const mpvBin = (config.program.serverAudio && config.program.serverAudio.mpvBin) || 'mpv';
  const mpvVer = runCmd(mpvBin, ['--version']);
  const amixerVer = runCmd('amixer', ['--version']);
  const aplayVer = runCmd('aplay', ['--version']);
  const controlsRes = amixerVer.ok ? runCmd('amixer', ['scontrols']) : { ok: false, stdout: '' };

  const controls = [];
  if (controlsRes.ok) {
    const matches = String(controlsRes.stdout || '').match(/'([^']+)'/g) || [];
    for (const m of matches) {
      const name = m.slice(1, -1);
      if (!controls.includes(name)) controls.push(name);
    }
  }

  const inspected = [];
  const targets = controls.length ? SERVER_AUDIO_CTRL_CANDIDATES.filter(c => controls.includes(c)) : SERVER_AUDIO_CTRL_CANDIDATES;
  for (const ctl of targets) {
    const r = runCmd('amixer', ['get', ctl]);
    if (!r.ok) continue;
    const parsed = parseMixerState(r.stdout);
    inspected.push({
      name: ctl,
      muted: parsed.muted,
      volumes: parsed.volumes,
      hasOn: parsed.hasOn,
      hasOff: parsed.hasOff,
    });
  }

  const cardsRes = aplayVer.ok ? runCmd('aplay', ['-l']) : { ok: false, stdout: '' };
  const cardLines = cardsRes.ok
    ? String(cardsRes.stdout || '').split('\n').filter(l => /^card\s+\d+/i.test(l.trim())).slice(0, 6)
    : [];

  const mutedControls = inspected.filter(i => i.muted).map(i => i.name);
  const issues = [];
  if (!mpvVer.ok) issues.push('mpv-not-found');
  if (!amixerVer.ok) issues.push('amixer-not-found');
  if (amixerVer.ok && inspected.length === 0) issues.push('no-mixer-controls');
  if (mutedControls.length > 0) issues.push('muted-controls');

  return {
    platform: process.platform,
    mpv: {
      found: mpvVer.ok,
      path: mpvBin,
      version: (() => {
        if (!mpvVer.ok) return null;
        const m = String(mpvVer.stdout || '').match(/mpv\s+(\S+)/i);
        return m ? m[1] : 'unknown';
      })(),
      error: mpvVer.ok ? null : (mpvVer.error || mpvVer.stderr || 'Not found'),
    },
    alsa: {
      amixerFound: amixerVer.ok,
      aplayFound: aplayVer.ok,
      controls,
      inspected,
      mutedControls,
      cards: cardLines,
    },
    healthy: issues.length === 0,
    issues,
  };
}

function applyLinuxAudioFix() {
  const health = getLinuxAudioHealth();
  if (!health.alsa.amixerFound) {
    return { changed: false, attempted: [], health };
  }

  const controls = health.alsa.inspected.length
    ? health.alsa.inspected.map(c => c.name)
    : SERVER_AUDIO_CTRL_CANDIDATES;
  const attempted = [];
  for (const ctl of controls) {
    const r1 = runCmd('amixer', ['set', ctl, '90%', 'unmute']);
    const r2 = r1.ok ? { ok: true } : runCmd('amixer', ['sset', ctl, '90%', 'unmute']);
    attempted.push({ name: ctl, ok: !!(r1.ok || r2.ok) });
  }

  return {
    changed: attempted.some(a => a.ok),
    attempted,
    health: getLinuxAudioHealth(),
  };
}

function bestEffortPrepareLinuxAudio() {
  if (process.platform !== 'linux') return;
  const autoUnmute = config.program.serverAudio?.autoUnmute !== false;
  if (!autoUnmute) return;
  try {
    const result = applyLinuxAudioFix();
    if (result.changed) winston.info('[server-audio] Applied ALSA unmute/volume fix before mpv start');
  } catch (err) {
    winston.warn(`[server-audio] Audio auto-fix failed: ${err?.message || err}`);
  }
}

// ── mpv boot / kill ────────────────────────────────────────────────────────
export function bootMpv() {
  if (mpvProc && mpvProc.exitCode === null) return; // already running

  const mpvBin = (config.program.serverAudio && config.program.serverAudio.mpvBin) || 'mpv';

  // Clean up any stale socket from a previous run
  try { fs.unlinkSync(sockPath); } catch (_) {}

  bestEffortPrepareLinuxAudio();

  winston.info(`[server-audio] Starting mpv: ${mpvBin}`);

  mpvProc = child_process.spawn(mpvBin, [
    '--idle=yes',
    '--no-video',
    '--no-terminal',
    '--really-quiet',
    `--input-ipc-server=${sockPath}`,
  ], { stdio: 'ignore', detached: false });

  mpvProc.on('error', err => {
    winston.error(`[server-audio] mpv failed to start: ${err.message}`);
    mpvProc = null;
  });

  mpvProc.on('exit', code => {
    winston.info(`[server-audio] mpv exited (code ${code})`);
    mpvProc = null;
    if (ipcSock) { try { ipcSock.destroy(); } catch (_) {} ipcSock = null; }
    // Reject any pending IPC requests
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('mpv process exited'));
      pending.delete(id);
    }
  });

  // mpv takes ~200–500ms to create the socket; retry a few times
  connectRetries = 0;
  setTimeout(connectIpc, 600);
}

export function killMpv() {
  if (ipcSock) { try { ipcSock.destroy(); } catch (_) {} ipcSock = null; }
  if (mpvProc) { try { mpvProc.kill('SIGTERM'); } catch (_) {} mpvProc = null; }
  serverQueue  = [];
  currentIndex = -1;
}

export function isRunning() {
  return mpvProc !== null && mpvProc.exitCode === null;
}

// ── IPC connection ─────────────────────────────────────────────────────────
function connectIpc() {
  if (!mpvProc || mpvProc.exitCode !== null) return;

  const sock = net.connect(sockPath);

  sock.on('connect', () => {
    connectRetries = 0;
    ipcSock        = sock;
    ipcBuf         = '';
    winston.info('[server-audio] IPC socket connected');
    // Observe playlist-pos so we get push notifications on track changes
    sendRaw('{"command":["observe_property",1,"playlist-pos"]}\n');
  });

  sock.on('data', chunk => {
    ipcBuf += chunk.toString();
    const lines = ipcBuf.split('\n');
    ipcBuf = lines.pop(); // last element may be an incomplete line
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { handleIpcMessage(JSON.parse(t)); } catch (_) {}
    }
  });

  sock.on('error', err => {
    if (connectRetries < 8 && mpvProc && mpvProc.exitCode === null) {
      connectRetries++;
      setTimeout(connectIpc, 400 * connectRetries);
    } else {
      winston.warn(`[server-audio] IPC connect failed: ${err.message}`);
    }
  });

  sock.on('close', () => {
    if (ipcSock === sock) ipcSock = null;
    // If mpv is still running reconnect (socket can be temporarily unavailable)
    if (mpvProc && mpvProc.exitCode === null) {
      setTimeout(connectIpc, 1000);
    }
  });
}

function sendRaw(str) {
  if (ipcSock && !ipcSock.destroyed) {
    try { ipcSock.write(str); } catch (_) {}
  }
}

function ipcCommand(args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!ipcSock || ipcSock.destroyed) {
      return reject(new Error('mpv IPC not connected'));
    }
    const id    = reqId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('IPC command timed out'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    sendRaw(JSON.stringify({ command: args, request_id: id }) + '\n');
  });
}

function handleIpcMessage(msg) {
  // Response to a pending request
  if (msg.request_id !== undefined) {
    const p = pending.get(msg.request_id);
    if (p) {
      pending.delete(msg.request_id);
      clearTimeout(p.timer);
      if (msg.error === 'success') p.resolve(msg.data !== undefined ? msg.data : null);
      else p.reject(new Error(msg.error || 'mpv error'));
    }
    return;
  }

  // Push event: observed property changed (playlist-pos)
  if (msg.event === 'property-change' && msg.name === 'playlist-pos') {
    if (msg.data !== null && msg.data !== undefined) {
      currentIndex = msg.data;
    }
  }
}

// ── Status ─────────────────────────────────────────────────────────────────
export async function getStatus() {
  const running   = isRunning();
  const connected = ipcSock && !ipcSock.destroyed;

  if (!running || !connected) {
    return {
      running,
      playing:      false,
      currentTime:  0,
      duration:     0,
      currentIndex: -1,
      queueLength:  serverQueue.length,
      volume:       100,
      loopMode:     'none',
      shuffle:      false,
      queue:        serverQueue,
    };
  }

  const [timePos, duration, pause, volume, loopFile, loopPlaylist, plPos] = await Promise.all([
    ipcCommand(['get_property', 'time-pos']).catch(() => 0),
    ipcCommand(['get_property', 'duration']).catch(() => 0),
    ipcCommand(['get_property', 'pause']).catch(() => true),
    ipcCommand(['get_property', 'volume']).catch(() => 100),
    ipcCommand(['get_property', 'loop-file']).catch(() => 'no'),
    ipcCommand(['get_property', 'loop-playlist']).catch(() => 'no'),
    ipcCommand(['get_property', 'playlist-pos']).catch(() => currentIndex),
  ]);

  if (plPos !== null && plPos !== undefined && plPos >= 0) currentIndex = plPos;

  let loopMode = 'none';
  if (loopFile     && loopFile     !== 'no' && loopFile     !== false) loopMode = 'one';
  else if (loopPlaylist && loopPlaylist !== 'no' && loopPlaylist !== false) loopMode = 'all';

  return {
    running:      true,
    playing:      !pause,
    currentTime:  timePos    || 0,
    duration:     duration   || 0,
    currentIndex,
    queueLength:  serverQueue.length,
    volume:       volume     || 100,
    loopMode,
    shuffle:      false, // mpv shuffle state not tracked
    queue:        serverQueue,
  };
}

// ── File path resolution ───────────────────────────────────────────────────
function resolveAbsPath(relPath) {
  const normPath = relPath.replace(/^\//, ''); // strip leading slash if present
  const folders = config.program.folders || {};
  for (const [vname, folder] of Object.entries(folders)) {
    if (normPath === vname || normPath.startsWith(vname + '/')) {
      const rel = normPath.slice(vname.length + 1);
      const abs = path.join(folder.root, rel);
      try {
        fs.accessSync(abs, fs.constants.R_OK);
        return abs;
      } catch (_) {}
    }
  }
  return null;
}

// ── Queue management ───────────────────────────────────────────────────────
export async function addToQueue(relPath, meta = {}) {
  const abs = resolveAbsPath(relPath);
  if (!abs) throw new Error('File not found: ' + relPath);

  // Enrich with DB tech metadata if not already provided
  let bitrate = meta.bitrate || null;
  let sampleRate = meta['sample-rate'] || null;
  let channels = meta.channels || null;
  if (!bitrate && !sampleRate) {
    try {
      const pathInfo = relPath.split('/');
      const vpath = pathInfo[0];
      const filepath = pathInfo.slice(1).join('/');
      const row = db.findFileByPath(filepath, vpath);
      if (row) {
        bitrate    = row.bitrate     || null;
        sampleRate = row.sample_rate || null;
        channels   = row.channels   || null;
      }
    } catch (_e) { /* non-fatal */ }
  }

  const entry = {
    relPath,
    title:         meta.title    || path.basename(relPath, path.extname(relPath)),
    artist:        meta.artist   || '',
    album:         meta.album    || '',
    albumArt:      meta.albumArt || '',
    bitrate,
    'sample-rate': sampleRate,
    channels,
  };
  serverQueue.push(entry);

  if (isRunning() && ipcSock && !ipcSock.destroyed) {
    await ipcCommand(['loadfile', abs, 'append-play']);
  }

  return serverQueue.length - 1;
}

export async function clearQueue() {
  serverQueue  = [];
  currentIndex = -1;
  if (isRunning() && ipcSock && !ipcSock.destroyed) {
    await ipcCommand(['playlist-clear']).catch(() => {});
    await ipcCommand(['stop']).catch(() => {});
  }
}

export async function removeAtIndex(index) {
  if (index < 0 || index >= serverQueue.length) throw new Error('Index out of range');
  serverQueue.splice(index, 1);

  if (isRunning() && ipcSock && !ipcSock.destroyed) {
    await ipcCommand(['playlist-remove', index]);
    if (currentIndex > index) currentIndex--;
    else if (currentIndex === index) currentIndex = Math.min(index, serverQueue.length - 1);
    if (serverQueue.length === 0) currentIndex = -1;
  }
}

export async function playAtIndex(index) {
  if (index < 0 || index >= serverQueue.length) throw new Error('Index out of range');
  currentIndex = index;
  if (isRunning() && ipcSock && !ipcSock.destroyed) {
    await ipcCommand(['set_property', 'playlist-pos', index]);
  }
}

export async function cycleLoop() {
  const status = await getStatus();
  const next = status.loopMode === 'none' ? 'one'
             : status.loopMode === 'one'  ? 'all'
             :                              'none';

  if (isRunning() && ipcSock && !ipcSock.destroyed) {
    await ipcCommand(['set_property', 'loop-file',     next === 'one' ? 'inf' : 'no']);
    await ipcCommand(['set_property', 'loop-playlist', next === 'all' ? 'inf' : 'no']);
  }
  return { loop_mode: next };
}

// ── Express API (auth-protected) ───────────────────────────────────────────
export function setup(mstream) {
  // GET /api/v1/server-playback/status
  mstream.get('/api/v1/server-playback/status', async (req, res) => {
    try { res.json(await getStatus()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/queue/add  { filepath, title, artist, album, albumArt }
  mstream.post('/api/v1/server-playback/queue/add', async (req, res) => {
    const { filepath, title, artist, album, albumArt } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath required' });
    try {
      const index = await addToQueue(filepath, { title, artist, album, albumArt });
      res.json({ index });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/queue/clear
  mstream.post('/api/v1/server-playback/queue/clear', async (req, res) => {
    try { await clearQueue(); res.json({}); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/queue/remove  { index }
  mstream.post('/api/v1/server-playback/queue/remove', async (req, res) => {
    const { index } = req.body;
    if (index === undefined) return res.status(400).json({ error: 'index required' });
    try { await removeAtIndex(Number(index)); res.json({}); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/queue/play-index  { index }
  mstream.post('/api/v1/server-playback/queue/play-index', async (req, res) => {
    const { index } = req.body;
    if (index === undefined) return res.status(400).json({ error: 'index required' });
    try { await playAtIndex(Number(index)); res.json({}); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/next
  mstream.post('/api/v1/server-playback/next', async (req, res) => {
    try {
      if (isRunning() && ipcSock && !ipcSock.destroyed)
        await ipcCommand(['playlist-next', 'force']);
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/previous
  mstream.post('/api/v1/server-playback/previous', async (req, res) => {
    try {
      if (isRunning() && ipcSock && !ipcSock.destroyed)
        await ipcCommand(['playlist-prev', 'force']);
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/pause  (toggles)
  mstream.post('/api/v1/server-playback/pause', async (req, res) => {
    try {
      if (isRunning() && ipcSock && !ipcSock.destroyed)
        await ipcCommand(['cycle', 'pause']);
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/set-pause  { paused: true|false }
  mstream.post('/api/v1/server-playback/set-pause', async (req, res) => {
    const { paused } = req.body;
    try {
      if (isRunning() && ipcSock && !ipcSock.destroyed)
        await ipcCommand(['set_property', 'pause', paused === true]);
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/seek  { position }
  mstream.post('/api/v1/server-playback/seek', async (req, res) => {
    const { position } = req.body;
    if (position === undefined) return res.status(400).json({ error: 'position required' });
    try {
      if (isRunning() && ipcSock && !ipcSock.destroyed)
        await ipcCommand(['seek', Number(position), 'absolute']);
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/volume  { volume }
  mstream.post('/api/v1/server-playback/volume', async (req, res) => {
    const { volume } = req.body;
    if (volume === undefined) return res.status(400).json({ error: 'volume required' });
    try {
      if (isRunning() && ipcSock && !ipcSock.destroyed)
        await ipcCommand(['set_property', 'volume', Math.max(0, Math.min(130, Number(volume)))]);
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/v1/server-playback/loop  (cycles: none → one → all → none)
  mstream.post('/api/v1/server-playback/loop', async (req, res) => {
    try { res.json(await cycleLoop()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/v1/server-playback/detect — check mpv availability
  mstream.get('/api/v1/server-playback/detect', (req, res) => {
    const mpvBin = (config.program.serverAudio && config.program.serverAudio.mpvBin) || 'mpv';
    child_process.execFile(mpvBin, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) return res.json({ found: false, version: null, path: mpvBin });
      const m = (stdout || '').match(/mpv\s+(\S+)/i);
      res.json({ found: true, version: m ? m[1] : 'unknown', path: mpvBin });
    });
  });

  // GET /api/v1/server-playback/audio-health — Linux speaker output diagnostics
  mstream.get('/api/v1/server-playback/audio-health', (req, res) => {
    try {
      if (process.platform !== 'linux') {
        return res.json({
          platform: process.platform,
          healthy: true,
          issues: [],
          note: 'Audio health checks are currently Linux-only.',
        });
      }
      return res.json(getLinuxAudioHealth());
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/server-playback/audio-health/fix — best-effort unmute + volume set
  mstream.post('/api/v1/server-playback/audio-health/fix', (req, res) => {
    try {
      if (req.user?.admin !== true) {
        return res.status(403).json({ error: 'Admin only' });
      }
      if (process.platform !== 'linux') {
        return res.status(400).json({ error: 'Audio fix is Linux-only.' });
      }
      return res.json(applyLinuxAudioFix());
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/server-playback/test-tone — play a stereo test tone through mpv
  mstream.post('/api/v1/server-playback/test-tone', async (req, res) => {
    try {
      if (!isRunning() || !ipcSock || ipcSock.destroyed) {
        return res.status(409).json({ ok: false, error: 'mpv is not running. Start Server Audio first.' });
      }

      // Use our bundled ffmpeg to generate a real audio file with a left/right test tone.
      // This is more reliable than lavfi:// URIs via mpv IPC.
      const { ffmpegBin } = await import('../util/ffmpeg-bootstrap.js');
      const fBin = await ffmpegBin();
      const tmpFile = path.join(os.tmpdir(), `mstream-test-tone-${Date.now()}.mp3`);

      // Generate 3s: 440 Hz on left channel, 880 Hz on right channel, then centre beep
      const ffResult = child_process.spawnSync(fBin, [
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
        '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3',
        '-filter_complex', '[0:a][1:a]amerge=inputs=2,volume=0.8',
        '-ac', '2', '-ar', '44100', '-q:a', '4',
        '-y', tmpFile,
      ], { timeout: 10000 });

      if (ffResult.status !== 0 || !fs.existsSync(tmpFile)) {
        const err = String(ffResult.stderr || ffResult.stdout || 'ffmpeg failed').slice(0, 200);
        return res.status(500).json({ ok: false, error: 'Could not generate test tone: ' + err });
      }

      await ipcCommand(['loadfile', tmpFile, 'replace']);

      // Clean up temp file after playback completes (3s + buffer)
      setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch (_) {} }, 6000);

      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

// ── server-remote HTML route (before auth) ────────────────────────────────
export function setupBeforeAuth(mstream) {
  mstream.get('/server-remote', (req, res) => {
    const saEnabled = config.program.serverAudio && config.program.serverAudio.enabled;
    if (!saEnabled) {
      return res.type('html').send(
        '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Server Audio</title>' +
        '<style>body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#e4e4e4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}' +
        '.box{max-width:420px;padding:40px;text-align:center}h1{color:#a78bfa;margin-bottom:12px}' +
        'p{color:#8888b0;line-height:1.6;margin-bottom:24px}a{color:#a78bfa;text-decoration:none}a:hover{text-decoration:underline}</style></head>' +
        '<body><div class="box"><h1>Server Audio</h1>' +
        '<p>Server Audio playback is not enabled.<br>Go to the <a href="/admin">Admin Panel</a> → <b>Server Audio</b> to enable it, then reload this page.</p>' +
        '<a href="/admin">Admin Panel</a> &nbsp;·&nbsp; <a href="/">Normal Mode</a></div></body></html>'
      );
    }
    const filePath = path.join(config.program.webAppDirectory, 'server-remote', 'index.html');
    res.sendFile(filePath, err => {
      if (err && !res.headersSent) res.status(500).send('Server remote page not found.');
    });
  });
}

// ── Admin helper: start / stop on demand ──────────────────────────────────
export function startIfEnabled() {
  if (config.program.serverAudio && config.program.serverAudio.enabled) {
    bootMpv();
  }
}
