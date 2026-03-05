# Last.fm Integration

mStream integrates with [Last.fm](https://www.last.fm) so every song you play is automatically scrobbled to your profile.  
Authentication uses the Last.fm **Mobile Session** flow — your password is sent once to Last.fm, a session key is returned and stored, and the password is never saved to disk.

---

## How it works for users

1. Open the **Last.fm** section in the GUIv2 sidebar (Tools → Last.fm).
2. Enter your Last.fm username and Last.fm password and click **Connect**.
3. mStream authenticates with Last.fm and stores only the session key in `save/conf/default.json`.  
   Your password is discarded immediately.
4. After 30 seconds of continuous playback, the track is scrobbled automatically.
5. The **Now Playing details modal** shows **Last.fm: Scrobbled ✓** (green) after a successful scrobble or an error message (red) if it failed.
6. To unlink your Last.fm account, click **Disconnect** in the same section.

---

## Admin — API key management

By default mStream ships with a built-in Last.fm API key and shared secret.  
Admins can override these with their own credentials in the **Last.fm** section of the Admin panel (Admin → Last.fm).

- The shared secret is stored server-side only and is **never** sent to browser clients.
- Changing the API key takes effect immediately without restarting the server.

To get your own credentials: <https://www.last.fm/api/account/create>

---

## API Endpoints

All endpoints require a valid user token (`x-access-token` header or `token` query param).

---

### GET `/api/v1/lastfm/status`

Returns the Last.fm username currently linked to the authenticated mStream user.

**Response**
```json
{ "linkedUser": "aroundmyroom" }
```
Returns `null` for `linkedUser` when no account is linked.

---

### POST `/api/v1/lastfm/connect`

Authenticates with Last.fm and links the account to the current mStream user.  
The password is used once to obtain a session key and is never stored.

**Request body**
```json
{
  "lastfmUser":     "aroundmyroom",
  "lastfmPassword": "your-lastfm-password"
}
```

**Response** (success)
```json
{ "linkedUser": "aroundmyroom" }
```

**Errors**
| Status | Meaning |
|--------|---------|
| 401 | Last.fm rejected the credentials (wrong username/password or API key) |
| 502 | Could not reach Last.fm |

---

### POST `/api/v1/lastfm/disconnect`

Removes the Last.fm link for the current mStream user.  
Clears `lastfm-user`, `lastfm-session`, and `lastfm-password` (legacy) from config and runtime.

**Request body** — empty `{}`

**Response** — `{}`

---

### POST `/api/v1/lastfm/scrobble-by-filepath`

Scrobbles a track by its mStream filepath and logs the play count in the user's metadata.  
This is the endpoint the player calls automatically after 30 seconds of playback.

**Request body**
```json
{ "filePath": "Music/Artist/Album/track.mp3" }
```

**Response** — `{}`

Returns `{}` silently (no error thrown) when no Last.fm account is linked.  
If the file is not found in the database, returns a 404.

---

### POST `/api/v1/lastfm/scrobble-by-metadata`

Scrobbles a track by providing the metadata directly (no file lookup).

**Request body**
```json
{
  "track":  "Heroes",
  "artist": "David Bowie",
  "album":  "Heroes"
}
```
`track` is required; `artist` and `album` are optional.

**Response** — `{ "scrobble": false }` if no Last.fm account is linked, otherwise `{}`

---

### GET `/api/v1/lastfm/similar-artists`

Returns similar artists from Last.fm for the given artist name.

**Query param** — `?artist=David+Bowie`

**Response** — Last.fm `getSimilar` payload (array of artist objects with name, match score, images).

---

### POST `/api/v1/admin/lastfm/config`  *(admin only)*

Updates the global Last.fm API key and shared secret.  
Takes effect immediately — no server restart required.

**Request body**
```json
{
  "apiKey":    "your-lastfm-api-key",
  "apiSecret": "your-lastfm-shared-secret"
}
```

**Response** — `{}`

---

## Config file reference

After a user connects, their `save/conf/default.json` will contain:

```json
"users": {
  "dennis": {
    "password": "<bcrypt hash>",
    "salt": "<salt>",
    "vpaths": ["Music"],
    "lastfm-user":    "aroundmyroom",
    "lastfm-session": "<session key from Last.fm>"
  }
}
```

`lastfm-password` is a legacy field kept for backwards compatibility.  
On next connect, it is replaced by `lastfm-session` and the plain-text password is removed.

---

## Scrobble timing

| Event | Trigger |
|-------|---------|
| Song starts playing | 30-second countdown begins |
| User skips before 30 s | Timer is cancelled — no scrobble |
| Crossfade / gapless handoff | Timer restarts for the new track |
| Server restart | Session key is loaded from config — scrobbling resumes immediately |
