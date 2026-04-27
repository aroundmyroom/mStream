import jwt from 'jsonwebtoken';
import Joi from 'joi';
import winston from 'winston';
import * as auth from '../util/auth.js';
import * as config from '../state/config.js';
import * as shared from '../api/shared.js';
import WebError from '../util/web-error.js';

export function setup(mstream) {
  mstream.post('/api/v1/auth/login', async (req, res) => {
    try {
      const schema = Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required()
      });
      await schema.validateAsync(req.body);

      if (!config.program.users[req.body.username]) { throw new Error('user not found'); }

      await auth.authenticateUser(config.program.users[req.body.username].password, config.program.users[req.body.username].salt, req.body.password)

      const token = jwt.sign({ username: req.body.username }, config.program.secret);

      res.cookie('x-access-token', token, {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
        sameSite: 'Strict',
        // NOTE: must NOT be httpOnly — the client JS needs to read this cookie
        // to repopulate S.token when a reverse proxy strips the x-access-token
        // request header. The token is also stored in localStorage, so httpOnly
        // would provide no additional XSS protection here.
        secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      });

      res.json({
        vpaths: config.program.users[req.body.username].vpaths,
        token: token
      });
    } catch (err) {
      winston.warn(`Failed login attempt from ${req.ip}. Username: ${req.body.username}`, { stack: err });
      setTimeout(() => { res.status(401).json({ error: 'Login Failed' }); }, 800);
    }
  });

  mstream.use((req, res, next) => {
    // Handle No Users
    if (Object.keys(config.program.users).length === 0
      && !req.path.startsWith('/api/v1/scanner/')
    ) {
      req.user = {
        vpaths: Object.keys(config.program.folders),
        username: 'mstream-user',
        // lockAdmin=true means the owner wants the admin API locked down — honour
        // that even in public/no-user mode where we'd otherwise grant admin:true.
        admin: config.program.lockAdmin !== true
      };

      return next();
    }

    // Accept token from multiple sources; also support standard "Authorization: Bearer <token>"
    // because some reverse proxies strip custom headers like x-access-token.
    const bearerToken = req.headers?.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : undefined;
    const token = req.body?.token || req.query?.token || req.headers?.['x-access-token'] || bearerToken || req.cookies?.['x-access-token'];
    if (!token) { throw new WebError('Authentication Error', 401); }
    req.token = token;

    const decoded = jwt.verify(token, config.program.secret);

    if (decoded.scan === true && req.path.startsWith('/api/v1/scanner/')) {
      req.scanApproved = true;
      return next();
    }

    // handle federation invite tokens
    if (decoded.invite && decoded.invite === true) {
      // Invite tokens can only be used with one API path
      if (req.path === '/federation/invite/exchange') { return next(); }
      throw new WebError('Authentication Error', 401);
    }

    if (!decoded.username || !config.program.users[decoded.username]) {
      throw new WebError('Authentication Error', 401);
    }

    req.user = config.program.users[decoded.username];
    req.user.username = decoded.username;

    // Handle Shared Tokens
    if (decoded.shareToken && decoded.shareToken === true) {
      const playlistItem = shared.lookupPlaylist(decoded.playlistId);

      if (
        req.path !== '/api/v1/download/shared' &&
        req.path !== '/api/v1/db/metadata' &&
        req.path.substring(0,11) !== '/album-art/' &&
        playlistItem.playlist.indexOf(decodeURIComponent(req.path).slice(7)) === -1
      ) {
        throw new WebError('Authentication Error', 401);
      }

      req.sharedPlaylistId = decoded.playlistId;
    }

    next();
  });
}
