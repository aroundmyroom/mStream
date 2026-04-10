/**
 * wrapped-stats.mjs — pure SQLite aggregation for Wrapped statistics
 *
 * Exported:
 *   getWrappedStats(userId, fromMs, toMs, vpaths) → stats object
 *   getPeriodBounds(period, offset)               → { from, to, label }
 */

import * as db from './manager.js';

// ── Period helpers ─────────────────────────────────────────────────────────────

/**
 * Returns { from, to, label } for the requested period/offset.
 * period: 'weekly' | 'monthly' | 'quarterly' | 'half-yearly' | 'yearly'
 * offset: 0 = current, -1 = previous, etc.
 * All boundaries are local-midnight-aligned (server timezone).
 */
export function getPeriodBounds(period = 'monthly', offset = 0) {
  offset = parseInt(offset, 10) || 0;
  const now = new Date();
  const y   = now.getFullYear();
  const m   = now.getMonth(); // 0-based
  const day = now.getDate();

  switch (period) {
    case 'weekly': {
      // ISO week — Monday start
      const dow = (now.getDay() + 6) % 7; // Mon=0 … Sun=6
      const from = new Date(y, m, day - dow).getTime() + offset * 7 * 86400000;
      const to   = from + 7 * 86400000;
      const d    = new Date(from);
      // ISO week number (local)
      const jan4 = new Date(d.getFullYear(), 0, 4);
      const isoY = jan4.getFullYear();
      const startOfIsoYear = new Date(isoY, 0, 4 - ((jan4.getDay() + 6) % 7)).getTime();
      const weekNum = 1 + Math.round((from - startOfIsoYear) / (7 * 86400000));
      return { from, to, label: `${isoY}-W${String(weekNum).padStart(2,'0')}` };
    }
    case 'monthly': {
      const adjustedMonth = m + offset;
      const y2 = y + Math.floor(adjustedMonth / 12);
      const m2 = ((adjustedMonth % 12) + 12) % 12;
      const from = new Date(y2, m2, 1).getTime();
      const to   = new Date(y2, m2 + 1, 1).getTime();
      const label = new Date(y2, m2, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
      return { from, to, label };
    }
    case 'quarterly': {
      const currentQ  = Math.floor(m / 3);
      const adjustedQ = currentQ + offset;
      const y2 = y + Math.floor(adjustedQ / 4);
      const q2 = ((adjustedQ % 4) + 4) % 4;
      const from = new Date(y2, q2 * 3, 1).getTime();
      const to   = new Date(y2, q2 * 3 + 3, 1).getTime();
      return { from, to, label: `Q${q2 + 1} ${y2}` };
    }
    case 'half-yearly': {
      const currentH  = Math.floor(m / 6);
      const adjustedH = currentH + offset;
      const y2 = y + Math.floor(adjustedH / 2);
      const h2 = ((adjustedH % 2) + 2) % 2;
      const from = new Date(y2, h2 * 6, 1).getTime();
      const to   = new Date(y2, h2 * 6 + 6, 1).getTime();
      return { from, to, label: `H${h2 + 1} ${y2}` };
    }
    case 'yearly': {
      const y2 = y + offset;
      return { from: new Date(y2, 0, 1).getTime(), to: new Date(y2 + 1, 0, 1).getTime(), label: String(y2) };
    }
    default:
      throw new Error(`Unknown period: ${period}`);
  }
}

// ── Stats aggregation ──────────────────────────────────────────────────────────

/**
 * Returns the full Wrapped stats object for a user in the given time range.
 * vpaths is the user's accessible vpath list — used for library_coverage_pct.
 */
export async function getWrappedStats(userId, fromMs, toMs, vpaths = []) {
  const events     = db.getWrappedDataInRange(userId, fromMs, toMs);
  const sessions   = db.getWrappedSessionsInRange(userId, fromMs, toMs);
  const radioRows  = db.getRadioStatsInRange(userId, fromMs, toMs);
  const podRows    = db.getPodcastStatsInRange(userId, fromMs, toMs);

  // ── Radio summary ────────────────────────────────────────────────────────────
  const radio = {
    total_ms:       radioRows.reduce((s, r) => s + (r.total_ms ?? 0), 0),
    total_sessions: radioRows.reduce((s, r) => s + (r.sessions ?? 0), 0),
    top_stations:   radioRows.slice(0, 5),
  };

  // ── Podcast summary ──────────────────────────────────────────────────────────
  const podcast = {
    total_ms:           podRows.reduce((s, r) => s + (r.total_ms ?? 0), 0),
    shows_heard:        podRows.length,
    episodes_played:    podRows.reduce((s, r) => s + (r.episodes_played ?? 0), 0),
    episodes_completed: podRows.reduce((s, r) => s + (r.completed_count ?? 0), 0),
    top_shows:          podRows.slice(0, 5),
  };

  if (events.length === 0) {
    return { ...emptyStats(), radio, podcast };
  }

  // ── Filepath-based fallback labels ─────────────────────────────────────────
  // When a file has no embedded title/artist tags, derive readable labels from
  // the file path rather than showing a raw hash or '(Unknown)'.
  // filepath format: Artist/Album/Track.mp3  (relative to vpath root)
  function _titleFromPath(fp) {
    if (!fp) return null;
    const name = fp.split('/').pop();                         // last segment
    return name.replace(/\.[^.]+$/, '');                     // strip extension
  }
  function _artistFromPath(fp) {
    if (!fp) return null;
    const parts = fp.split('/');
    // With 3+ parts: root-folder is typically Artist
    // With 2 parts: root-folder is Album — use it as artist fallback
    // With 1 part: flat file — use filename without extension
    return parts.length >= 2 ? parts[0] : _titleFromPath(fp);
  }

  // ── Basic counts ────────────────────────────────────────────────────────────
  const total_plays        = events.length;
  const completed_plays    = events.filter(e => e.completed).length;
  const skipped_plays      = events.filter(e => e.skipped).length;
  const total_listening_ms = events.reduce((s, e) => s + (e.played_ms ?? 0), 0);
  const unique_songs       = new Set(events.map(e => e.file_hash)).size;
  const skip_rate          = total_plays ? skipped_plays / total_plays : 0;
  const completion_rate    = total_plays ? completed_plays / total_plays : 0;
  const pause_count        = events.reduce((s, e) => s + (e.pause_count ?? 0), 0);

  const totalFiles = db.getTotalFileCount(vpaths);
  const library_coverage_pct = totalFiles > 0 ? (unique_songs / totalFiles) * 100 : 0;

  // ── Top songs ────────────────────────────────────────────────────────────────
  const songCounts = {};
  for (const e of events) {
    const derivedTitle  = e.title  || _titleFromPath(e.filepath);
    const derivedArtist = e.artist || _artistFromPath(e.filepath);
    if (!derivedTitle && !derivedArtist) continue;  // orphaned file — skip
    if (!songCounts[e.file_hash]) {
      songCounts[e.file_hash] = {
        hash:           e.file_hash,
        title:          derivedTitle,
        artist:         derivedArtist,
        album:          e.album,
        aaFile:         e.aaFile,
        play_count:     0,
        total_played_ms: 0,
      };
    }
    songCounts[e.file_hash].play_count++;
    songCounts[e.file_hash].total_played_ms += e.played_ms ?? 0;
  }
  const top_songs = Object.values(songCounts)
    .sort((a, b) => b.play_count - a.play_count || b.total_played_ms - a.total_played_ms)
    .slice(0, 10);

  // ── Top artists ─────────────────────────────────────────────────────────────
  const artistCounts = {};
  for (const e of events) {
    const key = e.artist || _artistFromPath(e.filepath);
    if (!key) continue;  // file deleted from library — no recoverable identity, skip
    if (!artistCounts[key]) {
      artistCounts[key] = { artist: key, artist_id: e.artist_id, play_count: 0, total_played_ms: 0 };
    }
    artistCounts[key].play_count++;
    artistCounts[key].total_played_ms += e.played_ms ?? 0;
  }
  const top_artists = Object.values(artistCounts)
    .sort((a, b) => b.play_count - a.play_count)
    .slice(0, 10);

  // ── Top albums ───────────────────────────────────────────────────────────────
  const albumCounts = {};
  for (const e of events) {
    if (!e.album) continue;
    const key = `${e.album}|||${e.artist || ''}`;
    if (!albumCounts[key]) {
      albumCounts[key] = { album: e.album, artist: e.artist, album_id: e.album_id, aaFile: e.aaFile, play_count: 0 };
    }
    albumCounts[key].play_count++;
  }
  const top_albums = Object.values(albumCounts)
    .sort((a, b) => b.play_count - a.play_count)
    .slice(0, 5);

  // ── Temporal patterns ────────────────────────────────────────────────────────
  const listening_by_hour    = new Array(24).fill(0);
  const listening_by_weekday = new Array(7).fill(0);  // 0=Mon..6=Sun
  const dayTotals = {};

  for (const e of events) {
    const d = new Date(e.started_at);
    const h = d.getHours();               // local server time
    const w = (d.getDay() + 6) % 7;       // Mon=0…Sun=6 local
    listening_by_hour[h]++;
    listening_by_weekday[w]++;
    // Local date string YYYY-MM-DD
    const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    dayTotals[dateKey] = (dayTotals[dateKey] ?? 0) + (e.played_ms ?? 0);
  }

  let top_listening_day = null;
  let topDayMs = 0;
  for (const [date, ms] of Object.entries(dayTotals)) {
    if (ms > topDayMs) { topDayMs = ms; top_listening_day = { date, total_listening_ms: ms }; }
  }

  // ── Session insights ─────────────────────────────────────────────────────────
  const completeSessions = sessions.filter(s => s.ended_at && s.started_at);
  const sessionLengths   = completeSessions.map(s => s.ended_at - s.started_at);
  const avg_session_length_ms = sessionLengths.length
    ? Math.round(sessionLengths.reduce((a, b) => a + b, 0) / sessionLengths.length)
    : 0;
  let longest_session = null;
  if (completeSessions.length) {
    longest_session = completeSessions.reduce((best, s) =>
      (s.ended_at - s.started_at) > (best.ended_at - best.started_at) ? s : best
    );
  }

  // ── New discoveries ──────────────────────────────────────────────────────────
  // Songs whose FIRST EVER play event is within this period
  const firstSeenHashes = new Set();
  const newDiscoveries = [];
  for (const e of events) {
    if (firstSeenHashes.has(e.file_hash)) continue;
    firstSeenHashes.add(e.file_hash);
    // Check if there is ANY event for this user+hash before fromMs
    const hasHistory = db.hasPlayEventBefore(userId, e.file_hash, fromMs);
    if (!hasHistory) newDiscoveries.push({ hash: e.file_hash, title: e.title, artist: e.artist });
  }

  // ── Fun facts ────────────────────────────────────────────────────────────────

  // Top song hours (for fun fact string)
  const topSong          = top_songs[0];
  const topSongH         = topSong ? Math.round(topSong.total_played_ms / 3600000 * 10) / 10 : 0;

  // Most skipped artist (min 5 plays, highest skip rate)
  const artistSkipData = {};
  for (const e of events) {
    const key = e.artist || _artistFromPath(e.filepath);
    if (!key) continue;  // orphaned file — skip
    if (!artistSkipData[key]) artistSkipData[key] = { total: 0, skipped: 0 };
    artistSkipData[key].total++;
    if (e.skipped) artistSkipData[key].skipped++;
  }
  let most_skipped_artist = null;
  let bestSkipRate = 0;
  for (const [artist, d] of Object.entries(artistSkipData)) {
    if (d.total < 5) continue;
    const rate = d.skipped / d.total;
    if (rate > bestSkipRate) { bestSkipRate = rate; most_skipped_artist = { artist, skip_rate: rate }; }
  }

  // Earliest play (earliest hour of day string)
  const earliest_play = events.length
    ? (() => {
        const earlyMs = Math.min(...events.map(e => {
          const d = new Date(e.started_at);
          return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
        }));
        return `${String(Math.floor(earlyMs / 3600)).padStart(2, '0')}:${String(Math.floor((earlyMs % 3600) / 60)).padStart(2, '0')}`;
      })()
    : null;

  // Most loyal song (≥ 5 plays, 100% completion rate, by play count)
  let most_loyal_song = null;
  for (const s of top_songs) {
    if (s.play_count < 5) continue;
    const sEvents = events.filter(e => e.file_hash === s.hash);
    const compRate = sEvents.filter(e => e.completed).length / sEvents.length;
    if (compRate >= 1.0) {
      most_loyal_song = {
        title:  s.title  || _titleFromPath(sEvents[0]?.filepath),
        artist: s.artist || _artistFromPath(sEvents[0]?.filepath),
      };
      break;
    }
  }

  // Night owl score
  const nightPlays = events.filter(e => {
    const h = new Date(e.started_at).getHours();
    return h >= 22 || h < 4;
  }).length;
  const night_owl_score = total_plays ? nightPlays / total_plays : 0;

  // Most back-to-back replayed song
  let most_replayed_song = null;
  {
    const sorted = [...events].sort((a, b) => a.started_at - b.started_at);
    let maxReplays = 0; let curHash = null; let curCount = 0;
    let bestHash = null;
    for (const e of sorted) {
      if (e.file_hash === curHash) {
        curCount++;
        if (curCount > maxReplays) { maxReplays = curCount; bestHash = curHash; }
      } else {
        curHash = e.file_hash; curCount = 1;
      }
    }
    if (bestHash && maxReplays >= 2) {
      const s = songCounts[bestHash];
      most_replayed_song = { title: s?.title, artist: s?.artist, replay_count: maxReplays };
    }
  }

  // ── Personality ─────────────────────────────────────────────────────────────
  let personality;
  if (night_owl_score > 0.40) {
    personality = { type: 'Night Owl', desc: 'Most of your listening happens after 10 PM.' };
  } else if (completion_rate > 0.85 && skip_rate < 0.10) {
    personality = { type: 'Album Completionist', desc: 'You actually listen to the whole track.' };
  } else if (skip_rate > 0.40) {
    personality = { type: 'Restless Skipper', desc: "You know what you want and you want it now." };
  } else if (listening_by_hour[6] + listening_by_hour[7] + listening_by_hour[8] + listening_by_hour[9] >
             total_plays * 0.30) {
    personality = { type: 'Early Bird', desc: 'Your day starts with music.' };
  } else if (total_plays > 0 && newDiscoveries.length / total_plays > 0.30) {
    personality = { type: 'Explorer', desc: 'Always hunting for something new.' };
  } else {
    personality = { type: 'Consistent Listener', desc: 'You know your taste and stick to it.' };
  }

  return {
    total_plays,
    unique_songs,
    completed_plays,
    skipped_plays,
    pause_count,
    total_listening_ms,
    skip_rate,
    completion_rate,
    library_coverage_pct,
    top_songs,
    top_artists,
    top_albums,
    listening_by_hour,
    listening_by_weekday,
    top_listening_day,
    avg_session_length_ms,
    longest_session,
    new_discoveries: newDiscoveries.length,
    new_discovery_list: newDiscoveries.slice(0, 20),
    fun_facts: {
      top_song_hours: topSong ? { song: topSong.title, artist: topSong.artist, hours: topSongH } : null,
      most_skipped_artist,
      earliest_play,
      most_loyal_song,
      night_owl_score,
      most_replayed_song,
    },
    personality,
    radio,
    podcast,
  };
}

function emptyStats() {
  return {
    total_plays: 0, unique_songs: 0, completed_plays: 0, skipped_plays: 0, pause_count: 0,
    total_listening_ms: 0, skip_rate: 0, completion_rate: 0, library_coverage_pct: 0,
    top_songs: [], top_artists: [], top_albums: [],
    listening_by_hour: new Array(24).fill(0),
    listening_by_weekday: new Array(7).fill(0),
    top_listening_day: null, avg_session_length_ms: 0, longest_session: null,
    new_discoveries: 0, new_discovery_list: [],
    fun_facts: { top_song_hours: null, most_skipped_artist: null, earliest_play: null, most_loyal_song: null, night_owl_score: 0, most_replayed_song: null },
    personality: { type: 'Consistent Listener', desc: 'No data for this period yet.' },
    radio:   { total_ms: 0, total_sessions: 0, top_stations: [] },
    podcast: { total_ms: 0, shows_heard: 0, episodes_played: 0, episodes_completed: 0, top_shows: [] },
  };
}
