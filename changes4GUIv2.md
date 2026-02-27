# mStream GUI v2 — Change Log

> All changes are in `webapp/v2/` (app.js, style.css, index.html) plus
> supporting fixes in `src/db/scanner.mjs` and `src/server.js`.
> Upload UI is **pending** — the server endpoint already exists
> (`POST /api/v1/file-explorer/upload`), only the v2 front-end is missing.

---

## Design System

- **Complete dark-mode rewrite** — deep navy/purple palette with CSS custom
  properties (`--bg`, `--surface`, `--raised`, `--card`, `--primary`, …).
  Every colour is a variable, so the whole theme can be swapped in one place.
- **Light mode** — a second `:root.light` variable block provides a clean
  light theme.  A toggle in the sidebar footer switches between the two and
  persists the choice in `localStorage('ms2_theme')`.
- **CSS grid layout** — the shell is a 3-column × 2-row grid:
  `sidebar | main content | queue panel` on top,
  `sidebar | player bar (spanning both)` on the bottom.
  `--sidebar: 236px`, `--player: 112px`, `--qp-width: 320px` are variables
  so breakpoints can resize everything at once.
- **Responsive breakpoints** — `@media (max-width: 1366px)` tightens sidebar
  and queue panel; `@media (max-width: 1024px)` compresses the player bar;
  `@media (max-width: 600px)` stacks the Now-Playing modal vertically and
  collapses the most-played bar graph column.
- **Animated "no-art" placeholder** — a 5-bar waveform SVG-alike (pure CSS
  spans) replaces missing album art everywhere: song rows, queue, player bar,
  Now-Playing modal.  Three variants: animated (default), static (album grid),
  small (queue/player).
- **Scrollbar styling** — 5px custom scrollbar across the whole app.

---

## Sidebar

- Collapsible section groups (nav-toggle with chevron) — state not persisted,
  visual only.
- **Navigation items**: Recent · Most Played · Search · Artists · Albums ·
  File Explorer · Auto-DJ · Jukebox · Apps.
- **Playlist list** — each entry shows a delete icon and a share icon on
  hover; selecting a playlist loads it as a view.
- **Footer** — Transcode toggle, Theme toggle, Admin link (hidden unless user
  is admin), Sign-out.

---

## Player Bar

- **Three-column grid** — left (album art + song info), centre (controls +
  progress bar), right (volume + extras).
- **Song info** — title, artist, album.  Long titles auto-scroll with a CSS
  marquee animation (`@keyframes player-marquee`).
- **Star rating** — 5-star widget in the player bar; clicking opens a pop-up
  rate panel.  Rating persists to the server via `POST /api/v1/db/rate-song`.
- **Clicking the left panel** opens the full **Now Playing modal**.
- **Controls** — Shuffle, Previous, Play/Pause (large purple circle button
  with glow), Next, Repeat (off / one / all).
- **Progress bar** — seek-on-click; thumb appears on hover; current time and
  duration shown.
- **Right side** — Mute, Volume slider, EQ button, Queue button (with live
  count badge), Visualizer button, DJ active pill.
- **VU-meter mini-spec canvas** — a real-time frequency bar canvas sits as an
  `position: absolute` overlay at the top of the player bar.  Bars grow
  upward from the bottom of the canvas.  Positioned 13 px left of centre
  (`translateX(calc(-50% - 13px))`).  Width `min(640px, 70%)`, height 36 px,
  opacity 0.7 (1.0 on hover).

---

## Queue Panel

- Slides in from the right as a fixed-width (`--qp-width`) column.
- **"Now Playing" card** — larger art + title + artist + stars at the top.
- **Up-next list** — numbered rows with art, title, artist; active row
  highlighted in purple; per-row remove button appears on hover.
- **Empty state** — illustrated hint when queue is empty.
- **Queue persistence** — the full queue (songs + index + playback position)
  is saved to `localStorage('ms2_queue_<username>')` every 5 s while
  playing and restored on next login.  A toast confirms restoration.

---

## Now Playing Modal

- Full-screen-width overlay (max 820 px wide).
- **Left panel** — square album art with a blurred, colour-extracted glow
  behind it (same image, `filter: blur(44px) brightness(0.28) saturate(1.9)`).
- **Right panel** (scrollable):
  - Title, artist, album.
  - 5-star rating widget (larger than player bar version).
  - Progress bar + seek.
  - Full playback controls (prev / play-pause / next + shuffle/repeat).
  - Metadata table — Year, Track, Disc, Genre, Format, ReplayGain, Hash.
  - **"Open Visualizer"** button.

---

## Equalizer

- Slide-up panel (`position: fixed`, animated `transform`) above the player
  bar, opened from the EQ button.
- **8-band parametric EQ** (60 Hz → 16 kHz) — vertical `range` sliders,
  ±12 dB each.
- **Presets** — Flat, Bass Boost, Treble Boost, Vocal, Classical, Electronic,
  Rock.  Active preset highlighted.
- **Bypass toggle** — disables all filters without losing the slider values.
- All gains and bypass state saved to `localStorage`.
- EQ button in player bar glows purple when non-flat settings are active.

---

## Visualizer

- Full-screen overlay (`z-index: 900`).
- **Mode 1 — Butterchurn / Milkdrop** — the `butterchurn` library renders
  animated Milkdrop presets.  All presets from `butterchurn-presets` and
  `butterchurn-presets-extra` are loaded; the preset cycles every 20 s or
  on manual "Next preset" button press.
- **Mode 2 — Spectrum analyser** — a custom canvas draws a symmetrical
  stereo frequency spectrum (left + right channels, mirrored vertically)
  using the Web Audio `AnalyserNode`.
- **Mode toggling** — button in the overlay toolbar switches between the two
  modes.
- Both modes share a single `AudioContext` with a stereo splitter so the
  left and right channels feed separate analysers.  The same analysers drive
  the mini-spec in the player bar.
- Hover-revealed toolbar shows current preset name, Next Preset, Mode toggle,
  and Close.
- Song title + artist are shown in a fade-in bar at the bottom on hover.

---

## Auto-DJ

- Dedicated sidebar view with a big toggle button and status line.
- **vpath filter** — checkboxes to restrict random picks to specific virtual
  paths.
- **Minimum rating filter** — star picker; only songs rated ≥ N stars are
  candidates.
- When enabled:
  - If queue is empty / ended: fetches a random song via
    `POST /api/v1/db/random-songs` and plays it immediately.
  - If a song is paused: resumes playback.
  - If already playing: takes over at the end of the current track.
- **Pre-fetch** — `max(25, crossfade + 15)` seconds before the current track
  ends, the next DJ song is silently appended to the queue so playback is
  seamless.  The extra headroom ensures the API response arrives before the
  crossfade ramp needs the next track index.
- **Ignore list** — the server returns a growing ignore list with each random
  song so the same track is not repeated until the list is exhausted.
- **Persistence** — Auto-DJ on/off state is stored in
  `localStorage('ms2_autodj')` and restored at login.
- A pulsing "DJ" pill in the player bar indicates active Auto-DJ.

---

## Playback Settings

A dedicated **Playback** sidebar entry (under Tools) opens a settings panel
for two purely client-side features — no server or config changes required.

### Crossfade
- Slider: 0 – 12 seconds (0 = off).
- Setting is persisted in `localStorage('ms2_crossfade')`.
- When a track has ≤ N seconds remaining a second hidden `<audio>` element
  (`_xfadeEl`) is created, connected to the **same Web Audio graph** as the
  main element (both go through `_audioGain` → EQ → analysers → destination),
  and starts playing the next track at volume 0.
- A `setInterval` ramp fades the outgoing track down and the incoming track
  up over the configured duration — volume only, queue is never touched.
- When `audioEl` fires `ended`, `_doXfadeHandoff()` performs a **true element
  swap**: `audioEl = _xfadeEl`.  The incoming element is already playing at
  the correct position through Web Audio — no `src` change, no `load()`,
  zero gap.  All permanent event listeners are detached from the old element
  and reattached to the new one; `MINI_SPEC.start()` is called explicitly
  because the `play` event will not re-fire.
- `_resetXfade()` (called by `Player.playAt()`) aborts a crossfade in
  progress and restores the saved volume.
- **Auto-DJ prefetch threshold** is `Math.max(25, crossfade + 15)` seconds,
  so the API call always completes before the crossfade ramp needs the next
  track in the queue.

### Sleep Timer
- Presets: **15 / 30 / 60 / 90 min** or **End of current song**.
- Active timer shows a 😴 countdown pill in the player bar.
- At expiry: a 40-step volume fade-out over 10 s, then `audioEl.pause()`.
- "End of song" mode is checked in the `ended` event handler — playback
  stops cleanly at the natural track boundary.
- Timer state is intentionally **not** persisted (resets on page reload).

---

## Play History Reset

A **Play History** sidebar entry (under Tools) provides a clean-slate option
for both play-history features — useful after importing a library or simply
starting over.

- **Reset Most Played** — zeroes the `pc` (play-count) column in
  `user_metadata` for every song owned by the current user via
  `POST /api/v1/db/stats/reset-play-counts`.  The Most Played view will show
  an empty state until songs are played again.
- **Reset Recently Played** — clears the `lp` (last-played timestamp) column
  for every song owned by the current user via
  `POST /api/v1/db/stats/reset-recently-played`.  The Recently Played view
  will show an empty state until songs are played again.

Both actions are per-user (other users' data is unaffected), require an
explicit confirmation dialog, and show a toast on success.  Ratings are
**not** touched by either reset.

---

## Jukebox

- Sidebar panel that shows the room code, full URL, and a QR code.
- WebSocket connection to the server (`/api/v1/remote/register-controller`).
- Remote clients can push songs to the jukebox via `/remote`.
- Live green dot pulses while the socket is connected.

---

## Views

| View | Description |
|---|---|
| **Recent** | Latest 40 scanned songs, full song-row list |
| **Most Played** | Top 40 songs with a relative play-count bar |
| **Search** | Live search across songs, artists, albums |
| **Artists** | A-Z artist list with avatar initials; click → albums of that artist |
| **Albums** | Responsive card grid; click → song list for that album |
| **File Explorer** | Directory tree with breadcrumb, inline filter, folder and file rows |
| **Playlists** | Load from sidebar; full song-row list with play-all / add-all |
| **Auto-DJ** | Config panel (vpath filter, min rating, start/stop) |
| **Jukebox** | Room code + QR + WebSocket status |
| **Apps** | Links to Android/iOS apps + QR for the local server URL |
| **Transcode** | Toggle + codec/bitrate/algorithm selects; persists in localStorage |
| **Play History** | Reset controls for Most Played counts and Recently Played timestamps |
| **Admin** | Manage vpaths, trigger scans, user management (admin only) |

Song rows across all views show: track number, album art, title + artist/album
sub-line, star rating, and a hover action bar (Play, Add to queue, Download,
3-dot context menu).

---

## Context Menu

Right-click (or 3-dot button) on any song row:
- Play Now / Add to Queue / Play Next
- Save to Playlist → opens playlist picker modal
- Download (direct file download)
- Rate → floating 5-star panel
- Share → creates a time-limited share link via `POST /api/v1/shared/make-shared`

---

## Shared Links

- A "Shared Links" modal (accessible from the context menu) lists all active
  share links for the logged-in user, shows expiry time, copy-URL button, and
  a revoke button.
- Expired links are shown dimmed with an "Expired" badge.

---

## PWA / Install

- PWA manifest is generated **inline** as a Blob URL to avoid the reverse
  proxy blocking a separate HTTP request for the manifest file.
  `window.location.origin` is prepended to all icon and `start_url` paths so
  they resolve correctly from the blob context.
- `apple-touch-icon` and standard favicon links remain as normal `<link>` tags.

---

## Audio Error Handling

`_onAudioError()` in `app.js` handles `MediaError` codes on the main audio
element:

- **Code 2 — `MEDIA_ERR_NETWORK`** (connection dropped mid-stream): triggers
  the existing stall-recovery path (`_reloadFromPosition`) — but only when
  Auto-DJ is active, to avoid spamming retries during manual pauses on a bad
  connection.
- **Code 3 — `MEDIA_ERR_DECODE`** and **Code 4 —
  `MEDIA_ERR_SRC_NOT_SUPPORTED`** (corrupt file, bad PTS timestamps,
  unsupported codec): the track is immediately skipped via `Player.next()`
  and a toast shows the filename.  These codes fire regardless of Auto-DJ
  state.  A common trigger is a FLAC file with non-monotonically increasing
  DTS packets that Chrome's demuxer rejects after partial playback.

---

## Expired / Missing Shared Links (`src/api/shared.js`)

Visiting a shared-playlist URL that has expired or never existed previously
returned a raw `{"error":"Server Error"}` JSON response in the browser.

The `/shared/:playlistId` route now catches lookup errors itself before the
global error handler can intercept them:

- **Expired token** (`TokenExpiredError`) → HTTP 410 with a styled full-page
  overlay: *"This link has expired"*.
- **Not found** → HTTP 404 with *"Link not found"*.

In both cases the response is the normal `shared/index.html` shell with a
`position:fixed` overlay injected into `<body>` (hardcoded dark colours so
it renders correctly before any CSS variables load).  The `sharedPlaylist`
script variable is set to `null`; a null-guard in `shared/index.html`
prevents a `TypeError` when the page JS runs.

---

## Scanner Changes (`src/db/scanner.mjs`)

- **`_needsArt` art backfill** — if the DB record for a file already exists
  but has no album art (`_needsArt: true`), the scanner re-parses the file
  metadata (with `skipCovers: false`) and runs art detection without touching
  the `ts` (last-scanned timestamp).  Covers embedded in WAV ID3 tags are
  handled correctly.  A dedicated `POST /api/v1/scanner/update-art` call
  writes only the `aaFile` column, leaving all other fields untouched.
- **Artwork subdirectories** — if no image is found directly in a music
  folder, the scanner now checks common subdirectory names:
  `artwork`, `scans`, `covers`, `images`, `art`, `cover`, `scan`.
- **Named-file priority** — `folder.jpg/png`, `cover.jpg/png`, `album.jpg/png`,
  `front.jpg/png` are preferred over other image files in the same directory.
- **Error resilience** — failed file reads are caught and logged rather than
  crashing the scan; a bail-out guard handles the case where all image reads
  fail.

---

## Server Changes (`src/server.js`)

- Added explicit public (pre-auth) routes for `/assets/fav/site.webmanifest`
  and `/v2/site.webmanifest` so the manifest file is accessible without a
  token even when the PWA approach is not used.

---

## Reverse-Proxy Configuration

When mStream is served through a reverse proxy (nginx, Caddy, Apache, etc.)
audio streaming will silently stall or pause mid-song because the proxy
drops idle TCP connections before the browser has finished reading the file.

### Symptoms
- Auto-DJ plays for a while, then the play button switches to ⏸ with no
  console error (browser was using its 30 s audio buffer and ran out).
- Console shows `ERR_CONNECTION_RESET 206 (Partial Content)` when the buffer
  eventually empties.

### Client-side recovery (already implemented)
`app.js` listens for `error` (MEDIA_ERR_NETWORK) and `stalled` events on
the audio element.  When either fires with Auto-DJ active it re-issues the
HTTP request and seeks back to the interrupted position, retrying up to 5
times with exponential back-off (1 s → 2 s → 4 s → 8 s → 16 s).

### Permanent nginx fix (recommended)
Add these two directives to the `location` block that proxies to mStream:

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_read_timeout 3600s;   # keep the connection open for up to 1 hour
    proxy_buffering    off;     # stream bytes straight to the browser —
                                # prevents nginx buffering the whole file
                                # in memory before forwarding
}
```

- **`proxy_read_timeout 3600s`** — extends the idle-connection timeout from
  the default 60 s to 1 hour.  Without this, nginx closes the upstream socket
  whenever no bytes have arrived for 60 s, which happens normally during
  audio streaming once the browser's buffer is full.
- **`proxy_buffering off`** — tells nginx to pass data to the client as it
  arrives rather than accumulating it first.  This is important for large
  audio files (FLAC can be 50–300 MB) because default buffering would cause
  nginx to try to hold the entire file in its proxy buffer, fail, and reset
  the connection.

After editing nginx.conf, reload without downtime:
```bash
sudo nginx -t && sudo nginx -s reload
```

---

## Upload — File Type Restriction

Enforced audio-only uploads at every layer of the stack to prevent arbitrary
files (PDFs, executables, text files, etc.) from being written to the server.

### Server (`src/api/file-explorer.js`)
- Each uploaded file's extension is checked against
  `config.program.supportedAudioFiles` before the stream is piped to disk.
- Rejected files have their stream drained and discarded immediately.
- Tracks `acceptedCount` / `firstRejectedExt` across all files in the
  multipart request.
- `bb.on('close')` now returns **HTTP 400** `{ error: "File type not allowed: .pdf" }`
  when every file in the batch was rejected, instead of silently returning 200.

### Ping endpoint (`src/api/playlist.js`)
- `GET /api/v1/ping` response now includes `supportedAudioFiles`
  (the same map used by the scanner) so the UI can enforce the same
  whitelist client-side without hard-coding extensions.

### v2 UI (`webapp/v2/app.js`)
- `S.supportedAudioFiles` state field populated from the ping response on login.
- `addFiles()` in the upload modal validates each file's extension before
  adding it to the pending list — invalid files are rejected immediately
  with a red `toastError("Not allowed: file.pdf")` toast, before any network
  request is made.
- The `<input type="file">` `accept` attribute is set dynamically from the
  server's whitelist when the modal opens, so the OS file picker also filters
  to audio-only by default.
- Added `toastError(msg)` helper — same position as the normal toast but with
  a red background (`.toast-error`) so errors are visually distinct.

### v2 CSS (`webapp/v2/style.css`)
- `.toast.toast-error` rule added: red background (`#c0392b`), red border,
  white text — distinguishes error toasts from neutral informational toasts.

### Alpha UI (`webapp/alpha/m.js`)
- `window._msSupportedAudio` populated from the ping response on init.
- Dropzone `addedfile` handler checks the file extension and fires an
  `iziToast.error` naming the rejected extension before calling
  `myDropzone.removeFile()` — the file never enters the upload queue.

---

## Pending

- **Song ratings UI** — the DB column and Auto-DJ `minRating` filter exist;
  there is currently no way to set ratings from within v2 (star widget saves
  via the rate panel but no dedicated "Rated songs" browse view exists).
