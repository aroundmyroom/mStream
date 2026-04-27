# Sonos Integration — "Cast to Sonos" Feature Plan

> **Status: Design / Planning** — not yet implemented

---

## What we're building

A **"Cast to Sonos"** feature that lets a user, from anywhere inside the mStream Velvet player,
push the currently playing track or their full queue to any Sonos room on the local network —
with a single click.

This is a **controller** pattern: mStream Velvet discovers Sonos devices and sends them SOAP
commands telling them what to play and where to fetch the audio from.  The Sonos speaker pulls
the audio directly from mStream Velvet's existing **DLNA HTTP server** (port 10293).

---

## How it fits with existing DLNA

We already have:

| What | Role |
|------|------|
| DLNA/UPnP MediaServer (port 10293) | **Content source** — Sonos can browse us as a library |
| Sonos integration (this feature) | **Controller** — mStream tells Sonos what to play *right now* |

These two are complementary.  DLNA lets Sonos _browse_ your collection; this feature lets
mStream _push_ to Sonos from the player.  Both use the DLNA HTTP port as the audio transport.

> **Prerequisite**: The DLNA server must be enabled and reachable by the Sonos devices on the
> same network segment.  (If DLNA is off, we auto-warn the user.)

---

## Architecture

```
mStream Velvet player (browser)
  │
  │  POST /api/v1/sonos/cast  { deviceIp, tracks }
  ▼
mStream Velvet server  ──────────────────────────────────────►  Sonos device (port 1400)
  src/api/sonos.js              SOAP: SetAVTransportURI
                                SOAP: Play
                                ◄── 200 OK
  │
  │  Audio URL embedded in cast request:
  │  http://<server-ip>:10293/media/<vpath>/<filepath>
  ▼
DLNA HTTP server (port 10293)
  │  GET /media/Music/Albums/...  (no auth, plain HTTP)
  ▼
Sonos speaker pulls audio stream  ──────────────────── 🔊 plays
```

---

## Unified Audio Output — the right UX approach

MStream Velvet already has a **Cast** button in the player bar (`#mpv-cast-btn`, added in
v6.11.0) that is a simple binary toggle: browser audio ↔ MPV server speaker.  With Sonos
rooms added as a third option, a binary toggle no longer makes sense.

**Proposal: upgrade the existing button into a universal "Audio Output" selector.**
One button, one icon, one dropdown.  Selecting any destination switches all playback to it.
Stopping cast returns to browser.  The pattern is identical to how Google Cast and AirPlay
behave on every music app.

```
  Player bar [  ◀  ▶  ⏸  ──────── ♪ Ring My Bell ────────  🔊▼  ]
                                                             │
                                                    ┌────────▼────────────┐
                                                    │ ● Browser  (active) │
                                                    │ ○ Server Speaker    │  ← MPV
                                                    │ ○ Living Room       │  ← Sonos
                                                    │ ○ Kitchen           │  ← Sonos
                                                    │ ○ Bedroom           │  ← Sonos
                                                    └─────────────────────┘
```

The dropdown shows only the outputs that are actually **available** to the current user:
- **Browser** — always present (the default)
- **Server Speaker** — only when `S.serverAudioRunning && S.allowMpvCast`
- **Sonos rooms** — only when Sonos integration is enabled in admin and at least one room
  has been discovered

This means:
- Users without MPV cast permission see no Server Speaker option
- Users on a network without Sonos see no Sonos options
- If only one non-browser output exists the UX degrades gracefully to a simple toggle

### What changes in code

| Current | New |
|---------|-----|
| `#mpv-cast-btn` (binary toggle button) | `#output-btn` (dropdown trigger button) |
| `toggleMpvCast()` | `_openOutputPicker()` shows dropdown |
| `_updateCastBtn()` hides/shows one button | `_updateOutputBtn()` populates output list |
| Button label: cast icon only | Button label: active output name + icon |

The button is **hidden when only "Browser" is available** (same as today — no MPV, no Sonos,
no button).  It appears as soon as at least one additional output is configured and available.

### Admin — unified "Audio Output" section

Replace the current separate Server Audio admin section with a single **Audio Output** admin
panel that covers both outputs side-by-side:

```
 Admin → Audio Output
 ┌──────────────────────────────────────────────────────────────────┐
 │  Server Speaker (mpv)               Sonos                        │
 │  ─────────────────────────          ─────────────────────────    │
 │  Enable toggle   [ON ]              Enable toggle   [OFF]        │
 │  mpv binary path [mpv]              Seed IP (optional)           │
 │  [Detect] [Start] [Stop]            [Scan now]                   │
 │  [Open Server Remote]               Rooms found: Living Room,    │
 │                                     Kitchen, Bedroom             │
 └──────────────────────────────────────────────────────────────────┘
```

This unification is purely a UI change.  The backend APIs remain separate
(`/api/v1/admin/server-audio` and `/api/v1/sonos/*`) — only the admin panel renders
them together.

---

## Sonos UPnP protocol primer

Every Sonos speaker runs a **UPnP device** on port **1400** and exposes several SOAP services:

| Service | Purpose | Endpoint |
|---------|---------|----------|
| **ZoneGroupTopology** | Get all rooms & groups | `POST /ZoneGroupTopology/Control` |
| **AVTransport** | Play/pause/stop/queue/seek | `POST /MediaRenderer/AVTransport/Control` |
| **RenderingControl** | Volume, mute | `POST /MediaRenderer/RenderingControl/Control` |

All calls are plain HTTP SOAP — no auth required on the LAN.  The same protocol we already
speak in `src/api/dlna.js` (SOAP responses, DIDL-Lite XML).

### Key SOAP calls used

| Action | What |
|--------|------|
| `ZoneGroupTopology.GetZoneGroupState` | Returns XML describing all rooms, zones, coordinator IPs |
| `AVTransport.SetAVTransportURI` | Set the URL to play (+ DIDL-Lite track metadata) |
| `AVTransport.Play` | Start playback |
| `AVTransport.AddURIToQueue` | Add a single track to Sonos' internal queue |
| `AVTransport.AddMultipleURIsToQueue` | Add several tracks at once |
| `AVTransport.RemoveAllTracksFromQueue` | Wipe Sonos queue before loading a new one |
| `AVTransport.Pause` / `Stop` / `Next` / `Previous` / `Seek` | Playback controls |
| `RenderingControl.SetVolume` | Volume control |

---

## Phased delivery

### Phase 1 — Discovery + Cast single track  *(MVP)*

**Backend — `src/api/sonos.js` (new file)**

1. **Device discovery** — reuse the existing `dgram` SSDP infrastructure (same as `dlna.js`).
   Send an M-SEARCH multicast for `urn:schemas-upnp-org:device:ZonePlayer:1` (Sonos USN).
   Cache discovered IPs in memory.  Alternative: user manually enters one Sonos IP in admin
   → call `ZoneGroupTopology.GetZoneGroupState` on that device → parse XML to get every room.

2. **Room list** — parse `GetZoneGroupState` response XML.  Each `<ZoneGroup>` has a
   coordinator (`Coordinator` attribute = the UUID to send commands to) and one or more
   `<ZoneMember>` elements with `RoomName`, `Location` (IP:port), `UUID`.

3. **Cast a track**:
   ```
   SetAVTransportURI(
     CurrentURI     = "http://<dlna-ip>:10293/media/<vpath>/<filepath>",
     CurrentURIMetaData = <DIDL-Lite with title/artist/album/art>
   )
   Play(Speed=1)
   ```
   The DIDL-Lite builder is already in `dlna.js` — extract `itemXml()` as a shared helper
   or duplicate the ~30-line function.

**New API endpoints** (all require JWT auth)

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/sonos/devices` | — | Returns cached room list; triggers discovery if cache is empty |
| `POST` | `/api/v1/sonos/scan` | — | Force re-scan / re-discover |
| `POST` | `/api/v1/sonos/cast` | `{deviceIp, track}` | Cast one track to a room |

`track` shape:
```json
{
  "url": "http://192.168.1.10:10293/media/Music/Albums/Ring My Bell.flac",
  "title": "Ring My Bell",
  "artist": "Anita Ward",
  "album": "Songs of Love",
  "artUrl": "http://192.168.1.10:10293/album-art/abcd1234.jpg",
  "durationSec": 215
}
```

**Player UI — `webapp/app.js`**

- **Upgrade `#mpv-cast-btn` → `#output-btn`** — transform the existing binary MPV cast
  toggle into a unified output dropdown trigger.
- On click: build a dropdown list combining available outputs (see the Unified Output section
  above) and display it anchored to the button.
- Selecting **Browser** → stop any active cast, return to browser audio (existing MPV stop
  logic; Sonos stop for Sonos sessions).
- Selecting **Server Speaker** → call existing `toggleMpvCast()` logic.
- Selecting a **Sonos room** → call `/api/v1/sonos/cast` with the current track URL;
  if MPV was active, stop it first.
- Button label shows active output: *"Browser"* (icon only, greyed) / *"Server Speaker"*
  (speaker icon, lit) / *"Living Room"* (cast icon + room name, lit).
- Toast: *"Now playing on Living Room"*.
- If DLNA is not running when Sonos is selected: toast warning with link to Admin → DLNA / UPnP.

**i18n keys needed** (add to all 12 locale files):
```
player.output.browser       = "Browser"
player.output.serverSpeaker = "Server Speaker"
player.output.castTo        = "Cast to…"
player.output.scanning      = "Scanning for devices…"
player.output.noDevices     = "No Sonos devices found on your network"
player.output.castSuccess   = "Now playing on {{room}}"
player.output.dlnaRequired  = "Enable DLNA in Admin to use Sonos"
```

> **Note**: The old `player.sonos.*` key prefix is replaced by `player.output.*` to reflect
> the unified concept — the dropdown serves both MPV and Sonos outputs.

---

### Phase 2 — Cast full queue

Extend `POST /api/v1/sonos/cast` to accept an array of tracks.

Flow on the Sonos side:
1. `RemoveAllTracksFromQueue` — clear existing Sonos queue
2. `AddMultipleURIsToQueue` (or batched `AddURIToQueue`) — load all tracks with DIDL-Lite metadata
3. `SetAVTransportURI` with `CurrentURI = "x-rincon-queue:RINCON_<UUID>#0"` — switch Sonos to play from its internal queue
4. `Play`

Player UI: right-click context menu on any album/playlist → **Cast all to Sonos** → room picker.

---

### Phase 3 — Remote control from mStream

Once a cast session is active, show a **mini Sonos control bar** in the player:

- Room name + a small speaker icon
- Play / Pause / Next / Previous buttons → SOAP `Play`, `Pause`, `Next`, `Previous`
- Volume slider → `RenderingControl.SetVolume`
- "Stop casting" button

New API:
| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/sonos/control` | `{deviceIp, action, value}` | `action`: play/pause/stop/next/previous/seek/volume |
| `GET` | `/api/v1/sonos/status` | — | Poll transport state + position (for UI sync) |

`/api/v1/sonos/status` calls `AVTransport.GetTransportInfo` + `GetPositionInfo` and returns:
```json
{
  "state": "PLAYING",
  "trackTitle": "Ring My Bell",
  "position": "00:01:45",
  "duration": "00:03:35"
}
```

---

### Phase 4 — Unified Audio Output admin panel

Merge the Sonos controls into the existing **Admin → Server Audio** section, renaming it
**Admin → Audio Output** (sidebar label change only — same route):

**Left column — Server Speaker (MPV)**: unchanged from current admin, just visually
co-located with Sonos.

**Right column — Sonos**:
- Enable/Disable toggle — shows/hides Sonos rooms in the player output dropdown
- **Seed IP** field (optional) — for cross-VLAN setups where SSDP doesn't reach; enter any
  one Sonos IP and the library will discover the rest via `GetZoneGroupState`
- **Scan now** button — triggers `SonosManager.InitializeWithDiscovery()` or
  `InitializeFromDevice()` if a seed IP is set; shows a spinner
- **Rooms found** list: Room name | Group | Status
- Config persisted in `save/conf/default.json` under `"sonos": { "enabled": false, "knownIps": [] }`

This is purely a UI change.  Backend routes stay separate (`/api/v1/admin/server-audio` and
`/api/v1/sonos/*`).  The sidebar entry "Server Audio" becomes "Audio Output".

---

## Implementation details

### npm dependency: `@svrooij/sonos`

The `svrooij/sonos-api-docs` repo is not just documentation — the same author published a
**full Node.js/TypeScript Sonos client** generated from those docs:

```
npm install @svrooij/sonos
```

- Repo: [github.com/svrooij/node-sonos-ts](https://github.com/svrooij/node-sonos-ts)
- Docs: [sonos-ts.svrooij.io](https://sonos-ts.svrooij.io/)
- Latest: v2.5.0 (June 2022) — Sonos SOAP protocol is stable; the library still works with all current S2 firmware

This replaces hand-rolling SOAP XML, SSDP discovery code, DIDL-Lite metadata, and the
`GetZoneGroupState` XML parser. Discovery, group management, transport control, volume —
all covered out of the box.

#### What it gives us for free

| Manual SOAP approach | `@svrooij/sonos` approach |
|----------------------|--------------------------|
| Write SSDP multicast M-SEARCH | `manager.InitializeWithDiscovery(10)` |
| Parse `GetZoneGroupState` XML | `manager.Devices` — already parsed, typed |
| Build `SetAVTransportURI` SOAP envelope | `device.AVTransportService.SetAVTransportURI({...})` |
| Build DIDL-Lite XML | `MetadataHelper.GuessTrack(url)` or manual `Track` object |
| Call `Play` SOAP | `device.Play()` |
| Volume control | `device.SetVolume(50)` |
| Group coordinator routing | handled automatically per device |

#### Usage sketch for `src/api/sonos.js`

```js
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { SonosManager, SonosDevice } = require('@svrooij/sonos');

// Discovery (SSDP)
const manager = new SonosManager();
await manager.InitializeWithDiscovery(10);
// OR from a known IP (works across VLANs):
await manager.InitializeFromDevice('192.168.1.50');

// List rooms
manager.Devices.forEach(d => console.log(d.Name, d.uuid, d.GroupName));

// Cast a track to a room
const device = manager.Devices.find(d => d.Name === 'Living Room');
await device.AVTransportService.SetAVTransportURI({
  InstanceID: 0,
  CurrentURI: 'http://192.168.1.10:10293/media/Music/Albums/ring-my-bell.flac',
  CurrentURIMetaData: '', // DIDL-Lite or empty string for direct URL
});
await device.Play();

// Volume
await device.RenderingControlService.SetVolume({ InstanceID: 0, Channel: 'Master', DesiredVolume: 50 });
```

The library uses CJS internally; imported via `createRequire` from mStream's ESM modules
(same pattern used for other CJS dependencies in this codebase).

### Audio URL construction

The track URL sent to Sonos must use the **DLNA HTTP server's IP and port**, not the HTTPS port:
```
http://<server-lan-ip>:<dlnaPort>/media/<vpath>/<encodedFilepath>
```

Server LAN IP is detected at DLNA start time (already in `dlna.js` as `_baseUrl`).  Re-use that
value.  Import the DLNA module's `getBaseUrl()` export from `sonos.js`.

### SSRF / security

- The `deviceIp` in `POST /api/v1/sonos/cast` must be validated against the discovered device
  list (whitelist) — do not allow arbitrary IPs to be targeted from the server.
- Alternatively: limit target IPs to RFC-1918 private ranges (192.168.x.x, 10.x.x.x, 172.16–31.x.x).
- The server only makes outbound connections to LAN devices — no internet exposure.

---

## Config file representation

```json
"sonos": {
  "enabled": true,
  "knownIps": ["192.168.1.50"],
  "dlnaBaseUrl": ""
}
```

`knownIps` is the Phase 4 admin-pinned list.  Can be empty — discovery handles it automatically.

---

## Supported Sonos models

All current S2 models (firmware 63.x and above):
Sonos One, One SL, Play:1, Play:3, Play:5, Beam, Arc, Ray, Roam, Era 100, Era 300,
SYMFONISK Bookshelf, Sonos Amp, Sonos Sub, Playbar.

All use port 1400 and the AVTransport / ZoneGroupTopology services documented at
[sonos.svrooij.io/services](https://sonos.svrooij.io/services/).

---

## Files to create / modify

| File | Change |
|------|--------|
| `src/api/sonos.js` | New — discovery via `@svrooij/sonos` `SonosManager`, cast logic |
| `src/api/dlna.js` | Minor — export `getBaseUrl()` so `sonos.js` can read the DLNA base URL |
| `src/server.js` | Add `sonos.setup(mstream)` call |
| `webapp/app.js` | Upgrade `#mpv-cast-btn` → `#output-btn` dropdown; add `_openOutputPicker()`, `_updateOutputBtn()` |
| `webapp/index.html` | Rename `#mpv-cast-btn` → `#output-btn` in markup |
| `webapp/admin/index.js` | Rename sidebar "Server Audio" → "Audio Output"; add Sonos column to that panel |
| `webapp/locales/*.json` | 12 locale files — new `player.output.*` keys (replaces planned `player.sonos.*`) |
| `save/conf/default.json` | `sonos` config block (added on first save) |
| `docs/API.md` | 3 new Sonos endpoints listed |
| `docs/API/sonos.md` | New endpoint detail page |
| `docs/server-audio.md` | Update title to "Audio Output"; add Sonos section |
| `package.json` | Add `@svrooij/sonos` dependency |

---

## Open questions / decisions needed

1. **DLNA dependency**: Should Cast to Sonos work *without* DLNA enabled?  Option: enable a minimal
   streaming-only mode (just `GET /media/:vpath/*`) independently of the full DLNA/SSDP server.

2. **Cross-VLAN**: SSDP won't reach Sonos devices on a different VLAN.  Phase 4 manual IP entry
   handles this.  Phase 1 should show a clear "no devices found — check VLAN / add device manually"
   message.

3. **Active session tracking**: Should mStream track which room is currently casting?  Storing the
   active `deviceIp` in memory (lost on restart) is enough for Phase 3.

4. **Multi-room (Sonos groups)**: For now, cast always targets the group coordinator for a zone —
   which means the whole bonded group plays.  Targeting individual speakers in a group can be
   added later.

5. **Format compatibility**: Library is FLAC (34k) · MP3 (31k) · WAV (12k) — all natively
   supported by Sonos with no transcoding required.  A small tail of M4A (62) and OGG (16)
   exists; those are also Sonos-native.  No transcoding layer needed.
