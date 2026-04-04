const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/mStream/save/db/mstream.sqlite');

// All events today
const midnight = new Date(); midnight.setHours(0,0,0,0);
const todayRows = db.prepare(`
  SELECT pe.id, pe.started_at, pe.ended_at, pe.played_ms, f.artist, f.title
  FROM play_events pe
  LEFT JOIN (SELECT hash, title, artist FROM files GROUP BY hash) f ON f.hash = pe.file_hash
  WHERE pe.started_at >= ?
  ORDER BY pe.started_at ASC
`).all(midnight.getTime());

console.log('Total play events today: ' + todayRows.length);
const uniqueToday = new Set(todayRows.map(r => r.id)).size;
console.log('(each row = one distinct song play)');
console.log('');
console.log('Breakdown:');
console.log(' Has played_ms > 0:', todayRows.filter(r => r.played_ms > 0).length);
console.log(' played_ms = 0:    ', todayRows.filter(r => r.played_ms === 0).length);
console.log(' played_ms = null: ', todayRows.filter(r => r.played_ms == null).length);
console.log(' Never got end/stop (open events):', todayRows.filter(r => !r.ended_at).length);

const uniqueHashes = new Set(todayRows.map(r => r.id));
console.log('\nUnique song hashes today:', new Set(todayRows.map(r => r.id)).size);

// Sessions today
const dow = (new Date().getDay() + 6) % 7;
const weekStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - dow).getTime();
const sess = db.prepare(`SELECT session_id, started_at, ended_at, total_tracks FROM listening_sessions WHERE started_at >= ? ORDER BY started_at`).all(weekStart);
console.log('\nListening sessions this week: ' + sess.length);
for (const s of sess) {
  const dur = s.ended_at ? Math.round((s.ended_at - s.started_at)/60000) + 'm' : '(open)';
  console.log('  ' + new Date(s.started_at).toLocaleString() + ' → ' + dur + ' · ' + s.total_tracks + ' tracks');
}
