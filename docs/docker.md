# Running mStream Velvet with Docker

## Quick start — pull from GitHub Container Registry

The easiest way. No build step required.

```shell
docker pull ghcr.io/aroundmyroom/mstream-velvet:latest
```

Or pin to a specific release:

```shell
docker pull ghcr.io/aroundmyroom/mstream-velvet:v5.16.34-velvet
```

### compose.yaml (ghcr.io — recommended)

```yaml
services:
  mstream:
    image: ghcr.io/aroundmyroom/mstream-velvet:latest
    container_name: mstream-velvet
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./save:/app/save
      - /media/music:/music
      - ./waveform-cache:/app/waveform-cache
      - ./image-cache:/app/image-cache
```

```shell
docker compose up -d
```

Open **http://localhost:3000**

---

## Build from source

```shell
git clone https://github.com/aroundmyroom/mStream.git
cd mStream
docker build -t mstream-velvet .
```

Then change the `image:` line in `compose.yaml` to `mstream-velvet`.

---

## How the image is published

Every time a `v*-velvet` tag is pushed to GitHub, the workflow `.github/workflows/docker-publish.yml` automatically:

1. Builds a multi-arch image (`linux/amd64` + `linux/arm64`)
2. Pushes it to `ghcr.io/aroundmyroom/mstream` with the version tag and `latest`

No manual steps are needed — tagging a release is enough.

---

## Volumes explained

| Volume | What it stores | Required? |
|---|---|---|
| `/app/save` | Config file (`save/conf/default.json`), SQLite database (`save/db/mstream.sqlite`), logs, sync state | **Yes** — without this, all data is lost on container restart |
| `/music` (or any host path) | Your music files — must be added to the config as a folder (see below) | Yes, unless music is already inside the image |
| `/app/waveform-cache` | Pre-computed waveforms (regenerated if missing, but takes time) | Recommended |
| `/app/image-cache` | Cached album art, podcast art, radio logos | Recommended |

---

## First run — adding your music library

On first start mStream creates a blank config at `save/conf/default.json`.

### Option 1 — environment variables (simple single-library setup)

Add an `environment:` block to `compose.yaml`. mStream will write the initial config automatically on the very first start and skip this step on every subsequent restart.

```yaml
environment:
  MSTREAM_MUSIC_DIR: /music          # path inside the container — matches your volume

  # Optional admin account. If omitted, the server starts in open mode (no login).
  # MSTREAM_ADMIN_USER: admin
  # MSTREAM_ADMIN_PASS: changeme

  # Optional extra vpaths — uncomment to enable:
  # MSTREAM_ENABLE_AUDIOBOOKS: "true"   # sub-folder: Audiobooks
  # MSTREAM_ENABLE_RECORDINGS: "true"   # sub-folder: Recordings  (also enables radio)
  # MSTREAM_ENABLE_YOUTUBE: "true"      # sub-folder: YouTube
```

Sub-folder names can be overridden with `MSTREAM_AUDIOBOOKS_SUBDIR`, `MSTREAM_RECORDINGS_SUBDIR`, `MSTREAM_YOUTUBE_SUBDIR`.

> **When env vars are NOT sufficient** — use Option 2 instead if you need:
> multiple mount points, child-vpaths, `albumsOnly`/`filepathPrefix` filtering, or any advanced folder layout.

### Option 2 — edit the config file directly

Edit `save/conf/default.json` to point at your music volume:

```json
{
  "folders": {
    "music": {
      "root": "/music"
    }
  }
}
```

Then restart the container:

```shell
docker compose restart
```

Open the admin panel at **http://localhost:3000/admin** — no login is required on a fresh install with no users. Start a scan from the **Scan** button.

---

## Adding users

Once the library has been scanned, create your first user in the admin panel under **Users**. The first user should have admin access.

After creating at least one user, the server requires login and the no-auth bypass is disabled.

---

## Updating

Pull the latest changes, rebuild the image, and restart:

```shell
git pull
docker build -t mstream-velvet .
docker compose up -d
```

Your data in the mounted volumes is untouched.

---

## Useful commands

| Command | Effect |
|---|---|
| `docker compose up -d` | Start in background |
| `docker compose down` | Stop and remove container |
| `docker compose restart` | Restart after config change |
| `docker compose logs -f` | Follow live logs |
| `docker exec -it mstream-velvet sh` | Shell into the running container |

---

## Running without Docker Compose

```shell
docker run -d \
  --name mstream-velvet \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /home/mStream/save:/app/save \
  -v /media/music:/music \
  -v /home/mStream/waveform-cache:/app/waveform-cache \
  -v /home/mStream/image-cache:/app/image-cache \
  mstream-velvet
```

---

## Behind a reverse proxy

If you run mStream behind nginx or Caddy, see [deploy.md](deploy.md) for the recommended nginx configuration — required for large FLAC libraries to avoid stall on idle connections.
