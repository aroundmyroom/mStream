#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const require = createRequire(import.meta.url);
const version = require('./package.json').version;

/**
 * First-run bootstrap — executes when MSTREAM_MUSIC_DIR is set.
 *
 * Supported environment variables:
 *
 *   MSTREAM_MUSIC_DIR          Path to the music library inside the container (e.g. /music).
 *                              This is the only required variable to trigger auto-config.
 *
 *   MSTREAM_ADMIN_USER         Admin username (optional).
 *   MSTREAM_ADMIN_PASS         Admin password (optional).
 *                              If both are omitted the server starts without any users —
 *                              all library access is open to anyone (no login required).
 *
 *   MSTREAM_ENABLE_AUDIOBOOKS  Set to "true" to add an AudioBooks folder (type: audio-books).
 *   MSTREAM_ENABLE_RECORDINGS  Set to "true" to add a Recordings folder (type: recordings) and enable radio.
 *   MSTREAM_ENABLE_YOUTUBE     Set to "true" to add a YouTube downloads folder (type: youtube).
 *
 *   MSTREAM_AUDIOBOOKS_SUBDIR  Optional sub-folder name inside MSTREAM_MUSIC_DIR.
 *                              If omitted, the folder type is applied to MSTREAM_MUSIC_DIR itself.
 *   MSTREAM_RECORDINGS_SUBDIR  Optional sub-folder name inside MSTREAM_MUSIC_DIR.
 *                              If omitted, the folder type is applied to MSTREAM_MUSIC_DIR itself.
 *   MSTREAM_YOUTUBE_SUBDIR     Optional sub-folder name inside MSTREAM_MUSIC_DIR.
 *                              If omitted, the folder type is applied to MSTREAM_MUSIC_DIR itself.
 *
 * Auto-config runs in two independent phases, each only once:
 *   1. Folder phase  — runs when no folders are configured yet.
 *   2. User phase    — runs when no users exist yet and both MSTREAM_ADMIN_USER
 *                      and MSTREAM_ADMIN_PASS are set.
 *
 * This means you can set up folders on first boot (without admin vars) and then
 * add MSTREAM_ADMIN_USER/PASS on a later restart to create the admin account.
 * Once users exist the user phase is skipped on all subsequent restarts.
 */
async function bootstrapFromEnv(configPath) {
  const musicDir = process.env.MSTREAM_MUSIC_DIR;
  if (!musicDir) return;

  // Lazy-load — only needed on first run
  const fsp = (await import('fs/promises')).default;
  const pathMod = (await import('path')).default;

  // Read existing config (may not exist yet)
  let existing = {};
  try {
    existing = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  } catch (_) { /* file missing or empty — start fresh */ }

  const hasFolders = existing.folders && Object.keys(existing.folders).length > 0;
  const hasUsers   = existing.users   && Object.keys(existing.users).length   > 0;

  // Nothing left to do
  if (hasFolders && hasUsers) return;

  const adminUser = process.env.MSTREAM_ADMIN_USER;
  const adminPass = process.env.MSTREAM_ADMIN_PASS;

  const cfg = { ...existing };

  // ── Folder bootstrap (first run only) ──────────────────────────────────────
  if (!hasFolders) {
    const folders = {};
    const vpaths  = [];

    // Main music folder
    folders['Music'] = { root: musicDir, type: 'music', allowRecordDelete: false, albumsOnly: false };
    vpaths.push('Music');

    // AudioBooks / Podcasts
    if (process.env.MSTREAM_ENABLE_AUDIOBOOKS === 'true') {
      const dir = process.env.MSTREAM_AUDIOBOOKS_SUBDIR
        ? pathMod.join(musicDir, process.env.MSTREAM_AUDIOBOOKS_SUBDIR)
        : musicDir;
      if (process.env.MSTREAM_AUDIOBOOKS_SUBDIR) await fsp.mkdir(dir, { recursive: true });
      folders['AudioBooks'] = { root: dir, type: 'audio-books', allowRecordDelete: false, albumsOnly: false };
      vpaths.push('AudioBooks');
    }

    // Radio Recordings
    if (process.env.MSTREAM_ENABLE_RECORDINGS === 'true') {
      const dir = process.env.MSTREAM_RECORDINGS_SUBDIR
        ? pathMod.join(musicDir, process.env.MSTREAM_RECORDINGS_SUBDIR)
        : musicDir;
      if (process.env.MSTREAM_RECORDINGS_SUBDIR) await fsp.mkdir(dir, { recursive: true });
      folders['Recordings'] = { root: dir, type: 'recordings', allowRecordDelete: true };
      vpaths.push('Recordings');
      cfg.radio = { enabled: true };
    }

    // YouTube downloads
    if (process.env.MSTREAM_ENABLE_YOUTUBE === 'true') {
      const dir = process.env.MSTREAM_YOUTUBE_SUBDIR
        ? pathMod.join(musicDir, process.env.MSTREAM_YOUTUBE_SUBDIR)
        : musicDir;
      if (process.env.MSTREAM_YOUTUBE_SUBDIR) await fsp.mkdir(dir, { recursive: true });
      folders['YouTube'] = { root: dir, type: 'youtube', allowRecordDelete: true };
      vpaths.push('YouTube');
    }

    cfg.folders = folders;
  }

  // ── User bootstrap (runs when no users exist yet) ──────────────────────────
  if (!hasUsers && adminUser && adminPass) {
    const { hashPassword } = await import('./src/util/auth.js');
    const hashed  = await hashPassword(adminPass);
    // Grant access to all currently-configured folders
    const vpaths  = Object.keys(cfg.folders || {});
    cfg.users = {
      [adminUser]: {
        password: hashed.hashPassword,
        salt:     hashed.salt,
        admin:    true,
        vpaths,
        'allow-radio-recording':  true,
        'allow-youtube-download': true,
      }
    };
  }

  await fsp.mkdir(pathMod.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

// Check if we are in an electron environment
if (process.versions["electron"]) {
  // off to a separate electron boot environment
  await import("./build/electron.js");
} else {
  const { Command } = await import('commander');
  const program = new Command();
  program
    .version(version)
    .option('-j, --json <json>', 'Specify JSON Boot File', join(__dirname, 'save/conf/default.json'))
    .parse(process.argv);

  console.clear();
  console.log(`
               ____  _
     _ __ ___ / ___|| |_ _ __ ___  __ _ _ __ ___
    | '_ \` _ \\\\___ \\| __| '__/ _ \\/ _\` | '_ \` _ \\
    | | | | | |___) | |_| | |  __/ (_| | | | | | |
    |_| |_| |_|____/ \\__|_|  \\___|\\__,_|_| |_| |_|`);
  console.log(`v${program.version()}`);
  console.log();
  console.log('Check out our Discord server:');
  console.log('https://discord.gg/KfsTCYrTkS');
  console.log();

  // First-run bootstrap: if MSTREAM_MUSIC_DIR is set and config has no folders
  // yet, auto-generate an initial config from environment variables.
  try {
    await bootstrapFromEnv(program.opts().json);
  } catch (err) {
    // Bootstrap failure is non-fatal — the server will still start.
    // Log clearly so the issue is visible in docker logs.
    console.error('[bootstrap] Failed to write initial config:', err.message);
  }

  // Boot the server
  const server = await import("./src/server.js");
  server.serveIt(program.opts().json);
}
