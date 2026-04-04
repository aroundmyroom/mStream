# Server Audio

**Server Audio** lets mStream play music directly through the server's speakers. Your browser becomes a remote control — no app installation required on any device.

---

## How it works

1. mStream spawns **mpv** in idle mode on server startup (or on-demand).
2. mpv listens for commands via a local Unix socket (JSON IPC protocol).
3. Any browser that can reach the server opens `/server-remote` to control playback.
4. The remote page polls the server every 2 seconds for playback state.

```
Browser ──(HTTPS)──▶ mStream API ──(Unix socket)──▶ mpv ──▶ server speakers
```

---

## Requirements

**mpv** must be installed on the server machine. mStream does **not** bundle mpv (unlike ffmpeg).

### Install mpv

**Linux (Debian / Ubuntu)**
```bash
sudo apt install mpv
```

**Linux (Fedora / RHEL)**
```bash
sudo dnf install mpv
```

**Linux (Arch)**
```bash
sudo pacman -S mpv
```

**macOS (Homebrew)**
```bash
brew install mpv
```

**Verify the install:**
```bash
mpv --version
# Expected: mpv 0.38.0 (or any v0.32+)
```

---

## Enable in the Admin Panel

1. Go to **Admin → Server Audio** in the left sidebar.
2. Click **Enable** — mStream will (optionally) auto-start mpv at boot.
3. If mpv is not on your system PATH, click **edit** next to *mpv Binary Path* and enter the absolute path (e.g. `/usr/local/bin/mpv`).
4. Click **Detect mpv** to verify the binary is reachable and see its version.
5. The status row shows whether mpv is currently **Running** or not.

### Manual start / stop

You can start or stop the mpv process independently of the *Enabled* toggle:

| Button | Effect |
|--------|--------|
| **Start** | Launches mpv now (does not change the *Enabled* setting) |
| **Stop**  | Kills mpv now (does not change the *Enabled* setting) |

Enabled + Start on boot (default when enabled via the toggle) means mpv restarts automatically when the mStream server restarts.

---

## The Server Remote page

Open `/server-remote` in any browser (phone, tablet, desktop). 

### Login

- If your mStream instance has users configured, enter your credentials.
- If no users are configured (open/single-user install), the page authenticates automatically.

### Now Playing bar

Shows the current track's art, title, artist, and a progress bar you can tap/click to seek.

### Controls

| Control | Action |
|---------|--------|
| ◀◀ / ▶▶ | Previous / Next track |
| ▶ / ❚❚ | Play / Pause |
| Repeat | Cycles: **Off → One → All → Off** |
| Volume slider | 0–130 (mpv supports up to 130% software boost) |

### Tabs

#### Queue

Lists all songs in the current playback queue. Tap a song to jump to it; tap × to remove it. The currently playing song is highlighted.

#### Auto-DJ

Automatically queues new songs so the music never stops.

| Setting | Description |
|---------|-------------|
| **Enabled toggle** | Turns Auto-DJ on/off |
| **Random** | Picks a random song from your library, avoiding recently played tracks |
| **Similar Artists** | Uses the Last.fm similar-artists API to find musically related songs (requires Last.fm API key configured in Admin → Last.fm) |

Auto-DJ fires when there are fewer than 2 songs ahead of the current position, or when the current track is within 25 seconds of ending.

#### Browse

File browser for your vpaths. Navigate into folders and tap **+ Queue** to add a song to the server playback queue.

---

## Configuration reference

These keys are stored in `save/db/default.json` under `serverAudio`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Whether mpv is started on server boot |
| `mpvBin` | string | `"mpv"` | Path to the mpv binary |

Example `default.json` fragment:
```json
{
  "serverAudio": {
    "enabled": true,
    "mpvBin": "/usr/bin/mpv"
  }
}
```

---

## API reference

All endpoints require a valid JWT token (`x-access-token` header) except `/server-remote`.

### Playback state

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/v1/server-playback/status` | Full playback state + queue |
| `GET`  | `/api/v1/server-playback/detect` | Detect mpv installation |

### Transport

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/server-playback/pause` | — | Toggle play/pause |
| `POST` | `/api/v1/server-playback/next` | — | Next track |
| `POST` | `/api/v1/server-playback/previous` | — | Previous track |
| `POST` | `/api/v1/server-playback/seek` | `{ position }` | Seek to absolute position (seconds) |
| `POST` | `/api/v1/server-playback/volume` | `{ volume }` | Set volume 0–130 |
| `POST` | `/api/v1/server-playback/loop` | — | Cycle loop mode (none→one→all→none) |

### Queue

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/server-playback/queue/add` | `{ filepath, title?, artist?, album?, albumArt? }` | Append song to queue |
| `POST` | `/api/v1/server-playback/queue/clear` | — | Clear queue and stop |
| `POST` | `/api/v1/server-playback/queue/remove` | `{ index }` | Remove song at index |
| `POST` | `/api/v1/server-playback/queue/play-index` | `{ index }` | Jump to index |

### Admin

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET`  | `/api/v1/admin/server-audio` | — | Get config + running state |
| `POST` | `/api/v1/admin/server-audio` | `{ enabled?, mpvBin? }` | Update config |
| `POST` | `/api/v1/admin/server-audio/start` | — | Start mpv now |
| `POST` | `/api/v1/admin/server-audio/stop` | — | Stop mpv now |

### Status response shape

```json
{
  "running":      true,
  "playing":      true,
  "currentTime":  42.1,
  "duration":     213.4,
  "currentIndex": 0,
  "queueLength":  5,
  "volume":       100,
  "loopMode":     "none",
  "queue": [
    {
      "relPath":  "Music/Albums/Artist/Album/01 Track.flac",
      "title":    "Track Title",
      "artist":   "Artist Name",
      "album":    "Album Name",
      "albumArt": "abc123.jpg"
    }
  ]
}
```

`loopMode` values: `"none"` / `"one"` / `"all"`

---

## Troubleshooting

**mpv not found**
> Click *Detect mpv* in the admin panel. If it shows ✗, either install mpv or set the full path in *mpv Binary Path*.

**No audio output**
> mpv uses the system's default audio output device. On headless Linux servers you may need to configure a virtual sink (PulseAudio / PipeWire) or connect audio hardware. Run `mpv --audio-device=help` from the terminal to list available devices.

**Status shows "Enabled, mpv not started"**
> Restart the mStream service (`systemctl restart music.service`) or click *Start* in the admin panel.

**Queue is empty after restart**
> The server-side queue is in-memory only — it resets on server restart. Auto-DJ will repopulate it automatically if enabled.
