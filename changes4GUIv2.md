# mStream GUI v2 — Change Log

> All changes are in `webapp/v2/` (app.js, style.css, index.html) plus
> supporting fixes in `src/db/scanner.mjs`, `src/server.js`,
> `src/api/file-explorer.js`, and `src/api/playlist.js`.

---

## v5.16.2-velvet — 2026-03-13

### 3-theme system: Velvet / Dark / Light

Replaced the 2-step blue/light toggle with a 3-step segmented selector across both the player and admin panel. Admin light mode now matches the player light mode exactly.

**`webapp/v2/style.css`**
- `:root` (Velvet) — unchanged navy/purple palette
- `:root.dark` added — true near-black (`#000` background) following Material / Apple dark-mode guidelines; all interactive colours adjusted for WCAG contrast
- `:root.light` — unchanged; login-screen override kept
- `:root.dark #login-screen` added — pure-black radial gradient, matching dark palette variables
- Old `.theme-toggle` / `.theme-toggle-track` / `.theme-toggle-thumb` / `.theme-icon-moon` / `.theme-icon-sun` CSS removed
- `.theme-seg` / `.theme-seg-btn` / `.theme-seg-btn.active` segmented pill CSS added

**`webapp/v2/index.html`**
- `<button id="theme-toggle">` (moon/sun 2-step) replaced with `<div id="theme-seg">` containing three `<button class="theme-seg-btn" data-theme="…">` buttons (Velvet / Dark / Light)

**`webapp/v2/app.js`**
- `applyTheme(light, persist)` boolean signature replaced with `applyTheme(theme, persist)` accepting `'velvet'`|`'dark'`|`'light'`
- Removes both `dark` and `light` classes before applying, then adds the relevant one (Velvet = no extra class)
- Active state on `.theme-seg-btn` buttons synced on every call
- OS colour-scheme listener updated: dark OS → `'velvet'`, light OS → `'light'`
- Theme toggle click listener replaced with per-button listeners on `.theme-seg-btn`
- Init IIFE updated: passes saved string theme directly; OS fallback now returns `'velvet'` for dark OS / `'light'` for light OS

**`webapp/admin/index.css`**
- `:root` (Velvet), `:root.dark`, `:root.light` themes defined with identical values to player
- Old toggle CSS removed; `.theme-seg` pill CSS added

**`webapp/admin/index.html`**
- Early-init script updated to read `'velvet'`|`'dark'`|`'light'` from `localStorage`
- `<button id="theme-toggle">` replaced with `<div id="theme-seg">` 3-step selector
- `applyTheme()` and button event listeners updated

---

## v5.16.1-velvet — 2026-03-13

### Remove all legacy / classic UI code

All remaining classic-UI entry points, UI elements, routes, and CSS have been removed.

**`src/server.js`**
- `/classic` route no longer serves the old player — returns `410 Gone`
- `/old-admin` auth guard, static mount, and `webapp/admin/` serving removed
- `/admin-v2 → /admin` 301 redirect removed
- `/v2` and `/v2/` 301 redirects to `/` removed
- `/v2/site.webmanifest` compatibility route removed

**`webapp/v2/index.html`**
- `<a id="classic-login-link">` (login screen link to `/classic`) removed
- `<a id="classic-admin-btn">` (sidebar footer link to `/old-admin`) removed
- `<a id="classic-player-btn">` (sidebar footer link to `/classic`) removed

**`webapp/v2/app.js`**
- Both `ms2_show_classic` localStorage checks in `showApp()` removed
- Classic-login-link hide block removed from the init IIFE

**`webapp/v2/style.css`**
- `.classic-link` and `.classic-link:hover` rules removed

**`todo.md`**
- LEGACY BURDEN section updated: removed items checked off, remaining directory renames tracked

---



### Routing cleanup: v2 and admin-v2 paths retired

All legacy path references (`/v2`, `/admin-v2`, `GUIv2`) have been replaced with canonical paths.
The main UI is now served directly at `/`; the admin panel at `/admin`.

**`src/server.js`**
- `/` now serves `webapp/v2/index.html` directly — no redirect
- `/admin` auth guard and static mount now point to `webapp/admin-v2/` (the new admin UI)
- `/old-admin` (new route, LEGACY) serves the original `webapp/admin/` for transition reference
- `/admin-v2` redirects 301 to `/admin` (LEGACY — for old bookmarks)
- `/v2` / `/v2/` redirect 301 to `/` (LEGACY — for old bookmarks and PWA installs)
- Explicit `express.static` mounts added for `/admin` → `admin-v2/` and `/old-admin` → `admin/`, placed before the general static mount so directory-name resolution is deterministic
- `/v2/site.webmanifest` kept with LEGACY comment for existing PWA installs

**`webapp/v2/index.html`**
- `style.css` → `/v2/style.css` (absolute path; was relative, broke when page served at `/`)
- `app.js` → `/v2/app.js` (same reason)
- PWA `start_url` changed from `origin + "/v2"` to `origin + "/"`
- Classic Admin footer link `href` changed from `/admin` to `/old-admin`

**`webapp/v2/app.js`**
- `openAdminPanel()` now opens `/admin` instead of `/admin-v2`

**`todo.md`**
- New **LEGACY BURDEN — Marked for Deletion** section added, tracking all directories, routes, and UI elements that must be removed before the clean branch becomes `main`

**`webapp/alpha/`** — surveyed and marked for deletion in todo.md.
This is a dead Vue.js prototype player (no server route serves it). Safe to delete immediately.

---

## v5.15.3-velvet — 2026-03-10

### Auto-DJ: Dice Roll Crossfade Animation (new feature)
- New optional **Dice Roll on Crossfade** toggle in the Auto-DJ settings view (visible only when Web Animations API is supported)
- On each crossfade a 3D cube animates from the player bar corner across the screen with a physics arc, three decreasing bounces, then fades out — total duration matches the crossfade length
- `S.djDice` persisted via `localStorage` key `ms2_dj_dice_<user>`; default OFF
- `_throwDjDice(xfSec)` handles animation via the Web Animations API — cancels any in-flight animation before starting a new one; all timers stored on the wrapper element to prevent leaks
- CSS: `#dj-dice`, `.dj-dice-cube`, `.dj-dice-face` variants with `perspective`/`transform-style:preserve-3d` 3D rendering; 6 face classes (f/b/r/l/t/d)
- `_webAnimSupported` feature-detect constant added; dice toggle and HTML only rendered when `true`

### Discogs: Compilation Album Detection
- `isCompilationAlbum(album)` — new function that returns `true` when the album tag matches known compilation patterns: `top 40`, `chart hit`, `greatest hits`, `va`, `various`, `best of`, `hits`, `collection`, `mixtape`, etc.
- When a compilation album is detected **and** artist + title are both known, all ID3 album-based Discogs searches are demoted from phase `'A'` to phase `'C'` (`albumPhase` variable) — so artist/song results (phase B) always rank above generic compilation covers
- Filepath folder fallback now also triggers when the existing album tag is itself a compilation, allowing the folder path to supply a more specific release name
- Fixes: files tagged with generic compilation names (e.g. `Complete Top 40 Van 1982`) were returning only compilation cover art instead of single/album art for the actual artist

### Auto-DJ: Similar Artists Fallback Improvement (`src/api/db.js`)
- `POST /api/v1/db/random-songs`: added a second fallback stage — when the `artists` filter (similar-artists mode) returns zero library matches, the server now retries with the `artists` filter removed but `ignoreArtists` still applied, before finally dropping `ignoreArtists` as a last resort
- Previously only the `ignoreArtists` exhaustion was handled; a library with no tracks from any Last.fm-suggested artist would return an empty result instead of gracefully falling back to random playback

### Art Crossfade: Background Tab Fix
- `_startArtXfade` card fade and player-bar/NP overlay transitions replaced `requestAnimationFrame(()=>requestAnimationFrame(...))` with a synchronous `void container.offsetHeight` reflow trigger
- `rAF` freezes entirely when the tab is in the background (page visibility hidden), causing crossfade art transitions to never complete when music plays while the tab is backgrounded; `offsetHeight` forces the reflow immediately regardless of visibility state

### Album Art Theme: `--primary-fg` Tracking
- `_applyAlbumArtTheme` now computes and sets `--primary-fg` alongside `--primary` and `--accent`: same hue/saturation as `--primary` but lightness clamped for readability as text (`L ≥ 0.65` in dark mode, `L ≤ 0.40` in light mode)
- `_resetAlbumArtTheme` now also removes `--primary-fg` when reverting to defaults, preventing stale values from the previous track bleeding through

### Remote UI: Velvet Gradient Logo
- `webapp/remote/index.html` topbar logo updated from flat blue polygons to the Velvet dual-gradient mark (outer: `#c4b5fd` → `#6d28d9`; inner: `#4c1d95` → `#a78bfa`) matching the main player and admin panel

### Similar Artists Strip: Pill Color Fix
- `.dj-strip-pill` border color reverted from `var(--primary-fg)` to `var(--t1)` / `var(--border2)` — the pill text was inheriting the dynamic album-art accent color and turning yellow/orange; pills now always render in neutral text color regardless of active theme

---

## v5.15.2-velvet — 2026-03-09

### ID3 Tag Editing (new feature)
- **Admin toggle** — new "Allow tag editing" switch in admin UI (`webapp/admin-v2/`) persists in config; both `POST /api/v1/admin/tags/write` and the NP modal edit UI respect it
- **Backend** (`src/api/admin.js`) — `POST /api/v1/admin/tags/write` writes title/artist/album/year/genre/track/disk via 3-step ffmpeg pipeline: (1) extract existing art, (2) write tags audio-only, (3) re-embed art using `-c:v mjpeg` to produce a valid PTS stream
- **NP modal edit UI** — pencil button in the Now Playing modal opens an inline form; saving updates the file, the in-memory queue, and the player bar immediately without a rescan
- **DB** — `db.updateFileTags()` added to sqlite-backend and loki-backend; queue cache updated in-place so UI reflects new tags instantly

### Discogs Art Embed Fixes
- **PTS fix** — embed command changed from `-c copy` to `-c:a copy -c:v mjpeg`; stream-copying a JPEG into FLAC/OGG produces `avg_frame_rate=0/0` with no PTS → Chrome's demuxer throws `DEMUXER_ERROR_COULD_NOT_PARSE: PTS is not defined`; re-encoding through ffmpeg's MJPEG codec generates correct timing metadata
- **Art deduplication** — `-map 0:a -map 1:v` instead of `-map 0 -map 1` so any pre-existing embedded art stream is dropped before the new one is added (prevents double art streams)
- **tmpCover to `/tmp/`** — Discogs temp cover file now written to `os.tmpdir()` instead of the music directory, so it never appears as a stray file in NFS/SMB shares
- **JPEG validation** — `fetchImageBuf` checks for `FF D8 FF` magic bytes before accepting a download

### Audio Resilience & Playback Fixes
- **Cache-busting after file rewrite** — after any tag save or art embed, `audioEl.src` is reassigned with `&_t=<timestamp>` cache-buster before `load()`; merely calling `load()` was insufficient — Chrome reused its stale internal byte-range offset and received a 416 on the rewritten (differently-sized) file
- **Restart from 0 after rewrite** — playback always restarts from position 0 after a file is rewritten; seeking to the pre-rewrite currentTime triggered range requests that could land mid-frame in the new file causing PTS errors
- **Toast notification** — user sees "Tags saved — restarting from the beginning" / "Album art saved — restarting from the beginning" when the current song is rewritten
- **`_reloadFromPosition` improvement** — attempt 0 tries to resume from currentTime; attempt 1+ immediately falls back to position 0 (breaks 416 loop from resized files)
- **Skip after 5 retries** — `_reloadFromPosition` calls `Player.next()` + shows toast after 5 failed recovery attempts instead of looping forever

### Server Error Handler Fix (`src/server.js`)
- `RangeNotSatisfiableError` (status 416) from the `send` module was being converted to 500 because the global error handler only checked for `WebError` instances; now any error with an integer `.status` property has that status honoured — 416 is logged at debug level, not error, to avoid alarming log noise

### DB / Scanner Fixes
- **`countArtUsage`** added to `loki-backend.js` (was missing, only existed in sqlite-backend)
- **`updateFileArt` artSource passthrough** — `manager.js` now passes the 5th `artSource` argument through correctly (was silently dropped)
- **Scanner** — `.jpeg` extension normalised to `.jpg` for art files; `_preserveTs` timestamp preservation fixed; `refreshQueueUI()` call added after scan completes

### Rating Stars Fixes
- **Player bar stars always visible** — stars were hidden when a song had no rating; now always show 5 stars (dim when unrated, yellow when rated)
- **Star CSS class mismatch** — `starsHtml()` generates `.s-on`/`.s-off` but player bar CSS targeted `.ps-on`/`.ps-off` (never existed); fixed to `.s-on`/`.s-off` so yellow ratings render correctly
- **NP modal stars interactive** — clicking stars in the Now Playing modal now immediately updates `.lit` state without waiting for the `updateBar→renderNPModal` chain
- **NP modal unlit stars visible** — unlit stars changed from near-black `var(--t4)` to `rgba(255,255,255,.08)` with hover brightening so they are visible but don't compete with yellow rated stars

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
- **VU / Spectrum strip** — a fixed-height 90 px `vu-spec-row` container sits
  at the top of the player-left column.  It holds two `position:absolute`
  elements — the mini spectrum canvas (`#mini-spec`) and the VU needle wrap
  (`#vu-needle-wrap`).  Only one is visible at a time (`visibility:hidden`
  keeps layout stable on the inactive one).  Click anywhere on the strip to
  toggle between modes; choice persists in `localStorage('vu-mode')`.

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
- **Drag-and-drop reordering** — every queue row has a 6-dot grip handle
  (visible on hover) on its left edge.  Rows can be dragged to any position;
  the array and the current `S.idx` pointer are updated immediately and
  persisted to `localStorage`.

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

### Gapless Playback
- Toggle in the Playback Settings panel.  When enabled and crossfade is set
  to 0, the next track is silently prebuffered and scheduled for a
  sample-accurate handoff at the exact track boundary.
- **Mechanism** — two `GainNode`s (`_curElGain`, `_nextElGain`) both feed the
  same downstream graph.  The Web Audio clock is used to schedule
  `linearRampToValueAtTime` calls that ramp the outgoing gain from `1 → 0`
  and the incoming gain from `0 → 1` over 20 ms, centred on the computed
  `endAt` timestamp.  The 20 ms ramp covers one full cycle of a 50 Hz bass
  wave, eliminating both the click and bass thump that shorter ramps produce.
- An 80 ms `setTimeout` fires before `endAt` and starts the prebuffered
  element playing at gain 0 so the audio pipeline is already flowing when
  the scheduled swap fires — no cold-start latency at the boundary.
- The prebuffer window opens when ≤ 8 s remain on the current track.
  If the remaining time is < 80 ms the timer fires immediately.
- `_resetXfade()` cancels any scheduled Web Audio values and clears the
  timer if the user skips or stops mid-ramp.
- Setting is persisted in `localStorage` (`ms2_gapless_<username>`).

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
| **File Explorer** | Directory tree with breadcrumb, inline filter, folder and file rows; Upload button when server permits |
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
- Share → creates a time-limited share link via `POST /api/v1/share`

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

## Upload — GUIv2 Client

Full upload support added to the v2 GUI — previously only the legacy alpha UI had upload capability.

- **Upload button** in the File Explorer toolbar: appears only when the server has `noUpload: false` (stored as `S.canUpload`) and the user is browsed into a real directory (not the root `/`).
- **Modal** (`#upload-modal`) with:
  - Drag-and-drop zone — drop files directly onto it.
  - Browse button — opens the OS file picker; `accept` attribute is set dynamically from the server's `supportedAudioFiles` whitelist so the OS filters to audio only by default.
  - Per-file rows showing filename, size, a remove button (pre-upload) or status icon (`✓` / `✗` / `…`).
  - Per-file XHR progress bars updated via `xhr.upload.onprogress`.
- Files are validated against `S.supportedAudioFiles` before being queued; invalid types are rejected immediately with a `toastError()` — no network request is made.
- On completion the modal auto-closes and `viewFiles(dir)` is called to refresh the directory listing immediately.
- The upload target directory is the currently browsed path, sent as the `data-location` header (URI-encoded) on each XHR request.

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

## Security — Remove ffbinaries Dependency

Removed the `ffbinaries` npm package (and its abandoned `request` + vulnerable
`tough-cookie` transitive dependencies) from the project.

### Problem
`ffbinaries` pulled in `request@2.88.2` (officially abandoned 2020), which
required `tough-cookie@2.5.0` — a known Prototype Pollution vulnerability.
Dependabot could not auto-fix it because `request` will never accept a newer
`tough-cookie` version.

### Fix (`src/api/transcode.js`)
- Removed `import ffbinaries` entirely.
- `init()` now directly resolves the binary paths using `process.platform` to
  determine the correct extension (`.exe` on Windows, none on Linux/macOS).
- Checks that `ffmpeg` and `ffprobe` exist in `ffmpegDirectory` before setting
  the paths via `fluent-ffmpeg` — throws a clear error if they are missing.
- 49 packages removed from the dependency tree; `npm audit` reports
  **0 vulnerabilities**.

### Also fixed via `npm audit fix`
- `ajv` — ReDoS via `$data` option
- `fast-xml-parser` — stack overflow in XMLBuilder
- `minimatch` — ReDoS via repeated wildcards

---

## Bug Fix — Loki Backend Parity

Two functions added to `src/db/loki-backend.js` that existed in
`src/db/sqlite-backend.js` but were missing from the Loki backend, causing
the server to crash for Loki users when calling the reset endpoints:

- `resetPlayCounts(username)` — sets `pc = 0` on all user metadata records
- `resetRecentlyPlayed(username)` — sets `lp = null` on all user metadata records

Both are now consistent across SQLite and Loki backends.

---

## CUE Sheet Track Markers

The scanner now detects and stores cue-point data for tracks that have an
embedded CUE sheet (via a `CUESHEET` Vorbis comment / ID3 tag) or a sidecar
`.cue` file alongside the audio file.

### How it works
- `src/db/scanner.mjs` — after successfully parsing a file, attempts to find
  a CUE sheet via `music-metadata`'s `native` tags.  If none is embedded,
  a sidecar `<basename>.cue` next to the file is tried.
- Parsed cue points are serialised as a JSON string and stored in the
  `cuepoints` column of the files table.
- Files that have been checked and contain no cue data get `'[]'` (sentinel,
  distinguishes "checked, none found" from `NULL` = "never checked").
- On subsequent scans, files with a non-NULL `cuepoints` value skip the
  redundant re-parse unless the file `modTime` has changed.

### Player UI
- The progress bar in the **Now Playing** modal renders small tick marks at
  each cue point (`.cue-markers` container, one `.cue-mark` per point).
- Clicking a tick seeks directly to that timestamp.
- Hovering a tick shows a tooltip with the track title and index number.

### Admin Stats
- The scan stats card in the Admin Panel shows two new fields:
  - **With CUE** — files that have at least one cue point stored
  - **CUE Unchecked** — files not yet analysed (decreases as scans proceed)

See `docs/cue-sheet-markers.md` for full details.

---

## Bug Fix — Seek Bar Thumb (Now Playing modal)

The circular thumb on the seek bar inside the Now Playing modal was
invisible in both dark and light mode due to a missing CSS variable fallback.

- `.prog-thumb` now uses `var(--primary)` fill with `var(--surface)` border,
  making it a consistent purple dot that stands out against the progress track
  in both themes.
- Added `display: block` to prevent the inline default from collapsing the
  element in some browsers.

---

## Scan Error Audit

The scanner records every file that fails during a library scan into a
persistent, deduplicated **scan error log** visible in the Admin Panel.

### Backend (`src/db/scanner.mjs`, `src/api/scanner.js`, `src/db/manager.js`)
- Scanner child process catches errors per-file and calls
  `POST /api/v1/scanner/report-error` with a GUID = `md5(filepath|errorType)`.
- Deduplication: same file + error type increments `count` / updates
  `last_seen` rather than inserting a new row.
- `POST /api/v1/scanner/prune-errors` deletes rows older than a configurable
  retention window (default 48 h) at the start of every scan.
- `GET /api/v1/admin/db/scan-errors` returns the full log.
- `DELETE /api/v1/admin/db/scan-errors` clears the entire log.
- `PUT /api/v1/admin/db/scan-errors/retention` saves the retention hours to
  `default.json`.

### Error types recorded
`parse_error` · `album_art` · `cue_sheet` · `db_insert` · `other`

### Admin UI (`webapp/admin-v2/`)
- **Sidebar item "Scan Errors"** with a live count badge (red if > 0).
- Full table with type badge, file path, error message, count, and
  last-seen timestamp.
- Filter chips per error type.
- Retention-period dropdown (12 h → 30 days) saved on change.
- Clear All button (with confirmation).

Both SQLite and Loki backends implement the four required functions
(`insertScanError`, `getScanErrors`, `clearScanErrors`, `pruneScanErrors`).

See `docs/scan-error-audit.md` for full details.

---

## Live Scan Progress

While a library scan is running, both the **Admin Panel** and the
**player header** show real-time progress: percentage, file count, scan
rate, ETA, and the current file being processed.

### Backend (`src/state/scan-progress.js`, `src/db/task-queue.js`, `src/api/scanner.js`, `src/api/admin.js`)
- New in-memory module `src/state/scan-progress.js` — a `Map` keyed by
  `scanId` (nanoid).  Resets on server restart; no DB involved.
- `startScan(scanId, vpath, expected)` — called in `task-queue.js` just
  before forking the scanner child process.  `expected` is the current file
  count for that vpath (baseline for % calculation); `null` on a first scan.
- `tick(scanId, filepath)` — called in `POST /api/v1/scanner/get-file` for
  every file the scanner processes.  Increments the counter, stores the
  current filepath, and recalculates `filesPerSec` every 5 s.
- `finish(scanId)` — called both in the `close` event of the child process
  and in `POST /api/v1/scanner/finish-scan` to clean up.
- `GET /api/v1/admin/db/scan/progress` — returns a snapshot array with
  `{ scanId, vpath, scanned, expected, pct, currentFile, elapsedSec, filesPerSec, etaSec }`.

### Admin Panel (`webapp/admin-v2/`)
- The **Scan Queue & Stats** card auto-polls `/api/v1/admin/db/scan/progress`
  every 3 s while the component is mounted.
- Each active scan is shown as a card with:
  - Pulsing green dot · vpath label
  - `37%` badge (or `first scan` shimmer pill when no baseline exists)
  - Estimated time remaining (e.g. `est. 4m 12s`)
  - Scan rate (`29.6/s`)
  - Animated progress bar (deterministic fill or indeterminate shimmer)
  - File count (`50,811 / ~137,412`)
  - Current file path (truncated to 60 chars from the right)

### Player header (`webapp/v2/`)
- While scanning, a compact single-row pill appears in the top-right of the
  main content area (admin users only, hidden for regular users).
- Same height as the Append All / Play All buttons.
- Shows: pulsing dot · vpath · mini progress bar · `%` · file count.
- The full current file path is available as a tooltip on hover.
- Disappears automatically when the scan finishes.

See `docs/scan-progress.md` for full details.

---

## Dynamic Queue Panel Label

The **"Now Playing"** label at the top of the queue panel is now live and
reflects the exact playback state at all times.

| State | Icon | Label |
|---|---|---|
| Nothing in queue / no song loaded | ■ square | **Stopped** |
| Song loaded but paused | ⏸ pause bars | **Paused** |
| Song playing normally | ▶ triangle | **Now Playing** |
| Auto-DJ crossfade in progress | ▶▶▶ fading triangles | **Crossfading…** |

### Implementation (`webapp/v2/app.js`, `webapp/v2/index.html`)
- Added `id="qp-np-label"` to the label `<div>` in `index.html`.
- New `_syncQueueLabel()` function checks (in order):
  1. `_xfadeFired` — if a crossfade ramp is active, show **Crossfading…**
  2. `S.queue[S.idx]` — if no current song, show **Stopped**
  3. `audioEl.paused` — if paused, show **Paused**; otherwise **Now Playing**
- Called from:
  - `syncPlayIcons()` — fires on every `play` / `pause` audio event
  - `refreshQueueUI()` — fires when the queue changes or a new track loads
    (both the normal path and the empty-queue early-return path)
  - `_startCrossfade()` — immediately when the gain ramp begins
  - `_resetXfade()` — if a crossfade is aborted mid-way (e.g. manual skip),
    flips the label back to **Now Playing** or **Paused** instantly

---

## Player Bar Redesign — VU Meters, Balance, Volume Groups

### VU Needle Meters
- Full VU needle-meter module (`VU_NEEDLE`) added alongside the existing mini
  spectrum analyser. Click the centre strip to toggle between modes; the
  chosen mode persists in `localStorage('vu-mode')`.
- Two canvas dials (L/R) with ballistic needle physics, arc zone colouring
  (green → yellow → red), segment LED scale, and a peak-hold lamp.
- Lamp glow is dark-mode-only; light mode shows a plain solid dot.
- Both dial canvases and the spectrum canvas sit inside a fixed-height (90px)
  `position:relative` container so the player bar never shifts when switching
  modes — each element is `position:absolute` and is hidden via
  `visibility:hidden` (not `display:none`) to keep layout stable.
- **Ref-level knob** — a 34 px canvas knob between the two dials lets the user
  drag left/right to adjust the peak reference level (−10 to −20 dBFS).
  Drag right = more deflection/red. Center-logo clicks are blocked from
  triggering the mode toggle.
- **F5 / restore fix** — `VIZ.initAudio()` is called inside `_onAudioPlay()`
  so the analyser nodes always exist before the draw loop starts.

### Audio Chain — Stereo Balance
- A `StereoPannerNode` (`_pannerNode`) is inserted **after** the EQ band and
  **after** the analyser taps, so balance never affects VU meter or spectrum
  levels.  Full chain:
  `src → gain(1.25) → eq[0..7] → analyserNode (butterchurn tap) + splitter
  (L/R spectrum taps) → StereoPannerNode → destination`.
- Value restores from `localStorage('ms2_balance')`.

### Player-Right Redesign
- Rebuilt as two labeled column groups separated by a 1 px divider:
  - **Balance** group — EQ + DJ-light buttons above, Balance label, L/slider/R.
  - **Volume** group — Visualiser + Queue buttons above, Volume label,
    mute/slider/vol-%.
- Buttons are 38 × 38 px (`pright-btn`) with 19 × 19 SVG icons.
- Volume slider has a 4 px track, 14 px thumb, max-width 200 px.
- Live volume percentage label (`#vol-pct`) updates on input.
- Balance slider resets to centre on double-click; value stored in
  `localStorage('ms2_balance')`.
- The "C" display label next to the balance slider was removed (no practical
  use); the `_setBalVal` helper and the broken `#bal-val` click listener were
  cleaned up from the JS.

### Album Art / Song Info
- Thumbnail enlarged from 64 px → 104 px (responsive: 72 px).
- Player-left gap: 12 → 16 px.
- Title font: 16 → 18 px; artist: 14 → 15 px; album: 12 → 13 px.

### localStorage Persistence (F5 safe)
- **Volume** — saved to `localStorage('ms2_vol')` on every slider change;
  restored on load (default 80). `_preMuteVol` seeded from the same value so
  unmuting after a refresh restores the correct level.
- **Balance** — already saved to `ms2_balance`; panner node wired from it in
  `ensureAudio()` (was already correct).
- **VU ref-level knob** — `REF_LEVEL` now initialises from
  `localStorage('ms2_ref')` (default −13 dBFS) and is saved on every drag
  event (both mouse and touch).

### Mini Spectrum — 8-point quality pass
Eight improvements applied to the spectrum analyser:

1. **Ballistics** — instant attack, frame-rate-independent exponential release
   (τ = 300 ms). Bars feel physical instead of twitchy.
2. **Gravity-accelerated peak fall** — after the hold period the tick
   accelerates downward like a real physical object rather than dropping at a
   fixed rate.
3. **Peak tick colour shift** — while holding the tick is bright white-yellow;
   as it falls it blends toward the bar's own hue, giving a visual cue of age.
4. **Corner-radius guard** — `roundRect` only applied when the bar is tall
   enough that the radius doesn't eat the whole bar.
5. **Floor line** — subtle 1 px semi-transparent baseline anchors the display
   when music is quiet.
6. **Frequency range 40 Hz floor** — log scale starts at 40 Hz instead of
   20 Hz; better mid-range spread, less bass-bar dominance in the centre.
7. **Soft height compression** — `pow(v, 0.82)` applied to raw FFT values
   so loud signals don't always slam the ceiling; more headroom for peak ticks.
8. **Idle breathing glow** — when playback stops in spectrum mode a slow
   purple breathing gradient plays on the canvas instead of a blank rectangle.

### Mini Spectrum — Theme Colours

Bar gradients and peak ticks use the live CSS variables `--primary` and
`--accent` so they update instantly when the theme changes (or when dynamic
album-art colouring rewrites those variables).

- **Bar gradient** — `createLinearGradient` from `--primary` at the baseline
  to `--accent` at the bar tip, recomputed every frame.
- **Peak-hold tick** — filled with `--accent` at an opacity that tracks the
  tick's height.
- **Idle breathing glow** — uses `--primary` for the bar colour.

### Mini Spectrum — Inverted Butterfly
- Frequency axis flipped so bass meets in the centre and treble spreads to the
  outer edges (was: treble at centre, bass outside). The tall low-frequency
  bars now sit directly adjacent to the VU needle dials, making the meters
  more readable alongside the spectrum.

### Theme Label
- The "dark mode" label in the sidebar toggle renamed to **Blue** to reflect
  the navy/blue palette (a true black dark mode is a future TODO).

### Light Mode Sync
- VU arc colours, guide arc, peak lamp, background gradient, and knob arc all
  mapped to GUIv2 light-mode CSS tokens so both themes look consistent.

---

## Idle & Drain Animation States

### Mini Spectrum
- **Idle breathing glow** — when playback stops (or on page load before the
  first track plays) in spectrum mode, a slow sine-wave ripple of low bars
  plays continuously with a purple breathing gradient overlay.  Driven by a
  dedicated `idleRaf` RAF loop separate from the main draw loop.
- **Drain** — when a track is paused/stopped, a `_draining` flag is set
  instead of killing the draw loop immediately.  The draw loop feeds silence
  so bars fall naturally under their ballistic release curve before idle kicks
  in.  Once all bars fall below the floor threshold the drain loop exits and
  `drawIdle()` takes over.

### VU Needle Meters
- **Idle parking** — `_drawIdle()` paints both needles parked at the far-left
  (−∞ position) instead of leaving blank canvases.
- **Drain** — `_vuDraining` flag keeps the RAF alive on pause.  Needles fall
  under their normal ballistic TAU (300 ms) to −24.5 VU, then hand off to
  `_drawIdle()`.  The real audio-level feed is silenced during drain so the
  fall is smooth and deterministic regardless of the track's last loudness.

---

## Dynamic Album-Art Colour Theming *(GitHub Copilot, 2026-03-04)*

When a track with album art begins playing, the UI's `--primary` and `--accent`
CSS variables are rewritten to colours sampled from the artwork, so the
spectrum bars, waveform, progress-fill gradient, and VU brand text all shift
to match the current album.

- The art image is drawn onto a hidden 8×8 canvas and every pixel is examined
  in HSL space.
- Near-white (lightness > 0.88) and near-black (lightness < 0.08) pixels are
  **skipped** — they carry no real hue and polluted results on light covers.
- If the most saturated surviving pixel has saturation < 0.18 the art is
  considered colourless and any previous variable override is **removed**,
  restoring the CSS defaults.  This prevents white or greyscale sleeves from
  forcing a random faint hue.
- Otherwise `--primary` is set from the winning pixel's hue and `--accent` is
  derived from the same hue rotated 35° with a slight lightness shift, keeping
  the two colours related but distinct.
- When the track has no album art, or the image fails to load, both variables
  are removed and the CSS defaults take over — there is no carryover from the
  previous track.
- The function is a no-op if the URL has not changed since the last call
  (`_lastThemeUrl` guard), so switching from paused to playing never
  redundantly re-samples.

---

## Light Mode Overhaul

The `:root.light` palette and all light-mode override rules were substantially
revised to use a consistent lavender-gray language instead of near-white.

### Palette changes (`webapp/v2/style.css`)
| Token | Value | Role |
|---|---|---|
| `--bg` | `#e8e8f2` | Main content area — medium lavender-gray |
| `--surface` | `#f2f2fa` | Sidebar / player / queue panels |
| `--raised` | `#e4e4ef` | Raised elements over surface |
| `--card` | `#dcdcec` | Cards over bg |
| `--primary` | `#6d3ce6` | Accent purple (darker than dark-mode `#8b5cf6`) |
| `--t1` | `#0c0c1a` | Primary text |
| `--t2` | `#42425e` | Secondary text |
| `--t3` | `#7878a0` | Tertiary/label text |

### Canvas element light-mode fixes

Several canvas-drawn elements were using hardcoded `rgba(255,255,255,…)` alpha
colours for decorative lines, which were invisible against the light player
background:

- **Spectrum floor line and centre divider** — now `rgba(0,0,0,.12/.08)` in
  light mode (both idle and active draw loops).
- **Waveform unplayed region** — see *Waveform Display* section above.

The VU dial (`drawDial`) was already fully branched on `dark`/light and
needed no changes.

### Component overrides added
- **Sidebar** — vertical gradient `#eae8f8 → #e8e8f4` + purple-tinted
  right border + subtle drop shadow.
- **Player bar** — top-to-bottom gradient `#eceaf8 → #e4e2f0`, purple glow
  separator line (no hard `border-top`), ambient upward shadow.
- **Queue panel** — matching gradient + purple-tinted left border + shadow.
- **Content header** — downward gradient `#dddaf0 → #e4e4f0` + border +
  purple-tinted box-shadow.
- **Song rows** — hover `rgba(109,60,230,.07)`, playing `rgba(109,60,230,.10)`.
- **Nav items** — hover `rgba(100,80,200,.09)`, active `rgba(109,60,230,.13)`.
- **Control buttons** (`.ctrl-btn`) — hover `rgba(109,60,230,.10)`,
  active/playing `rgba(109,60,230,.15)`.
- **Vol/balance sliders** — track colour `rgba(109,60,230,.18)`.
- **Album cards** — resting `box-shadow:0 2px 8px rgba(0,0,0,.10)`.
- **Queue items** — hover + active backgrounds matching nav items.
- **VU / spectrum strip** — glassy gradient border, white inset highlight,
  ambient shadow (see Player Bar Visual Integration).

---

## Content Header Depth

The content-area header (`.content-header`) was flat and looked disconnected
from the visually richer sidebar and player.

- **Dark** — purple wash `linear-gradient(180deg,rgba(139,92,246,.07) 0%,
  transparent 100%)` composited over `var(--bg)`, downward ambient shadow,
  purple hairline at the bottom border.
- **Light** — downward gradient `#dddaf0 → #e4e4f0`, purple-tinted
  `border-bottom`, matching two-layer box-shadow.
- `position:relative; z-index:1` so the shadow appears above the scrollable
  content area.

---

## Player Bar Visual Integration

The player bar (`.player` + VU/spectrum strip + controls area) was redesigned
to feel cohesive with the rest of the UI instead of a flat "80s" panel.

### Dark mode
- **`.player`** — `background: linear-gradient(180deg, var(--surface) 0%,
  var(--raised) 100%)`.  Hard `border-top` removed; replaced with a
  `box-shadow` that draws: a purple glow hairline at the top edge
  (`0 -1px 0 rgba(139,92,246,.18)`), a large upward ambient shadow
  (`0 -12px 40px rgba(0,0,0,.35)`), and an inset top highlight
  (`inset 0 1px 0 rgba(139,92,246,.10)`).
- **`.vu-needle-wrap`** — opaque `var(--raised)` fill replaced with a
  near-transparent purple-tinted glass gradient.  Purple-hued border
  (`rgba(139,92,246,.15)`), inset top-edge highlight, subtle drop shadow.
- **`.vu-spec-row`** — ambient ring outline
  (`0 0 0 1px rgba(139,92,246,.10)`) + vertical drop shadow.
- **`.player-thumb`** — three-layer floating shadow (deep `0 8px 24px`,
  close `0 2px 6px`, 1px inset highlight ring).
- **`.player-center`** — very subtle frosted glass card
  (`background: rgba(255,255,255,.03)`, `border-radius:16px`, inset top
  highlight) groups the controls without hard borders.
- **`.vol-divider`** — replaced flat `var(--border)` with a
  `linear-gradient` that fades in/out through `rgba(139,92,246,.25)`,
  making the divider feel like part of the palette.

### Light mode
- All of the above has matching `:root.light` overrides using the `#6d3ce6`
  palette (see *Light Mode Overhaul*).
- VU/spec strip uses a white inset highlight instead of the dark-mode opaque
  one, giving a glassy appearance on the light background.

---

## OS Colour Scheme Auto-Detection

mStream v2 now honours the `prefers-color-scheme` media feature so the
correct theme loads on a first visit without any action from the user.

### Logic (`webapp/v2/app.js`)
- `applyTheme(light, persist = true)` gains a second parameter.
  - `persist = true` (default) — writes `ms2_theme` to `localStorage` as
    before.
  - `persist = false` — applies the theme visually without touching storage,
    so the user's explicit choice is never overwritten by OS changes.
- A `matchMedia('(prefers-color-scheme: dark)')` listener is registered at
  module load.  When the OS colour scheme changes it calls
  `applyTheme(!e.matches, false)` **only if `ms2_theme` is absent from
  localStorage** — i.e. the user has not yet made an explicit choice.
- On init, if `ms2_theme` is not in storage the theme is set from the OS
  media query (`persist = false`); if it is present the stored value wins
  as before.

### Behaviour matrix
| Condition | Result |
|---|---|
| Fresh visit, OS = dark | Dark mode (no entry written to localStorage) |
| Fresh visit, OS = light | Light mode (no entry written to localStorage) |
| User clicks toggle | Theme flips and is saved to localStorage |
| OS changes after user clicked toggle | No effect — stored preference wins |
| User clears localStorage | OS preference takes over again |

---

## Pending

- **Song ratings UI** — the DB column and Auto-DJ `minRating` filter exist;
  there is currently no way to set ratings from within v2 (star widget saves
  via the rate panel but no dedicated "Rated songs" browse view exists).
- **True dark mode** — a full black/grey palette (separate from the current
  blue theme) is planned but requires broader CSS variable changes.

---

## Player Bar Redesign & RTW 1206 PPM Meter

### Player Bar Layout Overhaul

The player bar (`<footer class="player">`) was rebuilt as a proper CSS grid
with three columns and three rows:

| Column | Content |
|---|---|
| 1 `minmax(0,1fr)` | Album art + song info (rows 1–3) |
| 2 `auto` | Playback controls + utility icons (row 1) |
| 3 `min(468px,38%)` | VU / spectrum strip (rows 1–3, right column) |

The progress timeline occupies `grid-column:1/3; grid-row:2` and the
volume/balance row occupies `grid-column:1/3; grid-row:3`, so the VU
column spans the full bar height without interacting with the timeline.

Changes from the old layout:
- `--player` height increased from `180px` to `210px` to accommodate the
  three-row grid.
- Utility icons (EQ, visualizer, queue) moved from the right `player-right`
  block into the centre `player-controls` row, separated from playback
  controls by a thin `ctrl-sep` divider (`1px`, `22px` tall,
  `rgba(139,92,246,.22)`).
- `player-right` now contains only the balance and volume sliders.
- `vu-spec-row` promoted to `grid-column:3; grid-row:1/4` — a permanent
  right column rather than a full-width strip below the controls.
- A `border-left:1px solid rgba(139,92,246,.12)` separates the VU column
  from the rest of the bar in dark mode; light mode uses `rgba(109,60,230,.16)`.
- Responsive: VU column is hidden below 860 px (`display:none`; the player
  collapses to a two-column grid).
- Album art thumb resized from 104 × 104 to 88 × 88 px to suit the tighter row.
- `player::before` ambient radial halo added (purple glow centred on play button).
- Progress bar fill changed from flat `var(--primary)` to a
  `linear-gradient(90deg, --primary, --accent)` for a livelier look.

### VU Needle Redesign

The analogue VU needle dials were redesigned for the new narrower column:

- **Sweep widened** from ±25° to ±55°, filling the available canvas width.
- **Angle table** updated to match the new range (−25 VU → −55°;
  +3 VU → +55°).
- **Transparent face** — the radial gradient fill was removed; the player bar
  background shows through the canvas.  Only a faint stroke ring provides
  bezel depth.
- **Pivot at canvas bottom** — `CY = VH = 120`, so the needle tail just exits
  below the canvas edge and is clipped naturally.
- **Arc radius reduced** from 130 to 108 virtual units to stay within the
  taller sweep.
- **`±` signs** repositioned inward (`R−5`) so they stay in-canvas at ±57°.
- **Brand text** brightened (`rgba(180,150,255,.90)`, `700` weight).
- **`VU` label** raised to `VH−12` so it's clear of the pivot.
- Background fill and glass-card CSS removed from `.vu-needle-wrap` in both
  dark and light themes.

### RTW 1206 PPM as 3rd Visualisation Mode

A horizontal Peak Programme Meter is added alongside the spectrum and VU
needle — mode cycle: `spec → needle → ppm → spec`, persisted in
`localStorage('vu-mode')`.

**Layout**

A `<div id="vu-ppm-wrap">` sibling is added inside `#vu-spec-row`, overlaid
via `position:absolute; top:24px; left:0; width:100%; height:100%`.  Inside
it lives a single `<canvas id="vu-ppm">` that is drawn every animation frame.

**Meter geometry** (virtual 200 × 64 coordinate space):

| Zone | Detail |
|---|---|
| Rows | L on top (`y=2`), R below (`y=19`), 13 virt-px tall each |
| Segments | 44, spanning −40 dBFS (`i=0`) to +3 dBFS (`i=43`) |
| Colours | Green ≤ −9, yellow −8..−2, red ≥ −1 (vivid hex: `#2ee87a`, `#f5c842`, `#ff5555`) |
| Unlit | `rgba(…, .12)` ghost squares |
| Scale | dB ticks at −40, −30, −20, −10, −5, 0, +3 |
| Brand | `RTW` text, bottom-left of scale |

**Ballistics** (real dBFS, no VU offset):

```
peakToDBFS()  →  raw dBFS from getFloatTimeDomainData
attack τ  = 5 ms  (near-instant LED response)
release τ = 1.5 s
peak hold = 2 s, then 2 s fade
```

**Brightness slider**

A hairline slider (`BS_H = 2 virt-px`) is drawn inside the canvas below the
dB scale.  A ☀ icon marks the low-brightness end.  Dragging the lollipop
thumb adjusts `ppmBrightness` (0.0–1.0, default `0.38`), persisted in
`localStorage('ms2_ppm_bright')`.  The effective alpha applied to all segments
is `0.22 + ppmBrightness × 0.78`, giving a true 0.22–1.0 range.

Slider zone click/drag events stop propagation so they don't trigger mode
switching; clicks outside the slider zone bubble through and do switch modes.

### Idle Spectrum Animation Tweak

The full-canvas breathing purple glow wash that overlaid the idle mini-spectrum
was removed.  Bars now breathe via alpha alone (`0.18 + 0.50 × wave × breath`)
against the transparent canvas/player background, which looks cleaner and
reduces the visual noise when nothing is playing.

---

## VU / PPM — Balance-Aware Metering

Previously the `analyserL` / `analyserR` nodes tapped the signal **before** the
`StereoPannerNode`, so the VU needle and PPM meters were always centred
regardless of the balance slider position.

The audio graph is now:

```
src → gain → EQ[0..7] → analyserNode (butterchurn, pre-pan)
                      └→ _pannerNode → destination
                                    └→ splitter → analyserL / analyserR
```

The Butterchurn visualizer still taps pre-pan (so the visual reacts to the full
stereo field, not the listener-side pan), while the VU/PPM analysers tap
**post-pan** — panning left now moves the left needle up and the right needle
down, exactly as expected on a real mixer.

---

## Queue Panel — Reopen Tab

When the queue panel is collapsed with the `<` button, a small `>` tab appears
fixed to the right edge of the viewport (centred vertically).  Clicking it
calls `toggleQueue()` and reopens the panel, after which the tab disappears.

**Implementation details:**

- `#qp-reopen-tab` button is placed at the top of `#queue-panel` in the DOM so
  the CSS selector `.queue-panel.collapsed #qp-reopen-tab` can drive its
  visibility.
- `position:fixed; right:0` escapes the panel's `overflow:hidden` (which is
  required for the collapse animation).
- Styled as a 28 × 52 px rounded-left pill matching `var(--surface)` and
  `var(--border)`, with a `>` chevron SVG.

---

## Queue Panel — Width

`--qp-width` increased from `320px` to `488px` to better align the queue
panel's left edge with the PPM/VU meter column in the player bar.

---

## Player Bar — Volume / Balance Alignment

- `.player-right` gains `padding-right:13px` so the right edge of the volume
  bar aligns with the right edge of the seek / progress bar.
- `.vol-pct` (`min-width`) raised to `34px` to match the time-display spans,
  and `margin-left:4px` added so the percentage text right-aligns under the
  end-time stamp.
- Font size of volume %, "BALANCE" label and L / R labels unified to `11px`
  (same as the seek-bar time display).
- All three elements changed from `var(--t3)` to `var(--t2)` to match the
  colour of the time display.

---

## Auto-DJ — Persistent Settings

The Auto-DJ source selection and minimum-rating filter are now persisted across
page reloads via `localStorage`:

| Key | Content |
|---|---|
| `ms2_dj_vpaths` | JSON array of selected vpath names |
| `ms2_dj_min_rating` | integer rating threshold (0 = Any) |

Both values are restored when the page loads and when `checkSession()` runs.
Saved vpaths are validated against the server's current vpath list on every
load; any entry that no longer exists is silently removed, and the selection
falls back to "all" if nothing valid remains.


---

## Waveform Display *(GitHub Copilot, 2026-03-04)*

A waveform canvas is drawn in the player bar progress area while a song is playing.

- Peaks are generated server-side via ffmpeg and cached in `localStorage` (`wf:` prefix) so they survive page reloads.
- The canvas is split into played (left) and unplayed (right) halves using clip regions; both use the `--primary → --accent` gradient.
- A 60 fps RAF loop keeps the split point in sync with playback position.
- `restoreQueue()` on page load triggers a waveform fetch for the currently queued track.
- When waveform data is present, the normal gradient fill bar is hidden (`background: transparent`).
- **Sub-vpath fix** — files whose vpath is a child folder of a larger indexed
  root (e.g. `12-inches` mapping to a subfolder inside `Music`) were returning
  a 404 when requesting waveform data.  The server now iterates all configured
  `folders` to find the owning root, re-resolves `relativePath` under that
  root, and uses the correct DB hash as the cache key.
- **Light-mode unplayed colour** — the unplayed bar region uses
  `rgba(0,0,0,0.20)` in light mode instead of the white `rgba(255,255,255,0.18)`
  that was invisible against the light player background.

---

## Genre Browsing *(GitHub Copilot, 2026-03-04)*

New sidebar section listing genres from the library.

- Genres are normalised before display: multi-value fields (`"Pop/Rock"`, `"Disco, Funk"`) are split on `,`, `;`, and `/`; near-duplicate spellings are merged by canonical key; genres with fewer than 10 songs are folded into the most word-similar larger genre.
- The "richest" spelling (most spaces/hyphens) wins the display name — `"New Wave"` beats `"NewWave"`, `"Synth-Pop"` beats `"Synthpop"`.
- Clicking a genre loads all matching songs. Songs tagged with multi-value strings appear in each constituent genre.

API: `/api/v1/db/genres` · `/api/v1/db/genre/songs`

---

## Decade Browsing *(GitHub Copilot, 2026-03-04)*

New sidebar section listing decades (1960s, 1970s, …) with song counts.

- Clicking a decade shows an album grid for that decade using virtual scroll.
- Albums are fetched via a `GROUP BY album, artist` DB query with indexes on `year`, making the query fast on large libraries.

API: `/api/v1/db/decades` · `/api/v1/db/decade/albums`

---

## Auto-DJ — Similar Artists Mode *(GitHub Copilot, 2026-03-04)*

A toggle in the Auto-DJ settings panel enables Similar Artists mode.

- When active, each Auto-DJ pick calls `GET /api/v1/lastfm/similar-artists` for the currently playing artist.
- The returned artist list is passed as the `artists` filter to `POST /api/v1/db/random-songs`, biasing picks towards similar artists in the local library.
- A toast confirms the result: `"Similar to David Bowie: Iggy Pop, Lou Reed, T. Rex +17 more"`.
- Falls back to unrestricted random if Last.fm returns no results or the call fails, with a toast explaining why.
- Toggle state is persisted in `localStorage` (`ms2_dj_similar_<user>`).

API: `/api/v1/lastfm/similar-artists`

---

## Seek Bar — DOM Arrow Indicator *(GitHub Copilot, 2026-03-05)*

Replaced the CSS `cursor:` SVG approach (which follows the OS pointer on both axes) with a proper DOM solution:

- `cursor:none` is set on `.player-progress` and `.np-progress` — the real pointer is hidden while over the bar.
- A `.seek-arrow` `<div>` (CSS border-triangle, white / amber on cue ticks) is appended to the container. Its `bottom` is fixed in CSS and **never touched by JS** — it can only move horizontally.
- `mousemove` on the container updates only `left` in pixels; vertical position is immovable.
- Disappears on `mouseleave`. Turns amber when hovering over a cue tick.
- Applied to both the player-bar row and the Now Playing modal track.
- No API changes.

---

## Auto-DJ Artist Cooldown — Persisted Across Reloads *(GitHub Copilot, 2026-03-05)*

The 8-song artist-cooldown window (`djArtistHistory`) was in-memory only — a server restart or page reload wiped it, allowing the same artist to repeat immediately.

- `S.djArtistHistory` is now seeded from `localStorage` key `ms2_dj_artist_history_<user>` on page load.
- Every call to `_djPushArtistHistory()` saves the updated array back to localStorage.
- `setQueue`, `playSingle`, and vpath source changes clear the key alongside the existing `ignore` cleanup.
- No server or API changes.

---

## Player Bar — UI Polish & Controls Redesign *(GitHub Copilot, 2026-03-07)*

A comprehensive pass over the player bar controls, info strip, icons, and interactive feedback.

### Transport Controls
- Wrapped shuffle / prev / play / next / repeat in `div.ctrl-transport` with `margin-right: 20px` to shift the transport group left of the utility buttons.
- **Sharp straight icons** — `stroke-linecap="square"` + `stroke-linejoin="miter"` applied to shuffle and repeat SVGs; `rx` removed from prev/next bar rects; repeat path arcs replaced with straight `L`-corner paths so corners are truly 90°.
- **Repeat-One** — `_svgRepeatAll` / `_svgRepeatOne` JS constants; `_syncRepeatIcon()` swaps the icon and renders a large `1` inside the SVG for repeat-one mode.
- Shuffle / repeat dot indicator (4 px circle below button) shows active state.

### Transport Feedback — Info Strip instead of Toasts
- Shuffle on/off, Repeat (Off / All / One Song), and all Sleep timer states now show in `_showInfoStrip()` (centered, no badge) instead of `toast()`.
- `_showInfoStrip` gains a 4th `center` param; `.dj-strip-center` CSS modifier hides the badge and centres content at 13 px.
- Text format: `Shuffle: On`, `Repeat: One Song`, `💤 Sleep timer set · 5 min`, etc.
- When Shuffle is toggled while Auto-DJ is active, strip shows: *Shuffle: On — but inactive, Auto-DJ is on*.

### Auto-DJ Status in Queue Label
- `_syncQueueLabel()` now shows `· AUTO-DJ` (accent colour) inline when Auto-DJ is on, and `· AUTO-DJ: SIMILAR SONGS` when Similar is also on.
- Label updates immediately when Auto-DJ or Similar Songs is toggled.

### DJ Badge → Headphones Icon Button
- Removed animated `dj-light` text pill with gradient sweep.
- Replaced with a `ctrl-btn ctrl-sm` headphones SVG icon (same size and style as EQ / visualizer).
- **Active** (DJ on): `var(--primary)` colour + 4 px dot indicator below.
- **Inactive** (DJ off): muted `var(--t3)` colour — always visible, never hidden.

### Utility Icons Alignment
- `ctrl-sm` buttons (Auto-DJ, EQ, Visualizer, Queue) bumped to **40 × 40 px**, SVGs to **22 × 22 px** — identical to shuffle and repeat.

### Queue Icon
- Replaced generic bulleted-list icon with a **play-queue icon**: filled play triangle (current track indicator) + 3 horizontal lines.
- Queue count badge: 9 px bold, `box-shadow: 0 0 0 2px var(--bg)` halo for readability against any background.
- **Auto-contrast badge text** — `_updateBadgeFg()` computes relative luminance of `--primary` (supports hex, rgb, and hsl formats) and sets `--badge-fg` to `#111` or `#fff` accordingly. Called from `applyTheme()` and from the album-art colour extractor so it updates on every primary colour change.

### Volume Slider Glow
- Removed persistent brightness-proportional glow (`--vol-glow` CSS var + JS calculation).
- Replaced with hover/active-only ring: `box-shadow: 0 0 0 3px rgba(139,92,246,.18)` on hover, 5 px on active.

### Velvet Name Alignment
- `align-self: flex-end` on `.brand-velvet` (sidebar) and `.vu-cn-velvet` (VU meter) — right-aligns the VELVET label under mStream.

### Custom Tooltips
- Replaced browser-native `title="…"` white tooltips with a custom `#tip-box` system.
- All `title` attributes are converted to `data-tip` at runtime; a `MutationObserver` handles dynamically added elements.
- Styled with `var(--raised)` background, themed border, `var(--t1)` text, 6 px radius, drop shadow — consistent across dark and light themes.
- Tooltip auto-dismisses after **5 seconds** if the mouse stays on the element; hides on `mouseout` and `mousedown`.
- `#tip-box` is declared before `app.js` in the HTML to prevent null-reference on load.

### DJ Similar Strip — Left Accent Border
- Removed flashing gradient badge entirely (`display:none`).
- Added `border-left: 3px solid var(--primary)` to the strip as a static active indicator.

---

## [Feature] Discogs — WAV/AIFF Cache-Only Art + Inline Info Note *(GitHub Copilot, 2026-03-08)*

**Files:** `webapp/v2/app.js`

Previously, the Fix Art picker would show for all file formats but the embed endpoint returned a 422 for WAV/AIFF/W64 files. Now the client detects the format and handles it gracefully:

- When the current song is a **WAV, AIFF, or W64** file the search button still appears, but below it a 2-line inline note is shown:
  > *WAV files can't store embedded art — art will be saved to the database only.*  
  > *It is lost on a DB reset or album-art cache delete.*
- When the current song is an **embeddable format** (mp3, flac, ogg, m4a…) the button appears alone as before.
- The extension is re-checked at click time: the embed status message shows `⏳ Saving art to database…` for WAV and `⏳ Embedding cover art…` for all other formats.
- After success, `refreshQueueUI()` is called alongside `renderNPModal()` and `Player.updateBar()` so the **queue panel** immediately shows the new art (this was previously missing).

---

## [Feature] Discogs — Allow Art Update flag (`S.discogsAllowUpdate`) *(GitHub Copilot, 2026-03-08)*

**Files:** `webapp/v2/app.js`

- New `S.discogsAllowUpdate: false` state field.
- Fetched from `GET /api/v1/admin/discogs/config` on login, `checkSession()`, and `visibilitychange` — alongside the existing `discogsEnabled` fetch.
- `renderNPModal()` now shows the Discogs cover-art section only when:
  ```
  S.isAdmin && S.discogsEnabled && (!song['album-art'] || S.discogsAllowUpdate)
  ```
  — when **Allow Art Update** is off, the Fix Art picker is hidden for songs that already have album art.

---

## [Feature] Last.fm — Server-Side Enable/Disable, Nav Button Gating *(GitHub Copilot, 2026-03-08)*

**Files:** `webapp/v2/app.js`, `webapp/v2/index.html`

### Nav button
- `<button data-view="lastfm">` now has `id="lastfm-nav-btn"` and the `hidden` CSS class (matches the Discogs nav button pattern).
- `showApp()` calls `document.getElementById('lastfm-nav-btn').classList.remove('hidden')` when `S.lastfmEnabled` is true.
- The button is shown for **all users** (not admin-only) since scrobbling is a user-facing feature.

### `S.lastfmEnabled` state
- New `S.lastfmEnabled: false` state field.
- Set by fetching `GET /api/v1/lastfm/status` (a public endpoint, already authenticated) and reading `response.serverEnabled`.
  - This is called after both login flow and `checkSession()` — outside the admin-only block so it works for regular users.
  - Also re-checked in the `visibilitychange` handler so disabling Last.fm in the admin panel is reflected without a hard reload.

### Scrobble gating
- Both scrobble timer blocks (in `playAt()` and the standalone playback handler) are now wrapped in `if (S.lastfmEnabled) { … }`.
- When disabled: `clearTimeout(scrobbleTimer)` still runs (cancels any in-flight timer) and the scrobble status string is cleared, but no new timer is started.

### `visibilitychange` handler
- Previously only checked Discogs (admin-only).
- Now also checks Last.fm status for all users and shows/hides `lastfm-nav-btn` accordingly.
- The admin-only Discogs block remains guarded by `if (S.isAdmin)` as before.

---

## [Feature] Visualizer — Art-Pulse VU Mode *(GitHub Copilot, 2026-03-08)*

**Files:** `webapp/v2/app.js`, `src/server.js`

A new visualizer mode added alongside the existing spectrum analyser: **Art-Pulse** — a two-sided VU bar display that reveals the album art through the bars.

### How it works
- A hidden `<canvas>` overlays the album art in the player bar left panel.
- 80 bars per side (L and R channels) are drawn using the same log-bin geometry and decay constants as the spectrum analyser (`logBin`, `GAP`, `relDecay = 0.30`, `barW`).
- **L channel**: treble far-left → bass at centre (mirrored).
- **R channel**: bass at centre → treble far-right.
- Each bar is a vertical "window" into the underlying album art — the image is cover-cropped to the canvas and each bar column is clipped, so the art is revealed proportionally to each frequency band's energy.
- **Peak-hold ticks** with gravity-accelerated fall (`HOLD_MS = 1200`, `GRAVITY = 0.7`) match the PPM meter feel.
- Canvas is hidden (`visibility: hidden; pointer-events: none`) when silent or when no album art is loaded.

### Album-art route hardened
- `GET /api/v1/db/album-art` no longer returns HTTP 404 when the physical file is missing from disk (e.g. cleared cache, partial Discogs download, manual deletion).
- Instead it serves a small inline SVG placeholder, preventing broken-image flashes in the player bar and Now Playing modal.

---

## [Fix] Discogs Modal — Album Art Drifts Down on Repeated Open/Close *(GitHub Copilot, 2026-03-08)*

**File:** `webapp/v2/app.js` — `hideNPModal()`

**Problem:** Opening the Discogs picker scrolls the `#np-left` panel (it becomes `overflow-y: auto` via `.np-left--picking`). Closing the modal removed the class but left `scrollTop` at a non-zero value. On the next open the `justify-content: center` layout rendered with the residual scroll offset, pushing the album art down. Repeated open/close cycles compounded the offset.

**Fix:** `hideNPModal()` now resets `np-left.scrollTop = 0` after removing `np-left--picking`.

---

## [Fix] Auto-DJ Similar Artists — Dominant-Artist Bias Eliminated *(GitHub Copilot, 2026-03-08)*

**Files:** `src/api/db.js`, `webapp/v2/app.js`

**Problem:** The random-songs endpoint selected a track from a flat list of all songs matching the 20 similar artists. An artist with 50 tracks had 10× the probability of being picked over an artist with 5 tracks, so 2–3 large-catalogue artists dominated every session.

**Fix — two-stage artist-fair selection (`src/api/db.js`):**
When `artists` filter is active (similar-artists mode), the endpoint now:
1. Collects all non-ignored candidate song indices.
2. Groups them by artist.
3. Picks one artist at random — **equal weight per artist**, regardless of catalogue size.
4. Picks one random song from that artist.
Standard (non-similar) mode is unchanged: single-stage flat random as before.

**Fix — increased artist cooldown (`webapp/v2/app.js`):**
`DJ_ARTIST_COOLDOWN` raised from `8` → `15`. Once an artist plays they go into a 15-song exclusion window, giving all other similar artists much more breathing room before any artist can repeat.

---

## [Change] Auto-DJ Strip — Show Up to 10 "Other Choices" Pills *(GitHub Copilot, 2026-03-08)*

**File:** `webapp/v2/app.js` — `_showDJStrip()`

The DJ info strip previously showed at most 5 artist pills under "Other choices were:". Raised to **10** to take better advantage of wider screens and the full 20-artist Last.fm result set.

---

## [Fix] Scanner — Preserve Discogs Art on File Rescan *(GitHub Copilot, 2026-03-08)*

**Files:** `src/api/scanner.js`, `src/db/scanner.mjs`

**Problem:** When a file's modification time changed (tags edited, re-encoded, etc.) the scanner deleted the old DB record and re-inserted it. For WAV/AIFF files — which cannot embed cover art — the new record had `aaFile = null`. The post-scan orphan cleanup then found the Discogs-assigned image no longer referenced in the DB and deleted it from `image-cache/`.

**Fix:**
- `GET /api/v1/scanner/get-file` (`src/api/scanner.js`): when removing a stale record, the old `aaFile` is now returned to the scanner child process as `_preserveAaFile`.
- `src/db/scanner.mjs`: after re-parsing a modified file, if the new parse yields no `aaFile` (normal for WAV/AIFF) but `_preserveAaFile` was supplied, the preserved value is written back into the insert payload before `insertEntries()` is called.
- Result: the DB record always carries the user's Discogs art reference → `runOrphanCleanup` sees it as live → the image file on disk is untouched.
