# mStream v2 TODO

## Upload Feature (server: `noUpload: false`)

The upload endpoint (`POST /api/v1/file-explorer/upload`) is fully functional on the server.
In the classic GUI it works via drag-and-drop only, while inside the File Explorer view.
The v2 GUI has no upload support at all yet.

### Tasks

- [ ] Check server config on login/session — fetch `noUpload` status from `/api/v1/admin/about` or similar and store in app state
- [ ] Add an **Upload** button to the File Explorer / Library browser in v2, visible only when `noUpload === false`
- [ ] Implement drag-and-drop onto the file list area as an alternative to the button
- [ ] Show a progress bar during upload (reuse the Dropzone or fetch-based approach)
- [ ] Show success/error toast when upload completes
- [ ] Refresh the file list after a successful upload so the new files appear immediately
- [ ] Hide/disable the upload UI entirely when `noUpload === true` (respect admin setting)
- [ ] Ensure the upload target directory is the currently browsed vpath directory (pass as `data-location` header, URI-encoded)

---

## Admin Area — GUIv2

The admin panel (`webapp/admin/`) is the original unchanged UI from the upstream project.
It needs to be redesigned/integrated into the GUIv2 look and feel.

### Tasks

- [ ] Audit all existing admin panel features (scan controls, user management, transcode settings, db params)
- [ ] Redesign admin panel to match the GUIv2 dark-mode / CSS variable theme
- [ ] Integrate admin access into the GUIv2 sidebar (currently requires navigating to `/admin` separately)
- [ ] Ensure admin-only UI elements are hidden from non-admin users based on the ping/login response
- [ ] Replace or restyle all legacy CSS (materialize / foundation) in admin with GUIv2 variables
- [ ] Test all admin API calls still work after any restructuring

---

## NOW — Audio Quality / Playback

### ReplayGain / Loudness Normalization
- [ ] At scan time, compute R128 integrated loudness per track using `ffmpeg -af ebur128` and store `gain_db` in the DB
- [ ] Expose `gain_db` on song objects returned by all DB endpoints
- [ ] Client: apply gain as a Web Audio `GainNode` offset (dB → linear) when a track starts, respecting a user-toggle
- [ ] Add ReplayGain on/off toggle to the Playback settings view; persist with `_uKey('rg')`
- [ ] Pre-gain the crossfade element too so transitions don't have loudness jumps

### Waveform Scrubber
- [ ] Server: add `GET /api/v1/db/waveform?filepath=…` endpoint — run `ffmpeg` to extract raw PCM, downsample to ~1000 points, return as JSON float array; cache result to disk
- [ ] Client: replace `#prog-track` flat bar with a `<canvas>` waveform renderer
- [ ] Draw waveform in accent colour; shade played portion differently; show hover position
- [ ] Fall back gracefully to the plain bar if the waveform endpoint returns 404 or times out

### Gapless Playback
- [ ] Server: store `silence_end_ms` and `silence_start_ms` per track (leading/trailing silence detected at scan via `ffmpeg silencedetect`)
- [ ] Client: start playing the next track at `silence_end_ms` instead of `currentTime = 0`
- [ ] Skip ahead by `silence_start_ms` at end of current track so trailing silence is trimmed
- [ ] Integrate with the existing crossfade path — gapless and crossfade should be mutually exclusive modes

---

## NOW — Discovery / Browsing

### Smart Playlists
- [ ] Add `GET /api/v1/db/smart-playlist` endpoint accepting filters: `genre`, `yearFrom`, `yearTo`, `minRating`, `neverPlayed`, `limit`
- [ ] Add a "Smart Playlist" view in the sidebar with a filter builder UI (genre/decade dropdowns + rating picker)
- [ ] Wire result into the queue (play-all / replace-queue buttons)
- [ ] Persist the last-used filter per user with `_uKey('smart_pl_filter')`

### Genre & Decade Views
- [ ] Add `GET /api/v1/db/genres` endpoint returning distinct genres with track counts
- [ ] Add `GET /api/v1/db/decades` (or extend albums endpoint) returning albums grouped by decade
- [ ] Add **Genres** and **Decades** nav entries in the sidebar
- [ ] Render genre list → drill into genre → song list (reuse existing song-list renderer)
- [ ] Render decade timeline → drill into decade → album grid

### "Similar Artists" Auto-DJ seed
- [ ] When Auto-DJ starts and Last.fm scrobbling is configured, call `artist.getSimilar` for the current track's artist
- [ ] Use returned similar-artist names to bias the `random-songs` query (filter by `artist IN (…)`)
- [ ] Fall back to the existing random behaviour if Last.fm is unreachable or returns no results
- [ ] Add a "Similar Artist Radio" toggle in the Auto-DJ settings view

---

## NOW — Now-Playing Experience

### Dynamic Album-Art Colour Theming
- [ ] Client: when album art changes, draw it to a hidden `<canvas>` and use `getImageData` to sample a 5×5 grid of pixels
- [ ] Compute dominant non-neutral colour using a simple k-means or median-cut approach
- [ ] Apply the colour as `--primary` and a lightened variant as `--primary-lt` via `document.documentElement.style.setProperty`
- [ ] Ensure sufficient contrast on text/icon elements — clamp lightness to a safe range
- [ ] Add a user toggle "Dynamic colours" in settings; persist with `_uKey('dyn_color')`

### Media Session API
- [ ] Set `navigator.mediaSession.metadata` (title, artist, album, artwork) whenever the current track changes
- [ ] Wire `mediaSession.setActionHandler` for: `play`, `pause`, `previoustrack`, `nexttrack`, `seekto`
- [ ] Update `navigator.mediaSession.playbackState` on play/pause events
- [ ] Update `navigator.mediaSession.setPositionState` on `timeupdate` (throttled to 1 Hz)

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
