import path from 'path';
import loki from 'lokijs';
import winston from 'winston';
import escapeStringRegexp from 'escape-string-regexp';
import { createHash } from 'crypto';

// ── Subsonic ID helpers ───────────────────────────────────────────────────────
function _makeArtistId(artist) {
  return createHash('md5').update((artist || '').toLowerCase().trim()).digest('hex').slice(0, 16);
}
function _makeAlbumId(artist, album) {
  return createHash('md5')
    .update(`${(artist || '').toLowerCase().trim()}|||${(album || '').toLowerCase().trim()}`)
    .digest('hex').slice(0, 16);
}

const userDataDbName = 'user-data.loki-v1.db';
const filesDbName = 'files.loki-v3.db';
const shareDbName = 'shared.loki-v1.db';

let filesDB;
let userDataDb;
let shareDB;

let fileCollection;
let playlistCollection;
let userMetadataCollection;
let shareCollection;
let scanErrorCollection;

export function init(dbDirectory) {
  return new Promise((resolve) => {
    shareDB = new loki(path.join(dbDirectory, shareDbName));
    filesDB = new loki(path.join(dbDirectory, filesDbName));
    userDataDb = new loki(path.join(dbDirectory, userDataDbName));

    let loaded = 0;
    const checkDone = () => { if (++loaded === 3) { resolve(); } };

    filesDB.loadDatabase({}, err => {
      if (err) {
        winston.error('Files DB Load Error', { stack: err });
      }
      fileCollection = filesDB.getCollection('files');
      if (!fileCollection) {
        fileCollection = filesDB.addCollection('files');
      }
      fileCollection.ensureIndex('artist_id');
      fileCollection.ensureIndex('album_id');
      // One-time backfill: compute artist_id/album_id for docs predating this migration
      const _bfDocs = fileCollection.where(d => !d.artist_id);
      if (_bfDocs.length > 0) {
        for (const doc of _bfDocs) {
          doc.artist_id = _makeArtistId(doc.artist);
          doc.album_id  = _makeAlbumId(doc.artist, doc.album);
          fileCollection.update(doc);
        }
      }
      scanErrorCollection = filesDB.getCollection('scan_errors');
      if (!scanErrorCollection) {
        scanErrorCollection = filesDB.addCollection('scan_errors', { indices: ['vpath', 'last_seen'] });
      }
      checkDone();
    });

    userDataDb.loadDatabase({}, err => {
      if (err) {
        winston.error('Playlists DB Load Error', { stack: err });
      }
      playlistCollection = userDataDb.getCollection('playlists');
      if (!playlistCollection) {
        playlistCollection = userDataDb.addCollection('playlists');
      }
      userMetadataCollection = userDataDb.getCollection('user-metadata');
      if (!userMetadataCollection) {
        userMetadataCollection = userDataDb.addCollection('user-metadata');
      }
      checkDone();
    });

    shareDB.loadDatabase({}, _err => {
      shareCollection = shareDB.getCollection('playlists');
      if (shareCollection === null) {
        shareCollection = shareDB.addCollection('playlists');
      }
      checkDone();
    });
  });
}

export function close() {}

// Save operations
export function saveFilesDB() {
  filesDB.saveDatabase(err => {
    if (err) { winston.error('Files DB Save Error', { stack: err }); }
    winston.info('Metadata DB Saved');
  });
}

export function saveUserDB() {
  userDataDb.saveDatabase(err => {
    if (err) { winston.error('User DB Save Error', { stack: err }); }
  });
}

export function saveShareDB() {
  shareDB.saveDatabase(err => {
    if (err) { winston.error('Share DB Save Error', { stack: err }); }
  });
}

// Helper: map $loki to id in returned objects
function mapId(obj) {
  if (!obj) { return obj; }
  const result = { ...obj, id: obj.$loki };
  return result;
}

// Helper for vpath OR clause
function renderOrClause(vpaths, ignoreVPaths) {
  if (vpaths.length === 1) {
    return { 'vpath': { '$eq': vpaths[0] } };
  }

  const returnThis = { '$or': [] };
  for (const vpathItem of vpaths) {
    if (ignoreVPaths && typeof ignoreVPaths === 'object' && ignoreVPaths.includes(vpathItem)) {
      continue;
    }
    returnThis['$or'].push({ 'vpath': { '$eq': vpathItem } });
  }
  return returnThis;
}

// Filters out rows matching any of the excluded filepath prefixes.
// Used to exclude 'audio-books' child folders from music queries.
function _applyExcludePrefixes(results, excludeFilepathPrefixes) {
  if (!Array.isArray(excludeFilepathPrefixes) || excludeFilepathPrefixes.length === 0) return results;
  return results.filter(row => !excludeFilepathPrefixes.some(ep =>
    row.vpath === ep.vpath && row.filepath && row.filepath.startsWith(ep.prefix)
  ));
}

// File Operations
export function findFileByPath(filepath, vpath) {
  if (!fileCollection) { return null; }
  const result = fileCollection.findOne({ '$and': [{ 'filepath': filepath }, { 'vpath': vpath }] });
  return mapId(result);
}

export function updateFileScanId(file, scanId) {
  const dbFile = fileCollection.findOne({ '$and': [{ 'filepath': file.filepath }, { 'vpath': file.vpath }] });
  if (dbFile) {
    dbFile.sID = scanId;
    fileCollection.update(dbFile);
  }
}

export function findFilesByPaths(filepaths, vpath) {
  const map = new Map();
  for (const fp of filepaths) {
    const result = findFileByPath(fp, vpath);
    if (result) map.set(fp, result);
  }
  return map;
}

export function batchUpdateScanIds(filepaths, vpath, scanId) {
  for (const fp of filepaths) {
    const dbFile = fileCollection.findOne({ '$and': [{ 'filepath': fp }, { 'vpath': vpath }] });
    if (dbFile) { dbFile.sID = scanId; fileCollection.update(dbFile); }
  }
}

export function updateFileArt(filepath, vpath, aaFile, scanId, artSource = null) {
  const dbFile = fileCollection.findOne({ '$and': [{ 'filepath': { '$eq': filepath } }, { 'vpath': { '$eq': vpath } }] });
  if (dbFile) {
    dbFile.aaFile = aaFile;
    dbFile.sID = scanId;
    dbFile.art_source = artSource;
    fileCollection.update(dbFile);
  }
}

export function countArtUsage(aaFile) {
  return fileCollection.count({ 'aaFile': { '$eq': aaFile } });
}

export function updateFileCue(filepath, vpath, cuepoints) {
  const dbFile = fileCollection.findOne({ '$and': [{ 'filepath': { '$eq': filepath } }, { 'vpath': { '$eq': vpath } }] });
  if (dbFile) {
    dbFile.cuepoints = cuepoints;
    fileCollection.update(dbFile);
  }
}

export function updateFileDuration(filepath, vpath, duration) {
  const dbFile = fileCollection.findOne({ '$and': [{ 'filepath': { '$eq': filepath } }, { 'vpath': { '$eq': vpath } }] });
  if (dbFile) {
    dbFile.duration = duration;
    fileCollection.update(dbFile);
  }
}

export function getFileDuration(filepath) {
  const doc = fileCollection.findOne({ filepath: { '$eq': filepath } });
  return doc?.duration ?? null;
}

export function updateFileTags(filepath, vpath, tags) {
  const dbFile = fileCollection.findOne({ '$and': [{ 'filepath': { '$eq': filepath } }, { 'vpath': { '$eq': vpath } }] });
  if (!dbFile) return;
  Object.assign(dbFile, tags);
  if ('artist' in tags || 'album' in tags) {
    dbFile.artist_id = _makeArtistId(dbFile.artist);
    dbFile.album_id  = _makeAlbumId(dbFile.artist, dbFile.album);
  }
  fileCollection.update(dbFile);
}

export function insertFile(fileData) {
  // If this hash already exists under a different vpath, inherit that ts so the
  // file doesn't appear as "newly added" just because a new vpath was created.
  if (fileData.hash) {
    const existing = fileCollection.findOne({ hash: { $eq: fileData.hash }, ts: { $ne: null } });
    if (existing) { fileData = { ...fileData, ts: existing.ts }; }
  }
  const result = fileCollection.insert(fileData);
  return mapId(result);
}

export function removeFileByPath(filepath, vpath) {
  fileCollection.findAndRemove({ '$and': [
    { 'filepath': { '$eq': filepath } },
    { 'vpath': { '$eq': vpath } }
  ]});
}

export function getLiveArtFilenames() {
  return fileCollection.find({ aaFile: { $ne: null } }).map(f => f.aaFile).filter(Boolean);
}

export function getLiveHashes() {
  return fileCollection.find({ hash: { $ne: null } }).map(f => f.hash).filter(Boolean);
}

export function getStaleFileHashes(vpath, scanId) {
  return fileCollection.find({ '$and': [
    { 'vpath': { '$eq': vpath } },
    { 'sID':   { '$ne': scanId } }
  ]}).map(f => f.hash).filter(Boolean);
}

export function removeStaleFiles(vpath, scanId) {
  fileCollection.findAndRemove({ '$and': [
    { 'vpath': { '$eq': vpath } },
    { 'sID': { '$ne': scanId } }
  ]});
}

export function removeFilesByVpath(vpath) {
  fileCollection.findAndRemove({ 'vpath': { '$eq': vpath } });
}

export function countFilesByVpath(vpath) {
  if (!fileCollection) { return 0; }
  return fileCollection.count({ 'vpath': vpath });
}

export function getLastScannedMs() {
  if (!fileCollection) return null;
  const docs = fileCollection.data;
  let max = null;
  for (const d of docs) { if (d.ts && (!max || d.ts > max)) max = d.ts; }
  return max ? max * 1000 : null;
}

export function getStats() {
  if (!fileCollection) {
    return {
      totalFiles: 0, totalArtists: 0, totalAlbums: 0, totalGenres: 0,
      withArt: 0, withoutArt: 0,
      artFromDiscogs: 0, artEmbedded: 0, artFromDirectory: 0,
      withReplaygain: 0, withCue: 0, cueUnchecked: 0,
      oldestYear: null, newestYear: null, lastScannedTs: null,
      addedLast7Days: 0, addedLast30Days: 0,
      formats: [], perVpath: [], topArtists: [], topGenres: [], decades: [],
      totalDurationSec: 0,
    };
  }

  const now = Date.now();
  const nowSec   = Math.floor(now / 1000);
  const cutoff7  = nowSec - 7  * 86400;
  const cutoff30 = nowSec - 30 * 86400;

  const artists  = new Set();
  const albums   = new Set();
  const genres   = new Set();
  const formatMap = {};
  const vpathMap  = {};
  const artistMap = {};
  const genreMap  = {};
  const decadeMap = {};

  let withArt = 0, withReplaygain = 0, withCue = 0, cueUnchecked = 0;
  let last7 = 0, last30 = 0;
  let oldestYear = null, newestYear = null, lastScannedTs = null;
  let totalDurationSec = 0;
  let artFromDiscogs = 0, artEmbedded = 0, artFromDirectory = 0;

  const docs = fileCollection.data;
  const total = docs.length;

  for (const doc of docs) {
    if (doc.artist)  artists.add(doc.artist);
    if (doc.album)   albums.add(doc.album);
    if (doc.genre && doc.genre.trim()) genres.add(doc.genre.trim());

    if (doc.aaFile && doc.aaFile.trim()) {
      withArt++;
      const src = doc.art_source;
      if (src === 'discogs')   artFromDiscogs++;
      else if (src === 'embedded')   artEmbedded++;
      else if (src === 'directory')  artFromDirectory++;
    }
    if (doc.replaygainTrackDb != null)   withReplaygain++;
    if (doc.cuepoints != null && doc.cuepoints !== '[]') withCue++;
    else if (doc.cuepoints == null) cueUnchecked++;
    if (doc.ts > cutoff7)  last7++;
    if (doc.ts > cutoff30) last30++;
    if (doc.ts && (!lastScannedTs || doc.ts > lastScannedTs)) lastScannedTs = doc.ts * 1000;
    if (doc.duration != null && isFinite(doc.duration)) totalDurationSec += doc.duration;

    const yr = doc.year;
    if (yr >= 1900 && yr <= 2030) {
      const decade = Math.floor(yr / 10) * 10;
      decadeMap[decade] = (decadeMap[decade] || 0) + 1;
      if (oldestYear === null || yr < oldestYear) oldestYear = yr;
      if (newestYear === null || yr > newestYear) newestYear = yr;
    }

    const fmt = doc.format ? doc.format.toLowerCase().trim() : null;
    if (fmt) formatMap[fmt] = (formatMap[fmt] || 0) + 1;

    if (doc.vpath) vpathMap[doc.vpath] = (vpathMap[doc.vpath] || 0) + 1;

    const artist = doc.artist ? doc.artist.trim() : null;
    if (artist) artistMap[artist] = (artistMap[artist] || 0) + 1;

    const genre = doc.genre ? doc.genre.trim() : null;
    if (genre) genreMap[genre] = (genreMap[genre] || 0) + 1;
  }

  const toSortedArr = (map) => Object.entries(map)
    .map(([k, cnt]) => ({ format: k, cnt }))
    .sort((a, b) => b.cnt - a.cnt);

  const formats    = toSortedArr(formatMap);
  const perVpath   = Object.entries(vpathMap).map(([vpath, cnt]) => ({ vpath, cnt })).sort((a, b) => b.cnt - a.cnt);
  const topArtists = Object.entries(artistMap).map(([artist, cnt]) => ({ artist, cnt })).sort((a, b) => b.cnt - a.cnt).slice(0, 5);
  const topGenres  = Object.entries(genreMap).map(([genre, cnt]) => ({ genre, cnt })).sort((a, b) => b.cnt - a.cnt).slice(0, 5);
  const decades    = Object.entries(decadeMap).map(([decade, cnt]) => ({ decade: Number(decade), cnt })).sort((a, b) => a.decade - b.decade);

  return {
    totalFiles: total,
    totalArtists: artists.size,
    totalAlbums:  albums.size,
    totalGenres:  genres.size,
    withArt,
    withoutArt: total - withArt,
    artFromDiscogs,
    artEmbedded,
    artFromDirectory,
    withReplaygain,
    withCue,
    cueUnchecked,
    oldestYear,
    newestYear,
    lastScannedTs,
    addedLast7Days:  last7,
    addedLast30Days: last30,
    formats,
    perVpath,
    topArtists,
    topGenres,
    decades,
    totalDurationSec: Math.round(totalDurationSec),
  };
}

// Metadata Queries
const mapFunDefault = (left, right) => {
  return {
    artist: left.artist,
    album: left.album,
    hash: left.hash,
    track: left.track,
    title: left.title,
    year: left.year,
    aaFile: left.aaFile,
    filepath: left.filepath,
    rating: right.rating,
    "replaygain-track-db": left.replaygainTrackDb,
    vpath: left.vpath
  };
};

const rightFunDefault = (rightData) => {
  return rightData.hash + '-' + rightData.user;
};

export function getFileWithMetadata(filepath, vpath, username) {
  if (!fileCollection) { return null; }

  const leftFun = (leftData) => {
    return leftData.hash + '-' + username;
  };

  const result = fileCollection.chain()
    .find({ '$and': [{ 'filepath': filepath }, { 'vpath': vpath }] }, true)
    .eqJoin(userMetadataCollection.chain(), leftFun, rightFunDefault, mapFunDefault)
    .data();

  if (!result || !result[0]) { return null; }
  return result[0];
}

export function getArtists(vpaths, ignoreVPaths, excludeFilepathPrefixes) {
  if (!fileCollection) { return []; }

  const rawResults = fileCollection.find(renderOrClause(vpaths, ignoreVPaths));
  const results = _applyExcludePrefixes(rawResults, excludeFilepathPrefixes);
  const store = {};
  for (const row of results) {
    if (!store[row.artist] && !(row.artist === undefined || row.artist === null)) {
      store[row.artist] = true;
    }
  }

  return Object.keys(store).sort((a, b) => a.localeCompare(b));
}

export function getArtistAlbums(artist, vpaths, ignoreVPaths, excludeFilepathPrefixes) {
  if (!fileCollection) { return []; }

  const rawResults = fileCollection.chain().find({
    '$and': [
      renderOrClause(vpaths, ignoreVPaths),
      { 'artist': { '$eq': String(artist) } }
    ]
  }).simplesort('year', true).data();
  const results = _applyExcludePrefixes(rawResults, excludeFilepathPrefixes);

  const albums = [];
  const store = {};
  for (const row of results) {
    if (row.album === null) {
      if (!store[row.album]) {
        albums.push({
          name: null,
          year: null,
          album_art_file: row.aaFile ? row.aaFile : null
        });
        store[row.album] = true;
      }
    } else if (!store[`${row.album}${row.year}`]) {
      albums.push({
        name: row.album,
        year: row.year,
        album_art_file: row.aaFile ? row.aaFile : null
      });
      store[`${row.album}${row.year}`] = true;
    }
  }

  return albums;
}

export function getAlbums(vpaths, ignoreVPaths, excludeFilepathPrefixes) {
  if (!fileCollection) { return []; }

  const rawResults = fileCollection.find(renderOrClause(vpaths, ignoreVPaths));
  const results = _applyExcludePrefixes(rawResults, excludeFilepathPrefixes);
  const albums = [];
  const store = {};
  for (const row of results) {
    if (store[`${row.album}${row.year}`] || (row.album === undefined || row.album === null)) {
      continue;
    }
    albums.push({ name: row.album, album_art_file: row.aaFile, year: row.year });
    store[`${row.album}${row.year}`] = true;
  }

  albums.sort((a, b) => a.name.localeCompare(b.name));
  return albums;
}

export function getAlbumSongs(album, vpaths, username, opts) {
  if (!fileCollection) { return []; }

  const searchClause = [
    renderOrClause(vpaths, opts.ignoreVPaths),
    { 'album': { '$eq': album } }
  ];

  if (opts.artist) {
    searchClause.push({ 'artist': { '$eq': opts.artist } });
  }

  if (opts.year) {
    searchClause.push({ 'year': { '$eq': Number(opts.year) } });
  }

  const leftFun = (leftData) => {
    return leftData.hash + '-' + username;
  };

  return fileCollection.chain().find({
    '$and': searchClause
  }).compoundsort(['disk', 'track', 'filepath'])
    .eqJoin(userMetadataCollection.chain(), leftFun, rightFunDefault, mapFunDefault)
    .data();
}

export function searchFiles(searchCol, searchTerm, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes) {
  if (!fileCollection) { return []; }

  const findThis = {
    '$and': [
      renderOrClause(vpaths, ignoreVPaths),
      { [searchCol]: { '$regex': [escapeStringRegexp(String(searchTerm)), 'i'] } }
    ]
  };

  let results = fileCollection.find(findThis);
  if (filepathPrefix && typeof filepathPrefix === 'string') {
    results = results.filter(row => row.filepath && row.filepath.startsWith(filepathPrefix));
  }
  return _applyExcludePrefixes(results, excludeFilepathPrefixes);
}

export function searchFilesAllWords(tokens, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes) {
  if (!fileCollection || tokens.length === 0) { return []; }

  const tokenRegexes = tokens.map(t => new RegExp(escapeStringRegexp(t), 'i'));

  const raw = fileCollection.find(renderOrClause(vpaths, ignoreVPaths)).filter(row => {
    if (filepathPrefix && typeof filepathPrefix === 'string') {
      if (!row.filepath || !row.filepath.startsWith(filepathPrefix)) return false;
    }
    return tokenRegexes.every(re =>
      re.test(row.title || '') ||
      re.test(row.artist || '') ||
      re.test(row.album || '') ||
      re.test(row.filepath || '')
    );
  });
  return _applyExcludePrefixes(raw, excludeFilepathPrefixes);
}

export function getRatedSongs(vpaths, username, ignoreVPaths, excludeFilepathPrefixes) {
  if (!fileCollection) { return []; }

  const mapFun = (left, right) => {
    return {
      artist: right.artist,
      album: right.album,
      hash: right.hash,
      track: right.track,
      title: right.title,
      year: right.year,
      aaFile: right.aaFile,
      filepath: right.filepath,
      rating: left.rating,
      "replaygain-track-db": right.replaygainTrackDb,
      vpath: right.vpath
    };
  };

  const leftFun = (leftData) => {
    return leftData.hash + '-' + leftData.user;
  };

  const rightFun = (rightData) => {
    return rightData.hash + '-' + username;
  };

  return _applyExcludePrefixes(
    userMetadataCollection.chain()
      .eqJoin(fileCollection.chain(), leftFun, rightFun, mapFun)
      .find({
        '$and': [
          renderOrClause(vpaths, ignoreVPaths),
          { 'rating': { '$gt': 0 } }
        ]
      }).simplesort('rating', true).data(),
    excludeFilepathPrefixes
  );
}

export function getRecentlyAdded(vpaths, username, limit, ignoreVPaths, opts = {}) {
  if (!fileCollection) { return []; }

  const leftFun = (leftData) => {
    return leftData.hash + '-' + username;
  };

  const fCond = [renderOrClause(vpaths, ignoreVPaths), { 'ts': { '$gt': 0 } }];
  if (opts.filepathPrefix) {
    const esc = opts.filepathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    fCond.push({ filepath: { '$regex': new RegExp('^' + esc) } });
  }
  const raw = fileCollection.chain().find({ '$and': fCond }).simplesort('ts', true).limit(limit)
    .eqJoin(userMetadataCollection.chain(), leftFun, rightFunDefault, mapFunDefault)
    .data();
  return _applyExcludePrefixes(raw, opts.excludeFilepathPrefixes);
}

export function getRecentlyPlayed(vpaths, username, limit, ignoreVPaths, opts = {}) {
  if (!fileCollection) { return []; }

  const mapFun = (left, right) => {
    return {
      artist: right.artist,
      album: right.album,
      hash: right.hash,
      track: right.track,
      title: right.title,
      year: right.year,
      aaFile: right.aaFile,
      filepath: right.filepath,
      rating: left.rating,
      lastPlayed: left.lp,
      playCount: left.pc,
      "replaygain-track-db": right.replaygainTrackDb,
      vpath: right.vpath
    };
  };

  const leftFun = (leftData) => {
    return leftData.hash + '-' + leftData.user;
  };

  const rightFun = (rightData) => {
    return rightData.hash + '-' + username;
  };

  const fCond = [renderOrClause(vpaths, ignoreVPaths), { 'lastPlayed': { '$gt': 0 } }];
  if (opts.filepathPrefix) {
    const esc = opts.filepathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    fCond.push({ filepath: { '$regex': new RegExp('^' + esc) } });
  }
  const _rpRaw = userMetadataCollection.chain()
    .eqJoin(fileCollection.chain(), leftFun, rightFun, mapFun)
    .find({ '$and': fCond }).simplesort('lastPlayed', true).limit(limit).data();
  return _applyExcludePrefixes(_rpRaw, opts.excludeFilepathPrefixes);
}

export function getMostPlayed(vpaths, username, limit, ignoreVPaths, opts = {}) {
  if (!fileCollection) { return []; }

  const mapFun = (left, right) => {
    return {
      artist: right.artist,
      album: right.album,
      hash: right.hash,
      track: right.track,
      title: right.title,
      year: right.year,
      aaFile: right.aaFile,
      filepath: right.filepath,
      rating: left.rating,
      lastPlayed: left.lp,
      playCount: left.pc,
      "replaygain-track-db": right.replaygainTrackDb,
      vpath: right.vpath
    };
  };

  const leftFun = (leftData) => {
    return leftData.hash + '-' + leftData.user;
  };

  const rightFun = (rightData) => {
    return rightData.hash + '-' + username;
  };

  const fCond = [renderOrClause(vpaths, ignoreVPaths), { 'playCount': { '$gt': 0 } }];
  if (opts.filepathPrefix) {
    const esc = opts.filepathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    fCond.push({ filepath: { '$regex': new RegExp('^' + esc) } });
  }
  const _mpRaw = userMetadataCollection.chain()
    .eqJoin(fileCollection.chain(), leftFun, rightFun, mapFun)
    .find({ '$and': fCond }).simplesort('playCount', true).limit(limit).data();
  return _applyExcludePrefixes(_mpRaw, opts.excludeFilepathPrefixes);
}

export function getAllFilesWithMetadata(vpaths, username, opts) {
  if (!fileCollection) { return []; }

  let orClause = { '$or': [] };
  for (const vpathItem of vpaths) {
    if (opts.ignoreVPaths && typeof opts.ignoreVPaths === 'object' && opts.ignoreVPaths.includes(vpathItem)) {
      continue;
    }
    orClause['$or'].push({ 'vpath': { '$eq': vpathItem } });
  }

  const minRating = Number(opts.minRating);
  if (minRating && typeof minRating === 'number' && minRating <= 10 && !minRating < 1) {
    orClause = { '$and': [
      orClause,
      { 'rating': { '$gte': opts.minRating } }
    ]};
  }

  const leftFun = (leftData) => {
    return leftData.hash + '-' + username;
  };

  return _applyExcludePrefixes(
    fileCollection.chain()
      .eqJoin(userMetadataCollection.chain(), leftFun, rightFunDefault, mapFunDefault)
      .find(orClause)
      .data()
      .filter(doc => {
        if (opts.artists && Array.isArray(opts.artists) && opts.artists.length > 0) {
          const normed = opts.artists.map(a => a.toLowerCase());
          if (!doc.artist || !normed.includes(doc.artist.toLowerCase())) return false;
        }
        if (opts.ignoreArtists && Array.isArray(opts.ignoreArtists) && opts.ignoreArtists.length > 0) {
          const normed = opts.ignoreArtists.map(a => a.toLowerCase());
          if (doc.artist && normed.includes(doc.artist.toLowerCase())) return false;
        }
        return true;
      }),
    opts.excludeFilepathPrefixes
  );
}

// Loki is already an in-memory store — there is no point in a separate COUNT/OFFSET
// path.  These stubs return values that cause api/db.js to fall through to the
// full getAllFilesWithMetadata path, which is correct for Loki.
export function countFilesForRandom() { return 0; }
export function pickFileAtOffset() { return null; }

// User Metadata
export function findUserMetadata(hash, username) {
  if (!userMetadataCollection) { return null; }
  return userMetadataCollection.findOne({ '$and': [{ 'hash': hash }, { 'user': username }] });
}

export function insertUserMetadata(obj) {
  userMetadataCollection.insert(obj);
}

export function updateUserMetadata(obj) {
  userMetadataCollection.update(obj);
}

export function removeUserMetadataByUser(username) {
  userMetadataCollection.findAndRemove({ 'user': { '$eq': username } });
}

export function resetPlayCounts(username) {
  const records = userMetadataCollection.find({ 'user': { '$eq': username } });
  records.forEach(record => {
    record.pc = 0;
    userMetadataCollection.update(record);
  });
}

export function resetRecentlyPlayed(username) {
  const records = userMetadataCollection.find({ 'user': { '$eq': username } });
  records.forEach(record => {
    record.lp = null;
    userMetadataCollection.update(record);
  });
}

// Playlists
export function getUserPlaylists(username) {
  const playlists = [];
  const results = playlistCollection.find({ 'user': { '$eq': username }, 'filepath': { '$eq': null } });
  for (const row of results) {
    playlists.push({ name: row.name });
  }
  return playlists;
}

export function findPlaylist(username, playlistName) {
  return playlistCollection.findOne({
    '$and': [
      { 'user': { '$eq': username } },
      { 'name': { '$eq': playlistName } }
    ]
  });
}

export function createPlaylistEntry(entry) {
  playlistCollection.insert(entry);
}

export function deletePlaylist(username, playlistName) {
  playlistCollection.findAndRemove({
    '$and': [
      { 'user': { '$eq': username } },
      { 'name': { '$eq': playlistName } }
    ]
  });
}

export function getPlaylistEntryById(id) {
  return mapId(playlistCollection.get(id));
}

export function removePlaylistEntryById(id) {
  const result = playlistCollection.get(id);
  if (result) {
    playlistCollection.remove(result);
  }
}

export function loadPlaylistEntries(username, playlistName) {
  const results = playlistCollection.find({
    '$and': [
      { 'user': { '$eq': username } },
      { 'name': { '$eq': playlistName } },
      { 'filepath': { '$ne': null } }
    ]
  });
  return results.map(r => mapId(r));
}

export function removePlaylistsByUser(username) {
  playlistCollection.findAndRemove({ 'user': { '$eq': username } });
}

// Shared Playlists
export function findSharedPlaylist(playlistId) {
  return shareCollection.findOne({ 'playlistId': playlistId });
}

export function insertSharedPlaylist(item) {
  shareCollection.insert(item);
}

export function getAllSharedPlaylists() {
  return shareCollection.find();
}

export function removeSharedPlaylistById(playlistId) {
  shareCollection.findAndRemove({ 'playlistId': { '$eq': playlistId } });
}

export function removeExpiredSharedPlaylists() {
  shareCollection.findAndRemove({ 'expires': { '$lt': Math.floor(Date.now() / 1000) } });
}

export function removeEternalSharedPlaylists() {
  shareCollection.findAndRemove({ 'expires': { '$eq': null } });
  shareCollection.findAndRemove({ 'expires': { '$exists': false } });
}

export function removeSharedPlaylistsByUser(username) {
  shareCollection.findAndRemove({ 'user': { '$eq': username } });
}

// ── Scan Errors ─────────────────────────────────────────────────────────────

export function insertScanError(guid, filepath, vpath, errorType, errorMsg, stack) {
  const now = Math.floor(Date.now() / 1000);
  const existing = scanErrorCollection.findOne({ guid: { '$eq': guid } });
  if (existing) {
    existing.last_seen = now;
    existing.count = (existing.count || 1) + 1;
    existing.fixed_at = null;   // re-occurrence resets fix state
    existing.fix_action = null; // stale action no longer valid
    existing.error_msg = errorMsg || '';
    existing.stack = stack || '';
    scanErrorCollection.update(existing);
  } else {
    scanErrorCollection.insert({
      guid, filepath, vpath,
      error_type: errorType,
      error_msg: errorMsg || '',
      stack: stack || '',
      first_seen: now,
      last_seen: now,
      count: 1,
      fixed_at: null
    });
  }
}

export function getScanErrors(limit = 500) {
  const all = scanErrorCollection.find();
  const sorted = all
    .map(r => ({
      guid: r.guid, filepath: r.filepath, vpath: r.vpath,
      error_type: r.error_type, error_msg: r.error_msg, stack: r.stack,
      first_seen: r.first_seen, last_seen: r.last_seen, count: r.count,
      fixed_at: r.fixed_at || null,
      file_in_db: fileCollection.findOne({ filepath: r.filepath, vpath: r.vpath }) ? 1 : 0
    }))
    .sort((a, b) => {
      if ((a.fixed_at === null) !== (b.fixed_at === null)) return a.fixed_at === null ? -1 : 1;
      return b.last_seen - a.last_seen;
    });
  return { errors: sorted.slice(0, limit), total: sorted.length };
}

export function getScanErrorByGuid(guid) {
  const r = scanErrorCollection.findOne({ guid });
  if (!r) return null;
  return {
    guid: r.guid, filepath: r.filepath, vpath: r.vpath,
    error_type: r.error_type, error_msg: r.error_msg, stack: r.stack,
    first_seen: r.first_seen, last_seen: r.last_seen, count: r.count,
    fixed_at: r.fixed_at || null,
    file_in_db: fileCollection.findOne({ filepath: r.filepath, vpath: r.vpath }) ? 1 : 0
  };
}

export function clearScanErrors() {
  scanErrorCollection.clear();
}

export function pruneScanErrors(retentionHours) {
  const cutoff      = Math.floor(Date.now() / 1000) - retentionHours * 3600;
  const fixedCutoff = Math.floor(Date.now() / 1000) - 48 * 3600;
  scanErrorCollection.findAndRemove({ last_seen: { '$lt': cutoff } });
  scanErrorCollection.findAndRemove({ fixed_at: { '$ne': null, '$lt': fixedCutoff } });
}

export function clearResolvedErrors(vpath, scanStartTs) {
  scanErrorCollection.findAndRemove({ vpath: { '$eq': vpath }, last_seen: { '$lt': scanStartTs } });
}

export function markScanErrorFixed(guid, fixAction) {
  const now = Math.floor(Date.now() / 1000);
  const row = scanErrorCollection.findOne({ guid: { '$eq': guid } });
  if (row) { row.fixed_at = now; row.fix_action = fixAction || null; row.confirmed_at = null; scanErrorCollection.update(row); }
}

export function confirmScanErrorOk(filepath, vpath) {
  const now = Math.floor(Date.now() / 1000);
  const rows = scanErrorCollection.find({
    filepath:     { '$eq': filepath },
    vpath:        { '$eq': vpath },
    fixed_at:     { '$ne': null },
    confirmed_at: { '$eq': null }
  });
  for (const row of rows) { row.confirmed_at = now; scanErrorCollection.update(row); }
}

export function markFileArtChecked(filepath, vpath) {
  const row = fileCollection.findOne({ filepath: { '$eq': filepath }, vpath: { '$eq': vpath } });
  if (row && !row.aaFile) { row.aaFile = ''; fileCollection.update(row); }
}

export function markFileCueChecked(filepath, vpath) {
  const row = fileCollection.findOne({ filepath: { '$eq': filepath }, vpath: { '$eq': vpath } });
  if (row && row.cuepoints === null || row?.cuepoints === undefined) { row.cuepoints = '[]'; fileCollection.update(row); }
}

export function getScanErrorCount() {
  return scanErrorCollection.find({ fixed_at: { '$eq': null } })
    .filter(r => !!fileCollection.findOne({ filepath: r.filepath, vpath: r.vpath }))
    .length;
}

// ── Subsonic-specific queries ────────────────────────────────────────────────

export function getFilesByArtistId(artistId, vpaths, username, opts = {}) {
  if (!fileCollection) return [];
  let docs = fileCollection.find({
    '$and': [renderOrClause(vpaths, null), { artist_id: { '$eq': artistId } }]
  });
  if (opts.filepathPrefix) docs = docs.filter(d => (d.filepath || '').startsWith(opts.filepathPrefix));
  return docs.map(d => {
    const meta = userMetadataCollection
      ? userMetadataCollection.findOne({ '$and': [{ hash: d.hash }, { user: username }] })
      : null;
    return { ...d, rating: meta?.rating ?? null, starred: meta?.starred ?? 0,
      lastPlayed: meta?.lp ?? null, playCount: meta?.pc ?? 0 };
  });
}

export function getFilesByAlbumId(albumId, vpaths, username, opts = {}) {
  if (!fileCollection) return [];
  let docs = fileCollection.find({
    '$and': [renderOrClause(vpaths, null), { album_id: { '$eq': albumId } }]
  });
  if (opts.filepathPrefix) docs = docs.filter(d => (d.filepath || '').startsWith(opts.filepathPrefix));
  return docs.map(d => {
    const meta = userMetadataCollection
      ? userMetadataCollection.findOne({ '$and': [{ hash: d.hash }, { user: username }] })
      : null;
    return { ...d, rating: meta?.rating ?? null, starred: meta?.starred ?? 0,
      lastPlayed: meta?.lp ?? null, playCount: meta?.pc ?? 0 };
  });
}

export function getSongByHash(hash, username) {
  if (!fileCollection) return null;
  const d = fileCollection.findOne({ hash: { '$eq': hash } });
  if (!d) return null;
  const meta = userMetadataCollection
    ? userMetadataCollection.findOne({ '$and': [{ hash }, { user: username }] })
    : null;
  return { ...d, rating: meta?.rating ?? null, starred: meta?.starred ?? 0,
    lastPlayed: meta?.lp ?? null, playCount: meta?.pc ?? 0 };
}

export function getAaFileById(id) {
  if (!fileCollection || !id) return null;
  let doc = fileCollection.findOne({ '$and': [{ album_id: { '$eq': id } }, { aaFile: { '$ne': null } }] });
  if (doc?.aaFile) return doc.aaFile;
  doc = fileCollection.findOne({ '$and': [{ artist_id: { '$eq': id } }, { aaFile: { '$ne': null } }] });
  if (doc?.aaFile) return doc.aaFile;
  doc = fileCollection.findOne({ '$and': [{ hash: { '$eq': id } }, { aaFile: { '$ne': null } }] });
  return doc?.aaFile || null;
}

// In-memory cache for getAaFileForDir
const _aaFileForDirCache = new Map();
export function clearAaFileForDirCache() { _aaFileForDirCache.clear(); }

export function getAaFileForDir(vpath, dirRelPath) {
  if (!fileCollection) return null;
  const cacheKey = vpath + '\0' + (dirRelPath || '');
  if (_aaFileForDirCache.has(cacheKey)) return _aaFileForDirCache.get(cacheKey);
  const prefix = dirRelPath ? dirRelPath + '/' : '';
  const docs = fileCollection.find({ vpath: { '$eq': vpath } });
  const hit = docs.find(d => (!prefix || d.filepath.startsWith(prefix)) && d.aaFile);
  const result = hit?.aaFile || null;
  _aaFileForDirCache.set(cacheKey, result);
  return result;
}

export function getStarredSongs(vpaths, username, opts = {}) {
  if (!userMetadataCollection || !fileCollection) return [];
  const metaDocs = userMetadataCollection.find({ '$and': [{ user: { '$eq': username } }, { starred: { '$eq': 1 } }] });
  const results = [];
  for (const m of metaDocs) {
    const d = fileCollection.findOne({ hash: { '$eq': m.hash } });
    if (!d) continue;
    const vOk = vpaths.some(v => d.vpath === v);
    if (!vOk) continue;
    if (opts.filepathPrefix && !(d.filepath || '').startsWith(opts.filepathPrefix)) continue;
    results.push({ ...d, rating: m.rating ?? null, starred: 1,
      lastPlayed: m.lp ?? null, playCount: m.pc ?? 0 });
  }
  return results;
}

export function getStarredAlbums(vpaths, username, opts = {}) {
  const songs = getStarredSongs(vpaths, username, opts);
  const seen = {};
  return songs.filter(s => {
    if (!s.album_id || seen[s.album_id]) return false;
    seen[s.album_id] = true;
    return true;
  });
}

export function setStarred(hash, username, starred) {
  if (!userMetadataCollection) return;
  const existing = userMetadataCollection.findOne({ '$and': [{ hash }, { user: username }] });
  if (existing) {
    existing.starred = starred ? 1 : 0;
    userMetadataCollection.update(existing);
  } else {
    userMetadataCollection.insert({ hash, user: username, rating: null, pc: 0, lp: null, starred: starred ? 1 : 0 });
  }
}

export function getRandomSongs(vpaths, username, opts) {
  if (!fileCollection) return [];
  const limit = Math.min(Number(opts.size) || 10, 500);
  let docs = fileCollection.find(renderOrClause(vpaths, null));
  if (opts.filepathPrefix) docs = docs.filter(d => (d.filepath || '').startsWith(opts.filepathPrefix));
  if (opts.genre) docs = docs.filter(d => d.genre === opts.genre);
  if (opts.fromYear) docs = docs.filter(d => d.year >= Number(opts.fromYear));
  if (opts.toYear) docs = docs.filter(d => d.year <= Number(opts.toYear));
  // shuffle
  for (let i = docs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [docs[i], docs[j]] = [docs[j], docs[i]];
  }
  return docs.slice(0, limit).map(d => {
    const meta = userMetadataCollection
      ? userMetadataCollection.findOne({ '$and': [{ hash: d.hash }, { user: username }] })
      : null;
    return { ...d, rating: meta?.rating ?? null, starred: meta?.starred ?? 0,
      lastPlayed: meta?.lp ?? null, playCount: meta?.pc ?? 0 };
  });
}

export function getAlbumsByArtistId(artistId, vpaths, opts = {}) {
  if (!fileCollection) return [];
  let docs = fileCollection.find({
    '$and': [renderOrClause(vpaths, null), { artist_id: { '$eq': artistId } }]
  });
  if (opts.filepathPrefix) docs = docs.filter(d => (d.filepath || '').startsWith(opts.filepathPrefix));
  const map = {};
  for (const d of docs) {
    if (!map[d.album_id]) {
      map[d.album_id] = { album_id: d.album_id, artist_id: d.artist_id, album: d.album,
        artist: d.artist, year: d.year, aaFile: d.aaFile, songCount: 0 };
    }
    map[d.album_id].songCount++;
  }
  return Object.values(map).sort((a, b) => (b.year || 0) - (a.year || 0));
}

export function getAllAlbumIds(vpaths, opts = {}) {
  if (!fileCollection) return [];
  let docs = fileCollection.find(renderOrClause(vpaths, null));
  if (opts.filepathPrefix) docs = docs.filter(d => (d.filepath || '').startsWith(opts.filepathPrefix));
  const map = {};
  for (const d of docs) {
    if (!d.album) continue;
    if (!map[d.album_id]) {
      map[d.album_id] = { album_id: d.album_id, artist_id: d.artist_id, album: d.album,
        artist: d.artist, year: d.year, aaFile: d.aaFile, songCount: 0, ts: d.ts ?? 0 };
    }
    map[d.album_id].songCount++;
    if ((d.ts ?? 0) > map[d.album_id].ts) map[d.album_id].ts = d.ts ?? 0;
  }
  return Object.values(map).sort((a, b) => (a.album || '').localeCompare(b.album || ''));
}

export function getAllArtistIds(vpaths, opts = {}) {
  if (!fileCollection) return [];
  let docs = fileCollection.find(renderOrClause(vpaths, null));
  if (opts.filepathPrefix) docs = docs.filter(d => (d.filepath || '').startsWith(opts.filepathPrefix));
  const map = {};
  for (const d of docs) {
    if (!d.artist) continue;
    if (!map[d.artist_id]) {
      map[d.artist_id] = { artist_id: d.artist_id, artist: d.artist, aaFile: d.aaFile, albumCount: new Set() };
    }
    map[d.artist_id].albumCount.add(d.album_id);
  }
  return Object.values(map).map(a => ({ ...a, albumCount: a.albumCount.size }))
    .sort((a, b) => (a.artist || '').localeCompare(b.artist || ''));
}

export function getDirectoryContents(vpath, dirRelPath, username) {
  if (!fileCollection) return { dirs: [], files: [] };

  const prefix = dirRelPath ? dirRelPath + '/' : '';
  let docs;
  if (prefix) {
    const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    docs = fileCollection.find({ '$and': [{ vpath: { '$eq': vpath } }, { filepath: { '$regex': re } }] });
  } else {
    docs = fileCollection.find({ vpath: { '$eq': vpath } });
  }

  const dirMap = new Map(); // name -> aaFile
  const files = [];
  for (const doc of docs) {
    const rel = doc.filepath.slice(prefix.length);
    const slashPos = rel.indexOf('/');
    if (slashPos >= 0) {
      const name = rel.slice(0, slashPos);
      if (!dirMap.has(name) || (!dirMap.get(name) && doc.aaFile)) {
        dirMap.set(name, doc.aaFile || null);
      }
    } else {
      const meta = userMetadataCollection
        ? userMetadataCollection.findOne({ '$and': [{ hash: doc.hash }, { user: username }] })
        : null;
      files.push({ ...doc, rating: meta?.rating ?? null, starred: meta?.starred ?? 0,
        lastPlayed: meta?.lp ?? null, playCount: meta?.pc ?? 0 });
    }
  }

  return {
    dirs: [...dirMap.entries()]
      .map(([name, aaFile]) => ({ name, aaFile }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    files: files.sort((a, b) => (a.track || 0) - (b.track || 0) || (a.title || '').localeCompare(b.title || '')),
  };
}

// ── User settings (in-memory for loki backend) ───────────────
const _userSettings = {};

export function getUserSettings(username) {
  const s = _userSettings[username];
  return s ? { prefs: s.prefs || {}, queue: s.queue || null } : { prefs: {}, queue: null };
}

export function saveUserSettings(username, patch) {
  if (!_userSettings[username]) _userSettings[username] = { prefs: {}, queue: null };
  if (patch.prefs !== undefined) Object.assign(_userSettings[username].prefs, patch.prefs);
  if (patch.queue !== undefined) _userSettings[username].queue = patch.queue;
}

// ── Radio Stations (in-memory for loki backend) ──────────────
const _radioStations = {};   // { username: Array<station> }
let _radioStationNextId = 1;

export function getRadioStations(username) {
  return (_radioStations[username] || []).slice();
}
export function createRadioStation(username, data) {
  if (!_radioStations[username]) _radioStations[username] = [];
  const id = _radioStationNextId++;
  _radioStations[username].push({ id, user: username, name: data.name, genre: data.genre || null, country: data.country || null, link_a: data.link_a || null, link_b: data.link_b || null, link_c: data.link_c || null, img: data.img || null, sort_order: 0 });
  return id;
}
export function updateRadioStation(id, username, data) {
  const arr = _radioStations[username] || [];
  const idx = arr.findIndex(s => s.id === id);
  if (idx === -1) return false;
  Object.assign(arr[idx], { name: data.name, genre: data.genre || null, country: data.country || null, link_a: data.link_a || null, link_b: data.link_b || null, link_c: data.link_c || null, img: data.img || null });
  return true;
}
export function deleteRadioStation(id, username) {
  const arr = _radioStations[username] || [];
  const idx = arr.findIndex(s => s.id === id);
  if (idx === -1) return false;
  arr.splice(idx, 1);
  return true;
}

// ── Podcast Feeds (in-memory for loki backend) ───────────────
const _podcastFeeds = {};     // { username: Array<feed> }
const _podcastEpisodes = {};  // { feedId: Array<episode> }
let _podcastFeedNextId = 1;
let _podcastEpisodeNextId = 1;

export function getPodcastFeeds(username) {
  return (_podcastFeeds[username] || [])
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map(f => ({ ...f, episode_count: (_podcastEpisodes[f.id] || []).length }));
}
export function reorderPodcastFeeds(username, orderedIds) {
  const arr = _podcastFeeds[username] || [];
  orderedIds.forEach((id, idx) => {
    const f = arr.find(x => x.id === id);
    if (f) f.sort_order = idx;
  });
}
export function getPodcastFeed(id, username) {
  const list = _podcastFeeds[username] || [];
  const f = list.find(x => x.id === id);
  if (!f) return null;
  return { ...f, episode_count: (_podcastEpisodes[id] || []).length };
}
export function createPodcastFeed(username, data) {
  if (!_podcastFeeds[username]) _podcastFeeds[username] = [];
  const now = Math.floor(Date.now() / 1000);
  const id = _podcastFeedNextId++;
  _podcastFeeds[username].push({
    id, user: username, url: data.url, title: data.title || null,
    description: data.description || null, img: data.img || null,
    author: data.author || null, language: data.language || null,
    last_fetched: data.last_fetched || now, created_at: now
  });
  return id;
}
export function deletePodcastFeed(id, username) {
  const arr = _podcastFeeds[username] || [];
  const idx = arr.findIndex(f => f.id === id);
  if (idx !== -1) arr.splice(idx, 1);
  delete _podcastEpisodes[id];
}
export function updatePodcastFeedFetched(id, username, ts) {
  const arr = _podcastFeeds[username] || [];
  const f = arr.find(x => x.id === id);
  if (f) f.last_fetched = ts;
}
export function updatePodcastFeedTitle(id, username, title) {
  const arr = _podcastFeeds[username] || [];
  const f = arr.find(x => x.id === id);
  if (f) f.title = title;
}
export function updatePodcastFeedImg(id, username, img) {
  const arr = _podcastFeeds[username] || [];
  const f = arr.find(x => x.id === id);
  if (f) f.img = img;
}
export function updatePodcastFeedUrl(id, username, url) {
  const arr = _podcastFeeds[username] || [];
  const f = arr.find(x => x.id === id);
  if (f) f.url = url;
}
export function getPodcastFeedImgUsageCount(img) {
  return Object.values(_podcastFeeds).flat().filter(f => f.img === img).length;
}
export function getPodcastEpisodes(feedId) {
  return (_podcastEpisodes[feedId] || []).slice().sort((a, b) => (b.pub_date || 0) - (a.pub_date || 0));
}
export function upsertPodcastEpisodes(feedId, episodes) {
  if (!_podcastEpisodes[feedId]) _podcastEpisodes[feedId] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const ep of episodes) {
    const idx = _podcastEpisodes[feedId].findIndex(e => e.guid === ep.guid);
    if (idx !== -1) {
      Object.assign(_podcastEpisodes[feedId][idx], { title: ep.title, description: ep.description, audio_url: ep.audio_url, pub_date: ep.pub_date, duration_secs: ep.duration_secs, img: ep.img });
    } else {
      _podcastEpisodes[feedId].push({ id: _podcastEpisodeNextId++, feed_id: feedId, guid: ep.guid, title: ep.title || null, description: ep.description || null, audio_url: ep.audio_url, pub_date: ep.pub_date || null, duration_secs: ep.duration_secs || 0, img: ep.img || null, played: 0, play_position: 0, created_at: now });
    }
  }
}
export function saveEpisodeProgress(episodeId, feedId, position, played) {
  const arr = _podcastEpisodes[feedId] || [];
  const ep = arr.find(e => e.id === episodeId);
  if (ep) { ep.play_position = position; ep.played = played ? 1 : 0; }
}

// ── Smart Playlists (in-memory for Loki backend) ─────────────────────────────
const _smartPlaylists = {};  // { username: [{id, name, filters, sort, limit_n, created}] }
let _splNextId = 1;

export function runSmartPlaylist(filters, sort, limitN, vpaths, username) {
  if (!fileCollection) return [];
  const limit = Math.min(Number(limitN) || 100, 1000);
  let docs = fileCollection.find(renderOrClause(vpaths, null));

  if (filters.genres && filters.genres.length > 0) {
    const gs = new Set(filters.genres);
    docs = docs.filter(d => gs.has(d.genre));
  }
  if (filters.yearFrom) docs = docs.filter(d => d.year >= Number(filters.yearFrom));
  if (filters.yearTo)   docs = docs.filter(d => d.year <= Number(filters.yearTo));
  if (filters.artistSearch && filters.artistSearch.trim()) {
    const term = filters.artistSearch.trim().toLowerCase();
    docs = docs.filter(d => (d.artist || '').toLowerCase().includes(term));
  }

  // Attach metadata for rating/play-count/starred filters
  docs = docs.map(d => {
    const meta = userMetadataCollection
      ? userMetadataCollection.findOne({ '$and': [{ hash: d.hash }, { user: username }] })
      : null;
    return { ...d, _rating: meta?.rating ?? 0, _starred: meta?.starred ?? 0,
      _pc: meta?.pc ?? 0, _lp: meta?.lp ?? null };
  });

  if (filters.minRating > 0) docs = docs.filter(d => d._rating >= Number(filters.minRating));
  if (filters.playedStatus === 'never')  docs = docs.filter(d => d._pc === 0 || !d._pc);
  else if (filters.playedStatus === 'played') docs = docs.filter(d => d._pc > 0);
  else if (filters.minPlayCount > 0) docs = docs.filter(d => d._pc >= Number(filters.minPlayCount));
  if (filters.starred) docs = docs.filter(d => d._starred === 1);

  const sortKey = sort || 'artist';
  if (sortKey === 'random') {
    for (let i = docs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [docs[i], docs[j]] = [docs[j], docs[i]];
    }
  } else if (sortKey === 'rating')      docs.sort((a, b) => (b._rating || 0) - (a._rating || 0));
  else if (sortKey === 'play_count')    docs.sort((a, b) => (b._pc || 0) - (a._pc || 0));
  else if (sortKey === 'last_played')   docs.sort((a, b) => (b._lp || 0) - (a._lp || 0));
  else if (sortKey === 'year_asc')      docs.sort((a, b) => (a.year || 0) - (b.year || 0));
  else if (sortKey === 'year_desc')     docs.sort((a, b) => (b.year || 0) - (a.year || 0));
  else if (sortKey === 'album')         docs.sort((a, b) => (a.album || '').localeCompare(b.album || ''));
  else                                  docs.sort((a, b) => (a.artist || '').localeCompare(b.artist || ''));

  return docs.slice(0, limit).map(d => ({
    ...d, rating: d._rating, starred: d._starred, lastPlayed: d._lp, playCount: d._pc,
  }));
}

export function countSmartPlaylist(filters, vpaths, username) {
  return runSmartPlaylist(filters, 'artist', 100000, vpaths, username).length;
}

export function getSmartPlaylists(username) {
  return (_smartPlaylists[username] || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export function getSmartPlaylist(id, username) {
  return (_smartPlaylists[username] || []).find(s => s.id === id) || null;
}

export function saveSmartPlaylist(username, name, filters, sort, limitN) {
  if (!_smartPlaylists[username]) _smartPlaylists[username] = [];
  const id = _splNextId++;
  _smartPlaylists[username].push({ id, user: username, name, filters, sort, limit_n: limitN,
    created: Math.floor(Date.now() / 1000) });
  return id;
}

export function updateSmartPlaylist(id, username, data) {
  const arr = _smartPlaylists[username] || [];
  const idx = arr.findIndex(s => s.id === id);
  if (idx === -1) return false;
  Object.assign(arr[idx], { name: data.name, filters: data.filters, sort: data.sort, limit_n: data.limit_n });
  return true;
}

export function deleteSmartPlaylist(id, username) {
  const arr = _smartPlaylists[username] || [];
  const idx = arr.findIndex(s => s.id === id);
  if (idx === -1) return false;
  arr.splice(idx, 1);
  return true;
}

// Genre list (for genre-groups admin and SPL builder)
export function getGenres(vpaths, ignoreVPaths) {
  if (!fileCollection || !vpaths || vpaths.length === 0) return [];
  const results = fileCollection.find(renderOrClause(vpaths, ignoreVPaths || []));
  const genreMap = {};
  for (const doc of results) {
    const genre = doc.genre ? doc.genre.trim() : null;
    if (genre) genreMap[genre] = (genreMap[genre] || 0) + 1;
  }
  return Object.entries(genreMap).map(([genre, cnt]) => ({ genre, cnt })).sort((a, b) => b.cnt - a.cnt);
}

// Genre Groups — loki backend keeps these in memory only (no persistence)
let _genreGroups = [];
export function getGenreGroups() { return _genreGroups; }
export function saveGenreGroups(groups) { _genreGroups = groups; }

