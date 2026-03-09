import { parseFile } from 'music-metadata';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Joi from 'joi';
import { Jimp } from 'jimp';
import mime from 'mime-types';
import axios from 'axios';
import https from 'https';

const ax = axios.create({
  httpsAgent: new https.Agent({  
    rejectUnauthorized: false
  })
});

let loadJson;
try {
  loadJson = JSON.parse(process.argv[process.argv.length - 1], 'utf8');
} catch (_error) {
  console.error(`Warning: failed to parse JSON input`);
  process.exit(1);
}

// Validate input
const schema = Joi.object({
  vpath: Joi.string().required(),
  directory: Joi.string().required(),
  port: Joi.number().port().required(),
  token: Joi.string().required(),
  pause: Joi.number().required(),
  skipImg: Joi.boolean().required(),
  albumArtDirectory: Joi.string().required(),
  scanId: Joi.string().required(),
  isHttps: Joi.boolean().required(),
  compressImage: Joi.boolean().required(),
  supportedFiles: Joi.object().pattern(
    Joi.string(), Joi.boolean()
  ).required(),
  otherRoots: Joi.array().items(Joi.string()).required()
});

const { error: validationError } = schema.validate(loadJson);
if (validationError) {
  console.error(`Invalid JSON Input`);
  console.log(validationError);
  process.exit(1);
}

async function insertEntries(song) {
  const data = {
    "title": song.title ? String(song.title) : null,
    "artist": song.artist ? String(song.artist) : null,
    "year": song.year ? song.year : null,
    "album": song.album ? String(song.album) : null,
    "filepath": song.filePath,
    "format": song.format,
    "track": song.track.no ? song.track.no : null,
    "disk": song.disk.no ? song.disk.no : null,
    "modified": song.modified,
    "hash": song.hash,
    "aaFile": song.aaFile ? song.aaFile : null,
    "art_source": song._artSource || null,
    "vpath": loadJson.vpath,
    "ts": song._preserveTs || Math.floor(Date.now() / 1000),
    "sID": loadJson.scanId,
    "replaygainTrackDb": song.replaygain_track_gain ? song.replaygain_track_gain.dB : null,
    "genre": song.genre ? String(song.genre) : null,
    "cuepoints": song.cuepoints || null
  };

  await ax({
    method: 'POST',
    url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/add-file`,
    headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
    responseType: 'json',
    data: data
  });
}

/**
 * Report a scan error back to the mStream server database for persistent
 * auditing.  The GUID = md5(relativeFilePath + '|' + errorType) so the same
 * recurring problem on the same file increments its count instead of creating
 * duplicate rows.  Errors here must never crash or stall the scanner.
 */
async function reportError(absoluteFilepath, errorType, errorMsg, stack) {
  try {
    const rel = absoluteFilepath
      ? path.relative(loadJson.directory, absoluteFilepath)
      : '';
    const guid = crypto.createHash('md5').update(`${rel}|${errorType}`).digest('hex');
    await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/report-error`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: {
        guid,
        filepath: rel,
        vpath: loadJson.vpath,
        errorType,
        errorMsg:  String(errorMsg  || '').slice(0, 500),
        stack:     String(stack     || '').slice(0, 2000)
      }
    });
  } catch (_err) {
    // error reporting must never crash the scanner
  }
}

run();
async function run() {
  try {
    // Prune stale error entries before starting — respects the configured retention window.
    try {
      await ax({
        method: 'POST',
        url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/prune-errors`,
        headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
        responseType: 'json',
        data: { vpath: loadJson.vpath }
      });
    } catch (_e) { /* non-critical — prune fail should not abort scan */ }

    await recursiveScan(loadJson.directory);

    await ax({
      method: 'POST',
      url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/finish-scan`,
      headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
      responseType: 'json',
      data: {
        vpath: loadJson.vpath,
        scanId: loadJson.scanId
      }
    });
  }catch (err) {
    console.error('Scan Failed');
    console.error(err.stack)
  }
}

async function recursiveScan(dir) {
  if (process.send) process.send({ dir });
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_err) {
    return;
  }

  for (const file of files) {
    const filepath = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(filepath);
    } catch (_error) {
      // Bad file, ignore and continue
      continue;
    }

    if (stat.isDirectory()) {
      if (loadJson.otherRoots.includes(filepath)) { continue; }
      await recursiveScan(filepath);
    } else if (stat.isFile()) {
      try {
        // Make sure this is in our list of allowed files
        if (!loadJson.supportedFiles[getFileType(file).toLowerCase()]) {
          continue;
        }

        const dbFileInfo = await ax({
          method: 'POST',
          url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/get-file`,
          headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
          responseType: 'json',
          data: {
            filepath: path.relative(loadJson.directory, filepath),
            vpath: loadJson.vpath,
            modTime: stat.mtime.getTime(),
            scanId: loadJson.scanId
          }
        });

        if (Object.entries(dbFileInfo.data).length === 0 || dbFileInfo.data._stale) {
          // New or modified file — full parse + insert (cuepoints extracted inside parseMyFile)
          const songInfo = await parseMyFile(filepath, stat.mtime.getTime());
          // Preserve Discogs-assigned art (DB cache only, e.g. WAV files) when the
          // re-parsed file carries no embedded art — prevents orphan cleanup from
          // deleting art the user manually picked via the Discogs picker.
          if (!songInfo.aaFile && dbFileInfo.data._preserveAaFile) {
            songInfo.aaFile = dbFileInfo.data._preserveAaFile;
            songInfo._artSource = dbFileInfo.data._preserveArtSource || null;
          }
          // Preserve original insertion timestamp so editing tags/art doesn't
          // re-flood "Recently Added" (file hash changes after rewrite → ts = now without this).
          if (dbFileInfo.data._preserveTs) {
            songInfo._preserveTs = dbFileInfo.data._preserveTs;
          }
          await insertEntries(songInfo);
        } else {
          // File already in DB — run targeted updates for anything still missing

          if (dbFileInfo.data._needsArt) {
            // Entire art block is wrapped so a failure here never skips _needsCue below.
            try {
              let songInfo;
              try {
                songInfo = (await parseFile(filepath, { skipCovers: false })).common;
              } catch (_e) {
                await reportError(filepath, 'art', `Failed to parse file for embedded art: ${_e.message}`, _e.stack);
                songInfo = {};
              }
              songInfo.filePath = path.relative(loadJson.directory, filepath);
              await getAlbumArt(songInfo);
              if (songInfo.aaFile) {
                await ax({
                  method: 'POST',
                  url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-art`,
                  headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
                  responseType: 'json',
                  data: { filepath: dbFileInfo.data.filepath, vpath: loadJson.vpath, aaFile: songInfo.aaFile, scanId: loadJson.scanId, artSource: songInfo._artSource || null }
                });
              }
            } catch (_artErr) {
              await reportError(filepath, 'art', `Art update failed: ${_artErr.message}`, _artErr.stack);
            }
          }

          if (dbFileInfo.data._needsCue) {
            // Entire cue block is wrapped independently so a failure doesn't leave cuepoints = NULL forever.
            try {
              let cuepoints = '[]';
              try {
                const parsed = await parseFile(filepath, { skipCovers: true });
                const cue = parsed.common?.cuesheet;
                const sampleRate = parsed.format?.sampleRate || null;
                if (cue && Array.isArray(cue.tracks) && cue.tracks.length && sampleRate) {
                  const pts = [];
                  for (const t of cue.tracks) {
                    if (t.number === 170) continue;
                    const idx1 = Array.isArray(t.indexes) && t.indexes.find(i => i.number === 1);
                    if (!idx1) continue;
                    pts.push({ no: t.number, title: t.title || null, t: Math.round((idx1.offset / sampleRate) * 100) / 100 });
                  }
                  if (pts.length > 1) cuepoints = JSON.stringify(pts);
                }
              } catch (_e) {
                await reportError(filepath, 'cue', `Embedded cue sheet parse failed: ${_e.message}`, _e.stack);
              }
              // Fallback: sidecar .cue file alongside the audio file
              if (cuepoints === '[]') {
                try {
                  const sidecar = parseSidecarCue(filepath);
                  if (sidecar) cuepoints = JSON.stringify(sidecar);
                } catch (_e) {
                  await reportError(filepath, 'cue', `Sidecar .cue file parse failed: ${_e.message}`, _e.stack);
                }
              }
              // Always write back — even '[]' sentinel clears the NULL so this file is never re-checked
              await ax({
                method: 'POST',
                url: `http${loadJson.isHttps === true ? 's': ''}://localhost:${loadJson.port}/api/v1/scanner/update-cue`,
                headers: { 'accept': 'application/json', 'x-access-token': loadJson.token },
                responseType: 'json',
                data: { filepath: dbFileInfo.data.filepath, vpath: loadJson.vpath, cuepoints }
              });
            } catch (_cueErr) {
              await reportError(filepath, 'cue', `Cue update failed: ${_cueErr.message}`, _cueErr.stack);
            }
          }
        }
      } catch (err) {
        // console.log(err)
        console.error(`Warning: failed to add file ${filepath} to database: ${err.message}`);
        await reportError(filepath, 'insert', err.message, err.stack);
      }

      // pause
      if (loadJson.pause) { await timeout(loadJson.pause); }
    }
  }
}

function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parse a sidecar .cue file alongside an audio file.
// Returns [{no, title, t}] (t = seconds) or null.
// Only applies to single-FILE cue sheets where the FILE entry matches this audio file.
function parseSidecarCue(audioFilePath) {
  const dir  = path.dirname(audioFilePath);
  const base = path.basename(audioFilePath, path.extname(audioFilePath));

  // Prefer exact-basename match, then fall back to sole .cue in the directory
  let cuePath = path.join(dir, base + '.cue');
  if (!fs.existsSync(cuePath)) {
    let cueFiles;
    try { cueFiles = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.cue')); } catch (_e) { return null; }
    if (cueFiles.length !== 1) return null;
    cuePath = path.join(dir, cueFiles[0]);
  }

  let content;
  try { content = fs.readFileSync(cuePath, 'utf8'); } catch (_e) { return null; }

  // Only handle single-FILE cue sheets whose FILE line references this audio file
  const fileLines = [...content.matchAll(/^FILE\s+"([^"]+)"/gim)];
  if (fileLines.length !== 1) return null;
  const cueRef = path.basename(fileLines[0][1]);
  if (cueRef.toLowerCase() !== path.basename(audioFilePath).toLowerCase()) return null;

  // Parse TRACK / TITLE / INDEX 01 MM:SS:FF
  const tracks = [];
  let cur = null;
  for (const line of content.split(/\r?\n/)) {
    const trackM = line.match(/^\s*TRACK\s+(\d+)\s+AUDIO/i);
    if (trackM) { cur = { no: parseInt(trackM[1], 10), title: null }; continue; }
    if (!cur) continue;
    const titleM = line.match(/^\s*TITLE\s+"(.*)"/i);
    if (titleM) { cur.title = titleM[1]; continue; }
    const idxM = line.match(/^\s*INDEX\s+01\s+(\d+):(\d+):(\d+)/i);
    if (idxM) {
      const t = parseInt(idxM[1], 10) * 60 + parseInt(idxM[2], 10) + parseInt(idxM[3], 10) / 75;
      tracks.push({ no: cur.no, title: cur.title, t: Math.round(t * 100) / 100 });
      cur = null;
    }
  }
  return tracks.length > 1 ? tracks : null;
}

async function parseMyFile(thisSong, modified) {
  let songInfo, fmtInfo = {};
  try {
    const parsed = await parseFile(thisSong, { skipCovers: loadJson.skipImg });
    songInfo = parsed.common;
    fmtInfo = parsed.format || {};
  } catch (err) {
    console.error(`Warning: metadata parse error on ${thisSong}: ${err.message}`);
    await reportError(thisSong, 'parse', err.message, err.stack);
    songInfo = {track: { no: null, of: null }, disk: { no: null, of: null }};
  }

  songInfo.modified = modified;
  songInfo.filePath = path.relative(loadJson.directory, thisSong);
  songInfo.format = getFileType(thisSong);
  songInfo.hash = await calculateHash(thisSong);

  // Extract embedded cue sheet (present in single-file FLAC/WAV album rips)
  try {
    const cue = songInfo.cuesheet;
    const sampleRate = fmtInfo.sampleRate || null;
    if (cue && Array.isArray(cue.tracks) && cue.tracks.length && sampleRate) {
      const cuePoints = [];
      for (const t of cue.tracks) {
        if (t.number === 170) continue; // 0xAA = lead-out marker
        const idx1 = Array.isArray(t.indexes) && t.indexes.find(i => i.number === 1);
        if (!idx1) continue;
        const seconds = idx1.offset / sampleRate;
        cuePoints.push({ no: t.number, title: t.title || null, t: Math.round(seconds * 100) / 100 });
      }
      if (cuePoints.length > 1) {
        songInfo.cuepoints = JSON.stringify(cuePoints);
      }
    }
  } catch (_e) {
    // non-critical — embedded cue extraction failed
    await reportError(thisSong, 'cue', `Embedded cue sheet parse failed: ${_e.message}`, _e.stack);
  }

  // Fallback: sidecar .cue file alongside the audio file
  if (!songInfo.cuepoints) {
    try {
      const sidecar = parseSidecarCue(thisSong);
      if (sidecar) songInfo.cuepoints = JSON.stringify(sidecar);
    } catch (_e) {
      // non-critical
      await reportError(thisSong, 'cue', `Sidecar .cue file parse failed: ${_e.message}`, _e.stack);
    }
  }

  await getAlbumArt(songInfo);
  return songInfo;
}

function calculateHash(filepath) {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('md5').setEncoding('hex');
      const fileStream = fs.createReadStream(filepath);

      fileStream.on('error', (err) => {
        reject(err);
      });
  
      fileStream.on('end', () => {
        hash.end();
        fileStream.close();
        resolve(hash.read());
      });
  
      fileStream.pipe(hash);
    }catch(err) {
      reject(err);
    }
  });
}

async function getAlbumArt(songInfo) {
  if (loadJson.skipImg === true) { return; }

  let originalFileBuffer;

  // picture is stored in song metadata
  if (songInfo.picture && songInfo.picture[0]) {
    // Generate unique name based off hash of album art and metadata
    const picHashString = crypto.createHash('md5').update(songInfo.picture[0].data).digest('hex');
    // mime-types returns 'jpeg' for image/jpeg — normalise to 'jpg' so filenames
    // are consistent with what the Discogs embed endpoint writes (.jpg hardcoded).
    const _rawExt = mime.extension(songInfo.picture[0].format);
    const _normExt = (_rawExt === 'jpeg') ? 'jpg' : (_rawExt || 'jpg');
    songInfo.aaFile = picHashString + '.' + _normExt;
    songInfo._artSource = 'embedded';
    // Check image-cache folder for filename and save if doesn't exist
    if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
      // Save file sync
      fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), songInfo.picture[0].data);
      originalFileBuffer = songInfo.picture[0].data;
    }
  } else {
    originalFileBuffer = await checkDirectoryForAlbumArt(songInfo);
    if (songInfo.aaFile) { songInfo._artSource = 'directory'; }
  }

  if (originalFileBuffer) {
    try {
      await compressAlbumArt(originalFileBuffer, songInfo.aaFile);
    } catch (err) {
      console.error(`Warning: failed to compress album art for ${songInfo.filePath}: ${err.message}`);
      await reportError(path.join(loadJson.directory, songInfo.filePath), 'art', `Failed to compress album art: ${err.message}`, err.stack);
    }
  }
}

async function compressAlbumArt(buff, imgName) {
  if (loadJson.compressImage === false) { return; }

  const img = await Jimp.fromBuffer(buff);
  await img.scaleToFit({w:256, h:256}).write(path.join(loadJson.albumArtDirectory, 'zl-' + imgName));
  await img.scaleToFit({w:92, h:92}).write(path.join(loadJson.albumArtDirectory, 'zs-' + imgName));
}

const mapOfDirectoryAlbumArt = {};
function checkDirectoryForAlbumArt(songInfo) {
  const directory = path.join(loadJson.directory, path.dirname(songInfo.filePath));

  // album art has already been found
  if (mapOfDirectoryAlbumArt[directory]) {
    songInfo.aaFile = mapOfDirectoryAlbumArt[directory];
    return; // File already exists, no need to compress again
  }

  // directory was already scanned and nothing was found
  if (mapOfDirectoryAlbumArt[directory] === false) { return; }

  const imageArray = [];
  let files;
  try {
    files = fs.readdirSync(directory);
  } catch (_err) {
    return;
  }

  for (const file of files) {
    const filepath = path.join(directory, file);
    let stat;
    try {
      stat = fs.statSync(filepath);
    } catch (_error) {
      // Bad file, ignore and continue
      continue;
    }

    if (!stat.isFile()) {
      continue;
    }

    if (["png", "jpg"].indexOf(getFileType(file)) === -1) {
      continue;
    }

    imageArray.push(file);
  }

  if (imageArray.length === 0) {
    // No images directly in this directory — check common artwork subdirectories
    const artworkSubdirNames = ['artwork', 'scans', 'covers', 'images', 'art', 'cover', 'scan'];
    for (const file of files) {
      const subDirPath = path.join(directory, file);
      let subDirStat;
      try { subDirStat = fs.statSync(subDirPath); } catch { continue; }
      if (!subDirStat.isDirectory()) continue;
      if (!artworkSubdirNames.includes(file.toLowerCase())) continue;

      let subFiles;
      try { subFiles = fs.readdirSync(subDirPath); } catch { continue; }
      for (const subFile of subFiles) {
        const ext = getFileType(subFile).toLowerCase();
        if (ext !== 'jpg' && ext !== 'png') continue;
        let subStat;
        try { subStat = fs.statSync(path.join(subDirPath, subFile)); } catch { continue; }
        if (!subStat.isFile()) continue;
        imageArray.push(path.join(file, subFile)); // e.g. "artwork/front.jpg"
      }
      if (imageArray.length > 0) break;
    }

    if (imageArray.length === 0) {
      return mapOfDirectoryAlbumArt[directory] = false;
    }
  }

  let imageBuffer;
  let picFormat;
  let newFileFlag = false;

  // Search for a named file
  for (let i = 0; i < imageArray.length; i++) {
    const imgMod = imageArray[i].toLowerCase();
    if (imgMod === 'folder.jpg' || imgMod === 'cover.jpg' || imgMod === 'album.jpg' || imgMod === 'front.jpg' || imgMod === 'folder.png' || imgMod === 'cover.png' || imgMod === 'album.png' || imgMod === 'front.png') {
      try {
        imageBuffer = fs.readFileSync(path.join(directory, imageArray[i]));
        picFormat = getFileType(imageArray[i]);
      } catch (err) {
        console.error(`Warning: failed to read album art file ${imageArray[i]}: ${err.message}`);
      }
      break;
    }
  }
  
  // default to first file if none are named
  if (!imageBuffer) {
    try {
      imageBuffer = fs.readFileSync(path.join(directory, imageArray[0]));
      picFormat = getFileType(imageArray[0]);
    } catch (err) {
      console.error(`Warning: failed to read album art file ${imageArray[0]}: ${err.message}`);
    }
  }

  // If we still have no buffer (all reads failed or resulted in empty data), bail out
  if (!imageBuffer || imageBuffer.length === 0) {
    return mapOfDirectoryAlbumArt[directory] = false;
  }

  const picHashString = crypto.createHash('md5').update(imageBuffer).digest('hex');
  songInfo.aaFile = picHashString + '.' + picFormat;
  // Check image-cache folder for filename and save if doesn't exist
  if (!fs.existsSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile))) {
    // Save file sync
    fs.writeFileSync(path.join(loadJson.albumArtDirectory, songInfo.aaFile), imageBuffer);
    newFileFlag = true;
  }

  mapOfDirectoryAlbumArt[directory] = songInfo.aaFile;

  if (newFileFlag === true) { return imageBuffer; }
}

function getFileType(filename) {
  return filename.split(".").pop();
}