/**
 * albums-browse.js — Album Library browser (DB-driven, fast)
 *
 * Builds the album tree entirely from indexed DB data — no filesystem walking.
 * Supports MULTIPLE albumsOnly sources (root vpaths and child vpaths).
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
import axios from 'axios';
import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { getReleaseCoverBuf } from './discogs.js';

// ── Constants ──────────────────────────────────────────────────────────────────

// Strict disc-folder pattern: keyword + optional space/dash + digit(s)
// Requires the FIRST character after the keyword to be whitespace, dash, or digit.
// 'Disconet' does NOT match because 'o' != whitespace/dash/digit.
const DISC_RE         = /^(cd|disc)\s*[-–]?\s*\d/i;
const NUMERIC_DISC_RE = /^\d{1,2}$/;

const ART_NAMES = [
  'cover.jpg', 'Cover.jpg', 'front.jpg', 'Front.jpg',
  'Folder.jpg', 'folder.jpg',
  'cover.png', 'Cover.png', 'front.png', 'Front.png',
  'cover.webp', 'Cover.webp',
];
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Source resolution (all albumsOnly vpaths) ────────────────────────────────
// Returns an array of source descriptors for every vpath configured as albumsOnly.
// Each source:
//   vpathName   — the vpath name used as the player filepath prefix
//   vpathRoot   — absolute filesystem root of the vpath
//   dbVpath     — the vpath name as stored in the `files.vpath` column
//   prefix      — filepath prefix to filter by inside dbVpath (null = all files)
//   artRoot     — filesystem root to resolve artFile paths against
//
// Architecture rules:
//   • Only ROOT vpaths (no parentVpath) are indexed in the DB.
//     VCHILDs are shortcuts/filters — their files are stored under the parent.
//   • A ROOT vpath with albumsOnly:true → include ALL its files (prefix=null)
//   • A CHILD vpath with albumsOnly:true → files are under the PARENT root,
//     filtered by filepathPrefix (e.g. "Albums/")
//   • If NO vpath is marked albumsOnly, fall back to any vpath whose root
//     contains an Albums/ subdirectory.

let _sourcesCache = null;
let _cache        = null;
let _cacheTs      = 0;

export function invalidateCache() {
  _cache = null;
  _cacheTs = 0;
  _sourcesCache = null;
}

async function resolveAlbumsSources() {
  if (_sourcesCache) return _sourcesCache;

  const folders = config.program?.folders || {};
  const folderEntries = Object.entries(folders);

  // Build a parentVpath map (same logic as playlist.js / smart-playlists.js)
  // parentVpath = another folder whose root is a strict prefix of this folder's root
  const parentOf = {};
  for (const [name, folder] of folderEntries) {
    const myRoot = folder.root.replace(/\/?$/, '/');
    const parent = folderEntries.find(([other, otherF]) =>
      other !== name &&
      myRoot.startsWith(otherF.root.replace(/\/?$/, '/')) &&
      otherF.root.replace(/\/?$/, '/') !== myRoot
    );
    parentOf[name] = parent ? parent[0] : null;
  }

  const albumsOnlyNames = folderEntries
    .filter(([, f]) => f.albumsOnly === true)
    .map(([name]) => name);

  const sources = [];

  for (const name of albumsOnlyNames) {
    const folder = folders[name];
    const parent = parentOf[name];

    if (!parent) {
      // Root vpath marked albumsOnly — all its files are in the DB under this vpath,
      // filepath starts at root (e.g. "01 Track.flac" or "Artist/Album/01.flac")
      sources.push({
        vpathName : name,
        vpathRoot : folder.root,
        dbVpath   : name,
        prefix    : null,   // no prefix filter — include everything
        artRoot   : folder.root,
      });
    } else {
      // Child vpath — files are indexed under the parent root.
      // filepathPrefix = relative path from parent root to this folder
      const parentRoot = folders[parent].root.replace(/\/?$/, '/');
      const myRoot     = folder.root.replace(/\/?$/, '/');
      const prefix     = myRoot.slice(parentRoot.length); // e.g. "Albums/"
      sources.push({
        vpathName : name,
        vpathRoot : folder.root,
        dbVpath   : parent,
        prefix    : prefix,
        artRoot   : folder.root,
      });
    }
  }

  // Fallback: if nothing is marked albumsOnly, find any root with an Albums/ subdir.
  // Skip roots where the Albums/ subdirectory is already explicitly registered
  // as its own vpath (regardless of that vpath's albumsOnly setting) — this
  // respects an operator explicitly setting albumsOnly:false on the Albums vpath.
  const explicitRoots = new Set(folderEntries.map(([, f]) => f.root.replace(/\/?$/, '')));
  if (sources.length === 0) {
    for (const [name, folder] of folderEntries) {
      if (parentOf[name]) continue; // skip children
      const candidate = path.join(folder.root, 'Albums');
      if (explicitRoots.has(candidate)) continue; // Albums/ is its own configured vpath — honour albumsOnly:false
      try {
        const stat = await fsp.stat(candidate);
        if (stat.isDirectory()) {
          sources.push({
            vpathName : name,
            vpathRoot : folder.root,
            dbVpath   : name,
            prefix    : 'Albums/',
            artRoot   : folder.root,
          });
          break;
        }
      } catch { /* not here */ }
    }
  }

  _sourcesCache = sources;
  return sources;
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

function buildTrackListFromEntries(entries, source) {
  return entries
    .sort((a, b) =>
      ((a.row.track || 999) - (b.row.track || 999)) ||
      a.parts.at(-1).localeCompare(b.parts.at(-1), undefined, { numeric: true })
    )
    .map(e => {
      let cuepoints = [];
      try { if (e.row.cuepoints) cuepoints = JSON.parse(e.row.cuepoints); } catch { /* ignore */ }
      return {
        // Use dbVpath + original DB filepath so the URL always routes through the
        // parent/root vpath's static mount (avoids spaces-in-vpathName encoding issues).
        filepath  : source.dbVpath + '/' + e.row.filepath,
        title     : e.row.title   || cleanTrackName(e.parts.at(-1)),
        artist    : e.row.artist  || null,
        number    : e.row.track   || extractTrackNumber(e.parts.at(-1)),
        duration  : e.row.duration || null,
        aaFile    : e.row.aaFile  || null,
        cuepoints : cuepoints.length >= 2 ? cuepoints : [],
      };
    });
}

function buildAlbumFromEntries(albumPath, entries, partsBase, vpathName, seriesId, source) {
  const id          = md5(albumPath);
  const pathParts   = albumPath.split('/');
  const displayName = pathParts.pop();
  const year        = extractYear(displayName) || null;
  // Primary: "Artist - Album" convention in the folder name itself.
  // Fallback: the parent folder is the artist (e.g. Albums/Isaac Hayes/Branded →
  // parent "Isaac Hayes" is the artist when displayName contains no " - ").
  // Guard: skip when the parent is the vpath root (only 1 part left after pop).
  const parentFolder = pathParts.length >= 2 ? pathParts[pathParts.length - 1] : null;
  const artist      = extractArtist(displayName) || parentFolder || null;

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
    discs.push({ label: null, discIndex: 1, tracks: buildTrackListFromEntries(directEntries, source) });
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
        discs.push({ label: subName, discIndex: discIdx++, tracks: buildTrackListFromEntries(leafEntries, source) });
      }
    }
  }

  // Pick aaFile and cover_file from any row that has one
  let aaFile = null, coverFile = null;
  for (const e of entries) {
    if (!aaFile && e.row.aaFile)        aaFile    = e.row.aaFile;
    if (!coverFile && e.row.cover_file) coverFile = e.row.cover_file;
    if (aaFile && coverFile) break;
  }

  // artFile built from DB cover_file — no NFS access needed
  const artFile = coverFile ? albumPath + '/' + coverFile : null;

  return { id, path: albumPath, displayName, artist, year, artFile, aaFile, seriesId: seriesId || null, discs, sourceVpath: vpathName || null, _artRoot: source?.artRoot || null, _artPrefix: source?.prefix || null };
}

function buildTreeFromDB(dbRows, source) {
  // source.prefix: if set, strip it from the front of filepath to get the
  // relative path within _this_ library root.  e.g. filepath="Albums/X/Y.mp3"
  // with prefix="Albums/" → treePath="X/Y.mp3"
  // For a root albumsOnly vpath, prefix is null and filepath is already relative.
  const prefixLen = source.prefix ? source.prefix.length : 0;
  const vpathName = source.vpathName;

  // Group by L1 folder (first path segment after stripping prefix)
  const byL1 = new Map();
  for (const row of dbRows) {
    const treePath = prefixLen > 0 ? row.filepath.slice(prefixLen) : row.filepath;
    const parts = treePath.split('/');
    // parts[0] = L1 (album or artist folder), parts[1..] = rest
    const l1 = parts[0];
    if (!l1) continue;
    if (!byL1.has(l1)) byL1.set(l1, []);
    // Store treePath parts and original row; also track original filepath for player URL
    byL1.get(l1).push({ row, parts, originalFilepath: row.filepath });
  }

  const albums = [];
  const series = [];

  for (const [l1, entries] of [...byL1.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))) {
    // l1Path is the display/art path (relative to artRoot)
    const l1Path = source.prefix
      ? source.prefix.replace(/\/$/, '') + '/' + l1
      : l1;

    let hasDirectAudio = false;
    const l2Map = new Map();

    for (const e of entries) {
      if (e.parts.length === 2) {
        hasDirectAudio = true;  // file directly inside L1
      } else if (e.parts.length >= 3) {
        const l2 = e.parts[1];
        if (!l2Map.has(l2)) l2Map.set(l2, []);
        l2Map.get(l2).push(e);
      }
    }

    if (hasDirectAudio || l2Map.size === 0) {
      albums.push(buildAlbumFromEntries(l1Path, entries, 1, vpathName, null, source));
    } else {
      const l2names = [...l2Map.keys()];
      const allDiscs = l2names.every(isDiscFolder);

      if (allDiscs) {
        albums.push(buildAlbumFromEntries(l1Path, entries, 1, vpathName, null, source));
      } else {
        const seriesId = md5(l1Path);
        const seriesAlbumIds = [];

        for (const [l2, l2Entries] of [...l2Map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))) {
          const l2Path = l1Path + '/' + l2;
          const album  = buildAlbumFromEntries(l2Path, l2Entries, 2, vpathName, seriesId, source);
          albums.push(album);
          seriesAlbumIds.push(album.id);
        }

        series.push({
          id: seriesId, path: l1Path, displayName: l1,
          artFile: null, aaFile: null,
          albumIds: seriesAlbumIds,
          sourceVpath: vpathName,
        });
      }
    }
  }

  return { albums, series };
}

// ── Art resolution (parallel filesystem checks) ────────────────────────────────
// artRoot per album comes from source.artRoot stored in album._artRoot
async function resolveArt(albums, series) {
  // Check art for all albums in parallel — each album tries ART_NAMES sequentially
  await Promise.allSettled(
    albums.map(async album => {
      const artRoot = album._artRoot;
      if (!artRoot) return;
      // Strip source prefix before joining with artRoot to avoid double-segment path.
      // e.g. artRoot=/media/music/Albums, album.path="Albums/Artist" → strip "Albums/" → "Artist"
      const relPath    = (album._artPrefix && album.path.startsWith(album._artPrefix))
        ? album.path.slice(album._artPrefix.length)
        : album.path;
      const folderPath = path.join(artRoot, relPath);
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

export function setup(mstream) {
  // ── GET /api/v1/albums/browse ──────────────────────────────────────────────
  mstream.get('/api/v1/albums/browse', async (req, res) => {
    try {
      const now = Date.now();
      if (_cache && now - _cacheTs < CACHE_TTL) {
        return res.json(_cache);
      }

      const sources = await resolveAlbumsSources();
      if (!sources.length) {
        return res.json({ albums: [], series: [], error: 'No albumsOnly vpath or Albums/ folder found' });
      }

      // For each source, query DB rows filtered to that source and build a partial tree
      const allAlbums = [];
      const allSeries = [];

      for (const source of sources) {
        const rows = db.getFilesForAlbumsBrowse([{ vpath: source.dbVpath, prefix: source.prefix }]);
        const { albums, series } = buildTreeFromDB(rows, source);
        allAlbums.push(...albums);
        allSeries.push(...series);
      }

      // Resolve art files in parallel across all albums
      await resolveArt(allAlbums, allSeries);

      // Strip internal fields before sending to client
      const albums = allAlbums.map(({ _artRoot, _artPrefix, ...a }) => a);
      const series = allSeries;

      _cache   = { albums, series };
      _cacheTs = Date.now();

      res.json(_cache);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/albums/art-file ────────────────────────────────────────────
  // Serves a filesystem image (cover.jpg etc.) identified by its relative path
  // as returned in the artFile field of the browse response.
  // The `p` query param is e.g. "Albums/Artist - Title/cover.jpg"
  // We try every known albumsOnly artRoot until one resolves.
  mstream.get('/api/v1/albums/art-file', async (req, res) => {
    try {
      const p = req.query.p;
      if (!p || typeof p !== 'string') {
        return res.status(400).json({ error: 'Missing p' });
      }
      if (!/\.(jpe?g|png|webp|gif)$/i.test(p)) {
        return res.status(400).json({ error: 'Not an image' });
      }

      const sources = await resolveAlbumsSources();

      for (const source of sources) {
        const artRoot  = source.artRoot;
        // Strip source prefix from p if present (same issue as set-art):
        // p is e.g. "Albums/Artist/cover.jpg" but artRoot already points inside Albums/
        const relP     = (source.prefix && p.startsWith(source.prefix))
          ? p.slice(source.prefix.length)
          : p;
        const resolved     = path.resolve(artRoot, relP);
        const rootResolved = path.resolve(artRoot);
        // Security: stay inside this artRoot
        if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
          continue;
        }
        try {
          await fsp.access(resolved, fs.constants.R_OK);
          return res.sendFile(resolved);
        } catch { /* try next source */ }
      }

      res.status(404).json({ error: 'Not found' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/albums/set-art ───────────────────────────────────────────
  // Admin only. Downloads a cover image and writes it as cover.jpg inside the
  // album folder on disk.  albumPath is the `album.path` value from the browse
  // response (relative to artRoot, e.g. "Albums/Artist - Title (1990)").
  // Supply either releaseId (Discogs) or coverUrl (Deezer, iTunes, URL paste).
  mstream.post('/api/v1/albums/set-art', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({
      albumPath : Joi.string().required(),
      releaseId : Joi.number().integer(),
      coverUrl  : Joi.string().uri({ scheme: ['http', 'https'] }),
    }).or('releaseId', 'coverUrl');

    try {
      joiValidate(schema, req.body);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const albumPath = req.body.albumPath;

    // Resolve album folder: iterate all albumsOnly artRoots.
    // album.path is built in buildTreeFromDB as: prefix + l1 (e.g. "Albums/Artist Name").
    // artRoot for a child vpath is the child's own root (e.g. /media/music/Albums).
    // So we must strip the prefix before resolving against artRoot to avoid doubling it.
    const sources   = await resolveAlbumsSources();
    let albumDir    = null;
    for (const source of sources) {
      // Strip source prefix from albumPath if present so path is relative to artRoot
      const relPath   = (source.prefix && albumPath.startsWith(source.prefix))
        ? albumPath.slice(source.prefix.length)
        : albumPath;
      const candidate    = path.resolve(source.artRoot, relPath);
      const rootResolved = path.resolve(source.artRoot);
      // Security: path must stay within artRoot
      if (candidate !== rootResolved && !candidate.startsWith(rootResolved + path.sep)) continue;
      try {
        const stat = await fsp.stat(candidate);
        if (stat.isDirectory()) { albumDir = candidate; break; }
      } catch { /* try next source */ }
    }
    if (!albumDir) return res.status(404).json({ error: 'Album folder not found' });

    // Download the image
    let imgBuf;
    try {
      if (req.body.releaseId) {
        imgBuf = await getReleaseCoverBuf(req.body.releaseId);
      } else {
        const resp = await axios.get(req.body.coverUrl, {
          responseType  : 'arraybuffer',
          headers       : { 'User-Agent': 'mStreamVelvet/dev +https://github.com/aroundmyroom/mStream' },
          maxContentLength: 20 * 1024 * 1024,
          timeout       : 20000,
        });
        imgBuf = Buffer.from(resp.data);
      }
    } catch (e) {
      return res.status(502).json({ error: 'Failed to download image: ' + e.message });
    }

    // Convert to JPEG and write as cover.jpg using sharp (on-demand import,
    // same pattern as discogs.js so it works even if sharp is not a hard dep)
    const coverPath = path.join(albumDir, 'cover.jpg');
    try {
      const { default: sharp } = await import('sharp');
      await sharp(imgBuf)
        .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toFile(coverPath);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to save cover: ' + e.message });
    }

    // Invalidate browse cache so next request returns fresh artFile paths
    invalidateCache();

    const artFile = albumPath.replace(/\\/g, '/') + '/cover.jpg';
    res.json({ artFile });
  });
}
