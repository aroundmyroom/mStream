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
  playlists:[],
  view:     'recent',
  backFn:   null,
  curSongs: [],      // songs in current view (for play-all / add-all)
  ctxSong:  null,    // song target for context menu
  feDir:    '',      // file explorer current path
  feDirStack: [],    // navigation history stack
};

const audioEl = document.getElementById('audio');
let scanTimer    = null;
let djTimer      = null;
let scrobbleTimer = null;
let audioCtx     = null;   // shared Web Audio context (initialised by VIZ.open)
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
function mediaUrl(fp) { return `/media/${String(fp).replace(/^\/+/, '')}?token=${S.token}`; }
function dlUrl(fp)    { return `/media/${String(fp).replace(/^\/+/, '')}?token=${S.token}`; }

let _toastT;
function toast(msg, ms = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.add('hidden'), ms);
}

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
  },
  addAll(songs) {
    S.queue.push(...songs);
    toast(`Added ${songs.length} songs to queue`);
    refreshQueueUI();
  },
  playNext(song) {
    const insertAt = S.idx + 1;
    S.queue.splice(insertAt, 0, song);
    toast('Playing next: ' + (song.title || song.filepath.split('/').pop()));
    refreshQueueUI();
  },
  playAt(idx) {
    if (idx < 0 || idx >= S.queue.length) return;
    S.idx = idx;
    const s = S.queue[idx];
    audioEl.src = mediaUrl(s.filepath);
    audioEl.load();
    audioEl.play().catch(() => {});
    VIZ.initAudio();   // ensure AudioContext + L/R analysers exist for mini spectrum
    this.updateBar();
    highlightRow();
    refreshQueueUI();
    // Scrobble after 30 s (logs play count + last-played timestamp)
    clearTimeout(scrobbleTimer);
    scrobbleTimer = setTimeout(() => {
      api('POST', 'api/v1/lastfm/scrobble-by-filepath', { filePath: s.filepath }).catch(() => {});
    }, 30000);
  },
  toggle() {
    if (!audioEl.src) return;
    audioEl.paused ? audioEl.play().catch(() => {}) : audioEl.pause();
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
    const thumb = document.getElementById('player-art');
    const u = artUrl(s['album-art'], 'l');
    thumb.innerHTML = u
      ? `<img src="${u}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
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
  document.getElementById('dj-light').classList.toggle('hidden', !on);
  // update autodj page if visible
  const btn = document.querySelector('.autodj-toggle');
  if (btn) { btn.classList.toggle('on', on); btn.textContent = on ? '⏹ Stop Auto-DJ' : '▶ Start Auto-DJ'; }
  const status = document.querySelector('.autodj-status');
  if (status) { status.classList.toggle('on', on); status.textContent = on ? 'Auto-DJ is ON — random songs will play continuously' : 'Auto-DJ is OFF'; }
  if (on && S.queue.length === 0) autoDJFetch();
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
    const u = artUrl(cur['album-art'], 'm');
    npCard.innerHTML = `
      <div class="qp-np-track">
        <div class="qp-np-art">
          ${u
            ? `<img src="${u}" loading="lazy" onerror="this.style.display='none'">`
            : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`}
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
    const u = artUrl(s['album-art'], 's');
    const isActive = i === S.idx;
    return `
      <div class="q-item${isActive ? ' q-active' : ''}" data-qi="${i}">
        <div class="q-num">${isActive
          ? `<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>`
          : i + 1}
        </div>
        <div class="q-art">
          ${u
            ? `<img src="${u}" loading="lazy" onerror="this.style.display='none'">`
            : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`}
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
        ${art ? `<img src="${art}" loading="lazy" onerror="this.style.display='none'">` : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`}
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
        ${art ? `<img src="${art}" loading="lazy" onerror="this.style.display='none'">` : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`}
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
    ? `<img src="${u}" alt="" onerror="this.style.display='none'">`
    : `<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.18"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
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
    ['File',        s.filepath],
  ];
  document.getElementById('np-meta').innerHTML = rows.map(([k, v]) =>
    `<span class="np-meta-k">${k}</span>${mv(v)}`
  ).join('');
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
    const baseline = H;

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
        const bh  = Math.max(1, v * H * 0.92);
        const x   = startX + i * (barW + GAP);
        const hue = (1 - v) * 200;
        const grd = ctx.createLinearGradient(0, baseline, 0, baseline - bh);
        grd.addColorStop(0,   `hsla(${hue},100%,48%,.85)`);
        grd.addColorStop(1,   `hsla(${hue+80},100%,72%,.75)`);
        ctx.fillStyle = grd;
        const r = Math.min(barW * .4, 2.5 * dpr);
        ctx.beginPath();
        ctx.roundRect(x, baseline - bh, barW, bh, [r, r, 0, 0]);
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
    const gain     = audioCtx.createGain();
    gain.gain.value = 1.25;
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
function showAddToPlaylistModal(song) {
  const list = document.getElementById('atp-list');
  if (!S.playlists.length) {
    list.innerHTML = `<div class="modal-empty">No playlists yet. Create one first.</div>`;
  } else {
    list.innerHTML = S.playlists.map(p =>
      `<div class="modal-pl-item" data-pl="${esc(p.title)}">
        <svg class="modal-pl-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        ${esc(p.title)}
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
    <div class="pl-row" data-pl="${esc(p.title)}">
      <button class="pl-row-btn" data-pl="${esc(p.title)}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        ${esc(p.title)}
      </button>
      <button class="pl-row-del" data-pl="${esc(p.title)}" title="Delete">×</button>
    </div>`).join('');

  nav.querySelectorAll('.pl-row-btn').forEach(btn => {
    btn.addEventListener('click', () => openPlaylist(btn.dataset.pl));
  });
  nav.querySelectorAll('.pl-row-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const name = btn.dataset.pl;
      if (!confirm(`Delete playlist "${name}"?`)) return;
      try {
        await api('POST', 'api/v1/playlist/delete', { playlistname: name });
        await loadPlaylists();
        toast(`Deleted "${name}"`);
        if (S.view === 'playlist:' + name) viewRecent();
      } catch(e) { toast('Failed to delete playlist'); }
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
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px;gap:8px;">
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
    const artists = d.artists || [];
    if (!artists.length) { setBody('<div class="empty-state">No artists found</div>'); return; }
    S.curSongs = [];
    document.getElementById('play-all-btn').onclick = null;
    document.getElementById('add-all-btn').onclick  = null;
    const body = document.getElementById('content-body');
    body.innerHTML = `<div class="artist-list">${
      artists.map(a => `<div class="artist-row" data-artist="${esc(a)}">
        <div class="artist-av">${esc(a.charAt(0)).toUpperCase()}</div>
        <div class="artist-name">${esc(a)}</div>
      </div>`).join('')
    }</div>`;
    body.querySelectorAll('.artist-row').forEach(row => {
      row.addEventListener('click', () => viewArtistAlbums(row.dataset.artist));
    });
  } catch(e) { setBody(`<div class="empty-state">Error: ${esc(e.message)}</div>`); }
}

async function viewArtistAlbums(artist, backFn) {
  setTitle(artist); setBack(backFn || (() => viewArtists()));
  setBody('<div class="loading-state"></div>');
  try {
    const d = await api('POST', 'api/v1/db/artists-albums', { artist });
    renderAlbumGrid(d.albums || [], artist);
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

function renderAlbumGrid(albums, defaultArtist) {
  if (!albums.length) { setBody('<div class="empty-state">No albums found</div>'); return; }
  S.curSongs = [];
  document.getElementById('play-all-btn').onclick = null;
  document.getElementById('add-all-btn').onclick  = null;
  const body = document.getElementById('content-body');
  body.innerHTML = `<div class="album-grid">${albums.map((a, i) => {
    const name = a.name || 'Singles';
    const art  = artUrl(a.album_art_file, 's');
    return `<div class="album-card" data-i="${i}">
      <div class="album-art">
        ${art
          ? `<img src="${art}" alt="${esc(name)}" loading="lazy" onerror="this.style.display='none'">`
          : `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>`}
        <div class="play-ov"><svg width="30" height="30" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div>
      </div>
      <div class="album-meta">
        <div class="album-name">${esc(name)}</div>
        ${a.year ? `<div class="album-year">${a.year}</div>` : '<div class="album-year">&nbsp;</div>'}
      </div>
    </div>`;
  }).join('')}</div>`;
  body.querySelectorAll('.album-card').forEach(card => {
    card.addEventListener('click', () => {
      const album = albums[parseInt(card.dataset.i)];
      const backFn = defaultArtist ? () => viewArtistAlbums(defaultArtist) : () => viewAllAlbums();
      viewAlbumSongs(album.name, defaultArtist, backFn);
    });
  });
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
    const titleSongs = (d.title || []).map(t => ({
      title:      t.name.includes(' - ') ? t.name.split(' - ').slice(1).join(' - ') : t.name,
      artist:     t.name.includes(' - ') ? t.name.split(' - ')[0] : '',
      filepath:   t.filepath,
      'album-art': t.album_art_file || null,
    }));
    if (titleSongs.length) {
      html += `<div class="search-section"><h3>Songs (${titleSongs.length})</h3><div class="song-list">${renderSongRows(titleSongs)}</div></div>`;
    }
    if (!html) html = `<div class="empty-state">No results for "${esc(q)}"</div>`;
    res.innerHTML = html;

    res.querySelectorAll('.artist-row[data-artist]').forEach(r => r.addEventListener('click', () => viewArtistAlbums(r.dataset.artist, () => viewSearch())));
    res.querySelectorAll('.artist-row[data-album]').forEach(r => r.addEventListener('click', () => viewAlbumSongs(r.dataset.album, null, () => viewSearch())));
    attachSongListEvents(res, titleSongs);
    S.curSongs = titleSongs;
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
    return `
      <div class="fe-file" data-fp="${esc(fp || '')}" data-name="${esc(file.name)}">
        <svg class="fe-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
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

// ── SCAN STATUS ───────────────────────────────────────────────
async function pollScan() {
  try {
    const d = await api('GET', 'api/v1/db/status');
    const badge = document.getElementById('scan-badge');
    if (d.locked) {
      badge.textContent = `Scanning… ${d.totalFileCount.toLocaleString()} files`;
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
  localStorage.setItem('ms2_user',  username);
}

async function checkSession() {
  if (S.token) {
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
  try { const r = await fetch('/api/v1/db/status'); if (r.ok) return true; } catch(_) {}
  return false;
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.remove('hidden');
  if (S.isAdmin) document.getElementById('scan-btn').classList.remove('hidden');
  // Mark queue btn active (panel is visible by default)
  document.getElementById('queue-btn').classList.add('active');
  loadPlaylists();
  viewRecent();
  refreshQueueUI();
  pollScan();
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
});
document.getElementById('qp-clear-btn').addEventListener('click', () => {
  S.queue = []; S.idx = -1;
  refreshQueueUI();
  toast('Queue cleared');
});

// Logout
document.getElementById('logout-btn').addEventListener('click', () => {
  S.token = ''; S.username = '';
  localStorage.removeItem('ms2_token'); localStorage.removeItem('ms2_user');
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
document.getElementById('pl-save-cancel').addEventListener('click', () => hideModal('pl-save-modal'));
document.getElementById('pl-save-ok').addEventListener('click', async () => {
  const name = document.getElementById('pl-save-name').value.trim();
  if (!name) return;
  hideModal('pl-save-modal');
  try {
    await api('POST', 'api/v1/playlist/save', { title: name, songs: S.queue.map(s => s.filepath) });
    await loadPlaylists();
    toast(`Saved ${S.queue.length} songs to "${name}"`);
  } catch(e) { toast('Failed to save playlist: ' + e.message); }
});

// Add to playlist modal cancel
document.getElementById('atp-cancel').addEventListener('click', () => hideModal('atp-modal'));

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
          min="-12" max="12" step="0.5" value="${gains[i]}" orient="vertical"></div>
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

// Audio events
audioEl.addEventListener('play', () => {
  document.getElementById('icon-play').classList.add('hidden');
  document.getElementById('icon-pause').classList.remove('hidden');
  document.getElementById('np-icon-play').classList.add('hidden');
  document.getElementById('np-icon-pause').classList.remove('hidden');
  MINI_SPEC.start();
});
audioEl.addEventListener('pause', () => {
  document.getElementById('icon-play').classList.remove('hidden');
  document.getElementById('icon-pause').classList.add('hidden');
  document.getElementById('np-icon-pause').classList.add('hidden');
  document.getElementById('np-icon-play').classList.remove('hidden');
  MINI_SPEC.stop();
});
audioEl.addEventListener('ended', () => Player.next());
audioEl.addEventListener('timeupdate', () => {
  if (!audioEl.duration) return;
  const pct = (audioEl.currentTime / audioEl.duration) * 100;
  document.getElementById('prog-fill').style.width = pct + '%';
  document.getElementById('time-cur').textContent   = fmt(audioEl.currentTime);
  document.getElementById('time-total').textContent = fmt(audioEl.duration);
  // Auto-DJ pre-fetch: queue next song 10 s before the current one ends
  if (S.autoDJ && S.idx === S.queue.length - 1 &&
      (audioEl.duration - audioEl.currentTime) < 10) {
    autoDJPrefetch();
  }
  if (!document.getElementById('np-modal').classList.contains('hidden')) {
    document.getElementById('np-prog-fill').style.width  = pct + '%';
    document.getElementById('np-time-cur').textContent   = fmt(audioEl.currentTime);
    document.getElementById('np-time-total').textContent = fmt(audioEl.duration);
  }
});
document.getElementById('prog-track').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  if (audioEl.duration) audioEl.currentTime = ((e.clientX - r.left) / r.width) * audioEl.duration;
});
document.getElementById('volume').addEventListener('input', e => { audioEl.volume = e.target.value / 100; });
audioEl.volume = 0.8;

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

// ── INIT ─────────────────────────────────────────────────────
(async () => {
  // Apply saved theme before anything renders (prevents flash)
  applyTheme(localStorage.getItem('ms2_theme') === 'light');

  const ok = await checkSession();
  ok ? showApp() : showLogin();
})();
