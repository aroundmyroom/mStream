const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/mStream/save/db/mstream.sqlite');
// Only files under Albums/ prefix - exact prefix, no wildcards on artist
const rows = db.prepare("SELECT DISTINCT album, artist, filepath FROM files WHERE filepath LIKE 'Albums/%' AND (artist = 'Sade' OR album LIKE 'Sade%') ORDER BY filepath LIMIT 80").all();
console.log('Albums/ Sade count:', rows.length);
console.log(JSON.stringify(rows, null, 2));
