import winston from 'winston';
import express from 'express';
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
import * as podcastApi from './api/podcasts.js';
import * as smartPlaylistApi from './api/smart-playlists.js';
import WebError from './util/web-error.js';
import { sanitizeFilename } from './util/validation.js';

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
      return res.redirect(302, '/login');
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
  mstream.get('/login', (req, res, next) => {
    if (Object.keys(config.program.users).length === 0) {
      return res.redirect(302, '..');
    }

    try {
      jwt.verify(req.cookies['x-access-token'], config.program.secret);
      return res.redirect(302, '..');
    } catch (_err) {
      next();
    }
  });

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
  await sharedApi.setupBeforeSecurity(mstream);

  // Subsonic REST API — has its own auth, must be before authApi.setup()
  subsonicApi.setup(mstream);

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
  discogsApi.setup(mstream);
  waveformApi.setup(mstream);
  userSettingsApi.setup(mstream);
  lyricsApi.setup(mstream);
  radioApi.setup(mstream);
  radioRecorderApi.setup(mstream);
  radioSchedulerApi.setup(mstream);
  podcastApi.setup(mstream);
  smartPlaylistApi.setup(mstream);
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

  Object.keys(config.program.folders).forEach(key => {
    mstream.use(
      '/media/' + key + '/',
      express.static(config.program.folders[key].root)
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
