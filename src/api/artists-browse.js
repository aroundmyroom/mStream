/**
 * artists-browse.js — Artist Library
 *
 * Home-style landing page + letter browse + search + per-artist profile.
 * All artist counts are precomputed in artists_normalized.song_count during
 * rebuildArtistIndex() — no expensive runtime joins with the files table.
 *
 * Endpoints:
 *   GET  /api/v1/artists/home            → { totalCount, topArtists[], recentArtists[] }
 *   GET  /api/v1/artists/letter?l=A      → { artists[] }  (0 = all digits)
 *   GET  /api/v1/artists/search?q=       → { artists[] }
 *   GET  /api/v1/artists/profile?key=    → { canonicalName, bio, imageFile, releaseCategories[] }
 *   POST /api/v1/artists/fetch-info      → trigger Last.fm/MusicBrainz fetch (admin)
 *   POST /api/v1/artists/set-image       → set custom artist image (admin)
 *   POST /api/v1/artists/set-name        → override canonical name (admin)
 */

import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import https from 'https';
import path from 'path';
import sharp from 'sharp';
import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const CACHE_TTL      = 5 * 60 * 1000; // 5 minutes
const ARTIST_IMG_DIR = path.join(process.cwd(), 'image-cache', 'artists');
const ARTIST_IMG_SIZE = 400; // square JPEG size for stored artist images
const HYDRATE_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours
const HYDRATE_QUEUE_LIMIT = 800;
const HYDRATE_DELAY_OK_MS = 1400;
const HYDRATE_DELAY_IDLE_MS = 2200;
const HYDRATE_DELAY_ERR_MS = 4000;

// ── Cache ─────────────────────────────────────────────────────────────────────
// Cache only the home stats (cheap to hold; letter/search queries are fast too)

let _homeCache   = null;
let _homeCacheTs = 0;

// Background queue: prioritize home-shelf artists for image hydration.
const _imgHydrateQueue = [];
let _imgHydrateRunning = false;
const _imgHydrateQueued = new Set();
const _imgHydrateLastTry = new Map(); // artistKey -> timestamp
const _imgHydrateStats = {
  startedAt: Date.now(),
  enqueued: 0,
  dropped: 0,
  processed: 0,
  succeeded: 0,
  noImage: 0,
  failed: 0,
  lastRunAt: 0,
  lastSuccessAt: 0,
  lastErrorAt: 0,
  lastError: null,
};

export function invalidateArtistCache() {
  _homeCache   = null;
  _homeCacheTs = 0;
}

// ── Image directory ───────────────────────────────────────────────────────────

try { fs.mkdirSync(ARTIST_IMG_DIR, { recursive: true }); } catch (_e) { /* already exists */ }

// ── Profile builder ───────────────────────────────────────────────────────────
// Builds the artist profile (release categories) from raw file rows.
// Release categories are keyed by L1 folder name — fully generic.

function buildProfile(fileRows, canonicalName) {
  // Group by L1 folder → release folder (L2 path segment)
  // fileRows each have: filepath, vpath, title, artist, album, track, disk,
  //   year, duration, aaFile, cover_file

  const categories = new Map(); // l1 → Map<releaseFolder, { artFile, aaFile, tracks[] }>

  for (const row of fileRows) {
    const parts = row.filepath.split('/');
    if (parts.length < 2) continue; // bare file at vpath root — skip

    const l1 = parts[0];
    const releaseFolder = parts.length >= 3 ? parts[1] : null; // L2 segment
    if (!releaseFolder) continue; // just l1/filename — skip

    if (!categories.has(l1)) categories.set(l1, new Map());
    const relMap = categories.get(l1);

    if (!relMap.has(releaseFolder)) {
      relMap.set(releaseFolder, {
        folder: releaseFolder,
        artFile: null,
        aaFile: null,
        year: null,
        tracks: [],
      });
    }

    const rel = relMap.get(releaseFolder);
    if (!rel.artFile && row.cover_file) {
      // Build artFile path relative to vpath root for the images API
      rel.artFile = row.vpath + '/' + l1 + '/' + releaseFolder + '/' + row.cover_file;
    }
    if (!rel.aaFile && row.aaFile) rel.aaFile = row.aaFile;
    if (!rel.year && row.year) rel.year = row.year;

    rel.tracks.push({
      filepath : row.vpath + '/' + row.filepath,
      title    : row.title || null,
      artist   : row.artist || canonicalName,
      track    : row.track  || null,
      disk     : row.disk   || null,
      duration : row.duration || null,
      aaFile   : row.aaFile || null,
      cuepoints: row.cuepoints ? (() => { try { return JSON.parse(row.cuepoints); } catch { return []; } })() : [],
    });
  }

  // Sort tracks within each release by disk → track → filepath
  const result = [];
  for (const [l1, relMap] of categories) {
    const releases = [];
    for (const [, rel] of relMap) {
      rel.tracks.sort((a, b) => {
        if ((a.disk || 0) !== (b.disk || 0)) return (a.disk || 0) - (b.disk || 0);
        if ((a.track || 0) !== (b.track || 0)) return (a.track || 0) - (b.track || 0);
        return (a.filepath || '').localeCompare(b.filepath || '');
      });
      releases.push(rel);
    }
    // Sort releases within category by year (asc), then folder name
    releases.sort((a, b) => {
      if (a.year && b.year && a.year !== b.year) return a.year - b.year;
      return a.folder.localeCompare(b.folder);
    });
    result.push({ category: l1, releases });
  }

  // Sort categories by total track count descending (most content first)
  result.sort((a, b) => {
    const ca = a.releases.reduce((s, r) => s + r.tracks.length, 0);
    const cb = b.releases.reduce((s, r) => s + r.tracks.length, 0);
    return cb - ca;
  });

  return result;
}

// ── Fetch bio + image from Last.fm / MusicBrainz ──────────────────────────────

function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadJson(url, headers = null) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, headers ? { headers } : undefined, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function isLastfmPlaceholder(url) {
  if (!url) return true;
  const u = String(url).toLowerCase();
  return (
    u.includes('/2a96cbd8b46e442fc41c2b86b821562f') ||
    u.includes('lastfm.freetls.fastly.net/i/u/avatar170s') ||
    u.includes('noimage') ||
    u.endsWith('/0.png')
  );
}

function discogsHeaders() {
  const d = config.program?.discogs || {};
  if (!d.enabled || !d.apiKey || !d.apiSecret) return null;
  const ua = d.userAgentTag
    ? `mStreamVelvet/dev/${d.userAgentTag} +https://github.com/aroundmyroom/mStream`
    : 'mStreamVelvet/dev +https://github.com/aroundmyroom/mStream';
  return {
    'User-Agent': ua,
    'Authorization': `Discogs key=${d.apiKey}, secret=${d.apiSecret}`,
  };
}

function discogsStatus() {
  const d = config.program?.discogs || {};
  return {
    enabled: !!d.enabled,
    hasApiCredentials: !!(d.apiKey && d.apiSecret),
  };
}

async function fetchArtistImageFromDiscogs(artistName) {
  const headers = discogsHeaders();
  if (!headers || !artistName) return null;

  try {
    const q = encodeURIComponent(artistName);
    const search = await downloadJson(`https://api.discogs.com/database/search?type=artist&per_page=5&q=${q}`, headers);
    const results = Array.isArray(search?.results) ? search.results : [];
    if (!results.length) return null;

    const norm = s => String(s || '').toLowerCase().replace(/\(\d+\)/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const target = norm(artistName);
    let best = results[0];
    let bestScore = -1;
    for (const r of results) {
      const t = norm(r?.title);
      let score = 0;
      if (t === target) score = 100;
      else if (t.includes(target) || target.includes(t)) score = 80;
      else if (target && t && (target.split(' ').some(w => w.length > 2 && t.includes(w)))) score = 60;
      if (score > bestScore) { best = r; bestScore = score; }
    }

    // First choice: resource images[] (usually best quality)
    if (best?.resource_url) {
      try {
        const detail = await downloadJson(best.resource_url, headers);
        const imgs = Array.isArray(detail?.images) ? detail.images : [];
        const primary = imgs.find(i => i?.uri) || imgs[0];
        if (primary?.uri) return primary.uri;
      } catch (_e) { /* fallback below */ }
    }

    // Fallback: search result image fields
    if (best?.cover_image) return best.cover_image;
    if (best?.thumb) return best.thumb;
    return null;
  } catch (_e) {
    return null;
  }
}

async function searchDiscogsArtistCandidates(artistName, max = 8) {
  const headers = discogsHeaders();
  if (!headers || !artistName) return [];

  try {
    const q = encodeURIComponent(artistName);
    const search = await downloadJson(`https://api.discogs.com/database/search?type=artist&per_page=${Math.max(1, Math.min(20, max))}&q=${q}`, headers);
    const results = Array.isArray(search?.results) ? search.results : [];
    const out = [];
    for (const r of results) {
      let imageUrl = r?.cover_image || r?.thumb || null;
      if (r?.resource_url) {
        try {
          const detail = await downloadJson(r.resource_url, headers);
          const imgs = Array.isArray(detail?.images) ? detail.images : [];
          const primary = imgs.find(i => i?.uri) || imgs[0];
          if (primary?.uri) imageUrl = primary.uri;
        } catch (_e) { /* ignore detail lookup failures */ }
      }
      if (!imageUrl) continue;
      out.push({
        id: r?.id || null,
        title: r?.title || artistName,
        imageUrl,
        thumbUrl: r?.thumb || imageUrl,
        sourceUrl: r?.uri ? `https://www.discogs.com${r.uri}` : null,
      });
      if (out.length >= max) break;
    }
    return out;
  } catch (_e) {
    return [];
  }
}

async function fetchFromLastfm(artistName) {
  const lfm = config.program?.lastFM;
  if (!lfm?.apiKey) return null;

  const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getInfo&artist=${encodeURIComponent(artistName)}&api_key=${lfm.apiKey}&format=json`;
  try {
    const buf = await downloadBuffer(url);
    const data = JSON.parse(buf.toString());
    if (!data.artist) return null;

    const bio = stripHtml(data.artist?.bio?.summary || '').replace(/\s*Read more on Last\.fm\s*/i, '').trim() || null;

    // Find largest image (Last.fm returns array ordered small→large)
    const images = data.artist?.image || [];
    const imgUrl = [...images]
      .reverse()
      .map(img => img && img['#text'])
      .find(u => u && !isLastfmPlaceholder(u)) || null;

    return { bio, imageUrl: imgUrl };
  } catch (_e) {
    return null;
  }
}

async function fetchFromMusicBrainz(artistName) {
  const url = `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(artistName)}&fmt=json&limit=1`;
  try {
    // MusicBrainz requires a User-Agent but node's https does fine for one-offs
    const buf = await downloadBuffer(url);
    const data = JSON.parse(buf.toString());
    const artist = data.artists?.[0];
    if (!artist) return null;

    const parts = [
      artist.disambiguation ? `Also known as: ${artist.disambiguation}.` : null,
      artist['life-span']?.begin ? `Active from ${artist['life-span'].begin}${artist['life-span'].end ? ` to ${artist['life-span'].end}` : ''}.` : null,
      artist.area?.name ? `From ${artist.area.name}.` : null,
    ].filter(Boolean);

    return { bio: parts.join(' ') || null, imageUrl: null };
  } catch (_e) {
    return null;
  }
}

async function saveArtistImage(artistKey, imageUrl) {
  try {
    const buf     = await downloadBuffer(imageUrl);
    const outName = artistKey.replace(/[^a-z0-9_-]/g, '_') + '.jpg';
    const outPath = path.join(ARTIST_IMG_DIR, outName);
    await sharp(buf).resize(ARTIST_IMG_SIZE, ARTIST_IMG_SIZE, { fit: 'cover' }).jpeg({ quality: 85 }).toFile(outPath);
    return outName;
  } catch (_e) {
    return null;
  }
}

async function _hydrateArtistImage(artistKey, canonicalName) {
  const key = String(artistKey || '').toLowerCase().trim();
  if (!key) return 'skip';

  const now = Date.now();
  const lastTry = _imgHydrateLastTry.get(key) || 0;
  if (now - lastTry < HYDRATE_COOLDOWN_MS) return 'skip';
  _imgHydrateLastTry.set(key, now);

  const row = db.getArtistRow(canonicalName || artistKey);
  if (!row || row.imageFile) return 'skip';

  // Prefer Discogs for artist photos; use Last.fm only as fallback.
  let imageUrl = await fetchArtistImageFromDiscogs(row.canonicalName);
  let source = 'discogs';
  if (!imageUrl) {
    const result = await fetchFromLastfm(row.canonicalName);
    imageUrl = result?.imageUrl || null;
    source = 'lastfm';
  }
  if (!imageUrl) {
    // Persist attempt to avoid repeatedly hammering upstream sources for no-image artists.
    db.markArtistFetchAttempt(row.canonicalName);
    return 'no-image';
  }

  const imageFile = await saveArtistImage(row.artistKey, imageUrl);
  if (!imageFile) {
    db.markArtistFetchAttempt(row.canonicalName);
    return 'failed';
  }

  db.saveArtistInfo(row.canonicalName, {
    bio: row.bio || null,
    imageFile,
    imageSource: source,
  });
  invalidateArtistCache();
  return 'success';
}

function _enqueueHydration(artistKey, canonicalName) {
  const key = String(artistKey || '').toLowerCase().trim();
  if (!key || _imgHydrateQueued.has(key)) return;
  if (_imgHydrateQueue.length >= HYDRATE_QUEUE_LIMIT) {
    _imgHydrateStats.dropped += 1;
    return;
  }
  _imgHydrateQueued.add(key);
  _imgHydrateQueue.push({ artistKey: key, canonicalName });
  _imgHydrateStats.enqueued += 1;
}

function _queueHomeImageHydration(stats) {
  const top = (stats.topArtists || []).slice(0, 50);
  const recent = (stats.recentArtists || []).slice(0, 50);
  const mostPlayed = (stats.mostPlayedArtists || []).slice(0, 50);
  for (const a of top) {
    if (!a || a.imageFile) continue;
    _enqueueHydration(a.artistKey, a.canonicalName);
  }
  for (const a of recent) {
    if (!a || a.imageFile) continue;
    _enqueueHydration(a.artistKey, a.canonicalName);
  }
  for (const a of mostPlayed) {
    if (!a || a.imageFile) continue;
    _enqueueHydration(a.artistKey, a.canonicalName);
  }
  _drainHydrationQueue().catch(() => {});
}

function _queueListImageHydration(artists, limit = 120) {
  const rows = Array.isArray(artists) ? artists.slice(0, limit) : [];
  for (const a of rows) {
    if (!a || a.imageFile) continue;
    _enqueueHydration(a.artistKey, a.canonicalName);
  }
  _drainHydrationQueue().catch(() => {});
}

async function _drainHydrationQueue() {
  if (_imgHydrateRunning) return;
  _imgHydrateRunning = true;
  try {
    while (_imgHydrateQueue.length > 0) {
      _imgHydrateStats.lastRunAt = Date.now();
      const item = _imgHydrateQueue.shift();
      if (!item) continue;
      _imgHydrateQueued.delete(item.artistKey);
      try {
        const result = await _hydrateArtistImage(item.artistKey, item.canonicalName);
        _imgHydrateStats.processed += 1;
        if (result === 'success') {
          _imgHydrateStats.succeeded += 1;
          _imgHydrateStats.lastSuccessAt = Date.now();
        } else if (result === 'no-image') {
          _imgHydrateStats.noImage += 1;
        } else if (result === 'failed') {
          _imgHydrateStats.failed += 1;
          _imgHydrateStats.lastErrorAt = Date.now();
          _imgHydrateStats.lastError = 'image processing failed';
        }
        const waitMs = (result === 'success')
          ? HYDRATE_DELAY_OK_MS
          : (result === 'no-image' || result === 'skip')
            ? HYDRATE_DELAY_IDLE_MS
            : HYDRATE_DELAY_ERR_MS;
        await new Promise(r => setTimeout(r, waitMs));
      } catch (_e) {
        // non-fatal; continue queue
        _imgHydrateStats.processed += 1;
        _imgHydrateStats.failed += 1;
        _imgHydrateStats.lastErrorAt = Date.now();
        _imgHydrateStats.lastError = String(_e?.message || _e || 'hydrate error');
        await new Promise(r => setTimeout(r, HYDRATE_DELAY_ERR_MS));
      }
    }
  } finally {
    _imgHydrateRunning = false;
  }
}

function hydrationStatusSnapshot() {
  const discogs = discogsStatus();
  return {
    running: _imgHydrateRunning,
    queueLength: _imgHydrateQueue.length,
    queueLimit: HYDRATE_QUEUE_LIMIT,
    delayMs: {
      ok: HYDRATE_DELAY_OK_MS,
      noImage: HYDRATE_DELAY_IDLE_MS,
      error: HYDRATE_DELAY_ERR_MS,
    },
    discogs,
    stats: { ..._imgHydrateStats },
  };
}

function seedHydrationFromMissing(limit = 500) {
  const rows = db.getArtistImageAudit('missing', Math.max(1, Math.min(2000, Number(limit) || 500)));
  let enqueued = 0;
  for (const a of rows) {
    const before = _imgHydrateQueue.length;
    _enqueueHydration(a.artistKey, a.canonicalName);
    if (_imgHydrateQueue.length > before) enqueued += 1;
  }
  _drainHydrationQueue().catch(() => {});
  return enqueued;
}

// ── Allowed vpaths helper (reuse pattern from rest of API) ────────────────────

function getAllowedVpaths(req) {
  const folders = config.program?.folders || {};
  const all = Object.keys(folders);
  if (req.user.admin) return all;
  const allowed = req.user.vpaths || [];
  return all.filter(v => allowed.includes(v));
}

// ── Route setup ───────────────────────────────────────────────────────────────

export function setup(mstream) {

  // Serve artist images from image-cache/artists/
  mstream.get('/api/v1/artists/images/:filename', (req, res) => {
    const name = req.params.filename;
    // Security: only allow simple filenames with no path traversal
    if (!name || !/^[a-zA-Z0-9_\-\.]+\.(jpg|jpeg|png|webp)$/i.test(name)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(ARTIST_IMG_DIR, name);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(ARTIST_IMG_DIR) + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    res.sendFile(resolved);
  });

  // ── GET /api/v1/artists/home ──────────────────────────────────────────────
  // Returns: totalCount, topArtists (top 20 by song count), recentArtists (last 10 played).
  // Fully precomputed — no file table join.
  mstream.get('/api/v1/artists/home', (req, res) => {
    try {
      const now = Date.now();
      if (_homeCache && now - _homeCacheTs < CACHE_TTL) {
        _queueHomeImageHydration(_homeCache);
        return res.json(_homeCache);
      }
      const stats = db.getArtistHomeStats();
      _homeCache   = stats;
      _homeCacheTs = now;
      _queueHomeImageHydration(stats);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/artists/letter?l=A ────────────────────────────────────────
  // l = single letter A-Z or '0' for all digit-starting names.
  mstream.get('/api/v1/artists/letter', (req, res) => {
    try {
      const l = req.query.l;
      if (!l || typeof l !== 'string' || !/^[0-9A-Za-z]$/.test(l)) {
        return res.status(400).json({ error: 'Invalid letter. Use A-Z or 0 for digits.' });
      }
      const artists = db.getArtistsByLetter(l);
      _queueListImageHydration(artists, 200);
      res.json({ artists });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/artists/search?q= ─────────────────────────────────────────
  // FTS5 trigram search against artist names.
  mstream.get('/api/v1/artists/search', (req, res) => {
    try {
      const q = req.query.q;
      if (!q || typeof q !== 'string' || q.trim().length < 2) {
        return res.status(400).json({ error: 'Query must be at least 2 characters' });
      }
      // searchArtistsNormalized returns { name, variants[] } objects
      const rawResults = db.searchArtistsNormalized(q.trim(), null, null);
      const artists = rawResults.map(r => {
        // Fetch full row so we have imageFile, songCount etc.
        const row = db.getArtistRow(r.name);
        if (!row) return null;
        return {
          artistKey:    row.artistKey,
          canonicalName: row.canonicalName,
          imageFile:    row.imageFile,
          hasBio:       !!row.bio,
          songCount:    row.songCount || 0,
          rawVariants:  row.rawVariants || [row.canonicalName],
        };
      }).filter(Boolean);
      _queueListImageHydration(artists, 150);
      res.json({ artists });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/artists/profile?key= ──────────────────────────────────────
  mstream.get('/api/v1/artists/profile', (req, res) => {
    try {
      const key = req.query.key;
      if (!key || typeof key !== 'string') {
        return res.status(400).json({ error: 'Missing key' });
      }

      const artistRow = db.getArtistRow(key);
      if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

      const vpaths   = getAllowedVpaths(req);
      const fileRows = db.getArtistFiles(artistRow.rawVariants, vpaths, null);
      const releaseCategories = buildProfile(fileRows, artistRow.canonicalName);

      res.json({
        artistKey     : artistRow.artistKey,
        canonicalName : artistRow.canonicalName,
        bio           : artistRow.bio || null,
        imageFile     : artistRow.imageFile || null,
        imageSource   : artistRow.imageSource || null,
        lastFetched   : artistRow.lastFetched || null,
        releaseCategories,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/artists/fetch-info ─────────────────────────────────────────
  // Admin only. Fetches bio + image from Last.fm (then MusicBrainz fallback).
  mstream.post('/api/v1/artists/fetch-info', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({ artistKey: Joi.string().required() });
    try { joiValidate(schema, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

    const { artistKey } = req.body;
    const artistRow = db.getArtistRow(artistKey);
    if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

    try {
      const lfm = await fetchFromLastfm(artistRow.canonicalName);
      const mb  = (!lfm || !lfm.bio) ? await fetchFromMusicBrainz(artistRow.canonicalName) : null;

      let imageUrl = await fetchArtistImageFromDiscogs(artistRow.canonicalName);
      let source = imageUrl ? 'discogs' : 'lastfm';
      if (!imageUrl) imageUrl = lfm?.imageUrl || null;

      const bio = lfm?.bio || mb?.bio || null;
      if (!bio && !imageUrl) return res.status(502).json({ error: 'No data from Discogs, Last.fm, or MusicBrainz' });

      let imageFile = null;
      if (imageUrl) {
        imageFile = await saveArtistImage(artistRow.artistKey, imageUrl);
      }

      db.saveArtistInfo(artistRow.canonicalName, {
        bio         : bio,
        imageFile   : imageFile || null,
        imageSource : imageFile ? source : (mb ? 'musicbrainz' : 'lastfm'),
      });

      invalidateArtistCache();
      res.json({ ok: true, bio, imageFile, imageSource: imageFile ? source : (mb ? 'musicbrainz' : 'lastfm') });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/artists/set-image ──────────────────────────────────────────
  // Admin only. Downloads a custom image URL, resizes, stores.
  mstream.post('/api/v1/artists/set-image', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({
      artistKey : Joi.string().required(),
      imageUrl  : Joi.string().uri({ scheme: ['http', 'https'] }).required(),
    });
    try { joiValidate(schema, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

    const { artistKey, imageUrl } = req.body;
    const artistRow = db.getArtistRow(artistKey);
    if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

    try {
      const imageFile = await saveArtistImage(artistRow.artistKey, imageUrl);
      if (!imageFile) return res.status(422).json({ error: 'Could not download or process image' });

      db.setArtistImage(artistRow.canonicalName, imageFile, 'custom');
      invalidateArtistCache();
      res.json({ ok: true, imageFile });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/artists/set-name ───────────────────────────────────────────
  // Admin only. Override the canonical display name.
  mstream.post('/api/v1/artists/set-name', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({
      artistKey     : Joi.string().required(),
      canonicalName : Joi.string().min(1).max(200).required(),
    });
    try { joiValidate(schema, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

    const { artistKey, canonicalName } = req.body;
    const artistRow = db.getArtistRow(artistKey);
    if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

    try {
      db.setArtistNameOverride(artistRow.canonicalName, canonicalName);
      invalidateArtistCache();
      res.json({ ok: true, canonicalName });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/artists/mark-image-wrong ──────────────────────────────────
  // Admin-only action available from main player artist views.
  mstream.post('/api/v1/artists/mark-image-wrong', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({
      artistKey : Joi.string().required(),
      wrong     : Joi.boolean().default(true),
    });
    try { joiValidate(schema, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

    const { artistKey, wrong } = req.body;
    const artistRow = db.getArtistRow(artistKey);
    if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

    db.setArtistImageWrongFlag(artistRow.canonicalName, !!wrong);
    invalidateArtistCache();
    res.json({ ok: true, artistKey: artistRow.artistKey, wrong: !!wrong });
  });

  // ── GET /api/v1/admin/artists/image-audit?kind=missing|wrong|with-image&limit=200 ───
  mstream.get('/api/v1/admin/artists/image-audit', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const kind = String(req.query.kind || 'missing').toLowerCase();
    const limit = Number(req.query.limit || 200);
    if (kind !== 'missing' && kind !== 'wrong' && kind !== 'with-image') {
      return res.status(400).json({ error: 'Invalid kind' });
    }
    try {
      const artists = db.getArtistImageAudit(kind, limit);
      const counts = db.getArtistImageAuditCounts();
      res.json({ kind, counts, artists });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/admin/artists/hydration-status ────────────────────────────
  mstream.get('/api/v1/admin/artists/hydration-status', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    try {
      const counts = db.getArtistImageAuditCounts();
      res.json({ ...hydrationStatusSnapshot(), counts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/admin/artists/hydration-seed ─────────────────────────────
  mstream.post('/api/v1/admin/artists/hydration-seed', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({ limit: Joi.number().integer().min(1).max(2000).default(500) });
    try { joiValidate(schema, req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }

    try {
      const enqueued = seedHydrationFromMissing(req.body?.limit || 500);
      const counts = db.getArtistImageAuditCounts();
      res.json({ ok: true, enqueued, ...hydrationStatusSnapshot(), counts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/admin/artists/discogs-candidates?artistKey= ───────────────
  mstream.get('/api/v1/admin/artists/discogs-candidates', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const artistKey = String(req.query.artistKey || '');
    if (!artistKey) return res.status(400).json({ error: 'Missing artistKey' });

    const artistRow = db.getArtistRow(artistKey);
    if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

    try {
      const candidates = await searchDiscogsArtistCandidates(artistRow.canonicalName, 10);
      res.json({ artistKey: artistRow.artistKey, canonicalName: artistRow.canonicalName, candidates });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/admin/artists/apply-image ─────────────────────────────────
  // Admin sets image from Discogs candidate or custom URL link.
  mstream.post('/api/v1/admin/artists/apply-image', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      artistKey : Joi.string().required(),
      imageUrl  : Joi.string().uri({ scheme: ['http', 'https'] }).required(),
      source    : Joi.string().allow('', null).optional(),
    });
    try { joiValidate(schema, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

    const { artistKey, imageUrl, source } = req.body;
    const artistRow = db.getArtistRow(artistKey);
    if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

    try {
      const imageFile = await saveArtistImage(artistRow.artistKey, imageUrl);
      if (!imageFile) return res.status(422).json({ error: 'Could not download or process image' });

      db.setArtistImage(artistRow.canonicalName, imageFile, source || 'custom');
      db.setArtistImageWrongFlag(artistRow.canonicalName, false);
      invalidateArtistCache();
      res.json({ ok: true, imageFile, imageSource: source || 'custom' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
