import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import Joi from 'joi';
import * as config from '../state/config.js';
import * as dbManager from '../db/manager.js';
import { getVPathInfo } from '../util/vpath.js';
import { joiValidate } from '../util/validation.js';

const execFileAsync = promisify(execFile);

const UA_BASE = 'mStreamVelvet/dev +https://github.com/aroundmyroom/mStream';

function discogsHeaders() {
  const { apiKey, apiSecret, userAgentTag } = config.program.discogs;
  const ua = userAgentTag ? `mStreamVelvet/dev/${userAgentTag} +https://github.com/aroundmyroom/mStream` : UA_BASE;
  return {
    'User-Agent': ua,
    'Authorization': `Discogs key=${apiKey}, secret=${apiSecret}`,
  };
}

async function discogsGet(url) {
  const resp = await axios.get(url, { headers: discogsHeaders() });
  return resp.data;
}

async function fetchImageBuf(url) {
  const resp = await axios.get(url, {
    headers:      discogsHeaders(),
    responseType: 'arraybuffer',
  });
  return Buffer.from(resp.data);
}

/**
 * Cleans a raw filename/title string by stripping audio extension and
 * dot-separated hash/ID segments (e.g. ".G12U", ".3FAB8").
 * Works on both spaced and CamelCase filenames.
 */
function cleanFilenameNoise(s) {
  if (!s) return s;
  // Strip audio extension
  s = s.replace(/\.(mp3|flac|wav|ogg|aac|m4a|m4b|opus|aiff|wma|ape|wv)$/i, '');
  // Strip dot-separated short hash/ID segments (2-8 uppercase alphanum chars)
  s = s.replace(/\.[A-Z0-9]{2,8}(?=\.|$)/gi, '');
  return s.trim();
}

/**
 * If `raw` looks like a filename-style string, parse it into { artist, title }.
 * Handles two patterns:
 *   A) Spaced:    "Kool & the Gang - Fresh (Mark Berry Remix).G12U.wav"
 *                  → artist="Kool & the Gang", title="Fresh (Mark Berry Remix)"
 *   B) CamelCase: "RobinS-ShowMeLove-Acappella.G12U.wav"
 *                  → artist="Robin S", title="Show Me Love"
 * Returns null when `raw` doesn't look filename-like.
 */
function parseFilename(raw) {
  if (!raw) return null;
  const s = cleanFilenameNoise(raw);
  if (!s) return null;

  // Pattern A: contains " - " (spaced dash) → "Artist - Title" convention
  if (/ - /.test(s)) {
    const idx = s.indexOf(' - ');
    const artist = s.slice(0, idx).trim();
    const title  = s.slice(idx + 3).trim();
    if (artist && title) return { artist, title };
    if (title) return { artist: null, title };
  }

  // Pattern B: no spaces at all → CamelCase/dash joined
  if (!/\s/.test(s)) {
    let t = s;
    // Strip trailing version/descriptor words
    t = t.replace(/[\-_\s]+(acappella|acapella|a[\s-]?cappella|instrumental|instr\b|extended|radio[\s-]?edit|club[\s-]?mix|original[\s-]?mix|dub[\s-]?mix|dub\b|remix|remaster(?:ed)?|version\b|edit\b|vip\b|bootleg|demo\b|live\b)$/i, '');
    // Split on dashes, expand each CamelCase segment into words
    const parts = t.split('-').map(seg =>
      seg
        .replace(/_/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/\s{2,}/g, ' ')
        .trim()
    ).filter(Boolean);
    if (!parts.length) return null;
    if (parts.length === 1) return { artist: null, title: parts[0] };
    return { artist: parts[0], title: parts[1] };
  }

  return null;
}

export function setup(mstream) {

  // ── GET /api/v1/discogs/coverart?artist=X&title=Y&album=Z&year=N ──────────
  // Admin only. Returns up to 3 Discogs release cover thumbs (base64).
  mstream.get('/api/v1/discogs/coverart', async (req, res) => {
    if (!config.program.discogs?.enabled) return res.status(404).json({ error: 'Discogs not enabled' });
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const artist = String(req.query.artist || '').trim();
    const title  = cleanFilenameNoise(String(req.query.title  || '').trim());
    const album  = cleanFilenameNoise(String(req.query.album  || '').trim());
    const year   = String(req.query.year   || '').trim();
    if (!artist && !title && !album) return res.status(400).json({ error: 'artist, title, or album required' });

    // Strip common multi-disc suffixes from album title:
    // "CD2", "Disc 2", "(Disc 2)", "[CD 2]", "Vol. 2", "Part 2" etc.
    function stripDiscSuffix(s) {
      return s
        .replace(/[\s,\-–]+(?:CD|Disc|Disk|Vol\.?|Volume|Part|Pt\.?)\s*\d+\s*$/i, '')
        .replace(/\s*[\[(](?:CD|Disc|Disk|Vol\.?|Volume|Part|Pt\.?)\s*\d+[\])]\s*$/i, '')
        .trim();
    }

    // Build an ordered list of search param sets to try, from specific → broad.
    // We stop as soon as we have 3 choices.
    const searches = [];
    const addSearch = (params) => searches.push(params);

    const cleanAlbum = stripDiscSuffix(album);
    // First segment before comma/dash (e.g. "Journey into paradise" from "Journey…, The Larry Levan Story")
    const albumFirstSegment = cleanAlbum.split(/\s*[,\-–:]\s*/)[0].trim();

    // 1. Exact album + artist + year
    if (album) {
      const p = new URLSearchParams({ type: 'release', per_page: '8' });
      if (artist) p.set('artist', artist);
      p.set('release_title', album);
      if (year) p.set('year', year);
      addSearch(p);
    }

    // 2. Suffix-stripped album + artist (no year restriction)
    if (cleanAlbum && cleanAlbum !== album) {
      const p = new URLSearchParams({ type: 'release', per_page: '8' });
      if (artist) p.set('artist', artist);
      p.set('release_title', cleanAlbum);
      addSearch(p);
    }

    // 3. First segment of album + artist  (handles "Title, Subtitle CD2" → "Title")
    if (albumFirstSegment && albumFirstSegment !== cleanAlbum && albumFirstSegment.length > 3) {
      const p = new URLSearchParams({ type: 'release', per_page: '8' });
      if (artist) p.set('artist', artist);
      p.set('release_title', albumFirstSegment);
      addSearch(p);
    }

    // 4. Free-text query combining artist + clean album (handles varied punctuation)
    if (artist && cleanAlbum) {
      const p = new URLSearchParams({ type: 'release', per_page: '8' });
      p.set('q', `${artist} ${cleanAlbum}`);
      addSearch(p);
    }

    // 5. Track title as release_title (fallback when album tags are absent/wrong)
    if (title && title !== album) {
      const p = new URLSearchParams({ type: 'release', per_page: '5' });
      if (artist) p.set('artist', artist);
      p.set('release_title', title);
      addSearch(p);
    }

    // 6. Filename-style title parsing (e.g. "RobinS-ShowMeLove-Acappella.G12U.wav")
    //    → artist="Robin S", title="Show Me Love"
    const parsed = parseFilename(title) || parseFilename(album);
    if (parsed) {
      // 6a. parsed artist + parsed title as release_title
      if (parsed.title) {
        const p = new URLSearchParams({ type: 'release', per_page: '8' });
        const effectiveArtist = artist || parsed.artist;
        if (effectiveArtist) p.set('artist', effectiveArtist);
        p.set('release_title', parsed.title);
        addSearch(p);
      }
      // 6b. free-text q= combining both parsed parts
      if (parsed.artist && parsed.title) {
        const p = new URLSearchParams({ type: 'release', per_page: '8' });
        p.set('q', `${parsed.artist} ${parsed.title}`);
        addSearch(p);
      }
    }

    // 7. Artist-only master search (last resort — gets their most prominent releases)
    if (artist) {
      const p = new URLSearchParams({ type: 'master', per_page: '5' });
      p.set('artist', artist);
      addSearch(p);
    }

    // Fallback if nothing built (no artist, no album, only title)
    if (!searches.length) {
      const p = new URLSearchParams({ type: 'release', per_page: '5' });
      p.set('release_title', title || album);
      addSearch(p);
    }

    try {
      const choices = [];
      const seenIds = new Set();

      for (const params of searches) {
        if (choices.length >= 3) break;
        const searchData = await discogsGet(`https://api.discogs.com/database/search?${params}`);
        const results    = (searchData.results || []).filter(r => r.id && !seenIds.has(r.id));

        for (const result of results) {
          if (choices.length >= 3) break;
          seenIds.add(result.id);
          try {
            const release = await discogsGet(`https://api.discogs.com/releases/${result.id}`);
            const images  = release.images || [];
            const img     = images.find(i => i.type === 'primary') || images[0];
            if (!img?.uri150) continue;
            const imgBuf   = await fetchImageBuf(img.uri150);
            const thumbB64 = `data:image/jpeg;base64,${imgBuf.toString('base64')}`;
            choices.push({
              releaseId:    result.id,
              releaseTitle: release.title || result.title || '',
              year:         String(release.year || result.year || ''),
              thumbB64,
            });
          } catch (_) { /* skip this release */ }
        }
      }

      res.json({ choices });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/v1/discogs/embed ─────────────────────────────────
  // Admin only. Downloads full-res cover from Discogs and embeds
  // it into the audio file using ffmpeg (no cover.jpg written to disk).
  mstream.post('/api/v1/discogs/embed', async (req, res) => {
    if (!config.program.discogs?.enabled) return res.status(404).json({ error: 'Discogs not enabled' });
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({
      filepath:  Joi.string().required(),
      releaseId: Joi.number().integer().required(),
    });

    let pathInfo;
    try {
      joiValidate(schema, req.body);
      pathInfo = getVPathInfo(req.body.filepath, req.user);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const absPath = pathInfo.fullPath;
    if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'File not found' });

    // WAV and AIFF containers don't support embedded cover art — cache to DB only
    const extLower = path.extname(absPath).toLowerCase();
    const cacheOnly = ['.wav', '.aiff', '.aif', '.w64'].includes(extLower);

    try {
      // Fetch full-res primary image from Discogs
      const release = await discogsGet(`https://api.discogs.com/releases/${req.body.releaseId}`);
      const images  = release.images || [];
      const img     = images.find(i => i.type === 'primary') || images[0];
      if (!img?.uri) return res.status(404).json({ error: 'No cover image for this release' });

      const imgBuf   = await fetchImageBuf(img.uri);
      const ext      = extLower;
      const tmpDir   = os.tmpdir();
      const ts       = Date.now();
      const tmpCover = path.join(tmpDir, `mstream-cover-${ts}.jpg`);
      const tmpOut   = path.join(tmpDir, `mstream-out-${ts}${ext}`);

      fs.writeFileSync(tmpCover, imgBuf);

      if (!cacheOnly) {
        // ffmpeg: embed cover art — works for mp3, flac, ogg, m4a, opus
        const ffmpegBin = path.join(
          config.program.transcode.ffmpegDirectory,
          process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
        );
        await execFileAsync(ffmpegBin, [
          '-y',
          '-i', absPath,
          '-i', tmpCover,
          '-map', '0', '-map', '1',
          '-c', 'copy',
          '-disposition:v:0', 'attached_pic',
          '-metadata:s:v', 'title=Cover (Front)',
          '-metadata:s:v', 'comment=Cover (Front)',
          tmpOut,
        ]);

        // Replace the original file (copy+delete handles cross-device moves)
        fs.copyFileSync(tmpOut, absPath);
        try { fs.unlinkSync(tmpOut); } catch (_) {}
      }

      try { fs.unlinkSync(tmpCover); } catch (_) {}

      // ── Update image-cache + DB so the player shows the new art live ─────
      const artDir  = config.program.storage.albumArtDirectory;
      const md5     = crypto.createHash('md5').update(imgBuf).digest('hex');
      const aaFile  = `${md5}.jpg`;
      const artPath = path.join(artDir, aaFile);

      // Remember old art reference BEFORE overwriting the DB record
      const oldRecord = dbManager.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
      const oldAaFile = oldRecord?.aaFile || null;

      // Write full-res to image-cache (skip if already there)
      if (!fs.existsSync(artPath)) {
        fs.writeFileSync(artPath, imgBuf);
      }

      // Write compressed variants used by the player UI
      try {
        const { Jimp } = await import('jimp');
        const jimg = await Jimp.fromBuffer(imgBuf);
        const jl   = jimg.clone();
        const js   = jimg.clone();
        jl.scaleToFit({ w: 256, h: 256 });
        await jl.write(/** @type {any} */(path.join(artDir, `zl-${aaFile}`)));
        js.scaleToFit({ w: 92,  h: 92  });
        await js.write(/** @type {any} */(path.join(artDir, `zs-${aaFile}`)));
      } catch (_) { /* compression optional */ }

      // Update the DB record so grid/list views also show it after reload
      try { dbManager.updateFileArt(pathInfo.relativePath, pathInfo.vpath, aaFile, null); } catch (_) {}

      // ── Remove old art from cache/disk if it's now orphaned ──────────────
      if (oldAaFile && oldAaFile !== aaFile) {
        try {
          const refCount = dbManager.countArtUsage(oldAaFile);
          if (refCount === 0) {
            for (const prefix of ['', 'zl-', 'zs-']) {
              try { fs.unlinkSync(path.join(artDir, prefix + oldAaFile)); } catch (_) {}
            }
          }
        } catch (_) {}
      }

      res.json({ ok: true, aaFile, cacheOnly });
    } catch (e) {
      console.error('[discogs/embed] ERROR:', e);
      res.status(500).json({ error: e.message });
    }
  });
}
