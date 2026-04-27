const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const db = new DatabaseSync('/home/mStream/save/db/mstream.sqlite');
const IMG_DIR = '/image-cache/artists';

// Get all artists that lost their image (image_file NULL, last_fetched NULL = just reset)
const artists = db.prepare(
  "SELECT artist_clean, artist_key FROM artists_normalized WHERE image_file IS NULL"
).all();

const update = db.prepare(
  "UPDATE artists_normalized SET image_file = ?, image_source = 'discogs', last_fetched = ? WHERE artist_clean = ?"
);

let restored = 0;
for (const row of artists) {
  const key = (row.artist_key || row.artist_clean).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const fname = key + '.jpg';
  if (fs.existsSync(path.join(IMG_DIR, fname))) {
    update.run(fname, Date.now(), row.artist_clean);
    restored++;
  }
}
console.log('Restored', restored, 'of', artists.length, 'artists from disk files');
