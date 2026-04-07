import archiver from 'archiver';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import crypto from 'crypto';
import { parseFile } from 'music-metadata';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as vpath from '../util/vpath.js';
import * as shared from '../api/shared.js';
import * as m3u from '../util/m3u.js';
import WebError from '../util/web-error.js';

export function setup(mstream) {
  mstream.post('/api/v1/download/m3u', (req, res) => {
    // custom wrap download functions to avoid an error with the archiver module
    downloadM3U(req, res).catch(err  => {
      throw err;
    })
  });

  async function downloadM3U(req, res) {
    if (!req.body.path) { throw new WebError('Validation Error', 403); }
    const pathInfo = vpath.getVPathInfo(req.body.path, req.user);
    const playlistParentDir = path.dirname(pathInfo.fullPath);
    const songs = await m3u.readPlaylistSongs(pathInfo.fullPath);

    const archive = archiver('zip');
    archive.on('error', function (err) {
      winston.error('Download Error', { stack: err });
      res.status(500).json({ error: err.message });
    });

    res.attachment(`${path.basename(req.body.path)}.zip`);
    archive.pipe(res);
    const normalizedBase = pathInfo.basePath.endsWith(path.sep) ? pathInfo.basePath : pathInfo.basePath + path.sep;
    for (const song of songs) {
      const songPath = path.resolve(playlistParentDir, song);
      if (songPath !== pathInfo.basePath && !songPath.startsWith(normalizedBase)) {
        winston.warn(`M3U entry escaped library root: ${song}`);
        continue;
      }
      archive.file(songPath, { name: path.basename(song) });
    }

    archive.file(pathInfo.fullPath, { name: path.basename(pathInfo.fullPath) });
    archive.finalize();
  }

  mstream.post('/api/v1/download/directory',  (req, res) => {
    downloadDir(req, res).catch(err => {
      throw err;
    })
  });

  async function downloadDir(req, res) {
    if (!req.body.directory) { throw new WebError('Validation Error', 403); }

    const pathInfo = vpath.getVPathInfo(req.body.directory, req.user);
    if (!(await fs.stat(pathInfo.fullPath)).isDirectory()) { throw new Error('Not A Directory'); }

    const archive = archiver('zip');
    archive.on('error', (err) => {
      winston.error('Download Error', { stack: err })
      res.status(500).json({ error: 'Download Error' });
    });

    res.attachment('mstream-directory.zip');

    archive.pipe(res);

    archive.directory(pathInfo.basePath, false);
    archive.finalize();
  }

  mstream.get('/api/v1/download/shared', (req, res) => {
    if (!req.sharedPlaylistId) { throw new WebError('Missing Playlist Id', 403); }
    const fileArray = shared.lookupPlaylist(req.sharedPlaylistId).playlist;
    download(req, res, fileArray, 'mstream-shared').catch(err => {
      throw err;
    });
  });

  mstream.post('/api/v1/download/zip', (req, res) => {
    const fileArray = JSON.parse(req.body.fileArray);
    const filename = (req.body.filename || 'mstream-download').replace(/[/\\:*?"<>|]/g, '_').slice(0, 120);
    download(req, res, fileArray, filename).catch(err => {
      throw err;
    });
  });

  async function download(req, res, fileArray, filename = 'mstream-download') {
    const maxMb    = config.program.scanOptions.maxZipMb || 500;
    const maxBytes = maxMb * 1024 * 1024;

    // Pre-flight: resolve paths and check total size before opening the response stream
    let totalBytes = 0;
    const validFiles = [];
    for (const file of fileArray) {
      try {
        const pathInfo = vpath.getVPathInfo(file, req.user);
        const stat = await fs.stat(pathInfo.fullPath);
        totalBytes += stat.size;
        if (totalBytes > maxBytes) {
          return res.status(413).json({
            error: `ZIP would exceed the ${maxMb} MB server limit`,
            maxMb,
            sizeMb: Math.ceil(totalBytes / (1024 * 1024)),
          });
        }
        validFiles.push({ pathInfo, file });
      } catch (err) {
        winston.warn(`Skipping file for ZIP (not accessible): ${file}`);
      }
    }

    if (!validFiles.length) {
      return res.status(404).json({ error: 'No accessible files found' });
    }

    const archive = archiver('zip');

    archive.on('error', err => {
      winston.error('Download Error', { stack: err });
      if (!res.headersSent) res.status(500).json({ error: 'Archive error' });
    });

    res.attachment(`${filename}.zip`);
    archive.pipe(res);

    for (const { pathInfo, file } of validFiles) {
      archive.file(pathInfo.fullPath, { name: path.basename(file) });
    }

    archive.finalize();
  }

  // Delete a recording file from a recordings-type vpath.
  // Only available when the folder has allowRecordDelete=true.
  mstream.delete('/api/v1/files/recording', async (req, res) => {
    const schema = Joi.object({ filepath: Joi.string().required() });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    let pathInfo;
    try {
      pathInfo = vpath.getVPathInfo(value.filepath, req.user);
    } catch (e) {
      return res.status(403).json({ error: e.message });
    }

    const folderCfg = config.program.folders[pathInfo.vpath];
    if (!folderCfg || folderCfg.type !== 'recordings') {
      return res.status(403).json({ error: 'Not a recordings folder' });
    }
    if (!folderCfg.allowRecordDelete) {
      return res.status(403).json({ error: 'Deletion not permitted for this folder' });
    }

    // Only allow deleting audio files (no directory traversal to other types)
    const ext = path.extname(pathInfo.fullPath).toLowerCase().replace('.', '');
    const allowed = config.program.supportedAudioFiles || {};
    if (!allowed[ext]) {
      return res.status(400).json({ error: 'File type not allowed' });
    }

    try {
      await fs.unlink(pathInfo.fullPath);
      winston.info(`Recording deleted by ${req.user.username}: ${pathInfo.fullPath}`);
      res.json({ deleted: true });
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
      winston.error('Failed to delete recording', { stack: e });
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });

  // ── GET /api/v1/files/art?fp=<vpath/filename> ─────────────────────────────
  // Extracts cover art from an audio file (embedded) or a folder image
  // (cover.jpg / folder.jpg / front.jpg etc.) in the same directory.
  // Returns { aaFile: "md5hash.jpg" } which the client can pass to /album-art/.
  // The result is written to the album-art cache directory so subsequent requests
  // (and the scanner) reuse the same cached file — no duplicate writes.
  mstream.get('/api/v1/files/art', async (req, res) => {
    if (!req.query.fp) return res.status(400).json({ error: 'fp required' });

    let pathInfo;
    try {
      pathInfo = vpath.getVPathInfo(req.query.fp, req.user);
    } catch (e) {
      return res.status(403).json({ error: e.message });
    }

    const artDir  = config.program.storage.albumArtDirectory;

    // Helper: cache raw image buffer and return its filename
    async function cacheImage(buf, format) {
      const ext    = format === 'image/png' ? 'png' : 'jpg';
      const hash   = crypto.createHash('md5').update(buf).digest('hex');
      const aaFile = `${hash}.${ext}`;
      const artPath = path.join(artDir, aaFile);
      if (!fsSync.existsSync(artPath)) {
        await fs.mkdir(artDir, { recursive: true });
        await fs.writeFile(artPath, buf);
      }
      return aaFile;
    }

    try {
      // 1. Try embedded art first
      const meta = await parseFile(pathInfo.fullPath, { skipCovers: false, duration: false });
      const pic  = meta.common?.picture?.[0];
      if (pic) {
        return res.json({ aaFile: await cacheImage(pic.data, pic.format) });
      }

      // 2. Fall back to a folder image in the same directory
      const folderDir   = path.dirname(pathInfo.fullPath);
      const candidates  = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'front.png', 'artwork.jpg', 'artwork.png'];
      for (const name of candidates) {
        const imgPath = path.join(folderDir, name);
        if (fsSync.existsSync(imgPath)) {
          const buf    = await fs.readFile(imgPath);
          const format = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
          return res.json({ aaFile: await cacheImage(buf, format) });
        }
      }

      res.json({ aaFile: null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
