# Running mStream Velvet with Docker

## Updating to the latest release

If you installed via `compose.yaml` with `image: ghcr.io/aroundmyroom/mstream-velvet:latest`:

```shell
docker compose pull          # fetch the new image
docker compose down
docker compose up -d         # recreate the container
```

That's it — your `save/` folder (config, database, logs) and music volume are mounted from the host, so no data is lost.

> **Pinned to a specific version?** Update the tag in `compose.yaml` (e.g. `v5.16.37-velvet`), then run the same three commands.
> Check [releases/](../releases/) or the [GitHub releases page](https://github.com/aroundmyroom/mStream/releases) for the latest tag.

---

## Quick start — pull from GitHub Container Registry

The easiest way. No build step required.

```shell
docker pull ghcr.io/aroundmyroom/mstream-velvet:latest
```

Or pin to a specific release:

```shell
docker pull ghcr.io/aroundmyroom/mstream-velvet:v5.16.41-velvet
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
      - /media/music:/music         # adjust host path to your library
      - ./waveform-cache:/app/waveform-cache
      - ./image-cache:/app/image-cache
    environment:
      MSTREAM_MUSIC_DIR: /music     # triggers first-run auto-config (optional, see below)
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

Add an `environment:` block to your `compose.yaml`. mStream will write the initial config automatically on the very first start and skip this step on every subsequent restart.

Complete copy-paste example:

```yaml
services:
  mstream:
    image: ghcr.io/aroundmyroom/mstream-velvet:latest
    container_name: mstream-velvet
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./save:/app/save            # config, database, logs
      - /media/music:/music         # your music library (adjust host path)
      - ./waveform-cache:/app/waveform-cache
      - ./image-cache:/app/image-cache
    environment:
      MSTREAM_MUSIC_DIR: /music     # must match the volume target above

      # Admin account (optional).
      # If omitted the server starts in open mode — no login required.
      # MSTREAM_ADMIN_USER: admin
      # MSTREAM_ADMIN_PASS: changeme

      # Extra feature folders — uncomment to enable.
      # By default each type is applied directly to MSTREAM_MUSIC_DIR (/music).
      # If your files live in a sub-folder, add the matching *_SUBDIR variable:
      #   MSTREAM_ENABLE_YOUTUBE: "true"
      #   MSTREAM_YOUTUBE_SUBDIR: YouTube        # → folder root becomes /music/YouTube
      # You can also add, change or remove folders at any time in the Admin panel.
      # For full control, skip env vars and edit save/conf/default.json directly.

      # AudioBooks & Podcasts  (type: audio-books)
      # MSTREAM_ENABLE_AUDIOBOOKS: "true"
      # MSTREAM_AUDIOBOOKS_SUBDIR: Audiobooks    # optional — omit to use /music directly

      # Radio Recordings  (type: recordings — also enables the radio feature)
      # MSTREAM_ENABLE_RECORDINGS: "true"
      # MSTREAM_RECORDINGS_SUBDIR: Recordings    # optional — omit to use /music directly

      # YouTube Downloads  (type: youtube)
      # MSTREAM_ENABLE_YOUTUBE: "true"
      # MSTREAM_YOUTUBE_SUBDIR: YouTube          # optional — omit to use /music directly
```

```shell
docker compose up -d
```

Open **http://localhost:3000** (or the admin panel at **/admin** to start a scan).

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
