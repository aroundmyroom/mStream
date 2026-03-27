import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
  const buf = Buffer.from(resp.data);
  // Validate JPEG magic bytes (FF D8 FF) — a redirect or error page would
  // produce an HTML/text body that embeds as a corrupt JPEG and causes
  // Chrome's demuxer to emit "PTS is not defined" during playback.
  if (buf.length < 3 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) {
    throw new Error(`Discogs returned non-JPEG data (${buf.length} bytes, starts: ${buf.slice(0,4).toString('hex')})`);
  }
  return buf;
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

/**
 * Returns true when the album string looks like a generic compilation /
 * various-artists release where the album title is NOT specific to one artist
 * (e.g. "Complete Top 40 Van 1982", "Greatest Hits of the 80s", …).
 * In that case it makes no sense to search Discogs by album name first.
 */
function isCompilationAlbum(album) {
  if (!album) return false;
  return /\b(top\s*\d+|chart\s*hit|nr\.?\s*\d|number\s*\d|\bva\b|various|compilation|collection|greatest\s*hit|best\s*of|\bgold\b|\bhits\b|all\s*star|one\s*hit|radio\s*hit|nostalg|evergre|classic\s*hit|essential|playlist|mixtape)/i.test(album);
}

/**
 * Score how well the Discogs result artist (extracted from "Artist - Title"
 * format) matches the requested artist. Returns 0 (no match) → 1 (exact).
 * Handles Discogs split-artist titles like "Artist A / Artist B - Release".
 */
function artistMatchScore(requestedArtist, discogsTitle) {
  if (!requestedArtist || !discogsTitle) return 0.5;
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  // Discogs title format: "Artists - Release Title" (last ' - ' separates)
  const dashIdx = discogsTitle.lastIndexOf(' - ');
  const artistPart = dashIdx > 0 ? discogsTitle.slice(0, dashIdx) : '';
  if (!artistPart) return 0.5; // no artist portion extractable → neutral
  const req = normalize(requestedArtist);
  const art = normalize(artistPart);
  if (art === req) return 1.0;
  if (art.includes(req) || req.includes(art)) return 0.9;
  // word-level overlap for partial matches (e.g. "Francine McGee" in "A / Francine McGee")
  const reqWords = req.split(' ').filter(w => w.length > 1);
  const artWords = art.split(' ');
  if (!reqWords.length) return 0.5;
  const matched = reqWords.filter(w => artWords.includes(w)).length;
  return matched / reqWords.length;
}

export function setup(mstream) {

  // ── GET /api/v1/discogs/coverart?artist=X&title=Y&album=Z&year=N ──────────
  // Admin only. Returns up to 8 Discogs release cover thumbs (base64).
  mstream.get('/api/v1/discogs/coverart', async (req, res) => {
    if (config.program.discogs?.enabled === false) return res.status(404).json({ error: 'Discogs not enabled' });
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    let artist = String(req.query.artist || '').trim();
    let title   = cleanFilenameNoise(String(req.query.title  || '').trim());
    let album   = cleanFilenameNoise(String(req.query.album  || '').trim());
    const year  = String(req.query.year   || '').trim();

    // When tags are missing (common for untagged WAV files), try to recover
    // artist and release title from the filepath's parent directory name.
    // e.g. filepath = "12-inches/.../Van McCoy - The Hustle (12 Inch Classics On CD) - SP5-1306/01 The Hustle.wav"
    //      dirName  = "Van McCoy - The Hustle (12 Inch Classics On CD) - SP5-1306"
    //      → artist = "Van McCoy",  album = "The Hustle"
    // NOTE: we only fill album from the folder when the existing album tag is
    // absent or itself looks like a compilation — we must NOT overwrite a real
    // album tag with a folder that also happens to be a compilation name.
    const rawFilepath = String(req.query.filepath || '').trim();
    const albumTagIsCompilation = isCompilationAlbum(album);
    if (rawFilepath && (!artist || !album || albumTagIsCompilation)) {
      const segments  = rawFilepath.replace(/\\/g, '/').split('/').filter(Boolean);
      // Walk parent dirs from innermost outward; skip vpath root (first segment)
      for (let i = segments.length - 2; i >= 1; i--) {
        const parsed = parseFilename(segments[i]);
        if (!parsed) continue;
        if (!artist && parsed.artist) artist = parsed.artist;
        // Only fill album from folder when we don't already have a real (non-compilation) album tag
        if ((!album || albumTagIsCompilation) && parsed.title) {
          let t = stripDiscSuffix(parsed.title);
          // Strip trailing catalog-number suffix: " - SP5-1306", "- 12CL-001" etc.
          // Pattern: " - " followed by 1-6 letters then digits/dashes (no spaces)
          t = t.replace(/\s+-\s+[A-Za-z]{0,6}[\d][A-Za-z0-9\-]*$/, '').trim();
          album = t;
        }
        if (artist && album) break;
      }
    }

    if (!artist && !title && !album) return res.status(400).json({ error: 'artist, title, or album required' });

    // When the album tag is a generic compilation and we have artist + title,
    // downgrade all album-based searches to phase 'C' so Discogs results for
    // the specific artist/song (phase B) always rank above compilation covers.
    const compilationAlbum = isCompilationAlbum(album);
    const albumPhase = (compilationAlbum && artist && title) ? 'C' : 'A';

    // Strip common multi-disc suffixes from album title:
    // "CD2", "Disc 2", "(Disc 2)", "[CD 2]", "Vol. 2", "Part 2" etc.
    function stripDiscSuffix(s) {
      return s
        .replace(/[\s,\-–]+(?:CD|Disc|Disk|Vol\.?|Volume|Part|Pt\.?)\s*\d+\s*$/i, '')
        .replace(/\s*[\[(](?:CD|Disc|Disk|Vol\.?|Volume|Part|Pt\.?)\s*\d+[\])]\s*$/i, '')
        .trim();
    }

    // Build an ordered list of search param sets to try.
    // Priority: Phase A (ID3 album tag) → Phase B (track title / 12" logic) → Phase C (filepath last resort)
    const searches = [];
    const addSearch = (params, phase) => searches.push({ params, phase });

    const cleanAlbum        = album ? stripDiscSuffix(album) : '';
    // First segment before comma/dash (e.g. "Journey into paradise" from "Journey…, The Larry Levan Story CD2")
    const albumFirstSegment = cleanAlbum.split(/\s*[,\-–:]\s*/)[0].trim();
    // Album with trailing parenthetical stripped (e.g. "The Hustle" from "The Hustle (12 Inch Classics On CD)")
    const albumBareTitle    = cleanAlbum.replace(/\s*\([^)]*\)\s*$/, '').trim();

    // ── PHASE A: ID3 album tag (leading) ─────────────────────────────────────
    // When the album is a generic compilation but artist+title are known,
    // albumPhase = 'C' so these searches rank after the artist/song searches.
    // A1. Exact album + artist + year
    if (album) {
      const p = new URLSearchParams({ type: 'release', per_page: '8' });
      if (artist) p.set('artist', artist);
      p.set('release_title', album);
      if (year) p.set('year', year);
      addSearch(p, albumPhase);
    }

    // A2. Disc-suffix-stripped album + artist (no year)
    if (cleanAlbum && cleanAlbum !== album) {
      const p = new URLSearchParams({ type: 'release', per_page: '8' });
      if (artist) p.set('artist', artist);
      p.set('release_title', cleanAlbum);
      addSearch(p, albumPhase);
    }

    // A3. First segment before comma/dash ("Journey into paradise, The Larry Levan Story" → "Journey into paradise")
    if (albumFirstSegment && albumFirstSegment !== cleanAlbum && albumFirstSegment.length > 3) {
      const p = new URLSearchParams({ type: 'release', per_page: '8' });
      if (artist) p.set('artist', artist);
      p.set('release_title', albumFirstSegment);
      addSearch(p, albumPhase);
    }

    // A3b. Trailing-parenthetical-stripped album ("The Hustle (12 Inch Classics On CD)" → "The Hustle")
    if (albumBareTitle && albumBareTitle !== cleanAlbum && albumBareTitle !== albumFirstSegment && albumBareTitle.length > 2) {
      const p = new URLSearchParams({ type: 'release', per_page: '8' });
      if (artist) p.set('artist', artist);
      p.set('release_title', albumBareTitle);
      addSearch(p, albumPhase);
    }

    // A4. Free-text album + artist (handles varied Discogs punctuation)
    if (artist && cleanAlbum) {
      const p = new URLSearchParams({ type: 'release', per_page: '8' });
      p.set('q', `${artist} ${cleanAlbum}`);
      addSearch(p, albumPhase);
    }

    // A5. Free-text album only — catches compilations where Discogs album-artist
    //     is the curator/DJ, not the track artist (e.g. "Larry Levan" not "Yazoo")
    if (cleanAlbum && cleanAlbum.length > 4) {
      const p = new URLSearchParams({ type: 'release', per_page: '5' });
      p.set('q', cleanAlbum);
      addSearch(p, albumPhase);
    }

    // ── PHASE B: Track title / 12" single logic ───────────────────────────────
    // B1. Track title as release_title (useful when album tag is absent or wrong,
    //     or for 12" singles where release title = track title)
    if (title && title !== album) {
      const p = new URLSearchParams({ type: 'release', per_page: '5' });
      if (artist) p.set('artist', artist);
      p.set('release_title', title);
      addSearch(p, 'B');
    }

    // B2. When album === title (classic 12" single: track filed as its own album),
    //     the release title may differ from the track title. Artist master search
    //     surfaces their canonical releases (done AFTER all album strategies).
    if (artist && album && album === title) {
      const p = new URLSearchParams({ type: 'master', per_page: '8' });
      p.set('artist', artist);
      addSearch(p, 'B');
    }

    // B3. Free-text artist + title
    if (artist && title && title !== album) {
      const p = new URLSearchParams({ type: 'release', per_page: '5' });
      p.set('q', `${artist} ${title}`);
      addSearch(p, 'B');
    }

    // ── PHASE C: Filepath / filename (last resort — only used when tags are sparse) ──
    // C1. Filename-style title parsing (e.g. "RobinS-ShowMeLove-Acappella.G12U.wav")
    //     Only run if we don't already have both artist and album from tags.
    if (!artist || !album) {
      const parsed = parseFilename(title) || parseFilename(album);
      if (parsed) {
        if (parsed.title) {
          const p = new URLSearchParams({ type: 'release', per_page: '8' });
          const effectiveArtist = artist || parsed.artist;
          if (effectiveArtist) p.set('artist', effectiveArtist);
          p.set('release_title', parsed.title);
          addSearch(p, 'C');
        }
        if (parsed.artist && parsed.title) {
          const p = new URLSearchParams({ type: 'release', per_page: '8' });
          p.set('q', `${parsed.artist} ${parsed.title}`);
          addSearch(p, 'C');
        }
      }
    }

    // C2. Artist-only master (absolute last resort — their most prominent releases)
    if (artist) {
      const p = new URLSearchParams({ type: 'master', per_page: '8' });
      p.set('artist', artist);
      addSearch(p, 'C');
    }

    // Fallback if nothing built at all
    if (!searches.length) {
      const p = new URLSearchParams({ type: 'release', per_page: '5' });
      p.set('release_title', title || album);
      searches.push({ params: p, phase: 'C' });
    }

    try {
      // Phase 1: run all searches in parallel — preserves priority order via
      // Promise.allSettled index alignment, deduplicate across results.
      const candidates = [];
      const seenIds    = new Set();

      const searchSettled = await Promise.allSettled(
        searches.map(({ params }) =>
          discogsGet(`https://api.discogs.com/database/search?${params}`)
        )
      );
      for (let i = 0; i < searches.length; i++) {
        if (candidates.length >= 18) break;
        const settled = searchSettled[i];
        if (settled.status !== 'fulfilled') continue;
        const { phase } = searches[i];
        const results = (settled.value.results || []).filter(r => r.id && !seenIds.has(r.id));
        for (const result of results) {
          if (candidates.length >= 18) break;
          seenIds.add(result.id);
          candidates.push({
            result,
            phase,
            score: artistMatchScore(artist, result.title || ''),
          });
        }
      }

      // Sort: Phase A (album tag) always before Phase B (title), before Phase C (filepath).
      // Within the same phase, rank by artist-match score descending.
      const phaseOrder = { A: 0, B: 1, C: 2 };
      candidates.sort((a, b) =>
        (phaseOrder[a.phase] - phaseOrder[b.phase]) || (b.score - a.score)
      );

      // Phase 2: resolve all candidates' images in parallel, then deduplicate.
      const imageSettled = await Promise.allSettled(
        candidates.slice(0, 12).map(async ({ result }) => {
          let releaseId = result.id;
          if (result.type === 'master') {
            const master = await discogsGet(`https://api.discogs.com/masters/${result.id}`);
            if (!master.main_release) throw new Error('no main_release');
            releaseId = master.main_release;
          }
          const release = await discogsGet(`https://api.discogs.com/releases/${releaseId}`);
          const images  = release.images || [];
          const img     = images.find(i => i.type === 'primary') || images[0];
          if (!img?.uri) throw new Error('no image');
          const imgBuf   = await fetchImageBuf(img.uri);
          const thumbB64 = `data:image/jpeg;base64,${imgBuf.toString('base64')}`;
          return {
            releaseId,
            releaseTitle: release.title || result.title || '',
            year:         String(release.year || result.year || ''),
            thumbB64,
          };
        })
      );

      const choices      = [];
      const seenReleases = new Set();
      for (const s of imageSettled) {
        if (choices.length >= 8) break;
        if (s.status !== 'fulfilled') continue;
        const { releaseId } = s.value;
        if (seenReleases.has(releaseId)) continue;
        seenReleases.add(releaseId);
        choices.push(s.value);
      }

      res.json({ choices });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/v1/deezer/search ──────────────────────────────────
  // Server-side proxy for the Deezer album search API.
  // Required because the Deezer API does not set CORS headers, so browsers
  // can't call it directly from an HTTPS origin.
  mstream.get('/api/v1/deezer/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q is required' });
    try {
      const url = `https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=10`;
      const resp = await axios.get(url, { headers: { 'User-Agent': UA_BASE } });
      res.json(resp.data);
    } catch (e) {
      res.status(502).json({ error: 'Deezer request failed: ' + e.message });
    }
  });

  // ── POST /api/v1/discogs/embed ─────────────────────────────────
  // Admin only. Downloads full-res cover from Discogs and embeds
  // it into the audio file using ffmpeg (no cover.jpg written to disk).
  mstream.post('/api/v1/discogs/embed', async (req, res) => {
    if (config.program.discogs?.enabled === false) return res.status(404).json({ error: 'Discogs not enabled' });
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({
      filepath:  Joi.string().required(),
      releaseId: Joi.number().integer(),
      coverUrl:  Joi.string().uri(),
    }).or('releaseId', 'coverUrl');

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

    // Declare temp paths before try so the catch block can clean them up.
    // tmpCover goes to the OS temp dir so it never appears as a visible file in
    // the user's NFS music directory during download.
    // tmpOut must be in the same directory as absPath so fs.renameSync is a
    // single-syscall atomic replace (same filesystem, avoids EXDEV errors).
    const _ts      = Date.now();
    const tmpCover = path.join(os.tmpdir(), `.mstream-cover-${_ts}.jpg`);
    const tmpOut   = path.join(path.dirname(absPath), `.mstream-out-${_ts}${extLower}`);

    try {
      let imgUrl;
      if (req.body.coverUrl) {
        // Direct URL path (e.g. from Deezer) — skip Discogs API call
        imgUrl = req.body.coverUrl;
      } else {
        // Fetch full-res primary image from Discogs
        const release = await discogsGet(`https://api.discogs.com/releases/${req.body.releaseId}`);
        const images  = release.images || [];
        const img     = images.find(i => i.type === 'primary') || images[0];
        if (!img?.uri) return res.status(404).json({ error: 'No cover image for this release' });
        imgUrl = img.uri;
      }

      const imgBuf   = await fetchImageBuf(imgUrl);
      // Write temp files in the same directory as the audio file so renameSync
      // is atomic (same filesystem — avoids cross-device EXDEV errors).
      fs.writeFileSync(tmpCover, imgBuf);

      if (!cacheOnly) {
        // ffmpeg: embed cover art — works for mp3, flac, ogg, m4a, opus
        const ffmpegDir = config.program.transcode?.ffmpegDirectory;
        const ffmpegBin = ffmpegDir
          ? path.join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
          : 'ffmpeg';
        // Always map only the audio from the source ('-map 0:a') so any
        // pre-existing embedded-art stream is dropped and replaced cleanly.
        // CRITICAL: use '-c:v mjpeg' (re-encode through ffmpeg's JPEG encoder)
        // instead of '-c:v copy'. Stream-copying a raw JPEG produces an mjpeg
        // stream with avg_frame_rate=0/0 and no PTS, which makes Chrome's
        // demuxer emit "PTS is not defined" and refuse to play the file.
        // Re-encoding through mjpeg costs ~50ms but gives the stream proper
        // timing metadata that every browser/decoder expects.
        await execFileAsync(ffmpegBin, [
          '-y',
          '-i', absPath,
          '-i', tmpCover,
          '-map', '0:a', '-map', '1:v',
          '-c:a', 'copy',
          '-c:v', 'mjpeg',
          '-disposition:v:0', 'attached_pic',
          '-metadata:s:v', 'title=Cover (Front)',
          '-metadata:s:v', 'comment=Cover (Front)',
          tmpOut,
        ]);

        // Atomic replace — single syscall, file is never in a mid-written state
        fs.renameSync(tmpOut, absPath);
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
        if (imgBuf.length < 100) throw new Error('image buffer too small');
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
      try { dbManager.updateFileArt(pathInfo.relativePath, pathInfo.vpath, aaFile, null, req.body.coverUrl ? 'deezer' : 'discogs'); } catch (_) {}

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
      // Clean up any leftover temp files in the music directory
      try { fs.unlinkSync(tmpCover); } catch (_) {}
      try { fs.unlinkSync(tmpOut);   } catch (_) {}
      console.error('[discogs/embed] ERROR:', e);
      res.status(500).json({ error: e.message });
    }
  });
}
