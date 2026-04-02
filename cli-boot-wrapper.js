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
 *   MSTREAM_ENABLE_AUDIOBOOKS  Set to "true" to create an AudioBooks/Podcasts vpath.
 *   MSTREAM_ENABLE_RECORDINGS  Set to "true" to create a Recordings vpath (radio recording).
 *   MSTREAM_ENABLE_YOUTUBE     Set to "true" to create a YouTube downloads vpath.
 *
 *   MSTREAM_AUDIOBOOKS_SUBDIR  Sub-folder name inside MSTREAM_MUSIC_DIR (default: Audiobooks).
 *   MSTREAM_RECORDINGS_SUBDIR  Sub-folder name inside MSTREAM_MUSIC_DIR (default: Recordings).
 *   MSTREAM_YOUTUBE_SUBDIR     Sub-folder name inside MSTREAM_MUSIC_DIR (default: YouTube).
 *
 * Auto-config only runs when the config file has no folders configured yet,
 * so it is safe to leave these variables set on subsequent container restarts.
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

  // Skip if folders already configured
  if (existing.folders && Object.keys(existing.folders).length > 0) return;

  const folders = {};
  const vpaths = [];

  // Main music vpath
  folders['Music'] = { root: musicDir, type: 'music', allowRecordDelete: false, albumsOnly: false };
  vpaths.push('Music');

  // AudioBooks / Podcasts
  if (process.env.MSTREAM_ENABLE_AUDIOBOOKS === 'true') {
    const dir = pathMod.join(musicDir, process.env.MSTREAM_AUDIOBOOKS_SUBDIR || 'Audiobooks');
    await fsp.mkdir(dir, { recursive: true });
    folders['AudioBooks'] = { root: dir, type: 'audio-books', allowRecordDelete: false, albumsOnly: false };
    vpaths.push('AudioBooks');
  }

  // Radio Recordings
  if (process.env.MSTREAM_ENABLE_RECORDINGS === 'true') {
    const dir = pathMod.join(musicDir, process.env.MSTREAM_RECORDINGS_SUBDIR || 'Recordings');
    await fsp.mkdir(dir, { recursive: true });
    folders['Recordings'] = { root: dir, type: 'recordings', allowRecordDelete: true };
    vpaths.push('Recordings');
  }

  // YouTube downloads
  if (process.env.MSTREAM_ENABLE_YOUTUBE === 'true') {
    const dir = pathMod.join(musicDir, process.env.MSTREAM_YOUTUBE_SUBDIR || 'YouTube');
    await fsp.mkdir(dir, { recursive: true });
    folders['YouTube'] = { root: dir, type: 'youtube', allowRecordDelete: true };
    vpaths.push('YouTube');
  }

  const cfg = { ...existing, folders };

  // Optional admin user — if omitted the server runs without authentication
  const adminUser = process.env.MSTREAM_ADMIN_USER;
  const adminPass = process.env.MSTREAM_ADMIN_PASS;
  if (adminUser && adminPass) {
    const { hashPassword } = await import('./src/util/auth.js');
    const hashed = await hashPassword(adminPass);
    cfg.users = {
      [adminUser]: {
        password: hashed.hashPassword,
        salt: hashed.salt,
        admin: true,
        vpaths,
        'allow-radio-recording': true,
        'allow-youtube-download': true,
      }
    };
  }

  // Enable radio if recordings vpath is configured
  if (process.env.MSTREAM_ENABLE_RECORDINGS === 'true') {
    cfg.radio = { enabled: true };
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
  await bootstrapFromEnv(program.opts().json);

  // Boot the server
  const server = await import("./src/server.js");
  server.serveIt(program.opts().json);
}
