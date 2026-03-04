import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { getVPathInfo } from '../util/vpath.js';
import WebError from '../util/web-error.js';

// Number of RMS sample points returned (matches expected canvas width)
const POINTS = 800;

// Audio sample rate for PCM extraction — 200 Hz is sufficient for a
// full-track waveform overview even for tracks longer than 1 hour
const SAMPLE_RATE = 200;

/**
 * Downsample a Float32Array of PCM amplitudes into `count` averaged points,
 * normalised to 0–255 integers.
 */
function downsample(data, count) {
  const total = data.length;
  if (total === 0) return new Array(count).fill(0);
  const result = new Array(count);
  const chunkSize = total / count;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * chunkSize);
    const end   = Math.min(total, Math.floor((i + 1) * chunkSize));
    let sum = 0;
    for (let j = start; j < end; j++) sum += Math.abs(data[j]);
    result[i] = end > start ? sum / (end - start) : 0;
  }
  const max = Math.max(...result, 1e-6);
  return result.map(v => Math.round((v / max) * 255));
}

export function setup(mstream) {
  mstream.get('/api/v1/db/waveform', async (req, res) => {
    if (!req.query.filepath) throw new WebError('Missing filepath', 400);

    let pathInfo;
    try {
      pathInfo = getVPathInfo(req.query.filepath, req.user);
    } catch (_e) {
      throw new WebError('Access denied or file not found', 403);
    }

    // Primary DB lookup (file indexed under this vpath)
    let fileRow = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);

    // Fallback: file may be indexed under a different (parent) vpath.
    // E.g. vpath "12-inches" → /media/music/12 inches A-Z is a sub-dir of
    // vpath "Music" → /media/music, so the DB row lives under Music.
    // Iterate all folder roots to find the one that owns this physical path,
    // then re-do the lookup with the correct vpath + relativePath.
    if (!fileRow) {
      const allFolders = config.program.folders || {};
      for (const [fvpath, folder] of Object.entries(allFolders)) {
        if (fvpath === pathInfo.vpath) continue;   // already tried this one
        const root = folder.root;
        const normRoot = root.endsWith(path.sep) ? root : root + path.sep;
        if (pathInfo.fullPath.startsWith(normRoot)) {
          const rel = path.relative(root, pathInfo.fullPath);
          fileRow = db.findFileByPath(rel, fvpath);
          if (fileRow) break;
        }
      }
    }

    // Last resort: confirm the physical file at least exists on disk
    if (!fileRow && !fs.existsSync(pathInfo.fullPath)) {
      throw new WebError('File not found', 404);
    }

    // Cache in the album-art directory.
    // Prefer the DB hash (content-based, shareable across vpaths/duplicates).
    // Fall back to md5(fullPath) only when the file isn't indexed at all.
    const cacheDir  = config.program.storage.albumArtDirectory;
    const cacheHash = fileRow?.hash ?? crypto.createHash('md5').update(pathInfo.fullPath).digest('hex');
    const cacheKey  = `wf-${cacheHash}.json`;
    const cachePath = path.join(cacheDir, cacheKey);

    if (cachePath && fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        return res.json({ waveform: cached });
      } catch (_e) { /* corrupt cache — fall through to regenerate */ }
    }

    // Locate ffmpeg binary (same directory used by transcode module)
    const binaryExt  = process.platform === 'win32' ? '.exe' : '';
    const ffmpegDir  = config.program.transcode?.ffmpegDirectory;
    const ffmpegPath = ffmpegDir
      ? path.join(ffmpegDir, `ffmpeg${binaryExt}`)
      : null;

    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      throw new WebError(
        'FFmpeg not available — enable transcoding in config to use the waveform scrubber',
        503
      );
    }

    // Run ffmpeg: decode to mono f32le PCM at SAMPLE_RATE Hz, pipe stdout
    const chunks = [];
    await new Promise((resolve, reject) => {
      const stream = ffmpeg(pathInfo.fullPath)
        .setFfmpegPath(ffmpegPath)
        .noVideo()
        .audioChannels(1)
        .audioFrequency(SAMPLE_RATE)
        .format('f32le')
        .on('error', reject)
        .pipe();   // returns a PassThrough stream

      stream.on('data',  chunk => chunks.push(chunk));
      stream.on('end',   resolve);
      stream.on('error', reject);
    });

    const buf      = Buffer.concat(chunks);
    const f32      = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    const waveform = downsample(f32, POINTS);

    // Persist to cache
    if (cachePath) {
      try { fs.writeFileSync(cachePath, JSON.stringify(waveform)); } catch (_e) {}
    }

    res.json({ waveform });
  });
}
