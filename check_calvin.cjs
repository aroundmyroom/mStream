const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('save/db/mstream.sqlite');
db.exec('PRAGMA busy_timeout = 5000');

// Check how Calvin Harris is stored in files table
const rows = db.prepare(`SELECT DISTINCT artist, title FROM files WHERE artist LIKE '%Calvin%' LIMIT 20`).all();
console.log('files.artist samples for Calvin Harris:');
rows.forEach(r => console.log('  artist:', JSON.stringify(r.artist), '| title:', r.title?.slice(0,50)));

// Check artists_normalized
const an = db.prepare(`SELECT artist_clean, artist_raw_variants, image_file, last_fetched FROM artists_normalized WHERE artist_clean LIKE '%Calvin%'`).all();
console.log('\nartists_normalized:');
an.forEach(r => console.log('  clean:', JSON.stringify(r.artist_clean), '| raw_variants:', r.artist_raw_variants?.slice(0,80), '| image_file:', r.image_file, '| last_fetched:', r.last_fetched));
