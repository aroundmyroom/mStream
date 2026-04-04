# mStream v2 TODO

---

## NOW — In Progress / Remaining

### 📡 Remote Control — Now Playing + Queue Panel — PLANNED

**Context:** `webapp/remote/index.html` already exists (303 lines) as a full Velvet-styled page accessible at `/remote/<code>`. It has a login screen, error screen, and a remote screen with prev/pause/next controls and a file browser. What is missing: (1) a Now Playing strip showing the current track, (2) a Queue panel showing the full playlist with jump-to-track and remove controls.

The implementation uses a server-side cache pattern: the main player tab (app.js) pushes state to the server when requested; the remote page polls the server cache. This avoids direct browser-to-browser communication.

The feature must be released as **v6.0.1-velvet** following the full 11-step release checklist.

---

#### STEP 0 — `webapp/remote/index.html` — Theme system upgrade (prerequisite for all other steps)

The remote page currently has a **broken 2-way theme system** that must be fixed before adding any new elements. All new HTML from Steps 3 must use only CSS custom properties — no hardcoded hex colors — so getting the theme system correct first is essential.

**Current problems to fix:**

- The default `:root` CSS block contains the Velvet (navy/purple) palette, but the theme button shows **"Dark"** — wrong label.
- There is no real Dark (true-black) theme — `html.dark` / `:root.dark` does not exist.
- The early-init IIFE at the top of `<body>` only understands `'light'` — needs to also apply `dark` class.
- The theme button cycles through **2 states** (dark ↔ light). Must become a **3-state cycle**: Velvet → Dark → Light → Velvet.
- The localStorage key is plain `'ms2_theme'` (no user suffix) — correct for the remote page; keep it but store `'velvet'` | `'dark'` | `'light'`.

**A. CSS variable blocks — replace `:root` and `html.light` with three blocks matching `webapp/style.css` verbatim:**

```css
:root {
  --bg:#1a1a2e; --surface:#16213e; --raised:#0f3460; --card:#1e2d4a;
  --border:#2a3a5e; --r:10px;
  --primary:#8b5cf6; --primary-h:#7c3aed;
  --primary-d:rgba(139,92,246,.15); --primary-g:rgba(139,92,246,.4);
  --accent:#60a5fa; --red:#f87171;
  --t1:#eeeeff; --t2:#8888b0; --t3:#7e8ec0;
}
:root.dark {
  --bg:#000000; --surface:#0d0d0d; --raised:#1c1c1e; --card:#141414;
  --border:rgba(255,255,255,.09);
  --primary:#a78bfa; --primary-h:#9061f9;
  --primary-d:rgba(167,139,250,.14); --primary-g:rgba(167,139,250,.38);
  --accent:#60a5fa; --red:#f87171;
  --t1:#f1f1f1; --t2:#8a8a9a; --t3:#707082;
}
:root.light {
  --bg:#e8e8f2; --surface:#f2f2fa; --raised:#e4e4ef; --card:#dcdcec;
  --border:rgba(0,0,0,.10);
  --primary:#6d3ce6; --primary-h:#5b28d4;
  --primary-d:rgba(109,60,230,.12); --primary-g:rgba(109,60,230,.35);
  --accent:#2563eb; --red:#dc2626;
  --t1:#0c0c1a; --t2:#42425e; --t3:#7878a0;
}
```

Also add Dark overrides for login/error screens, and rename all `html.light` → `:root.light` throughout the file.

> **Critical:** `var(--surface2)` does NOT exist anywhere — replace every occurrence in new HTML with `var(--card)`.

**B. Early-init IIFE — replace at top of `<body>`:**

```js
(function() {
  var t = localStorage.getItem('ms2_theme');
  if (t === 'dark') { t = 'velvet'; localStorage.setItem('ms2_theme', 'velvet'); } // legacy migration
  if (t === 'light') document.documentElement.classList.add('light');
  else if (t === 'dark') document.documentElement.classList.add('dark');
}());
```

**C. Replace `applyTheme(theme)` and `toggleTheme()`:**

```js
function applyTheme(theme) {
  document.documentElement.classList.remove('dark', 'light');
  if (theme === 'dark')  document.documentElement.classList.add('dark');
  if (theme === 'light') document.documentElement.classList.add('light');
  var labels = { velvet: 'Velvet', dark: 'Dark', light: 'Light' };
  document.getElementById('theme-label').textContent = labels[theme] || 'Velvet';
  var icon = document.getElementById('theme-icon');
  if (theme === 'light') {
    icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
  } else if (theme === 'dark') {
    icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  } else {
    icon.innerHTML = '<polygon points="12,2 15,9 22,9 16.5,14 18.5,21 12,17 5.5,21 7.5,14 2,9 9,9"/>';
  }
  localStorage.setItem('ms2_theme', theme);
}
function toggleTheme() {
  var cur = localStorage.getItem('ms2_theme') || 'velvet';
  applyTheme(cur === 'velvet' ? 'dark' : cur === 'dark' ? 'light' : 'velvet');
}
```

Init call: `applyTheme(localStorage.getItem('ms2_theme') || 'velvet');`

---

#### STEP 1 — `src/api/remote.js`

**1a.** Add after `const codeStartTime = {};`:
```js
const playlistCache = {};
const nowPlayingCache = {};
```

**1b.** Add to `allowedCommands`: `'getNowPlaying'`, `'goToSong'`

**1c.** On WS close, also: `delete playlistCache[code]; delete nowPlayingCache[code];`

**1d.** Add to `setupAfterAuth`:
```js
mstream.post('/api/v1/jukebox/update-playlist', (req, res) => {
  const schema = Joi.object({ code: Joi.string().required(), tracks: Joi.array().required(), idx: Joi.number().integer().min(0).required() });
  joiValidate(schema, req.body);
  if (!(req.body.code in clients)) { throw new WebError('Code Not Found', 404); }
  playlistCache[req.body.code] = { tracks: req.body.tracks, idx: req.body.idx, ts: Date.now() };
  res.json({});
});
mstream.post('/api/v1/jukebox/update-now-playing', (req, res) => {
  const schema = Joi.object({ code: Joi.string().required(), nowPlaying: Joi.object().required() });
  joiValidate(schema, req.body);
  if (!(req.body.code in clients)) { throw new WebError('Code Not Found', 404); }
  nowPlayingCache[req.body.code] = { ...req.body.nowPlaying, ts: Date.now() };
  res.json({});
});
```

**1e.** Add to `setupBeforeAuth`:
```js
mstream.get('/api/v1/jukebox/get-playlist', (req, res) => {
  const code = req.query.code;
  if (!code || !(code in clients)) { return res.json({ tracks: [], idx: 0 }); }
  res.json(playlistCache[code] || { tracks: [], idx: 0 });
});
mstream.get('/api/v1/jukebox/get-now-playing', (req, res) => {
  const code = req.query.code;
  if (!code || !(code in clients)) { return res.json(null); }
  res.json(nowPlayingCache[code] || null);
});
```

---

#### STEP 2 — `webapp/app.js`

In the `ws.onmessage` handler inside `_connectJukebox()`, add after the `addSong` branch:

```js
else if (msg.command === 'removeSong') {
  const idx = parseInt(msg.file, 10);
  if (!isNaN(idx) && idx >= 0 && idx < S.queue.length) {
    S.queue.splice(idx, 1);
    if (S.idx > idx) S.idx--;
    else if (S.idx === idx) S.idx = Math.min(S.idx, S.queue.length - 1);
    persistQueue();
    refreshQueueUI();
  }
}
else if (msg.command === 'goToSong') {
  const idx = parseInt(msg.file, 10);
  if (!isNaN(idx) && idx >= 0 && idx < S.queue.length) {
    Player.playIdx(idx); // verify exact function name — see STEP 4
  }
}
else if (msg.command === 'getPlaylist') {
  const tracks = S.queue.map(s => ({ title: s.title||null, artist: s.artist||null, album: s.album||null, 'album-art': s['album-art']||null, filepath: s.filepath }));
  fetch('/api/v1/jukebox/update-playlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${S.token}` },
    body: JSON.stringify({ code: S.jukeCode, tracks, idx: S.idx }),
  }).catch(() => {});
}
else if (msg.command === 'getNowPlaying') {
  const song = S.queue[S.idx] || null;
  fetch('/api/v1/jukebox/update-now-playing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${S.token}` },
    body: JSON.stringify({ code: S.jukeCode, nowPlaying: {
      title: song?.title||null, artist: song?.artist||null, album: song?.album||null,
      albumArt: song?.['album-art']||null, filepath: song?.filepath||null,
      currentTime: audioEl.currentTime||0, duration: audioEl.duration||0, playing: !audioEl.paused,
    }}),
  }).catch(() => {});
}
```

---

#### STEP 3 — `webapp/remote/index.html`

**3a. Now Playing strip** — immediately after `<div id="remote-screen">`, before controls:
```html
<div id="np-strip" style="display:none; align-items:center; gap:12px; padding:12px 16px; background:var(--card); border-radius:10px; margin-bottom:12px;">
  <img id="np-art" src="" alt="" style="width:48px;height:48px;border-radius:6px;object-fit:cover;background:var(--raised);flex-shrink:0;" onerror="this.style.display='none'">
  <div style="flex:1;min-width:0;">
    <div id="np-title" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px;color:var(--t1);">—</div>
    <div id="np-artist" style="font-size:12px;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
    <div style="height:3px;background:var(--raised);border-radius:2px;margin-top:6px;">
      <div id="np-prog" style="height:100%;background:var(--accent);border-radius:2px;width:0%;transition:width 1s linear;"></div>
    </div>
  </div>
  <div id="np-badge" style="font-size:11px;color:var(--t3);flex-shrink:0;">▶</div>
</div>
```

**3b. Queue toggle button** — after prev/play/next row:
```html
<button id="queue-toggle-btn" onclick="toggleQueue()" style="margin-top:12px;width:100%;padding:8px;background:var(--raised);border:none;color:var(--t2);border-radius:8px;cursor:pointer;font-size:13px;">▤ Queue</button>
```

**3c. Queue panel** — after controls section, before file browser:
```html
<div id="queue-panel" style="display:none; margin-bottom:12px;">
  <div style="font-size:12px;color:var(--t3);padding:4px 0 8px;font-weight:600;letter-spacing:.05em;">QUEUE</div>
  <div id="queue-list" style="display:flex;flex-direction:column;gap:2px;max-height:300px;overflow-y:auto;"></div>
  <button onclick="refreshQueueRemote()" style="margin-top:8px;width:100%;padding:6px;background:var(--raised);border:none;color:var(--t3);border-radius:6px;cursor:pointer;font-size:12px;">↻ Refresh</button>
</div>
```

**3d. JS functions** (use `sendCommand(cmd, file)` — the existing name in remote/index.html — not `pushCmd`):

```js
let _npTimer = null;
function startPolling() {
  pollNowPlaying(); pollPlaylist();
  if (_npTimer) clearInterval(_npTimer);
  _npTimer = setInterval(pollNowPlaying, 2000);
}
function stopPolling() { if (_npTimer) { clearInterval(_npTimer); _npTimer = null; } }
async function pollNowPlaying() {
  try {
    const np = await (await fetch(`../../api/v1/jukebox/get-now-playing?code=${remoteCode}`)).json();
    const strip = document.getElementById('np-strip');
    if (!np || !np.filepath) { strip.style.display = 'none'; return; }
    strip.style.display = 'flex';
    document.getElementById('np-title').textContent  = np.title  || np.filepath.split('/').pop();
    document.getElementById('np-artist').textContent = np.artist || '';
    const art = document.getElementById('np-art');
    if (np.albumArt) { art.src = `../../${np.albumArt}`; art.style.display = ''; } else { art.style.display = 'none'; }
    document.getElementById('np-prog').style.width = (np.duration > 0 ? (np.currentTime / np.duration * 100).toFixed(1) : 0) + '%';
    document.getElementById('np-badge').textContent = np.playing ? '▶' : '⏸';
  } catch(_) {}
}
let _queueVisible = false;
function toggleQueue() {
  _queueVisible = !_queueVisible;
  document.getElementById('queue-panel').style.display = _queueVisible ? 'block' : 'none';
  document.getElementById('queue-toggle-btn').textContent = _queueVisible ? '▤ Hide Queue' : '▤ Queue';
  if (_queueVisible) refreshQueueRemote();
}
async function refreshQueueRemote() {
  sendCommand('getPlaylist');
  await new Promise(r => setTimeout(r, 400));
  pollPlaylist();
}
async function pollPlaylist() {
  try {
    const pl = await (await fetch(`../../api/v1/jukebox/get-playlist?code=${remoteCode}`)).json();
    const list = document.getElementById('queue-list');
    if (!pl || !pl.tracks || pl.tracks.length === 0) {
      list.innerHTML = '<div style="color:var(--t3);font-size:12px;padding:8px 0;">Queue is empty</div>'; return;
    }
    list.innerHTML = pl.tracks.map((t, i) => {
      const active = (i === pl.idx);
      const name = t.title || t.filepath.split('/').pop();
      const sub  = t.artist || '';
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:${active?'var(--raised)':'transparent'};${active?'color:var(--accent);font-weight:600;':'color:var(--t1);'}">
        <div style="flex:1;min-width:0;cursor:pointer;" onclick="goToSong(${i})">
          <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;">${active?'▶ ':''}${esc(name)}</div>
          ${sub?`<div style="font-size:11px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(sub)}</div>`:''}
        </div>
        <button onclick="removeSong(${i})" style="flex-shrink:0;background:none;border:none;color:var(--t3);cursor:pointer;font-size:16px;padding:2px 4px;line-height:1;">×</button>
      </div>`;
    }).join('');
  } catch(_) {}
}
function goToSong(idx) {
  sendCommand('goToSong', String(idx));
  setTimeout(() => { sendCommand('getNowPlaying'); setTimeout(pollNowPlaying, 500); }, 300);
}
function removeSong(idx) {
  sendCommand('removeSong', String(idx));
  setTimeout(refreshQueueRemote, 400);
}
```

**3e.** Declare `var remoteCode = remoteProperties.code;` as a top-level variable. Wire `startPolling()` when the remote screen becomes visible; `stopPolling()` when the WS closes.

---

#### STEP 4 — Verify `Player.playIdx` in `webapp/app.js`

Before implementing Step 2, search for the function used when clicking a queue item in `refreshQueueUI()`. Use that exact same call for the `goToSong` WS handler in Step 2.

---

#### STEP 5 — Changelog + docs + release

1. Update `changes-fork-velvet.md` with versioned entry for v6.0.1-velvet
2. Add `/api/v1/jukebox/get-playlist` and `/api/v1/jukebox/get-now-playing` in `docs/API.md` index
3. Follow the 11-step release checklist for **v6.0.1-velvet** — "Remote control: Now Playing + Queue panel"

---

### Per-user File Upload Permission — PLANNED

Currently upload is gated only by the server-wide `config.program.noUpload` flag. No per-user toggle exists.
Model: admin always has upload; regular users need explicit `allowUpload` permission (default: true).

- [ ] `src/state/config.js` — add `allowUpload: Joi.boolean().default(true)` to user schema
- [ ] `src/util/admin.js` — `addUser()` / `editUserAccess()` save `allowUpload`
- [ ] `src/api/file-explorer.js` — upload endpoint checks `req.user.allowUpload === false` → 403
- [ ] Admin UI (`webapp/admin/index.js`) — toggle button per user (same pattern as allow-radio-recording button)
- [ ] `GET /api/v1/ping` — expose `noUpload` per user so client can hide the upload button
- [ ] Update `changes-fork-velvet.md`

> Note: ytdl download is a **separate** endpoint and permission — do NOT gate it with `allowUpload`.

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
- [x] **Your Stats (Wrapped)** — `play_events` + `listening_sessions` tables; play-start/end/skip/stop API hooks wired into the player; per-period stats (top songs/artists, heatmaps, personality, fun facts); user "Your Stats" nav view; admin "Play Stats" panel with purge tool — **DONE**
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
