# Live Scan Progress

mStream shows real-time scan progress in two places while a library scan is running:

1. **Admin Panel** — a detailed card in the Scan Queue & Stats section
2. **Player header** — a compact single-row pill (admin users only)

Both update every 3 seconds and disappear automatically when the scan finishes.

---

## What is shown

| Field | Admin card | Player pill |
|---|---|---|
| Vpath being scanned | ✓ | ✓ |
| Progress bar | ✓ (animated, 6px) | ✓ (compact, 4px) |
| Percentage | ✓ badge | ✓ |
| Files scanned / expected | ✓ | ✓ |
| Estimated time remaining | ✓ | — (shown in admin) |
| Scan rate (files/sec) | ✓ | — |
| Current file path | ✓ (truncated, 60 chars) | tooltip on hover |
| First-scan shimmer | ✓ (no baseline exists) | ✓ |
| Elapsed time | ✓ | — |

---

## First scan vs. subsequent scans

- **Subsequent scans**: the file count from the previous scan is used as a
  baseline (`expected`).  Progress is shown as a percentage fill.
- **First scan** (empty DB / vpath never scanned before): `expected` is `null`.
  An indeterminate shimmer animation plays instead, and the badge says
  `first scan`.  The file counter still increments as files are processed.

---

## How it works — backend

### `src/state/scan-progress.js`
Pure in-memory module, no database.  Resets on server restart.

```
startScan(scanId, vpath, expected)   called when a scan fork is created
tick(scanId, filepath)               called per file in get-file endpoint
finish(scanId)                       called on scan completion/close
getAll()                             returns snapshot array for the API
```

Data stored per scan:
```json
{
  "scanId": "UyU04tkR",
  "vpath": "Music",
  "expected": 137412,
  "scanned": 51203,
  "currentFile": "/media/music/Artist/Album/Track.flac",
  "startedAt": 1740912345000,
  "filesPerSec": 29.6
}
```

### `src/db/task-queue.js`
- Before forking: `db.countFilesByVpath(vpath)` → `startScan(id, vpath, count)`
- On child `close`: `finish(scanId)`

### `src/api/scanner.js`
- `POST /api/v1/scanner/get-file`: `tick(scanId, filepath)` at the top of the handler
- `POST /api/v1/scanner/finish-scan`: `finish(scanId)` before pruning stale files

### `src/api/admin.js`
```
GET /api/v1/admin/db/scan/progress
```
Returns an array (one entry per active scan):
```json
[
  {
    "scanId": "UyU04tkR",
    "vpath": "Music",
    "scanned": 51203,
    "expected": 137412,
    "pct": 37,
    "currentFile": "/media/music/Artist/Album/Track.flac",
    "elapsedSec": 1731,
    "filesPerSec": 29.6,
    "etaSec": 2918
  }
]
```
Returns `[]` when no scan is active.

### Rate calculation
`filesPerSec` is recalculated every **5 seconds** using a sliding window:
```
filesPerSec = (scanned_now - scanned_5s_ago) / 5
```

### ETA calculation
```
etaSec = (expected - scanned) / filesPerSec
```
Only computed when `pct > 0`, `pct < 100`, and `filesPerSec > 0`.

---

## Admin Panel UI

The **Scan Queue & Stats** card (`webapp/admin-v2/`) polls the progress
endpoint every 3 s using a `setInterval` started in `mounted()` and cleared
in `beforeDestroy()`.

Each active scan renders as `.sp-card`:

```
● Music                                    37%   est. 48m 38s   29.6/s
[████████████░░░░░░░░░░░░░░░░░░░░░░░░░░]
51,203 / ~137,412 files                              elapsed: 28m 51s
↳ …/Ben Liebrand Series/VA - Grand 12 Inches/Track.flac
```

CSS classes: `.sp-container`, `.sp-card`, `.sp-header`, `.sp-live-dot`,
`.sp-vpath`, `.sp-pct-badge` / `.sp-firstscan-badge`, `.sp-track`,
`.sp-fill` / `.sp-fill-indeterminate`, `.sp-counts`, `.sp-elapsed`,
`.sp-current-file`, `.sp-filepath`.

---

## Player Header Widget

A compact pill appears in the `content-header` → `header-right` area of
the main player screen, visible only to admin users while a scan is running.

```
● Music  [━━━━━━░░░░░░░░░░]  37%  51,203 / ~137,412
```

- Same height as the Append All / Play All buttons (`padding: 6px 12px`)
- Min-width 200px, max-width 320px
- Full current file path available as a `title` tooltip on hover
- CSS classes: `.spc-wrap`, `.spc-card`, `.spc-dot`, `.spc-vpath`,
  `.spc-track`, `.spc-fill` / `.spc-fill-ind`, `.spc-pct`, `.spc-count`
- Rendered by `_renderScanProgress()` in `webapp/v2/app.js`, driven by the
  existing `pollScan()` function which now queries the progress endpoint
  instead of just `/api/v1/db/status`

---

## Compatibility

`countFilesByVpath(vpath)` is implemented in both `src/db/sqlite-backend.js`
and `src/db/loki-backend.js` and delegated through `src/db/manager.js`.
The feature works identically on both database backends.
