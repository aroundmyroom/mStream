# Album Library

*Introduced in v6.1.0-velvet*

The Album Library is a dedicated, full-featured view for browsing, navigating, and playing your music collection organised as albums. It replaces the former flat album list with a **DB-driven, performant browser** that automatically groups albums into series, handles multi-disc albums, and resolves cover art from disk or embedded tags.

---

## How it works

### Data source

The Album Library reads entirely from the **SQLite database** — no filesystem walking happens at browse time. All album structure is inferred from the `filepath` column in the `files` table.

Expected filepath layout (relative to the vpath root):

```
Albums/<L1 folder>/<optional L2 folder>/<optional disc folder>/track.flac
```

Examples:

| Path | Interpretation |
|---|---|
| `Albums/The Beatles - Abbey Road (1969)/01 Come Together.flac` | Standalone album |
| `Albums/The Beatles - Abbey Road (1969)/CD 1/01 Come Together.flac` | Multi-disc album (CD 1 is a disc, not a sub-album) |
| `Albums/Mike Platinas Megamixes/Megamix Vol. 1 (2000)/01 Track.flac` | Series — Vol. 1 is a sub-album inside the "Mike Platinas Megamixes" series |

### Album vs Series detection

The system inspects every L1 folder (direct child of `Albums/`):

- **Standalone album** — all files sit directly in the L1 folder, or all L2 sub-folders match the disc pattern (see below).
- **Multi-disc album** — L2 sub-folders all match the disc folder pattern. They become **disc tabs** inside a single album detail view.
- **Series** — L1 folder contains L2 sub-folders that do *not* match the disc pattern. Each L2 folder becomes its own album card grouped under a series banner.

### Disc folder detection

A sub-folder is treated as a *disc* (not a separate album) when its name matches:

```
/^(CD|Disc|DISC)\s*[-–]?\s*\d/   — e.g. "CD 1", "Disc 2", "CD-3"
/^\d{1,2}$/                        — e.g. "1", "2" (bare numeric)
```

The pattern is deliberately strict: "Disconet" does **not** match because the character after "Disc" is `o`, not a space, dash, or digit.

---

## Cover art resolution

For every album the system looks for a cover art image file in this priority order:

1. **Image file in the album folder** — checked top-down:
   ```
   cover.jpg  Cover.jpg  front.jpg  Front.jpg
   Folder.jpg folder.jpg
   cover.png  Cover.png  front.png  Front.png
   cover.webp Cover.webp
   ```
2. **Image file inside the first disc sub-folder** (for multi-disc albums that store art per-disc rather than at the album root).
3. **Embedded art from the DB** (`aaFile` field) — extracted during file scanning and cached in the `image-cache/` directory.

If none of the above are found the album shows a placeholder icon.

### Adding cover art manually

Simply drop one of the supported filenames into the album folder on the filesystem. The cache TTL is **5 minutes**, so the art appears automatically on the next browse without any restart or rescan.

```
/media/music/Albums/My Album (2001)/cover.jpg
```

---

## API

| Endpoint | Description |
|---|---|
| `GET /api/v1/albums/browse` | Returns the full album tree `{ albums, series }` |
| `GET /api/v1/albums/art-file?p=<path>` | Serves an on-disk art file by its relative path |

See [docs/API/albums_browse.md](API/albums_browse.md) for full request/response details.

---

## Frontend views

Three client-side views handle the Album Library:

| Function | Description |
|---|---|
| `viewAlbumLibrary()` | Main grid — series cards and standalone album cards with live search filter |
| `viewAlbumSeries(seriesId)` | Drill-down into a series — shows all sub-album cards |
| `viewAlbumDetail(albumId, activeDiscIdx)` | Album detail — disc tabs, full track list, per-track and batch play/queue controls |

---

## Performance

- **First load** — ~60 ms (DB read + in-memory tree build + parallel art resolution via `Promise.allSettled`)
- **Subsequent loads** — instant (5-minute in-memory cache, no DB or FS access)
- Cache is automatically invalidated when the DB scanner runs a full scan (`invalidateCache()` is called from the scan pipeline).

---

## Folder structure requirements

Enable **Albums Only** on a folder via Admin → Directories. That folder (and all its contents) becomes an album source.

- Any folder type `music` or `audio-books` can be marked `albumsOnly: true`.
- **Multiple** folders can be marked albumsOnly simultaneously — all are merged into one Album Library.
- A folder can be a **root vpath** (its own DB entry) or a **child vpath** (a sub-folder of another vpath). Child vpath files are already stored in the DB under the parent root; they are never indexed separately.
- If no folder has `albumsOnly` set, the system falls back to auto-detecting any root vpath that has an `Albums/` sub-directory on disk (legacy fallback).
- The `albumsOnly` flag change takes effect immediately — no server restart required.
