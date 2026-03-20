import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';

function lrclibFetch(artist, title, duration) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ artist_name: artist, track_name: title });
    const dur = Math.round(Number(duration));
    if (dur > 0) params.set('duration', String(dur));
    const url = `https://lrclib.net/api/get?${params}`;
    const req = https.get(url, { headers: { 'User-Agent': 'mStream-Velvet/1.0 (https://github.com/aroundmyroom/mStream)' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        } else {
          resolve(null);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('lrclib timeout')); });
  });
}

// Fallback: search by title+artist when exact get fails.
// When a duration is supplied, ranks results by closeness to that duration so
// a 12-inch or extended mix won't silently beat the correct single version.
function lrclibSearch(artist, title, duration) {
  return new Promise((resolve, reject) => {
    const q = [artist, title].filter(Boolean).join(' ');
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
    const req = https.get(url, { headers: { 'User-Agent': 'mStream-Velvet/1.0 (https://github.com/aroundmyroom/mStream)' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const results = JSON.parse(data);
            if (!Array.isArray(results) || results.length === 0) { resolve(null); return; }
            const withLyrics = results.filter(r => r.syncedLyrics || r.plainLyrics);
            if (!withLyrics.length) { resolve(null); return; }
            const dur = Number(duration);
            if (dur > 0) {
              // Sort by duration delta; prefer synced lyrics as tiebreaker
              withLyrics.sort((a, b) => {
                const da = Math.abs((a.duration || 0) - dur);
                const db = Math.abs((b.duration || 0) - dur);
                if (da !== db) return da - db;
                return (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0);
              });
            }
            resolve(withLyrics[0]);
          } catch { resolve(null); }
        } else {
          resolve(null);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('lrclib timeout')); });
  });
}

function parseLrc(lrc) {
  const lines = [];
  const re = /\[(\d+):(\d+(?:\.\d+)?)\](.*)/;
  for (const raw of lrc.split('\n')) {
    const m = raw.match(re);
    if (m) {
      const time = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
      lines.push({ time, text: m[3].trim() });
    }
  }
  return lines;
}

function cacheDir() {
  return path.join(config.program.storage.dbDirectory, '..', 'lyrics');
}

export function setup(mstream) {
  // GET /api/v1/lyrics?artist=&title=&filepath=&duration=
  // Returns { synced: true, lines: [{time, text}] }
  //       | { synced: false, lines: [{time:null, text}] }
  //       | { notFound: true }
  mstream.get('/api/v1/lyrics', async (req, res) => {
    if (config.program.lyrics?.enabled === false) return res.json({ notFound: true });
    const artist   = (req.query.artist   || '').trim();
    const title    = (req.query.title    || '').trim();
    const filepath = (req.query.filepath || '').trim();

    // Prefer authoritative duration from DB; fall back to client-supplied value
    let duration = Number(req.query.duration) || 0;
    if (filepath) {
      try {
        const dbDur = db.getFileDuration(filepath);
        if (dbDur != null && dbDur > 0) duration = dbDur;
      } catch (_e) { /* non-fatal */ }
    }

    if (!title) return res.json({ notFound: true });

    const hash     = crypto.createHash('md5')
      .update(`${artist}||${title}||${Math.round(Number(duration))}`)
      .digest('hex');
    const dir      = cacheDir();
    const hitPath  = path.join(dir, `${hash}.json`);
    const nonePath = path.join(dir, `${hash}.none`);

    try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) { /* ignore */ }

    // Serve from cache
    if (fs.existsSync(hitPath)) {
      try { return res.json(JSON.parse(fs.readFileSync(hitPath, 'utf8'))); } catch (_e) { /* fall through to refetch */ }
    }
    if (fs.existsSync(nonePath)) {
      return res.json({ notFound: true });
    }

    // Fetch from lrclib.net
    try {
      // Try exact match first (with duration if available)
      let data = await lrclibFetch(artist, title, duration);
      // If duration was provided and exact match failed, retry without duration
      if (!data && Number(duration) > 0) {
        data = await lrclibFetch(artist, title, 0);
      }
      // Last resort: fuzzy search, ranked by duration closeness when available
      if (!data) {
        data = await lrclibSearch(artist, title, duration);
      }

      if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
        try { fs.writeFileSync(nonePath, ''); } catch (_e) { /* ignore */ }
        return res.json({ notFound: true });
      }

      let result;
      if (data.syncedLyrics) {
        const lines = parseLrc(data.syncedLyrics);
        result = { synced: true, lines };
      } else {
        const lines = data.plainLyrics
          .split('\n')
          .map(t => ({ time: null, text: t.trim() }))
          .filter(l => l.text);
        result = { synced: false, lines };
      }

      try { fs.writeFileSync(hitPath, JSON.stringify(result)); } catch (_e) { /* ignore */ }
      return res.json(result);
    } catch (_err) {
      return res.json({ notFound: true });
    }
  });
}
