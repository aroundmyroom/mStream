/**
 * Subsonic REST API — 1.16.1 + Open Subsonic extensions
 *
 * All endpoints live under /rest/{action}(.view)?
 * Auth: both ?p=plaintext and ?t=md5token&s=salt are supported.
 * Response format: JSON (f=json) or XML (default).
 *
 * Open Subsonic extras included in every response:
 *   openSubsonic: true, type: "mstream", serverVersion: <pkg version>
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import winston from 'winston';
import sharp from 'sharp';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

const API_VERSION = '1.16.1';
const SERVER_TYPE = 'mstream';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Authenticate a Subsonic request.
 * Returns the username string on success, or null on failure.
 */
function authenticate(req) {
  const u = req.query.u || req.body?.u;
  if (!u) return null;

  const userObj = config.program.users[u];
  // In no-auth mode (no users configured) we accept any username with any password
  if (Object.keys(config.program.users).length === 0) {
    return u || 'mstream-user';
  }
  if (!userObj) return null;

  const storedPw = userObj['subsonic-password'];
  if (!storedPw) return null;

  // ?t=md5(password+nonce) &s=nonce
  const t = req.query.t || req.body?.t;
  const s = req.query.s || req.body?.s;
  if (t && s) {
    const expected = createHash('md5').update(storedPw + s).digest('hex');
    return expected === t ? u : null;
  }

  // ?p=plaintext  or  ?p=enc:hex
  const p = req.query.p || req.body?.p;
  if (p) {
    let plain = p;
    if (plain.startsWith('enc:')) {
      plain = Buffer.from(plain.slice(4), 'hex').toString('utf8');
    }
    return plain === storedPw ? u : null;
  }

  return null;
}

/** Build the common response wrapper */
function makeResponse(status = 'ok', extra = {}) {
  return {
    'subsonic-response': {
      xmlns: 'http://subsonic.org/restapi',
      status,
      version: API_VERSION,
      type: SERVER_TYPE,
      serverVersion: packageJson.version,
      openSubsonic: true,
      ...extra
    }
  };
}

function makeError(code, message) {
  return makeResponse('failed', { error: { code, message } });
}

const ERRORS = {
  GENERIC:       { code: 0,  message: 'A generic error.' },
  MISSING_PARAM: { code: 10, message: 'Required parameter is missing.' },
  BAD_VERSION:   { code: 20, message: 'Incompatible Subsonic REST protocol version. Client must upgrade.' },
  AUTH:          { code: 40, message: 'Wrong username or password.' },
  UNAUTH:        { code: 50, message: 'User is not authorized for the given operation.' },
  NOT_FOUND:     { code: 70, message: 'The requested data was not found.' },
};

/** Send response in XML or JSON based on ?f= query param */
function sendResponse(req, res, payload) {
  const fmt = (req.query.f || req.body?.f || 'xml').toLowerCase();
  if (fmt === 'json' || fmt === 'jsonp') {
    const wrapper = payload['subsonic-response'];
    const out = { 'subsonic-response': wrapper };
    if (fmt === 'jsonp') {
      const cb = req.query.callback || 'callback';
      res.type('application/javascript');
      return res.send(`${cb}(${JSON.stringify(out)})`);
    }
    return res.json(out);
  }
  // XML
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(toXml(payload));
}

/** Minimal JSON→XML serialiser */
function toXml(obj, tag = null, indent = '') {
  if (tag === null) {
    // root call — iterate top-level key
    const rootKey = Object.keys(obj)[0];
    const val = obj[rootKey];
    return `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(val, rootKey, '')}`;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => toXml(item, tag, indent)).join('\n');
  }
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') {
    return `${indent}<${tag}>${xmlEscape(String(obj))}</${tag}>`;
  }

  const attrs = [];
  const children = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      children.push({ k, v });
    } else if (typeof v === 'object') {
      children.push({ k, v });
    } else {
      attrs.push(`${k}="${xmlEscape(String(v))}"`);
    }
  }

  const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
  if (children.length === 0) {
    return `${indent}<${tag}${attrStr}/>`;
  }
  const inner = children.map(({ k, v }) => toXml(v, k, indent + '  ')).join('\n');
  return `${indent}<${tag}${attrStr}>\n${inner}\n${indent}</${tag}>`;
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Return the vpaths a user is allowed to access */
function getUserVpaths(username) {
  if (Object.keys(config.program.users).length === 0) {
    return Object.keys(config.program.folders);
  }
  return config.program.users[username]?.vpaths ?? [];
}

/**
 * Encode a directory identity as an opaque ID for use in getMusicDirectory.
 * Format: "d:" + base64url(JSON.stringify({v: dbVpath, p: dirRelPath}))
 * dirRelPath has NO trailing slash.
 */
function makeDirId(dbVpath, dirRelPath) {
  return 'd:' + Buffer.from(JSON.stringify({ v: dbVpath, p: dirRelPath })).toString('base64url');
}

function parseDirId(id) {
  if (!id || !String(id).startsWith('d:')) return null;
  try {
    return JSON.parse(Buffer.from(String(id).slice(2), 'base64url').toString('utf8'));
  } catch { return null; }
}

/**
 * Build vpath metadata: detect child vpaths (sub-folders of another vpath).
 * Returns { [vpath]: { parentVpath, filepathPrefix } } where parentVpath/filepathPrefix
 * are non-null only when this vpath's root is inside another vpath's root.
 */
function getVpathMeta(username) {
  const allFolders = config.program.folders;
  const userVpaths = getUserVpaths(username);
  const meta = {};
  for (const vp of userVpaths) {
    if (!allFolders[vp]) { meta[vp] = { parentVpath: null, filepathPrefix: null }; continue; }
    const myRoot = allFolders[vp].root.replace(/\/?$/, '/');
    const parentVpath = userVpaths.find(other =>
      other !== vp &&
      allFolders[other] &&
      allFolders[other].root.replace(/\/?$/, '/') !== myRoot &&
      myRoot.startsWith(allFolders[other].root.replace(/\/?$/, '/'))
    );
    meta[vp] = {
      parentVpath: parentVpath || null,
      filepathPrefix: parentVpath
        ? myRoot.slice(allFolders[parentVpath].root.replace(/\/?$/, '/').length)
        : null
    };
  }
  return meta;
}

/**
 * Resolve the effective vpath list for a request.
 * If ?musicFolderId=N is present (1-based index into subsonicVpaths),
 * restrict to that single folder — this is how Subsonic clients filter
 * by music folder. Falls back to all allowed vpaths when absent/invalid.
 * Child vpaths (sub-folders) are resolved to their DB parent vpath.
 */
function resolveVpaths(req) {
  const rawId = req.query.musicFolderId ?? req.body?.musicFolderId;
  const meta = req.subsonicVpathMeta || {};
  let targetVpaths = req.subsonicVpaths;
  if (rawId !== undefined && rawId !== null && rawId !== '') {
    const id = parseInt(rawId, 10);
    if (!isNaN(id) && id >= 1 && id <= req.subsonicVpaths.length) {
      targetVpaths = [req.subsonicVpaths[id - 1]];
    }
  }
  // Resolve child vpaths to their DB parent so DB queries find actual rows
  const dbVpaths = new Set();
  for (const vp of targetVpaths) {
    dbVpaths.add(meta[vp]?.parentVpath || vp);
  }
  return [...dbVpaths];
}

/**
 * Return the filepath prefix for the selected musicFolderId, or null if
 * the folder is not a child vpath or no folder was selected.
 */
function resolvePrefix(req) {
  const rawId = req.query.musicFolderId ?? req.body?.musicFolderId;
  if (rawId === undefined || rawId === null || rawId === '') return null;
  const id = parseInt(rawId, 10);
  if (isNaN(id) || id < 1 || id > req.subsonicVpaths.length) return null;
  const vp = req.subsonicVpaths[id - 1];
  return (req.subsonicVpathMeta || {})[vp]?.filepathPrefix ?? null;
}

// ── Song/Album/Artist object builders ────────────────────────────────────────

function isoOrNull(epochSec) {
  if (!epochSec) return null;
  return new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z');
}

function buildSong(row, vpaths) {
  // contentType heuristic from format
  const fmt = (row.format || 'mp3').toLowerCase();
  const mimeMap = {
    mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
    opus: 'audio/opus', aac: 'audio/aac', m4a: 'audio/mp4',
    wav: 'audio/wav', wma: 'audio/x-ms-wma', aiff: 'audio/aiff',
    aif: 'audio/aiff', ape: 'audio/ape', wv: 'audio/x-wavpack',
    mpc: 'audio/musepack'
  };
  const contentType = mimeMap[fmt] || 'audio/mpeg';

  const song = {
    id: row.hash,
    parent: row.album_id || row.artist_id || 'root',
    isDir: false,
    title: row.title || path.basename(row.filepath || '', path.extname(row.filepath || '')),
    album: row.album || null,
    artist: row.artist || null,
    track: row.track || null,
    year: row.year || null,
    genre: row.genre || null,
    coverArt: row.aaFile || null,
    size: null,
    contentType,
    suffix: fmt,
    duration: row.duration ? Math.round(row.duration) : null,
    bitRate: null,
    path: path.join(row.vpath, row.filepath).replace(/\\/g, '/'),
    isVideo: false,
    playCount: row.playCount || row.pc || 0,
    albumId: row.album_id || null,
    artistId: row.artist_id || null,
    type: 'music',
    mediaType: 'song',
  };

  if (row.starred) {
    song.starred = isoOrNull(typeof row.starred === 'number' && row.starred === 1
      ? Math.floor(Date.now() / 1000) : row.starred) || new Date().toISOString().replace('.000Z', 'Z');
  }
  if (row.lastPlayed || row.lp) {
    song.played = isoOrNull(row.lastPlayed || row.lp);
  }
  if (row.replaygainTrackDb != null || row['replaygain-track-db'] != null) {
    const rgVal = row.replaygainTrackDb ?? row['replaygain-track-db'];
    song.replayGain = { trackGain: rgVal };
  }
  if (row.rating) {
    song.userRating = Math.min(5, Math.round(row.rating / 2));
  }
  if (row.disk) song.discNumber = row.disk;

  return song;
}

function buildAlbum(albumRow, songs) {
  const songCount = songs ? songs.length : (albumRow.songCount || 0);
  const duration = songs
    ? songs.reduce((s, r) => s + (r.duration || 0), 0)
    : (albumRow.totalDuration != null ? albumRow.totalDuration : null);
  const album = {
    id: albumRow.album_id,
    name: albumRow.album || '(Unknown)',
    artist: albumRow.artist || null,
    artistId: albumRow.artist_id || null,
    coverArt: albumRow.aaFile || null,
    songCount,
    year: albumRow.year || null,
  };
  if (duration !== null) album.duration = Math.round(duration);
  if (songs) {
    album.song = songs.map(s => buildSong(s));
  }
  return album;
}

// Serve a simple SVG folder icon for directory entries that have no art.
function serveFolderIcon(res) {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="512" height="512">',
    '<path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0',
    ' 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="#5C6BC0"/>',
    '<path d="M12 10v3.5c-.3-.2-.6-.3-1-.3-1.1 0-2 .9-2 2s.9 2 2 2 2-.9',
    ' 2-2v-4h2v-1.2L12 10z" fill="white" opacity="0.85"/>',
    '</svg>',
  ].join('');
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
}

function buildArtist(artistRow, albums) {
  const artist = {
    id: artistRow.artist_id,
    name: artistRow.artist || '(Unknown)',
    albumCount: albums ? albums.length : (artistRow.albumCount || 0),
    coverArt: artistRow.aaFile || null,
  };
  if (albums) {
    artist.album = albums.map(a => buildAlbum(a, null));
  }
  return artist;
}

// ── Middleware: parse auth + attach user to req ──────────────────────────────

function subsonicAuth(req, res, next) {
  const username = authenticate(req);
  if (!username) {
    return sendResponse(req, res, makeError(ERRORS.AUTH.code, ERRORS.AUTH.message));
  }
  req.subsonicUser = username;
  req.subsonicVpaths = getUserVpaths(username);
  req.subsonicVpathMeta = getVpathMeta(username);
  next();
}

// ── Route handler factory ────────────────────────────────────────────────────

// In-memory now-playing store: key = username, value = { id, playerId, playerName, startedAt }
const nowPlayingStore = new Map();

export function setup(mstream) {
  // ── Debug request logger ────────────────────────────────────────────────────
  // Logs every incoming Subsonic request to the mStream log files.
  // Password param is scrubbed. Disable by removing/commenting this block.
  mstream.use('/rest', (req, _res, next) => {
    const q = { ...req.query };
    if (q.p) q.p = '[scrubbed]';
    const action = req.path.replace(/^\//, '').replace(/\.view$/, '');
    const qs = Object.entries(q).map(([k, v]) => `${k}=${v}`).join(' ');
    let msg = `[SUBSONIC] ${req.method} ${action}`;
    if (qs) msg += ` | ${qs}`;
    if (req.method === 'POST' && req.body && Object.keys(req.body).length) {
      const b = { ...req.body };
      if (b.p) b.p = '[scrubbed]';
      msg += ` | body:${JSON.stringify(b)}`;
    }
    winston.info(msg);
    next();
  });

  // Subsonic endpoints accept both GET and POST
  // Pattern: /rest/<action>  and  /rest/<action>.view
  const router = (action, handler) => {
    mstream.all(`/rest/${action}`,      subsonicAuth, handler);
    mstream.all(`/rest/${action}.view`, subsonicAuth, handler);
  };

  // ── ping ────────────────────────────────────────────────────────────────────
  router('ping', (req, res) => {
    sendResponse(req, res, makeResponse());
  });

  // ── getLicense ──────────────────────────────────────────────────────────────
  router('getLicense', (req, res) => {
    sendResponse(req, res, makeResponse('ok', {
      license: { valid: true, email: '', licenseExpires: '2099-12-31T00:00:00' }
    }));
  });

  // ── getMusicFolders ─────────────────────────────────────────────────────────
  router('getMusicFolders', (req, res) => {
    const folders = req.subsonicVpaths.map((vp, i) => ({ id: i + 1, name: vp }));
    sendResponse(req, res, makeResponse('ok', {
      musicFolders: { musicFolder: folders }
    }));
  });

  // ── getIndexes ──────────────────────────────────────────────────────────────
  // For folder-browsing clients (e.g. Substreamer Folders tab):
  //   - No musicFolderId → return vpaths as top-level entries (id = 1..N integer)
  //   - musicFolderId=N  → return first-level FS dirs of that vpath, A-Z indexed
  router('getIndexes', (req, res) => {
    const rawFolderId = req.query.musicFolderId ?? req.body?.musicFolderId;
    const buckets = {};

    if (!rawFolderId && rawFolderId !== 0) {
      // No folder selected → list vpaths so user sees "Music, 12-inches, Disco…"
      req.subsonicVpaths.forEach((vp, i) => {
        const letter = vp.charAt(0).toUpperCase();
        const key = /[A-Z]/.test(letter) ? letter : '#';
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push({ id: String(i + 1), name: vp });
      });
    } else {
      // Folder selected → return first-level FS dirs of that vpath
      const folderId = parseInt(rawFolderId, 10);
      if (!isNaN(folderId) && folderId >= 1 && folderId <= req.subsonicVpaths.length) {
        const selectedVpath = req.subsonicVpaths[folderId - 1];
        const vpMeta = (req.subsonicVpathMeta || {})[selectedVpath] || {};
        const dbVpath = vpMeta.parentVpath || selectedVpath;
        const dirRelPath = (vpMeta.filepathPrefix || '').replace(/\/$/, '');

        const { dirs } = db.getDirectoryContents(dbVpath, dirRelPath, req.subsonicUser);
        for (const d of dirs) {
          const letter = d.name.charAt(0).toUpperCase();
          const key = /[A-Z]/.test(letter) ? letter : '#';
          if (!buckets[key]) buckets[key] = [];
          buckets[key].push({
            id: makeDirId(dbVpath, dirRelPath ? dirRelPath + '/' + d.name : d.name),
            name: d.name,
            ...(d.aaFile ? { coverArt: d.aaFile } : {}),
          });
        }
      }
    }

    const index = Object.keys(buckets).sort().map(k => ({
      name: k,
      artist: buckets[k]
    }));
    const lastModifiedMs = db.getLastScannedMs() || Date.now();
    const ifModifiedSince = parseInt(req.query.ifModifiedSince ?? req.body?.ifModifiedSince ?? '0', 10);
    if (ifModifiedSince > 0 && lastModifiedMs <= ifModifiedSince) {
      return sendResponse(req, res, makeResponse('ok', {
        indexes: { index: [], lastModified: lastModifiedMs, ignoredArticles: 'The El La Los Las Le Les' }
      }));
    }
    sendResponse(req, res, makeResponse('ok', {
      indexes: { index, lastModified: lastModifiedMs, ignoredArticles: 'The El La Los Las Le Les' }
    }));
  });

  // ── getArtists ──────────────────────────────────────────────────────────────
  router('getArtists', (req, res) => {
    const artists = db.getAllArtistIds(resolveVpaths(req), { filepathPrefix: resolvePrefix(req) });
    const buckets = {};
    for (const a of artists) {
      const letter = (a.artist || '#').charAt(0).toUpperCase();
      const key = /[A-Z]/.test(letter) ? letter : '#';
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push({ id: a.artist_id, name: a.artist, albumCount: a.albumCount });
    }
    const index = Object.keys(buckets).sort().map(k => ({
      name: k,
      artist: buckets[k]
    }));
    sendResponse(req, res, makeResponse('ok', {
      artists: { index, ignoredArticles: 'The El La Los Las Le Les' }
    }));
  });

  // ── getArtist ───────────────────────────────────────────────────────────────
  router('getArtist', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    const albums = db.getAlbumsByArtistId(id, req.subsonicVpaths);
    if (!albums || albums.length === 0) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }
    const artistRow = {
      artist_id: id,
      artist: albums[0].artist,
      aaFile: albums[0].aaFile,
      albumCount: albums.length
    };
    const artistObj = buildArtist(artistRow, albums);
    sendResponse(req, res, makeResponse('ok', { artist: artistObj }));
  });

  // ── getAlbum ────────────────────────────────────────────────────────────────
  router('getAlbum', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    const songs = db.getFilesByAlbumId(id, req.subsonicVpaths, req.subsonicUser);
    if (!songs || songs.length === 0) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }
    const first = songs[0];
    const albumRow = {
      album_id: id,
      album: first.album,
      artist: first.artist,
      artist_id: first.artist_id,
      aaFile: first.aaFile,
      year: first.year,
      songCount: songs.length
    };
    const albumObj = buildAlbum(albumRow, songs);
    sendResponse(req, res, makeResponse('ok', { album: albumObj }));
  });

  // ── getSong ─────────────────────────────────────────────────────────────────
  router('getSong', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    const row = db.getSongByHash(id, req.subsonicUser);
    if (!row || !req.subsonicVpaths.includes(row.vpath)) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }
    sendResponse(req, res, makeResponse('ok', { song: buildSong(row) }));
  });

  // ── getMusicDirectory ─────────────────────────────────────────────────────────
  // Browses the actual folder hierarchy stored in the DB.
  // IDs:
  //   Integer 1..N  → root of vpath N (from getMusicFolders)
  //   "d:..."       → encoded sub-directory (makeDirId)
  //   other string  → treated as album_id for backward-compat with some clients
  router('getMusicDirectory', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    const vpathIndex = parseInt(id, 10);

    // ── case 1: vpath root ────────────────────────────────────────────────────
    if (!isNaN(vpathIndex) && vpathIndex >= 1 && vpathIndex <= req.subsonicVpaths.length) {
      const selectedVpath = req.subsonicVpaths[vpathIndex - 1];
      const vpMeta = (req.subsonicVpathMeta || {})[selectedVpath] || {};
      const dbVpath = vpMeta.parentVpath || selectedVpath;
      // dirRelPath for this vpath root: strip trailing slash from filepathPrefix
      const dirRelPath = vpMeta.filepathPrefix ? vpMeta.filepathPrefix.replace(/\/$/, '') : '';

      const { dirs, files } = db.getDirectoryContents(dbVpath, dirRelPath, req.subsonicUser);
      const children = [
        ...dirs.map(d => ({
          id: makeDirId(dbVpath, dirRelPath ? dirRelPath + '/' + d.name : d.name),
          parent: id, isDir: true, title: d.name,
          ...(d.aaFile ? { coverArt: d.aaFile } : {}),
        })),
        ...files.map(f => ({ ...buildSong(f, req.subsonicVpaths), isDir: false, parent: id })),
      ];
      return sendResponse(req, res, makeResponse('ok', {
        directory: { id, name: selectedVpath, child: children }
      }));
    }

    // ── case 2: encoded sub-directory ─────────────────────────────────────────
    const parsed = parseDirId(id);
    if (parsed) {
      const { v: dbVpath, p: dirRelPath } = parsed;
      // Security: verify the user has access to this dbVpath
      const hasAccess = req.subsonicVpaths.some(vp => {
        const m = (req.subsonicVpathMeta || {})[vp] || {};
        return (m.parentVpath || vp) === dbVpath;
      });
      if (!hasAccess) {
        return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
      }

      const { dirs, files } = db.getDirectoryContents(dbVpath, dirRelPath, req.subsonicUser);
      const displayName = dirRelPath.includes('/') ? dirRelPath.slice(dirRelPath.lastIndexOf('/') + 1) : dirRelPath;

      // Compute parent ID
      let parentId;
      if (dirRelPath.includes('/')) {
        parentId = makeDirId(dbVpath, dirRelPath.slice(0, dirRelPath.lastIndexOf('/')));
      } else {
        // Parent is the vpath root — find its index
        const vpIdx = req.subsonicVpaths.findIndex(vp => {
          const m = (req.subsonicVpathMeta || {})[vp] || {};
          const vpRoot = (m.filepathPrefix || '').replace(/\/$/, '');
          return (m.parentVpath || vp) === dbVpath && (vpRoot === dirRelPath || (!vpRoot && !dirRelPath));
        });
        parentId = vpIdx >= 0 ? String(vpIdx + 1) : null;
      }

      const children = [
        ...dirs.map(d => ({
          id: makeDirId(dbVpath, dirRelPath + '/' + d.name),
          parent: id, isDir: true, title: d.name,
          ...(d.aaFile ? { coverArt: d.aaFile } : {}),
        })),
        ...files.map(f => ({ ...buildSong(f, req.subsonicVpaths), isDir: false, parent: id })),
      ];
      return sendResponse(req, res, makeResponse('ok', {
        directory: { id, parent: parentId, name: displayName, child: children }
      }));
    }

    // ── case 3: album_id (legacy / other clients) ─────────────────────────────
    const songs = db.getFilesByAlbumId(id, req.subsonicVpaths, req.subsonicUser);
    if (!songs || songs.length === 0) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }
    const children = songs.map(s => ({ ...buildSong(s), isDir: false }));
    const first = songs[0];
    sendResponse(req, res, makeResponse('ok', {
      directory: { id, parent: first.artist_id, name: first.album, child: children }
    }));
  });

  // ── search2 / search3 ────────────────────────────────────────────────────────
  const handleSearch = (req, res) => {
    const query = req.query.query || req.body?.query || '';
    const artistCount = parseInt(req.query.artistCount || req.body?.artistCount || '20', 10);
    const albumCount  = parseInt(req.query.albumCount  || req.body?.albumCount  || '20', 10);
    const songCount   = parseInt(req.query.songCount   || req.body?.songCount   || '20', 10);

    const vp = resolveVpaths(req);
    const user = req.subsonicUser;

    let artists = [], albums = [], songs = [];

    if (query.trim()) {
      const rawArtists = db.searchFiles('artist', query, vp, null);
      const rawAlbums  = db.searchFiles('album',  query, vp, null);
      const rawSongs   = db.searchFiles('title',  query, vp, null);

      // Deduplicate artists
      const artistSeen = {};
      for (const r of rawArtists) {
        if (!r.artist_id || artistSeen[r.artist_id]) continue;
        artistSeen[r.artist_id] = true;
        artists.push({ id: r.artist_id, name: r.artist || '' });
        if (artists.length >= artistCount) break;
      }

      // Deduplicate albums
      const albumSeen = {};
      for (const r of rawAlbums) {
        if (!r.album_id || albumSeen[r.album_id]) continue;
        albumSeen[r.album_id] = true;
        albums.push(buildAlbum({
          album_id: r.album_id, album: r.album, artist: r.artist,
          artist_id: r.artist_id, aaFile: r.aaFile, year: r.year
        }, null));
        if (albums.length >= albumCount) break;
      }

      songs = rawSongs.slice(0, songCount).map(r => buildSong(r));
    }

    const resultKey = 'searchResult3';
    sendResponse(req, res, makeResponse('ok', {
      [resultKey]: {
        artist: artists,
        album: albums,
        song: songs,
        artistOffset: 0, albumOffset: 0, songOffset: 0,
        artistCount: artists.length, albumCount: albums.length, songCount: songs.length
      }
    }));
  };

  router('search2', handleSearch);
  router('search3', handleSearch);

  // ── getAlbumList / getAlbumList2 ─────────────────────────────────────────────
  /**
   * Resolve effective vpaths + filepathPrefix for album-list queries.
   * When musicFolderId is provided, honour it exactly (existing behaviour).
   * When no folder is selected, restrict to albumsOnly vpaths so flat non-album
   * folders (Top-40, Disco, etc.) don't pollute the album list with singles.
   * Falls back to the full vpath list when no albumsOnly vpaths are configured.
   */
  function resolveAlbumListScope(req) {
    const rawFolderId = req.query.musicFolderId ?? req.body?.musicFolderId;
    if (rawFolderId !== undefined && rawFolderId !== null && rawFolderId !== '') {
      return { vp: resolveVpaths(req), pfxValue: resolvePrefix(req) };
    }

    const allowed = new Set(req.subsonicVpaths);
    const folders = config.program.folders || {};
    const entries = Object.entries(folders).filter(([n]) => allowed.has(n));

    // Build parentOf map (same logic as albums-browse.js / playlist.js)
    const parentOf = {};
    for (const [name, folder] of entries) {
      const myRoot = folder.root.replace(/\/?$/, '/');
      const parent = entries.find(([other, otherF]) =>
        other !== name &&
        myRoot.startsWith(otherF.root.replace(/\/?$/, '/')) &&
        otherF.root.replace(/\/?$/, '/') !== myRoot
      );
      parentOf[name] = parent ? parent[0] : null;
    }

    const aoEntries = entries.filter(([, f]) => f.albumsOnly === true);
    if (aoEntries.length === 0) {
      // No albumsOnly configured — return everything
      return { vp: resolveVpaths(req), pfxValue: null };
    }

    if (aoEntries.length === 1) {
      const [name, folder] = aoEntries[0];
      const parent = parentOf[name];
      if (parent) {
        // Child vpath — files are indexed under parent, filter by prefix
        const parentRoot = folders[parent].root.replace(/\/?$/, '/');
        const myRoot     = folder.root.replace(/\/?$/, '/');
        return { vp: [parent], pfxValue: myRoot.slice(parentRoot.length) };
      }
      // Root vpath marked albumsOnly — include all its files
      return { vp: [name], pfxValue: null };
    }

    // Multiple albumsOnly sources — union their DB vpaths; prefix filtering
    // is not viable across sources with different prefixes, so show all.
    const dbVpathSet = new Set();
    for (const [name] of aoEntries) {
      dbVpathSet.add(parentOf[name] || name);
    }
    return { vp: [...dbVpathSet], pfxValue: null };
  }

  const handleAlbumList = (req, res) => {
    const type   = req.query.type   || req.body?.type   || 'newest';
    const size   = Math.min(parseInt(req.query.size   || req.body?.size   || '10', 10), 500);
    const offset = parseInt(req.query.offset || req.body?.offset || '0', 10);
    const user   = req.subsonicUser;
    const { vp, pfxValue } = resolveAlbumListScope(req);
    const pfx    = { filepathPrefix: pfxValue };

    let rows = [];
    const limit = size + offset;

    if (type === 'newest') {
      rows = db.getRecentlyAdded(vp, user, limit, null, pfx);
    } else if (type === 'recent') {
      rows = db.getRecentlyPlayed(vp, user, limit, null, pfx);
    } else if (type === 'frequent' || type === 'highest') {
      rows = db.getMostPlayed(vp, user, limit, null, pfx);
    } else if (type === 'starred') {
      rows = db.getStarredSongs(vp, user, pfx).slice(0, limit);
    } else if (type === 'random') {
      rows = db.getRandomSongs(vp, user, { size: limit, ...pfx });
    } else if (type === 'byYear') {
      const fromYear = parseInt(req.query.fromYear || req.body?.fromYear || '0', 10);
      const toYear   = parseInt(req.query.toYear   || req.body?.toYear   || '9999', 10);
      rows = db.getRandomSongs(vp, user, { size: limit, fromYear, toYear, ...pfx });
    } else if (type === 'byGenre') {
      const genre = req.query.genre || req.body?.genre || '';
      rows = db.getRandomSongs(vp, user, { size: limit, genre, ...pfx });
    } else {
      // alphabeticalByName, alphabeticalByArtist — all albums sorted
      const allAlbums = db.getAllAlbumIds(vp, pfx);
      const sliced = allAlbums.slice(offset, offset + size);
      const albumObjs = sliced.map(a => buildAlbum(a, null));
      const key = req.path.includes('2') ? 'albumList2' : 'albumList';
      return sendResponse(req, res, makeResponse('ok', { [key]: { album: albumObjs } }));
    }

    // Deduplicate by album_id
    const seen = {};
    const albumRows = [];
    for (const r of rows) {
      if (!r.album_id || seen[r.album_id]) continue;
      seen[r.album_id] = true;
      albumRows.push(r);
      if (albumRows.length >= size) break;
    }

    // Fetch songCount + totalDuration for these albums in one query
    const statsMap = db.getAlbumStatsByIds(albumRows.map(r => r.album_id));
    const albumObjs = albumRows.map(r => {
      const stats = statsMap[r.album_id] || {};
      return buildAlbum({
        album_id: r.album_id, album: r.album, artist: r.artist,
        artist_id: r.artist_id, aaFile: r.aaFile, year: r.year,
        songCount: stats.songCount || 0, totalDuration: stats.totalDuration || 0
      }, null);
    });

    const key = req.path.includes('2') ? 'albumList2' : 'albumList';
    sendResponse(req, res, makeResponse('ok', { [key]: { album: albumObjs.slice(offset) } }));
  };

  router('getAlbumList',  handleAlbumList);
  router('getAlbumList2', handleAlbumList);

  // ── getRandomSongs ───────────────────────────────────────────────────────────
  router('getRandomSongs', (req, res) => {
    const opts = {
      size:     req.query.size     || req.body?.size     || 10,
      genre:    req.query.genre    || req.body?.genre    || null,
      fromYear: req.query.fromYear || req.body?.fromYear || null,
      toYear:   req.query.toYear   || req.body?.toYear   || null,
      filepathPrefix: resolvePrefix(req),
    };
    const rows = db.getRandomSongs(resolveVpaths(req), req.subsonicUser, opts);
    sendResponse(req, res, makeResponse('ok', {
      randomSongs: { song: rows.map(r => buildSong(r)) }
    }));
  });

  // ── getSongsByGenre ──────────────────────────────────────────────────────────
  router('getSongsByGenre', (req, res) => {
    const genre  = req.query.genre  || req.body?.genre  || '';
    const count  = Math.min(parseInt(req.query.count  || req.body?.count  || '10', 10), 500);
    const offset = parseInt(req.query.offset || req.body?.offset || '0', 10);

    const rows = db.getSongsByGenre(genre, resolveVpaths(req), req.subsonicUser, null, { filepathPrefix: resolvePrefix(req) });
    const slice = rows.slice(offset, offset + count);
    sendResponse(req, res, makeResponse('ok', {
      songsByGenre: { song: slice.map(r => buildSong(r)) }
    }));
  });

  // ── getGenres ────────────────────────────────────────────────────────────────
  router('getGenres', (req, res) => {
    const genres = db.getGenres(resolveVpaths(req), null, { filepathPrefix: resolvePrefix(req) });
    const genreList = genres.map(g => ({
      value: g.genre, songCount: g.cnt, albumCount: 0
    }));
    sendResponse(req, res, makeResponse('ok', {
      genres: { genre: genreList }
    }));
  });

  // ── getNowPlaying ────────────────────────────────────────────────────────────
  router('getNowPlaying', (req, res) => {
    const cutoff = Date.now() - 30 * 60 * 1000; // 30 minutes
    const entries = [];
    for (const [username, np] of nowPlayingStore) {
      if (np.startedAt < cutoff) { nowPlayingStore.delete(username); continue; }
      const row = db.getSongByHash(np.id, username);
      if (!row) continue;
      const song = buildSong(row, req.subsonicVpaths);
      entries.push({
        ...song,
        username,
        minutesAgo: Math.floor((Date.now() - np.startedAt) / 60000),
        playerId:   np.playerId,
        playerName: np.playerName,
      });
    }
    sendResponse(req, res, makeResponse('ok', { nowPlaying: { entry: entries } }));
  });

  // ── getStarred / getStarred2 ──────────────────────────────────────────────
  const handleGetStarred = (req, res) => {
    const vp     = resolveVpaths(req);
    const pfx    = { filepathPrefix: resolvePrefix(req) };
    const songs  = db.getStarredSongs(vp, req.subsonicUser, pfx);
    const albums = db.getStarredAlbums(vp, req.subsonicUser, pfx);
    const key = req.path.includes('2') ? 'starred2' : 'starred';
    sendResponse(req, res, makeResponse('ok', {
      [key]: {
        song:   songs.map(r => buildSong(r)),
        album:  albums.map(r => buildAlbum(r, null)),
        artist: []
      }
    }));
  };
  router('getStarred',  handleGetStarred);
  router('getStarred2', handleGetStarred);

  // ── star / unstar ────────────────────────────────────────────────────────────
  const handleStar = (req, res, starValue) => {
    const ids = [].concat(
      req.query.id   || req.body?.id   || [],
      req.query.albumId  || req.body?.albumId  || [],
      req.query.artistId || req.body?.artistId || []
    ).flat().filter(Boolean);

    for (const id of ids) {
      // id can be a song hash (32 hex chars) or album_id/artist_id (16 hex chars)
      if (id.length === 32) {
        // song hash
        db.setStarred(id, req.subsonicUser, starValue);
      } else {
        // album or artist — star all songs in it
        const songs = db.getFilesByAlbumId(id, req.subsonicVpaths, req.subsonicUser);
        for (const s of songs) {
          if (s.hash) db.setStarred(s.hash, req.subsonicUser, starValue);
        }
      }
    }
    sendResponse(req, res, makeResponse());
  };
  router('star',   (req, res) => handleStar(req, res, true));
  router('unstar', (req, res) => handleStar(req, res, false));

  // ── setRating ────────────────────────────────────────────────────────────────
  router('setRating', (req, res) => {
    const id     = req.query.id     || req.body?.id;
    const rating = parseInt(req.query.rating || req.body?.rating || '0', 10); // 1-5 stars or 0=remove

    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    // Convert Subsonic 1-5 to mStream 1-10
    const mstreamRating = rating > 0 ? rating * 2 : null;

    const existing = db.findUserMetadata(id, req.subsonicUser);
    if (existing) {
      db.updateUserMetadata({ ...existing, rating: mstreamRating });
    } else {
      db.insertUserMetadata({ hash: id, user: req.subsonicUser, rating: mstreamRating, pc: 0, lp: null });
    }
    db.saveUserDB();
    sendResponse(req, res, makeResponse());
  });

  // ── scrobble ─────────────────────────────────────────────────────────────────
  router('scrobble', (req, res) => {
    const id = [].concat(req.query.id || req.body?.id || []).flat().filter(Boolean)[0];
    const submission = String(req.query.submission || req.body?.submission || 'true') !== 'false';

    if (id && !submission) {
      // submission=false means "now playing" — track it for getNowPlaying
      const playerName = req.query.c || req.body?.c || 'Unknown';
      const playerId   = req.query.c || req.body?.c || 'Unknown';
      nowPlayingStore.set(req.subsonicUser, { id, playerName, playerId, startedAt: Date.now() });
    }

    if (id && submission) {
      // Clear now-playing entry when submission is complete
      nowPlayingStore.delete(req.subsonicUser);
      const existing = db.findUserMetadata(id, req.subsonicUser);
      const now = Math.floor(Date.now() / 1000);
      if (existing) {
        db.updateUserMetadata({ ...existing, pc: (existing.pc || 0) + 1, lp: now });
      } else {
        db.insertUserMetadata({ hash: id, user: req.subsonicUser, rating: null, pc: 1, lp: now });
      }
      db.saveUserDB();
    }
    sendResponse(req, res, makeResponse());
  });

  // ── stream / download ────────────────────────────────────────────────────────
  // Serve the audio file directly — do NOT redirect to /media/ because that
  // route is behind JWT auth and Subsonic clients don't carry a JWT token.
  // Dedup concurrent thumbnail generation: shared between handleStream (pre-warm) and
  // getCoverArt (on-demand). If two requests arrive for the same thumb before it exists,
  // the second waits for the first's promise rather than spawning a parallel sharp instance.
  const thumbInProgress = new Map();

  const handleStream = async (req, res) => {
    let id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));
    // Strip Sonora/OpenSubsonic preview suffix (e.g. "<hash>-preview-0")
    id = String(id).replace(/-preview-\d+$/, '');

    const row = db.getSongByHash(id, req.subsonicUser);
    if (!row || !req.subsonicVpaths.includes(row.vpath)) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }

    const folder = config.program.folders[row.vpath];
    if (!folder) return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));

    const fullPath = path.join(folder.root, row.filepath);

    // Pre-warm thumbnail tiers before audio starts flowing.
    // iSub fires getCoverArt (size=160) and stream within ~5ms of each other.
    // Generating both tiers here ensures that by the time size=160 arrives,
    // the zs- thumbnail already exists on disk → getCoverArt responds in < 1 ms.
    // iOS AVFoundation needs > 100 ms of buffering before actual playback starts,
    // so even a 24 KB zs- file at LAN speeds arrives and renders well before audio.
    if (row.aaFile) {
      const artDir = config.program.storage.albumArtDirectory;
      const fullArtPath = path.join(artDir, row.aaFile);
      if (fs.existsSync(fullArtPath)) {
        for (const [prefix, px] of [['zs-', 92], ['zl-', 256]]) {
          const thumbPath = path.join(artDir, prefix + row.aaFile);
          if (!fs.existsSync(thumbPath) && !thumbInProgress.has(thumbPath)) {
            const gen = sharp(fullArtPath)
              .resize(px, px, { fit: 'inside', withoutEnlargement: true })
              .toFile(thumbPath)
              .catch(() => {})
              .finally(() => thumbInProgress.delete(thumbPath));
            thumbInProgress.set(thumbPath, gen);
          }
        }
        // Await zs- only if it is currently being generated (first-ever play).
        // For cached thumbnails this returns instantly. No artificial extra delay —
        // at LAN speeds a 2–24 KB zs- file transfers in < 1 ms; iOS AVFoundation
        // needs > 100 ms of audio buffering before playback starts, so art always
        // arrives first even without extra padding.
        const zsPath = path.join(artDir, 'zs-' + row.aaFile);
        try { await thumbInProgress.get(zsPath); } catch (_) { /* non-fatal */ }
      }
    }

    // Set explicit Content-Type using the DB format field so iOS AVFoundation gets
    // the correct IANA MIME type. Express's mime module maps .flac → audio/x-flac
    // and .wav → audio/x-wav, both of which iOS rejects. We need audio/flac + audio/wav.
    const streamMimeMap = {
      mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
      opus: 'audio/opus', aac: 'audio/aac', m4a: 'audio/mp4',
      wav: 'audio/wav', wma: 'audio/x-ms-wma', aiff: 'audio/aiff',
      aif: 'audio/aiff', ape: 'audio/ape', wv: 'audio/x-wavpack',
      mpc: 'audio/musepack'
    };
    const fmt = (row.format || path.extname(fullPath).slice(1)).toLowerCase();
    const mime = streamMimeMap[fmt];
    if (mime) res.set('Content-Type', mime);

    res.sendFile(fullPath, err => {
      if (err && !res.headersSent) {
        sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, 'File not found on disk'));
      }
    });
  };
  router('stream',   handleStream);
  router('download', handleStream);

  // ── getCoverArt ──────────────────────────────────────────────────────────────
  // Serve directly — do NOT redirect to /album-art/ (JWT-protected route).
  router('getCoverArt', async (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return res.status(404).end();

    let filename = String(id);
    // Reject the literal string "null" (sent by some clients when coverArt is absent)
    if (filename === 'null') return res.status(404).end();

    // Folder IDs: vpath integers ("1".."N") or d:... encoded dir IDs.
    // Attempt to resolve to real album art from DB; fall back to SVG folder icon.
    const parsedInt  = /^\d+$/.test(filename) ? parseInt(filename, 10) : NaN;
    const isFolderInt = !isNaN(parsedInt) && parsedInt >= 1 && parsedInt <= (req.subsonicVpaths?.length || 0);
    const isDirId     = filename.startsWith('d:');
    if (isFolderInt || isDirId) {
      let artFile = null;
      if (isDirId) {
        const parsed = parseDirId(filename);
        if (parsed) artFile = db.getAaFileForDir(parsed.v, parsed.p);
      } else {
        const vp     = req.subsonicVpaths[parsedInt - 1];
        const vpMeta = (req.subsonicVpathMeta || {})[vp] || {};
        const dbVp   = vpMeta.parentVpath || vp;
        const prefix = (vpMeta.filepathPrefix || '').replace(/\/$/, '');
        artFile = db.getAaFileForDir(dbVp, prefix);
      }
      if (artFile) {
        const artPath = path.join(config.program.storage.albumArtDirectory, path.basename(artFile));
        if (fs.existsSync(artPath)) {
          res.set('Cache-Control', 'public, max-age=86400');
          return res.sendFile(artPath, err => { if (err && !res.headersSent) res.status(500).end(); });
        }
      }
      return serveFolderIcon(res);
    }

    // If id looks like a plain filename (has an extension), serve directly.
    // Otherwise treat it as an album_id / artist_id / song_hash and look up aaFile.
    if (!path.extname(filename)) {
      const resolved = db.getAaFileById(filename);
      if (!resolved) return res.status(404).end();
      filename = resolved;
    }
    // Sanitize to prevent path traversal
    filename = path.basename(filename);
    const artDir = config.program.storage.albumArtDirectory;

    // Honour the ?size= parameter by serving a pre-generated thumbnail when available.
    // The scanner writes zs-<hash>.ext (92px) and zl-<hash>.ext (256px) alongside the
    // full-resolution original. Serving a small thumbnail dramatically reduces transfer
    // time and prevents a race condition on first play where the stream starts before
    // the full-res image has finished loading.
    // If the thumbnail is missing, generate it on-demand so future requests are instant.
    const reqSize = parseInt(req.query.size || req.body?.size || '0', 10);
    const fullPath = path.join(artDir, filename);
    if (!fs.existsSync(fullPath)) return res.status(404).end();
    let servePath = fullPath;
    if (reqSize > 0) {
      // Two-tier thumbnail selection:
      //   size <= 160 → zs- (92px, 4–24 KB)  — now-playing bar
      //     This is the timing-critical request: arrives simultaneously with stream.
      //     Must be small enough to transfer before iSub renders the now-playing screen.
      //   size > 160  → zl- (256px, 60–170 KB) — full-screen art
      //     The prefetch (size=2160) fires ~1s before stream starts; zl- easily
      //     completes in that window now that thumbnails are always pre-generated.
      const useZs    = reqSize <= 160;
      const prefix   = useZs ? 'zs-' : 'zl-';
      const px       = useZs ? 92 : 256;
      const thumbPath = path.join(artDir, prefix + filename);
      if (fs.existsSync(thumbPath)) {
        servePath = thumbPath;
      } else {
        if (!thumbInProgress.has(thumbPath)) {
          const gen = sharp(fullPath)
            .resize(px, px, { fit: 'inside', withoutEnlargement: true })
            .toFile(thumbPath)
            .catch(() => {})
            .finally(() => thumbInProgress.delete(thumbPath));
          thumbInProgress.set(thumbPath, gen);
        }
        // Also generate the other tier fire-and-forget so it's ready immediately.
        const otherPath = path.join(artDir, (useZs ? 'zl-' : 'zs-') + filename);
        if (!fs.existsSync(otherPath) && !thumbInProgress.has(otherPath)) {
          const gen = sharp(fullPath)
            .resize(useZs ? 256 : 92, useZs ? 256 : 92, { fit: 'inside', withoutEnlargement: true })
            .toFile(otherPath)
            .catch(() => {})
            .finally(() => thumbInProgress.delete(otherPath));
          thumbInProgress.set(otherPath, gen);
        }
        try {
          await thumbInProgress.get(thumbPath);
          if (fs.existsSync(thumbPath)) servePath = thumbPath;
        } catch (e) {
          // fall back to full-res — not fatal
        }
      }
    }
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(servePath, err => {
      if (err && !res.headersSent) res.status(500).end();
    });
  });

  // ── getLyrics ────────────────────────────────────────────────────────────────
  router('getLyrics', (req, res) => {
    sendResponse(req, res, makeResponse('ok', { lyrics: {} }));
  });

  // ── getUser ───────────────────────────────────────────────────────────────────
  router('getUser', (req, res) => {
    const username = req.query.username || req.body?.username || req.subsonicUser;
    const userObj  = config.program.users[username];
    if (!userObj && Object.keys(config.program.users).length > 0) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }
    const isAdmin = userObj?.admin === true || Object.keys(config.program.users).length === 0;
    const user = {
      username,
      email: '',
      scrobblingEnabled: false,
      adminRole: isAdmin,
      settingsRole: true,
      downloadRole: true,
      uploadRole: false,
      playlistRole: true,
      coverArtRole: false,
      commentRole: false,
      podcastRole: false,
      streamRole: true,
      jukeboxRole: false,
      shareRole: false,
      videoConversionRole: false,
      folder: (userObj?.vpaths ?? Object.keys(config.program.folders)).map((vp, i) => i + 1)
    };
    sendResponse(req, res, makeResponse('ok', { user }));
  });

  // ── getUsers ──────────────────────────────────────────────────────────────────
  router('getUsers', (req, res) => {
    const userIsAdmin = config.program.users[req.subsonicUser]?.admin === true
      || Object.keys(config.program.users).length === 0;
    if (!userIsAdmin) {
      return sendResponse(req, res, makeError(ERRORS.UNAUTH.code, ERRORS.UNAUTH.message));
    }
    const users = Object.keys(config.program.users).map(u => {
      const obj = config.program.users[u];
      return {
        username: u, email: '', scrobblingEnabled: false,
        adminRole: obj.admin === true, settingsRole: true, downloadRole: true,
        uploadRole: false, playlistRole: true, coverArtRole: false,
        commentRole: false, podcastRole: false, streamRole: true,
        jukeboxRole: false, shareRole: false, videoConversionRole: false,
        folder: (obj.vpaths || []).map((vp, i) => i + 1)
      };
    });
    sendResponse(req, res, makeResponse('ok', { users: { user: users } }));
  });

  // ── getPlaylists ──────────────────────────────────────────────────────────────
  router('getPlaylists', (req, res) => {
    const lists = db.getUserPlaylists(req.subsonicUser);
    const playlists = lists.map(pl => ({
      id: pl.name,
      name: pl.name,
      owner: req.subsonicUser,
      public: false,
      songCount: 0,
      duration: 0
    }));
    sendResponse(req, res, makeResponse('ok', { playlists: { playlist: playlists } }));
  });

  // ── getPlaylist ───────────────────────────────────────────────────────────────
  router('getPlaylist', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    const vpathMeta = req.subsonicVpathMeta || {};
    const entries = db.loadPlaylistEntries(req.subsonicUser, id);
    const songs = [];
    for (const entry of entries) {
      if (!entry.filepath) continue;
      // filepath stored as "vpath/relative" — split on first /
      const sep = entry.filepath.indexOf('/');
      if (sep === -1) continue;
      const vp = entry.filepath.slice(0, sep);
      const fp = entry.filepath.slice(sep + 1);
      if (!req.subsonicVpaths.includes(vp)) continue;
      // Resolve child vpath → root DB vpath + filepathPrefix
      // (songs added by the web client via a child vpath are stored with the
      //  child vpath name, but the DB only has the root parent vpath)
      const meta = vpathMeta[vp] || {};
      const dbVpath = meta.parentVpath || vp;
      const dbFp    = meta.filepathPrefix ? meta.filepathPrefix + fp : fp;
      const row = db.getFileWithMetadata(dbFp, dbVpath, req.subsonicUser);
      if (row) songs.push(buildSong(row));
    }
    const duration = songs.reduce((s, r) => s + (r.duration || 0), 0);
    sendResponse(req, res, makeResponse('ok', {
      playlist: {
        id, name: id, owner: req.subsonicUser, public: false,
        songCount: songs.length, duration: Math.round(duration),
        entry: songs
      }
    }));
  });

  // ── createPlaylist ────────────────────────────────────────────────────────────
  router('createPlaylist', (req, res) => {
    const name = req.query.name || req.body?.name;
    if (!name) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'name required'));

    const songIds = [].concat(req.query.songId || req.body?.songId || []).flat().filter(Boolean);

    // Delete existing then recreate
    db.deletePlaylist(req.subsonicUser, name);
    for (const hash of songIds) {
      const row = db.getSongByHash(hash, req.subsonicUser);
      if (!row || !req.subsonicVpaths.includes(row.vpath)) continue;
      const fp = path.join(row.vpath, row.filepath).replace(/\\/g, '/');
      db.createPlaylistEntry({ name, filepath: fp, user: req.subsonicUser });
    }
    // Insert null sentinel entry
    db.createPlaylistEntry({ name, filepath: null, user: req.subsonicUser, live: false });
    db.saveUserDB();

    sendResponse(req, res, makeResponse('ok', {
      playlist: { id: name, name, owner: req.subsonicUser, public: false,
        songCount: songIds.length, duration: 0 }
    }));
  });

  // ── updatePlaylist ────────────────────────────────────────────────────────────
  router('updatePlaylist', (req, res) => {
    const playlistId = req.query.playlistId || req.body?.playlistId;
    if (!playlistId) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'playlistId required'));

    const toAdd    = [].concat(req.query.songIdToAdd    || req.body?.songIdToAdd    || []).flat().filter(Boolean);
    const toRemove = [].concat(req.query.songIndexToRemove || req.body?.songIndexToRemove || []).flat().map(Number).filter(n => !isNaN(n));

    // Load existing
    const entries = db.loadPlaylistEntries(req.subsonicUser, playlistId);
    let filepaths  = entries.filter(e => e.filepath).map(e => e.filepath);

    // Remove by index (descending to preserve indices)
    toRemove.sort((a, b) => b - a).forEach(i => { if (i >= 0 && i < filepaths.length) filepaths.splice(i, 1); });

    // Append new songs
    for (const hash of toAdd) {
      const row = db.getSongByHash(hash, req.subsonicUser);
      if (!row || !req.subsonicVpaths.includes(row.vpath)) continue;
      filepaths.push(path.join(row.vpath, row.filepath).replace(/\\/g, '/'));
    }

    // Rewrite
    db.deletePlaylist(req.subsonicUser, playlistId);
    for (const fp of filepaths) {
      db.createPlaylistEntry({ name: playlistId, filepath: fp, user: req.subsonicUser });
    }
    db.createPlaylistEntry({ name: playlistId, filepath: null, user: req.subsonicUser, live: false });
    db.saveUserDB();

    sendResponse(req, res, makeResponse());
  });

  // ── deletePlaylist ────────────────────────────────────────────────────────────
  router('deletePlaylist', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    db.deletePlaylist(req.subsonicUser, id);
    db.saveUserDB();
    sendResponse(req, res, makeResponse());
  });

  // ── getArtistInfo / getAlbumInfo ─────────────────────────────────────────────
  // Stubs — no biography/image fetching; return empty objects to silence client retries
  router('getArtistInfo',  (req, res) => sendResponse(req, res, makeResponse('ok', { artistInfo: {} })));
  router('getArtistInfo2', (req, res) => sendResponse(req, res, makeResponse('ok', { artistInfo: {} })));
  router('getAlbumInfo',   (req, res) => sendResponse(req, res, makeResponse('ok', { albumInfo: {} })));
  router('getAlbumInfo2',  (req, res) => sendResponse(req, res, makeResponse('ok', { albumInfo: {} })));

  // ── getSimilarSongs / getTopSongs ─────────────────────────────────────────────
  // Stubs — no audio-analysis/MusicBrainz lookup yet; return empty song lists
  router('getSimilarSongs',  (req, res) => sendResponse(req, res, makeResponse('ok', { similarSongs:  { song: [] } })));
  router('getSimilarSongs2', (req, res) => sendResponse(req, res, makeResponse('ok', { similarSongs2: { song: [] } })));
  router('getTopSongs',      (req, res) => sendResponse(req, res, makeResponse('ok', { topSongs:      { song: [] } })));

  // ── getBookmarks / saveBookmark / deleteBookmark ─────────────────────────────
  // Stub — mStream doesn't support bookmarks yet
  router('getBookmarks',  (req, res) => sendResponse(req, res, makeResponse('ok', { bookmarks: {} })));
  router('saveBookmark',  (req, res) => sendResponse(req, res, makeResponse()));
  router('deleteBookmark',(req, res) => sendResponse(req, res, makeResponse()));

  // ── getPodcasts / getNewestPodcasts ──────────────────────────────────────────
  router('getPodcasts',       (req, res) => sendResponse(req, res, makeResponse('ok', { podcasts: {} })));
  router('getNewestPodcasts', (req, res) => sendResponse(req, res, makeResponse('ok', { newestPodcasts: {} })));

  // ── getInternetRadioStations ──────────────────────────────────────────────────
  router('getInternetRadioStations', (req, res) => {
    sendResponse(req, res, makeResponse('ok', { internetRadioStations: {} }));
  });

  // ── getScanStatus ─────────────────────────────────────────────────────────────
  router('getScanStatus', (req, res) => {
    sendResponse(req, res, makeResponse('ok', { scanStatus: { scanning: false, count: 0 } }));
  });

  // ── getOpenSubsonicExtensions ─────────────────────────────────────────────────
  router('getOpenSubsonicExtensions', (req, res) => {
    sendResponse(req, res, makeResponse('ok', {
      openSubsonicExtensions: [
        { name: 'songLyrics',  versions: [1] },
        { name: 'formPost',    versions: [1] },
        { name: 'noAuth',      versions: [1] },
      ]
    }));
  });

  // ── createUser / updateUser / deleteUser ──────────────────────────────────────
  // Admin stubs — defer to mStream admin API; return unauth for non-admins
  const adminOnly = (req, res) => {
    const isAdmin = config.program.users[req.subsonicUser]?.admin === true
      || Object.keys(config.program.users).length === 0;
    if (!isAdmin) return sendResponse(req, res, makeError(ERRORS.UNAUTH.code, ERRORS.UNAUTH.message));
    sendResponse(req, res, makeResponse());
  };
  router('createUser', adminOnly);
  router('updateUser', adminOnly);
  router('deleteUser', adminOnly);

  // ── changePassword ────────────────────────────────────────────────────────────
  router('changePassword', (req, res) => {
    // Only allow users to change their own subsonic password
    const username = req.query.username || req.body?.username;
    const password = req.query.password || req.body?.password;
    if (!username || !password) {
      return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'username and password required'));
    }
    if (username !== req.subsonicUser && config.program.users[req.subsonicUser]?.admin !== true) {
      return sendResponse(req, res, makeError(ERRORS.UNAUTH.code, ERRORS.UNAUTH.message));
    }
    const userObj = config.program.users[username];
    if (!userObj && Object.keys(config.program.users).length > 0) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }
    if (userObj) {
      let plain = password;
      if (plain.startsWith('enc:')) plain = Buffer.from(plain.slice(4), 'hex').toString('utf8');
      userObj['subsonic-password'] = plain;
      // persist async — don't wait
      import('../util/admin.js').then(a => a.editSubsonicPassword(username, plain)).catch(() => {});
    }
    sendResponse(req, res, makeResponse());
  });

  // ── Catch-all for unsupported endpoints ──────────────────────────────────────
  mstream.all('/rest/:action', subsonicAuth, (req, res) => {
    sendResponse(req, res, makeResponse());
  });
  mstream.all('/rest/:action.view', subsonicAuth, (req, res) => {
    sendResponse(req, res, makeResponse());
  });
}
