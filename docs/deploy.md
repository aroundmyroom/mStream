# Deployment & Reverse-Proxy Guide

## nginx Reverse-Proxy Configuration

When serving mStream Velvet behind nginx you **must** set generous timeouts and disable proxy buffering for audio streams. Without this, large FLAC files will stall on idle connections.

Create `/etc/nginx/sites-available/mstream` (adjust `server_name` and `proxy_pass` port to match your setup):

```nginx
server {
    listen 80;
    server_name your.domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your.domain.com;

    ssl_certificate     /etc/letsencrypt/live/your.domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your.domain.com/privkey.pem;

    # --- key settings for large FLAC / audio streaming ---
    proxy_buffering          off;          # stream bytes straight to client
    proxy_read_timeout       3600s;        # keep idle streams alive
    proxy_send_timeout       3600s;
    proxy_connect_timeout    10s;
    client_max_body_size     0;            # no upload-size limit (album art)

    # WebSocket support (waveform + scan-progress events)
    proxy_http_version       1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    location / {
        proxy_pass http://127.0.0.1:3000;
    }
}
```

Enable and reload:

```bash
ln -s /etc/nginx/sites-available/mstream /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

## Running as a systemd Service

See [install.md](install.md) for full instructions including PM2 and the `music.service` systemd unit.

---

## Release Process

- Bump the version in `package.json`
- Commit with message `vX.X.X`
- Tag: `git tag vX.X.X`
- Push: `git push && git push --tags`
