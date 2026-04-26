# Album Version Tags — Design Plan

**Status**: Implemented — shipped in v6.13.0-velvet
**Motivation**: Users with multiple editions of the same album (original, remaster, deluxe, hi-res) need a reliable way to distinguish them in the UI. The same album title appears multiple times in the artist view with no distinguishing label.

---

## What is a TXXX tag? (and when do you use it?)

### The short version

`TXXX` is a **user-defined text field** in the ID3v2 standard (MP3 files). Because the ID3 standard cannot list every possible piece of metadata anyone will ever want, it provides one open-ended slot where *you* decide the name and value. Every `TXXX` frame has two parts:

```
TXXX : EDITION = Deluxe Edition
       ↑ description  ↑ value
       (you name it)  (you fill it)
```

In mStream Velvet's config list you write it as `TXXX:EDITION` — the colon separates the frame type from the description you chose.

### Practical examples — what to set in your tagger

| You want to tag | Tagger field name | mStream Velvet config entry | Example value |
|---|---|---|---|
| Edition type | `TXXX` → description `EDITION` | `TXXX:EDITION` | `Deluxe Edition` |
| Version label | `TXXX` → description `VERSION` | `TXXX:VERSION` | `2016 Remaster` |
| Audio quality | `TXXX` → description `QUALITY` | `TXXX:QUALITY` | `24bit/96kHz` |
| Remaster year | `TXXX` → description `REMASTER` | `TXXX:REMASTER` | `2003 Remaster` |
| Album version | `TXXX` → description `ALBUMVERSION` | `TXXX:ALBUMVERSION` | `Expanded Edition` |

**In foobar2000**: Column Browser → right-click a track → Properties → `...` button → New → enter `EDITION` as the field name → enter `Deluxe Edition` as the value.

**In Mp3tag**: In the tag panel, click the `+` button to add a new field → field name: `TXXX:EDITION` → value: `Deluxe Edition`. *(Mp3tag uses the TXXX: prefix notation directly.)*

**In MusicBrainz Picard**: Picard automatically writes some TXXX fields from its scripting system. If you use a custom script: `~edition` → maps to `TXXX:EDITION` in the output.

### TXXX only applies to MP3 files

| File format | Equivalent to `TXXX:EDITION` |
|---|---|
| **MP3** | `TXXX` frame with description `EDITION` |
| **FLAC / OGG / Opus** | Vorbis comment key `EDITION = Deluxe Edition` |
| **M4A / AAC** | iTunes custom atom `----:com.apple.iTunes:EDITION` |
| **WavPack / APE** | APE tag `Edition = Deluxe Edition` |

mStream Velvet's scanner handles all four formats. The config entry `TXXX:EDITION` tells it to look for `EDITION` in whatever format the file uses — it maps automatically.

### The default field priority order

mStream Velvet tries these fields in this order, stopping at the first non-empty value:

```
1. TIT3           — MP3 subtitle frame (dBpoweramp, EAC default)
2. SUBTITLE       — FLAC/Vorbis equivalent of TIT3
3. DISCSUBTITLE   — MusicBrainz Picard (e.g. "Remaster")
4. TXXX:EDITION   — User-defined: edition name
5. TXXX:VERSION   — User-defined: version string
6. TXXX:ALBUMVERSION — Variant spelling
7. TXXX:QUALITY   — User-defined: audio quality string
8. TXXX:REMASTER  — User-defined: remaster info
9. TXXX:DESCRIPTION — User-defined: free description
10. EDITION       — Vorbis/APE raw key (without TXXX: prefix)
11. VERSION       — Vorbis/APE raw key
12. ALBUMVERSION  — Vorbis/APE raw key
13. QUALITY       — Vorbis/APE raw key
14. REMASTER      — Vorbis/APE raw key
→  heuristic fallback (album title / folder name / audio properties)
```

You can change this order in **Admin → Database → Album Version Tag Fields**.

---

## The Problem in Concrete Terms

A user has two copies of *The Division Bell* by Pink Floyd:

| Folder | Files | Tag values |
|--------|-------|------------|
| `Music/Pink Floyd/The Division Bell/` | 16× FLAC 16bit | `ALBUM = The Division Bell`, `TIT3 = 2016 remaster` |
| `Music/Pink Floyd/The Division Bell [HiRes]/` | 16× FLAC 24bit-96kHz | `ALBUM = The Division Bell`, `TIT3 = HiRes 24bit-96kHz` |

mStream Velvet already stores them as two separate album groups (different folder → different `dir` key in `getArtistAlbumsMulti`). But the artist view album cards only show `album.name` and `album.year` — both identical. The user cannot tell which is which.

**Critical observation**: the user in the example above uses `TIT3` (subtitle). But the real world is far messier — users tag their files with dozens of different keys depending on which ripper, tagger, or convention they follow. A hardcoded list of three or four "preferred" tag names would silently miss the majority of real libraries.

---

## Reality Check: The Tag Diversity Problem

There is no single standard tag for "album edition". Users set this information in wildly different places:

### ID3v2 (MP3, AIFF, WAV)
| Tag ID | Name | Used by |
|--------|------|---------|
| `TIT3` | Subtitle / content description | Manual taggers, EAC, dBpoweramp |
| `TSST` | Set subtitle | Rare; marks a disc set as a whole |
| `TXXX:EDITION` | User-defined: edition | Power users following the TXXX convention |
| `TXXX:VERSION` | User-defined: version | Beets, picard with custom scripts |
| `TXXX:ALBUMVERSION` | User-defined: album version | Variant spelling |
| `TXXX:RELEASETYPE` | User-defined: release type | MusicBrainz-aware taggers |
| `TXXX:QUALITY` | User-defined: quality | Custom home workflows |
| `TXXX:REMASTER` | User-defined: remaster year | Custom home workflows |
| `TXXX:DESCRIPTION` | User-defined: free description | Varies widely |
| `COMM:eng` / `COMM::` | Comment | iTunes imports, foobar2000 defaults |

### Vorbis comments (FLAC, OGG, Opus)
All Vorbis tags are free-form key=value. Common ones for edition/version:
| Key | Used by |
|-----|---------|
| `SUBTITLE` | Direct TIT3 equivalent |
| `EDITION` | Beets `albumtype` ecosystem |
| `VERSION` | Picard custom variables |
| `ALBUMVERSION` | Variant |
| `DISCSUBTITLE` | MusicBrainz Picard standard output |
| `RELEASETYPE` | MusicBrainz (e.g. `Album`, `Single`, `Compilation`) |
| `QUALITY` | Custom |
| `REMASTER` | Custom |
| `DESCRIPTION` | Various |
| `COMMENT` | General comment field |

### MP4 / AAC / M4A (iTunes container)
| Atom | Name | Notes |
|------|------|-------|
| `----:com.apple.iTunes:EDITION` | Custom atom | iTunes extended tags |
| `----:com.apple.iTunes:VERSION` | Custom atom | iTunes extended tags |
| `©des` | Description | iTunes short description field |
| `ldes` | Long description | iTunes long description field |

### APE tags (WavPack, Monkey's Audio)
| Key | Notes |
|-----|-------|
| `Edition` | Direct equivalent |
| `Version` | Direct equivalent |
| `SubTitle` | Direct equivalent |
| `Comment` | General |

The conclusion: **any fixed hardcoded list will work for some users and silently fail for others.** The architecture must be configurable.

---

## Architecture: Configurable Tag Field Mapping

### The core idea

The admin defines an **ordered list of tag fields** to try for `album_version`. The scanner walks through that list in order and uses the first non-empty value it finds. If nothing matches any configured field, the heuristic fallback runs.

This is stored in `save/conf/default.json` under a new key `albumVersionTags`:

```json
{
  "albumVersionTags": [
    "TIT3",
    "SUBTITLE",
    "DISCSUBTITLE",
    "TXXX:EDITION",
    "TXXX:VERSION",
    "TXXX:ALBUMVERSION",
    "TXXX:QUALITY",
    "TXXX:REMASTER",
    "TXXX:DESCRIPTION",
    "EDITION",
    "VERSION",
    "ALBUMVERSION",
    "QUALITY",
    "REMASTER",
    "COMMENT"
  ]
}
```

**Default list** (shipped in the codebase default, used when the key is absent from config):
1. `TIT3` / `SUBTITLE` — the most widely used standard tag
2. `DISCSUBTITLE` — output by MusicBrainz Picard for edition variants
3. `TXXX:EDITION`, `TXXX:VERSION`, `TXXX:ALBUMVERSION` — explicit user-defined fields
4. `TXXX:QUALITY`, `TXXX:REMASTER` — audio quality / remaster info
5. `EDITION`, `VERSION`, `ALBUMVERSION` — Vorbis equivalents of the TXXX fields above
6. `COMMENT` — last resort; generic comment field (lowest priority because it often contains unrelated info like ripping notes)

A user who tags with `TXXX:DESCRIPTION` simply adds it to the list in the admin panel. A user who only uses `SUBTITLE` can shorten the list to just that. Order matters: place your primary tag first.

### How the scanner reads configurable tags

`music-metadata` exposes tag data in two ways:
- **`common.*`** — cross-format normalised fields (e.g. `common.comment`, `common.subtitle`)
- **`native['ID3v2.4']`** / `native['vorbis']` / etc. — raw tag arrays per format

The scanner resolves a configured field name against both:

```js
function resolveTagField(fieldName, songInfo, nativeMap) {
  const key = fieldName.toUpperCase().trim();

  // 1. TXXX:KEY — ID3v2 user-defined text
  if (key.startsWith('TXXX:')) {
    const desc = key.slice(5);
    return nativeMap.txxx?.[desc] ?? null;
  }

  // 2. music-metadata common fields (cross-format normalised)
  const commonAlias = {
    'TIT3':        () => firstOf(songInfo.subtitle),
    'SUBTITLE':    () => firstOf(songInfo.subtitle),
    'DISCSUBTITLE':() => firstOf(songInfo.discsubtitle),
    'COMMENT':     () => firstOf(songInfo.comment?.map(c => c.text ?? c)),
  };
  if (commonAlias[key]) return commonAlias[key]() ?? null;

  // 3. Raw Vorbis / APE / native tag by exact key name
  return nativeMap.vorbis?.[key]
      ?? nativeMap.ape?.[key]
      ?? nativeMap.itunesCustom?.[key]
      ?? null;
}

function firstOf(v) {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}
```

`nativeMap` is built once per file from `parsed.native`:

```js
function buildNativeMap(native) {
  const map = { txxx: {}, vorbis: {}, ape: {}, itunesCustom: {} };
  for (const [format, tags] of Object.entries(native || {})) {
    for (const tag of tags) {
      if (tag.id === 'TXXX' && tag.value?.description) {
        map.txxx[tag.value.description.toUpperCase()] = tag.value.text;
      } else if (format === 'vorbis') {
        map.vorbis[tag.id.toUpperCase()] = tag.value;
      } else if (format === 'APEv2') {
        map.ape[tag.id.toUpperCase()] = tag.value;
      } else if (tag.id?.startsWith('----:com.apple.iTunes:')) {
        const k = tag.id.replace('----:com.apple.iTunes:', '').toUpperCase();
        map.itunesCustom[k] = tag.value;
      }
    }
  }
  return map;
}
```

The main derive function then becomes:

```js
function deriveAlbumVersion(songInfo, native, fmtInfo, configuredFields) {
  const nativeMap = buildNativeMap(native);

  // Walk the user-configured (or default) tag field list
  for (const field of configuredFields) {
    const val = resolveTagField(field, songInfo, nativeMap);
    if (val && String(val).trim()) return String(val).trim();
  }

  // Heuristic fallback (see section below)
  const fromTitle = parseVersionHeuristic(songInfo.album || '');
  if (fromTitle) return fromTitle;

  const folder = (songInfo.filePath || '').split('/').slice(-2, -1)[0] || '';
  const fromFolder = parseVersionHeuristic(folder);
  if (fromFolder) return fromFolder;

  // Infer from audio properties
  if ((fmtInfo.bitsPerSample ?? 0) >= 24 && (fmtInfo.sampleRate ?? 0) >= 88200) {
    const bits = fmtInfo.bitsPerSample;
    const khz  = Math.round(fmtInfo.sampleRate / 1000);
    return `Hi-Res ${bits}bit/${khz}kHz`;
  }

  return null;
}
```

---

## Heuristic Fallback — Robust Normalisation

The previous design ran raw regex against raw strings. This is fragile because:
- Users write "Remastered", "remaster", "REMASTER", "Re-master", "remasterised"
- Typos: "Dleuxe", "Dleuxe Edition" (yes, these exist in real libraries)
- Mixed spacing: "(Deluxe Edition)" vs "(DeluxeEdition)" vs "[Deluxe]"
- Accented characters: "édition deluxe"
- Unicode en-dashes vs hyphens: "2011‒Remaster" vs "2011-Remaster"

### Pre-normalisation step

Before any regex is applied, normalise the input string:

```js
function normaliseForHeuristic(s) {
  return String(s)
    .normalize('NFD')                    // decompose accents
    .replace(/[\u0300-\u036f]/g, '')     // strip diacritics
    .toLowerCase()
    .replace(/[–—\u2012-\u2015]/g, '-') // normalise all dashes to hyphen
    .replace(/[^\x20-\x7e]/g, ' ')      // replace non-ASCII with space
    .replace(/\s+/g, ' ')               // collapse whitespace
    .trim();
}
```

Now all patterns match against a clean ASCII lowercase string.

### Pattern table (all applied to normalised input)

Each pattern produces a canonical **display label** that is stored verbatim:

| Normalised pattern (regex on lowercase) | Display label | Notes |
|-----------------------------------------|---------------|-------|
| `d[e]?luxe\s*(edition\|ed\.?\|ed)?` | `Deluxe Edition` | handles "deluxe", "dleuxe" via the optional `[e]` is not enough — see fuzzy section |
| `expan\w*\s*(edition\|ed\.?)?` | `Expanded Edition` | "expanded", "expansion" |
| `anni?ver\w*\s*(edition\|ed\.?)?` | `Anniversary Edition` | typo-tolerant prefix match |
| `remast\w*` | `Remaster` | "remaster", "remastered", "remastering", "remasterised" |
| `remast\w*\s+(\d{4})` | `Remaster $1` | includes year when present |
| `(\d{4})\s+remast\w*` | `$1 Remaster` | year-first variant |
| `(\d{4})\s+(digital\s+)?remast\w*` | `$1 Remaster` | |
| `hi.?res` | `Hi-Res` | "hires", "hi-res", "hi res" |
| `(\d{2,3})\s*-?\s*bit` | `${n}bit` | "24bit", "24-bit", "24 bit" |
| `(\d{2,4}(?:\.\d)?)\s*k?hz` | `${n}kHz` | "96khz", "96.0 kHz", "192kHz" |
| `dsd\s*(\d+)?` | `DSD${n}` | "DSD64", "DSD 128", "DSD" |
| `sacd` | `SACD` | |
| `bonus\s+(track\|disc\|edition)?` | `Bonus Edition` | |
| `(box\s*set\|boxset)` | `Box Set` | |
| `(live\b(?!\s+remaster))` | `Live` | avoids "Live Remaster" matching "Live" alone |
| `(mono\b)` | `Mono` | |
| `(stereo\b)` | `Stereo` | |
| `(complete\s+edition\|complete\s+coll\w+)` | `Complete Edition` | |

### Fuzzy matching for common typos

For the most commonly misspelled words, use a Levenshtein distance ≤ 1 check before the regex, applied only to words of 5+ characters:

```js
const FUZZY_WORDS = {
  'deluxe':   'Deluxe Edition',
  'expanded': 'Expanded Edition',
  'remaster': 'Remaster',
  'remastered': 'Remaster',
  'anniversary': 'Anniversary Edition',
};

function fuzzyMatch(normalised) {
  for (const [target, label] of Object.entries(FUZZY_WORDS)) {
    // Find all words in the string that are within edit distance 1 of target
    const words = normalised.split(/[\s\-\[\]()\{\}]+/);
    for (const word of words) {
      if (word.length >= target.length - 1 && levenshtein(word, target) <= 1) {
        return label;
      }
    }
  }
  return null;
}
```

`levenshtein()` is a standard 10-line implementation — no external dependency needed.

### Combined patterns: multiple signals in one string

When a string contains both edition and quality info (e.g. `"Deluxe Edition 24bit/96kHz"`), the heuristic extracts both and joins them:

```js
function parseVersionHeuristic(rawInput) {
  if (!rawInput) return null;
  const s = normaliseForHeuristic(rawInput);
  const parts = [];

  const editionMatch = matchEdition(s);   // returns "Deluxe Edition" or null
  const qualityMatch = matchQuality(s);   // returns "24bit/96kHz" or null

  // Try fuzzy if no pattern matched
  const fuzzy = (!editionMatch && !qualityMatch) ? fuzzyMatch(s) : null;

  if (editionMatch) parts.push(editionMatch);
  if (qualityMatch) parts.push(qualityMatch);
  if (fuzzy && !parts.length) parts.push(fuzzy);

  return parts.length ? parts.join(' · ') : null;
}
```

**Confidence gate**: heuristics only fire on strings that contain `(...)`, `[...]` delimiters OR where a known keyword is found. Plain album names like `"The Division Bell"` never trigger a false positive.

```js
const HAS_BRACKET_OR_KEYWORD = /[\[\](]|remast|deluxe|hi.res|\d{2,3}.?bit|\d{2,4}.?k?hz|dsd|sacd|expanded|anniversary|bonus|live\b/i;
if (!HAS_BRACKET_OR_KEYWORD.test(s)) return null; // plain name, skip heuristics
```

---

## Admin UI: Tag Field Configuration

### Where it lives

Admin panel → **Scanning** section → **Album Version Tag Fields** card.

### What it shows

A reorderable list of tag field names that the scanner will try, in order. The user can:
- **Add** a custom field name (free-text input)
- **Remove** any field from the list
- **Drag to reorder** (or move up/down buttons for touch screens)
- **Reset to defaults** button

Visual feedback: each field in the list shows the format type badge next to it: `ID3`, `Vorbis`, `TXXX`, `iTunes` — derived from the field name pattern.

### Storage

Saved to `save/conf/default.json`:
```json
{
  "albumVersionTags": ["TIT3", "SUBTITLE", "DISCSUBTITLE", "TXXX:EDITION", "TXXX:VERSION", "EDITION", "VERSION"]
}
```

The scanner process receives this list via the scan job JSON payload (same mechanism already used for `skipImg`, `compressImage`, etc.).

### Admin API endpoint

```
POST /api/v1/admin/config/album-version-tags
Body: { tags: ["TIT3", "TXXX:EDITION", ...] }
```

Validates: array of strings, max 20 entries, each string ≤ 60 chars, only safe characters.

---

## Database Schema Changes

### New columns on `files`

```sql
ALTER TABLE files ADD COLUMN album_version TEXT;
ALTER TABLE files ADD COLUMN album_version_source TEXT;  -- which field/method produced the value
```

`album_version_source` stores a short machine-readable string for the admin inventory panel, e.g. `"TIT3"`, `"TXXX:EDITION"`, `"heuristic:title"`, `"heuristic:folder"`, `"inferred:audio"`. This enables the admin to show a breakdown of exactly how version data was gathered across the library.

### Album queries

The three album listing functions need to expose `album_version`:

```sql
-- getArtistAlbumsMulti / getArtistAlbums
SELECT album AS name, MAX(year) AS year,
  MAX(aaFile) AS album_art_file,
  MAX(album_version) AS album_version,   -- ← new
  rtrim(filepath, replace(filepath, '/', '')) AS dir
FROM files
WHERE ...
GROUP BY album, rtrim(filepath, replace(filepath, '/', ''))
```

`MAX(album_version)` is safe because all tracks in the same physical folder share the same derived version string.

### FTS index — `fts_files`

`album_version` is added to the FTS5 `fts_files` table so users can search "deluxe" or "24bit" and find those editions:

```sql
CREATE VIRTUAL TABLE fts_files USING fts5(
  title, artist, album, album_version, filepath,
  content='files', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 1'
);
```

---

## Scanner Changes

### `src/db/scanner.mjs`

Key new functions:
1. `buildNativeMap(native)` — builds a flat lookup of all raw tag data by format
2. `resolveTagField(fieldName, songInfo, nativeMap)` — resolves one configured field name
3. `normaliseForHeuristic(s)` — ASCII lowercase, diacritics stripped, dashes normalised
4. `fuzzyMatch(normalised)` — Levenshtein ≤ 1 for common terms
5. `matchEdition(s)` — regex battery for edition terms
6. `matchQuality(s)` — regex battery for audio quality terms
7. `parseVersionHeuristic(raw)` — combines the above with confidence gate
8. `deriveAlbumVersion(songInfo, native, fmtInfo, configuredFields)` — orchestrator

The `configuredFields` array comes from `loadJson.albumVersionTags` (set when the scan job is started). If absent, the built-in default list is used.

New fields in the scanner payload:
```js
data.album_version        = deriveAlbumVersion(songInfo, parsed.native, fmtInfo, loadJson.albumVersionTags);
data.album_version_source = lastSource; // set by deriveAlbumVersion as a side-effect
```

### `src/db/sqlite-backend.js`

- Migration: `ALTER TABLE files ADD COLUMN album_version TEXT` + `album_version_source TEXT`
- `insertFileRow` — add both columns
- `insertFile()` — pass both from `fileData`
- `getArtistAlbumsMulti`, `getArtistAlbums`, `getAlbums` — add `MAX(album_version)`
- `fts_files` definition — add `album_version` column

### `src/api/scanner.js`

When starting a scan job, inject `albumVersionTags` from config into the scanner payload:
```js
albumVersionTags: program.albumVersionTags || DEFAULT_ALBUM_VERSION_TAGS,
```

---

## API Changes

### `POST /api/v1/admin/config/album-version-tags`

New admin-only endpoint. Validates and saves the tag list to config.

### `GET /api/v1/albums/browse` and artist album endpoints

No route changes needed — `album_version` flows through once DB queries return it.

### `POST /api/v1/db/search`

FTS automatically searches `album_version`. No route changes needed.

### Subsonic API

Map `album_version` to the Subsonic `comment` field on `<album>` elements for third-party client compatibility.

---

## UI Changes

The guiding principle: **the user must immediately understand when they are looking at multiple versions of the same album, and must never have to wonder which one they are opening or playing.**

---

### 1 — Artist profile: album grid (multi-version scenario)

This is the main problem to solve. A user who owns *The Division Bell* in three versions — original 1994, 2016 remaster, 24bit/96kHz hi-res — currently sees three identical cards with no distinguishing information.

**After this change:**

```
[art]           [art]           [art]
The Division    The Division    The Division
Bell            Bell            Bell
1994            2016            2016
                [2016 Remaster] [Hi-Res 24bit/96kHz]
```

Implementation — version badge below the year:

```js
`<div class="album-meta">
  <div class="album-name">${esc(alb.name || '—')}</div>
  <div class="album-year">
    ${alb.year || ''}
    ${alb.album_version ? `<span class="alb-version-badge">${esc(alb.album_version)}</span>` : ''}
  </div>
</div>`
```

**Visual grouping of same-title albums**: when an artist has two or more albums with the same `name` value, render them with a subtle shared background or a thin left border accent (`var(--accent)` at 30% opacity) to signal "these are variants of the same album". No grouping collapse — keep all versions visible. This is purely a CSS class `alb-sibling-group` added by the render loop when it detects `alb.name === prevAlbName`.

CSS: `.alb-version-badge` — inline pill, `var(--t3)` text, `var(--bg2)` background, 10px font, no uppercase, `max-width: 120px`, overflow ellipsis with `title` tooltip for long strings.

---

### 2 — Album detail view (`viewAlbumSongs`)

The detail header currently shows `Artist · Year`. Extend to include the version on the same line, larger than the badge style on cards:

```
Pink Floyd
The Division Bell  ·  2016 Remaster     ← version inline, same size as year
```

If `album_version` is null, nothing changes — the line stays `Artist · Year`.

`album_version` is picked from `rows[0]?.album_version` (all tracks in a folder share the same derived value). It is passed through `viewAlbumSongs()` opts → rendered in the header.

**Track list**: individual track subtitles are not shown per-track (they would all say the same thing). Exception: if some tracks have a different subtitle than others (bonus disc scenario), show a small per-track badge only on the tracks where the value differs from the album-level version.

---

### 3 — Albums browse grid (library-wide)

The flat album browser (`/albums`) currently shows `Album Title / Artist / Year` on each card. With many remaster variants this becomes noisy if a user has e.g. 5 versions of Dark Side of the Moon.

**Badge**: same pill design as artist profile, shown below year.

**Sort/filter**: the album browser already supports sort-by-name and sort-by-year. No new filter controls needed for Phase 3. In a later phase, a "Group versions" toggle could collapse same-name albums into a single card with a version picker overlay, but this is out of scope for now.

**Tooltip on hover**: hovering the version badge shows the full raw `album_version` string (for truncated values).

---

### 4 — Search results: tracks tab

Tracks already have `artist`, `album`, and `year` shown per row. Add `album_version` as a small inline badge after the album name in the track row:

```
Love Will Tear Us Apart   Joy Division   Unknown Pleasures [2015 Remaster]   1980
```

The badge must be visually lighter than the album name so it does not compete with the track title. Use `var(--t3)` colour and 85% font size. No separate column — inline within the album cell.

---

### 5 — Search results: albums tab

When a search returns album results, each album row shows:

```
[art]  The Division Bell  ·  Pink Floyd  ·  1994
[art]  The Division Bell  ·  Pink Floyd  ·  2016  [2016 Remaster]
[art]  The Division Bell  ·  Pink Floyd  ·  2016  [Hi-Res 24bit/96kHz]
```

The version badge sits at the end of the year field. The three rows are visually distinct despite sharing the same title and artist — the user can immediately see they are different releases and click the one they want.

---

### 6 — Now-playing / queue panel

When a track from a versioned album is playing or in the queue, show the version badge after the album name in the queue row. This matters when the user has queued a mix of versions and needs to see which is playing. Small pill, same style, `max-width: 90px`.

---

### 7 — CSS design tokens

All version-related UI uses a consistent set of classes so the appearance can be globally adjusted:

```css
.alb-version-badge {
  display: inline-block;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--bg2);
  color: var(--t3);
  vertical-align: middle;
  margin-left: 4px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Sibling albums with the same title: subtle grouped background */
.alb-sibling-group {
  outline: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-radius: 6px;
}
```

The design deliberately avoids aggressive visual treatment. Version badges are supplementary info — they should be readable on inspection but should not draw the eye more than the album art and title.

---

## Admin Panel — Tag Inventory + Configuration

### Configuration card
Reorderable list of tag field names (described above).

### Inventory panel (read-only)

Shows how many files have version data and from which source:

| Source | Count |
|--------|-------|
| TIT3 / SUBTITLE | 2,340 |
| DISCSUBTITLE | 480 |
| TXXX:EDITION | 4,280 |
| TXXX:VERSION | 1,102 |
| Heuristic (title) | 650 |
| Heuristic (folder) | 120 |
| Inferred (Hi-Res audio) | 3,100 |
| No version info | — |

SQL:
```sql
SELECT album_version_source, COUNT(*) AS cnt
FROM files
WHERE album_version_source IS NOT NULL
GROUP BY album_version_source
ORDER BY cnt DESC;
```

---

## Implementation Phases

### Phase 1 — Tag mapping config + scanner + DB (backend only)
1. Add `albumVersionTags` config key with default list
2. Implement `buildNativeMap`, `resolveTagField`, heuristic functions in scanner
3. DB migration: `album_version` + `album_version_source` columns
4. Extend album query functions to return `album_version`
5. Add admin API endpoint for config

**Deliverable**: after a rescan, `album_version` is populated from whatever tags the user has. No visible UI change yet.

### Phase 2 — Admin UI: tag field configuration
1. Configuration card in Admin → Scanning
2. Drag-to-reorder (or up/down arrows) list
3. Add/remove fields, reset-to-defaults button
4. Save via new API endpoint

**Deliverable**: admins can point mStream Velvet at their specific tag keys without touching config files.

### Phase 3 — Album card badges + sibling grouping
1. Artist profile album grid — version badge + `.alb-sibling-group` visual grouping for same-name albums
2. Albums browse grid — version badge on cards
3. Now-playing / queue panel — version badge after album name in queue rows
4. `alb-version-badge` CSS, `alb-sibling-group` CSS

**Deliverable**: album lists show edition labels; multiple versions of the same album are visually grouped in the artist profile.

### Phase 4 — Album detail header + track list
1. Pass `album_version` through `viewAlbumSongs()` opts
2. Render in detail header inline with year
3. Per-track badge for bonus disc variant tracks (only shown when a track's subtitle differs from the album-level version)

**Deliverable**: opening an album makes its edition immediately clear from the header.

### Phase 5 — FTS + search integration
1. Add `album_version` to `fts_files`
2. FTS rebuild trigger on startup
3. Search result track rows — version badge after album name in the album cell
4. Search result album rows — version badge after year field

### Phase 6 — Admin inventory panel
1. Source breakdown table
2. Optional: list albums with multiple editions detected in the same library

---

## Open Questions / Decisions Needed

1. **Single combined string vs two separate fields?**  
   `album_version TEXT` (single derived label) is the simplest path to Phase 1–3. If future filtering ("show only Hi-Res") is desired, add `album_quality TEXT` as a second column later. Don't over-engineer now.

2. **Should `album_version` be user-editable via the Tag Editor?**  
   Yes — fits naturally into the Tag Workshop design (`docs/tageditor.md`). The override is stored in DB only, not written back to the audio file tag.

3. **Track subtitle vs album version**  
   `TIT3` is technically a per-track tag. If tracks in the same folder have *different* subtitle values (e.g. bonus disc labeling), use the *most common* value across the folder as `album_version` rather than the first one. A simple majority-vote across the folder's files handles this correctly.

4. **COMMENT field: include or exclude by default?**  
   Comment fields often contain ripper notes, URLs, and unrelated text. `COMMENT` should be in the configurable list but **not** in the default list. Users who want it can add it manually. Putting it in the default would generate false positives for most users.

5. **`bit_depth` column**  
   `fmtInfo.bitsPerSample` is available in the scanner but not currently stored in the DB. Phase 1 should add `bit_depth INTEGER` to the `files` table — both for the Hi-Res inference and for the track detail modal / Subsonic clients.

---

## Files to Modify (summary)

| File | Change |
|------|--------|
| `save/conf/default.json` | Add `albumVersionTags` default list |
| `src/db/scanner.mjs` | Tag resolver, heuristic functions, `deriveAlbumVersion()` |
| `src/db/sqlite-backend.js` | Migration, schema, INSERT, album SELECT queries, FTS |
| `src/api/scanner.js` | Pass `albumVersionTags` from config to scanner payload |
| `src/api/albums-browse.js` | Ensure `album_version` passes through to response objects |
| `webapp/app.js` | Artist profile album grid (badge + sibling grouping), album detail header, albums browse, search track rows, search album rows, queue panel |
| `webapp/app.css` | `.alb-version-badge`, `.alb-sibling-group` |
| `webapp/admin/index.js` | Tag field config card + inventory panel |

---

## Related Files / Prior Art

- `docs/tageditor.md` — Tag Workshop design
- `docs/scanning.md` — Scanner architecture
- `docs/albums.md` — Album browser design
- `src/db/scanner.mjs` — Current tag extraction (subtitle/TXXX not yet harvested)
- `src/db/sqlite-backend.js` — `getArtistAlbumsMulti` / `getArtistAlbums`
