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
- **Pre-fetch** — 25 s before the current track ends, the next DJ song is
  silently appended to the queue so playback is seamless.
- **Ignore list** — the server returns a growing ignore list with each random
  song so the same track is not repeated until the list is exhausted.
- **Persistence** — Auto-DJ on/off state is stored in
  `localStorage('ms2_autodj')` and restored at login.
- A pulsing "DJ" pill in the player bar indicates active Auto-DJ.

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

## Scanner Changes (`src/db/scanner.mjs`)

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

## Pending

- **File upload UI** — the server endpoint `POST /api/v1/file-explorer/upload`
  is functional; the v2 front-end upload button and modal have not been built
  yet.
