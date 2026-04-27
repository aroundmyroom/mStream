const jwt = require('jsonwebtoken');
const https = require('https');
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/home/mStream/save/conf/default.json', 'utf8'));
const token = jwt.sign({ username: Object.keys(cfg.users)[0] }, cfg.secret);
const opts = {
  hostname: 'music.aroundtheworld.net', port: 3000,
  path: '/api/v1/artists/images/aha.jpg',
  headers: { 'x-access-token': token },
  rejectUnauthorized: false
};
const req = https.get(opts, r => {
  console.log('status:', r.statusCode);
  console.log('content-type:', r.headers['content-type']);
  const chunks = [];
  r.on('data', c => chunks.push(c));
  r.on('end', () => {
    const buf = Buffer.concat(chunks);
    console.log('size:', buf.length, 'bytes');
    fs.writeFileSync('/tmp/aha_test.bin', buf);
  });
});
req.on('error', e => console.error(e));
