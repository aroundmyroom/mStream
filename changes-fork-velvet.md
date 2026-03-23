# mStream Velvet Fork — Combined Change Log

## Lyrics: filename fallback parsing — 2026-03-23

**Files:** `src/api/lyrics.js`

- When a song is not yet in the DB, the client sends the raw filename as the title (e.g. `Alesso & Katy Perry - When I'm Gone.mp3`). The server now strips the audio extension and, if the filename follows the common `Artist - Title` convention, splits it into separate artist/title fields before querying lrclib.net. Previously lrclib was searched with the full filename string, which always returned no results.

---

## Feature visibility fixes (all auth modes) — 2026-03-23

**Files:** `webapp/app.js`

- **Last.fm always hidden in no-auth/Docker mode** — no-auth path in `checkSession()` never called `api/v1/lastfm/status`, so `S.lastfmEnabled` stayed `false` and the Last.fm nav button was always hidden regardless of server config. Fixed by adding the same fetch the authenticated paths already had.
- **Radio button doesn't appear after enabling in admin tab** — the `visibilitychange` handler (used to refresh feature flags when switching back from the admin panel) checked Discogs and Last.fm but not `radioEnabled`. Radio nav button now re-checks `api/v1/radio/enabled` on tab focus, same as Last.fm.
- **Discogs flags not reset in no-auth admin-check failure** — no-auth isAdmin catch block now resets `discogsEnabled/discogsAllowUpdate/allowId3Edit = false` consistently with the other two auth paths.
- **Podcasts/radio/feeds always visible** — `feedsEnabled = true` in all three auth paths (login, token-resume, no-auth); no-auth path fetches `radioEnabled`; delete-feed handler no longer hides podcasts section.

---

## Docker/SQLite fixes + theme sync — 2026-03-23

**Files:** `src/state/config.js`, `src/db/sqlite-backend.js`, `src/db/loki-backend.js`, `Dockerfile`, `webapp/admin/index.html`

- **Default DB engine changed from `loki` → `sqlite`** — fresh installs (including Docker) now use SQLite automatically
- **SQLite directory auto-creation** — `sqlite-backend.js` calls `mkdirSync(dbDirectory, { recursive: true })` on init; no more crash if `save/db/` doesn't exist yet
- **Config directory auto-creation** — `config.js` now creates parent directories before writing the config file on first boot
- **`getGenres()` added to loki-backend** — was missing entirely, causing a 500 error on the admin genre-groups page when using loki engine
- **Dockerfile: pre-create runtime dirs** — `RUN mkdir -p save/conf save/db save/logs save/sync image-cache waveform-cache` so SQLite and config writer work on first container start even without volumes
- **Admin panel theme sync** — admin `index.html` boot script now reads the correct `ms2_theme_<username>` localStorage key (not the non-existent `ms2_theme`), so admin and player always share the same colour scheme; falls back to OS preference if no key found

---

## Docker support — 2026-03-23

**Files:** `Dockerfile`, `.dockerignore`

- `Dockerfile`: `node:24-alpine` base, installs production dependencies, exposes port 3000, starts via `cli-boot-wrapper.js`
- `.dockerignore`: excludes `node_modules`, `.git`, runtime-generated folders (`save/`, `image-cache/`, `waveform-cache/`), Electron binaries (`bin/`), build artefacts, and docs — keeps the image lean; runtime folders are intended as Docker volumes

---

## Bug fixes + SPL/Podcast/Radio polish — 2026-03-23

**Files:** `webapp/app.js`, `webapp/style.css`, `src/db/sqlite-backend.js`

### Smart Playlists

- Genre groups now open with all genres **deselected** by default (less overwhelming when picking individual genres)
- **Genre search bar** added above the genre groups — supports comma-separated multi-term filtering
- **Edit (✎) button** added to each SPL sidebar nav row — opens the builder pre-filled with that playlist's saved filters
- SPL nav row turns accent colour when its results are the active view (consistent with playlists/radio rows)

### Podcast

- **Artwork protected from orphan cleanup** — `getLiveArtFilenames()` in `sqlite-backend.js` now includes a `podcast_feeds.img` query so scan-triggered cleanup never deletes cached podcast feed art
- **Latest episode date** shown in feed overview (`latest_pub_date` subquery added to `getPodcastFeeds` and `getPodcastFeed`); displayed with accent colour above the "refreshed" date

### Now Playing context sub-label

`_syncQueueLabel` reads a new `S.playSource` state field and appends a secondary line:
- `· Radio Stream` when playing a live radio station
- `· Podcast: <feed name>` when playing a podcast episode
- `· Playlist: <name>` when playing a static playlist
- `· Smart Playlist: <name>` when playing a smart playlist

### No-auth / Docker clean-install fix (Closes #25)

**Bug:** On a fresh install with no users configured, the no-auth fallback in `checkSession()` never called the admin probe, so `S.isAdmin` stayed `false` — the admin panel button and scan button never appeared.  
**Fix:** Added `api('GET', 'api/v1/admin/directories')` probe to the no-auth path, matching what the normal session path already does.

### Radio progress bar

- **Correct fill on live streams** — `timeupdate` handler now checks `isRadio`; forces fill to 100% and hides the seek thumb instead of dividing by `Infinity` duration (which produced 0%)
- **Stale dot cleared on song switch** — `updateBar()` resets fill and thumb position immediately whenever the current song changes (radio → 100% + hidden thumb; music → 0% + visible thumb at left edge)

---

## Documentation — 2026-03-22

**Files:** `docs/smart-playlists.md`, `docs/API.md`, `docs/API/smart-playlists.md` (new), `docs/API/admin_genre-groups.md` (new), `docs/API/podcasts.md` (new), `competitors.md`

- Updated `docs/smart-playlists.md`: added Libraries filter and Fresh Picks sections; updated filters table and JSON schema
- Created `docs/API/smart-playlists.md`: full REST reference for all six endpoints, filters schema table, DB schema
- Created `docs/API/admin_genre-groups.md`: reference for `GET/POST /api/v1/admin/genre-groups` and `GET /api/v1/db/genre-groups`
- Created `docs/API/podcasts.md`: reference for all eight podcast endpoints
- Updated `docs/API.md`: added index entries for Smart Playlists, Genre Groups, and Podcasts
- Updated `competitors.md`: fixed Smart Playlists row (⚠️ planned → ✅), added Genre Groups row, updated priority gaps and roadmap, added both to selling points

---

## Smart Playlists: Fresh Picks + vpath library filter — 2026-03-22

**Files:** `src/api/smart-playlists.js`, `webapp/app.js`, `webapp/style.css`

### Fresh Picks feature

New per-playlist **"Fresh Picks"** toggle in the builder. When enabled, the playlist runs with `ORDER BY RANDOM()` every time it is opened from the sidebar — so each open gives a different selection of songs that match the filters. Useful for discovery-style playlists.

- Builder toggle persisted in `filters.freshPicks` (boolean, default false)
- Running a saved playlist checks `pl.filters.freshPicks` and forces `sort='random'` when true
- Preview button in the builder also honours the toggle
- A small shuffle icon appears next to the playlist name in the sidebar nav
- A **"New picks"** re-shuffle button appears in the results header for Fresh Picks playlists
- Default filters extracted to `_splDefaultFilters()` function (single source of truth)

### vpath (library) filter for Smart Playlists

New "Libraries" section in the builder when the server has more than one music vpath:

- Toggle pills to include/exclude individual libraries
- Deselecting all but one child vpath (e.g. "Top-40") correctly resolves to a `filepathPrefix` LIKE clause instead of a vpath exclusion, because child vpath files are stored under the parent vpath in the DB
- `selectedVpaths: []` = all included; explicit list = only those vpaths
- Backward-compatible migration from old `ignoreVPaths` format



**Files:** `src/db/sqlite-backend.js`, `src/db/loki-backend.js`, `src/db/manager.js`, `src/api/smart-playlists.js` (new), `src/server.js`, `webapp/index.html`, `webapp/app.js`, `webapp/style.css`

### What was added

Smart Playlists are a dynamic filter system separate from static playlists. They query the music library on-demand using filter criteria and return a fresh list every time.

**Filter options:**
- Multi-genre select (pick any combination, or leave empty for all)
- Year range (from/to)
- Minimum star rating (any, ★ to ★★★★★ — stored as raw DB values 0/2/4/6/8/10)
- Play status: any / never played / played / at-least N plays
- Starred songs only
- Artist text search (case-insensitive substring match)

**Sort options:** Artist/Album, Album, Year ↑/↓, Top Rated, Most Played, Recently Played, Random

**Max songs:** 25 / 50 / 100 / 200 / 500 / 1000

**Filtering live preview:** A debounced count query fires 500ms after any filter change to show "X songs match" before running.

**Save / CRUD:** Smart playlists can be named and saved. They appear in a new "Smart Playlists" sidebar section. Saved playlists can be run (re-evaluating the library live), edited, or deleted.

**API routes:**
- `GET /api/v1/smart-playlists` — list saved
- `POST /api/v1/smart-playlists/run` — execute (no save)
- `POST /api/v1/smart-playlists/count` — preview count
- `POST /api/v1/smart-playlists` — save new
- `PUT /api/v1/smart-playlists/:id` — update
- `DELETE /api/v1/smart-playlists/:id` — delete

**DB:** New `smart_playlists` table (SQLite) with `id, user, name, filters (JSON), sort, limit_n, created`. Migration-safe: `CREATE TABLE IF NOT EXISTS` with `UNIQUE(user, name)`. Loki backend uses in-memory store.

---

## Podcast Feeds UI — full rewrite + art cache fix + RSS URL editing — 2026-03-21

**Files:** `webapp/app.js`, `webapp/style.css`, `src/server.js`, `src/api/podcasts.js`, `src/db/sqlite-backend.js`, `src/db/loki-backend.js`, `src/db/manager.js`

### Problems fixed

1. **Layout broken** — Feed list was using `.rs-list` (radio station tile grid: `repeat(auto-fill, minmax(155px,1fr))`). Each feed rendered as a small square card; text wrapped badly; art was clipped at wrong sizes.
2. **Edit panel overlapped next feed** — `.pf-edit-row` was a bare sibling div inside the grid, so it became a stray grid cell on top of the adjacent card.
3. **Images empty after page reload** — `sendArtFallback` in `src/server.js` set `Cache-Control: public, max-age=86400`. Before the podcast art file was downloaded, the browser cached the SVG placeholder for 24 h against the same URL. Fixed to `no-store`.
4. **Images empty after Refresh button** — Cache-busting `_v` was `Date.now()` (session-only, lost on reload). Now derived from `last_fetched` (persists) and stamped fresh after an explicit refresh.
5. **Episode playback art blank** — Player's `artUrl()` call had no version info. New `album-art-v` field on song objects carries the buster into the player thumbnail and `_applyAlbumArtTheme`.
6. **Art size 72→88 px** — CSS and inline style updated.
7. **RSS URL not editable** — `PATCH /api/v1/podcast/feeds/:id` only accepted `title`. Extended to accept `url` as well; `updatePodcastFeedUrl()` added to all three DB layers. Edit panel shows both Display name and RSS URL fields.

---

## Podcast feed art: orphan-cleanup protection + refresh recovery — 2026-03-21

**Files:** `cleanup-albumart.mjs`, `src/api/podcasts.js`, `src/db/sqlite-backend.js`, `src/db/loki-backend.js`, `src/db/manager.js`

**Bug:** Scan-triggered orphan cleanup (`cleanup-albumart.mjs`) was deleting all `podcast-*.{ext}` files from `image-cache/` because it only queried `radio_stations.img` for protection, not `podcast_feeds.img`.

**Fixes:**
- `cleanup-albumart.mjs`: added `podcast_feeds` query; `podcast-*` filenames now added to `referenced` set alongside radio logos and song album art.
- `POST /api/v1/podcast/feeds/:id/refresh`: if the feed's cached art file is missing from disk (e.g. after a cleanup run), the endpoint now re-downloads and re-caches the art via `_cacheArt()`. Art filename updated in DB via new `updatePodcastFeedImg()`.
- `updatePodcastFeedImg(id, username, img)` added to SQLite backend, Loki backend, and manager.
- Existing art recovered by refreshing all affected feeds via the API.

---

## Podcast Feeds — complete feature: RSS subscribe, episode browse, play, progress, drag-reorder — 2026-03-21

**Files:** `src/api/podcasts.js` *(new)*, `src/server.js`, `src/db/sqlite-backend.js`, `src/db/loki-backend.js`, `src/db/manager.js`, `webapp/app.js`, `webapp/index.html`, `docs/podcasts.md` *(new)*

Full server-side podcast feature. No external service or account required.

### Database

Two new tables in both SQLite and Loki backends:

- **`podcast_feeds`**: `id, user, url, title, description, img, author, language, last_fetched, sort_order, created_at`
- **`podcast_episodes`**: `id, feed_id, guid, title, description, audio_url, pub_date, duration_secs, img, played, play_position, created_at`

Unique constraint `(feed_id, guid)` on episodes. `INSERT OR IGNORE` on upsert preserves existing `played`/`play_position` on re-fetch.

`sort_order` column on feeds added via migration-safe `ALTER TABLE … ADD COLUMN`.

### RSS Parsing (`src/api/podcasts.js`)

- Uses `fast-xml-parser` v5 (`processEntities: false` — required for feeds with large HTML entity counts like Anchor/Spotify).
- Resolves audio URL from `<enclosure>`, `<ppg:enclosureSecure>` (BBC feeds), or `<media:content>`.
- `_parseDuration()` normalises both integer-seconds (`1690`) and `HH:MM:SS` / `MM:SS` strings (`00:51:54`).
- `_cleanHtml()` strips real HTML tags, entity-encoded tags (`&lt;p&gt;`), and decodes standard XML character entities.
- SSRF protection via `_ssrfCheck()` blocks localhost, `127.x`, RFC-1918 ranges on all outbound fetches.
- Cover art downloaded and cached as `podcast-{md5}.{ext}` in the album-art directory; shared across feeds with the same image URL; deleted only when the last referencing feed is unsubscribed.
- `getLiveArtFilenames()` in `cleanup-albumart.mjs` includes `podcast-*` filenames to prevent orphan cleanup from deleting active art.

Validated against: BBC Global News Podcast, NHK World Radio Japan, Anchor/Spotify feeds.

### API Endpoints (9 total, all auth-required)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/podcast/preview` | Fetch + parse RSS without saving; returns feed metadata + episode count |
| `GET` | `/api/v1/podcast/feeds` | List user's subscribed feeds (ordered by `sort_order`) |
| `POST` | `/api/v1/podcast/feeds` | Subscribe: fetch RSS, cache art, insert feed + all episodes |
| `PUT` | `/api/v1/podcast/feeds/reorder` | Persist drag-reorder; body `{ids: number[]}` |
| `PATCH` | `/api/v1/podcast/feeds/:id` | Rename feed |
| `DELETE` | `/api/v1/podcast/feeds/:id` | Unsubscribe; cascade-deletes episodes + cleans art |
| `POST` | `/api/v1/podcast/feeds/:id/refresh` | Re-fetch RSS; upserts new episodes; updates `last_fetched` |
| `GET` | `/api/v1/podcast/episodes/:feedId` | List episodes for a feed, newest first |
| `POST` | `/api/v1/podcast/episode/progress` | Save resume position + played flag |

All endpoints check feed ownership via `req.user.username`. Mounted after `authApi.setup()` in `server.js`.

### UI (`webapp/app.js`, `webapp/index.html`)

- **Feeds view** (`viewPodcastFeeds`): card grid showing cover art, title, author, episode count, last-refreshed timestamp. Cards drag-reorderable via `.rs-drag-handle` (same DOM pattern as radio stations). Reorder persisted via `PUT /api/v1/podcast/feeds/reorder`.
- **Subscribe form**: paste RSS URL → preview (title, author, episode count shown) → confirm to subscribe.
- **Rename / Refresh / Unsubscribe** buttons on each card.
- **Episode list** (`viewPodcastEpisodes`): sorted newest first; title, pub date, duration, Play button.
- **Playback**: `Player.playSingle()` with `isPodcast: true`. Audio streams via existing radio stream proxy for same-origin Web Audio API compatibility.
- **External URL guards**: `_fetchWaveform()` and `rateSong()` silently skip `http(s)://` filepaths; `POST /api/v1/db/rate-song` returns `400` for external URLs.

### Listen section visibility (`webapp/app.js`)

`_updateListenSection()` shows the Listen nav section when any of:
- `S.radioEnabled` — at least one radio station configured
- `S.feedsEnabled` — at least one podcast feed subscribed (checked at login/session via `GET /api/v1/podcast/feeds`)
- `S.audiobooksEnabled` — user has at least one `audio-books` vpath

### Navigation restructure (`webapp/index.html`)

Final sidebar structure:
- **Music Library**: Search, File Explorer, Recently Added, Artists, Albums, Genres, Decades, Auto-DJ
- **Listen** (conditional): Radio Streams, Podcasts, Feeds
- **Stats**: Starred, Most Played, Recently Played
- **Playlists**
- **Connectors**: Last.fm, Discogs, Subsonic API
- **Tools**: Settings, Shared Links, Transcode, Jukebox, Mobile Apps, Play History

### Documentation

`docs/podcasts.md` *(new)*: complete reference covering UI, feed card grid, episode playback, RSS parsing support matrix, SSRF protection, database schema, and all 9 REST API endpoints with request/response examples.

---

## Podcast Feeds — RSS subscribe, browse, play — 2026-03-21

**Files:** `src/api/podcasts.js` *(new)*, `src/server.js`, `src/db/sqlite-backend.js`, `src/db/loki-backend.js`, `src/db/manager.js`, `webapp/app.js`

Full podcast feed subscription system, accessible from the **Podcast Feeds** button in the Podcasts & Audiobooks sidebar section:

- **Subscribe by URL**: paste any RSS 2.0 podcast feed URL; the server fetches and parses the feed (title, author, description, cover art, episode list) automatically. SSRF protection rejects private/loopback addresses. Cover art is downloaded and cached locally under the album-art directory with a `podcast-` prefix.

- **Feed list**: cards showing cover art, podcast title, author, episode count, and description snippet. Two action buttons per card — **Refresh** (re-fetches RSS and upserts new episodes) and **Unsubscribe** (deletes feed + cached art when no longer referenced).

- **Episode list**: click any feed card to open its episode list showing title, publish date, and duration. Each episode has a **Play** button.

- **Playback**: podcast episodes stream directly through the existing radio stream proxy (`/api/v1/radio/stream`) — no new server-side proxy needed. The episode plays in the standard player bar with seek, volume, and all existing controls working normally.

- **DB schema**: two new tables `podcast_feeds` and `podcast_episodes` (both SQLite and in-memory Loki backends); per-user isolation; `UNIQUE(feed_id, guid)` constraint ensures refresh is idempotent. Episode progress (`play_position`, `played`) columns reserved for future use.

- **API endpoints**: `GET/POST /api/v1/podcast/feeds`, `DELETE /api/v1/podcast/feeds/:id`, `POST /api/v1/podcast/feeds/:id/refresh`, `GET /api/v1/podcast/episodes/:feedId`, `POST /api/v1/podcast/episode/progress`. All endpoints enforce ownership checks — users can only access their own feeds.

- **RSS parsing**: uses `fast-xml-parser` v5 (already a dependency). Handles `<itunes:image>`, `<itunes:duration>` (integer seconds or HH:MM:SS), `<ppg:enclosureSecure>` (BBC feeds), `<media:content>`, multi-namespace RSS 2.0 feeds. Strips HTML from episode descriptions.

---

> Merged from three source files covering all components of the velvet fork:
> **`Changes-Velvet.md`** (versioned server + webapp log) · **`changes4GUIv2.md`** (GUIv2 player feature reference) · **`changes-adminGUIv2.md`** (admin panel v2 log).
>
> *Consolidated 2026-03-16. The three source files have been removed; this is the canonical changelog going forward.*

---

## Podcasts & Audiobooks nav section — 2026-03-21

**Files:** `webapp/index.html`, `webapp/app.js`

A dedicated "Podcasts & Audiobooks" section now appears in the sidebar for any
user who has access to at least one vpath of type `audio-books`:

- **Hidden by default** — the new `nav-section` (`id="podcasts-section"`) is
  not rendered until `ping` returns `vpathMetaData`. After ping, if the user has
  any `audio-books` vpaths, the section is revealed automatically with
  `classList.remove('hidden')`. Users without such folders never see it.

- **Per-user**: visibility is driven entirely by `S.vpaths` (server-side access
  list) intersected with `S.vpathMeta` type information — no admin toggle
  needed.

- **Library view** (`viewPodcasts` / `_renderPodcastsView`): renders each
  audio-books vpath as a folder card (reuses `.fe-dir`/`.fe-grid` CSS). Clicking
  a card opens the file explorer at that vpath root. The back button in the file
  explorer returns to the podcasts/audiobooks list.

- **Nav dispatch**: `data-view="podcasts"` wired into the existing sidebar click
  handler.

- **Phase 2 (future)**: RSS podcast subscriptions tab, per-episode play-state
  tracking, and auto-download — requires its own DB tables and backend.

---

## Audio-books isolation from music library — 2026-03-21


**Files:** `src/db/sqlite-backend.js`, `src/db/loki-backend.js`, `src/api/db.js`, `webapp/app.js`

Folders registered as type `audio-books` in the admin panel are now fully
isolated from all music browsing, search, and playback:

- **Scanner behaviour confirmed**: child vpaths (whose root sits inside another vpath) are never scanned independently — their files are stored in the parent vpath's DB space with a filepath prefix. This required a new `excludeFilepathPrefixes` mechanism beyond the existing `ignoreVPaths` to exclude them from queries at the DB level.

- **New DB helper** `excludePrefixClauses()` (SQLite) / `_applyExcludePrefixes()` (Loki): generates `AND NOT (vpath = ? AND filepath LIKE ?)` clauses applied to every affected query.

- **All music queries now exclude audio-books content**: Artists, Albums, Recently Added, Rated/Starred, Most Played, Recently Played, Random Songs (Auto-DJ lean + full paths), Search.

- **Player helpers** `_musicVpaths()` and `_audioBookExclusions()`: compute the correct `ignoreVPaths` + `excludeFilepathPrefixes` from `S.vpathMeta` at call time. Applied to all browse/search/Auto-DJ API calls.

- **After ping**: when `S.vpathMeta` is received, `S.djVpaths` is re-filtered to remove any audio-books vpaths that were included before metadata was known.

---

## Docs: full json_config.md rewrite — 2026-03-21

**`docs/json_config.md`**: Rewrote and completed the JSON configuration reference.
- Replaced bullet-list Scan Options with a full table covering all 9 fields, including the three previously undocumented ones: `maxConcurrentTasks`, `compressImage`, `scanErrorRetentionHours`
- Updated Transcoding table to include the `algorithm` field
- Added previously missing sections: `address`, `lockAdmin`, `maxRequestSize`, `db` (engine + clearSharedInterval), `lastFM` (server-level), `discogs`, `radio`, `federation`, `rpn`
- Added **Opt-in vs Opt-out: How Feature Defaults Work** — explains why Last.fm is on-by-default (`enabled: true` in Joi schema), Discogs is off-by-default (`enabled: false` in schema), and Radio requires an explicit `=== true` check (not in schema at all)

---

## Part 1 — Versioned Release Log

> *Source: `Changes-Velvet.md` — covers `webapp/`, `webapp/admin/`, `src/`, and all supporting files.*

---

## Radio: UI polish, card grid, drag-reorder, logo system, queue behaviour — 2026-03-20

### Full radio feature overhaul: visual design, station ordering, logo caching, and player bar fixes

**`webapp/app.js`**:
- `_playRadio()` uses `Player.playSingle()` — clears the queue and plays the station directly; fixes player bar not updating title/artist on channel switch.
- Added informational notice below the channel grid: "Playing a radio stream clears the play queue".
- Radio view rebuilt as a responsive card grid (`auto-fill, minmax(155px,1fr)`) — each station is a vertical card with logo, name, genre/country tags, and action buttons.
- Drag-to-reorder: cards are draggable when no filter is active; a six-dot handle appears top-right; horizontal drop indicator (left/right box-shadow) shows the insertion point; on drop the new order is persisted via `PUT /api/v1/radio/stations/reorder`.
- Filter pills for Genre and Country above the grid; reorder handle hidden when a filter is active.
- `.rs-meta` colour changed from `var(--t3)` to `var(--t2)` for readability.
- Placeholder logo (no image set) uses the Lucide radio SVG icon, matching the nav icon.
- Nav icon updated to the Lucide radio icon (`<circle cx="12" cy="12" r="2"/>` + four arc paths).
- Form layout: separate "Link B" / "Link C" fields shown only on demand; multi-genre hint text added; section title changed from "Radio" to "Channels".

**`webapp/style.css`**:
- New card-grid styles: `.rs-list`, `.rs-row`, `.rs-card-art`, `.rs-drag-handle`, `.rs-drag-over-left`, `.rs-drag-over-right`.
- `.rs-queue-notice` — subtle bordered notice below the grid (`color: var(--t1)`).
- `.spc-count` (scan progress song counter) changed from `var(--t3)` to `var(--t1)` — numbers were unreadable.

**`src/api/radio.js`**:
- `getLiveArtFilenames()` now includes radio logo filenames (`radio-*.{ext}`) so orphan-cleanup never deletes active station logos.
- Delete endpoint cleans up the cached art file when no other station references it (checks `getRadioStationImgUsageCount`).
- `PUT /api/v1/radio/stations/reorder` — accepts `{ ids: [...] }`, validates ownership, delegates to `db.reorderRadioStations`.
- Art proxy (`GET /api/v1/radio/art`) — fetches remote images server-side to bypass browser CORS in the edit form.
- Stream proxy (`GET /api/v1/radio/stream`) — pipes live stream through the server for same-origin Web Audio API compatibility; normalises AAC+/HE-AAC content-type to `audio/aac`.
- ICY now-playing (`GET /api/v1/radio/nowplaying`) — HTTP/1.1 byte-level parser reads the first `StreamTitle` block; falls back gracefully when no ICY metadata present.

**`src/db/sqlite-backend.js`**:
- `sort_order` column added to `radio_stations` table (migration-safe `ALTER TABLE … ADD COLUMN`).
- `getRadioStations()` orders by `sort_order ASC, id ASC`.
- `reorderRadioStations(username, orderedIds)` — updates `sort_order` for each ID using `BEGIN` / `COMMIT` (no `.transaction()` — `node:sqlite` `DatabaseSync` does not expose that method).
- `getRadioStationImgUsageCount(img)` — counts how many stations reference a given local logo filename.

**`docs/API/radio.md`** *(new)*:
- Full reference for all radio endpoints: admin config, station CRUD, reorder, stream proxy, ICY now-playing, art proxy.
- Documents the `img` field convention (local filename → served via `/album-art/`), SSRF protection, and ICY HTTP/1.1 requirement.

---

## Lyrics: two-pass lrclib lookup + stale-cache removal — 2026-03-20

### Removed .none cache mechanism; added duration-fallback second pass

**`src/api/lyrics.js`**:
- Removed `.none` cache files entirely — "not found" results are never written to disk; every lookup re-queries lrclib on next request.
- Removed `duration <= 0` bail-out that was blocking all lookups for tracks whose duration wasn't yet in the DB.
- Two-pass fetch: first attempt with duration (exact match), second attempt without duration (fuzzy fallback) if first returns nothing.
- Only successful hits are cached as `.json`.

**`save/lyrics/`**:
- Cleared all stale `.none` cache files that were blocking re-fetches.

---

## Lyric display improvements — 2026-03-20

### Larger active line, smooth brightness gradient, no flash on line change

**`webapp/app.js`** — `lyricFillTick` / `lyricTick`:
- Active lyric font: 36 px → 72 px (CSS only via `.vlm-active`).
- Brightness gradient managed entirely by `requestAnimationFrame`; inline colour reset removed to eliminate flash on line change.
- Upcoming line within 2.5 s: real-time ramp from 0.35 → 1.0 opacity for seamless transition into active.
- Upcoming dist ≥ 2: `max(0.28, 0.65 − (dist−1)×0.12)`.
- Past lines: `max(0.28, 0.65 + (dist+1)×0.10)` — slower falloff, floor 0.28 so distant lines remain readable.

**`webapp/style.css`**:
- `.vlm-line` base opacity floor: 0.28.
- `.vlm-line.vlm-active`: `font-size:72px; color:#fff; text-shadow:0 0 24px var(--primary); transform:translateX(6px)`.
- `.vlm-near` class removed — all brightness handled by rAF.

---

## Lyrics: exact-match-only (no fallbacks) — 2026-03-20


### Wrong lyrics are now impossible — only an exact artist + title + duration hit is accepted

**Problem:** The previous three-step fetch chain (exact+duration → exact-no-duration → fuzzy search) produced false positives. Steps 2 and 3 could return lyrics for a completely different version of the track — a 12-inch remix timed to 7 minutes synced to a 3-minute radio edit plays badly out of sync. No lyrics at all is strictly better than wrong lyrics.

**`src/api/lyrics.js`**:
- Removed `lrclibSearch` function entirely — the fuzzy `/api/search` fallback is gone.
- Removed the "retry without duration" step — the exact `/api/get` call is no longer retried without duration.
- If `duration ≤ 0` (track not yet in DB or scan pending), the request writes a `.none` cache entry and returns `notFound` immediately without making a network call.
- Single attempt: `lrclibFetch(artist, title, duration)`. If the API returns nothing, `notFound` is cached and returned. No second guesses.

**`docs/technology-choices.md`**:
- Rewrote the LRCLIB matching section to document the exact-match-only policy and the rationale (wrong version = off-time = worse than nothing).

---

## Lyrics: duration-accurate version matching — 2026-03-20

### Lyrics now use the authoritative track duration from the database

**Problem:** Lyrics were being fetched for the wrong version of a track (e.g. a 7-minute 12-inch remix matched instead of the 3-minute single) because the fuzzy search fallback picked the first result with any lyrics, ignoring track length entirely.

**`src/db/sqlite-backend.js`**:
- Added `getFileDuration(filepath)` — `SELECT duration FROM files WHERE filepath = ? LIMIT 1`; returns the stored duration (in seconds) or `null`.

**`src/db/loki-backend.js`**:
- Added matching `getFileDuration(filepath)` using LokiJS `findOne`.

**`src/db/manager.js`**:
- Exports `getFileDuration` as a thin proxy to the active backend.

**`src/api/lyrics.js`**:
- Imports `db` manager.
- New `filepath` query parameter accepted on `GET /api/v1/lyrics`.
- When `filepath` is provided, the server looks up the track's duration from the database and uses it as the authoritative value (overriding the client-supplied `duration` param, which comes from the audio element and may be imprecise or zero for freshly-loaded tracks).
- `lrclibSearch(artist, title, duration)` — the fuzzy-search fallback now accepts a `duration` argument. When duration is known, all results with lyrics are sorted by `|result.duration − trackDuration|` ascending. A synced-lyrics preference is applied as a tiebreaker for equal duration deltas. This means shorter single versions and longer 12-inch mixes are ranked correctly.

**`webapp/app.js`**:
- Lyrics fetch now includes `&filepath=…` (URI-encoded) alongside the existing `artist`, `title`, and `duration` params.

---

## Technology choices document — 2026-03-20

### New reference document explaining every external service and library choice

**`docs/technology-choices.md`** *(new)*:
- Covers FFmpeg, LRCLIB, Discogs, Last.fm, Syncthing, Butterchurn, audioMotion-analyzer, SQLite, Web Audio API, Subsonic protocol, and music-metadata.
- For each: what it does in mStream, a comparison table of alternatives, and the concrete reason it was chosen over them (e.g. LRCLIB vs Musixmatch — free vs paid; Syncthing vs Dropbox — self-hosted vs cloud; Discogs vs Spotify — cacheable images vs ToS restriction).
- Includes a summary table at the end for quick reference.

**`README.md`**:
- Added link to `docs/technology-choices.md` in the installation section alongside the existing `docs/install.md` and `docs/deploy.md` links.

---

## Admin External Services panel — 2026-03-19

### Lyrics, Discogs, and Last.fm grouped under a dedicated "External Services" section in the admin sidebar

**`src/api/admin.js`**:
- New `GET /api/v1/admin/lyrics/config` — returns `{ enabled: bool }`.
- New `POST /api/v1/admin/lyrics/config` — accepts `{ enabled: bool }`, persists to config file, updates `config.program.lyrics.enabled` in memory.

**`src/api/lyrics.js`**:
- Guard at handler entry: `if (config.program.lyrics?.enabled === false) return res.json({ notFound: true })` — disabling lyrics in admin immediately stops all lyric fetches without a server restart.

**`src/api/discogs.js`**:
- Fixed `enabled` default: changed `!config.program.discogs?.enabled` guard to `config.program.discogs?.enabled === false`. Previously an absent `enabled` key (i.e. existing configs that pre-date the toggle) was treated as disabled; now it defaults to enabled.

**`webapp/admin/index.js`**:
- New `lyricsView` Vue component — single enable/disable checkbox; reads from `GET /api/v1/admin/lyrics/config`, writes via `POST`.
- Registered as `lyrics-view`.

**`webapp/admin/index.html`**:
- Moved Last.fm and Discogs nav items out of the "Server" section.
- New **"External Services"** section label containing: Last.fm, Discogs, Lyrics (in that order).
- Lyrics nav item uses a speech-bubble SVG icon.

---

## Visualizer: mode label and tooltip fix — 2026-03-19

### Mode button now shows the active mode name, not the next one; tooltip correctly names the next mode

**`webapp/app.js`** — `VIZ.applyMode()`:
- `#viz-mode-label` text set to `MODE_NAMES[vizTopMode]` (the current mode) — previously it was offset by one, showing the *next* mode's name instead.
- Tooltip (`modeBtn.dataset.tip`) set to `'Switch to ' + MODE_NAMES[nextMode]` — writes directly to `data-tip` rather than `element.title`, because the custom `#tip-box` tooltip system strips all `title` attributes to `data-tip` at page load via `convertTitles()`. Writing to `element.title` after load had no effect.

---

## Player bar visualizer button: focus/size bug fix — 2026-03-19

### The eye icon button in the player bar no longer appears enlarged after returning from the full-screen visualizer

**Root cause:** The button retained browser `:focus` state after the overlay closed. On touch-screen devices (CleverTouch) this caused the browser to apply a focus ring / zoom that made the button visually large until the user tapped elsewhere.

**`webapp/app.js`** — `VIZ.close()`:
- Added `document.getElementById('viz-open-btn').blur()` immediately after removing the `.active` class from the button.

**`webapp/style.css`**:
- Added `outline:none` to the `.ctrl-btn` rule.
- Added `.ctrl-btn:focus { outline: none; }` rule to suppress browser focus rings on all player bar control buttons.

---



### Vpath filter pills in the search view

Allows scoping a search to one or more specific vpaths/child-vpaths, mirroring the same filtering available in Auto-DJ.

**`webapp/app.js`**:
- `viewSearch()` renders a pill row below the search input when more than one vpath exists (`S.vpaths.length > 1`). Reuses the existing `.dj-vpath-pill` / `.dj-vpath-pill.on` styles.
- All vpaths start selected (ON); toggling a pill OFF excludes that library from results. At least one pill must remain selected (the last one cannot be deselected).
- Selection is stored in `S.searchVpaths` and persists across back-navigations within the session.
- `doSearch()` uses the same child-vpath detection logic as Auto-DJ: when all selected vpaths are children of the same parent vpath, it sends `filepathPrefix` instead of `ignoreVPaths`, which correctly scopes results to files stored under the parent vpath with the matching folder prefix.

**`webapp/style.css`**:
- Added `.search-vpath-pills` — flex-wrap container (`gap:6px`, `padding:4px 2px 16px`) placed between the search input and the results.
- `.search-wrap` bottom margin reduced from `20px` to `8px` when pills are present.

**`src/api/db.js`**:
- Added `filepathPrefix` (optional string) to the Joi schema for `POST /api/v1/db/search`.
- Passes `filepathPrefix` through to `db.searchFiles()` and `db.searchFilesAllWords()`.

**`src/db/sqlite-backend.js`**:
- `searchFiles()` and `searchFilesAllWords()` now accept an optional `filepathPrefix` parameter and append `AND filepath LIKE ? ESCAPE '\'` when set.

**`src/db/loki-backend.js`**:
- Same: `searchFiles()` and `searchFilesAllWords()` filter by `row.filepath.startsWith(filepathPrefix)` when set.

**`src/db/manager.js`**:
- Proxy functions for `searchFiles` and `searchFilesAllWords` updated with the new `filepathPrefix` parameter.

**`.gitignore`** + **`save/lyrics/README.md`** *(new)*:
- `save/lyrics/*` added to `.gitignore` (same pattern as `waveform-cache/*`) so lyrics cache files are never committed.
- `!save/lyrics/README.md` exception keeps the directory anchor file tracked.
- `save/lyrics/README.md` created describing the cache format.

---

## AudioMotion-analyzer visualizer — 2026-03-19

### Third visualizer mode added alongside Milkdrop and Custom Spectrum

**`webapp/assets/js/lib/audiomotion-analyzer.js`** *(new file)*:
- audioMotion-analyzer 4.5.4 (87 KB) bundled as a local global script — ESM `export` replaced with `window.AudioMotionAnalyzer = AudioMotionAnalyzer`.
- Self-hosted so no CDN dependency; versioned with the app.

**`webapp/index.html`**:
- `<script defer src="../assets/js/lib/audiomotion-analyzer.js"></script>` added.
- `<div id="am-container" class="am-container hidden"></div>` added inside the viz overlay for the canvas mount point.

**`webapp/style.css`**:
- `.am-container { position:absolute; inset:0; width:100%; height:100%; z-index:1; background:#000; cursor:pointer; }`
- `.am-container canvas { width:100%!important; height:100%!important; }` — forces canvas to fill the overlay regardless of device pixel ratio.

**`webapp/app.js`** — VIZ module extended:
- `vizTopMode` (0/1/2) replaces the old `specMode` boolean: **0** = Milkdrop, **1** = Custom Spectrum (7 modes), **2** = AudioMotion.
- `AM_PRESETS` array — 6 curated presets: *Mirror Peaks*, *LED Dual*, *Radial*, *Octave Reflex*, *Velvet*, *Line Stereo*.
- `_applyAMPreset(i)` — sets `mode`, `gradient`, `channelLayout`, `reflexRatio`, `radialInvert`, `showScaleX` etc. on the live analyzer instance.
- `startAudioMotion(container)` — creates `AudioMotionAnalyzer` with `connectSpeakers: false` (avoids double audio routing), connects to the shared `analyserNode`, registers the custom *velvet* gradient.
- `stopAudioMotion()` — destroys the analyzer, hides the container.
- `toggleMode()` cycles `(vizTopMode + 1) % 3`.
- `next()` / `prev()` advance through AM presets when `vizTopMode === 2`.
- `open()` / `close()` updated to start/stop all three modes correctly.

---

## Scan error count accuracy — 2026-03-19

### Sidebar badge and header pill now count only actionable (unfixed + in-library) errors

**`src/db/sqlite-backend.js`** — `getScanErrorCount()`:
- Changed from `SELECT COUNT(*) WHERE fixed_at IS NULL` to an **INNER JOIN files** query — deleted files are no longer counted.

**`src/db/loki-backend.js`** — `getScanErrorCount()`:
- Added `.filter(r => !!fileCollection.findOne({filepath, vpath}))` before the `fixed_at === null` count.

**`webapp/admin/index.js`**:
- `unfixedCount` computed: `this.errors.filter(e => !e.fixed_at && e.file_in_db).length` (was `errors.length`).
- Header pill uses `unfixedCount` instead of `errors.length`.
- `load()` badge update uses `this.unfixedCount` (was `errRes.data.length`) — prevents the badge from being overwritten with the raw row count on panel load.

---

## Scan errors: "Gone from library" indicator — 2026-03-19

### Errors for files removed from the library are visually distinguished and non-actionable

**`src/db/sqlite-backend.js`** — `getScanErrors()`:
- Added `LEFT JOIN files f ON e.filepath = f.filepath AND e.vpath = f.vpath` to the query.
- Each row now carries `file_in_db` (1 if still in library, 0 if removed).

**`src/db/loki-backend.js`** — `getScanErrors()`:
- Each result row gets `file_in_db: fileCollection.findOne({filepath, vpath}) ? 1 : 0`.

**`webapp/admin/index.js`**:
- Compact row: brown `🗑 Gone from library` pill badge shown when `file_in_db === 0`.
- Expanded detail: brown bordered banner — "File no longer in library. This error will be auto-removed after 48 h."
- **Fix button suppressed** when `file_in_db === 0` (replaced with plain informational text); prevents attempting a fix on a file that no longer exists.

**`webapp/admin/index.css`**:
- `.se-deleted-badge` — brown/tan pill badge.
- `.se-deleted-banner`, `.se-deleted-title`, `.se-deleted-body` — brown bordered detail panel.

---

## Settings panel: Genres & Decades visibility toggles — 2026-03-19

### Per-user toggle to show/hide Genres and Decades navigation buttons

**`webapp/index.html`**:
- Nav button label changed from "Playback Settings" → "**Settings**".

**`webapp/app.js`**:
- `S.showGenres` — reads `ms2_show_genres_<user>` from localStorage (default `true`; `'0'` = hidden).
- `S.showDecades` — reads `ms2_show_decades_<user>` (same pattern).
- `_applyNavVisibility()` — adds/removes `.hidden` on the Genres and Decades nav buttons; if the active view becomes hidden, redirects to Recent.
- Called at startup (before `checkSession()`) and from `_applyServerSettings()` on every cross-device sync.
- Settings panel page title: `setTitle('Settings')`.
- New **Navigation** section in the Settings panel: two checkbox toggles ("Show Genres in navigation", "Show Decades in navigation") wired to `show-genres-enable` / `show-decades-enable` IDs.
- `_collectPrefs()` includes `show_genres` / `show_decades` keys.
- `_applyServerSettings()` applies both and calls `_applyNavVisibility()`.

---

## Scan error confirmed_at — 2026-03-19

### "Rescan confirmed OK" chip: scanner marks errors verified after a successful rescan

**`src/db/sqlite-backend.js`**:
- Migration-safe `ALTER TABLE scan_errors ADD COLUMN confirmed_at INTEGER` (no-op if column exists).
- `confirmScanErrorOk(filepath, vpath)` — sets `confirmed_at = now` where `fixed_at IS NOT NULL AND confirmed_at IS NULL`.
- `markScanErrorFixed()` resets `confirmed_at = NULL` (re-fixing clears any previous confirmation).

**`src/db/loki-backend.js`**: same `confirmScanErrorOk()` and `markScanErrorFixed()` logic.

**`src/db/manager.js`**: exports `confirmScanErrorOk`.

**`src/api/scanner.js`**:
- New endpoint `POST /api/v1/scanner/confirm-ok` — reads `{filepath, vpath}`, calls `db.confirmScanErrorOk()`.

**`src/db/scanner.mjs`**:
- `confirmOk(absoluteFilepath)` helper — mirrors `reportError()`; posts to the confirm-ok endpoint; errors are swallowed so a confirm failure never crashes the scanner.
- Called after a successful `insertEntries()` (new/updated file branch).
- Called at the end of the targeted-updates else block (after `_needsDuration` check).

**`webapp/admin/index.js`**:
- Confirmed chip in the fix row: `✓ Rescan confirmed OK X ago` (green pill, shown when `confirmed_at` is set).
- Before confirmation: faded italic hint — "rescan to confirm, auto-removed after 48 h".

**`webapp/admin/index.css`**: `.se-confirmed-chip` — green pill badge (dark/velvet theme variant).

---

## Scan Error Fix: corrupt FLAC frame fallback — 2026-03-19

### FLAC files with corrupt frame data now handled gracefully
- Added two-pass strategy to `remuxAudio()`:
  1. **Pass 1** — stream-copy (lossless, fast) — works for tag/container corruption
  2. **Pass 2 (FLAC only)** — re-encode with `-err_detect ignore_err -fflags +discardcorrupt`: ffmpeg decodes frame-by-frame, discards unreadable packets, re-encodes surviving audio to a clean FLAC — produces a playable file with silence gaps where frames were lost
  3. **If Pass 2 also fails or output < 1 KB** → returns `unrecoverable: true` → shows the red "unrecoverable" banner (same as zeroed-out files)
- Fix endpoint now distinguishes `{ ok: false, unrecoverable: true }` from a plain error — former shows the red banner instead of a raw 500 toast
- Fixed double popup on successful fix: the `note` message is now folded into the single success toast instead of firing a second separate warning toast

### Fix button now repairs FLAC/WAV/MP3 parse and duration errors
- Added `remuxAudio()` server function: uses bundled ffmpeg to stream-copy the audio with `-vn -c:a copy -map_metadata 0`, which rebuilds the container and drops corrupt tag blocks
- FLAC with prepended ID3v2 header: uses `-f flac` to force the input parser past the ID3v2 block so ffmpeg finds the `fLaC` marker and reads STREAMINFO correctly
- MP3: also passes `-write_apetag 0 -id3v2_version 3` to strip the corrupt APEv2 footer that causes `RangeError [ERR_OUT_OF_RANGE]` in music-metadata's APEv2Parser
- WAV: passes `-write_id3v2 0` to avoid re-embedding a broken ID3 chunk
- The in-place rewrite changes the file's mtime → the next library scan automatically re-parses it
- Fix endpoint (`POST /api/v1/admin/db/scan-errors/fix`) handles `error_type === 'parse'` and `error_type === 'duration'`

### Unrecoverable file detection
- Added `probeHasAudio()`: runs ffprobe before remux to check that the file has at least one audio stream with `channels > 0` and `sample_rate > 0`
- Completely zeroed-out or truncated files (no valid audio data at all) return `action: 'unrecoverable'` instead of attempting remux
- Admin UI: shows a prominent **red banner** in the expanded detail panel — "File is corrupt and unrecoverable — No valid audio stream was found. Delete it from disk."
- Sticky red toast on detection: "⚠ File Unrecoverable — This file cannot be played or repaired. Delete it."
- Error text in expanded detail panel is now selectable (added `user-select: text` to `.se-detail` and `.se-stack`)
- Fix-failed toast is now sticky (`timeout: 0`) so the error message isn't missed
- Hint text under the Fix button updated to describe what each fix type actually does

---

## README — 2026-03-18

### Add GUI screenshots to README
- Embedded `docs/front.jpg` and `docs/admin.jpg` in `README.md` directly below the intro paragraph
- Thumbnails displayed at 480 px wide, side by side; clicking opens full-size image on GitHub

---

## Server-synced user settings & queue — 2026-03-18

### All user preferences and queue state now persist in the database

Previously every setting (theme, EQ, crossfade, Auto-DJ config, keyword filter, etc.) and the current queue lived only in the browser's `localStorage`, meaning a user on a second browser or device started with defaults.

**`src/db/sqlite-backend.js`** + **`src/db/loki-backend.js`**:
- New `user_settings` table (`username TEXT PRIMARY KEY, prefs TEXT, queue TEXT`) added via `CREATE TABLE IF NOT EXISTS` — migration-safe, zero downtime.
- `getUserSettings(username)` — returns `{prefs, queue}` JSON blob for the user.
- `saveUserSettings(username, patch)` — merges a partial `{prefs?, queue?}` update into the stored record.

**`src/db/manager.js`**: exports `getUserSettings` and `saveUserSettings`.

**`src/api/user-settings.js`** *(new file)*:
- `GET /api/v1/user/settings` — returns the user's saved prefs + queue.
- `POST /api/v1/user/settings` — accepts `{prefs?, queue?}`, merges and saves.

**`src/server.js`**: registers the new API module.

**`webapp/app.js`**:
- `_collectPrefs()` — snapshots all 34 user-pref localStorage keys into one plain object.
- `_syncPrefs()` — debounced 1.5 s POST of prefs; fires after every pref change (theme, EQ, DJ settings, etc.).
- `_syncQueueToDb()` — debounced 2 s POST of the current queue + position; called only on structural changes (add/remove/reorder/song change) to avoid DB writes every 5 s from the timeupdate tick.
- `_loadServerSettings()` — fetches settings from server after login; called by both `tryLogin()` and `checkSession()`.
- `_applyServerSettings(data)` — writes each pref into localStorage AND updates `S` state live; DB queue always wins on page load (source of truth).
- `localStorage` debug keys: `ms2_settings_pulled_<user>` and `ms2_settings_pushed_<user>` record ISO timestamps for each DB sync direction.
- `_syncPrefs()` wired to all ~40 pref-write sites.

**Cross-device position accuracy:**
- `seeked` audio event triggers a debounced 1 s DB write after any scrubber seek.
- `_startPositionSync()` / `_stopPositionSync()` write position to DB every 15 s while playing, stopped on pause — keeps position at most 15 s stale for cross-device F5.
- `beforeunload` uses `navigator.sendBeacon` to flush the exact position to DB on page close/F5 — guarantees frame-accurate restore on own-browser refresh.

**`docs/API/user-settings.md`** *(new file)*: full API reference including both endpoints, all pref keys, response shapes, and iOS usage pattern.
**`docs/API.md`**: new **User Settings** section.

---

## Auto-DJ UI contrast fixes — 2026-03-18

### Low-contrast text in dark/velvet themes corrected

**`webapp/style.css`**:
- `.autodj-toggle` (off state): text `--primary` → `--t1` (purple-on-navy was illegible)
- `.autodj-opts h4` ("Settings" header): `--t2` → `--t1`
- `.autodj-status` both states: `--t2` / `--primary` → `--t1`
- `.dj-vpath-pill` (unselected): `--t2` → `--t1`
- `.dj-vpath-pill.on` (selected): `--primary` → `--t1` (border + background retain purple accent)
- `.dj-filter-tag` text: `--primary` → `--t1`
- `.dj-strip-pills` container: added `padding:2px 1px` so pill border-radius is no longer clipped by `overflow:hidden`
- `.dj-similar-strip::before` progress line: added `border-radius:0 2px 2px 0` for a rounded leading edge

---

## Queue restore — scrubber position — 2026-03-18

### Waveform playhead and time counters now reflect restored position on login/F5

**`webapp/app.js`** — `restoreQueue()`:
- After `audioEl.currentTime = data.time` in the `loadedmetadata` handler, a one-shot `seeked` listener now calls `_renderTimes()`, updates `np-prog-fill` width, and redraws the waveform so the scrubber lands at the correct position immediately without waiting for the next `timeupdate`.

---

## Search — 2026-03-18

### Multi-word cross-field search
- Previously, searching "chaka khan fate" returned nothing because each word group was matched against a single column (title OR artist) as a single string.
- Added `searchFilesAllWords()` in `sqlite-backend.js`: splits the query into tokens and requires **every token** to appear in **any** of title / artist / album / filepath.
- The search endpoint now runs the cross-field query automatically whenever the input contains more than one word, merging unique results into the songs list.
- Single-word searches remain unchanged.

---


## v5.16.27-velvet — 2026-03-17

### Fix: rating and last-played fail for songs browsed via child vpath
- `rate-song` and `scrobble-by-filepath` endpoints did a direct DB lookup using the child vpath name (e.g. `Disco`) and stripped relative path — but all files are stored under the root vpath (`Music`), so the lookup always returned null → 500 error.
- Added `resolveFile()` helper in `src/api/db.js` that mirrors the existing `pullMetaData` fallback: tries the direct lookup first, then walks config folders to detect parent vpaths and retries with the correct prefix.
- Same inline fallback added to `src/api/scrobbler.js` so last-played and play-count are recorded correctly for child-vpath files.
- All files under child vpaths (Disco, etc.) scanned via `Music` root are now rateable and scrobble correctly regardless of which vpath the file explorer was browsed through.

---

## v5.16.26-velvet — 2026-03-17

### A-Z strip: full-width layout

**`webapp/style.css`**:
- `.az-strip` changed from `flex-wrap:wrap` to `flex-wrap:nowrap` so all 27 buttons (`#` + A–Z) fill the full available width in one row
- `.az-btn` now uses `flex:1 1 0; min-width:0` — each button stretches proportionally to the container width, adapting automatically to any screen size
- Added `white-space:nowrap; overflow:hidden` to prevent label overflow
- Mobile breakpoint `≤480px`: falls back to wrapped layout (~7 buttons per row) so buttons stay readable on small phones

---

## v5.16.25-velvet — 2026-03-16

### Decades & Genres: browse filter + track virtual-scroll

**`webapp/app.js`**:
- `_mountSongVScroll(allSongs, container)` — virtual scroller for song rows; renders only the visible window plus an 8-row buffer, so 5 000+ track lists are smooth. Uses a single delegated click handler on the scroll wrapper (no per-row listeners). `highlightRow()` called after each render so the currently-playing row is always highlighted.
- Sort bar inside the Tracks tab: **Artist / Title / Album / Year** pill buttons. Clicking the active pill toggles ascending ↑ / descending ↓. Client-side sort — instant, no extra API call. `S.curSongs` and play-all/add-all buttons stay in sync with the current sort order.
- `_showSongsIn` reduced to a thin wrapper over `_mountSongVScroll`.
- **Browse filter input** added to the tab bar in both `viewGenreDetail` and `viewDecadeDetail`. Filter value is preserved when switching between Albums and Tracks tabs. Albums tab: matches album name or artist. Tracks tab: matches title, artist, or album. No-match message includes the query string. Clear (×) button appears only when the field is non-empty.

**`webapp/style.css`**:
- Added `.tracks-mode`, `.sort-bar`, `.sort-bar-label`, `.sort-pill`, `.sort-dir`, `.vslist-wrap` — layout and pill styles for the virtual track scroller and sort bar.
- Added `.browse-filter-wrap`, `.browse-filter-input`, `.browse-filter-clear` — filter input right-aligned in the tab bar.
- Filter input colours corrected: `background: var(--surface)` (not `--raised`), `border: var(--border2)`, `placeholder: var(--t2)` — legible across all three themes (default blue, amoled, light).
- Tab-group wrapped in `.browse-tab-group` so the filter can be pushed to the far right with `margin-left:auto` on `.browse-filter-wrap`.

---

## v5.16.24-velvet — 2026-03-16

### Decades & Genres: Albums/Tracks toggle tabs

**`src/db/sqlite-backend.js`** — two new DB functions:
- `getSongsByDecade(decade, vpaths, username, ignoreVPaths)` — all tracks for a decade (by year range)
- `getAlbumsByGenre(rawGenres, vpaths, ignoreVPaths)` — distinct albums for a genre

**`src/db/manager.js`** — delegating exports for both new functions

**`src/api/db.js`** — two new endpoints:
- `POST /api/v1/db/decade/songs` — track list for a decade
- `POST /api/v1/db/genre/albums` — album list for a genre

**`webapp/app.js`**:
- `viewDecadeAlbums` replaced by `viewDecadeDetail(decade, label, defaultTab)` — fetches both albums and songs in parallel, renders Albums/Tracks tab bar; defaults to Albums if any exist, else Tracks
- `viewGenreSongs` replaced by `viewGenreDetail(genre, defaultTab)` — same pattern; Albums tab + Tracks tab
- `viewDecades` click handler updated to call `viewDecadeDetail`
- `viewGenres` click handler updated to call `viewGenreDetail`
- Added `_mountSongVScroll(allSongs, container)` — virtual scroller for song rows (renders only visible rows + buffer, handles 5000+ tracks smoothly) with delegated click events
- Sort bar in Tracks tab: Artist / Title / Album / Year pills, toggling ↑↓ direction; client-side sort with instant re-render
- `_showSongsIn` is now a thin wrapper over `_mountSongVScroll`
- `_mountAlbumVScroll` accepts optional `containerEl` 4th param (defaults to `content-body`)

**`webapp/style.css`** — new `.browse-mode`, `.browse-tabs`, `.browse-tab`, `.browse-cnt`, `#browse-content` styles — pill tabs consistent with EQ preset buttons; added `.tracks-mode`, `.sort-bar`, `.sort-pill`, `.vslist-wrap` for virtual track list; fixed broken `.settings-input` selector

---

## v5.16.23-velvet — 2026-03-16

### EQ: new band layout + House/Trance/Disco/Pop presets

**`webapp/app.js`, `webapp/index.html`**

**Band layout changes** — better coverage for dance/electronic genres:
- Band 2: 170 Hz → **100 Hz** (Q 1.4 → 1.8) — adds dedicated chest-thump zone (house kick punch)
- Band 3: 310 Hz → **200 Hz** (Q 1.4) — low-mid body; 310 was redundant with 170
- Band 4: 600 Hz → **500 Hz** (Q 1.4 → 1.8) — muddiness notch; tighter Q for surgical cuts
- Band 7:  6 kHz → **10 kHz** (Q 1.4) — hi-hat shimmer, synth air; 6k was too low for trance/house top-end

**New presets** — replaces Electronic with genre-specific curves:
- **House** `[6, 5, 2, -3, -1, 1, 2, 3]` — hard sub, chest thump, mid cut, air push
- **Trance** `[5, 4, 1, -4, 0, 4, 4, 5]` — sub punch, deep mid notch, sparkly top
- **Disco** `[4, 3, -1, -2, 1, 3, 3, 4]` — funk bass, mud cut, string presence
- **Pop** `[2, 1, 0, -1, 2, 3, 2, 3]` — clean, vocal presence, bright
- Bass Boost updated to `[6, 5, 3, 0, 0, 0, 0, 0]` (stronger low end with new band positions)
- Classical, Rock, Vocal recalibrated for new bands

---

## v5.16.22-velvet — 2026-03-17

### Documentation: new README, per-release notes in releases/

- `README.md` fully rewritten — introduces mStream Velvet as a distinct fork; adds feature comparison table vs classic mStream, full feature overview by area, install/update instructions, mobile app info, technical details
- Mobile Apps section corrected: official Niera Tech app uses the native mStream API (not Subsonic); Subsonic clients listed separately
- `releases/` folder created — 25 per-version `.md` files (v5.15.1-velvet through v5.16.21-velvet) extracted from `changes-fork-velvet.md` Part 1; README links to the current version file
- GitHub release `v5.16.22-velvet` tagged from current HEAD

---


## v5.16.21-velvet — 2026-03-16

### SQLite: prepared-statement cache, 6 new indexes, PRAGMA tuning, no ORDER BY RANDOM()

**`src/db/sqlite-backend.js`**

**PRAGMA improvements (init)**
- `PRAGMA cache_size = -32000` — raises SQLite page cache from default 2 MB to 32 MB; keeps hot B-tree pages (indexes, recently-read rows) in RAM instead of re-reading from disk
- `PRAGMA temp_store = MEMORY` — sort/temp B-trees stay in RAM; previously could spill to disk during large ORDER BY passes

**New migration indexes (idempotent `CREATE INDEX IF NOT EXISTS` on every startup)**
- `idx_files_aaFile ON files(aaFile)` — `countArtUsage()` was doing a full 123K-row table scan per file during art cleanup; now an index seek
- `idx_files_vpath_sID ON files(vpath, sID)` — `getStaleFileHashes()` + `removeStaleFiles()` post-scan were scanning the full vpath subset unsorted; now a composite index scan
- `idx_um_user_lp ON user_metadata(user, lp)` — Recently Played query was scanning all user rows then sorting; now index-range walk + no sort pass
- `idx_um_user_pc ON user_metadata(user, pc)` — same for Most Played
- `idx_um_user_rating ON user_metadata(user, rating)` — same for Rated Songs
- `idx_um_user_starred ON user_metadata(user, starred)` — same for Starred Songs / Starred Albums (Subsonic)

**Prepared-statement cache (`_s` object, populated at end of `init()`)**
The following functions previously called `db.prepare()` (= `sqlite3_prepare_v2`) on every invocation. During a scan of 123K files this amounted to ~1 million unnecessary SQL compilations. All now use a pre-compiled statement stored in `_s.*`:
- `findFileByPath` → `_s.findFile`
- `updateFileScanId` → `_s.updateScanId`
- `updateFileArt` → `_s.updateArt`
- `countArtUsage` → `_s.countArtUsage`
- `updateFileCue` → `_s.updateCue`
- `updateFileDuration` → `_s.updateDuration`
- `insertFile` (both the ts-inheritance SELECT and the INSERT) → `_s.insertFileTs` / `_s.insertFileRow`
- `removeFileByPath` → `_s.removeByPath`
- `getLiveArtFilenames` → `_s.liveArt`
- `getLiveHashes` → `_s.liveHashes`
- `getStaleFileHashes` → `_s.staleHashes`
- `removeStaleFiles` → `_s.removeStale`

**Subsonic `getRandomSongs` — replace `ORDER BY RANDOM()` with COUNT + OFFSET**
`ORDER BY RANDOM()` assigns a random value to every candidate row then sorts them all — a full-table sort of all matching rows regardless of `LIMIT`. For 123K songs returning 10, this was sorting 123K rows to produce 10.
New approach: `SELECT COUNT(*)` (index-only) → loop `size` times picking `Math.random() * count` offsets → `LIMIT 1 OFFSET n` per pick using a single pre-prepared statement. `ORDER BY f.rowid` walks the implicit B-tree (free sort). Collision-avoidance Set prevents picking the same offset twice.

---

## v5.16.20-velvet — 2026-03-16

### Auto-DJ: fix heap spike — COUNT+OFFSET instead of full table load

**Problem:** The no-filter (pure random) Auto-DJ path called `getAllFilesWithMetadata` which did `SELECT *` across all rows, loading the entire 123K-song library into Node.js heap on every pick (~50 MB per request). With concurrent users or rapid track changes this could accumulate without being freed promptly.

**`src/db/sqlite-backend.js`**
- `countFilesForRandom(vpaths, username, opts)`: `SELECT COUNT(*)` with the same WHERE filters (vpath, minRating, filepathPrefix, ignoreArtists) — cheap index-only query, nothing in heap
- `pickFileAtOffset(vpaths, username, opts, offset)`: `SELECT … LIMIT 1 OFFSET ?` — fetches exactly one row
- Internal `_buildRandomWhere()` helper shared by both, keeping WHERE logic DRY

**`src/db/loki-backend.js`**
- `countFilesForRandom()` / `pickFileAtOffset()` stubs returning `0` / `null` — Loki is an in-memory store so pulling all rows is normal; returning 0 causes api/db.js to fall through to the existing full-load path

**`src/db/manager.js`**
- Proxy exports for `countFilesForRandom` and `pickFileAtOffset`

**`src/api/db.js`** (`POST /api/v1/db/random-songs`)
- No-filter path now: `COUNT(*)` → pick random offset in `[0, count)` skipping ignored offsets → `LIMIT 1 OFFSET n` — O(1) heap regardless of library size
- ignoreArtists-exhaustion fallback retries with the lean path too, not the full load
- Artist-filter path (similar-artists mode, small result set) unchanged — still uses two-stage fair selection on the full filtered array
- Loki / zero-count fallback: falls through to the original `getAllFilesWithMetadata` path (no regression for Loki users)

---

## v5.16.19-velvet — 2026-03-16

### Auto-Resume setting, nav reorganisation, auth log noise reduction

**`webapp/app.js`**
- Added `autoResume` preference stored in localStorage (`ms2_auto_resume_<user>`) — default OFF (music is always paused on reload unless the user opts in)
- `restoreQueue()` now gates auto-play behind `S.autoResume`; previously playback always resumed on page reload
- New "Auto-Resume" section in Playback Settings view with a toggle and explanatory hint text
- Tools sidebar section now starts collapsed by default (hard-coded alongside user-stored collapsed state)

**`webapp/index.html`**
- "Playback Settings" button moved from the Tools nav section up to the top-level (always visible, above Tools)
- New "Connectors" nav section added, containing Last.fm, Discogs, and Subsonic API nav buttons (previously scattered in Tools)
- Tools section now contains only: Shared Links, Play History

**`src/server.js`**
- Auth failure logging: 401/403 on non-mStream paths (internet scanner probes) downgraded from `warn` to `debug` — only real mStream routes (`/api/`, `/rest/`, `/media/`, `/album-art/`, `/waveform/`) log at `warn` level

---

## v5.16.18-velvet — 2026-03-15

### Subsonic: Folders navigation, folder art, getCoverArt fixes, performance

**`src/api/subsonic.js`**
- `getIndexes`: rewritten for folder-browsing clients (e.g. Substreamer Folders tab)
  - No `musicFolderId` → returns vpaths as top-level entries so user sees "Music, 12-inches, Disco…" instead of a flat artist list
  - `musicFolderId=N` → returns first-level filesystem directories of that vpath, A-Z indexed
- `getMusicDirectory`: full real-filesystem hierarchy browsing using `getDirectoryContents()` — three cases: vpath root (integer id), encoded sub-directory (`d:…`), legacy album_id fallback
- `makeDirId()` / `parseDirId()`: opaque base64url-encoded directory IDs carrying `{v: vpath, p: relPath}`
- Debug request logging middleware on `/rest/*`: logs every Subsonic request to mStream log files with password scrubbed
- `getCoverArt`: handles folder IDs (`d:…`, vpath integers) — resolves to real album art via `getAaFileForDir`; falls back to SVG folder icon; bare album_id / artist_id / song_hash looked up via `getAaFileById`; literal `"null"` id returns 404; folder art responses include `Cache-Control: public, max-age=86400`
- `serveFolderIcon()`: inline SVG folder icon served for directories with no art (transparent background, indigo folder shape)

**`src/db/sqlite-backend.js`**
- `getDirectoryContents(vpath, dirRelPath, username)`: returns `{dirs: [{name, aaFile}], files:[]}` via `GROUP BY + MAX(aaFile)` per sub-directory; full user metadata join on files
- `getAaFileById(id)`: resolves bare album_id / artist_id / song_hash → aaFile filename
- `getAaFileForDir(vpath, dirRelPath)`: resolves a directory path → representative aaFile; results cached in `_aaFileForDirCache` (Map) for O(1) repeat lookups
- Covering index `idx_files_vpath_filepath_aa (vpath, filepath, aaFile)` added — makes initial `getAaFileForDir` queries index-only

**`src/db/loki-backend.js`**
- Same `getDirectoryContents`, `getAaFileById`, `getAaFileForDir` + in-memory cache added

**`src/db/manager.js`**
- New proxy exports: `getDirectoryContents`, `getAaFileById`, `getAaFileForDir`, `clearAaFileForDirCache`

**`src/db/task-queue.js`**
- `db.clearAaFileForDirCache()` called when a file scan completes so stale art lookups are evicted

---

## v5.16.17-velvet — 2026-03-16

### Subsonic REST API 1.16.1 + Open Subsonic extensions

**`src/api/subsonic.js`** — new file
- Full Subsonic 1.16.1 REST API with `openSubsonic: true` in every response
- All responses carry `type: "mstream"` and `serverVersion` per Open Subsonic spec
- Auth: MD5 token auth (`?t=MD5(password+salt)&s=salt`) and plaintext (`?p=`) both supported; separate `subsonic-password` field on each user enables standard Subsonic apps to connect without conflicting with mStream's PBKDF2 password
- XML and JSON response formats (`?f=xml|json`), JSONP supported
- Endpoints: `ping`, `getLicense`, `getMusicFolders`, `getIndexes`, `getArtists`, `getArtist`, `getAlbum`, `getSong`, `getMusicDirectory`, `search2`, `search3`, `getAlbumList`, `getAlbumList2`, `getRandomSongs`, `getSongsByGenre`, `getGenres`, `getNowPlaying`, `getStarred`, `getStarred2`, `star`, `unstar`, `setRating`, `scrobble`, `stream`, `download`, `getCoverArt`, `getLyrics`, `getUser`, `getUsers`, `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist`, `getBookmarks`, `saveBookmark`, `deleteBookmark`, `getScanStatus`, `getOpenSubsonicExtensions`, `createUser`, `updateUser`, `deleteUser`, `changePassword` + stub responses for podcast/radio endpoints
- `stream`/`download` use `res.sendFile()` directly (no JWT redirect); `getCoverArt` reads from albumArtDirectory directly — no 401 on media/art requests from Subsonic clients
- `buildSong()` maps DB rows to Subsonic objects including replayGain, starred, playCount, genre, track, disc, year, contentType, suffix
- Child vpath support: `getVpathMeta()` detects sub-folder vpaths at startup; `resolveVpaths()` maps them to their DB parent; `resolvePrefix()` derives the filepath prefix — `musicFolderId` filtering now works correctly across all 5 vpaths including nested sub-folders

**`src/db/sqlite-backend.js` / `src/db/loki-backend.js`**
- New query functions: `getFilesByArtistId`, `getFilesByAlbumId`, `getSongByHash`, `getStarredSongs`, `getStarredAlbums`, `setStarred`, `getRandomSongs`, `getAlbumsByArtistId`, `getAllAlbumIds`, `getAllArtistIds`
- `setStarred` uses UPSERT pattern — creates or updates `user_metadata` row
- All Subsonic browse functions accept `opts.filepathPrefix` for sub-folder filtering; `prefixClause()` helper added to sqlite backend; loki backend uses regex chain condition

**`src/db/manager.js`**
- Proxy exports added for all ten new DB functions; all Subsonic browse proxies accept and forward `opts` parameter

**`src/util/admin.js`**
- `editSubsonicPassword(username, password)` — stores plaintext subsonic password on user config (same pattern as `editUserPassword`)

**`src/api/admin.js`**
- `POST /api/v1/admin/users/subsonic-password` — set subsonic password for any user (admin only)
- `GET /api/v1/admin/users` now scrubs `subsonic-password` from the response (same as regular password scrubbing)

**`src/server.js`**
- `subsonicApi.setup(mstream)` registered before `authApi.setup()` so Subsonic routes bypass mStream session auth and use their own auth middleware

**`webapp/admin/index.js`**
- Password modal now has two separate fields: "New mStream Password" and "New Subsonic Password"; each is optional — blank = skip; validation requires at least one field filled

**`webapp/index.html`**
- "Subsonic API" nav button added to sidebar (always visible)

**`webapp/app.js`**
- `viewSubsonic()` — shows server URL with copy button, subsonic password change form, and connection hint card (username, API path, token auth note)

---

## v5.16.16-velvet — 2026-03-15

### DB: Add artist_id / album_id / starred columns for Subsonic readiness

**`src/db/sqlite-backend.js`**
- New helper functions `_makeArtistId(artist)` and `_makeAlbumId(artist, album)` — 16-char hex MD5 slugs, collision-free at any practical library size
- `files` table: added `artist_id TEXT` and `album_id TEXT` columns (new DBs) + ALTER TABLE migrations for existing DBs
- `user_metadata` table: added `starred INTEGER DEFAULT 0` column (new DBs) + migration for existing DBs
- Indexes `idx_files_artist_id` and `idx_files_album_id` created via migrations (idempotent on every startup)
- One-time startup backfill: computes and stores `artist_id`/`album_id` for all 137k existing records in a single BEGIN/COMMIT transaction

**`src/db/loki-backend.js`**
- Same ID helpers added
- `fileCollection.ensureIndex('artist_id')` and `ensureIndex('album_id')` on every init
- In-memory backfill for any docs loaded without these fields
- `updateFileTags()` recomputes `artist_id`/`album_id` when artist or album is edited

**`src/db/scanner.mjs`**
- Computes `artist_id` and `album_id` at scan time and sends them in the `add-file` payload — new files get correct IDs immediately without waiting for a backfill

---

## v5.16.15-velvet — 2026-03-14

### Improve: dynamic colour extraction from album art

**`webapp/app.js`**
- Canvas scaled up from 8×8 (64 px) to 32×32 (1024 px) — far less blurring, hues stay distinct
- Replaced single-pixel winner-takes-all with 36 hue buckets (10° each), scored by Σ s² per bucket — balances vibrancy and prevalence so the *characteristic* colour of the cover wins
- Effective distinct colour range increases from ~8 broad zones to 36 discrete hue zones
- All lightness/saturation clamping and readability guarantees unchanged

### Fix: Balance reset button vertical alignment

**`webapp/style.css`**
- `⊙` reset button was 1–2 px too high; changed `vertical-align` from `text-top` to `middle`

### Revert: artLegacy stat (not needed)

**`src/db/sqlite-backend.js`, `src/db/loki-backend.js`, `webapp/admin/index.js`**
- Removed the startup backfill migration and `artLegacy` counter added in previous session — pre-existing NULL `art_source` records will simply not appear in per-source counts, which is the correct behaviour going forward

---

## v5.16.14-velvet — 2026-03-14

### Now Playing label: shows Crossfade status alongside Auto-DJ

**`webapp/app.js`**
- Sub-label now reads `· Auto-DJ: Similar Songs & Crossfade` (or `· Auto-DJ & Crossfade`) when crossfade is active (`S.crossfade > 0`), and falls back to the previous text when crossfade is off
- Both crossfade sliders (DJ panel + Settings panel) now call `_syncQueueLabel()` on `input` so the header updates in real-time as the slider is dragged

---

## v5.16.13-velvet — 2026-03-14

### Fix: VU meter peak lamp glow clipped at top of canvas

**`webapp/app.js`**
- Virtual drawing height `VH` increased from `120` to `134` — adds 14 units of headroom above the arc without moving any needle/arc geometry (pivot `CY=VH` stays at the canvas bottom)
- Peak lamp `lampY` moved from `10` → `24` so the radial glow (radius 20) clears the canvas top edge with 4 units to spare
- Channel label `y` updated `12` → `26` to stay visually aligned with the arc top

---

## v5.16.12-velvet — 2026-03-14

### Fix: search bar loses focus after results arrive

**`webapp/app.js`**
- Removed the `inp.blur()` calls in `doSearch()` that intentionally defocused the search input after results loaded. This was causing the spacebar to fire play/pause instead of inserting a space, because focus had left the `<input>` and the global keydown handler's INPUT guard no longer applied.

---

## v5.16.11-velvet — 2026-03-14

### Admin stats: Total Library Duration

**`src/db/sqlite-backend.js`** / **`src/db/loki-backend.js`**
- `getStats()` now returns `totalDurationSec` — sum of all `duration` values in the files table (SQLite: single `SUM()` query; Loki: accumulator in the doc loop)

**`webapp/admin/index.js`**
- New stat chip **"Total Library Duration"** shown after Waveforms Cached — formatted as `Xd Yh Zm` (days, hours, minutes)
- Hidden when no duration data is available (e.g. library not yet scanned)

---

## v5.16.10-velvet — 2026-03-14

### Admin: Directory access test

**`src/api/admin.js`**
- New `GET /api/v1/admin/directories/test` endpoint (admin-only): iterates every configured vpath, writes a uniquely-named temp file, reads it back, deletes it, and reports `{ readable, writable, storageType, error }` per directory — no artifact is ever left on disk

**`webapp/admin/index.js`**
- New **"Test Access"** button in the Directories card header — opens a modal that immediately runs the check and shows per-directory read/write status
- Storage type is auto-detected and shown as a badge: Linux local, Linux mounted drive, Windows local drive, Windows network share, macOS local, macOS external, or Desktop App (Electron)
- Results use green ✓ / amber ✓ / red ✗ indicators; any OS error code is shown inline
- Advice panel at the bottom adapts to the overall result: all-good confirmation, or platform-specific instructions to fix permissions (Linux/macOS `chown`+`chmod`, Windows Security properties)

---

## v5.16.9-velvet — 2026-03-13

### Waveform overhaul — RMS + γ=0.7 + 8 kHz sampling

**`src/api/waveform.js`**
- `SAMPLE_RATE` raised from 200 → **8000 Hz**: each display bar now computes RMS over ~5000+ raw PCM samples, producing a naturally smooth energy envelope without any explicit smoothing pass
- `POINTS` set to **600**: each bar renders at ~1.5–2 px wide, matching SoundCloud/Beatport density
- Per-chunk method changed from **mean of absolute values → RMS** (sum of squares → sqrt): properly weights sustained energy without being hijacked by individual noise spikes
- Normalisation ceiling moved from p98 → **p99**; noise gate added at 0.1% of p99 to silence true DC offset / digital black
- Loudness curve changed from **linear → γ=0.7 power curve**: quiet breakdowns (2% of peak) render at ~8% bar height (visible but clearly quiet); loud 40–100% range maps to 53–100% (47% spread — kick, hi-hat, drop all distinct)
- 11 existing waveform cache files cleared so they regenerate with the improved algorithm

---

## v5.16.8-velvet — 2026-03-13

### Discogs cover-art search parallelized

**`src/api/discogs.js`**
- Phase 1 (search queries): all Discogs search requests now fire simultaneously via `Promise.allSettled` instead of sequentially — results are collected in original priority order
- Phase 2 (image resolution): all candidate master-resolve + release-fetch + image-download chains fire in parallel — worst-case round-trip drops from ~10–15 s to ~1–2 s
- One failed Discogs call no longer blocks the others

---

## v5.16.7-velvet — 2026-03-13

### Crossfade slider added to Auto-DJ settings

**`webapp/app.js`**
- Auto-DJ settings view (`viewAutoDJ`) now includes a **Crossfade Duration** row with a `0–12 s` range slider, matching the one in Playback Settings
- Both sliders read from and write to the same `S.crossfade` state variable and the same `ms2_crossfade_<user>` localStorage key — changing one is immediately reflected in the other if both views were somehow in the DOM simultaneously
- Slider uses existing `.xf-ctrl` / `.xf-slider` / `.xf-val` CSS classes for consistent look across both panels

---

## v5.16.6-velvet — 2026-03-13

### Waveform percentile normalisation — fixes flat waveforms on tracks with transient peaks

**`src/api/waveform.js`**
- `downsample()` now normalises against the **98th percentile** of bar values instead of the absolute maximum
- Previously a single loud transient (e.g. one drum hit) became the global max, compressing the entire rest of the track to ~20% height
- Now the 2% loudest spikes clip to 255 and everything else scales against realistic programme loudness — waveforms are consistently tall and readable across all track types
- All 602 stale waveform cache files wiped; tracks regenerate on next play

---

## v5.16.5-velvet — 2026-03-13

### Track duration stored in DB and exposed via API

**`src/db/scanner.mjs`**
- `parseMyFile()` now extracts `format.duration` from the `music-metadata` parse result and stores it as `songInfo._duration` (seconds, float, 3 decimal places; `null` if not present or non-finite)
- `insertEntries()` passes `duration` through to the `add-file` API call

**`src/db/sqlite-backend.js`**
- `duration REAL` column added to the `files` table schema
- Migration: `ALTER TABLE files ADD COLUMN duration REAL` runs silently on existing databases
- `insertFile()` now stores `duration`

**`src/db/loki-backend.js`**
- No changes needed — Loki stores documents as plain objects so `duration` persists automatically

**`src/api/db.js`**
- `renderMetadataObj()` now includes `"duration"` in every track metadata response
- Covers all track-returning endpoints: `/api/v1/db/metadata`, `/album-songs`, `/search`, `/rated`, `/recent/added`, `/stats/recently-played`, `/stats/most-played`, `/random-songs`, `/playlist/load`, `/genre/songs`
- Value is seconds as a float (e.g. `237.431`); `null` for tracks not yet rescanned

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

---

## Part 2 — GUIv2 Player — Versioned Entries & Feature Reference

> *Source: `changes4GUIv2.md` — detailed record of all `webapp/v2/` changes. Version entries for v5.15.x/v5.16.x complement the broader entries in Part 1 above with player-specific detail.*

---

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

---

## Part 3 — Admin Panel v2 — Change Log

> *Source: `changes-adminGUIv2.md` — all `webapp/admin-v2/` fixes and features, plus supporting backend and cross-component changes.*

---

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
