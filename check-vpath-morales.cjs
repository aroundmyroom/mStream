const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/mStream/save/db/mstream.sqlite');
const rows = db.prepare("SELECT vpath, filepath, album FROM files WHERE album LIKE '%Club Motown%' LIMIT 10").all();
console.log('Club Motown rows:', JSON.stringify(rows, null, 2));
