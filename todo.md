# mStream v2 TODO

---

## NOW — In Progress / Remaining

### ~~⚠️ File-Write Access Check~~ — Phase 1 ✅ DONE (admin test), Phase 2 still open

**Phase 1 — Admin directory access test (implemented v5.16.10):**
- [x] `GET /api/v1/admin/directories/test` — write/read/delete a uniquely-named temp file per vpath, no artifact left
- [x] Admin UI: "Test Access" button in Directories card → modal with per-directory read/write indicators, storage-type badge (Linux local/mounted, Windows local/network, macOS local/external, Electron desktop app), and platform-specific fix advice

**Phase 2 — Automatic gating of write features (still to do):**
- [ ] Server: expose `vpathWriteAccess: { [vpath]: bool }` on `GET /api/v1/ping` (admin-only field); re-check on rescan
- [ ] Client: read into `S.vpathWriteAccess`; helper `_canWriteVpath(song)` returns bool
- [ ] Gate Discogs "Search Album Art" button: hide/disable when `!_canWriteVpath(song)` (except cache-only formats WAV/AIFF/W64)
- [ ] Gate future ID3 Tag Editor with the same helper
- [ ] Show tooltip on disabled button: "mStream does not have write access to this folder"

---

### Subsonic / OpenSubsonic API — compliance audit & further testing

> See `docs/subsonic.md` for the full implementation reference.

- [ ] **Auth**: verify `enc:` hex-encoded password variant works (some clients use it instead of MD5 token)
- [ ] **`getIndexes`**: confirm `ifModifiedSince` filtering behaves correctly — currently ignored, always returns full list
- [ ] **`getMusicDirectory`**: test with DSub, Ultrasonic, Jamstash — confirm folder hierarchy and parent-id navigation work in each client
- [ ] **`search2` / `search3`**: test wildcard edge-cases and empty-query behaviour across clients
- [ ] **`getAlbumList` / `getAlbumList2`**: audit `byYear`, `byGenre`, `newest`, `recent`, `random`, `alphabeticalByName/Artist`, `starred` — compare response shape with OpenSubsonic reference
- [ ] **`getArtistInfo` / `getArtistInfo2`**: currently returns empty biography — wire up local cache or skip gracefully
- [ ] **`getAlbumInfo` / `getAlbumInfo2`**: stub; add LastFM/Discogs info when available
- [ ] **`getSimilarSongs` / `getSimilarSongs2`** and **`getTopSongs`**: currently empty — investigate Listenbrainz / last.fm fallback
- [ ] **Bookmarks**: `getBookmarks` / `saveBookmark` / `deleteBookmark` — verify persistence and that multiple clients share bookmarks correctly
- [ ] **Playlists**: `createPlaylist`, `updatePlaylist`, `deletePlaylist` — end-to-end test with Substreamer and Nautiline
- [ ] **Scrobble**: currently a no-op; consider wiring to the same play-count path as the native player
- [ ] **`stream` transcoding**: `maxBitRate` and `format` params are currently ignored — document this limitation
- [ ] **`getOpenSubsonicExtensions`**: returns `formPost: 1` — test POST auth with at least one client
- [ ] **`createUser` / `updateUser` / `deleteUser`**: confirm round-trip through admin API and that subsonic-password is preserved on update
- [ ] **XML format**: run a quick smoke-test with a client that defaults to XML (e.g. DSub) to verify the XML serialisation is well-formed
- [ ] Once testing token budget allows: run through the full [OpenSubsonic conformance checklist](https://opensubsonic.netlify.app/)

---

### Admin Area — GUIv2 ✅ (skipped — already done by user)

### Smart Playlists

> Note: an earlier prototype was removed in commit `d8e224fe` — needs a clean re-implementation.

- [ ] Add `GET /api/v1/db/smart-playlist` endpoint accepting filters: `genre`, `yearFrom`, `yearTo`, `neverPlayed`, `limit`
- [ ] Add a "Smart Playlist" view in the sidebar with a filter builder UI (genre/decade dropdowns)
- [ ] Wire result into the queue (play-all / replace-queue buttons)
- [ ] Persist the last-used filter per user with `_uKey('smart_pl_filter')`

---

## DONE — Completed features

### Subsonic REST API 1.16.1 + Open Subsonic ✅ (v5.16.17)
- [x] Full `/rest/*` endpoint suite: ping, getLicense, getMusicFolders, getIndexes, getArtists, getArtist, getAlbum, getSong, getMusicDirectory, search2/3, getAlbumList/2, getRandomSongs, getSongsByGenre, getGenres, getNowPlaying, getStarred/2, star, unstar, setRating, scrobble, stream, download, getCoverArt, getLyrics, getUser, getUsers, getPlaylists + CRUD, getBookmarks + CRUD, getScanStatus, getOpenSubsonicExtensions, createUser, updateUser, deleteUser, changePassword
- [x] MD5 token auth (`?t=&s=`) + plaintext auth (`?p=`); separate `subsonic-password` field per user
- [x] `openSubsonic: true` + `type: "mstream"` in every response
- [x] Admin UI: Password modal has separate mStream and Subsonic password fields
- [x] Player UI: "Subsonic API" nav item shows server URL, password change form, connection hints
- [x] DB: `getFilesByArtistId/AlbumId`, `getSongByHash`, `getStarredSongs/Albums`, `setStarred`, `getRandomSongs`, `getAllAlbumIds/ArtistIds` (SQLite + Loki)

### Subsonic DB prerequisites ✅ (v5.16.16)
- [x] `artist_id` + `album_id` columns in `files` table (indexed) — computed as `MD5(normalised name).slice(0,16)`
- [x] `starred` column in `user_metadata` table
- [x] One-time backfill at startup for all 137k existing records (SQLite + Loki)
- [x] Scanner computes IDs for all new files at scan time
- [x] `updateFileTags` recomputes IDs when artist/album is edited

### Dynamic colour extraction from album art ✅ (v5.16.15)
- [x] Canvas upscaled 8×8 → 32×32 for better hue separation
- [x] Winner-takes-all replaced with 36 hue-bucket scoring (Σ s²)
- [x] Readability clamping (L and S ranges) preserved unchanged

### Balance reset button alignment ✅ (v5.16.15)
- [x] `vertical-align: text-top` → `middle` on `.bal-center-btn`

### Upload in GUIv2 ✅
- [x] `S.canUpload` set from `noUpload` flag in the `/api/v1/ping` response on login
- [x] **Upload** button in File Explorer toolbar — visible only when `S.canUpload === true` and not at the root `/`
- [x] Modal with drag-and-drop zone + browse-files button; files validated against `supportedAudioFiles` before queuing
- [x] Per-file XHR progress bars; status icons (`✓` / `✗` / `…`) per file
- [x] Auto-closes modal on completion; calls `viewFiles()` to refresh the file list immediately
- [x] Success and error toasts with file count; `toastError()` for rejected file types

### Gapless Playback ✅

Client-side gapless is complete. Scan-time silence detection moved to FUTURE.

- [x] Client: `_gaplessTimer` fires 80 ms before end, starts next element; 20 ms ramp eliminates bass thump
- [x] Toggle in Playback settings; persisted with `_uKey('gapless')`; mutually exclusive with crossfade

### ReplayGain / Loudness Normalization ✅
- [x] At scan time, read ReplayGain tags from file metadata (`replaygain_track_gain`) and store `replaygainTrackDb` in the DB
- [x] Expose `replaygain-track-db` on song objects returned by all DB endpoints
- [x] Client: apply gain as a Web Audio `GainNode` (`_rgGainNode`) offset (dB → linear) when a track starts
- [x] Add ReplayGain on/off toggle (`#rg-enable`) to the Playback settings view; persist with `_uKey('rg')`
- [x] Pre-gain both the main and crossfade elements through the same `_rgGainNode` so transitions have no loudness jumps

### Waveform Scrubber ✅
- [x] Server: `GET /api/v1/db/waveform?filepath=…` endpoint (`src/api/waveform.js`) — `ffmpeg` extracts raw PCM, downsamples to ~1000 points, returns JSON float array; result cached to `waveformDirectory`
- [x] Client: `<canvas>` waveform renderer replaces flat `#prog-track` bar
- [x] Waveform drawn with `--primary` → `--accent` gradient; played/unplayed split tracks current position at 60 fps via RAF
- [x] Falls back gracefully to flat bar if waveform endpoint unavailable; survives F5 via `restoreQueue` hook
- [x] Waveform cache separated from image-cache (`waveformDirectory` config key; documented in `docs/json_config.md`)
- [x] Generation status shown in player bar during scan

### Genre & Decade Views ✅
- [x] Server: `GET /api/v1/db/genres` returns distinct genres with track counts; `genre-merge.js` normalises multi-value fields, merges near-duplicates, folds genres with < 10 songs into nearest larger genre
- [x] Server: `GET /api/v1/db/decades` returns albums grouped by decade; `GET /api/v1/db/decade/albums` drills into a decade
- [x] **Genres** and **Decades** nav entries in the sidebar
- [x] Genre list → drill into genre → song list (reuses existing song-list renderer)
- [x] Decade timeline → album grid (virtual-scroll, same grid as Albums view)

### Similar Artists Auto-DJ ✅
- [x] When Auto-DJ starts, call `artist.getSimilar` via `GET /api/v1/lastfm/similar-artists`; built-in API key — no user account required
- [x] Returned artist names bias the `random-songs` query (`artist IN (…)` filter)
- [x] Fall back to plain random with a toast when Last.fm is unreachable or returns no matching library artists
- [x] "Similar Artist Radio" toggle (`#dj-similar`) in the Auto-DJ settings view; persisted with `_uKey('djSimilar')`
- [x] Artist cooldown window — no same artist repeated within last 8 picks
- [x] Seek arrow hidden on song change / crossfade; DJ artist history persisted across page reloads

### Dynamic Album-Art Colour Theming ✅
- [x] Client: when album art changes, draw it to a hidden `<canvas>` and use `getImageData` to sample a grid of pixels
- [x] Compute dominant non-neutral colour; skip near-white (l > 0.88) and near-black (l < 0.08) pixels
- [x] Apply the colour as `--primary` and `--accent` (hue rotated 35°) via `document.documentElement.style.setProperty`
- [x] Ensure sufficient contrast — clamp lightness; reset to defaults on greyscale or no-art
- [x] User toggle "Dynamic colours" (`#dyn-color-enable`) in Playback settings; stored as `_uKey('dyn_color')` = `'0'` when off (default ON = key absent)

### Media Session API ✅
- [x] Set `navigator.mediaSession.metadata` (title, artist, album, artwork) whenever the current track changes
- [x] Wire `mediaSession.setActionHandler` for: `play`, `pause`, `previoustrack`, `nexttrack`, `seekto`
- [x] Update `navigator.mediaSession.playbackState` (`'playing'` / `'paused'`) in `_onAudioPlay` / `_onAudioPause`
- [x] Update `navigator.mediaSession.setPositionState` in `_onAudioTimeupdateUI`, throttled to 1 Hz via `_msPosThrottle`

### Last.fm Scrobbling & NP Indicator ✅
- [x] Session-key auth flow: admin stores API key/secret; users connect their account via `/api/v1/lastfm/connect`
- [x] Scrobble fires 30 s into playback (both `playAt` and `_onAudioMediaChange` timers, async try/catch)
- [x] NP modal shows `Last.fm: Scrobbled ✓` (green fade-in) or error message (red) in a reserved 4th line; status preserved when modal is reopened mid-track

### Queue Drag-and-Drop Reordering ✅
- [x] Queue items are draggable; drop reorders the in-memory queue array and re-renders
- [x] Active item auto-scrolls to centre with smooth animation

### Touch / CleverTouch UX fixes ✅
- [x] `roundRect` polyfill for older Chromium; VU meter always full brightness
- [x] Search CPU stall + race condition fixed for CleverTouch hardware
- [x] General touch interaction improvements (scroll, tap targets)

---

## FUTURE — Library Management

### Discogs URL: Direct Release Lookup (art + tags from a single URL)

Instead of searching Discogs by metadata, let the user paste a Discogs release or master URL and have mStream fetch the cover art and all tag fields in one shot — no searching, no ambiguity.

**How it works:**
- User pastes `https://www.discogs.com/release/1234567-…` or `.../master/1234567` into a field in the Now Playing modal
- Client extracts the numeric ID and type (`release` / `master`) from the URL with a regex — no round-trip needed for parsing
- If `master`, server auto-resolves to the main release version via `GET /api/v1/discogs/release?type=master&id=…`
- Single API call returns: `artist`, `title`, `year`, `label`, `catno`, `genres`, full `tracklist[]`, and primary cover image (base64 thumb for preview + full-res embed URI)
- Metadata note: image fetch (`i.discogs.com`) requires the Discogs `Authorization` header — art works when API key is configured; without a key only tag metadata is returned
- User can choose to apply: **cover art only**, **tags only**, or **both** — matching the existing embed pipeline (`POST /api/v1/discogs/embed`)

**Why this is better than search for known releases:**
- Zero ambiguity — user picked the exact release on Discogs.com themselves
- No search quota consumed (1 call vs 3–10 search calls)
- Fetches full tracklist, label, catalog number — fields the current search flow doesn't expose

**Implementation steps:**
- [ ] Server: `GET /api/v1/discogs/release?id=<id>&type=release|master` — call `discogsGet()`, for master issues second call to get main release; return flattened `{ artist, title, year, label, catno, genres[], tracklist[], thumb: base64 | null }`
- [ ] Client NP modal: add "Discogs URL" text input below the existing art grid; on paste/submit extract ID + type and call the new endpoint
- [ ] Pre-fill all ID3 tag form fields from the response; show cover thumbnail preview
- [ ] Apply buttons: "Art + Tags", "Art Only", "Tags Only" — art path reuses existing `POST /api/v1/discogs/embed`, tag path reuses `POST /api/v1/admin/tags/write`
- [ ] Graceful fallback: if API key is missing, grey out the "Art" buttons with tooltip "Discogs API key required for image download" but still allow tag fill

---

### Inline Tag Editor
- [ ] Server: add `PUT /api/v1/db/tag` endpoint — accept `{ filepath, title, artist, album, year, genre, trackNumber }`, write ID3/FLAC tags via a Node library (e.g. `music-metadata` + `node-id3`), re-index the track
- [ ] Client: add an "Edit Tags" option to the song context menu
- [ ] Render a modal form pre-filled with current metadata; submit on save
- [ ] Show a toast and refresh the current view on success

### Duplicate Detector
- [ ] Server: add `GET /api/v1/db/duplicates` — return groups of tracks sharing identical `(artist, title, duration ±2s)` or matching acoustic fingerprint (AcoustID via `fpcalc`)
- [ ] Client: add a "Duplicates" entry under the admin section of the sidebar (admin-only)
- [ ] Render duplicate groups with side-by-side metadata diff; allow selecting which to keep
- [ ] Provide a "Delete file" action (admin-only, calls existing file-delete endpoint)

### Bulk Download as ZIP
- [ ] Server: add `POST /api/v1/download/zip` — accept array of filepaths, stream a ZIP archive using `archiver`
- [ ] Client: add "Download Album" button on album detail views and "Download Playlist" on playlist views
- [ ] Show a progress toast while the stream downloads; handle abort

### Gapless — scan-time silence trimming *(optional enhancement)*
The 80 ms timer-based gapless works well for most content. This would improve albums with deliberate silence gaps:
- [ ] Server: detect `silence_end_ms` / `silence_start_ms` per track via `ffmpeg silencedetect` at scan time; store in DB (schema change required)
- [ ] Client: use DB silence offsets instead of fixed 80 ms window when available

### User Settings in DB instead of localStorage
Currently all user preferences (ReplayGain, Gapless, Dynamic Colours, crossfade, shuffle, etc.) are stored in `localStorage` with a username-scoped key. This means settings are **per-browser** — a user loses their preferences on a new device or different browser.
- [ ] Add a `user_settings` table to the DB (key/value per username)
- [ ] Add `GET /api/v1/settings` and `PUT /api/v1/settings` endpoints
- [ ] On login: fetch settings from server and hydrate `S` state + `localStorage` as a local cache
- [ ] On change: write to `localStorage` immediately (fast), debounce a PUT to the server (sync in background)
- [ ] Covers: `rg`, `gapless`, `dyn_color`, `crossfade`, `shuffle`, `repeat`, `vol`, `balance`, `djSimilar`, `trans_*`, `smart_pl_filter`, and future settings
- [ ] **Playlist resume / position sync**: also persist the active queue (ordered list of filepaths) + current index + seek position in `user_settings` — on login, restore queue and seek to saved position. This solves the iOS/Android "restarts from first song" problem: the app reads the server state on launch, and `localStorage` acts as a fast local cache between sessions. Cross-device resume becomes possible for free once the server is the source of truth.
  - **Storage pattern**: write to `localStorage` immediately on every change (zero latency, works offline); debounce a PUT to server DB every ~10–15 sec and on pause/close. On login/launch: fetch from server and hydrate `localStorage`. If server unreachable: fall back to `localStorage`. Same debounce pattern applies to all other user settings above.

---

## FUTURE — Accessibility & Appearance

### Customizable Themes
Two complementary approaches, both buildable on the same CSS-variable foundation:

---

#### Track A — External / File-based Themes (power users, designers)
All UI colors already live in ~18 CSS custom properties (`--bg`, `--surface`, `--primary`, `--t1`, etc.).
A user theme is simply a file that overrides those variables — no knowledge of the app internals needed.

**How it works:**
- Add a `themes/` folder inside the mStream data directory (next to `save/`)
- Server scans `themes/*.css` on startup and exposes them via `GET /api/v1/themes` (name list)
- Each file is served as a static asset; the client injects a `<link id="user-theme">` tag pointing to the chosen file
- Themes are just plain CSS: `:root { --bg: #0a0a0a; --primary: #ff6b35; }` — nothing app-specific required
- A `themes/README.md` (or docs page) lists all overridable variables with their defaults so theme authors know what to target
- Selected theme name stored in `localStorage` per user, synced to server DB once that feature lands

**Implementation steps:**
- [ ] Create `themes/` dir, add server static route + `GET /api/v1/themes` endpoint that lists `.css` files
- [ ] `applyTheme(name)` — inject/swap `<link id="user-theme">` for file-based themes; toggle `:root.theme-<name>` class for built-ins
- [ ] Appearance settings: show built-in swatches + any discovered file-based themes in a unified grid
- [ ] Docs: publish the full variable reference so the community can share themes

---

#### Track B — In-UI Color Customizer (accessibility / color-blindness support)
A visual picker inside the app that lets any user tune their own palette without touching files.
Critical for accessibility: color-blind users (deuteranopia, protanopia, tritanopia, achromatopsia) each need different contrast strategies that no single built-in theme covers.

**How it works:**
- A "Customize" panel in Appearance settings shows a small live preview (sidebar strip + player bar + a song card)
- Sliders / swatches for: background tone, accent color (hue wheel), text contrast level, border visibility
- WCAG AA contrast ratio computed live (`L1+0.05 / L2+0.05 ≥ 4.5`) and shown as a pass/fail badge — users can see immediately if their combination is legible
- Presets for common color-blind profiles (e.g. "Deuteranopia safe" shifts primary away from red/green, boosts blue/yellow contrast)
- On save: writes the chosen values as inline `document.documentElement.style.setProperty(...)` calls — stored as a small JSON blob in `localStorage` (`_uKey('custom_theme')`) and synced to server DB later
- Dynamic album-art color (`_applyAlbumArtTheme`) is automatically disabled when using a custom palette to avoid overriding the user's accessibility choices

**Implementation steps:**
- [ ] Build a `viewThemeEditor()` panel with live preview, hue wheel for `--primary`, lightness sliders for `--bg`/`--surface`, contrast-ratio display
- [ ] Add 4–5 colorblind-safe presets (deuteranopia, protanopia, tritanopia, high-contrast dark, high-contrast light)
- [ ] Persist the custom variable blob to `localStorage`; apply on startup before first paint to avoid flash
- [ ] Auto-disable dynamic album-art color when a custom/accessibility theme is active
- [ ] Refactor `applyTheme(light: bool)` → `applyTheme(name: string)` to unify built-in + custom + file-based themes under one function

---

#### Theme Persistence — Where themes are saved

This is a first-class concern and must be designed clearly up front.

**Two storage tiers, used together:**

| Who | Where saved | How |
|-----|-------------|-----|
| Admin / power user | `save/themes/<name>.css` on the server | Upload or hand-edit a `.css` file; available to all users of that server instance |
| Any logged-in user | Server DB (`user_settings` table, key `custom_theme`) | Saved via `PUT /api/v1/settings` — survives browser clear, works across devices |
| Any in-browser user (no server write access) | `localStorage` only (`_uKey('custom_theme')`) | Instant, zero latency, no account required; lost on browser data clear |

**Key design rule:** `localStorage` is always the *fast local cache*. On every theme change, write to `localStorage` immediately (no flash on next load), then debounce a PUT to the server in the background. On login, fetch from the server and overwrite the local cache — server is the source of truth for logged-in users. This is the same pattern already planned for all user settings.

**Named theme save/load flow (Track B custom themes):**
- User finishes tuning colours → types a name → clicks "Save Theme"
- Theme is stored as a JSON blob: `{ name, vars: { '--bg': '#…', '--primary': '#…', … } }`
- Admin users get an extra "Publish to server" option — this POSTs the same blob to a new `POST /api/v1/themes` endpoint which writes it as `save/themes/<name>.css` on disk, making it available to everyone on that server
- Non-admin users: theme stays in their `user_settings` + `localStorage` only — fully private to them
- Theme list in Appearance settings shows: built-in themes → server themes (admin-published) → my saved themes (personal)

**Implementation steps:**
- [ ] `GET /api/v1/themes` — list built-in names + scanned `save/themes/*.css` + caller's saved personal themes from `user_settings`
- [ ] `POST /api/v1/themes` (admin only) — accept a `{ name, vars }` blob, write `save/themes/<name>.css`
- [ ] `DELETE /api/v1/themes/:name` (admin only) — remove a server-published theme
- [ ] Client: on theme change → write `localStorage` immediately + debounce PUT to `user_settings`
- [ ] Client: on login → fetch `user_settings.custom_theme` and hydrate `localStorage` + apply
- [ ] Client: "Save Theme" modal with name input; "Publish to server" button visible to admins only
- [ ] Themes applied on startup before first paint (read from `localStorage` synchronously) to avoid flash of default colours

---

**Shared prerequisite for both tracks:**
- [ ] Audit `_updateBadgeFg` and `_applyAlbumArtTheme` — both override `--primary`; they must check a `lockAccent` flag before mutating variables owned by the active theme

---

## FUTURE — Social / Multi-user

### Collaborative Queue (Jukebox)
- [ ] Extend the Jukebox WS protocol to accept `queue-append` messages from any connected session
- [ ] Broadcast queue state changes to all connected clients in the same session
- [ ] Show connected-user avatars/initials in the Jukebox view
- [ ] Add per-track "added by" attribution in the queue panel

### Listening Stats Dashboard
- [ ] Server: add `GET /api/v1/stats/summary?range=7d|30d|all` — return top artists, top albums, top tracks, plays-per-day array, current streak
- [ ] Client: add a **Stats** view in the sidebar
- [ ] Render a plays-per-day sparkline chart (pure canvas, no library dependency)
- [ ] Render top-10 artists / albums / tracks with play counts and mini bar indicators
- [ ] Show current listening streak (consecutive days with at least one play)

---

## LEGACY BURDEN — Marked for Deletion

These items are code or directories that served the old GUI era and are no longer part of the canonical path.
They are kept temporarily for safety (backward compat, cache warm-down, reference) but **must be removed**
before the clean branch becomes `main`. Check each item off when confirmed safe to delete.

### Directories

- [x] ~~**`webapp/admin/`**~~ — old upstream admin deleted.

- [x] ~~**`webapp/admin-v2/`**~~ — renamed to `webapp/admin/`; server mount updated to `admin-v2` → `admin`.

- [ ] **`webapp/v2/`** — the main UI directory, still named `v2` from the old routing era.
  Should be renamed to something neutral (e.g. `webapp/player/` or `webapp/app/`) when convenient.
  _After renaming: update the `res.sendFile(...)` call at `GET /` in `src/server.js` and the absolute asset paths
  in `webapp/v2/index.html` (`/v2/style.css`, `/v2/app.js`)._

- [ ] **`webapp/alpha/`** — an unmaintained Vue.js prototype player. No route serves it.
  **Safe to delete immediately.**

- [ ] **`webapp/old.html`** — a standalone HTML file at the webapp root. Likely an old index backup.
  Verify no route or link references it, then delete.

- [x] ~~**`webapp/index.html`** (classic UI)~~ — `/classic` route removed (returns 410). Directory still on disk;
  delete `webapp/index.html` and all classic-specific assets when ready.

### Server routes (`src/server.js`)

- [x] ~~`/admin-v2` redirect~~ — removed
- [x] ~~`/v2` and `/v2/` redirects~~ — removed
- [x] ~~`/v2/site.webmanifest` route~~ — removed
- [x] ~~`/old-admin` route block + static mount~~ — removed
- [x] ~~`/classic` route (serving classic UI)~~ — replaced with 410 Gone stub

### Client code (`webapp/v2/`)

- [x] ~~`classic-admin-btn`~~ — removed from `index.html`
- [x] ~~`classic-player-btn`~~ — removed from `index.html`
- [x] ~~`classic-login-link`~~ — removed from `index.html`
- [x] ~~All `ms2_show_classic` localStorage checks in `app.js`~~ — removed
- [x] ~~`.classic-link` CSS rules in `style.css`~~ — removed


