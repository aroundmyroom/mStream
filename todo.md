# mStream v2 TODO

---

## NOW — In Progress / Remaining

### Artist Image Moderation — Follow-ups

- [ ] Admin Artists: add bulk actions (apply first Discogs candidate to selected rows)
- [ ] Admin Artists: add pagination/filter by minimum song count for very large libraries
- [ ] Admin Artists: add image-dimension / file-size details to manual URL preview before apply
- [ ] Admin Artists: add bulk Yes/No validation actions in the With image review list
- [ ] Admin Directories: add bulk Artists On/Off actions by folder type (music/audio-books/recordings)
- [ ] Admin Directories: add visual parent/child relationship badges for Albums Only and Artists On/Off inheritance
- [ ] Player Artist Library: optional badge for already-flagged wrong artists (admin-only)
- [ ] Add global media-enrichment budget (shared limiter between artist-image hydration and album-art background tasks)
- [ ] Add admin performance panel for enrichment throughput (items/min, queue depth, fail rate)

### Localisation (i18n) — Phase 1: Infrastructure + Admin Panel

Upstream commit `67e11723` added a full i18n system. We have zero i18n infrastructure currently.
The work is split into two phases. Phase 1 is safe and self-contained.

**Phase 1 — copy infrastructure + wire admin panel (do first)**

- [ ] Copy `webapp/assets/js/i18n.js` from upstream — add `I18N.onChange()` pub/sub and `I18N.ready` Promise (upstream additions)
- [ ] Create `webapp/assets/js/flags.js` — inline SVG flags for all 12 languages (en, de, es, fr, it, ja, ko, nl, pl, pt, ru, zh)
- [ ] Create `webapp/assets/js/lang-dropdown.js` — reusable flag+name dropdown (two variants: `.nav-lang-*` top-bar, `.sidenav-lang-*` sidenav-bottom)
- [ ] Create `webapp/assets/css/lang-dropdown.css` — styles for both dropdown variants
- [ ] Create `webapp/locales/` directory with all 12 locale JSON files from upstream (`en.json` through `zh.json`), plus `languages.json` index
- [ ] Add our custom locale keys to all 12 files for features upstream doesn't have: Album Browser, Discogs/Deezer art search, Wrapped stats, Your Stats, zip download, cue markers, podcast player, rate-limit messages (~80–100 new keys)
- [ ] Wire `webapp/admin/index.html`: add `<script src="../assets/js/flags.js">` after i18n load, add language picker section at bottom of sidebar, add `data-i18n` attrs to all static nav labels
- [ ] Wire `webapp/admin/index.js`: add `I18NSTATE` Vue.observable + `Vue.prototype.t()` bridge + `I18N.onChange()` listener; update all Vue templates with `{{ t('key') }}` calls
- [ ] Wire `webapp/admin/admin.css` (or inline styles): add `.admin-lang-*` dropdown styles
- [ ] Wire `webapp/index.html`: load `flags.js` + `lang-dropdown.js` + `lang-dropdown.css`; add language picker to nav-bar and sidenav bottom

**Phase 2 — wire main webapp app.js (separate release, larger effort)**

- [ ] Audit all hardcoded English strings in `webapp/app.js` — ~200–300 toast messages, status text, button labels, error messages
- [ ] Add `window.t = (key, params) => I18N.t(key, params)` shim at top of app.js
- [ ] Replace inline English strings in JS template literals with `t('key')` calls
- [ ] Add all new keys to all 12 locale files
- [ ] Test language switching live — verify dynamic UI re-renders (Vue components react via `I18N.onChange`; non-Vue parts need explicit re-render hooks or re-generation of affected DOM)

**Architecture notes:**
- `i18n.js` uses `data-i18n` attrs for static HTML and `window.t(key)` for dynamic JS — both need wiring
- Language persisted in `localStorage['mstream-lang']`; detected via `navigator.language` on first visit
- Locale JSON files use flat dot-delimited keys: `"toast.uploadFailed": "..."`; plurals use `{ "one": "...", "other": "..." }` objects
- `I18N.onChange(fn)` fires after each language load — Vue bridge increments reactive counter so templates re-render
- All locale files must stay in sync; `en.json` is the source of truth / fallback

---

### yt-dlp year from `release_year` — LOW PRIORITY / OPTIONAL

- [ ] In `src/api/ytdl.js` line ~299: `const year = info.release_year || (info.release_date ? info.release_date.substring(0,4) : null) || (info.upload_date ? info.upload_date.slice(0,4) : '');`

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

### Tag Workshop — Phase 1: Filename Heuristics
- [ ] DB: `tag_proposals` table — `filepath, source, proposed_title, proposed_artist, proposed_album, proposed_year, proposed_genre, proposed_track, confidence, status`
- [ ] Server: background scan job — parse filepath patterns → INSERT with confidence score
- [ ] Admin UI: **"Tag Workshop"** card — table with Accept / Edit / Skip actions
- [ ] Bulk-accept button: "Accept all confidence ≥ 0.85"
- [ ] On accept: write tags via `node-id3` / `music-metadata`, queue re-index

### Tag Workshop — Phase 2: AcoustID Fingerprinting
- [ ] Add `fpcalc` (Chromaprint) binary to `bin/`
- [ ] Fingerprint job — run `fpcalc`, POST to `api.acoustid.org/v2/lookup`, store MusicBrainz Recording ID
- [ ] Enrich with full MusicBrainz metadata via second API call

### Tag Workshop — Phase 3: Manual Fallback
- [ ] Inline edit row in Tag Workshop
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

### Audio Output Device Selector
- [ ] `navigator.mediaDevices.enumerateDevices()` → dropdown in Playback Settings
- [ ] `audioEl.setSinkId(deviceId)` on selection; persist in `localStorage`
- [ ] Listen for `devicechange` to refresh the list

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

### Artist Metadata & Discovery — Needs More Analysis

> Found by analysing Musicseerr. Each item below needs deeper investigation before implementation.

- [ ] **TheAudioDB — artist imagery (fanart, banners, logos, CD art)** — Free public API (30 req/min), no auth needed. Investigate: API response shape, cache TTL strategy, where/how to surface in the UI (artist cards, Now Playing modal, future Artist page). See `docs/technology-choices.md` for existing stance.
- [ ] **Wikidata — artist biography text** — Fully open, no API key, no rate limits. Investigate: query format (SPARQL or entity lookup), language fallback, how to cache per-artist, and whether bio fits in a Now Playing panel expansion or a future Artist page.
- [ ] **MusicBrainz — artist MBID + structured discography** — Already in the AcoustID fingerprint todo (line ~382). Investigate: MBID lookup by artist name, discography endpoint, release types (studio/live/EP), rate-limit (1 req/sec). Prerequisite for a full Artist page.
- [ ] **Artist page** — Biography (Wikidata), discography (MusicBrainz), hero image/logo (TheAudioDB), similar artists (Last.fm). Depends on items above. Investigate: route/nav pattern, which parts are feasible without all three services being configured, fallback behaviour.

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
