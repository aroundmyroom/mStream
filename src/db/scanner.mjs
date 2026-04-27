// Compute audio identity hash — based on song metadata (artist+album+title+duration)
// Survives transcoding: if audio content is the same, audio_hash stays the same
// even if file encoding changes (MP3 → FLAC, 128k → 320k, etc.)
function calculateAudioHash(songInfo) {
  const audioId = `${(songInfo.artist || '').toLowerCase().trim()}|${(songInfo.album || '').toLowerCase().trim()}|${(songInfo.title || '').toLowerCase().trim()}|${Math.round(songInfo.duration || 0)}`;
  return crypto.createHash('sha256').update(audioId).digest('hex');
}

// ── Album version detection ───────────────────────────────────────────────────
// Default ordered list of tag fields to try for album_version.
// Resolved first-non-empty wins; heuristic fallback runs if all yield nothing.
const DEFAULT_ALBUM_VERSION_TAGS = [
  'TIT3', 'SUBTITLE', 'DISCSUBTITLE',
  'TXXX:EDITION', 'TXXX:VERSION', 'TXXX:ALBUMVERSION',
  'TXXX:QUALITY', 'TXXX:REMASTER', 'TXXX:DESCRIPTION',
  'EDITION', 'VERSION', 'ALBUMVERSION', 'QUALITY', 'REMASTER',
  // COMMENT intentionally excluded from default — too noisy; add via admin config if desired
];

/** Flatten raw music-metadata native tag arrays into lookup maps by format. */
function buildNativeMap(native) {
  const map = { txxx: {}, vorbis: {}, ape: {}, itunesCustom: {} };
  for (const [format, tags] of Object.entries(native || {})) {
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (!tag || !tag.id) continue;
      if (tag.id === 'TXXX' && tag.value?.description) {
        map.txxx[tag.value.description.toUpperCase()] = tag.value.text;
      } else if (format === 'vorbis') {
        map.vorbis[tag.id.toUpperCase()] = Array.isArray(tag.value) ? tag.value[0] : tag.value;
      } else if (format === 'APEv2') {
        map.ape[tag.id.toUpperCase()] = tag.value;
      } else if (tag.id.startsWith('----:com.apple.iTunes:')) {
        const k = tag.id.replace('----:com.apple.iTunes:', '').toUpperCase();
        map.itunesCustom[k] = tag.value;
      }
    }
  }
  return map;
}

function _firstOf(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  if (typeof v === 'object' && 'text' in v) return v.text ?? null;
  return String(v);
}

/** Resolve one configured field name against all tag formats. Returns string or null. */
function resolveTagField(fieldName, songInfo, nativeMap) {
  const key = fieldName.toUpperCase().trim();

  // TXXX:KEY — ID3v2 user-defined text frame
  if (key.startsWith('TXXX:')) {
    const desc = key.slice(5);
    const val = nativeMap.txxx?.[desc];
    return val != null ? String(val).trim() || null : null;
  }

  // music-metadata normalised common fields
  const commonAlias = {
    'TIT3':        () => _firstOf(songInfo.subtitle),
    'SUBTITLE':    () => _firstOf(songInfo.subtitle),
    'DISCSUBTITLE':() => _firstOf(songInfo.discsubtitle),
    'COMMENT':     () => {
      const c = songInfo.comment;
      if (!c) return null;
      const arr = Array.isArray(c) ? c : [c];
      for (const item of arr) {
        const t = (typeof item === 'object') ? (item.text ?? item) : item;
        if (t && String(t).trim()) return String(t).trim();
      }
      return null;
    },
  };
  if (commonAlias[key]) return commonAlias[key]() ?? null;

  // Raw Vorbis / APE / iTunes custom atom by exact key name
  const raw = nativeMap.vorbis?.[key] ?? nativeMap.ape?.[key] ?? nativeMap.itunesCustom?.[key];
  if (raw != null) return String(raw).trim() || null;
  return null;
}

// ── Heuristic fallback ────────────────────────────────────────────────────────
/** Normalise a string for reliable regex matching: strip diacritics, lowercase, unify dashes. */
function normaliseForHeuristic(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')       // strip diacritics
    .toLowerCase()
    .replace(/[–—\u2012-\u2015]/g, '-')    // normalise all dashes to hyphen
    .replace(/[^\x20-\x7e]/g, ' ')         // replace remaining non-ASCII with space
    .replace(/\s+/g, ' ')
    .trim();
}

/** Minimal Levenshtein distance (edit distance) between two strings. */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

const FUZZY_WORDS = {
  'deluxe':       'Deluxe Edition',
  'dleuxe':       'Deluxe Edition',   // common typo
  'expanded':     'Expanded Edition',
  'remaster':     'Remaster',
  'remastered':   'Remaster',
  'anniversary':  'Anniversary Edition',
};

function fuzzyMatch(normalised) {
  const words = normalised.split(/[\s\-\[\]()\{\}]+/).filter(w => w.length >= 4);
  for (const [target, label] of Object.entries(FUZZY_WORDS)) {
    for (const word of words) {
      if (Math.abs(word.length - target.length) <= 1 && levenshtein(word, target) <= 1) {
        return label;
      }
    }
  }
  return null;
}

// Confidence gate: only run heuristics if at least one known keyword/bracket is present
const HAS_BRACKET_OR_KEYWORD = /[\[\](]|remast|deluxe|hi.?res|\d{2,3}.?bit|\d{3,6}.?k?hz|dsd|sacd|expanded|anniversary|bonus\s|live\b|mono\b|stereo\b/i;

function matchEdition(s) {
  // Order matters: more specific patterns before generic ones
  if (/anni?ver\w*/.test(s))                           return 'Anniversary Edition';
  if (/expan\w*/.test(s))                              return 'Expanded Edition';
  if (/d[e]?luxe/.test(s))                            return 'Deluxe Edition';
  if (/complet\w+\s*(edition|ed\.?|coll\w+)?/.test(s)) return 'Complete Edition';
  if (/box\s*set|boxset/.test(s))                      return 'Box Set';
  if (/bonus\s*(track|disc|edition|cd)?/.test(s))      return 'Bonus Edition';
  if (/\blive\b(?!\s*remast)/.test(s))                return 'Live';
  if (/\bmono\b/.test(s))                              return 'Mono';
  if (/\bstereo\b/.test(s))                            return 'Stereo';
  if (/\bsacd\b/.test(s))                              return 'SACD';

  // Remaster — capture optional year
  const rmYear1 = s.match(/(\d{4})\s*(?:digital\s+)?remast\w*/);
  if (rmYear1) return `${rmYear1[1]} Remaster`;
  const rmYear2 = s.match(/remast\w*\s*(\d{4})/);
  if (rmYear2) return `Remaster ${rmYear2[1]}`;
  if (/remast\w*/.test(s)) return 'Remaster';

  return null;
}

function matchQuality(s) {
  const parts = [];

  // Hi-Res marker
  if (/hi.?res/.test(s)) parts.push('Hi-Res');

  // DSD
  const dsd = s.match(/\bdsd\s*(\d+)?/);
  if (dsd) parts.push(dsd[1] ? `DSD${dsd[1]}` : 'DSD');

  // Bit depth
  const bits = s.match(/(\d{2,3})\s*-?\s*bit/);
  if (bits) parts.push(`${bits[1]}bit`);

  // Sample rate — match e.g. 96khz, 96kHz, 192.0 kHz, 44100hz
  const hz = s.match(/(\d{2,6}(?:\.\d)?)\s*k?hz/);
  if (hz) {
    const val = parseFloat(hz[1]);
    // If the raw value looks like Hz (>= 1000), convert to kHz label
    const khz = val >= 1000 ? Math.round(val / 1000) : val;
    if (khz >= 44) parts.push(`${khz}kHz`);
  }

  return parts.length ? parts.join('/') : null;
}

function parseVersionHeuristic(rawInput) {
  if (!rawInput) return null;
  const s = normaliseForHeuristic(rawInput);
  if (!HAS_BRACKET_OR_KEYWORD.test(s)) return null;  // plain name, skip heuristics

  const editionMatch = matchEdition(s);
  const qualityMatch = matchQuality(s);

  if (!editionMatch && !qualityMatch) {
    const fuzzy = fuzzyMatch(s);
    return fuzzy || null;
  }

  const parts = [];
  if (editionMatch) parts.push(editionMatch);
  if (qualityMatch) parts.push(qualityMatch);
  return parts.join(' · ');
}

// Module-level variable so deriveAlbumVersion can communicate the source
let _lastAlbumVersionSource = null;

/** Main orchestrator: walk configured tag fields, fall back to heuristics, infer from audio. */
function deriveAlbumVersion(songInfo, native, fmtInfo, configuredFields) {
  _lastAlbumVersionSource = null;
  const fields = Array.isArray(configuredFields) && configuredFields.length > 0
    ? configuredFields : DEFAULT_ALBUM_VERSION_TAGS;
  const nativeMap = buildNativeMap(native);

  for (const field of fields) {
    const val = resolveTagField(field, songInfo, nativeMap);
    if (val && val.trim()) {
      _lastAlbumVersionSource = field;
      return val.trim();
    }
  }

  // Heuristic: album title string
  const fromTitle = parseVersionHeuristic(songInfo.album || '');
  if (fromTitle) {
    _lastAlbumVersionSource = 'heuristic:title';
    return fromTitle;
  }

  // Heuristic: parent folder name
  const folder = (songInfo.filePath || '').split('/').slice(-2, -1)[0] || '';
  const fromFolder = parseVersionHeuristic(folder);
  if (fromFolder) {
    _lastAlbumVersionSource = 'heuristic:folder';
    return fromFolder;
  }

  // Infer from audio technical properties
  const bits = fmtInfo.bitsPerSample ?? 0;
  const sr   = fmtInfo.sampleRate   ?? 0;
  if (bits >= 24 && sr >= 88200) {
    const khz = Math.round(sr / 1000);
    _lastAlbumVersionSource = 'inferred:audio';
    return `Hi-Res ${bits}bit/${khz}kHz`;
  }

  return null;
}
// ─────────────────────────────────────────────────────────────────────────────

import { parseFile } from 'music-metadata';
import fs from 'fs';
import fsp from 'node:fs/promises';
import path from 'path';
import crypto from 'crypto';
import Joi from 'joi';
import sharp from 'sharp';
import mime from 'mime-types';
import axios from 'axios';
import http from 'http';
import https from 'https';
import { execFile } from 'child_process';

// Disable keep-alive on both agents: between batch flushes the server-side
// keep-alive timeout can expire, leaving a stale socket in the pool. When
// axios reuses that dead socket the next write raises EPIPE. Creating a fresh
// connection per request is cheap compared to metadata parsing overhead.
const ax = axios.create({
  httpAgent:  new http.Agent({  keepAlive: false }),
  httpsAgent: new https.Agent({ keepAlive: false, rejectUnauthorized: false }),
});

let loadJson;
try {
  loadJson = JSON.parse(process.argv[process.argv.length - 1], 'utf8');
} catch (_error) {
  console.error(`Warning: failed to parse JSON input`);
  process.exit(1);
}

// Validate input
const schema = Joi.object({
  vpath: Joi.string().required(),
  directory: Joi.string().required(),
  port: Joi.number().port().required(),
  token: Joi.string().required(),
  pause: Joi.number().required(),
  skipImg: Joi.boolean().required(),
  albumArtDirectory: Joi.string().required(),
  scanId: Joi.string().required(),
  isHttps: Joi.boolean().required(),
  compressImage: Joi.boolean().required(),
  hasBaseline: Joi.boolean().required(),
  supportedFiles: Joi.object().pattern(
    Joi.string(), Joi.boolean()
  ).required(),
  otherRoots: Joi.array().items(Joi.string()).required(),
  excludedPaths: Joi.array().items(Joi.string()).default([]),
  ffprobePath: Joi.string().optional().allow('', null),
  albumVersionTags: Joi.array().items(Joi.string()).optional(),
});

const { error: validationError } = schema.validate(loadJson);
if (validationError) {
  console.error(`Invalid JSON Input`);
  console.log(validationError);
  process.exit(1);
}

// ── Subsonic ID helpers ───────────────────────────────────────────────────────
function _makeArtistId(artist) {
  return crypto.createHash('md5').update((artist || '').toLowerCase().trim()).digest('hex').slice(0, 16);
}
function _makeAlbumId(artist, album) {
  return crypto.createHash('md5')
    .update(`${(artist || '').toLowerCase().trim()}|||${(album || '').toLowerCase().trim()}`)
    .digest('hex').slice(0, 16);
}

async function insertEntries(song) {
  const data = {
    "title": song.title ? String(song.title) : null,
    "artist": song.artist ? String(song.artist) : null,
    "albumArtist": song.albumartist ? String(song.albumartist) : null,
    "year": song.year ? song.year : null,
    "album": song.album ? String(song.album) : null,
    "filepath": song.filePath,
    "format": song.format,
    "track": song.track.no ? song.track.no : null,
    "trackOf": song.track.of ? song.track.of : null,
    "disk": song.disk.no ? song.disk.no : null,
    "modified": song.modified,
    "hash": song.hash,
    "audio_hash": song.audio_hash,
    "aaFile": song.aaFile ? song.aaFile : null,
    "art_source": song._artSource || null,
    "cover_file": song._coverFile || null,
    "vpath": loadJson.vpath,
    "ts": song._preserveTs || (song._isReindex ? null : Math.floor(Date.now() / 1000)) || null,
    "sID": loadJson.scanId,
    "replaygainTrackDb": song.replaygain_track_gain ? song.replaygain_track_gain.dB : null,
    "genre": song.genre ? String(song.genre) : null,
    "cuepoints": song.cuepoints || null,
    "duration": song._duration ?? null,
    "bitrate":     song._bitrate     ?? null,
    "sample_rate": song._sampleRate  ?? null,
    "channels":    song._channels    ?? null,
    "bit_depth":   song._bitDepth    ?? null,
    "album_version":        song._albumVersion       ?? null,
    "album_version_source": song._albumVersionSource ?? null,
    "artist_id": _makeArtistId(song.artist ? String(song.artist) : null),
    "album_id": _makeAlbumId(song.artist ? String(song.artist) : null, song.album ? String(song.album) : null),
    "_oldHash": song._oldHash || null
  };

  await ax({
    method: 'POST',
    url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/add-file`,
    headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
    responseType: 'json',
    data: data
  });
}

/**
 * Report a scan error back to the mStream server database for persistent
 * auditing.  The GUID = md5(relativeFilePath + '|' + errorType) so the same
 * recurring problem on the same file increments its count instead of creating
 * duplicate rows.  Errors here must never crash or stall the scanner.
 */
async function reportError(absoluteFilepath, errorType, errorMsg, stack) {
  try {
    const rel = absoluteFilepath
      ? path.relative(loadJson.directory, absoluteFilepath)
      : '';
    const guid = crypto.createHash('md5').update(`${rel}|${errorType}`).digest('hex');
    await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/report-error`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: {
        guid,
        filepath: rel,
        vpath: loadJson.vpath,
        errorType,
        errorMsg:  String(errorMsg  || '').slice(0, 500),
        stack:     String(stack     || '').slice(0, 2000)
      }
    });
  } catch (_err) {
    // error reporting must never crash the scanner
  }
}

async function confirmOk(absoluteFilepath) {
  try {
    const rel = absoluteFilepath
      ? path.relative(loadJson.directory, absoluteFilepath)
      : '';
    await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/confirm-ok`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: { filepath: rel, vpath: loadJson.vpath }
    });
  } catch (_err) {
    // confirm-ok must never crash the scanner
  }
}

// Running total of valid files discovered during recursiveScan.
// Updated as directories are walked so set-expected pings reflect the
// current tree-walk progress rather than requiring a separate pre-count pass.
let _totalSeen = 0;

run();
async function run() {
  try {
    // ── Sentinel file (mount guard) check ─────────────────────────────────────
    // After every successful scan, mStream Velvet writes .velvet.md to the vpath
    // root. If this file is missing when hasBaseline=true, the music share is
    // almost certainly not mounted — abort before touching the DB.
    //
    // Exception: if the sentinel has never been written (e.g. first scan after
    // upgrading from a version that predates the sentinel feature), we allow the
    // scan to proceed. The zero-files guard below still protects against a
    // genuinely absent mount in that case. The sentinel will be written by
    // finish-scan at the end of this run, protecting all future scans.
    if (loadJson.hasBaseline) {
      const sentinelPath = path.join(loadJson.directory, '.velvet.md');
      if (!fs.existsSync(sentinelPath)) {
        // Check whether the directory itself is accessible and non-empty.
        // If it has at least one entry it is almost certainly mounted —
        // treat this as a first-time run (post-upgrade) and continue.
        let dirEntries = [];
        try { dirEntries = fs.readdirSync(loadJson.directory); } catch (_e) { /* fall through */ }
        if (dirEntries.length === 0) {
          console.error(
            `[scanner] ABORTED scan for vpath "${loadJson.vpath}": ` +
            `sentinel file ".velvet.md" not found in "${loadJson.directory}" ` +
            `and the directory appears empty. Music share may not be mounted. ` +
            `Database was NOT modified.`
          );
          try {
            await ax({
              method: 'POST',
              url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/abort-scan`,
              headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
              responseType: 'json',
              data: { scanId: loadJson.scanId, vpath: loadJson.vpath, reason: 'sentinel_missing' }
            });
          } catch (_e) { /* non-critical */ }
          return;
        }
        console.warn(
          `[scanner] sentinel file ".velvet.md" not found in "${loadJson.directory}" ` +
          `but directory is accessible — treating as first scan after upgrade. ` +
          `Sentinel will be written after this scan completes.`
        );
      }
    }

    // Prune stale error entries before starting — respects the configured retention window.
    try {
      await ax({
        method: 'POST',
        url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/prune-errors`,
        headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
        responseType: 'json',
        data: { vpath: loadJson.vpath }
      });
    } catch (_e) { /* non-critical — prune fail should not abort scan */ }

    // Progress strategy (both first scans and rescans):
    //  - Rescan (hasBaseline=true): expected is already set from DB count; no
    //    change needed. pct is capped at 99 until finish-scan fires.
    //  - First scan (hasBaseline=false): no pre-count pass — scanning starts
    //    immediately. _totalSeen is incremented per file in recursiveScan.
    //    After the full tree walk a single set-expected ping sends the true
    //    total. The UI shows an indeterminate bar + growing file count with no
    //    double-traverse and no 10+ min pre-scan delay.

    const scanStartTs = Math.floor(Date.now() / 1000);
    await recursiveScan(loadJson.directory);

    // ── Mount / access failure guard ──────────────────────────────────────────
    // If this vpath had files in the DB (hasBaseline=true) but the walk found
    // zero files, the music directory is almost certainly unreachable (NFS/SMB
    // disconnected, Docker volume not mounted, permissions lost, etc.).
    // Calling finish-scan in this state would wipe the entire DB for this vpath.
    // Abort instead and log a clear warning — the existing DB rows are preserved.
    if (loadJson.hasBaseline && _totalSeen === 0) {
      console.error(
        `[scanner] ABORTED scan for vpath "${loadJson.vpath}": ` +
        `directory returned 0 files but DB has existing records. ` +
        `The music directory may be unmounted or inaccessible. ` +
        `Database was NOT modified.`
      );
      // Signal the progress tracker that this scan did not finish cleanly.
      try {
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/abort-scan`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: { scanId: loadJson.scanId, vpath: loadJson.vpath, reason: 'mount_failure' }
        });
      } catch (_e) { /* non-critical — server may not have this endpoint yet */ }
      return;
    }

    // Final set-expected: after the full tree walk, _totalSeen is the true total.
    // For rescans the DB count is already set; this is only meaningful for first scans.
    if (!loadJson.hasBaseline && _totalSeen > 0) {
      try {
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/set-expected`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: { scanId: loadJson.scanId, expected: _totalSeen }
        });
      } catch (_e) { /* non-critical */ }
    }

    await flushBatch();

    await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/finish-scan`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: {
        vpath: loadJson.vpath,
        scanId: loadJson.scanId,
        scanStartTs
      }
    });
  }catch (err) {
    console.error('Scan Failed');
    console.error(err.stack)
  }
}

// ── Batch scan helpers ────────────────────────────────────────────────────────
// Instead of one HTTP call per file, files are accumulated and sent in batches
// of SCAN_BATCH_SIZE.  This reduces 138K sequential round trips to ~700, and
// wraps all unchanged-file scanId UPDATEs in a single SQL transaction per batch.

const SCAN_BATCH_SIZE = 200;
let _pendingBatch = []; // { absPath, relPath, modTime }

async function processFileResult(absPath, relPath, modTime, data) {
  if (Object.entries(data).length === 0 || data._stale) {
    // New or modified file — full parse + insert (cuepoints extracted inside parseMyFile)
    const songInfo = await parseMyFile(absPath, modTime);
    // Preserve Discogs-assigned art (DB cache only, e.g. WAV files) when the
    // re-parsed file carries no embedded art — prevents orphan cleanup from
    // deleting art the user manually picked via the Discogs picker.
    if (!songInfo.aaFile && data._preserveAaFile) {
      songInfo.aaFile = data._preserveAaFile;
      songInfo._artSource = data._preserveArtSource || null;
    }
    // Preserve original insertion timestamp so editing tags/art doesn't
    // re-flood "Recently Added" (file hash changes after rewrite → ts = now without this).
    // Only set _isReindex for files that were already in the DB (_stale).
    // For brand-new files (data = {}), _isReindex must remain unset so that
    // ts = song.modified (file mtime) — making them appear in Recently Added.
    if (data._stale) {
      songInfo._isReindex = true;
    }
    if (data._preserveTs) {
      songInfo._preserveTs = data._preserveTs;
    }
    if (data._oldHash) {
      songInfo._oldHash = data._oldHash;
    }
    await insertEntries(songInfo);
    await confirmOk(absPath);
  } else {
    // File already in DB — run targeted updates for anything still missing

    if (data._needsArt) {
      try {
        let songInfo;
        try {
          songInfo = (await parseFile(absPath, { skipCovers: false })).common;
        } catch (_e) {
          await reportError(absPath, 'art', `Failed to parse file for embedded art: ${_e.message}`, _e.stack);
          songInfo = {};
        }
        songInfo.filePath = relPath;
        await getAlbumArt(songInfo);
        if (songInfo.aaFile) {
          await ax({
            method: 'POST',
            url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-art`,
            headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
            responseType: 'json',
            data: { filepath: data.filepath, vpath: loadJson.vpath, aaFile: songInfo.aaFile, scanId: loadJson.scanId, artSource: songInfo._artSource || null, coverFile: songInfo._coverFile || null }
          });
        }
      } catch (_artErr) {
        await reportError(absPath, 'art', `Art update failed: ${_artErr.message}`, _artErr.stack);
      }
    }

    if (data._needsCue) {
      try {
        let cuepoints = '[]';
        try {
          const parsed = await parseFile(absPath, { skipCovers: true });
          const cue = parsed.common?.cuesheet;
          const sampleRate = parsed.format?.sampleRate || null;
          if (cue && Array.isArray(cue.tracks) && cue.tracks.length && sampleRate) {
            const pts = [];
            for (const t of cue.tracks) {
              if (t.number === 170) continue;
              const idx1 = Array.isArray(t.indexes) && t.indexes.find(i => i.number === 1);
              if (!idx1) continue;
              pts.push({ no: t.number, title: t.title || null, t: Math.round((idx1.offset / sampleRate) * 100) / 100 });
            }
            if (pts.length > 1) cuepoints = JSON.stringify(pts);
          }
        } catch (_e) {
          await reportError(absPath, 'cue', `Embedded cue sheet parse failed: ${_e.message}`, _e.stack);
        }
        if (cuepoints === '[]') {
          try {
            const sidecar = parseSidecarCue(absPath);
            if (sidecar) cuepoints = JSON.stringify(sidecar);
          } catch (_e) {
            await reportError(absPath, 'cue', `Sidecar .cue file parse failed: ${_e.message}`, _e.stack);
          }
        }
        // M4B chapter fallback (only when no cuepoints found yet)
        if (cuepoints === '[]' && /\.m4b$/i.test(absPath) && loadJson.ffprobePath) {
          try {
            const chapters = await extractM4bChapters(absPath, loadJson.ffprobePath);
            if (chapters) cuepoints = JSON.stringify(chapters);
          } catch (_e) {
            await reportError(absPath, 'cue', `M4B chapter extraction failed: ${_e.message}`, _e.stack);
          }
        }
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-cue`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: { filepath: data.filepath, vpath: loadJson.vpath, cuepoints }
        });
      } catch (_cueErr) {
        await reportError(absPath, 'cue', `Cue update failed: ${_cueErr.message}`, _cueErr.stack);
      }
    }

    if (data._needsDuration) {
      try {
        let duration = null;
        try {
          const parsed = await parseFile(absPath, { skipCovers: true });
          const d = parsed.format?.duration;
          if (d != null && isFinite(d)) { duration = Math.round(d * 1000) / 1000; }
        } catch (_e) {
          await reportError(absPath, 'duration', `Duration parse failed: ${_e.message}`, _e.stack);
        }
        if (duration !== null) {
          await ax({
            method: 'POST',
            url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-duration`,
            headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
            responseType: 'json',
            data: { filepath: data.filepath, vpath: loadJson.vpath, duration }
          });
        }
      } catch (_durErr) {
        await reportError(absPath, 'duration', `Duration update failed: ${_durErr.message}`, _durErr.stack);
      }
    }

    if (data._needsBitrate) {
      try {
        let bitrate = null, sampleRate = null, channels = null, bitDepth = null;
        try {
          // Use duration:true so FLAC/WAV files return accurate bitrate and duration
          const parsed = await parseFile(absPath, { skipCovers: true, duration: true });
          const fmt = parsed.format || {};
          if (fmt.bitrate != null && isFinite(fmt.bitrate) && fmt.bitrate > 0) {
            bitrate = Math.round(fmt.bitrate / 1000);
          }
          sampleRate = fmt.sampleRate || null;
          channels   = fmt.numberOfChannels || null;
          bitDepth   = fmt.bitsPerSample || null;
          // Fallback: calculate bitrate from filesize / duration for lossless files
          // where music-metadata does not embed a bitrate value (e.g. some FLAC, WAV)
          if (bitrate == null && fmt.duration > 0) {
            try {
              const { size } = fs.statSync(absPath);
              bitrate = Math.round(size * 8 / fmt.duration / 1000);
            } catch (_) { /* ignore stat errors */ }
          }
        } catch (_e) {
          await reportError(absPath, 'bitrate', `Tech-meta parse failed: ${_e.message}`, _e.stack);
        }
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-tech-meta`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: { filepath: data.filepath, vpath: loadJson.vpath, bitrate, sample_rate: sampleRate, channels, bit_depth: bitDepth }
        });
      } catch (_techErr) {
        await reportError(absPath, 'bitrate', `Tech-meta update failed: ${_techErr.message}`, _techErr.stack);
      }
    }

    if (data._needsAlbumVersion) {
      try {
        let albumVersion = null, albumVersionSource = null;
        try {
          const parsed = await parseFile(absPath, { skipCovers: true });
          const common = parsed.common || {};
          const native = parsed.native || {};
          const fmt    = parsed.format || {};
          // relPath must be set on common so the folder-name heuristic works
          common.filePath = relPath;
          const cfgFields = Array.isArray(loadJson.albumVersionTags) ? loadJson.albumVersionTags : null;
          albumVersion       = deriveAlbumVersion(common, native, fmt, cfgFields);
          albumVersionSource = _lastAlbumVersionSource;
        } catch (_e) {
          await reportError(absPath, 'album-version', `Album version parse failed: ${_e.message}`, _e.stack);
        }
        await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-album-version`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: { filepath: data.filepath, vpath: loadJson.vpath, album_version: albumVersion, album_version_source: albumVersionSource }
        });
      } catch (_avErr) {
        await reportError(absPath, 'album-version', `Album version update failed: ${_avErr.message}`, _avErr.stack);
      }
    }

    await confirmOk(absPath);
  }
}

async function flushBatch() {
  if (_pendingBatch.length === 0) return;
  const batch = _pendingBatch.splice(0);
  let batchResults;
  try {
    const res = await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's' : ''}://localhost:${loadJson.port}/api/v1/scanner/get-files-batch`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: {
        vpath: loadJson.vpath,
        scanId: loadJson.scanId,
        items: batch.map(b => ({ filepath: b.relPath, modTime: b.modTime }))
      }
    });
    batchResults = res.data;
  } catch (_batchErr) {
    // If the batch endpoint itself fails, report errors for all files in the batch
    for (const b of batch) {
      await reportError(b.absPath, 'insert', `Batch lookup failed: ${_batchErr.message}`, _batchErr.stack);
    }
    return;
  }

  for (const b of batch) {
    try {
      const data = batchResults[b.relPath] ?? {};
      await processFileResult(b.absPath, b.relPath, b.modTime, data);
    } catch (err) {
      console.error(`Warning: failed to add file ${b.absPath} to database: ${err.message}`);
      await reportError(b.absPath, 'insert', err.message, err.stack);
    }
    if (loadJson.pause) await timeout(loadJson.pause);
  }
}

async function recursiveScan(dir) {
  if (process.send) process.send({ dir });
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_err) {
    return;
  }

  for (const file of files) {
    const filepath = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(filepath);
    } catch (_error) {
      // Bad file, ignore and continue
      continue;
    }

    if (stat.isDirectory()) {
      if (loadJson.otherRoots.includes(filepath)) { continue; }
      if (loadJson.excludedPaths.includes(filepath)) { continue; }
      await recursiveScan(filepath);
    } else if (stat.isFile()) {
      if (!loadJson.supportedFiles[getFileType(file).toLowerCase()]) { continue; }
      _pendingBatch.push({ absPath: filepath, relPath: path.relative(loadJson.directory, filepath), modTime: stat.mtime.getTime() });
      _totalSeen++;
      if (_pendingBatch.length >= SCAN_BATCH_SIZE) await flushBatch();
    }
  }
}

function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parse a sidecar .cue file alongside an audio file.
// Returns [{no, title, t}] (t = seconds) or null.
// Only applies to single-FILE cue sheets where the FILE entry matches this audio file.
function parseSidecarCue(audioFilePath) {
  const dir  = path.dirname(audioFilePath);
  const base = path.basename(audioFilePath, path.extname(audioFilePath));

  // Prefer exact-basename match, then fall back to sole .cue in the directory
  let cuePath = path.join(dir, base + '.cue');
  if (!fs.existsSync(cuePath)) {
    let cueFiles;
    try { cueFiles = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.cue')); } catch (_e) { return null; }
    if (cueFiles.length !== 1) return null;
    cuePath = path.join(dir, cueFiles[0]);
  }

  let content;
  try { content = fs.readFileSync(cuePath, 'utf8'); } catch (_e) { return null; }

  // Only handle single-FILE cue sheets whose FILE line references this audio file
  const fileLines = [...content.matchAll(/^FILE\s+"([^"]+)"/gim)];
  if (fileLines.length !== 1) return null;
  const cueRef = path.basename(fileLines[0][1]);
  if (cueRef.toLowerCase() !== path.basename(audioFilePath).toLowerCase()) return null;

  // Parse TRACK / TITLE / INDEX 01 MM:SS:FF
  const tracks = [];
  let cur = null;
  for (const line of content.split(/\r?\n/)) {
    const trackM = line.match(/^\s*TRACK\s+(\d+)\s+AUDIO/i);
    if (trackM) { cur = { no: parseInt(trackM[1], 10), title: null }; continue; }
    if (!cur) continue;
    const titleM = line.match(/^\s*TITLE\s+"(.*)"/i);
    if (titleM) { cur.title = titleM[1]; continue; }
    const idxM = line.match(/^\s*INDEX\s+01\s+(\d+):(\d+):(\d+)/i);
    if (idxM) {
      const t = parseInt(idxM[1], 10) * 60 + parseInt(idxM[2], 10) + parseInt(idxM[3], 10) / 75;
      tracks.push({ no: cur.no, title: cur.title, t: Math.round(t * 100) / 100 });
      cur = null;
    }
  }
  return tracks.length > 1 ? tracks : null;
}

// Extract chapters from an M4B/M4A file via ffprobe.
// Returns [{no, title, t}] (t = seconds) or null if no chapters found.
function extractM4bChapters(filePath, ffprobePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_chapters', filePath];
    execFile(ffprobePath, args, { maxBuffer: 2 * 1024 * 1024, timeout: 20000 }, (err, stdout) => {
      if (err) { reject(err); return; }
      let chapters;
      try { chapters = JSON.parse(stdout).chapters; } catch (_e) { resolve(null); return; }
      if (!Array.isArray(chapters) || chapters.length < 2) { resolve(null); return; }
      const pts = chapters.map((ch, i) => ({
        no:    i + 1,
        title: (ch.tags?.title || `Chapter ${i + 1}`).trim(),
        t:     Math.round(parseFloat(ch.start_time) * 100) / 100 || 0,
      })).filter(cp => cp.t >= 0);
      resolve(pts.length >= 2 ? pts : null);
    });
  });
}

// Returns a promise that rejects after `ms` milliseconds with a timeout error.
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

const PARSE_TIMEOUT_MS = 30000; // 30 s — enough for any normal file; hangs abort cleanly

async function parseMyFile(thisSong, modified) {
  let songInfo, fmtInfo = {}, nativeInfo = {};
  try {
    const parsed = await withTimeout(
      parseFile(thisSong, { skipCovers: loadJson.skipImg }),
      PARSE_TIMEOUT_MS
    );
    songInfo = parsed.common;
    fmtInfo = parsed.format || {};
    nativeInfo = parsed.native || {};
  } catch (err) {
    // If the error is in the embedded picture block, retry without covers to
    // still recover text tags (title, artist, album, year, track, etc.)
    if (!loadJson.skipImg) {
      try {
        const fallback = await withTimeout(
          parseFile(thisSong, { skipCovers: true }),
          PARSE_TIMEOUT_MS
        );
        songInfo = fallback.common;
        fmtInfo = fallback.format || {};
        nativeInfo = fallback.native || {};
        console.error(`Warning: metadata parse error (covers skipped) on ${thisSong}: ${err.message}`);
        await reportError(thisSong, 'parse', err.message, err.stack);
      } catch (err2) {
        console.error(`Warning: metadata parse error on ${thisSong}: ${err2.message}`);
        await reportError(thisSong, 'parse', err2.message, err2.stack);
        songInfo = {track: { no: null, of: null }, disk: { no: null, of: null }};
      }
    } else {
      console.error(`Warning: metadata parse error on ${thisSong}: ${err.message}`);
      await reportError(thisSong, 'parse', err.message, err.stack);
      songInfo = {track: { no: null, of: null }, disk: { no: null, of: null }};
    }
  }

  songInfo.modified = modified;
  songInfo.filePath = path.relative(loadJson.directory, thisSong);
  songInfo.format = getFileType(thisSong);
  // duration from format block (seconds, float) — e.g. 237.43
  songInfo._duration = (fmtInfo.duration != null && isFinite(fmtInfo.duration))
    ? Math.round(fmtInfo.duration * 1000) / 1000
    : null;
  // audio technical metadata — bitrate (stored as kbps integer), sample rate (Hz), channels
  songInfo._bitrate    = (fmtInfo.bitrate != null && isFinite(fmtInfo.bitrate) && fmtInfo.bitrate > 0)
    ? Math.round(fmtInfo.bitrate / 1000) : null;
  songInfo._sampleRate = fmtInfo.sampleRate || null;
  songInfo._channels   = fmtInfo.numberOfChannels || null;
  songInfo._bitDepth   = fmtInfo.bitsPerSample || null;

  // ── Folder-name fallback for missing tags ─────────────────────────────────
  // When a file has no embedded artist/album/title tags the parent folder name
  // is usually "Artist - Release info …" (dash or en-dash separator).
  // Extract the artist from the first segment and derive title from filename.
  //
  // NOTE: This writes ONLY to the mStream database — the audio files on disk
  // are never modified. Derived values survive rescans: if a file is unchanged
  // on disk the scanner skips full re-parsing and the DB values are preserved.
  // Only files whose content changes (new modTime/hash) trigger a re-parse,
  // which will re-derive the same values if no embedded tags are found.
  if (!songInfo.artist && !songInfo.albumartist) {
    const segments = songInfo.filePath.split('/');
    const parentFolder = segments.length >= 2 ? segments[segments.length - 2] : null;
    if (parentFolder) {
      const m = parentFolder.match(/^(.+?)\s+[-–]\s+/);
      if (m) songInfo.artist = m[1].trim();
    }
  }
  if (!songInfo.album) {
    const segments = songInfo.filePath.split('/');
    const parentFolder = segments.length >= 2 ? segments[segments.length - 2] : null;
    if (parentFolder) {
      // Album = everything before the catalogue number at the end (SP5-… / -cd- etc.)
      const clean = parentFolder.replace(/\s*[-–]\s*(SP\d[-\d]*|[A-Z]{2,}-\d[\w-]*|-cd-|-\d+).*$/i, '').trim();
      songInfo.album = clean;
    }
  }
  if (!songInfo.title) {
    // Title = filename without extension, stripped of leading track numbers
    const base = path.basename(thisSong, path.extname(thisSong));
    songInfo.title = base.replace(/^[\d\s._-]+/, '').trim() || base;
  }
  // ────────────────────────────────────────────────────────────────────────────

  try {
    songInfo.hash = await withTimeout(calculateHash(thisSong), PARSE_TIMEOUT_MS);
  } catch (err) {
    console.error(`Warning: hash failed on ${thisSong}: ${err.message}`);
    await reportError(thisSong, 'parse', `Hash failed: ${err.message}`, err.stack);
    songInfo.hash = null;
  }

  // Calculate audio_hash (metadata-based identity, survives transcoding)
  try {
    songInfo.audio_hash = calculateAudioHash(songInfo);
  } catch (err) {
    console.error(`Warning: audio_hash failed on ${thisSong}: ${err.message}`);
    songInfo.audio_hash = null;
  }
  // Extract embedded cue sheet (present in single-file FLAC/WAV album rips)
  try {
    const cue = songInfo.cuesheet;
    const sampleRate = fmtInfo.sampleRate || null;
    if (cue && Array.isArray(cue.tracks) && cue.tracks.length && sampleRate) {
      const cuePoints = [];
      for (const t of cue.tracks) {
        if (t.number === 170) continue; // 0xAA = lead-out marker
        const idx1 = Array.isArray(t.indexes) && t.indexes.find(i => i.number === 1);
        if (!idx1) continue;
        const seconds = idx1.offset / sampleRate;
        cuePoints.push({ no: t.number, title: t.title || null, t: Math.round(seconds * 100) / 100 });
      }
      if (cuePoints.length > 1) {
        songInfo.cuepoints = JSON.stringify(cuePoints);
      }
    }
  } catch (_e) {
    // non-critical — embedded cue extraction failed
    await reportError(thisSong, 'cue', `Embedded cue sheet parse failed: ${_e.message}`, _e.stack);
  }

  // Fallback: sidecar .cue file alongside the audio file
  if (!songInfo.cuepoints) {
    try {
      const sidecar = parseSidecarCue(thisSong);
      if (sidecar) songInfo.cuepoints = JSON.stringify(sidecar);
    } catch (_e) {
      // non-critical
      await reportError(thisSong, 'cue', `Sidecar .cue file parse failed: ${_e.message}`, _e.stack);
    }
  }

  // M4B chapter extraction via ffprobe (only when no cuepoints found yet)
  if (!songInfo.cuepoints && /\.m4b$/i.test(thisSong) && loadJson.ffprobePath) {
    try {
      const chapters = await extractM4bChapters(thisSong, loadJson.ffprobePath);
      if (chapters) songInfo.cuepoints = JSON.stringify(chapters);
    } catch (_e) {
      await reportError(thisSong, 'cue', `M4B chapter extraction failed: ${_e.message}`, _e.stack);
    }
  }

  await getAlbumArt(songInfo);

  // ── Album version detection ───────────────────────────────────────────────
  // Derive album_version from tags, heuristics, or audio properties.
  // Uses the user-configured albumVersionTags list (or built-in default).
  try {
    songInfo._albumVersion = deriveAlbumVersion(
      songInfo, nativeInfo, fmtInfo,
      loadJson.albumVersionTags || DEFAULT_ALBUM_VERSION_TAGS
    );
    songInfo._albumVersionSource = _lastAlbumVersionSource;
  } catch (_avErr) {
    songInfo._albumVersion = null;
    songInfo._albumVersionSource = null;
  }

  return songInfo;
}

// Maximum bytes read when hashing — first 512 KB is sufficient for change
// detection and uniqueness. Avoids 30-s timeouts on large single-file mixes.
const HASH_READ_LIMIT = 524288; // 512 KB

function calculateHash(filepath) {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('md5').setEncoding('hex');
      const fileStream = fs.createReadStream(filepath, { start: 0, end: HASH_READ_LIMIT - 1 });

      fileStream.on('error', (err) => {
        reject(err);
      });
  
      fileStream.on('end', () => {
        hash.end();
        fileStream.close();
        resolve(hash.read());
      });
  
      fileStream.pipe(hash);
    }catch(err) {
      reject(err);
    }
  });
}

async function getAlbumArt(songInfo) {
  if (loadJson.skipImg === true) { return; }

  let originalFileBuffer;

  // picture is stored in song metadata
  if (songInfo.picture && songInfo.picture[0]) {
    // Prefer the Front Cover (type 3 / 'Cover (front)') over whatever [0] happens to be.
    // FLAC files with both ID3 and Vorbis tag blocks can have multiple picture entries
    // in arbitrary order; picking by type avoids using a back cover or artist photo.
    const frontCover = songInfo.picture.find(p => p.type === 'Cover (front)') || songInfo.picture[0];
    // Generate unique name based off hash of album art and metadata
    const picHashString = crypto.createHash('md5').update(frontCover.data).digest('hex');
    // mime-types returns 'jpeg' for image/jpeg — normalise to 'jpg' so filenames
    // are consistent with what the Discogs embed endpoint writes (.jpg hardcoded).
    const _rawExt = mime.extension(frontCover.format);
    const _normExt = (_rawExt === 'jpeg') ? 'jpg' : (_rawExt || 'jpg');
    songInfo.aaFile = picHashString + '.' + _normExt;
    songInfo._artSource = 'embedded';
    // Check image-cache folder for filename and save if doesn't exist
    if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
      // Save file sync
      fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), frontCover.data);
      originalFileBuffer = Buffer.from(frontCover.data);
    }
  } else {
    originalFileBuffer = await checkDirectoryForAlbumArt(songInfo);
    if (songInfo.aaFile) { songInfo._artSource = 'directory'; }
  }

  if (originalFileBuffer) {
    try {
      await compressAlbumArt(originalFileBuffer, songInfo.aaFile);
    } catch (err) {
      // sharp couldn't decode the image (e.g. corrupted embedded PNG/JPEG).
      // The original is already on disk; copy it as a fallback thumbnail so
      // art still displays. Don't report a scan error — the user can't fix a
      // corrupted embedded image and the error would persist every rescan.
      try {
        const zlPath = path.join(loadJson.albumArtDirectory, 'zl-' + songInfo.aaFile);
        const zsPath = path.join(loadJson.albumArtDirectory, 'zs-' + songInfo.aaFile);
        if (!fs.existsSync(zlPath)) { fs.writeFileSync(zlPath, originalFileBuffer); }
        if (!fs.existsSync(zsPath)) { fs.writeFileSync(zsPath, originalFileBuffer); }
      } catch (_) { /* ignore fallback failure */ }
      console.warn(`Warning: could not compress album art for ${songInfo.filePath} (${err.message}) — using original`);
    }
  }
}

async function compressAlbumArt(buff, imgName) {
  if (loadJson.compressImage === false) { return; }
  if (buff.length < 100) { return; } // guard against malformed micro-buffers (file-type CVE workaround)

  await sharp(buff).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).toFile(path.join(loadJson.albumArtDirectory, 'zl-' + imgName));
  await sharp(buff).resize(92,  92,  { fit: 'inside', withoutEnlargement: true }).toFile(path.join(loadJson.albumArtDirectory, 'zs-' + imgName));
  await sharp(buff).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).toFile(path.join(loadJson.albumArtDirectory, 'zm-' + imgName));
}

const mapOfDirectoryAlbumArt = {};
function checkDirectoryForAlbumArt(songInfo) {
  const directory = path.join(loadJson.directory, path.dirname(songInfo.filePath));

  // album art has already been found
  if (mapOfDirectoryAlbumArt[directory]) {
    songInfo.aaFile = mapOfDirectoryAlbumArt[directory];
    return; // File already exists, no need to compress again
  }

  // directory was already scanned and nothing was found
  if (mapOfDirectoryAlbumArt[directory] === false) { return; }

  const imageArray = [];
  let files;
  try {
    files = fs.readdirSync(directory);
  } catch (_err) {
    return;
  }

  for (const file of files) {
    const filepath = path.join(directory, file);
    let stat;
    try {
      stat = fs.statSync(filepath);
    } catch (_error) {
      // Bad file, ignore and continue
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }

    if (["png", "jpg"].indexOf(getFileType(file)) === -1) {
      continue;
    }

    imageArray.push(file);
  }

  if (imageArray.length === 0) {
    // No images directly in this directory — check common artwork subdirectories
    const artworkSubdirNames = ['artwork', 'scans', 'covers', 'images', 'art', 'cover', 'scan'];
    for (const file of files) {
      const subDirPath = path.join(directory, file);
      let subDirStat;
      try { subDirStat = fs.statSync(subDirPath); } catch { continue; }
      if (!subDirStat.isDirectory()) continue;
      if (!artworkSubdirNames.includes(file.toLowerCase())) continue;

      let subFiles;
      try { subFiles = fs.readdirSync(subDirPath); } catch { continue; }
      for (const subFile of subFiles) {
        const ext = getFileType(subFile).toLowerCase();
        if (ext !== 'jpg' && ext !== 'png') continue;
        let subStat;
        try { subStat = fs.statSync(path.join(subDirPath, subFile)); } catch { continue; }
        if (!subStat.isFile()) continue;
        imageArray.push(path.join(file, subFile)); // e.g. "artwork/front.jpg"
      }
      if (imageArray.length > 0) break;
    }

    if (imageArray.length === 0) {
      // No images in directory or artwork subdirs — check one level up (parent dir).
      // This handles multi-disc albums where cover.jpg lives in the album root
      // but tracks are in CD1/, CD2/, Disc 1/ etc. subdirectories.
      const parentDir = path.dirname(directory);
      // Only check if parent is inside the music root (don't escape the library)
      if (parentDir && parentDir !== directory && parentDir.startsWith(loadJson.directory)) {
        let parentFiles;
        try { parentFiles = fs.readdirSync(parentDir); } catch { parentFiles = []; }
        for (const pf of parentFiles) {
          const ext = getFileType(pf).toLowerCase();
          if (ext !== 'jpg' && ext !== 'png') continue;
          let pStat;
          try { pStat = fs.statSync(path.join(parentDir, pf)); } catch { continue; }
          if (!pStat.isFile()) continue;
          // Prefix with '../' so path.join(directory, '../cover.jpg') resolves correctly
          imageArray.push(path.join('..', pf));
        }
      }
    }

    if (imageArray.length === 0) {
      return mapOfDirectoryAlbumArt[directory] = false;
    }
  }

  let imageBuffer;
  let picFormat;
  let selectedImageFile = null;
  let newFileFlag = false;

  // Search for a named file
  for (let i = 0; i < imageArray.length; i++) {
    const imgMod = imageArray[i].toLowerCase();
    if (imgMod === 'folder.jpg' || imgMod === 'cover.jpg' || imgMod === 'album.jpg' || imgMod === 'front.jpg' || imgMod === 'folder.png' || imgMod === 'cover.png' || imgMod === 'album.png' || imgMod === 'front.png') {
      try {
        imageBuffer = fs.readFileSync(path.join(directory, imageArray[i]));
        picFormat = getFileType(imageArray[i]);
        selectedImageFile = imageArray[i];
      } catch (err) {
        console.error(`Warning: failed to read album art file ${imageArray[i]}: ${err.message}`);
      }
      break;
    }
  }
  
  // default to first file if none are named
  if (!imageBuffer) {
    try {
      imageBuffer = fs.readFileSync(path.join(directory, imageArray[0]));
      picFormat = getFileType(imageArray[0]);
      selectedImageFile = imageArray[0];
    } catch (err) {
      console.error(`Warning: failed to read album art file ${imageArray[0]}: ${err.message}`);
    }
  }

  // If we still have no buffer (all reads failed or resulted in empty data), bail out
  if (!imageBuffer || imageBuffer.length === 0) {
    return mapOfDirectoryAlbumArt[directory] = false;
  }

  const picHashString = crypto.createHash('md5').update(imageBuffer).digest('hex');
  songInfo.aaFile = picHashString + '.' + picFormat;
  if (selectedImageFile) songInfo._coverFile = selectedImageFile;
  // Check image-cache folder for filename and save if doesn't exist
  if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
    // Save file sync
    fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), imageBuffer);
    newFileFlag = true;
  }

  mapOfDirectoryAlbumArt[directory] = songInfo.aaFile;

  if (newFileFlag === true) { return imageBuffer; }
}

function getFileType(filename) {
  return filename.split(".").pop();
}