# Your Stats — Listening Statistics

mStream Velvet tracks your listening activity privately, on your own server. No data leaves your instance.

---

## How it works

Every time you play a song, the player sends a lightweight event to the server:

| Event | When | What it records |
|---|---|---|
| `play-start` | Immediately on song load | `file_hash`, `started_at`, `source`, `session_id` |
| `play-end` | Track finishes naturally | `played_ms`, `completed = true` |
| `play-skip` | You press Next before the track ends | `played_ms`, `skipped = true` |
| `play-stop` | Tab/window closes | Best-effort `played_ms` via `sendBeacon` |
| `session-end` | Tab/window closes | `ended_at` on the session row |

A **session** = one page load. All plays in that browser tab share a single `session_id` (UUID generated at load time).

All raw data is stored in two SQLite tables: `play_events` and `listening_sessions`.

---

## User view

Click **Your Stats** in the sidebar to see your statistics.

### Period picker

Choose the time window at the top:

| Period | Coverage |
|---|---|
| Week | Current ISO week (Mon–Sun) |
| Month | Current calendar month |
| Quarter | Current quarter (Q1–Q4) |
| Half-Year | H1 (Jan–Jun) or H2 (Jul–Dec) |
| Year | Full calendar year |

Use **← Earlier** / **Later →** to navigate to previous periods.

### Summary strip

| Metric | Description |
|---|---|
| Plays | Total songs started |
| Listened | Sum of `played_ms` across all events |
| Unique songs | Distinct tracks heard |
| Skip rate | Skipped events ÷ total plays |
| Library covered | Unique songs ÷ total files in your library |

### Top Songs / Top Artists

Top 10 by play count, with album art thumbnails.

### Listening by Hour / Weekday

Bar charts showing when you listen most.  
Intensity: lighter = fewer plays, stronger blue = more plays.

### Personality

A rule-based type assigned from your listening patterns:

| Type | Condition |
|---|---|
| Night Owl | >40 % of plays between 22:00–04:00 |
| Album Completionist | Completion rate >85 % AND skip rate <10 % |
| Restless Skipper | Skip rate >40 % |
| Early Bird | >30 % of plays between 06:00–09:00 |
| Explorer | >30 % of plays are first-time songs in the period |
| Consistent Listener | Fallback |

### Fun Facts

- Top song total hours
- Most loyal song (100 % completion, ≥5 plays)
- Most skipped artist (≥5 plays)
- Most back-to-back replayed song
- Earliest play time of day
- New discoveries count

---

## Privacy

- **All data is local.** Play events are stored only in `save/db/mstream.sqlite`.
- **No external calls.** The stats system makes no network requests.
- **No data before April 2026.** Historical plays from `user_metadata.pc` are not imported — only events recorded since this feature was activated.
- Tags are never duplicated into `play_events` — stats always JOIN to the `files` table at query time, so tag edits are reflected automatically.

---

## Admin — Play Stats panel

Accessible from the admin sidebar → **Play Stats**.

Shows:
- Total play events (all users)
- Estimated DB storage used
- Per-user breakdown (event count, listening time)

### Purging old events

Select a user and set **Keep months** (1–60), then click **Purge**. Events older than that threshold are deleted. Sessions with no remaining events are also cleaned up.

---

## Database schema

```sql
play_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  file_hash    TEXT NOT NULL,        -- joins to files.hash
  started_at   INTEGER NOT NULL,     -- Unix ms
  ended_at     INTEGER,
  duration_ms  INTEGER,              -- track total from files.duration * 1000
  played_ms    INTEGER,              -- ms actually heard
  completed    INTEGER DEFAULT 0,    -- 1 if played_ms >= 90% of duration_ms
  skipped      INTEGER DEFAULT 0,    -- 1 if user skipped
  source       TEXT,                 -- 'manual'|'shuffle'|'autodj'|'playlist'|'smart-playlist'
  session_id   TEXT
)

listening_sessions (
  session_id   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  total_tracks INTEGER DEFAULT 0
)
```

---

## API reference

### Player event endpoints (JWT-authenticated)

```
POST /api/v1/wrapped/play-start
  body: { filePath, sessionId, source }
  returns: { ok, eventId }

POST /api/v1/wrapped/play-end
  body: { eventId, playedMs }

POST /api/v1/wrapped/play-skip
  body: { eventId, playedMs }

POST /api/v1/wrapped/play-stop
  body: { eventId, playedMs }

POST /api/v1/wrapped/session-end
  body: { sessionId }
```

### Stats endpoints (JWT-authenticated)

```
GET /api/v1/user/wrapped?period=monthly&offset=0
  → full stats object for the authenticated user

GET /api/v1/user/wrapped/periods
  → { periods: [ { year, month, play_count } ] }
```

### Admin endpoints (admin-only)

```
GET  /api/v1/admin/wrapped/stats
     → { total_events, storage_bytes, per_user: [...] }

POST /api/v1/admin/wrapped/purge
     body: { userId, keepMonths }
     → { ok, deleted }
```
