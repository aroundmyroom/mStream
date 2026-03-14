import { promisify } from 'util';
import path from 'path';
import child from 'child_process';
import fs from 'fs';
import os from 'os';
import Joi from 'joi';
import winston from 'winston';
import archiver from 'archiver';
import * as fileExplorer from '../util/file-explorer.js';
import * as admin from '../util/admin.js';
import * as config from '../state/config.js';
import * as dbQueue from '../db/task-queue.js';
import * as imageCompress from '../db/image-compress-manager.js';
import * as transcode from './transcode.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { getVPathInfo } from '../util/vpath.js';

import { getTransAlgos, getTransCodecs, getTransBitrates } from '../api/transcode.js';
import * as scanProgress from '../state/scan-progress.js';
import * as scrobblerApi from './scrobbler.js';

export function setup(mstream) {
  mstream.all('/api/v1/admin/{*path}', (req, res, next) => {
    if (config.program.lockAdmin === true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    if (req.user.admin !== true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    next();
  });

  mstream.post('/api/v1/admin/lock-api', async (req, res) => {
    const schema = Joi.object({ lock: Joi.boolean().required() });
    joiValidate(schema, req.body);

    await admin.lockAdminApi(req.body.lock);
    res.json({});
  });

  mstream.get('/api/v1/admin/file-explorer/win-drives', (req, res) => {
    if (os.platform() !== 'win32') {
      return res.json([]);
    }

    child.exec('wmic logicaldisk get name', (error, stdout) => {
      const drives = stdout.split('\r\r\n')
        .filter(value => /[A-Za-z]:/.test(value))
        .map(value => value.trim() + '\\')
      res.json(drives);
    });
  });

  // The admin file explorer can view the entire system
  mstream.post("/api/v1/admin/file-explorer", async (req, res) => {
    const schema = Joi.object({
      directory: Joi.string().required(),
      joinDirectory: Joi.string().optional()
    });
    joiValidate(schema, req.body);

    // Handle home directory
    let thisDirectory = req.body.directory;
    if (req.body.directory === '~') {
      thisDirectory = os.homedir();
    }

    if (req.body.joinDirectory) {
      thisDirectory = path.join(thisDirectory, req.body.joinDirectory);
    }

    const folderContents = await fileExplorer.getDirectoryContents(thisDirectory, {}, true);

    res.json({
      path: thisDirectory,
      directories: folderContents.directories,
      files: folderContents.files
    });
  });

  mstream.get("/api/v1/admin/directories", (req, res) => {
    res.json(config.program.folders);
  });

  // Test read/write access for every configured vpath directory.
  // Writes a temp file, reads it back, then deletes it — no artifact is ever left.
  mstream.get('/api/v1/admin/directories/test', async (req, res) => {
    const platform   = os.platform();
    const isElectron = !!process.versions.electron;
    const fsp        = fs.promises;
    const results    = [];

    for (const [vpath, info] of Object.entries(config.program.folders)) {
      const root = info.root;

      // Detect storage type from path shape + platform
      let storageType;
      if (isElectron) {
        storageType = 'electron';
      } else if (platform === 'win32') {
        storageType = /^\\\\/.test(root) ? 'windows-network' : 'windows-local';
      } else if (platform === 'darwin') {
        storageType = /^\/Volumes\//.test(root) ? 'mac-external' : 'mac-local';
      } else {
        // Linux / other POSIX — /mnt/, /media/, /run/media/, /net/ are mount points
        storageType = /^\/(?:mnt|media|run\/media|net)\//.test(root) ? 'linux-mounted' : 'linux-local';
      }

      let readable = false;
      let writable = false;
      let errorMsg = null;

      // Read test
      try {
        await fsp.access(root, fs.constants.R_OK);
        readable = true;
      } catch (e) {
        errorMsg = e.code || e.message;
      }

      // Write test — temp file uses random suffix so it never collides; always cleaned up
      if (readable) {
        const rnd     = Math.random().toString(36).slice(2, 9);
        const tmpFile = path.join(root, `.mstream-writetest-${Date.now()}-${rnd}`);
        try {
          await fsp.writeFile(tmpFile, 'mstream-access-test', { flag: 'wx' });
          const data = await fsp.readFile(tmpFile, 'utf8');
          writable = (data === 'mstream-access-test');
        } catch (e) {
          if (!errorMsg) errorMsg = e.code || e.message;
        } finally {
          try { await fsp.unlink(tmpFile); } catch (_) { /* already gone */ }
        }
      }

      results.push({ vpath, root, storageType, readable, writable, error: errorMsg });
    }

    res.json({ platform, isElectron, results });
  });

  mstream.get("/api/v1/admin/db/params", (req, res) => {
    res.json({ ...config.program.scanOptions, engine: config.program.db.engine });
  });

  mstream.post("/api/v1/admin/db/engine", async (req, res) => {
    const schema = Joi.object({
      engine: Joi.string().valid('loki', 'sqlite').required()
    });
    joiValidate(schema, req.body);
    await admin.editDbEngine(req.body.engine);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/scan-interval", async (req, res) => {
    const schema = Joi.object({
      scanInterval: Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editScanInterval(req.body.scanInterval);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/save-interval", async (req, res) => {
    const schema = Joi.object({
      saveInterval: Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editSaveInterval(req.body.saveInterval);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/skip-img", async (req, res) => {
    const schema = Joi.object({
      skipImg: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editSkipImg(req.body.skipImg);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/pause", async (req, res) => {
    const schema = Joi.object({
      pause:  Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editPause(req.body.pause);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/boot-scan-delay", async (req, res) => {
    const schema = Joi.object({
      bootScanDelay:  Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editBootScanDelay(req.body.bootScanDelay);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/max-concurrent-scans", async (req, res) => {
    const schema = Joi.object({
      maxConcurrentTasks:  Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editMaxConcurrentTasks(req.body.maxConcurrentTasks);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/compress-image", async (req, res) => {
    const schema = Joi.object({
      compressImage:  Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editCompressImages(req.body.compressImage);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/allow-id3edit", async (req, res) => {
    const schema = Joi.object({ allowId3Edit: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editAllowId3Edit(req.body.allowId3Edit);
    res.json({});
  });

  mstream.get("/api/v1/admin/users", (req, res) => {
    // Scrub passwords and salts before sending to frontend
    const memClone = JSON.parse(JSON.stringify(config.program.users));
    Object.keys(memClone).forEach(username => {
      delete memClone[username].password;
      delete memClone[username].salt;
    });

    res.json(memClone);
  });

  mstream.put("/api/v1/admin/directory", async (req, res) => {
    const schema = Joi.object({
      directory: Joi.string().required(),
      vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required(),
      autoAccess: Joi.boolean().default(false),
      isAudioBooks: Joi.boolean().default(false)
    });
    const input = joiValidate(schema, req.body);

    await admin.addDirectory(
      input.value.directory,
      input.value.vpath,
      input.value.autoAccess,
      input.value.isAudioBooks,
      mstream);
    res.json({});

    try {
      // Only scan this vpath if it is NOT a child of another configured vpath.
      // Child folders (e.g. /media/music/Disco inside /media/music) are already
      // covered by their parent vpath scan — scanning them separately creates duplicates.
      const isChild = Object.keys(config.program.folders).some(
        other => other !== input.value.vpath && dbQueue.isChildOf(other, input.value.vpath)
      );
      if (!isChild) {
        dbQueue.scanVPath(input.value.vpath);
      }
    }catch (err) {
      winston.error('/api/v1/admin/directory failed to add ', { stack: err });
    }
  });

  mstream.delete("/api/v1/admin/directory", async (req, res) => {
    const schema = Joi.object({
      vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required()
    });
    joiValidate(schema, req.body);

    await admin.removeDirectory(req.body.vpath);
    res.json({});
  });

  mstream.put("/api/v1/admin/users", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required(),
      vpaths: Joi.array().items(Joi.string()).required(),
      admin: Joi.boolean().optional().default(false)
    });
    const input = joiValidate(schema, req.body);

    await admin.addUser(
      input.value.username,
      input.value.password,
      input.value.admin,
      input.value.vpaths
    );
    res.json({});
  });

  mstream.post("/api/v1/admin/db/force-compress-images", (req, res) => {
    res.json({ started: imageCompress.run() });
  });

  mstream.post("/api/v1/admin/db/scan/all", (req, res) => {
    dbQueue.scanAll();
    res.json({});
  });

  mstream.post("/api/v1/admin/db/scan/stop", (req, res) => {
    dbQueue.stopScanning();
    res.json({});
  });

  mstream.get("/api/v1/admin/db/scan/stats", (req, res) => {
    const stats = db.getStats();
    // Count cached waveform files (filesystem — not tracked in DB)
    try {
      const wfDir = config.program.storage?.waveformDirectory;
      stats.waveformCount = wfDir
        ? fs.readdirSync(wfDir).filter(f => f.startsWith('wf-') && f.endsWith('.json')).length
        : 0;
    } catch (_) { stats.waveformCount = 0; }
    res.json(stats);
  });

  mstream.get('/api/v1/admin/db/scan/progress', (req, res) => {
    res.json(scanProgress.getAll());
  });

  // ── Scan Error Audit ──────────────────────────────────────────────────────────
  mstream.get('/api/v1/admin/db/scan-errors', (req, res) => {
    res.json(db.getScanErrors());
  });

  mstream.delete('/api/v1/admin/db/scan-errors', (req, res) => {
    db.clearScanErrors();
    res.json({});
  });

  mstream.get('/api/v1/admin/db/scan-errors/count', (req, res) => {
    res.json({ count: db.getScanErrorCount() });
  });

  // ── Auto-fix a single scan error ─────────────────────────────────────────
  // For art errors: strips embedded images from the file using ffmpeg so that
  // music-metadata can parse the file cleanly on the next scan.
  // Returns an error if the file cannot be found or if ffmpeg fails — no
  // silent DB suppression fallback.
  mstream.post('/api/v1/admin/db/scan-errors/fix', async (req, res) => {
    try {
      const schema = Joi.object({ guid: Joi.string().required() });
      joiValidate(schema, req.body);
      const { guid } = req.body;

      const errors = db.getScanErrors();
      const err = errors.find(e => e.guid === guid);
      if (!err) return res.status(404).json({ error: 'Error not found' });

      if (err.error_type === 'art') {
        // Reconstruct the absolute path: filepath stored in DB is relative to
        // the vpath root directory (see scanner.mjs reportError)
        const vpathFolder = config.program.folders[err.vpath];
        if (!vpathFolder) return res.status(400).json({ error: `Unknown vpath: ${err.vpath}` });
        const absPath = path.join(vpathFolder.root, err.filepath);

        if (!fs.existsSync(absPath)) {
          return res.status(400).json({ error: `File not found on disk: ${absPath}` });
        }

        const result = await stripEmbeddedImages(absPath);
        if (!result.ok) {
          return res.status(500).json({ error: result.reason });
        }

        db.markScanErrorFixed(guid);
        return res.json({ ok: true, action: 'art_fixed' });

      } else if (err.error_type === 'cue') {
        // Cue data comes from text sidecar files or text tags—nothing to strip
        // from the audio binary. Just mark fixed so the error clears.
        db.markScanErrorFixed(guid);
        return res.json({ ok: true, action: 'cue_dismissed' });

      } else {
        // parse / insert / other — no file action possible
        db.markScanErrorFixed(guid);
        return res.json({ ok: true, action: 'dismissed' });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  mstream.post('/api/v1/admin/db/params/scan-error-retention', async (req, res) => {
    const schema = Joi.object({
      hours: Joi.number().integer().valid(12, 24, 48, 72, 168, 336, 720).required()
    });
    joiValidate(schema, req.body);
    await admin.editScanErrorRetention(req.body.hours);
    res.json({});
  });
  // ─────────────────────────────────────────────────────────────────────────────

  mstream.delete("/api/v1/admin/users", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.deleteUser(req.body.username);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/password", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.editUserPassword(req.body.username, req.body.password);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/lastfm", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      lastfmUser: Joi.string().required(),
      lastfmPassword: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.setUserLastFM(req.body.username, req.body.lastfmUser, req.body.lastfmPassword);
    res.json({});
  });

  // Update global Last.fm API key + shared secret (admin only)
  mstream.get("/api/v1/admin/lastfm/config", (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({
      enabled:   config.program.lastFM?.enabled   !== false,
      apiKey:    config.program.lastFM?.apiKey    || '',
      apiSecret: config.program.lastFM?.apiSecret || '',
    });
  });

  mstream.post("/api/v1/admin/lastfm/config", async (req, res) => {
    const schema = Joi.object({
      enabled:   Joi.boolean().required(),
      apiKey:    Joi.string().allow('').required(),
      apiSecret: Joi.string().allow('').required(),
    });
    joiValidate(schema, req.body);

    const loadConfig = await admin.loadFile(config.configFile);
    if (!loadConfig.lastFM) loadConfig.lastFM = {};
    loadConfig.lastFM.enabled   = req.body.enabled;
    loadConfig.lastFM.apiKey    = req.body.apiKey;
    loadConfig.lastFM.apiSecret = req.body.apiSecret;
    await admin.saveFile(loadConfig, config.configFile);

    config.program.lastFM.enabled   = req.body.enabled;
    config.program.lastFM.apiKey    = req.body.apiKey;
    config.program.lastFM.apiSecret = req.body.apiSecret;
    scrobblerApi.updateApiKeys(req.body.apiKey, req.body.apiSecret);

    res.json({});
  });

  mstream.post("/api/v1/admin/users/vpaths", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      vpaths: Joi.array().items(Joi.string()).required()
    });
    joiValidate(schema, req.body);

    await admin.editUserVPaths(req.body.username, req.body.vpaths);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/access", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      admin: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editUserAccess(req.body.username, req.body.admin);
    res.json({});
  });

  mstream.get("/api/v1/admin/config", (req, res) => {
    res.json({
      address: config.program.address,
      port: config.program.port,
      noUpload: config.program.noUpload,
      writeLogs: config.program.writeLogs,
      secret: config.program.secret.slice(-4),
      ssl: config.program.ssl,
      storage: config.program.storage,
      maxRequestSize: config.program.maxRequestSize,
      federation: config.program.federation
    });
  });

  mstream.post("/api/v1/admin/config/max-request-size", async (req, res) => {
    const schema = Joi.object({
      maxRequestSize: Joi.string().pattern(/[0-9]+(KB|MB)/i).required()
    });
    joiValidate(schema, req.body);

    await admin.editMaxRequestSize(req.body.maxRequestSize);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/port", async (req, res) => {
    const schema = Joi.object({
      port: Joi.number().required()
    });
    joiValidate(schema, req.body);

    await admin.editPort(req.body.port);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/address", async (req, res) => {
    const schema = Joi.object({
      address: Joi.string().ip({ cidr: 'forbidden' }).required(),
    });
    joiValidate(schema, req.body);

    await admin.editAddress(req.body.address);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/noupload", async (req, res) => {
    const schema = Joi.object({
      noUpload: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editUpload(req.body.noUpload);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/write-logs", async (req, res) => {
    const schema = Joi.object({
      writeLogs: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editWriteLogs(req.body.writeLogs);
    res.json({});
  });

  mstream.post("/api/v1/admin/config/secret", async (req, res) => {
    const schema = Joi.object({
      strength: Joi.number().integer().positive().required()
    });
    joiValidate(schema, req.body);

    const secret = await config.asyncRandom(req.body.strength);
    await admin.editSecret(secret);
    res.json({});
  });

  mstream.get("/api/v1/admin/transcode", (req, res) => {
    const memClone = JSON.parse(JSON.stringify(config.program.transcode));
    memClone.downloaded = transcode.isDownloaded();
    res.json(memClone);
  });

  mstream.post("/api/v1/admin/transcode/enable", async (req, res) => {
    const schema = Joi.object({
      enable: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.enableTranscode(req.body.enable);
    res.json({});
  });

  mstream.post("/api/v1/admin/transcode/default-codec", async (req, res) => {
    const schema = Joi.object({
      defaultCodec: Joi.string().valid(...getTransCodecs()).required()
    });
    joiValidate(schema, req.body);

    await admin.editDefaultCodec(req.body.defaultCodec);
    res.json({});
  });

  mstream.post("/api/v1/admin/transcode/default-bitrate", async (req, res) => {
    const schema = Joi.object({
      defaultBitrate: Joi.string().valid(...getTransBitrates()).required()
    });
    joiValidate(schema, req.body);

    await admin.editDefaultBitrate(req.body.defaultBitrate);
    res.json({});
  });

  mstream.post("/api/v1/admin/transcode/default-algorithm", async (req, res) => {
    const schema = Joi.object({
      algorithm: Joi.string().valid(...getTransAlgos()).required()
    });
    joiValidate(schema, req.body);

    await admin.editDefaultAlgorithm(req.body.algorithm);
    res.json({});
  });

  mstream.post("/api/v1/admin/transcode/download", async (req, res) => {
    await transcode.downloadedFFmpeg();
    res.json({});
  });

  mstream.get("/api/v1/admin/logs/download", (req, res) => {
    const archive = archiver('zip');
    archive.on('error', err => {
      winston.error('Download Error', { stack: err });
      res.status(500).json({ error: err.message });
    });

    res.attachment(`mstream-logs.zip`);

    //streaming magic
    archive.pipe(res);
    archive.directory(config.program.storage.logsDirectory, false)
    archive.finalize();
  });

  mstream.get("/api/v1/admin/db/shared", (req, res) => {
    res.json(db.getAllSharedPlaylists());
  });

  mstream.delete("/api/v1/admin/db/shared", (req, res) => {
    const schema = Joi.object({ id: Joi.string().required() });
    joiValidate(schema, req.body);

    db.removeSharedPlaylistById(req.body.id);
    db.saveShareDB();
    res.json({});
  });

  mstream.delete("/api/v1/admin/db/shared/expired", (req, res) => {
    db.removeExpiredSharedPlaylists();
    db.saveShareDB();
    res.json({});
  });

  mstream.delete("/api/v1/admin/db/shared/eternal", (req, res) => {
    db.removeEternalSharedPlaylists();
    db.saveShareDB();
    res.json({});
  });

  let enableFederationDebouncer = false;
  mstream.post('/api/v1/admin/federation/enable', async (req, res) => {
    const schema = Joi.object({ enable: Joi.boolean().required() });
    joiValidate(schema, req.body);

    if (enableFederationDebouncer === true) { throw new Error('Debouncer Enabled'); }
    await admin.enableFederation(req.body.enable);

    enableFederationDebouncer = true;
    setTimeout(() => {
      enableFederationDebouncer = false;
    }, 5000);

    res.json({});
  });

  mstream.delete("/api/v1/admin/ssl", async (req, res) => {
    if (!config.program.ssl.cert) { throw new Error('No Certs'); }
    await admin.removeSSL();
    res.json({});
  });

  mstream.post("/api/v1/admin/ssl", async (req, res) => {
    const schema = Joi.object({
      cert: Joi.string().required(),
      key: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.setSSL(path.resolve(req.body.cert), path.resolve(req.body.key));
    res.json({});
  });

  // ── Discogs config ───────────────────────────────────────────
  mstream.get("/api/v1/admin/discogs/config", (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({
      enabled:        config.program.discogs?.enabled        || false,
      allowArtUpdate: config.program.discogs?.allowArtUpdate || false,
      allowId3Edit:   config.program.scanOptions?.allowId3Edit || false,
      apiKey:         config.program.discogs?.apiKey         || '',
      apiSecret:      config.program.discogs?.apiSecret      || '',
      userAgentTag:   config.program.discogs?.userAgentTag   || '',
    });
  });

  mstream.post("/api/v1/admin/discogs/config", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      enabled:        Joi.boolean().required(),
      allowArtUpdate: Joi.boolean().required(),
      apiKey:         Joi.string().allow('').required(),
      apiSecret:      Joi.string().allow('').required(),
      userAgentTag:   Joi.string().allow('').pattern(/^[a-zA-Z0-9]{0,4}$/).required(),
    });
    joiValidate(schema, req.body);

    const loadConfig = await admin.loadFile(config.configFile);
    if (!loadConfig.discogs) loadConfig.discogs = {};
    loadConfig.discogs.enabled        = req.body.enabled;
    loadConfig.discogs.allowArtUpdate = req.body.allowArtUpdate;
    loadConfig.discogs.apiKey         = req.body.apiKey;
    loadConfig.discogs.apiSecret      = req.body.apiSecret;
    loadConfig.discogs.userAgentTag   = req.body.userAgentTag;
    await admin.saveFile(loadConfig, config.configFile);

    config.program.discogs.enabled        = req.body.enabled;
    config.program.discogs.allowArtUpdate = req.body.allowArtUpdate;
    config.program.discogs.apiKey         = req.body.apiKey;
    config.program.discogs.apiSecret      = req.body.apiSecret;
    config.program.discogs.userAgentTag   = req.body.userAgentTag;

    res.json({});
  });

  // ── ID3 tag write ────────────────────────────────────────────
  const execFileAsync = promisify(child.execFile);
  mstream.post('/api/v1/admin/tags/write', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    if (!config.program.scanOptions?.allowId3Edit) return res.status(403).json({ error: 'ID3 editing not enabled in admin settings' });

    const schema = Joi.object({
      filepath: Joi.string().required(),
      title:    Joi.string().allow('').optional(),
      artist:   Joi.string().allow('').optional(),
      album:    Joi.string().allow('').optional(),
      year:     Joi.alternatives().try(Joi.string().allow(''), Joi.number()).optional(),
      genre:    Joi.string().allow('').optional(),
      track:    Joi.alternatives().try(Joi.string().allow(''), Joi.number()).optional(),
      disk:     Joi.alternatives().try(Joi.string().allow(''), Joi.number()).optional(),
    });
    joiValidate(schema, req.body);

    let pathInfo;
    try { pathInfo = getVPathInfo(req.body.filepath, req.user); } catch (e) { return res.status(400).json({ error: e.message }); }
    const absPath = pathInfo.fullPath;
    if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'File not found' });

    const ext       = path.extname(absPath).toLowerCase();
    const ffmpegDir = config.program.transcode?.ffmpegDirectory;
    const ffmpegBin = ffmpegDir ? path.join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg';
    // Write to same directory so fs.renameSync is atomic (avoids cross-device EXDEV errors).
    const tmpOut    = path.join(path.dirname(absPath), `.mstream-tags-tmp-${Date.now()}${ext}`);

    const metaArgs = [];
    // ffmpeg uses 'date' for year and 'disc' for disk number
    if (req.body.title  !== undefined) metaArgs.push('-metadata', `title=${req.body.title}`);
    if (req.body.artist !== undefined) metaArgs.push('-metadata', `artist=${req.body.artist}`);
    if (req.body.album  !== undefined) metaArgs.push('-metadata', `album=${req.body.album}`);
    if (req.body.year   !== undefined) metaArgs.push('-metadata', `date=${req.body.year}`);
    if (req.body.genre  !== undefined) metaArgs.push('-metadata', `genre=${req.body.genre}`);
    if (req.body.track  !== undefined) metaArgs.push('-metadata', `track=${req.body.track}`);
    if (req.body.disk   !== undefined) metaArgs.push('-metadata', `disc=${req.body.disk}`);

    // Temp path for extracted art (OS temp dir — never visible in music dirs)
    const tmpArt = path.join(os.tmpdir(), `.mstream-art-${Date.now()}.jpg`);
    // Second temp output used only when re-embedding art after tag write
    const tmpOut2 = path.join(path.dirname(absPath), `.mstream-tags-art-${Date.now()}${ext}`);

    try {
      // ── Step 1: extract any embedded picture stream ──────────────────────
      // We never stream-copy the picture stream directly because ffmpeg sets
      // avg_frame_rate=0/0 on the copy, which makes Chrome's demuxer emit
      // "PTS is not defined" and refuse to play the file.  Instead we extract
      // the raw image, write tags audio-only, then re-embed it fresh so ffmpeg
      // generates correct disposition and timing metadata.
      let hasArt = false;
      try {
        await execFileAsync(ffmpegBin, [
          '-y', '-i', absPath,
          '-map', '0:v:0', '-frames:v', '1', '-f', 'image2', tmpArt,
        ]);
        hasArt = fs.existsSync(tmpArt) && fs.statSync(tmpArt).size > 100;
      } catch (_) { /* no picture stream — that's fine */ }

      // ── Step 2: write tags, audio stream only ─────────────────────────────
      await execFileAsync(ffmpegBin, [
        '-y', '-fflags', '+genpts', '-i', absPath,
        '-map', '0:a', '-map_metadata', '0', '-codec', 'copy',
        ...metaArgs,
        tmpOut,
      ]);

      if (hasArt) {
        // ── Step 3: re-embed the extracted art ─────────────────────────────
        // Use '-c:v mjpeg' (re-encode) not '-c:v copy'. Stream-copying a JPEG
        // produces an mjpeg stream with avg_frame_rate=0/0 and no PTS, which
        // causes Chrome to emit "PTS is not defined" and refuse to play.
        try {
          await execFileAsync(ffmpegBin, [
            '-y',
            '-i', tmpOut, '-i', tmpArt,
            '-map', '0:a', '-map', '1:v',
            '-c:a', 'copy',
            '-c:v', 'mjpeg',
            '-disposition:v:0', 'attached_pic',
            '-metadata:s:v', 'title=Cover (Front)',
            '-metadata:s:v', 'comment=Cover (Front)',
            tmpOut2,
          ]);
          fs.renameSync(tmpOut2, absPath);
          try { fs.unlinkSync(tmpOut); } catch (_) {}
        } catch (_) {
          // Re-embed failed (e.g. corrupt art) — still commit the tag changes
          try { fs.unlinkSync(tmpOut2); } catch (_) {}
          fs.renameSync(tmpOut, absPath);
        }
        try { fs.unlinkSync(tmpArt); } catch (_) {}
      } else {
        // No art — single atomic rename
        fs.renameSync(tmpOut, absPath);
      }

      // ── Step 4: update DB ─────────────────────────────────────────────────
      const tags = {};
      if (req.body.title  !== undefined) tags.title  = req.body.title  || null;
      if (req.body.artist !== undefined) tags.artist = req.body.artist || null;
      if (req.body.album  !== undefined) tags.album  = req.body.album  || null;
      if (req.body.year   !== undefined) tags.year   = req.body.year   ? Number(req.body.year)  || null : null;
      if (req.body.genre  !== undefined) tags.genre  = req.body.genre  || null;
      if (req.body.track  !== undefined) tags.track  = req.body.track  ? Number(req.body.track) || null : null;
      if (req.body.disk   !== undefined) tags.disk   = req.body.disk   ? Number(req.body.disk)  || null : null;
      db.updateFileTags(pathInfo.relativePath, pathInfo.vpath, tags);

      res.json({ ok: true });
    } catch (e) {
      try { fs.unlinkSync(tmpOut);  } catch (_) {}
      try { fs.unlinkSync(tmpOut2); } catch (_) {}
      try { fs.unlinkSync(tmpArt);  } catch (_) {}
      res.status(500).json({ error: e.message });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// stripEmbeddedImages(absFilepath)
// Uses the bundled ffmpeg binary to copy the audio stream and all text metadata
// while discarding every video/image stream (embedded cover art, PICTURE blocks
// etc.).  This resolves UnexpectedFileContentError and InvalidCharacterError
// raised by music-metadata when it tries to parse those malformed image tags.
// The file is rewritten in-place via a temp file so the original is never
// truncated before the new file is confirmed complete.
// Caller must verify the file exists before calling this function.
// ─────────────────────────────────────────────────────────────────────────────
async function stripEmbeddedImages(absFilepath) {
  const ffmpegDir = config.program.transcode?.ffmpegDirectory;
  const binExt    = process.platform === 'win32' ? '.exe' : '';
  const ffmpegBin = ffmpegDir ? path.join(ffmpegDir, `ffmpeg${binExt}`) : null;

  if (!ffmpegBin || !fs.existsSync(ffmpegBin)) {
    return { ok: false, reason: 'ffmpeg binary not found' };
  }

  const dir  = path.dirname(absFilepath);
  const base = path.basename(absFilepath, path.extname(absFilepath));
  const ext  = path.extname(absFilepath);
  const tmp  = path.join(dir, `.__mstream_fix_${base}${ext}`);

  // For WAV files: suppress ID3 tag output — the malformed id3 chunk in the
  // RIFF container (which caused UnexpectedFileContentError) must not be
  // re-written by ffmpeg into the output file.
  const isWav = ext.toLowerCase() === '.wav';

  try {
    await new Promise((resolve, reject) => {
      // -map 0:a        : keep only audio streams — drops all image/video streams
      // -c:a copy       : stream-copy (no re-encode, lossless)
      // -map_metadata 0 : preserve all text tags (title, artist, album, etc.)
      // -write_id3v2 0  : (WAV only) do NOT write an ID3v2 block into the output
      const args = ['-y', '-i', absFilepath, '-map', '0:a', '-c:a', 'copy', '-map_metadata', '0'];
      if (isWav) args.push('-write_id3v2', '0');
      args.push(tmp);

      const proc = child.spawn(ffmpegBin, args);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
      });
      proc.on('error', reject);
    });

    fs.renameSync(tmp, absFilepath);
    return { ok: true };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, reason: e.message };
  }
}
