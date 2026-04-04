# YouTube Download API

*Requires the `youtube` permission enabled for the user in Admin → Users.*

---

## GET /api/v1/ytdl/info

Fetch metadata for a YouTube URL without downloading anything.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `url` | string | Full YouTube video URL |

**Response:**

```json
{
  "title": "Song Title",
  "artist": "Artist Name",
  "album": "",
  "year": "2024",
  "thumb": "https://i.ytimg.com/vi/XXXX/maxresdefault.jpg"
}
```

- `album` is always an empty string (YouTube has no album concept — fill it in the UI before downloading)
- `thumb` is the highest-resolution thumbnail URL available, or `null`
- `year` is the 4-digit upload year, or empty string if unavailable
- `artist` is derived from the channel name or parsed from `"Artist - Title"` pattern in the video title

---

## POST /api/v1/ytdl/download

Download a YouTube URL, tag the output file, and save it to the user's configured YouTube / recordings folder.

**Request body:**

```json
{
  "url": "https://www.youtube.com/watch?v=XXXX",
  "format": "opus",
  "title": "Song Title",
  "artist": "Artist Name",
  "album": "Album Name",
  "year": "2024"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | YouTube video URL (http/https only) |
| `format` | `"opus"` \| `"mp3"` | Yes | Output format — defaults to `opus` |
| `title` | string | Yes | Title tag (max 200 chars) |
| `artist` | string | No | Artist tag (max 200 chars) |
| `album` | string | No | Album tag (max 200 chars) |
| `year` | string | No | Year tag (max 4 chars) |

**Response (200 OK):**

```json
{
  "filePath": "Artist - Title.opus",
  "vpath": "youtube"
}
```

`filePath` is the bare filename (not the full path). `vpath` is the folder it was saved into. Use `vpath/filePath` as the filepath reference for the streaming or art endpoints.

**Errors:**

| Status | Meaning |
|---|---|
| 400 | Validation error, invalid URL, or no YouTube/recordings folder configured for this user |
| 403 | User does not have the `youtube` permission |
| 500 | yt-dlp or ffmpeg error — message included in response |

---

## Technical notes

- All intermediate files (raw stream, thumbnail) are written to a private temp directory under the OS temp folder and deleted unconditionally after every download — nothing lands in the music folder until the final file is moved into place.
- Files are saved to the first accessible folder of type `youtube` in the user's vpaths; if none exists, falls back to `type: recordings`. Returns 400 if neither is configured.
- Filenames are sanitised and de-duplicated automatically (`Artist - Title.opus`, or `Artist - Title_1.opus` if a collision exists).
- Album art embedding per format: MP3 uses ID3v2 attached picture; Opus/OGG uses Vorbis `METADATA_BLOCK_PICTURE` (binary spec, base64-encoded) — see [youtube-download.md](../youtube-download.md) for details.
- Both yt-dlp and ffmpeg are managed automatically by mStream Velvet — no manual installation required.
