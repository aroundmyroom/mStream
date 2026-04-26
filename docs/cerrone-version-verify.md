# Album Version Tags — Cerrone Verification Guide

## What to expect before a rescan

The album version system is now **installed but not yet populated**. All existing files have `album_version = NULL` because they were scanned before this feature was added. Version badges will appear **only after you rescan the affected vpaths**.

---

## Step 1 — Trigger a rescan (small test first)

In the mStream Velvet **Admin** panel → **Database** tab → click **Start Scan** (or select a specific vpath if you want to test a subset first). The scanner will now run `deriveAlbumVersion()` for every file.

---

## Step 2 — What the scanner will pick up for Cerrone

Cerrone's library has 174 albums. After a full rescan you should see version badges on albums that have any of:

### Case A — Exact tag in file (most reliable)
If any Cerrone file has a `TIT3` (subtitle), `SUBTITLE`, `DISCSUBTITLE`, or any configured `TXXX:EDITION`/`TXXX:VERSION` etc. tag, that value becomes the `album_version`. Source will be recorded as e.g. `TIT3` or `TXXX:EDITION`.

### Case B — Heuristic on album title
If the album name contains recognisable edition/quality keywords, the heuristic fires:

| Album name pattern | Detected version |
|---|---|
| `Cerrone VI [Remaster 2003]` | `Remaster 2003` |
| `Cerrone - Supernature (Deluxe Edition)` | `Deluxe Edition` |
| `Cerrone Heritage (Expanded)` | `Expanded Edition` |
| `Cerrone Live 24bit/96kHz` | `24bit/96kHz` |
| `The Box [Hi-Res]` | `Hi-Res` |

Source: `heuristic:title`

### Case C — Heuristic on folder name
If the file's parent folder contains an edition keyword (e.g. you have `Music/Cerrone/Love in C Minor [Remaster]/01.flac`), the folder name triggers the heuristic even if the album tag itself has no brackets.

Source: `heuristic:folder`

### Case D — Inferred from audio quality
If a file is 24-bit or higher at ≥ 88.2 kHz (Hi-Res), and no tag or heuristic matched, it gets an automatic badge: e.g. `Hi-Res 24bit/96kHz`.

Source: `inferred:audio`

---

## Step 3 — Where to see the badges in the UI

### 3a. Search — Albums tab
1. Open the search bar
2. Type `cerrone`
3. Click the **Albums** tab
4. Albums with a detected version will show a small pill badge (grey) after the album name

### 3b. Artist Profile — Albums grid
1. Search for `cerrone`
2. Click on **Cerrone** in the Artists section
3. Scroll to the Albums section at the bottom of the profile
4. Albums with version data show a badge under the year
5. Albums with the **same title but different versions** (e.g. original + remaster) will be grouped with a subtle outline highlight

### 3c. Albums Library (Browse)
1. Navigate to **Albums** in the left sidebar
2. Filter by typing `cerrone` in the filter box
3. Albums with a version show a badge under the year on each card

### 3d. Album Songs view
1. Click any Cerrone album card
2. If that album has an `album_version`, a grey badge appears at the top of the track list (above the first track)

---

## Step 4 — Check the Admin inventory

In **Admin** → **Database** → scroll to the **Album Version Tag Fields** card → click **Show Version Source Breakdown**.

This shows a table like:

| Source | Files |
|---|---|
| `TIT3` | 2847 |
| `heuristic:title` | 1203 |
| `TXXX:EDITION` | 891 |
| `heuristic:folder` | 445 |
| `inferred:audio` | 312 |

This tells you which detection method is producing data and how many files each method covers across your entire library.

---

## Step 5 — Verify via API (optional, technical)

```bash
# Replace YOUR_TOKEN with a JWT from: node /tmp/make-token.cjs
curl -sk -X POST https://music.aroundtheworld.net:3000/api/v1/db/search \
  -H "Content-Type: application/json" \
  -H "x-access-token: YOUR_TOKEN" \
  -d '{"search":"cerrone"}' | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const withVer=d.albums.filter(a=>a.album_version);
console.log('Albums with version:',withVer.length,'/',d.albums.length);
withVer.slice(0,10).forEach(a=>console.log(' ',a.name,'→',a.album_version));
"
```

After a rescan you should see at least some of the 174 Cerrone albums showing a `album_version` value if their files or folder names contain edition/quality keywords.

---

## Notes

- **No rescan = no data**. The columns are there and the DB is ready, but version values are only populated during file scanning. They will NOT appear on existing rows until a rescan runs.
- **Partial rescan**: You can trigger a scan on just the `Music` vpath to test without waiting for other vpaths.
- **Re-scan is incremental**: Only changed/new files are scanned if `hasBaseline = true`. To force all files to be re-evaluated for version tags, you would need a full forced rescan or wait for the next scheduled scan to pick up files with changed mtimes.
- **First full scan fills it in**: On the next cold rescan (or when you add new files), every file processed by the scanner will get its `album_version` evaluated.
