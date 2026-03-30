import Joi from 'joi';
import path from 'path';
import * as vpath from '../util/vpath.js';
import * as dbQueue from '../db/task-queue.js';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';
import { mergeGenreRows } from '../util/genre-merge.js';

function renderMetadataObj(row) {
  return {
    "filepath": path.join(row.vpath, row.filepath).replace(/\\/g, '/'),
    "metadata": {
      "artist": row.artist ? row.artist : null,
      "hash": row.hash ? row.hash : null,
      "album": row.album ? row.album : null,
      "track": row.track ? row.track : null,
      "track-of": row.trackOf ? row.trackOf : null,
      "disk": row.disk ? row.disk : null,
      "title": row.title ? row.title : null,
      "year": row.year ? row.year : null,
      "album-art": row.aaFile ? row.aaFile : null,
      "rating": row.rating ? row.rating : null,
      "play-count": row.playCount ? row.playCount : null,
      "last-played": row.lastPlayed ? row.lastPlayed : null,
      "genre": row.genre || null,
      "replaygain-track-db": row.replaygainTrackDb != null ? row.replaygainTrackDb : null,
      "duration": row.duration != null ? row.duration : null
    }
  };
}

// Resolve a file by its child-vpath filepath, falling back to the parent vpath
// if the file is stored in the DB under the parent (scanned before the child
// vpath was added, or vice-versa).  Returns the DB row or null.
function resolveFile(pathInfo, user) {
  let result = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
  if (!result) {
    const folders = config.program?.folders || {};
    const myRoot  = folders[pathInfo.vpath]?.root.replace(/\/?$/, '/');
    if (myRoot) {
      for (const [parentKey, parentFolder] of Object.entries(folders)) {
        if (parentKey === pathInfo.vpath) continue;
        if (user && !user.vpaths.includes(parentKey)) continue;
        const parentRoot = parentFolder.root.replace(/\/?$/, '/');
        if (myRoot.startsWith(parentRoot) && myRoot !== parentRoot) {
          const prefix = myRoot.slice(parentRoot.length);
          result = db.findFileByPath(prefix + pathInfo.relativePath, parentKey);
          if (result) break;
        }
      }
    }
  }
  return result;
}

export function pullMetaData(filepath, user) {
  const pathInfo = vpath.getVPathInfo(filepath, user);
  let result = db.getFileWithMetadata(pathInfo.relativePath, pathInfo.vpath, user.username);

  if (!result) {
    // This vpath may be a sub-folder of another vpath (e.g. "12-inches" lives
    // inside the "Music" root). Try to find the file via the parent vpath.
    const folders = config.program?.folders || {};
    const myRoot  = folders[pathInfo.vpath]?.root.replace(/\/?$/, '/');
    if (myRoot) {
      for (const [parentKey, parentFolder] of Object.entries(folders)) {
        if (parentKey === pathInfo.vpath) continue;
        if (!user.vpaths.includes(parentKey)) continue;
        const parentRoot = parentFolder.root.replace(/\/?$/, '/');
        if (myRoot.startsWith(parentRoot) && myRoot !== parentRoot) {
          const prefix = myRoot.slice(parentRoot.length);
          result = db.getFileWithMetadata(prefix + pathInfo.relativePath, parentKey, user.username);
          if (result) break;
        }
      }
    }
  }

  if (!result) {
    return { "filepath": filepath, "metadata": null };
  }

  // Always return the original filepath so the song plays via the correct vpath
  const rendered = renderMetadataObj(result);
  rendered.filepath = filepath;
  return rendered;
}

export function setup(mstream) {
  mstream.get('/api/v1/db/status', (req, res) => {
    let total = 0;
    for (const vpathItem of req.user.vpaths) {
      total += db.countFilesByVpath(vpathItem);
    }

    res.json({
      totalFileCount: total,
      locked: dbQueue.isScanning(),
      vpaths: req.user.vpaths,
      scanningVpaths: dbQueue.getScanningVpaths().filter(s => req.user.vpaths.includes(s.vpath))
    });
  });

  mstream.post('/api/v1/db/metadata', (req, res) => {
    res.json(pullMetaData(req.body.filepath, req.user));
  });

  mstream.post('/api/v1/db/metadata/batch', (req, res) => {
    const returnThis = {};
    req.body.forEach(f => {
      console.log(f)
      returnThis[f] = pullMetaData(f, req.user);
    });

    res.json(returnThis);
  });

  // legacy enpoint, moved to POST
  mstream.get('/api/v1/db/artists', (req, res) => {
    res.json({ artists: db.getArtists(req.user.vpaths) });
  });

  mstream.post('/api/v1/db/artists', (req, res) => {
    res.json({ artists: db.getArtists(req.user.vpaths, req.body.ignoreVPaths, req.body.excludeFilepathPrefixes) });
  });

  mstream.post('/api/v1/db/artists-albums', (req, res) => {
    const albums = db.getArtistAlbums(req.body.artist, req.user.vpaths, req.body.ignoreVPaths, req.body.excludeFilepathPrefixes, req.body.includeFilepathPrefixes);
    res.json({ albums });
  });

  mstream.get('/api/v1/db/albums', (req, res) => {
    res.json({ albums: db.getAlbums(req.user.vpaths) });
  });

  mstream.post('/api/v1/db/albums', (req, res) => {
    res.json({ albums: db.getAlbums(req.user.vpaths, req.body.ignoreVPaths, req.body.excludeFilepathPrefixes, req.body.includeFilepathPrefixes) });
  });

  mstream.post('/api/v1/db/album-songs', (req, res) => {
    const results = db.getAlbumSongs(
      req.body.album ? String(req.body.album) : null,
      req.user.vpaths,
      req.user.username,
      { ignoreVPaths: req.body.ignoreVPaths, artist: req.body.artist, year: req.body.year, excludeFilepathPrefixes: req.body.excludeFilepathPrefixes }
    );

    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  mstream.post('/api/v1/db/search', (req, res) => {
    const schema = Joi.object({
      search: Joi.string().required(),
      noArtists: Joi.boolean().optional(),
      noAlbums: Joi.boolean().optional(),
      noTitles: Joi.boolean().optional(),
      noFiles: Joi.boolean().optional(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      filepathPrefix: Joi.string().optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional()
    });
    joiValidate(schema, req.body);

    const { positiveTerms, negativeTerms } = parseSearchQuery(req.body.search);
    if (!positiveTerms.length) { res.json({ artists: [], albums: [], files: [], title: [] }); return; }
    const posSearch = positiveTerms.join(' ');

    const artists = req.body.noArtists === true ? [] : searchByX(req, 'artist',   undefined, posSearch, negativeTerms);
    const albums  = req.body.noAlbums  === true ? [] : searchByX(req, 'album',    undefined, posSearch, negativeTerms);
    const files   = req.body.noFiles   === true ? [] : searchByX(req, 'filepath', undefined, posSearch, negativeTerms);
    const title   = req.body.noTitles  === true ? [] : searchByX(req, 'title', 'filepath',   posSearch, negativeTerms);

    // Multi-word smart search: if there are >1 positive tokens, also run a
    // cross-field FTS query so "chaka khan fate" finds songs where artist words
    // and title words are spread across separate columns.
    if (positiveTerms.length > 1) {
      const seenPaths = new Set(title.map(t => t.filepath));
      const crossRows = db.searchFilesAllWords(positiveTerms, req.user.vpaths, req.body.ignoreVPaths, req.body.filepathPrefix || null, req.body.excludeFilepathPrefixes, negativeTerms);
      for (const row of crossRows) {
        const fp = path.join(row.vpath, row.filepath).replace(/\\/g, '/');
        if (!seenPaths.has(fp)) {
          seenPaths.add(fp);
          title.push({
            name: `${row.artist} - ${row.title}`,
            album_art_file: row.aaFile ? row.aaFile : null,
            filepath: fp
          });
        }
      }
    }

    res.json({ artists, albums, files, title });
  });

  function searchByX(req, searchCol, resCol, posSearch, negativeTerms = []) {
    if (!resCol) {
      resCol = searchCol;
    }

    const results = db.searchFiles(searchCol, posSearch, req.user.vpaths, req.body.ignoreVPaths, req.body.filepathPrefix || null, req.body.excludeFilepathPrefixes, negativeTerms);

    const returnThis = [];
    const store = {};
    for (const row of results) {
      if (!store[row[resCol]]) {
        let name = row[resCol];
        let filepath = false;

        if (searchCol === 'filepath') {
          name = path.join(row.vpath, row[resCol]).replace(/\\/g, '/');
          filepath = path.join(row.vpath, row[resCol]).replace(/\\/g, '/');
        } else if (searchCol === 'title') {
          name = `${row.artist} - ${row.title}`;
          filepath = path.join(row.vpath, row[resCol]).replace(/\\/g, '/');
        }

        returnThis.push({
          name: name,
          album_art_file: row.aaFile ? row.aaFile : null,
          filepath
        });
        store[row[resCol]] = true;
      }
    }

    return returnThis;
  }

  // Parse raw search input into positive and negative term lists.
  // Supports: "-word" and "NOT word" syntax to exclude results.
  function parseSearchQuery(raw) {
    const parts = raw.trim().split(/\s+/);
    const positiveTerms = [], negativeTerms = [];
    let skipNext = false;
    for (let i = 0; i < parts.length; i++) {
      if (skipNext) { skipNext = false; continue; }
      const t = parts[i];
      if (t.toLowerCase() === 'not' && i + 1 < parts.length) {
        negativeTerms.push(parts[i + 1]);
        skipNext = true;
      } else if (t.startsWith('-') && t.length > 1) {
        negativeTerms.push(t.slice(1));
      } else {
        positiveTerms.push(t);
      }
    }
    return { positiveTerms, negativeTerms };
  }

  // legacy endpoint, moved to POST
  mstream.get('/api/v1/db/rated', (req, res) => {
    const results = db.getRatedSongs(req.user.vpaths, req.user.username);
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  mstream.post('/api/v1/db/rated', (req, res) => {
    const results = db.getRatedSongs(req.user.vpaths, req.user.username, req.body.ignoreVPaths, req.body.excludeFilepathPrefixes);
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  mstream.post('/api/v1/db/rate-song', (req, res) => {
    const schema = Joi.object({
      filepath: Joi.string().required(),
      rating: Joi.number().integer().min(0).max(10).allow(null).required()
    });
    joiValidate(schema, req.body);

    if (/^https?:\/\//i.test(req.body.filepath)) { return res.status(400).json({ error: 'Cannot rate external URLs' }); }
    const pathInfo = vpath.getVPathInfo(req.body.filepath);
    const result = resolveFile(pathInfo, req.user);
    if (!result) { throw new Error('File Not Found'); }

    const result2 = db.findUserMetadata(result.hash, req.user.username);
    if (!result2) {
      db.insertUserMetadata({
        user: req.user.username,
        hash: result.hash,
        rating: req.body.rating
      });
    } else {
      result2.rating = req.body.rating;
      db.updateUserMetadata(result2);
    }

    res.json({});
    db.saveUserDB();
  });

  mstream.post('/api/v1/db/recent/added', (req, res) => {
    const schema = Joi.object({
      limit: Joi.number().integer().min(1).required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional()
    });
    joiValidate(schema, req.body);

    const results = db.getRecentlyAdded(req.user.vpaths, req.user.username, req.body.limit, req.body.ignoreVPaths, { excludeFilepathPrefixes: req.body.excludeFilepathPrefixes });
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  // ── log a play (always runs — independent of scrobbling) ────
  mstream.post('/api/v1/db/stats/log-play', (req, res) => {
    const schema = Joi.object({ filePath: Joi.string().required() });
    joiValidate(schema, req.body);
    if (/^https?:\/\//i.test(req.body.filePath)) { return res.json({ ok: false }); }
    const pathInfo = vpath.getVPathInfo(req.body.filePath, req.user);
    const fileRow  = resolveFile(pathInfo, req.user);
    if (!fileRow) { return res.json({ ok: false }); }
    const existing = db.findUserMetadata(fileRow.hash, req.user.username);
    if (!existing) {
      db.insertUserMetadata({ user: req.user.username, hash: fileRow.hash, pc: 1, lp: Date.now() });
    } else {
      existing.pc = (existing.pc && typeof existing.pc === 'number') ? existing.pc + 1 : 1;
      existing.lp = Date.now();
      db.updateUserMetadata(existing);
    }
    db.saveUserDB();
    res.json({ ok: true });
  });

  mstream.post('/api/v1/db/stats/recently-played', (req, res) => {
    const schema = Joi.object({
      limit: Joi.number().integer().min(1).required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional()
    });
    joiValidate(schema, req.body);

    const results = db.getRecentlyPlayed(req.user.vpaths, req.user.username, req.body.limit, req.body.ignoreVPaths, { excludeFilepathPrefixes: req.body.excludeFilepathPrefixes });
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  mstream.post('/api/v1/db/stats/most-played', (req, res) => {
    const schema = Joi.object({
      limit: Joi.number().integer().min(1).required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional()
    });
    joiValidate(schema, req.body);

    const results = db.getMostPlayed(req.user.vpaths, req.user.username, req.body.limit, req.body.ignoreVPaths, { excludeFilepathPrefixes: req.body.excludeFilepathPrefixes });
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  mstream.post('/api/v1/db/stats/reset-play-counts', (req, res) => {
    db.resetPlayCounts(req.user.username);
    db.saveUserDB();
    res.json({ success: true });
  });

  mstream.post('/api/v1/db/stats/reset-recently-played', (req, res) => {
    db.resetRecentlyPlayed(req.user.username);
    db.saveUserDB();
    res.json({ success: true });
  });

  mstream.post('/api/v1/db/random-songs', (req, res) => {
    // Ignore list
    let ignoreList = [];
    if (req.body.ignoreList && Array.isArray(req.body.ignoreList)) {
      ignoreList = req.body.ignoreList;
    }

    let ignorePercentage = .5;
    if (req.body.ignorePercentage && typeof req.body.ignorePercentage === 'number' && req.body.ignorePercentage < 1 && !req.body.ignorePercentage < 0) {
      ignorePercentage = req.body.ignorePercentage;
    }

    const hasArtistFilter = Array.isArray(req.body.artists) && req.body.artists.length > 0;

    // ── Lean path: no artist filter → COUNT + single-row OFFSET fetch ──────
    // Avoids loading all 100k+ rows into heap just to pick one.
    // Falls back to the full-load path if the backend returns 0 (Loki) or if
    // the ignoreList has grown too large to reason about efficiently.
    if (!hasArtistFilter) {
      const opts = {
        ignoreVPaths:  req.body.ignoreVPaths,
        minRating:     req.body.minRating,
        filepathPrefix: req.body.filepathPrefix || null,
        ignoreArtists: Array.isArray(req.body.ignoreArtists) ? req.body.ignoreArtists : undefined,
        excludeFilepathPrefixes: req.body.excludeFilepathPrefixes,
      };

      let count = db.countFilesForRandom(req.user.vpaths, req.user.username, opts);

      // Loki stubs return 0 — fall through to full-load path below
      if (count > 0) {
        // Trim ignore list to at most 50% of candidates
        while (ignoreList.length > count * ignorePercentage) {
          ignoreList.shift();
        }
        if (count === 0) { throw new WebError('No songs that match criteria', 400); }

        // Build a sorted set of ignored positions so we can skip efficiently
        const ignoredSet = new Set(ignoreList);

        // Pick a random offset among the non-ignored positions
        const available = count - ignoredSet.size;
        if (available <= 0) {
          // Everything is ignored — reset and pick freely
          ignoreList = [];
          ignoredSet.clear();
        }

        // Random pick: generate random offset in [0, count), skip ignored slots
        let attempts = 0;
        let offset;
        do {
          offset = Math.floor(Math.random() * count);
          attempts++;
        } while (ignoredSet.has(offset) && attempts < count);

        const row = db.pickFileAtOffset(req.user.vpaths, req.user.username, opts, offset);
        if (!row) { throw new WebError('No songs that match criteria', 400); }

        ignoreList.push(offset);
        return res.json({ songs: [renderMetadataObj(row)], ignoreList });
      }

      // ignoreArtists eliminated all candidates — retry without it
      if (count === 0 && Array.isArray(req.body.ignoreArtists) && req.body.ignoreArtists.length > 0) {
        const optsNoIgnore = { ignoreVPaths: opts.ignoreVPaths, minRating: opts.minRating, filepathPrefix: opts.filepathPrefix, excludeFilepathPrefixes: opts.excludeFilepathPrefixes };
        count = db.countFilesForRandom(req.user.vpaths, req.user.username, optsNoIgnore);
        if (count > 0) {
          ignoreList = [];
          const offset = Math.floor(Math.random() * count);
          const row = db.pickFileAtOffset(req.user.vpaths, req.user.username, optsNoIgnore, offset);
          if (!row) { throw new WebError('No songs that match criteria', 400); }
          return res.json({ songs: [renderMetadataObj(row)], ignoreList: [offset] });
        }
      }
      // count still 0 (Loki or truly empty library) → fall through to full-load path
    }

    // ── Full-load path: artist filter active, or Loki backend ────────────────
    const results = db.getAllFilesWithMetadata(req.user.vpaths, req.user.username, {
      ignoreVPaths: req.body.ignoreVPaths,
      minRating: req.body.minRating,
      filepathPrefix: req.body.filepathPrefix || null,
      artists: hasArtistFilter ? req.body.artists : undefined,
      ignoreArtists: Array.isArray(req.body.ignoreArtists) ? req.body.ignoreArtists : undefined,
      excludeFilepathPrefixes: req.body.excludeFilepathPrefixes,
    });

    // If the similar-artists filter returned nothing in the library, retry
    // without it — no 400, no client-side fallback dance, playback never stalls.
    let finalResults = results;
    if (results.length === 0 && hasArtistFilter) {
      finalResults = db.getAllFilesWithMetadata(req.user.vpaths, req.user.username, {
        ignoreVPaths: req.body.ignoreVPaths,
        minRating: req.body.minRating,
        filepathPrefix: req.body.filepathPrefix || null,
        ignoreArtists: Array.isArray(req.body.ignoreArtists) ? req.body.ignoreArtists : undefined,
        excludeFilepathPrefixes: req.body.excludeFilepathPrefixes,
      });
    }

    // If ignoreArtists eliminated all candidates, retry without it so playback never stalls
    if (finalResults.length === 0 && Array.isArray(req.body.ignoreArtists) && req.body.ignoreArtists.length > 0) {
      finalResults = db.getAllFilesWithMetadata(req.user.vpaths, req.user.username, {
        ignoreVPaths: req.body.ignoreVPaths,
        minRating: req.body.minRating,
        filepathPrefix: req.body.filepathPrefix || null,
      });
    }

    const count = finalResults.length;
    if (count === 0) { throw new WebError('No songs that match criteria', 400); }
    while (ignoreList.length > count * ignorePercentage) {
      ignoreList.shift();
    }

    const returnThis = { songs: [], ignoreList: [] };

    // ── Two-stage artist-fair selection (similar-artists mode) ────────────────
    // When an artist filter is active, pick a random *artist* first (equal weight
    // per artist, not per song), then a random song from that artist.
    // This prevents artists with large catalogues from dominating the queue.
    if (hasArtistFilter) {
      // Collect available (non-ignored) indices
      const available = [];
      for (let i = 0; i < count; i++) {
        if (ignoreList.indexOf(i) === -1) available.push(i);
      }
      // If everything is ignored, reset and pick freely
      const pickFrom = available.length > 0 ? available : Array.from({ length: count }, (_, i) => i);
      // Group by artist
      const byArtist = new Map();
      for (const idx of pickFrom) {
        const a = (finalResults[idx].artist || '').trim().toLowerCase();
        if (!byArtist.has(a)) byArtist.set(a, []);
        byArtist.get(a).push(idx);
      }
      const artistKeys = [...byArtist.keys()];
      const chosenArtist = artistKeys[Math.floor(Math.random() * artistKeys.length)];
      const artistIndices = byArtist.get(chosenArtist);
      const pickedIdx = artistIndices[Math.floor(Math.random() * artistIndices.length)];
      returnThis.songs.push(renderMetadataObj(finalResults[pickedIdx]));
      ignoreList.push(pickedIdx);
    } else {
      // ── Standard single-stage random selection (Loki fallback) ───────────
      let randomNumber = Math.floor(Math.random() * count);
      while (ignoreList.indexOf(randomNumber) > -1) {
        randomNumber = Math.floor(Math.random() * count);
      }
      returnThis.songs.push(renderMetadataObj(finalResults[randomNumber]));
      ignoreList.push(randomNumber);
    }

    returnThis.ignoreList = ignoreList;

    res.json(returnThis);
  });

  mstream.post('/api/v1/playlist/load', (req, res) => {
    const playlist = String(req.body.playlistname);
    const returnThis = [];

    const results = db.loadPlaylistEntries(req.user.username, playlist);

    for (const row of results) {
      // Look up metadata (with parent-vpath fallback for child vpaths)
      const meta = pullMetaData(row.filepath, req.user);
      returnThis.push({ id: row.id, filepath: row.filepath, metadata: meta.metadata || {} });
    }

    res.json(returnThis);
  });

  // Returns embedded cue sheet track markers for a single file (used by the player seek bar)
  mstream.get('/api/v1/db/cuepoints', (req, res) => {
    try {
      const pathInfo = vpath.getVPathInfo(req.query.fp, req.user);
      const row = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
      res.json({ cuepoints: row?.cuepoints ? JSON.parse(row.cuepoints) : [] });
    } catch (_e) {
      res.json({ cuepoints: [] });
    }
  });

  // ── GENRE BROWSING ────────────────────────────────────────────
  mstream.get('/api/v1/db/genres', (req, res) => {
    const { genres } = mergeGenreRows(db.getGenres(req.user.vpaths));
    res.json({ genres });
  });

  mstream.post('/api/v1/db/genres', (req, res) => {
    const { genres } = mergeGenreRows(db.getGenres(req.user.vpaths, req.body.ignoreVPaths));
    res.json({ genres });
  });

  // ── GENRE GROUPS (custom display groupings configured by admin) ───────────
  mstream.get('/api/v1/db/genre-groups', (req, res) => {
    try {
      const savedGroups = db.getGenreGroups();
      const { genres: merged, rawMap } = mergeGenreRows(db.getGenres(req.user.vpaths));
      const cntMap = new Map(merged.map(g => [g.genre, g.cnt]));
      if (!savedGroups || savedGroups.length === 0) {
        return res.json({ groups: null, genres: merged });
      }
      // Build reverse map: raw DB string → merged display name (handles legacy raw strings in DB)
      const rawToDisplay = new Map();
      for (const [display, rawSet] of rawMap) for (const raw of rawSet) rawToDisplay.set(raw, display);
      const resolveGenre = g => {
        if (cntMap.has(g)) return g;
        const d = rawToDisplay.get(g);
        return (d && cntMap.has(d)) ? d : null;
      };
      const assignedGenres = new Set();
      const groups = savedGroups.map(grp => ({
        name: grp.name,
        genres: [...new Set(grp.genres.map(resolveGenre).filter(Boolean))]
          .map(g => ({ genre: g, cnt: cntMap.get(g) }))
          .filter(g => g.cnt > 0),
      })).filter(grp => grp.genres.length > 0);
      for (const grp of groups) for (const g of grp.genres) assignedGenres.add(g.genre);
      const otherGenres = merged.filter(g => !assignedGenres.has(g.genre));
      if (otherGenres.length > 0) {
        const existingOther = groups.find(g => g.name.toLowerCase() === 'other');
        if (existingOther) { existingOther.genres.push(...otherGenres); }
        else { groups.push({ name: 'Other', genres: otherGenres }); }
      }
      res.json({ groups, genres: merged });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  mstream.post('/api/v1/db/genre/songs', (req, res) => {
    const schema = Joi.object({
      genre: Joi.string().required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);
    // Re-derive the rawMap so we know which DB genre strings belong to this
    // merged display genre (handles "House, Trance, Chillout" multi-values).
    const { rawMap } = mergeGenreRows(db.getGenres(req.user.vpaths, req.body.ignoreVPaths));
    // Exact lookup first; case-insensitive fallback in case capitalisation drifts.
    let rawSet = rawMap.get(req.body.genre);
    if (!rawSet) {
      const needle = req.body.genre.toLowerCase();
      for (const [k, v] of rawMap) {
        if (k.toLowerCase() === needle) { rawSet = v; break; }
      }
    }
    if (!rawSet || rawSet.size === 0) return res.json([]);
    const results = db.getSongsByGenreRaw(rawSet, req.user.vpaths, req.user.username, req.body.ignoreVPaths);
    res.json(results.map(renderMetadataObj));
  });

  // ── DECADE BROWSING ───────────────────────────────────────────
  mstream.get('/api/v1/db/decades', (req, res) => {
    res.json({ decades: db.getDecades(req.user.vpaths) });
  });

  mstream.post('/api/v1/db/decades', (req, res) => {
    res.json({ decades: db.getDecades(req.user.vpaths, req.body.ignoreVPaths) });
  });

  mstream.post('/api/v1/db/decade/albums', (req, res) => {
    const schema = Joi.object({
      decade: Joi.number().integer().required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional()
    });
    joiValidate(schema, req.body);
    const albums = db.getAlbumsByDecade(Number(req.body.decade), req.user.vpaths, req.body.ignoreVPaths, req.body.excludeFilepathPrefixes);
    res.json({ albums });
  });

  mstream.post('/api/v1/db/decade/songs', (req, res) => {
    const schema = Joi.object({
      decade: Joi.number().integer().required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);
    const songs = db.getSongsByDecade(Number(req.body.decade), req.user.vpaths, req.user.username, req.body.ignoreVPaths);
    res.json(songs.map(renderMetadataObj));
  });

  mstream.post('/api/v1/db/genre/albums', (req, res) => {
    const schema = Joi.object({
      genre: Joi.string().required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional()
    });
    joiValidate(schema, req.body);
    const { rawMap } = mergeGenreRows(db.getGenres(req.user.vpaths, req.body.ignoreVPaths));
    let rawSet = rawMap.get(req.body.genre);
    if (!rawSet) {
      const needle = req.body.genre.toLowerCase();
      for (const [k, v] of rawMap) {
        if (k.toLowerCase() === needle) { rawSet = v; break; }
      }
    }
    if (!rawSet || rawSet.size === 0) return res.json({ albums: [] });
    const albums = db.getAlbumsByGenre(rawSet, req.user.vpaths, req.body.ignoreVPaths, req.body.excludeFilepathPrefixes);
    res.json({ albums });
  });
}
