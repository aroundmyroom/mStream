# Running mStream Velvet with Docker

## Quick start

### 1. Clone and build

```shell
git clone https://github.com/aroundmyroom/mStream.git
cd mStream
docker build -t mstream-velvet .
```

### 2. Start with Docker Compose

Edit the volume paths in `compose.yaml` to match your system, then:

```shell
docker compose up -d
```

Open your browser at **http://localhost:3000**

---

## compose.yaml

```yaml
services:
  mstream:
    image: mstream-velvet
    container_name: mstream-velvet
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      # Persistent data — config, database, logs, sync state
      - /home/mStream/save:/app/save
      # Your music library (read-only recommended)
      - /media/music:/music
      # Cached waveform data
      - /home/mStream/waveform-cache:/app/waveform-cache
      # Cached album art / podcast / radio artwork
      - /home/mStream/image-cache:/app/image-cache
```

Adjust the host-side paths (`/home/mStream/…`, `/media/music`) to wherever you want to store data on your machine.

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
Edit the file to point at your music volume:

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
