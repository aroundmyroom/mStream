import fs from 'fs/promises';
import crypto from 'crypto';
import Joi from 'joi';
import axios from 'axios';
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

    // lookup metadata
    const pathInfo = getVPathInfo(req.body.filePath, req.user);
    const dbFileInfo = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);

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
    res.json({ linkedUser: req.user['lastfm-user'] || null });
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
