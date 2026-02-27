'use strict';
// ── STATE ─────────────────────────────────────────────────────
const S = {
  token:    localStorage.getItem('ms2_token') || '',
  username: localStorage.getItem('ms2_user')  || '',
  isAdmin:  false,
  vpaths:   [],
  queue:    [],
  idx:      -1,
  shuffle:  false,
  repeat:   'off',   // 'off' | 'one' | 'all'
  autoDJ:   false,
  djIgnore: [],
  djMinRating: 0,
  djVpaths: [],       // [] means all selected
  _djPrefetching: false, // true while prefetch request is in-flight
  vpathMeta: {},     // keyed by vpath: { type, parentVpath, filepathPrefix }
  playlists:[],
  view:     'recent',
  backFn:   null,
  curSongs: [],      // songs in current view (for play-all / add-all)
  ctxSong:  null,    // song target for context menu
  feDir:    '',      // file explorer current path
  feDirStack: [],    // navigation history stack
  canUpload: true,   // false when server has noUpload=true
  supportedAudioFiles: {},  // populated from ping
  // Transcode
  transInfo:    null,  // { serverEnabled, defaultCodec, defaultBitrate, defaultAlgorithm }
  transEnabled: !!localStorage.getItem('ms2_trans'),
  transCodec:   localStorage.getItem('ms2_trans_codec')   || '',
  transBitrate: localStorage.getItem('ms2_trans_bitrate') || '',
  transAlgo:    localStorage.getItem('ms2_trans_algo')    || '',
  // Jukebox
  jukeWs:   null,
  jukeCode: null,
  // Playback
  crossfade: parseInt(localStorage.getItem('ms2_crossfade') || '0'),
  sleepMins: 0,        // 0 = off; remaining minutes when active
  sleepEndsAt: 0,      // Date.now() ms timestamp when sleep fires
};

let audioEl = document.getElementById('audio');
let scanTimer    = null;
let djTimer      = null;
let scrobbleTimer = null;
let audioCtx     = null;   // shared Web Audio context (initialised by VIZ.open)
let _audioGain   = null;   // Web Audio gain node — set once in ensureAudio
let _sleepTimer  = null;   // setInterval handle for sleep countdown
let _xfadeEl     = null;   // second audio element used for crossfade
let _xfadeGainIv = null;   // setInterval handle for crossfade gain ramp
let _xfadeFired  = false;  // true once crossfade has started for the current track
let _xfadeStartVol = 0;    // audioEl.volume at the moment crossfade began
let _xfadeNextIdx  = -1;   // nextIdx stored for the ended-event handoff
let _xfadeWired  = false;  // true once _xfadeEl is connected to Web Audio
let analyserL    = null;   // left-channel analyser
let analyserR    = null;   // right-channel analyser
let eqFilters    = [];     // 8 BiquadFilterNodes – built on first play

// ── HELPERS ──────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2,'0')}`;
}
function artUrl(f, size) {
  if (!f) return null;
  const sz = size || 's';
  return `/album-art/${encodeURIComponent(f)}?compress=${sz}&token=${S.token}`;
}
// Returns an img tag if art exists, otherwise the animated waveform placeholder
function artOrPlaceholder(f, size, extraClass) {
  const u = artUrl(f, size);
  const cls = extraClass ? ` ${extraClass}` : '';
  if (u) return `<img src="${u}" alt="" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml()">`;
  return noArtHtml(cls);
}
function noArtHtml(extraClass) {
  return `<div class="no-art${extraClass||''}"><div class="no-art-wave"><span></span><span></span><span></span><span></span><span></span></div></div>`;
}
function encodeFp(fp) {
  // Encode each path segment so characters like # & ? don't break the URL,
  // while keeping / separators intact. express.static decodes them server-side.
  return String(fp).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}
function mediaUrl(fp) {
  const path = encodeFp(fp);
  if (S.transEnabled && S.transInfo?.serverEnabled) {
    const params = new URLSearchParams({ token: S.token });
    if (S.transCodec)   params.set('codec',   S.transCodec);
    if (S.transBitrate) params.set('bitrate', S.transBitrate);
    if (S.transAlgo)    params.set('algo',    S.transAlgo);
    return `/transcode/${path}?${params}`;
  }
  return `/media/${path}?token=${S.token}`;
}
function dlUrl(fp) { return `/media/${encodeFp(fp)}?token=${S.token}`; }

let _toastT;
function toast(msg, ms = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden', 'toast-error');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.add('hidden'), ms);
}
function toastError(msg, ms = 4000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.add('toast-error');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => { el.classList.add('hidden'); el.classList.remove('toast-error'); }, ms);
}

// ── QUEUE PERSISTENCE ───────────────────────────────────────
function _queueKey() { return `ms2_queue_${S.username}`; }
function persistQueue() {
  if (!S.username) return;
  try {
    localStorage.setItem(_queueKey(), JSON.stringify({
      queue: S.queue,
      idx:   S.idx,
      time:  audioEl.currentTime || 0,
    }));
  } catch(_) {}
}
function restoreQueue() {
  const key = _queueKey();
  if (!key) return;
  let data;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    data = JSON.parse(raw);
  } catch(_) { return; }
  if (!Array.isArray(data.queue) || !data.queue.length) return;

  // Restore core state — this must always succeed
  S.queue = data.queue;
  S.idx   = (typeof data.idx === 'number' && data.idx >= 0 && data.idx < data.queue.length)
            ? data.idx : 0;
  refreshQueueUI();
  toast(`Queue restored (${S.queue.length} song${S.queue.length !== 1 ? 's' : ''})`, 2500);

  // Set up audio element — failures here must NOT break queue display
  try {
    const s = S.queue[S.idx];
    if (s) {
      audioEl.src = mediaUrl(s.filepath);
      audioEl.load();
      Player.updateBar();
      highlightRow();
      if (data.time > 1) {
        audioEl.addEventListener('loadedmetadata', () => {
          audioEl.currentTime = data.time;
        }, { once: true });
      }
    }
  } catch(e) { console.warn('restoreQueue audio setup failed:', e); }
  // Ensure icons always reflect reality after restore (src reassignment can
  // trigger spurious play events in some browsers before paused settles).
  syncPlayIcons();
}
// Throttled save of currentTime every 5 s while audio is playing
let _persistTimer = null;

// ── API ───────────────────────────────────────────────────────
async function api(method, path, body) {
  const r = await fetch('/' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-access-token': S.token },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return r.json();
}

// ── NORMALIZE SONG ────────────────────────────────────────────
function norm(s) {
  const m = s.metadata || s;
  return {
    title:      m.title    || null,
    artist:     m.artist   || null,
    album:      m.album    || null,
    year:       m.year     || null,
    track:      m.track    || null,
    disk:       m.disk     || null,
    genre:      m.genre    || null,
    replaygain: m['replaygain-track'] != null ? m['replaygain-track'] : (m['replaygain-track-db'] != null ? m['replaygain-track-db'] : null),
    'album-art': m['album-art'] || null,
    rating:     m.rating   || null,
    hash:       m.hash     || null,
    filepath:   s.filepath,
  };
}

// ── RATING HELPERS ────────────────────────────────────────────
function starsHtml(rating, cls) {
  const filled = Math.round((rating || 0) / 2);
  const c = cls || '';
  return Array.from({length:5}, (_,i) =>
    `<span class="${c}${i < filled ? ' s-on' : ' s-off'}">★</span>`
  ).join('');
}

async function rateSong(filepath, rating) {
  try {
    await api('POST', 'api/v1/db/rate-song', { filepath, rating });
    toast(rating ? `Rated ${Math.round(rating/2)} stars` : 'Rating removed');
  } catch(e) { toast('Rating failed'); }
}

// ── ARTIST NORMALIZATION ──────────────────────────────────────
// Rules:
//   - Strip leading symbols/brackets/quotes/spaces
//   - Strip zero-padded track prefixes (0, 01, 09, 001 … always start with 0)
//   - Keep bare single/multi non-zero digits ("2 Brothers", "1 Alarma", "10cc")
// Three-pass approach so bracket-wrapped numbers like "(01) Name" are handled.
function normalizeArtist(name) {
  const noise = /^[\s#'"`()|[\]{}_.,\-\u2013\u2014*!/\\]+/;
  return String(name)
    .replace(noise, '')               // pass 1: strip leading symbols/brackets
    .replace(/^0\d*[\s.,)\]]+/, '')   // pass 2: strip zero-padded number (0, 01, 09, 001…)
    .replace(noise, '')               // pass 3: strip any symbols now exposed
    .toLowerCase().trim();
}
// Same stripping logic but preserves original case — used for display, A-Z bucket, avatar letter.
function cleanArtistDisplay(name) {
  const noise = /^[\s#'"`()|[\]{}_.,\-\u2013\u2014*!/\\]+/;
  return String(name)
    .replace(noise, '')
    .replace(/^0\d*[\s.,)\]]+/, '')
    .replace(noise, '')
    .trim();
}

// ── PLAYER ───────────────────────────────────────────────────
const Player = {
  setQueue(songs, start) {
    S.queue = [...songs];
    S.djIgnore = [];
    this.playAt(start ?? 0);
  },
  playSingle(song) {
    S.queue = [song];
    S.djIgnore = [];
    this.playAt(0);
  },
  // Add to queue; if nothing is playing yet, start immediately
  queueAndPlay(song) {
    if (!audioEl.src || audioEl.ended || S.queue.length === 0) {
      this.playSingle(song);
    } else {
      this.addSong(song);
    }
  },
  addSong(song) {
    S.queue.push(song);
    toast('Added: ' + (song.title || song.filepath.split('/').pop()));
    refreshQueueUI();
    persistQueue();
  },
  addAll(songs) {
    S.queue.push(...songs);
    toast(`Added ${songs.length} songs to queue`);
    refreshQueueUI();
    persistQueue();
  },
  playNext(song) {
    const insertAt = S.idx + 1;
    S.queue.splice(insertAt, 0, song);
    toast('Playing next: ' + (song.title || song.filepath.split('/').pop()));
    refreshQueueUI();
    persistQueue();
  },
  playAt(idx) {
    if (idx < 0 || idx >= S.queue.length) return;
    S.idx = idx;
    _resetXfade();  // new track starting — arm crossfade for this track
    const s = S.queue[idx];
    audioEl.src = mediaUrl(s.filepath);
    audioEl.load();
    VIZ.initAudio();   // ensure AudioContext + analysers exist BEFORE play fires
    audioEl.play().catch(() => {});
    this.updateBar();
    highlightRow();
    refreshQueueUI();
    // Scrobble after 30 s (logs play count + last-played timestamp)
    clearTimeout(scrobbleTimer);
    scrobbleTimer = setTimeout(() => {
      api('POST', 'api/v1/lastfm/scrobble-by-filepath', { filePath: s.filepath }).catch(() => {});
    }, 30000);
    persistQueue();
  },
  toggle() {
    // If nothing is loaded and nothing is queued — truly nothing to do
    if (!audioEl.src && !S.queue.length) return;
    // src is cleared on logout — if there's a queued track, reload it and play
    if (!audioEl.src) { this.playAt(S.idx); return; }
    // src is set: toggle play/pause regardless of queue state
    // (queue may have been cleared while a song was already loaded)
    if (audioEl.paused) { VIZ.initAudio(); audioEl.play().catch(() => {}); }
    else { audioEl.pause(); }
  },
  next() {
    if (!S.queue.length) return;
    if (S.shuffle) {
      const next = Math.floor(Math.random() * S.queue.length);
      this.playAt(next);
    } else if (S.repeat === 'one') {
      audioEl.currentTime = 0;
      audioEl.play().catch(() => {});
    } else if (S.idx < S.queue.length - 1) {
      this.playAt(S.idx + 1);
    } else if (S.repeat === 'all') {
      this.playAt(0);
    } else if (S.autoDJ) {
      // If autoDJPrefetch already queued a song, just advance; otherwise fetch now
      if (S.queue.length > S.idx + 1) {
        this.playAt(S.idx + 1);
      } else {
        autoDJFetch();
      }
    }
  },
  prev() {
    if (audioEl.currentTime > 3) { audioEl.currentTime = 0; return; }
    if (S.idx > 0) this.playAt(S.idx - 1);
    else           audioEl.currentTime = 0;
  },
  updateBar() {
    const s = S.queue[S.idx];
    if (!s) return;
    document.getElementById('player-title').textContent  = s.title  || s.filepath?.split('/').pop() || '—';
    document.getElementById('player-artist').textContent = s.artist || '';
    const albumYear = [s.album, s.year].filter(Boolean).join(' · ');
    const albumEl = document.getElementById('player-album');
    albumEl.textContent = albumYear;
    albumEl.classList.toggle('hidden', !albumYear);
    requestAnimationFrame(() => {
      ['player-title','player-artist','player-album'].forEach(id => {
        const el = document.getElementById(id);
        if (!el || el.classList.contains('hidden')) return;
        el.classList.remove('marquee-scroll');
        el.style.removeProperty('--scroll-by');
        const overflow = el.scrollWidth - el.clientWidth;
        if (overflow > 4) {
          el.style.setProperty('--scroll-by', `-${overflow}px`);
          el.classList.add('marquee-scroll');
        }
      });
    });
    const thumb = document.getElementById('player-art');
    const u = artUrl(s['album-art'], 'l');
    thumb.innerHTML = u
      ? `<img src="${u}" alt="" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml()">`
      : noArtHtml();
    // update player stars
    const starsEl = document.getElementById('player-stars');
    if (s.rating) {
      starsEl.innerHTML = starsHtml(s.rating, 'ps');
      starsEl.dataset.fp = s.filepath;
      starsEl.dataset.rating = s.rating || 0;
    } else { starsEl.innerHTML = ''; }
    // sync NP modal if open
    if (!document.getElementById('np-modal').classList.contains('hidden')) {
      renderNPModal();
    }
    // sync visualizer song info
    VIZ.songChanged();
  },
};

// ── AUTO-DJ ──────────────────────────────────────────────────
// Shared helper — returns {ignoreList, songs} from the random-songs API
async function _djApiCall() {
  const selected = S.djVpaths.length > 0 ? S.djVpaths : S.vpaths;

  // Child-vpath optimisation: if every selected vpath is a child of the
  // same parent (stored under the parent vpath in the DB), use a
  // filepathPrefix filter on the parent instead of ignoreVPaths.
  const meta = S.vpathMeta || {};
  const allChildSameParent =
    selected.length > 0 &&
    selected.every(v => meta[v]?.parentVpath) &&
    new Set(selected.map(v => meta[v].parentVpath)).size === 1;

  if (allChildSameParent) {
    const parentVpath = meta[selected[0]].parentVpath;
    // Combine prefixes with OR is not supported cleanly; for a single child
    // vpath (the common case) just send the one prefix.
    const filepathPrefix = selected.length === 1 ? meta[selected[0]].filepathPrefix : null;
    const ignoreVPaths = S.vpaths.filter(v => v !== parentVpath && !meta[v]?.parentVpath);
    return api('POST', 'api/v1/db/random-songs', {
      ignoreList:    S.djIgnore,
      minRating:     S.djMinRating || undefined,
      ignoreVPaths:  ignoreVPaths.length > 0 ? ignoreVPaths : undefined,
      filepathPrefix: filepathPrefix || undefined,
    });
  }

  const ignoreVPaths = S.vpaths.filter(v => !selected.includes(v));
  return api('POST', 'api/v1/db/random-songs', {
    ignoreList:   S.djIgnore,
    minRating:    S.djMinRating || undefined,
    ignoreVPaths: ignoreVPaths.length > 0 ? ignoreVPaths : undefined,
  });
}

// Pre-fetch: silently queue the next DJ song without playing it
async function autoDJPrefetch() {
  if (S._djPrefetching) return;          // already in-flight
  if (S.queue.length > S.idx + 1) return; // already pre-queued
  S._djPrefetching = true;
  try {
    const d = await _djApiCall();
    S.djIgnore = d.ignoreList;
    S.queue.push(norm(d.songs[0]));
    refreshQueueUI();
  } catch(e) { console.error('Auto-DJ prefetch failed:', e); }
  finally { S._djPrefetching = false; }
}

// Full fetch + play: used as fallback when prefetch wasn't ready in time
async function autoDJFetch() {
  try {
    const d = await _djApiCall();
    S.djIgnore = d.ignoreList;
    const song = norm(d.songs[0]);
    S.queue.push(song);
    Player.playAt(S.queue.length - 1);
    refreshQueueUI();
  } catch(e) { console.error('Auto-DJ fetch failed:', e); }
}

function setAutoDJ(on) {
  S.autoDJ = on;
  localStorage.setItem('ms2_autodj', on ? '1' : '');
  document.getElementById('dj-light').classList.toggle('hidden', !on);
  // update autodj page if visible
  const btn = document.querySelector('.autodj-toggle');
  if (btn) { btn.classList.toggle('on', on); btn.textContent = on ? '⏹ Stop Auto-DJ' : '▶ Start Auto-DJ'; }
  const status = document.querySelector('.autodj-status');
  if (status) { status.classList.toggle('on', on); status.textContent = on ? 'Auto-DJ is ON — random songs will play continuously' : 'Auto-DJ is OFF'; }
  if (on) {
    if (!audioEl.src || audioEl.ended || S.queue.length === 0) {
      // Nothing playing and nothing queued — fetch a new song and play it
      autoDJFetch();
    } else if (audioEl.paused) {
      // Song is queued/loaded but paused — just start playing
      VIZ.initAudio();
      audioEl.play().catch(() => {});
    }
    // If already playing, Auto-DJ will take over naturally at end of track
  }
}

// ── QUEUE UI ─────────────────────────────────────────────────
function refreshQueueUI() {
  const list   = document.getElementById('queue-list');
  const cnt    = document.getElementById('qp-count');
  const badge  = document.getElementById('queue-count');
  const npCard = document.getElementById('qp-np-card');

  // Player bar badge
  if (S.queue.length) {
    badge.textContent = String(S.queue.length);
    badge.classList.add('show');
  } else { badge.classList.remove('show'); }

  // "Up Next" count (songs after current)
  const upNext = S.idx >= 0 ? Math.max(0, S.queue.length - S.idx - 1) : S.queue.length;
  cnt.textContent = upNext ? `(${upNext})` : '';

  // Now Playing card
  const cur = S.queue[S.idx];
  if (cur) {
    npCard.innerHTML = `
      <div class="qp-np-track">
        <div class="qp-np-art">
          ${artOrPlaceholder(cur['album-art'], 'm', 'no-art-sm')}
        </div>
        <div class="qp-np-info">
          <div class="qp-np-title">${esc(cur.title || cur.filepath?.split('/').pop() || '—')}</div>
          <div class="qp-np-artist">${esc(cur.artist || '')}</div>
          ${cur.rating ? `<div class="qp-np-stars" style="margin-top:3px">${starsHtml(cur.rating)}</div>` : ''}
        </div>
      </div>`;
  } else {
    npCard.innerHTML = `<div class="qp-np-empty">Nothing playing yet — click any song to start</div>`;
  }

  // Queue items
  if (!S.queue.length) {
    list.innerHTML = `
      <div class="q-empty-state">
        <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
          <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
        <p>Queue is empty.<br>Click <strong>+</strong> on any song to add it here.</p>
      </div>`;
    return;
  }

  list.innerHTML = S.queue.map((s, i) => {
    const isActive = i === S.idx;
    return `
      <div class="q-item${isActive ? ' q-active' : ''}" data-qi="${i}">
        <div class="q-num">${isActive
          ? `<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`
          : i + 1}
        </div>
        <div class="q-art">
          ${artOrPlaceholder(s['album-art'], 's', 'no-art-sm')}
        </div>
        <div class="q-info">
          <div class="q-title">${esc(s.title || s.filepath?.split('/').pop() || '?')}</div>
          <div class="q-artist">${esc(s.artist || '')}</div>
        </div>
        <button class="q-remove" data-qi="${i}" title="Remove from queue">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
  }).join('');

  list.querySelectorAll('.q-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.q-remove')) return;
      Player.playAt(parseInt(el.dataset.qi));
    });
  });
  list.querySelectorAll('.q-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.qi);
      S.queue.splice(i, 1);
      if (S.idx >= i && S.idx > 0) S.idx--;
      refreshQueueUI();
    });
  });

  const active = list.querySelector('.q-active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function toggleQueue() {
  const panel = document.getElementById('queue-panel');
  panel.classList.toggle('collapsed');
  document.getElementById('queue-btn').classList.toggle('active', !panel.classList.contains('collapsed'));
}

// ── HIGHLIGHT ────────────────────────────────────────────────
function highlightRow() {
  document.querySelectorAll('.song-row.playing').forEach(r => r.classList.remove('playing'));
  const cur = S.queue[S.idx];
  if (!cur) return;
  document.querySelectorAll('.song-row').forEach(r => {
    const i = parseInt(r.dataset.ci);
    if (!isNaN(i) && S.curSongs[i] && S.curSongs[i].filepath === cur.filepath) {
      r.classList.add('playing');
    }
  });
}

// ── VIEW HELPERS ──────────────────────────────────────────────
function setTitle(t)  { document.getElementById('content-title').textContent = t; }
function setBody(html) { document.getElementById('content-body').innerHTML = html; }
function setBack(fn) {
  S.backFn = fn;
  document.getElementById('back-btn').classList.toggle('hidden', !fn);
}
function setNavActive(view) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.pl-row').forEach(r => r.classList.remove('active'));
}
function setPlaylistActive(name) {
  document.querySelectorAll('.pl-row').forEach(r => {
    r.classList.toggle('active', r.dataset.pl === name);
  });
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
}

// ── SONG ROWS ────────────────────────────────────────────────
function renderSongRows(songs) {
  return songs.map((s, i) => {
    const title  = s.title  || s.filepath?.split('/').pop() || 'Unknown';
    const artist = s.artist || '';
    const album  = s.album  ? ` · ${s.album}` : '';
    const stars  = starsHtml(s.rating || 0);
    const art    = artUrl(s['album-art'], 's');
    return `<div class="song-row" data-ci="${i}">
      <div class="row-num">
        <span class="num-val">${i + 1}</span>
        <svg class="row-play-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
      </div>
      <div class="row-art">
        ${art ? `<img src="${art}" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml(' no-art-sm')">` : noArtHtml(' no-art-sm')}
      </div>
      <div class="song-info">
        <div class="song-title">${esc(title)}</div>
        <div class="song-sub">${esc(artist)}${esc(album)}</div>
      </div>
      <div class="row-stars" data-ci="${i}">${stars}</div>
      <div class="row-actions">
        <button class="row-act-btn add-btn" data-ci="${i}" title="Add to queue">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="row-act-btn ctx-btn" data-ci="${i}" title="More options">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

// Like renderSongRows but shows the file path under the subtitle — used in search results
function renderSongRowsWithPath(songs) {
  return songs.map((s, i) => {
    const title  = s.title  || s.filepath?.split('/').pop() || 'Unknown';
    const artist = s.artist || '';
    const album  = s.album  ? ` · ${s.album}` : '';
    const stars  = starsHtml(s.rating || 0);
    const art    = artUrl(s['album-art'], 's');
    // Show path without the filename at the end for ID3-matched songs,
    // or the full relative path for filename-matched songs
    const pathDir = s.filepath ? s.filepath.split('/').slice(0, -1).join('/') : '';
    return `<div class="song-row" data-ci="${i}">
      <div class="row-num">
        <span class="num-val">${i + 1}</span>
        <svg class="row-play-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
      </div>
      <div class="row-art">
        ${art ? `<img src="${art}" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml(' no-art-sm')">` : noArtHtml(' no-art-sm')}
      </div>
      <div class="song-info">
        <div class="song-title">${esc(title)}</div>
        ${artist || album ? `<div class="song-sub">${esc(artist)}${esc(album)}</div>` : ''}
        ${pathDir ? `<div class="song-path" title="${esc(s.filepath)}">📁 ${esc(pathDir)}</div>` : ''}
      </div>
      <div class="row-stars" data-ci="${i}">${stars}</div>
      <div class="row-actions">
        <button class="row-act-btn add-btn" data-ci="${i}" title="Add to queue">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="row-act-btn ctx-btn" data-ci="${i}" title="More options">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

function renderMostPlayedRows(songs, maxPlays) {
  return songs.map((s, i) => {
    const title  = s.title  || s.filepath?.split('/').pop() || 'Unknown';
    const artist = s.artist || '';
    const album  = s.album  ? ` · ${s.album}` : '';
    const stars  = starsHtml(s.rating || 0);
    const art    = artUrl(s['album-art'], 's');
    const plays  = s._playCount || 0;
    const pct    = maxPlays > 0 ? Math.max(3, Math.round((plays / maxPlays) * 100)) : 0;
    return `<div class="song-row mp-row" data-ci="${i}">
      <div class="row-num">
        <span class="num-val">${i + 1}</span>
        <svg class="row-play-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
      </div>
      <div class="row-art">
        ${art ? `<img src="${art}" loading="lazy" onerror="this.parentNode.innerHTML=noArtHtml(' no-art-sm')">` : noArtHtml(' no-art-sm')}
      </div>
      <div class="song-info">
        <div class="song-title">${esc(title)}</div>
        <div class="song-sub">${esc(artist)}${esc(album)}</div>
      </div>
      <div class="mp-count-cell">
        <div class="mp-bar-track"><div class="mp-bar-fill" style="width:${pct}%"></div></div>
        <span class="mp-num">${plays}</span>
      </div>
      <div class="row-stars" data-ci="${i}">${stars}</div>
      <div class="row-actions">
        <button class="row-act-btn add-btn" data-ci="${i}" title="Add to queue">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="row-act-btn ctx-btn" data-ci="${i}" title="More options">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

function showMostPlayed(songs) {
  S.curSongs = songs;
  document.getElementById('play-all-btn').onclick = () => {
    if (songs.length) { Player.setQueue(songs, 0); toast(`Playing ${songs.length} songs`); }
  };
  document.getElementById('add-all-btn').onclick = () => {
    if (songs.length) { Player.addAll(songs); }
  };
  if (!songs.length) { setBody('<div class="empty-state">No songs found</div>'); return; }
  const maxPlays = Math.max(...songs.map(s => s._playCount || 0));
  const body = document.getElementById('content-body');
  body.innerHTML = `<div class="song-list">${renderMostPlayedRows(songs, maxPlays)}</div>`;
  attachSongListEvents(body, songs);
  highlightRow();
}

function attachSongListEvents(container, songs) {
  container.querySelectorAll('.song-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.add-btn') || e.target.closest('.ctx-btn') || e.target.closest('.row-stars')) return;
      const i = parseInt(row.dataset.ci);
      if (songs[i]) Player.queueAndPlay(songs[i]);
    });
  });
  container.querySelectorAll('.add-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.ci);
      if (songs[i]) Player.addSong(songs[i]);
    });
  });
  container.querySelectorAll('.ctx-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.ci);
      S.ctxSong = songs[i];
      showCtxMenu(e.clientX, e.clientY);
    });
  });
  container.querySelectorAll('.row-stars').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(el.dataset.ci);
      if (songs[i]) showRatePanel(e.clientX, e.clientY, songs[i]);
    });
  });
}

function showSongs(songs, title) {
  S.curSongs = songs;
  document.getElementById('play-all-btn').onclick = () => {
    if (songs.length) { Player.setQueue(songs, 0); toast(`Playing ${songs.length} songs`); }
  };
  document.getElementById('add-all-btn').onclick = () => {
    if (songs.length) { Player.addAll(songs); }
  };
  if (!songs.length) { setBody('<div class="empty-state">No songs found</div>'); return; }
  const body = document.getElementById('content-body');
  body.innerHTML = `<div class="song-list">${renderSongRows(songs)}</div>`;
  attachSongListEvents(body, songs);
  highlightRow();
}

// ── CONTEXT MENU ─────────────────────────────────────────────
function showCtxMenu(x, y) {
  const menu = document.getElementById('ctx-menu');
  menu.classList.remove('hidden');
  // Show remove-from-playlist only when inside a playlist view
  const inPlaylist = typeof S.view === 'string' && S.view.startsWith('playlist:');
  menu.querySelector('.ctx-remove-pl').classList.toggle('hidden', !inPlaylist);
  // Keep within viewport
  const mw = 180, mh = 200;
  const left = Math.min(x, window.innerWidth  - mw - 8);
  const top  = Math.min(y, window.innerHeight - mh - 8);
  menu.style.left = left + 'px';
  menu.style.top  = top  + 'px';
}
function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.add('hidden');
  hideRatePanel();
}

function showRatePanel(x, y, song) {
  const panel = document.getElementById('rate-panel');
  panel.classList.remove('hidden');
  panel.dataset.fp = song.filepath;
  const currentStars = Math.round((song.rating || 0) / 2);
  // highlight current rating
  panel.querySelectorAll('.rate-stars span').forEach((s, i) => {
    s.classList.toggle('lit', i < currentStars);
  });
  const pw = 180, ph = 80;
  const left = Math.min(x + 4, window.innerWidth  - pw - 8);
  const top  = Math.min(y, window.innerHeight - ph - 8);
  panel.style.left = left + 'px';
  panel.style.top  = top  + 'px';
}
function hideRatePanel() {
  document.getElementById('rate-panel').classList.add('hidden');
}

// ── NOW PLAYING MODAL ──────────────────────────────────────────
function renderNPModal() {
  const s = S.queue[S.idx];
  if (!s) return;
  const u = artUrl(s['album-art'], 'l');
  // Blurred glow background
  const blurEl = document.getElementById('np-art-blur');
  if (blurEl) blurEl.style.backgroundImage = u ? `url(${u})` : '';
  // Square art
  document.getElementById('np-art').innerHTML = u
    ? `<img src="${u}" alt="" onerror="this.parentNode.innerHTML=noArtHtml()">`
    : noArtHtml();
  document.getElementById('np-title').textContent  = s.title  || s.filepath?.split('/').pop() || '—';
  document.getElementById('np-artist').textContent = s.artist || '';
  const sub = [s.album, s.year].filter(Boolean).join(' · ');
  const albumEl = document.getElementById('np-album');
  albumEl.textContent = sub;
  albumEl.classList.toggle('hidden', !sub);
  const filled = Math.round((s.rating || 0) / 2);
  document.querySelectorAll('#np-rate-stars span').forEach((star, i) => {
    star.classList.toggle('lit', i < filled);
  });
  document.getElementById('np-icon-play').classList.toggle('hidden', !audioEl.paused);
  document.getElementById('np-icon-pause').classList.toggle('hidden', audioEl.paused);
  if (audioEl.duration) {
    const pct = (audioEl.currentTime / audioEl.duration) * 100;
    document.getElementById('np-prog-fill').style.width   = pct + '%';
    document.getElementById('np-time-cur').textContent    = fmt(audioEl.currentTime);
    document.getElementById('np-time-total').textContent  = fmt(audioEl.duration);
  }
  // Full metadata table
  function mv(val) {
    return val != null ? `<span class="np-meta-v">${esc(String(val))}</span>` : `<span class="np-meta-v dim">—</span>`;
  }
  const starStr = s.rating ? `${'\u2605'.repeat(Math.round(s.rating/2))}${'\u2606'.repeat(5-Math.round(s.rating/2))}` : null;
  const rgStr   = s.replaygain != null ? `${s.replaygain > 0 ? '+' : ''}${Number(s.replaygain).toFixed(2)} dB` : null;
  const rows = [
    ['Title',       s.title],
    ['Artist',      s.artist],
    ['Album',       s.album],
    ['Year',        s.year],
    ['Genre',       s.genre],
    ['Track',       s.track],
    ['Disc',        s.disk],
    ['Rating',      starStr],
    ['Replay Gain', rgStr],
  ];
  document.getElementById('np-meta').innerHTML = rows.map(([k, v]) =>
    `<span class="np-meta-k">${k}</span>${mv(v)}`
  ).join('');
  // Filepath block — full path with directory dimmed and filename highlighted
  const fpEl = document.getElementById('np-filepath');
  if (s.filepath) {
    const parts = s.filepath.split('/');
    const fname = parts.pop();
    const dirParts = parts.filter(Boolean);
    const dirHtml = dirParts.map(p => `<span class="np-fp-dir">${esc(p)}</span><span class="np-fp-sep">/</span>`).join('');
    fpEl.innerHTML = `<span class="np-fp-label">File Path</span><div class="np-fp-path">${dirHtml}<span class="np-fp-file">${esc(fname)}</span></div>`;
    fpEl.classList.remove('hidden');
  } else {
    fpEl.innerHTML = '';
    fpEl.classList.add('hidden');
  }
}
function showNPModal() {
  if (!S.queue[S.idx]) return;
  renderNPModal();
  document.getElementById('np-modal').classList.remove('hidden');
}
function hideNPModal() {
  document.getElementById('np-modal').classList.add('hidden');
}

// ── EQUALIZER CONFIG ──────────────────────────────────────────
const EQ_BANDS = [
  { freq:    60, type: 'lowshelf',  label: '60',   q: 1.0 },
  { freq:   170, type: 'peaking',   label: '170',  q: 1.4 },
  { freq:   310, type: 'peaking',   label: '310',  q: 1.4 },
  { freq:   600, type: 'peaking',   label: '600',  q: 1.4 },
  { freq:  1000, type: 'peaking',   label: '1k',   q: 1.4 },
  { freq:  3000, type: 'peaking',   label: '3k',   q: 1.4 },
  { freq:  6000, type: 'peaking',   label: '6k',   q: 1.4 },
  { freq: 14000, type: 'highshelf', label: '14k',  q: 1.0 },
];
const EQ_PRESETS = {
  'Flat':       [  0,  0,  0,  0,  0,  0,  0,  0],
  'Bass Boost': [  6,  4,  2,  0,  0,  0,  0,  0],
  'Classical':  [  0,  0,  0,  0,  0,  0, -2, -4],
  'Vocal':      [ -2, -2,  0,  2,  4,  2,  0, -2],
  'Electronic': [  4,  2,  0, -2,  0,  2,  4,  2],
  'Rock':       [  2,  2,  0, -1,  0,  1,  3,  2],
};

// ── MINI SPECTRUM (player bar) ──────────────────────────────
const MINI_SPEC = (() => {
  let rafId = null;

  function draw() {
    const canvas = document.getElementById('mini-spec');
    if (!canvas) return;
    // Only run when audio context is ready
    if (!audioCtx || !analyserL || !analyserR) { rafId = requestAnimationFrame(draw); return; }
    const aL = analyserL;
    const aR = analyserR;

    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.clientWidth  * dpr;
    const H   = canvas.clientHeight * dpr;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

    const ctx = canvas.getContext('2d');
    const BARS = 80;  // per channel
    const GAP  = 1.5 * dpr;
    const cg   = 2 * dpr;          // centre divider
    const hw   = (W - cg) / 2;
    const barW = (hw - GAP * (BARS - 1)) / BARS;
    const baseline = H;  // bottom of canvas — bars grow upward

    ctx.clearRect(0, 0, W, H);

    const dL = new Uint8Array(aL.frequencyBinCount);
    const dR = new Uint8Array(aR.frequencyBinCount);
    aL.getByteFrequencyData(dL);
    aR.getByteFrequencyData(dR);

    function logBin(i, binCount) {
      const freq = Math.pow(2, (Math.log2(20) + (Math.log2(20000) - Math.log2(20)) * i / BARS));
      return Math.min(Math.floor(freq / (audioCtx.sampleRate / 2) * binCount), binCount - 1);
    }

    // Draw one side; reverse = true mirrors freq axis
    function side(data, startX, reverse) {
      for (let i = 0; i < BARS; i++) {
        const bi  = reverse ? (BARS - 1 - i) : i;
        const v   = data[logBin(bi, data.length)] / 255;
        const barH = Math.max(1, v * baseline * 0.92);
        const x   = startX + i * (barW + GAP);
        const hue = (1 - v) * 200;
        const r   = Math.min(barW * .4, 2.5 * dpr);

        const grd = ctx.createLinearGradient(0, baseline, 0, baseline - barH);
        grd.addColorStop(0, `hsla(${hue},100%,48%,.85)`);
        grd.addColorStop(1, `hsla(${hue+80},100%,72%,.75)`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.roundRect(x, baseline - barH, barW, barH, [r, r, 0, 0]);
        ctx.fill();
      }
    }

    // L: bass left → treble at centre
    side(dL, 0, false);
    // centre gap
    ctx.fillStyle = 'rgba(255,255,255,.04)';
    ctx.fillRect(hw, 0, cg, H);
    // R: treble at centre → bass right (mirrored)
    side(dR, hw + cg, true);

    rafId = requestAnimationFrame(draw);
  }

  return {
    start() { if (!rafId) draw(); },
    stop()  { if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
               const c = document.getElementById('mini-spec');
               if (c) { const ctx = c.getContext('2d'); ctx.clearRect(0,0,c.width,c.height); } },
  };
})();

// ── BUTTERCHURN VISUALIZER + SPECTRUM ────────────────────────
const VIZ = (() => {
  let visualizer = null, analyserNode = null;
  // analyserL, analyserR, audioCtx are module-scope (shared with MINI_SPEC)
  let presets = {}, presetKeys = [], presetHistory = [], presetIndex = 0;
  let cycleTimer = null, frameId = null;
  const CYCLE_MS = 15000;

  // Spectrum state
  let specMode = false;           // false = butterchurn, true = spectrum
  let specFrameId = null;
  let peakL = [], peakVelL = [];  // peak state — left channel
  let peakR = [], peakVelR = [];  // peak state — right channel

  function ensureAudio() {
    if (audioCtx) { audioCtx.resume(); return; }
    audioCtx    = new (window.AudioContext || window.webkitAudioContext)();
    // Auto-resume if the browser suspends the context (energy-saving policy)
    // — without this a suspended context causes ~0.5 s silence mid-song.
    audioCtx.addEventListener('statechange', () => {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    });
    // Main analyser for butterchurn
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.82;
    // Per-channel analysers for spectrum
    analyserL = audioCtx.createAnalyser();
    analyserL.fftSize = 2048;
    analyserL.smoothingTimeConstant = 0.82;
    analyserR = audioCtx.createAnalyser();
    analyserR.fftSize = 2048;
    analyserR.smoothingTimeConstant = 0.82;
    _audioGain = audioCtx.createGain();
    _audioGain.gain.value = 1.25;
    const gain     = _audioGain;
    const splitter = audioCtx.createChannelSplitter(2);
    const src      = audioCtx.createMediaElementSource(audioEl);
    // Build 8-band EQ filter chain and apply saved settings
    const _savedGains   = JSON.parse(localStorage.getItem('ms2_eq')    || 'null') || Array(8).fill(0);
    const _savedEnabled = localStorage.getItem('ms2_eq_on') !== 'false';
    eqFilters = EQ_BANDS.map((b, i) => {
      const f = audioCtx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.freq;
      if (b.type === 'peaking') f.Q.value = b.q;
      f.gain.value = _savedEnabled ? (_savedGains[i] || 0) : 0;
      return f;
    });
    // Wire: src → gain → eq[0..7] → analyserNode + splitter → destinations
    src.connect(gain);
    let _node = gain;
    for (const f of eqFilters) { _node.connect(f); _node = f; }
    _node.connect(analyserNode);      // butterchurn (mono mix)
    _node.connect(splitter);          // split into L + R
    splitter.connect(analyserL, 0);   // left  channel
    splitter.connect(analyserR, 1);   // right channel
    analyserNode.connect(audioCtx.destination);
  }

  function setPresetLabel() {
    const el = document.getElementById('viz-preset-name');
    if (!el) return;
    const n = presetKeys[presetIndex] || '';
    el.textContent = n.length > 65 ? n.substring(0, 65) + '\u2026' : n;
  }

  function loadPreset(blend) {
    if (!visualizer || !presetKeys.length) return;
    visualizer.loadPreset(presets[presetKeys[presetIndex]], blend ?? 5.7);
    setPresetLabel();
  }

  function startRender() {
    function frame() { frameId = requestAnimationFrame(frame); visualizer.render(); }
    frameId = requestAnimationFrame(frame);
  }

  function initViz(canvas) {
    if (!window.butterchurn) { toast('Visualizer loading\u2026 try again in a moment'); return; }
    presets = {};
    if (window.butterchurnPresets)      Object.assign(presets, butterchurnPresets.getPresets());
    if (window.butterchurnPresetsExtra) Object.assign(presets, butterchurnPresetsExtra.getPresets());
    presetKeys  = Object.keys(presets);
    presetIndex = Math.floor(Math.random() * presetKeys.length);
    canvas.width  = canvas.clientWidth  || window.innerWidth;
    canvas.height = canvas.clientHeight || window.innerHeight;
    visualizer = butterchurn.default.createVisualizer(audioCtx, canvas, {
      width: canvas.width, height: canvas.height,
      pixelRatio: window.devicePixelRatio || 1, textureRatio: 1,
    });
    visualizer.connectAudio(analyserNode);
    loadPreset(0);
    startRender();
    cycleTimer = setInterval(() => {
      presetHistory.push(presetIndex);
      presetIndex = Math.floor(Math.random() * presetKeys.length);
      loadPreset(2.7);
    }, CYCLE_MS);
  }

  // ── SPECTRUM RENDERER — 7 modes, click canvas to cycle ────
  const SPEC_MODES = ['Bar Spectrum','Mirror Bars','Radial','Oscilloscope','Waterfall','VU Needles','Lissajous'];
  let specStyleIdx = parseInt(localStorage.getItem('ms2_spec_style') || '0') % SPEC_MODES.length;
  let specLabelAlpha = 0;         // fade-out alpha for mode label overlay
  let waterfallRows = null;       // pixel row buffer for waterfall mode
  let waterfallPos  = 0;

  function startSpectrum(canvas) {
    const ctx = canvas.getContext('2d');
    const BAR_COUNT = 96;
    const GAP = 2;
    const CENTRE_GAP = 3;

    // ---- shared peak arrays (reused across mode switches) ----
    function ensurePeaks(arr, vel, n) {
      while (arr.length < n) { arr.push(0); vel.push(0); }
      arr.length = n; vel.length = n;
    }
    ensurePeaks(peakL, peakVelL, BAR_COUNT);
    ensurePeaks(peakR, peakVelR, BAR_COUNT);

    const dataL  = new Uint8Array(analyserL.frequencyBinCount);
    const dataR  = new Uint8Array(analyserR.frequencyBinCount);
    const waveL  = new Uint8Array(analyserL.fftSize);
    const waveR  = new Uint8Array(analyserR.fftSize);

    function resizeCanvas() {
      const nw = canvas.clientWidth  * (window.devicePixelRatio || 1);
      const nh = canvas.clientHeight * (window.devicePixelRatio || 1);
      if (canvas.width !== nw || canvas.height !== nh) {
        canvas.width = nw; canvas.height = nh;
        waterfallRows = null; // reset waterfall on resize
      }
    }

    function lerp(a, b, t) { return a + (b - a) * t; }
    function barBin(i, total, binCount) {
      const freq = Math.pow(2, lerp(Math.log2(20), Math.log2(20000), i / total));
      return Math.min(Math.floor(freq / (audioCtx.sampleRate / 2) * binCount), binCount - 1);
    }
    function barHue(v) { return (1 - v) * 200; }

    // ── shared background ──
    function drawBg(W, H) {
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#06060e'); bg.addColorStop(1, '#0d0d1a');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    }

    // ── shared channel label ──
    function drawLabels(W, H, dpr, y, lx, rx) {
      ctx.shadowBlur = 0;
      const fs = Math.max(18, 22 * dpr);
      ctx.font = `700 ${fs}px system-ui,sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText('L', lx, y); ctx.fillText('R', rx, y);
    }

    // ── shared bar-channel renderer ──
    function drawBarChannel(data, peaks, vels, px, pw, baseline, dpr, reverse) {
      const gap  = GAP * dpr;
      const barW = (pw - gap * (BAR_COUNT - 1)) / BAR_COUNT;
      for (let i = 0; i < BAR_COUNT; i++) {
        const bi   = reverse ? (BAR_COUNT - 1 - i) : i;
        const v    = data[barBin(bi, BAR_COUNT, data.length)] / 255;
        const barH = v * baseline;
        const x    = px + i * (barW + gap);
        const hue  = barHue(v);
        const grd  = ctx.createLinearGradient(0, baseline, 0, baseline - barH);
        grd.addColorStop(0,   `hsla(${hue},100%,50%,.95)`);
        grd.addColorStop(0.6, `hsla(${hue+40},100%,62%,.9)`);
        grd.addColorStop(1,   `hsla(${hue+80},100%,78%,.85)`);
        ctx.shadowColor = `hsla(${hue},100%,58%,.55)`; ctx.shadowBlur = 10*dpr;
        ctx.fillStyle = grd;
        const r = Math.min(barW*.35, 4*dpr);
        ctx.beginPath(); ctx.roundRect(x, baseline-barH, barW, barH, [r,r,0,0]); ctx.fill();
        if (barH > peaks[i]) { peaks[i]=barH; vels[i]=0; }
        else { vels[i]+=0.35*dpr; peaks[i]-=vels[i]; if(peaks[i]<0)peaks[i]=0; }
        if (peaks[i]>2) {
          ctx.shadowBlur=6*dpr; ctx.fillStyle=`hsla(${hue+60},100%,90%,.95)`;
          ctx.fillRect(x, baseline-peaks[i]-3*dpr, barW, 2*dpr);
        }
        ctx.shadowBlur=0;
        const rg = ctx.createLinearGradient(0,baseline,0,baseline+barH*.4);
        rg.addColorStop(0,`hsla(${hue},100%,50%,.20)`); rg.addColorStop(1,`hsla(${hue},100%,50%,0)`);
        ctx.fillStyle=rg; ctx.beginPath(); ctx.roundRect(x,baseline,barW,barH*.4,[0,0,r,r]); ctx.fill();
      }
    }

    // ══ MODE 0 — Bar Spectrum ══════════════════════════════════
    function drawBarSpectrum(W, H, dpr) {
      drawBg(W, H);
      ctx.shadowBlur=0; ctx.strokeStyle='rgba(255,255,255,.03)'; ctx.lineWidth=1;
      for(let g=.25;g<1;g+=.25){ctx.beginPath();ctx.moveTo(0,H*g);ctx.lineTo(W,H*g);ctx.stroke();}
      const cg=CENTRE_GAP*dpr, hw=(W-cg)/2, bl=H*.85;
      drawBarChannel(dataL, peakL, peakVelL, 0,       hw, bl, dpr, false);
      ctx.shadowBlur=0; ctx.fillStyle='rgba(255,255,255,.06)'; ctx.fillRect(hw,0,cg,H);
      drawBarChannel(dataR, peakR, peakVelR, hw+cg, hw, bl, dpr, true);
      ctx.shadowBlur=0; ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(0,bl);ctx.lineTo(W,bl);ctx.stroke();
      drawLabels(W,H,dpr, bl+28*dpr, hw/2, hw+cg+hw/2);
    }

    // ══ MODE 1 — Mirror Bars ══════════════════════════════════
    function drawMirrorBars(W, H, dpr) {
      drawBg(W, H);
      const cg=CENTRE_GAP*dpr, hw=(W-cg)/2, cy=H/2;
      const gap=GAP*dpr, barW=(hw-gap*(BAR_COUNT-1))/BAR_COUNT;
      // draw both channels mirrored up+down
      [[dataL,0],[dataR,hw+cg]].forEach(([data,px],ci)=>{
        for(let i=0;i<BAR_COUNT;i++){
          const v=data[barBin(i,BAR_COUNT,data.length)]/255;
          const half=v*cy*.9;
          const x=px+i*(barW+gap);
          const hue=barHue(v);
          const grdU=ctx.createLinearGradient(0,cy,0,cy-half);
          grdU.addColorStop(0,`hsla(${hue},100%,50%,.9)`);
          grdU.addColorStop(1,`hsla(${hue+80},100%,78%,.85)`);
          ctx.shadowColor=`hsla(${hue},100%,55%,.5)`; ctx.shadowBlur=8*dpr;
          ctx.fillStyle=grdU; ctx.beginPath();
          ctx.roundRect(x,cy-half,barW,half,[Math.min(barW*.4,4*dpr),Math.min(barW*.4,4*dpr),0,0]);
          ctx.fill();
          const grdD=ctx.createLinearGradient(0,cy,0,cy+half);
          grdD.addColorStop(0,`hsla(${hue},100%,50%,.9)`);
          grdD.addColorStop(1,`hsla(${hue+80},100%,78%,.1)`);
          ctx.fillStyle=grdD; ctx.beginPath();
          ctx.roundRect(x,cy,barW,half,[0,0,Math.min(barW*.4,4*dpr),Math.min(barW*.4,4*dpr)]);
          ctx.fill();
        }
      });
      ctx.shadowBlur=0; ctx.fillStyle='rgba(255,255,255,.06)'; ctx.fillRect(hw,0,cg,H);
      ctx.strokeStyle='rgba(255,255,255,.12)'; ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(0,cy);ctx.lineTo(W,cy);ctx.stroke();
      drawLabels(W,H,dpr, H*.92, hw/2, hw+cg+hw/2);
    }

    // ══ MODE 2 — Radial ═══════════════════════════════════════
    function drawRadial(W, H, dpr) {
      drawBg(W, H);
      const cx=W/2, cy=H/2, innerR=Math.min(W,H)*.12, outerMax=Math.min(W,H)*.47;
      const BARS=120;
      ctx.shadowBlur=0;
      // inner circle glow
      const cGrd=ctx.createRadialGradient(cx,cy,0,cx,cy,innerR);
      cGrd.addColorStop(0,'rgba(130,60,255,.35)'); cGrd.addColorStop(1,'rgba(130,60,255,0)');
      ctx.fillStyle=cGrd; ctx.beginPath(); ctx.arc(cx,cy,innerR,0,Math.PI*2); ctx.fill();
      // L = left half (π..2π), R = right half (0..π)
      [[dataL,Math.PI,2*Math.PI],[dataR,0,Math.PI]].forEach(([data,aStart,aEnd])=>{
        for(let i=0;i<BARS;i++){
          const v=data[barBin(i,BARS,data.length)]/255;
          const angle=lerp(aStart,aEnd,(i+.5)/BARS);
          const barLen=(outerMax-innerR)*v;
          const r1=innerR+2*dpr, r2=innerR+barLen;
          if(r2<=r1) continue;
          const hue=barHue(v);
          ctx.shadowColor=`hsla(${hue},100%,55%,.4)`; ctx.shadowBlur=8*dpr;
          ctx.strokeStyle=`hsla(${hue},100%,62%,.9)`; ctx.lineWidth=Math.max(2,W/600*dpr);
          ctx.beginPath();
          ctx.moveTo(cx+Math.cos(angle)*r1, cy+Math.sin(angle)*r1);
          ctx.lineTo(cx+Math.cos(angle)*r2, cy+Math.sin(angle)*r2);
          ctx.stroke();
        }
      });
      ctx.shadowBlur=0;
      // L / R labels
      const fs=Math.max(18,22*dpr);
      ctx.font=`700 ${fs}px system-ui,sans-serif`; ctx.textAlign='center';
      ctx.fillStyle='rgba(255,255,255,.45)';
      ctx.fillText('L',cx-innerR*1.8,cy); ctx.fillText('R',cx+innerR*1.8,cy);
    }

    // ══ MODE 3 — Oscilloscope ═════════════════════════════════
    function drawOscilloscope(W, H, dpr) {
      ctx.fillStyle='rgba(0,0,0,.88)'; ctx.fillRect(0,0,W,H);
      [[waveL,'#00ff88',H*.28],[waveR,'#00aaff',H*.72]].forEach(([wave,colour,midY])=>{
        ctx.shadowColor=colour; ctx.shadowBlur=14*dpr;
        ctx.strokeStyle=colour; ctx.lineWidth=1.5*dpr;
        ctx.beginPath();
        const sliceW=W/wave.length;
        for(let i=0;i<wave.length;i++){
          const x=i*sliceW;
          const y=midY+((wave[i]/128)-1)*H*.2;
          i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
        }
        ctx.stroke();
        // channel label
        ctx.shadowBlur=0; ctx.font=`700 ${Math.max(14,16*dpr)}px system-ui,sans-serif`;
        ctx.textAlign='left'; ctx.fillStyle=colour+'aa';
        ctx.fillText(colour==='#00ff88'?'L':'R', 12*dpr, midY-H*.22);
      });
    }

    // ══ MODE 4 — Waterfall / Spectrogram ═════════════════════
    function drawWaterfall(W, H, dpr) {
      const BINS=256;
      if (!waterfallRows || waterfallRows.width!==W) {
        waterfallRows=ctx.createImageData(W, H);
        waterfallPos=0;
      }
      // shift image down one row
      const rowBytes=W*4;
      waterfallRows.data.copyWithin(rowBytes, 0, W*H*4-rowBytes);
      // write new top row using average of L+R
      for(let x=0;x<W;x++){
        const i=Math.floor(x/W*BINS);
        const vL=dataL[Math.min(i,dataL.length-1)]/255;
        const vR=dataR[Math.min(i,dataR.length-1)]/255;
        const v=(vL+vR)/2;
        const hue=barHue(v)*1.1;
        // hsla→rgb inline (fast approximation)
        const l=0.1+v*0.55, s=1;
        const a=v>0.02?1:0;
        // simple hue→rgb
        function hsl2rgb(h,sl,ll){
          h=((h%360)+360)%360; const c=(1-Math.abs(2*ll-1))*sl;
          const x2=c*(1-Math.abs((h/60)%2-1)); const m=ll-c/2;
          let r=0,g=0,b=0;
          if(h<60){r=c;g=x2;}else if(h<120){r=x2;g=c;}
          else if(h<180){g=c;b=x2;}else if(h<240){g=x2;b=c;}
          else if(h<300){r=x2;b=c;}else{r=c;b=x2;}
          return[(r+m)*255,(g+m)*255,(b+m)*255];
        }
        const [r,g,b]=hsl2rgb(hue,s,l);
        const base=x*4;
        waterfallRows.data[base]=r; waterfallRows.data[base+1]=g;
        waterfallRows.data[base+2]=b; waterfallRows.data[base+3]=a*255;
      }
      ctx.clearRect(0,0,W,H);
      ctx.putImageData(waterfallRows,0,0);
      // time axis label
      ctx.shadowBlur=0; ctx.font=`${Math.max(11,13*dpr)}px system-ui,sans-serif`;
      ctx.textAlign='right'; ctx.fillStyle='rgba(255,255,255,.3)';
      ctx.fillText('L+R Spectrogram', W-10*dpr, H-10*dpr);
    }

    // ══ MODE 5 — Analog VU Needles ════════════════════════════
    function drawVUNeedles(W, H, dpr) {
      drawBg(W, H);
      const channels=[{data:dataL,label:'L',cx:W*.27},{data:dataR,label:'R',cx:W*.73}];
      const cy=H*.55, radius=Math.min(W*.22, H*.52);
      const arcStart=Math.PI*.75, arcEnd=Math.PI*2.25; // 135°..405° (270° sweep)
      channels.forEach(({data,label,cx})=>{
        // compute RMS-like level
        let sum=0; for(let i=0;i<data.length;i++) sum+=data[i]*data[i];
        const rms=Math.sqrt(sum/data.length)/255;
        // peak hold
        const key=label==='L'?'_vuPkL':'_vuPkR';
        const keyV=label==='L'?'_vuPkVL':'_vuPkVR';
        if(!startSpectrum[key]) startSpectrum[key]=0;
        if(!startSpectrum[keyV]) startSpectrum[keyV]=0;
        if(rms>startSpectrum[key]){startSpectrum[key]=rms;startSpectrum[keyV]=0;}
        else{startSpectrum[keyV]+=0.002; startSpectrum[key]-=startSpectrum[keyV]; if(startSpectrum[key]<0)startSpectrum[key]=0;}
        const pk=startSpectrum[key];

        // arc background
        ctx.shadowBlur=0;
        ctx.strokeStyle='rgba(255,255,255,.06)'; ctx.lineWidth=18*dpr;
        ctx.lineCap='round';
        ctx.beginPath(); ctx.arc(cx,cy,radius,arcStart,arcEnd); ctx.stroke();

        // coloured arc fill
        const fillEnd=arcStart+(arcEnd-arcStart)*rms;
        const hue=barHue(rms);
        const arcGrd=ctx.createConicalGradient?null:null; // fallback: solid
        ctx.shadowColor=`hsla(${hue},100%,55%,.5)`; ctx.shadowBlur=16*dpr;
        ctx.strokeStyle=`hsla(${hue},100%,55%,.9)`; ctx.lineWidth=14*dpr;
        ctx.beginPath(); ctx.arc(cx,cy,radius,arcStart,fillEnd); ctx.stroke();

        // peak indicator tick
        const pkAngle=arcStart+(arcEnd-arcStart)*pk;
        ctx.shadowBlur=10*dpr; ctx.strokeStyle='rgba(255,255,255,.9)'; ctx.lineWidth=3*dpr;
        ctx.beginPath();
        ctx.moveTo(cx+Math.cos(pkAngle)*(radius-10*dpr), cy+Math.sin(pkAngle)*(radius-10*dpr));
        ctx.lineTo(cx+Math.cos(pkAngle)*(radius+10*dpr), cy+Math.sin(pkAngle)*(radius+10*dpr));
        ctx.stroke();

        // needle
        const needleAngle=arcStart+(arcEnd-arcStart)*rms;
        ctx.shadowColor='rgba(255,200,50,.7)'; ctx.shadowBlur=12*dpr;
        ctx.strokeStyle='rgba(255,220,80,.95)'; ctx.lineWidth=2.5*dpr;
        ctx.lineCap='round';
        ctx.beginPath();
        ctx.moveTo(cx,cy);
        ctx.lineTo(cx+Math.cos(needleAngle)*radius*.92, cy+Math.sin(needleAngle)*radius*.92);
        ctx.stroke();

        // centre pivot dot
        ctx.shadowBlur=8*dpr; ctx.fillStyle='rgba(255,220,80,.9)';
        ctx.beginPath(); ctx.arc(cx,cy,6*dpr,0,Math.PI*2); ctx.fill();

        // db labels along arc
        ctx.shadowBlur=0; ctx.fillStyle='rgba(255,255,255,.35)';
        ctx.font=`${Math.max(9,10*dpr)}px system-ui,sans-serif`; ctx.textAlign='center';
        ['-40','-20','-10','-6','-3','0','+3'].forEach((db,di,arr)=>{
          const t=di/(arr.length-1);
          const a=arcStart+(arcEnd-arcStart)*t;
          const lx=cx+Math.cos(a)*(radius+16*dpr), ly=cy+Math.sin(a)*(radius+16*dpr);
          ctx.fillText(db,lx,ly);
        });

        // channel label
        ctx.font=`700 ${Math.max(20,26*dpr)}px system-ui,sans-serif`;
        ctx.fillStyle='rgba(255,255,255,.5)'; ctx.textAlign='center';
        ctx.fillText(label, cx, cy+radius*.45);

        // dB value
        const db=rms>0?Math.max(-60,20*Math.log10(rms)):'-∞';
        ctx.font=`${Math.max(13,15*dpr)}px system-ui,sans-serif`;
        ctx.fillStyle='rgba(255,220,80,.7)';
        ctx.fillText(typeof db==='number'?db.toFixed(1)+' dB':db, cx, cy+radius*.62);
      });
    }

    // ══ MODE 6 — Lissajous / XY Phase Scope ══════════════════
    function drawLissajous(W, H, dpr) {
      ctx.fillStyle='rgba(0,0,0,.85)'; ctx.fillRect(0,0,W,H);
      const cx=W/2, cy=H/2, r=Math.min(W,H)*.42;
      // crosshair
      ctx.shadowBlur=0; ctx.strokeStyle='rgba(255,255,255,.07)'; ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(cx-r,cy);ctx.lineTo(cx+r,cy);ctx.stroke();
      ctx.beginPath();ctx.moveTo(cx,cy-r);ctx.lineTo(cx,cy+r);ctx.stroke();
      // circle guide
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke();

      const N=waveL.length;
      ctx.lineWidth=1.5*dpr;
      ctx.shadowColor='rgba(120,80,255,.6)'; ctx.shadowBlur=8*dpr;
      ctx.beginPath();
      for(let i=0;i<N;i++){
        const x=cx + ((waveL[i]-128)/128)*r;
        const y=cy - ((waveR[i]-128)/128)*r;
        i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
      }
      // colour by position using a gradient stroke
      const lGrd=ctx.createLinearGradient(cx-r,cy,cx+r,cy);
      lGrd.addColorStop(0,'rgba(0,200,255,.7)');
      lGrd.addColorStop(.5,'rgba(160,80,255,.8)');
      lGrd.addColorStop(1,'rgba(255,80,160,.7)');
      ctx.strokeStyle=lGrd; ctx.stroke();

      ctx.shadowBlur=0; ctx.font=`${Math.max(11,13*dpr)}px system-ui,sans-serif`;
      ctx.fillStyle='rgba(255,255,255,.3)'; ctx.textAlign='center';
      ctx.fillText('L → X   R → Y   Phase Correlation',cx,H-14*dpr);
    }

    // ── mode-name flash overlay ──────────────────────────────
    function drawModeLabel(W, H, dpr) {
      if (specLabelAlpha <= 0) return;
      ctx.shadowBlur=0;
      const fs=Math.max(22,28*dpr);
      ctx.font=`700 ${fs}px system-ui,sans-serif`;
      ctx.textAlign='center';
      ctx.fillStyle=`rgba(255,255,255,${specLabelAlpha.toFixed(2)})`;
      ctx.fillText(SPEC_MODES[specStyleIdx], W/2, H/2);
      specLabelAlpha=Math.max(0, specLabelAlpha-0.012);
    }

    // ── main render loop ────────────────────────────────────
    function drawFrame() {
      specFrameId = requestAnimationFrame(drawFrame);
      resizeCanvas();
      analyserL.getByteFrequencyData(dataL);
      analyserR.getByteFrequencyData(dataR);
      analyserL.getByteTimeDomainData(waveL);
      analyserR.getByteTimeDomainData(waveR);
      const W=canvas.width, H=canvas.height, dpr=window.devicePixelRatio||1;
      switch(specStyleIdx) {
        case 0: drawBarSpectrum(W,H,dpr); break;
        case 1: drawMirrorBars(W,H,dpr);  break;
        case 2: drawRadial(W,H,dpr);      break;
        case 3: drawOscilloscope(W,H,dpr);break;
        case 4: drawWaterfall(W,H,dpr);   break;
        case 5: drawVUNeedles(W,H,dpr);   break;
        case 6: drawLissajous(W,H,dpr);   break;
      }
      drawModeLabel(W,H,dpr);
    }

    // click anywhere on spectrum canvas to cycle modes
    canvas._specClick = () => {
      specStyleIdx = (specStyleIdx + 1) % SPEC_MODES.length;
      localStorage.setItem('ms2_spec_style', specStyleIdx);
      specLabelAlpha = 1.0;
      peakL.fill(0); peakVelL.fill(0);
      peakR.fill(0); peakVelR.fill(0);
      waterfallRows = null;
    };
    canvas.removeEventListener('click', canvas._specClick);
    canvas.addEventListener('click', canvas._specClick);

    drawFrame();
  }

  function stopSpectrum() {
    if (specFrameId) { cancelAnimationFrame(specFrameId); specFrameId = null; }
  }

  function applyMode() {
    const bcCanvas   = document.getElementById('viz-canvas');
    const spCanvas   = document.getElementById('spec-canvas');
    const label      = document.getElementById('viz-mode-label');
    const prevBtn    = document.getElementById('viz-prev-btn');
    const nextBtn    = document.getElementById('viz-next-btn');
    const presetName = document.getElementById('viz-preset-name');
    if (specMode) {
      bcCanvas.classList.add('hidden');
      spCanvas.classList.remove('hidden');
      if (label) label.textContent = 'Milkdrop';
      if (prevBtn)    prevBtn.style.visibility    = 'hidden';
      if (nextBtn)    nextBtn.style.visibility    = 'hidden';
      if (presetName) presetName.style.visibility = 'hidden';
      // stop butterchurn render loop (it will be resumed on mode switch back)
      if (frameId) { cancelAnimationFrame(frameId); frameId = null; }
      startSpectrum(spCanvas);
    } else {
      spCanvas.classList.add('hidden');
      bcCanvas.classList.remove('hidden');
      if (label) label.textContent = 'Spectrum';
      if (prevBtn)    prevBtn.style.visibility    = '';
      if (nextBtn)    nextBtn.style.visibility    = '';
      if (presetName) presetName.style.visibility = '';
      stopSpectrum();
      if (visualizer && !frameId) startRender();
    }
  }

  function updateSongInfo() {
    const s = S.queue[S.idx];
    const t = document.getElementById('viz-song-title');
    const a = document.getElementById('viz-song-artist');
    if (t) t.textContent = s ? (s.title || s.filepath?.split('/').pop() || '') : '';
    if (a) a.textContent = s?.artist || '';
  }

  return {
    open() {
      ensureAudio();
      const overlay = document.getElementById('viz-overlay');
      overlay.classList.remove('hidden');
      document.getElementById('viz-open-btn').classList.add('active');
      updateSongInfo();
      const canvas  = document.getElementById('viz-canvas');
      if (specMode) {
        applyMode();
      } else {
        if (!visualizer) {
          initViz(canvas);
        } else {
          canvas.width  = canvas.clientWidth;
          canvas.height = canvas.clientHeight;
          visualizer.setRendererSize(canvas.width, canvas.height);
          if (!frameId) startRender();
        }
      }
    },
    close() {
      document.getElementById('viz-overlay').classList.add('hidden');
      document.getElementById('viz-open-btn').classList.remove('active');
      if (frameId)    { cancelAnimationFrame(frameId);    frameId    = null; }
      if (specFrameId){ cancelAnimationFrame(specFrameId); specFrameId = null; }
    },
    next()  {
      if (specMode) return;
      presetHistory.push(presetIndex);
      presetIndex = Math.floor(Math.random() * presetKeys.length);
      loadPreset(2.7);
    },
    prev()  {
      if (specMode) return;
      if (presetHistory.length) presetIndex = presetHistory.pop();
      else presetIndex = ((presetIndex - 1) + presetKeys.length) % presetKeys.length;
      loadPreset(2.7);
    },
    toggleMode() {
      specMode = !specMode;
      applyMode();
    },
    songChanged() { updateSongInfo(); },
    initAudio()   { ensureAudio(); },
  };
})();

// ── MODALS ────────────────────────────────────────────────────
function showModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function hideModal(id)  { document.getElementById(id).classList.add('hidden'); }

function showConfirmModal(title, msg, onOk) {
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-msg').textContent   = msg;
  const okBtn = document.getElementById('confirm-modal-ok');
  const newOk = okBtn.cloneNode(true); // remove any previous listener
  okBtn.parentNode.replaceChild(newOk, okBtn);
  newOk.addEventListener('click', () => { hideModal('confirm-modal'); onOk(); });
  showModal('confirm-modal');
}

// ── UPLOAD MODAL ──────────────────────────────────────────────
function openUploadModal(dir) {
  let pendingFiles = [];   // { file: File, status: 'waiting'|'uploading'|'done'|'error' }

  const destEl    = document.getElementById('upload-modal-dest');
  const dropZone  = document.getElementById('upload-drop-zone');
  const listEl    = document.getElementById('upload-file-list');
  const startBtn  = document.getElementById('upload-start-btn');

  destEl.textContent = `Destination: ${dir}`;
  pendingFiles = [];
  listEl.innerHTML = '';
  startBtn.disabled = true;
  startBtn.onclick = null;  // clear any previous listener without cloning

  function fmtSize(bytes) {
    if (bytes < 1024)       return bytes + ' B';
    if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function renderList() {
    listEl.innerHTML = pendingFiles.map((pf, i) => `
      <div class="upload-file-item" id="ufi-${i}">
        <div class="upload-file-row">
          <span class="upload-file-name" title="${esc(pf.file.name)}">${esc(pf.file.name)}</span>
          <span class="upload-file-size">${fmtSize(pf.file.size)}</span>
          ${pf.status === 'waiting'
            ? `<button class="upload-file-remove" data-idx="${i}" title="Remove">✕</button>`
            : `<span class="upload-file-status">${pf.status === 'done' ? '✓' : pf.status === 'error' ? '✗' : '…'}</span>`}
        </div>
        <div class="upload-progress"><div class="upload-progress-bar" id="upb-${i}" style="width:${pf.progress || 0}%"></div></div>
      </div>`).join('');
    listEl.querySelectorAll('.upload-file-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingFiles.splice(parseInt(btn.dataset.idx), 1);
        renderList();
      });
    });
    startBtn.disabled = pendingFiles.length === 0;
  }

  function addFiles(files) {
    const rejected = [];
    Array.from(files).forEach(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      if (Object.keys(S.supportedAudioFiles).length > 0 && !S.supportedAudioFiles[ext]) {
        rejected.push(f.name);
        return;
      }
      if (!pendingFiles.some(p => p.file.name === f.name && p.file.size === f.size)) {
        pendingFiles.push({ file: f, status: 'waiting', progress: 0 });
      }
    });
    if (rejected.length > 0) {
      const names = rejected.slice(0, 2).join(', ') + (rejected.length > 2 ? ` +${rejected.length - 2} more` : '');
      toastError(`Not allowed: ${names}`);
    }
    renderList();
  }

  // Reset listeners by cloning the drop zone
  const newDrop  = dropZone.cloneNode(true);
  const newInput = newDrop.querySelector('#upload-file-input');
  dropZone.parentNode.replaceChild(newDrop, dropZone);

  // Set accept attribute from server's supported audio file list
  const _acceptExts = Object.entries(S.supportedAudioFiles).filter(([,v]) => v).map(([k]) => '.' + k).join(',');
  if (_acceptExts) newInput.setAttribute('accept', _acceptExts);

  newDrop.addEventListener('click', e => { if (!e.target.closest('label')) newInput.click(); });
  newInput.addEventListener('change', () => { addFiles(newInput.files); newInput.value = ''; });
  newDrop.addEventListener('dragover',  e => { e.preventDefault(); newDrop.classList.add('drag-over'); });
  newDrop.addEventListener('dragleave', ()=> { newDrop.classList.remove('drag-over'); });
  newDrop.addEventListener('drop', e => {
    e.preventDefault(); newDrop.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  startBtn.onclick = async () => {
    startBtn.disabled = true;
    let doneCount = 0, errorCount = 0;

    for (let i = 0; i < pendingFiles.length; i++) {
      const pf = pendingFiles[i];
      if (pf.status !== 'waiting') continue;
      pf.status = 'uploading';
      renderList();

      await new Promise(resolve => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) {
            pf.progress = Math.round((e.loaded / e.total) * 100);
            const bar = document.getElementById(`upb-${i}`);
            if (bar) bar.style.width = pf.progress + '%';
          }
        };
        xhr.onload = () => {
          pf.progress = 100;
          if (xhr.status >= 200 && xhr.status < 300) {
            pf.status = 'done'; doneCount++;
          } else {
            pf.status = 'error'; errorCount++;
          }
          renderList(); resolve();
        };
        xhr.onerror = () => { pf.status = 'error'; errorCount++; renderList(); resolve(); };
        xhr.open('POST', '/api/v1/file-explorer/upload');
        xhr.setRequestHeader('x-access-token', S.token);
        xhr.setRequestHeader('data-location', encodeURI(dir));
        const fd = new FormData();
        fd.append('file', pf.file);
        xhr.send(fd);
      });
    }

    // All done
    const allDone = pendingFiles.every(p => p.status === 'done' || p.status === 'error');
    if (allDone) {
      setTimeout(() => {
        hideModal('upload-modal');
        if (doneCount > 0) {
          viewFiles(dir, false);
          toast(`${doneCount} file${doneCount !== 1 ? 's' : ''} uploaded`);
        }
        if (errorCount > 0) {
          toast(`${errorCount} file${errorCount !== 1 ? 's' : ''} failed to upload`);
        }
      }, 500);
    }
  };

  showModal('upload-modal');
}

function showSavePlaylistModal() {
  document.getElementById('pl-save-name').value = '';
  showModal('pl-save-modal');
  setTimeout(() => document.getElementById('pl-save-name').focus(), 50);
}
function showNewPlaylistModal() {
  document.getElementById('pl-new-name').value = '';
  showModal('pl-new-modal');
  setTimeout(() => document.getElementById('pl-new-name').focus(), 50);
}
function showDeletePlaylistModal(name) {
  document.getElementById('pl-del-msg').textContent = `"${name}" will be permanently removed. This cannot be undone.`;
  document.getElementById('pl-del-ok').dataset.pl = name;
  showModal('pl-del-modal');
}
function showAddToPlaylistModal(song) {
  const list = document.getElementById('atp-list');
  if (!S.playlists.length) {
    list.innerHTML = `<div class="modal-empty">No playlists yet. Create one first.</div>`;
  } else {
    list.innerHTML = S.playlists.map(p =>
      `<div class="modal-pl-item" data-pl="${esc(p.name)}">
        <svg class="modal-pl-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        ${esc(p.name)}
      </div>`
    ).join('');
    list.querySelectorAll('.modal-pl-item').forEach(el => {
      el.addEventListener('click', async () => {
        hideModal('atp-modal');
        try {
          await api('POST', 'api/v1/playlist/add-song', { song: song.filepath, playlist: el.dataset.pl });
          toast(`Added to "${el.dataset.pl}"`);
        } catch(e) { toast('Failed to add to playlist'); }
      });
    });
  }
  showModal('atp-modal');
}

// ── SHARE PLAYLIST ───────────────────────────────────────────
function showSharePlaylistModal(songs) {
  const resultEl = document.getElementById('share-pl-result');
  const urlEl    = document.getElementById('share-pl-url');
  const okBtn    = document.getElementById('share-pl-ok');
  resultEl.classList.add('hidden');
  urlEl.value = '';
  document.getElementById('share-pl-expires').value = '';
  okBtn.disabled = false;
  okBtn.textContent = 'Create link';
  showModal('share-pl-modal');

  okBtn.onclick = async () => {
    okBtn.disabled = true;
    okBtn.textContent = 'Creating…';
    try {
      const expires = document.getElementById('share-pl-expires').value;
      const body = { playlist: songs.map(s => s.filepath) };
      if (expires) body.time = parseInt(expires);
      const d = await api('POST', 'api/v1/share', body);
      const url = `${location.origin}/shared/${d.playlistId}`;
      urlEl.value = url;
      resultEl.classList.remove('hidden');
      okBtn.textContent = 'Create another';
      okBtn.disabled = false;
    } catch(e) {
      toast('Failed to create share link');
      okBtn.disabled = false;
      okBtn.textContent = 'Create link';
    }
  };

  document.getElementById('share-pl-copy').onclick = () => {
    const url = urlEl.value;
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('share-pl-copy');
      const orig = btn.innerHTML;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg> Copied!`;
      setTimeout(() => { btn.innerHTML = orig; }, 1800);
    }).catch(() => { urlEl.select(); toast('Copy failed — select the URL manually'); });
  };
}

// ── PLAYLISTS ────────────────────────────────────────────────
async function loadPlaylists() {
  try {
    S.playlists = (await api('GET', 'api/v1/playlist/getall')) || [];
  } catch(_) { S.playlists = []; }
  renderPlaylistNav();
}

function renderPlaylistNav() {
  const nav = document.getElementById('playlist-nav');
  nav.innerHTML = S.playlists.map(p => `
    <div class="pl-row" data-pl="${esc(p.name)}">
      <button class="pl-row-btn" data-pl="${esc(p.name)}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        ${esc(p.name)}
      </button>
      <button class="pl-row-share" data-pl="${esc(p.name)}" title="Share">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
      </button>
      <button class="pl-row-del" data-pl="${esc(p.name)}" title="Delete">×</button>
    </div>`).join('');

  nav.querySelectorAll('.pl-row-btn').forEach(btn => {
    btn.addEventListener('click', () => openPlaylist(btn.dataset.pl));
  });
  nav.querySelectorAll('.pl-row-share').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const name = btn.dataset.pl;
      try {
        const d = await api('POST', 'api/v1/playlist/load', { playlistname: name });
        const songs = d.map(item => norm(item));
        showSharePlaylistModal(songs);
      } catch(_) { toast('Failed to load playlist'); }
    });
  });
  nav.querySelectorAll('.pl-row-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const name = btn.dataset.pl;
      showDeletePlaylistModal(name);
    });
  });
}

async function openPlaylist(name) {
  setTitle(name);
  setBack(null);
  setPlaylistActive(name);
  S.view = 'playlist:' + name;
  setBody('<div class="loading-state"></div>');

  document.getElementById('play-all-btn').onclick = () => {
    if (S.curSongs.length) { Player.setQueue(S.curSongs, 0); toast(`Playing "${name}"`); }
  };
  document.getElementById('add-all-btn').onclick = () => {
    if (S.curSongs.length) { Player.addAll(S.curSongs); }
  };

  try {
    const d = await api('POST', 'api/v1/playlist/load', { playlistname: name });
    const songs = d.map(item => ({ ...norm(item), _plid: item.id }));
    S.curSongs = songs;
    if (!songs.length) { setBody('<div class="empty-state">This playlist is empty</div>'); return; }
    const body = document.getElementById('content-body');
    body.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
        <button id="pl-save-cur-btn" class="btn-sm">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/></svg>
          Save current queue into "${esc(name)}"
        </button>
      </div>
      <div class="song-list">${renderSongRows(songs)}</div>`;
    document.getElementById('pl-save-cur-btn').onclick = async () => {
      if (!S.queue.length) { toast('Queue is empty'); return; }
      try {
        await api('POST', 'api/v1/playlist/save', { title: name, songs: S.queue.map(s => s.filepath) });
        toast(`Saved ${S.queue.length} songs to "${name}"`);
        openPlaylist(name);
      } catch(e) { toast('Save failed'); }
    };
    attachSongListEvents(body, songs);
    highlightRow();
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

// ── VIEWS ─────────────────────────────────────────────────────
async function viewSharedLinks() {
  setTitle('Shared Links'); setBack(null); setNavActive('shared-links'); S.view = 'shared-links';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  setBody('<div class="loading-state"></div>');
  try {
    const items = await api('GET', 'api/v1/share/list');
    if (!items.length) {
      setBody(`<div class="empty-state">No shared links yet.<br>Use the share button in the queue panel to share your queue.</div>`);
      return;
    }
    const body = document.getElementById('content-body');
    body.innerHTML = `<div class="shared-links-list">${items.map(item => {
      const url = `${location.origin}/shared/${item.playlistId}`;
      const exp = item.expires ? new Date(item.expires * 1000).toLocaleDateString() : 'Never';
      const expired = item.expires && item.expires * 1000 < Date.now();
      return `<div class="shared-link-row${expired ? ' shared-expired' : ''}" data-id="${esc(item.playlistId)}">
        <div class="shared-link-info">
          <div class="shared-link-url">${esc(url)}</div>
          <div class="shared-link-meta">${item.songCount} song${item.songCount !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; Expires: ${exp}${expired ? ' <span class="shared-expired-tag">expired</span>' : ''}</div>
        </div>
        <div class="shared-link-actions">
          <button class="btn-ghost shared-copy-btn" data-url="${esc(url)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy
          </button>
          <a class="btn-ghost" href="${esc(url)}" target="_blank" rel="noopener">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15,3 21,3 21,9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Open
          </a>
          <button class="btn-ghost shared-del-btn" data-id="${esc(item.playlistId)}" style="color:var(--red)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14H6L5,6"/><path d="M9,6V4h6v2"/></svg>
            Delete
          </button>
        </div>
      </div>`;
    }).join('')}</div>`;
    body.querySelectorAll('.shared-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.url).then(() => {
          const orig = btn.innerHTML;
          btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg> Copied!`;
          setTimeout(() => { btn.innerHTML = orig; }, 1800);
        }).catch(() => toast('Copy failed'));
      });
    });
    body.querySelectorAll('.shared-del-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        showModal('del-share-modal');
        const ok     = document.getElementById('del-share-ok');
        const cancel = document.getElementById('del-share-cancel');
        const cleanup = () => { ok.replaceWith(ok.cloneNode(true)); cancel.replaceWith(cancel.cloneNode(true)); };
        document.getElementById('del-share-ok').addEventListener('click', async () => {
          hideModal('del-share-modal'); cleanup();
          try {
            await api('DELETE', `api/v1/share/${id}`);
            viewSharedLinks();
          } catch(e) { toast('Delete failed'); }
        }, { once: true });
        document.getElementById('del-share-cancel').addEventListener('click', () => {
          hideModal('del-share-modal'); cleanup();
        }, { once: true });
      });
    });
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewRecent() {
  setTitle('Recently Added'); setBack(null); setNavActive('recent'); S.view = 'recent';
  setBody('<div class="loading-state"></div>');
  try {
    const d = await api('POST', 'api/v1/db/recent/added', { limit: 200 });
    showSongs(d.map(norm));
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewArtists() {
  setTitle('Artists'); setBack(null); setNavActive('artists'); S.view = 'artists';
  setBody('<div class="loading-state"></div>');
  try {
    const d = await api('POST', 'api/v1/db/artists', {});
    const rawArtists = d.artists || [];
    if (!rawArtists.length) { setBody('<div class="empty-state">No artists found</div>'); return; }
    S.curSongs = [];
    document.getElementById('play-all-btn').onclick = null;
    document.getElementById('add-all-btn').onclick  = null;

    // Group raw artist name variants by normalized key
    const groupMap = new Map();
    for (const a of rawArtists) {
      const key = normalizeArtist(a);
      const clean = cleanArtistDisplay(a);
      if (!groupMap.has(key)) {
        groupMap.set(key, { display: a, cleanDisplay: clean, variants: [a] });
      } else {
        const g = groupMap.get(key);
        g.variants.push(a);
        // Prefer a clean display that starts with a real letter
        if (!/^[a-zA-Z]/i.test(g.cleanDisplay) && /^[a-zA-Z]/i.test(clean)) {
          g.display = a;
          g.cleanDisplay = clean;
        }
      }
    }
    const groups = [...groupMap.values()];

    // Determine which A-Z / # buckets are populated using the CLEAN name
    const letterOf = g => {
      const ch = g.cleanDisplay.charAt(0).toUpperCase();
      return /[A-Z]/.test(ch) ? ch : '#';
    };
    const AZ_KEYS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
    const hasLetter = new Set(groups.map(letterOf));

    const body = document.getElementById('content-body');
    body.innerHTML = `
      <div class="fe-filter-row">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="lib-filter" class="fe-filter-input" type="text" placeholder="Search artists…" autocomplete="off">
        <span id="lib-match-count" class="fe-match-count"></span>
        <button id="lib-filter-clear" class="fe-filter-clear hidden" title="Clear filter">✕</button>
      </div>
      <div class="az-strip" id="az-strip">${
        AZ_KEYS.map(l => `<button class="az-btn" data-letter="${l}"${hasLetter.has(l) ? '' : ' disabled'}>${l}</button>`).join('')
      }</div>
      <div class="artist-list">${
        groups.map((g, i) => {
          const letter = letterOf(g);
          const av = g.cleanDisplay.charAt(0).toUpperCase() || '?';
          return `<div class="artist-row" data-gi="${i}" data-letter="${letter}">
            <div class="artist-av">${esc(av)}</div>
            <div class="artist-name">${esc(g.cleanDisplay)}${g.variants.length > 1 ? `<span class="artist-var"> +${g.variants.length - 1}</span>` : ''}</div>
          </div>`;
        }).join('')
      }</div>`;

    const filterInput = body.querySelector('#lib-filter');
    const filterClear = body.querySelector('#lib-filter-clear');
    const matchCount  = body.querySelector('#lib-match-count');
    const azStrip     = body.querySelector('#az-strip');
    const allRows     = Array.from(body.querySelectorAll('.artist-row'));
    const rowNames    = groups.map(g => g.cleanDisplay.toLowerCase());

    function setActiveAZ(letter) {
      body.querySelectorAll('.az-btn').forEach(b => b.classList.toggle('active', b.dataset.letter === letter));
    }
    function applyFilter() {
      const q = filterInput.value.trim().toLowerCase();
      filterClear.classList.toggle('hidden', !q);
      azStrip.classList.toggle('az-hidden', !!q); // hide A-Z when typing
      if (q) { _activeLetter = null; setActiveAZ(null); }
      let visible = 0;
      allRows.forEach((row, i) => {
        const matches = !q || rowNames[i].includes(q);
        row.classList.toggle('fe-hidden', !matches);
        if (matches) visible++;
      });
      matchCount.textContent = q ? `${visible} result${visible !== 1 ? 's' : ''}` : '';
    }

    // A-Z strip click: filter list to only artists starting with that letter
    // Clicking the active letter again clears the filter and shows all
    let _activeLetter = null;
    body.querySelectorAll('.az-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        filterInput.value = '';
        const letter = btn.dataset.letter;
        if (_activeLetter === letter) {
          // toggle off → show all
          _activeLetter = null;
          setActiveAZ(null);
          allRows.forEach(r => r.classList.remove('fe-hidden'));
          matchCount.textContent = '';
          azStrip.classList.remove('az-hidden');
          return;
        }
        _activeLetter = letter;
        setActiveAZ(letter);
        let visible = 0;
        allRows.forEach(row => {
          const matches = row.dataset.letter === letter;
          row.classList.toggle('fe-hidden', !matches);
          if (matches) visible++;
        });
        matchCount.textContent = `${visible} artist${visible !== 1 ? 's' : ''}`;
        // Scroll content-body back to top so results are visible
        body.scrollTop = 0;
      });
    });

    let _artTimer;
    filterInput.addEventListener('input', () => { clearTimeout(_artTimer); _artTimer = setTimeout(applyFilter, 150); });
    filterClear.addEventListener('click', () => { clearTimeout(_artTimer); _activeLetter = null; filterInput.value = ''; filterInput.focus(); applyFilter(); });
    allRows.forEach(row => {
      const g = groups[parseInt(row.dataset.gi)];
      if (g) row.addEventListener('click', () => viewArtistAlbums(g.display, g.variants));
    });
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewArtistAlbums(displayName, variantsOrBackFn, backFn) {
  // Overloaded: (name, variants[], backFn?) from artist list
  //             (name, backFn?)         from search / legacy callers
  let variants, back;
  if (Array.isArray(variantsOrBackFn)) {
    variants = variantsOrBackFn;
    back = backFn;
  } else {
    variants = [displayName];
    back = variantsOrBackFn;
  }
  setTitle(displayName); setBack(back || (() => viewArtists()));
  setBody('<div class="loading-state"></div>');
  try {
    // Parallel fetch for all name variants, then merge albums client-side
    const results = await Promise.all(
      variants.map(a => api('POST', 'api/v1/db/artists-albums', { artist: a }))
    );
    const seen = new Set();
    const albums = [];
    for (let i = 0; i < results.length; i++) {
      for (const alb of (results[i].albums || [])) {
        const key = `${alb.name}|${alb.year}`;
        if (!seen.has(key)) {
          seen.add(key);
          albums.push({ ...alb, _rawArtist: variants[i] });
        }
      }
    }
    renderAlbumGrid(albums, displayName, variants);
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewAllAlbums() {
  setTitle('Albums'); setBack(null); setNavActive('albums'); S.view = 'albums';
  setBody('<div class="loading-state"></div>');
  try {
    const d = await api('POST', 'api/v1/db/albums', {});
    renderAlbumGrid(d.albums || [], null);
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

function renderAlbumGrid(albums, defaultArtist, artistVariants) {
  if (!albums.length) { setBody('<div class="empty-state">No albums found</div>'); return; }
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  const body = document.getElementById('content-body');

  // Pre-compute clean names for display / filtering / A-Z
  const albumsClean = albums.map(a => ({
    ...a,
    cleanName: a.name ? cleanArtistDisplay(a.name) : 'Singles',
  }));

  const letterOfAlbum = a => {
    const ch = a.cleanName.charAt(0).toUpperCase();
    return /[A-Z]/.test(ch) ? ch : '#';
  };
  const AZ_KEYS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
  const hasLetter = new Set(albumsClean.map(letterOfAlbum));

  body.innerHTML = `
    <div class="fe-filter-row">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input id="lib-filter" class="fe-filter-input" type="text" placeholder="Search albums…" autocomplete="off">
      <span id="lib-match-count" class="fe-match-count"></span>
      <button id="lib-filter-clear" class="fe-filter-clear hidden" title="Clear filter">✕</button>
    </div>
    <div class="az-strip" id="az-strip">${
      AZ_KEYS.map(l => `<button class="az-btn" data-letter="${l}"${hasLetter.has(l) ? '' : ' disabled'}>${l}</button>`).join('')
    }</div>
    <div class="album-grid"></div>`;
  const filterInput = body.querySelector('#lib-filter');
  const filterClear = body.querySelector('#lib-filter-clear');
  const matchCount  = body.querySelector('#lib-match-count');
  const azStrip     = body.querySelector('#az-strip');
  const grid        = body.querySelector('.album-grid');

  // Pre-build HTML strings — use cleanName for display
  const cardData = albumsClean.map((a, i) => {
    const name = a.cleanName;
    const art  = artUrl(a.album_art_file, 's');
    return {
      lc:     name.toLowerCase(),
      letter: letterOfAlbum(a),
      html: `<div class="album-card" data-i="${i}">
        <div class="album-art">
          ${art
            ? `<img src="${art}" alt="${esc(name)}" loading="lazy" onerror="this.style.display='none'">`
            : `<div class="no-art no-art-album"><div class="no-art-wave"><span></span><span></span><span></span><span></span><span></span></div><span class="no-art-label">no artwork</span></div>`}
          <div class="play-ov"><svg width="30" height="30" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div>
        </div>
        <div class="album-meta">
          <div class="album-name">${esc(name)}</div>
          ${a.year ? `<div class="album-year">${a.year}</div>` : '<div class="album-year">&nbsp;</div>'}
        </div>
      </div>`
    };
  });

  // Single delegated listener
  grid.addEventListener('click', e => {
    const card = e.target.closest('.album-card');
    if (!card) return;
    const album = albums[parseInt(card.dataset.i)];
    if (!album) return;
    const backFn = defaultArtist ? () => viewArtistAlbums(defaultArtist, artistVariants || [defaultArtist]) : () => viewAllAlbums();
    viewAlbumSongs(album.name, album._rawArtist || defaultArtist, backFn);
  });

  let _albTimer, _rafId, _activeLetter = null;
  const CHUNK = 80;

  function setActiveAZ(letter) {
    body.querySelectorAll('.az-btn').forEach(b => b.classList.toggle('active', b.dataset.letter === letter));
  }

  function renderChunked(data) {
    cancelAnimationFrame(_rafId);
    grid.innerHTML = '';
    matchCount.textContent = '';
    filterClear.classList.add('hidden');
    let pos = 0;
    function step() {
      grid.insertAdjacentHTML('beforeend', data.slice(pos, pos + CHUNK).map(c => c.html).join(''));
      pos += CHUNK;
      if (pos < data.length) _rafId = requestAnimationFrame(step);
    }
    step();
  }

  function renderFiltered(q) {
    cancelAnimationFrame(_rafId);
    const subset = cardData.filter(c => c.lc.includes(q));
    grid.innerHTML = subset.map(c => c.html).join('');
    filterClear.classList.remove('hidden');
    matchCount.textContent = `${subset.length} result${subset.length !== 1 ? 's' : ''}`;
  }

  // A-Z strip
  body.querySelectorAll('.az-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      filterInput.value = '';
      azStrip.classList.remove('az-hidden');
      const letter = btn.dataset.letter;
      if (_activeLetter === letter) {
        _activeLetter = null;
        setActiveAZ(null);
        matchCount.textContent = '';
        renderChunked(cardData);
        return;
      }
      _activeLetter = letter;
      setActiveAZ(letter);
      const subset = cardData.filter(c => c.letter === letter);
      cancelAnimationFrame(_rafId);
      grid.innerHTML = subset.map(c => c.html).join('');
      matchCount.textContent = `${subset.length} album${subset.length !== 1 ? 's' : ''}`;
      body.scrollTop = 0;
    });
  });

  filterInput.addEventListener('input', () => {
    clearTimeout(_albTimer);
    _albTimer = setTimeout(() => {
      const q = filterInput.value.trim().toLowerCase();
      _activeLetter = null;
      setActiveAZ(null);
      azStrip.classList.toggle('az-hidden', !!q);
      if (q) renderFiltered(q);
      else { matchCount.textContent = ''; renderChunked(cardData); }
    }, 150);
  });
  filterClear.addEventListener('click', () => {
    clearTimeout(_albTimer);
    _activeLetter = null;
    setActiveAZ(null);
    filterInput.value = '';
    filterInput.focus();
    azStrip.classList.remove('az-hidden');
    matchCount.textContent = '';
    renderChunked(cardData);
  });

  renderChunked(cardData);
}

async function viewAlbumSongs(albumName, artist, backFn) {
  setTitle(albumName || 'Singles');
  setBack(backFn || null);
  setBody('<div class="loading-state"></div>');
  try {
    const body = { album: albumName };
    if (artist) body.artist = artist;
    const d = await api('POST', 'api/v1/db/album-songs', body);
    showSongs(d.map(norm));
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

function viewSearch() {
  setTitle('Search'); setBack(null); setNavActive('search'); S.view = 'search';
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  const body = document.getElementById('content-body');
  body.innerHTML = `
    <div class="search-wrap">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--t3);flex-shrink:0"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input class="search-input" id="search-input" type="text" placeholder="Search artists, albums, songs…" autocomplete="off">
    </div>
    <div id="search-results"></div>`;
  const input = document.getElementById('search-input');
  // Restore previous query if returning from a drill-down
  if (S.lastSearch) {
    input.value = S.lastSearch;
    doSearch(S.lastSearch);
  } else {
    input.focus();
  }
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    S.lastSearch = q;
    if (!q) { document.getElementById('search-results').innerHTML = ''; return; }
    timer = setTimeout(() => doSearch(q), 320);
  });
}

async function doSearch(q) {
  const res = document.getElementById('search-results');
  if (!res) return;
  res.innerHTML = '<div class="loading-state"></div>';
  try {
    const d = await api('POST', 'api/v1/db/search', { search: q });
    let html = '';

    if (d.artists?.length) {
      html += `<div class="search-section"><h3>Artists (${d.artists.length})</h3><div class="artist-list">${
        d.artists.map(a => `<div class="artist-row" data-artist="${esc(a.name)}">
          <div class="artist-av">${esc(a.name.charAt(0)).toUpperCase()}</div>
          <div class="artist-name">${esc(a.name)}</div>
        </div>`).join('')
      }</div></div>`;
    }
    if (d.albums?.length) {
      html += `<div class="search-section"><h3>Albums (${d.albums.length})</h3><div class="artist-list">${
        d.albums.map(a => {
          const au = artUrl(a.album_art_file, 's');
          return `<div class="artist-row" data-album="${esc(a.name)}">
            <div class="artist-av" style="border-radius:6px;overflow:hidden">
              ${au ? `<img src="${au}" style="width:38px;height:38px;object-fit:cover" loading="lazy" onerror="this.parentNode.innerHTML='♪'">` : '♪'}
            </div>
            <div class="artist-name">${esc(a.name)}</div>
          </div>`;
        }).join('')
      }</div></div>`;
    }
    // Songs matched by ID3 title
    const seenPaths = new Set();
    const titleSongs = (d.title || []).map(t => {
      seenPaths.add(t.filepath);
      return {
        title:      t.name.includes(' - ') ? t.name.split(' - ').slice(1).join(' - ') : t.name,
        artist:     t.name.includes(' - ') ? t.name.split(' - ')[0] : '',
        filepath:   t.filepath,
        'album-art': t.album_art_file || null,
      };
    });
    // Songs matched only by filename (no ID3 title hit) — deduplicate against above
    const fileSongs = (d.files || [])
      .filter(f => !seenPaths.has(f.filepath))
      .map(f => ({
        title:      f.filepath.split('/').pop().replace(/\.[^.]+$/, ''),
        artist:     '',
        filepath:   f.filepath,
        'album-art': f.album_art_file || null,
      }));
    const allSongs = [...titleSongs, ...fileSongs];
    if (allSongs.length) {
      html += `<div class="search-section"><h3>Songs (${allSongs.length})</h3><div class="song-list">${renderSongRowsWithPath(allSongs)}</div></div>`;
    }
    if (!html) html = `<div class="empty-state">No results for "${esc(q)}"</div>`;
    res.innerHTML = html;

    res.querySelectorAll('.artist-row[data-artist]').forEach(r => r.addEventListener('click', () => viewArtistAlbums(r.dataset.artist, () => viewSearch())));
    res.querySelectorAll('.artist-row[data-album]').forEach(r => r.addEventListener('click', () => viewAlbumSongs(r.dataset.album, null, () => viewSearch())));
    attachSongListEvents(res, allSongs);
    S.curSongs = allSongs;
  } catch(e) { res.innerHTML = `<div class="empty-state">Search failed: ${esc(e.message)}</div>`; }
}

async function viewRated() {
  setTitle('Starred'); setBack(null); setNavActive('rated'); S.view = 'rated';
  setBody('<div class="loading-state"></div>');
  try {
    const d = await api('POST', 'api/v1/db/rated', {});
    if (!d.length) { setBody('<div class="empty-state">No starred songs yet. Rate songs with ★</div>'); return; }
    showSongs(d.map(norm));
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewMostPlayed() {
  setTitle('Most Played'); setBack(null); setNavActive('most-played'); S.view = 'most-played';
  setBody('<div class="loading-state"></div>');
  try {
    const d = await api('POST', 'api/v1/db/stats/most-played', { limit: 100 });
    if (!d.length) { setBody('<div class="empty-state">No play history yet</div>'); return; }
    showMostPlayed(d.map(s => { const n = norm(s); n._playCount = s.metadata?.['play-count']; return n; }));
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewPlayed() {
  setTitle('Recently Played'); setBack(null); setNavActive('played'); S.view = 'played';
  setBody('<div class="loading-state"></div>');
  try {
    const d = await api('POST', 'api/v1/db/stats/recently-played', { limit: 100 });
    if (!d.length) { setBody('<div class="empty-state">No play history yet</div>'); return; }
    showSongs(d.map(norm));
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

// ── FILE EXPLORER ─────────────────────────────────────────────
async function viewFiles(dir, addToStack) {
  setNavActive('files'); S.view = 'files';
  if (addToStack && S.feDir !== dir) S.feDirStack.push(S.feDir);
  S.feDir = dir || '';
  setBody('<div class="loading-state"></div>');
  try {
    const d = await api('POST', 'api/v1/file-explorer', { directory: S.feDir, sort: true, pullMetadata: true });
    renderFileExplorer(d);
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

function renderFileExplorer(d) {
  const curPath = d.path || '/';
  // Build breadcrumb
  const parts = curPath.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
  let crumbs = `<span class="fe-crumb" data-dir="">⌂ Root</span>`;
  let cumPath = '';
  parts.forEach(p => {
    crumbs += `<span class="fe-crumb-sep">/</span>`;
    cumPath += (cumPath ? '/' : '') + p;
    crumbs += `<span class="fe-crumb" data-dir="/${cumPath}">${esc(p)}</span>`;
  });

  const dirs = (d.directories || []).map(dir => `
    <div class="fe-dir" data-dir="${esc(curPath + dir.name)}">
      <svg class="fe-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="fe-name">${esc(dir.name)}</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--t3);flex-shrink:0"><polyline points="9,18 15,12 9,6"/></svg>
    </div>`).join('');

  const files = (d.files || []).map(file => {
    const meta = file.metadata?.metadata;
    const fp   = file.metadata?.filepath;
    const title  = meta?.title  || file.name;
    const artist = meta?.artist || '';
    const artU   = artUrl(meta?.['album-art'], 's');
    const thumb  = artU
      ? `<img class="fe-thumb" src="${artU}" alt="" loading="lazy" onerror="this.outerHTML='<svg class=fe-icon width=16 height=16 viewBox=&quot;0 0 24 24&quot; fill=none stroke=currentColor stroke-width=2><path d=&quot;M9 18V5l12-2v13&quot;/><circle cx=6 cy=18 r=3/><circle cx=18 cy=16 r=3/></svg>'">`
      : `<svg class="fe-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    return `
      <div class="fe-file" data-fp="${esc(fp || '')}" data-name="${esc(file.name)}">
        ${thumb}
        <div class="fe-name">
          <div>${esc(title)}</div>
          ${artist ? `<div style="font-size:11px;color:var(--t2);margin-top:1px">${esc(artist)}</div>` : ''}
        </div>
        <span class="fe-sub">${esc(file.type?.toUpperCase() || '')}</span>
        <div class="fe-actions">
          <button class="fe-act fe-play-btn" title="Play">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
          </button>
          <button class="fe-act fe-add-btn" title="Add to queue">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <a class="fe-act" href="${fp ? dlUrl(fp) : '#'}" download="${esc(file.name)}" title="Download" onclick="event.stopPropagation()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </a>
        </div>
      </div>`;
  }).join('');

  // Back button logic
  const hasBack = S.feDirStack.length > 0;
  setBack(hasBack ? () => { const prev = S.feDirStack.pop(); S.feDir = prev; viewFiles(prev, false); } : null);
  setTitle(parts.length ? parts[parts.length - 1] : 'File Explorer');

  // Play all for directory
  const dirSongs = (d.files || [])
    .filter(f => f.metadata?.filepath)
    .map(f => norm(f.metadata));

  document.getElementById('play-all-btn').onclick = () => {
    if (dirSongs.length) { Player.setQueue(dirSongs, 0); toast(`Playing ${dirSongs.length} songs from this folder`); }
  };
  document.getElementById('add-all-btn').onclick = () => {
    if (dirSongs.length) { Player.addAll(dirSongs); }
  };
  S.curSongs = dirSongs;

  const body = document.getElementById('content-body');
  body.innerHTML = `
    <div class="fe-breadcrumb">${crumbs}</div>
    <div class="fe-filter-row">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input id="fe-filter" class="fe-filter-input" type="text" placeholder="Filter folders and songs…" autocomplete="off">
      <span id="fe-match-count" class="fe-match-count"></span>
      <button id="fe-filter-clear" class="fe-filter-clear hidden" title="Clear filter">✕</button>
      ${S.canUpload && curPath !== '/' ? `<button id="fe-upload-btn" class="fe-upload-btn" title="Upload files here"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16,16 12,12 8,16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg> Upload</button>` : ''}
    </div>
    <div id="fe-grid" class="fe-grid">${dirs}${files}</div>`;

  // Live filter
  const filterInput  = body.querySelector('#fe-filter');
  const filterClear  = body.querySelector('#fe-filter-clear');
  const matchCount   = body.querySelector('#fe-match-count');
  const grid         = body.querySelector('#fe-grid');

  function applyFilter() {
    const q = filterInput.value.trim().toLowerCase();
    filterClear.classList.toggle('hidden', !q);
    const rows = grid.querySelectorAll('.fe-dir, .fe-file');
    let visible = 0;
    rows.forEach(row => {
      const name = (row.dataset.dir || row.dataset.name || '').split('/').pop().toLowerCase();
      const artist = row.querySelector('[style*="color:var(--t2)"]')?.textContent?.toLowerCase() || '';
      const matches = !q || name.includes(q) || artist.includes(q);
      row.classList.toggle('fe-hidden', !matches);
      if (matches) visible++;
    });
    matchCount.textContent = q ? `${visible} result${visible !== 1 ? 's' : ''}` : '';
  }

  filterInput.addEventListener('input', applyFilter);
  filterClear.addEventListener('click', () => { filterInput.value = ''; filterInput.focus(); applyFilter(); });

  // Upload button
  body.querySelector('#fe-upload-btn')?.addEventListener('click', () => openUploadModal(curPath));

  // Breadcrumb navigation
  body.querySelectorAll('.fe-crumb').forEach(el => {
    el.addEventListener('click', () => { S.feDirStack = []; viewFiles(el.dataset.dir || '', false); });
  });
  // Navigate into directory
  body.querySelectorAll('.fe-dir').forEach(el => {
    el.addEventListener('click', () => viewFiles(el.dataset.dir, true));
  });
  // File actions
  body.querySelectorAll('.fe-file').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.fe-act')) return;
      const fp = el.dataset.fp;
      if (!fp) return;
      const found = dirSongs.find(s => s.filepath === fp);
      if (found) Player.queueAndPlay(found);
    });
  });
  body.querySelectorAll('.fe-play-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const fp = btn.closest('.fe-file').dataset.fp;
      const found = dirSongs.find(s => s.filepath === fp);
      if (found) Player.playSingle(found);
    });
  });
  body.querySelectorAll('.fe-add-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const fp = btn.closest('.fe-file').dataset.fp;
      const found = dirSongs.find(s => s.filepath === fp);
      if (found) Player.addSong(found);
    });
  });
}

// ── AUTO-DJ VIEW ──────────────────────────────────────────────
async function viewAutoDJ() {
  setTitle('Auto-DJ'); setBack(null); setNavActive('autodj'); S.view = 'autodj';
  S.curSongs = [];
  // Ensure vpaths are loaded (may be empty if checkSession had a hiccup)
  if (!S.vpaths.length) {
    try {
      const d = await api('GET', 'api/v1/db/status');
      if (d.vpaths && d.vpaths.length) {
        S.vpaths = d.vpaths;
        if (!S.djVpaths.length) S.djVpaths = [...S.vpaths];
      }
    } catch(_) {}
  }
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  const body = document.getElementById('content-body');
  body.innerHTML = `
    <div class="autodj-panel">
      <div class="autodj-hero">
        <div class="autodj-icon">🎲</div>
        <h2>Auto-DJ</h2>
        <p>Automatically plays random songs from your library so you never run out of music. Adjust the settings below to tune your experience.</p>
      </div>
      <button class="autodj-toggle${S.autoDJ ? ' on' : ''}" id="autodj-main-btn">
        ${S.autoDJ ? '⏹ Stop Auto-DJ' : '▶ Start Auto-DJ'}
      </button>
      <div class="autodj-status${S.autoDJ ? ' on' : ''}" id="autodj-status-msg">
        ${S.autoDJ ? 'Auto-DJ is ON — random songs will play continuously' : 'Auto-DJ is OFF'}
      </div>
      <div class="autodj-opts">
        <h4>Settings</h4>
        ${S.vpaths.length > 1 ? `
        <div class="autodj-opt-row">
          <div>
            <div class="autodj-opt-label">Sources</div>
            <div class="autodj-opt-hint">Collections Auto-DJ draws from</div>
          </div>
          <div class="dj-vpath-pills" id="dj-vpaths">
            ${S.vpaths.map(v => `<button class="dj-vpath-pill${S.djVpaths.includes(v) ? ' on' : ''}" data-vpath="${esc(v)}">${esc(v)}</button>`).join('')}
          </div>
        </div>` : ''}
        <div class="autodj-opt-row">
          <div>
            <div class="autodj-opt-label">Minimum Rating</div>
            <div class="autodj-opt-hint">Only play songs with this rating or higher</div>
          </div>
          <select class="autodj-select" id="dj-min-rating">
            <option value="0" ${S.djMinRating===0?'selected':''}>Any</option>
            <option value="2" ${S.djMinRating===2?'selected':''}>★ (1 star)</option>
            <option value="4" ${S.djMinRating===4?'selected':''}>★★ (2 stars)</option>
            <option value="6" ${S.djMinRating===6?'selected':''}>★★★ (3 stars)</option>
            <option value="8" ${S.djMinRating===8?'selected':''}>★★★★ (4 stars)</option>
            <option value="10" ${S.djMinRating===10?'selected':''}>★★★★★ (5 stars)</option>
          </select>
        </div>
      </div>
    </div>`;

  document.getElementById('autodj-main-btn').onclick = () => setAutoDJ(!S.autoDJ);
  document.getElementById('dj-min-rating').onchange = e => { S.djMinRating = parseInt(e.target.value); };

  const pillsEl = document.getElementById('dj-vpaths');
  if (pillsEl) {
    pillsEl.addEventListener('click', e => {
      const pill = e.target.closest('.dj-vpath-pill');
      if (!pill) return;
      const v = pill.dataset.vpath;
      const idx = S.djVpaths.indexOf(v);
      if (idx === -1) {
        S.djVpaths.push(v);
        pill.classList.add('on');
      } else if (S.djVpaths.length > 1) {
        S.djVpaths.splice(idx, 1);
        pill.classList.remove('on');
      } else {
        toast('At least one source must be active');
        return;
      }
      S.djIgnore = []; // reset play history when sources change
    });
  }
}

// ── TRANSCODE ─────────────────────────────────────────────────
function viewTranscode() {
  setTitle('Transcode'); setBack(null); setNavActive('transcode'); S.view = 'transcode';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  const info = S.transInfo;
  if (!info || !info.serverEnabled) {
    setBody(`
      <div class="info-panel">
        <div class="info-panel-icon">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8.5 8.5h9l-9 9v11l20-20h11l-31 31h11l20-20v11l-9 9h9"/>
          </svg>
        </div>
        <h2>Transcoding</h2>
        <p class="info-hint">Transcoding is not enabled on this server. Ask your server admin to enable it in the config.</p>
      </div>`);
    return;
  }

  setBody(`
    <div class="settings-panel">
      <div class="settings-section-title">Transcode Settings</div>
      <p class="settings-desc">Stream audio converted on-the-fly to reduce bandwidth. Server default: <strong>${esc(info.defaultCodec || '—')} / ${esc(info.defaultBitrate || '—')} / ${esc(info.defaultAlgorithm || '—')}</strong>.</p>
      <div class="settings-row settings-row-toggle">
        <span class="settings-label">Enable Transcoding</span>
        <label class="toggle-sw">
          <input type="checkbox" id="tc-enable" ${S.transEnabled ? 'checked' : ''}>
          <span class="toggle-sw-track"><span class="toggle-sw-thumb"></span></span>
        </label>
      </div>
      <div id="tc-opts" class="settings-opts${S.transEnabled ? '' : ' dimmed'}">
        <div class="settings-row">
          <label class="settings-label" for="tc-codec">Codec</label>
          <select class="settings-select" id="tc-codec">
            <option value="">Default (${esc(info.defaultCodec || 'server')})</option>
            <option value="opus" ${S.transCodec==='opus'?'selected':''}>Opus / OGG</option>
            <option value="mp3"  ${S.transCodec==='mp3' ?'selected':''}>MP3</option>
            <option value="aac"  ${S.transCodec==='aac' ?'selected':''}>AAC</option>
          </select>
        </div>
        <div class="settings-row">
          <label class="settings-label" for="tc-bitrate">Bitrate</label>
          <select class="settings-select" id="tc-bitrate">
            <option value="">Default (${esc(info.defaultBitrate || 'server')})</option>
            <option value="64k"  ${S.transBitrate==='64k' ?'selected':''}>64 kbps</option>
            <option value="96k"  ${S.transBitrate==='96k' ?'selected':''}>96 kbps</option>
            <option value="128k" ${S.transBitrate==='128k'?'selected':''}>128 kbps</option>
            <option value="192k" ${S.transBitrate==='192k'?'selected':''}>192 kbps</option>
          </select>
        </div>
        <div class="settings-row">
          <label class="settings-label" for="tc-algo">Algorithm</label>
          <select class="settings-select" id="tc-algo">
            <option value="">Default (${esc(info.defaultAlgorithm || 'server')})</option>
            <option value="buffer" ${S.transAlgo==='buffer'?'selected':''}>Buffer</option>
            <option value="stream" ${S.transAlgo==='stream'?'selected':''}>Stream</option>
          </select>
        </div>
      </div>
    </div>`);

  const optsEl = document.getElementById('tc-opts');
  document.getElementById('tc-enable').onchange = e => {
    S.transEnabled = e.target.checked;
    S.transEnabled ? localStorage.setItem('ms2_trans', '1') : localStorage.removeItem('ms2_trans');
    optsEl.classList.toggle('dimmed', !S.transEnabled);
    // Reload current song with new URL scheme
    if (S.queue[S.idx]) {
      const t = audioEl.currentTime, playing = !audioEl.paused;
      audioEl.src = mediaUrl(S.queue[S.idx].filepath);
      audioEl.currentTime = t;
      if (playing) audioEl.play().catch(() => {});
    }
    toast(S.transEnabled ? 'Transcoding enabled' : 'Transcoding disabled');
  };
  document.getElementById('tc-codec').onchange = e => {
    S.transCodec = e.target.value;
    e.target.value ? localStorage.setItem('ms2_trans_codec', e.target.value) : localStorage.removeItem('ms2_trans_codec');
  };
  document.getElementById('tc-bitrate').onchange = e => {
    S.transBitrate = e.target.value;
    e.target.value ? localStorage.setItem('ms2_trans_bitrate', e.target.value) : localStorage.removeItem('ms2_trans_bitrate');
  };
  document.getElementById('tc-algo').onchange = e => {
    S.transAlgo = e.target.value;
    e.target.value ? localStorage.setItem('ms2_trans_algo', e.target.value) : localStorage.removeItem('ms2_trans_algo');
  };
}

// ── JUKEBOX ───────────────────────────────────────────────────
function viewJukebox() {
  setTitle('Jukebox'); setBack(null); setNavActive('jukebox'); S.view = 'jukebox';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  if (S.jukeCode && S.jukeWs && S.jukeWs.readyState === WebSocket.OPEN) {
    _renderJukeboxActive(S.jukeCode);
    return;
  }

  setBody(`
    <div class="info-panel">
      <div class="info-panel-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15.5 1h-8A2.5 2.5 0 0 0 5 3.5v17A2.5 2.5 0 0 0 7.5 23h8a2.5 2.5 0 0 0 2.5-2.5v-17A2.5 2.5 0 0 0 15.5 1zm-4 21c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4.5-4H7V4h9v14z"/></svg>
      </div>
      <h2>Jukebox Mode</h2>
      <p class="info-hint">Control this player from another device on the same network. Click Connect to generate a shareable remote-control link.</p>
      <button class="btn-primary" id="juke-connect-btn">Connect</button>
    </div>`);

  document.getElementById('juke-connect-btn').onclick = _connectJukebox;
}

function _connectJukebox() {
  const btn = document.getElementById('juke-connect-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/?token=${S.token}`);

  ws.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      // Initial handshake — server sends back the code
      if (msg.code && !S.jukeCode) {
        S.jukeCode = msg.code;
        S.jukeWs = ws;
        if (S.view === 'jukebox') _renderJukeboxActive(msg.code);
      }
      // Remote commands
      if (msg.command) {
        if      (msg.command === 'next')      Player.next();
        else if (msg.command === 'previous')  Player.prev();
        else if (msg.command === 'playPause') Player.toggle();
        else if (msg.command === 'addSong' && msg.file) {
          Player.addSong({ filepath: msg.file, title: msg.file.split('/').pop() });
        }
      }
    } catch(_) {}
  };

  ws.onerror = () => {
    toast('Jukebox connection failed');
    if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
  };

  ws.onclose = () => {
    S.jukeCode = null; S.jukeWs = null;
    if (S.view === 'jukebox') viewJukebox();
  };
}

function _renderJukeboxActive(code) {
  const url = `${location.protocol}//${location.host}/remote/${code}`;

  // Generate QR code locally — no external service needed
  let qrSvg = '';
  try {
    const QRC = qrcodegen.QrCode;
    const qr  = QRC.encodeText(url, QRC.Ecc.MEDIUM);
    // toSvgString(border) returns a full <svg> string
    const raw = qr.toSvgString(2);
    // Inject sizing + theme-aware colours into the generated SVG
    qrSvg = raw
      .replace('<svg ', '<svg width="180" height="180" style="border-radius:8px" ')
      .replace(/fill="#000000"/g, 'fill="var(--t1)"')
      .replace(/fill="#ffffff"/g, 'fill="var(--surface)"');
  } catch(e) {
    qrSvg = `<div style="width:180px;height:180px;display:flex;align-items:center;justify-content:center;background:var(--raised);border-radius:8px;color:var(--t3);font-size:12px">QR unavailable</div>`;
  }

  setBody(`
    <div class="jukebox-panel">
      <div class="jukebox-header">
        <div class="jukebox-live-dot"></div>
        <h2>Jukebox Active</h2>
      </div>
      <p class="jukebox-hint">Scan the QR code or share the link to control this player from another device.</p>
      ${qrSvg}
      <div class="jukebox-code-row">
        <span class="jukebox-code-label">Code</span>
        <strong class="jukebox-code-val">${esc(code)}</strong>
      </div>
      <div style="display:flex;align-items:center;gap:8px;max-width:100%">
        <a class="jukebox-url" href="${esc(url)}" target="_blank" rel="noopener" style="flex:1;min-width:0">${esc(url)}</a>
        <button class="btn-ghost" id="juke-copy-btn" style="flex-shrink:0;padding:6px 12px;font-size:12px">Copy</button>
      </div>
      <button class="btn-ghost jukebox-disc" id="juke-disc-btn">Disconnect</button>
    </div>`);

  document.getElementById('juke-copy-btn').onclick = () => {
    navigator.clipboard.writeText(url).then(() => toast('Link copied!')).catch(() => {
      // Fallback for insecure contexts
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      toast('Link copied!');
    });
  };

  document.getElementById('juke-disc-btn').onclick = () => {
    S.jukeWs?.close();
    S.jukeWs = null; S.jukeCode = null;
    viewJukebox();
  };
}

// ── APPS ──────────────────────────────────────────────────────
function viewApps() {
  setTitle('Mobile Apps'); setBack(null); setNavActive('apps'); S.view = 'apps';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  setBody(`
    <div class="apps-panel">
      <h2>Mobile Apps</h2>
      <p class="apps-desc">Listen to your music on the go with the official mStream apps.</p>
      <div class="apps-grid">
        <a class="app-card" href="https://play.google.com/store/apps/details?id=mstream.music" target="_blank" rel="noopener">
          <svg class="app-card-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M3.18 23.76A1.51 1.51 0 0 1 2 22.36V1.64A1.51 1.51 0 0 1 3.18.24L13.6 12 3.18 23.76zM16.2 9.06l-2.58-2.58L5.8 1.68l8.37 4.83 2.03 2.55zm1.94 1.81L16.2 9.06 14.6 12l1.6 2.94 1.94-1.13a.97.97 0 0 0 0-1.94zM5.8 22.32l7.82-4.8-2.03-2.55-5.79 7.35z"/></svg>
          <div>
            <div class="app-card-title">Android</div>
            <div class="app-card-sub">Get it on Google Play</div>
          </div>
        </a>
        <a class="app-card" href="https://apps.apple.com/us/app/mstream-player/id1605378892" target="_blank" rel="noopener">
          <svg class="app-card-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
          <div>
            <div class="app-card-title">iOS</div>
            <div class="app-card-sub">Download on the App Store</div>
          </div>
        </a>
      </div>
      <div class="apps-qr-section">
        <h3>Add this server to the app</h3>
        <p>Use the QR code tool to quickly connect a mobile device to this server.</p>
        <a class="btn-primary" href="/qr" target="_blank" rel="noopener">Open QR Tool</a>
      </div>
    </div>`);
}

// ── PLAY HISTORY VIEW ────────────────────────────────────────
function viewPlayHistory() {
  setTitle('Play History'); setBack(null); setNavActive('play-history'); S.view = 'play-history';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  setBody(`
    <div class="playback-panel">
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">🏆</div>
          <div>
            <div class="playback-section-title">Most Played</div>
            <div class="playback-section-desc">Reset all play-count statistics to zero. The Most Played list will be empty until songs are played again.</div>
          </div>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Play counts</div>
            <div class="playback-row-hint">Clears the play-count number on every song</div>
          </div>
          <button class="btn-danger" id="reset-play-counts-btn">Reset</button>
        </div>
      </div>
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">🕐</div>
          <div>
            <div class="playback-section-title">Recently Played</div>
            <div class="playback-section-desc">Reset all last-played timestamps. The Recently Played list will be empty until songs are played again.</div>
          </div>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Last-played timestamps</div>
            <div class="playback-row-hint">Clears the date each song was last played</div>
          </div>
          <button class="btn-danger" id="reset-recently-played-btn">Reset</button>
        </div>
      </div>
    </div>`);

  document.getElementById('reset-play-counts-btn').addEventListener('click', () => {
    showConfirmModal(
      'Reset Most Played',
      'All play counts will be set to zero. This cannot be undone.',
      async () => {
        try {
          await api('POST', 'api/v1/db/stats/reset-play-counts', {});
          toast('\u2713 Most Played counts reset');
        } catch(e) { toast(`Error: ${esc(e.message)}`); }
      }
    );
  });

  document.getElementById('reset-recently-played-btn').addEventListener('click', () => {
    showConfirmModal(
      'Reset Recently Played',
      'All last-played timestamps will be cleared. This cannot be undone.',
      async () => {
        try {
          await api('POST', 'api/v1/db/stats/reset-recently-played', {});
          toast('\u2713 Recently Played history reset');
        } catch(e) { toast(`Error: ${esc(e.message)}`); }
      }
    );
  });
}

// ── PLAYBACK VIEW ─────────────────────────────────────────────
function viewPlayback() {
  setTitle('Playback'); setBack(null); setNavActive('playback'); S.view = 'playback';
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;

  const xf = S.crossfade;
  const sleepActive = S.sleepMins > 0;
  const sleepRemaining = sleepActive ? Math.max(0, Math.ceil((S.sleepEndsAt - Date.now()) / 60000)) : 0;

  setBody(`
    <div class="playback-panel">

      <!-- ── CROSSFADE ── -->
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">🎚️</div>
          <div>
            <div class="playback-section-title">Crossfade</div>
            <div class="playback-section-desc">Smoothly blend between tracks — the current song fades out while the next fades in.</div>
          </div>
        </div>
        <div class="playback-row">
          <div class="playback-row-label">
            <div class="playback-row-name">Crossfade Duration</div>
            <div class="playback-row-hint">0 = disabled · max 12 seconds</div>
          </div>
          <div class="xf-ctrl">
            <input type="range" id="xf-slider" class="xf-slider" min="0" max="12" step="1" value="${xf}">
            <span id="xf-val" class="xf-val">${xf === 0 ? 'Off' : xf + 's'}</span>
          </div>
        </div>
      </div>

      <!-- ── SLEEP TIMER ── -->
      <div class="playback-section">
        <div class="playback-section-hdr">
          <div class="playback-section-icon">😴</div>
          <div>
            <div class="playback-section-title">Sleep Timer</div>
            <div class="playback-section-desc">Playback fades out and stops automatically after the chosen time.</div>
          </div>
        </div>
        ${sleepActive ? `
        <div class="sleep-active-box" id="sleep-active-box">
          <div class="sleep-active-info">
            <span class="sleep-active-label">Timer active</span>
            <span class="sleep-active-remaining" id="sleep-view-remaining">${sleepRemaining} min remaining</span>
          </div>
          <button class="sleep-cancel-btn" id="sleep-cancel-btn">Cancel</button>
        </div>` : ''}
        <div class="sleep-presets" id="sleep-presets">
          <button class="sleep-preset" data-mins="15">15 min</button>
          <button class="sleep-preset" data-mins="30">30 min</button>
          <button class="sleep-preset" data-mins="60">60 min</button>
          <button class="sleep-preset" data-mins="90">90 min</button>
          <button class="sleep-preset" data-mins="-1">End of song</button>
        </div>
      </div>

    </div>`);

  // Crossfade slider
  const xfSlider = document.getElementById('xf-slider');
  const xfVal    = document.getElementById('xf-val');
  xfSlider.addEventListener('input', () => {
    const v = parseInt(xfSlider.value);
    xfVal.textContent = v === 0 ? 'Off' : v + 's';
    S.crossfade = v;
    localStorage.setItem('ms2_crossfade', v);
  });

  // Sleep presets
  document.getElementById('sleep-presets').addEventListener('click', e => {
    const btn = e.target.closest('.sleep-preset');
    if (!btn) return;
    const mins = parseInt(btn.dataset.mins);
    setSleepTimer(mins);
    viewPlayback(); // re-render to show active box
  });
  const cancelBtn = document.getElementById('sleep-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { setSleepTimer(0); viewPlayback(); });
}

// ── SLEEP TIMER LOGIC ─────────────────────────────────────────
function setSleepTimer(mins) {
  // Cancel any existing timer
  clearInterval(_sleepTimer);
  _sleepTimer = null;
  S.sleepMins = 0;
  S.sleepEndsAt = 0;
  _updateSleepLight();

  if (mins === 0) return;

  if (mins === -1) {
    // End of current song — trigger when 'ended' fires next
    S.sleepMins = -1;
    S.sleepEndsAt = -1;
    toast('Sleep: will stop after this song');
    _updateSleepLight();
    return;
  }

  S.sleepMins = mins;
  S.sleepEndsAt = Date.now() + mins * 60000;
  toast(`Sleep timer set · ${mins} min`);
  _updateSleepLight();

  _sleepTimer = setInterval(() => {
    const remaining = S.sleepEndsAt - Date.now();
    _updateSleepLight();
    // Update the playback view remaining label if visible
    const remEl = document.getElementById('sleep-view-remaining');
    if (remEl) remEl.textContent = Math.max(0, Math.ceil(remaining / 60000)) + ' min remaining';

    if (remaining <= 0) {
      clearInterval(_sleepTimer);
      _sleepTimer = null;
      S.sleepMins = 0;
      _updateSleepLight();
      _sleepFadeOut();
    }
  }, 15000); // update every 15 s
}

function _updateSleepLight() {
  const el = document.getElementById('sleep-light');
  const cd = document.getElementById('sleep-countdown');
  if (!el) return;
  if (S.sleepMins === 0) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  if (S.sleepMins === -1) {
    cd.textContent = 'end of song';
  } else {
    const mins = Math.max(0, Math.ceil((S.sleepEndsAt - Date.now()) / 60000));
    cd.textContent = mins + 'm';
  }
}

function _sleepFadeOut() {
  // Fade volume to 0 over 10 seconds then pause
  const startVol = audioEl.volume;
  const steps = 40;
  const stepMs = 10000 / steps;
  const dec = startVol / steps;
  let step = 0;
  const iv = setInterval(() => {
    step++;
    audioEl.volume = Math.max(0, startVol - dec * step);
    if (step >= steps) {
      clearInterval(iv);
      audioEl.pause();
      audioEl.volume = startVol; // restore volume for next play
      toast('Sleep timer — playback stopped');
      S.sleepMins = 0;
      _updateSleepLight();
    }
  }, stepMs);
}

// ── CROSSFADE LOGIC ───────────────────────────────────────────
// _xfadeEl is connected to the SAME Web Audio graph as audioEl (both go
// through _audioGain → EQ → analysers → destination).  It starts the next
// track at volume 0; the ramp brings _xfadeEl up and audioEl down.
// When audioEl fires 'ended', _doXfadeHandoff does a TRUE element swap:
//   audioEl = _xfadeEl  (already playing, no gap, no reload)
// Event listeners are detached from the old element and attached to the new one.

function _getOrCreateXfadeEl() {
  if (_xfadeEl) return _xfadeEl;
  _xfadeEl = document.createElement('audio');
  _xfadeEl.volume = 0;
  _xfadeEl.style.display = 'none';
  document.body.appendChild(_xfadeEl);
  _xfadeWired = false;
  return _xfadeEl;
}

function _connectXfadeToAudio() {
  if (_xfadeWired || !_audioGain || !_xfadeEl) return;
  try {
    const xSrc = audioCtx.createMediaElementSource(_xfadeEl);
    xSrc.connect(_audioGain);
    _xfadeWired = true;
  } catch(e) { /* already connected or no audioCtx */ }
}

function _startCrossfade(nextIdx) {
  if (_xfadeFired) return;
  _xfadeFired    = true;
  _xfadeNextIdx  = nextIdx;
  _xfadeStartVol = audioEl.volume;

  const xf     = S.crossfade;
  const steps  = Math.max(20, xf * 10);
  const stepMs = (xf * 1000) / steps;

  VIZ.initAudio();               // ensure audioCtx + _audioGain exist
  const xEl  = _getOrCreateXfadeEl();
  _connectXfadeToAudio();         // wire xfadeEl into the Web Audio graph
  const next = S.queue[nextIdx];
  if (!next) { _xfadeFired = false; return; }
  xEl.src    = mediaUrl(next.filepath);
  xEl.volume = 0;
  xEl.play().catch(() => {});

  let step = 0;
  clearInterval(_xfadeGainIv);
  _xfadeGainIv = setInterval(() => {
    step++;
    const pct      = Math.min(step / steps, 1);
    audioEl.volume = Math.max(0, _xfadeStartVol * (1 - pct));
    xEl.volume     = Math.min(_xfadeStartVol, _xfadeStartVol * pct);
    if (step >= steps) {
      clearInterval(_xfadeGainIv);
      _xfadeGainIv = null;
      // Ramp done — audioEl has at most a few ms left.
      // The 'ended' event will call _doXfadeHandoff to complete the transition.
    }
  }, stepMs);
}

// Called exclusively from the 'ended' handler when _xfadeFired is true.
// _xfadeEl is already playing the next track through Web Audio.
// We do a true element swap: retire the old audioEl, promote _xfadeEl to
// be the new audioEl, reattach all event listeners — zero gap, no reload.
function _doXfadeHandoff(nextIdx) {
  clearInterval(_xfadeGainIv);
  _xfadeGainIv = null;

  const vol     = _xfadeStartVol > 0 ? _xfadeStartVol : 0.8;
  const newEl   = _xfadeEl;
  const oldEl   = audioEl;

  // Clear crossfade state
  _xfadeFired    = false;
  _xfadeNextIdx  = -1;
  _xfadeStartVol = 0;
  _xfadeWired    = false;
  _xfadeEl       = null;

  S.idx = nextIdx;
  const s = S.queue[nextIdx];

  // Detach all permanent listeners from the old element
  _detachAudioListeners(oldEl);
  // Silence + pause the old element (it's no longer 'audioEl')
  oldEl.volume = 0;
  oldEl.pause();
  // Don't clear oldEl.src — leave it for GC; removing src can cause a brief noise

  // Promote the new element
  audioEl = newEl;
  audioEl.volume = vol;

  // Re-attach all permanent listeners to the new element
  _attachAudioListeners(audioEl);
  // The new element is already playing — 'play' won't re-fire, so kick the
  // VU meter and icon sync manually.
  MINI_SPEC.start();
  syncPlayIcons();

  if (!s) return;

  // Update UI / persistence (mirrors Player.playAt without touching audio)
  Player.updateBar();
  highlightRow();
  refreshQueueUI();
  clearTimeout(scrobbleTimer);
  scrobbleTimer = setTimeout(() => {
    api('POST', 'api/v1/lastfm/scrobble-by-filepath', { filePath: s.filepath }).catch(() => {});
  }, 30000);
  persistQueue();
}

function _resetXfade() {
  const wasActive = _xfadeFired;
  const savedVol  = _xfadeStartVol;
  _xfadeFired    = false;
  _xfadeNextIdx  = -1;
  _xfadeStartVol = 0;
  _xfadeWired    = false;
  clearInterval(_xfadeGainIv);
  _xfadeGainIv = null;
  if (_xfadeEl) { _xfadeEl.pause(); _xfadeEl.src = ''; _xfadeEl = null; }
  // Restore volume if the ramp was interrupted mid-way by a manual action
  if (wasActive && savedVol > 0) audioEl.volume = savedVol;
}

// ── SCAN STATUS ───────────────────────────────────────────────
async function pollScan() {
  try {
    const d = await api('GET', 'api/v1/db/status');
    const badge = document.getElementById('scan-badge');
    if (S.isAdmin && d.locked) {
      let locStr = '';
      if (d.scanningVpaths?.length) {
        locStr = ' · ' + d.scanningVpaths.map(s => {
          if (!s.dir) return s.vpath;
          const parts = s.dir.split('/').filter(Boolean);
          return parts.slice(-2).join('/');
        }).join('  |  ');
      }
      badge.textContent = `Scanning… ${d.totalFileCount.toLocaleString()} files${locStr}`;
      badge.classList.add('show');
      scanTimer = setTimeout(pollScan, 3500);
    } else {
      badge.classList.remove('show');
    }
    // Populate S.vpaths from status if checkSession() didn't do it yet
    if (d.vpaths && d.vpaths.length && !S.vpaths.length) {
      S.vpaths = d.vpaths;
      if (!S.djVpaths.length) S.djVpaths = [...S.vpaths];
      if (S.view === 'autodj') viewAutoDJ(); // re-render to show source pills
    }
  } catch(_) {}
}

// ── AUTH ──────────────────────────────────────────────────────
async function tryLogin(username, password) {
  const d = await api('POST', 'api/v1/auth/login', { username, password });
  S.token    = d.token;
  S.username = username;
  S.vpaths   = d.vpaths || [];
  S.djVpaths = [...S.vpaths];  // default: all sources selected
  localStorage.setItem('ms2_token', d.token);
  localStorage.setItem('token', d.token);   // mirror for admin panel compatibility
  localStorage.setItem('ms2_user',  username);
  localStorage.removeItem('ms2_logged_out');
  // Detect admin role after login
  try {
    await api('GET', 'api/v1/admin/directories');
    S.isAdmin = true;
  } catch(_) { S.isAdmin = false; }
}

async function checkSession() {
  if (S.token) {
    // Restore username from localStorage so queue key resolves correctly
    if (!S.username) S.username = localStorage.getItem('ms2_user') || '';
    try {
      const d = await api('GET', 'api/v1/db/status');
      S.vpaths = d.vpaths || [];
      if (S.djVpaths.length === 0) { S.djVpaths = [...S.vpaths]; }
      // detect admin by trying the admin endpoint
      try {
        await api('GET', 'api/v1/admin/directories');
        S.isAdmin = true;
      } catch(_) { S.isAdmin = false; }
      return true;
    } catch(e) {
      if (e.status === 401) { S.token = ''; localStorage.removeItem('ms2_token'); }
    }
  }
  // Fallback for genuine no-auth servers (no users configured at all).
  // Block it if the user explicitly logged out — they must re-enter credentials.
  if (localStorage.getItem('ms2_logged_out')) { return false; }
  try {
    const r = await fetch('/api/v1/db/status');
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      S.vpaths   = d.vpaths || [];
      S.djVpaths = [...S.vpaths];
      // User authenticated via cookie (e.g. arrived from classic UI).
      // Extract the token from the cookie so WS connections and token-based
      // API calls work correctly — the cookie is NOT httpOnly so JS can read it.
      if (!S.token) {
        const m = document.cookie.match(/(?:^|;\s*)x-access-token=([^;]+)/);
        if (m) {
          S.token = decodeURIComponent(m[1]);
          // Also decode the username from the JWT payload (middle segment)
          try {
            const payload = JSON.parse(atob(S.token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
            if (payload.username && !S.username) {
              S.username = payload.username;
              localStorage.setItem('ms2_user', S.username);
            }
          } catch(_) {}
          localStorage.setItem('ms2_token', S.token);
          localStorage.setItem('token', S.token);   // mirror for admin panel compatibility
        }
      }
      return true;
    }
  } catch(_) {}
  return false;
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.remove('hidden');
  if (S.isAdmin) {
    document.getElementById('scan-btn').classList.remove('hidden');
    document.getElementById('admin-panel-btn').classList.remove('hidden');
  }
  // Mark queue btn active (panel is visible by default)
  document.getElementById('queue-btn').classList.add('active');
  loadPlaylists();
  viewRecent();
  refreshQueueUI();
  restoreQueue();
  // Restore auto-DJ state from previous session
  if (localStorage.getItem('ms2_autodj')) { setAutoDJ(true); }
  // Guarantee a save on F5 / tab close
  window.addEventListener('beforeunload', persistQueue);
  pollScan();
  // Fetch ping to get transcode server info + vpath metadata
  api('GET', 'api/v1/ping').then(d => {
    if (d.transcode) {
      S.transInfo = {
        serverEnabled:    true,
        defaultCodec:     d.transcode.defaultCodec     || '',
        defaultBitrate:   d.transcode.defaultBitrate   || '',
        defaultAlgorithm: d.transcode.defaultAlgorithm || '',
      };
    } else {
      S.transInfo = { serverEnabled: false };
    }
    // Store vpath parent/child metadata for Auto-DJ child-vpath optimisation
    if (d.vpathMetaData) { S.vpathMeta = d.vpathMetaData; }
    // Upload capability
    S.canUpload = !d.noUpload;
    if (d.supportedAudioFiles) S.supportedAudioFiles = d.supportedAudioFiles;
  }).catch(() => { S.transInfo = { serverEnabled: false }; });
}
function showLogin() {
  document.getElementById('login-screen').style.display = '';
  document.getElementById('app').classList.add('hidden');
}

// ── EVENTS ────────────────────────────────────────────────────
// Login
document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  btn.disabled = true; btn.textContent = 'Signing in…'; err.textContent = '';
  try {
    await tryLogin(document.getElementById('l-user').value.trim(), document.getElementById('l-pass').value);
    showApp();
  } catch(_) { err.textContent = 'Login failed. Check credentials.'; }
  finally    { btn.disabled = false; btn.textContent = 'Sign In'; }
});

// Sidebar nav
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.view;
    if (v === 'recent')      viewRecent();
    else if (v === 'artists') viewArtists();
    else if (v === 'albums')  viewAllAlbums();
    else if (v === 'search')  viewSearch();
    else if (v === 'rated')   viewRated();
    else if (v === 'most-played') viewMostPlayed();
    else if (v === 'played')  viewPlayed();
    else if (v === 'files')   { S.feDirStack = []; viewFiles('', false); }
    else if (v === 'autodj')  viewAutoDJ();
    else if (v === 'transcode') viewTranscode();
    else if (v === 'jukebox')   viewJukebox();
    else if (v === 'apps')      viewApps();
    else if (v === 'shared-links') viewSharedLinks();
    else if (v === 'playback')  viewPlayback();
    else if (v === 'play-history') viewPlayHistory();
  });
});

// Back button
document.getElementById('back-btn').addEventListener('click', () => S.backFn?.());

// Player controls
document.getElementById('play-btn').addEventListener('click', () => Player.toggle());
document.getElementById('next-btn').addEventListener('click', () => Player.next());
document.getElementById('prev-btn').addEventListener('click', () => Player.prev());

// Shuffle
document.getElementById('shuffle-btn').addEventListener('click', () => {
  S.shuffle = !S.shuffle;
  document.getElementById('shuffle-btn').classList.toggle('active', S.shuffle);
  toast(S.shuffle ? 'Shuffle: On' : 'Shuffle: Off');
});

// Repeat
document.getElementById('repeat-btn').addEventListener('click', () => {
  const modes = ['off', 'all', 'one'];
  S.repeat = modes[(modes.indexOf(S.repeat) + 1) % modes.length];
  const btn = document.getElementById('repeat-btn');
  btn.classList.toggle('active', S.repeat !== 'off');
  btn.title = S.repeat === 'one' ? 'Repeat: One' : S.repeat === 'all' ? 'Repeat: All' : 'Repeat: Off';
  // show "1" on button for repeat-one
  toast(S.repeat === 'one' ? 'Repeat: One song' : S.repeat === 'all' ? 'Repeat: All' : 'Repeat: Off');
});

// Queue toggle (player bar button)
document.getElementById('queue-btn').addEventListener('click', toggleQueue);
// Collapse button inside queue panel
document.getElementById('qp-close-btn').addEventListener('click', () => {
  document.getElementById('queue-panel').classList.add('collapsed');
  document.getElementById('queue-btn').classList.remove('active');
});
// Save queue as playlist
document.getElementById('qp-share-btn').addEventListener('click', () => {
  if (!S.queue.length) { toast('Queue is empty'); return; }
  showSharePlaylistModal(S.queue);
});
document.getElementById('qp-save-btn').addEventListener('click', () => showSavePlaylistModal());
document.getElementById('qp-shuffle-btn').addEventListener('click', () => {
  if (!S.queue.length) return;
  // Fisher-Yates shuffle
  for (let i = S.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [S.queue[i], S.queue[j]] = [S.queue[j], S.queue[i]];
  }
  S.idx = 0;
  refreshQueueUI();
  toast('Queue shuffled');
  persistQueue();
});
document.getElementById('qp-clear-btn').addEventListener('click', () => {
  S.queue = []; S.idx = -1;
  refreshQueueUI();
  toast('Queue cleared');
  persistQueue();
});

// Logout
document.getElementById('logout-btn').addEventListener('click', () => {
  if (S.username) localStorage.removeItem(_queueKey());
  // Flush queue to localStorage NOW, before we clear S.username (persistQueue
  // guards on S.username so it must be called while it still has a value).
  persistQueue();
  // Full W3C reset: pause → remove src → load() wipes all internal play state
  // so no spurious 'play' event can fire when restoreQueue() assigns a new src.
  audioEl.pause();
  audioEl.removeAttribute('src');
  audioEl.load();
  MINI_SPEC.stop();
  syncPlayIcons();  // guarantee ▶ icon before login screen appears
  S.token = ''; S.username = '';
  localStorage.removeItem('ms2_token'); localStorage.removeItem('ms2_user');
  // Expire the server-set cookie so a page refresh cannot re-authenticate
  document.cookie = 'x-access-token=; Max-Age=0; path=/; SameSite=Strict';
  localStorage.setItem('ms2_logged_out', '1');
  showLogin();
});

// Scan button (admin)
document.getElementById('scan-btn').addEventListener('click', async () => {
  try {
    await api('POST', 'api/v1/admin/db/scan/all', {});
    toast('Library scan started');
    pollScan();
  } catch(e) { toast('Scan failed: ' + e.message); }
});

// New playlist
document.getElementById('new-pl-btn').addEventListener('click', () => showNewPlaylistModal());
document.getElementById('pl-new-cancel').addEventListener('click', () => hideModal('pl-new-modal'));
document.getElementById('pl-new-ok').addEventListener('click', async () => {
  const name = document.getElementById('pl-new-name').value.trim();
  if (!name) return;
  hideModal('pl-new-modal');
  try {
    await api('POST', 'api/v1/playlist/new', { title: name });
    await loadPlaylists();
    toast(`Playlist "${name}" created`);
  } catch(e) { toast('Failed to create playlist: ' + e.message); }
});

// Save playlist modal
document.getElementById('share-pl-cancel').addEventListener('click', () => hideModal('share-pl-modal'));
document.getElementById('pl-save-cancel').addEventListener('click', () => hideModal('pl-save-modal'));
document.getElementById('pl-save-ok').addEventListener('click', async () => {
  const name = document.getElementById('pl-save-name').value.trim();
  if (!name) return;
  hideModal('pl-save-modal');
  try {
    await api('POST', 'api/v1/playlist/save', { title: name, songs: S.queue.map(s => s.filepath) });
    await loadPlaylists();
    toast(`Saved ${S.queue.length} songs to "${name}"`);
    openPlaylist(name);
  } catch(e) { toast('Failed to save playlist: ' + e.message); }
});

// Add to playlist modal cancel
document.getElementById('atp-cancel').addEventListener('click', () => hideModal('atp-modal'));
document.getElementById('pl-del-cancel').addEventListener('click', () => hideModal('pl-del-modal'));
document.getElementById('confirm-modal-cancel').addEventListener('click', () => hideModal('confirm-modal'));
document.getElementById('upload-cancel-btn').addEventListener('click', () => hideModal('upload-modal'));
document.getElementById('pl-del-ok').addEventListener('click', async () => {
  const name = document.getElementById('pl-del-ok').dataset.pl;
  hideModal('pl-del-modal');
  try {
    await api('POST', 'api/v1/playlist/delete', { playlistname: name });
    await loadPlaylists();
    toast(`Deleted "${name}"`);
    if (S.view === 'playlist:' + name) viewRecent();
  } catch(e) { toast('Failed to delete playlist'); }
});

// Context menu actions
document.getElementById('ctx-menu').querySelectorAll('.ctx-item').forEach(btn => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    const song   = S.ctxSong;
    hideCtxMenu();
    if (!song) return;
    if (action === 'add-queue')   { Player.addSong(song); }
    if (action === 'add-playlist'){ showAddToPlaylistModal(song); }
    if (action === 'play-next')   { Player.playNext(song); }
    if (action === 'remove-from-playlist') {
      if (!song._plid) { toast('Cannot remove: missing playlist entry ID'); return; }
      const plName = S.view.replace(/^playlist:/, '');
      try {
        await api('POST', 'api/v1/playlist/remove-song', { id: song._plid });
        toast('Removed from playlist');
        openPlaylist(plName);
      } catch(e) { toast('Failed to remove song'); }
    }
    if (action === 'download')    {
      const a = document.createElement('a');
      a.href = dlUrl(song.filepath);
      a.download = (song.title || song.filepath.split('/').pop());
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }
    if (action === 'rate')        { showRatePanel(0, 0, song); document.getElementById('rate-panel').style.left = '50%'; document.getElementById('rate-panel').style.top = '40%'; }
  });
});

// Rate panel
document.getElementById('rate-stars').querySelectorAll('span').forEach((star, i) => {
  star.addEventListener('mouseenter', () => {
    document.querySelectorAll('#rate-stars span').forEach((s2, j) => s2.classList.toggle('lit', j <= i));
  });
  star.addEventListener('mouseleave', () => {
    const fp  = document.getElementById('rate-panel').dataset.fp;
    const song = S.ctxSong;
    const cur  = Math.round((song?.rating || 0) / 2);
    document.querySelectorAll('#rate-stars span').forEach((s2, j) => s2.classList.toggle('lit', j < cur));
  });
  star.addEventListener('click', async () => {
    const fp  = document.getElementById('rate-panel').dataset.fp;
    const val = parseInt(star.dataset.v);
    hideRatePanel();
    if (!fp) return;
    // Update rating on matching song in current view
    const song = S.curSongs.find(s => s.filepath === fp) || S.ctxSong;
    if (song) song.rating = val;
    // Re-render stars in the row
    document.querySelectorAll(`.row-stars[data-ci]`).forEach(el => {
      const ci = parseInt(el.dataset.ci);
      if (S.curSongs[ci]?.filepath === fp) el.innerHTML = starsHtml(val);
    });
    // Update player stars if this is the current song
    if (S.queue[S.idx]?.filepath === fp) {
      S.queue[S.idx].rating = val;
      Player.updateBar();
    }
    await rateSong(fp, val);
  });
});
document.getElementById('rate-clear').addEventListener('click', async () => {
  const fp = document.getElementById('rate-panel').dataset.fp;
  hideRatePanel();
  if (!fp) return;
  const song = S.curSongs.find(s => s.filepath === fp) || S.ctxSong;
  if (song) { delete song.rating; }
  document.querySelectorAll(`.row-stars[data-ci]`).forEach(el => {
    const ci = parseInt(el.dataset.ci);
    if (S.curSongs[ci]?.filepath === fp) el.innerHTML = starsHtml(0);
  });
  if (S.queue[S.idx]?.filepath === fp) { delete S.queue[S.idx].rating; Player.updateBar(); }
  await rateSong(fp, null);
});

// Player stars click (in player bar)
document.getElementById('player-stars').addEventListener('click', e => {
  const cur = S.queue[S.idx];
  if (!cur) return;
  const rect = document.getElementById('player-stars').getBoundingClientRect();
  showRatePanel(rect.left, rect.top - 80, cur);
  S.ctxSong = cur;
  document.getElementById('rate-panel').dataset.fp = cur.filepath;
});

// ── EQUALIZER ────────────────────────────────────────────────
const EQ = (() => {
  let gains   = JSON.parse(localStorage.getItem('ms2_eq')    || 'null') || Array(8).fill(0);
  let enabled = localStorage.getItem('ms2_eq_on') !== 'false';

  function save() {
    localStorage.setItem('ms2_eq', JSON.stringify(gains));
    localStorage.setItem('ms2_eq_on', enabled ? 'true' : 'false');
  }

  function applyToFilters() {
    if (!eqFilters.length) return;
    eqFilters.forEach((f, i) => { f.gain.value = enabled ? (gains[i] || 0) : 0; });
  }

  const dbLabel = v => (v > 0 ? '+' : '') + v;
  const dbColor = v => v > 0 ? 'var(--primary)' : v < 0 ? 'var(--accent)' : 'var(--t3)';

  function updateSliderUIs() {
    EQ_BANDS.forEach((_, i) => {
      const s = document.getElementById(`eq-s-${i}`);
      const l = document.getElementById(`eq-db-${i}`);
      if (s) s.value = gains[i];
      if (l) { l.textContent = dbLabel(gains[i]); l.style.color = dbColor(gains[i]); }
    });
    updateActivePreset();
  }

  function updateActivePreset() {
    document.querySelectorAll('.eq-preset-btn').forEach(btn => {
      const p = EQ_PRESETS[btn.dataset.preset];
      btn.classList.toggle('active', !!p && JSON.stringify(p) === JSON.stringify(gains));
    });
  }

  function updateBypassUI() {
    const track = document.getElementById('eq-bypass-track');
    const lbl   = document.getElementById('eq-bypass-text');
    if (track) track.classList.toggle('lit', enabled);
    if (lbl)   lbl.textContent = enabled ? 'On' : 'Off';
    document.getElementById('eq-btn')?.classList.toggle('eq-active', enabled && gains.some(g => g !== 0));
  }

  function renderSliders() {
    const wrap = document.getElementById('eq-sliders');
    if (!wrap) return;
    wrap.innerHTML = EQ_BANDS.map((b, i) => `
      <div class="eq-band">
        <span class="eq-db" id="eq-db-${i}" style="color:${dbColor(gains[i])}">${dbLabel(gains[i])}</span>
        <div class="eq-slider-wrap"><input type="range" class="eq-slider" id="eq-s-${i}"
          min="-12" max="12" step="0.5" value="${gains[i]}"></div>
        <span class="eq-freq">${esc(b.label)}</span>
      </div>`).join('');
    EQ_BANDS.forEach((_, i) => {
      document.getElementById(`eq-s-${i}`).addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        gains[i] = v;
        const l = document.getElementById(`eq-db-${i}`);
        if (l) { l.textContent = dbLabel(v); l.style.color = dbColor(v); }
        applyToFilters(); save(); updateActivePreset(); updateBypassUI();
      });
    });
    document.querySelectorAll('.eq-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = EQ_PRESETS[btn.dataset.preset];
        if (!p) return;
        gains = [...p];
        applyToFilters(); save(); updateSliderUIs(); updateBypassUI();
      });
    });
    updateActivePreset();
  }

  function open() {
    const panel = document.getElementById('eq-panel');
    panel.classList.remove('hidden');
    requestAnimationFrame(() => panel.classList.add('open'));
    renderSliders();
    updateBypassUI();
  }

  function close() {
    const panel = document.getElementById('eq-panel');
    panel.classList.remove('open');
    panel.addEventListener('transitionend', () => panel.classList.add('hidden'), { once: true });
  }

  function toggle() {
    const panel = document.getElementById('eq-panel');
    (panel.classList.contains('hidden') || !panel.classList.contains('open')) ? open() : close();
  }

  document.getElementById('eq-bypass-track').addEventListener('click', () => {
    enabled = !enabled;
    applyToFilters(); save(); updateBypassUI();
  });
  document.getElementById('eq-close-btn').addEventListener('click', close);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const panel = document.getElementById('eq-panel');
      if (panel && !panel.classList.contains('hidden')) close();
    }
  });

  updateBypassUI();
  return { toggle, open, close, applyToFilters };
})();

// Close ctx / rate panel on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('#ctx-menu') && !e.target.closest('.ctx-btn') && !e.target.closest('#rate-panel') && !e.target.closest('.row-stars') && !e.target.closest('#player-stars')) {
    hideCtxMenu();
  }
});

// Sync play/pause icon state from audioEl.paused — call this any time the
// icon may be stale (restore, logout, etc.) rather than relying on events.
function syncPlayIcons() {
  const playing = !audioEl.paused;
  document.getElementById('icon-play').classList.toggle('hidden',  playing);
  document.getElementById('icon-pause').classList.toggle('hidden', !playing);
  document.getElementById('np-icon-play').classList.toggle('hidden',  playing);
  document.getElementById('np-icon-pause').classList.toggle('hidden', !playing);
}

// ── AUDIO EVENT HANDLERS (named so they can be moved to a swapped element) ──
function _onAudioPlay()  { syncPlayIcons(); MINI_SPEC.start(); }
function _onAudioPause() { syncPlayIcons(); MINI_SPEC.stop();  }
function _onAudioEnded() {
  if (S.sleepMins === -1) {
    S.sleepMins = 0;
    S.sleepEndsAt = 0;
    _updateSleepLight();
    toast('Sleep timer \u2014 playback stopped');
    return;
  }
  // Crossfade: _xfadeEl is already playing through Web Audio.
  // Swap it into the audioEl role — zero gap.
  if (_xfadeFired) {
    _doXfadeHandoff(_xfadeNextIdx);
    return;
  }
  Player.next();
}
function _onAudioError() {
  const err = audioEl.error;
  if (!err || !audioEl.src) return;
  console.warn(`Audio error code ${err.code}: ${err.message || '(no message)'}`);

  // Code 2 = MEDIA_ERR_NETWORK — connection dropped mid-stream; try to reload.
  if (err.code === MediaError.MEDIA_ERR_NETWORK) {
    if (!S.autoDJ) return; // only auto-recover for Auto-DJ streams
    _reloadFromPosition(0);
    return;
  }

  // Code 3 = MEDIA_ERR_DECODE, Code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED
  // — the file exists but the browser can't parse it (corrupt, unsupported
  //   codec, bad PTS timestamps, etc.).
  if (err.code === MediaError.MEDIA_ERR_DECODE ||
      err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    const song = S.queue[S.idx];
    const name = song ? (song.title || song.filepath.split('/').pop()) : 'Unknown';
    toast(`⚠ Skipping unplayable file: ${name}`);
    Player.next();
    return;
  }
}
function _onAudioStalled() {
  if (!S.autoDJ) return;
  clearTimeout(_netRecoveryTimer);
  _netRecoveryTimer = setTimeout(() => {
    if (audioEl.readyState < 3) {
      console.warn(`Auto-DJ: stream stalled (readyState=${audioEl.readyState}) — recovering`);
      _reloadFromPosition(0);
    }
  }, 5000);
}
function _onAudioPlaying()  { clearTimeout(_netRecoveryTimer); }
function _onAudioCanPlay() { clearTimeout(_netRecoveryTimer); }
function _onAudioTimeupdatePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => { _persistTimer = null; persistQueue(); }, 5000);
}
function _onAudioTimeupdateUI() {
  if (!audioEl.duration) return;
  const pct = (audioEl.currentTime / audioEl.duration) * 100;
  document.getElementById('prog-fill').style.width = pct + '%';
  document.getElementById('time-cur').textContent   = fmt(audioEl.currentTime);
  document.getElementById('time-total').textContent = fmt(audioEl.duration);
  if (S.autoDJ && S.idx === S.queue.length - 1 &&
      (audioEl.duration - audioEl.currentTime) < Math.max(25, S.crossfade + 15)) {
    autoDJPrefetch();
  }
  if (!document.getElementById('np-modal').classList.contains('hidden')) {
    document.getElementById('np-prog-fill').style.width  = pct + '%';
    document.getElementById('np-time-cur').textContent   = fmt(audioEl.currentTime);
    document.getElementById('np-time-total').textContent = fmt(audioEl.duration);
  }
  if (S.crossfade > 0 && !_xfadeFired) {
    const remaining = audioEl.duration - audioEl.currentTime;
    if (remaining > 0 && remaining <= S.crossfade) {
      let nextIdx = -1;
      if (S.shuffle) {
        nextIdx = Math.floor(Math.random() * S.queue.length);
      } else if (S.repeat === 'one') {
        nextIdx = S.idx;
      } else if (S.idx < S.queue.length - 1) {
        nextIdx = S.idx + 1;
      } else if (S.repeat === 'all') {
        nextIdx = 0;
      } else if (S.autoDJ && S.queue.length > S.idx + 1) {
        nextIdx = S.idx + 1;
      }
      if (nextIdx !== -1) _startCrossfade(nextIdx);
    }
  }
  _updateSleepLight();
}

function _attachAudioListeners(el) {
  el.addEventListener('play',        _onAudioPlay);
  el.addEventListener('pause',       _onAudioPause);
  el.addEventListener('ended',       _onAudioEnded);
  el.addEventListener('error',       _onAudioError);
  el.addEventListener('stalled',     _onAudioStalled);
  el.addEventListener('playing',     _onAudioPlaying);
  el.addEventListener('canplay',     _onAudioCanPlay);
  el.addEventListener('timeupdate',  _onAudioTimeupdatePersist);
  el.addEventListener('timeupdate',  _onAudioTimeupdateUI);
}
function _detachAudioListeners(el) {
  el.removeEventListener('play',        _onAudioPlay);
  el.removeEventListener('pause',       _onAudioPause);
  el.removeEventListener('ended',       _onAudioEnded);
  el.removeEventListener('error',       _onAudioError);
  el.removeEventListener('stalled',     _onAudioStalled);
  el.removeEventListener('playing',     _onAudioPlaying);
  el.removeEventListener('canplay',     _onAudioCanPlay);
  el.removeEventListener('timeupdate',  _onAudioTimeupdatePersist);
  el.removeEventListener('timeupdate',  _onAudioTimeupdateUI);
}

// Attach all permanent listeners to the initial audioEl
_attachAudioListeners(audioEl);

// ── NETWORK RECOVERY (proxy / firewall connection reset) ─────
// Reverse proxies (nginx, Caddy…) reset TCP connections mid-stream when
// their proxy_read_timeout or keepalive limits are hit.  The browser logs
// ERR_CONNECTION_RESET / 206 in the console, continues playing from its
// buffer, then silently pauses when the buffer is exhausted.
//
// Two events signal trouble:
//   • 'error'   – MEDIA_ERR_NETWORK (code 2) once the buffer runs dry
//   • 'stalled' – browser stopped receiving bytes (fires 3 s after the
//                 network goes quiet, BEFORE the buffer actually runs out)
//
// Recovery: capture currentTime, call load() to re-issue the HTTP request,
// then seek back and resume.  If the proxy resets that request too, we retry
// with exponential back-off (max 5 attempts, 1 → 2 → 4 → 8 → 16 s).

let _netRecoveryTimer = null;

function _reloadFromPosition(attempt) {
  attempt = attempt || 0;
  if (attempt > 5) { console.error('Auto-DJ: gave up after 5 recovery attempts'); return; }
  const resumeAt = audioEl.currentTime;
  const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
  console.warn(`Auto-DJ: recovery attempt ${attempt + 1}/5 — resume from ${Math.round(resumeAt)}s in ${delay}ms`);
  clearTimeout(_netRecoveryTimer);
  _netRecoveryTimer = setTimeout(() => {
    audioEl.load(); // re-issues the HTTP GET through the proxy
    const onMeta = () => {
      if (resumeAt > 1) audioEl.currentTime = resumeAt;
      VIZ.initAudio();
      audioEl.play().catch(() => _reloadFromPosition(attempt + 1));
    };
    audioEl.addEventListener('loadedmetadata', onMeta, { once: true });
    // If loadedmetadata never fires (proxy keeps resetting), retry
    const retryTimer = setTimeout(() => {
      audioEl.removeEventListener('loadedmetadata', onMeta);
      if (S.autoDJ && audioEl.paused) _reloadFromPosition(attempt + 1);
    }, 12000);
    // Clean up retry timer once we're actually playing
    audioEl.addEventListener('playing', () => clearTimeout(retryTimer), { once: true });
  }, delay);
}

// (error, stalled, playing, canplay, timeupdate × 2 are all registered via _attachAudioListeners above)
document.getElementById('prog-track').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  if (audioEl.duration) audioEl.currentTime = ((e.clientX - r.left) / r.width) * audioEl.duration;
});
document.getElementById('volume').addEventListener('input', e => { audioEl.volume = e.target.value / 100; });
audioEl.volume = 0.8;

let _preMuteVol = 0.8;
document.getElementById('mute-btn').addEventListener('click', () => {
  if (audioEl.volume > 0) {
    _preMuteVol = audioEl.volume;
    audioEl.volume = 0;
    document.getElementById('volume').value = 0;
    document.getElementById('mute-btn').classList.add('muted');
    document.getElementById('vol-icon-on').classList.add('hidden');
    document.getElementById('vol-icon-off').classList.remove('hidden');
  } else {
    audioEl.volume = _preMuteVol;
    document.getElementById('volume').value = Math.round(_preMuteVol * 100);
    document.getElementById('mute-btn').classList.remove('muted');
    document.getElementById('vol-icon-on').classList.remove('hidden');
    document.getElementById('vol-icon-off').classList.add('hidden');
  }
});
// Restore mute icon if user drags slider back up from 0
document.getElementById('volume').addEventListener('input', e => {
  if (parseFloat(e.target.value) > 0 && audioEl.volume === 0) {
    document.getElementById('mute-btn').classList.remove('muted');
    document.getElementById('vol-icon-on').classList.remove('hidden');
    document.getElementById('vol-icon-off').classList.add('hidden');
  }
});

// NP Modal
document.getElementById('np-open-btn').addEventListener('click', e => {
  if (e.target.closest('#player-stars')) return;
  showNPModal();
});
document.getElementById('np-close-btn').addEventListener('click', hideNPModal);
document.getElementById('np-modal').addEventListener('click', e => {
  if (!e.target.closest('#np-box')) hideNPModal();
});
document.getElementById('np-play-btn').addEventListener('click', () => Player.toggle());
document.getElementById('np-prev-btn').addEventListener('click', () => Player.prev());
document.getElementById('np-next-btn').addEventListener('click', () => Player.next());
document.getElementById('np-prog-track').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  if (audioEl.duration) audioEl.currentTime = ((e.clientX - r.left) / r.width) * audioEl.duration;
});
document.getElementById('np-viz-btn').addEventListener('click', () => { hideNPModal(); VIZ.open(); });

// Visualizer
document.getElementById('viz-open-btn').addEventListener('click', () => VIZ.open());
document.getElementById('viz-close-btn').addEventListener('click', () => VIZ.close());
document.getElementById('viz-prev-btn').addEventListener('click', () => VIZ.prev());
document.getElementById('viz-next-btn').addEventListener('click', () => VIZ.next());
document.getElementById('viz-mode-btn').addEventListener('click', () => VIZ.toggleMode());
document.getElementById('eq-btn').addEventListener('click', () => EQ.toggle());
window.addEventListener('resize', () => {
  const overlay = document.getElementById('viz-overlay');
  if (overlay.classList.contains('hidden')) return;
  const canvas = document.getElementById('viz-canvas');
  canvas.width  = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
});
document.getElementById('np-rate-clear').addEventListener('click', async () => {
  const s = S.queue[S.idx];
  if (!s) return;
  delete s.rating;
  const ci = S.curSongs.findIndex(cs => cs.filepath === s.filepath);
  if (ci >= 0) {
    delete S.curSongs[ci].rating;
    document.querySelectorAll(`.row-stars[data-ci="${ci}"]`).forEach(el => { el.innerHTML = starsHtml(0); });
  }
  document.querySelectorAll('#np-rate-stars span').forEach(s2 => s2.classList.remove('lit'));
  Player.updateBar();
  await rateSong(s.filepath, null);
});

document.getElementById('np-rate-stars').querySelectorAll('span').forEach((star, i) => {
  star.addEventListener('mouseenter', () => {
    document.querySelectorAll('#np-rate-stars span').forEach((s2, j) => s2.classList.toggle('lit', j <= i));
  });
  star.addEventListener('mouseleave', () => {
    const cur = Math.round((S.queue[S.idx]?.rating || 0) / 2);
    document.querySelectorAll('#np-rate-stars span').forEach((s2, j) => s2.classList.toggle('lit', j < cur));
  });
  star.addEventListener('click', async () => {
    const s = S.queue[S.idx];
    if (!s) return;
    const val = parseInt(star.dataset.v);
    s.rating = val;
    const ci = S.curSongs.findIndex(cs => cs.filepath === s.filepath);
    if (ci >= 0) {
      S.curSongs[ci].rating = val;
      document.querySelectorAll(`.row-stars[data-ci="${ci}"]`).forEach(el => { el.innerHTML = starsHtml(val); });
    }
    Player.updateBar();
    await rateSong(s.filepath, val);
  });
});

// ── PLAYLIST MODAL WIRING ─────────────────────────────────────

// "New playlist" button in sidebar
document.getElementById('new-pl-btn').addEventListener('click', () => showNewPlaylistModal());

// "Save queue as playlist" button in queue panel
document.getElementById('qp-save-btn').addEventListener('click', () => {
  if (!S.queue.length) { toast('Queue is empty'); return; }
  showSavePlaylistModal();
});

// pl-new modal
document.getElementById('pl-new-cancel').addEventListener('click', () => hideModal('pl-new-modal'));
document.getElementById('pl-new-ok').addEventListener('click', async () => {
  const name = document.getElementById('pl-new-name').value.trim();
  if (!name) return;
  hideModal('pl-new-modal');
  try {
    await api('POST', 'api/v1/playlist/new', { title: name });
    await loadPlaylists();
    toast(`Playlist "${name}" created`);
    openPlaylist(name);
  } catch(e) { toast(e.message?.includes('Already Exists') ? `"${name}" already exists` : 'Failed to create playlist'); }
});
document.getElementById('pl-new-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('pl-new-ok').click();
});

// pl-save modal (save current queue into a named playlist)
document.getElementById('pl-save-cancel').addEventListener('click', () => hideModal('pl-save-modal'));
document.getElementById('pl-save-ok').addEventListener('click', async () => {
  const name = document.getElementById('pl-save-name').value.trim();
  if (!name) return;
  hideModal('pl-save-modal');
  try {
    await api('POST', 'api/v1/playlist/save', { title: name, songs: S.queue.map(s => s.filepath) });
    await loadPlaylists();
    toast(`Saved ${S.queue.length} songs to "${name}"`);
  } catch(e) { toast('Failed to save playlist'); }
});
document.getElementById('pl-save-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('pl-save-ok').click();
});

// atp-cancel
document.getElementById('atp-cancel').addEventListener('click', () => hideModal('atp-modal'));

// ── THEME ─────────────────────────────────────────────────────
function applyTheme(light) {
  document.documentElement.classList.toggle('light', light);
  const track = document.getElementById('theme-track');
  const label = document.getElementById('theme-label');
  if (track) track.classList.toggle('lit', light);
  if (label) label.textContent = light ? 'Light Mode' : 'Dark Mode';
  localStorage.setItem('ms2_theme', light ? 'light' : 'dark');
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  applyTheme(!document.documentElement.classList.contains('light'));
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
  if (e.code === 'Escape')     { hideNPModal(); hideCtxMenu(); VIZ.close(); }
  if (e.code === 'Space')       { e.preventDefault(); Player.toggle(); }
  if (e.code === 'ArrowRight')  { e.preventDefault(); Player.next(); }
  if (e.code === 'ArrowLeft')   { e.preventDefault(); Player.prev(); }
  if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey) { S.shuffle = !S.shuffle; document.getElementById('shuffle-btn').classList.toggle('active', S.shuffle); toast(S.shuffle ? 'Shuffle: On' : 'Shuffle: Off'); }
});

// ── SIDEBAR COLLAPSE ─────────────────────────────────────────
(function initSectionCollapse() {
  const KEY = 'ms2_nav_collapsed';
  const stored = new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
  document.querySelectorAll('.nav-section').forEach(section => {
    if (stored.has(section.dataset.section)) section.classList.add('collapsed');
    section.querySelector('.nav-toggle').addEventListener('click', e => {
      if (e.target.closest('#new-pl-btn')) return;
      section.classList.toggle('collapsed');
      const collapsed = [...document.querySelectorAll('.nav-section.collapsed')]
        .map(s => s.dataset.section);
      localStorage.setItem(KEY, JSON.stringify(collapsed));
    });
  });
}());

// ── INIT ─────────────────────────────────────────────────────
(async () => {
  // Apply saved theme before anything renders (prevents flash)
  applyTheme(localStorage.getItem('ms2_theme') === 'light');

  const ok = await checkSession();
  ok ? showApp() : showLogin();
})();
