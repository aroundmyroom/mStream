/**
 * artist-rebuild-worker.mjs
 *
 * Runs entirely in a worker_thread so buildArtistGroups (CPU-intensive, ~20 s
 * on large libraries) never blocks the main event loop and never interrupts
 * audio streaming.
 *
 * Receives via workerData:
 *   { dbPath, vpaths, includeFilepathPrefixes, excludeFilepathPrefixes }
 *
 * Posts back: { ok: true, groups: number } or { error: string }
 */

import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { buildArtistGroups } from './artist-normalize.js';

const { dbPath, vpaths, includeFilepathPrefixes, excludeFilepathPrefixes } = workerData;

// ── SQL helpers (mirrored from sqlite-backend.js) ─────────────────────────

function inClause(column, values) {
  if (values.length === 0) return { sql: '1=0', params: [] };
  return { sql: `${column} IN (${values.map(() => '?').join(',')})`, params: values };
}

function includePrefixClauses(prefixes) {
  if (!prefixes || prefixes.length === 0) return { sql: '', params: [] };
  const parts = prefixes.map(({ vpath, prefix }) => ({
    vpath,
    like: prefix.replace(/[%_\\]/g, '\\$&') + '%',
  }));
  const sql = ' AND (' + parts.map(() => `(vpath = ? AND filepath LIKE ? ESCAPE '\\')`).join(' OR ') + ')';
  return { sql, params: parts.flatMap(p => [p.vpath, p.like]) };
}

function excludePrefixClauses(prefixes) {
  if (!prefixes || prefixes.length === 0) return { sql: '', params: [] };
  const parts = prefixes.map(({ vpath, prefix }) => ({
    vpath,
    like: prefix.replace(/[%_\\]/g, '\\$&') + '%',
  }));
  const sql = parts.map(() => ` AND NOT (vpath = ? AND filepath LIKE ? ESCAPE '\\')`).join('');
  return { sql, params: parts.flatMap(p => [p.vpath, p.like]) };
}

// ── Rebuild ───────────────────────────────────────────────────────────────

try {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA cache_size = -8000');

  if (vpaths.length === 0) {
    db.exec('BEGIN');
    db.exec('DELETE FROM artists_normalized');
    db.exec('COMMIT');
    db.exec("INSERT INTO fts_artists(fts_artists) VALUES ('rebuild')");
    parentPort.postMessage({ ok: true, groups: 0 });
    process.exit(0);
  }

  const vpIn    = inClause('vpath', vpaths);
  const include = includePrefixClauses(includeFilepathPrefixes);
  const exclude = excludePrefixClauses(excludeFilepathPrefixes);

  const rawRows = db.prepare(
    `SELECT artist, vpath, COUNT(*) AS count
     FROM files
     WHERE artist IS NOT NULL AND artist != '' AND ${vpIn.sql}${include.sql}${exclude.sql}
     GROUP BY artist, vpath`
  ).all(...vpIn.params, ...include.params, ...exclude.params);

  const countMap = new Map();
  const vpathMap = new Map();
  for (const row of rawRows) {
    countMap.set(row.artist, (countMap.get(row.artist) || 0) + row.count);
    if (!vpathMap.has(row.artist)) vpathMap.set(row.artist, new Set());
    vpathMap.get(row.artist).add(row.vpath);
  }

  const countRows = [...countMap.entries()].map(([artist, count]) => ({ artist, count }));
  const groups = buildArtistGroups(countRows);

  const existing = db.prepare(
    'SELECT artist_clean, bio, image_file, image_source, last_fetched, image_flag_wrong, name_override FROM artists_normalized'
  ).all();
  const existingMap = new Map(existing.map(r => [r.artist_clean.toLowerCase(), r]));

  db.exec('BEGIN');
  db.exec('DELETE FROM artists_normalized');
  const ins = db.prepare(`
    INSERT INTO artists_normalized
      (artist_clean, artist_raw_variants, vpaths_json, bio, image_file, image_source,
       last_fetched, image_flag_wrong, name_override, song_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [, group] of groups) {
    const vpathSet = new Set();
    for (const v of group.rawVariants) {
      const vps = vpathMap.get(v.name);
      if (vps) for (const vp of vps) vpathSet.add(vp);
    }
    const prevKey = group.canonicalName.toLowerCase();
    const prev = existingMap.get(prevKey);
    const displayName = (prev && prev.name_override) ? prev.artist_clean : group.canonicalName;
    ins.run(
      displayName,
      JSON.stringify(group.rawVariants.map(v => v.name)),
      JSON.stringify([...vpathSet]),
      prev ? (prev.bio || null) : null,
      prev ? (prev.image_file || null) : null,
      prev ? (prev.image_source || null) : null,
      prev ? (prev.last_fetched || null) : null,
      prev ? (prev.image_flag_wrong || 0) : 0,
      prev ? (prev.name_override || 0) : 0,
      group.rawVariants.reduce((sum, v) => sum + (countMap.get(v.name) || 0), 0)
    );
  }

  db.exec('COMMIT');
  db.exec("INSERT INTO fts_artists(fts_artists) VALUES ('rebuild')");

  parentPort.postMessage({ ok: true, groups: groups.size });
} catch (err) {
  parentPort.postMessage({ error: err.message || String(err) });
  process.exit(1);
}
