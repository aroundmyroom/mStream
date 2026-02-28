# Admin Panel GUIv2 — Change Log

All changes to `webapp/admin-v2/` (the GUIv2-styled admin panel).
The classic admin at `webapp/admin/` is untouched throughout.

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