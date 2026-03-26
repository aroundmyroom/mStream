# mStream v2 TODO

---

## NOW — In Progress / Remaining

### 🎙 Podcasts — ✅ DONE (2026-03-21); Save to Library ✅ DONE (2026-03-24)

> See [`docs/podcasts.md`](docs/podcasts.md) for full documentation.

**Phase 0 — Hybrid nav UI** ✅
- [x] Listen sidebar section (`id="podcasts-section"`) — hidden by default
- [x] Revealed when radio enabled OR podcast feed subscribed OR audio-books vpath exists
- [x] `_updateListenSection()` — single source of truth for Listen section visibility
- [x] Nav dispatcher wired (`data-view="podcasts"`, `data-view="podcast-feeds"`)

**Phase 1 — Database** ✅
- [x] `podcast_feeds` + `podcast_episodes` tables (SQLite + Loki); unique `(feed_id, guid)` constraint
- [x] `sort_order` via migration-safe `ALTER TABLE … ADD COLUMN`
- [x] All DB functions: create, get, delete (cascade), upsert episodes, reorder, save progress, art usage count
- [x] `getPodcastEpisode(id)` single-row lookup

**Phase 2 — Backend (`src/api/podcasts.js`)** ✅
- [x] 9 REST endpoints (preview, list, subscribe, reorder, rename, delete, refresh, episodes, progress)
- [x] `POST /api/v1/podcast/episode/save` — stream episode audio to AudioBooks vpath folder; SSRF guard, sanitised naming, streaming pipeline, partial-file cleanup
- [x] SSRF protection on all outbound fetches
- [x] RSS parser handles BBC / NHK / Anchor feeds; dual-format `<itunes:duration>`; HTML stripping
- [x] Cover art downloaded and cached as `podcast-{md5}.{ext}`; orphan-cleanup protected

**Phase 3 — Admin UI** — not needed (no admin toggle; always available per-user)

**Phase 4 — Player UI** ✅
- [x] Feed card grid with cover art, episode count, last-refreshed; drag-reorder
- [x] Subscribe form with URL preview before committing
- [x] Rename / Refresh / Unsubscribe per card
- [x] Episode list with Play button; `Player.playSingle()` with `isPodcast: true`
- [x] External URL guards: waveform fetch + song rating silently skip `http(s)://` filepaths
- [x] Save-to-library button per episode: spinner → green ✓ / red ✕ states; toast on result

---

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
- [x] **`getIndexes`**: `ifModifiedSince` filtering implemented — returns empty `indexes` when library unchanged since given timestamp; `lastModified` now reflects actual last scan time instead of `Date.now()`
- [ ] **`getMusicDirectory`**: test with DSub, Ultrasonic, Jamstash — confirm folder hierarchy and parent-id navigation work in each client
- [ ] **`search2` / `search3`**: test wildcard edge-cases and empty-query behaviour across clients
- [ ] **`getAlbumList` / `getAlbumList2`**: audit `byYear`, `byGenre`, `newest`, `recent`, `random`, `alphabeticalByName/Artist`, `starred` — compare response shape with OpenSubsonic reference
  - [x] **`getArtistInfo` / `getArtistInfo2`**: empty-stub added — returns `{ artistInfo: {} }` to silence client retries; no biography/image fetching
  - [x] **`getAlbumInfo` / `getAlbumInfo2`**: empty-stub added — returns `{ albumInfo: {} }` to silence client retries
  - [x] **`getSimilarSongs` / `getSimilarSongs2`** and **`getTopSongs`**: empty-stubs added — return `{ song: [] }`; proper implementation deferred to audio-analysis feature
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

- [x] Full Smart Playlists feature implemented — filter builder, saved named playlists, CRUD, live preview count
  - Filters: multi-genre, year range, min rating, play status (any/never/played/at-least N), starred, artist search
  - Sort: artist, album, year ↑/↓, top rated, most played, recently played, random
  - API: 6 REST endpoints under `/api/v1/smart-playlists`
  - DB: `smart_playlists` table (SQLite) + in-memory store (Loki)
  - UI: "Smart Playlists" sidebar section, filter builder view, results view with Edit button
  - Docs: `docs/smart-playlists.md`
- [x] Libraries (vpath) filter — toggle pills per music library; child-vpath prefix resolution
- [x] Fresh Picks toggle — shuffle on every open; "New picks" button in results; nav indicator

---

### 📱 Mobile / PWA Responsive Layout — PLANNED (not started)

Audit completed 2026-03-26. Strategy: **Option A — separate `mobile.css`** loaded via `<link media="(max-width:1023px)">`. Zero changes to existing `style.css` or desktop layout.

- [ ] Create `webapp/mobile.css` with all phone/tablet overrides
  - `≤768px` phones: CSS grid collapses to single column; sidebar + queue hidden; bottom tab-bar replaces sidebar nav; player compacts to ~80px mini-bar
  - `769–1023px` tablet portrait (iPad): sidebar as slide-in drawer overlay; queue collapsible; full player
- [ ] Add `<link rel="stylesheet" media="(max-width:1023px)" href="/webapp/mobile.css">` in `index.html`
- [ ] iOS PWA meta tags (3 lines in `<head>`): `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `theme-color`
- [ ] Global `-webkit-tap-highlight-color: transparent` in `mobile.css`
- [ ] Enhance inline Blob manifest: add `orientation:"portrait"`, `id`, `scope`
- [ ] (Optional, low priority) Service worker for offline caching

---

### 🎵 Acoustic Similarity & Audio Analysis — PLANNED (not started)

> Full design document: [`docs/audio-analysis.md`](docs/audio-analysis.md)

Analyse every track's actual audio content (BPM, key, timbre, energy) and use those features to:
1. Build "acoustically similar" smart playlists of up to 200 songs from a seed track
2. Add a new "Acoustic" Auto-DJ mode that always picks the next track based on sound-match
3. Improve Subsonic `getSimilarSongs` (currently returns empty)

**Technology decision:** Use [Essentia.js](https://github.com/MTG/essentia.js) (WebAssembly port of the MTG Essentia C++ library) running server-side in Node.js. Falls back to pure-JS MIR algorithms if WASM is incompatible with Node v22.

**Key design principles:**
- Optional feature — completely off by default; opt-in from admin panel
- Fully incremental — tracks already analysed are never re-processed (keyed by hash)
- Resumable — can be interrupted and restarted; continues from where it left off
- Library of 130,000 songs taking a week to analyse is acceptable
- Analysis runs in a background process; server remains fully usable
- Only deleted/added tracks need re-analysis; modified tags do not

**Extracted features per track:**
- BPM + confidence (from `RhythmExtractor2013`)
- Musical key + scale + strength (from `KeyExtractor`)
- Danceability score (from `Danceability`)
- EBU R128 integrated loudness (from `LoudnessEBUR128`)
- 13-coefficient MFCC mean (timbre fingerprint, from `MFCC`)
- 12-value HPCP mean (harmonic fingerprint, from `HPCP`)

**Similarity scoring:** Weighted cosine similarity across MFCC + HPCP vectors, plus BPM (half/double tempo counted as compatible), Camelot-wheel key distance, danceability, and loudness.

**Phase 1 — Backend core:**
- [ ] `audio_features` table (SQLite + Loki, migration-safe)
- [ ] `src/db/audio-analyzer.mjs` — FFmpeg PCM pipe → Essentia WASM → DB write
- [ ] `getSimilarSongs(hash, limit)` in both backends (in-process cosine scoring)
- [ ] API: `GET /api/v1/db/similar`, `GET /api/v1/db/audio-features/:hash`
- [ ] API: `POST|GET /api/v1/admin/audio-analysis/start|status|stop`

**Phase 2 — Admin UI:**
- [ ] "Audio Analysis" card in admin panel — progress bar, start/stop buttons, throttle setting

**Phase 3 — Player UI:**
- [ ] "≈ Build Similar Playlist" button in Now Playing modal (seed strength + length)
- [ ] BPM / key / danceability shown in Now Playing modal when features exist
- [ ] Auto-DJ: "Acoustic" mode

**Phase 4 — Optional polish:**
- [ ] Similarity weighting sliders in Settings
- [ ] Wire Subsonic `getSimilarSongs` to this

---

## DONE — Completed features

### Radio Stream Recording ✅
- [x] `'recordings'` vpath folder type — excluded from all library scans
- [x] Per-user `allow-radio-recording` permission; admin toggles per-user via `POST /api/v1/admin/users/allow-radio-recording`
- [x] Admin UI: "Radio Recordings folder" checkbox in directory add form; `● Record` toggle button per user in Users table
- [x] Playbar: SVG ring+circle record button visible only for radio + permission; pulsing animation while recording; elapsed time pill
- [x] Folder-select modal on record click; auto-stop when switching to non-radio
- [x] API: `GET /api/v1/radio/record/active`, `POST /api/v1/radio/record/start`, `POST /api/v1/radio/record/stop`
- [x] SSRF protection; write permission probe before starting; Content-Type → extension mapping; safe filename generation
- [x] Station logo embedded as cover art after recording stops (FFmpeg copy-only pass)
- [x] Max recording duration cap in admin (default 180 min); auto-stops via `setTimeout`; new admin endpoint `POST /api/v1/admin/db/params/max-recording-minutes`
- [x] Scheduled radio recording — `radio_schedules` DB table, `radio-scheduler.js` with 30s ticker, tabbed record modal (Record Now / Schedule), CRUD API (`GET/POST/DELETE/PATCH`), recurrence: once/daily/weekdays/custom days

### Sleep timer ✅
- [x] Countdown timer in Playback Settings — user sets duration in minutes
- [x] Fade-out over the final seconds before stopping playback
- [x] "End of current song" mode — stops after the current track finishes
- [x] Timer state persists across reload (stored in `localStorage`)
- [x] Cancel button visible while timer is active

### In-browser ID3 tag editor ✅
- [x] "Edit Tags" button in Now Playing modal (admin + `allowId3Edit` flag required)
- [x] Editable fields: title, artist, album, track number, year, genre, disc number
- [x] Writes tags directly to the media file via `PUT /api/v1/files/id3`
- [x] File re-scanned automatically after save so library stays in sync

### Radio channels ✅
- [x] Per-user station CRUD (`POST/PUT/DELETE /api/v1/radio/stations`)
- [x] `sort_order` column + `PUT /api/v1/radio/stations/reorder` — drag-to-reorder in the UI
- [x] Responsive card grid layout (`auto-fill, minmax(155px,1fr)`)
- [x] Logo caching: remote URL → local `radio-{md5}.{ext}` in album-art directory; served via `/album-art/`
- [x] Orphan cleanup protection: `getLiveArtFilenames()` includes radio logos so they are never deleted
- [x] Delete cleans up cached art when no other station references it
- [x] Stream proxy (`/api/v1/radio/stream`) for same-origin Web Audio API compatibility
- [x] ICY now-playing metadata parser (`/api/v1/radio/nowplaying`) — HTTP/1.1 byte-level reader
- [x] Art proxy (`/api/v1/radio/art`) — fetches remote images server-side for CORS-free preview in edit form
- [x] Player bar title/artist updates correctly on channel switch (`Player.playSingle`)
- [x] Notice below channel grid: "Playing a radio stream clears the play queue"
- [x] Filter pills by Genre and Country; reorder handle hidden when filter active
- [x] `docs/API/radio.md` — full API reference

### Lyrics improvements ✅
- [x] Removed `.none` cache mechanism — "not found" never cached, always re-queried
- [x] Removed `duration <= 0` bail-out (was blocking all lookups for un-scanned tracks)
- [x] Two-pass lrclib lookup: with duration first, then without as fallback
- [x] Active lyric line: 36 px → 72 px font size
- [x] Smooth brightness gradient via rAF (upcoming ramp 0.35→1.0, past falloff, floor 0.28)
- [x] No flash on line change (inline reset removed)


- [x] Pill row below search input shows all vpaths (only rendered when > 1 vpath exists)
- [x] All on by default; toggling off excludes that library from results; at least 1 always stays on
- [x] Selection persists in `S.searchVpaths` across back-navigations
- [x] Child-vpath aware: uses `filepathPrefix` (not `ignoreVPaths`) when selected vpaths are sub-folders of the same parent — same logic as Auto-DJ
- [x] Backend: `filepathPrefix` added to `/api/v1/db/search`, `searchFiles`, `searchFilesAllWords` (SQLite + Loki)
- [x] `save/lyrics/` added to `.gitignore`; `README.md` anchor committed

### Radio: ICY bitrate display in playbar ✅ (2026-03-24)
- [x] `_fetchIcyMeta()` returns `{ title, bitrate }` — captures `icy-br` response header
- [x] `/api/v1/radio/nowplaying` includes `bitrate` in response
- [x] `#player-radio-kbps` pill badge in playbar — shown when stream advertises bitrate, hidden otherwise
- [x] "Podcast Feeds" menu rename (was "Feeds")

### Auto-DJ keyword filter — fuzzy double-letter matching ✅ (2026-03-25)
- [x] `_djSongBlocked()` normalises both haystack and filter word by collapsing repeated consecutive chars before comparing — `acapella` now matches `Acappella`, etc.

### Subsonic `getIndexes` `ifModifiedSince` ✅ (2026-03-25)
- [x] `lastModified` now reflects real last-scan timestamp (`MAX(ts)` from files table)
- [x] When client sends `ifModifiedSince` ≥ last scan, returns empty index (no redundant transfer)
- [x] `getLastScannedMs()` added to SQLite + Loki backends
- [x] Full `/rest/*` endpoint suite: ping, getLicense, getMusicFolders, getIndexes, getArtists, getArtist, getAlbum, getSong, getMusicDirectory, search2/3, getAlbumList/2, getRandomSongs, getSongsByGenre, getGenres, getNowPlaying, getStarred/2, star, unstar, setRating, scrobble, stream, download, getCoverArt, getLyrics, getUser, getUsers, getPlaylists + CRUD, getBookmarks + CRUD, getScanStatus, getOpenSubsonicExtensions, createUser, updateUser, deleteUser, changePassword
- [x] MD5 token auth (`?t=&s=`) + plaintext auth (`?p=`) + `enc:` hex-encoded password (`?p=enc:…`); separate `subsonic-password` field per user
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
- [x] Genre list → drill into genre → Albums/Tracks tabs (`viewGenreDetail`)
- [x] Decade list → drill into decade → Albums/Tracks tabs (`viewDecadeDetail`); defaults to Tracks when no albums exist (e.g. 1900s with 1 track)
- [x] New API: `POST /api/v1/db/decade/songs` and `POST /api/v1/db/genre/albums`; DB functions `getSongsByDecade`, `getAlbumsByGenre`
- [x] Tracks tab: virtual scroll (`_mountSongVScroll`) handles 5 000+ rows; sort bar (Artist / Title / Album / Year, toggle ↑↓)
- [x] Browse filter input in tab bar — live client-side filter for albums and tracks; value preserved across tab switches; × clear button

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

### Tag Workshop — Phase 1: Filename Heuristics
> ~55K untagged files. Phase 1 is zero-dependency, offline, runs in milliseconds. Resolves structured collections (DJ sets, 12-inches with `Artist - Title.mp3` naming) without touching audio.
- [ ] DB: `tag_proposals` table — `filepath, source (heuristic|acoustid|manual), proposed_title, proposed_artist, proposed_album, proposed_year, proposed_genre, proposed_track, confidence (0-1), status (pending|accepted|rejected|edited)`
- [ ] Server: background scan job — parse filepath patterns (`Artist/Album/NN Title`, `Artist - Title`, `NN. Artist - Title`, `Title (Year) [Label]`, etc.) → INSERT into `tag_proposals` with confidence score
- [ ] Admin UI: **"Tag Workshop"** card — table of pending proposals (filepath, source, proposed fields, confidence); actions: Accept / Edit / Skip
- [ ] Bulk-accept button: "Accept all confidence ≥ 0.85"
- [ ] On accept: write tags via `node-id3` / `music-metadata`, mark `status=accepted`, queue re-index for that file

### Tag Workshop — Phase 2: AcoustID Fingerprinting
> Identifies songs by audio content even with completely wrong or missing filenames. ~3 req/s rate limit → 55K files ≈ 5 hours as background job.
- [ ] Add `fpcalc` (Chromaprint) binary to `bin/` alongside ffmpeg
- [ ] Server: fingerprint job — run `fpcalc` on unresolved files, POST to `api.acoustid.org/v2/lookup`, store MusicBrainz Recording ID in `tag_proposals`
- [ ] Enrich proposals with full MusicBrainz metadata (title, artist, album, year, genre) via second API call
- [ ] Surface AcoustID confidence score in Tag Workshop admin table; distinguish heuristic vs fingerprint rows visually

### Tag Workshop — Phase 3: Manual Fallback
- [ ] Inline edit row in Tag Workshop — override any proposed field before accepting
- [ ] "Use filename as title" quick-fill button for completely unidentifiable files
- [ ] "Apply to similar filenames" — propagate artist/album guess to other files in the same folder

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

### Synced Lyrics (LRC / LRCLIB)
> Especially useful for Top 40 / pop libraries. No lyrics support exists at all today.

- [ ] Server: `GET /api/v1/lyrics?artist=&title=&duration=` — query [lrclib.net](https://lrclib.net) API (no auth required) by artist + title + duration; return `{ synced: true, lines: [{time, text}] }` or `{ synced: false, plain: "..." }` for plain-text fallback
- [ ] Cache the raw `.lrc` file alongside the audio (e.g. `<hash>.lrc` in `save/lyrics/`) to avoid repeat network calls after first fetch
- [ ] Client: in the Now Playing modal, show a scrolling lyric panel; active line highlighted and auto-scrolled to match `audioEl.currentTime`
- [ ] Graceful degradation: plain-text lyrics shown statically when only unsynced text is available; panel hidden when no result found
- [ ] "No lyrics" state cached (e.g. `<hash>.lrc.none` sentinel file) so the API is not re-queried on every open

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

### ~~Bulk Download as ZIP~~ ✅ DONE — 2026-03-25
- [x] Server: `POST /api/v1/download/zip` — accepts `fileArray` (JSON array of filepaths) + optional `filename`; streams a ZIP archive; pre-flight size guard returns 413 if over `maxZipMb` limit
- [x] Client: Download ZIP button in page header — shown on album and playlist views, hidden elsewhere; filename = album/playlist name
- [x] Admin: "Max ZIP Download Size" setting in DB Scan Settings (default 500 MB)
- [x] Error handling: 413 → toast with MB limit details; network errors → generic toast

### Gapless — scan-time silence trimming *(optional enhancement)*
The 80 ms timer-based gapless works well for most content. This would improve albums with deliberate silence gaps:
- [ ] Server: detect `silence_end_ms` / `silence_start_ms` per track via `ffmpeg silencedetect` at scan time; store in DB (schema change required)
- [ ] Client: use DB silence offsets instead of fixed 80 ms window when available

### ~~User Settings in DB instead of localStorage~~ ✅ DONE — 2026-03-18
All user preferences and queue/position now persist in the server DB (`user_settings` table).
- [x] `user_settings` table in SQLite + Loki backends
- [x] `GET /api/v1/user/settings` and `POST /api/v1/user/settings` endpoints
- [x] On login: fetch from server, apply to `S` state + `localStorage`
- [x] On every pref change: debounced 1.5 s write to DB
- [x] On structural queue change (add/remove/reorder/song change): debounced 2 s write
- [x] On seeked: debounced 1 s position write
- [x] Every 15 s during playback: direct position write (cross-device F5 accuracy)
- [x] On `beforeunload`: `navigator.sendBeacon` flushes exact position (own-browser F5 accuracy)
- [x] DB is always source of truth on page load; covers all 34 pref keys + queue + seek position
- [x] Documented in `docs/API/user-settings.md`

---

## FUTURE — Accessibility & Appearance

### Audio Output Device Selector
Allow users to choose which audio output device the player streams to.

**How it works:**
- Use `navigator.mediaDevices.enumerateDevices()` (filtered to `audiooutput`) to populate a dropdown in Playback Settings
- On selection call `audioEl.setSinkId(deviceId)` — takes effect immediately
- Persist chosen `deviceId` in `localStorage`; re-apply on startup with silent fallback to default if device is gone
- Listen for `navigator.mediaDevices.devicechange` to refresh the list when headphones are plugged/unplugged

**Browser support:** Chrome/Edge/Firefox ✅ — Safari ❌ (no `setSinkId`)

---

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

## FUTURE — Home, Analytics & Discovery

> Roadmap items from 2026-03-17 strategic review. Priority order: play_events table first — every other item in this section depends on it.

### Home Screen
- [ ] Add **Home** nav entry — first view on load instead of blank state
- [ ] Time-aware greeting ("Good morning / evening") with contextual suggested playlist based on listening history
- [ ] **Continue Listening** strip — last 3 albums/playlists with resume position
- [ ] **Recently Added** strip — tracks sorted by file mtime since last scan
- [ ] **Mood quick-picks** — one button per bucket (Energy / Chill / Nostalgia) generated from own play history, no external API

### Listening Analytics — Play Events
- [ ] `play_events` table: `timestamp`, `filepath`, `duration_played`, `song_duration`, `source` (`manual|autoDJ|queue-add|shuffle`)
- [ ] Insert row on every song completion or skip (>5 s played counts as a play event)
- [ ] Server: `GET /api/v1/stats/playstats` — listening volume (minutes/day), time-of-day histogram per genre, skip rate per song, completion rate
- [ ] Client: **Analytics view** — plays-per-day sparkline, time-of-day heatmap, top genres by hour bucket (morning / afternoon / late-afternoon / evening / night)
- [ ] **Manual vs Auto-DJ ratio** chart — shows how much is curated vs auto-generated
- [ ] **"Unplayed gems"** view — tracks with 0 play events, filterable by decade/genre; great for 123K libraries where discovery is hard

### Smart Auto-DJ — Personal Weights
- [ ] Re-rank Auto-DJ candidates by `completion_rate × recency_decay` (recently completed = stronger weight)
- [ ] Penalise songs skipped >2× in the last 30 days — push them to bottom of candidate pool
- [ ] Keep Last.fm similar-artist seed but re-sort its results using personal weights
- [ ] BPM-continuity rule: avoid jumps >40 BPM between consecutive auto-queued tracks (requires BPM tag)
- [ ] **Harmonic mixing / Camelot wheel filter** — once musical key is stored (e.g. via essentia.js), apply a Camelot wheel lookup to chain tracks that mix harmonically; small open-source `camelot-key` npm packages reduce this to a simple lookup table. Combined with BPM continuity and the existing Last.fm artist graph this would make Auto-DJ genuinely DJ-quality.

### Smart Playlist Builder
- [ ] Filter builder UI: genre, decade, BPM range, energy level, never-played toggle, min-rating, max-duration
- [ ] `POST /api/v1/db/smart-playlist` — server-side filter execution, returns matching tracks
- [ ] Save as named playlist; auto-refreshes on rescan

### Tag & Library Health (especially for unmixed / filename-only tracks)
- [ ] Background tag-enricher job: parse `Artist - Title` pattern from filename for tracks with no ID3 title/artist
- [ ] AcoustID audio fingerprint lookup for completely untagged files → MusicBrainz metadata auto-fill
- [ ] Duplicate detector: flag same AcoustID fingerprint on multiple files, show in admin UI

### External Service Integrations
- [ ] **Last.fm scrobbling** — POST to `track.scrobble` on song completion (>50% played); user API key in settings
- [x] **ListenBrainz scrobbling** — open-source alternative, no rate limits, good for privacy-conscious users
- [ ] **Spotify audio features import** — fetch BPM, energy, danceability, valence per tagged track via Web API (OAuth); store locally — no ongoing dependency once fetched

---

## FUTURE — Social / Multi-user

### Collaborative Queue (Jukebox)
- [ ] Extend the Jukebox WS protocol to accept `queue-append` messages from any connected session
- [ ] Broadcast queue state changes to all connected clients in the same session
- [ ] Show connected-user avatars/initials in the Jukebox view
- [ ] Add per-track "added by" attribution in the queue panel

### Multi-room / Snapcast / Chromecast
> No synchronized multi-room capability today. The Jukebox feature is the closest thing — it's collaborative queue, not audio sync.

**Snapcast sidecar (preferred open-source path):**
- [ ] Run [snapcast](https://github.com/badaix/snapcast) as a sidecar process; Velvet writes PCM audio to the snapfifo pipe while playing
- [ ] Control snapcast server (client mute, volume, group assignment) via its JSON-RPC API over TCP — Node.js-controllable with a plain `net.Socket`
- [ ] Admin UI: "Multi-room" panel showing snapcast clients (name, latency, volume, muted); allow renaming and grouping rooms
- [ ] Player UI: room selector — choose which snapcast client(s) follow the current queue
- [ ] Latency compensation: read per-client latency from snapcast JSON-RPC and display it as an indicator in admin (Snapcast handles sync automatically)

**Chromecast (Cast Web SDK — browser-side):**
- [ ] Load Cast Web SDK in the player; add a Cast button to the Now Playing bar
- [ ] Implement a Cast receiver app URL that proxies the mStream `/api/v1/music/` stream endpoint
- [ ] Sync play/pause/seek state between the Cast session and the local player


- [ ] Server: add `GET /api/v1/stats/summary?range=7d|30d|all` — return top artists, top albums, top tracks, plays-per-day array, current streak
- [ ] Client: add a **Stats** view in the sidebar
- [ ] Render a plays-per-day sparkline chart (pure canvas, no library dependency)
- [ ] Render top-10 artists / albums / tracks with play counts and mini bar indicators
- [ ] Show current listening streak (consecutive days with at least one play)

