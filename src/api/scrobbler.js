import fs from 'fs/promises';
import crypto from 'crypto';
import https from 'https';
import Joi from 'joi';
import axios from 'axios';
import winston from 'winston';
import * as config from '../state/config.js';
import Scribble from '../state/lastfm.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { getVPathInfo } from '../util/vpath.js';
import WebError from '../util/web-error.js';

const Scrobbler = new Scribble();

export function setup(mstream) {
  Scrobbler.setKeys(config.program.lastFM.apiKey, config.program.lastFM.apiSecret)

  for (const user in config.program.users) {
    if (!Object.hasOwn(config.program.users, user)) { continue; }
    const u = config.program.users[user];
    if (!u['lastfm-user']) { continue; }
    if (u['lastfm-session']) {
      // Preferred: session key from a previous connect — password never stored
      Scrobbler.addUserWithSession(u['lastfm-user'], u['lastfm-session']);
    } else if (u['lastfm-password']) {
      // Legacy: plain-text password in old config — works until user reconnects
      Scrobbler.addUser(u['lastfm-user'], u['lastfm-password']);
    }
  }

  mstream.post('/api/v1/lastfm/scrobble-by-metadata', (req, res) => {
    const schema = Joi.object({
      artist: Joi.string().optional().allow(''),
      album: Joi.string().optional().allow(''),
      track: Joi.string().required(),
    });
    joiValidate(schema, req.body);

    // TODO: update last-played field in DB
    if (!req.user['lastfm-user'] || (!req.user['lastfm-session'] && !req.user['lastfm-password'])) {
      return res.json({ scrobble: false });
    }

    Scrobbler.Scrobble(
      req.body,
      req.user['lastfm-user'],
      (_post_return_data) => { res.json({}); }
    );
  });

  mstream.post('/api/v1/lastfm/scrobble-by-filepath', (req, res) => {
    const schema = Joi.object({
      filePath: Joi.string().required(),
    });
    joiValidate(schema, req.body);

    // lookup metadata — with child-vpath fallback
    const pathInfo = getVPathInfo(req.body.filePath, req.user);
    let dbFileInfo = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
    if (!dbFileInfo) {
      const folders = config.program?.folders || {};
      const myRoot  = folders[pathInfo.vpath]?.root.replace(/\/?$/, '/');
      if (myRoot) {
        for (const [parentKey, parentFolder] of Object.entries(folders)) {
          if (parentKey === pathInfo.vpath) continue;
          if (!req.user.vpaths.includes(parentKey)) continue;
          const parentRoot = parentFolder.root.replace(/\/?$/, '/');
          if (myRoot.startsWith(parentRoot) && myRoot !== parentRoot) {
            const prefix = myRoot.slice(parentRoot.length);
            dbFileInfo = db.findFileByPath(prefix + pathInfo.relativePath, parentKey);
            if (dbFileInfo) break;
          }
        }
      }
    }

    if (!dbFileInfo) {
      return res.json({ scrobble: false });
    }

    // log play
    const result = db.findUserMetadata(dbFileInfo.hash, req.user.username);

    if (!result) {
      db.insertUserMetadata({
        user: req.user.username,
        hash: dbFileInfo.hash,
        pc: 1,
        lp: Date.now()
      });
    } else {
      result.pc = result.pc && typeof result.pc === 'number'
        ? result.pc + 1 : 1;
      result.lp = Date.now();

      db.updateUserMetadata(result);
    }

    db.saveUserDB();
    res.json({});

    if (req.user['lastfm-user'] && (req.user['lastfm-session'] || req.user['lastfm-password'])) {
      // scrobble on last fm
      Scrobbler.Scrobble(
        {
          artist: dbFileInfo.artist,
          album: dbFileInfo.album,
          track: dbFileInfo.title
        },
        req.user['lastfm-user'],
        (_post_return_data) => {}
      );
    }
  });

  mstream.get('/api/v1/lastfm/similar-artists', (req, res) => {
    if (!req.query.artist) return res.json({ artists: [] });
    Scrobbler.GetSimilarArtists(
      String(req.query.artist),
      (data) => {
        try {
          const artists = (data?.similarartists?.artist || [])
            .slice(0, 20)
            .map(a => a.name)
            .filter(Boolean);
          res.json({ artists });
        } catch (_e) {
          res.json({ artists: [] });
        }
      },
      20
    );
  });

  mstream.post('/api/v1/lastfm/test-login', async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required()
    });
    joiValidate(schema, req.body);

    const token = crypto.createHash('md5').update(req.body.username + crypto.createHash('md5').update(req.body.password, 'utf8').digest("hex"), 'utf8').digest("hex");
    const cryptoString = `api_key${config.program.lastFM.apiKey}authToken${token}methodauth.getMobileSessionusername${req.body.username}${config.program.lastFM.apiSecret}`;
    const hash = crypto.createHash('md5').update(cryptoString, 'utf8').digest("hex");

    await axios({
      method: 'GET',
      url: `http://ws.audioscrobbler.com/2.0/?method=auth.getMobileSession&username=${req.body.username}&authToken=${token}&api_key=${config.program.lastFM.apiKey}&api_sig=${hash}`
    });
    res.json({});
  });

  // ── Per-user self-service Last.fm endpoints ──────────────────

  mstream.get('/api/v1/lastfm/status', (req, res) => {
    res.json({
      serverEnabled: config.program.lastFM?.enabled !== false,
      linkedUser: req.user['lastfm-user'] || null,
    });
  });

  mstream.post('/api/v1/lastfm/connect', async (req, res) => {
    const schema = Joi.object({
      lastfmUser:     Joi.string().required(),
      lastfmPassword: Joi.string().required(),
    });
    joiValidate(schema, req.body);

    // Authenticate against Last.fm before saving
    const token = crypto.createHash('md5').update(
      req.body.lastfmUser + crypto.createHash('md5').update(req.body.lastfmPassword, 'utf8').digest('hex'),
      'utf8'
    ).digest('hex');
    const apiSig = crypto.createHash('md5').update(
      `api_key${config.program.lastFM.apiKey}authToken${token}methodauth.getMobileSessionusername${req.body.lastfmUser}${config.program.lastFM.apiSecret}`,
      'utf8'
    ).digest('hex');
    // Call Last.fm — validateStatus:null lets us read error bodies instead of axios throwing
    let lfmResponse;
    try {
      lfmResponse = await axios({
        method: 'GET',
        url: `http://ws.audioscrobbler.com/2.0/?method=auth.getMobileSession&username=${encodeURIComponent(req.body.lastfmUser)}&authToken=${token}&api_key=${config.program.lastFM.apiKey}&api_sig=${apiSig}&format=json`,
        validateStatus: null,
      });
    } catch (netErr) {
      throw new WebError('Could not reach Last.fm: ' + netErr.message, 502);
    }
    if (lfmResponse.data?.error) {
      throw new WebError(`Last.fm error: ${lfmResponse.data.message || 'Authentication failed'} (code ${lfmResponse.data.error})`, 401);
    }
    const sessionKey = lfmResponse.data?.session?.key;
    if (!sessionKey) { throw new WebError('Last.fm returned no session key', 502); }

    // Persist session key only — password is never written to disk
    const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
    if (!loadConfig.users) loadConfig.users = {};
    if (!loadConfig.users[req.user.username]) loadConfig.users[req.user.username] = {};
    loadConfig.users[req.user.username]['lastfm-user']    = req.body.lastfmUser;
    loadConfig.users[req.user.username]['lastfm-session'] = sessionKey;
    delete loadConfig.users[req.user.username]['lastfm-password'];
    await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');

    config.program.users[req.user.username]['lastfm-user']    = req.body.lastfmUser;
    config.program.users[req.user.username]['lastfm-session'] = sessionKey;
    delete config.program.users[req.user.username]['lastfm-password'];

    Scrobbler.addUserWithSession(req.body.lastfmUser, sessionKey);
    res.json({ linkedUser: req.body.lastfmUser });
  });

  mstream.post('/api/v1/lastfm/disconnect', async (req, res) => {
    const lfmUser = req.user['lastfm-user'];

    // Remove from config.json
    const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
    if (loadConfig.users?.[req.user.username]) {
      delete loadConfig.users[req.user.username]['lastfm-user'];
      delete loadConfig.users[req.user.username]['lastfm-session'];
      delete loadConfig.users[req.user.username]['lastfm-password'];
      await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');
    }
    delete config.program.users[req.user.username]['lastfm-user'];
    delete config.program.users[req.user.username]['lastfm-session'];
    delete config.program.users[req.user.username]['lastfm-password'];

    // Remove from runtime scrobbler
    if (lfmUser && Scrobbler.users[lfmUser]) delete Scrobbler.users[lfmUser];

    res.json({});
  });
}

export function reset() {
  Scrobbler.reset();
}

// Allow admin.js to update the runtime API keys without restarting
export function updateApiKeys(apiKey, apiSecret) {
  Scrobbler.setKeys(apiKey, apiSecret);
}

// ── ListenBrainz ─────────────────────────────────────────────────────────────

// In no-auth mode there are no persistent user objects, so we hold the token here.
let _noAuthLbToken = null;

/**
 * Submit a listen to ListenBrainz.
 * listen_type: 'single' (scrobble) or 'playing_now' (now-playing ping).
 * https://listenbrainz.readthedocs.io/en/latest/users/api/index.html
 */
function lbSubmit(token, artist, track, release, listenedAt) {
  const isNowPlaying = listenedAt === 'playing_now';
  return new Promise((resolve, reject) => {
    const trackMeta = {
      artist_name: artist || '',
      track_name:  track  || '',
      ...(release ? { release_name: release } : {}),
      additional_info: { submission_client: 'mStream', media_player: 'mStream' },
    };
    const listenEntry = isNowPlaying
      ? { track_metadata: trackMeta }
      : { listened_at: listenedAt || Math.floor(Date.now() / 1000), track_metadata: trackMeta };
    const payload = JSON.stringify({
      listen_type: isNowPlaying ? 'playing_now' : 'single',
      payload: [listenEntry],
    });
    const req = https.request({
      hostname: 'api.listenbrainz.org',
      path: '/1/submit-listens',
      method: 'POST',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200) { resolve(true); }
        else { reject(new Error(`ListenBrainz ${res.statusCode}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('ListenBrainz timeout')); });
    req.write(payload);
    req.end();
  });
}

export function setupListenBrainz(mstream) {
  // ── Admin: enable/disable ───────────────────────────────────────────────────
  mstream.get('/api/v1/admin/listenbrainz/config', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({ enabled: config.program.listenBrainz?.enabled === true });
  });

  mstream.post('/api/v1/admin/listenbrainz/config', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({ enabled: Joi.boolean().required() });
    joiValidate(schema, req.body);
    const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
    if (!loadConfig.listenBrainz) loadConfig.listenBrainz = {};
    loadConfig.listenBrainz.enabled = req.body.enabled;
    await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');
    config.program.listenBrainz.enabled = req.body.enabled;
    res.json({});
  });

  // ── Per-user: status / connect / disconnect ─────────────────────────────────
  mstream.get('/api/v1/listenbrainz/status', (req, res) => {
    const isNoAuth = req.user.username === 'mstream-user';
    const linked   = isNoAuth ? !!_noAuthLbToken : !!req.user['listenbrainz-token'];
    res.json({
      serverEnabled: config.program.listenBrainz?.enabled === true,
      linked,
    });
  });

  mstream.post('/api/v1/listenbrainz/connect', async (req, res) => {
    const schema = Joi.object({ lbToken: Joi.string().required() });
    joiValidate(schema, req.body);
    const token = req.body.lbToken.trim();

    // Validate the token by calling the LB validate-token endpoint
    const vtRes = await new Promise((resolve) => {
      https.get({
        hostname: 'api.listenbrainz.org',
        path: `/1/validate-token`,
        headers: { 'Authorization': `Token ${token}` },
      }, r => {
        let d = ''; r.on('data', c => { d += c; }); r.on('end', () => resolve({ status: r.statusCode, body: d }));
      }).on('error', () => resolve({ status: 0, body: '' }));
    });
    let vtJson;
    try { vtJson = JSON.parse(vtRes.body); } catch(_) { vtJson = {}; }
    if (vtRes.status !== 200 || !vtJson.valid) {
      throw new WebError('Invalid ListenBrainz token — check and try again', 401);
    }

    // Persist token — no-auth uses in-memory only; real users go to config file
    const username = req.user.username;
    if (username === 'mstream-user') {
      _noAuthLbToken = token;
    } else {
      const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
      if (!loadConfig.users) loadConfig.users = {};
      if (!loadConfig.users[username]) loadConfig.users[username] = {};
      loadConfig.users[username]['listenbrainz-token'] = token;
      await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');
      config.program.users[username]['listenbrainz-token'] = token;
    }
    res.json({ linked: true, lbUsername: vtJson.user_name || null });
  });

  mstream.post('/api/v1/listenbrainz/disconnect', async (req, res) => {
    const username = req.user.username;
    if (username === 'mstream-user') {
      _noAuthLbToken = null;
    } else {
      const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
      if (loadConfig.users?.[username]) {
        delete loadConfig.users[username]['listenbrainz-token'];
        await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');
      }
      if (config.program.users[username]) delete config.program.users[username]['listenbrainz-token'];
    }
    res.json({});
  });

  // ── Now-playing ping (appears instantly on ListenBrainz) ───────────────────
  mstream.post('/api/v1/listenbrainz/playing-now', async (req, res) => {
    const schema = Joi.object({ filePath: Joi.string().required() });
    joiValidate(schema, req.body);

    const username = req.user.username;
    const token = username === 'mstream-user'
      ? _noAuthLbToken
      : req.user['listenbrainz-token'];
    if (!token) return res.json({ sent: false });

    const pathInfo = getVPathInfo(req.body.filePath, req.user);
    let dbFileInfo = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
    if (!dbFileInfo) {
      const folders = config.program?.folders || {};
      const myRoot  = folders[pathInfo.vpath]?.root.replace(/\/?$/, '/');
      if (myRoot) {
        for (const [parentKey, parentFolder] of Object.entries(folders)) {
          if (parentKey === pathInfo.vpath) continue;
          if (!req.user.vpaths.includes(parentKey)) continue;
          const parentRoot = parentFolder.root.replace(/\/?$/, '/');
          if (myRoot.startsWith(parentRoot) && myRoot !== parentRoot) {
            const prefix = myRoot.slice(parentRoot.length);
            dbFileInfo = db.findFileByPath(prefix + pathInfo.relativePath, parentKey);
            if (dbFileInfo) break;
          }
        }
      }
    }
    if (!dbFileInfo) return res.json({ sent: false });

    res.json({ sent: true });
    try {
      await lbSubmit(token, dbFileInfo.artist, dbFileInfo.title, dbFileInfo.album, 'playing_now');
    } catch (_e) { /* fire and forget */ }
  });

  // ── Scrobble ────────────────────────────────────────────────────────────────
  mstream.post('/api/v1/listenbrainz/scrobble-by-filepath', async (req, res) => {
    const schema = Joi.object({ filePath: Joi.string().required() });
    joiValidate(schema, req.body);

    const username = req.user.username;
    const token = username === 'mstream-user'
      ? _noAuthLbToken
      : req.user['listenbrainz-token'];
    if (!token) return res.json({ scrobble: false });

    const pathInfo = getVPathInfo(req.body.filePath, req.user);
    let dbFileInfo = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
    if (!dbFileInfo) {
      const folders = config.program?.folders || {};
      const myRoot  = folders[pathInfo.vpath]?.root.replace(/\/?$/, '/');
      if (myRoot) {
        for (const [parentKey, parentFolder] of Object.entries(folders)) {
          if (parentKey === pathInfo.vpath) continue;
          if (!req.user.vpaths.includes(parentKey)) continue;
          const parentRoot = parentFolder.root.replace(/\/?$/, '/');
          if (myRoot.startsWith(parentRoot) && myRoot !== parentRoot) {
            const prefix = myRoot.slice(parentRoot.length);
            dbFileInfo = db.findFileByPath(prefix + pathInfo.relativePath, parentKey);
            if (dbFileInfo) break;
          }
        }
      }
    }
    if (!dbFileInfo) return res.json({ scrobble: false });

    res.json({});
    try {
      await lbSubmit(token, dbFileInfo.artist, dbFileInfo.title, dbFileInfo.album);
    } catch (_e) { /* fire and forget */ }
  });
}
