import archiver from 'archiver';
import path from 'path';
import fs from 'fs/promises';
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
    for (const song of songs) {
      const songPath = path.join(playlistParentDir, song);
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
}
