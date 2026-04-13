# GitHub Copilot Instructions

- **Dev server = production server**: all development and testing happens directly on `/home/mStream`. This machine always runs the latest code. There is no separate staging environment. Commits are made from this machine.
- Do not suggest or create a commit unless the user explicitly asks for it
- **Commit/push blackout window: Monday–Friday 09:00–17:00 CET (Amsterdam, UTC+1 winter / UTC+2 summer). Do NOT commit or push during these hours unless the user explicitly overrides. Outside these hours (evenings, weekends) commits are allowed as normal.**
- Before starting any commit, always write change notes first — update `changes-fork-velvet.md` with a summary of what changed and why
- **After a commit, do NOT push automatically. Only push to GitHub (`git push`) when the user explicitly says to push or to release. The active tracking remote is `origin master`.**
- The server uses HTTPS — always use `https://` in URLs and code
- **Live server URL**: `https://music.aroundtheworld.net:3000` — use this for all curl tests and API verification when `localhost` or `127.0.0.1` is unreachable (curl exits with code 7 = connection refused). Example: `curl -sk https://music.aroundtheworld.net:3000/api/v1/ping/public`
- **Authenticated API calls from scripts**: do NOT attempt to log in via `/api/v1/auth/login` (passwords are salted hashes — the plain value in config is the hash, not the raw password). Instead, mint a JWT directly from the server secret and use the `x-access-token` header. Node.js pattern (always write a `.cjs` file):
  ```js
  const jwt = require('jsonwebtoken');
  const https = require('https');
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('/home/mStream/save/conf/default.json', 'utf8'));
  const token = jwt.sign({ username: Object.keys(cfg.users)[0] }, cfg.secret);
  const opts = { hostname: 'music.aroundtheworld.net', port: 3000, path: '/api/v1/YOUR/ENDPOINT', headers: { 'x-access-token': token }, rejectUnauthorized: false };
  https.get(opts, r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>console.log(JSON.parse(b))); });
  ```
  Use `https.get` (not `execSync curl`) for large responses — curl via execSync hits ENOBUFS on responses >1 MB.
- Restart the server with: `systemctl restart music.service`
- **After every change to any `src/` file, always restart the server automatically — do not wait for the user to ask. Client-side-only changes (`webapp/` files that are served statically) do not need a restart.**
- Active branch is `master`
- Admin UI lives in `webapp/admin/` — always use that for admin-related changes
- When creating a new release, bump the version in `package.json` first
- **When bumping the version**, always update the Docker version pin in **both** `README.md` (the `docker pull` example near the bottom of the Installing section) and `docs/docker.md` (the pull example in that file) to the new tag — e.g. `ghcr.io/aroundmyroom/mstream-velvet:vX.Y.Z-velvet`
- **Before writing any release notes or changelog entry**, always read the most recent 3–5 release files in `releases/` (sorted by version) to understand what has already been shipped — this prevents re-announcing features that were in a prior release and ensures nothing new gets missed.
- When implementing a new feature, always cross-check `releases/` + `changes-fork-velvet.md` to confirm it is not already documented. If a feature exists in code but has no release note, add it to the current patch entry.
- `sqlite3` CLI is not installed on this system; SQLite is accessed via the Node.js built-in `node:sqlite` module (`DatabaseSync`) — Node v24.14.0
- **Database file**: `save/db/mstream.sqlite` — this is the ONLY active DB. `save/db/files.sqlite` is an empty placeholder, ignore it.
- **Config file**: `save/conf/default.json` — this is the active config. Never reference `config.json` or `save/db/default.json`; they do not exist or are stale copies.
- **Main table**: `files` (not `songs`, not `tracks`)
- **To query the DB from CLI**, always write a `.cjs` file and run it with `node /home/mStream/yourscript.cjs` — never use `--eval` or heredoc (`<< 'EOF'`) as the shell mangles multi-line `--eval` strings and causes `ReferenceError: x is not defined`. Example:
  ```js
  // /home/mStream/check.cjs
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('save/db/mstream.sqlite');
  console.log(db.prepare('SELECT COUNT(*) as c FROM files').get());
  ```
  Then run: `node /home/mStream/check.cjs` (always use absolute path), clean up with `rm` afterwards.
- After editing `webapp/admin/index.js`, always validate with: `node --input-type=module < webapp/admin/index.js 2>&1 | grep -v "not defined" | head -5` — a clean result (only `not defined` browser refs) means no syntax errors
- **The Easter egg (`window.EGG`, `egg-canvas`, `egg-pixel`) must NEVER be mentioned in any changelog, release notes, commit message, documentation, or todo file. Treat it as invisible — fix or improve it silently without any reference to it in written records.**
- After implementing any user-facing feature, always update **all three** records: (1) `changes-fork-velvet.md` changelog, (2) the relevant file under `docs/` (create one if needed), (3) `todo.md` — **remove** completed items entirely (do not keep a DONE section; completed work is recorded in `changes-fork-velvet.md` and `releases/`).

---

## i18n / Taal Module — REQUIRED for all new features

Every new user-visible string MUST use i18n keys — never hardcode text in templates or JS.

- **Player frontend** (`webapp/app.js`): use `t('player.[section].[key]')` — e.g. `toast(t('player.toast.queueEmpty'))`
- **Admin frontend** (`webapp/admin/index.js`): use `this.t('admin.[section].[key]')` in Petite-Vue templates
- **Static HTML** (`webapp/index.html`): use `data-i18n="player.[section].[key]"` attributes
- **Add every new key to `webapp/locales/en.json`** (English, authoritative source)
- **Add Dutch translation to `webapp/locales/nl.json`** — AI translates NL; keep it natural
- **MANDATORY: ALL 12 locale files must always stay in sync.** When you add new keys, you MUST add them to every locale file — not just en.json and nl.json. The 10 other locales (de, fr, es, it, pt, pl, ru, zh, ja, ko) get the English value as a placeholder until community translations arrive.
- **Dynamic values** use `{{param}}` in the key: `t('player.toast.addedSongs', { count: songs.length })`
- **Key namespaces**: `player.nav.*`, `player.toast.*`, `player.modal.*`, `player.title.*`, `player.boot.*`, `player.player.*`, `admin.*`
- **After adding keys**, always verify ALL 12 locale files are in sync. Run this script (write to a .cjs file, don't use --eval):
  ```js
  const fs = require('fs');
  const en = JSON.parse(fs.readFileSync('webapp/locales/en.json','utf8'));
  const enKeys = Object.keys(en);
  for (const lang of ['nl','de','fr','es','it','pt','pl','ru','zh','ja','ko']) {
    const d = JSON.parse(fs.readFileSync(`webapp/locales/${lang}.json`,'utf8'));
    const missing = enKeys.filter(k => !(k in d));
    if (missing.length) console.log(lang + ' MISSING ' + missing.length + ':', missing.slice(0,5));
    else console.log(lang + ': OK (' + Object.keys(d).length + ')');
  }
  ```
- **Quick sync command** — adds any missing keys to all 10 other locales using English as base:
  ```js
  // /tmp/sync_locales.cjs
  const fs = require('fs');
  const en = JSON.parse(fs.readFileSync('webapp/locales/en.json','utf8'));
  const enKeys = Object.keys(en);
  for (const lang of ['de','fr','es','it','pt','pl','ru','zh','ja','ko']) {
    const path = `webapp/locales/${lang}.json`;
    const d = JSON.parse(fs.readFileSync(path,'utf8'));
    const missing = enKeys.filter(k => !(k in d));
    if (!missing.length) { console.log(lang + ': in sync'); continue; }
    for (const k of missing) d[k] = en[k];
    const synced = {}; for (const k of enKeys) synced[k] = d[k];
    fs.writeFileSync(path, JSON.stringify(synced, null, 2));
    console.log(lang + ': added ' + missing.length);
  }
  ```

---

## Release workflow (full checklist)

Every release follows this exact sequence — do not skip steps:

1. **Bump version** in `package.json` — format `X.Y.Z-velvet`
2. **Update `README.md`** — version badge link and Docker pin (`ghcr.io/aroundmyroom/mstream-velvet:vX.Y.Z-velvet`)
3. **Write release notes** — create `releases/vX.Y.Z-velvet.md`
4. **Update `changes-fork-velvet.md`** — add a versioned entry above the previous one
5. **Update `docs/API.md`** index if any new endpoint was added
6. **Create any new `docs/API/*.md` detail pages** needed
7. **Update `docs/docker.md`** — version pin in the pull example
8. **Commit** everything: `git add -A && git commit -m "vX.Y.Z-velvet: <short description>"`
9. **Push** to GitHub: `git push`
10. **Tag the release**: `git tag vX.Y.Z-velvet && git push origin vX.Y.Z-velvet`
    - The tag push **automatically triggers** `.github/workflows/docker-publish.yml`
    - GitHub Actions builds a multi-arch image (`linux/amd64` + `linux/arm64`) and pushes it to `ghcr.io/aroundmyroom/mstream-velvet` with the version tag **and** `latest`
    - No manual Docker steps are needed — tagging is enough
11. **Create the GitHub Release**: `gh release create vX.Y.Z-velvet --title "vX.Y.Z-velvet — <short title>" --notes-file releases/vX.Y.Z-velvet.md --repo aroundmyroom/mStream`
    - This makes the release visible on the GitHub Releases page — without this step the tag exists but no release shows up

---

## Architecture notes

### child-vpath / filepathPrefix whitelist pattern
When a parent vpath contains child sub-folders that need different filtering (Albums-Only, Auto-DJ source restriction), always use the **whitelist approach** — `includeFilepathPrefixes` — not a blacklist. A blacklist leaks files at the parent root and in unregistered sub-folders. The whitelist SQL pattern is:
```sql
WHERE vpath = 'Music' AND filepath LIKE 'Albums/%'
```
See `src/db/sqlite-backend.js` → `includePrefixClauses()` and `excludePrefixClauses()`.

### CRITICAL — child-vpath filepath rule (404 bug — fixed 3× times, DO NOT regress)
**Any code that adds a song filepath to the queue MUST use the DB-sourced parent-vpath path, never the raw child-vpath name.**

**Why it breaks:** Express.static mounts are registered as `/media/[vpath name]/` with literal spaces. A child vpath like `Unidisc 12-inch classics` mounts as `/media/Unidisc 12-inch classics/`. But browsers percent-encode spaces in URLs → `/media/Unidisc%2012-inch%20classics/` → Express can't match the mount → **404**.

**The correct path is ALWAYS:** `Music/12 inches/12 Inch Classics on CD (Unidisc Series)/album/track.wav` (using the ROOT DB vpath, never the child vpath name).

**Every code path that produces a song filepath must go through one of these:**
1. `renderMetadataObj(row)` → `row.vpath + '/' + row.filepath` — server-side ✓
2. `api('POST', 'api/v1/db/metadata', { filepath })` → `norm(meta)` — client-side lookup ✓
3. `source.dbVpath + '/' + e.row.filepath` — albums-browse pattern ✓

**Known locations fixed (never remove these fixes):**
- `src/api/albums-browse.js` line ~193: `filepath: source.dbVpath + '/' + e.row.filepath` (fixed v6.1.1)
- `webapp/app.js` jukebox `addSong` WebSocket handler: calls `api('POST', 'api/v1/db/metadata', ...)` then `norm(meta)` (fixed v6.x.x)

**When reviewing ANY new code that builds a filepath for playback:** ask "does this use the child vpath name or the DB parent vpath?" If child vpath name → BUG.

### Vpath indexing architecture — NO duplicate indexing
**Only ROOT vpaths are indexed in the database.** A ROOT vpath is one whose `root` path is not a sub-path of any other configured vpath.

VCHILDs (child vpaths) are **shortcuts / filters only** — their files are already stored in the DB under the parent ROOT. They are never indexed separately. Treating a child vpath as a separate indexed source would cause duplicate rows.

Detection logic (same as `src/api/playlist.js` and `src/api/smart-playlists.js`):
```js
// A vpath is a CHILD if another vpath's root is a strict prefix of its own root
const parentVpath = allVpaths.find(other =>
  other !== name &&
  myRoot.startsWith(folders[other].root + '/') // strict prefix, not equal
);
```

The `vpathMetaData` object (sent by `/api/v1/playlist/getall`) exposes this per vpath:
- `parentVpath`: name of the parent ROOT vpath, or `null` if this is a ROOT
- `filepathPrefix`: relative path prefix to filter by inside the parent (e.g. `"Albums/"`)
- `albumsOnly`: boolean — restrict to albums content only
- `type`: `"music"` | `"recordings"` | `"youtube"` | `"audio-books"`

### albumsOnly vpath behaviour
`albumsOnly: true` can be set on either a ROOT or a CHILD vpath:

- **ROOT vpath with `albumsOnly: true`** — all files in that vpath root are albums; include ALL of them in the Album Library.
- **CHILD vpath with `albumsOnly: true`** — the child's `filepathPrefix` (e.g. `"Albums/"`) is the filter; query the **parent ROOT** with `filepath LIKE 'Albums/%'`.
- **No vpath has `albumsOnly`** — fallback: look for any ROOT vpath that has an `Albums/` subdirectory on disk.

This logic is implemented in `src/api/albums-browse.js` → `resolveAlbumsSources()`. The Album Library supports **multiple** albumsOnly sources simultaneously.

### ffmpeg self-contained bootstrap
`src/util/ffmpeg-bootstrap.js` manages the ffmpeg binary:
- `MIN_FFMPEG_MAJOR = 6` — minimum required version
- On startup: checks `bin/ffmpeg/ffmpeg`, downloads from BtbN if missing or below v6
- All consumers (`ytdl.js`, `radio-recorder.js`, `transcode.js`, `discogs.js`) import `ffmpegBin()` / `ffprobeBin()` — never use the system PATH

### YouTube download
- Endpoint: `GET /api/v1/ytdl/info?url=` and `POST /api/v1/ytdl/download`
- All temp files go to `os.tmpdir()` via `fsp.mkdtemp()` — never in the music folder
- Opus art uses `METADATA_BLOCK_PICTURE` Vorbis comment (binary spec, base64) — NOT `-map 1:v` (Opus containers reject video streams)
- MP3 art uses `-map 0:a -map 1:v -c:v mjpeg -id3v2_version 3 -disposition:v:0 attached_pic`
- Files saved to `type: youtube` vpath; falls back to `type: recordings` if none configured

### On-demand album art
- `GET /api/v1/files/art?fp=<vpath/file>` — extracts embedded art via `music-metadata`, MD5-hashes, caches to `albumArtDirectory`, returns `{ aaFile }`
- Client calls this automatically for any song with no pre-cached art — player bar, queue panel, file list, file explorer (recordings/youtube folders) all wired

### Radio recording
- Stop API (`POST /api/v1/radio/recording/stop`) returns: `filePath`, `relPath`, `bytesWritten`, `durationMs`, `vpath`, `stationName`, `artFile`
- Non-MP3 art embed: `-map 0:a -map 1:v -c:a copy -c:v copy -disposition:v:0 attached_pic`

---

## Analysing external projects / competitor features

When the user asks "can we benefit from this?" or "analyse this project for us" or shares a GitHub repo / PR link for comparison:

1. **Understand our project first** — before evaluating any external feature, search the codebase for the relevant area (e.g. check `webapp/app.js`, `src/api/`, `todo.md`, `docs/`) to know what we already have, so you don't suggest duplicates.
2. **Filter by legality and fit** — skip anything involving illegal downloads, Bittorrent/Soulseek integration, or any download orchestration tool (Lidarr etc.). mStream serves files the user already owns.
3. **Know our existing integrations** — Last.fm (scrobbling + similar-artists API, `S.lastfmEnabled` / `S.lastfmHasApiKey`), ListenBrainz (scrobbling + now-playing), Discogs (album art), AcoustID/MusicBrainz (fingerprint, in todo). Do not suggest adding something we already have.
4. **Know our player** — 8-band EQ (not 10-band), crossfade, gapless, ReplayGain, Auto-DJ (random + similar-artists modes), sleep timer, transcode. Check before claiming these are missing.
5. **Rate by effort** — split findings into "low effort / directly applicable" vs "more analysis needed" before presenting them. Only suggest adding to `todo.md` after this triage.
