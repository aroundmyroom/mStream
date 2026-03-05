# Library Scanning

mStream scans your music folders to build the database that powers search, browsing, Recently Added, and all playback features.

---

## Virtual Paths (vpaths)

Every music folder in mStream is identified by a short **vpath key** (e.g. `Music`, `Blues`, `Audiobooks`).  
This key is used in every API call, in streaming URLs, and in the per-user access control list.

```json
"folders": {
  "Music":      { "root": "/media/music" },
  "Audiobooks": { "root": "/media/audiobooks" }
}
```

A user's `vpaths` array lists which keys they can access.

---

## How scanning works

### Scan process overview

1. A scan task is queued for a vpath (either on boot, on a timer, or triggered manually from the Admin panel).
2. mStream forks a separate Node.js process (`src/db/scanner.mjs`) for each active scan to keep the main server responsive.
3. The scanner walks the folder tree recursively, calling back into the server API for each file it finds.
4. When a file is **new** (not in the DB for this vpath), it is fully parsed (tags, ReplayGain, album art) and inserted.
5. When a file is **already known** (same relative path + vpath + mtime), it is skipped.  Only missing art or missing cue-points are filled in.
6. After the walk, any file in the DB that was not touched by the current scan is removed (stale file cleanup).

### Nested vpaths — no duplicate scanning

If you have a vpath whose root folder sits **inside** another vpath's root, the child is a **nested vpath**.

Example:
```
Music      → /media/music          (parent)
DisconetV8 → /media/music/Disconet/Volume8   (child — nested inside Music)
```

The scanner handles this correctly in two ways:

**`scanAll()` — automatic de-duplication**  
When a full rescan is triggered (on boot or via Admin → Scan All), only the **parent** vpath is queued.  
Child vpaths are detected via the `childVpaths()` function in `src/db/task-queue.js` and skipped.  
The parent scan walks through the child folder anyway and registers those files under the child's vpath automatically via `otherRoots` filtering.

**`otherRoots` filter — per-file deduplication during walk**  
Every scan process receives an `otherRoots` list: the root paths of all *other* vpaths that are not children of the current scan.  
When the recursive walker encounters a directory that matches an `otherRoots` entry, it skips into it — preventing the same physical files from being inserted twice.

**What happens when you add a new nested vpath via Admin**  
Adding a vpath via the Admin panel triggers `scanVPath(newVpath)` directly, which scans only the new folder.  
Files that physically exist inside the parent vpath are already in the DB with their original insertion timestamp, so:
- The new vpath's rows inherit the existing `ts` (insertion timestamp) from the parent — they will **not** flood "Recently Added".
- This ts-inheritance happens automatically in `insertFile()` in both the SQLite and LokiDB backends.

---

## "Recently Added" explained

The **Recently Added** list is ordered by `ts` — the Unix timestamp of when a file was **first inserted into the database**, not the file's creation or modification date on disk.

This means:
- Files that are genuinely new to the library (never scanned before) appear at the top.
- Files added via a new vpath that points at folders already covered by an existing vpath inherit the original `ts` and do **not** appear in Recently Added.

If you add a brand-new vpath pointing at a folder that has never been scanned, all files in that folder will get today's `ts` and will appear in Recently Added — because they are genuinely new to the library.

---

## Scan triggers

| Trigger | How |
|---------|-----|
| Server boot | Automatic, after the `bootScanDelay` (default 3 seconds) |
| Scan interval | Automatic, every `scanInterval` hours (default 24) — set to 0 to disable |
| Admin: Scan All | Admin panel → DB → Scan All button |
| Admin: Add folder | Adding a new vpath automatically queues a scan for it |
| API | `POST /api/v1/admin/db/scan/all` |

---

## Scan settings (Admin → DB)

| Setting | Default | Description |
|---------|---------|-------------|
| Scan interval | 24 h | How often automatic rescans run (0 = disabled) |
| Boot scan delay | 3 s | Delay before the first scan after server start |
| Max concurrent scans | 1 | How many vpaths scan in parallel |
| Skip images | false | Skip album art extraction (faster scan on slow disks) |
| Compress images | true | Downsample album art to save disk space |
| Pause between files | 0 ms | Throttle the scanner to reduce disk I/O pressure |

---

## Scan progress

Scan progress is shown in two places while a scan is running:

- **Admin panel** (Admin → Scan Queue & Stats) — detailed card with progress bar, file count, scan rate, estimated time remaining, and current file path.
- **Player header** — compact pill visible to admin users only (percentage + file count, updates every 3 seconds).

See [scan-progress.md](scan-progress.md) for full details.

---

## Scan errors

Files that fail to parse are logged to the `scan_errors` table.  
They can be reviewed in the Admin panel under **Scan Errors**.  
The same recurring error on the same file increments a counter rather than creating duplicate rows.  
Errors older than the configured retention window (default 48 hours) are pruned automatically.

See [scan-error-audit.md](scan-error-audit.md) for full details.

---

## Database engines

mStream supports two database backends:

| Engine | File | Notes |
|--------|------|-------|
| `sqlite` | `save/db/mstream.sqlite` | **Recommended.** Fast, persistent, WAL mode for concurrent reads |
| `loki` | `save/db/files.loki-v3.db` | In-memory LokiJS, saved periodically — legacy option |

The engine can be changed in Admin → DB.  A rescan is required after switching engines.
