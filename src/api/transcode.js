import path from 'path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import winston from 'winston';
import * as vpath from '../util/vpath.js';
import * as config from '../state/config.js';
import { ensureFfmpeg, ffmpegBin } from '../util/ffmpeg-bootstrap.js';

const codecMap = {
  'mp3': { codec: 'libmp3lame', contentType: 'audio/mpeg' },
  'opus': { codec: 'libopus', contentType: 'audio/ogg' },
  'aac': { codec: 'aac', contentType: 'audio/aac' }
};

const algoSet = new Set(['buffer', 'stream']);
const bitrateSet = new Set(['64k', '128k', '192k', '96k']);

export function getTransAlgos() {
  return Array.from(algoSet);
}

export function getTransBitrates() {
  return Array.from(bitrateSet);
}

export function getTransCodecs() {
  return Object.keys(codecMap);
}

function initHeaders(res, audioTypeId, contentLength) {
  const contentType = codecMap[audioTypeId].contentType;
  return res.header({
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'Content-Length': contentLength
  });
}

let lockInit = false;

async function init() {
  await ensureFfmpeg();
  const { access } = await import('node:fs/promises');
  await access(ffmpegBin());
  lockInit = true;
  winston.info('FFmpeg OK!');
}

export function reset() {
  lockInit = false;
}

export function isEnabled() {
  return lockInit === true && config.program.transcode.enabled === true;
}

export function isDownloaded() {
  return lockInit;
}

export async function downloadedFFmpeg() {
  await init();
}

const transCache = {};
function spawnTranscode(inputPath, codec, bitrate, gainDb = null) {
  // Optional ReplayGain volume adjustment via a simple volume= filter.
  // A limiter (alimiter) prevents clipping after gain is applied.
  // Only applied when gainDb is a finite non-zero number.
  const afParts = [];
  if (gainDb != null && isFinite(gainDb) && gainDb !== 0) {
    const linearGain = Math.pow(10, gainDb / 20).toFixed(6);
    afParts.push(`volume=${linearGain}`);
    afParts.push('alimiter=level_in=1:level_out=1:limit=0.9998:attack=5:release=50');
  }
  const args = ['-i', inputPath, '-vn', '-f', codec, '-acodec', codecMap[codec].codec, '-ab', bitrate];
  if (afParts.length) args.push('-af', afParts.join(','));
  args.push('-');
  return spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'ignore'] });
}

export function setup(mstream) {
  if (config.program.transcode.enabled === true) {
    init().catch(err => {
      winston.error('FFmpeg init failed — transcoding disabled', { stack: err });
    });
  }

  mstream.all("/transcode/{*filepath}", (req, res) => {
    if (!config.program.transcode || config.program.transcode.enabled !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    if (lockInit !== true) {
      return res.status(500).json({ error: 'transcoding disabled' });
    }

    const codec = codecMap[req.query.codec] ? req.query.codec : config.program.transcode.defaultCodec;
    const algo = algoSet.has(req.query.algo) ? req.query.algo : config.program.transcode.algorithm;
    const bitrate = bitrateSet.has(req.query.bitrate) ? req.query.bitrate : config.program.transcode.defaultBitrate;

    // Express 5 / path-to-regexp v8 returns wildcard {*filepath} params as an array,
    // not a string. Use req.path instead — it is always a plain decoded string.
    const rawFilepath = decodeURI(req.path.slice('/transcode/'.length));
    const pathInfo = vpath.getVPathInfo(rawFilepath, req.user);

    // Stream audio data
    if (req.method === 'GET') {

      // check cache
      if (transCache[`${pathInfo.fullPath}|${bitrate}|${codec}`]) {
        const t = transCache[`${pathInfo.fullPath}|${bitrate}|${codec}`].deref();
        if (t!== undefined) {
          initHeaders(res, codec, t.contentLength);
          Readable.from(t.bufs).pipe(res);
          return;
        }
      }

      if (algo === 'stream') {
        const proc = spawnTranscode(pathInfo.fullPath, codec, bitrate);
        proc.on('error', err => {
          winston.error('Transcoding Error!', { stack: err });
          winston.error(pathInfo.fullPath);
        });
        return proc.stdout.pipe(res);
      }

      // Buffer mode
      const bufs = [];
      let contentLength = 0;
      const proc = spawnTranscode(pathInfo.fullPath, codec, bitrate);
      proc.on('error', err => {
        winston.error('Transcoding Error!', { stack: err });
        winston.error(pathInfo.fullPath);
      });
      proc.stdout.on('data', chunk => {
        bufs.push(chunk);
        contentLength += chunk.length;
      });
      proc.stdout.on('end', () => {
        initHeaders(res, codec, contentLength);
        transCache[`${pathInfo.fullPath}|${bitrate}|${codec}`] = new WeakRef({ contentLength, bufs });
        Readable.from(bufs).pipe(res);
      });

    // } else if (req.method === 'HEAD') {
    //   // The HEAD request should return the same headers as the GET request, but not the body
    //   initHeaders(res, codec, pathInfo.fullPath).sendStatus(200);
    } else {
      res.sendStatus(405); // Method not allowed
    }
  });
}
