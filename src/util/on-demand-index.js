/**
 * on-demand-index.js
 *
 * When a file that hasn't been scanned yet is played via the file explorer,
 * index it immediately so play stats can be recorded normally.
 */

import crypto from 'crypto';
import fs from 'fs';
import { parseFile } from 'music-metadata';
import * as db from '../db/manager.js';

const HASH_READ_LIMIT = 524288; // 512 KB — matches scanner.mjs

function computeHash(fullPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5').setEncoding('hex');
    const stream = fs.createReadStream(fullPath, { start: 0, end: HASH_READ_LIMIT - 1 });
    stream.on('error', reject);
    stream.on('end', () => { hash.end(); stream.close(); resolve(hash.read()); });
    stream.pipe(hash);
  });
}

/**
 * Index a single file on-the-fly for play tracking purposes.
 * @param {object} pathInfo - Result of vpath.getVPathInfo()
 * @returns {object|null} The inserted file row object, or null on failure.
 */
export async function indexFileOnDemand(pathInfo) {
  try {
    if (!fs.existsSync(pathInfo.fullPath)) return null;
    const hash = await computeHash(pathInfo.fullPath);
    const meta = await parseFile(pathInfo.fullPath, { skipCovers: true, duration: true });
    const t = meta.common;
    const stat = fs.statSync(pathInfo.fullPath);
    const fileData = {
      hash,
      filepath: pathInfo.relativePath,
      vpath:    pathInfo.vpath,
      title:    t.title  || null,
      artist:   t.artist || null,
      album:    t.album  || null,
      year:     t.year   || null,
      duration: meta.format.duration || null,
      format:   meta.format.container || null,
      genre:    t.genre && t.genre[0] ? t.genre[0] : null,
      modified: Math.floor(stat.mtimeMs / 1000),
      ts:       Date.now(),
    };
    return db.insertFile(fileData);
  } catch (_e) {
    return null;
  }
}
