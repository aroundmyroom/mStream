/**
 * mb-enrich-worker.mjs
 * Worker thread: looks up each AcoustID-matched file on MusicBrainz (1 req/s),
 * stores album/year/track/release-id, and classifies tag_status.
 */
import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import https from 'node:https';

const { dbPath } = workerData;

const RATE_DELAY_MS  = 1100;   // stay safely under MB's 1 req/s limit
const BATCH_SIZE     = 50;
const IDLE_WAIT_MS   = 60_000;
const HTTP_TIMEOUT_MS = 25_000;
const USER_AGENT     = 'mStreamVelvet/1.0 (https://github.com/aroundmyroom/mStream; admin-contact@music.aroundtheworld.net)';

const db = new DatabaseSync(dbPath, { timeout: 15_000 });
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000');

const _getQueue = db.prepare(`
  SELECT filepath, vpath, mbid, title, artist, album, year, track
  FROM files
  WHERE mbid IS NOT NULL
    AND mb_enrichment_status IS NULL
    AND acoustid_status = 'found'
  LIMIT ?
`);

const _setPending = db.prepare(
  `UPDATE files SET mb_enrichment_status = 'pending', mb_enriched_ts = ? WHERE filepath = ? AND vpath = ?`
);

const _setResult = db.prepare(`
  UPDATE files
  SET mb_album = ?, mb_year = ?, mb_track = ?, mb_release_id = ?,
      mb_album_dir = ?,
      mb_enrichment_status = ?, mb_enriched_ts = ?, tag_status = ?,
      mb_enrichment_error = ?
  WHERE filepath = ? AND vpath = ?
`);

const _resetPending = db.prepare(
  `UPDATE files SET mb_enrichment_status = NULL WHERE mb_enrichment_status = 'pending'`
);

const _getStats = db.prepare(`
  SELECT
    COUNT(CASE WHEN mbid IS NOT NULL AND acoustid_status = 'found' THEN 1 END) AS total,
    COUNT(CASE WHEN mb_enrichment_status = 'done'    THEN 1 END) AS done,
    COUNT(CASE WHEN mb_enrichment_status = 'error'   THEN 1 END) AS errors,
    COUNT(CASE WHEN mb_enrichment_status = 'no_data' THEN 1 END) AS no_data,
    COUNT(CASE WHEN mb_enrichment_status IS NULL AND mbid IS NOT NULL AND acoustid_status = 'found' THEN 1 END) AS queued
  FROM files
`);

// Reset pending rows left over from an interrupted previous run
_resetPending.run();

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

/**
 * Compute the "physical album directory" key for grouping.
 * Strips the filename and collapses trailing /CD N / Disc N indicators so
 * that multi-disc albums share one group key.
 */
function normalizeAlbumDir(filepath) {
  const lastSlash = filepath.lastIndexOf('/');
  let dir = lastSlash > 0 ? filepath.slice(0, lastSlash) : '';
  dir = dir.replace(/\/(CD|Disc|Disk|Side)\s*\d+\s*$/i, '');
  return dir;
}

/** Classify tag_status by comparing stored file tags against MB data. */
function computeTagStatus(row, mbData) {
  if (!mbData.mb_release_id) return 'needs_review';
  const titleOk  = !mbData.mb_title  || norm(row.title)  === norm(mbData.mb_title);
  const artistOk = !mbData.mb_artist || norm(row.artist) === norm(mbData.mb_artist);
  const albumOk  = !mbData.mb_album  || norm(row.album)  === norm(mbData.mb_album);
  const yearOk   = !mbData.mb_year   || Math.abs((row.year || 0) - mbData.mb_year) <= 1;
  return (titleOk && artistOk && albumOk && yearOk) ? 'confirmed' : 'needs_review';
}

/** Pick the best release: prefer Album > Single by primary-type, then earliest date. */
function selectRelease(releases) {
  if (!releases || releases.length === 0) return null;
  const typeScore = rg => ({ Album: 2, Single: 1 }[(rg || {})['primary-type']] || 0);
  const parseDate = d => {
    if (!d) return 0;
    // dates can be "2003", "2003-04", "2003-04-07"
    return parseInt(d.replace(/-/g, '').padEnd(8, '0'), 10);
  };
  return [...releases].sort((a, b) => {
    const sa = typeScore(a['release-group']), sb = typeScore(b['release-group']);
    if (sa !== sb) return sb - sa;
    const da = parseDate(a.date), db_ = parseDate(b.date);
    if (da && db_) return da - db_;
    if (da) return -1;
    if (db_) return 1;
    return 0;
  })[0];
}

/** Fetch recording data from MusicBrainz. Returns parsed JSON or throws. */
function mbLookup(mbid) {
  return new Promise((resolve, reject) => {
    const url = `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(mbid)}?inc=artists%2Breleases%2Brelease-groups%2Bmedia&fmt=json`;
    const timer = setTimeout(() => { req.destroy(new Error('MB timeout')); }, HTTP_TIMEOUT_MS);
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
      clearTimeout(timer);
      if (res.statusCode === 404) { res.resume(); return resolve(null); }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`MB HTTP ${res.statusCode}`));
      }
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`MB JSON: ${e.message}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ── Process one file ──────────────────────────────────────────────────────────

async function processFile(row) {
  const ts = Math.floor(Date.now() / 1000);
  _setPending.run(ts, row.filepath, row.vpath);

  let apiData;
  try {
    apiData = await mbLookup(row.mbid);
  } catch (err) {
    _setResult.run(null, null, null, null, null, 'error', ts, null, err.message.slice(0, 200), row.filepath, row.vpath);
    return;
  }

  if (!apiData) {
    _setResult.run(null, null, null, null, null, 'no_data', ts, null, null, row.filepath, row.vpath);
    return;
  }

  // Extract canonical artist name from artist-credit
  const mbArtist = apiData['artist-credit']?.[0]?.artist?.name ?? null;

  const best = selectRelease(apiData.releases);
  if (!best) {
    // No release info — store artist/title at least, mark no_data
    _setResult.run(
      null, null, null, null, null, 'no_data', ts, 'needs_review', null,
      row.filepath, row.vpath
    );
    return;
  }

  // Get track number from first medium (MB only returns the matching medium)
  let mbTrack = null;
  try {
    mbTrack = best.media?.[0]?.tracks?.[0]?.position ?? null;
    if (!mbTrack) {
      const numStr = best.media?.[0]?.tracks?.[0]?.number;
      mbTrack = numStr ? parseInt(numStr, 10) || null : null;
    }
  } catch (_) {}

  // Parse release year from date string
  let mbYear = null;
  if (best.date) {
    const yr = parseInt(best.date.slice(0, 4), 10);
    if (yr >= 1900 && yr <= 2100) mbYear = yr;
  }

  const mbData = {
    mb_title:      apiData.title     ?? null,
    mb_artist:     mbArtist,
    mb_album:      best.title        ?? null,
    mb_year:       mbYear,
    mb_track:      mbTrack,
    mb_release_id: best.id           ?? null,
  };

  const tagStatus = computeTagStatus(row, mbData);

  _setResult.run(
    mbData.mb_album, mbData.mb_year, mbData.mb_track, mbData.mb_release_id,
    normalizeAlbumDir(row.filepath),
    'done', ts, tagStatus, null,
    row.filepath, row.vpath
  );
}

// ── Main loop ─────────────────────────────────────────────────────────────────

let _stopping = false;

async function run() {
  parentPort.postMessage({ type: 'ready' });

  while (!_stopping) {
    const batch = _getQueue.all(BATCH_SIZE);

    if (batch.length === 0) {
      // Nothing to do — report status and wait
      parentPort.postMessage({ type: 'status', stats: _getStats.get(), idle: true });
      for (let i = 0; i < IDLE_WAIT_MS / 1000 && !_stopping; i++) {
        await sleep(1000);
      }
      continue;
    }

    for (const row of batch) {
      if (_stopping) break;
      await processFile(row);
      await sleep(RATE_DELAY_MS);
    }

    parentPort.postMessage({ type: 'status', stats: _getStats.get(), idle: false });
  }

  parentPort.postMessage({ type: 'stopped', stats: _getStats.get() });
}

parentPort.on('message', msg => {
  if (msg === 'stop') _stopping = true;
});

run().catch(err => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
