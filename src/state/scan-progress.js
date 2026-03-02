// In-memory scan progress tracker — resets on server restart.
// Keyed by scanId (nanoid(8) assigned to each scan run).
const _scans = new Map();

/**
 * Called when a scan begins.
 * @param {string} scanId
 * @param {string} vpath
 * @param {number|null} expected  - file count from DB before scan (null = first scan)
 */
export function startScan(scanId, vpath, expected) {
  _scans.set(scanId, {
    scanId,
    vpath,
    expected,           // null means no baseline (first scan)
    scanned: 0,
    currentFile: null,
    startedAt: Date.now(),
    _rateBase: 0,
    _rateTs: Date.now(),
    filesPerSec: null,
  });
}

/**
 * Called by the get-file endpoint for each file processed.
 * @param {string} scanId
 * @param {string} filepath
 */
export function tick(scanId, filepath) {
  const s = _scans.get(scanId);
  if (!s) return;
  s.scanned++;
  s.currentFile = filepath;
  // Recalculate rate every 5 seconds
  const elapsed = Date.now() - s._rateTs;
  if (elapsed >= 5000) {
    s.filesPerSec = (s.scanned - s._rateBase) / (elapsed / 1000);
    s._rateBase = s.scanned;
    s._rateTs = Date.now();
  }
}

/**
 * Remove scan from in-memory tracker.
 * @param {string} scanId
 */
export function finish(scanId) {
  _scans.delete(scanId);
}

/**
 * Returns a snapshot of all active scans suitable for the API response.
 */
export function getAll() {
  const now = Date.now();
  return [..._scans.values()].map(s => {
    let pct = null;
    if (s.expected && s.expected > 0 && s.scanned > 0) {
      pct = Math.min(100, Math.round((s.scanned / s.expected) * 100));
    }
    const elapsedSec = Math.round((now - s.startedAt) / 1000);
    let etaSec = null;
    if (pct !== null && pct > 0 && pct < 100 && s.filesPerSec > 0) {
      etaSec = Math.round((s.expected - s.scanned) / s.filesPerSec);
    }
    return {
      scanId: s.scanId,
      vpath: s.vpath,
      scanned: s.scanned,
      expected: s.expected,
      pct,
      currentFile: s.currentFile,
      elapsedSec,
      filesPerSec: s.filesPerSec != null ? Math.round(s.filesPerSec * 10) / 10 : null,
      etaSec,
    };
  });
}
