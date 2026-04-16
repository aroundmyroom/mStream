/**
 * fpcalc-bootstrap.js
 *
 * Auto-downloads the fpcalc binary from the official Chromaprint GitHub
 * releases on first use. fpcalc is used by the AcoustID fingerprinting
 * worker to generate Chromaprint fingerprints for every file in the library.
 *
 * Supported platforms (static builds, no system dependencies):
 *   Linux x64   → chromaprint-fpcalc-1.5.1-linux-x86_64.tar.gz
 *   Linux arm64 → chromaprint-fpcalc-1.5.1-linux-aarch64.tar.gz
 *   macOS x64   → chromaprint-fpcalc-1.5.1-macos-x86_64.tar.gz
 *   Windows x64 → chromaprint-fpcalc-1.5.1-windows-x86_64.zip
 *
 * All other platforms: log a warning — user must provide the binary manually.
 *
 * The binary is stored in bin/fpcalc/fpcalc (or fpcalc.exe on Windows).
 */

import fsp from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import winston from 'winston';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binaryExt = process.platform === 'win32' ? '.exe' : '';

const FPCALC_VERSION = '1.5.1';
export const BUNDLED_FPCALC_DIR = path.join(__dirname, '../../bin/fpcalc');

let _initPromise = null;

// ── Path helpers ─────────────────────────────────────────────────────────────

export function fpcalcBin() {
  return path.join(BUNDLED_FPCALC_DIR, `fpcalc${binaryExt}`);
}

// ── Platform → download URL ──────────────────────────────────────────────────

function releaseInfo() {
  const { platform, arch } = process;
  const base = `https://github.com/acoustid/chromaprint/releases/download/v${FPCALC_VERSION}`;

  if (platform === 'linux' && arch === 'x64') {
    return { url: `${base}/chromaprint-fpcalc-${FPCALC_VERSION}-linux-x86_64.tar.gz`, ext: 'tar.gz' };
  }
  if (platform === 'linux' && arch === 'arm64') {
    return { url: `${base}/chromaprint-fpcalc-${FPCALC_VERSION}-linux-aarch64.tar.gz`, ext: 'tar.gz' };
  }
  if (platform === 'darwin') {
    // No official arm64 build for macOS from Chromaprint — use x86_64 (runs via Rosetta on M1/M2)
    return { url: `${base}/chromaprint-fpcalc-${FPCALC_VERSION}-macos-x86_64.tar.gz`, ext: 'tar.gz' };
  }
  if (platform === 'win32' && arch === 'x64') {
    return { url: `${base}/chromaprint-fpcalc-${FPCALC_VERSION}-windows-x86_64.zip`, ext: 'zip' };
  }
  return null;
}

// ── HTTP download helpers ────────────────────────────────────────────────────

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'mstream-fpcalc-bootstrap/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
        }
        const tmp = destPath + '.tmp';
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', async () => {
          try { await fsp.rename(tmp, destPath); resolve(); }
          catch (e) { fsp.unlink(tmp).catch(() => {}); reject(e); }
        });
        out.on('error', e => { fsp.unlink(tmp).catch(() => {}); reject(e); });
      }).on('error', reject);
    };
    follow(url);
  });
}

// ── Extraction ───────────────────────────────────────────────────────────────

// Extract fpcalc from a .tar.gz archive using system tar.
// The archive contains chromaprint-fpcalc-X.Y.Z-<platform>/fpcalc so we
// use --strip-components=1 to drop the directory prefix.
function extractTarGz(tarPath, destDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', [
      '-xzf', tarPath,
      '-C', destDir,
      '--strip-components=1',
      '--wildcards', '*/fpcalc',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed (${code}): ${err.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

// Extract fpcalc.exe from a .zip archive using PowerShell (Windows only).
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const script = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem;
      $zip = [IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}');
      foreach ($entry in $zip.Entries) {
        if ($entry.Name -eq 'fpcalc.exe') {
          $outPath = Join-Path '${destDir.replace(/'/g, "''")}' $entry.Name;
          [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $outPath, $true);
        }
      }
      $zip.Dispose();
    `;
    const proc = spawn('powershell', ['-NoProfile', '-Command', script],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`zip extract failed (${code}): ${err.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

// ── Version check ────────────────────────────────────────────────────────────

// Run `fpcalc -version` and return the version string, or '' on failure.
function getFpcalcVersion(binPath) {
  return new Promise(resolve => {
    const p = spawn(binPath, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let o = '';
    p.stdout.on('data', d => { o += d; });
    p.on('close', () => resolve(o.trim()));
    p.on('error', () => resolve(''));
  });
}

// ── Core download + install ──────────────────────────────────────────────────

async function downloadAndInstall() {
  const info = releaseInfo();
  if (!info) {
    winston.warn(
      `[fpcalc-bootstrap] No static build for ${process.platform}/${process.arch}. ` +
      `Place fpcalc in ${BUNDLED_FPCALC_DIR} manually.`
    );
    return false;
  }

  await fsp.mkdir(BUNDLED_FPCALC_DIR, { recursive: true });

  winston.info(`[fpcalc-bootstrap] Downloading fpcalc v${FPCALC_VERSION} for ${process.platform}/${process.arch}…`);

  const archivePath = path.join(BUNDLED_FPCALC_DIR, `fpcalc-download.${info.ext}`);

  try {
    await downloadToFile(info.url, archivePath);

    if (info.ext === 'tar.gz') {
      await extractTarGz(archivePath, BUNDLED_FPCALC_DIR);
    } else {
      await extractZip(archivePath, BUNDLED_FPCALC_DIR);
    }

    await fsp.unlink(archivePath).catch(() => {});

    const binPath = fpcalcBin();

    // Ensure executable bit is set (critical on Linux/macOS)
    if (process.platform !== 'win32') {
      await fsp.chmod(binPath, 0o755);
    }

    const version = await getFpcalcVersion(binPath);
    if (!version) {
      throw new Error('fpcalc did not respond to -version after installation');
    }

    winston.info(`[fpcalc-bootstrap] fpcalc installed: ${version}`);
    return true;
  } catch (err) {
    winston.error(`[fpcalc-bootstrap] Download/install failed: ${err.message}`);
    // Clean up partial downloads
    fsp.unlink(archivePath).catch(() => {});
    return false;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensures fpcalc is present and executable.
 * Safe to call multiple times — only runs once per process (cached promise).
 * Returns true if fpcalc is ready, false if it could not be obtained.
 */
export async function ensureFpcalc() {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const binPath = fpcalcBin();

    // Check if binary already exists and works
    try {
      await fsp.access(binPath, fs.constants.F_OK);
      const version = await getFpcalcVersion(binPath);
      if (version) {
        winston.info(`[fpcalc-bootstrap] fpcalc ready: ${version}`);
        return true;
      }
      // Binary exists but doesn't run — try to fix executable bit first
      if (process.platform !== 'win32') {
        try {
          await fsp.chmod(binPath, 0o755);
          const v2 = await getFpcalcVersion(binPath);
          if (v2) {
            winston.info(`[fpcalc-bootstrap] fpcalc ready (fixed exec bit): ${v2}`);
            return true;
          }
        } catch (_e) {}
      }
      winston.warn(`[fpcalc-bootstrap] fpcalc exists but is not functional — re-downloading`);
    } catch (_e) {
      // File doesn't exist — download it
    }

    return downloadAndInstall();
  })();

  return _initPromise;
}
