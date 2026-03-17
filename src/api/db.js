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
    res.json({ artists: db.getArtists(req.user.vpaths, req.body.ignoreVPaths) });
  });

  mstream.post('/api/v1/db/artists-albums', (req, res) => {
    const albums = db.getArtistAlbums(req.body.artist, req.user.vpaths, req.body.ignoreVPaths);
    res.json({ albums });
  });

  mstream.get('/api/v1/db/albums', (req, res) => {
    res.json({ albums: db.getAlbums(req.user.vpaths) });
  });

  mstream.post('/api/v1/db/albums', (req, res) => {
    res.json({ albums: db.getAlbums(req.user.vpaths, req.body.ignoreVPaths) });
  });

  mstream.post('/api/v1/db/album-songs', (req, res) => {
    const results = db.getAlbumSongs(
      req.body.album ? String(req.body.album) : null,
      req.user.vpaths,
      req.user.username,
      { ignoreVPaths: req.body.ignoreVPaths, artist: req.body.artist, year: req.body.year }
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
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);

    const artists = req.body.noArtists === true ? [] : searchByX(req, 'artist');
    const albums = req.body.noAlbums === true ? [] : searchByX(req, 'album');
    const files = req.body.noFiles === true ? [] : searchByX(req, 'filepath');
    const title = req.body.noTitles === true ? [] : searchByX(req, 'title', 'filepath');
    res.json({artists, albums, files, title });
  });

  function searchByX(req, searchCol, resCol) {
    if (!resCol) {
      resCol = searchCol;
    }

    const results = db.searchFiles(searchCol, req.body.search, req.user.vpaths, req.body.ignoreVPaths);

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
    const results = db.getRatedSongs(req.user.vpaths, req.user.username, req.body.ignoreVPaths);
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
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);

    const results = db.getRecentlyAdded(req.user.vpaths, req.user.username, req.body.limit, req.body.ignoreVPaths);
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  mstream.post('/api/v1/db/stats/recently-played', (req, res) => {
    const schema = Joi.object({
      limit: Joi.number().integer().min(1).required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);

    const results = db.getRecentlyPlayed(req.user.vpaths, req.user.username, req.body.limit, req.body.ignoreVPaths);
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  mstream.post('/api/v1/db/stats/most-played', (req, res) => {
    const schema = Joi.object({
      limit: Joi.number().integer().min(1).required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);

    const results = db.getMostPlayed(req.user.vpaths, req.user.username, req.body.limit, req.body.ignoreVPaths);
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
        const optsNoIgnore = { ignoreVPaths: opts.ignoreVPaths, minRating: opts.minRating, filepathPrefix: opts.filepathPrefix };
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
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);
    const albums = db.getAlbumsByDecade(Number(req.body.decade), req.user.vpaths, req.body.ignoreVPaths);
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
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
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
    const albums = db.getAlbumsByGenre(rawSet, req.user.vpaths, req.body.ignoreVPaths);
    res.json({ albums });
  });
}
