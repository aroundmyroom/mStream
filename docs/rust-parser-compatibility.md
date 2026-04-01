# Rust Parser — Compatibility Analysis

Upstream commit: `98619f4` ("Experimental rust parser") + `132f168` (rustls fix) + `77da085` (pre-built binaries)  
Analysed against: mStream-velvet fork  
Date: 2026-04-01

---

## What the Rust parser is

A standalone native binary (`bin/rust-parser/rust-parser-{platform}-{arch}`) spawned by Node as a child process.  
It receives the same JSON config as `scanner.mjs` and calls the same internal API endpoints to insert files.  
It uses [lofty](https://github.com/Serial-ATA/lofty-rs) for metadata, tokio for async concurrency, and reqwest (rustls) for HTTP.

It is **opt-in** (`scanOptions.rustParser: false` default) and **disabled by default** in upstream too.

Pre-built binaries are provided for all platforms including `linux-arm64` (our Docker target).

---

## Why it is faster

Our JS scanner is sequential — one file at a time in the Node.js event loop with no true parallelism.  
The Rust parser uses `tokio` async tasks with `logical_cpus × 2` concurrency, full multi-threading, no GC pauses, and direct syscalls for file I/O.  
For libraries of 10 000+ files expected improvement: **5–15× faster initial scans** on any multi-core machine.

---

## Missing fields

Fields our `scanner.mjs` sends to `add-file` that the Rust parser does **not** emit:

| Field | Our scanner | Rust parser | Impact if missing |
|---|---|---|---|
| `duration` | ✅ float (seconds) from `music-metadata` format block | ❌ absent | Smart playlists, playback duration display, queue total time — all broken |
| `cuepoints` | ✅ JSON string from embedded cue sheet or sidecar `.cue` | ❌ absent | FLAC/WAV album rips lose all chapter markers silently |
| `artist_id` | ✅ MD5 of normalised artist name | ❌ absent | Subsonic API (`getSong`, `getArtist`, `getAlbum`) returns broken IDs |
| `album_id` | ✅ MD5 of normalised artist + album | ❌ absent | Same Subsonic breakage |
| `art_source` | ✅ `"embedded"` or `"directory"` | ❌ absent | Discogs-assigned art orphaned on rescan; user loses manually picked art |
| `trackOf` | ✅ track total (e.g. `12` in "5/12") | ❌ absent | Track total not stored; minor metadata loss |

---

## Missing behavioural features

Features present in our `scanner.mjs` that are entirely absent from the Rust parser:

### 1. `otherRoots` guard
Our scanner skips subdirectories that are registered as their own vpath.  
The Rust parser has no such concept — it would walk into those subdirectories and double-index every file under a child vpath.  
The `ScanConfig` struct does not include an `otherRoots` field.

### 2. Targeted `_needs*` update loop
When a file already exists in the DB but is flagged as incomplete, our scanner runs targeted repair passes:

- `_needsArt` → re-parse embedded art and call `update-art`
- `_needsCue` → re-parse cue sheet (embedded + sidecar fallback) and call `update-cue`
- `_needsDuration` → re-parse duration and call `update-duration`

The Rust parser has none of this. Files flagged as needing repair are simply skipped (`return` early), so the DB stays permanently incomplete for those files.

### 3. Scan error reporting (`report-error` / `confirm-ok`)
Our scanner calls:
- `POST /api/v1/scanner/report-error` — persists per-file scan errors to the DB for the admin error-audit panel
- `POST /api/v1/scanner/confirm-ok` — clears errors on files that parsed successfully this run

The Rust parser writes all warnings to `stderr` only. No persistent error tracking. The admin scan-error audit panel would remain empty regardless of actual parse failures.

### 4. Pre-scan error prune (`prune-errors`)
Our scanner calls `POST /api/v1/scanner/prune-errors` before walking the directory, respecting the configured retention window.  
The Rust parser never calls this endpoint — stale error entries accumulate indefinitely.

### 5. `scanStartTs` in `finish-scan`
Our `finish-scan` payload includes `scanStartTs` (unix timestamp when the scan began).  
The server uses this in `clearResolvedErrors()` to remove error entries for files that were not re-encountered this scan (i.e. they are now resolved).  
The Rust parser sends only `{ vpath, scanId }` — `clearResolvedErrors()` is never triggered; old errors are never cleared.

### 6. Sidecar `.cue` file support
Our scanner has a `parseSidecarCue()` function that finds a `.cue` file alongside an audio file (same basename, or sole `.cue` in the directory) and extracts chapter points from it.  
The Rust parser only handles embedded cue sheets inside the audio container. External `.cue` files are ignored.

---

## Summary

The Rust parser is architecturally sound and the speed improvement would be real. However it was designed against upstream's simpler schema. Our fork has diverged significantly:

- **4 missing DB columns** (`duration`, `cuepoints`, `artist_id`, `album_id`)
- **1 missing metadata field** (`art_source`) that protects user-assigned art
- **3 missing API endpoints** used for error auditing
- **2 missing scan-correctness behaviours** (`otherRoots` guard, `_needs*` repair loop)

Adopting it as-is would **silently corrupt the database** on the next scan:  
duration gone, cue sheets gone, Subsonic IDs broken, Discogs art orphaned, child vpaths double-indexed.

### Adoption path (if ever pursued)
To make the Rust parser safe for this fork, `main.rs` would need:

1. Add `duration` extraction via lofty's `AudioFile` trait (`file.properties().duration()`)
2. Add `cuepoints` extraction via lofty's `CueSheet` tag item
3. Add `otherRoots: Vec<String>` to `ScanConfig` and skip those directories during the walk
4. Add MD5 `artist_id` / `album_id` generation (same algorithm as `sqlite-backend.js`)
5. Add `art_source` field (`"embedded"` / `"directory"`) to `FileEntry`
6. Add `trackOf` field to `FileEntry`
7. Implement the `_needs*` repair loop (requires `get-file` to return those flags — already does)
8. Implement `report-error`, `confirm-ok`, `prune-errors` HTTP calls
9. Add `scanStartTs` to the `finish-scan` payload
10. Add sidecar `.cue` file parser
11. Rebuild all 6 platform binaries and commit them

Until upstream closes these gaps or we implement them ourselves, the JS scanner (`src/db/scanner.mjs`) remains the only correct option for this fork.
