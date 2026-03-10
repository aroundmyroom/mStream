# Admin Panel GUIv2 — Change Log

All changes to `webapp/admin-v2/` (the GUIv2-styled admin panel).
The classic admin at `webapp/admin/` is untouched throughout.

---

## 2026-03-10

### Velvet Gradient Logo
- `webapp/admin-v2/index.html`: favicon inline SVG updated to the Velvet dual-gradient mark; sidebar brand SVG polygons replaced with the same gradient definitions (`#c4b5fd` → `#6d28d9` outer, `#4c1d95` → `#a78bfa` inner) — matches the main GUIv2 player and remote control tab
- `webapp/admin-v2/index.js` About view: legacy flat mStream wordmark SVG replaced with the Velvet gradient icon + `mStream Velvet / Admin Panel` text header using the same CSS variable typography (`--t1`, `--t2`, `--primary`) as the rest of the GUIv2 UI; gradient IDs namespaced (`aa-vg-o`, `aa-vg-i`) to avoid SVG `<defs>` ID collisions

---

## [Initial] Created `webapp/admin-v2/` — Separate GUIv2 Admin

**Problem:** The old admin panel (`webapp/admin/`) uses Materialize CSS, green buttons, floating labels, and a completely different visual language from the GUIv2 player. Attempts to restyle it in-place broke the classic admin.

**Fix:** Created `webapp/admin-v2/` as a completely separate directory — a patched copy of the classic admin JS with all Materialize dependencies removed and GUIv2 styling applied. The classic admin at `/admin` is left 100% intact.

**Files:**
- `webapp/admin-v2/index.html` — New entry point: GUIv2 sidebar, theme toggle, modal mount points
- `webapp/admin-v2/index.css` — Full GUIv2 CSS variables (dark/light), no Materialize
- `webapp/admin-v2/index.js` — All Vue components patched from classic admin
- `src/server.js` — Added `/admin-v2` auth-guarded route alongside `/admin`
- `webapp/v2/index.html` + `webapp/v2/app.js` — Added "Admin Panel" → `/admin-v2` and "Classic Admin" → `/admin` footer links in the GUIv2 player

---

## [Fix] Removed All Materialize JS Dependencies from `index.js`

**Problem:** Classic admin uses `M.Modal`, `M.Tabs`, `M.FormSelect`, `M.updateTextFields` from Materialize JS — none of which exist in admin-v2.

**Fix:**
- `M.Modal.getInstance().open()` / `.close()` → `modVM.openModal()` / `modVM.closeModal()`
- `M.Modal.init(...)` block → `document.addEventListener('click', ...)` for `.modal-close` class
- `M.updateTextFields()` — removed (not needed with label-above form pattern)
- `M.FormSelect.init()` / `selectInstance[0].destroy()` — removed; native `<select>` used
- `M.Tabs` in `rpnView` and `federationMainPanel` → `activeTab` Vue data + `v-show` buttons
- `usersVpathsView`: `selectInstance[0].getSelectedValues()` → `Array.from(document.querySelectorAll(...option:checked)).map(el => el.value)`

---

## [Fix] Modal System — `modVM` Restructured

**Problem:** Classic admin uses Materialize modals triggered by ID. Admin-v2 needs a Vue-controlled modal.

**Fix:**
- `modVM` Vue instance mounts on `#admin-modal-wrapper`
- `modalOpen` boolean controls visibility via `v-show`
- `currentViewModal` string drives `<component :is="...">` dynamic component
- `openModal()` / `closeModal()` methods used throughout
- `'edit-select-codec-modal'` typo fixed → `'edit-transcode-codec-modal'`

---

## [Fix] HTML Syntax Error — `toggleSideMenu` Orphaned `else` Blocks

**Problem:** `index.html` had corrupted `toggleSideMenu` JavaScript with orphaned `else` blocks causing a parse error.

**Fix:** Rewrote the function cleanly using `.open` CSS class toggle on `#sidenav`.

---

## [Fix] CSS ID Mismatches — Sidebar Overlay and FAB

**Problem:** JS referenced `#sidebar-overlay`, `#sidebar-fab` which didn't exist in the HTML.

**Fix:**
- `#sidebar-overlay` → `#sidenav-cover`
- `#sidebar-fab` → `.fixed-action-btn` / `.hamburger-btn`
- `#main-content` → `#content`

---

## [Fix] API Errors on Linux

**Problem:** `win-drives` endpoint returned HTTP 400 on Linux, causing a console error. Federation startup call fired even on non-federation servers causing a 405.

**Fix:**
- `src/api/admin.js`: `win-drives` returns `[]` on Linux instead of HTTP 400
- `index.js`: Federation startup API call wrapped in `if (ADMINDATA.serverParams.federation.enabled)`

---

## [Fix] Removed All Green Materialize Buttons

**Problem:** All action buttons used `btn green waves-effect waves-light` — green is Materialize's default but looks completely wrong in GUIv2 (which uses `--primary` purple).

**Fix:** All `btn green waves-effect waves-light` → `btn`. All `waves-*` classes stripped. GUIv2 CSS `--primary: #8b5cf6` (purple) applies automatically.

---

## [Feature] Theme Toggle — Matches GUIv2 Player Exactly

**Problem:** The original theme toggle was a plain icon button, visually different from the GUIv2 player's slider toggle.

**Fix:** Replaced with the full GUIv2 slider: moon/sun SVG icons + label text + track + thumb. Identical HTML structure, CSS classes (`theme-toggle`, `theme-toggle-track`, `theme-toggle-thumb`, `theme-icon-moon`, `theme-icon-sun`), and `applyTheme()`/`localStorage('ms2_theme')` logic as the GUIv2 player.

---

## [Redesign] Directories View — `foldersView` Component

**Problem:** The Add Directory form used Materialize floating labels, side-by-side fields that misaligned, and required scrolling off-screen to reach the Add button. No explanations on the checkboxes.

**Fix:**
- Fields stacked vertically (full-width) — "Directory Path" then "Path Alias" — alignment is now impossible to break
- "Directory Path" input is `readonly` with pointer cursor + inline Browse button; makes it obvious it is a picker, not a text field
- "Path Alias (vPath)" has descriptive help text below
- Both checkboxes have title + descriptive explanation text:
  - **Give access to all users** — explains auto-access for all users
  - **Audiobooks & Podcasts** — explains that files are scanned into a separate spoken-word library, not the main music collection
- Add Directory button lives in `.card-action` at card bottom — always visible, no scrolling
- Existing directories shown in a separate card below with colour-coded vPath `<code>` and a red Remove button

---

## [Redesign] Browse Directories Modal — `fileExplorerModal` Component

**Problem:** Navigation was plain `[back] [home] [refresh]` bracket links. No modal header. `document.getElementById('dynamic-modal').scrollIntoView()` referenced a non-existent element (old Materialize ID). Current path shown as unstyled `<h6>`. "Select Current Directory" was a bare `[<a>]` link.

**Fix:**
- Proper modal header: "Browse Directories" title + `×` close button
- Navigation bar with SVG icon buttons: **Up** / **Home** / **Refresh** (styled `btn-flat btn-small`)
- **Select Current** button right-aligned in the navigation bar
- Current path shown as `<code>` with accent colour below the toolbar
- Directory listing in a `max-height: 50vh; overflow-y: auto` scroll region — never overflows the screen
- Each row: folder SVG icon + name (overflow ellipsis) + per-row Select button
- Removed stale `document.getElementById('dynamic-modal').scrollIntoView()` call

---

## [Fix] Modal Rendering — Dialog Centered on Screen

**Problem:** `.modal-backdrop` and `.modal-dialog` were siblings in the HTML. The backdrop was `position:fixed` covering the screen, but the dialog was a plain div rendered in document flow — it appeared below all page content, off screen.

**Fix:** Nested `.modal-dialog` inside `.modal-backdrop`. The backdrop is a flex container (`align-items: center; justify-content: center`) so the dialog is always dead-centered. `@click.stop` on the dialog prevents the backdrop-click-close from firing when clicking inside.

---

## [Fix] Font — Replaced Jura with GUIv2 System Font Stack

**Problem:** `admin-v2` loaded the Jura custom font (a narrow geometric typeface). GUIv2 uses the native OS system font stack. Text looked noticeably different when switching between the two.

**Fix:**
- Removed `<link href="../assets/fonts/jura.css">` from `index.html`
- `font-family` in `index.css` changed to `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`
- Removed `.iziToast { font-family: 'Jura' }` override

---

## [Fix] Logo — Replaced SVG Wordmark with GUIv2 Icon Mark

**Problem:** The admin-v2 sidebar showed a 100px-wide full SVG wordmark spelling out "mStream" in vector paths. GUIv2 uses a small 26×26px three-bar icon mark + the word "mStream" in plain bold text.

**Fix:**
- Replaced the large SVG wordmark with the identical 26×26px icon mark used in the GUIv2 player
- "mStream" label in bold 15px (`font-weight:700; letter-spacing:-.2px`) matching `.sidebar-brand` in GUIv2
- Small "Admin Panel" subtitle below in uppercase `--t3` colour
- `.side-nav-brand` padding/gap updated to match GUIv2's `.sidebar-brand` exactly (`padding: 18px 16px 14px; gap: 10px`)

---

## [Fix] Confirm Dialogs — Replaced `iziToast.question` Yellow Popups

**Problem:** All 15 destructive-action confirmations (remove directory, delete user, remove SSL, toggle features, etc.) used `iziToast.question()` — a yellow Materialize-styled toast popup that is completely inconsistent with GUIv2's modal style.

**Fix:** Replaced all 15 calls with a new `adminConfirm(title, message, label, fn)` helper backed by a dedicated `confirmVM` Vue instance:
- Renders using the same `.modal-backdrop` + `.modal-dialog` CSS as all other admin-v2 modals
- Title supports HTML (`v-html`) for bold/dynamic text
- Optional message line in `--t2` colour
- **Go Back** (flat) and a red **confirm** button with a dynamic label
- Clicking outside (backdrop) cancels — consistent with all other modals
- Dialog capped at `max-width: 420px` (compact for yes/no vs `600px` for file browser)
- Also fixed: 5 callbacks missing `async` keyword, 6 template-literal labels using broken single-quote syntax, 15 double-semicolon `};;` artifacts from extraction, and a broken `enableFederation` try/catch block that lost its `await API.axios(...)` call during transformation

---

## 14 — iziToast: GUIv2-themed notifications

**Problem:** All `iziToast.warning / .error / .success / .info` toasts rendered with iziToast's default Materialize-style coloured backgrounds (orange, red, green, blue). The warning shown after folder removal ("Server Rebooting…") was particularly jarring — bright orange against the dark GUIv2 surface.

**Fix (`webapp/admin-v2/index.css`):** Added a CSS override block that resets every toast to the GUIv2 surface (`var(--surface)`, `var(--border2)` border, `var(--t1)/var(--t2)` text) and replaces the full background colour with a slim left-border accent per type:

| Type | iziToast class | Accent colour |
|---|---|---|
| warning | `.iziToast-color-orange` | `#f59e0b` amber |
| error | `.iziToast-color-red` | `var(--red)` #ef4444 |
| success | `.iziToast-color-green` | `#22c55e` green |
| info | `.iziToast-color-blue` | `var(--accent)` blue |
| question | `.iziToast-color-yellow` | `#eab308` yellow |

Progress bar tinted to match per-type accent. Close button uses `filter: invert(1)` in dark mode so it's visible on the dark surface; restored in `:root.light`. No JS changes needed — purely additive CSS covering all 76 remaining iziToast calls.

---

## [Fix] SSL Modal — Pre-populated Fields and Write Target

**Problem:** `editSslModal` `data()` initialised `certPath` and `keyPath` as empty strings, so the modal always opened blank even when certs were already configured. The `updateSSL` method also wrote the new values into `dbParams.scanInterval` (copy-paste error) instead of `ssl.cert`/`ssl.key`.

**Fix (`index.js` — `editSslModal`):**
- `data()` now reads `ADMINDATA.serverParams.ssl.cert` / `.key` to pre-fill both fields
- `updateSSL` writes `Vue.set(ADMINDATA.serverParams.ssl, 'cert', ...)` and `...ssl, 'key', ...` — correct targets
- Added a missing `catch(err) {}` block that prevented the `finally` from running on API failure

---

## [Fix] Button Hover — Text Goes Invisible in Dark Mode

**Problem:** The global rule `a:hover { color: var(--primary); }` overrode the white text on `.btn` elements when hovered, making button labels invisible (white btn → purple text).

**Fix (`index.css`):** Added `color: #fff` to the `.btn:hover, .btn-large:hover, .btn-small:hover` rule so button text stays white regardless of the link hover colour.

---

## [Fix] Settings & Database — Content Not Centered

**Problem:** `.form-card` and `.content-switcher` both had `max-width` set but no `margin: 0 auto`, so they sat left-aligned on wide screens.

**Fix (`index.css`):**
- `.form-card` — added `margin: 0 auto 1.5rem`
- `.content-switcher` — added `margin: 0 auto`

---

## [Feature] Database View — Rich Stats Panel

**Problem:** The DB view only showed a file count after clicking "Pull Stats". There was no breakdown of artists, albums, genres, formats, cover-art coverage, ReplayGain tagging, decade distribution, or recent additions.

**Fix:**

*Backend (`src/db/sqlite-backend.js`, `src/db/loki-backend.js`, `src/db/manager.js`, `src/api/admin.js`):*
- Added `getStats()` to both DB backends. Returns: `totalFiles`, `totalArtists`, `totalAlbums`, `totalGenres`, `withArt`, `withoutArt`, `withReplaygain`, `addedLast7Days`, `addedLast30Days`, `oldestYear`, `newestYear`, `formats[]`, `topArtists[]`, `topGenres[]`, `decades[]`, `perVpath[]`, `lastScannedTs`
- SQLite: uses 12 queries; all string comparisons use single-quoted literals (SQLite treats `!= ""` as column reference, not empty string); year queries filtered to `1900–2030` to exclude corrupt ID3 tags; formats grouped by `LOWER(TRIM(format))`; timestamps stored as Unix seconds — cutoffs computed as `nowSec - N * 86400`; `lastScannedTs` returned as `ts * 1000` (ms for frontend)
- LokiJS: single-pass JS loop over `fileCollection.data` with same rules (seconds cutoffs, decade filter, `toLowerCase().trim()`)
- `manager.js`: exports `getStats()`
- `admin.js` stats endpoint: returns `db.getStats()` instead of `{ fileCount }`

*Frontend (`index.js` — `dbView`):*
- 10 summary "chip" cards: Tracks, Artists, Albums, Genres, With Art, No Art, ReplayGain, Added 7d, Added 30d, Year Range
- Four horizontal bar-chart sections: Formats, Top Artists, Top Genres, Decades — each bar fills proportionally, coloured distinctly
- "Tracks per Folder" section (shown when more than one vpath)
- "Last file added" timestamp formatted with `toLocaleString()`
- Guarded with `v-else-if="dbStats && dbStats.totalFiles != null"` so old servers that return only `{ fileCount }` still get a graceful fallback message

*Styles (`index.css`):* Added `.stat-grid`, `.stat-chip`, `.sc-num`, `.sc-label`, `.stat-section-row`, `.stat-section`, `.stat-section-title`, `.stat-bar-row`, `.stat-bar-bg`, `.stat-bar-fill`, `.stat-bar-bg`, `.stat-bar-count`; global `.spinner { width/height: 28px !important }` rule to stop the Materialize 65px override.

---

## [Fix] Go to Player — Invalid URL on `/admin-v2/` Path

**Problem:** The sidebar "Go to Player" link used `window.location.href.replace('/admin', '')`. On the `/admin-v2/` path this corrupted `:3000-v2/` → invalid URL.

**Fix (`index.html`):** Changed onclick to `window.location.href = window.location.origin + '/'` — always navigates to the server root regardless of current path.

---

## [Fix] Player — Auto-play Triggers on Page Load After Navigating Back

**Problem:** When returning to the GUIv2 player from the admin panel, Auto-DJ called `play()` on a paused track, resuming playback unexpectedly.

**Root cause:** `persistQueue` did not save the playing state; `restoreQueue` always called `play()` if auto-DJ was on; `setAutoDJ(true)` on page init immediately tried to advance playback.

**Fix (`webapp/v2/app.js`):**
- `persistQueue` now saves `playing: !audioEl.paused`
- `restoreQueue` only calls `play()` after `loadedmetadata` if `data.playing === true`
- `setAutoDJ(on, skipAutoStart)` — added `skipAutoStart` parameter; page-init call uses `setAutoDJ(true, true)` to skip the auto-advance on restore

---

## [Fix] Transcoding View — FFmpeg Logo Sizing & Dark Mode

**Problem:** The FFmpeg SVG logo had no explicit size, defaulted to 224px wide and showed the text group in black (invisible in dark mode).

**Fix:**
- Added `class="ffmpeg-logo"` to `<svg>` and `class="ffmpeg-text"` to the text `<g>`
- CSS: `.ffmpeg-logo { height: 36px; width: auto; max-width: 200px; display: block; }`
- CSS: `.ffmpeg-logo .ffmpeg-text { fill: var(--t1); }` — text inherits the theme foreground colour
- Replaced `<h4>Powered By</h4>` + block SVG with `.powered-by-row` flex container (`display:flex; align-items:center; gap:1rem`) matching the pattern applied to Syncthing below
- CSS: `.powered-by-row`, `.powered-by-label` added

---

## [Fix] Removed "Coming Soon" Stubs

**Problem:** Three UI locations showed non-functional "Coming Soon" messages or triggered empty toasts:
1. Logs view — "Logs Directory" `[edit]` link triggered a `changeLogsDir()` function that only showed an "Under Construction" toast
2. Transcoding view — "FFmpeg Directory" `[edit]` link triggered a `changeFolder()` function with the same toast
3. Users view — Last.FM modal opened to a blank "Coming Soon" card

**Fix (`index.js`):**
1. Logs Directory row: removed `[edit]` link; replaced action cell with muted text `"Edit in config file"`
2. FFmpeg Directory row: same treatment
3. Last.FM modal: the modal and its trigger method `openLastFmModal` were never reachable from any template button — removed entirely (see Audit section below)
- Removed `changeLogsDir()` and `changeFolder()` methods

---

## [Fix] Federation View — Permanent Loading Spinner

**Problem:** On first load, `ADMINDATA.getFederationParams()` was only called inside an `if (serverParams.federation && serverParams.federation.enabled)` guard. If federation was disabled (the default), the function was never called, `federationParamsUpdated.ts` stayed at `0` forever, and the spinner never cleared.

`getFederationParams()` already handles the disabled case gracefully — on a 404/non-federation server it sets `federationEnabled.val = false` and always updates `federationParamsUpdated.ts = Date.now()`.

**Fix (`index.js` startup block):** Removed the conditional; `getFederationParams()` is always called unconditionally after `getServerParams()` resolves.

---

## [Fix] Federation View — Syncthing Logo Sizing & Layout

**Problem:** The Syncthing SVG logo had `max-width="200px"` as an SVG attribute (invalid — has no effect), no CSS sizing, and used the old `<div class="row logo-row">` + `<h4>Powered By</h4>` layout pattern (inconsistent with the FFmpeg fix above).

**Fix (`index.js`, `index.css`):**
- Replaced `<div class="row logo-row">` + `<h4>` with `.powered-by-row` flex container + `<span class="powered-by-label">` — same pattern as Transcoding view
- Removed invalid `max-width="200px"` SVG attribute; added `class="syncthing-logo"`
- CSS: `.syncthing-logo { height: 36px; width: auto; display: block; max-width: 220px; }`

---

## [Fix] About View — mStream Logo Dark Mode

**Problem:** The large mStream SVG wordmark in the About view used hardcoded hex fills (`#7aa0d4`, `#aac4e8`, `#26477b`) — visible in dark mode but overly bright/saturated in light mode, and no adaptation to theme changes.

**Fix (`index.css`):**
- Added `--mlogo-a`, `--mlogo-b`, `--mlogo-c` CSS variables with dark and light values
- `.mstream-logo .st0 { fill: var(--mlogo-a) !important }` and `.st1` / `[fill="#26477b"]` overrides
- Colours shift to darker navy/slate in light mode without touching the SVG source

---

## [Audit] Code Quality Pass — Miscellaneous Fixes

Full review of all admin-v2 components. Issues found and fixed:

| Component | Issue | Fix |
|---|---|---|
| `advancedView` | `openModal` method defined twice (duplicate silently overwriting first) | Removed duplicate definition |
| `editScanIntervalView` | Modal subtitle and field label said "seconds"; display shows "hours" | Changed to "hours" throughout |
| `editSaveIntervalView` | Modal subtitle and field label said "seconds"; display shows "files" | Changed to "files" throughout |
| `lastFMModal` | Component, its `modVM` registration, `openLastFmModal` method in `usersView`, and `ADMINDATA.lastFMStorage` were all dead code — no template ever called the method | Removed entirely |
| `federationGenerateInvite` | `window.location.protocol === 'https'` missing colon — always false | Fixed to `=== 'https:'` |
| `getWinDrives` | `console.log(res.data)` debug log left in production code | Removed |
| `lockView` | Raw `<h2>`, `<p>`, `<br><br>` tags — no card wrapper, looks unstyled | Rewritten with `.card` / `.card-content` / `.card-action` pattern; explanatory text as `<ul>` list; action as `<button class="btn red">` |
| `federationMainPanel` | "Generate Invite Token" was a `<p>` used as click target — not keyboard-accessible | Changed to `<button class="btn-flat btn-small">` |
| `federationMainPanel` | Accept Invite "Server URL" input had no `v-model`, used dead Materialize `class="validate"` and floating-label pattern | Added `inviteServerUrl: ''` to `data()`; `v-model="inviteServerUrl"`; changed to label-above input pattern |
---

## [Audit] Backend Bug Pass — Full Project Source Review

Full review of all backend source files. Issues found and fixed:

---

### [Fix] Security — GET /api/v1/admin/users sends password hashes to browser

**File:** `src/api/admin.js`

**Problem:** The scrubbing loop iterated all top-level keys of the users object (which are usernames — `alice`, `bob`, etc). These never match the strings `"password"` or `"salt"`, so the condition is never true and nothing is deleted. Every user's hashed password and salt were sent verbatim to the admin panel frontend on every page load.

```js
// BROKEN — iterates username keys, never matches 'password' or 'salt'
Object.keys(memClone).forEach(key => {
  if(key === 'password' || key === 'salt') { delete memClone[key]; }
});
```

**Fix:** Iterate usernames and delete the nested properties on each user object.

```js
Object.keys(memClone).forEach(username => {
  delete memClone[username].password;
  delete memClone[username].salt;
});
```

---

### [Fix] POST /api/v1/admin/users/lastfm — three compounding bugs

**Files:** `src/api/admin.js`, `src/util/admin.js`

**Problem 1 — Field name typos:** Schema field names were `lasftfmUser` / `lasftfmPassword` (letters transposed — `lasftfm` instead of `lastfm`). Any client sending the correct field names would receive a Joi validation error.

**Problem 2 — Wrong argument:** The handler called `admin.setUserLastFM(req.body.username, req.body.password)`. `req.body.password` was not in the Joi schema so Joi strips it — it is always `undefined`.

**Problem 3 — Function did not exist:** `admin.setUserLastFM` was not exported from `src/util/admin.js` at all. The call would throw `TypeError: admin.setUserLastFM is not a function` at runtime.

**Fix:**
- Corrected schema field names to `lastfmUser` / `lastfmPassword`
- Fixed handler call to `admin.setUserLastFM(req.body.username, req.body.lastfmUser, req.body.lastfmPassword)`
- Implemented `setUserLastFM(username, lastfmUser, lastfmPassword)` in `src/util/admin.js` following the same transaction pattern as `editUserAccess`: deep-clone → update clone → save config file → update live `config.program.users`; stores under `lastfm-user` / `lastfm-password` keys as expected by the scrobbler

---

### [Fix] GET /api/v1/admin/config — federation object not included in response

**File:** `src/api/admin.js`

**Problem:** The config endpoint returned `address`, `port`, `noUpload`, `writeLogs`, `secret`, `ssl`, `storage`, `maxRequestSize` but omitted `federation`. The frontend's `serverParams.federation` was always `undefined`.

**Fix:** Added `federation: config.program.federation` to the response object.

---

### [Fix] POST /api/v1/lastfm/test-login — wrong config path for API credentials

**File:** `src/api/scrobbler.js`

**Problem:** The HMAC signature string used `config.program.apiKey` and `config.program.apiSecret` — both `undefined` at the top level. The correct path is `config.program.lastFM.apiKey` / `config.program.lastFM.apiSecret`. As a result, the generated `api_sig` hash was always wrong and every Last.FM login test would return an authentication error from the Last.FM API.

**Fix:** Changed both references to `config.program.lastFM.apiKey` and `config.program.lastFM.apiSecret`.

---

### [Fix] package.json — Linux syncthing binary path typo

**File:** `package.json`

**Problem:** The Electron builder `linux.files` array listed `"bin/syncthng/syncthing-linux"` — missing the `i` in `syncthing`. The directory is `bin/syncthing/`. Electron builds for Linux would silently omit the syncthing binary from the package.

**Fix:** Corrected to `"bin/syncthing/syncthing-linux"`.

---

### [Fix] Comment typo — "fronted" → "frontend" (webapp/admin-v2/index.js)

**File:** `webapp/admin-v2/index.js`

**Problem:** 17 inline comments used `fronted` where `frontend` was intended (e.g. `// update fronted data`). No runtime impact.

**Fix:** Global replacement via `sed`; zero occurrences remain.

---

### [Note] federation/invite/accept — incomplete feature, not a bug

**File:** `src/api/federation.js`

The `POST /api/v1/federation/invite/accept` endpoint has its axios handshake call commented out and returns `{}` unconditionally. This is a work-in-progress feature stub, not an accidental regression. Left as-is pending federation implementation.

---

## [Fix] Admin Panel Tab — No Longer Spawns Multiple Instances

**Files:** `webapp/v2/index.html`, `webapp/admin-v2/index.html`

**Problem 1:** The "Admin Panel" footer link used `target="_blank"` — every click opened a fresh tab, leading to multiple admin instances fighting each other.

**Fix (`webapp/v2/index.html`):** Changed to `target="mstream-admin"`. The browser opens one named tab on first click and reuses it on every subsequent click. Also removed `rel="noopener"` (which was blocking `window.opener` — required for the return fix below).

**Problem 2:** The "Go to Player" link in the admin sidenav used `window.location.href = /` — this navigated the admin tab to a new player instance rather than switching back to the original player tab, so music effectively restarted.

**Fix (`webapp/admin-v2/index.html`):** The link now checks `window.opener` first. If an opener exists (i.e. admin was opened from the player), it calls `window.opener.focus()` then `window.close()` — returning focus to the original tab with music still playing. Falls back to `window.location.href = /` when accessed standalone.

---

## [Feature] Classic UI — Hidden by Default, Toggleable via Admin

**Files:** `webapp/v2/index.html`, `webapp/v2/app.js`, `webapp/admin-v2/index.js`

**Problem:** The Classic UI links (login screen "← Back to Classic UI", footer "Classic UI" player link, and footer "Classic Admin" button) were always visible. There was no way to hide them for a clean GUIv2-only experience.

**Solution:** All three links are now hidden by default. A single `localStorage` flag (`ms2_show_classic`) controls their visibility across the whole app.

- **`webapp/v2/index.html`**: Added `id="classic-login-link"` and `id="classic-player-btn"` to the two classic player links; footer classic link starts with `class="hidden"`
- **`webapp/v2/app.js` init block**: Hides `#classic-login-link` on page load unless `ms2_show_classic === '1'`
- **`webapp/v2/app.js` `showApp()`**: Only unhides `#classic-player-btn` and `#classic-admin-btn` when the flag is set
- **`webapp/admin-v2/index.js` `advancedView`**: Added `showClassicUI` data property (reads from localStorage) and a new **UI Settings** card with a `Classic UI (player & admin links): Hidden / Visible [show/hide]` toggle row. `toggleClassicUI()` writes or removes the `ms2_show_classic` key and toasts "Reload the player tab for changes to take effect"

---

## [Feature] QR Connect Page — Rewritten in GUIv2 Style

**File:** `webapp/qr/index.html`

**Problem:** The QR tool page still used Materialize CSS — green buttons, floating labels, white background — completely out of place when opened from the GUIv2 player. It also had two bugs:
1. Read `localStorage.getItem("token")` — the old key; GUIv2 stores the session token under `ms2_token`, so the username never pre-filled
2. The password field was `type="text"` — credentials visible in plain text on screen

**Fix:** Full rewrite — Materialize removed entirely, page now uses the same CSS variables (`--bg`, `--surface`, `--raised`, `--accent`, `--t1/t2/t3`, `--border`, `--r`) as the GUIv2 player:
- Dark/light theme toggle (sun icon, top-right), reads and writes `ms2_theme` to stay in sync with the player
- Label-above input pattern matching the admin panel style  
- Live QR regeneration on every keystroke (`oninput`) — no button press needed  
- Password field changed to `type="password"`
- Token pre-fill corrected to `ms2_token`
- `materialize.js` dependency removed; page has zero external CSS/JS dependencies beyond `qr.js` and `jwt-decode.js`
---

## [Fix] VU Meter — Repositioned Into Player Layout Flow

**Files:** `webapp/v2/index.html`, `webapp/v2/style.css`

**Problem:** The `#mini-spec` canvas was `position:absolute` at the very top of the player bar, visually detached from the controls and progress bar. On smaller screens it overlapped other elements.

**Fix:** Moved `#mini-spec` out of its old anchor point and into `.player-center` as a plain flow element, sitting below the progress bar. CSS changes:
- `position:absolute` / `top` removed from `.mini-spec`; replaced with `width:100%; height:28px` (block flow)
- `.player-center` `gap` reduced to `0` — controls, progress, and VU are tightly stacked
- `.player` gained `padding: 8px 20px 18px 20px` to lift the whole bar off the browser bottom edge

Final order in `.player-center`: song controls → progress bar → VU meter canvas.

---

## [Fix] Admin Logout — URL Crash + Incomplete Token Cleanup

**File:** `webapp/assets/js/api.js`

**Problem 1 — URL crash:** `logout()` and `goToPlayer()` both built the redirect URL with `window.location.href.replace('/admin', '')`. When the admin panel is at `/admin-v2` this strips only the literal string `/admin`, leaving `…3000-v2/login` — an invalid URL that threw:
> `SyntaxError: Failed to execute 'assign' on 'Location': '…3000-v2/login' is not a valid URL`

**Fix:** Both functions now use `window.location.origin + '/'` as the base, which is always valid regardless of the current path.

**Problem 2 — Stale session:** `logout()` only cleared `localStorage.removeItem('token')` (the old classic-UI key). The GUIv2 session key `ms2_token` was never removed, so a GUIv2 player tab would remain "logged in" after the admin signed out.

**Fix:** `logout()` now removes both `token` and `ms2_token`.

---

## [Feature] Admin Logout — Confirmation Warning

**Files:** `webapp/admin-v2/index.html`

**Problem:** Clicking Logout in the sidebar immediately called `API.logout()` with no warning. Users who had music playing in the player tab had no chance to cancel.

**Fix:** The logout `onclick` now calls `adminConfirm('Sign out?', 'Music playing in the player tab will stop.', 'Sign Out', () => API.logout())` — the existing confirmation dialog — before proceeding. Users must explicitly confirm; clicking outside or pressing Cancel leaves the session intact.

---

## [Fix] Logout — Stop Player in All Open Tabs

**Files:** `webapp/assets/js/api.js`, `webapp/v2/app.js`

**Problem:** Confirming logout in the admin panel only cleared storage and redirected the admin tab. Any open player tab continued playing music with a now-invalid session.

**Fix:** Uses the `BroadcastChannel` API (channel name `mstream`):
- `api.js` `logout()` posts `{ type: 'logout' }` on the channel _before_ redirecting
- `app.js` registers a listener at startup; on receiving `logout` it immediately pauses audio, clears both token keys, and redirects the player tab to the login page

Works for any number of open player tabs regardless of how the admin panel was opened (named tab, direct URL, etc.). The `try/catch` around both sides silently ignores the rare private-browsing contexts where `BroadcastChannel` is unavailable.

---

## [Fix] Logout — Queue Saved as Paused, No Auto-Play on Re-login

**File:** `webapp/v2/app.js`

**Problem:** When the player tab received the logout broadcast and was redirected to login, the queue was saved to localStorage with `playing: true` (the `beforeunload` handler fired while the audio element was still considered playing). On re-login `restoreQueue()` read that flag and immediately called `audioEl.play()` — starting music automatically even when it should stay paused.

**Fix:** In the broadcast logout handler, `persistQueue()` is now called explicitly right after `audioEl.pause()` and before the tokens are cleared. This guarantees the saved snapshot has `playing: false`. `restoreQueue()` then restores the queue position and seeks to the saved time, but does not call `audioEl.play()` — the player stays paused on login regardless of auto-DJ or any other setting.

---

## [Fix] Admin Panel Button — Never Navigates Player Tab Away

**Files:** `webapp/v2/index.html`, `webapp/v2/app.js`

**Problem:** The "Admin Panel" footer link used `target="mstream-admin"`. When the admin tab closed itself via `window.close()`, the browser could reassign that window name to the player tab. The next click on "Admin Panel" would then navigate the player tab to `/admin-v2`, killing playback.

Switching to `target="_blank"` fixed that specific case but broke `window.opener` — the admin's "Go to Player" button relies on `window.opener` to focus the player tab and close itself.

**Fix:** Replaced the `<a>` element with a `<span onclick="openAdminPanel()">` and added `openAdminPanel()` to `app.js`:
- Stores the admin window in a module-level `_adminWin` variable
- If that window is still open, focuses it (no duplicate tabs)
- If not, opens a fresh one via `window.open('/admin-v2', '_blank')`

Since `window.open()` always sets `window.opener` on the new tab, the admin's "Go to Player" (`window.opener.focus(); window.close()`) continues to work perfectly. The player tab is never navigated away.

---

## [Fix + Rewrite] Jukebox Remote Page — GUIv2 Style + 500 Error Fixed

**Files:** `webapp/remote/index.html`, `webapp/remote/index.css`, `webapp/remote/index.js`, `src/api/remote.js`

### Backend fix — 500 → proper 4xx
`remote.js` was throwing plain `new Error(...)` for unknown code / invalid command, which the global error handler mapped to HTTP 500. Fixed by importing `WebError` and throwing `new WebError('Code Not Found', 404)` and `new WebError('Command Not Recognized', 400)`.

### Remote page — full rewrite (no Materialize, no Vue, no axios)
The `/remote/:code` page was using Materialize CSS and Vue 2, resulting in a white-only page completely out of place on mobile.

**Rewritten as pure vanilla HTML/CSS/JS:**
- GUIv2 CSS variables (`--bg`, `--surface`, `--raised`, `--accent`, `--t1/t2/t3`, `--border`) — full dark/light theme
- Theme syncs with the player via `ms2_theme` localStorage key; toggle button top-right
- Topbar with mStream logo and "Remote Control" label
- Login card: enter code manually if not arriving via QR link; error feedback; Enter key submits
- Auto-connects immediately when server pre-injects `remoteProperties` (QR scan flow)
- **Controls**: ⏮ Previous, ⏯ Play/Pause (accent-coloured large button), ⏭ Next — all send commands via `fetch` with the jukebox token
- Brief `ctrlToast` feedback line below controls on each command
- **File browser**: breadcrumb path + back button, folder/file icons, tap anywhere on a song row OR tap "+ Queue" button to add to queue; spinner while loading
- No external dependencies — zero CDN calls, works fully offline on local network

## Remote login screen — GUIv2 modal style
- Added `--primary`, `--primary-h`, `--primary-d`, `--primary-g`, `--red` CSS variables to remote page (dark + light)
- Login `#login-screen` now uses the same radial-gradient purple glow background as GUIv2
- `.login-card` upgraded: `border-radius:22px`, deep `box-shadow` (dark mode) / soft shadow (light mode)
- `.field-input` focus state now shows primary-color border + `box-shadow: 0 0 0 3px var(--primary-d)` glow ring
- `.btn-primary` now uses `--primary` purple with hover glow and active scale, matching GUIv2 login button
- Added centered logo + title + subtitle brand block inside login card (replacing plain `<h2>` + `<p>`)

## v2 login screen — input visibility & brand polish
- `.login-card` border upgraded from `--border` (7% white) to `--border2` (13% white) — more defined card edge
- `.login-card` box-shadow slightly stronger purple glow; added explicit light-mode shadow override
- `#login-form input` background changed from `var(--raised)` (near-black, invisible) to `rgba(255,255,255,.06)` — clearly visible translucent fields in dark mode
- `#login-form input` border changed from `var(--border)` (7% opacity, invisible) to `rgba(255,255,255,.16)` — solid visible border in dark mode
- Added `:root.light #login-form input` override: `background:rgba(0,0,0,.05); border-color:rgba(0,0,0,.18)` — fixes "grey background" appearance in light mode
- Login brand logo SVG updated from grey-blue (`#6684B2`/`#26477B`) to purple (`#a78bfa`/`#7c3aed`) — aligns with primary color theme

## v2 login — properly visible inputs matching remote page style
- `.login-card` background changed from `var(--surface)` (#101018, near-black) to `var(--card)` (#1a1a26) — card now visually separates from the page background
- `#login-form input` dark mode: background `rgba(255,255,255,.11)`, border `rgba(255,255,255,.28)` — strongly visible fields on dark card
- `#login-form input` light mode: background `#d8d8ee`, border `rgba(0,0,0,.22)` — clearly defined purple-tinted fields contrasting the light card

## v2 login — full remote-page style parity
- Root cause identified: v2 global theme uses near-black transparent colors (--bg:#08080e, --border:rgba(255,255,255,.07)) making inputs invisible
- Fix: Scoped remote-page's solid-color variables directly onto #login-screen so all child elements (card, inputs, labels) inherit them — identical to remote page
- Dark mode: --surface:#16213e, --raised:#0f3460, --border:#2a3a5e, --t1:#e0e0f0, --t2:#a0a8c0, --t3:#6070a0
- Light mode: --surface:#ffffff, --raised:#e4e8f0, --border:#d1d5db, --t1:#111827, --t2:#4b5563, --t3:#9ca3af
- #login-form input now uses var(--raised) + var(--border) — same as .field-input on remote page
- Added field-label <label> elements above each input (Username / Password) matching remote page layout
- Login card border/shadow match remote page exactly

## Remote page — styled error screen for invalid/expired codes
- `src/api/remote.js`: `/remote/:code` route no longer throws on invalid code (was causing 500 SERVER ERROR)
  - Now serves the remote page HTML with `remoteProperties = { error: true }` injected
- `webapp/remote/index.html`: Added `#error-screen` — hidden by default, shown when `remoteProperties.error === true`
  - Red-tinted radial-gradient background (dark + light variants)
  - `.error-card`: same card style as login card (border-radius:22px, box-shadow) with centered content
  - `.error-icon`: circular red badge with info/alert SVG icon
  - Heading "Code Not Found", message explaining the code is invalid or expired
  - "Try Another Code" button linking to `/remote/` — purple primary button with hover/active effects
- Login screen and remote screen are both hidden; JS checks `remoteProperties.error` at startup and shows correct screen

## Login & remote page — restore correct mStream logo colors
- Both login card logos were using purple (#8b5cf6/#6d3ce6) from a prior change
- Restored to original mStream brand colors: outer polygons #6684B2, center polygon #26477B — matches topbar logo and all other instances in the app

## Remote page — play buttons match GUIv2 exactly
- Removed old `.ctrl-btn` / `.ctrl-btn.large` with blue accent background and hard borders
- Added `.ctrl-nav` (44×44px, no background, hover rgba) for Prev/Next — matches v2 player bar
- Added `.play-main` (56×56px, `var(--primary)` purple, hover glow ring `box-shadow:0 0 0 8px var(--primary-d)`) — matches v2 player bar
- Controls row wrapped in `.ctrl-row` flex container inside `.controls` column flex
- `ctrl-toast` feedback line restored inside controls block

## Remote page — play/pause button icon toggles
- Play button now has two SVGs: play triangle (#play-icon) and pause bars (#pause-icon)
- `_isPlaying` state variable tracks optimistic play state
- `updatePlayBtn()` toggles visibility of the two icons
- On successful `playPause` command: `_isPlaying` flips, icon updates immediately
- On connect (`showRemote`): `_isPlaying` resets to false (assume paused, unknown state)
- Matches v2's dual-icon play/pause button pattern

## GUIv2 dark mode — navy blue background (remote-style) [EXPERIMENTAL / REVERTABLE]
- Replaced near-black dark palette with remote page's solid navy blue palette
- --bg: #08080e → #1a1a2e
- --surface: #101018 → #16213e
- --raised: #16161f → #0f3460
- --card: #1a1a26 → #1e2d4a
- --border: rgba(255,255,255,.07) → #2a3a5e (solid, visible)
- --border2: rgba(255,255,255,.13) → #3a4e72 (solid)
- --t3: #44445c → #6070a0 (more readable muted text on lighter bg)
- --t4: #2a2a3e → #2a3a5e
- Original values kept in comment block in style.css for easy revert
- TO REVERT: in style.css :root block, uncomment the "ORIGINAL NEAR-BLACK DARK" block and remove the navy values, restore --t3:#44445c --t4:#2a2a3e

## All pages — navy dark palette applied everywhere
- webapp/qr/index.html: --bg #08080e→#1a1a2e, --surface #101018→#16213e, --raised #16161f→#0f3460, --border rgba(.07)→#2a3a5e, --border2 rgba(.13)→#3a4e72, --t3 #44445c→#6070a0
- webapp/admin-v2/index.css: same bg/surface/raised/card, plus --t4 #2a2a3e→#2a3a5e, --border #2a2a3e→#2a3a5e, --border2 #3a3a52→#3a4e72
- webapp/shared/index.html: already inherits from v2/style.css (updated previously) ✓
- webapp/remote/index.html: already the navy palette (the source) ✓

---

## [Feature] Last.fm — Enable/Disable Toggle in Admin Panel *(GitHub Copilot, 2026-03-08)*

**Files:** `webapp/admin-v2/index.js`, `src/api/admin.js`, `src/api/scrobbler.js`, `src/state/config.js`

### What was added
The Last.fm admin panel card (`lastFMView` Vue component) previously had no enable/disable toggle and no way to load the current settings — it was a write-only form for API credentials only.

### Changes

**`src/state/config.js`**
- Added `enabled: Joi.boolean().default(true)` to `lastFMOptions` Joi schema.
  Defaults to `true` so existing installations keep scrobbling working after the upgrade.

**`src/api/admin.js`**
- Added `GET /api/v1/admin/lastfm/config` — returns `{ enabled, apiKey, apiSecret }`.
- Updated `POST /api/v1/admin/lastfm/config` — now accepts and persists `enabled` alongside `apiKey`/`apiSecret`.

**`src/api/scrobbler.js`**
- `GET /api/v1/lastfm/status` now returns `{ serverEnabled, linkedUser }` where `serverEnabled` reflects the admin toggle. The player reads this on load and after tab refocus to gate scrobbling and hide/show the nav button.

**`webapp/admin-v2/index.js`** — `lastFMView` rewrite:
- Added `enabled: true` to component data.
- Added `mounted()` lifecycle hook — calls `GET /api/v1/admin/lastfm/config` and populates all three fields.
- Added **Enable** checkbox row in the table (above API Key).
- Updated `save()` to send `{ enabled, apiKey, apiSecret }` — removed the "both fields required" guard since credentials are optional (built-in keys ship with the app).
- Save confirmation toast changed from "Last.fm credentials saved" to "Last.fm settings saved".

---

## [Feature] Discogs — Allow Art Update Toggle + Description Rewrite *(GitHub Copilot, 2026-03-08)*

**Files:** `webapp/admin-v2/index.js`, `src/api/admin.js`, `src/api/discogs.js`, `src/state/config.js`, `src/db/sqlite-backend.js`, `src/db/manager.js`

### New setting: Allow Art Update

When enabled, the Fix Art picker in the Now Playing modal is also shown for songs that **already have** album art. This lets admins search Discogs and replace existing art.

**`src/state/config.js`**
- Added `allowArtUpdate: Joi.boolean().default(false)` to `discogsOptions`.

**`src/api/admin.js`**
- `GET /api/v1/admin/discogs/config` now returns `allowArtUpdate`.
- `POST /api/v1/admin/discogs/config` Joi schema accepts `allowArtUpdate: Joi.boolean().required()`; persisted to config file and live runtime.

**`src/db/sqlite-backend.js` + `src/db/manager.js`**
- New exported function `countArtUsage(aaFile)` — counts how many DB rows still reference a given art filename, used to decide whether to delete the old art file.

**`src/api/discogs.js`** — embed endpoint:
- Before overwriting the DB record, reads the song's current `aaFile` from the database.
- After saving the new art and updating the DB, checks `countArtUsage(oldAaFile)`. If the count is `0` (no other song still uses it), all three variants are deleted from `image-cache/`:
  - `{hash}.jpg` (full res)
  - `zl-{hash}.jpg` (256 px, large)
  - `zs-{hash}.jpg` (92 px, small)

**`webapp/admin-v2/index.js`** — `discogsView`:
- Added `allowArtUpdate: false` to component data.
- `mounted()` now populates `this.allowArtUpdate` from the GET response.
- New **Allow Art Update** table row with checkbox and description text:
  > *When enabled, the Fix Art button also appears on songs that already have album art, letting you update it. The old art is removed from the cache and database once no other song references it.*
- `save()` includes `allowArtUpdate` in the POST body.

### Card description text rewrite
The Discogs card description was updated throughout to clearly explain the 3-proposal picker and its purpose (fixing missing or broken art) rather than vaguely mentioning "album cover art embedding".
