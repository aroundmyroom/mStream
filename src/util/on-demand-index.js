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
import * as config from '../state/config.js';

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

    // Resolve child vpath → parent vpath before inserting.
    // If pathInfo.vpath is a sub-directory of another configured vpath (e.g.
    // "12-inches" lives inside the "Music" root), we must store the row under
    // the parent so it is consistent with what the regular scanner would produce,
    // and so that the scanner's finish-scan pruning can clean it up correctly.
    const folders = config.program?.folders || {};
    let effectiveVpath   = pathInfo.vpath;
    let effectiveRelPath = pathInfo.relativePath;
    const myRoot = folders[pathInfo.vpath]?.root?.replace(/\/?$/, '/');
    if (myRoot) {
      for (const [parentKey, parentFolder] of Object.entries(folders)) {
        if (parentKey === pathInfo.vpath) continue;
        const parentRoot = parentFolder.root?.replace(/\/?$/, '/');
        if (parentRoot && myRoot.startsWith(parentRoot) && myRoot !== parentRoot) {
          // This vpath is a child — rewrite to the parent's vpath + prefix
          const prefix = myRoot.slice(parentRoot.length);
          effectiveVpath   = parentKey;
          effectiveRelPath = prefix + pathInfo.relativePath;
          break;
        }
      }
    }

    // If the file is already in the DB under the resolved vpath, return it
    // without creating a duplicate row.
    const existing = db.findFileByPath(effectiveRelPath, effectiveVpath);
    if (existing) return existing;

    const hash = await computeHash(pathInfo.fullPath);
    const meta = await parseFile(pathInfo.fullPath, { skipCovers: true, duration: true });
    const t = meta.common;
    const stat = fs.statSync(pathInfo.fullPath);
    const fileData = {
      hash,
      filepath: effectiveRelPath,
      vpath:    effectiveVpath,
      title:    t.title  || null,
      artist:   t.artist || null,
      album:    t.album  || null,
      year:     t.year   || null,
      duration: meta.format.duration || null,
      format:   meta.format.container || null,
      genre:    t.genre && t.genre[0] ? t.genre[0] : null,
      modified: stat.mtime.getTime(),
      ts:       Date.now(),
    };
    return db.insertFile(fileData);
  } catch (_e) {
    return null;
  }
}
