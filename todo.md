# mStream v2 TODO

---

## NOW — In Progress / Remaining

### 🎙 Podcasts — PLANNED

> Users subscribe to RSS feed URLs. The server fetches, parses and stores all episodes in the DB — server-side, SSRF-protected, no external podcast service needed. `fast-xml-parser` (already in `package.json`) handles the XML. Each user has their own independent subscription list when podcasts are enabled in the admin panel.

**Validated test feeds (all three must work):**
- `https://podcasts.files.bbci.co.uk/p02nq0gn.rss` — BBC, `audio/mpeg`, uses `<ppg:enclosureSecure>` for HTTPS, `<itunes:duration>` as integer seconds (`1690`)
- `https://www3.nhk.or.jp/rj/podcast/rss/indonesian.xml` — NHK, standard `<enclosure>`, `<itunes:duration>` as integer seconds
- `https://anchor.fm/s/a2b53d4c/podcast/rss` — Anchor/Spotify, standard `<enclosure>` already HTTPS, **`<itunes:duration>` as `HH:MM:SS` string** (`00:51:54`), `<guid>` is a plain UUID, uses `<dc:creator>` for author, has `<itunes:season>` + `<itunes:episode>` number fields

**Critical parser requirement — `<itunes:duration>` dual format:**
- BBC/NHK: integer seconds (`1690`)
- Anchor/Spotify: `HH:MM:SS` or `MM:SS` string (`00:51:54`, `45:18`)
- Parser must detect format and normalise to integer seconds:
  ```js
  function _parseDuration(v) {
    if (!v) return 0;
    if (!isNaN(v)) return parseInt(v, 10);
    const parts = String(v).split(':').map(Number);
    if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
    if (parts.length === 2) return parts[0]*60 + parts[1];
    return 0;
  }
  ```

**Architecture: two-level browse (feed list → episode list → play)**
```
Podcasts nav
  └── Feed card grid  (one card per subscribed RSS feed)
        └── Episode list  (all episodes from that feed, newest first)
              └── Player  (plays like a song / radio — uses Player.playSingle)
```

**Phase 1 — Database (`src/db/sqlite-backend.js`)**
- [ ] `podcast_feeds` table: `id INTEGER PK, user TEXT, url TEXT, title TEXT, description TEXT, img TEXT (local filename), author TEXT, language TEXT, last_fetched INTEGER (unix ms), sort_order INTEGER, created_at INTEGER`
- [ ] `podcast_episodes` table: `id INTEGER PK, feed_id INTEGER FK, guid TEXT, title TEXT, description TEXT, audio_url TEXT, pub_date INTEGER (unix ms), duration_secs INTEGER, img TEXT (local filename or remote URL), played INTEGER DEFAULT 0, play_position REAL DEFAULT 0, created_at INTEGER`
- [ ] Unique constraint: `(feed_id, guid)` on episodes — prevents duplicates on refresh
- [ ] Migration-safe: check `PRAGMA table_info` before `ALTER TABLE … ADD COLUMN`
- [ ] DB functions: `createPodcastFeed(user, data)`, `getPodcastFeeds(user)` → array sorted by `sort_order`, `deletePodcastFeed(id, user)` + cascade-delete its episodes, `upsertPodcastEpisodes(feedId, episodes[])` (INSERT OR REPLACE keyed on guid+feed_id), `getPodcastEpisodes(feedId, user)` → sorted `pub_date DESC`, `markEpisodePlayed(episodeId, feedId, user, played)`, `saveEpisodePosition(episodeId, feedId, user, pos)`, `getPodcastFeedImgUsageCount(img)` (same cleanup pattern as radio)

**Phase 2 — Backend (`src/api/podcasts.js`)**
- [ ] Admin: `GET/POST /api/v1/admin/podcast/config` — enable/disable globally (same Joi + config pattern as radio/lyrics)
- [ ] `GET /api/v1/podcast/enabled` — all authenticated users
- [ ] `GET /api/v1/podcast/feeds` — list user's feeds; each feed includes `episode_count` and `latest_pub_date` (computed from episodes table) so the feed card can show "latest episode: 18 Mar 2026"
- [ ] `POST /api/v1/podcast/feeds` — subscribe: body `{ url }`, fetch RSS (10 s timeout), parse with `_parseRssFeed()`, validate that ≥1 episode has `<enclosure type="audio/…">`, cache feed art, save feed + all episodes to DB, return `{ id, title, img, episode_count }`
- [ ] `DELETE /api/v1/podcast/feeds/:id` — unsubscribe, cascade-delete episodes, clean up cached art file if no other feed uses it
- [ ] `POST /api/v1/podcast/feeds/:id/refresh` — re-fetch RSS, upsert new/updated episodes (keyed on `guid`), update `last_fetched`, return updated feed row
- [ ] `GET /api/v1/podcast/feeds/:id/episodes` — list all episodes for this feed (must belong to requesting user), each with `{ id, title, pub_date, duration_secs, img, played, play_position, audio_url }`
- [ ] `PUT /api/v1/podcast/episodes/:episodeId/played` — body `{ played: true/false }`; verify episode belongs to user via feed ownership
- [ ] `PUT /api/v1/podcast/episodes/:episodeId/position` — body `{ position: 42.5 }` (float seconds)
- [ ] `_parseRssFeed(xml)` helper using `fast-xml-parser` (`ignoreAttributes: false`, `attributeNamePrefix: '@_'`):
  - Extract feed: `title`, `description`, `itunes:image['@_href']`, `itunes:author` or `author`, `language`
  - Extract episodes from `rss.channel.item[]` (always normalise to array); for each item:
    - Audio URL: prefer `ppg:enclosureSecure['@_url']` (BBC) → `enclosure['@_url']` (NHK, Anchor) — skip items without an audio enclosure (`type` starting with `audio/`)
    - Duration: `_parseDuration(itunes:duration)` — handles both integer seconds (`1690`) AND `HH:MM:SS`/`MM:SS` strings (`00:51:54`) from Anchor/Spotify feeds
    - `guid`: use `guid['#text']` if object, else the string value directly (Anchor uses plain UUID strings)
    - `pubDate` → `new Date(pubDate).getTime()` for unix ms
    - Optional episode number: `itunes:episode` + `itunes:season` stored for future display
  - Strip HTML tags from `description` with simple regex `/<[^>]+>/g` for plain-text display
  - All three test feeds return episodes with audio URLs — validate at least 1 episode has an audio enclosure before saving
- [ ] SSRF protection: all outbound fetch calls (RSS URL, art download) pass through `_ssrfCheck(hostname)` — reuse from radio
- [ ] Feed cover art: `<itunes:image href>` downloaded and cached as `podcast-{md5}.{ext}` in album-art directory — same `_cachePodcastArt()` function mirroring `_cacheRadioArt()` from radio
- [ ] Episode art: stored as original URL in DB; served to client via `/api/v1/radio/art?url=…` proxy (reuses existing CORS-bypass endpoint)
- [ ] `getLiveArtFilenames()` in `cleanup-albumart.mjs` must include `podcast-*.{ext}` filenames — podcast art must NEVER be deleted by the orphan cleanup scanner

**Phase 3 — Admin UI (`webapp/admin/index.html` + `webapp/admin/index.js`)**
- [ ] New `podcasts-view` Vue component — single enable/disable checkbox, reads `GET /api/v1/admin/podcast/config`, saves via `POST`
- [ ] Nav item "Podcasts" in library/streaming section — headphones Lucide SVG icon (same icon as player nav)
- [ ] After editing: validate with `node --input-type=module < webapp/admin/index.js 2>&1 | grep -v "not defined" | head -5`

**Phase 4 — Player UI (`webapp/app.js`)**

*Feed list view (`viewPodcasts()`):*
- [ ] Nav item "Podcasts" below Radio — headphones Lucide icon
- [ ] `S.podcasts` loaded from `GET /api/v1/podcast/feeds` (includes `episode_count` + `latest_pub_date`)
- [ ] Render: section header with "+ Add Feed" button; card grid (same `auto-fill, minmax(155px,1fr)` as radio)
- [ ] Each feed card shows: cover art (via `/album-art/{img}`), feed title, latest episode date (`latest_pub_date` formatted as `dd Mon yyyy`), episode count badge; click anywhere on card → `viewPodcastEpisodes(feed.id)`)
- [ ] Card action buttons: "Refresh" (POST refresh → re-render card), "Delete" (confirm → DELETE → remove card)
- [ ] Notice below grid: "Playing a podcast episode clears the play queue"
- [ ] "+ Add Feed" form: text input for RSS URL + "Subscribe" button → POST → success shows new card; error shows inline toast

*Episode list view (`viewPodcastEpisodes(feedId)`):*
- [ ] Back button → `viewPodcasts()`
- [ ] Feed header row: art (72×72), feed title (large), author, episode count
- [ ] Episodes list (table/rows sorted newest first); each row shows:
  - Unplayed indicator dot (`.pd-unplayed` — coloured, disappears when played)
  - Episode title
  - `pubDate` formatted as `dd Mon yyyy`
  - Duration formatted as `h:mm:ss` or `m:ss`
  - Play button (▶)
  - Resume indicator: if `play_position > 5`, show a small progress bar stub so user knows they've partially listened
- [ ] Played rows dimmed: `.pd-played` → `opacity: 0.55`
- [ ] "Mark all played" button in header

*Playback (`_playPodcastEpisode(episode, feed)`):*
- [ ] Builds song object: `{ title: episode.title, artist: feed.title, album: '', filepath: episode.audio_url, 'album-art': episode.img || feed.img || null, isPodcast: true, _episodeId: episode.id, _feedId: feed.id }`
- [ ] Calls `Player.playSingle(song)` — same as radio; clears queue
- [ ] Audio URL is direct HTTPS link from `<enclosure>` / `<ppg:enclosureSecure>` — played via the existing stream proxy (`mediaUrl()`) so CORS is handled identically to radio
- [ ] On `loadedmetadata`: if `episode.play_position > 5` and `< duration - 10`, seek `audioEl.currentTime = episode.play_position`
- [ ] On `timeupdate` (throttled, every 5 s): `PUT /api/v1/podcast/episodes/:id/position`
- [ ] On `ended` or progress `> 90 %`: `PUT /api/v1/podcast/episodes/:id/played { played: true }`
- [ ] Player bar: `isPodcast` → no star rating, no lyrics fetch, `_stopRadioNowPlaying()` (same as music tracks)

**Phase 5 — CSS (`webapp/style.css`)**
- [ ] `.pd-list` — episode list container (flex-column, gap)
- [ ] `.pd-row` — single episode row (flex, align-center, gap, padding, border-bottom)
- [ ] `.pd-unplayed` — small filled circle, `background: var(--primary)`, hidden when `.pd-played`
- [ ] `.pd-played` — `opacity: 0.55`
- [ ] `.pd-title` — episode title, `font-weight:600; color:var(--t1)`
- [ ] `.pd-meta` — date + duration, `font-size:11px; color:var(--t2)` (NOT `var(--t3)`)
- [ ] `.pd-resume` — thin progress stub, `height:2px; background:var(--primary); border-radius:99px`
- [ ] Feed card: reuse `.rs-row` / `.rs-card-art` classes from radio where possible; add `.pd-ep-count` badge

**Out of scope (v1):**
- Download for offline playback
- Auto-refresh on schedule (user refreshes manually)
- Chapter markers
- Podcast search/discovery API

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

### Bulk Download as ZIP
- [ ] Server: add `POST /api/v1/download/zip` — accept array of filepaths, stream a ZIP archive using `archiver`
- [ ] Client: add "Download Album" button on album detail views and "Download Playlist" on playlist views
- [ ] Show a progress toast while the stream downloads; handle abort

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
- [ ] **ListenBrainz scrobbling** — open-source alternative, no rate limits, good for privacy-conscious users
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

