import { parseFile } from 'music-metadata';
import fs from 'fs';
import fsp from 'node:fs/promises';
import path from 'path';
import crypto from 'crypto';
import Joi from 'joi';
import sharp from 'sharp';
import mime from 'mime-types';
import axios from 'axios';
import http from 'http';
import https from 'https';

// Disable keep-alive on both agents: between batch flushes the server-side
// keep-alive timeout can expire, leaving a stale socket in the pool. When
// axios reuses that dead socket the next write raises EPIPE. Creating a fresh
// connection per request is cheap compared to metadata parsing overhead.
const ax = axios.create({
  httpAgent:  new http.Agent({  keepAlive: false }),
  httpsAgent: new https.Agent({ keepAlive: false, rejectUnauthorized: false }),
});

let loadJson;
try {
  loadJson = JSON.parse(process.argv[process.argv.length - 1], 'utf8');
} catch (_error) {
  console.error(`Warning: failed to parse JSON input`);
  process.exit(1);
}

// Validate input
const schema = Joi.object({
  vpath: Joi.string().required(),
  directory: Joi.string().required(),
  port: Joi.number().port().required(),
  token: Joi.string().required(),
  pause: Joi.number().required(),
  skipImg: Joi.boolean().required(),
  albumArtDirectory: Joi.string().required(),
  scanId: Joi.string().required(),
  isHttps: Joi.boolean().required(),
  compressImage: Joi.boolean().required(),
  hasBaseline: Joi.boolean().required(),
  supportedFiles: Joi.object().pattern(
    Joi.string(), Joi.boolean()
  ).required(),
  otherRoots: Joi.array().items(Joi.string()).required(),
  excludedPaths: Joi.array().items(Joi.string()).default([])
});

const { error: validationError } = schema.validate(loadJson);
if (validationError) {
  console.error(`Invalid JSON Input`);
  console.log(validationError);
  process.exit(1);
}

// ── Subsonic ID helpers ───────────────────────────────────────────────────────
function _makeArtistId(artist) {
  return crypto.createHash('md5').update((artist || '').toLowerCase().trim()).digest('hex').slice(0, 16);
}
function _makeAlbumId(artist, album) {
  return crypto.createHash('md5')
    .update(`${(artist || '').toLowerCase().trim()}|||${(album || '').toLowerCase().trim()}`)
    .digest('hex').slice(0, 16);
}

async function insertEntries(song) {
  const data = {
    "title": song.title ? String(song.title) : null,
    "artist": song.artist ? String(song.artist) : null,
    "year": song.year ? song.year : null,
    "album": song.album ? String(song.album) : null,
    "filepath": song.filePath,
    "format": song.format,
    "track": song.track.no ? song.track.no : null,
    "trackOf": song.track.of ? song.track.of : null,
    "disk": song.disk.no ? song.disk.no : null,
    "modified": song.modified,
    "hash": song.hash,
    "aaFile": song.aaFile ? song.aaFile : null,
    "art_source": song._artSource || null,
    "cover_file": song._coverFile || null,
    "vpath": loadJson.vpath,
    "ts": song._preserveTs || song.modified || Math.floor(Date.now() / 1000),
    "sID": loadJson.scanId,
    "replaygainTrackDb": song.replaygain_track_gain ? song.replaygain_track_gain.dB : null,
    "genre": song.genre ? String(song.genre) : null,
    "cuepoints": song.cuepoints || null,
    "duration": song._duration ?? null,
    "bitrate":     song._bitrate     ?? null,
    "sample_rate": song._sampleRate  ?? null,
    "channels":    song._channels    ?? null,
    "artist_id": _makeArtistId(song.artist ? String(song.artist) : null),
    "album_id": _makeAlbumId(song.artist ? String(song.artist) : null, song.album ? String(song.album) : null)
  };

  await ax({
    method: 'POST',
    url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/add-file`,
    headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
    responseType: 'json',
    data: data
  });
}

/**
 * Report a scan error back to the mStream server database for persistent
 * auditing.  The GUID = md5(relativeFilePath + '|' + errorType) so the same
 * recurring problem on the same file increments its count instead of creating
 * duplicate rows.  Errors here must never crash or stall the scanner.
 */
async function reportError(absoluteFilepath, errorType, errorMsg, stack) {
  try {
    const rel = absoluteFilepath
      ? path.relative(loadJson.directory, absoluteFilepath)
      : '';
    const guid = crypto.createHash('md5').update(`${rel}|${errorType}`).digest('hex');
    await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/report-error`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: {
        guid,
        filepath: rel,
        vpath: loadJson.vpath,
        errorType,
        errorMsg:  String(errorMsg  || '').slice(0, 500),
        stack:     String(stack     || '').slice(0, 2000)
      }
    });
  } catch (_err) {
    // error reporting must never crash the scanner
  }
}

async function confirmOk(absoluteFilepath) {
  try {
    const rel = absoluteFilepath
      ? path.relative(loadJson.directory, absoluteFilepath)
      : '';
    await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/confirm-ok`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: { filepath: rel, vpath: loadJson.vpath }
    });
  } catch (_err) {
    // confirm-ok must never crash the scanner
  }
}

// Running total of valid files discovered during recursiveScan.
// Updated as directories are walked so set-expected pings reflect the
// current tree-walk progress rather than requiring a separate pre-count pass.
let _totalSeen = 0;

run();
async function run() {
  try {
    // Prune stale error entries before starting — respects the configured retention window.
    try {
      await ax({
        method: 'POST',
        url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/prune-errors`,
        headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
        responseType: 'json',
        data: { vpath: loadJson.vpath }
      });
    } catch (_e) { /* non-critical — prune fail should not abort scan */ }

    // Progress strategy (both first scans and rescans):
    //  - Rescan (hasBaseline=true): expected is already set from DB count; no
    //    change needed. pct is capped at 99 until finish-scan fires.
    //  - First scan (hasBaseline=false): no pre-count pass — scanning starts
    //    immediately. _totalSeen is incremented per file in recursiveScan.
    //    After the full tree walk a single set-expected ping sends the true
    //    total. The UI shows an indeterminate bar + growing file count with no
    //    double-traverse and no 10+ min pre-scan delay.

    const scanStartTs = Math.floor(Date.now() / 1000);
    await recursiveScan(loadJson.directory);

    // Final set-expected: after the full tree walk, _totalSeen is the true total.
    // For rescans the DB count is already set; this is only meaningful for first scans.
    if (!loadJson.hasBaseline && _totalSeen > 0) {
      try {
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/set-expected`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: { scanId: loadJson.scanId, expected: _totalSeen }
        });
      } catch (_e) { /* non-critical */ }
    }

    await flushBatch();

    await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/finish-scan`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: {
        vpath: loadJson.vpath,
        scanId: loadJson.scanId,
        scanStartTs
      }
    });
  }catch (err) {
    console.error('Scan Failed');
    console.error(err.stack)
  }
}

// ── Batch scan helpers ────────────────────────────────────────────────────────
// Instead of one HTTP call per file, files are accumulated and sent in batches
// of SCAN_BATCH_SIZE.  This reduces 138K sequential round trips to ~700, and
// wraps all unchanged-file scanId UPDATEs in a single SQL transaction per batch.

const SCAN_BATCH_SIZE = 200;
let _pendingBatch = []; // { absPath, relPath, modTime }

async function processFileResult(absPath, relPath, modTime, data) {
  if (Object.entries(data).length === 0 || data._stale) {
    // New or modified file — full parse + insert (cuepoints extracted inside parseMyFile)
    const songInfo = await parseMyFile(absPath, modTime);
    // Preserve Discogs-assigned art (DB cache only, e.g. WAV files) when the
    // re-parsed file carries no embedded art — prevents orphan cleanup from
    // deleting art the user manually picked via the Discogs picker.
    if (!songInfo.aaFile && data._preserveAaFile) {
      songInfo.aaFile = data._preserveAaFile;
      songInfo._artSource = data._preserveArtSource || null;
    }
    // Preserve original insertion timestamp so editing tags/art doesn't
    // re-flood "Recently Added" (file hash changes after rewrite → ts = now without this).
    if (data._preserveTs) {
      songInfo._preserveTs = data._preserveTs;
    }
    await insertEntries(songInfo);
    await confirmOk(absPath);
  } else {
    // File already in DB — run targeted updates for anything still missing

    if (data._needsArt) {
      try {
        let songInfo;
        try {
          songInfo = (await parseFile(absPath, { skipCovers: false })).common;
        } catch (_e) {
          await reportError(absPath, 'art', `Failed to parse file for embedded art: ${_e.message}`, _e.stack);
          songInfo = {};
        }
        songInfo.filePath = relPath;
        await getAlbumArt(songInfo);
        if (songInfo.aaFile) {
          await ax({
            method: 'POST',
            url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-art`,
            headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
            responseType: 'json',
            data: { filepath: data.filepath, vpath: loadJson.vpath, aaFile: songInfo.aaFile, scanId: loadJson.scanId, artSource: songInfo._artSource || null, coverFile: songInfo._coverFile || null }
          });
        }
      } catch (_artErr) {
        await reportError(absPath, 'art', `Art update failed: ${_artErr.message}`, _artErr.stack);
      }
    }

    if (data._needsCue) {
      try {
        let cuepoints = '[]';
        try {
          const parsed = await parseFile(absPath, { skipCovers: true });
          const cue = parsed.common?.cuesheet;
          const sampleRate = parsed.format?.sampleRate || null;
          if (cue && Array.isArray(cue.tracks) && cue.tracks.length && sampleRate) {
            const pts = [];
            for (const t of cue.tracks) {
              if (t.number === 170) continue;
              const idx1 = Array.isArray(t.indexes) && t.indexes.find(i => i.number === 1);
              if (!idx1) continue;
              pts.push({ no: t.number, title: t.title || null, t: Math.round((idx1.offset / sampleRate) * 100) / 100 });
            }
            if (pts.length > 1) cuepoints = JSON.stringify(pts);
          }
        } catch (_e) {
          await reportError(absPath, 'cue', `Embedded cue sheet parse failed: ${_e.message}`, _e.stack);
        }
        if (cuepoints === '[]') {
          try {
            const sidecar = parseSidecarCue(absPath);
            if (sidecar) cuepoints = JSON.stringify(sidecar);
          } catch (_e) {
            await reportError(absPath, 'cue', `Sidecar .cue file parse failed: ${_e.message}`, _e.stack);
          }
        }
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-cue`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: { filepath: data.filepath, vpath: loadJson.vpath, cuepoints }
        });
      } catch (_cueErr) {
        await reportError(absPath, 'cue', `Cue update failed: ${_cueErr.message}`, _cueErr.stack);
      }
    }

    if (data._needsDuration) {
      try {
        let duration = null;
        try {
          const parsed = await parseFile(absPath, { skipCovers: true });
          const d = parsed.format?.duration;
          if (d != null && isFinite(d)) { duration = Math.round(d * 1000) / 1000; }
        } catch (_e) {
          await reportError(absPath, 'duration', `Duration parse failed: ${_e.message}`, _e.stack);
        }
        if (duration !== null) {
          await ax({
            method: 'POST',
            url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-duration`,
            headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
            responseType: 'json',
            data: { filepath: data.filepath, vpath: loadJson.vpath, duration }
          });
        }
      } catch (_durErr) {
        await reportError(absPath, 'duration', `Duration update failed: ${_durErr.message}`, _durErr.stack);
      }
    }

    if (data._needsBitrate) {
      try {
        let bitrate = null, sampleRate = null, channels = null;
        try {
          // Use duration:true so FLAC/WAV files return accurate bitrate and duration
          const parsed = await parseFile(absPath, { skipCovers: true, duration: true });
          const fmt = parsed.format || {};
          if (fmt.bitrate != null && isFinite(fmt.bitrate) && fmt.bitrate > 0) {
            bitrate = Math.round(fmt.bitrate / 1000);
          }
          sampleRate = fmt.sampleRate || null;
          channels   = fmt.numberOfChannels || null;
          // Fallback: calculate bitrate from filesize / duration for lossless files
          // where music-metadata does not embed a bitrate value (e.g. some FLAC, WAV)
          if (bitrate == null && fmt.duration > 0) {
            try {
              const { size } = fs.statSync(absPath);
              bitrate = Math.round(size * 8 / fmt.duration / 1000);
            } catch (_) { /* ignore stat errors */ }
          }
        } catch (_e) {
          await reportError(absPath, 'bitrate', `Tech-meta parse failed: ${_e.message}`, _e.stack);
        }
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-tech-meta`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: { filepath: data.filepath, vpath: loadJson.vpath, bitrate, sample_rate: sampleRate, channels }
        });
      } catch (_techErr) {
        await reportError(absPath, 'bitrate', `Tech-meta update failed: ${_techErr.message}`, _techErr.stack);
      }
    }
    await confirmOk(absPath);
  }
}

async function flushBatch() {
  if (_pendingBatch.length === 0) return;
  const batch = _pendingBatch.splice(0);
  let batchResults;
  try {
    const res = await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's' : ''}://localhost:${loadJson.port}/api/v1/scanner/get-files-batch`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: {
        vpath: loadJson.vpath,
        scanId: loadJson.scanId,
        items: batch.map(b => ({ filepath: b.relPath, modTime: b.modTime }))
      }
    });
    batchResults = res.data;
  } catch (_batchErr) {
    // If the batch endpoint itself fails, report errors for all files in the batch
    for (const b of batch) {
      await reportError(b.absPath, 'insert', `Batch lookup failed: ${_batchErr.message}`, _batchErr.stack);
    }
    return;
  }

  for (const b of batch) {
    try {
      const data = batchResults[b.relPath] ?? {};
      await processFileResult(b.absPath, b.relPath, b.modTime, data);
    } catch (err) {
      console.error(`Warning: failed to add file ${b.absPath} to database: ${err.message}`);
      await reportError(b.absPath, 'insert', err.message, err.stack);
    }
    if (loadJson.pause) await timeout(loadJson.pause);
  }
}

async function recursiveScan(dir) {
  if (process.send) process.send({ dir });
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_err) {
    return;
  }

  for (const file of files) {
    const filepath = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(filepath);
    } catch (_error) {
      // Bad file, ignore and continue
      continue;
    }

    if (stat.isDirectory()) {
      if (loadJson.otherRoots.includes(filepath)) { continue; }
      if (loadJson.excludedPaths.includes(filepath)) { continue; }
      await recursiveScan(filepath);
    } else if (stat.isFile()) {
      if (!loadJson.supportedFiles[getFileType(file).toLowerCase()]) { continue; }
      _pendingBatch.push({ absPath: filepath, relPath: path.relative(loadJson.directory, filepath), modTime: stat.mtime.getTime() });
      _totalSeen++;
      if (_pendingBatch.length >= SCAN_BATCH_SIZE) await flushBatch();
    }
  }
}

function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parse a sidecar .cue file alongside an audio file.
// Returns [{no, title, t}] (t = seconds) or null.
// Only applies to single-FILE cue sheets where the FILE entry matches this audio file.
function parseSidecarCue(audioFilePath) {
  const dir  = path.dirname(audioFilePath);
  const base = path.basename(audioFilePath, path.extname(audioFilePath));

  // Prefer exact-basename match, then fall back to sole .cue in the directory
  let cuePath = path.join(dir, base + '.cue');
  if (!fs.existsSync(cuePath)) {
    let cueFiles;
    try { cueFiles = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.cue')); } catch (_e) { return null; }
    if (cueFiles.length !== 1) return null;
    cuePath = path.join(dir, cueFiles[0]);
  }

  let content;
  try { content = fs.readFileSync(cuePath, 'utf8'); } catch (_e) { return null; }

  // Only handle single-FILE cue sheets whose FILE line references this audio file
  const fileLines = [...content.matchAll(/^FILE\s+"([^"]+)"/gim)];
  if (fileLines.length !== 1) return null;
  const cueRef = path.basename(fileLines[0][1]);
  if (cueRef.toLowerCase() !== path.basename(audioFilePath).toLowerCase()) return null;

  // Parse TRACK / TITLE / INDEX 01 MM:SS:FF
  const tracks = [];
  let cur = null;
  for (const line of content.split(/\r?\n/)) {
    const trackM = line.match(/^\s*TRACK\s+(\d+)\s+AUDIO/i);
    if (trackM) { cur = { no: parseInt(trackM[1], 10), title: null }; continue; }
    if (!cur) continue;
    const titleM = line.match(/^\s*TITLE\s+"(.*)"/i);
    if (titleM) { cur.title = titleM[1]; continue; }
    const idxM = line.match(/^\s*INDEX\s+01\s+(\d+):(\d+):(\d+)/i);
    if (idxM) {
      const t = parseInt(idxM[1], 10) * 60 + parseInt(idxM[2], 10) + parseInt(idxM[3], 10) / 75;
      tracks.push({ no: cur.no, title: cur.title, t: Math.round(t * 100) / 100 });
      cur = null;
    }
  }
  return tracks.length > 1 ? tracks : null;
}

// Returns a promise that rejects after `ms` milliseconds with a timeout error.
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

const PARSE_TIMEOUT_MS = 30000; // 30 s — enough for any normal file; hangs abort cleanly

async function parseMyFile(thisSong, modified) {
  let songInfo, fmtInfo = {};
  try {
    const parsed = await withTimeout(
      parseFile(thisSong, { skipCovers: loadJson.skipImg }),
      PARSE_TIMEOUT_MS
    );
    songInfo = parsed.common;
    fmtInfo = parsed.format || {};
  } catch (err) {
    // If the error is in the embedded picture block, retry without covers to
    // still recover text tags (title, artist, album, year, track, etc.)
    if (!loadJson.skipImg) {
      try {
        const fallback = await withTimeout(
          parseFile(thisSong, { skipCovers: true }),
          PARSE_TIMEOUT_MS
        );
        songInfo = fallback.common;
        fmtInfo = fallback.format || {};
        console.error(`Warning: metadata parse error (covers skipped) on ${thisSong}: ${err.message}`);
        await reportError(thisSong, 'parse', err.message, err.stack);
      } catch (err2) {
        console.error(`Warning: metadata parse error on ${thisSong}: ${err2.message}`);
        await reportError(thisSong, 'parse', err2.message, err2.stack);
        songInfo = {track: { no: null, of: null }, disk: { no: null, of: null }};
      }
    } else {
      console.error(`Warning: metadata parse error on ${thisSong}: ${err.message}`);
      await reportError(thisSong, 'parse', err.message, err.stack);
      songInfo = {track: { no: null, of: null }, disk: { no: null, of: null }};
    }
  }

  songInfo.modified = modified;
  songInfo.filePath = path.relative(loadJson.directory, thisSong);
  songInfo.format = getFileType(thisSong);
  // duration from format block (seconds, float) — e.g. 237.43
  songInfo._duration = (fmtInfo.duration != null && isFinite(fmtInfo.duration))
    ? Math.round(fmtInfo.duration * 1000) / 1000
    : null;
  // audio technical metadata — bitrate (stored as kbps integer), sample rate (Hz), channels
  songInfo._bitrate    = (fmtInfo.bitrate != null && isFinite(fmtInfo.bitrate) && fmtInfo.bitrate > 0)
    ? Math.round(fmtInfo.bitrate / 1000) : null;
  songInfo._sampleRate = fmtInfo.sampleRate || null;
  songInfo._channels   = fmtInfo.numberOfChannels || null;

  // ── Folder-name fallback for missing tags ─────────────────────────────────
  // When a file has no embedded artist/album/title tags the parent folder name
  // is usually "Artist - Release info …" (dash or en-dash separator).
  // Extract the artist from the first segment and derive title from filename.
  //
  // NOTE: This writes ONLY to the mStream database — the audio files on disk
  // are never modified. Derived values survive rescans: if a file is unchanged
  // on disk the scanner skips full re-parsing and the DB values are preserved.
  // Only files whose content changes (new modTime/hash) trigger a re-parse,
  // which will re-derive the same values if no embedded tags are found.
  if (!songInfo.artist && !songInfo.albumartist) {
    const segments = songInfo.filePath.split('/');
    const parentFolder = segments.length >= 2 ? segments[segments.length - 2] : null;
    if (parentFolder) {
      const m = parentFolder.match(/^(.+?)\s+[-–]\s+/);
      if (m) songInfo.artist = m[1].trim();
    }
  }
  if (!songInfo.album) {
    const segments = songInfo.filePath.split('/');
    const parentFolder = segments.length >= 2 ? segments[segments.length - 2] : null;
    if (parentFolder) {
      // Album = everything before the catalogue number at the end (SP5-… / -cd- etc.)
      const clean = parentFolder.replace(/\s*[-–]\s*(SP\d[-\d]*|[A-Z]{2,}-\d[\w-]*|-cd-|-\d+).*$/i, '').trim();
      songInfo.album = clean;
    }
  }
  if (!songInfo.title) {
    // Title = filename without extension, stripped of leading track numbers
    const base = path.basename(thisSong, path.extname(thisSong));
    songInfo.title = base.replace(/^[\d\s._-]+/, '').trim() || base;
  }
  // ────────────────────────────────────────────────────────────────────────────

  try {
    songInfo.hash = await withTimeout(calculateHash(thisSong), PARSE_TIMEOUT_MS);
  } catch (err) {
    console.error(`Warning: hash failed on ${thisSong}: ${err.message}`);
    await reportError(thisSong, 'parse', `Hash failed: ${err.message}`, err.stack);
    songInfo.hash = null;
  }

  // Extract embedded cue sheet (present in single-file FLAC/WAV album rips)
  try {
    const cue = songInfo.cuesheet;
    const sampleRate = fmtInfo.sampleRate || null;
    if (cue && Array.isArray(cue.tracks) && cue.tracks.length && sampleRate) {
      const cuePoints = [];
      for (const t of cue.tracks) {
        if (t.number === 170) continue; // 0xAA = lead-out marker
        const idx1 = Array.isArray(t.indexes) && t.indexes.find(i => i.number === 1);
        if (!idx1) continue;
        const seconds = idx1.offset / sampleRate;
        cuePoints.push({ no: t.number, title: t.title || null, t: Math.round(seconds * 100) / 100 });
      }
      if (cuePoints.length > 1) {
        songInfo.cuepoints = JSON.stringify(cuePoints);
      }
    }
  } catch (_e) {
    // non-critical — embedded cue extraction failed
    await reportError(thisSong, 'cue', `Embedded cue sheet parse failed: ${_e.message}`, _e.stack);
  }

  // Fallback: sidecar .cue file alongside the audio file
  if (!songInfo.cuepoints) {
    try {
      const sidecar = parseSidecarCue(thisSong);
      if (sidecar) songInfo.cuepoints = JSON.stringify(sidecar);
    } catch (_e) {
      // non-critical
      await reportError(thisSong, 'cue', `Sidecar .cue file parse failed: ${_e.message}`, _e.stack);
    }
  }

  await getAlbumArt(songInfo);
  return songInfo;
}

// Maximum bytes read when hashing — first 512 KB is sufficient for change
// detection and uniqueness. Avoids 30-s timeouts on large single-file mixes.
const HASH_READ_LIMIT = 524288; // 512 KB

function calculateHash(filepath) {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('md5').setEncoding('hex');
      const fileStream = fs.createReadStream(filepath, { start: 0, end: HASH_READ_LIMIT - 1 });

      fileStream.on('error', (err) => {
        reject(err);
      });
  
      fileStream.on('end', () => {
        hash.end();
        fileStream.close();
        resolve(hash.read());
      });
  
      fileStream.pipe(hash);
    }catch(err) {
      reject(err);
    }
  });
}

async function getAlbumArt(songInfo) {
  if (loadJson.skipImg === true) { return; }

  let originalFileBuffer;

  // picture is stored in song metadata
  if (songInfo.picture && songInfo.picture[0]) {
    // Prefer the Front Cover (type 3 / 'Cover (front)') over whatever [0] happens to be.
    // FLAC files with both ID3 and Vorbis tag blocks can have multiple picture entries
    // in arbitrary order; picking by type avoids using a back cover or artist photo.
    const frontCover = songInfo.picture.find(p => p.type === 'Cover (front)') || songInfo.picture[0];
    // Generate unique name based off hash of album art and metadata
    const picHashString = crypto.createHash('md5').update(frontCover.data).digest('hex');
    // mime-types returns 'jpeg' for image/jpeg — normalise to 'jpg' so filenames
    // are consistent with what the Discogs embed endpoint writes (.jpg hardcoded).
    const _rawExt = mime.extension(frontCover.format);
    const _normExt = (_rawExt === 'jpeg') ? 'jpg' : (_rawExt || 'jpg');
    songInfo.aaFile = picHashString + '.' + _normExt;
    songInfo._artSource = 'embedded';
    // Check image-cache folder for filename and save if doesn't exist
    if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
      // Save file sync
      fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), frontCover.data);
      originalFileBuffer = Buffer.from(frontCover.data);
    }
  } else {
    originalFileBuffer = await checkDirectoryForAlbumArt(songInfo);
    if (songInfo.aaFile) { songInfo._artSource = 'directory'; }
  }

  if (originalFileBuffer) {
    try {
      await compressAlbumArt(originalFileBuffer, songInfo.aaFile);
    } catch (err) {
      // sharp couldn't decode the image (e.g. corrupted embedded PNG/JPEG).
      // The original is already on disk; copy it as a fallback thumbnail so
      // art still displays. Don't report a scan error — the user can't fix a
      // corrupted embedded image and the error would persist every rescan.
      try {
        const zlPath = path.join(loadJson.albumArtDirectory, 'zl-' + songInfo.aaFile);
        const zsPath = path.join(loadJson.albumArtDirectory, 'zs-' + songInfo.aaFile);
        if (!fs.existsSync(zlPath)) { fs.writeFileSync(zlPath, originalFileBuffer); }
        if (!fs.existsSync(zsPath)) { fs.writeFileSync(zsPath, originalFileBuffer); }
      } catch (_) { /* ignore fallback failure */ }
      console.warn(`Warning: could not compress album art for ${songInfo.filePath} (${err.message}) — using original`);
    }
  }
}

async function compressAlbumArt(buff, imgName) {
  if (loadJson.compressImage === false) { return; }
  if (buff.length < 100) { return; } // guard against malformed micro-buffers (file-type CVE workaround)

  await sharp(buff).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).toFile(path.join(loadJson.albumArtDirectory, 'zl-' + imgName));
  await sharp(buff).resize(92,  92,  { fit: 'inside', withoutEnlargement: true }).toFile(path.join(loadJson.albumArtDirectory, 'zs-' + imgName));
  await sharp(buff).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).toFile(path.join(loadJson.albumArtDirectory, 'zm-' + imgName));
}

const mapOfDirectoryAlbumArt = {};
function checkDirectoryForAlbumArt(songInfo) {
  const directory = path.join(loadJson.directory, path.dirname(songInfo.filePath));

  // album art has already been found
  if (mapOfDirectoryAlbumArt[directory]) {
    songInfo.aaFile = mapOfDirectoryAlbumArt[directory];
    return; // File already exists, no need to compress again
  }

  // directory was already scanned and nothing was found
  if (mapOfDirectoryAlbumArt[directory] === false) { return; }

  const imageArray = [];
  let files;
  try {
    files = fs.readdirSync(directory);
  } catch (_err) {
    return;
  }

  for (const file of files) {
    const filepath = path.join(directory, file);
    let stat;
    try {
      stat = fs.statSync(filepath);
    } catch (_error) {
      // Bad file, ignore and continue
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }

    if (["png", "jpg"].indexOf(getFileType(file)) === -1) {
      continue;
    }

    imageArray.push(file);
  }

  if (imageArray.length === 0) {
    // No images directly in this directory — check common artwork subdirectories
    const artworkSubdirNames = ['artwork', 'scans', 'covers', 'images', 'art', 'cover', 'scan'];
    for (const file of files) {
      const subDirPath = path.join(directory, file);
      let subDirStat;
      try { subDirStat = fs.statSync(subDirPath); } catch { continue; }
      if (!subDirStat.isDirectory()) continue;
      if (!artworkSubdirNames.includes(file.toLowerCase())) continue;

      let subFiles;
      try { subFiles = fs.readdirSync(subDirPath); } catch { continue; }
      for (const subFile of subFiles) {
        const ext = getFileType(subFile).toLowerCase();
        if (ext !== 'jpg' && ext !== 'png') continue;
        let subStat;
        try { subStat = fs.statSync(path.join(subDirPath, subFile)); } catch { continue; }
        if (!subStat.isFile()) continue;
        imageArray.push(path.join(file, subFile)); // e.g. "artwork/front.jpg"
      }
      if (imageArray.length > 0) break;
    }

    if (imageArray.length === 0) {
      return mapOfDirectoryAlbumArt[directory] = false;
    }
  }

  let imageBuffer;
  let picFormat;
  let selectedImageFile = null;
  let newFileFlag = false;

  // Search for a named file
  for (let i = 0; i < imageArray.length; i++) {
    const imgMod = imageArray[i].toLowerCase();
    if (imgMod === 'folder.jpg' || imgMod === 'cover.jpg' || imgMod === 'album.jpg' || imgMod === 'front.jpg' || imgMod === 'folder.png' || imgMod === 'cover.png' || imgMod === 'album.png' || imgMod === 'front.png') {
      try {
        imageBuffer = fs.readFileSync(path.join(directory, imageArray[i]));
        picFormat = getFileType(imageArray[i]);
        selectedImageFile = imageArray[i];
      } catch (err) {
        console.error(`Warning: failed to read album art file ${imageArray[i]}: ${err.message}`);
      }
      break;
    }
  }
  
  // default to first file if none are named
  if (!imageBuffer) {
    try {
      imageBuffer = fs.readFileSync(path.join(directory, imageArray[0]));
      picFormat = getFileType(imageArray[0]);
      selectedImageFile = imageArray[0];
    } catch (err) {
      console.error(`Warning: failed to read album art file ${imageArray[0]}: ${err.message}`);
    }
  }

  // If we still have no buffer (all reads failed or resulted in empty data), bail out
  if (!imageBuffer || imageBuffer.length === 0) {
    return mapOfDirectoryAlbumArt[directory] = false;
  }

  const picHashString = crypto.createHash('md5').update(imageBuffer).digest('hex');
  songInfo.aaFile = picHashString + '.' + picFormat;
  if (selectedImageFile) songInfo._coverFile = selectedImageFile;
  // Check image-cache folder for filename and save if doesn't exist
  if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
    // Save file sync
    fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), imageBuffer);
    newFileFlag = true;
  }

  mapOfDirectoryAlbumArt[directory] = songInfo.aaFile;

  if (newFileFlag === true) { return imageBuffer; }
}

function getFileType(filename) {
  return filename.split(".").pop();
}