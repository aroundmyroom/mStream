import { Readable } from 'node:stream';
import https from 'node:https';
import http from 'node:http';
import { existsSync, unlink } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as admin from '../util/admin.js';

function _ssrfCheck(hostname) {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '::1' ||
    /^127\./.test(h) || /^10\./.test(h) ||
    /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

const _URL_RE = /^https?:\/\/.+/i;

// Download a remote image URL once and store it in the album-art directory.
// Returns the local filename (e.g. "radio-abc123.jpg") on success, or the
// original URL on any failure so the station still saves.
// force=true re-downloads even if the file already exists (logo refresh).
async function _cacheRadioArt(imgUrl, force = false) {
  if (!imgUrl) return imgUrl;
  // Already a local filename — keep as-is
  if (!/^https?:\/\//i.test(imgUrl)) return imgUrl;
  try {
    const hash = createHash('md5').update(imgUrl).digest('hex');
    const artDir = config.program.storage.albumArtDirectory;
    await mkdir(artDir, { recursive: true });
    // Try the early-return skip only when we can guess the extension from the URL
    const urlExt = imgUrl.split('?')[0].match(/\.(png|gif|webp|svg|jpe?g)$/i)?.[1]?.toLowerCase().replace('jpeg','jpg');
    if (!force && urlExt) {
      const cachedPath = path.join(artDir, `radio-${hash}.${urlExt}`);
      if (existsSync(cachedPath)) return `radio-${hash}.${urlExt}`;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    const r = await fetch(imgUrl, { signal: ac.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!r.ok) return imgUrl;
    const ct = r.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return imgUrl;
    // Derive extension: prefer URL path, fall back to Content-Type
    const ctExtMap = { 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/jpeg': 'jpg' };
    const ext = urlExt || ctExtMap[ct.split(';')[0].trim().toLowerCase()] || 'jpg';
    const filename = `radio-${hash}.${ext}`;
    const fullPath = path.join(artDir, filename);
    if (!force && existsSync(fullPath)) return filename; // already cached (no-ext URL hit on second save)
    const buf = await r.arrayBuffer();
    await writeFile(fullPath, Buffer.from(buf));
    // Purge compressed thumbnail cache so /album-art regenerates them
    for (const size of ['s', 'l']) {
      const thumb = path.join(artDir, `z${size}-${filename}`);
      if (existsSync(thumb)) unlink(thumb, () => {});
    }
    return filename;
  } catch { return imgUrl; }
}


// ICY (Shoutcast/Icecast) in-stream metadata parser.
// Uses node:http/https (always HTTP/1.1) so the server actually injects ICY
// metadata — fetch() negotiates HTTP/2 via ALPN and CDN servers only inject
// ICY data on HTTP/1.1 connections even though they send the icy-metaint header.
async function _fetchIcyMeta(rawUrl) {
  return new Promise(resolve => {
    const timeout = setTimeout(() => { req.destroy(); resolve(null); }, 15000);
    const parsed  = new URL(rawUrl);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search, method: 'GET',
        headers: { 'User-Agent': 'mStream/5 RadioProxy', 'Icy-MetaData': '1' } },
      res => {
        // Follow one redirect (CDN hop)
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
          res.resume();
          clearTimeout(timeout);
          _fetchIcyMeta(res.headers.location).then(resolve);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); clearTimeout(timeout); resolve(null); return; }
        const icyBr   = parseInt(res.headers['icy-br'] || '0', 10) || null;
        const metaint = parseInt(res.headers['icy-metaint'] || '0', 10);
        if (!metaint) { res.resume(); clearTimeout(timeout); resolve({ title: null, bitrate: icyBr }); return; }

        // Byte-level state machine: skip metaint audio bytes → length byte → length×16 meta bytes
        let audioLeft = metaint, metaWait = -1;
        const metaBuf = [];
        let totalRead = 0;
        const LIMIT   = metaint * 30;

        res.on('data', chunk => {
          if (totalRead >= LIMIT) return;
          totalRead += chunk.length;
          for (let i = 0; i < chunk.length; ) {
            if (audioLeft > 0) {
              const skip = Math.min(audioLeft, chunk.length - i);
              i += skip; audioLeft -= skip;
            } else if (metaWait === -1) {
              metaWait = chunk[i++] * 16;
              if (metaWait === 0) { audioLeft = metaint; metaWait = -1; }
            } else {
              metaBuf.push(chunk[i++]);
              if (--metaWait === 0) {
                req.destroy();
                clearTimeout(timeout);
                // ICY metadata encoding is not standardised.
                //
                // Case 1 — clean UTF-8: no action needed.
                //
                // Case 2 — raw Latin-1/Windows-1252 bytes: some bytes are
                //   invalid UTF-8 → Node inserts U+FFFD; re-decode as latin1.
                //
                // Case 3 — Windows-1252 double-encoding mojibake: the station
                //   took UTF-8 bytes, misread each byte as a Windows-1252 char,
                //   then re-encoded those chars as UTF-8.
                //   e.g. É (U+00C9) → UTF-8 bytes C3 89 → read as Win-1252
                //   chars Ã (0xC3) + ‰ (0x89→U+2030) → wire bytes C3 83 E2 80 B0
                //   → we decode as "Ã‰" instead of É.
                //   Fingerprint: presence of Windows-1252 0x80-0x9F special chars
                //   (€ ‰ ‹ — ™ etc.) which never appear in real track titles.
                //   Fix: map each char back to a CP1252 byte, decode those bytes
                //   as UTF-8.  Accepted only when the result is shorter (double-
                //   encoding always inflates) and contains no replacement chars.
                const rawBuf = Buffer.from(metaBuf);
                let text = rawBuf.toString('utf8');

                // Case 2 — raw invalid UTF-8 bytes
                if (text.includes('\uFFFD')) {
                  text = rawBuf.toString('latin1');
                }

                // Case 3 — Windows-1252 double-encoding
                if (/[\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/.test(text)) {
                  // CP1252 byte value for each special char in the 0x80-0x9F range
                  const _w = new Map([[0x20AC,0x80],[0x201A,0x82],[0x0192,0x83],[0x201E,0x84],
                    [0x2026,0x85],[0x2020,0x86],[0x2021,0x87],[0x02C6,0x88],[0x2030,0x89],
                    [0x0160,0x8A],[0x2039,0x8B],[0x0152,0x8C],[0x017D,0x8E],[0x2018,0x91],
                    [0x2019,0x92],[0x201C,0x93],[0x201D,0x94],[0x2022,0x95],[0x2013,0x96],
                    [0x2014,0x97],[0x02DC,0x98],[0x2122,0x99],[0x0161,0x9A],[0x203A,0x9B],
                    [0x0153,0x9C],[0x017E,0x9E],[0x0178,0x9F]]);
                  const bytes = []; let ok = true;
                  for (const ch of text) {
                    const cp = ch.codePointAt(0);
                    if (_w.has(cp))    { bytes.push(_w.get(cp)); }
                    else if (cp < 0x100) { bytes.push(cp); }
                    else               { ok = false; break; }
                  }
                  if (ok) {
                    const fixed = Buffer.from(bytes).toString('utf8');
                    if (!fixed.includes('\uFFFD') && [...fixed].length < [...text].length) {
                      text = fixed;
                    }
                  }
                }

                const m     = text.match(/StreamTitle='(.*?)(?:';|'\0|'$)/s);
                const title = m ? (m[1].replace(/\0+$/, '').trim() || null) : null;
                resolve({ title, bitrate: icyBr });
                return;
              }
            }
          }
          if (totalRead >= LIMIT) { req.destroy(); clearTimeout(timeout); resolve({ title: null, bitrate: icyBr }); }
        });
        res.on('end',   () => { clearTimeout(timeout); resolve({ title: null, bitrate: icyBr }); });
        res.on('error', () => { clearTimeout(timeout); resolve({ title: null, bitrate: icyBr }); });
      }
    );
    req.on('error', () => { clearTimeout(timeout); resolve(null); });
    req.end();
  });
}

function _validLink(v) {
  if (!v) return true;           // optional fields
  if (!_URL_RE.test(v)) return false;
  if (/\.m3u8?$/i.test(v)) return false;  // no M3U/M3U8 playlists
  return true;
}

const stationSchema = Joi.object({
  name:    Joi.string().max(120).required(),
  genre:   Joi.string().max(80).allow('', null).optional(),
  country: Joi.string().max(80).allow('', null).optional(),
  link_a:  Joi.string().max(1024).allow('', null).optional(),
  link_b:  Joi.string().max(1024).allow('', null).optional(),
  link_c:  Joi.string().max(1024).allow('', null).optional(),
  img:     Joi.string().max(1024).allow('', null).optional(),
});

export function setup(mstream) {
  // ── Admin: enable/disable radio globally ──────────────────
  mstream.get('/api/v1/admin/radio/config', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({ enabled: config.program.radio?.enabled === true });
  });

  mstream.post('/api/v1/admin/radio/config', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({ enabled: Joi.boolean().required() });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const loadConfig = await admin.loadFile(config.configFile);
    if (!loadConfig.radio) loadConfig.radio = {};
    loadConfig.radio.enabled = value.enabled;
    await admin.saveFile(loadConfig, config.configFile);

    if (!config.program.radio) config.program.radio = {};
    config.program.radio.enabled = value.enabled;

    res.json({});
  });

  // ── Public: check if radio is enabled (all authenticated users) ──
  // ── Art proxy — fetch station images server-side to avoid browser CORS blocks ──
  mstream.get('/api/v1/radio/art', async (req, res) => {
    const raw = req.query.url;
    if (!raw) return res.status(400).end();
    let parsed;
    try { parsed = new URL(raw); } catch { return res.status(400).end(); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return res.status(400).end();
    // SSRF protection
    if (_ssrfCheck(parsed.hostname)) return res.status(403).end();
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      const r = await fetch(parsed.href, { signal: ac.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (!r.ok) return res.status(r.status).end();
      const ct = r.headers.get('content-type') || 'image/jpeg';
      if (!ct.startsWith('image/')) return res.status(415).end();
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const buf = await r.arrayBuffer();
      res.end(Buffer.from(buf));
    } catch { res.status(502).end(); }
  });

  // ── Stream proxy — avoids browser CORS block on cross-origin audio ────────
  // Pipes the live stream through the server so the browser gets same-origin
  // audio (critical: createMediaElementSource marks audioEl as CORS-required,
  // which silences cross-origin streams that lack CORS headers).
  mstream.get('/api/v1/radio/stream', async (req, res) => {
    const raw = req.query.url;
    if (!raw) return res.status(400).end();
    let parsed;
    try { parsed = new URL(raw); } catch { return res.status(400).end(); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return res.status(400).end();
    if (_ssrfCheck(parsed.hostname)) return res.status(403).end();

    const ac = new AbortController();
    req.on('close', () => ac.abort());
    try {
      // Forward Range header so podcast seeks work (static MP3/AAC files).
      const upstreamHeaders = { 'User-Agent': 'mStream/5 RadioProxy', 'Icy-MetaData': '0' };
      if (req.headers['range']) upstreamHeaders['Range'] = req.headers['range'];

      const r = await fetch(parsed.href, {
        signal: ac.signal,
        redirect: 'follow',
        headers: upstreamHeaders,
      });
      if (!r.ok && r.status !== 206) return res.status(r.status).end();

      // Normalise content-type so Chrome recognises AAC/AAC+ streams
      let ct = r.headers.get('content-type') || 'audio/mpeg';
      if (/\baacp\b|aac\+|audio\/aac/i.test(ct)) ct = 'audio/aac';

      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'no-cache, no-store');

      // Forward range-response headers so the browser can seek and show duration
      const cl = r.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      const cr = r.headers.get('content-range');
      if (cr) res.setHeader('Content-Range', cr);
      const ar = r.headers.get('accept-ranges');
      if (ar) res.setHeader('Accept-Ranges', ar);

      res.status(r.status); // preserve 206 Partial Content

      const nodeStream = Readable.fromWeb(r.body);
      nodeStream.pipe(res);
      nodeStream.on('error', () => { if (!res.headersSent) res.status(502).end(); });
    } catch (e) {
      if (!res.headersSent) res.status(e?.name === 'AbortError' ? 499 : 502).end();
    }
  });

  mstream.get('/api/v1/radio/enabled', (req, res) => {
    res.json({ enabled: config.program.radio?.enabled === true });
  });

  // ── ICY now-playing metadata ─────────────────────────────────────────────
  // Opens the stream once, reads the first ICY metadata block, parses
  // StreamTitle='...', returns { title, artist } (artist may be null).
  mstream.get('/api/v1/radio/nowplaying', async (req, res) => {
    const raw = req.query.url;
    if (!raw) return res.status(400).json({ error: 'url required' });
    let parsed;
    try { parsed = new URL(raw); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return res.status(400).json({ error: 'http/https only' });
    if (_ssrfCheck(parsed.hostname)) return res.status(403).end();
    const meta = await _fetchIcyMeta(parsed.href);
    // Return the raw StreamTitle as-is — stations use different conventions
    // (some send "Artist - Title", others "Title - Artist"), so we don't split.
    return res.json({ title: meta?.title || null, bitrate: meta?.bitrate || null });
  });

  // ── Per-user station CRUD ──────────────────────────────────
  mstream.get('/api/v1/radio/stations', (req, res) => {
    if (config.program.radio?.enabled !== true) return res.json([]);
    const artDir = config.program.storage.albumArtDirectory;
    const stations = db.getRadioStations(req.user.username).map(s => {
      // If img is a local filename but the file no longer exists on disk, clear it
      // so the client knows the logo is missing and the user can re-enter the URL.
      if (s.img && !/^https?:\/\//i.test(s.img)) {
        if (!existsSync(path.join(artDir, s.img))) s.img = null;
      }
      return s;
    });
    res.json(stations);
  });

  mstream.post('/api/v1/radio/stations', async (req, res) => {
    if (config.program.radio?.enabled !== true) return res.status(403).json({ error: 'Radio not enabled' });
    const { error, value } = stationSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    for (const field of ['link_a', 'link_b', 'link_c']) {
      if (value[field] && !_validLink(value[field])) {
        return res.status(400).json({ error: `${field}: must be an HTTP/HTTPS stream URL (no .m3u8 playlists)` });
      }
    }
    if (!value.link_a) return res.status(400).json({ error: 'At least Link A is required' });

    value.img = await _cacheRadioArt(value.img);
    const id = db.createRadioStation(req.user.username, value);
    res.json({ id });
  });

  // ── Reorder stations ─────────────────────────────────────────────────────
  mstream.put('/api/v1/radio/stations/reorder', (req, res) => {
    if (config.program.radio?.enabled !== true) return res.status(403).json({ error: 'Radio not enabled' });
    const schema = Joi.object({ ids: Joi.array().items(Joi.number().integer()).required() });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    // Verify all IDs belong to this user
    const owned = new Set(db.getRadioStations(req.user.username).map(s => s.id));
    if (!value.ids.every(id => owned.has(id))) return res.status(403).json({ error: 'Invalid station id' });
    db.reorderRadioStations(req.user.username, value.ids);
    res.json({});
  });

  mstream.put('/api/v1/radio/stations/:id', async (req, res) => {
    if (config.program.radio?.enabled !== true) return res.status(403).json({ error: 'Radio not enabled' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

    const { error, value } = stationSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    for (const field of ['link_a', 'link_b', 'link_c']) {
      if (value[field] && !_validLink(value[field])) {
        return res.status(400).json({ error: `${field}: must be an HTTP/HTTPS stream URL (no .m3u8 playlists)` });
      }
    }
    if (!value.link_a) return res.status(400).json({ error: 'At least Link A is required' });

    value.img = await _cacheRadioArt(value.img, true); // force re-download on edit
    const ok = db.updateRadioStation(id, req.user.username, value);
    if (!ok) return res.status(404).json({ error: 'Station not found' });
    res.json({});
  });

  mstream.delete('/api/v1/radio/stations/:id', (req, res) => {
    if (config.program.radio?.enabled !== true) return res.status(403).json({ error: 'Radio not enabled' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    // Grab img before deleting so we can clean up if no other station references it
    const stations = db.getRadioStations(req.user.username);
    const station  = stations.find(s => s.id === id);
    const ok = db.deleteRadioStation(id, req.user.username);
    if (!ok) return res.status(404).json({ error: 'Station not found' });
    // Clean up cached art file if this was the only station using it
    if (station?.img && !/^https?:\/\//i.test(station.img)) {
      const stillUsed = db.getRadioStationImgUsageCount(station.img);
      if (stillUsed === 0) {
        const artDir = config.program.storage.albumArtDirectory;
        for (const prefix of ['', 'zs-', 'zl-']) {
          try { unlink(path.join(artDir, prefix + station.img), () => {}); } catch (_) {}
        }
      }
    }
    res.json({});
  });
}
