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
    const formatMap = { 'ogg': 'vorbis', 'm4b': 'm4a' };
    const ytdlAudioFormat = formatMap[value.outputCodec] || value.outputCodec;
    const ytdlArgs = ['-f', "ba", "-x", value.url, '-o', downloadDir,
      "--ffmpeg-location", ffmpegPath, "--audio-format", ytdlAudioFormat, "--embed-metadata"];
    const noEmbedThumbnail = ['wav', 'opus', 'ogg'];
    if (!noEmbedThumbnail.includes(value.outputCodec)) {
      ytdlArgs.push("--embed-thumbnail", "--convert-thumbnails", "jpg");
    }
    const ytdl = spawn('yt-dlp', ytdlArgs);
    
    downloadTracker.set(ytdl.pid, {
      process: ytdl,
      url: value.url,
      directory: value.directory,
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

      if (code !== 0) {
        winston.warn(`yt-dlp process exited with code ${code}, checking for downloaded file anyway`);
      }

      try {
        // Find the downloaded file by scanning for new files matching the output codec
        // Some formats produce a different file extension than the codec name
        const extMap = { 'aac': 'm4a' };
        const expectedExt = extMap[value.outputCodec] || value.outputCodec;
        const dirFiles = await fs.readdir(pathInfo.fullPath);
        let downloadedFile = null;
        let downloadedStat = null;
        for (const file of dirFiles) {
          if (!file.endsWith('.' + expectedExt)) continue;
          const filePath = path.join(pathInfo.fullPath, file);
          const stat = await fs.stat(filePath);
          if (stat.mtime.getTime() >= entry.startTime) {
            downloadedFile = filePath;
            downloadedStat = stat;
            break;
          }
        }

        if (!downloadedFile) {
          if (entry) {
            entry.status = 'error';
            setTimeout(() => downloadTracker.delete(ytdl.pid), 30000);
          }
          winston.error('yt-dlp: could not find downloaded file in ' + pathInfo.fullPath);
          return;
        }

        // For FLAC/Opus/OGG files, yt-dlp often fails to embed the thumbnail.
        // Download it separately and embed via ffmpeg.
        if (value.outputCodec === 'flac' || value.outputCodec === 'opus' || value.outputCodec === 'ogg') {
          try {
            // Check if the file already has an embedded picture
            const checkMeta = await parseFile(downloadedFile, { skipCovers: false });
            if (!checkMeta.common.picture || checkMeta.common.picture.length === 0) {
              // Fetch thumbnail URL from yt-dlp metadata
              const metaInfo = await lookupMetadata(value.url);
              if (metaInfo.thumbnail) {
                // Download thumbnail to a temp file
                const thumbPath = downloadedFile + '.thumb.jpg';
                const thumbProc = spawn('yt-dlp', ['--no-download', '--write-thumbnail', '--convert-thumbnails', 'jpg',
                  '--ffmpeg-location', ffmpegPath, '-o', downloadedFile + '.thumb', value.url]);
                await new Promise((resolve, reject) => {
                  thumbProc.on('close', (c) => c === 0 ? resolve() : reject(new Error('thumbnail download failed')));
                  thumbProc.on('error', reject);
                });

                try {
                  await fs.access(thumbPath);
                  const tmpEmbed = downloadedFile + '.tmp.' + expectedExt;

                  if (value.outputCodec === 'flac') {
                    // FLAC supports attached_pic via ffmpeg directly
                    await new Promise((resolve, reject) => {
                      const proc = spawn(ffmpegPath, [
                        '-i', downloadedFile, '-i', thumbPath,
                        '-map', '0:a', '-map', '1:0',
                        '-c', 'copy', '-disposition:v', 'attached_pic',
                        '-y', tmpEmbed
                      ]);
                      proc.on('close', (c) => c === 0 ? resolve() : reject(new Error('ffmpeg thumbnail embed failed')));
                      proc.on('error', reject);
                    });
                  } else {
                    // OGG/Opus need METADATA_BLOCK_PICTURE encoded in Vorbis comments
                    const imgData = await fs.readFile(thumbPath);
                    const mimeStr = 'image/jpeg';
                    // Build METADATA_BLOCK_PICTURE binary: type(4) + mime_len(4) + mime + desc_len(4) + desc + width(4) + height(4) + depth(4) + colors(4) + data_len(4) + data
                    const header = Buffer.alloc(32 + mimeStr.length);
                    let offset = 0;
                    header.writeUInt32BE(3, offset); offset += 4;              // picture type: front cover
                    header.writeUInt32BE(mimeStr.length, offset); offset += 4; // MIME length
                    header.write(mimeStr, offset); offset += mimeStr.length;   // MIME string
                    header.writeUInt32BE(0, offset); offset += 4;              // description length
                    header.writeUInt32BE(0, offset); offset += 4;              // width (0 = unknown)
                    header.writeUInt32BE(0, offset); offset += 4;              // height (0 = unknown)
                    header.writeUInt32BE(0, offset); offset += 4;              // color depth
                    header.writeUInt32BE(0, offset); offset += 4;              // indexed colors
                    header.writeUInt32BE(imgData.length, offset);              // data length
                    const pictureBlock = Buffer.concat([header, imgData]);
                    const b64 = pictureBlock.toString('base64');

                    // Write to temp file to avoid OS command-line length limits
                    const metaFilePath = downloadedFile + '.ffmeta';
                    await new Promise((resolve, reject) => {
                      const proc = spawn(ffmpegPath, [
                        '-y', '-i', downloadedFile,
                        '-f', 'ffmetadata', metaFilePath
                      ]);
                      proc.on('close', (c) => c === 0 ? resolve() : reject(new Error('metadata extraction failed')));
                      proc.on('error', reject);
                    });
                    await fs.appendFile(metaFilePath, `METADATA_BLOCK_PICTURE=${b64}\n`);
                    await new Promise((resolve, reject) => {
                      const proc = spawn(ffmpegPath, [
                        '-y', '-i', downloadedFile,
                        '-f', 'ffmetadata', '-i', metaFilePath,
                        '-map', '0:a', '-map_metadata', '1',
                        '-c:a', 'copy', tmpEmbed
                      ]);
                      proc.on('close', (c) => c === 0 ? resolve() : reject(new Error('ffmpeg thumbnail embed failed')));
                      proc.on('error', reject);
                    });
                    try { await fs.unlink(metaFilePath); } catch { /* ignore */ }
                  }

                  await fs.rename(tmpEmbed, downloadedFile);
                  downloadedStat = await fs.stat(downloadedFile);
                  winston.info('yt-dlp: embedded thumbnail into ' + value.outputCodec + ' file');
                } finally {
                  try { await fs.unlink(thumbPath); } catch { /* ignore */ }
                  try { await fs.unlink(downloadedFile + '.tmp.' + expectedExt); } catch { /* ignore */ }
                }
              }
            }
          } catch (thumbErr) {
            winston.warn('yt-dlp: failed to embed thumbnail into ' + value.outputCodec, { stack: thumbErr });
          }
        }

        // Write user-submitted metadata to the file's ID3 tags via ffmpeg
        const userMeta = entry.metadata || {};
        if (userMeta.title || userMeta.artist || userMeta.album || userMeta.year) {
          try {
            const tmpFile = downloadedFile + '.tmp.' + expectedExt;
            const ffmpegArgs = ['-i', downloadedFile, '-c', 'copy'];
            if (userMeta.title) { ffmpegArgs.push('-metadata', `title=${userMeta.title}`); }
            if (userMeta.artist) { ffmpegArgs.push('-metadata', `artist=${userMeta.artist}`); }
            if (userMeta.album) { ffmpegArgs.push('-metadata', `album=${userMeta.album}`); }
            if (userMeta.year) { ffmpegArgs.push('-metadata', `date=${userMeta.year}`); }
            ffmpegArgs.push('-y', tmpFile);

            await new Promise((resolve, reject) => {
              const proc = spawn(ffmpegPath, ffmpegArgs);
              proc.on('close', (ffCode) => {
                if (ffCode !== 0) { return reject(new Error(`ffmpeg exited with code ${ffCode}`)); }
                resolve();
              });
              proc.on('error', reject);
            });

            await fs.rename(tmpFile, downloadedFile);
            downloadedStat = await fs.stat(downloadedFile);
            winston.info('yt-dlp: wrote user metadata tags to file');
          } catch (tagErr) {
            winston.error('yt-dlp: failed to write metadata tags', { stack: tagErr });
            try { await fs.unlink(downloadedFile + '.tmp.' + expectedExt); } catch { /* ignore */ }
          }
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
        const relativePath = path.relative(pathInfo.basePath, downloadedFile);
        const data = {
          title: userMeta.title || (metadata.title ? String(metadata.title) : null),
          artist: userMeta.artist || (metadata.artist ? String(metadata.artist) : null),
          year: userMeta.year ? Number(userMeta.year) : (metadata.year || null),
          album: userMeta.album || (metadata.album ? String(metadata.album) : null),
          filepath: relativePath,
          format: expectedExt,
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

        if (entry) {
          entry.status = 'complete';
          setTimeout(() => downloadTracker.delete(ytdl.pid), 30000);
        }
      } catch (err) {
        winston.error('yt-dlp: failed to add file to database', { stack: err });
        if (entry) {
          entry.status = 'error';
          setTimeout(() => downloadTracker.delete(ytdl.pid), 30000);
        }
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
        directory: entry.directory,
        outputCodec: entry.outputCodec,
        status: entry.status,
        startTime: entry.startTime,
      });
    }
    res.json({ downloads });
  });
}