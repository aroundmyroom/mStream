import winston from 'winston';
import express from 'express';
import compression from 'compression';
import fs from 'fs';
import path from 'path';
import Joi from 'joi';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import http from 'http';
import https from 'https';
import { createRequire } from 'module';

import * as dbApi from './api/db.js';
import * as playlistApi from './api/playlist.js';
import * as authApi from './api/auth.js';
import * as fileExplorerApi from './api/file-explorer.js';
import * as downloadApi from './api/download.js';
import * as adminApi from './api/admin.js';
import * as remoteApi from './api/remote.js';
import * as sharedApi from './api/shared.js';
import * as scrobblerApi from './api/scrobbler.js';
import * as discordWebhookApi from './api/discord-webhook.js';
import * as customWebhooksApi from './api/custom-webhooks.js';
import * as discogsApi from './api/discogs.js';
import * as waveformApi from './api/waveform.js';
import * as config from './state/config.js';
import * as logger from './logger.js';
import * as transcode from './api/transcode.js';
import * as dbManager from './db/manager.js';
import * as dbQueue from './db/task-queue.js';
import * as syncthing from './state/syncthing.js';
import * as federationApi from './api/federation.js';
import * as scannerApi from './api/scanner.js';
import * as subsonicApi from './api/subsonic.js';
import * as userSettingsApi from './api/user-settings.js';
import * as lyricsApi from './api/lyrics.js';
import * as radioApi from './api/radio.js';
import * as radioRecorderApi from './api/radio-recorder.js';
import * as radioSchedulerApi from './api/radio-scheduler.js';
import * as backupApi from './api/backup.js';
import * as telemetryApi from './api/telemetry.js';
import * as podcastApi from './api/podcasts.js';
import * as smartPlaylistApi from './api/smart-playlists.js';
import * as ytdlApi from './api/ytdl.js';
import * as albumsBrowseApi from './api/albums-browse.js';
import * as artistsBrowseApi from './api/artists-browse.js';
import * as wrappedApi from './api/wrapped.js';
import * as serverPlaybackApi from './api/server-playback.js';
import * as acoustidApi from './api/acoustid.js';
import * as tagWorkshopApi from './api/tagworkshop.js';
import * as dlnaApi from './api/dlna.js';
import WebError from './util/web-error.js';
import { sanitizeFilename } from './util/validation.js';
import { ensureFfmpeg } from './util/ffmpeg-bootstrap.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

let mstream;
let server;

export async function serveIt(configFile) {
  mstream = express();

  try {
    await config.setup(configFile);
  } catch (err) {
    winston.error('Failed to validate config file', { stack: err });
    process.exit(1);
  }

  // Logging
  if (config.program.writeLogs) {
    logger.addFileLogger(config.program.storage.logsDirectory);
  }

  // Set server
  if (config.program.ssl && config.program.ssl.cert && config.program.ssl.key) {
    try {
      config.setIsHttps(true);
      server = https.createServer({
        key: fs.readFileSync(config.program.ssl.key),
        cert: fs.readFileSync(config.program.ssl.cert),
      });
    } catch (error) {
      winston.error('FAILED TO CREATE HTTPS SERVER');
      error.code = 'BAD CERTS';
      throw error;
    }
  } else {
    config.setIsHttps(false);
    server = http.createServer();
  }

  // Magic Middleware Things
  mstream.use(compression()); // gzip static assets and API responses
  mstream.use(cookieParser());
  mstream.use(express.json({ limit: config.program.maxRequestSize }));
  mstream.use(express.urlencoded({ extended: true }));
  mstream.use((req, res, next) => {
    // CORS
    res.header('Access-Control-Allow-Origin', '*');
    res.header(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept'
    );
    next();
  });

  // Setup DB
  await dbManager.initDB();

  // remove trailing slashes, needed for relative URLs on the webapp
  mstream.get('{*path}', (req, res, next) => {
    // check if theres more than one slash at the end of the URL
    if (req.path.endsWith('//')) {
      // find all trailing slashes at the end of the url
      const matchEnd = req.path.match(/(\/)+$/g);
      const queryString =
        req.url.match(/(\?.*)/g) === null ? '' : req.url.match(/(\?.*)/g);
      // redirect to a more sane URL
      return res.redirect(
        302,
        req.path.slice(0, (matchEnd[0].length - 1) * -1) + queryString
      );
    }
    next();
  });

  // Admin panel (webapp/admin/) — auth guard
  mstream.get('/admin', (req, res, next) => {
    if (config.program.lockAdmin === true) {
      return res.send('<p>Admin Page Disabled</p>');
    }
    if (Object.keys(config.program.users).length === 0) {
      return next();
    }
    try {
      jwt.verify(req.cookies['x-access-token'], config.program.secret);
      next();
    } catch (_err) {
      return res.redirect(302, '/');
    }
  });

  mstream.get('/admin/index.html', (req, res, next) => {
    if (config.program.lockAdmin === true) {
      return res.send('<p>Admin Page Disabled</p>');
    }
    next();
  });

  // Main UI — served directly at root
  mstream.get('/', (_req, res) => res.sendFile(path.join(config.program.webAppDirectory, 'index.html')));

  // Classic UI has been removed. /classic returns 410 Gone.
  mstream.get('/classic', (_req, res) => res.status(410).send('<p>Classic UI has been removed.</p>'));
  mstream.get('/login', (_req, res) => res.redirect(301, '/'));
  mstream.get('/login/', (_req, res) => res.redirect(301, '/'));

  // Mount admin panel (webapp/admin/) at /admin — must be before general static
  mstream.use('/admin', express.static(path.join(config.program.webAppDirectory, 'admin')));

  // Give access to public folder
  mstream.use('/', express.static(config.program.webAppDirectory));

  // Serve browser-standard paths without auth
  mstream.get('/favicon.ico', (_req, res) => res.redirect(301, '/assets/fav/favicon.ico'));
  mstream.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });
  const manifestFile = path.join(config.program.webAppDirectory, 'assets/fav/site.webmanifest');
  mstream.get('/assets/fav/site.webmanifest', (_req, res) => res.sendFile(manifestFile));

  // Public APIs
  remoteApi.setupBeforeAuth(mstream, server);
  serverPlaybackApi.setupBeforeAuth(mstream);
  await sharedApi.setupBeforeSecurity(mstream);

  // Subsonic REST API — has its own auth, must be before authApi.setup()
  subsonicApi.setup(mstream);

  // Public lightweight ping — reachability check without credentials.
  // Also returns instanceId so the client can detect server identity changes
  // and wipe stale localStorage from a previous instance.
  mstream.get('/api/v1/ping/public', (_req, res) => res.json({ status: 'ok', instanceId: config.program.instanceId }));

  // Public — returns enabled languages so the player picker only shows active ones
  const _ALL_LANG_CODES = ['en','nl','de','fr','es','it','pt','pl','ru','zh','ja','ko'];
  mstream.get('/api/v1/languages/enabled', (_req, res) => {
    res.json({ enabled: config.program.languages?.enabled || _ALL_LANG_CODES });
  });

  // Everything below this line requires authentication
  authApi.setup(mstream);

  scannerApi.setup(mstream);
  adminApi.setup(mstream);
  dbApi.setup(mstream);
  playlistApi.setup(mstream);
  downloadApi.setup(mstream);
  fileExplorerApi.setup(mstream);
  transcode.setup(mstream);
  scrobblerApi.setup(mstream);
  scrobblerApi.setupListenBrainz(mstream);
  discordWebhookApi.setup(mstream);
  customWebhooksApi.setup(mstream);
  discogsApi.setup(mstream);
  waveformApi.setup(mstream);
  userSettingsApi.setup(mstream);
  lyricsApi.setup(mstream);
  radioApi.setup(mstream);
  radioRecorderApi.setup(mstream);
  radioSchedulerApi.setup(mstream);
  backupApi.setup(mstream);
  telemetryApi.setup(packageJson.version);
  podcastApi.setup(mstream);
  smartPlaylistApi.setup(mstream);
  ytdlApi.setup(mstream);
  albumsBrowseApi.setup(mstream);
  artistsBrowseApi.setup(mstream);
  wrappedApi.setup(mstream);
  serverPlaybackApi.setup(mstream);
  acoustidApi.setup(mstream);
  tagWorkshopApi.setup(mstream);
  dlnaApi.setup(mstream);
  // Kick off ffmpeg auto-download early so it's ready for radio-recorder,
  // discogs cover-art and ytdl use — non-blocking, safe to ignore errors here.
  ensureFfmpeg().catch(e => winston.warn('[ffmpeg-bootstrap] startup prefetch failed: ' + e.message));
  remoteApi.setupAfterAuth(mstream, server);
  sharedApi.setupAfterSecurity(mstream);
  syncthing.setup();
  federationApi.setup(mstream);

  // Versioned APIs
  mstream.get('/api/', (req, res) => res.json({ "server": packageJson.version, "apiVersions": ["1"] }));

  // album art folder
  // Rule: NEVER return 404. If the file is in the DB but missing from disk
  // (cache cleared, partial scan, manual deletion) serve a neutral SVG placeholder
  // so the browser shows something consistent instead of a broken-image icon.
  const ALBUM_ART_FALLBACK_SVG = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
    '<rect width="1" height="1" fill="#1e1e2e"/>' +
    '<circle cx=".5" cy=".5" r=".28" fill="none" stroke="#45475a" stroke-width=".06"/>' +
    '<circle cx=".5" cy=".5" r=".08" fill="#45475a"/>' +
    '</svg>'
  );
  function sendArtFallback(res) {
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'no-store');
    res.end(ALBUM_ART_FALLBACK_SVG);
  }

  mstream.get('/album-art/:file', (req, res) => {
    if (!req.params.file) { return sendArtFallback(res); }

    const filename = sanitizeFilename(req.params.file);

    const compressedFilePath = path.join(config.program.storage.albumArtDirectory, `z${req.query.compress}-${filename}`);
    if (req.query.compress && fs.existsSync(compressedFilePath)) {
      return res.sendFile(compressedFilePath);
    }

    const fullPath = path.join(config.program.storage.albumArtDirectory, filename);
    if (!fs.existsSync(fullPath)) { return sendArtFallback(res); }
    res.sendFile(fullPath, err => {
      if (err && !res.headersSent) sendArtFallback(res);
    });
  });

  // TODO: determine if user has access to the exact file
  // mstream.all('/media/*', (req, res, next) => {
  //   next();
  // });

  // ── FLAC ID3-preamble stripper ─────────────────────────────────
  // Some FLAC files (typically from iTunes / Picard) have an ID3v2 tag
  // prepended before the native fLaC marker.  ffprobe handles them fine,
  // but Chromium's built-in FFmpeg demuxer requires fLaC at byte 0 and
  // throws DEMUXER_ERROR_NO_SUPPORTED_STREAMS otherwise.
  //
  // This middleware intercepts any /media/…/*.flac request, detects the
  // ID3 preamble, and serves the file from the fLaC offset with correct
  // Content-Length / Content-Range so seeking still works.
  // Non-ID3 files are passed straight through to express.static below.

  /** Parse a syncsafe-integer ID3v2 header and return the number of bytes to skip. */
  function flacId3Skip(buf) {
    if (buf.length < 10 || buf.slice(0, 3).toString('ascii') !== 'ID3') return 0;
    const hasFooter = (buf[5] & 0x10) !== 0;
    const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
                    ((buf[8] & 0x7f) << 7)  |  (buf[9] & 0x7f);
    return 10 + tagSize + (hasFooter ? 10 : 0);
  }

  mstream.use('/media/', async (req, res, next) => {
    if (!req.path.toLowerCase().endsWith('.flac')) return next();
    // Reconstruct the absolute file path from the vpath + relative path.
    const parts = req.path.split('/').filter(Boolean);
    if (parts.length < 2) return next();
    const vpath = decodeURIComponent(parts[0]);
    const folder = config.program.folders[vpath]?.root;
    if (!folder) return next();
    const relPath = parts.slice(1).map(p => decodeURIComponent(p)).join('/');
    const filePath = path.join(folder, relPath);

    try {
      // Read just the first 10 bytes to check for ID3 preamble.
      const fh = await fs.promises.open(filePath, 'r');
      const hdr = Buffer.alloc(10);
      await fh.read(hdr, 0, 10, 0);
      await fh.close();
      const skip = flacId3Skip(hdr);
      if (skip === 0) return next(); // clean fLaC file — let express.static handle it

      const stat = await fs.promises.stat(filePath);
      const effectiveSize = stat.size - skip;
      const rangeHeader = req.headers['range'];

      res.setHeader('Content-Type', 'audio/flac');
      res.setHeader('Accept-Ranges', 'bytes');

      if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (!m) { res.status(416).end(); return; }
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end   = m[2] ? parseInt(m[2], 10) : effectiveSize - 1;
        if (start > effectiveSize - 1) {
          res.setHeader('Content-Range', `bytes */${effectiveSize}`);
          res.status(416).end(); return;
        }
        const clampedEnd = Math.min(end, effectiveSize - 1);
        res.setHeader('Content-Range', `bytes ${start}-${clampedEnd}/${effectiveSize}`);
        res.setHeader('Content-Length', clampedEnd - start + 1);
        res.status(206);
        fs.createReadStream(filePath, { start: skip + start, end: skip + clampedEnd }).pipe(res);
      } else {
        res.setHeader('Content-Length', effectiveSize);
        res.status(200);
        fs.createReadStream(filePath, { start: skip }).pipe(res);
      }
    } catch {
      next(); // file not found / unreadable → let express.static return 404
    }
  });

  // audio/flac is the IANA-registered MIME type; audio/x-flac (the mime package
  // default) is rejected by Chromium's FFmpeg demuxer → DEMUXER_ERROR_NO_SUPPORTED_STREAMS.
  const setMediaHeaders = (res, filePath) => {
    if (filePath.toLowerCase().endsWith('.flac')) res.setHeader('Content-Type', 'audio/flac');
  };

  Object.keys(config.program.folders).forEach(key => {
    mstream.use(
      '/media/' + key + '/',
      express.static(config.program.folders[key].root, { setHeaders: setMediaHeaders })
    );
  });

  // error handling
  mstream.use((error, req, res, _next) => {
    // Honour .status from any HTTP-aware error (e.g. send module's
    // RangeNotSatisfiableError has status=416). Fall back to 500 only when
    // there is no explicit status.
    const status = (error.status && Number.isInteger(error.status))
      ? error.status
      : 500;

    if (status === 401 || status === 403) {
      // Auth failures on unknown paths are internet scanner noise — log at debug only.
      // Real mStream routes all start with /api/, /rest/, /media/, /album-art/, /waveform/.
      const isMstreamPath = /^\/(api|rest|media|album-art|waveform)(\/|$)/i.test(req.originalUrl);
      if (isMstreamPath) {
        winston.warn(`Auth failure on route ${req.originalUrl} [${status}]`);
      } else {
        winston.debug(`Auth probe (ignored) on ${req.originalUrl} [${status}]`);
      }
    } else if (status === 416) {
      // Range Not Satisfiable — happens when the client cached a byte-offset
      // from before a file was rewritten. Not a server bug; log at debug level.
      winston.debug(`Range not satisfiable on ${req.originalUrl} [416] — client will retry from 0`);
    } else {
      winston.error(`Server error on route ${req.originalUrl}: ${error.message}`, { stack: error });
    }

    // Check for validation error
    if (error instanceof Joi.ValidationError) {
      return res.status(403).json({ error: error.message });
    }

    if (error instanceof WebError) {
      return res.status(error.status).json({ error: error.message });
    }

    // For errors that carry their own HTTP status (send, multer, etc.) return
    // that status so the browser can handle it correctly.
    if (status !== 500) {
      return res.status(status).end();
    }

    res.status(500).json({ error: 'Server Error' });
  });

  // Start the server!
  server.on('request', mstream);
  server.listen(config.program.port, config.program.address, () => {
    const protocol = config.program.ssl && config.program.ssl.cert && config.program.ssl.key ? 'https' : 'http';
    winston.info(`Access mStream locally: ${protocol}://localhost:${config.program.port}`);

    dbQueue.runAfterBoot();
    // Boot mpv if server audio is enabled in config
    serverPlaybackApi.startIfEnabled();
  });
}

export function reboot() {
  try {
    winston.info('Rebooting Server');
    logger.reset();
    scrobblerApi.reset();
    transcode.reset();
    dbQueue.reset();

    if (config.program.federation.enabled === false) {
      syncthing.kill2();
    }

    // Close the server
    server.close(() => {
      serveIt(config.configFile);
    });
  } catch (err) {
    winston.error('Reboot Failed', { stack: err });
    process.exit(1);
  }
}
