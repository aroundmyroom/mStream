/**
 * albums-browse.js — Album Library browser (DB-driven, fast)
 *
 * Builds the album tree entirely from indexed DB data — no filesystem walking.
 * Art files (cover.jpg etc.) are discovered via parallel fs.access at the end.
 *
 * Endpoints:
 *   GET /api/v1/albums/browse         → { albums, series }
 *   GET /api/v1/albums/art-file?p=    → serves a filesystem image file
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';

// ── Constants ──────────────────────────────────────────────────────────────────

// Strict disc-folder pattern: keyword + optional space/dash + digit(s)
// Requires the FIRST character after the keyword to be whitespace, dash, or digit.
// 'Disconet' does NOT match because 'o' != whitespace/dash/digit.
const DISC_RE         = /^(CD|Disc|DISC)\s*[-–]?\s*\d/;
const NUMERIC_DISC_RE = /^\d{1,2}$/;

const ART_NAMES = [
  'cover.jpg', 'Cover.jpg', 'front.jpg', 'Front.jpg',
  'Folder.jpg', 'folder.jpg',
  'cover.png', 'Cover.png', 'front.png', 'Front.png',
  'cover.webp', 'Cover.webp',
];
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Cache ──────────────────────────────────────────────────────────────────────

let _cache = null;
let _cacheTs = 0;

export function invalidateCache() {
  _cache = null;
  _cacheTs = 0;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function extractYear(name) {
  const m = name.match(/\((\d{4})\)/) || name.match(/^(\d{4})\s*[-–]/);
  return m ? m[1] : null;
}

function extractArtist(name) {
  const i = name.indexOf(' - ');
  return i > 0 ? name.slice(0, i).trim() : null;
}

function extractTrackNumber(filename) {
  const base = path.basename(filename, path.extname(filename));
  const m = base.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function cleanTrackName(filename) {
  return path.basename(filename, path.extname(filename))
    .replace(/^\d+\.?\s*[-–]?\s*/, '')
    .trim() || path.basename(filename, path.extname(filename));
}

function isDiscFolder(name) {
  return DISC_RE.test(name) || NUMERIC_DISC_RE.test(name);
}

// ── DB-driven tree builder ─────────────────────────────────────────────────────
// No filesystem access for structure — entirely from DB filepath strings.

function buildTrackListFromEntries(entries, vpathName) {
  return entries
    .sort((a, b) =>
      ((a.row.track || 999) - (b.row.track || 999)) ||
      a.parts.at(-1).localeCompare(b.parts.at(-1), undefined, { numeric: true })
    )
    .map(e => ({
      filepath : vpathName + '/' + e.row.filepath,            // "Music/Albums/..."
      title    : e.row.title   || cleanTrackName(e.parts.at(-1)),
      artist   : e.row.artist  || null,
      number   : e.row.track   || extractTrackNumber(e.parts.at(-1)),
      duration : e.row.duration || null,
      aaFile   : e.row.aaFile  || null,
    }));
}

function buildAlbumFromEntries(albumPath, entries, partsBase, vpathName, seriesId) {
  const id          = md5(albumPath);
  const displayName = albumPath.split('/').pop();
  const year        = extractYear(displayName) || null;
  const artist      = extractArtist(displayName) || null;

  // Split entries into direct tracks vs sub-folder entries
  let directEntries = [];
  const subMap = new Map();   // subFolderName → entries[]

  for (const e of entries) {
    if (e.parts.length === partsBase + 1) {
      directEntries.push(e);   // file sits directly in this album folder
    } else if (e.parts.length >= partsBase + 2) {
      const sub = e.parts[partsBase];
      if (!subMap.has(sub)) subMap.set(sub, []);
      subMap.get(sub).push(e);
    }
  }

  const discs = [];

  if (directEntries.length > 0) {
    discs.push({ label: null, discIndex: 1, tracks: buildTrackListFromEntries(directEntries, vpathName) });
  }

  if (subMap.size > 0) {
    const sorted = [...subMap.entries()].sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { numeric: true })
    );
    let discIdx = directEntries.length > 0 ? 2 : 1;
    for (const [subName, subEntries] of sorted) {
      // Only include entries directly in this sub-folder (one level deep)
      const leafEntries = subEntries.filter(e => e.parts.length === partsBase + 2);
      if (leafEntries.length > 0) {
        discs.push({ label: subName, discIndex: discIdx++, tracks: buildTrackListFromEntries(leafEntries, vpathName) });
      }
    }
  }

  // Pick aaFile from any row that has one
  let aaFile = null;
  for (const e of entries) {
    if (e.row.aaFile) { aaFile = e.row.aaFile; break; }
  }

  return { id, path: albumPath, displayName, artist, year, artFile: null, aaFile, seriesId: seriesId || null, discs };
}

function buildTreeFromDB(dbRows, vpathName) {
  // Group all rows by their L1 folder (Albums/<L1>)
  const byL1 = new Map();
  for (const row of dbRows) {
    const parts = row.filepath.split('/');
    // parts[0] = 'Albums', parts[1] = L1, parts[2..] = rest
    const l1 = parts[1];
    if (!l1) continue;
    if (!byL1.has(l1)) byL1.set(l1, []);
    byL1.get(l1).push({ row, parts });
  }

  const albums = [];
  const series = [];

  for (const [l1, entries] of [...byL1.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))) {
    const l1Path = 'Albums/' + l1;

    // Classify L1: direct audio file? or disc sub-folders? or non-disc sub-folders?
    let hasDirectAudio = false;
    const l2Map = new Map();

    for (const e of entries) {
      if (e.parts.length === 3) {
        hasDirectAudio = true;  // file directly inside L1
      } else if (e.parts.length >= 4) {
        const l2 = e.parts[2];
        if (!l2Map.has(l2)) l2Map.set(l2, []);
        l2Map.get(l2).push(e);
      }
    }

    if (hasDirectAudio || l2Map.size === 0) {
      // Flat/single-file album
      albums.push(buildAlbumFromEntries(l1Path, entries, 2, vpathName, null));
    } else {
      const l2names = [...l2Map.keys()];
      const allDiscs = l2names.every(isDiscFolder);

      if (allDiscs) {
        // Multi-disc album
        albums.push(buildAlbumFromEntries(l1Path, entries, 2, vpathName, null));
      } else {
        // Series: each L2 sub-folder is a sub-album within the series
        const seriesId    = md5(l1Path);
        const seriesAlbumIds = [];

        for (const [l2, l2Entries] of [...l2Map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))) {
          const l2Path = l1Path + '/' + l2;
          const album  = buildAlbumFromEntries(l2Path, l2Entries, 3, vpathName, seriesId);
          albums.push(album);
          seriesAlbumIds.push(album.id);
        }

        series.push({
          id: seriesId, path: l1Path, displayName: l1,
          artFile: null, aaFile: null,   // filled by resolveArt
          albumIds: seriesAlbumIds,
        });
      }
    }
  }

  return { albums, series };
}

// ── Art resolution (parallel filesystem checks) ────────────────────────────────

async function resolveArt(albums, series, vpathRoot) {
  // Check art for all albums in parallel — each album tries ART_NAMES sequentially
  await Promise.allSettled(
    albums.map(async album => {
      // Try art at album root
      const folderPath = path.join(vpathRoot, album.path);
      for (const name of ART_NAMES) {
        try {
          await fsp.access(path.join(folderPath, name), fs.constants.R_OK);
          album.artFile = album.path + '/' + name;
          return;
        } catch { /* next */ }
      }
      // Try art inside first disc sub-folder (for multi-disc albums with no root art)
      const firstDisc = album.discs.find(d => d.label);
      if (firstDisc) {
        const discPath = path.join(folderPath, firstDisc.label);
        for (const name of ART_NAMES) {
          try {
            await fsp.access(path.join(discPath, name), fs.constants.R_OK);
            album.artFile = album.path + '/' + firstDisc.label + '/' + name;
            return;
          } catch { /* next */ }
        }
      }
    })
  );

  // Propagate art to series from first member album that has any
  for (const s of series) {
    const first = s.albumIds.map(id => albums.find(a => a.id === id)).find(a => a?.artFile || a?.aaFile);
    s.artFile = first?.artFile || null;
    s.aaFile  = first?.aaFile  || null;
  }
}

// ── Setup ──────────────────────────────────────────────────────────────────────

// Cached vpathRoot (resolved once at first browse request)
let _vpathRoot = null;
let _vpathName = null;

async function resolveVpathRoot() {
  if (_vpathRoot) return { vpathRoot: _vpathRoot, vpathName: _vpathName };
  const folders = config.program?.folders || {};
  for (const [name, folder] of Object.entries(folders)) {
    const candidate = path.join(folder.root, 'Albums');
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isDirectory()) {
        _vpathRoot = folder.root;
        _vpathName = name;
        return { vpathRoot: _vpathRoot, vpathName: _vpathName };
      }
    } catch { /* not this folder */ }
  }
  return { vpathRoot: null, vpathName: null };
}

export function setup(mstream) {
  // ── GET /api/v1/albums/browse ──────────────────────────────────────────────
  mstream.get('/api/v1/albums/browse', async (req, res) => {
    try {
      const now = Date.now();
      if (_cache && now - _cacheTs < CACHE_TTL) {
        return res.json(_cache);
      }

      const { vpathRoot, vpathName } = await resolveVpathRoot();
      if (!vpathRoot) {
        return res.json({ albums: [], series: [], error: 'No Albums/ folder found' });
      }

      // Build tree purely from DB rows — no filesystem walking
      const rows = db.getFilesForAlbumsBrowse ? db.getFilesForAlbumsBrowse() : [];
      const { albums, series } = buildTreeFromDB(rows, vpathName);

      // Resolve art files in parallel (one Promise per album)
      await resolveArt(albums, series, vpathRoot);

      _cache   = { albums, series };
      _cacheTs = Date.now();

      res.json(_cache);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/albums/art-file ────────────────────────────────────────────
  // Serves a filesystem image (cover.jpg etc.) from within the vpath root.
  // The `p` query param is a path relative to vpathRoot, e.g.
  //   "Albums/Artist/Album/cover.jpg"
  mstream.get('/api/v1/albums/art-file', async (req, res) => {
    try {
      const p = req.query.p;
      if (!p || typeof p !== 'string') {
        return res.status(400).json({ error: 'Missing p' });
      }

      const { vpathRoot } = await resolveVpathRoot();
      if (!vpathRoot) return res.status(404).json({ error: 'Not found' });

      // Prevent path traversal: normalize and verify the resolved path stays
      // inside vpathRoot.
      const resolved = path.resolve(vpathRoot, p);
      const rootResolved = path.resolve(vpathRoot);
      if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
        return res.status(400).json({ error: 'Invalid path' });
      }

      // Only allow image files
      if (!/\.(jpe?g|png|webp|gif)$/i.test(resolved)) {
        return res.status(400).json({ error: 'Not an image' });
      }

      res.sendFile(resolved);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
