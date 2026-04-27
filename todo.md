# mStream v2 TODO

---

## NOW — In Progress / Remaining

### ReplayGain / Normalisation Workshop

130,294 of 134,600 songs are missing a ReplayGain tag. Format breakdown: FLAC 70,541 · MP3 42,027 · WAV 17,384 · other ~342.

**Recommended tool: `rsgain`** — bootstrap from GitHub releases (same static-binary pattern as ffmpeg). Single binary handles FLAC, MP3, WAV, OGG, M4A, Opus in-place. ~150–300× realtime per song; with 2 workers ≈ 12–24 h for the full library.

- [ ] Bootstrap `rsgain` binary (Linux x64 + arm64) in `bin/rsgain/`, same pattern as `src/util/ffmpeg-bootstrap.js`
- [ ] `src/api/rsgain.js` — job queue: iterate `WHERE replaygainTrackDb IS NULL`, spawn rsgain per song, parse output, update DB `replaygainTrackDb` directly (no rescan needed)
- [ ] Concurrency: 2 workers default (configurable 1–4), with a global budget limiter shared with hydration
- [ ] **Phase 1 — Analyse only (safe first milestone):** calculate gain and write to DB only, do not touch audio files; player already reads from DB so RG works immediately
- [ ] **Phase 2 — Write to file:** embed `REPLAYGAIN_TRACK_GAIN` tag into the audio file via rsgain (for portability with other players)
- [ ] Admin → Normalisation Workshop panel: status count, Start/Pause/Stop, concurrency slider, live SSE progress + ETA (same pattern as scan-progress), per-format breakdown, error log
- [ ] Process order: FLAC first → MP3 → WAV (WAV last: BWF chunk write, skip gracefully if read-only/locked)
- [ ] After job completes, re-expose updated `withReplaygain` stat in Admin → Stats

---

### Artist Image Moderation — Follow-ups

- [ ] Admin Artists: add bulk actions (apply first Discogs candidate to selected rows)
- [ ] Admin Artists: add pagination/filter by minimum song count for very large libraries
- [ ] Admin Artists: add image-dimension / file-size details to manual URL preview before apply
- [ ] Admin Artists: add bulk Yes/No validation actions in the With image review list
- [ ] Admin Directories: add bulk Artists On/Off actions by folder type (music/audio-books/recordings)
- [ ] Admin Directories: add visual parent/child relationship badges for Albums Only and Artists On/Off inheritance
- [ ] Player Artist Library: optional badge for already-flagged wrong artists (admin-only)
- [ ] Add global media-enrichment budget (shared limiter between artist-image hydration and album-art background tasks)
### Localisation (i18n) — Phase 2: Remaining admin template strings

Phase 1 (i18n.js engine + admin sidebar + language pickers with real flag-button UI + locale JSON validation on activation) and Phase 3 (full player frontend — app.js + index.html) are complete, including enabled-language filtering in admin and cross-tab language sync (shipped in v6.8.4 and v6.8.5-velvet).

Recent follow-up shipped in v6.10.1-velvet: open player views rendered dynamically in `webapp/app.js` now re-render on language switch instead of keeping stale text until the user navigates away and back.

Recent follow-up shipped in v6.10.1-velvet: Admin → Server Audio now includes explicit control explanations, Linux ALSA sound checks, and a backend unmute fix path (with optional auto-unmute on mpv start).

Recent follow-up shipped in v6.10.1-velvet: Admin → Server Audio actions now show live click feedback and include a guided end-to-end test report to validate speaker output setup.

**Phase 2 — admin template strings (medium effort)**

- [ ] Replace remaining hardcoded English strings in `wrappedAdminView`, `foldersView`, `usersView`, `settingsView`, and `backupView` with `{{ t('admin.*') }}` calls.
- [ ] Replace remaining hardcoded modal strings in `webapp/admin/index.js` (mpv modal + transcode modals + legacy confirm/modal copy) with i18n keys.
- [ ] Player i18n: final sweep of remaining utility panels (Jukebox + Transcode + other info cards) to eliminate last hardcoded strings

---

### File-Write Access Check — Phase 2

Phase 1 (admin directory access test) is done. Remaining:

- [ ] Server: expose `vpathWriteAccess: { [vpath]: bool }` on `GET /api/v1/ping` (admin-only); re-check on rescan
- [ ] Client: `_canWriteVpath(song)` helper
- [ ] Gate Discogs "Search Album Art" button when `!_canWriteVpath(song)`
- [ ] Gate future ID3 Tag Editor with the same helper
- [ ] Show tooltip on disabled button: "mStream does not have write access to this folder"

---

### Subsonic / OpenSubsonic API — compliance audit & further testing

- [ ] **`getMusicDirectory`**: test with DSub, Ultrasonic, Jamstash
- [ ] **`search2` / `search3`**: test wildcard edge-cases and empty-query behaviour across clients
- [ ] **`getAlbumList` / `getAlbumList2`**: audit `byYear`, `byGenre`, `newest`, `recent`, `random`, `alphabeticalByName/Artist`, `starred`
- [ ] **Bookmarks**: verify persistence and that multiple clients share bookmarks correctly
- [ ] **Playlists**: `createPlaylist`, `updatePlaylist`, `deletePlaylist` — end-to-end test with Substreamer and Nautiline
- [ ] **Scrobble**: consider wiring to the same play-count path as the native player
- [ ] **`stream` transcoding**: `maxBitRate` and `format` params are currently ignored — document this limitation
- [ ] **`createUser` / `updateUser` / `deleteUser`**: confirm round-trip through admin API
- [ ] **XML format**: smoke-test with a client that defaults to XML (e.g. DSub)
- [ ] Run through the full [OpenSubsonic conformance checklist](https://opensubsonic.netlify.app/)

---

### 📱 Mobile / PWA Responsive Layout — PLANNED (not started)

Audit completed 2026-03-26. Strategy: **Option A — separate `mobile.css`** loaded via `<link media="(max-width:1023px)">`.

- [ ] Create `webapp/mobile.css` with all phone/tablet overrides
- [ ] Add `<link rel="stylesheet" media="(max-width:1023px)" href="/webapp/mobile.css">` in `index.html`
- [ ] iOS PWA meta tags: `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `theme-color`
- [ ] Global `-webkit-tap-highlight-color: transparent` in `mobile.css`
- [ ] Enhance inline Blob manifest: add `orientation:"portrait"`, `id`, `scope`
- [ ] (Optional) Service worker for offline caching

---

## FUTURE — Library Management

### Tag Workshop — Enhancements
- [ ] "Use filename as title" quick-fill button
- [ ] "Apply to similar filenames" — propagate artist/album guess to other files in same folder

### Discogs URL: Direct Release Lookup
- [ ] Server: `GET /api/v1/discogs/release?id=<id>&type=release|master`
- [ ] Client NP modal: "Discogs URL" input; extract ID + type, call endpoint, pre-fill tag fields
- [ ] Apply buttons: "Art + Tags", "Art Only", "Tags Only"
- [ ] Graceful fallback when no API key

### Duplicate Detector
- [ ] Server: `GET /api/v1/db/duplicates` — groups of tracks sharing `(artist, title, duration ±2s)`
- [ ] Client: admin-only "Duplicates" sidebar entry
- [ ] Side-by-side metadata diff; select which to keep; "Delete file" action

### Gapless — scan-time silence trimming *(optional)*
- [ ] Server: detect `silence_end_ms` / `silence_start_ms` via `ffmpeg silencedetect` at scan time; store in DB
- [ ] Client: use DB offsets instead of fixed 80 ms window when available

---

## FUTURE — Accessibility & Appearance

### Customizable Themes

#### Track A — External / File-based Themes
- [ ] `themes/` dir + static route + `GET /api/v1/themes` listing `.css` files
- [ ] Appearance settings: built-in swatches + discovered file-based themes

#### Track B — In-UI Color Customizer
- [ ] `viewThemeEditor()` panel: hue wheel for `--primary`, lightness sliders, contrast-ratio display
- [ ] 4–5 colorblind-safe presets (deuteranopia, protanopia, tritanopia, high-contrast dark/light)
- [ ] Persist custom variable blob to `localStorage`; apply before first paint

#### Theme Persistence
- [ ] `GET /api/v1/themes`, `POST /api/v1/themes` (admin), `DELETE /api/v1/themes/:name` (admin)
- [ ] On theme change → write `localStorage` immediately + debounce PUT to `user_settings`
- [ ] Audit `_updateBadgeFg` and `_applyAlbumArtTheme` — add `lockAccent` flag guard

---

## FUTURE — Home, Analytics & Discovery

### Home Screen
- [ ] **Time-based play stats** — `play_log` table; songs played today/week/month/year; listening streak
- [ ] Time-aware greeting with contextual suggested playlist
- [ ] **Continue Listening** strip — last 3 albums/playlists with resume position
- [ ] **Mood quick-picks** — Energy / Chill / Nostalgia from own play history

### Listening Analytics — Play Events
- [ ] **"Unplayed gems"** — tracks with 0 play events, filterable by decade/genre

### Smart Auto-DJ — Personal Weights
- [ ] Re-rank candidates by `completion_rate × recency_decay`
- [ ] Penalise songs skipped >2× in the last 30 days
- [ ] BPM-continuity rule: avoid jumps >40 BPM between consecutive auto-queued tracks
- [ ] **Harmonic mixing / Camelot wheel filter**

### 🎵 Acoustic Similarity & Audio Analysis — PLANNED

> Full design document: [`docs/audio-analysis.md`](docs/audio-analysis.md)

**AudioMuse-AI sidecar — investigate before building native analysis:**
- [ ] **Subsonic compatibility test** — AudioMuse-AI (AGPL-3.0, Python+Docker) supports Navidrome via OpenSubsonic. Try pointing it at mStream's `/rest` endpoint (`NAVIDROME_URL`, `NAVIDROME_USER`, `NAVIDROME_PASSWORD`) to stream audio for analysis and push generated playlists back. mStream's `createPlaylist`/`updatePlaylist`/`stream` etc. are likely sufficient — verify which calls it makes and whether any are missing.
- [ ] **If Subsonic bridge works**: use AudioMuse-AI as the sonic intelligence engine (clustering, text search, song paths, similar-song playlists) without building any native analysis — mStream just becomes the player + library, AudioMuse-AI adds AI on top.
- [ ] **If Subsonic bridge fails**: note which missing endpoints blocked it, fix those in `src/api/subsonic.js`, retry.
- [ ] **Phase 2 option (deeper integration)**: add an mStream admin toggle for an AudioMuse-AI REST URL; Auto-DJ calls AudioMuse-AI's similarity API for the next track in "Acoustic" mode instead of Last.fm. Real-time sonic similarity rather than batch playlist generation.

**Phase 1 — Backend:**
- [ ] `audio_features` table (SQLite)
- [ ] `src/db/audio-analyzer.mjs` — FFmpeg PCM pipe → Essentia WASM → DB write
- [ ] `getSimilarSongs(hash, limit)` — cosine scoring
- [ ] API: `GET /api/v1/db/similar`, `GET /api/v1/db/audio-features/:hash`, start/status/stop endpoints

**Phase 2 — Admin UI:**
- [ ] "Audio Analysis" card — progress bar, start/stop, throttle setting

**Phase 3 — Player UI:**
- [ ] "≈ Build Similar Playlist" button in Now Playing modal
- [ ] BPM / key / danceability in Now Playing modal when features exist
- [ ] Auto-DJ: "Acoustic" mode

### Stats View
- [ ] `GET /api/v1/stats/summary?range=7d|30d|all`
- [ ] **Stats** view in sidebar — plays-per-day sparkline, top-10 artists/albums/tracks, streak
- [ ] Your Stats: add direct jump controls (e.g. "Now" / calendar jump) for faster long-range period navigation

---

## FUTURE — Social / Multi-user

### Collaborative Queue (Jukebox)
- [ ] Extend Jukebox WS protocol to accept `queue-append` messages from any connected session
- [ ] Broadcast queue state changes to all connected clients in same session
- [ ] Show connected-user avatars/initials in Jukebox view
- [ ] Per-track "added by" attribution in queue panel

### Multi-room / Snapcast / Chromecast

**Snapcast sidecar:**
- [ ] Run snapcast as a sidecar; Velvet writes PCM to snapfifo while playing
- [ ] Control via snapcast JSON-RPC API over TCP
- [ ] Admin UI: "Multi-room" panel; player UI: room selector

**Chromecast:**
- [ ] Cast Web SDK + Cast button in Now Playing bar
- [ ] Cast receiver app URL that proxies the `/api/v1/music/` stream endpoint
- [ ] Sync play/pause/seek between Cast session and local player
