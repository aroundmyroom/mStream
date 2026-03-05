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
      db.removeFileByPath(req.body.filepath, req.body.vpath);
      return res.json({});
    }
    // update scan ID now so the record survives finish-scan pruning
    db.updateFileScanId(dbFileInfo, req.body.scanId);

    const flags = {};
    // signal art-only update if aaFile is missing
    if (!dbFileInfo.aaFile) { flags._needsArt = true; }
    // signal cue-only update if cuepoints has never been checked (NULL)
    if (dbFileInfo.cuepoints === null || dbFileInfo.cuepoints === undefined) { flags._needsCue = true; }

    if (flags._needsArt || flags._needsCue) {
      return res.json({ ...flags, filepath: dbFileInfo.filepath, vpath: dbFileInfo.vpath });
    }

    res.json(dbFileInfo);
  });

  mstream.post('/api/v1/scanner/update-art', (req, res) => {
    db.updateFileArt(req.body.filepath, req.body.vpath, req.body.aaFile, req.body.scanId);
    res.json({});
  });

  mstream.post('/api/v1/scanner/update-cue', (req, res) => {
    // cuepoints is either a JSON string or '[]' (sentinel: checked, no cue found)
    db.updateFileCue(req.body.filepath, req.body.vpath, req.body.cuepoints);
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
    db.saveFilesDB();
    res.json({});
  });

  let saveCounter = 0;
  mstream.post('/api/v1/scanner/add-file', (req, res) => {
    db.insertFile(req.body);
    res.json({});

    saveCounter++;
    if(saveCounter > config.program.scanOptions.saveInterval) {
      saveCounter = 0;
      db.saveFilesDB();
    }
  });
}
