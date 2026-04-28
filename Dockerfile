FROM node:24-slim

# Build tools needed for npm native modules on Debian slim
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends wget xz-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --g npm@latest && npm install --production

COPY . .

# Pre-download yt-dlp so it's ready immediately on container start.
# The server also auto-downloads it at runtime if missing or empty.
RUN arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" ;; \
      aarch64) url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64" ;; \
      armv7l)  url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_armv7l" ;; \
      *)       url="" ;; \
    esac; \
    if [ -n "$url" ]; then \
      mkdir -p bin/yt-dlp && \
      if wget -q -O bin/yt-dlp/yt-dlp "$url" && [ -s bin/yt-dlp/yt-dlp ]; then \
        chmod +x bin/yt-dlp/yt-dlp && echo "yt-dlp pre-download OK"; \
      else \
        rm -f bin/yt-dlp/yt-dlp && echo "yt-dlp pre-download failed (will auto-download at runtime)"; \
      fi; \
    fi

# Pre-download fpcalc (Chromaprint) for AcoustID fingerprinting.
# Static binary, no system dependencies. Falls back gracefully if download fails.
RUN arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  url="https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-linux-x86_64.tar.gz" ;; \
      aarch64) url="https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-linux-aarch64.tar.gz" ;; \
      *)       url="" ;; \
    esac; \
    if [ -n "$url" ]; then \
      mkdir -p bin/fpcalc && \
      if wget -q -O /tmp/fpcalc.tar.gz "$url" && \
         tar -xzf /tmp/fpcalc.tar.gz -C bin/fpcalc --strip-components=1 --wildcards '*/fpcalc' && \
         chmod +x bin/fpcalc/fpcalc && \
         rm -f /tmp/fpcalc.tar.gz && \
         bin/fpcalc/fpcalc -version; then \
        echo "fpcalc pre-download OK"; \
      else \
        rm -rf bin/fpcalc && echo "fpcalc pre-download failed (will auto-download at runtime)"; \
      fi; \
    fi

# Pre-download rsgain (EBU R128 measurement, x86_64 only — no arm64 static build available).
# Falls back to ffmpeg-based measurement at runtime when rsgain is absent.
RUN arch="$(uname -m)"; \
    if [ "$arch" = "x86_64" ]; then \
      tag=$(wget -qO- "https://api.github.com/repos/complexlogic/rsgain/releases/latest" \
            | grep '"tag_name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/') && \
      if [ -n "$tag" ]; then \
        mkdir -p bin/rsgain && \
        if wget -q -O /tmp/rsgain.tar.xz \
             "https://github.com/complexlogic/rsgain/releases/download/v${tag}/rsgain-${tag}-Linux.tar.xz" && \
           tar -xJf /tmp/rsgain.tar.xz -C bin/rsgain --strip-components=1 "rsgain-${tag}-Linux/rsgain" && \
           chmod +x bin/rsgain/rsgain && \
           rm -f /tmp/rsgain.tar.xz && \
           bin/rsgain/rsgain --version; then \
          echo "rsgain pre-download OK (v${tag})"; \
        else \
          rm -rf bin/rsgain && echo "rsgain pre-download failed (ffmpeg fallback will be used)"; \
        fi; \
      else \
        echo "rsgain: could not resolve latest tag (ffmpeg fallback will be used)"; \
      fi; \
    else \
      echo "rsgain: arch ${arch} not supported (ffmpeg fallback will be used)"; \
    fi

# Pre-create runtime directories so SQLite and the config writer
# can initialise even when no volume is mounted on first start.
RUN mkdir -p save/conf save/db save/logs save/sync image-cache waveform-cache

# First-run auto-config env vars - ALL OPTIONAL, see compose.yaml for full docs.
# These are a convenience for simple single-library setups only.
# For multiple volumes, child-vpaths, albumsOnly, or any advanced config,
# edit save/conf/default.json directly instead of using these variables.
# MSTREAM_MUSIC_DIR is the only trigger; empty here = bootstrap never runs.
ENV MSTREAM_MUSIC_DIR=""
ENV MSTREAM_ADMIN_USER=""
ENV MSTREAM_ADMIN_PASS=""
ENV MSTREAM_ENABLE_AUDIOBOOKS=""
ENV MSTREAM_ENABLE_RECORDINGS=""
ENV MSTREAM_ENABLE_YOUTUBE=""
ENV MSTREAM_AUDIOBOOKS_SUBDIR=""
ENV MSTREAM_RECORDINGS_SUBDIR=""
ENV MSTREAM_YOUTUBE_SUBDIR=""

EXPOSE 3000

CMD ["node", "cli-boot-wrapper.js"]
