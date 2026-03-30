import commandExists from "command-exists";
import { spawn } from "child_process";
import winston from "winston";
import Joi from 'joi';
import ffbinaries from 'ffbinaries';
import path from 'path';
import * as config from '../state/config.js';
import * as transcode from './transcode.js';
import { joiValidate } from '../util/validation.js';
import * as vpath from '../util/vpath.js';
import * as db from '../db/manager.js';
import { parseFile } from 'music-metadata';
import { Jimp } from 'jimp';
import mime from 'mime-types';
import crypto from 'crypto';
import fs from 'fs/promises';

const downloadTracker = new Map();
const platform = ffbinaries.detectPlatform();

const youtubeUrlSchema = Joi.string().uri({ scheme: ['http', 'https'] }).required().custom((value) => {
  const parsed = new URL(value);
  if (parsed.hostname !== 'youtube.com' && !parsed.hostname.endsWith('.youtube.com') && parsed.hostname !== 'youtu.be') {
    throw new Error('URL must be a YouTube link');
  }
  return value;
});

function sanitizeYoutubeUrl(url) {
  const parsed = new URL(url);
  const v = parsed.searchParams.get('v');
  if (!v) { throw new Error('Invalid YouTube URL - missing video ID'); }
  parsed.search = '';
  parsed.searchParams.set('v', v);
  return parsed.toString();
}

function lookupMetadata(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--dump-json', '--no-download', url]);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      if (code !== 0) {
        winston.error('yt-dlp metadata lookup failed:', stderr);
        return reject(new Error('Failed to lookup metadata'));
      }

      try {
        const json = JSON.parse(stdout);
        resolve({
          title: json.title || null,
          artist: json.artist || json.creator || json.uploader || null,
          album: json.album || null,
          year: json.release_year || json.release_date?.substring(0, 4) || null,
          thumbnail: json.thumbnail || null,
        });
      } catch (e) {
        reject(new Error('Failed to parse yt-dlp output'));
      }
    });
  });
}

export function setup(mstream) {
  mstream.post("/api/v1/ytdl/", async (req, res) => {
    if (config.program.noUpload === true) { throw new WebError('Uploading Disabled'); }
    if (req.user.allowUpload === false) { throw new WebError('Uploading Disabled', 403); }

    if (!config.program.transcode || config.program.transcode.enabled !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    if(!transcode.isDownloaded()) {
      return res.status(500).json({ error: 'FFmpeg not downloaded yet' });
    }

    const filesFormats = Object.keys(config.program.supportedAudioFiles).filter((format) => {
      return config.program.supportedAudioFiles[format] === true;
    });

    const schema = Joi.object({
      directory: Joi.string().required(),
      url: youtubeUrlSchema,
      outputCodec: Joi.string().valid(...filesFormats).default('mp3'),
      metadata: Joi.object({
        title: Joi.string().allow('').optional(),
        artist: Joi.string().allow('').optional(),
        album: Joi.string().allow('').optional(),
        year: Joi.string().allow('').optional(),
      }).optional().default({}),
    });
    const { value } = joiValidate(schema, req.body);

    // verify path exists
    const pathInfo = vpath.getVPathInfo(value.directory, req.user);
    if (!(await fs.stat(pathInfo.fullPath)).isDirectory()) { throw new Error('Not A Directory'); }

    value.url = sanitizeYoutubeUrl(value.url);

    // Pass in ffmpeg directory
    const ffmpegPath = path.join(config.program.transcode.ffmpegDirectory, ffbinaries.getBinaryFilename("ffmpeg", platform));

    try {
      const exists = await commandExists('yt-dlp')
      if (!exists) {
        winston.error('yt-dlp is not installed');
        return res.status(500).json({ error: 'yt-dlp is not installed' });
      }
    } catch (err) {
      winston.error('Error in ytdl API', err);
      res.status(500).json({ error: 'Error - failed to find yt-dlp' });
    }

    const downloadDir = path.join(pathInfo.fullPath, `%(title)s.%(ext)s`);
    const ytdl = spawn('yt-dlp', ['-f', "ba", "-x", value.url, '-o', downloadDir,
      "--ffmpeg-location", ffmpegPath, "--audio-format", value.outputCodec,
      "--embed-thumbnail", "--convert-thumbnails", "jpg", "--embed-metadata"]);
    
    downloadTracker.set(ytdl.pid, {
      process: ytdl,
      url: value.url,
      outputCodec: value.outputCodec,
      metadata: value.metadata,
      status: 'downloading',
      startTime: Date.now(),
    });

    ytdl.stdout.on('data', (data) => {
      winston.info(`yt-dlp output: ${data}`);
    });

    ytdl.stderr.on('data', (data) => {
      winston.error('yt-dlp error: failed to download file - ', value.url);
      winston.error('yt-dlp error:', data.toString());
    });

    ytdl.on('close', async (code) => {
      const entry = downloadTracker.get(ytdl.pid);
      if (entry) {
        entry.status = code === 0 ? 'complete' : 'error';
        setTimeout(() => downloadTracker.delete(ytdl.pid), 30000);
      }
      if (code !== 0) {
        winston.error(`yt-dlp process exited with code ${code}`);
        return;
      }

      try {
        // Find the downloaded file by scanning for new files matching the output codec
        const dirFiles = await fs.readdir(pathInfo.fullPath);
        let downloadedFile = null;
        let downloadedStat = null;
        for (const file of dirFiles) {
          if (!file.endsWith('.' + value.outputCodec)) continue;
          const filePath = path.join(pathInfo.fullPath, file);
          const stat = await fs.stat(filePath);
          if (stat.mtime.getTime() >= entry.startTime) {
            downloadedFile = filePath;
            downloadedStat = stat;
            break;
          }
        }

        if (!downloadedFile) {
          winston.error('yt-dlp: could not find downloaded file in ' + pathInfo.fullPath);
          return;
        }

        // Parse metadata from the downloaded file (include covers for album art)
        const skipImg = config.program.scanOptions.skipImg === true;
        let metadata;
        try {
          metadata = (await parseFile(downloadedFile, { skipCovers: skipImg })).common;
        } catch (err) {
          winston.error('yt-dlp: metadata parse error', { stack: err });
          metadata = { track: { no: null, of: null }, disk: { no: null, of: null } };
        }

        // Compute file hash
        const fileBuffer = await fs.readFile(downloadedFile);
        const hash = crypto.createHash('md5').update(fileBuffer).digest('hex');

        // Build DB record matching the scanner schema
        // User-submitted metadata overrides take priority over parsed file metadata
        const userMeta = entry.metadata || {};
        const relativePath = path.relative(pathInfo.basePath, downloadedFile);
        const data = {
          title: userMeta.title || (metadata.title ? String(metadata.title) : null),
          artist: userMeta.artist || (metadata.artist ? String(metadata.artist) : null),
          year: userMeta.year ? Number(userMeta.year) : (metadata.year || null),
          album: userMeta.album || (metadata.album ? String(metadata.album) : null),
          filepath: relativePath,
          format: value.outputCodec,
          track: metadata.track?.no || null,
          disk: metadata.disk?.no || null,
          modified: downloadedStat.mtime.getTime(),
          hash: hash,
          aaFile: null,
          vpath: pathInfo.vpath,
          ts: Math.floor(Date.now() / 1000),
          sID: 'ytdl',
          replaygainTrackDb: metadata.replaygain_track_gain ? metadata.replaygain_track_gain.dB : null,
        };

        if (metadata.genre) { data.genre = metadata.genre; }

        // Extract and save album art from embedded thumbnail
        if (!skipImg && metadata.picture && metadata.picture[0]) {
          try {
            const picData = metadata.picture[0].data;
            const picHashString = crypto.createHash('md5').update(picData.toString('utf-8')).digest('hex');
            const extension = mime.extension(metadata.picture[0].format) || 'jpg';
            data.aaFile = picHashString + '.' + extension;

            const aaDir = config.program.storage.albumArtDirectory;
            const aaFilePath = path.join(aaDir, data.aaFile);

            // Save original if it doesn't already exist in the cache
            let isNewFile = false;
            try {
              await fs.access(aaFilePath);
            } catch {
              await fs.writeFile(aaFilePath, picData);
              isNewFile = true;
            }

            // Create compressed versions for thumbnails
            if (isNewFile && config.program.scanOptions.compressImage) {
              const img = await Jimp.fromBuffer(picData);
              await img.scaleToFit({ w: 256, h: 256 }).write(path.join(aaDir, 'zl-' + data.aaFile));
              await img.scaleToFit({ w: 92, h: 92 }).write(path.join(aaDir, 'zs-' + data.aaFile));
            }
          } catch (err) {
            winston.error('yt-dlp: failed to extract album art', { stack: err });
          }
        }

        db.getFileCollection().insert(data);
        db.saveFilesDB();
        winston.info(`yt-dlp: added ${relativePath} to database`);
      } catch (err) {
        winston.error('yt-dlp: failed to add file to database', { stack: err });
      }
    });

    res.json({ message: 'Download started' });
  });

  mstream.get("/api/v1/ytdl/metadata", async (req, res) => {
    const schema = Joi.object({ url: youtubeUrlSchema });
    const { value } = joiValidate(schema, req.query);

    try {
      await commandExists('yt-dlp');
    } catch (err) {
      return res.status(500).json({ error: 'yt-dlp is not installed' });
    }

    const url = sanitizeYoutubeUrl(value.url);
    const metadata = await lookupMetadata(url);
    res.json(metadata);
  });

  mstream.get("/api/v1/ytdl/downloads", (req, res) => {
    const downloads = [];
    for (const [pid, entry] of downloadTracker) {
      downloads.push({
        pid,
        url: entry.url,
        outputCodec: entry.outputCodec,
        status: entry.status,
        startTime: entry.startTime,
      });
    }
    res.json({ downloads });
  });
}