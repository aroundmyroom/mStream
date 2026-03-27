import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import winston from 'winston';
import * as config from '../state/config.js';

const MAX_BACKUPS = 4;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function backupDir() {
  return path.join(config.program.storage.dbDirectory, '..', 'backups');
}

async function ensureBackupDir() {
  await fsp.mkdir(backupDir(), { recursive: true });
}

async function createBackup() {
  await ensureBackupDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const filename = `backup-${ts}.zip`;
  const filepath = path.join(backupDir(), filename);
  const dbDir = config.program.storage.dbDirectory;
  const cfgFile = config.configFile;

  const filesToInclude = [{ src: cfgFile, name: 'default.json' }];

  if (config.program.db.engine === 'loki') {
    // Loki engine — three separate .db files
    for (const name of ['user-data.loki-v1.db', 'files.loki-v3.db', 'shared.loki-v1.db']) {
      const src = path.join(dbDir, name);
      try { await fsp.access(src); filesToInclude.push({ src, name }); } catch (_) {}
    }
  } else {
    // SQLite engine — main db file + WAL files if present
    const dbFile = path.join(dbDir, 'mstream.sqlite');
    filesToInclude.push({ src: dbFile, name: 'mstream.sqlite' });
    for (const ext of ['-wal', '-shm']) {
      try {
        await fsp.access(dbFile + ext);
        filesToInclude.push({ src: dbFile + ext, name: 'mstream.sqlite' + ext });
      } catch (_) {}
    }
  }

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filepath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const { src, name } of filesToInclude) {
      archive.file(src, { name });
    }
    archive.finalize();
  });

  await pruneOldBackups();
  winston.info(`Backup created: ${filename}`);
  return filename;
}

async function pruneOldBackups() {
  const dir = backupDir();
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch (_) { return; }

  const backups = files
    .filter(f => f.startsWith('backup-') && f.endsWith('.zip'))
    .sort(); // lexicographic order = chronological (YYYY-MM-DDTHH-mm)

  const toDelete = backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS));
  for (const f of toDelete) {
    await fsp.unlink(path.join(dir, f)).catch(() => {});
    winston.info(`Old backup removed: ${f}`);
  }
}

async function listBackups() {
  const dir = backupDir();
  try {
    const files = await fsp.readdir(dir);
    const backups = [];
    for (const f of files.filter(f => f.startsWith('backup-') && f.endsWith('.zip'))) {
      const stat = await fsp.stat(path.join(dir, f)).catch(() => null);
      backups.push({ filename: f, size: stat?.size || 0, mtime: stat?.mtimeMs || 0 });
    }
    return backups.sort((a, b) => b.mtime - a.mtime); // newest first
  } catch (_) { return []; }
}

// ── Weekly scheduler ──────────────────────────────────────────────────────────

let _weeklyInterval = null;

async function _checkWeekly() {
  const flagFile = path.join(backupDir(), '.last-weekly');
  let lastMs = 0;
  try {
    const txt = await fsp.readFile(flagFile, 'utf8');
    lastMs = parseInt(txt) || 0;
  } catch (_) {}

  if (Date.now() - lastMs >= WEEK_MS) {
    try {
      await createBackup();
      await ensureBackupDir();
      await fsp.writeFile(flagFile, String(Date.now()), 'utf8');
    } catch (e) {
      winston.error('Weekly backup failed', { stack: e });
    }
  }
}

function _startWeeklyScheduler() {
  if (_weeklyInterval) return;
  // Check on boot after 30s, then every hour
  setTimeout(() => {
    _checkWeekly().catch(() => {});
    _weeklyInterval = setInterval(() => _checkWeekly().catch(() => {}), 60 * 60 * 1000);
  }, 30_000);
}

export function setup(mstream) {
  _startWeeklyScheduler();

  // Trigger a manual backup
  mstream.post('/api/v1/admin/backup', async (req, res) => {
    try {
      const filename = await createBackup();
      res.json({ filename });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // List available backups
  mstream.get('/api/v1/admin/backups', async (req, res) => {
    try {
      res.json(await listBackups());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Download a specific backup
  mstream.get('/api/v1/admin/backup/download/:filename', async (req, res) => {
    const { filename } = req.params;
    // Validate filename to prevent path traversal
    if (!/^backup-[\dT\-]+\.zip$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filepath = path.join(backupDir(), filename);
    try {
      await fsp.access(filepath);
      res.download(filepath, filename);
    } catch (_) {
      res.status(404).json({ error: 'Backup not found' });
    }
  });
}
