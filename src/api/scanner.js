import path from 'path';
import fs from 'fs';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import * as scanProgress from '../state/scan-progress.js';

export function setup(mstream) {
  mstream.all('/api/v1/scanner/{*path}', (req, res, next) => {
    if (req.scanApproved !== true) { return res.status(403).json({ error: 'Access Denied' }); }
    next();
  });

  mstream.post('/api/v1/scanner/get-file', (req, res) => {
    if (req.body.scanId) { scanProgress.tick(req.body.scanId, req.body.filepath); }
    const dbFileInfo = db.findFileByPath(req.body.filepath, req.body.vpath);

    // return empty response if nothing was found
    if (!dbFileInfo) {
      return res.json({});
    }
    // if the file was edited, remove it from the DB
    else if (req.body.modTime !== dbFileInfo.modified) {
      // Preserve any Discogs-assigned art (cache-only, e.g. WAV) so a rescan
      // of the modified file doesn't orphan art the user manually picked.
      const preserveAaFile = dbFileInfo.aaFile || null;
      const preserveArtSource = dbFileInfo.art_source || null;
      db.removeFileByPath(req.body.filepath, req.body.vpath);
      return res.json({ _stale: true, _preserveAaFile: preserveAaFile, _preserveArtSource: preserveArtSource, _preserveTs: dbFileInfo.ts || null });
    }
    // hash=null means a previous parse failed (e.g. hash timeout on a large file) — force re-parse
    else if (dbFileInfo.hash === null || dbFileInfo.hash === undefined) {
      db.removeFileByPath(req.body.filepath, req.body.vpath);
      return res.json({ _stale: true, _preserveAaFile: dbFileInfo.aaFile || null, _preserveArtSource: dbFileInfo.art_source || null, _preserveTs: dbFileInfo.ts || null });
    }
    // update scan ID now so the record survives finish-scan pruning
    db.updateFileScanId(dbFileInfo, req.body.scanId);

    const flags = {};
    // signal art-only update if aaFile is missing (null = never attempted; '' = checked, none found)
    // OR if aaFile is set but the cached file no longer exists on disk (e.g. image-cache was cleared)
    if (dbFileInfo.aaFile === null || dbFileInfo.aaFile === undefined) {
      flags._needsArt = true;
    } else if (dbFileInfo.aaFile && !fs.existsSync(path.join(config.program.storage.albumArtDirectory, dbFileInfo.aaFile))) {
      flags._needsArt = true;
      // Clear the stale aaFile ref so the scanner inserts the freshly-extracted filename
      db.updateFileArt(dbFileInfo.filepath, dbFileInfo.vpath, null, req.body.scanId, null);
    }
    // signal cue-only update if cuepoints has never been checked (NULL)
    if (dbFileInfo.cuepoints === null || dbFileInfo.cuepoints === undefined) { flags._needsCue = true; }
    // signal duration-only update if duration was never stored (NULL)
    if (dbFileInfo.duration === null || dbFileInfo.duration === undefined) { flags._needsDuration = true; }

    if (flags._needsArt || flags._needsCue || flags._needsDuration) {
      return res.json({ ...flags, filepath: dbFileInfo.filepath, vpath: dbFileInfo.vpath });
    }

    res.json(dbFileInfo);
  });

  mstream.post('/api/v1/scanner/set-expected', (req, res) => {
    if (req.body.scanId && req.body.expected > 0) {
      scanProgress.setExpected(req.body.scanId, req.body.expected);
    }
    res.json({});
  });

  // Incremental pre-count update — called every 5 000 files during the
  // first-scan pre-count walk so the UI shows a growing "Counting…" counter.
  mstream.post('/api/v1/scanner/counting-update', (req, res) => {
    if (req.body.scanId && req.body.found > 0) {
      scanProgress.updateCountingFound(req.body.scanId, req.body.found);
    }
    res.json({});
  });

  // Batch variant of get-file: look up N files in one HTTP call + one SQL transaction.
  // Items that are unchanged and complete have their scanId updated in a single transaction,
  // reducing 200 individual UPDATEs to 1 — ~200x faster for unchanged-file rescans.
  mstream.post('/api/v1/scanner/get-files-batch', (req, res) => {
    const { items, vpath, scanId } = req.body;
    if (!Array.isArray(items) || !items.length || !vpath || !scanId) {
      return res.status(400).json({ error: 'Invalid batch request' });
    }
    try {
      const filepaths = items.map(i => i.filepath);
      const dbMap = db.findFilesByPaths(filepaths, vpath);
      const results = {};
      const batchScanIdUpdates = []; // filepaths for fully-up-to-date files

      for (const item of items) {
        scanProgress.tick(scanId, item.filepath);
        const dbFileInfo = dbMap.get(item.filepath);

        if (!dbFileInfo) {
          results[item.filepath] = {};
          continue;
        }

        if (item.modTime !== dbFileInfo.modified) {
          const preserveAaFile = dbFileInfo.aaFile || null;
          const preserveArtSource = dbFileInfo.art_source || null;
          db.removeFileByPath(item.filepath, vpath);
          results[item.filepath] = { _stale: true, _preserveAaFile: preserveAaFile, _preserveArtSource: preserveArtSource, _preserveTs: dbFileInfo.ts || null };
          continue;
        }

        // hash=null means a previous parse failed (e.g. hash timeout on large file) — force re-parse
        if (dbFileInfo.hash === null || dbFileInfo.hash === undefined) {
          db.removeFileByPath(item.filepath, vpath);
          results[item.filepath] = { _stale: true, _preserveAaFile: dbFileInfo.aaFile || null, _preserveArtSource: dbFileInfo.art_source || null, _preserveTs: dbFileInfo.ts || null };
          continue;
        }

        // Same mtime — check flags (same logic as get-file)
        const flags = {};
        if (dbFileInfo.aaFile === null || dbFileInfo.aaFile === undefined) {
          flags._needsArt = true;
        } else if (dbFileInfo.aaFile && !fs.existsSync(path.join(config.program.storage.albumArtDirectory, dbFileInfo.aaFile))) {
          flags._needsArt = true;
          db.updateFileArt(dbFileInfo.filepath, dbFileInfo.vpath, null, scanId, null);
        }
        if (dbFileInfo.cuepoints === null || dbFileInfo.cuepoints === undefined) { flags._needsCue = true; }
        if (dbFileInfo.duration === null || dbFileInfo.duration === undefined) { flags._needsDuration = true; }

        if (flags._needsArt || flags._needsCue || flags._needsDuration) {
          // Needs work — update scanId now so it survives finish-scan pruning
          db.updateFileScanId(dbFileInfo, scanId);
          results[item.filepath] = { ...flags, filepath: dbFileInfo.filepath, vpath: dbFileInfo.vpath };
        } else {
          // Completely clean — collect for single-transaction batch update
          batchScanIdUpdates.push(item.filepath);
          results[item.filepath] = dbFileInfo;
        }
      }

      // All clean-file scanId updates in one transaction
      if (batchScanIdUpdates.length > 0) {
        db.batchUpdateScanIds(batchScanIdUpdates, vpath, scanId);
      }

      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  mstream.post('/api/v1/scanner/update-art', (req, res) => {
    db.updateFileArt(req.body.filepath, req.body.vpath, req.body.aaFile, req.body.scanId, req.body.artSource || null);
    res.json({});
  });

  mstream.post('/api/v1/scanner/update-cue', (req, res) => {
    // cuepoints is either a JSON string or '[]' (sentinel: checked, no cue found)
    db.updateFileCue(req.body.filepath, req.body.vpath, req.body.cuepoints);
    res.json({});
  });

  mstream.post('/api/v1/scanner/update-duration', (req, res) => {
    db.updateFileDuration(req.body.filepath, req.body.vpath, req.body.duration);
    res.json({});
  });

  // Scan error audit: called by the scanner child process to record an error.
  // The guid (md5 of filepath|errorType) ensures deduplication: the same problem
  // on the same file is counted (count++) rather than creating duplicate rows.
  mstream.post('/api/v1/scanner/report-error', (req, res) => {
    const { guid, filepath, vpath, errorType, errorMsg, stack } = req.body;
    if (!guid || !filepath || !vpath || !errorType) { return res.json({}); }
    db.insertScanError(guid, filepath, vpath, errorType, errorMsg || '', stack || '');
    res.json({});
  });

  // After a file is successfully parsed/inserted, confirm any fixed scan errors
  // for it are now resolved.  Only rows where fixed_at IS NOT NULL are touched.
  mstream.post('/api/v1/scanner/confirm-ok', (req, res) => {
    const { filepath, vpath } = req.body;
    if (!filepath || !vpath) return res.json({});
    db.confirmScanErrorOk(filepath, vpath);
    res.json({});
  });

  // Prune old scan errors before each scan run.
  mstream.post('/api/v1/scanner/prune-errors', (req, res) => {
    const retentionHours = config.program.scanOptions.scanErrorRetentionHours || 48;
    db.pruneScanErrors(retentionHours);
    res.json({});
  });

  mstream.post('/api/v1/scanner/finish-scan', (req, res) => {
    scanProgress.finish(req.body.scanId);
    // Delete server-side waveform cache files for any tracks being pruned
    try {
      const cacheDir = config.program.storage.waveformDirectory;
      const staleHashes = db.getStaleFileHashes(req.body.vpath, req.body.scanId);
      for (const hash of staleHashes) {
        const wfPath = path.join(cacheDir, `wf-${hash}.json`);
        if (fs.existsSync(wfPath)) fs.unlinkSync(wfPath);
      }
    } catch (_e) { /* non-critical — waveform cleanup must not abort scan */ }
    db.removeStaleFiles(req.body.vpath, req.body.scanId);
    // Purge any files that belong to excluded-type VCHILDs of this ROOT vpath.
    // These are sub-directories the user has marked as "excluded from index".
    try {
      const rootDir = config.program.folders[req.body.vpath]?.root;
      if (rootDir) {
        for (const [vk, vf] of Object.entries(config.program.folders)) {
          if (vk === req.body.vpath || vf.type !== 'excluded') continue;
          // Is vk a VCHILD of the scanned vpath? Its root must be a sub-path of rootDir.
          const childRoot = vf.root.replace(/\/?$/, '/');
          const parentRoot = rootDir.replace(/\/?$/, '/');
          if (!childRoot.startsWith(parentRoot)) continue;
          // Compute relative prefix (e.g. "DJ Mixes/") and purge from DB
          const relPrefix = path.relative(rootDir, vf.root);
          if (relPrefix) db.removeFilesByPrefix(req.body.vpath, relPrefix + '/');
        }
      }
    } catch (_e) { /* non-critical — purge errors must not abort scan */ }
    // Clear errors that were NOT re-encountered this scan — they are resolved.
    if (req.body.scanStartTs) {
      try { db.clearResolvedErrors(req.body.vpath, req.body.scanStartTs); } catch (_e) { /* non-critical */ }
    }
    db.saveFilesDB();
    // Commit any open scan transaction so the finished state is durable
    // before we return the response.
    db.commitTransaction();
    // Rebuild the folder and artist search indexes after every scan.
    // These are non-critical background operations — errors must not fail the scan.
    try { db.rebuildFolderIndex(); } catch (_e) { /* non-critical */ }
    try { db.rebuildArtistIndex(); } catch (_e) { /* non-critical */ }
    res.json({});
  });

  // Batch scan inserts into explicit SQLite transactions (500 at a time).
  // Without batching, every insertFile() is its own auto-commit which causes
  // an fsync/WAL flush per file.  On HDD/SD that takes 20-200 ms each,
  // blocking the Node.js event loop and starving the audio stream of bytes
  // — causing the browser to pause playback mid-song.
  // 500 batches = ~276 commits for 138K files instead of 2760 — fewer WAL fsyncs.
  let _txBatch = 0;
  const TX_BATCH_SIZE = 500;

  mstream.post('/api/v1/scanner/add-file', (req, res) => {
    if (_txBatch === 0) db.beginTransaction();
    db.insertFile(req.body);
    scanProgress.tickInsert(req.body.sID);
    _txBatch++;
    if (_txBatch >= TX_BATCH_SIZE) {
      db.commitTransaction();
      _txBatch = 0;
    }
    res.json({});
  });
}
