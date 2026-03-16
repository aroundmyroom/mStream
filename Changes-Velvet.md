# mStream Velvet — Change Log

> Canonical changelog for the `velvet-master` branch.
> Covers all changes to `webapp/`, `webapp/admin/`, `src/`, and supporting files.

---

## v5.16.20-velvet — 2026-03-16

### Auto-DJ: fix heap spike — COUNT+OFFSET instead of full table load

**Problem:** The no-filter (pure random) Auto-DJ path called `getAllFilesWithMetadata` which did `SELECT *` across all rows, loading the entire 123K-song library into Node.js heap on every pick (~50 MB per request). With concurrent users or rapid track changes this could accumulate without being freed promptly.

**`src/db/sqlite-backend.js`**
- `countFilesForRandom(vpaths, username, opts)`: `SELECT COUNT(*)` with the same WHERE filters (vpath, minRating, filepathPrefix, ignoreArtists) — cheap index-only query, nothing in heap
- `pickFileAtOffset(vpaths, username, opts, offset)`: `SELECT … LIMIT 1 OFFSET ?` — fetches exactly one row
- Internal `_buildRandomWhere()` helper shared by both, keeping WHERE logic DRY

**`src/db/loki-backend.js`**
- `countFilesForRandom()` / `pickFileAtOffset()` stubs returning `0` / `null` — Loki is an in-memory store so pulling all rows is normal; returning 0 causes api/db.js to fall through to the existing full-load path

**`src/db/manager.js`**
- Proxy exports for `countFilesForRandom` and `pickFileAtOffset`

**`src/api/db.js`** (`POST /api/v1/db/random-songs`)
- No-filter path now: `COUNT(*)` → pick random offset in `[0, count)` skipping ignored offsets → `LIMIT 1 OFFSET n` — O(1) heap regardless of library size
- ignoreArtists-exhaustion fallback retries with the lean path too, not the full load
- Artist-filter path (similar-artists mode, small result set) unchanged — still uses two-stage fair selection on the full filtered array
- Loki / zero-count fallback: falls through to the original `getAllFilesWithMetadata` path (no regression for Loki users)

---

## v5.16.19-velvet — 2026-03-16

### Auto-Resume setting, nav reorganisation, auth log noise reduction

**`webapp/app.js`**
- Added `autoResume` preference stored in localStorage (`ms2_auto_resume_<user>`) — default OFF (music is always paused on reload unless the user opts in)
- `restoreQueue()` now gates auto-play behind `S.autoResume`; previously playback always resumed on page reload
- New "Auto-Resume" section in Playback Settings view with a toggle and explanatory hint text
- Tools sidebar section now starts collapsed by default (hard-coded alongside user-stored collapsed state)

**`webapp/index.html`**
- "Playback Settings" button moved from the Tools nav section up to the top-level (always visible, above Tools)
- New "Connectors" nav section added, containing Last.fm, Discogs, and Subsonic API nav buttons (previously scattered in Tools)
- Tools section now contains only: Shared Links, Play History

**`src/server.js`**
- Auth failure logging: 401/403 on non-mStream paths (internet scanner probes) downgraded from `warn` to `debug` — only real mStream routes (`/api/`, `/rest/`, `/media/`, `/album-art/`, `/waveform/`) log at `warn` level

---

## v5.16.18-velvet — 2026-03-15

### Subsonic: Folders navigation, folder art, getCoverArt fixes, performance

**`src/api/subsonic.js`**
- `getIndexes`: rewritten for folder-browsing clients (e.g. Substreamer Folders tab)
  - No `musicFolderId` → returns vpaths as top-level entries so user sees "Music, 12-inches, Disco…" instead of a flat artist list
  - `musicFolderId=N` → returns first-level filesystem directories of that vpath, A-Z indexed
- `getMusicDirectory`: full real-filesystem hierarchy browsing using `getDirectoryContents()` — three cases: vpath root (integer id), encoded sub-directory (`d:…`), legacy album_id fallback
- `makeDirId()` / `parseDirId()`: opaque base64url-encoded directory IDs carrying `{v: vpath, p: relPath}`
- Debug request logging middleware on `/rest/*`: logs every Subsonic request to mStream log files with password scrubbed
- `getCoverArt`: handles folder IDs (`d:…`, vpath integers) — resolves to real album art via `getAaFileForDir`; falls back to SVG folder icon; bare album_id / artist_id / song_hash looked up via `getAaFileById`; literal `"null"` id returns 404; folder art responses include `Cache-Control: public, max-age=86400`
- `serveFolderIcon()`: inline SVG folder icon served for directories with no art (transparent background, indigo folder shape)

**`src/db/sqlite-backend.js`**
- `getDirectoryContents(vpath, dirRelPath, username)`: returns `{dirs: [{name, aaFile}], files:[]}` via `GROUP BY + MAX(aaFile)` per sub-directory; full user metadata join on files
- `getAaFileById(id)`: resolves bare album_id / artist_id / song_hash → aaFile filename
- `getAaFileForDir(vpath, dirRelPath)`: resolves a directory path → representative aaFile; results cached in `_aaFileForDirCache` (Map) for O(1) repeat lookups
- Covering index `idx_files_vpath_filepath_aa (vpath, filepath, aaFile)` added — makes initial `getAaFileForDir` queries index-only

**`src/db/loki-backend.js`**
- Same `getDirectoryContents`, `getAaFileById`, `getAaFileForDir` + in-memory cache added

**`src/db/manager.js`**
- New proxy exports: `getDirectoryContents`, `getAaFileById`, `getAaFileForDir`, `clearAaFileForDirCache`

**`src/db/task-queue.js`**
- `db.clearAaFileForDirCache()` called when a file scan completes so stale art lookups are evicted

---

## v5.16.17-velvet — 2026-03-16

### Subsonic REST API 1.16.1 + Open Subsonic extensions

**`src/api/subsonic.js`** — new file
- Full Subsonic 1.16.1 REST API with `openSubsonic: true` in every response
- All responses carry `type: "mstream"` and `serverVersion` per Open Subsonic spec
- Auth: MD5 token auth (`?t=MD5(password+salt)&s=salt`) and plaintext (`?p=`) both supported; separate `subsonic-password` field on each user enables standard Subsonic apps to connect without conflicting with mStream's PBKDF2 password
- XML and JSON response formats (`?f=xml|json`), JSONP supported
- Endpoints: `ping`, `getLicense`, `getMusicFolders`, `getIndexes`, `getArtists`, `getArtist`, `getAlbum`, `getSong`, `getMusicDirectory`, `search2`, `search3`, `getAlbumList`, `getAlbumList2`, `getRandomSongs`, `getSongsByGenre`, `getGenres`, `getNowPlaying`, `getStarred`, `getStarred2`, `star`, `unstar`, `setRating`, `scrobble`, `stream`, `download`, `getCoverArt`, `getLyrics`, `getUser`, `getUsers`, `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist`, `getBookmarks`, `saveBookmark`, `deleteBookmark`, `getScanStatus`, `getOpenSubsonicExtensions`, `createUser`, `updateUser`, `deleteUser`, `changePassword` + stub responses for podcast/radio endpoints
- `stream`/`download` use `res.sendFile()` directly (no JWT redirect); `getCoverArt` reads from albumArtDirectory directly — no 401 on media/art requests from Subsonic clients
- `buildSong()` maps DB rows to Subsonic objects including replayGain, starred, playCount, genre, track, disc, year, contentType, suffix
- Child vpath support: `getVpathMeta()` detects sub-folder vpaths at startup; `resolveVpaths()` maps them to their DB parent; `resolvePrefix()` derives the filepath prefix — `musicFolderId` filtering now works correctly across all 5 vpaths including nested sub-folders

**`src/db/sqlite-backend.js` / `src/db/loki-backend.js`**
- New query functions: `getFilesByArtistId`, `getFilesByAlbumId`, `getSongByHash`, `getStarredSongs`, `getStarredAlbums`, `setStarred`, `getRandomSongs`, `getAlbumsByArtistId`, `getAllAlbumIds`, `getAllArtistIds`
- `setStarred` uses UPSERT pattern — creates or updates `user_metadata` row
- All Subsonic browse functions accept `opts.filepathPrefix` for sub-folder filtering; `prefixClause()` helper added to sqlite backend; loki backend uses regex chain condition

**`src/db/manager.js`**
- Proxy exports added for all ten new DB functions; all Subsonic browse proxies accept and forward `opts` parameter

**`src/util/admin.js`**
- `editSubsonicPassword(username, password)` — stores plaintext subsonic password on user config (same pattern as `editUserPassword`)

**`src/api/admin.js`**
- `POST /api/v1/admin/users/subsonic-password` — set subsonic password for any user (admin only)
- `GET /api/v1/admin/users` now scrubs `subsonic-password` from the response (same as regular password scrubbing)

**`src/server.js`**
- `subsonicApi.setup(mstream)` registered before `authApi.setup()` so Subsonic routes bypass mStream session auth and use their own auth middleware

**`webapp/admin/index.js`**
- Password modal now has two separate fields: "New mStream Password" and "New Subsonic Password"; each is optional — blank = skip; validation requires at least one field filled

**`webapp/index.html`**
- "Subsonic API" nav button added to sidebar (always visible)

**`webapp/app.js`**
- `viewSubsonic()` — shows server URL with copy button, subsonic password change form, and connection hint card (username, API path, token auth note)

---

## v5.16.16-velvet — 2026-03-15

### DB: Add artist_id / album_id / starred columns for Subsonic readiness

**`src/db/sqlite-backend.js`**
- New helper functions `_makeArtistId(artist)` and `_makeAlbumId(artist, album)` — 16-char hex MD5 slugs, collision-free at any practical library size
- `files` table: added `artist_id TEXT` and `album_id TEXT` columns (new DBs) + ALTER TABLE migrations for existing DBs
- `user_metadata` table: added `starred INTEGER DEFAULT 0` column (new DBs) + migration for existing DBs
- Indexes `idx_files_artist_id` and `idx_files_album_id` created via migrations (idempotent on every startup)
- One-time startup backfill: computes and stores `artist_id`/`album_id` for all 137k existing records in a single BEGIN/COMMIT transaction

**`src/db/loki-backend.js`**
- Same ID helpers added
- `fileCollection.ensureIndex('artist_id')` and `ensureIndex('album_id')` on every init
- In-memory backfill for any docs loaded without these fields
- `updateFileTags()` recomputes `artist_id`/`album_id` when artist or album is edited

**`src/db/scanner.mjs`**
- Computes `artist_id` and `album_id` at scan time and sends them in the `add-file` payload — new files get correct IDs immediately without waiting for a backfill

---

## v5.16.15-velvet — 2026-03-14

### Improve: dynamic colour extraction from album art

**`webapp/app.js`**
- Canvas scaled up from 8×8 (64 px) to 32×32 (1024 px) — far less blurring, hues stay distinct
- Replaced single-pixel winner-takes-all with 36 hue buckets (10° each), scored by Σ s² per bucket — balances vibrancy and prevalence so the *characteristic* colour of the cover wins
- Effective distinct colour range increases from ~8 broad zones to 36 discrete hue zones
- All lightness/saturation clamping and readability guarantees unchanged

### Fix: Balance reset button vertical alignment

**`webapp/style.css`**
- `⊙` reset button was 1–2 px too high; changed `vertical-align` from `text-top` to `middle`

### Revert: artLegacy stat (not needed)

**`src/db/sqlite-backend.js`, `src/db/loki-backend.js`, `webapp/admin/index.js`**
- Removed the startup backfill migration and `artLegacy` counter added in previous session — pre-existing NULL `art_source` records will simply not appear in per-source counts, which is the correct behaviour going forward

---

## v5.16.14-velvet — 2026-03-14

### Now Playing label: shows Crossfade status alongside Auto-DJ

**`webapp/app.js`**
- Sub-label now reads `· Auto-DJ: Similar Songs & Crossfade` (or `· Auto-DJ & Crossfade`) when crossfade is active (`S.crossfade > 0`), and falls back to the previous text when crossfade is off
- Both crossfade sliders (DJ panel + Settings panel) now call `_syncQueueLabel()` on `input` so the header updates in real-time as the slider is dragged

---

## v5.16.13-velvet — 2026-03-14

### Fix: VU meter peak lamp glow clipped at top of canvas

**`webapp/app.js`**
- Virtual drawing height `VH` increased from `120` to `134` — adds 14 units of headroom above the arc without moving any needle/arc geometry (pivot `CY=VH` stays at the canvas bottom)
- Peak lamp `lampY` moved from `10` → `24` so the radial glow (radius 20) clears the canvas top edge with 4 units to spare
- Channel label `y` updated `12` → `26` to stay visually aligned with the arc top

---

## v5.16.12-velvet — 2026-03-14

### Fix: search bar loses focus after results arrive

**`webapp/app.js`**
- Removed the `inp.blur()` calls in `doSearch()` that intentionally defocused the search input after results loaded. This was causing the spacebar to fire play/pause instead of inserting a space, because focus had left the `<input>` and the global keydown handler's INPUT guard no longer applied.

---

## v5.16.11-velvet — 2026-03-14

### Admin stats: Total Library Duration

**`src/db/sqlite-backend.js`** / **`src/db/loki-backend.js`**
- `getStats()` now returns `totalDurationSec` — sum of all `duration` values in the files table (SQLite: single `SUM()` query; Loki: accumulator in the doc loop)

**`webapp/admin/index.js`**
- New stat chip **"Total Library Duration"** shown after Waveforms Cached — formatted as `Xd Yh Zm` (days, hours, minutes)
- Hidden when no duration data is available (e.g. library not yet scanned)

---

## v5.16.10-velvet — 2026-03-14

### Admin: Directory access test

**`src/api/admin.js`**
- New `GET /api/v1/admin/directories/test` endpoint (admin-only): iterates every configured vpath, writes a uniquely-named temp file, reads it back, deletes it, and reports `{ readable, writable, storageType, error }` per directory — no artifact is ever left on disk

**`webapp/admin/index.js`**
- New **"Test Access"** button in the Directories card header — opens a modal that immediately runs the check and shows per-directory read/write status
- Storage type is auto-detected and shown as a badge: Linux local, Linux mounted drive, Windows local drive, Windows network share, macOS local, macOS external, or Desktop App (Electron)
- Results use green ✓ / amber ✓ / red ✗ indicators; any OS error code is shown inline
- Advice panel at the bottom adapts to the overall result: all-good confirmation, or platform-specific instructions to fix permissions (Linux/macOS `chown`+`chmod`, Windows Security properties)

---

## v5.16.9-velvet — 2026-03-13

### Waveform overhaul — RMS + γ=0.7 + 8 kHz sampling

**`src/api/waveform.js`**
- `SAMPLE_RATE` raised from 200 → **8000 Hz**: each display bar now computes RMS over ~5000+ raw PCM samples, producing a naturally smooth energy envelope without any explicit smoothing pass
- `POINTS` set to **600**: each bar renders at ~1.5–2 px wide, matching SoundCloud/Beatport density
- Per-chunk method changed from **mean of absolute values → RMS** (sum of squares → sqrt): properly weights sustained energy without being hijacked by individual noise spikes
- Normalisation ceiling moved from p98 → **p99**; noise gate added at 0.1% of p99 to silence true DC offset / digital black
- Loudness curve changed from **linear → γ=0.7 power curve**: quiet breakdowns (2% of peak) render at ~8% bar height (visible but clearly quiet); loud 40–100% range maps to 53–100% (47% spread — kick, hi-hat, drop all distinct)
- 11 existing waveform cache files cleared so they regenerate with the improved algorithm

---

## v5.16.8-velvet — 2026-03-13

### Discogs cover-art search parallelized

**`src/api/discogs.js`**
- Phase 1 (search queries): all Discogs search requests now fire simultaneously via `Promise.allSettled` instead of sequentially — results are collected in original priority order
- Phase 2 (image resolution): all candidate master-resolve + release-fetch + image-download chains fire in parallel — worst-case round-trip drops from ~10–15 s to ~1–2 s
- One failed Discogs call no longer blocks the others

---

## v5.16.7-velvet — 2026-03-13

### Crossfade slider added to Auto-DJ settings

**`webapp/app.js`**
- Auto-DJ settings view (`viewAutoDJ`) now includes a **Crossfade Duration** row with a `0–12 s` range slider, matching the one in Playback Settings
- Both sliders read from and write to the same `S.crossfade` state variable and the same `ms2_crossfade_<user>` localStorage key — changing one is immediately reflected in the other if both views were somehow in the DOM simultaneously
- Slider uses existing `.xf-ctrl` / `.xf-slider` / `.xf-val` CSS classes for consistent look across both panels

---

## v5.16.6-velvet — 2026-03-13

### Waveform percentile normalisation — fixes flat waveforms on tracks with transient peaks

**`src/api/waveform.js`**
- `downsample()` now normalises against the **98th percentile** of bar values instead of the absolute maximum
- Previously a single loud transient (e.g. one drum hit) became the global max, compressing the entire rest of the track to ~20% height
- Now the 2% loudest spikes clip to 255 and everything else scales against realistic programme loudness — waveforms are consistently tall and readable across all track types
- All 602 stale waveform cache files wiped; tracks regenerate on next play

---

## v5.16.5-velvet — 2026-03-13

### Track duration stored in DB and exposed via API

**`src/db/scanner.mjs`**
- `parseMyFile()` now extracts `format.duration` from the `music-metadata` parse result and stores it as `songInfo._duration` (seconds, float, 3 decimal places; `null` if not present or non-finite)
- `insertEntries()` passes `duration` through to the `add-file` API call

**`src/db/sqlite-backend.js`**
- `duration REAL` column added to the `files` table schema
- Migration: `ALTER TABLE files ADD COLUMN duration REAL` runs silently on existing databases
- `insertFile()` now stores `duration`

**`src/db/loki-backend.js`**
- No changes needed — Loki stores documents as plain objects so `duration` persists automatically

**`src/api/db.js`**
- `renderMetadataObj()` now includes `"duration"` in every track metadata response
- Covers all track-returning endpoints: `/api/v1/db/metadata`, `/album-songs`, `/search`, `/rated`, `/recent/added`, `/stats/recently-played`, `/stats/most-played`, `/random-songs`, `/playlist/load`, `/genre/songs`
- Value is seconds as a float (e.g. `237.431`); `null` for tracks not yet rescanned

---

## v5.16.4-velvet — 2026-03-13

### webapp moved to root; theme-aware canvas rendering; media-query specificity fix

**`webapp/app.js`** (moved from `webapp/v2/app.js`)
- All canvas drawing functions (`drawIdle`, spectrum analyser, VU gauge, PPM meter, volume knob) now use explicit `isLight` / `dark` variables — previously all used `!contains('light')` which incorrectly treated Velvet the same as Dark mode
- Waveform unplayed-bar colour is now theme-aware: Light `rgba(0,0,0,0.22)`, Dark `rgba(255,255,255,0.28)`, Velvet `rgba(255,255,255,0.35)` — was a single value that was too faint on both dark backgrounds
- `applyTheme()` now calls `_drawWaveform()` via `requestAnimationFrame` immediately on theme switch so the canvas updates without waiting for the next RAF loop

**`webapp/style.css`** (moved from `webapp/v2/style.css`)
- All `@media` breakpoint `:root` overrides now target `:root,:root.dark,:root.light` — previously plain `:root` was overriding Velvet's `--sidebar` variable at narrower widths due to CSS specificity

**`webapp/index.html`** (moved from `webapp/v2/index.html`)
- Asset paths updated: `/v2/style.css` → `/style.css`, `/v2/app.js` → `/app.js`

**`src/server.js`**
- `sendFile` path updated from `v2/index.html` → `index.html`

**`webapp/v2/`**
- Directory and all contents removed; player now served directly from `webapp/`

---

## v5.16.3-velvet — 2026-03-13

### Player bar position toggle; playback settings 2-column layout; theme selector moved to top of sidebar

**`webapp/v2/app.js`**
- `S.barTop` state property added (persisted as `ms2_bar_top_<user>` in localStorage)
- `applyBarPos(top)` function added — toggles `:root.bar-top` class on `<html>`
- `applyBarPos` called in init IIFE before first render
- Playback Settings → new **Interface** section with Bottom / Top segmented pill for player bar position

**`webapp/v2/style.css`**
- `:root.bar-top` layout rules: flips `#app` grid rows so player occupies the top row, main content the bottom
- Player gradient and box-shadow direction inverted in bar-top mode
- DJ similar-artists strip repositioned to `top: var(--player)` in bar-top mode with reversed slide animation
- DJ dice, toast, and EQ panel (vu-needle mode) all reposition to clear the bar in top mode
- `.playback-panel` changed from single-column `max-width:480px` to always-2-column `grid-template-columns:repeat(2,1fr)` — cards in the same row stretch to equal height
- `.playback-seg` / `.playback-seg-btn` CSS added for use in settings rows
- Theme segmented pill moved from sidebar footer to directly below the logo — margin adjusted (`margin:0 .75rem .55rem`)

**`webapp/v2/index.html`**
- `#theme-seg` moved from inside `.sidebar-footer` to immediately after `.sidebar-brand`

---

## v5.16.2-velvet — 2026-03-13

### 3-theme system: Velvet / Dark / Light; admin light mode fix; true dark mode

Replaced the 2-step blue/light toggle with a 3-step segmented selector across both the player and admin panel. Admin light mode now matches the player light mode exactly.

**`webapp/v2/style.css`**
- `:root` (Velvet) — existing navy/purple palette unchanged
- `:root.dark` added — true near-black (`#000` bg) following Material / Apple dark-mode guidelines
- `:root.dark #login-screen` added — pure-black radial gradient override
- Old `.theme-toggle` / `.theme-toggle-track` / `.theme-toggle-thumb` CSS removed
- `.theme-seg` / `.theme-seg-btn` segmented pill CSS added

**`webapp/v2/index.html`**
- `<button id="theme-toggle">` replaced with `<div id="theme-seg">` 3-button pill (Velvet / Dark / Light)

**`webapp/v2/app.js`**
- `applyTheme(light, persist)` → `applyTheme(theme, persist)` accepting `'velvet'|'dark'|'light'`
- OS colour-scheme listener: dark OS → `'velvet'`, light OS → `'light'`
- Init IIFE: passes saved string theme directly; falls back to OS preference

**`webapp/admin/index.css`**
- `:root` (Velvet), `:root.dark`, `:root.light` — values identical to player
- Old toggle CSS removed; `.theme-seg` pill CSS added

**`webapp/admin/index.html`**
- Early-init script reads `'velvet'|'dark'|'light'` from localStorage
- `<button id="theme-toggle">` replaced with `<div id="theme-seg">` 3-step selector
- `applyTheme()` and button listeners updated

---

## v5.16.1-velvet — 2026-03-13

### Remove all legacy / classic UI code

**`src/server.js`**
- `/classic` returns `410 Gone`
- `/old-admin`, `/admin-v2 → /admin` redirect, `/v2`, `/v2/` routes removed

**`webapp/v2/index.html`**
- Classic login link, classic admin btn, classic player btn removed

**`webapp/v2/app.js`**
- `ms2_show_classic` localStorage checks removed

**`webapp/v2/style.css`**
- `.classic-link` rules removed

---

## v5.16.0-velvet — 2026-03-13

### Routing: retire /v2 and /admin-v2; rename webapp/admin-v2 → webapp/admin

**`src/server.js`**
- `/` serves `webapp/v2/index.html` directly (no redirect)
- `/admin` → `webapp/admin/` (was `webapp/admin-v2/`)
- `/classic` stub kept as `410 Gone`
- All `/v2`, `/admin-v2` compatibility routes removed

**`webapp/admin-v2/` → `webapp/admin/`**
- Directory renamed; server mount path updated

---

## v5.15.3-velvet — 2026-03-10

### Dice crossfade; Discogs compilation fix; art crossfade bg-tab fix; primary-fg tracking; Velvet logo in admin & remote

**`webapp/v2/app.js`**
- DJ dice 3-D cube crossfade animation
- `--badge-fg` / `--primary-fg` tracking updated for live dynamic colour changes
- Background-tab art crossfade fix

**`src/api/discogs.js`**
- Compilation album Discogs search fix

**`webapp/admin-v2/index.html`** / **`webapp/remote/index.html`**
- Velvet gradient logo applied

---

## v5.15.2-velvet — 2026-03-09

### ID3 tag editing; Discogs PTS fix; audio resilience; 416 error handler

**`src/api/admin.js`**
- New ID3 tag editing endpoint

**`src/api/discogs.js`**
- PTS (partial track search) fix

**`webapp/v2/app.js`** / **`webapp/v2/index.html`**
- Audio resilience improvements; 416 range-not-satisfiable error handler

---

## v5.15.1-velvet — 2026-03-09

### Art provenance tracking (`art_source` column)

**`src/db/`** (sqlite + loki backends)
- `art_source` column added to files table (migration via ALTER TABLE)
- Values: `'embedded'` | `'directory'` | `'discogs'`

**`src/api/discogs.js`** / **`src/api/scanner.js`**
- `artSource` param threaded through update-art flow

**`webapp/admin/`**
- Three new stat chips: Art Embedded, Art from Folder, Art via Discogs
