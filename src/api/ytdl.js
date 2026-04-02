import fsp from 'node:fs/promises';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import { ensureFfmpeg, getFfmpegDir } from '../util/ffmpeg-bootstrap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binaryExt = process.platform === 'win32' ? '.exe' : '';

const BUNDLED_YTDLP = path.join(__dirname, '../../bin/yt-dlp/yt-dlp' + binaryExt);

// Map platform+arch to the correct yt-dlp release asset name
function _ytdlpReleaseAsset() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  const arch = process.arch;
  if (process.platform === 'darwin') {
    return arch === 'arm64' ? 'yt-dlp_macos' : 'yt-dlp_macos_legacy';
  }
  // Linux
  if (arch === 'arm64' || arch === 'aarch64') return 'yt-dlp_linux_aarch64';
  if (arch === 'arm')                          return 'yt-dlp_linux_armv7l';
  return 'yt-dlp_linux'; // x86_64 + musl (works on Alpine)
}

// Download a URL following redirects, save to destPath, make executable.
function _downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, { headers: { 'User-Agent': 'mstream-ytdlp-installer' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} downloading yt-dlp`));
        }
        const tmp = destPath + '.tmp';
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', async () => {
          try {
            await fsp.chmod(tmp, 0o755);
            await fsp.rename(tmp, destPath);
            resolve();
          } catch (e) { reject(e); }
        });
        out.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

// Ensure yt-dlp binary is present, downloading it if needed.
// Safe to call multiple times; only downloads once.
let _ytdlpReady = null;
async function _ensureYtdlp() {
  if (_ytdlpReady) return _ytdlpReady;
  _ytdlpReady = (async () => {
    try {
      await fsp.access(BUNDLED_YTDLP, fs.constants.X_OK);
      // Also reject 0-byte files (failed download baked into image)
      const stat = await fsp.stat(BUNDLED_YTDLP);
      if (stat.size > 0) return BUNDLED_YTDLP; // exists, executable, non-empty
      // 0-byte — delete and re-download
      await fsp.unlink(BUNDLED_YTDLP).catch(() => {});
    } catch (e) {
      // File exists but not executable — chmod it and return
      if (e.code === 'EACCES') {
        await fsp.chmod(BUNDLED_YTDLP, 0o755);
        return BUNDLED_YTDLP;
      }
      // File missing — fall through to download
    }

    const asset = _ytdlpReleaseAsset();
    const url   = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
    winston.info(`yt-dlp not found or empty — downloading ${asset}…`);
    await fsp.mkdir(path.dirname(BUNDLED_YTDLP), { recursive: true });
    await _downloadFile(url, BUNDLED_YTDLP);
    await fsp.chmod(BUNDLED_YTDLP, 0o755);
    winston.info('yt-dlp downloaded successfully');
    return BUNDLED_YTDLP;
  })().catch(e => {
    _ytdlpReady = null; // allow retry on next call
    throw e;
  });
  return _ytdlpReady;
}

async function _ytdlpBin() {
  try { return await _ensureYtdlp(); } catch (e) {
    winston.warn('yt-dlp auto-download failed: ' + e.message + ' — falling back to system PATH');
    return 'yt-dlp';
  }
}

function _ffmpegDir() {
  return getFfmpegDir();
}

function _ffmpegBin() {
  return path.join(_ffmpegDir(), `ffmpeg${binaryExt}`);
}

function _getUserRecordingFolder(user) {
  const folders = config.program.folders || {};
  const accessible = user.vpaths || [];
  // Prefer a dedicated 'youtube' folder; fall back to 'recordings' if none configured
  for (const vpath of accessible) {
    const f = folders[vpath];
    if (f && f.type === 'youtube') return { vpath, root: f.root };
  }
  for (const vpath of accessible) {
    const f = folders[vpath];
    if (f && f.type === 'recordings') return { vpath, root: f.root };
  }
  return null;
}

// Strip common YouTube title noise and split "Artist - Title"
function _parseTitle(rawTitle, channelName) {
  let artist = channelName || '';
  let title  = rawTitle    || '';

  const dashIdx = title.indexOf(' - ');
  if (dashIdx > 0) {
    artist = title.slice(0, dashIdx).trim();
    title  = title.slice(dashIdx + 3).trim();
  }

  // Strip common video suffixes
  title = title
    .replace(/\s*\(Official\s+(Video|Audio|Music\s+Video|Lyric\s+Video|Visualizer)\)/gi, '')
    .replace(/\s*\[Official\s+(Video|Audio|Music\s+Video)\]/gi, '')
    .replace(/\s*\(Lyrics?\)/gi, '')
    .replace(/\s*\[Lyrics?\]/gi, '')
    .replace(/\s*\(HD\)/gi, '')
    .replace(/\s*\[HD\]/gi, '')
    .replace(/\s*\(4K\)/gi, '')
    .replace(/\s*\(Audio\)/gi, '')
    .replace(/\s*ft\.?\s+[^([\n]+/i, '')
    .replace(/\s*feat\.?\s+[^([\n]+/i, '')
    .trim();

  return { artist, title };
}

// Run yt-dlp --dump-json and return parsed metadata object
async function _ytdlpInfo(url, ytdlp, ffmpegDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytdlp, [
      '--dump-json', '--no-playlist', '--no-warnings', '--quiet',
      '--ffmpeg-location', ffmpegDir,
      '--', url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || `yt-dlp exited with code ${code}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Failed to parse yt-dlp output')); }
    });
    proc.on('error', reject);
  });
}

// Download audio + thumbnail via yt-dlp into tmpDir using 'track' as the base name.
// Produces: tmpDir/track.<ext>  and  tmpDir/track.jpg
async function _ytdlpDownload(url, tmpDir, format, ffmpegDir, ytdlp) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytdlp, [
      '-x', '--audio-format', format,
      '--write-thumbnail', '--convert-thumbnails', 'jpg',
      '--no-playlist', '--no-warnings', '--quiet', '--no-part',
      '--ffmpeg-location', ffmpegDir,
      '-o', path.join(tmpDir, 'track.%(ext)s'),
      '--', url,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `yt-dlp download failed with code ${code}`));
    });
    proc.on('error', reject);
  });
}

// Build a METADATA_BLOCK_PICTURE binary block (FLAC/Vorbis spec) from a JPEG file.
// Opus stores cover art as a base64-encoded version of this structure in a Vorbis
// comment named METADATA_BLOCK_PICTURE — no video stream mapping needed or supported.
async function _buildMetadataBlockPicture(jpegPath) {
  const imageData = await fsp.readFile(jpegPath);
  const mime = Buffer.from('image/jpeg', 'utf8');
  const desc = Buffer.alloc(0);
  const buf  = Buffer.allocUnsafe(4 + 4 + mime.length + 4 + desc.length + 4 + 4 + 4 + 4 + 4 + imageData.length);
  let o = 0;
  buf.writeUInt32BE(3, o);           o += 4; // picture type: 3 = front cover
  buf.writeUInt32BE(mime.length, o); o += 4;
  mime.copy(buf, o);                 o += mime.length;
  buf.writeUInt32BE(desc.length, o); o += 4;
  desc.copy(buf, o);                 o += desc.length;
  buf.writeUInt32BE(0, o);           o += 4; // width  (0 = unknown)
  buf.writeUInt32BE(0, o);           o += 4; // height (0 = unknown)
  buf.writeUInt32BE(0, o);           o += 4; // colour depth (0 = unknown)
  buf.writeUInt32BE(0, o);           o += 4; // colours used (0 = unknown)
  buf.writeUInt32BE(imageData.length, o); o += 4;
  imageData.copy(buf, o);
  return buf.toString('base64');
}

// Re-tag audio file using ffmpeg codec-copy (no re-encode), write to outputFile.
//   MP3  — art embedded as ID3 attached_pic via mjpeg re-encode (proper PTS required)
//   Opus — art injected as METADATA_BLOCK_PICTURE Vorbis comment (no stream mapping)
async function _ffmpegTag(inputFile, outputFile, { title, artist, album, year, thumbFile }) {
  const ffmpeg = _ffmpegBin();
  try { await fsp.access(ffmpeg); } catch {
    await fsp.rename(inputFile, outputFile);
    return;
  }

  const ismp3  = outputFile.toLowerCase().endsWith('.mp3');
  const isopus = outputFile.toLowerCase().endsWith('.opus');

  // Build arg list
  const args = ['-i', inputFile];

  if (thumbFile && ismp3) {
    // MP3: embed as video stream with mjpeg re-encode so the JPEG gets proper PTS
    args.push('-i', thumbFile,
      '-map', '0:a', '-map', '1:v',
      '-c:a', 'copy', '-c:v', 'mjpeg',
      '-id3v2_version', '3', '-disposition:v:0', 'attached_pic');
  } else {
    args.push('-map', '0:a', '-c:a', 'copy');
  }

  if (title)  args.push('-metadata', `title=${title}`);
  if (artist) args.push('-metadata', `artist=${artist}`);
  if (album)  args.push('-metadata', `album=${album}`);
  if (year)   args.push('-metadata', `date=${year}`);

  // Opus: inject cover art as a Vorbis METADATA_BLOCK_PICTURE comment (base64-encoded
  // binary block per FLAC/Vorbis spec). No video stream mapping — the Opus container
  // does not support video streams.
  if (thumbFile && isopus) {
    const mbp = await _buildMetadataBlockPicture(thumbFile);
    args.push('-metadata', `METADATA_BLOCK_PICTURE=${mbp}`);
  }

  args.push('-y', outputFile);

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg tagging failed (code ${code}): ${err.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

async function _updateYtdlp() {
  let bin;
  try { bin = await _ensureYtdlp(); } catch { return; }
  return new Promise(resolve => {
    const proc = spawn(bin, ['--update'], { stdio: 'pipe' });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    proc.on('close', code => {
      const trimmed = out.trim().split('\n').pop() || '';
      if (trimmed) winston.info('yt-dlp update: ' + trimmed);
      if (code !== 0) winston.warn('yt-dlp --update exited ' + code);
      resolve();
    });
    proc.on('error', e => { winston.warn('yt-dlp --update error: ' + e.message); resolve(); });
  });
}

export function setup(mstream) {
  // Ensure yt-dlp and ffmpeg binaries are present — both non-blocking.
  _ensureYtdlp()
    .then(() => _updateYtdlp())
    .catch(e => winston.warn('yt-dlp prefetch/update failed: ' + e.message));
  ensureFfmpeg()
    .catch(e => winston.warn('ffmpeg prefetch failed: ' + e.message));

  // ── GET /api/v1/ytdl/info?url=... ──────────────────────────────────────────
  mstream.get('/api/v1/ytdl/info', async (req, res) => {
    if (!req.user['allow-youtube-download']) {
      return res.status(403).json({ error: 'YouTube download not enabled for this user' });
    }
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: 'url required' });
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs are supported' });
    }
    try {
      const ytdlp = await _ytdlpBin();
      const info  = await _ytdlpInfo(rawUrl, ytdlp, _ffmpegDir());
      const { artist, title } = _parseTitle(info.title || '', info.artist || info.uploader || info.channel || '');
      const year  = info.upload_date ? info.upload_date.slice(0, 4) : '';
      const thumb = info.thumbnail || null;
      res.json({ title, artist, album: '', year, thumb });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Failed to fetch video info' });
    }
  });

  // ── POST /api/v1/ytdl/download ─────────────────────────────────────────────
  mstream.post('/api/v1/ytdl/download', async (req, res) => {
    if (!req.user['allow-youtube-download']) {
      return res.status(403).json({ error: 'YouTube download not enabled for this user' });
    }
    const schema = Joi.object({
      url:    Joi.string().required(),
      title:  Joi.string().max(200).required(),
      artist: Joi.string().max(200).allow('').optional(),
      album:  Joi.string().max(200).allow('').optional(),
      year:   Joi.string().max(4).allow('').optional(),
      format: Joi.string().valid('opus', 'mp3').default('opus'),
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    let parsedUrl;
    try { parsedUrl = new URL(value.url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs are supported' });
    }
    const recFolder = _getUserRecordingFolder(req.user);
    if (!recFolder) {
      return res.status(400).json({ error: 'No recordings folder configured and accessible. Set a folder type to "recordings" in Admin → Folders.' });
    }

    const safePart = (s) => (s || '').replace(/[\/\\?%*:|"<>]/g, '_').trim();
    const safeTitle  = safePart(value.title)  || 'track';
    const safeArtist = safePart(value.artist);
    const baseName   = safeArtist ? `${safeArtist} - ${safeTitle}`.slice(0, 200) : safeTitle.slice(0, 200);
    const ext = value.format === 'mp3' ? 'mp3' : 'opus';

    // Find a non-colliding final output path
    let finalFile = path.join(recFolder.root, `${baseName}.${ext}`);
    let suffix = 1;
    while (true) {
      try { await fsp.access(finalFile); finalFile = path.join(recFolder.root, `${baseName}_${suffix}.${ext}`); suffix++; }
      catch { break; }
    }

    await fsp.mkdir(recFolder.root, { recursive: true });

    // All temp files go to a private dir in os.tmpdir() — nothing lands in the music folder
    // until the final rename. The entire tmpDir is removed in the finally block.
    const tmpDir  = await fsp.mkdtemp(path.join(os.tmpdir(), 'mstream-ytdl-'));
    const tmpFile = path.join(tmpDir, `track.${ext}`);
    const tmpThumb = path.join(tmpDir, 'track.jpg');

    try {
      const ytdlp     = await _ytdlpBin();
      const ffmpegDir = _ffmpegDir();

      await _ytdlpDownload(value.url, tmpDir, ext, ffmpegDir, ytdlp);

      const hasThumb = await fsp.access(tmpThumb).then(() => true).catch(() => false);

      // Tag + embed art via ffmpeg (codec-copy, no re-encode), output directly to finalFile
      await _ffmpegTag(tmpFile, finalFile, {
        title: value.title, artist: value.artist, album: value.album, year: value.year,
        thumbFile: hasThumb ? tmpThumb : null,
      });

      res.json({ filePath: path.basename(finalFile), vpath: recFolder.vpath });
    } catch (err) {
      await fsp.unlink(finalFile).catch(() => {});
      if (!res.headersSent) res.status(500).json({ error: err.message || 'Download failed' });
    } finally {
      // Always wipe the temp dir — no stray files ever in the music folder
      fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}
