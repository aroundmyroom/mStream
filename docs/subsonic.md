# mStream Subsonic API

mStream implements the **Subsonic REST API 1.16.1** plus the **Open Subsonic** extensions, making it compatible with the large ecosystem of Subsonic-compatible clients.

### Tested clients (confirmed working)

| Client | Platform | Notes |
|---|---|---|
| **Symfonium** | Android | Full library sync verified (v6.10.0+) |
| **DSub** | Android | ✅ |
| **Substreamer** | iOS | ✅ |
| **Ultrasonic** | Android | ✅ |
| **Feishin** | Desktop | ✅ |
| Clementine / Strawberry | Desktop | ✅ |
| Nautiline | iOS | ✅ |
| Any Subsonic 1.16.1 client | — | Should work |

---

## Base URL

```
https://<your-server>:<port>/rest/
```

All endpoints are available both with and without the `.view` extension, e.g.:

```
/rest/ping
/rest/ping.view     ← same thing
```

---

## Authentication

Subsonic uses a **separate password** from your mStream login. This is necessary because mStream stores passwords as PBKDF2-SHA512 hashes, which are incompatible with Subsonic's MD5 token scheme.

### Setting your Subsonic password

**As admin (for any user):**
- Admin UI → Users → Password button → "New Subsonic Password" field

**As a regular user:**
- Player → "Subsonic API" nav item → enter new password → Save

### MD5 token auth (recommended)

```
?u=<username>&t=<MD5(password+salt)>&s=<salt>&v=1.16.1&c=<client-name>
```

Example (salt = `abc123`, password = `sesame`):
```
t = MD5("sesameabc123")
```

### Plaintext auth

```
?u=<username>&p=<password>&v=1.16.1&c=<client-name>
```

Hex-encoded plaintext is also accepted:
```
?p=enc:<hex-encoded-password>
```

---

## Response Formats

Append `&f=json` for JSON (default: XML):

```
?f=json    → JSON
?f=xml     → XML  (default)
?f=jsonp&callback=myFn  → JSONP
```

---

## Open Subsonic

Every response includes:

```json
{
  "openSubsonic": true,
  "type": "mstream",
  "serverVersion": "5.16.18-velvet"
}
```

Supported extensions returned by `getOpenSubsonicExtensions`:
- `replayGain` — `replayGain` object with `trackGain` on song objects
- `formPost` — auth parameters may be sent via HTTP POST body

---

## Implemented Endpoints

### System
| Endpoint | Status | Notes |
|---|---|---|
| `ping` | ✅ | Always returns `status: ok` |
| `getLicense` | ✅ | Returns `valid: true`, expires 2099 |
| `getScanStatus` | ✅ | Returns `scanning` bool and `count` |
| `getOpenSubsonicExtensions` | ✅ | Lists `replayGain` and `formPost` |

### Library — Folder browsing
| Endpoint | Status | Notes |
|---|---|---|
| `getMusicFolders` | ✅ | Returns all vpaths the user can access; ID = 1-based index |
| `getIndexes` | ✅ | No `musicFolderId` → lists vpaths A-Z; with `musicFolderId` → lists first-level FS directories of that vpath A-Z |
| `getMusicDirectory` | ✅ | Integer id → vpath root; `d:…` id → sub-directory; album_id string → album fallback for legacy clients |

### Library — ID3/tag browsing
| Endpoint | Status | Notes |
|---|---|---|
| `getArtists` | ✅ | Alphabetical artist index grouped by letter |
| `getArtist` | ✅ | Artist + album list |
| `getAlbum` | ✅ | Album + song list |
| `getSong` | ✅ | Single song by hash ID |

### Search
| Endpoint | Status | Notes |
|---|---|---|
| `search2` | ✅ | Folder-based; returns artists, albums, songs |
| `search3` | ✅ | ID3-based (same data, different wrapper) |

### Album lists
| Endpoint | Status | Notes |
|---|---|---|
| `getAlbumList` | ✅ | `newest`, `recent`, `random`, `alphabeticalByName`, `alphabeticalByArtist`, `byGenre`, `byYear`, `starred` |
| `getAlbumList2` | ✅ | Same sort modes, ID3 mode |
| `getRandomSongs` | ✅ | Optional genre/year/folder/size filter |
| `getSongsByGenre` | ✅ | Filtered by exact genre string |
| `getGenres` | ✅ | All genres with song and album counts |
| `getNowPlaying` | ✅ | Always empty (no server-side playback tracking) |

### Starred
| Endpoint | Status | Notes |
|---|---|---|
| `getStarred` | ✅ | Folder-based starred songs and albums |
| `getStarred2` | ✅ | ID3-based starred items |
| `star` | ✅ | Stars a song, album, or artist by ID |
| `unstar` | ✅ | Removes star |

### Playback
| Endpoint | Status | Notes |
|---|---|---|
| `stream` | ✅ | Serves original file directly via `res.sendFile` — no JWT redirect, no transcoding |
| `download` | ✅ | Same as stream |
| `getCoverArt` | ✅ | Serves from albumArtDirectory; resolves folder IDs (`d:…`, vpath integers) to real art via `getAaFileForDir`; bare album/artist/song hashes via `getAaFileById`; SVG folder icon fallback |
| `getLyrics` | ✅ | Returns lyrics from file tags if present |
| `scrobble` | ✅ | Updates `playCount` and `lastPlayed` in user_metadata |
| `setRating` | ✅ | Stores 1–5 rating in user_metadata |

### Playlists
| Endpoint | Status | Notes |
|---|---|---|
| `getPlaylists` | ✅ | All playlists visible to the current user |
| `getPlaylist` | ✅ | Full playlist with song list |
| `createPlaylist` | ✅ | Create new or replace existing |
| `updatePlaylist` | ✅ | Rename, append songs, remove by index |
| `deletePlaylist` | ✅ | Delete by ID |

### Bookmarks
| Endpoint | Status | Notes |
|---|---|---|
| `getBookmarks` | ✅ | All bookmarks for the user |
| `saveBookmark` | ✅ | Upsert bookmark at position (ms) |
| `deleteBookmark` | ✅ | Delete bookmark for a song ID |

### Artist/Album info
| Endpoint | Status | Notes |
|---|---|---|
| `getArtistInfo` | ⚠️ | Returns empty biography/URLs; `similarArtist` list is empty |
| `getArtistInfo2` | ⚠️ | Same |
| `getAlbumInfo` | ⚠️ | Returns empty notes/URL |
| `getAlbumInfo2` | ⚠️ | Same |
| `getSimilarSongs` | ⚠️ | Returns empty list |
| `getSimilarSongs2` | ⚠️ | Returns empty list |
| `getTopSongs` | ⚠️ | Returns empty list |

### Users (admin only)
| Endpoint | Status | Notes |
|---|---|---|
| `getUser` | ✅ | Non-admin can only see own record |
| `getUsers` | ✅ | Admin only |
| `createUser` | ✅ | Creates user + subsonic-password |
| `updateUser` | ✅ | Update password or admin flag |
| `deleteUser` | ✅ | Deletes user |
| `changePassword` | ✅ | Admin can change any user; user can change own |

### Stubs (return empty/ok)
| Endpoint | Notes |
|---|---|
| `getPodcasts`, `getNewestPodcasts` | Returns empty list |
| `getInternetRadioStations` | Returns empty list |
| `createInternetRadioStation`, `updateInternetRadioStation`, `deleteInternetRadioStation` | Returns ok |

---

## Directory / Folder Navigation

### How IDs work

| ID format | Meaning |
|---|---|
| `"1"`, `"2"`, … `"N"` | Vpath root — index into `getMusicFolders` list |
| `"d:<base64url>"` | Encoded sub-directory: `{v: "<vpath>", p: "<relPath>"}` |
| `"<16-char hex>"` | album_id or artist_id (MD5 slug) |
| `"<64-char hex>"` | song hash (SHA256) |
| `"<filename>.jpg"` etc. | Direct album art filename in albumArtDirectory |

### Folder art logic

`getCoverArt` for a folder ID:
1. Decode the `d:…` ID or resolve vpath integer → `(dbVpath, dirRelPath)`
2. `getAaFileForDir(vpath, relPath)` — returns `MAX(aaFile)` from any file under that directory (cached in memory)
3. If an art file is found on disk → serve it with `Cache-Control: public, max-age=86400`
4. Otherwise → serve inline SVG folder icon

### `getIndexes` behaviour

| Request | Response |
|---|---|
| `GET getIndexes` (no musicFolderId) | Returns vpaths as artist entries, A-Z grouped |
| `GET getIndexes?musicFolderId=2` | Returns first-level subdirs of vpath 2, A-Z grouped |

Clients then navigate deeper using `getMusicDirectory?id=<dirId>`.

---

## Song Object Fields

| Field | Value |
|---|---|
| `id` | SHA256 hash of the filepath |
| `title`, `artist`, `album` | From file tags |
| `track`, `discNumber`, `year`, `genre` | From file tags |
| `duration` | Seconds (integer) |
| `suffix`, `contentType` | e.g. `mp3`, `audio/mpeg` |
| `coverArt` | `aaFile` filename if present |
| `parent` | `album_id` |
| `artistId`, `albumId` | 16-char hex MD5 slugs |
| `starred` | ISO date string if starred, omitted otherwise |
| `userRating` | 1–5 or omitted |
| `playCount`, `played` | From user_metadata |
| `replayGain.trackGain` | dB value from file tags (Open Subsonic) |
| `mediaType` | Always `"song"` |
| `isDir` | Always `false` |
| `isVideo` | Always `false` |
| `path` | `<vpath>/<filepath>` |
| `type` | Always `"music"` |

---

## Client Setup

1. **Server URL**: `https://your-server:3000`
2. **Username**: your mStream username
3. **Password**: your **Subsonic password** (set separately via Admin UI or the Subsonic API nav page)
4. **Use HTTPS**: yes
5. **API version**: leave at default (1.16.1 or auto-detect)

---

## Known Limitations

| Area | Status |
|---|---|
| Transcoding | Not supported — `stream` always serves the original file; `maxBitRate` and `format` params are ignored |
| `getCoverArt` `size` param | Accepted but not used — full-size image always returned |
| `ifModifiedSince` on `getIndexes` | Accepted but ignored — always returns full response |
| Artist/album metadata (bio, similar) | External lookups (Last.fm, MusicBrainz) not wired up |
| `enc:` hex-encoded password | Accepted as auth but not extensively tested |


---

## Base URL

```
https://<your-server>:<port>/rest/
```

All endpoints are available both with and without the `.view` extension, e.g.:

```
/rest/ping
/rest/ping.view     ← same thing
```

---

## Authentication

Subsonic uses a **separate password** from your mStream login. This is necessary because mStream stores passwords as PBKDF2-SHA512 hashes, which are incompatible with Subsonic's MD5 token scheme.

### Setting your Subsonic password

**As admin (for any user):**
- Admin UI → Users → Password button → "New Subsonic Password" field

**As a regular user:**
- Player → "Subsonic API" nav item → enter new password → Save

### MD5 token auth (recommended)

```
?u=<username>&t=<MD5(password+salt)>&s=<salt>&v=1.16.1&c=<client-name>
```

Example (salt = `abc123`, password = `sesame`):
```
t = MD5("sesameabc123")
```

### Plaintext auth

```
?u=<username>&p=<password>&v=1.16.1&c=<client-name>
```

Hex-encoded plaintext is also accepted:
```
?p=enc:<hex-encoded-password>
```

---

## Response Formats

Append `&f=json` for JSON (default: XML):

```
?f=json    → JSON
?f=xml     → XML  (default)
?f=jsonp&callback=myFn  → JSONP
```

---

## Open Subsonic

Every response includes:

```json
{
  "openSubsonic": true,
  "type": "mstream",
  "serverVersion": "5.16.17-velvet"
}
```

Supported extensions returned by `getOpenSubsonicExtensions`:
- `replayGain` — `replayGainStatus`, `trackReplayGain`, `albumReplayGain` on song objects
- `songLyrics` — `getLyrics` (plain text from tags)

---

## Implemented Endpoints

### System
| Endpoint | Notes |
|---|---|
| `ping` | Always returns `status: ok` |
| `getLicense` | Returns `valid: true`, no expiry |
| `getScanStatus` | Returns scanning status and file count |
| `getOpenSubsonicExtensions` | Lists supported Open Subsonic extensions |

### Library browsing
| Endpoint | Notes |
|---|---|
| `getMusicFolders` | Returns vpaths the authenticated user can access |
| `getIndexes` | Alphabetical artist index, optionally filtered by musicFolderId |
| `getArtists` | Same as getIndexes but in ID3/album-artist mode |
| `getArtist` | Artist detail with album list |
| `getAlbum` | Album detail with song list |
| `getSong` | Single song by ID |
| `getMusicDirectory` | Browse by filesystem directory |

### Search
| Endpoint | Notes |
|---|---|
| `search2` | Folder-based search; returns artists, albums, songs |
| `search3` | ID3-based search (same data, different response wrapper) |

### Album lists
| Endpoint | Notes |
|---|---|
| `getAlbumList` | Folder-based list: `newest`, `alphabeticalByName`, `byGenre`, `byYear`, `random` |
| `getAlbumList2` | ID3-based list (same sort modes) |
| `getRandomSongs` | Random songs with optional genre/year/folder filter |
| `getSongsByGenre` | Songs filtered by genre string |
| `getGenres` | All genres with song and album counts |
| `getNowPlaying` | Returns entries for any tracks currently being scrobbled (always empty at rest) |

### Starred
| Endpoint | Notes |
|---|---|
| `getStarred` | Folder-based starred songs and albums |
| `getStarred2` | ID3-based starred items |
| `star` | Star a song, album, or artist by ID |
| `unstar` | Remove star |

### Playback
| Endpoint | Notes |
|---|---|
| `stream` | Redirects to `/media/<vpath>/<filepath>` (no transcoding) |
| `download` | Same as stream |
| `getCoverArt` | Redirects to `/album-art/<id>` |
| `getLyrics` | Returns lyrics from file tags (title/artist search ignored) |
| `scrobble` | Updates `lastPlayed` and `playCount` in user_metadata |
| `setRating` | Sets user rating (1–5 stars) |

### Playlists
| Endpoint | Notes |
|---|---|
| `getPlaylists` | All playlists visible to the user |
| `getPlaylist` | Playlist detail with full song list |
| `createPlaylist` | Create or replace a playlist |
| `updatePlaylist` | Rename, add songs, remove song indices |
| `deletePlaylist` | Delete by ID |

### Bookmarks
| Endpoint | Notes |
|---|---|
| `getBookmarks` | All bookmarks for the user |
| `saveBookmark` | Create/update bookmark at position (ms) |
| `deleteBookmark` | Delete bookmark for a song |

### Users (admin only)
| Endpoint | Notes |
|---|---|
| `getUser` | User detail (non-admin can only see self) |
| `getUsers` | All users (admin only) |
| `createUser` | Create new user with Subsonic password |
| `updateUser` | Update password or admin flag |
| `deleteUser` | Delete user |
| `changePassword` | Admin can change any user; user can change own |

### Not implemented (stub 200)
- `getPodcasts`, `getNewestPodcasts` — returns empty list
- `getInternetRadioStations` — returns empty list

---

## Song Object Fields

Subsonic song objects returned by mStream include:

| Field | Notes |
|---|---|
| `id` | SHA256 hash of the filepath |
| `title` | Always present |
| `artist`, `album` | From file tags; **omitted** (not null) when blank |
| `track`, `disc`, `year`, `genre` | From file tags; **omitted** when not set |
| `duration` | Seconds (integer); omitted when unknown |
| `bitRate` | kbps |
| `suffix`, `contentType` | e.g. `mp3`, `audio/mpeg` |
| `coverArt` | Album art cache filename; **omitted** when no art |
| `artistId`, `albumId` | Pre-computed 16-char hex MD5 slugs; omitted when blank |
| `starred` | ISO date string if starred, omitted otherwise |
| `userRating` | 1–5 or omitted |
| `playCount`, `lastPlayed` | From user_metadata |
| `replayGain` | Open Subsonic extension (`trackGain` field) |
| `mediaType` | Always `"song"` |
| `isDir` | Always `false` |
| `isVideo` | Always `false` |

> **Note:** Optional fields are **omitted entirely** when their value is null or blank. They are never sent as `null`. This is correct per the OpenSubsonic spec and required for compatibility with strict JSON parsers (e.g. Symfonium's Moshi `@NonNull` annotations).

---

## Client Setup

All clients follow the same pattern:

1. **Server URL:** `https://your-server:3000`
2. **Username:** your mStream username (or `mstream-user` in no-auth mode)
3. **Password:** your **Subsonic password** (set separately — see Authentication above)
4. **Use HTTPS:** yes
5. **API version:** leave at default (1.16.1 or auto)

### Symfonium-specific notes

Symfonium requires a **Force Full Resync** after first setup to import the full library. Go to: Library → your mStream server → ⋮ menu → Force Full Resync.

---

## Notes

- **No transcoding:** `stream` always serves the original file. Clients requesting a lower bitRate will still get the original.
- **Cover art:** Pulled from mStream's existing album art cache. The `size` parameter in `getCoverArt` is accepted but ignored.
- **Optional fields:** All optional fields are omitted entirely when null (never sent as `null`). Required by strict clients like Symfonium.
- **Starred timestamps:** When starring, mStream records the current UTC time as ISO-8601 string.
- **Playlist IDs:** mStream playlist IDs are the playlist filename (without `.json`). Subsonic client playlist IDs are the same string.
- **Artist/Album IDs:** Stable MD5 slugs derived from artist name (and album title for albums). These do not change when tags are edited via mStream's tag editor.
- **Empty library enumeration:** When `query` is empty, mStream returns the full library paginated — this is the mechanism Symfonium and DSub use for initial sync.
