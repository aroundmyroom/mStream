# mStream Velvet — Change Log

> Canonical changelog for the `velvet-master` branch.
> Covers all changes to `webapp/`, `webapp/admin/`, `src/`, and supporting files.

---

## v5.16.4-velvet — 2026-03-13

### webapp moved to root; theme-aware canvas rendering; media-query specificity fix

**`webapp/app.js`** (moved from `webapp/v2/app.js`)
- All canvas drawing functions (`drawIdle`, spectrum analyser, VU gauge, PPM meter, volume knob) now use explicit `isLight` / `dark` variables — previously all used `!contains('light')` which incorrectly treated Velvet the same as Dark mode
- Waveform unplayed-bar colour is now theme-aware: Light `rgba(0,0,0,0.22)`, Dark `rgba(255,255,255,0.28)`, Velvet `rgba(255,255,255,0.35)` — was a single value that was too faint on both dark backgrounds
- `applyTheme()` now calls `_drawWaveform()` via `requestAnimationFrame` immediately on theme switch so the canvas updates without waiting for the next RAF loop

**`webapp/style.css`** (moved from `webapp/v2/style.css`)
- All `@media` breakpoint `:root` overrides now target `:root,:root.dark,:root.light` — previously plain `:root` was overriding Velvet's `--sidebar` variable at narrower widths due to CSS specificity

**`webapp/index.html`** (moved from `webapp/v2/index.html`)
- Asset paths updated: `/v2/style.css` → `/style.css`, `/v2/app.js` → `/app.js`

**`src/server.js`**
- `sendFile` path updated from `v2/index.html` → `index.html`

**`webapp/v2/`**
- Directory and all contents removed; player now served directly from `webapp/`

---

## v5.16.3-velvet — 2026-03-13

### Player bar position toggle; playback settings 2-column layout; theme selector moved to top of sidebar

**`webapp/v2/app.js`**
- `S.barTop` state property added (persisted as `ms2_bar_top_<user>` in localStorage)
- `applyBarPos(top)` function added — toggles `:root.bar-top` class on `<html>`
- `applyBarPos` called in init IIFE before first render
- Playback Settings → new **Interface** section with Bottom / Top segmented pill for player bar position

**`webapp/v2/style.css`**
- `:root.bar-top` layout rules: flips `#app` grid rows so player occupies the top row, main content the bottom
- Player gradient and box-shadow direction inverted in bar-top mode
- DJ similar-artists strip repositioned to `top: var(--player)` in bar-top mode with reversed slide animation
- DJ dice, toast, and EQ panel (vu-needle mode) all reposition to clear the bar in top mode
- `.playback-panel` changed from single-column `max-width:480px` to always-2-column `grid-template-columns:repeat(2,1fr)` — cards in the same row stretch to equal height
- `.playback-seg` / `.playback-seg-btn` CSS added for use in settings rows
- Theme segmented pill moved from sidebar footer to directly below the logo — margin adjusted (`margin:0 .75rem .55rem`)

**`webapp/v2/index.html`**
- `#theme-seg` moved from inside `.sidebar-footer` to immediately after `.sidebar-brand`

---

## v5.16.2-velvet — 2026-03-13

### 3-theme system: Velvet / Dark / Light; admin light mode fix; true dark mode

Replaced the 2-step blue/light toggle with a 3-step segmented selector across both the player and admin panel. Admin light mode now matches the player light mode exactly.

**`webapp/v2/style.css`**
- `:root` (Velvet) — existing navy/purple palette unchanged
- `:root.dark` added — true near-black (`#000` bg) following Material / Apple dark-mode guidelines
- `:root.dark #login-screen` added — pure-black radial gradient override
- Old `.theme-toggle` / `.theme-toggle-track` / `.theme-toggle-thumb` CSS removed
- `.theme-seg` / `.theme-seg-btn` segmented pill CSS added

**`webapp/v2/index.html`**
- `<button id="theme-toggle">` replaced with `<div id="theme-seg">` 3-button pill (Velvet / Dark / Light)

**`webapp/v2/app.js`**
- `applyTheme(light, persist)` → `applyTheme(theme, persist)` accepting `'velvet'|'dark'|'light'`
- OS colour-scheme listener: dark OS → `'velvet'`, light OS → `'light'`
- Init IIFE: passes saved string theme directly; falls back to OS preference

**`webapp/admin/index.css`**
- `:root` (Velvet), `:root.dark`, `:root.light` — values identical to player
- Old toggle CSS removed; `.theme-seg` pill CSS added

**`webapp/admin/index.html`**
- Early-init script reads `'velvet'|'dark'|'light'` from localStorage
- `<button id="theme-toggle">` replaced with `<div id="theme-seg">` 3-step selector
- `applyTheme()` and button listeners updated

---

## v5.16.1-velvet — 2026-03-13

### Remove all legacy / classic UI code

**`src/server.js`**
- `/classic` returns `410 Gone`
- `/old-admin`, `/admin-v2 → /admin` redirect, `/v2`, `/v2/` routes removed

**`webapp/v2/index.html`**
- Classic login link, classic admin btn, classic player btn removed

**`webapp/v2/app.js`**
- `ms2_show_classic` localStorage checks removed

**`webapp/v2/style.css`**
- `.classic-link` rules removed

---

## v5.16.0-velvet — 2026-03-13

### Routing: retire /v2 and /admin-v2; rename webapp/admin-v2 → webapp/admin

**`src/server.js`**
- `/` serves `webapp/v2/index.html` directly (no redirect)
- `/admin` → `webapp/admin/` (was `webapp/admin-v2/`)
- `/classic` stub kept as `410 Gone`
- All `/v2`, `/admin-v2` compatibility routes removed

**`webapp/admin-v2/` → `webapp/admin/`**
- Directory renamed; server mount path updated

---

## v5.15.3-velvet — 2026-03-10

### Dice crossfade; Discogs compilation fix; art crossfade bg-tab fix; primary-fg tracking; Velvet logo in admin & remote

**`webapp/v2/app.js`**
- DJ dice 3-D cube crossfade animation
- `--badge-fg` / `--primary-fg` tracking updated for live dynamic colour changes
- Background-tab art crossfade fix

**`src/api/discogs.js`**
- Compilation album Discogs search fix

**`webapp/admin-v2/index.html`** / **`webapp/remote/index.html`**
- Velvet gradient logo applied

---

## v5.15.2-velvet — 2026-03-09

### ID3 tag editing; Discogs PTS fix; audio resilience; 416 error handler

**`src/api/admin.js`**
- New ID3 tag editing endpoint

**`src/api/discogs.js`**
- PTS (partial track search) fix

**`webapp/v2/app.js`** / **`webapp/v2/index.html`**
- Audio resilience improvements; 416 range-not-satisfiable error handler

---

## v5.15.1-velvet — 2026-03-09

### Art provenance tracking (`art_source` column)

**`src/db/`** (sqlite + loki backends)
- `art_source` column added to files table (migration via ALTER TABLE)
- Values: `'embedded'` | `'directory'` | `'discogs'`

**`src/api/discogs.js`** / **`src/api/scanner.js`**
- `artSource` param threaded through update-art flow

**`webapp/admin/`**
- Three new stat chips: Art Embedded, Art from Folder, Art via Discogs
