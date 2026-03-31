FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --g npm@latest
RUN npm install --production

COPY . .

# Pre-download yt-dlp so it's ready immediately on container start.
# The server also auto-downloads it at runtime if missing (e.g. offline builds).
RUN arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" ;; \
      aarch64) url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64" ;; \
      armv7l)  url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_armv7l" ;; \
      *)       url="" ;; \
    esac; \
    if [ -n "$url" ]; then \
      mkdir -p bin/yt-dlp && \
      wget -q -O bin/yt-dlp/yt-dlp "$url" && \
      chmod +x bin/yt-dlp/yt-dlp || echo "yt-dlp pre-download failed (will auto-download at runtime)"; \
    fi

# Pre-create runtime directories so SQLite and the config writer
# can initialise even when no volume is mounted on first start.
RUN mkdir -p save/conf save/db save/logs save/sync image-cache waveform-cache

EXPOSE 3000

CMD ["node", "cli-boot-wrapper.js"]
