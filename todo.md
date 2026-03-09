# mStream v2 TODO

---

## NOW — In Progress / Remaining



### Admin Area — GUIv2

The admin panel (`webapp/admin/`) is the original unchanged UI from the upstream project.
It needs to be redesigned/integrated into the GUIv2 look and feel.

- [ ] Audit all existing admin panel features (scan controls, user management, transcode settings, db params)
- [ ] Redesign admin panel to match the GUIv2 dark-mode / CSS variable theme
- [ ] Integrate admin access into the GUIv2 sidebar (currently requires navigating to `/admin` separately)
- [ ] Ensure admin-only UI elements are hidden from non-admin users based on the ping/login response
- [ ] Replace or restyle all legacy CSS (materialize / foundation) in admin with GUIv2 variables
- [ ] Test all admin API calls still work after any restructuring

### Smart Playlists

> Note: an earlier prototype was removed in commit `d8e224fe` — needs a clean re-implementation.

- [ ] Add `GET /api/v1/db/smart-playlist` endpoint accepting filters: `genre`, `yearFrom`, `yearTo`, `neverPlayed`, `limit`
- [ ] Add a "Smart Playlist" view in the sidebar with a filter builder UI (genre/decade dropdowns)
- [ ] Wire result into the queue (play-all / replace-queue buttons)
- [ ] Persist the last-used filter per user with `_uKey('smart_pl_filter')`

---

## DONE — Completed features

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
