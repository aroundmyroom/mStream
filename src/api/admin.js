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
import { invalidateCache as invalidateAlbumsCache } from './albums-browse.js';
import { invalidateArtistCache } from './artists-browse.js';
import * as scrobblerApi from './scrobbler.js';
import { mergeGenreRows } from '../util/genre-merge.js';
import * as serverPlaybackApi from './server-playback.js';

let _artistRebuildState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  lastError: null,
};

function _errMsg(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  try { return JSON.stringify(err); } catch (_e) { return 'Unknown error'; }
}

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
    res.json({ ...config.program.scanOptions });
  });

  mstream.post("/api/v1/admin/db/params/scan-interval", async (req, res) => {
    const schema = Joi.object({
      scanInterval: Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editScanInterval(req.body.scanInterval);
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

  mstream.post("/api/v1/admin/db/params/boot-scan-delay", async (req, res) => {
    const schema = Joi.object({
      bootScanDelay:  Joi.number().integer().min(0).required()
    });
    joiValidate(schema, req.body);

    await admin.editBootScanDelay(req.body.bootScanDelay);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/boot-scan-enabled", async (req, res) => {
    const schema = Joi.object({
      bootScanEnabled: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    await admin.editBootScanEnabled(req.body.bootScanEnabled);
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

  mstream.post("/api/v1/admin/db/params/max-recording-minutes", async (req, res) => {
    const schema = Joi.object({ maxRecordingMinutes: Joi.number().integer().min(1).required() });
    joiValidate(schema, req.body);
    await admin.editMaxRecordingMinutes(req.body.maxRecordingMinutes);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/max-zip-mb", async (req, res) => {
    const schema = Joi.object({ maxZipMb: Joi.number().integer().min(1).required() });
    joiValidate(schema, req.body);
    await admin.editMaxZipMb(req.body.maxZipMb);
    res.json({});
  });

  mstream.post("/api/v1/admin/db/params/album-version-tags", async (req, res) => {
    const schema = Joi.object({
      tags: Joi.array()
        .items(Joi.string().max(60).pattern(/^[\w:.\-\s]+$/))
        .max(20)
        .required()
    });
    const input = joiValidate(schema, req.body);
    await admin.editAlbumVersionTags(input.tags);
    res.json({});
  });

  mstream.get("/api/v1/admin/db/album-version-inventory", (req, res) => {
    const rows = db.getAlbumVersionInventory();
    res.json(rows);
  });

  mstream.get("/api/v1/admin/users", (req, res) => {
    // Scrub passwords and salts before sending to frontend
    const memClone = JSON.parse(JSON.stringify(config.program.users));
    Object.keys(memClone).forEach(username => {
      delete memClone[username].password;
      delete memClone[username].salt;
      delete memClone[username]['subsonic-password'];
    });

    res.json(memClone);
  });

  mstream.put("/api/v1/admin/directory", async (req, res) => {
    const schema = Joi.object({
      directory: Joi.string().required(),
      vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required(),
      autoAccess: Joi.boolean().default(false),
      isAudioBooks: Joi.boolean().default(false),
      isRecording: Joi.boolean().default(false),
      isYoutube: Joi.boolean().default(false),
      allowRecordDelete: Joi.boolean().default(false),
      isExcluded: Joi.boolean().default(false),
      artistsOn: Joi.boolean().default(true),
    });
    const input = joiValidate(schema, req.body);

    await admin.addDirectory(
      input.value.directory,
      input.value.vpath,
      input.value.autoAccess,
      input.value.isAudioBooks,
      mstream,
      input.value.isRecording,
      input.value.allowRecordDelete,
      input.value.isYoutube,
      input.value.isExcluded,
      input.value.artistsOn);
    res.json({});

    try {
      // Skip scan for recordings/youtube/excluded folders — must not be indexed in the music library.
      const folderType = config.program.folders[input.value.vpath]?.type || 'music';
      if (folderType !== 'recordings' && folderType !== 'youtube' && folderType !== 'excluded') {
        const isChild = Object.keys(config.program.folders).some(
          other => other !== input.value.vpath && dbQueue.isChildOf(other, input.value.vpath)
        );
        if (!isChild) {
          dbQueue.scanVPath(input.value.vpath);
        }
      }
    }catch (err) {
      winston.error('/api/v1/admin/directory failed to add ', { stack: err });
    }
  });

  // PATCH /api/v1/admin/directory/flags — update per-folder flags on an existing folder
  // Supports: allowRecordDelete (recordings/youtube folders), albumsOnly (music/audio-books only), artistsOn (all non-excluded folders)
  mstream.patch("/api/v1/admin/directory/flags", async (req, res) => {
    const schema = Joi.object({
      vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required(),
      allowRecordDelete: Joi.boolean().optional(),
      albumsOnly: Joi.boolean().optional(),
      artistsOn: Joi.boolean().optional(),
    }).or('allowRecordDelete', 'albumsOnly', 'artistsOn');
    const input = joiValidate(schema, req.body);
    const { vpath, allowRecordDelete, albumsOnly, artistsOn } = input.value;
    const folder = config.program.folders[vpath];
    if (!folder) return res.status(404).json({ error: 'vpath not found' });

    if (allowRecordDelete !== undefined) {
      const isRecordingType = folder.type === 'recordings' || folder.type === 'youtube';
      if (!isRecordingType) return res.status(400).json({ error: 'only recordings/youtube folders support allowRecordDelete' });
      if (allowRecordDelete) config.program.folders[vpath].allowRecordDelete = true;
      else delete config.program.folders[vpath].allowRecordDelete;
    }

    if (albumsOnly !== undefined) {
      const isRecordingType = folder.type === 'recordings' || folder.type === 'youtube';
      if (isRecordingType) return res.status(400).json({ error: 'recordings/youtube folders are not included in the albums view' });
      if (albumsOnly) config.program.folders[vpath].albumsOnly = true;
      else delete config.program.folders[vpath].albumsOnly;
    }

    if (artistsOn !== undefined) {
      if (folder.type === 'excluded') return res.status(400).json({ error: 'excluded folders are never included in artist features' });
      if (artistsOn) config.program.folders[vpath].artistsOn = true;
      else config.program.folders[vpath].artistsOn = false;
    }

    // Persist to config file
    const loadConfig = await admin.loadFile(config.configFile);
    if (!loadConfig.folders) loadConfig.folders = {};
    if (!loadConfig.folders[vpath]) loadConfig.folders[vpath] = {};

    if (allowRecordDelete !== undefined) {
      if (allowRecordDelete) loadConfig.folders[vpath].allowRecordDelete = true;
      else delete loadConfig.folders[vpath].allowRecordDelete;
    }
    if (albumsOnly !== undefined) {
      if (albumsOnly) loadConfig.folders[vpath].albumsOnly = true;
      else delete loadConfig.folders[vpath].albumsOnly;
    }
    if (artistsOn !== undefined) {
      loadConfig.folders[vpath].artistsOn = artistsOn ? true : false;
    }

    await admin.saveFile(loadConfig, config.configFile);
    if (albumsOnly !== undefined) invalidateAlbumsCache();
    res.json({});
    if (artistsOn !== undefined) {
      // Pass invalidateArtistCache as onComplete so the cache is cleared
      // only after the worker finishes writing the new index.
      db.rebuildArtistIndex(invalidateArtistCache);
    }
  });

  // PATCH /api/v1/admin/directory/type — change the type of an existing folder
  mstream.patch("/api/v1/admin/directory/type", async (req, res) => {
    const schema = Joi.object({
      vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required(),
      type: Joi.string().valid('music', 'audio-books', 'recordings', 'youtube', 'excluded').required(),
    });
    const input = joiValidate(schema, req.body);
    const { vpath, type } = input.value;
    const folder = config.program.folders[vpath];
    if (!folder) return res.status(404).json({ error: 'vpath not found' });

    config.program.folders[vpath].type = type;
    // Clear flags that are incompatible with the new type
    if (type !== 'recordings' && type !== 'youtube') delete config.program.folders[vpath].allowRecordDelete;
    if (type === 'recordings' || type === 'youtube' || type === 'excluded') delete config.program.folders[vpath].albumsOnly;

    const loadConfig = await admin.loadFile(config.configFile);
    if (!loadConfig.folders?.[vpath]) return res.status(404).json({ error: 'vpath not in config' });
    loadConfig.folders[vpath].type = type;
    if (type !== 'recordings' && type !== 'youtube') delete loadConfig.folders[vpath].allowRecordDelete;
    if (type === 'recordings' || type === 'youtube' || type === 'excluded') delete loadConfig.folders[vpath].albumsOnly;
    await admin.saveFile(loadConfig, config.configFile);
    // When a folder is marked as excluded, trigger a scan of its parent ROOT
    // so that any already-indexed files under it get purged from the DB.
    if (type === 'excluded') {
      try {
        const thisRoot = config.program.folders[vpath]?.root;
        if (thisRoot) {
          const parentVpath = Object.keys(config.program.folders).find(other => {
            if (other === vpath) return false;
            const otherRoot = config.program.folders[other].root.replace(/\/?$/, '/');
            return thisRoot.replace(/\/?$/, '/').startsWith(otherRoot);
          });
          if (parentVpath) dbQueue.scanVPath(parentVpath);
        }
      } catch (_e) { /* non-critical */ }
    }
    res.json({});
  });

  // PATCH /api/v1/admin/directory/root — change filesystem path of an existing folder
  mstream.patch("/api/v1/admin/directory/root", async (req, res) => {
    const schema = Joi.object({
      vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required(),
      root: Joi.string().required(),
    });
    const input = joiValidate(schema, req.body);
    const { vpath, root } = input.value;
    if (!config.program.folders[vpath]) return res.status(404).json({ error: 'vpath not found' });

    const stat = await fs.promises.stat(root).catch(() => null);
    if (!stat?.isDirectory()) return res.status(400).json({ error: `${root} is not a valid directory` });

    config.program.folders[vpath].root = root;
    const loadConfig = await admin.loadFile(config.configFile);
    if (loadConfig.folders?.[vpath]) loadConfig.folders[vpath].root = root;
    await admin.saveFile(loadConfig, config.configFile);
    res.json({ restartRequired: true });
  });

  // PATCH /api/v1/admin/directory/users — set which users have access to a folder
  mstream.patch("/api/v1/admin/directory/users", async (req, res) => {
    const schema = Joi.object({
      vpath: Joi.string().pattern(/[a-zA-Z0-9-]+/).required(),
      users: Joi.array().items(Joi.string()).required(),
    });
    const input = joiValidate(schema, req.body);
    const { vpath, users: newUsers } = input.value;
    if (!config.program.folders[vpath]) return res.status(404).json({ error: 'vpath not found' });

    // Update each user's vpaths list
    const loadConfig = await admin.loadFile(config.configFile);
    Object.entries(config.program.users).forEach(([uname, u]) => {
      const shouldHave = newUsers.includes(uname);
      const has = (u.vpaths || []).includes(vpath);
      if (shouldHave && !has) {
        u.vpaths.push(vpath);
        if (loadConfig.users?.[uname]) loadConfig.users[uname].vpaths = u.vpaths;
      } else if (!shouldHave && has) {
        u.vpaths.splice(u.vpaths.indexOf(vpath), 1);
        if (loadConfig.users?.[uname]) loadConfig.users[uname].vpaths = u.vpaths;
      }
    });
    await admin.saveFile(loadConfig, config.configFile);
    res.json({});
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
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
    res.json(db.getScanErrors(limit));
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

      const err = db.getScanErrorByGuid(guid);
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

        db.markScanErrorFixed(guid, 'art_fixed');
        return res.json({ ok: true, action: 'art_fixed' });

      } else if (err.error_type === 'cue') {
        // Cue data comes from text sidecar files or text tags—nothing to strip
        // from the audio binary. Just mark fixed so the error clears.
        db.markScanErrorFixed(guid, 'cue_dismissed');
        return res.json({ ok: true, action: 'cue_dismissed' });

      } else if (err.error_type === 'parse' || err.error_type === 'duration') {
        // Corrupt tag block (e.g. APEv2 RangeError, unreadable FLAC/WAV header).
        // Re-mux the file with ffmpeg — strips APEv2 on MP3, rebuilds the clean
        // container on FLAC/WAV/OGG/etc.  The in-place rewrite changes the file's
        // mtime, so the next library scan automatically re-processes it.
        const vpathFolder2 = config.program.folders[err.vpath];
        if (!vpathFolder2) return res.status(400).json({ error: `Unknown vpath: ${err.vpath}` });
        const absPath2 = path.join(vpathFolder2.root, err.filepath);

        if (!fs.existsSync(absPath2)) {
          return res.status(400).json({ error: `File not found on disk: ${absPath2}` });
        }

        const ext2 = path.extname(absPath2).toLowerCase();
        const remuxable = ['.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.wma', '.ape'];
        if (!remuxable.includes(ext2)) {
          db.markScanErrorFixed(guid);
          return res.json({ ok: true, action: 'dismissed' });
        }

        // Pre-check with ffprobe: if the file has no valid audio stream at all
        // (e.g. completely zeroed-out file, truncated beyond recovery) then
        // remuxing is pointless — tell the client it is unrecoverable.
        const probeOk = await probeHasAudio(absPath2);
        if (!probeOk) {
          console.error(`[scan-error-fix] file is unrecoverable (no valid audio stream): ${absPath2}`);
          db.markScanErrorFixed(guid, 'unrecoverable');
          return res.json({ ok: true, action: 'unrecoverable' });
        }

        const result2 = await remuxAudio(absPath2);
        if (!result2.ok) {
          if (result2.unrecoverable) {
            console.error(`[scan-error-fix] file is unrecoverable (corrupt frames): ${absPath2}`);
            db.markScanErrorFixed(guid, 'unrecoverable');
            return res.json({ ok: true, action: 'unrecoverable' });
          }
          console.error(`[scan-error-fix] fix failed for ${absPath2}: ${result2.reason}`);
          return res.status(500).json({ error: result2.reason });
        }

        const action3 = result2.reencoded ? 'reencoded' : 'remuxed';
        const reencMsg = result2.reencoded
          ? 'File re-encoded (some corrupt frames discarded) — trigger a rescan to update the library.'
          : 'File rewritten — trigger a rescan to update the library.';
        db.markScanErrorFixed(guid, action3);
        return res.json({ ok: true, action: action3, note: reencMsg });

      } else {
        // insert / other — no file action possible
        db.markScanErrorFixed(guid, 'dismissed');
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

  mstream.post("/api/v1/admin/users/subsonic-password", async (req, res) => {
    const schema = Joi.object({
      username: Joi.string().required(),
      password: Joi.string().required()
    });
    joiValidate(schema, req.body);

    await admin.editSubsonicPassword(req.body.username, req.body.password);
    res.json({});
  });

  // Per-user: toggle Subsonic scrobble forwarding for Last.fm and/or ListenBrainz.
  // A normal user can only change their own settings; admins can set any user.
  mstream.post("/api/v1/admin/users/subsonic-scrobble", async (req, res) => {
    const schema = Joi.object({
      username:       Joi.string().required(),
      scrobbleLastfm: Joi.boolean().optional(),
      scrobbleLb:     Joi.boolean().optional(),
    });
    joiValidate(schema, req.body);
    const { username, scrobbleLastfm, scrobbleLb } = req.body;
    // Only admins can change other users; regular users can only change themselves
    if (req.user.admin !== true && req.user.username !== username) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const userConf = config.program.users[username];
    if (!userConf) return res.status(404).json({ error: 'User not found' });
    if (scrobbleLastfm !== undefined) userConf['subsonic-scrobble-lastfm'] = scrobbleLastfm;
    if (scrobbleLb     !== undefined) userConf['subsonic-scrobble-lb']     = scrobbleLb;
    // Persist to config file
    const raw = JSON.parse(await fs.promises.readFile(config.configFile, 'utf-8'));
    if (!raw.users) raw.users = {};
    if (!raw.users[username]) raw.users[username] = {};
    if (scrobbleLastfm !== undefined) raw.users[username]['subsonic-scrobble-lastfm'] = scrobbleLastfm;
    if (scrobbleLb     !== undefined) raw.users[username]['subsonic-scrobble-lb']     = scrobbleLb;
    await fs.promises.writeFile(config.configFile, JSON.stringify(raw, null, 2), 'utf8');
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

  // ── Discord webhook config (admin only) ─────────────────────────────────
  mstream.get("/api/v1/admin/discord-webhook/config", (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({
      enabled: config.program.discordWebhook?.enabled === true,
      url:     config.program.discordWebhook?.url    || '',
    });
  });

  mstream.post("/api/v1/admin/discord-webhook/config", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      enabled: Joi.boolean().required(),
      url:     Joi.string().uri().allow('').required(),
    });
    joiValidate(schema, req.body);

    // Security: only allow discord.com webhook URLs
    if (req.body.url) {
      let parsed;
      try { parsed = new URL(req.body.url); } catch (_) {
        return res.status(400).json({ error: 'Invalid webhook URL' });
      }
      if (parsed.hostname !== 'discord.com' && parsed.hostname !== 'discordapp.com') {
        return res.status(400).json({ error: 'Only discord.com webhook URLs are accepted' });
      }
    }

    const loadConfig = await admin.loadFile(config.configFile);
    if (!loadConfig.discordWebhook) loadConfig.discordWebhook = {};
    loadConfig.discordWebhook.enabled = req.body.enabled;
    loadConfig.discordWebhook.url     = req.body.url;
    await admin.saveFile(loadConfig, config.configFile);

    config.program.discordWebhook.enabled = req.body.enabled;
    config.program.discordWebhook.url     = req.body.url;

    res.json({});
  });

  // ── Custom webhooks config (admin only) ─────────────────────────────────
  mstream.get("/api/v1/admin/custom-webhooks/config", (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const raw = Array.isArray(config.program.customWebhooks) ? config.program.customWebhooks : [];
    const slots = Array.from({ length: 2 }, (_, i) => ({
      name:    String(raw[i]?.name    || '').slice(0, 64),
      url:     String(raw[i]?.url     || ''),
      enabled: raw[i]?.enabled === true,
    }));
    res.json({ webhooks: slots });
  });

  mstream.post("/api/v1/admin/custom-webhooks/config", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const slotSchema = Joi.object({
      name:    Joi.string().allow('').max(64).required(),
      url:     Joi.string().uri({ scheme: ['http', 'https'] }).allow('').required(),
      enabled: Joi.boolean().required(),
    });
    const schema = Joi.object({ webhooks: Joi.array().items(slotSchema).max(2).required() });
    joiValidate(schema, req.body);

    const loadConfig = await admin.loadFile(config.configFile);
    loadConfig.customWebhooks = req.body.webhooks;
    await admin.saveFile(loadConfig, config.configFile);
    config.program.customWebhooks = req.body.webhooks;

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

  mstream.post("/api/v1/admin/users/allow-radio-recording", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      username: Joi.string().required(),
      allow: Joi.boolean().required()
    });
    joiValidate(schema, req.body);
    await admin.editAllowRadioRecording(req.body.username, req.body.allow);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/allow-youtube-download", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      username: Joi.string().required(),
      allow: Joi.boolean().required()
    });
    joiValidate(schema, req.body);
    await admin.editAllowYoutubeDownload(req.body.username, req.body.allow);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/allow-upload", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      username: Joi.string().required(),
      allow: Joi.boolean().required()
    });
    joiValidate(schema, req.body);
    await admin.editAllowUpload(req.body.username, req.body.allow);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/allow-server-remote", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({ username: Joi.string().required(), allow: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editAllowServerRemote(req.body.username, req.body.allow);
    res.json({});
  });

  mstream.post("/api/v1/admin/users/allow-mpv-cast", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({ username: Joi.string().required(), allow: Joi.boolean().required() });
    joiValidate(schema, req.body);
    await admin.editAllowMpvCast(req.body.username, req.body.allow);
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
      federation: config.program.federation,
      ui: config.program.ui || 'velvet'
    });
  });

  mstream.post("/api/v1/admin/config/theme", async (req, res) => {
    const schema = Joi.object({ ui: Joi.string().valid('velvet', 'velvet-dark', 'velvet-light').required() });
    joiValidate(schema, req.body);
    await admin.editUi(req.body.ui);
    res.json({});
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
      enabled:        config.program.discogs?.enabled !== false,
      allowArtUpdate: config.program.discogs?.allowArtUpdate || false,
      allowId3Edit:   config.program.scanOptions?.allowId3Edit || false,
      apiKey:         config.program.discogs?.apiKey         || '',
      apiSecret:      config.program.discogs?.apiSecret      || '',
      userAgentTag:   config.program.discogs?.userAgentTag   || '',
      itunesEnabled:  config.program.discogs?.itunesEnabled  !== false,
      deezerEnabled:  config.program.discogs?.deezerEnabled  !== false,
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
      itunesEnabled:  Joi.boolean().required(),
      deezerEnabled:  Joi.boolean().required(),
    });
    joiValidate(schema, req.body);

    const loadConfig = await admin.loadFile(config.configFile);
    if (!loadConfig.discogs) loadConfig.discogs = {};
    loadConfig.discogs.enabled        = req.body.enabled;
    loadConfig.discogs.allowArtUpdate = req.body.allowArtUpdate;
    loadConfig.discogs.apiKey         = req.body.apiKey;
    loadConfig.discogs.apiSecret      = req.body.apiSecret;
    loadConfig.discogs.userAgentTag   = req.body.userAgentTag;
    loadConfig.discogs.itunesEnabled  = req.body.itunesEnabled;
    loadConfig.discogs.deezerEnabled  = req.body.deezerEnabled;
    await admin.saveFile(loadConfig, config.configFile);

    config.program.discogs.enabled        = req.body.enabled;
    config.program.discogs.allowArtUpdate = req.body.allowArtUpdate;
    config.program.discogs.apiKey         = req.body.apiKey;
    config.program.discogs.apiSecret      = req.body.apiSecret;
    config.program.discogs.userAgentTag   = req.body.userAgentTag;
    config.program.discogs.itunesEnabled  = req.body.itunesEnabled;
    config.program.discogs.deezerEnabled  = req.body.deezerEnabled;

    res.json({});
  });

  // ── Lyrics config ────────────────────────────────────────────
  mstream.get("/api/v1/admin/lyrics/config", (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({
      enabled: config.program.lyrics?.enabled !== false,
    });
  });

  mstream.post("/api/v1/admin/lyrics/config", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({ enabled: Joi.boolean().required() });
    joiValidate(schema, req.body);

    const loadConfig = await admin.loadFile(config.configFile);
    if (!loadConfig.lyrics) loadConfig.lyrics = {};
    loadConfig.lyrics.enabled = req.body.enabled;
    await admin.saveFile(loadConfig, config.configFile);

    if (!config.program.lyrics) config.program.lyrics = {};
    config.program.lyrics.enabled = req.body.enabled;

    res.json({});
  });

  // ── AcoustID config ───────────────────────────────────────────
  mstream.get("/api/v1/admin/acoustid/config", (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const apiKey = config.program.acoustid?.apiKey || '';
    // Mask the key — show first 6 chars + asterisks so admin can confirm which key is set
    const maskedKey = apiKey.length > 6
      ? apiKey.slice(0, 6) + '*'.repeat(apiKey.length - 6)
      : apiKey.replace(/./g, '*');
    res.json({
      enabled: config.program.acoustid?.enabled === true,
      apiKey:  maskedKey,
      hasKey:  apiKey.length >= 4,
    });
  });

  mstream.post("/api/v1/admin/acoustid/config", async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      enabled: Joi.boolean().required(),
      // Allow empty string (clearing key) or a non-empty key string
      apiKey:  Joi.string().allow('').max(64).required(),
    });
    joiValidate(schema, req.body);

    // If apiKey is the masked value (contains asterisks) from the GET response,
    // the admin didn't change it — preserve the existing stored key instead of saving asterisks.
    const incomingKey = req.body.apiKey.trim();
    const isUnchangedMask = incomingKey.includes('*') && incomingKey.length > 0;
    const newKey = isUnchangedMask ? (config.program.acoustid?.apiKey || '') : incomingKey;

    const loadConfig = await admin.loadFile(config.configFile);
    if (!loadConfig.acoustid) loadConfig.acoustid = {};
    loadConfig.acoustid.enabled = req.body.enabled;
    loadConfig.acoustid.apiKey  = newKey;
    await admin.saveFile(loadConfig, config.configFile);

    if (!config.program.acoustid) config.program.acoustid = {};
    config.program.acoustid.enabled = req.body.enabled;
    config.program.acoustid.apiKey  = newKey;

    res.json({});
  });

  // ── Genre Groups (admin-configurable display groupings) ─────────────────
  // Mirrors GENRE_BUCKETS in webapp/app.js — used to build auto-defaults when no groups saved
  const GENRE_BUCKETS_DEFAULT = [
    ['Rock',               /\b(rock|punk|metal|grunge|emo|hardcore|alternative|indie|shoegaze|post.rock|new.wave|prog(ressive)?|glam|gothic|psychedel|garage|britpop|surf|math.rock|noise.rock|skate)\b/i],
    ['Electronic',         /\b(electro(nic)?|techno|house|trance|drum.?n?.?bass|dnb|d&b|ambient|synth|rave|edm|idm|breakbeat|dubstep|chillout|chill(?!i)|deep.house|trip.hop|downtempo|jungle|acid|minimal(?! folk|ist)|dance(?!.pop)|club|industrial|dark.wave|ebm|vaporwave|lo.?fi|hardstyle|psytrance|psybient|dub(?!step)|gabber|neurofunk|liquid drum|deathstep)\b/i],
    ['Pop',                /\b(pop(?!.punk|.rock)|disco|bubblegum|teen.pop|j.?pop|k.?pop|c.?pop|city.pop)\b/i],
    ['Hip-Hop & R&B',      /\b(hip.?hop|rap|r&b|rnb|neo.?soul|urban|grime|trap|drill|afroswing)\b/i],
    ['Soul & Funk',        /\b(soul|funk|motown|rhythm.and.blues|boogie|northern.soul|groove(?! metal))\b/i],
    ['Jazz & Blues',       /\b(jazz|blues|swing|bebop|be.bop|fusion|bossa|latin.jazz|cool.jazz|dixieland|delta|smooth.jazz|acid.jazz|nu.jazz)\b/i],
    ['Classical',          /\b(classical|orchestral|opera|chamber|symphony|baroque|contempor|neoclassic|minimali(st)?|modern.classical)\b/i],
    ['Folk & Country',     /\b(folk|country|bluegrass|acoustic(?!.rock)|singer.?songwriter|americana|celtic|irish|western|cowboy|outlaw|appalachian)\b/i],
    ['World & Reggae',     /\b(world|reggae|latin(?!.jazz)|african|caribbean|cuban|salsa|bossa.nova|afrobeat|cumbia|flamenco|tango|polka|turkish|arabic|indian|bollywood|samba|merengue|calypso|afrobeats|dancehall)\b/i],
    ['Gospel & Christian', /\b(gospel|christian|worship|spiritual|hymn|ccm|praise|inspirational|devotional)\b/i],
  ];
  function _autoGroupGenres(allGenres) {
    const bucketMap = new Map(GENRE_BUCKETS_DEFAULT.map(([label]) => [label, []]));
    const other = [];
    for (const g of allGenres) {
      let classified = false;
      for (const [label, re] of GENRE_BUCKETS_DEFAULT) {
        if (re.test(g)) { bucketMap.get(label).push(g); classified = true; break; }
      }
      if (!classified) other.push(g);
    }
    const result = GENRE_BUCKETS_DEFAULT
      .map(([label]) => ({ name: label, genres: bucketMap.get(label) }))
      .filter(g => g.genres.length > 0);
    if (other.length > 0) result.push({ name: 'Other', genres: other });
    return result;
  }

  mstream.get('/api/v1/admin/genre-groups', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    try {
      const savedGroups = db.getGenreGroups();
      const rawRows = db.getGenres(req.user.vpaths);
      const { genres: merged, rawMap } = mergeGenreRows(rawRows);
      const allGenres = merged.map(g => g.genre); // merged display names
      const allGenreSet = new Set(allGenres);
      // Build reverse map: raw DB string → merged display name
      const rawToDisplay = new Map();
      for (const [display, rawSet] of rawMap) for (const raw of rawSet) rawToDisplay.set(raw, display);
      const normalizeGenre = g => allGenreSet.has(g) ? g : (rawToDisplay.get(g) || null);
      const isDefault = !savedGroups || savedGroups.length === 0;
      let groups;
      if (isDefault) {
        groups = _autoGroupGenres(allGenres);
      } else {
        // Normalize any old raw strings to display names; drop genres not in current library
        groups = savedGroups.map(grp => ({
          name: grp.name,
          genres: [...new Set(grp.genres.map(normalizeGenre).filter(Boolean))],
        }));
      }
      res.json({ groups, allGenres, isDefault });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  mstream.post('/api/v1/admin/genre-groups', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.array().items(
      Joi.object({
        name:   Joi.string().max(120).required(),
        genres: Joi.array().items(Joi.string().max(200)).required(),
      })
    );
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    try {
      db.saveGenreGroups(value);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
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
      // Sync modified timestamp so the scanner doesn't flag this as stale on next pass
      // and re-insert the file with a fresh ts (which would flood Recently Added).
      try {
        const newMtime = fs.statSync(absPath).mtime.getTime();
        db.updateFileModified(pathInfo.relativePath, pathInfo.vpath, newMtime);
      } catch (_) {}

      res.json({ ok: true });
    } catch (e) {
      try { fs.unlinkSync(tmpOut);  } catch (_) {}
      try { fs.unlinkSync(tmpOut2); } catch (_) {}
      try { fs.unlinkSync(tmpArt);  } catch (_) {}
      res.status(500).json({ error: e.message });
    }
  });

  // ── Wrapped admin: stats + purge ──────────────────────────────────────────
  mstream.get('/api/v1/admin/wrapped/stats', (req, res) => {
    res.json(db.getWrappedAdminStats());
  });

  mstream.post('/api/v1/admin/wrapped/purge', (req, res) => {
    const schema = Joi.object({
      userId: Joi.string().required(),
      fromMs: Joi.number().integer().min(0).required(),
      toMs:   Joi.number().integer().min(0).required(),
    });
    const { value } = joiValidate(schema, req.body);
    if (value.toMs < value.fromMs) return res.status(400).json({ error: 'toMs must be >= fromMs' });
    const deleted = db.purgePlayEvents(value.userId, value.fromMs, value.toMs);
    res.json({ ok: true, deleted });
  });

  // GET /api/v1/admin/artists/rebuild-status
  mstream.get('/api/v1/admin/artists/rebuild-status', (req, res) => {
    res.json(_artistRebuildState);
  });

  // POST /api/v1/admin/artists/rebuild-index
  // Starts a background rebuild and returns immediately so the UI can show
  // a loader/poll status without reverse-proxy timeouts.
  mstream.post('/api/v1/admin/artists/rebuild-index', (req, res) => {
    if (_artistRebuildState.running) {
      return res.status(409).json({ ok: false, running: true, error: 'Artist index rebuild already running' });
    }

    _artistRebuildState = {
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      lastError: null,
    };
    res.json({ ok: true, started: true });

    db.rebuildArtistIndex(() => {
      _artistRebuildState.running = false;
      _artistRebuildState.finishedAt = Date.now();
      invalidateArtistCache();
    });
  });

  // POST /api/v1/admin/wrapped/backfill-folder-metadata
  // For files with no artist tag, derive artist/album/title from the folder name.
  mstream.post('/api/v1/admin/wrapped/backfill-folder-metadata', async (req, res) => {
    try {
      const updated = db.backfillFolderMetadata();
      res.json({ ok: true, updated });
      db.rebuildArtistIndex(invalidateArtistCache);
    } catch (err) {
      winston.error(err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Server Audio (mpv) Admin API ──────────────────────────────────────────

  // GET /api/v1/admin/server-audio — get current config + running state
  mstream.get('/api/v1/admin/server-audio', (req, res) => {
    const sa = config.program.serverAudio || {};
    res.json({
      enabled: sa.enabled || false,
      mpvBin:  sa.mpvBin  || 'mpv',
      autoUnmute: sa.autoUnmute !== false,
      running: serverPlaybackApi.isRunning(),
    });
  });

  // POST /api/v1/admin/server-audio — update config (enabled, mpvBin)
  mstream.post('/api/v1/admin/server-audio', async (req, res) => {
    const schema = Joi.object({
      enabled: Joi.boolean().optional(),
      mpvBin:  Joi.string().optional(),
      autoUnmute: Joi.boolean().optional(),
    }).min(1);
    joiValidate(schema, req.body);

    if (!config.program.serverAudio) config.program.serverAudio = {};
    if (req.body.enabled !== undefined) config.program.serverAudio.enabled = req.body.enabled;
    if (req.body.mpvBin  !== undefined) config.program.serverAudio.mpvBin  = req.body.mpvBin;
    if (req.body.autoUnmute !== undefined) config.program.serverAudio.autoUnmute = req.body.autoUnmute;

    const loadConfig = await admin.loadFile(config.configFile);
    if (!loadConfig.serverAudio) loadConfig.serverAudio = {};
    if (req.body.enabled !== undefined) loadConfig.serverAudio.enabled = req.body.enabled;
    if (req.body.mpvBin  !== undefined) loadConfig.serverAudio.mpvBin  = req.body.mpvBin;
    if (req.body.autoUnmute !== undefined) loadConfig.serverAudio.autoUnmute = req.body.autoUnmute;
    await admin.saveFile(loadConfig, config.configFile);

    if (req.body.enabled === true)  serverPlaybackApi.bootMpv();
    if (req.body.enabled === false) serverPlaybackApi.killMpv();

    res.json({});
  });

  // POST /api/v1/admin/server-audio/start — start mpv without changing config
  mstream.post('/api/v1/admin/server-audio/start', (req, res) => {
    serverPlaybackApi.bootMpv();
    res.json({ running: serverPlaybackApi.isRunning() });
  });

  // POST /api/v1/admin/server-audio/stop — stop mpv without changing config
  mstream.post('/api/v1/admin/server-audio/stop', (req, res) => {
    serverPlaybackApi.killMpv();
    res.json({ running: false });
  });

  // ── Languages config ──────────────────────────────────────────
  const _ALL_LANG_CODES = ['en','nl','de','fr','es','it','pt','pl','ru','zh','ja','ko'];

  mstream.get('/api/v1/admin/languages/config', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({ enabled: config.program.languages?.enabled || _ALL_LANG_CODES });
  });

  mstream.post('/api/v1/admin/languages/config', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      enabled: Joi.array().items(Joi.string().max(5)).min(1).required()
    });
    joiValidate(schema, req.body);

    // English is always first and always present
    const enabled = ['en', ...req.body.enabled.filter(c => c !== 'en' && _ALL_LANG_CODES.includes(c))];

    const loadConfig = await admin.loadFile(config.configFile);
    if (!loadConfig.languages) loadConfig.languages = {};
    loadConfig.languages.enabled = enabled;
    await admin.saveFile(loadConfig, config.configFile);

    if (!config.program.languages) config.program.languages = {};
    config.program.languages.enabled = enabled;

    res.json({});
  });

  // ── GET /api/v1/admin/diagnostics/artist-albums?artist=Riverside ───────────
  // Diagnoses why albums may be missing from the artist view for a given artist.
  // Returns three diagnostic sections:
  //   1. effectiveArtistValues — all distinct COALESCE(album_artist, artist)
  //      values in `files` for tracks that mention the artist anywhere.
  //      Any value NOT in rawVariants will produce invisible albums.
  //   2. normalizedEntry — what artists_normalized knows about this artist:
  //      canonicalName, rawVariants, vpaths_json, song_count.
  //   3. albumsByVariant — per-variant album count in the DB, so you can see
  //      exactly which spelling has which albums.
  mstream.get('/api/v1/admin/diagnostics/artist-albums', (req, res) => {
    const artistParam = String(req.query.artist || '').trim();
    if (!artistParam) {
      return res.status(400).json({ error: 'Missing ?artist= parameter' });
    }
    const rawDb = db.getDB();

    // 1. All distinct effective-artist values where this name appears anywhere
    const effectiveRows = rawDb.prepare(`
      SELECT DISTINCT COALESCE(album_artist, artist) AS effective, COUNT(*) AS track_count
      FROM files
      WHERE COALESCE(album_artist, artist) LIKE ? OR artist LIKE ? OR album_artist LIKE ?
      GROUP BY COALESCE(album_artist, artist)
      ORDER BY track_count DESC
    `).all(`%${artistParam}%`, `%${artistParam}%`, `%${artistParam}%`);

    // 2. Normalized index entry
    const normRow = rawDb.prepare(
      "SELECT artist_clean, artist_raw_variants, vpaths_json, song_count FROM artists_normalized WHERE lower(artist_clean) = lower(?)"
    ).get(artistParam);

    let rawVariants = [];
    if (normRow) {
      try { rawVariants = JSON.parse(normRow.artist_raw_variants); } catch (_) { rawVariants = [normRow.artist_clean]; }
    }

    // 3. Per-variant album breakdown
    const albumsByVariant = {};
    for (const variant of rawVariants) {
      const albums = rawDb.prepare(`
        SELECT DISTINCT album, rtrim(filepath, replace(filepath, '/', '')) AS dir, vpath
        FROM files
        WHERE COALESCE(album_artist, artist) = ?
        ORDER BY album
      `).all(variant);
      albumsByVariant[variant] = albums.map(r => ({ album: r.album, dir: r.dir, vpath: r.vpath }));
    }

    // 4. Albums that match the search but whose effective artist is NOT in rawVariants
    const variantSet = new Set(rawVariants.map(v => v.toLowerCase()));
    const orphanAlbums = effectiveRows
      .filter(r => !variantSet.has((r.effective || '').toLowerCase()))
      .map(r => {
        const orphanRows = rawDb.prepare(`
          SELECT DISTINCT album, rtrim(filepath, replace(filepath, '/', '')) AS dir, vpath
          FROM files
          WHERE COALESCE(album_artist, artist) = ?
          ORDER BY album
        `).all(r.effective);
        return {
          effective: r.effective,
          track_count: r.track_count,
          albums: orphanRows.map(o => ({ album: o.album, dir: o.dir, vpath: o.vpath })),
        };
      });

    res.json({
      query: artistParam,
      normalizedEntry: normRow ? {
        canonicalName: normRow.artist_clean,
        rawVariants,
        vpaths: (() => { try { return JSON.parse(normRow.vpaths_json); } catch (_) { return []; } })(),
        songCount: normRow.song_count,
      } : null,
      effectiveArtistValues: effectiveRows,
      albumsByVariant,
      orphanAlbums,
      summary: {
        totalEffectiveValues: effectiveRows.length,
        coveredByVariants: effectiveRows.filter(r => variantSet.has((r.effective || '').toLowerCase())).length,
        orphanedValues: orphanAlbums.length,
        orphanedAlbumCount: orphanAlbums.reduce((s, o) => s + o.albums.length, 0),
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// probeHasAudio(absFilepath)
// Returns true when ffprobe finds at least one audio stream with a non-zero
// sample rate and channel count.  Used to detect completely zeroed / truncated
// files before wasting a remux attempt.
// ─────────────────────────────────────────────────────────────────────────────
async function probeHasAudio(absFilepath) {
  const ffmpegDir = config.program.transcode?.ffmpegDirectory;
  const binExt    = process.platform === 'win32' ? '.exe' : '';
  const ffprobeBin = ffmpegDir ? path.join(ffmpegDir, `ffprobe${binExt}`) : null;
  if (!ffprobeBin || !fs.existsSync(ffprobeBin)) return true; // can't probe — optimistically try remux

  try {
    const stdout = await new Promise((resolve, reject) => {
      const args = [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_type,channels,sample_rate',
        '-of', 'csv=p=0',
        absFilepath
      ];
      const proc = child.spawn(ffprobeBin, args);
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('close', code => resolve(out.trim()));
      proc.on('error', reject);
    });
    // stdout looks like "audio,2,44100" — valid if we have channels > 0 and sample_rate > 0
    if (!stdout) return false;
    const parts = stdout.split(',');
    const channels   = parseInt(parts[1], 10) || 0;
    const sampleRate = parseInt(parts[2], 10) || 0;
    return channels > 0 && sampleRate > 0;
  } catch (_) {
    return true; // probe failed for unexpected reason — let remux try anyway
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// remuxAudio(absFilepath)
// Re-muxes an audio file with ffmpeg to fix corrupt tag blocks that prevent
// music-metadata from reading it (e.g. APEv2 RangeError on MP3, invalid FLAC
// headers, broken WAV RIFF chunks).  For MP3 the APEv2 tag block is stripped
// and a clean ID3v2.3 header is written.  For all formats the audio stream is
// stream-copied (lossless, no re-encode) and all text metadata is preserved.
// The in-place rewrite also bumps mtime so the next scan re-processes the file.
// Caller must verify the file exists before calling this function.
// ─────────────────────────────────────────────────────────────────────────────
async function remuxAudio(absFilepath) {
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

  const extLc = ext.toLowerCase();
  const isFlac = extLc === '.flac';
  const isMp3  = extLc === '.mp3';
  const isWav  = extLc === '.wav';

  try {
    await new Promise((resolve, reject) => {
      // For FLAC files that have an ID3v2 header prepended (which causes
      // music-metadata's "Invalid FLAC preamble" error): force the input
      // parser to FLAC with -f flac.  Without this ffmpeg operates in
      // "ID3v2-prefixed-FLAC" hybrid mode and cannot determine codec
      // parameters (sample rate, channels), causing "Could not write header"
      // errors even with stream-copy.  Forcing -f flac makes ffmpeg seek
      // past the ID3v2 block to the fLaC marker and read STREAMINFO correctly.
      //
      // -vn             : exclude video/image streams
      // -c:a copy       : stream-copy — lossless, no re-encode
      // -map_metadata 0 : preserve all text tags (title, artist, album, …)
      const args = ['-y'];
      if (isFlac) args.push('-f', 'flac');
      args.push('-i', absFilepath, '-vn', '-c:a', 'copy', '-map_metadata', '0');
      if (isMp3) {
        // Strip APEv2 tag block (its corrupt footer causes RangeError in music-metadata)
        // and write a clean ID3v2.3 header instead.
        args.push('-write_apetag', '0', '-id3v2_version', '3');
      }
      if (isWav) {
        // Do not write an ID3v2 block into the RIFF container.
        args.push('-write_id3v2', '0');
      }
      args.push(tmp);

      const proc = child.spawn(ffmpegBin, args);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) return resolve();
        const msg = `ffmpeg exited ${code}: ${stderr.slice(-600)}`;
        reject(new Error(msg));
      });
      proc.on('error', reject);
    });

    fs.renameSync(tmp, absFilepath);
    return { ok: true };
  } catch (streamCopyErr) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}

    // Stream-copy failed (e.g. corrupt FLAC frames — valid STREAMINFO but bad
    // frame data causes "Could not write header" even though probeHasAudio
    // passed).  For FLAC, try a re-encode with error tolerance: ffmpeg will
    // decode frame-by-frame, discard corrupt packets, and re-encode the
    // surviving audio.  The result is playable with silence gaps where frames
    // were unreadable — far better than an unplayable file.
    if (isFlac) {
      try {
        await new Promise((resolve, reject) => {
          const args2 = [
            '-y',
            '-err_detect', 'ignore_err',
            '-i', absFilepath,
            '-fflags', '+discardcorrupt',
            '-vn', '-c:a', 'flac', '-map_metadata', '0',
            tmp
          ];
          const proc2 = child.spawn(ffmpegBin, args2);
          let stderr2 = '';
          proc2.stderr.on('data', d => { stderr2 += d.toString(); });
          proc2.on('close', code => {
            if (code !== 0) return reject(new Error(`ffmpeg re-encode exited ${code}: ${stderr2.slice(-600)}`));
            // Sanity-check: output must be at least 1 KB
            const outSize = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
            if (outSize < 1024) return reject(new Error(`re-encode produced empty output (${outSize} bytes)`));
            resolve();
          });
          proc2.on('error', reject);
        });
        fs.renameSync(tmp, absFilepath);
        return { ok: true, reencoded: true };
      } catch (reEncodeErr) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        console.error(`[scan-error-fix] FLAC re-encode also failed for ${absFilepath}: ${reEncodeErr.message}`);
        return { ok: false, unrecoverable: true, reason: reEncodeErr.message };
      }
    }

    // Non-FLAC stream-copy failure — unrecoverable
    console.error(`[scan-error-fix] remuxAudio failed for ${absFilepath}: ${streamCopyErr.message}`);
    return { ok: false, unrecoverable: true, reason: streamCopyErr.message };
  }
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
