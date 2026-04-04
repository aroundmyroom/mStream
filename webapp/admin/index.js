const ADMINDATA = (() => {
  const module = {};

  module.version = { val: false };

  // Used for handling the file explorer selection
  module.sharedSelect = { value: '' };

  // Used for modifying a user
  module.selectedUser = { value: '' };

  // folders
  module.folders = {};
  module.foldersUpdated = { ts: 0 };
  module.winDrives = [];
  // users
  module.users = {};
  module.usersUpdated = { ts: 0 };
  // db stuff
  module.dbParams = {};
  module.dbParamsUpdated = { ts: 0 };
  // server settings
  module.serverParams = {};
  module.serverParamsUpdated = { ts: 0 };
  // transcoding
  module.transcodeParams = {};
  module.transcodeParamsUpdated = { ts: 0 };
  module.downloadPending = { val: false };
  // server audio (mpv)
  module.serverAudioParams = {};
  module.serverAudioParamsUpdated = { ts: 0 };
  // shared playlists
  module.sharedPlaylists = [];
  module.sharedPlaylistUpdated = { ts: 0 };
  // federation
  module.federationEnabled = { val: false };
  module.federationParams = {};
  module.federationParamsUpdated = { ts: 0 };
  module.federationInviteToken = { val: null };

  module.getSharedPlaylists = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/db/shared`
    });

    while(module.sharedPlaylists.length !== 0) {
      module.sharedPlaylists.pop();
    }

    res.data.forEach(item => {
      module.sharedPlaylists.push(item);
    });

    module.sharedPlaylistUpdated.ts = Date.now();
  };

  module.deleteSharedPlaylist = async (playlistObj) => {
    const res = await API.axios({
      method: 'DELETE',
      url: `${API.url()}/api/v1/admin/db/shared`,
      data: { id: playlistObj.playlistId }
    });

    module.sharedPlaylists.splice(module.sharedPlaylists.indexOf(playlistObj), 1);
  };

  module.deleteUnxpShared = async () => {
    const res = await API.axios({
      method: 'DELETE',
      url: `${API.url()}/api/v1/admin/db/shared/eternal`
    });

    // Clear playlist array since we no longer know it's state after this api call
    while(module.sharedPlaylists.length !== 0) {
      module.sharedPlaylists.pop();
    }
  };

  module.deleteExpiredShared = async () => {
    const res = await API.axios({
      method: 'DELETE',
      url: `${API.url()}/api/v1/admin/db/shared/expired`
    });

    // Clear playlist array since we no longer know it's state after this api call
    while(module.sharedPlaylists.length !== 0) {
      module.sharedPlaylists.pop();
    }
  };

  module.getFolders = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/directories`
    });

    Object.keys(res.data).forEach(key=>{
      module.folders[key] = res.data[key];
    });

    module.foldersUpdated.ts = Date.now();
  };

  module.getUsers = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/users`
    });

    Object.keys(res.data).forEach(key=>{
      module.users[key] = res.data[key];
    });

    module.usersUpdated.ts = Date.now();
  };

  module.getDbParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/db/params`
    });

    Object.keys(res.data).forEach(key=>{
      module.dbParams[key] = res.data[key];
    });

    module.dbParamsUpdated.ts = Date.now();
  }

  module.getServerParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/config`
    });

    Object.keys(res.data).forEach(key=>{
      module.serverParams[key] = res.data[key];
    });

    module.serverParamsUpdated.ts = Date.now();
  }

  module.getTranscodeParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/transcode`
    });

    Object.keys(res.data).forEach(key=>{
      module.transcodeParams[key] = res.data[key];
    });

    module.transcodeParamsUpdated.ts = Date.now();
  }

  module.getServerAudioParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/server-audio`
    });

    Object.keys(res.data).forEach(key=>{
      module.serverAudioParams[key] = res.data[key];
    });

    module.serverAudioParamsUpdated.ts = Date.now();
  }

  module.getFederationParams = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/federation/stats`
      });

      if (res.data.enabled === false) {
        module.federationEnabled.val = false;
      } else {
        module.federationEnabled.val = true;
        Object.keys(res.data).forEach(key=>{
          module.federationParams[key] = res.data[key];
        });
      }
    }catch (err) {}

    module.federationParamsUpdated.ts = Date.now();
  }

  module.getVersion = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api`
      });
      module.version.val = res.data.server;
    }catch (err) {} 
  }

  module.getWinDrives = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/file-explorer/win-drives`
      });

      module.winDrives.length = 0;
      res.data.forEach((d) => {
        module.winDrives.push(d);
      });

      return res;
    }catch(err){}
  }

  return module;
})();

// Load in data
ADMINDATA.getTranscodeParams();
ADMINDATA.getServerAudioParams();
ADMINDATA.getFolders();
ADMINDATA.getUsers();
ADMINDATA.getDbParams();
ADMINDATA.getServerParams().then(() => {
  ADMINDATA.getFederationParams();
}).catch(() => {});
ADMINDATA.getVersion();
ADMINDATA.getWinDrives();

// Fetch scan error count for sidebar badge on boot
(async () => {
  try {
    const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/db/scan-errors/count` });
    const badge = document.getElementById('scan-errors-badge');
    if (badge && res.data.count > 0) {
      badge.textContent = res.data.count > 99 ? '99+' : res.data.count;
      badge.style.display = 'inline-flex';
    }
  } catch (_e) {}
})();

// Handle .modal-close class elements
document.addEventListener('click', function(e) {
  if (e.target.closest('.modal-close')) modVM.closeModal();
});

// Intialize Clipboard
new ClipboardJS('.fed-copy-button');

// ── Confirm dialog helper ──────────────────────────────────────
function adminConfirm(title, message, confirmLabel, onConfirm) {
  confirmVM.ask(title, message, confirmLabel, onConfirm);
}

// ── Modal template helpers ─────────────────────────────────────
const mHead = (title, subtitle = '') =>
  `<div class="modal-header"><div><div class="modal-title">${title}</div>${subtitle ? `<div class="modal-subtitle">${subtitle}</div>` : ''}</div><button class="modal-close-x" type="button" @click="closeModal">&times;</button></div>`;
const mFoot = (saveLabel = 'Save', pendingLabel = 'Saving') =>
  `<div class="modal-footer-row"><button class="btn-flat" type="button" @click="closeModal">Cancel</button><button class="btn" type="submit" :disabled="submitPending === true">{{submitPending === false ? '${saveLabel}' : '${pendingLabel}...'}}</button></div>`;

// Global mixin: provides closeModal() to every component
Vue.mixin({
  methods: {
    closeModal() { if (typeof modVM !== 'undefined') modVM.closeModal(); }
  }
});

// ── Wrapped Play Stats Admin View ──────────────────────────────────────────
const wrappedAdminView = Vue.component('wrapped-admin-view', {
  data() {
    return {
      loading:    false,
      loaded:     false,
      stats:      null,   // { total_events, storage_bytes, per_user: [...] }
      purgeUser:  '',
      keepMonths: 12,
      purging:    false,
    };
  },
  computed: {
    storageKB() {
      return this.stats ? (this.stats.storage_bytes / 1024).toFixed(1) : '—';
    },
  },
  mounted() { this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try {
        const r = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/wrapped/stats` });
        this.stats = r.data;
        this.loaded = true;
        // Pre-fill purge user with first in list
        if (this.stats.per_user.length) this.purgeUser = this.stats.per_user[0].user_id;
      } catch (e) {
        iziToast.error({ title: 'Failed to load play stats', position: 'topCenter', timeout: 3000 });
      } finally {
        this.loading = false;
      }
    },
    doPurge() {
      if (!this.purgeUser) return;
      adminConfirm(
        `Purge play events for <b>${this.purgeUser}</b>?`,
        `Events older than ${this.keepMonths} month(s) will be permanently deleted.`,
        'Purge',
        async () => {
          this.purging = true;
          try {
            const r = await API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/wrapped/purge`,
              data: { userId: this.purgeUser, keepMonths: this.keepMonths },
            });
            iziToast.success({ title: `Deleted ${r.data.deleted} events`, position: 'topCenter', timeout: 3000 });
            this.load();
          } catch (e) {
            iziToast.error({ title: 'Purge failed', message: e.message, position: 'topCenter', timeout: 4000 });
          } finally {
            this.purging = false;
          }
        }
      );
    },
    fmtMs(ms) {
      if (!ms) return '0 min';
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      return h ? `${h}h ${m}m` : `${m} min`;
    },
  },
  template: `
    <div>
      <div class="card">
        <div class="card-content">
          <span class="card-title">Play Statistics</span>
          <p class="grey-text">All listening events recorded on this server.</p>
          <div v-if="loading" class="center-align" style="padding:2rem;">Loading…</div>
          <div v-else-if="loaded && stats">
            <div style="display:flex;gap:2rem;flex-wrap:wrap;margin-bottom:1.5rem;">
              <div class="admin-stat-box">
                <div class="admin-stat-value">{{ stats.total_events.toLocaleString() }}</div>
                <div class="admin-stat-label">Song play events</div>
              </div>
              <div class="admin-stat-box">
                <div class="admin-stat-value">{{ stats.total_radio.toLocaleString() }}</div>
                <div class="admin-stat-label">Radio sessions</div>
              </div>
              <div class="admin-stat-box">
                <div class="admin-stat-value">{{ stats.total_podcast.toLocaleString() }}</div>
                <div class="admin-stat-label">Podcast episodes</div>
              </div>
              <div class="admin-stat-box">
                <div class="admin-stat-value">{{ storageKB }} KB</div>
                <div class="admin-stat-label">DB storage used</div>
              </div>
            </div>
            <table class="striped" v-if="stats.per_user.length">
              <thead><tr><th>User</th><th>Songs</th><th>Song time</th><th>Radio sessions</th><th>Radio time</th><th>Podcast eps</th><th>Podcast time</th></tr></thead>
              <tbody>
                <tr v-for="u in stats.per_user" :key="u.user_id">
                  <td>{{ u.user_id }}</td>
                  <td>{{ u.event_count.toLocaleString() }}</td>
                  <td>{{ fmtMs(u.total_played_ms) }}</td>
                  <td>{{ u.radio_sessions.toLocaleString() }}</td>
                  <td>{{ fmtMs(u.total_radio_ms) }}</td>
                  <td>{{ u.podcast_episodes.toLocaleString() }}</td>
                  <td>{{ fmtMs(u.total_podcast_ms) }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="grey-text">No play events recorded yet.</p>
          </div>
        </div>
      </div>

      <div class="card" v-if="loaded && stats && stats.per_user.length">
        <div class="card-content">
          <span class="card-title">Purge Old Events</span>
          <p class="grey-text">Delete play events older than N months for a specific user.</p>
          <div style="display:flex;gap:1rem;align-items:flex-end;flex-wrap:wrap;">
            <div class="input-field" style="margin:0;">
              <select v-model="purgeUser" style="display:block;padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);">
                <option v-for="u in stats.per_user" :key="u.user_id" :value="u.user_id">{{ u.user_id }}</option>
              </select>
              <label style="position:static;font-size:.8rem;color:var(--fg-muted);">User</label>
            </div>
            <div class="input-field" style="margin:0;">
              <input type="number" v-model.number="keepMonths" min="1" max="60" style="width:5rem;" />
              <label style="position:static;font-size:.8rem;color:var(--fg-muted);">Keep months</label>
            </div>
            <button class="btn red darken-1" :disabled="purging" @click="doPurge">
              {{ purging ? 'Purging…' : 'Purge' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
});

// ── Scan Error Audit View ──────────────────────────────────────────────────
const scanErrorsView = Vue.component('scan-errors-view', {
  data() {
    return {
      errors:          [],
      total:           0,
      loading:         false,
      loaded:          false,
      expandedRow:     null,
      typeFilter:      null,
      retentionHours:  ADMINDATA.dbParams.scanErrorRetentionHours || 48,
      savingRetention: false,
      fixing:          {},   // guid → true while fix API call is in-flight
    };
  },
  computed: {
    filteredErrors() {
      if (!this.typeFilter) return this.errors;
      return this.errors.filter(e => e.error_type === this.typeFilter);
    },
    typeCounts() {
      const c = {};
      for (const e of this.errors) { c[e.error_type] = (c[e.error_type] || 0) + 1; }
      return c;
    },
    allTypes() {
      return [...new Set(this.errors.map(e => e.error_type))];
    },
    unfixedCount() {
      return this.errors.filter(e => !e.fixed_at && e.file_in_db).length;
    }
  },
  mounted() { this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try {
        const [errRes, paramRes] = await Promise.all([
          API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/db/scan-errors` }),
          API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/db/params` })
        ]);
        this.errors = errRes.data.errors;
        this.total  = errRes.data.total;
        this.loaded = true;
        if (paramRes.data.scanErrorRetentionHours) {
          this.retentionHours = paramRes.data.scanErrorRetentionHours;
        }
        const badge = document.getElementById('scan-errors-badge');
        if (badge) {
          const cnt = this.unfixedCount;
          badge.textContent = cnt > 99 ? '99+' : cnt;
          badge.style.display = cnt === 0 ? 'none' : 'inline-flex';
        }
      } catch (err) {
        iziToast.error({ title: 'Failed to load scan errors', position: 'topCenter', timeout: 3000 });
      } finally {
        this.loading = false;
      }
    },
    confirmClear() {
      adminConfirm(
        'Clear all scan errors?',
        'This deletes the entire error history. Errors will re-appear on the next scan if the underlying problems persist.',
        'Clear All',
        () => this.doClear()
      );
    },
    async doClear() {
      try {
        await API.axios({ method: 'DELETE', url: `${API.url()}/api/v1/admin/db/scan-errors` });
        this.errors = [];
        this.total  = 0;
        this.typeFilter = null;
        const badge = document.getElementById('scan-errors-badge');
        if (badge) badge.style.display = 'none';
        iziToast.success({ title: 'Scan errors cleared', position: 'topCenter', timeout: 2500 });
      } catch (err) {
        iziToast.error({ title: 'Failed to clear errors', position: 'topCenter', timeout: 3000 });
      }
    },
    async saveRetention() {
      this.savingRetention = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/scan-error-retention`,
          data: { hours: Number(this.retentionHours) }
        });
        ADMINDATA.dbParams.scanErrorRetentionHours = Number(this.retentionHours);
        iziToast.success({ title: 'Retention period saved', position: 'topCenter', timeout: 2000 });
      } catch (err) {
        iziToast.error({ title: 'Failed to save retention', position: 'topCenter', timeout: 3000 });
      } finally {
        this.savingRetention = false;
      }
    },
    toggleRow(guid) {
      this.expandedRow = this.expandedRow === guid ? null : guid;
    },
    typeLabel(t) {
      return { parse: 'Parse Error', art: 'Album Art', cue: 'CUE Sheet', insert: 'DB Insert', other: 'Other' }[t] || t;
    },
    typeIcon(t) {
      const icons = {
        parse:  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
        art:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
        cue:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
        insert: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
        other:  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
      };
      return icons[t] || icons.other;
    },
    typeColor(t) {
      return { parse: 'var(--red)', art: 'var(--yellow)', cue: 'var(--primary)', insert: 'var(--accent)', other: 'var(--t2)' }[t] || 'var(--t2)';
    },
    typeBg(t) {
      return { parse: 'rgba(248,113,113,.14)', art: 'rgba(251,191,36,.14)', cue: 'rgba(139,92,246,.14)', insert: 'rgba(96,165,250,.12)', other: 'rgba(136,136,176,.10)' }[t] || 'rgba(136,136,176,.10)';
    },
    retentionLabel(h) {
      const map = { 12:'12 hours', 24:'1 day', 48:'2 days', 72:'3 days', 168:'1 week', 336:'2 weeks', 720:'30 days' };
      return map[h] || h + 'h';
    },
    relTime(ts) {
      const s = Math.floor(Date.now() / 1000) - ts;
      if (s < 10)     return 'just now';
      if (s < 60)     return s + 's ago';
      if (s < 3600)   return Math.floor(s / 60) + 'm ago';
      if (s < 86400)  return Math.floor(s / 3600) + 'h ago';
      if (s < 2592000) return Math.floor(s / 86400) + 'd ago';
      return new Date(ts * 1000).toLocaleDateString();
    },
    absTime(ts) {
      return new Date(ts * 1000).toLocaleString();
    },
    shortPath(fp) {
      if (!fp) return '—';
      const parts = fp.replace(/\\/g, '/').split('/');
      if (parts.length <= 3) return fp;
      return '\u2026/' + parts.slice(-2).join('/');
    },
    copyPath(fp) {
      if (!fp) return;
      navigator.clipboard.writeText(fp).then(() => {
        iziToast.info({ title: 'Path copied to clipboard', position: 'topCenter', timeout: 1500 });
      }).catch(() => {});
    },
    async fixError(err) {
      if (err.fixed_at || this.fixing[err.guid]) return;
      Vue.set(this.fixing, err.guid, true);
      try {
        const r = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/scan-errors/fix`, data: { guid: err.guid } });
        const idx = this.errors.findIndex(e => e.guid === err.guid);
        if (idx >= 0) {
          this.errors[idx].fixed_at  = Math.floor(Date.now() / 1000);
          this.errors[idx]._fixAction = r.data.action;
        }
        const badge = document.getElementById('scan-errors-badge');
        if (badge) {
          const cnt = this.unfixedCount;
          badge.textContent = cnt > 99 ? '99+' : cnt;
          badge.style.display = cnt === 0 ? 'none' : 'inline-flex';
        }
        const labels = { art_fixed: 'Embedded image stripped from file', remuxed: 'File rewritten — trigger a rescan to update the library', cue_dismissed: 'Cue error dismissed', dismissed: 'Dismissed', unrecoverable: 'File is corrupt and unrecoverable — delete it' };
        if (r.data.action === 'unrecoverable') {
          iziToast.error({ title: '\u26A0 File Unrecoverable', message: 'No valid audio stream found. This file is completely corrupt and cannot be played or repaired. Delete it.', position: 'topCenter', timeout: 0, close: true });
        } else {
          const msg = (labels[r.data.action] || 'Done') + (r.data.note ? ' — ' + r.data.note : '');
          iziToast.success({ title: 'Fixed', message: msg, position: 'topCenter', timeout: 4000 });
        }
        // Sync fix_action from server response into the local row so the badge
        // reflects the correct state immediately (before page reload).
        if (idx >= 0) this.errors[idx].fix_action = r.data.action;
      } catch (e) {
        iziToast.error({ title: 'Fix failed', message: e?.response?.data?.error || 'Unknown error', position: 'topCenter', timeout: 0, close: true });
      } finally {
        Vue.delete(this.fixing, err.guid);
      }
    },
    fixActionLabel(action) {
      return { art_fixed: 'Embedded image stripped', remuxed: 'File rewritten, rescan needed', reencoded: 'File re-encoded, rescan needed', cue_dismissed: 'Cue error dismissed', dismissed: 'Dismissed', unrecoverable: '\u26A0 Unrecoverable — delete this file' }[action] || 'Fixed';
    }
  },
  template: `
    <div>
      <div class="container">

        <!-- ── Header Card ── -->
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <div class="se-header">
                  <div class="se-title-group">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2" style="flex-shrink:0;margin-top:1px">
                      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <div>
                      <div class="se-main-title">Scan Error Audit</div>
                      <div class="se-sub">Persistent log of every file that failed during a library scan — deduplicated by file &amp; error type so recurring problems show a count, not duplicate rows.</div>
                    </div>
                    <span class="se-total-pill" v-if="loaded && unfixedCount > 0">
                      {{unfixedCount}} issue{{unfixedCount === 1 ? '' : 's'}}{{total > errors.length ? ' (showing '+errors.length.toLocaleString()+' of '+total.toLocaleString()+')' : ''}}
                    </span>
                    <span class="se-total-pill se-total-ok" v-else-if="loaded && errors.length === 0">
                      ✓ Clean
                    </span>
                    <span class="se-total-pill se-total-ok" v-else-if="loaded && unfixedCount === 0">
                      ✓ No actionable issues
                    </span>
                  </div>
                  <div class="se-controls-row">
                    <div class="se-retention-group">
                      <label class="se-retention-label">Keep errors for</label>
                      <select v-model.number="retentionHours" @change="saveRetention" class="se-retention-sel" :disabled="savingRetention">
                        <option :value="12">12 hours</option>
                        <option :value="24">1 day</option>
                        <option :value="48">2 days</option>
                        <option :value="72">3 days</option>
                        <option :value="168">1 week</option>
                        <option :value="336">2 weeks</option>
                        <option :value="720">30 days</option>
                      </select>
                      <span class="se-retention-hint">Older entries are pruned at scan start</span>
                    </div>
                    <div class="se-action-group">
                      <button class="btn-flat btn-small" @click="load" :disabled="loading">
                        <svg v-if="!loading" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        <svg v-else class="se-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                        {{loading ? 'Loading…' : 'Refresh'}}
                      </button>
                      <button class="btn btn-small red" @click="confirmClear" v-if="errors.length > 0">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                        Clear All
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Loading spinner ── -->
        <div class="row" v-if="loading && !loaded">
          <div class="col s12" style="display:flex;justify-content:center;padding:3rem 0">
            <svg class="spinner" width="50px" height="50px" viewBox="0 0 66 66"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
          </div>
        </div>

        <!-- ── Empty state ── -->
        <div class="row" v-else-if="loaded && errors.length === 0">
          <div class="col s12">
            <div class="card">
              <div class="se-empty-state">
                <div class="se-empty-icon">
                  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="1.5">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                </div>
                <div class="se-empty-title">No scan errors</div>
                <div class="se-empty-msg">Your library scanned cleanly — no file parsing, art extraction, cue sheet or database errors were recorded.</div>
              </div>
            </div>
          </div>
        </div>

        <template v-else-if="loaded && errors.length > 0">

          <!-- ── Truncation warning ── -->
          <div class="row" v-if="total > errors.length">
            <div class="col s12">
              <div style="background:rgba(251,191,36,.13);border:1px solid rgba(251,191,36,.35);border-radius:8px;padding:.7rem 1rem;display:flex;align-items:center;gap:.6rem;font-size:.85rem;color:var(--yellow)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                Showing first {{errors.length.toLocaleString()}} of {{total.toLocaleString()}} errors. Use <strong>Clear All</strong> to remove old entries, then re-scan to re-detect current problems.
              </div>
            </div>
          </div>

          <!-- ── Type filter chips ── -->
          <div class="row">
            <div class="col s12">
              <div class="se-filter-strip">
                <button class="se-fchip" :class="{active: typeFilter === null}" @click="typeFilter = null">
                  All
                  <span class="se-fchip-cnt">{{errors.length}}</span>
                </button>
                <button
                  v-for="type in allTypes" :key="type"
                  class="se-fchip"
                  :class="{active: typeFilter === type}"
                  :style="typeFilter === type ? {background: typeBg(type), borderColor: typeColor(type), color: typeColor(type)} : {}"
                  @click="typeFilter = (typeFilter === type ? null : type)"
                >
                  <span class="se-fchip-dot" :style="{background: typeColor(type)}"></span>
                  {{typeLabel(type)}}
                  <span class="se-fchip-cnt">{{typeCounts[type] || 0}}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- ── Errors table ── -->
          <div class="row">
            <div class="col s12">
              <div class="card se-table-card">
                <div class="se-table-wrap">

                  <!-- Column headers -->
                  <div class="se-thead">
                    <div class="se-th se-col-type">Type</div>
                    <div class="se-th se-col-file">File</div>
                    <div class="se-th se-col-msg">Issue</div>
                    <div class="se-th se-col-count">Detections</div>
                    <div class="se-th se-col-first">First Seen</div>
                    <div class="se-th se-col-last">Last Seen</div>
                    <div class="se-th se-col-exp"></div>
                  </div>

                  <!-- Body rows -->
                  <template v-for="err in filteredErrors" :key="err.guid">
                    <!-- Main row -->
                    <div
                      class="se-row"
                      :class="{expanded: expandedRow === err.guid, 'se-row--fixed': err.fixed_at && err.fix_action !== 'unrecoverable', 'se-row--unrecoverable': err.fix_action === 'unrecoverable'}"
                      @click="toggleRow(err.guid)"
                    >
                      <!-- Type badge -->
                      <div class="se-col-type">
                        <span class="se-type-badge"
                          :style="{background: typeBg(err.error_type), color: typeColor(err.error_type), borderColor: typeColor(err.error_type)}"
                        >
                          <span v-html="typeIcon(err.error_type)"></span>
                          {{typeLabel(err.error_type)}}
                        </span>
                        <span class="se-fixed-badge" v-if="err.fixed_at && err.fix_action !== 'unrecoverable'">&#x2713; Fixed</span>
                        <span class="se-unrecoverable-badge" v-if="err.fix_action === 'unrecoverable'">&#x26A0; Unrecoverable</span>
                        <span class="se-deleted-badge" v-if="!err.file_in_db && !(err.error_msg && (err.error_msg.includes('EPIPE') || err.error_msg.includes('ECONNRESET') || err.error_msg.includes('ECONNREFUSED')))">&#x1F5D1; Gone from library</span>
                        <span class="se-deleted-badge" v-if="!err.file_in_db && err.error_msg && (err.error_msg.includes('EPIPE') || err.error_msg.includes('ECONNRESET') || err.error_msg.includes('ECONNREFUSED'))">&#x26A1; Scan interrupted</span>
                      </div>

                      <!-- File path -->
                      <div class="se-col-file">
                        <span class="se-vpath-tag">{{err.vpath}}</span>
                        <span class="se-filepath" :title="err.filepath" @click.stop="copyPath(err.filepath)">
                          {{shortPath(err.filepath)}}
                        </span>
                      </div>

                      <!-- Error message (truncated) -->
                      <div class="se-col-msg">
                        <span class="se-errmsg">{{err.error_msg || '(no message)'}}</span>
                      </div>

                      <!-- Detection count -->
                      <div class="se-col-count">
                        <span class="se-count-badge" v-if="err.count > 1" :title="err.count + ' times detected'">
                          {{err.count}}&times; detected
                        </span>
                        <span class="se-count-once" v-else>Once</span>
                      </div>

                      <!-- First seen -->
                      <div class="se-col-first">
                        <span :title="absTime(err.first_seen)">{{relTime(err.first_seen)}}</span>
                      </div>

                      <!-- Last seen -->
                      <div class="se-col-last">
                        <span :title="absTime(err.last_seen)">{{relTime(err.last_seen)}}</span>
                      </div>

                      <!-- Expand chevron -->
                      <div class="se-col-exp">
                        <svg class="se-chevron" :class="{open: expandedRow === err.guid}"
                          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                          <polyline points="6 9 12 15 18 9"/>
                        </svg>
                      </div>
                    </div>

                    <!-- Expanded detail panel -->
                    <div class="se-detail" v-if="expandedRow === err.guid">
                      <div class="se-detail-grid">
                        <div class="se-detail-section">
                          <div class="se-detail-label">Full Path</div>
                          <div class="se-detail-value se-detail-path" @click="copyPath(err.filepath)" title="Click to copy">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            {{err.filepath || '—'}}
                          </div>
                        </div>
                        <div class="se-detail-section">
                          <div class="se-detail-label">Error Message</div>
                          <div class="se-detail-value">{{err.error_msg || '(none)'}}</div>
                        </div>
                        <div class="se-detail-section" v-if="err.stack">
                          <div class="se-detail-label">Stack Trace</div>
                          <pre class="se-stack">{{err.stack}}</pre>
                        </div>
                        <div class="se-detail-meta-row">
                          <div class="se-detail-meta-chip">
                            <span class="se-detail-meta-k">Library path</span>
                            <span class="se-detail-meta-v">{{err.vpath}}</span>
                          </div>
                          <div class="se-detail-meta-chip">
                            <span class="se-detail-meta-k">First detected</span>
                            <span class="se-detail-meta-v">{{absTime(err.first_seen)}}</span>
                          </div>
                          <div class="se-detail-meta-chip">
                            <span class="se-detail-meta-k">Last detected</span>
                            <span class="se-detail-meta-v">{{absTime(err.last_seen)}}</span>
                          </div>
                          <div class="se-detail-meta-chip">
                            <span class="se-detail-meta-k">Total detections</span>
                            <span class="se-detail-meta-v" :style="{color: err.count > 1 ? typeColor(err.error_type) : 'inherit'}">
                              {{err.count}} time{{err.count === 1 ? '' : 's'}}
                            </span>
                          </div>
                        </div>

                        <!-- ── Deleted-from-library banner ── -->
                        <div class="se-deleted-banner" v-if="!err.file_in_db">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                          <div>
                            <div class="se-deleted-title">File no longer in library</div>
                            <div class="se-deleted-body" v-if="err.error_msg && (err.error_msg.includes('EPIPE') || err.error_msg.includes('ECONNRESET') || err.error_msg.includes('ECONNREFUSED'))">
                              The scan was interrupted by a connection error (server restart or crash mid-scan) &mdash; the file itself may be perfectly fine. Run another scan and it should be picked up normally. This error record will expire automatically after 48 h.
                            </div>
                            <div class="se-deleted-body" v-else>This file was removed from the library database (most likely deleted from disk). No action needed &mdash; this error record will expire automatically after 48 h.</div>
                          </div>
                        </div>

                        <!-- ── Fix action row ── -->
                        <div class="se-unrecoverable-banner" v-if="err.fix_action === 'unrecoverable'">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                          <div>
                            <div class="se-unrecoverable-title">File is corrupt and unrecoverable</div>
                            <div class="se-unrecoverable-body">No valid audio stream was found. This file cannot be played or repaired &mdash; it contains no audio data. <strong>Delete it from disk.</strong></div>
                          </div>
                        </div>
                        <div class="se-detail-fix-row" v-else-if="err.fixed_at && err.fix_action !== 'unrecoverable'">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--se-green,#4caf50)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                          <span class="se-fix-done-txt">
                            Fixed {{relTime(err.fixed_at)}}
                            <span v-if="err.fix_action" style="opacity:.65;margin-left:.35rem">({{fixActionLabel(err.fix_action)}})</span>
                            <span v-if="err.confirmed_at" class="se-confirmed-chip">&#10003; Rescan confirmed OK {{relTime(err.confirmed_at)}}</span>
                            <span v-else style="opacity:.5;margin-left:.5rem;font-size:.8em">— rescan to confirm, auto-removed after 48 h</span>
                          </span>
                        </div>
                        <div class="se-detail-fix-row" v-else-if="!err.file_in_db">
                          <span style="opacity:.5;font-size:.85em">No fix needed — file has been removed from the library.</span>
                        </div>
                        <div class="se-detail-fix-row" v-else>
                          <button class="se-fix-btn" @click.stop="fixError(err)" :disabled="fixing[err.guid]">
                            <svg v-if="!fixing[err.guid]" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                            <svg v-else class="se-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                            {{fixing[err.guid] ? 'Fixing\u2026' : 'Fix this error'}}
                          </button>
                          <span class="se-fix-hint" v-if="err.error_type === 'art'">Strips embedded images with ffmpeg &mdash; then rescan to update the library</span>
                          <span class="se-fix-hint" v-else-if="err.error_type === 'cue'">Marks cue error as dismissed &mdash; auto-expires in 48 h</span>
                          <span class="se-fix-hint" v-else-if="err.error_type === 'parse' || err.error_type === 'duration'">Rewrites file with ffmpeg (lossless, no re-encode) &mdash; then rescan to update the library</span>
                          <span class="se-fix-hint" v-else>Dismisses this error &mdash; auto-expires in 48 h</span>
                        </div>

                      </div>
                    </div>

                  </template>

                  <!-- Row count footer -->
                  <div class="se-table-footer">
                    Showing {{filteredErrors.length}} of {{errors.length}} error{{errors.length === 1 ? '' : 's'}}
                    <span v-if="typeFilter"> &mdash; filtered by <b>{{typeLabel(typeFilter)}}</b></span>
                    <a v-if="typeFilter" @click="typeFilter = null" style="margin-left:.5rem">&times; clear filter</a>
                  </div>

                </div>
              </div>
            </div>
          </div>

        </template>

      </div>
    </div>`
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Directory Access Test Modal ────────────────────────────────────────────
const dirAccessTestModal = Vue.component('dir-access-test-modal', {
  data() {
    return {
      loading: true,
      platform: '',
      isElectron: false,
      results: []
    };
  },
  computed: {
    allGood()    { return !this.loading && this.results.length > 0 && this.results.every(r => r.readable && r.writable); },
    hasNoAccess(){ return this.results.some(r => !r.readable); },
    hasReadOnly(){ return this.results.some(r => r.readable && !r.writable); },
    adviceLevel(){
      if (this.loading || this.results.length === 0) return 'ok';
      if (this.hasNoAccess) return 'error';
      if (this.hasReadOnly) return 'warn';
      return 'ok';
    },
    adviceText() {
      if (this.loading || this.results.length === 0) return '';
      if (this.allGood) return 'All directories are accessible with full read/write permissions. No action needed.';
      const parts = [];
      if (this.hasNoAccess)
        parts.push('One or more directories cannot be read at all. Verify the path still exists and that the mStream process has at least read permission on that location.');
      if (this.hasReadOnly) {
        if (this.platform === 'win32')
          parts.push('One or more directories are read-only. mStream can stream music but cannot embed cover art or write tags. Right-click the folder → Properties → Security → grant the mStream service account Modify permission.');
        else
          parts.push('One or more directories are read-only. mStream can stream music but cannot embed cover art or write tags. Fix with: sudo chown -R $(whoami) /path/to/dir && chmod -R u+rw /path/to/dir');
      }
      return parts.join('  ');
    },
    adviceBox() {
      const common = 'border-radius:8px;padding:.7rem 1rem;margin-top:.75rem;font-size:.88rem;line-height:1.6;';
      if (this.adviceLevel === 'error') return common + 'background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.3);color:#f87171;';
      if (this.adviceLevel === 'warn')  return common + 'background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);color:#fbbf24;';
      return common + 'background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.3);color:#4ade80;';
    },
    adviceTitle() {
      if (this.adviceLevel === 'error') return '✘  Access Problem';
      if (this.adviceLevel === 'warn')  return '⚠  Action Required';
      return '✔  All Good';
    }
  },
  template: `
    <div>
      ${mHead('Directory Access Test', 'Read / write check for each configured directory')}
      <div class="modal-body">
        <div v-if="loading" style="display:flex;align-items:center;justify-content:center;padding:2.5rem 0;gap:1rem;color:var(--t2);">
          <svg class="spinner" width="28" height="28" viewBox="0 0 66 66"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
          Testing access…
        </div>
        <div v-else-if="results.length === 0" style="color:var(--t2);padding:.75rem 0;">No directories configured yet.</div>
        <div v-else>
          <div v-for="r in results" :key="r.vpath" style="margin-bottom:.75rem;border:1px solid var(--border);border-radius:8px;overflow:hidden;">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:.5rem .85rem;background:var(--c1b);gap:.5rem;flex-wrap:wrap;">
              <div style="min-width:0;flex:1;">
                <code style="color:var(--accent);font-size:.9rem;">{{r.vpath}}</code>
                <div style="color:var(--t3);font-size:.75rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px;">{{r.root}}</div>
              </div>
              <span :style="storageBadgeStyle(r.storageType)" style="font-size:.72rem;padding:.18rem .52rem;border-radius:4px;font-weight:600;letter-spacing:.03em;white-space:nowrap;flex-shrink:0;">{{storageLabel(r.storageType)}}</span>
            </div>
            <div style="display:flex;align-items:center;gap:1.5rem;padding:.5rem .85rem;flex-wrap:wrap;">
              <span :style="r.readable ? 'color:#4ade80;font-weight:700;' : 'color:#f87171;font-weight:700;'">
                {{r.readable ? '✓' : '✗'}} Read
              </span>
              <span :style="r.writable ? 'color:#4ade80;font-weight:700;' : r.readable ? 'color:#fbbf24;font-weight:700;' : 'color:#f87171;font-weight:700;'">
                {{r.writable ? '✓' : '✗'}} Write
              </span>
              <span v-if="r.error" style="color:var(--t3);font-size:.75rem;font-family:monospace;">{{r.error}}</span>
            </div>
          </div>
          <div :style="adviceBox">
            <strong>{{adviceTitle}}</strong><br>
            {{adviceText}}
          </div>
        </div>
      </div>
      <div class="modal-footer-row">
        <button class="btn" type="button" @click="closeModal">Close</button>
      </div>
    </div>`,
  mounted() { this.runTest(); },
  methods: {
    async runTest() {
      this.loading = true;
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/directories/test` });
        this.platform   = res.data.platform;
        this.isElectron = res.data.isElectron;
        this.results    = res.data.results;
      } catch (err) {
        iziToast.error({ title: 'Access test failed', position: 'topCenter', timeout: 3500 });
        modVM.closeModal();
      } finally {
        this.loading = false;
      }
    },
    storageLabel(t) {
      const m = {
        'electron':        'Desktop App',
        'windows-local':   'Windows local drive',
        'windows-network': 'Windows network share',
        'linux-local':     'Linux local',
        'linux-mounted':   'Linux mounted drive',
        'mac-local':       'macOS local',
        'mac-external':    'macOS external drive'
      };
      return m[t] || t;
    },
    storageBadgeStyle(t) {
      if (t === 'electron')
        return 'background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.3);';
      if (t === 'windows-network' || t === 'linux-mounted' || t === 'mac-external')
        return 'background:rgba(251,191,36,.12);color:#fbbf24;border:1px solid rgba(251,191,36,.3);';
      return 'background:rgba(99,102,241,.12);color:#818cf8;border:1px solid rgba(99,102,241,.25);';
    }
  }
});

const foldersView = Vue.component('folders-view', {
  data() {
    return {
      componentKey: false, // Flip this value to force re-render
      dirName: '',
      folder: ADMINDATA.sharedSelect,
      foldersTS: ADMINDATA.foldersUpdated,
      usersTS: ADMINDATA.usersUpdated,
      folders: ADMINDATA.folders,
      users: ADMINDATA.users,
      submitPending: false,
      editingFolder: null,
      editForm: { root: '', type: 'music', users: [] }
    };
  },
  computed: {
    directories_users() {
      // Depend on usersTS.ts so Vue re-evaluates when users load
      void this.usersTS.ts;
      // Returns { vpath: [username, ...] } — only non-admin users explicitly assigned
      const map = {};
      Object.keys(this.folders).forEach(vp => { map[vp] = []; });
      Object.entries(this.users).forEach(([uname, u]) => {
        if (u.admin) return; // admins shown separately
        (u.vpaths || []).forEach(vp => {
          if (!map[vp]) map[vp] = [];
          map[vp].push(uname);
        });
      });
      return map;
    },
    admin_users() {
      void this.usersTS.ts;
      return Object.entries(this.users)
        .filter(([, u]) => u.admin)
        .map(([uname]) => uname);
    },
    non_admin_count() {
      void this.usersTS.ts;
      return Object.values(this.users).filter(u => !u.admin).length;
    }
  },
  template: `
    <div class="container">

      <div class="card">
        <div class="card-content">
          <span class="card-title">Add Directory</span>
          <form id="choose-directory-form" @submit.prevent="submitForm">

            <div class="input-field">
              <label for="folder-name">Directory Path</label>
              <div style="display:flex;gap:.5rem;align-items:stretch;">
                <input
                  v-on:click="addFolderDialog()"
                  v-model="folder.value"
                  id="folder-name" required type="text"
                  placeholder="Click Browse to choose a folder…"
                  style="cursor:pointer;flex:1;margin-bottom:0;"
                  readonly />
                <button type="button" class="btn" @click="addFolderDialog()" style="flex-shrink:0;height:38px;align-self:center;" title="Open folder browser">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 48 48" style="vertical-align:middle;margin-right:4px;"><path fill="#FFA000" d="M38 12H22l-4-4H8c-2.2 0-4 1.8-4 4v24c0 2.2 1.8 4 4 4h31c1.7 0 3-1.3 3-3V16c0-2.2-1.8-4-4-4z"/><path fill="#FFCA28" d="M42.2 18H15.3c-1.9 0-3.6 1.4-3.9 3.3L8 40h31.7c1.9 0 3.6-1.4 3.9-3.3l2.5-14c.5-2.4-1.4-4.7-3.9-4.7z"/></svg>Browse
                </button>
              </div>
            </div>

            <div class="input-field">
              <label for="add-directory-name">Path Alias <span style="color:var(--t3);font-weight:400;">(vPath)</span></label>
              <input
                pattern="[a-zA-Z0-9-]+"
                v-model="dirName"
                id="add-directory-name" required type="text"
                placeholder="e.g. music" />
              <small style="display:block;color:var(--t2);font-size:.82rem;margin-top:.25rem;">
                A short URL-friendly name used to identify this directory in the API and player. Letters, numbers, hyphens only — no spaces.
              </small>
            </div>

            <div style="display:flex;flex-direction:column;gap:.85rem;margin:.25rem 0 .5rem;">

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-auto-access" type="checkbox" checked style="width:auto;margin-top:3px;flex-shrink:0;" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">Give access to all users</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">Every existing and new user will automatically have this directory in their allowed paths. Uncheck to manage access per-user manually.</small>
                </span>
              </label>

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-is-audiobooks" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">Audiobooks &amp; Podcasts</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">Mark this directory as an Audiobooks / Podcasts library. Files will be scanned and displayed separately from your main music collection, allowing you to browse and stream spoken-word content independently.</small>
                </span>
              </label>

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-is-recordings" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;"
                  @change="
                    const any = $event.target.checked || document.getElementById('folder-is-youtube').checked;
                    document.getElementById('folder-allow-record-delete-row').style.display = any ? 'flex' : 'none';
                    if (!any) document.getElementById('folder-allow-record-delete').checked = false;" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">Radio Recordings folder</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">Target folder for radio stream recordings. Not scanned into the music library. Can be combined with YouTube Downloads below.</small>
                </span>
              </label>

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-is-youtube" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;"
                  @change="
                    const any = $event.target.checked || document.getElementById('folder-is-recordings').checked;
                    document.getElementById('folder-allow-record-delete-row').style.display = any ? 'flex' : 'none';
                    if (!any) document.getElementById('folder-allow-record-delete').checked = false;" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">YouTube Downloads folder</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">Target folder for YouTube audio downloads. Not scanned into the music library. Can be combined with Radio Recordings above.</small>
                </span>
              </label>

              <label id="folder-allow-record-delete-row" style="display:none;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-allow-record-delete" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">Allow users to delete files</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">When enabled, a <strong>Delete</strong> option appears in the context menu for files in this folder. A confirmation prompt is always shown before deletion.</small>
                </span>
              </label>

            </div>
          </form>
        </div>
        <div class="card-action">
          <button class="btn" type="submit" form="choose-directory-form" :disabled="submitPending === true">
            {{ submitPending ? 'Adding…' : 'Add Directory' }}
          </button>
        </div>
      </div>

      <div v-show="foldersTS.ts === 0" style="display:flex;justify-content:center;padding:2rem;">
        <svg class="spinner" width="48" height="48" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>

      <div v-show="foldersTS.ts > 0" class="card">
        <div class="card-content">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;">
            <span class="card-title" style="margin-bottom:0;">Directories</span>
            <button class="btn-small" type="button" @click="testAccess" title="Check read / write access for all configured directories">Test Access</button>
          </div>
          <div v-if="Object.keys(folders).length === 0" style="color:var(--t2);padding:.5rem 0;">No directories added yet.</div>
          <div v-else style="display:flex;flex-direction:column;gap:10px;">
            <div v-for="(v, k) in folders" :key="k"
                 style="border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;background:var(--raised);display:flex;flex-direction:column;gap:8px;">

              <!-- Row 1: vpath + type badge + actions -->
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <code style="font-size:1rem;color:var(--accent);font-weight:700;">{{k}}</code>
                <span :style="'display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;' +
                  (v.type === 'recordings' ? 'background:rgba(99,102,241,.15);color:#818cf8;' :
                   v.type === 'youtube'    ? 'background:rgba(220,50,50,.12);color:#e05555;' :
                   v.type === 'audio-books'? 'background:rgba(245,158,11,.12);color:#f59e0b;' :
                                            'background:rgba(16,185,129,.12);color:#10b981;')">
                  {{ v.type === 'recordings' ? '⏺ Radio Recordings' :
                     v.type === 'youtube'    ? '▶ YouTube Downloads' :
                     v.type === 'audio-books'? '📖 Audiobooks' : '🎵 Music' }}
                </span>
                <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;">
                  <button class="btn-small" type="button" @click="toggleEditFolder(k)">
                    {{ editingFolder === k ? 'Cancel' : 'Edit' }}
                  </button>
                  <button v-if="v.type === 'recordings' || v.type === 'youtube'" class="btn-small" type="button"
                    :style="v.allowRecordDelete ? 'background:var(--primary);color:#fff;' : ''"
                    :title="v.allowRecordDelete ? 'Users can delete files — click to disable' : 'Users cannot delete files — click to enable'"
                    @click="toggleRecordDelete(k)">
                    {{v.allowRecordDelete ? 'Delete: On' : 'Delete: Off'}}
                  </button>
                  <button v-if="v.type !== 'recordings' && v.type !== 'youtube'" class="btn-small" type="button"
                    :style="v.albumsOnly ? 'background:var(--primary);color:#fff;' : ''"
                    :title="v.albumsOnly ? 'Albums Only ON — click to disable' : 'Albums Only OFF — click to enable'"
                    @click="toggleAlbumsOnly(k)">
                    {{v.albumsOnly ? 'Albums Only: On' : 'Albums Only: Off'}}
                  </button>
                  <button class="btn-small red" type="button" @click="removeFolder(k, v.root)">Remove</button>
                </div>
              </div>

              <!-- Row 2: directory path -->
              <div style="display:flex;align-items:baseline;gap:8px;">
                <span style="font-size:11px;color:var(--t3);flex-shrink:0;min-width:60px;">Path</span>
                <span style="font-size:12px;color:var(--t2);word-break:break-all;font-family:monospace;">{{v.root}}</span>
              </div>

              <!-- Row 3: user access -->
              <div style="display:flex;align-items:flex-start;gap:8px;">
                <span style="font-size:11px;color:var(--t3);flex-shrink:0;min-width:60px;padding-top:2px;">Access</span>
                <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                  <span v-for="uname in admin_users" :key="'admin-'+uname"
                        title="Admin — always has full access to all folders"
                        style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:11px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);color:#f59e0b;font-weight:600;">
                    ★ {{uname}}
                  </span>
                  <span v-if="(directories_users[k] || []).length >= non_admin_count && non_admin_count > 0"
                        style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:11px;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);color:#10b981;font-weight:600;">All users</span>
                  <template v-else-if="(directories_users[k] || []).length > 0">
                    <span v-for="uname in (directories_users[k] || [])" :key="uname"
                          style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:11px;background:var(--card);border:1px solid var(--border);color:var(--t2);">
                      {{uname}}
                    </span>
                  </template>
                  <span v-else-if="non_admin_count > 0"
                        style="font-size:12px;color:var(--t3);">No regular users assigned</span>
                </div>
              </div>

              <!-- Edit panel (inline, expands when Edit is clicked) -->
              <div v-if="editingFolder === k"
                   style="margin-top:6px;padding:14px;border-radius:var(--r);background:var(--card);border:1px solid var(--border);display:flex;flex-direction:column;gap:12px;">

                <!-- Path -->
                <div>
                  <label style="font-size:12px;font-weight:600;color:var(--t2);display:block;margin-bottom:4px;">Directory Path</label>
                  <div style="display:flex;gap:6px;">
                    <input v-model="editForm.root" type="text" class="settings-select" style="flex:1;font-family:monospace;font-size:.82rem;" />
                    <button class="btn-small" type="button" @click="pickEditFolder(k)" title="Browse">…</button>
                  </div>
                  <small style="color:var(--t3);font-size:.78rem;">Changing the path requires a server restart to take effect for media serving.</small>
                </div>

                <!-- Type (checkboxes for radio/youtube, like add form) -->
                <div>
                  <label style="font-size:12px;font-weight:600;color:var(--t2);display:block;margin-bottom:6px;">Folder Type</label>
                  <div style="display:flex;flex-wrap:wrap;gap:18px;align-items:center;">
                    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;color:var(--t1);">
                      <input type="checkbox" v-model="editForm.isRecording" style="width:auto;" />
                      ⏺ Radio Recordings
                    </label>
                    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;color:var(--t1);">
                      <input type="checkbox" v-model="editForm.isYoutube" style="width:auto;" />
                      ▶ YouTube Downloads
                    </label>
                    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;color:var(--t1);">
                      <input type="checkbox" v-model="editForm.isAudioBooks" style="width:auto;" />
                      📖 Audiobooks
                    </label>
                  </div>
                  <small style="color:var(--t3);font-size:.78rem;">Check one or both. Both checked = Radio+YouTube combined folder.</small>
                </div>

                <!-- User access (non-admin users only) -->
                <div v-if="non_admin_count > 0">
                  <label style="font-size:12px;font-weight:600;color:var(--t2);display:block;margin-bottom:6px;">User Access</label>
                  <div style="display:flex;flex-wrap:wrap;gap:8px;">
                    <label v-for="(u, uname) in users" :key="uname" v-if="!u.admin"
                           style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;color:var(--t1);">
                      <input type="checkbox" :value="uname" v-model="editForm.users" style="width:auto;" />
                      {{uname}}
                    </label>
                  </div>
                </div>

                <!-- Save -->
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                  <button class="btn-small" type="button" @click="editingFolder = null">Cancel</button>
                  <button class="btn-small btn-primary" type="button" @click="saveEditFolder(k)">Save changes</button>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>

    </div>`,
    created: function() {
      ADMINDATA.sharedSelect.value = '';
    },
    watch: {
      'folder.value': function (newVal, oldVal) {
        this.makeVPath(newVal);
      }
    },
    methods: {
      makeVPath(dir) {
        const newName = dir.split(/[\\\/]/).pop().toLowerCase().replace(' ', '-').replace(/[^a-zA-Z0-9-]/g, "");
        
        // TODO: Check that vpath doesn't already exist

        this.dirName = newName;
        this.$nextTick(() => {
        });
      },
      maybeResetForm: function() {
        if (this.dirName === '' && this.folder.value === '') {
          document.getElementById("choose-directory-form").reset();
        }
      },
      addFolderDialog: function (event) {
        modVM.currentViewModal = 'file-explorer-modal';
        modVM.openModal();
      },
      submitForm: async function () {
        if (ADMINDATA.folders[this.dirName]) {
          iziToast.warn({
            title: 'Server Path already in use',
            position: 'topCenter',
            timeout: 3500
          });
          return;
        }

        try {
          this.submitPending = true;

          await API.axios({
            method: 'PUT',
            url: `${API.url()}/api/v1/admin/directory`,
            data: {
              directory: this.folder.value,
              vpath: this.dirName,
              autoAccess: document.getElementById('folder-auto-access').checked,
              isAudioBooks: document.getElementById('folder-is-audiobooks').checked,
              isRecording: document.getElementById('folder-is-recordings').checked,
              isYoutube: document.getElementById('folder-is-youtube').checked,
              allowRecordDelete: document.getElementById('folder-allow-record-delete').checked
            }
          });

          if (document.getElementById('folder-auto-access').checked) {
            Object.values(ADMINDATA.users).forEach(user => {
              user.vpaths.push(this.dirName);
            });
          }

          Vue.set(ADMINDATA.folders, this.dirName, { root: this.folder.value });
          this.dirName = '';
          this.folder.value = '';
          this.$nextTick(() => {
          });
        }catch(err) {
          iziToast.error({
            title: 'Failed to add directory',
            position: 'topCenter',
            timeout: 3500
          });
        } finally {
          this.submitPending = false;
        }
      },
      testAccess: function() {
        modVM.currentViewModal = 'dir-access-test-modal';
        modVM.openModal();
      },
      toggleRecordDelete: async function(vpath) {
        const folder = ADMINDATA.folders[vpath];
        const newVal = !folder.allowRecordDelete;
        try {
          await API.axios({
            method: 'PATCH',
            url: `${API.url()}/api/v1/admin/directory/flags`,
            data: { vpath, allowRecordDelete: newVal }
          });
          Vue.set(ADMINDATA.folders[vpath], 'allowRecordDelete', newVal);
          iziToast.success({
            title: newVal ? 'Users can now delete their own recordings' : 'Recording deletion disabled',
            position: 'topCenter', timeout: 3000
          });
        } catch (_e) {
          iziToast.error({ title: 'Failed to update setting', position: 'topCenter', timeout: 3000 });
        }
      },
      toggleAlbumsOnly: async function(vpath) {
        const folder = ADMINDATA.folders[vpath];
        const newVal = !folder.albumsOnly;
        try {
          await API.axios({
            method: 'PATCH',
            url: `${API.url()}/api/v1/admin/directory/flags`,
            data: { vpath, albumsOnly: newVal }
          });
          Vue.set(ADMINDATA.folders[vpath], 'albumsOnly', newVal);
          iziToast.success({
            title: newVal ? 'Albums Only enabled — Albums view restricted to this folder' : 'Albums Only disabled',
            position: 'topCenter', timeout: 3000
          });
        } catch (_e) {
          iziToast.error({ title: 'Failed to update setting', position: 'topCenter', timeout: 3000 });
        }
      },
      toggleEditFolder: function(vpath) {
        if (this.editingFolder === vpath) {
          this.editingFolder = null;
          return;
        }
        const folder = ADMINDATA.folders[vpath];
        const currentUsers = (this.directories_users[vpath] || []).slice();
        this.editForm = {
          root: folder.root || '',
          isRecording: folder.type === 'recordings' || (folder.type === 'youtube' && folder.allowRecordDelete),
          isYoutube: folder.type === 'youtube' || (folder.type === 'recordings' && folder.allowRecordDelete),
          isAudioBooks: folder.type === 'audio-books',
          users: currentUsers
        };
        this.editingFolder = vpath;
      },
      pickEditFolder: function() {
        modVM.currentViewModal = 'file-explorer-modal';
        ADMINDATA.sharedSelect._editTarget = 'editForm';
        ADMINDATA.sharedSelect._editRef = this;
        modVM.openModal();
      },
      saveEditFolder: async function(vpath) {
        const folder = ADMINDATA.folders[vpath];
        const errors = [];

        // 1. Save type if changed (checkbox logic)
        let newType = 'music';
        if (this.editForm.isAudioBooks) {
          newType = 'audio-books';
        } else if (this.editForm.isRecording && this.editForm.isYoutube) {
          newType = 'recordings';
        } else if (this.editForm.isYoutube) {
          newType = 'youtube';
        } else if (this.editForm.isRecording) {
          newType = 'recordings';
        }
        if (newType !== (folder.type || 'music')) {
          try {
            await API.axios({
              method: 'PATCH',
              url: `${API.url()}/api/v1/admin/directory/type`,
              data: { vpath, type: newType }
            });
            Vue.set(ADMINDATA.folders[vpath], 'type', newType);
            // Clear flags incompatible with new type
            const isRecordLike = newType === 'recordings' || newType === 'youtube';
            if (!isRecordLike) Vue.delete(ADMINDATA.folders[vpath], 'allowRecordDelete');
            if (isRecordLike) Vue.delete(ADMINDATA.folders[vpath], 'albumsOnly');
          } catch (_e) {
            errors.push('type');
          }
        }

        // 2. Save path if changed
        if (this.editForm.root.trim() && this.editForm.root.trim() !== folder.root) {
          try {
            await API.axios({
              method: 'PATCH',
              url: `${API.url()}/api/v1/admin/directory/root`,
              data: { vpath, root: this.editForm.root.trim() }
            });
            Vue.set(ADMINDATA.folders[vpath], 'root', this.editForm.root.trim());
            iziToast.warning({
              title: 'Path changed — server restart recommended for media serving to update',
              position: 'topCenter', timeout: 5000
            });
          } catch (err) {
            errors.push('path');
            iziToast.error({
              title: 'Invalid path: ' + (err?.response?.data?.error || 'not a valid directory'),
              position: 'topCenter', timeout: 4000
            });
          }
        }

        // 3. Save user access if changed
        const prevUsers = (this.directories_users[vpath] || []).slice().sort().join(',');
        const nextUsers = this.editForm.users.slice().sort().join(',');
        if (prevUsers !== nextUsers) {
          try {
            await API.axios({
              method: 'PATCH',
              url: `${API.url()}/api/v1/admin/directory/users`,
              data: { vpath, users: this.editForm.users }
            });
            // Update in-memory user vpaths so directories_users recomputes
            Object.entries(ADMINDATA.users).forEach(([uname, u]) => {
              if (u.admin) return;
              const hasAccess = this.editForm.users.includes(uname);
              const vpaths = (u.vpaths || []).filter(vp => vp !== vpath);
              if (hasAccess) vpaths.push(vpath);
              Vue.set(ADMINDATA.users[uname], 'vpaths', vpaths);
            });
            ADMINDATA.usersUpdated.ts = Date.now();
          } catch (_e) {
            errors.push('users');
          }
        }

        if (errors.length === 0) {
          iziToast.success({ title: 'Folder updated', position: 'topCenter', timeout: 2500 });
          this.editingFolder = null;
        } else if (errors.length < 3) {
          iziToast.warning({ title: `Some changes failed: ${errors.join(', ')}`, position: 'topCenter', timeout: 4000 });
        }
      },
      removeFolder: async function(vpath, folder) {
                adminConfirm(`Remove access to <b>${folder}</b>?`, `No files will be deleted. Your server will need to reboot.`, 'Remove', () => {
          API.axios({
                          method: 'DELETE',
                          url: `${API.url()}/api/v1/admin/directory`,
                          data: { vpath: vpath }
                        }).then(() => {
                          iziToast.warning({
                            title: 'Server Rebooting. Please wait 30s for the server to come back online',
                            position: 'topCenter',
                            timeout: 3500
                          });
                          Vue.delete(ADMINDATA.folders, vpath);
                          Object.values(ADMINDATA.users).forEach(user => {
                            if (user.vpaths.includes(vpath)) {
                              user.vpaths.splice(user.vpaths.indexOf(vpath), 1);
                            }
                          });
                        }).catch(() => {
                          iziToast.error({
                            title: 'Failed to remove folder',
                            position: 'topCenter',
                            timeout: 3500
                          });
                        });
        });
      }
    }
});

const usersView = Vue.component('users-view', {
  data() {
    return {
      directories: ADMINDATA.folders,
      users: ADMINDATA.users,
      usersTS: ADMINDATA.usersUpdated,
      newUsername: '',
      newPassword: '',
      showNewPassword: false,
      newUserDirs: [],
      makeAdmin: Object.keys(ADMINDATA.users).length === 0 ? true : false,
      submitPending: false,
      selectInstance: null
    };
  },
  template: `
    <div class="container">

      <div class="card">
        <div class="card-content">
          <span class="card-title">Add User</span>
          <p style="color:var(--t2);font-size:.88rem;margin:.25rem 0 1rem;">Create a new account. The first user must have admin access.</p>
          <form id="add-user-form" @submit.prevent="addUser" autocomplete="off">

            <div style="display:flex;gap:.75rem;flex-wrap:wrap;">
              <div class="input-field" style="flex:1;min-width:160px;">
                <label for="new-username">Username</label>
                <input v-model="newUsername" id="new-username" required type="text" placeholder="e.g. alice" autocomplete="off">
              </div>
              <div class="input-field" style="flex:1;min-width:160px;">
                <label for="new-password">Password</label>
                <div class="pwd-wrap">
                  <input v-model="newPassword" id="new-password" required :type="showNewPassword ? 'text' : 'password'" placeholder="•••••••" autocomplete="new-password">
                  <button type="button" class="pwd-toggle" @click="showNewPassword = !showNewPassword" tabindex="-1" :title="showNewPassword ? 'Hide password' : 'Show password'">
                    <svg v-if="!showNewPassword" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  </button>
                </div>
              </div>
            </div>

            <div class="input-field">
              <label for="new-user-dirs">Folder Access <span style="color:var(--red);font-size:.8rem;">*</span></label>
              <select id="new-user-dirs" :disabled="Object.keys(directories).length === 0" multiple :size="Math.max(2, Object.keys(directories).length)" v-model="newUserDirs">
                <option disabled value="" v-if="Object.keys(directories).length === 0">No directories &mdash; add a music folder first</option>
                <option v-for="(val, key) in directories" :key="key" :value="key">{{ key }}</option>
              </select>
              <small style="display:block;color:var(--t2);font-size:.82rem;margin-top:.25rem;" v-if="Object.keys(directories).length > 0">Select at least one folder. Hold Ctrl / Cmd to select multiple.</small>
              <small style="display:block;color:var(--t2);font-size:.82rem;margin-top:.25rem;" v-else>Add a music directory before creating users.</small>
            </div>

            <label style="display:flex;align-items:center;gap:.6rem;cursor:pointer;margin:.25rem 0 .5rem;">
              <input id="make-admin-cb" type="checkbox" v-model="makeAdmin" style="width:auto;margin:0;flex-shrink:0;">
              <span><span style="color:var(--t1);font-weight:600;">Grant admin access</span><br><small style="color:var(--t2);font-size:.82rem;">Admin users can access this settings panel and manage all users.</small></span>
            </label>

          </form>
        </div>
        <div class="card-action">
          <button class="btn" type="submit" form="add-user-form" :disabled="submitPending === true">
            {{submitPending === false ? 'Add User' : 'Adding...'}}
          </button>
        </div>
      </div>

      <div v-if="usersTS.ts === 0" style="display:flex;justify-content:center;padding:2rem;">
        <svg class="spinner" width="48" height="48" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>

      <div v-else class="card">
        <div class="card-content">
          <span class="card-title">Users</span>
          <p v-if="Object.keys(users).length === 0" style="color:var(--t2);margin:.5rem 0 0;">No users &mdash; authentication is currently <strong>disabled</strong>. The first user you create must have admin access.</p>
          <div v-if="Object.keys(users).length === 0" style="margin-top:.85rem;padding:.65rem .85rem;border-radius:6px;background:var(--raised);border:1px solid var(--border);font-size:.85rem;color:var(--t2);line-height:1.5;">
            <strong style="color:var(--t1);">Subsonic API (no-auth mode)</strong><br>
            Subsonic-compatible apps (Ultrasonic, DSub, Symfonium&hellip;) require a username.<br>
            Use <code style="background:var(--bg);padding:.1rem .35rem;border-radius:3px;color:var(--primary);font-size:.9em;">mstream-user</code> as the username with any password.
          </div>
          <table v-else>
            <thead>
              <tr>
                <th style="width:140px;">Username</th>
                <th>Folders</th>
                <th style="width:70px;">Role</th>
                <th style="width:130px;">Permissions</th>
                <th style="text-align:right;white-space:nowrap;">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(v, k) in users">
                <td style="font-weight:600;color:var(--t1);">{{k}}</td>
                <td><span style="color:var(--t2);font-size:.85rem;">{{v.vpaths.join(', ') || '&mdash;'}}</span></td>
                <td>
                  <span v-if="v.admin === true" style="background:rgba(139,92,246,.15);color:var(--primary);font-size:.75rem;font-weight:700;padding:.15rem .45rem;border-radius:4px;">Admin</span>
                  <span v-else style="background:var(--raised);color:var(--t2);font-size:.75rem;padding:.15rem .45rem;border-radius:4px;">User</span>
                </td>
                <td>
                  <div style="display:flex;flex-direction:column;gap:.3rem;">
                    <button type="button" class="btn-small btn-flat"
                      :title="v['allow-radio-recording'] ? 'Click to disable radio recording' : 'Click to enable radio recording'"
                      :style="v['allow-radio-recording'] ? 'background:rgba(220,50,50,.12);color:#e05555;border-color:rgba(220,50,50,.35);font-weight:600;' : ''"
                      style="text-align:left;width:100%;"
                      @click="toggleRadioRecording(k, v)">
                      &#9679;&nbsp;Record&nbsp;<span style="opacity:.6;font-size:.68rem;">{{v['allow-radio-recording'] ? 'ON' : 'off'}}</span>
                    </button>
                    <button type="button" class="btn-small btn-flat"
                      :title="v['allow-youtube-download'] ? 'Click to disable YouTube download' : 'Click to enable YouTube download'"
                      :style="v['allow-youtube-download'] ? 'background:rgba(220,50,50,.12);color:#e05555;border-color:rgba(220,50,50,.35);font-weight:600;' : ''"
                      style="text-align:left;width:100%;"
                      @click="toggleYoutubeDownload(k, v)">
                      &#9654;&nbsp;YouTube&nbsp;<span style="opacity:.6;font-size:.68rem;">{{v['allow-youtube-download'] ? 'ON' : 'off'}}</span>
                    </button>
                  </div>
                </td>
                <td>
                  <div style="display:flex;gap:.4rem;justify-content:flex-end;flex-wrap:wrap;">
                    <button class="btn-small btn-flat" type="button" @click="changePassword(k)">Password</button>
                    <button class="btn-small btn-flat" type="button" @click="changeVPaths(k)">Folders</button>
                    <button class="btn-small btn-flat" type="button" @click="changeAccess(k)">Access</button>
                    <button class="btn-small" type="button" style="background:var(--red);border-color:var(--red);" @click="deleteUser(k)">Delete</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

    </div>`,
    mounted: function () {
    },
    beforeDestroy: function() {
    },
    methods: {
      changeVPaths: function(username) {
        ADMINDATA.selectedUser.value = username;
        modVM.currentViewModal = 'user-vpaths-modal';
        modVM.openModal();
      },
      changeAccess: function(username) {
        ADMINDATA.selectedUser.value = username;
        modVM.currentViewModal = 'user-access-modal';
        modVM.openModal();
      },
      changePassword: function(username) {
        ADMINDATA.selectedUser.value = username;
        modVM.currentViewModal = 'user-password-modal';
        modVM.openModal();
      },
      deleteUser: function (username) {
                adminConfirm(`Delete <b>${username}</b>?`, '', 'Delete', async () => {
          try {
                          await API.axios({
                            method: 'DELETE',
                            url: `${API.url()}/api/v1/admin/users`,
                            data: { username: username }
                          });
                          Vue.delete(ADMINDATA.users, username);
                        } catch (err) {
                          iziToast.error({
                            title: 'Failed to delete user',
                            position: 'topCenter',
                            timeout: 3500
                          });
                        }
        });
      },
      addUser: async function (event) {
        try {
          this.submitPending = true;

          if (this.newUserDirs.length === 0) {
            iziToast.warning({
              title: 'No folder selected',
              message: 'Please select at least one folder for this user.',
              position: 'topCenter',
              timeout: 4000
            });
            this.submitPending = false;
            return;
          }

          const data = {
            username: this.newUsername,
            password: this.newPassword,
            vpaths: this.newUserDirs,
            admin: this.makeAdmin
          };

          await API.axios({
            method: 'PUT',
            url: `${API.url()}/api/v1/admin/users`,
            data: data
          });

          Vue.set(ADMINDATA.users, this.newUsername, { vpaths: data.vpaths, admin: data.admin });

          const isFirstUser = Object.keys(ADMINDATA.users).length === 1;

          this.newUsername = '';
          this.newPassword = '';
          this.showNewPassword = false;
          this.makeAdmin = false;
          this.newUserDirs = [];

          iziToast.success({ title: 'User added', position: 'topCenter', timeout: 3000 });

          if (isFirstUser) {
            adminConfirm('First user created', 'You will now be taken to the login page.', 'Go to Login', () => {
              window.location.href = '/login';
            });
          }
        }catch(err) {
          iziToast.error({
            title: 'Failed to add user',
            position: 'topCenter',
            timeout: 3500
          });
        }finally {
          this.submitPending = false;
        }
      },
      toggleRadioRecording: async function (username, user) {
        const newVal = !user['allow-radio-recording'];
        try {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/allow-radio-recording`,
            data: { username, allow: newVal }
          });
          Vue.set(ADMINDATA.users[username], 'allow-radio-recording', newVal);
          iziToast.success({ title: newVal ? 'Radio recording enabled' : 'Radio recording disabled', position: 'topCenter', timeout: 3000 });
        } catch (err) {
          iziToast.error({ title: 'Failed to update', position: 'topCenter', timeout: 3500 });
        }
      },
      toggleYoutubeDownload: async function (username, user) {
        const newVal = !user['allow-youtube-download'];
        try {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/allow-youtube-download`,
            data: { username, allow: newVal }
          });
          Vue.set(ADMINDATA.users[username], 'allow-youtube-download', newVal);
          iziToast.success({ title: newVal ? 'YouTube download enabled' : 'YouTube download disabled', position: 'topCenter', timeout: 3000 });
        } catch (err) {
          iziToast.error({ title: 'Failed to update', position: 'topCenter', timeout: 3500 });
        }
      }
    }
});

const advancedView = Vue.component('advanced-view', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      paramsTS: ADMINDATA.serverParamsUpdated
    };
  },
  template: `
    <div v-if="paramsTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Security</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>File Uploading:</b> {{params.noUpload === false ? 'Enabled' : 'Disabled'}}</td>
                      <td>
                        <a v-on:click="toggleFileUpload()" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>Auth Key:</b> ****************{{params.secret}}</td>
                      <td>
                        <a v-on:click="generateNewKey()" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Network Settings</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>Port:</b> {{params.port}}</td>
                      <td>
                        <a v-on:click="openModal('edit-port-modal')" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>Max Request Size:</b> {{params.maxRequestSize}}</td>
                      <td>
                        <a v-on:click="openModal('edit-request-size-modal')" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>Address:</b> {{params.address}}</td>
                      <td>
                        <a v-on:click="openModal('edit-address-modal')" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div v-if="!params.ssl || !params.ssl.cert">
                <div class="card-content">
                  <span class="card-title">SSL Settings</span>
                  <a v-on:click="openModal('edit-ssl-modal')" class="btn">Add SSL Certs</a>
                </div>
              </div>
              <div v-else>
                <div class="card-content">
                  <span class="card-title">SSL Settings</span>
                  <table>
                    <tbody>
                      <tr>
                        <td><b>Cert:</b> {{params.ssl.cert}}</td>
                      </tr>
                      <tr>
                        <td><b>Key:</b> {{params.ssl.key}}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div class="card-action">
                  <a v-on:click="openModal('edit-ssl-modal')" class="btn">Edit SSL</a>
                  <a v-on:click="removeSSL()" class="btn">Remove SSL</a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  methods: {
    openModal: function(modalView) {
      modVM.currentViewModal = modalView;
      modVM.openModal();
    },
    removeSSL: function() {
            adminConfirm('Remove SSL Keys?', 'Your server will need to reboot', 'Remove SSL', async () => {
        try {
                      await API.axios({
                        method: 'DELETE',
                        url: `${API.url()}/api/v1/admin/ssl`
                      });

                      setTimeout(() => {
                        window.location.href = window.location.href.replace('https://', 'http://'); 
                      }, 4000);

                      iziToast.success({
                        title: 'Certs Deleted. You will be redirected shortly',
                        position: 'topCenter',
                        timeout: 8500
                      });
                    } catch (err) {
                      iziToast.error({
                        title: 'Failed to Delete Cert',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }
      });
    },
    generateNewKey: function() {
            adminConfirm('<b>Generate a New Auth Key?</b>', 'All active login sessions will be invalidated.  You will need to login after', 'Generate Key', () => {
        API.axios({
                      method: 'POST',
                      url: `${API.url()}/api/v1/admin/config/secret`,
                      data: { strength: 128 }
                    }).then(() => {
                      API.logout();
                    }).catch(() => {
                      iziToast.error({
                        title: 'Failed',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    });
      });
    },
    toggleFileUpload: function() {
            adminConfirm(`<b>${this.params.noUpload === false ? 'Disable' : 'Enable'} File Uploading?</b>`, '', `${this.params.noUpload === false ? 'Disable' : 'Enable'}`, () => {
        API.axios({
                      method: 'POST',
                      url: `${API.url()}/api/v1/admin/config/noupload`,
                      data: { noUpload: !this.params.noUpload }
                    }).then(() => {
                      // update frontend data
                      Vue.set(ADMINDATA.serverParams, 'noUpload', !this.params.noUpload);

                      iziToast.success({
                        title: 'Updated Successfully',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }).catch(() => {
                      iziToast.error({
                        title: 'Failed',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    });
      });
    }
  }
});


const dbView = Vue.component('db-view', {
  data() {
    return {
      dbParams: ADMINDATA.dbParams,
      dbStats: null,
      sharedPlaylists: ADMINDATA.sharedPlaylists,
      sharedPlaylistsTS: ADMINDATA.sharedPlaylistUpdated,
      isPullingStats: false,
      isPullingShared: false,
      scanProgress: [],
      spPollTimer: null,
    };
  },
  mounted: async function() {
    await this.pollProgress();
    this.spPollTimer = setInterval(() => this.pollProgress(), 3000);
  },
  beforeDestroy: function() {
    if (this.spPollTimer) { clearInterval(this.spPollTimer); this.spPollTimer = null; }
  },
  template: `
    <div>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">DB Scan Settings</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>Scan Interval:</b> {{dbParams.scanInterval}} hours</td>
                      <td>
                        <a v-on:click="openModal('edit-scan-interval-modal')" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>Boot Scan Delay:</b> {{dbParams.bootScanDelay}} seconds</td>
                      <td>
                        <a v-on:click="openModal('edit-boot-scan-delay-modal')" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>Skip Image Metadata:</b> {{dbParams.skipImg}}</td>
                      <td>
                        <a v-on:click="toggleSkipImg()" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>Compress Images:</b> {{dbParams.compressImage}}</td>
                      <td>
                        <a v-on:click="recompressImages()" class="btn-sm">re-compress</a>
                        <a v-on:click="toggleCompressImage()" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>Max Concurrent Scans:</b> {{dbParams.maxConcurrentTasks}}</td>
                      <td>
                        <a v-on:click="openModal('edit-max-scan-modal')" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>DB Engine:</b> {{dbParams.engine}}</td>
                      <td>
                        <a v-on:click="openModal('edit-db-engine-modal')" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>Allow ID3 Tag Editing:</b> {{dbParams.allowId3Edit || false}}</td>
                      <td>
                        <a v-on:click="toggleAllowId3Edit()" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>Max ZIP Download Size:</b> {{dbParams.maxZipMb || 500}} MB</td>
                      <td>
                        <a v-on:click="openModal('edit-max-zip-mb-modal')" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Scan Queue & Stats</span>
                <a v-on:click="scanDB" class="btn">Start A Scan</a>
                <a v-if="scanProgress.length > 0" v-on:click="stopScan" class="btn red" style="margin-left:.5rem">Stop Scanning</a>
                <a v-on:click="pullStats" class="btn">Pull Stats</a>
                <div v-if="scanProgress.length > 0" class="sp-container">
                  <div v-for="sp in scanProgress" :key="sp.scanId" class="sp-card">
                    <div class="sp-header">
                      <span class="sp-live-dot"></span>
                      <span class="sp-vpath">{{sp.vpath}}</span>
                      <span v-if="sp.countingFound > 0 && sp.scanned === 0" class="sp-counting-badge">Counting&hellip;</span>
                      <span v-else-if="sp.pct !== null" class="sp-pct-badge">{{sp.pct}}%</span>
                      <span v-else class="sp-firstscan-badge">first scan</span>
                      <span class="sp-spacer"></span>
                      <span v-if="sp.etaSec" class="sp-eta">est. {{formatEta(sp.etaSec)}}</span>
                      <span v-if="sp.filesPerSec" class="sp-rate">{{sp.filesPerSec}}/s</span>
                    </div>
                    <div class="sp-track">
                      <div v-if="sp.countingFound > 0 && sp.scanned === 0" class="sp-fill-indeterminate"></div>
                      <div v-else-if="sp.pct !== null" class="sp-fill" :style="{width: sp.pct + '%'}"></div>
                      <div v-else class="sp-fill-indeterminate"></div>
                    </div>
                    <div class="sp-counts">
                      <span v-if="sp.countingFound > 0 && sp.scanned === 0">{{sp.countingFound.toLocaleString()}} files found&hellip;</span>
                      <span v-else-if="sp.expected">{{sp.scanned.toLocaleString()}} / {{sp.expected.toLocaleString()}} files checked</span>
                      <span v-else>{{sp.scanned.toLocaleString()}} files checked</span>
                      <span class="sp-elapsed">elapsed: {{formatElapsed(sp.elapsedSec)}}</span>
                    </div>
                    <div v-if="sp.added > 0" class="sp-counts" style="margin-top:.2rem;color:var(--accent,#26a69a)">
                      <span>{{sp.added.toLocaleString()}} added to DB</span>
                    </div>
                    <div v-if="sp.currentFile" class="sp-current-file">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                      <span class="sp-filepath" :title="sp.currentFile">{{truncatePath(sp.currentFile)}}</span>
                    </div>
                  </div>
                </div>
                <div v-if="isPullingStats === true">
                  <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
                </div>
                <div v-else-if="dbStats && dbStats.totalFiles != null">
                  <div class="stat-grid">
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.totalFiles||0).toLocaleString()}}</div>
                      <div class="sc-label">Total Tracks</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.totalArtists||0).toLocaleString()}}</div>
                      <div class="sc-label">Artists</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.totalAlbums||0).toLocaleString()}}</div>
                      <div class="sc-label">Albums</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.totalGenres||0).toLocaleString()}}</div>
                      <div class="sc-label">Genres</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.withArt||0).toLocaleString()}}</div>
                      <div class="sc-label">With Cover Art</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--t2)">{{(dbStats.withoutArt||0).toLocaleString()}}</div>
                      <div class="sc-label">No Cover Art</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.artEmbedded||0).toLocaleString()}}</div>
                      <div class="sc-label">Art Embedded in File</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.artFromDirectory||0).toLocaleString()}}</div>
                      <div class="sc-label">Art from Folder Image</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--accent)">{{(dbStats.artFromDiscogs||0).toLocaleString()}}</div>
                      <div class="sc-label">Art Picked by User (Discogs)</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--accent)">{{(dbStats.withReplaygain||0).toLocaleString()}}</div>
                      <div class="sc-label">ReplayGain Tagged</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--accent)">{{(dbStats.withCue||0).toLocaleString()}}</div>
                      <div class="sc-label">CUE Sheet Files</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--t2)">{{(dbStats.cueUnchecked||0).toLocaleString()}}</div>
                      <div class="sc-label">CUE Not Yet Scanned</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.addedLast7Days||0).toLocaleString()}}</div>
                      <div class="sc-label">Added Last 7 Days</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.addedLast30Days||0).toLocaleString()}}</div>
                      <div class="sc-label">Added Last 30 Days</div>
                    </div>
                    <div class="stat-chip" v-if="dbStats.oldestYear">
                      <div class="sc-num">{{dbStats.oldestYear}}&thinsp;&ndash;&thinsp;{{dbStats.newestYear}}</div>
                      <div class="sc-label">Year Range</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--accent)">{{(dbStats.waveformCount||0).toLocaleString()}}</div>
                      <div class="sc-label">Waveforms Cached</div>
                    </div>
                    <div class="stat-chip" v-if="dbStats.totalDurationSec > 0">
                      <div class="sc-num" style="color:var(--primary)">{{formatDuration(dbStats.totalDurationSec)}}</div>
                      <div class="sc-label">Total Library Duration</div>
                    </div>
                  </div>

                  <div class="stat-section-row">
                    <div class="stat-section" v-if="dbStats.formats.length > 1">
                      <div class="stat-section-title">Formats</div>
                      <div v-for="f in dbStats.formats" class="stat-bar-row">
                        <span class="stat-bar-label">{{f.format ? f.format.toUpperCase() : '?'}}</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(f.cnt/dbStats.totalFiles*100)+'%'}"></div></div>
                        <span class="stat-bar-count">{{f.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                    <div class="stat-section" v-if="dbStats.topArtists.length > 0">
                      <div class="stat-section-title">Top Artists by Track Count</div>
                      <div v-for="a in dbStats.topArtists" class="stat-bar-row">
                        <span class="stat-bar-label">{{a.artist}}</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(a.cnt/dbStats.topArtists[0].cnt*100)+'%', background:'var(--accent)'}"></div></div>
                        <span class="stat-bar-count">{{a.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                    <div class="stat-section" v-if="dbStats.topGenres.length > 0">
                      <div class="stat-section-title">Top Genres</div>
                      <div v-for="g in dbStats.topGenres" class="stat-bar-row">
                        <span class="stat-bar-label">{{g.genre}}</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(g.cnt/dbStats.topGenres[0].cnt*100)+'%', background:'var(--red)'}"></div></div>
                        <span class="stat-bar-count">{{g.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                    <div class="stat-section" v-if="dbStats.decades && dbStats.decades.length > 1">
                      <div class="stat-section-title">Music by Decade</div>
                      <div v-for="d in dbStats.decades" class="stat-bar-row">
                        <span class="stat-bar-label">{{d.decade}}s</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(d.cnt / Math.max(...dbStats.decades.map(x=>x.cnt)) * 100)+'%', background:'var(--t2)'}"></div></div>
                        <span class="stat-bar-count">{{d.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                    <div class="stat-section" v-if="dbStats.perVpath.length > 1">
                      <div class="stat-section-title">Tracks per Folder</div>
                      <div v-for="v in dbStats.perVpath" class="stat-bar-row">
                        <span class="stat-bar-label">{{v.vpath}}</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(v.cnt/dbStats.totalFiles*100)+'%', background:'var(--accent)'}"></div></div>
                        <span class="stat-bar-count">{{v.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                  </div>

                  <div v-if="dbStats.lastScannedTs" style="font-size:.8rem;color:var(--t2);margin-top:.75rem">
                    Last file added: {{new Date(dbStats.lastScannedTs).toLocaleString()}}
                  </div>
                </div>
                <div v-else-if="dbStats" style="color:var(--t2);font-size:.88rem;margin-top:.75rem">
                  {{(dbStats.fileCount||0).toLocaleString()}} files indexed &mdash; restart the server to see full statistics.
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Shared Playlists</span>
                <a v-on:click="loadShared" class="btn">Load Playlists</a>
                <br><br>
                <div v-if="isPullingShared === true">
                  <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
                </div>
                <div v-else-if="sharedPlaylistsTS.ts !== 0 && sharedPlaylists.length > 0">
                  <a v-on:click="deleteUnxpShared" class="btn-sm">Delete Playlists with no Expiration</a>
                  <br>
                  <a v-on:click="deleteExpiredShared" class="btn-sm">Delete Expired Playlists</a>
                  <br>
                  <table>
                    <thead>
                      <tr>
                        <th>Playlist ID</th>
                        <th>User</th>
                        <th>Expires</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(v, k) in sharedPlaylists">
                        <th><a target="_blank" v-bind:href="'/shared/'+ v.playlistId">{{v.playlistId}}</a></th>
                        <th>{{v.user}}</th>
                        <th>{{new Date(v.expires * 1000).toLocaleString()}}</th>
                        <th><a v-on:click="deletePlaylist(v)" class="btn-sm btn-sm-delete">delete</a></th>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div v-else-if="sharedPlaylistsTS.ts !== 0 && sharedPlaylists.length === 0">
                  No Shared Playlists
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    pollProgress: async function() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/db/scan/progress` });
        this.scanProgress = res.data;
      } catch (_e) {}
    },
    formatEta: function(sec) {
      if (!sec || sec <= 0) return null;
      if (sec < 60) return `${sec}s`;
      if (sec < 3600) return `${Math.floor(sec/60)}m ${sec%60}s`;
      return `${Math.floor(sec/3600)}h ${Math.floor((sec%3600)/60)}m`;
    },
    formatDuration: function(sec) {
      if (!sec || sec <= 0) return '0m';
      const d = Math.floor(sec / 86400);
      const h = Math.floor((sec % 86400) / 3600);
      const m = Math.floor((sec % 3600) / 60);
      if (d > 0) return `${d}d ${h}h ${m}m`;
      if (h > 0) return `${h}h ${m}m`;
      return `${m}m`;
    },
    formatElapsed: function(sec) {
      if (!sec || sec <= 0) return '0s';
      if (sec < 60) return `${sec}s`;
      if (sec < 3600) return `${Math.floor(sec/60)}m ${sec%60}s`;
      return `${Math.floor(sec/3600)}h ${Math.floor((sec%3600)/60)}m`;
    },
    truncatePath: function(fp, maxLen = 60) {
      if (!fp) return '';
      if (fp.length <= maxLen) return fp;
      return '\u2026' + fp.slice(-(maxLen - 1));
    },
    pullStats: async function() {
      try {
        this.isPullingStats = true;
        const res = await API.axios({
          method: 'GET',
          url: `${API.url()}/api/v1/admin/db/scan/stats`
        });

        this.dbStats = res.data
      } catch (err) {
        iziToast.error({
          title: 'Failed to Pull Data',
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.isPullingStats = false;
      }
    },
    loadShared: async function() {
      try {
        this.isPullingShared = true;
        await ADMINDATA.getSharedPlaylists();
      } catch (err) {
        iziToast.error({
          title: 'Failed to Pull Data',
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.isPullingShared = false;
      }
    },
    deletePlaylist: async function(playlistObj) {
            adminConfirm(`Delete playlist <b>${playlistObj.playlistId}</b>?`, '', 'Delete', async () => {
        try {
                      await ADMINDATA.deleteSharedPlaylist(playlistObj);
                    } catch (err) {
                      iziToast.error({
                        title: 'Failed to Delete Playlist',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }
      });
    },
    deleteUnxpShared: async function() {
            adminConfirm(`Delete all playlists without expiration dates?`, '', 'Delete', async () => {
        try {
                      this.isPullingShared = true;
                      await ADMINDATA.deleteUnxpShared();
                      await ADMINDATA.getSharedPlaylists();
                    } catch (err) {
                      iziToast.error({
                        title: 'Failed to Delete Shared Playlists',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    } finally {
                      this.isPullingShared = false;
                    }
      });
    },
    deleteExpiredShared: async function() {
      try {
        this.isPullingShared = true;
        await ADMINDATA.deleteExpiredShared();
        await ADMINDATA.getSharedPlaylists();
      } catch (err) {
        iziToast.error({
          title: 'Failed to Pull Data',
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.isPullingShared = false;
      }
    },
    scanDB: async function() {
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/scan/all`
        });

        iziToast.success({
          title: 'Scan Started',
          position: 'topCenter',
          timeout: 3500
        });
      } catch (err) {
        iziToast.error({
          title: 'Failed to Start Scan',
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    stopScan: async function() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/scan/stop` });
        iziToast.success({ title: 'Scan Stopped', position: 'topCenter', timeout: 3500 });
        this.scanProgress = [];
      } catch (err) {
        iziToast.error({ title: 'Failed to Stop Scan', position: 'topCenter', timeout: 3500 });
      }
    },
    recompressImages: function() {
            adminConfirm(`<b>Compress All Images?</b>`, 'This process will run in the background', 'Start', async () => {
        try {
                      const res = await API.axios({
                        method: 'POST',
                        url: `${API.url()}/api/v1/admin/db/force-compress-images`,
                      });

                      if (res.data.started === true) {
                        iziToast.success({
                          title: 'Process Started',
                          position: 'topCenter',
                          timeout: 3500
                        });
                      } else {
                        iziToast.warning({
                          title: 'Image Compression In Progress',
                          position: 'topCenter',
                          timeout: 3500
                        });
                      }

                    } catch (err) {
                      iziToast.error({
                        title: 'Failed',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }
      });
    },
    toggleCompressImage: function() {
            adminConfirm(`<b>${this.dbParams.compressImage === true ? 'Disable' : 'Enable'} Compress Images?</b>`, '', `${this.dbParams.compressImage === true ? 'Disable' : 'Enable'}`, () => {
        API.axios({
                      method: 'POST',
                      url: `${API.url()}/api/v1/admin/db/params/compress-image`,
                      data: { compressImage: !this.dbParams.compressImage }
                    }).then(() => {
                      // update frontend data
                      Vue.set(ADMINDATA.dbParams, 'compressImage', !this.dbParams.compressImage);

                      iziToast.success({
                        title: 'Updated Successfully',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }).catch(() => {
                      iziToast.error({
                        title: 'Failed',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    });
      });
    },
    toggleAllowId3Edit: function() {
            adminConfirm(
        `<b>${this.dbParams.allowId3Edit ? 'Disable' : 'Enable'} ID3 Tag Editing?</b>`,
        this.dbParams.allowId3Edit
          ? 'Admins will no longer be able to edit ID3 tags in the Now Playing modal.'
          : 'Allows admins to edit ID3 tags (title, artist, album, year, genre…) in the Now Playing modal. Tags are written directly to the file via ffmpeg.',
        this.dbParams.allowId3Edit ? 'Disable' : 'Enable',
        () => {
          API.axios({
                        method: 'POST',
                        url: `${API.url()}/api/v1/admin/db/params/allow-id3edit`,
                        data: { allowId3Edit: !this.dbParams.allowId3Edit }
                      }).then(() => {
                        Vue.set(ADMINDATA.dbParams, 'allowId3Edit', !this.dbParams.allowId3Edit);
                        iziToast.success({ title: 'Updated Successfully', position: 'topCenter', timeout: 3500 });
                      }).catch(() => {
                        iziToast.error({ title: 'Failed', position: 'topCenter', timeout: 3500 });
                      });
        }
      );
    },
    toggleSkipImg: function() {
            adminConfirm(`<b>${this.dbParams.skipImg === true ? 'Disable' : 'Enable'} Image Skip?</b>`, '', `${this.dbParams.skipImg === true ? 'Disable' : 'Enable'}`, () => {
        API.axios({
                      method: 'POST',
                      url: `${API.url()}/api/v1/admin/db/params/skip-img`,
                      data: { skipImg: !this.dbParams.skipImg }
                    }).then(() => {
                      // update frontend data
                      Vue.set(ADMINDATA.dbParams, 'skipImg', !this.dbParams.skipImg);

                      iziToast.success({
                        title: 'Updated Successfully',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }).catch(() => {
                      iziToast.error({
                        title: 'Failed',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    });
      });
    },
    openModal: function(modalView) {
      modVM.currentViewModal = modalView;
      modVM.openModal();
    }
  }
});

// ── Backup View ──────────────────────────────────────────────────────────────
const backupView = Vue.component('backup-view', {
  data() {
    return {
      backups: [],
      isLoading: true,
      isCreating: false,
    };
  },
  mounted: async function() {
    await this.loadBackups();
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Backup</span>
              <p style="color:var(--t2);margin-bottom:1rem;">
                Create a backup of the database and configuration file. Backups are stored in
                <code style="color:var(--accent);background:var(--raised);padding:.1rem .35rem;border-radius:4px;">save/backups/</code>.
                A backup runs automatically every week and the 4 most recent are kept.
              </p>
              <div v-if="isLoading" style="text-align:center;padding:2rem 0;">
                <svg class="spinner" width="40px" height="40px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else>
                <div v-if="backups.length === 0" style="color:var(--t2);margin:.5rem 0 1rem;">No backups yet.</div>
                <table v-else>
                  <thead>
                    <tr>
                      <th>Filename</th>
                      <th>Size</th>
                      <th>Created</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="b in backups" :key="b.filename">
                      <td style="font-family:monospace;font-size:.85rem;">{{b.filename}}</td>
                      <td>{{formatBytes(b.size)}}</td>
                      <td>{{formatDate(b.mtime)}}</td>
                      <td><a class="btn-sm btn-sm-download" title="Download" style="cursor:pointer;" @click="downloadBackup(b.filename)">Download</a></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div class="card-action">
              <button class="btn" type="button" :disabled="isCreating" @click="createBackup()">
                <span v-if="isCreating">Creating…</span>
                <span v-else>Create Backup Now</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    loadBackups: async function() {
      this.isLoading = true;
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/backups` });
        this.backups = res.data;
      } catch (_) {
        iziToast.error({ title: 'Failed to load backups', position: 'topCenter', timeout: 3500 });
      }
      this.isLoading = false;
    },
    createBackup: async function() {
      this.isCreating = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/backup` });
        iziToast.success({ title: 'Backup created successfully', position: 'topCenter', timeout: 3500 });
        await this.loadBackups();
      } catch (_) {
        iziToast.error({ title: 'Backup failed', position: 'topCenter', timeout: 3500 });
        this.isCreating = false;
      }
      this.isCreating = false;
    },
    downloadBackup: async function(filename) {
      try {
        const response = await API.axios({
          url: `${API.url()}/api/v1/admin/backup/download/${encodeURIComponent(filename)}`,
          method: 'GET',
          responseType: 'blob',
        });
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        link.remove();
      } catch (_) {
        iziToast.error({ title: 'Download failed', position: 'topCenter', timeout: 3500 });
      }
    },
    formatBytes: function(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },
    formatDate: function(ms) {
      if (!ms) return '—';
      return new Date(ms).toLocaleString();
    },
  }
});

const rpnView = Vue.component('rpn-view', {
  data() {
    return {
      activeTab: 'standard',
      submitPending: false
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <h1>mStream RPN</h1>
          <div class="card">
            <div class="tabs">
              <div class="tab"><button :class="{active: activeTab==='standard'}" @click="activeTab='standard'">Standard</button></div>
              <div class="tab"><button :class="{active: activeTab==='advanced'}" @click="activeTab='advanced'">Advanced</button></div>
            </div>
            <div id="test1" v-show="activeTab==='standard'">
              <form @submit.prevent="standardLogin">
                <div class="card-content">
                  <span class="card-title">Login</span>
                  <div class="row">
                    <div class="col s12 m6">
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-simple-username" required type="text">
                          <label for="rpn-simple-username">Username</label>
                        </div>
                      </div>
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-simple-password" required type="password">
                          <label for="rpn-simple-password">Password</label>
                        </div>
                      </div>
                    </div>
                    <div class="col s12 m6 hide-on-small-only">
                      <div class="row">
                        <h5 class="center-align">Help Support mStream</h5>
                      </div>
                      <div class="row">
                        <div class="col s2"></div>
                        <a target="_blank" href="https://mstream.io/reverse-proxy-network" class="btn blue">Sign Up</a>
                        <div class="col s2"></div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="card-action">
                  <button class="btn" type="submit" :disabled="submitPending === true">
                    {{submitPending === false ? 'Login to RPN' : 'Pending...'}}
                  </button>
                </div>
              </form>
            </div>
            <div id="test2" v-show="activeTab==='advanced'">
              <form @submit.prevent="advancedLogin">
                <div class="card-content">
                  <span class="card-title">Config</span>
                  <div class="row">
                    <div class="col s12 m12 l6">
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-advanced-address" required type="text">
                          <label for="rpn-advanced-address">Server Address</label>
                        </div>
                      </div>
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-advanced-port" required type="number" type="number" min="2" max="65535">
                          <label for="rpn-advanced-port">Port</label>
                        </div>
                      </div>
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-advanced-domain" required type="text">
                          <label for="rpn-advanced-domain">Server Domain</label>
                        </div>
                      </div>
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-advanced-password" required type="password">
                          <label for="rpn-advanced-password">Server Key</label>
                        </div>
                      </div>
                    </div>
                    <div class="col s12 m12 l6">
                      <h5>
                        <a target="_blank" href="https://github.com/fog-machine/tunnel-server">
                          Check the docs to learn how to deploy your own server
                        </a>
                      </h5>
                    </div>
                  </div>
                </div>
                <div class="card-action">
                  <button class="btn" type="submit" :disabled="submitPending === true">
                    {{submitPending === false ? 'Connect To Server' : 'Connecting...'}}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
      <div class="row">
        <h4>Features</h4>
        <ul class="browser-default">
          <li>Choose your own domain @ https://your-name.mstream.io</li>
          <li>Automatic SSL Encryption for your server</li>
          <li>'Hole Punching' software guarantees your server stays online as long as you have a working internet connection</li>
          <li>IP Obfuscation hides your IP address and adds an additional layer of security</li>  
        </ul>
      </div>
    </div>`,
  methods: {
    standardLogin: function() {
      console.log('STAND')
    },
    advancedLogin: function() {
      console.log('ADV')
    }
  }
});

const infoView = Vue.component('info-view', {
  data() {
    return {
      version: ADMINDATA.version,
      telemetryPending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row logo-row-mstream" style="display:flex;align-items:center;gap:14px;padding:0 0 8px;">
        <svg width="72" height="72" viewBox="72 33 76 89">
          <defs>
            <linearGradient id="aa-vg-o" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#c4b5fd"/><stop offset="100%" stop-color="#6d28d9" stop-opacity=".85"/></linearGradient>
            <linearGradient id="aa-vg-i" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4c1d95"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient>
          </defs>
          <polygon fill="url(#aa-vg-o)" points="75,118.5 75,35.5 96,48.5 96,118.5"/>
          <polygon fill="url(#aa-vg-i)" points="99,118.5 99,49.5 110.5,56.5 121,49.5 121,118.5"/>
          <polygon fill="url(#aa-vg-o)" points="124,118.5 124,48.5 145,35.5 145,118.5"/>
        </svg>
        <div>
          <div style="font-size:1.6rem;font-weight:700;line-height:1.1;"><span style="font-weight:300;color:var(--t2);">m</span><span style="color:var(--t1);">Stream</span> <span style="font-size:.7rem;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:var(--primary);opacity:.85;">Velvet</span></div>
          <div style="font-size:.8rem;color:var(--t3);margin-top:2px;">Admin Panel</div>
        </div>
      </div>
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <h4 style="margin:0 0 .25rem;font-size:1.3rem;font-weight:700;color:var(--t1);"><span style="font-weight:300;color:var(--t2);">m</span><span style="font-weight:700;color:var(--t1);">Stream</span> <span style="font-size:10px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:var(--primary);opacity:.85;vertical-align:middle;position:relative;top:-1px;">Velvet</span> <span style="color:var(--primary);font-size:1rem;">v{{version.val}}</span> <span style="color:var(--t2);font-size:.8rem;font-weight:400;">— a fork of mStream</span></h4>
              <p style="margin:0 0 1.25rem;color:var(--t2);font-size:.85rem;">mStream Developed by <strong style="color:var(--t1);">Paul Sori</strong><br>Features, Functionality and Maintenance by <strong style="color:var(--t1);">Dennis Slagers</strong> (AroundMyRoom)</p>
              <div style="margin-bottom:1.25rem;display:flex;gap:.75rem;flex-wrap:wrap;">
                <a href="https://github.com/aroundmyroom/mStream" target="_blank" style="display:inline-flex;align-items:center;gap:8px;background:var(--raised);border:1px solid var(--border);color:var(--t1);text-decoration:none;padding:.5rem 1rem;border-radius:6px;font-size:.85rem;font-weight:600;">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/></svg>
                  GitHub — mStream Velvet
                </a>
                <a href="https://discord.gg/KfsTCYrTkS" target="_blank" style="display:inline-flex;align-items:center;gap:8px;background:#5865F2;color:#fff;text-decoration:none;padding:.5rem 1rem;border-radius:6px;font-size:.85rem;font-weight:600;">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
                  Discord — mStream Velvet
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Anonymous Telemetry</span>
              <p style="color:var(--t2);margin-bottom:.75rem;">mStream Velvet sends a small anonymous ping once at startup and then every 24 hours. This helps us understand how many instances are running and which versions are in use.</p>
              <p style="color:var(--t2);margin-bottom:.5rem;font-size:.85rem;"><strong style="color:var(--t1);">Exactly this data is sent — nothing more:</strong></p>
              <pre style="background:var(--raised);border:1px solid var(--border);border-radius:6px;padding:.65rem .9rem;font-size:.78rem;color:var(--t2);margin:0 0 1rem;overflow-x:auto;">{"id":"&lt;random UUID, generated once on first boot&gt;","version":"&lt;current version&gt;","platform":"linux","lastSeen":1774595289943}</pre>
              <p style="color:var(--t2);font-size:.85rem;margin-bottom:0;">No IP addresses, usernames, file paths, or any personal data is ever collected. The UUID is stored in <code style="color:var(--accent);background:var(--raised);padding:.1rem .3rem;border-radius:3px;">save/conf/instance-id</code> and never changes unless you delete it. To opt out permanently, add <code style="color:var(--accent);background:var(--raised);padding:.1rem .3rem;border-radius:3px;">"telemetry": false</code> to your config file and restart mStream.</p>
            </div>
          </div>
        </div>
      </div>
    </div>`
});

// ── Server Audio Admin View ────────────────────────────────────────────────
const serverAudioView = Vue.component('server-audio-view', {
  data() {
    return {
      params: ADMINDATA.serverAudioParams,
      paramsTS: ADMINDATA.serverAudioParamsUpdated,
      mpvPath: '',
      detecting: false,
      detectResult: null,
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card" style="margin-bottom:10px">
            <div class="card-content">
              <span class="card-title">Server Audio <span style="font-size:.7em;font-weight:400;color:var(--t2)">▸ mpv</span></span>
              <p style="color:var(--t2);font-size:.92rem;margin-bottom:18px">
                Stream audio directly through the server's speakers.
                A lightweight browser remote at <code>/server-remote</code> lets you control playback, browse files, and run Auto-DJ from any device.
              </p>
              <div v-if="paramsTS.ts === 0" style="padding:16px 0;display:flex;justify-content:center">
                <svg class="spinner" width="48px" height="48px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else>
                <table>
                  <tbody>
                    <tr>
                      <td><b>Status:</b>&nbsp;
                        <span v-if="params.enabled">
                          <span v-if="params.running" style="color:var(--green)">● Running</span>
                          <span v-else style="color:var(--orange,#f97316)">● Enabled, mpv not started</span>
                        </span>
                        <span v-else style="color:var(--t3)">Disabled</span>
                      </td>
                      <td>
                        <a v-on:click="toggleEnabled()" class="btn-sm btn-sm-edit">{{params.enabled ? 'Disable' : 'Enable'}}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>mpv Enabled:</b> {{params.enabled ? 'Yes' : 'No'}}</td>
                      <td></td>
                    </tr>
                    <tr>
                      <td><b>mpv Binary Path:</b> <code>{{params.mpvBin || 'mpv'}}</code></td>
                      <td>
                        <a v-on:click="changeMpvBin()" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td colspan="2" style="padding-top:10px;padding-bottom:4px">
                        <a v-on:click="detectMpv()" class="btn-sm" style="margin-right:6px">Detect mpv</a>
                        <a v-on:click="startMpv()"  class="btn-sm" style="margin-right:6px">Start</a>
                        <a v-on:click="stopMpv()"   class="btn-sm">Stop</a>
                      </td>
                    </tr>
                    <tr v-if="detectResult !== null">
                      <td colspan="2" style="font-size:.87rem;color:var(--t2)">
                        <span v-if="detectResult.found" style="color:var(--green)">
                          ✓ Found mpv {{detectResult.version}} at <code>{{detectResult.path}}</code>
                        </span>
                        <span v-else style="color:var(--red)">
                          ✗ mpv not found at <code>{{detectResult.path}}</code>. Install mpv or set path above.
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td colspan="2" style="padding-top:12px">
                        <a href="/server-remote" target="_blank" class="btn-sm btn-sm-edit">Open Server Remote ↗</a>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-content">
              <span class="card-title">How it works</span>
              <ul style="color:var(--t2);font-size:.9rem;line-height:1.7;padding-left:1.2em;list-style:disc">
                <li>mStream starts <b>mpv</b> in <em>idle</em> mode and communicates via a local Unix socket.</li>
                <li>Your browser becomes a remote control — you never need to install anything on mobile.</li>
                <li>Auto-DJ in the remote page automatically queues new songs using your library, with optional Last.fm similar-artists matching.</li>
                <li>mpv must be installed on the server. See the <a href="https://github.com/AroundMyRoom/mStream/blob/master/docs/server-audio.md" target="_blank" style="color:var(--primary)">documentation</a> for install instructions.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    toggleEnabled() {
      const next = !this.params.enabled;
      adminConfirm(
        `<b>${next ? 'Enable' : 'Disable'} Server Audio?</b>`,
        next ? 'This will start mpv on the server.' : 'This will stop mpv on the server.',
        next ? 'Enable' : 'Disable',
        async () => {
          await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/server-audio`, data: { enabled: next } });
          Vue.set(ADMINDATA.serverAudioParams, 'enabled', next);
          if (!next) Vue.set(ADMINDATA.serverAudioParams, 'running', false);
          await ADMINDATA.getServerAudioParams();
        }
      );
    },
    changeMpvBin() {
      modVM.currentViewModal = 'server-audio-mpvbin-modal';
      modVM.openModal();
    },
    async detectMpv() {
      this.detecting = true; this.detectResult = null;
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/server-playback/detect` });
        this.detectResult = res.data;
      } catch (_) { this.detectResult = { found: false, path: this.params.mpvBin || 'mpv' }; }
      this.detecting = false;
    },
    async startMpv() {
      await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/server-audio/start` });
      await ADMINDATA.getServerAudioParams();
    },
    async stopMpv() {
      await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/server-audio/stop` });
      Vue.set(ADMINDATA.serverAudioParams, 'running', false);
    },
  }
});

const transcodeView = Vue.component('transcode-view', {
  data() {
    return {
      params: ADMINDATA.transcodeParams,
      paramsTS: ADMINDATA.transcodeParamsUpdated,
      downloadPending: ADMINDATA.downloadPending,
    };
  },
  template: `
    <div class="container">
      <div class="powered-by-row">
        <span class="powered-by-label">Powered by</span>
        <svg class="ffmpeg-logo" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 224.44334 60.186738">
          <defs>
            <radialGradient id="a" gradientUnits="userSpaceOnUse" cy="442.72311" cx="-122.3936" gradientTransform="matrix(1,0,0,-1,134.4463,453.7334)" r="29.5804">
              <stop stop-color="#fff" offset="0"/>
              <stop stop-color="#007808" offset="1"/>
            </radialGradient>
          </defs>
          <g>
            <polygon points="0.511 12.364 0.511 5.078 5.402 6.763 5.402 13.541" fill="#0b4819"/>
            <polygon points="4.455 42.317 4.455 15.226 9.13 16.215 9.13 41.393" fill="#0b4819"/>
            <polygon points="27.321 5.066 15.306 18.846 15.306 24.71 33.126 4.617 61.351 2.432 19.834 45.706 25.361 45.997 55.516 15.154 55.516 44.305 52.166 47.454 60.662 47.913 60.662 55.981 34.012 53.917 47.597 40.738 47.597 34.243 28.175 53.465 4.919 51.667 42.222 11.55 36.083 11.882 9.13 41.393 9.13 16.215 11.683 13.201 5.402 13.541 5.402 6.763" fill="#105c80"/>
            <polygon points="4.455 15.226 7.159 11.971 11.683 13.201 9.13 16.215" fill="#0b4819"/>
            <polygon points="11.004 18.039 15.306 18.846 15.306 24.71 11.004 24.358" fill="#084010"/>
            <polygon points="15.82 47.006 19.834 45.706 25.361 45.997 21.714 47.346" fill="#0c541e"/>
            <polygon points="23.808 3.106 27.321 5.066 15.306 18.846 11.004 18.039" fill="#1a5c34"/>
            <polygon points="11.004 24.358 30.022 2.58 33.126 4.617 15.306 24.71" fill="#0b4819"/>
            <polygon points="33.195 10.432 36.083 11.882 9.13 41.393 4.455 42.317" fill="#1a5c34"/>
            <polygon points="0 53.344 39.798 10.042 42.222 11.55 4.919 51.667" fill="#0b4819"/>
            <polygon points="45.597 34.677 47.597 34.243 28.175 53.465 24.721 55.437" fill="#1a5c34"/>
            <polygon points="45.597 41.737 45.597 34.677 47.597 34.243 47.597 40.738" fill="#0b4819"/>
            <polygon points="30.973 55.965 45.597 41.737 47.597 40.738 34.012 53.917" fill="#0b4819"/>
            <polygon points="54.168 45.648 50.538 49.059 52.166 47.454 55.516 44.305" fill="#13802d"/>
            <polygon points="21.714 47.346 54.168 13.9 55.516 15.154 25.361 45.997" fill="#0b4819"/>
            <polygon points="54.168 13.9 55.516 15.154 55.516 44.305 54.168 45.648" fill="#084010"/>
            <polygon points="59.759 49.604 60.662 47.913 60.662 55.981 59.759 58.403" fill="#084010"/>
            <polygon points="60.507 0 61.351 2.432 19.834 45.706 15.82 47.006" fill="#1a5c34"/>
            <polygon points="23.808 3.106 11.004 18.039 11.004 24.358 30.022 2.58 60.507 0 15.82 47.006 21.714 47.346 54.168 13.9 54.168 45.648 50.538 49.059 59.759 49.604 59.759 58.403 30.973 55.965 45.597 41.737 45.597 34.677 24.721 55.437 0 53.344 39.798 10.042 33.195 10.432 4.455 42.317 4.455 15.226 7.159 11.971 0.511 12.364 0.511 5.078" fill="url(#a)"/>
          </g>
          <g class="ffmpeg-text" transform="matrix(2.6160433,0,0,2.6160433,70,-145)">
            <polygon points="2.907 66.777 6.825 66.777 6.825 69.229 2.907 69.229 2.907 74.687 0.797 74.687 0.797 74.688 0.797 61.504 8.218 61.504 8.218 63.965 2.907 63.965"/>
            <polygon points="11.13 66.777 15.049 66.777 15.049 69.229 11.13 69.229 11.13 74.687 9.021 74.687 9.021 74.688 9.021 61.504 16.442 61.504 16.442 63.965 11.13 63.965"/>
            <path d="m19.69 69.063v5.625h-2.461v-8.534l2.461-0.264v0.782c0.551-0.517 1.254-0.773 2.109-0.773 1.113 0 1.963 0.337 2.549 1.011 0.645-0.674 1.611-1.011 2.9-1.011 1.113 0 1.963 0.337 2.549 1.011 0.586 0.675 0.879 1.45 0.879 2.329v5.449h-2.461v-4.834c0-0.586-0.132-1.04-0.396-1.362-0.264-0.321-0.691-0.491-1.283-0.51-0.486 0.035-0.908 0.357-1.266 0.967-0.029 0.183-0.044 0.366-0.044 0.555v5.186h-2.461v-4.834c0-0.586-0.132-1.04-0.396-1.362-0.264-0.321-0.689-0.492-1.281-0.511-0.539 0.034-1.005 0.394-1.398 1.08z"/>
            <path d="m31.913 78.379v-12.225l2.461-0.264v0.703c0.656-0.47 1.301-0.703 1.934-0.703 1.348 0 2.417 0.438 3.208 1.317 0.791 0.88 1.187 1.904 1.187 3.076s-0.396 2.197-1.187 3.076-1.86 1.318-3.208 1.318c-0.879-0.06-1.523-0.296-1.934-0.712v4.421l-2.461-0.007zm2.461-8.885v1.425c0.117 0.983 0.732 1.562 1.846 1.73 1.406-0.111 2.197-0.841 2.373-2.188-0.059-1.642-0.85-2.49-2.373-2.55-1.114 0.176-1.729 0.704-1.846 1.583z"/>
            <path d="m41.094 70.293c0-1.289 0.41-2.345 1.23-3.164 0.82-0.82 1.875-1.23 3.164-1.23s2.314 0.41 3.076 1.23c0.762 0.819 1.143 1.875 1.143 3.164v0.879h-6.064c0.059 0.469 0.264 0.835 0.615 1.099s0.762 0.396 1.23 0.396c0.82 0 1.553-0.233 2.197-0.702l1.406 1.405c-0.645 0.879-1.846 1.318-3.604 1.318-1.289 0-2.344-0.41-3.164-1.23s-1.229-1.875-1.229-3.165zm5.625-1.977c-0.352-0.264-0.762-0.396-1.23-0.396s-0.879 0.132-1.23 0.396-0.527 0.63-0.527 1.099h3.516c-0.002-0.469-0.178-0.835-0.529-1.099z"/>
            <path d="m59.037 66.163v7.822c0 1.23-0.366 2.259-1.099 3.085s-1.655 1.263-2.769 1.311l-0.527 0.053c-1.699-0.035-3.018-0.521-3.955-1.459l1.143-1.318c0.645 0.47 1.427 0.732 2.347 0.791 0.938 0 1.572-0.22 1.902-0.659 0.332-0.438 0.497-0.923 0.497-1.449v-0.439c-0.656 0.527-1.418 0.791-2.285 0.791-1.348 0-2.358-0.396-3.032-1.187s-1.011-1.86-1.011-3.208c0-1.289 0.366-2.345 1.099-3.164 0.733-0.82 1.772-1.23 3.12-1.23 0.996 0.06 1.699 0.325 2.109 0.8v-0.8l2.461 0.26zm-2.461 4.921v-1.424c-0.117-0.983-0.732-1.562-1.846-1.73-1.465 0.053-2.256 0.782-2.373 2.188 0.059 1.642 0.85 2.49 2.373 2.55 1.114-0.177 1.729-0.705 1.846-1.584z"/>
          </g>
        </svg>
      </div>
      <div v-if="paramsTS.ts === 0" class="row">
        <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>
      <div v-else class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Settings</span>
              <table>
                <tbody>
                  <tr>
                    <td><b>Transcoding:</b> {{params.enabled === true ? 'Enabled' : 'Disabled'}}</td>
                    <td>
                      <a v-on:click="toggleEnabled()" class="btn-sm btn-sm-edit">edit</a>
                    </td>
                  </tr>
                  <tr>
                    <td><b>FFmpeg Directory:</b> {{params.ffmpegDirectory}}</td>
                    <td style="color:var(--t2);font-size:.82rem">Edit in config file</td>
                  </tr>
                  <tr>
                    <td><b>FFmpeg Downloaded:</b> {{downloadPending.val === true ? 'pending...' : params.downloaded}}</td>
                    <td>
                      <a v-on:click="downloadFFMpeg()" class="btn-sm">download</a>
                    </td>
                  </tr>
                  <tr>
                    <td><b>Default Codec:</b> {{params.defaultCodec}}</td>
                    <td>
                      <a v-on:click="changeCodec()" class="btn-sm btn-sm-edit">edit</a>
                    </td>
                  </tr>
                  <tr>
                    <td><b>Default Bitrate:</b> {{params.defaultBitrate}}</td>
                    <td>
                      <a v-on:click="changeBitrate()" class="btn-sm btn-sm-edit">edit</a>
                    </td>
                  </tr>
                  <tr>
                  <td><b>Default Algorithm:</b> {{params.algorithm}}</td>
                  <td>
                    <a v-on:click="changeAlgorithm()" class="btn-sm btn-sm-edit">edit</a>
                  </td>
                </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    toggleEnabled: function() {
            adminConfirm(`<b>${this.params.enabled === true ? 'Disable' : 'Enable'} Transcoding?</b>`, 'Enabling this will download FFmpeg', `${this.params.enabled === true ? 'Disable' : 'Enable'}`, async () => {
        try {
                      await API.axios({
                        method: 'POST',
                        url: `${API.url()}/api/v1/admin/transcode/enable`,
                        data: { enable: !this.params.enabled }
                      });
                      Vue.set(ADMINDATA.transcodeParams, 'enabled', !this.params.enabled);

                      // download ffmpeg
                      if (this.params.enabled === true) { this.downloadFFMpeg(); }

                      iziToast.success({
                        title: 'Updated Successfully',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    } catch (err) {
                      iziToast.error({
                        title: 'Failed',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }
      });
    },
    changeCodec: function() {
      modVM.currentViewModal = 'edit-transcode-codec-modal';
      modVM.openModal();
    },
    changeBitrate: function() {
      modVM.currentViewModal = 'edit-transcode-bitrate-modal';
      modVM.openModal();
    },
    changeAlgorithm: function() {
      modVM.currentViewModal = 'edit-transcode-algorithm-modal';
      modVM.openModal();
    },
    downloadFFMpeg: async function() {
      if (this.downloadPending.val === true) {
        return;
      }

      try {
        this.downloadPending.val = true;
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/transcode/download`,
        });
        Vue.set(ADMINDATA.transcodeParams, 'downloaded', true);
        iziToast.success({
          title: 'FFmpeg Downloaded',
          position: 'topCenter',
          timeout: 3500
        });
      } catch (err) {
        iziToast.error({
          title: 'Failed To Download FFmpeg',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.downloadPending.val = false;
      }
    },
    changeFolder: function() {}
  }
});

const federationMainPanel = Vue.component('federation-main-panel', { // activeTab-patched
  data() {
    return {
      params: ADMINDATA.federationParams,
      paramsTS: ADMINDATA.federationParamsUpdated,
      enabled: ADMINDATA.federationEnabled,
      syncthingUrl: "",
      activeTab: 'federation',
      enablePending: false,

      currentToken: '',
      inviteServerUrl: '',
      parsedTokenData: null,
      submitPending: false
    };
  },
  template: `
    <div>
      <div class="tabs">
        <div class="tab"><button :class="{active: activeTab==='federation'}" @click="activeTab='federation'">Federation</button></div>
        <div class="tab"><button :class="{active: activeTab==='syncthing'}" @click="activeTab='syncthing'; setSyncthingUrl()">Syncthing</button></div>
      </div>
      <div id="sync-tab-1" v-show="activeTab==='federation'">
        <div class="container">
          <div class="row">
            <div class="col s12">
              <div class="card">
                <div class="card-content">
                  <span class="card-title">mStream Federation</span>
                  <table>
                    <tbody>
                      <tr>
                        <td><b>Device ID:</b> {{params.deviceId}}</td>
                      </tr>
                    </tbody>
                  </table>
                  <button type="button" class="btn-flat btn-small" style="margin-top:.25rem;" @click="openFederationGenerateInviteModal()">Generate Invite Token</button>
                </div>
                <div class="card-action flow-root">
                  <a v-on:click="enableFederation()" v-bind:class="{ 'red': enabled.val }" class="btn">Disable Federation</a>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="big-container">
          <div class="row">
            <div class="col s12">
              <div class="card">
                <div class="card-content">
                  <span class="card-title">Accept Invite Token</span>
                  <div class="row">
                    <div class="col s12 m12 l6">
                      <div class="row">
                        <div class="col s12">
                          <label for="fed-invite-token">Federation Token</label>
                          <textarea id="fed-invite-token" v-model="currentToken" style="height: auto;" rows="4" cols="60" placeholder="Paste your token here"></textarea>
                        </div>
                      </div>
                      <div class="input-field" style="margin-top:.5rem;">
                        <label for="fed-invite-url">Server URL (optional)</label>
                        <input id="fed-invite-url" v-model="inviteServerUrl" type="text" placeholder="https://your-server.example.com">
                      </div>
                    </div>
                    <div class="col s12 m12 l6">
                      <form @submit.prevent="acceptInvite" v-if="parsedTokenData !== null">
                        <p>Select and name folders you want to federate:</p>
                        <div v-for="(item, key, index) in parsedTokenData.vPaths">
                          <label>
                            <input type="checkbox" checked/>
                            <span>{{key}}</span>
                          </label>
                        </div>
                        <button class="btn" type="submit" :disabled="submitPending === true">
                          {{submitPending === false ? 'Accept Invite' : 'Working ...'}}
                        </button>
                      </form>
                      <div v-else>
                        <p>Paste your token in the textbox to continue</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="sync-tab-2" v-show="activeTab==='syncthing'">
        <iframe id="syncthing-iframe" :src="syncthingUrl"></iframe>
      </div>
    </div>`,
  watch: {
    'currentToken': function(val, preVal) {
      try {
        if (!val) { 
          return this.parsedTokenData = null;
        }

        const decoded = jwt_decode(val);
        this.parsedTokenData = decoded;
      } catch(err) {
        console.log(err)
        this.parsedTokenData = null;
      }
    }
  },
  methods: {
    editName: async function() {

    },
    acceptInvite: async function() {
      try {
        const postData = {
          invite: this.currentToken,
          paths: {}
        };
    
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/federation/invite/accept`,
          data: postData
        });
      } catch (err) {
        iziToast.error({
          title: 'Failed to accept invite',
          position: 'topCenter',
          timeout: 3500
        });
      }

  //   var folderNames = {};

  //   var decoded = jwt_decode($('#federation-invitation-code').val());
  //   Object.keys(decoded.vPaths).forEach(function(key) {
  //     if($("input[type=checkbox][value="+decoded.vPaths[key]+"]").is(":checked")){
  //       folderNames[key] = $("#" + decoded.vPaths[key]).val();
  //     }
  //   });

  //   if (Object.keys(folderNames).length === 0) {
  //     iziToast.error({
  //       title: 'No directories selected',
  //       position: 'topCenter',
  //       timeout: 3500
  //     });
  //   }

    // var sendThis = {
    //   invite: $('#federation-invitation-code').val(),
    //   paths: folderNames
    // };

  //   MSTREAMAPI.acceptFederationInvite(sendThis, function(res, err){
  //     if (err !== false) {
  //       boilerplateFailure(res, err);
  //       return;
  //     }

  //     iziToast.success({
  //       title: 'Federation Successful!',
  //       position: 'topCenter',
  //       timeout: 3500
  //     });
  //   });
    },
    setSyncthingUrl: function() {
      if (this.syncthingUrl !== '') { return; }
      this.syncthingUrl = '/api/v1/syncthing-proxy/?token=' + API.token();
    },
    openFederationGenerateInviteModal: function() {
      modVM.currentViewModal = 'federation-generate-invite-modal';
      modVM.openModal();
    },
    enableFederation: function() {
      adminConfirm(`${this.enabled.val === true ? 'Disable' : 'Enable'} Federation?`, '', `${this.enabled.val === true ? 'Disable' : 'Enable'}`, async () => {
        try {
          this.enablePending = true;
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/federation/enable`,
            data: { enable: !this.enabled.val }
          });
          Vue.set(ADMINDATA.federationEnabled, 'val', !this.enabled.val);
          iziToast.success({
            title: `Syncthing ${this.enabled.val === true ? 'Enabled' : 'Disabled'}`,
            position: 'topCenter',
            timeout: 3500
          });
        } catch(err) {
          iziToast.error({
            title: 'Toggle Failed',
            position: 'topCenter',
            timeout: 3500
          });
        } finally {
          this.enablePending = false;
        }
      });
    }
  }
});

const federationView = Vue.component('federation-view', {
  data() {
    return {
      paramsTS: ADMINDATA.federationParamsUpdated,
      enabled: ADMINDATA.federationEnabled,
      enablePending: false,
    };
  },
  template: `
    <div v-if="paramsTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else-if="enabled.val === false" class="row">
      <div class="container">
        <div class="powered-by-row">
          <span class="powered-by-label">Powered By</span>
          <svg xmlns="http://www.w3.org/2000/svg" class="syncthing-logo" viewBox="0 0 429 117.3"><linearGradient id="a" gradientUnits="userSpaceOnUse" x1="58.666" y1="117.332" x2="58.666" y2="0"><stop offset="0" stop-color="#0882c8"/><stop offset="1" stop-color="#26b6db"/></linearGradient><circle fill="url(#a)" cx="58.7" cy="58.7" r="58.7"/><circle fill="none" stroke="#FFF" stroke-width="6" stroke-miterlimit="10" cx="58.7" cy="58.5" r="43.7"/><path fill="#FFF" d="M94.7 47.8c4.7 1.6 9.8-.9 11.4-5.6 1.6-4.7-.9-9.8-5.6-11.4-4.7-1.6-9.8.9-11.4 5.6-1.6 4.7.9 9.8 5.6 11.4z"/><path fill="none" stroke="#FFF" stroke-width="6" stroke-miterlimit="10" d="M97.6 39.4l-30.1 25"/><path fill="#FFF" d="M77.6 91c-.4 4.9 3.2 9.3 8.2 9.8 5 .4 9.3-3.2 9.8-8.2.4-4.9-3.2-9.3-8.2-9.8-5-.4-9.4 3.2-9.8 8.2z"/><path fill="none" stroke="#FFF" stroke-width="6" stroke-miterlimit="10" d="M86.5 91.8l-19-27.4"/><path fill="#FFF" d="M60 69.3c2.7 4.2 8.3 5.4 12.4 2.7 4.2-2.7 5.4-8.3 2.7-12.4-2.7-4.2-8.3-5.4-12.4-2.7-4.2 2.6-5.4 8.2-2.7 12.4z"/><g><path fill="#FFF" d="M21.2 61.4c-4.3-2.5-9.8-1.1-12.3 3.1-2.5 4.3-1.1 9.8 3.1 12.3 4.3 2.5 9.8 1.1 12.3-3.1s1.1-9.7-3.1-12.3z"/><path fill="none" stroke="#FFF" stroke-width="6" stroke-miterlimit="10" d="M16.6 69.1l50.9-4.7"/></g><g fill="#0891D1"><path d="M163.8 50.2c-.6-.7-6.3-4.1-11.4-4.1-3.4 0-5.2 1.2-5.2 3.5 0 2.9 3.2 3.7 8.9 5.2 8.2 2.2 13.3 5 13.3 12.9 0 9.7-7.8 13-16 13-6.2 0-13.1-2-18.2-5.3l4.3-8.6c.8.8 7.5 5 14 5 3.5 0 5.2-1.1 5.2-3.2 0-3.2-4.4-4-10.3-5.8-7.9-2.4-11.5-5.3-11.5-11.8 0-9 7.2-13.9 15.7-13.9 6.1 0 11.6 2.5 15.4 4.7l-4.2 8.4zM175 85.1c1.7.5 3.3.8 4.4.8 2 0 3.3-1.5 4.2-5.5l-11.9-31.5h9.8l7.4 23.3 6.3-23.3h8.9L192 85.5c-1.7 5.3-6.2 8.7-11.8 8.8-1.7 0-3.5-.2-5.3-.9v-8.3zM239.3 80.3h-9.6V62.6c0-4.1-1.7-5.9-4.3-5.9-2.6 0-5.8 2.3-7 5.6v18.1h-9.6V48.8h8.6v5.3c2.3-3.7 6.8-5.9 12.2-5.9 8.2 0 9.5 6.7 9.5 11.9v20.2zM261.6 48.2c7.2 0 12.3 3.4 14.8 8.3l-9.4 2.8c-1.2-1.9-3.1-3-5.5-3-4 0-7 3.2-7 8.2 0 5 3.1 8.3 7 8.3 2.4 0 4.6-1.3 5.5-3.1l9.4 2.9c-2.3 4.9-7.6 8.3-14.8 8.3-10.6 0-16.9-7.7-16.9-16.4s6.2-16.3 16.9-16.3zM302.1 78.7c-2.6 1.1-6.2 2.3-9.7 2.3-4.7 0-8.8-2.3-8.8-8.4V56.1h-4v-7.3h4v-10h9.6v10h6.4v7.3h-6.4v13.1c0 2.1 1.2 2.9 2.8 2.9 1.4 0 3-.6 4.2-1.1l1.9 7.7zM337.2 80.3h-9.6V62.6c0-4.1-1.8-5.9-4.6-5.9-2.3 0-5.5 2.2-6.7 5.6v18.1h-9.6V36.5h9.6v17.6c2.3-3.7 6.3-5.9 10.9-5.9 8.5 0 9.9 6.5 9.9 11.9v20.2zM343.4 45.2v-8.7h9.6v8.7h-9.6zm0 35.1V48.8h9.6v31.5h-9.6zM389.9 80.3h-9.6V62.6c0-4.1-1.7-5.9-4.3-5.9-2.6 0-5.8 2.3-7 5.6v18.1h-9.6V48.8h8.6v5.3c2.3-3.7 6.8-5.9 12.2-5.9 8.2 0 9.5 6.7 9.5 11.9v20.2zM395.5 64.6c0-9.2 6-16.3 14.6-16.3 4.7 0 8.4 2.2 10.6 5.8v-5.2h8.3v29.3c0 9.6-7.5 15.5-18.2 15.5-6.8 0-11.5-2.3-15-6.3l5.1-5.2c2.3 2.6 6 4.3 9.9 4.3 4.6 0 8.6-2.4 8.6-8.3v-3.1c-1.9 3.5-5.9 5.3-10 5.3-8.3.1-13.9-7.1-13.9-15.8zm23.9 3.9v-6.6c-1.3-3.3-4.2-5.5-7.1-5.5-4.1 0-7 4-7 8.4 0 4.6 3.2 8 7.5 8 2.9 0 5.3-1.8 6.6-4.3z"/></g></svg>
        </div>
        <a v-on:click="enableFederation()" class="btn-large">Enable Federation</a>
      </div>
    </div>
    <federation-main-panel v-else>
    </federation-main-panel>`,
  methods: {
    enableFederation: async function() {
      try {
        this.enablePending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/federation/enable`,
          data: {
            enable: !this.enabled.val,
          }
        });

        // update frontend data
        Vue.set(ADMINDATA.federationEnabled, 'val', !this.enabled.val);
  
        iziToast.success({
          title: `Syncthing ${this.enabled.val === true ? 'Enabled' : 'Disabled'}`,
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Toggle Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.enablePending = false;
      }
    }
  }
});

const logsView = Vue.component('logs-view', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      paramsTS: ADMINDATA.serverParamsUpdated
    };
  },
  template: `
    <div v-if="paramsTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Logging</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>Write Logs:</b> {{params.writeLogs === true ? 'Enabled' : 'Disabled'}}</td>
                      <td>
                        <a v-on:click="toggleWriteLogs" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>Logs Directory:</b> {{params.storage.logsDirectory}}</td>
                      <td style="color:var(--t2);font-size:.82rem">Edit in config file</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="card-action">
                <a v-on:click="downloadLogs()" class="btn">Download Log File</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    downloadLogs: async function() {
      try {
        const response = await API.axios({
          url: `${API.url()}/api/v1/admin/logs/download`, //your url
          method: 'GET',
          responseType: 'blob', // important
        });

        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', 'mstream-logs.zip'); //or any other extension
        document.body.appendChild(link);
        link.click();
      } catch (err) {
        console.log(err)
        iziToast.error({
          title: 'Download Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    toggleWriteLogs: function() {
            adminConfirm(`<b>${this.params.writeLogs === true ? 'Disable' : 'Enable'} Writing Logs To Disk?</b>`, '', `${this.params.writeLogs === true ? 'Disable' : 'Enable'}`, () => {
        API.axios({
                      method: 'POST',
                      url: `${API.url()}/api/v1/admin/config/write-logs`,
                      data: { writeLogs: !this.params.writeLogs }
                    }).then(() => {
                      // update frontend data
                      Vue.set(ADMINDATA.serverParams, 'writeLogs', !this.params.writeLogs);

                      iziToast.success({
                        title: 'Updated Successfully',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }).catch(() => {
                      iziToast.error({
                        title: 'Failed',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    });
      });
    },
  }
});

const lockView = Vue.component('lock-view', {
  data() {
    return {};
  },
  template: `
    <div class="container">
      <div class="card">
        <div class="card-content">
          <span class="card-title">Lock Admin Panel</span>
          <p style="color:var(--t2);">Disabling the admin panel will prevent anyone from making configuration changes through this interface.</p>
          <p style="color:var(--t2);">To re-enable it you will need to:</p>
          <ul style="color:var(--t2);padding-left:1.25rem;margin:.25rem 0 1rem;line-height:1.9;">
            <li>Open the mStream config file</li>
            <li>Set <code style="color:var(--accent);background:var(--raised);padding:.1rem .35rem;border-radius:4px;">lockAdmin</code> to <code style="color:var(--accent);background:var(--raised);padding:.1rem .35rem;border-radius:4px;">false</code></li>
            <li>Reboot mStream</li>
          </ul>
        </div>
        <div class="card-action">
          <button class="btn red" type="button" @click="disableAdmin()">Disable Admin Panel</button>
        </div>
      </div>
    </div>`,

    methods: {
      disableAdmin: function() {
                adminConfirm('<b>Disable Admin Panel?</b>', '', 'Disable', () => {
          API.axios({
                          method: 'POST',
                          url: `${API.url()}/api/v1/admin/lock-api`,
                          data: { lock: true }
                        }).then(() => {
                          window.location.reload();
                        }).catch(() => {
                          iziToast.error({
                            title: 'Failed to disable admin panel',
                            position: 'topCenter',
                            timeout: 3500
                          });
                        });
        });
      }
    }
});

const lyricsView = Vue.component('lyrics-view', {
  data() {
    return {
      enabled: true,
      pending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Synced Lyrics</span>
              <p style="margin-bottom:0.5rem;">
                When enabled, the visualizer&#x2019;s <b>Lyrics mode</b> fetches time-synced LRC lyrics from
                <a href="https://lrclib.net" target="_blank" rel="noopener">lrclib.net</a> and displays them in sync with playback.
                Lyrics are cached locally after the first fetch so repeated plays work offline.
              </p>
              <p style="margin-bottom:1rem;font-size:0.85rem;color:#999;">Disable this if the server has no internet access, to avoid timeout delays when the player opens the Lyrics view.</p>
              <table>
                <tbody>
                  <tr>
                    <td style="width:140px"><b>Enable</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> Fetch synced lyrics from lrclib.net</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? &#x27;Saving...&#x27; : &#x27;Save&#x27; }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/lyrics/config` });
      this.enabled = res.data.enabled !== false;
    } catch(e) { /* ignore */ }
  },
  methods: {
    save: async function() {
      this.pending = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/lyrics/config`,
          data: { enabled: this.enabled }
        });
        iziToast.success({ title: 'Lyrics settings saved', position: 'topCenter', timeout: 3000 });
      } catch(err) {
        iziToast.error({ title: 'Failed to save Lyrics settings', position: 'topCenter', timeout: 3000 });
      } finally {
        this.pending = false;
      }
    }
  }
});

const lastFMView = Vue.component('lastfm-view', {
  data() {
    return {
      enabled: true,
      apiKey: '',
      apiSecret: '',
      pending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Last.fm</span>
              <p style="margin-bottom:0.5rem;">
                When enabled, users can link their Last.fm account to scrobble every track they play.
                mStream ships with built-in API credentials — you can optionally override them with
                <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener">your own key &amp; shared secret</a>.
              </p>
              <p style="margin-bottom:1rem;font-size:0.85rem;color:#999;">The shared secret is stored server-side only and is never sent to clients.</p>
              <table>
                <tbody>
                  <tr>
                    <td style="width:140px"><b>Enable</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> Enable Last.fm scrobbling for users</td>
                  </tr>
                  <tr>
                    <td><b>API Key</b></td>
                    <td><input v-model="apiKey" type="text" placeholder="Leave blank to use built-in key" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore spellcheck="false" style="margin:0" /></td>
                  </tr>
                  <tr>
                    <td><b>Shared Secret</b></td>
                    <td><input v-model="apiSecret" type="password" placeholder="Leave blank to use built-in secret" autocomplete="new-password" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore style="margin:0" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? 'Saving...' : 'Save' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/lastfm/config` });
      this.enabled   = res.data.enabled !== false;
      this.apiKey    = res.data.apiKey    || '';
      this.apiSecret = res.data.apiSecret || '';
    } catch(e) { /* ignore */ }
  },
  methods: {
    save: async function() {
      this.pending = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/lastfm/config`,
          data: { enabled: this.enabled, apiKey: this.apiKey.trim(), apiSecret: this.apiSecret.trim() }
        });
        iziToast.success({ title: 'Last.fm settings saved', position: 'topCenter', timeout: 3000 });
      } catch(err) {
        iziToast.error({ title: 'Failed to save Last.fm settings', position: 'topCenter', timeout: 3000 });
      } finally {
        this.pending = false;
      }
    }
  }
});

const listenBrainzView = Vue.component('listenbrainz-view', {
  data() {
    return { enabled: false, pending: false };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">ListenBrainz</span>
              <p style="margin-bottom:1rem;">
                When enabled, users can enter their own ListenBrainz user token to scrobble every track they play.
                Get a token at <a href="https://listenbrainz.org/profile/" target="_blank" rel="noopener">listenbrainz.org/profile</a>.
              </p>
              <table><tbody>
                <tr>
                  <td style="width:140px"><b>Enable</b></td>
                  <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> Enable ListenBrainz scrobbling for users</td>
                </tr>
              </tbody></table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? 'Saving...' : 'Save' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/listenbrainz/config` });
      this.enabled = res.data.enabled === true;
    } catch(e) { /* ignore */ }
  },
  methods: {
    save: async function() {
      this.pending = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/listenbrainz/config`, data: { enabled: this.enabled } });
        iziToast.success({ title: 'ListenBrainz settings saved', position: 'topCenter', timeout: 3000 });
      } catch(err) {
        iziToast.error({ title: 'Failed to save ListenBrainz settings', position: 'topCenter', timeout: 3000 });
      } finally { this.pending = false; }
    }
  }
});

const discogsView = Vue.component('discogs-view', {
  data() {
    return {
      enabled: false,
      allowArtUpdate: false,
      apiKey: '',
      apiSecret: '',
      userAgentTag: '',
      pending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Discogs Cover Art</span>
              <p style="margin-bottom:0.5rem;">
                When a song is missing album art &#8212; or has art that looks wrong &#8212; the Now Playing modal
                shows a <b>"Fix Art"</b> button. Clicking it searches the
                <a href="https://www.discogs.com/developers/" target="_blank" rel="noopener">Discogs API</a>
                and presents up to <b>8 front-cover proposals</b> to choose from.
                Selecting one permanently embeds the image into the audio file (mp3, flac, ogg, m4a&hellip;),
                so every client sees the correct art from that point on.
                This picker is only visible to admins.
              </p>
              <p style="margin-bottom:0.5rem;">
                <b>API key &amp; secret are optional.</b>
                Without them, Discogs allows <b>25 unauthenticated requests per minute</b> — enough for casual use.
                With your own key + secret (free, register at <a href="https://www.discogs.com/settings/developers" target="_blank" rel="noopener">discogs.com/settings/developers</a>)
                the limit rises to <b>60 requests per minute</b>.
                Each cover art search uses up to ~10 requests, so you may hit the unauthenticated limit quickly if you search often.
              </p>
              <p style="margin-bottom:1rem; font-size:0.85rem; color:#999;">
                The key and secret are stored server-side only and are never exposed to non-admin users.
              </p>
              <table>
                <tbody>
                  <tr>
                    <td style="width:160px"><b>Enable</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> Enable Discogs cover art</td>
                  </tr>
                  <tr>
                    <td><b>Allow Art Update</b></td>
                    <td>
                      <input type="checkbox" v-model="allowArtUpdate" style="margin:0;width:auto;height:auto;" /> Allow replacing existing album art
                      <div style="font-size:0.78rem;color:#999;margin-top:4px;">When enabled, the Fix Art button also appears on songs that <i>already have</i> album art, letting you update it. The old art is removed from the cache and database once no other song references it.</div>
                    </td>
                  </tr>
                  <tr>
                    <td><b>API Key</b></td>
                    <td><input v-model="apiKey" type="text" placeholder="Consumer Key" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore spellcheck="false" style="margin:0" /></td>
                  </tr>
                  <tr>
                    <td><b>API Secret</b></td>
                    <td><input v-model="apiSecret" type="password" placeholder="Consumer Secret" autocomplete="new-password" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore style="margin:0" /></td>
                  </tr>
                  <tr>
                    <td><b>Instance Tag</b></td>
                    <td>
                      <input v-model="userAgentTag" type="text" maxlength="4" placeholder="e.g. amr" autocomplete="off" spellcheck="false" style="margin:0;width:80px;text-transform:lowercase" />
                      <div style="font-size:0.78rem;color:#999;margin-top:4px;">Optional. Up to 4 letters/digits. Your tag is appended to the User-Agent sent to Discogs: <code>mStreamVelvet/dev/{{ userAgentTag || 'tag' }} +…</code></div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? 'Saving...' : 'Save' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/discogs/config` });
      this.enabled        = !!res.data.enabled;
      this.allowArtUpdate = !!res.data.allowArtUpdate;
      this.apiKey         = res.data.apiKey       || '';
      this.apiSecret      = res.data.apiSecret    || '';
      this.userAgentTag   = res.data.userAgentTag || '';
    } catch(e) { /* ignore */ }
  },
  methods: {
    save: async function() {
      this.pending = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/discogs/config`,
          data: { enabled: this.enabled, allowArtUpdate: this.allowArtUpdate, apiKey: this.apiKey.trim(), apiSecret: this.apiSecret.trim(), userAgentTag: this.userAgentTag.trim().slice(0,4).replace(/[^a-zA-Z0-9]/g,'') }
        });
        iziToast.success({ title: 'Discogs settings saved', position: 'topCenter', timeout: 3000 });
      } catch(err) {
        iziToast.error({ title: 'Failed to save Discogs settings', position: 'topCenter', timeout: 3000 });
      } finally {
        this.pending = false;
      }
    }
  }
});

const radioView = Vue.component('radio-view', {
  data() {
    return {
      enabled: false,
      maxRecordingMinutes: ADMINDATA.dbParams.maxRecordingMinutes || 180,
      pending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Radio Streams</span>
              <p style="margin-bottom:0.5rem;">
                When enabled, users see a <b>Radio Streams</b> section under Library in the player.
                Each user manages their own personal list of internet radio channels — channels are <em>not</em> shared between users.
              </p>
              <p style="margin-bottom:1rem;font-size:0.85rem;color:#999;">
                Only direct HTTP/HTTPS audio stream URLs are supported.
                M3U/M3U8 playlist URLs are intentionally not accepted.
                Each channel can have up to 3 fallback stream links.
              </p>
              <table>
                <tbody>
                  <tr>
                    <td style="width:140px"><b>Enable</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> Allow users to add and play internet radio stations</td>
                  </tr>
                  <tr v-if="enabled">
                    <td><b>Max Recording Duration</b></td>
                    <td>
                      <input type="number" v-model.number="maxRecordingMinutes" min="1" step="1" style="width:80px;display:inline-block;margin:0 6px 0 0;" />
                      minutes — recordings are auto-stopped after this limit
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? 'Saving...' : 'Save' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/radio/config` });
      this.enabled = res.data.enabled === true;
    } catch(e) { /* ignore */ }
  },
  methods: {
    save: async function() {
      this.pending = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/radio/config`,
          data: { enabled: this.enabled }
        });
        if (this.enabled) {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/db/params/max-recording-minutes`,
            data: { maxRecordingMinutes: this.maxRecordingMinutes }
          });
          Vue.set(ADMINDATA.dbParams, 'maxRecordingMinutes', this.maxRecordingMinutes);
        }
        iziToast.success({ title: 'Radio settings saved', position: 'topCenter', timeout: 3000 });
      } catch(err) {
        iziToast.error({ title: 'Failed to save Radio settings', position: 'topCenter', timeout: 3000 });
      } finally {
        this.pending = false;
      }
    }
  }
});

// ── Genre Groups Admin View ────────────────────────────────────────────────
const genreGroupsView = Vue.component('genre-groups-view', {
  data() {
    return {
      groups: [],        // [{name, genres:[str], collapsed:false}, ...]
      allGenres: [],     // all genre strings from library
      isDefault: false,  // true = showing auto-defaults (nothing saved yet)
      pending: false,
      dragSrc: null,     // {groupIdx, genreIdx} — groupIdx=-2 means search results
      dropTargetIdx: null,
      newGroupName: '',
      renamingIdx: null,
      renamingVal: '',
      searchQuery: '',
    };
  },
  computed: {
    otherGroupIdx() {
      return this.groups.findIndex(g => g.name.toLowerCase() === 'other');
    },
    searchResults() {
      const raw = this.searchQuery.trim();
      if (!raw) return [];
      // Parse tokens: -word = exclude, +word or bare word = must include
      const must = [], exclude = [];
      for (const token of raw.toLowerCase().split(/\s+/)) {
        if (!token) continue;
        if (token.startsWith('-') && token.length > 1) exclude.push(token.slice(1));
        else if (token.startsWith('+') && token.length > 1) must.push(token.slice(1));
        else must.push(token);
      }
      if (!must.length && !exclude.length) return [];
      // Build full genre universe
      const allGenreSet = new Set(this.allGenres);
      for (const grp of this.groups) for (const g of grp.genres) allGenreSet.add(g);
      return [...allGenreSet].filter(g => {
        const gl = g.toLowerCase();
        return must.every(t => gl.includes(t)) && !exclude.some(t => gl.includes(t));
      }).sort();
    },
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">Groups &amp; Genres</span>
              <p style="margin-bottom:.5rem;">Organise genres into top-level groups for the <b>Genres</b> view and <b>Smart Playlists</b>.<br><small style="color:var(--t2)">Double-click a group name to rename it. Drag a genre chip from the right panel and drop it onto a group name on the left. Groups cannot be deleted — move unwanted genres to <em>Other</em>.</small></p>
              <div v-if="isDefault" style="background:var(--raised);border-left:3px solid var(--accent,#6366f1);padding:10px 14px;border-radius:4px;margin-top:10px;font-size:.875rem;color:var(--t2);">Auto-detected defaults based on your music library. Edit and <b style="color:var(--t1)">Save</b> to store your custom grouping.</div>
            </div>
          </div>
        </div>
      </div>

      <div class="gg-layout">
        <!-- LEFT: group names as drop targets -->
        <div class="gg-left">
          <div v-for="(grp, gi) in groups" :key="gi"
               class="gg-left-item"
               :class="{'gg-left-active': dropTargetIdx === gi}"
               @dragover.prevent="dropTargetIdx = gi"
               @dragleave="onDragleave($event, gi)"
               @drop.prevent="onDropToGroup(gi)">
            <span class="gg-chevron-sm" @click="toggleCollapse(gi)" :title="grp.collapsed ? 'Expand' : 'Collapse'">{{grp.collapsed ? '▶' : '▼'}}</span>
            <span v-if="renamingIdx !== gi" class="gg-left-name" @dblclick="startRename(gi)" title="Double-click to rename">{{grp.name}}</span>
            <input v-else v-model="renamingVal" class="gg-rename-inp gg-left-rename" @blur="commitRename(gi)" @keydown.enter="commitRename(gi)" @keydown.esc="renamingIdx=null" ref="renameInput">
            <span class="gg-left-cnt">{{grp.genres.length}}</span>
            <button v-if="grp.genres.length === 0" class="gg-del-btn" @click.stop="deleteGroup(gi)" title="Delete empty group">&#x2715;</button>
          </div>
          <div class="gg-add-row">
            <input v-model="newGroupName" type="text" placeholder="New group…" class="gg-add-inp" @keydown.enter="addGroup">
            <button class="btn btn-small" @click="addGroup" :disabled="!newGroupName.trim()">+</button>
          </div>
        </div>

        <!-- RIGHT: search + collapsible genre sections -->
        <div class="gg-right">
          <!-- Search bar -->
          <div class="gg-search-row">
            <span class="gg-search-icon">&#128269;</span>
            <input v-model="searchQuery" type="text" placeholder="e.g. house  ·  deep house  ·  house -acid  ·  house +deep" class="gg-search-inp" @keydown.esc="searchQuery=''">
            <button v-if="searchQuery" class="gg-search-clear" @click="searchQuery=''" title="Clear">&#x2715;</button>
          </div>

          <!-- Search results panel -->
          <div v-if="searchQuery.trim()" class="gg-search-panel">
            <div class="gg-search-panel-head">Results for <b>"{{searchQuery.trim()}}"</b> <span style="color:var(--t3);font-weight:400;">· +word = must include &nbsp; -word = exclude</span> — drag a chip to a group on the left</div>
            <div class="gg-chips" style="padding:10px 14px;">
              <span v-if="searchResults.length === 0" class="gg-empty-hint">No genres match</span>
              <span v-for="(g, si) in searchResults" :key="g"
                    class="gg-chip gg-chip-search"
                    :class="{dragging: dragSrc && dragSrc.groupIdx===-2 && dragSrc.genreIdx===si}"
                    draggable="true"
                    @dragstart="onDragStartSearch(si)"
                    @dragend="dragSrc=null">
                {{g}}
                <span class="gg-chip-group-hint">{{groupOf(g)}}</span>
              </span>
            </div>
          </div>
          <div v-for="(grp, gi) in groups" :key="gi" class="gg-group">
            <div class="gg-group-head"
                 :class="{'gg-drop-over': dropTargetIdx === gi}"
                 @dragover.prevent="dropTargetIdx = gi"
                 @dragleave="onDragleave($event, gi)"
                 @drop.prevent="onDropToGroup(gi)">
              <span class="gg-chevron" @click="toggleCollapse(gi)" style="cursor:pointer;margin-right:6px;">{{grp.collapsed ? '▶' : '▼'}}</span>
              <span v-if="renamingIdx !== gi" style="flex:1;cursor:text;font-weight:700;" @dblclick="startRename(gi)">{{grp.name}}</span>
              <input v-else v-model="renamingVal" class="gg-rename-inp" style="flex:1;" @blur="commitRename(gi)" @keydown.enter="commitRename(gi)" @keydown.esc="renamingIdx=null">
              <small style="color:var(--t2);">{{grp.genres.length}}</small>
            </div>
            <div v-show="!grp.collapsed" class="gg-chips"
                 :class="{'gg-drop-over': dropTargetIdx === gi}"
                 @dragover.prevent="dropTargetIdx = gi"
                 @dragleave="onDragleave($event, gi)"
                 @drop.prevent="onDropToGroup(gi)">
              <span v-for="(g, gei) in grp.genres" :key="g"
                    class="gg-chip"
                    :class="{dragging: dragSrc && dragSrc.groupIdx===gi && dragSrc.genreIdx===gei}"
                    draggable="true"
                    @dragstart="onDragStart(gi, gei)"
                    @dragend="dragSrc=null">
                {{g}}<span v-if="gi !== otherGroupIdx && otherGroupIdx !== -1" class="gg-chip-remove" @click.stop="moveToOther(gi, gei)" title="Move to Other">↓</span>
              </span>
              <span v-if="grp.genres.length === 0" class="gg-empty-hint">Drop genres here</span>
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button class="btn-flat" @click="resetToDefault">Reset to Auto</button>
            <button class="btn" @click="save" :disabled="pending">{{ pending ? 'Saving…' : 'Save' }}</button>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    await this.load();
  },
  watch: {
    renamingIdx(v) {
      if (v !== null) this.$nextTick(() => { const el = this.$refs.renameInput; if (el) { const arr = Array.isArray(el) ? el[0] : el; arr && arr.focus && arr.focus(); } });
    }
  },
  methods: {
    async load() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/genre-groups` });
        this.allGenres = res.data.allGenres || [];
        this.isDefault = !!res.data.isDefault;
        this.groups = (res.data.groups || []).map(g => ({ name: g.name, genres: [...g.genres], collapsed: false }));
        // If nothing is in the DB yet, seed it now so it persists immediately
        if (this.isDefault) await this._autoSave();
      } catch(e) { iziToast.error({ title: 'Failed to load genre groups', position: 'topCenter', timeout: 3000 }); }
    },
    toggleCollapse(gi) {
      this.groups[gi].collapsed = !this.groups[gi].collapsed;
      // collapse state is UI-only, no need to persist
    },
    async addGroup() {
      const name = this.newGroupName.trim();
      if (!name) return;
      this.groups.push({ name, genres: [], collapsed: false });
      this.newGroupName = '';
      await this._autoSave();
    },
    async deleteGroup(gi) {
      if (this.groups[gi].genres.length > 0) return;
      this.groups.splice(gi, 1);
      await this._autoSave();
    },
    async moveToOther(gi, gei) {
      const [g] = this.groups[gi].genres.splice(gei, 1);
      const oi = this.otherGroupIdx;
      if (oi !== -1) {
        this.groups[oi].genres.push(g);
      } else {
        this.groups.push({ name: 'Other', genres: [g], collapsed: false });
      }
      await this._autoSave();
    },
    startRename(gi) { this.renamingIdx = gi; this.renamingVal = this.groups[gi].name; },
    async commitRename(gi) {
      if (this.renamingVal.trim()) this.groups[gi].name = this.renamingVal.trim();
      this.renamingIdx = null;
      await this._autoSave();
    },
    // ── Drag-and-drop ────────────────────────────────────────────
    onDragStart(groupIdx, genreIdx) { this.dragSrc = { groupIdx, genreIdx }; this.dropTargetIdx = null; },
    onDragStartSearch(si) { this.dragSrc = { groupIdx: -2, genreIdx: si }; this.dropTargetIdx = null; },
    groupOf(genre) {
      const grp = this.groups.find(g => g.genres.includes(genre));
      return grp ? grp.name : 'unassigned';
    },
    onDragleave(e, gi) {
      if (!e.currentTarget.contains(e.relatedTarget)) {
        if (this.dropTargetIdx === gi) this.dropTargetIdx = null;
      }
    },
    async onDropToGroup(destGi) {
      const src = this.dragSrc;
      this.dragSrc = null;
      this.dropTargetIdx = null;
      if (!src) return;
      let genre;
      if (src.groupIdx === -2) {
        // Drag from search results — find genre by value and remove from its current group
        genre = this.searchResults[src.genreIdx];
        if (!genre) return;
        for (const grp of this.groups) {
          const idx = grp.genres.indexOf(genre);
          if (idx !== -1) { grp.genres.splice(idx, 1); break; }
        }
      } else {
        if (src.groupIdx === destGi) return;
        genre = this.groups[src.groupIdx].genres.splice(src.genreIdx, 1)[0];
      }
      if (!genre) return;
      this.groups[destGi].genres.push(genre);
      await this._autoSave();
    },
    // ── Auto-save (silent, called after every mutation) ──────────
    async _autoSave() {
      try {
        const payload = this.groups.map(g => ({ name: g.name, genres: g.genres }));
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/genre-groups`, data: payload });
        this.isDefault = false;
      } catch(e) { iziToast.error({ title: 'Auto-save failed', position: 'topCenter', timeout: 3000 }); }
    },
    resetToDefault() {
      adminConfirm('Reset genre groups?', 'All custom groups will be removed. The player will fall back to automatic genre classification.', 'Reset', async () => {
        try {
          await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/genre-groups`, data: [] });
          await this.load();
          iziToast.success({ title: 'Genre groups reset', position: 'topCenter', timeout: 2500 });
        } catch(e) { iziToast.error({ title: 'Reset failed', position: 'topCenter', timeout: 3000 }); }
      });
    },
    async save() {
      this.pending = true;
      try {
        // Save all groups (including empty ones) so renamed group names are preserved
        const payload = this.groups.map(g => ({ name: g.name, genres: g.genres }));
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/genre-groups`, data: payload });
        this.isDefault = false;
        iziToast.success({ title: 'Genre groups saved', position: 'topCenter', timeout: 2500 });
      } catch(e) { iziToast.error({ title: 'Save failed', position: 'topCenter', timeout: 3000 }); }
      finally { this.pending = false; }
    }
  }
});

const vm = new Vue({
  el: '#content',
  components: {
    'folders-view': foldersView,
    'users-view': usersView,
    'db-view': dbView,
    'backup-view': backupView,
    'advanced-view': advancedView,
    'info-view': infoView,
    'transcode-view': transcodeView,
    'server-audio-view': serverAudioView,
    'federation-view': federationView,
    'logs-view': logsView,
    'rpn-view': rpnView,
    'lock-view': lockView,
    'scan-errors-view': scanErrorsView,
    'wrapped-admin-view': wrappedAdminView,
    'lastfm-view': lastFMView,
    'listenbrainz-view': listenBrainzView,
    'discogs-view': discogsView,
    'lyrics-view': lyricsView,
    'radio-view': radioView,
    'genre-groups-view': genreGroupsView,
  },
  data: {
    currentViewMain: 'folders-view',
    componentKey: false
  }
});

function changeView(viewName, el){
  if (vm.currentViewMain === viewName) { return; }

  document.getElementById('content').scrollTop = 0;
  vm.currentViewMain = viewName;

  const elements = document.querySelectorAll('.side-nav-item'); // or:
  elements.forEach(elm => {
    elm.classList.remove("select")
  });

  el.classList.add("select");

  // close nav on mobile
  closeSideMenu();
}

const fileExplorerModal = Vue.component('file-explorer-modal', {
  data() {
    return {
      componentKey: false, // Flip this value to force re-render,
      pending: false,
      currentDirectory: null,
      winDrives: ADMINDATA.winDrives,
      contents: []
    };
  },
  template: `
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:1rem 1.5rem .75rem;border-bottom:1px solid var(--border);">
        <h5 style="margin:0;">Browse Directories</h5>
        <button class="modal-close-x" type="button" title="Close" @click="closeModal">&times;</button>
      </div>

      <div style="padding:.65rem 1.5rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
        <button class="btn-flat btn-small" type="button" @click="goToDirectory(currentDirectory, '..')" title="Go up one level">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          Up
        </button>
        <button class="btn-flat btn-small" type="button" @click="goToDirectory('~')" title="Home directory">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          Home
        </button>
        <button class="btn-flat btn-small" type="button" @click="goToDirectory(currentDirectory)" title="Reload">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Refresh
        </button>
        <div style="margin-left:auto;display:flex;align-items:center;gap:.5rem;">
          <select @change="goToDirectory($event.target.value)" v-if="winDrives.length > 0" style="width:auto;padding:.25rem .4rem;font-size:.82rem;background:var(--raised);color:var(--t1);border:1px solid var(--border);border-radius:6px;">
            <option v-for="(value) in winDrives" :selected="currentDirectory && currentDirectory.startsWith(value)" :value="value">{{ value }}</option>
          </select>
          <button class="btn btn-small" type="button" @click="selectDirectory(currentDirectory)" :disabled="currentDirectory === null">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Select Current
          </button>
        </div>
      </div>

      <div v-if="currentDirectory !== null" style="padding:.4rem 1.5rem;background:var(--card);border-bottom:1px solid var(--border);">
        <code style="font-size:.8rem;color:var(--accent);word-break:break-all;">{{ currentDirectory }}</code>
      </div>

      <div v-if="currentDirectory === null || pending === true" style="display:flex;justify-content:center;padding:2rem;">
        <svg class="spinner" width="40" height="40" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>
      <div v-else style="max-height:50vh;overflow-y:auto;">
        <div v-if="contents.length === 0" style="padding:1.25rem 1.5rem;color:var(--t3);text-align:center;">No subdirectories</div>
        <ul class="collection" style="margin:0;border-radius:0;border-left:none;border-right:none;" v-else>
          <li
            v-for="dir in contents"
            class="collection-item"
            @click="goToDirectory(currentDirectory, dir.name)"
            style="display:flex;align-items:center;gap:.75rem;padding:.5rem 1.25rem;cursor:pointer;">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" height="20" style="flex-shrink:0;"><path fill="#FFA000" d="M38 12H22l-4-4H8c-2.2 0-4 1.8-4 4v24c0 2.2 1.8 4 4 4h31c1.7 0 3-1.3 3-3V16c0-2.2-1.8-4-4-4z"/><path fill="#FFCA28" d="M42.2 18H15.3c-1.9 0-3.6 1.4-3.9 3.3L8 40h31.7c1.9 0 3.6-1.4 3.9-3.3l2.5-14c.5-2.4-1.4-4.7-3.9-4.7z"/></svg>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ dir.name }}</span>
            <button class="btn-small" type="button" @click.stop="selectDirectory(currentDirectory, dir.name)">Select</button>
          </li>
        </ul>
      </div>
    </div>`,
  created: async function () {
    this.goToDirectory('~');
  },
  methods: {
    goToDirectory: async function (dir, joinDir) {
      if (this.pending) { return; }
      this.pending = true;
      try {
        const params = { directory: dir };
        if (joinDir) { params.joinDirectory = joinDir; }
  
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/file-explorer`,
          data: params
        });
  
        this.currentDirectory = res.data.path
  
        while (this.contents.length > 0) {
          this.contents.pop();
        }
  
        res.data.directories.forEach(d => {
          this.contents.push(d);
        });

        this.$nextTick(() => {
          // scroll modal back to top after navigation
          const dlg = document.querySelector('.modal-dialog');
          if (dlg) dlg.scrollTop = 0;
        });
      } catch(err) {
        iziToast.error({
          title: 'Failed to get directory contents',
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.pending = false;
      }
    },
    closeModal: function () {
      modVM.closeModal();
    },
    selectDirectory: async function (dir, joinDir) {
      try {
        let selectThis = dir;

        if (joinDir) {
          const res = await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/file-explorer`,
            data: { directory: dir, joinDirectory: joinDir }
          });  
  
          selectThis = res.data.path
        }
  
        Vue.set(ADMINDATA.sharedSelect, 'value', selectThis);
  
        // close the modal
        modVM.closeModal();
      }catch(err) {
        iziToast.error({
          title: 'Cannot Select Directory',
          position: 'topCenter',
          timeout: 3500
        });
      }
    }
  }
});

const userPasswordView = Vue.component('user-password-view', {
  data() {
    return {
      users: ADMINDATA.users,
      currentUser: ADMINDATA.selectedUser,
      resetPassword: '',
      showResetPassword: false,
      subsonicPassword: '',
      showSubsonicPassword: false,
      submitPending: false
    };
  }, 
  template: `
    <form @submit.prevent="updatePassword">
      ${mHead('Reset Password', '{{"User: " + currentUser.value}}')}
      <div class="modal-body">
        <div class="field-group">
          <label for="reset-password">New mStream Password</label>
          <div class="pwd-wrap">
            <input v-model="resetPassword" id="reset-password" :type="showResetPassword ? 'text' : 'password'" placeholder="Leave blank to keep unchanged" autocomplete="new-password">
            <button type="button" class="pwd-toggle" @click="showResetPassword = !showResetPassword" tabindex="-1" :title="showResetPassword ? 'Hide' : 'Show'">
              <svg v-if="!showResetPassword" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
          </div>
        </div>
        <div class="field-group" style="margin-top:1rem;">
          <label for="subsonic-password">Subsonic API Password</label>
          <div style="font-size:.78rem;color:var(--t2);margin-bottom:.35rem;">Used by Subsonic-compatible apps (Ultrasonic, DSub, Symfonium, etc.). Must be stored in plain text for MD5 token auth.</div>
          <div class="pwd-wrap">
            <input v-model="subsonicPassword" id="subsonic-password" :type="showSubsonicPassword ? 'text' : 'password'" placeholder="Leave blank to keep unchanged" autocomplete="new-password">
            <button type="button" class="pwd-toggle" @click="showSubsonicPassword = !showSubsonicPassword" tabindex="-1" :title="showSubsonicPassword ? 'Hide' : 'Show'">
              <svg v-if="!showSubsonicPassword" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
          </div>
        </div>
      </div>
      ${mFoot('Update Password', 'Updating')}
    </form>`,
  methods: {
    updatePassword: async function() {
      try {
        this.submitPending = true;

        if (!this.resetPassword && !this.subsonicPassword) {
          iziToast.warning({
            title: 'Nothing to update',
            message: 'Enter a new mStream password, Subsonic password, or both.',
            position: 'topCenter',
            timeout: 3500
          });
          this.submitPending = false;
          return;
        }

        if (this.resetPassword) {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/password`,
            data: {
              username: this.currentUser.value,
              password: this.resetPassword
            }
          });
        }

        if (this.subsonicPassword) {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/subsonic-password`,
            data: {
              username: this.currentUser.value,
              password: this.subsonicPassword
            }
          });
        }
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: 'Password Updated',
          position: 'topCenter',
          timeout: 3500
        });
      }catch(err) {
        iziToast.error({
          title: 'Password Reset Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const usersVpathsView = Vue.component('user-vpaths-view', {
  data() {
    return {
      users: ADMINDATA.users,
      directories: ADMINDATA.folders,
      currentUser: ADMINDATA.selectedUser,
      selectedDirs: [],
      submitPending: false,
      selectInstance: null
    };
  },
  template: `
    <form @submit.prevent="updateFolders">
      ${mHead('Folder Access', '{{"User: " + currentUser.value}}')}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-user-dirs">Accessible Folders</label>
          <select id="edit-user-dirs" :disabled="Object.keys(directories).length === 0" multiple :size="Math.max(2, Object.keys(directories).length)" v-model="selectedDirs">
            <option disabled v-if="Object.keys(directories).length === 0">No directories available</option>
            <option v-for="(val, key) in directories" :key="key" :value="key">{{ key }}</option>
          </select>
          <span class="field-hint">Hold Ctrl / Cmd to select multiple folders.</span>
        </div>
      </div>
      ${mFoot('Save', 'Saving')}
    </form>`,
    mounted: function () {
      if (this.currentUser.value && this.users[this.currentUser.value]) {
        this.selectedDirs = (this.users[this.currentUser.value].vpaths || []).slice();
      }
    },
    beforeDestroy: function() {
    },
    methods: {
      updateFolders: async function() {
        try {
          this.submitPending = true;

          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/vpaths`,
            data: {
              username: this.currentUser.value,
              vpaths: this.selectedDirs
            }
          });

          // update frontend data
          Vue.set(ADMINDATA.users[this.currentUser.value], 'vpaths', this.selectedDirs.slice());
    
          // close & reset the modal
          modVM.closeModal();
  
          iziToast.success({
            title: 'User Permissions Updated',
            position: 'topCenter',
            timeout: 3500
          });
        } catch(err) {
          iziToast.error({
            title: 'Failed to Update Folders',
            position: 'topCenter',
            timeout: 3500
          });
        }finally {
          this.submitPending = false;
        }
      }
    }
});

const userAccessView = Vue.component('user-access-view', {
  data() {
    return {
      users: ADMINDATA.users,
      currentUser: ADMINDATA.selectedUser,
      submitPending: false,
      isAdmin: ADMINDATA.users[ADMINDATA.selectedUser.value].admin
    };
  },
  template: `
    <form @submit.prevent="updateUser">
      ${mHead('User Access', '{{"User: " + currentUser.value}}')}
      <div class="modal-body">
        <div style="display:flex;align-items:center;gap:.6rem;">
          <input id="user-admin-cb" type="checkbox" v-model="isAdmin" style="width:auto;margin:0;">
          <label for="user-admin-cb" style="font-size:.95rem;color:var(--t1);">Grant admin access</label>
        </div>
        <p class="field-hint" style="color:var(--red);" v-if="!isAdmin">Warning: removing the last admin account will lock you out of this panel.</p>
      </div>
      ${mFoot('Save', 'Saving')}
    </form>`,
    methods: {
      updateUser: async function() {
        try {

          // TODO: Warn user if they are removing admin status from the last admin user
            // They will lose all access to the admin panel

          this.submitPending = true;

          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/access`,
            data: {
              username: this.currentUser.value,
              admin: this.isAdmin
            }
          });

          // update frontend data
          Vue.set(ADMINDATA.users[this.currentUser.value], 'admin', this.isAdmin);
    
          // close & reset the modal
          modVM.closeModal();
  
          iziToast.success({
            title: 'User Permissions Updated',
            position: 'topCenter',
            timeout: 3500
          });
        } catch(err) {
          iziToast.error({
            title: 'Failed to Update User',
            position: 'topCenter',
            timeout: 3500
          });
        }finally {
          this.submitPending = false;
        }
      }
    }
});

const editRequestSizeModal = Vue.component('edit-request-size-modal', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      submitPending: false,
      maxRequestSize: ADMINDATA.serverParams.maxRequestSize
    };
  },
  template: `
    <form @submit.prevent="updatePort">
      ${mHead('Max Request Size', 'Accepts KB or MB — e.g. 50mb')}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-max-request-size">Max Request Size</label>
          <input v-model="maxRequestSize" id="edit-max-request-size" required type="text" placeholder="e.g. 50mb">
          <span class="field-hint">⚠ Requires a server reboot to apply.</span>
        </div>
      </div>
      ${mFoot('Update', 'Updating')}
    </form>`,
  mounted: function () {
  },
  methods: {
    updatePort: async function() {
      try {
        this.submitPending = true;
        this.maxRequestSize = this.maxRequestSize.replaceAll(' ', '');

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/max-request-size`,
          data: { maxRequestSize: this.maxRequestSize }
        });

        // update frontend data
        Vue.set(ADMINDATA.serverParams, 'maxRequestSize', this.maxRequestSize);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: 'Success: Allow the server 30 seconds to reboot',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Failed to Update',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});


const editPortModal = Vue.component('edit-port-modal', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      submitPending: false,
      currentPort: ADMINDATA.serverParams.port
    };
  },
  template: `
    <form @submit.prevent="updatePort">
      ${mHead('Server Port', 'Change the port mStream listens on')}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-port">Port Number</label>
          <input v-model="currentPort" id="edit-port" required type="number" min="2" max="65535" placeholder="3000">
          <span class="field-hint">⚠ Requires a reboot. You will be redirected automatically.</span>
        </div>
      </div>
      ${mFoot('Update', 'Updating')}
    </form>`,
  mounted: function () {
  },
  methods: {
    updatePort: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/port`,
          data: { port: this.currentPort }
        });

        // update frontend data
        // Vue.set(ADMINDATA.serverParams, 'port', this.currentPort);
  
        // close & reset the modal
        modVM.closeModal();

        setTimeout(() => {
          window.location.href = window.location.href.replace(`:${ADMINDATA.serverParams.port}`, `:${this.currentPort}`); 
        }, 4000);

        iziToast.success({
          title: 'Port Updated.  You will be redirected shortly',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Failed to Update Port',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editAddressModal = Vue.component('edit-address-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.serverParams.address
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead('Server Address', "Only change if you know what you're doing")}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-server-address">Bind Address</label>
          <input v-model="editValue" id="edit-server-address" required type="text" placeholder="0.0.0.0">
          <span class="field-hint">⚠ Requires a reboot. Default <code>0.0.0.0</code> binds to all interfaces.</span>
        </div>
      </div>
      ${mFoot('Update', 'Updating')}
    </form>`,
  mounted: function () {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/address`,
          data: { address: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.serverParams, 'address', this.editValue);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: 'Address Updated.  Server is rebooting',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editMaxScanModal = Vue.component('edit-max-scans-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.maxConcurrentTasks
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead('Max Concurrent Scans')}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-max-scans">Max Concurrent Scans</label>
          <input v-model="editValue" id="edit-max-scans" required type="number" min="1">
          <span class="field-hint">⚠ Values above 1 are experimental and may cause instability.</span>
        </div>
      </div>
      ${mFoot('Update', 'Updating')}
    </form>`,
  mounted: function () {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/max-concurrent-scans`,
          data: { maxConcurrentTasks: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.dbParams, 'maxConcurrentTasks', this.editValue);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: 'Updated Successfully',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editBootScanView = Vue.component('edit-boot-scan-delay-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.bootScanDelay
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead('Boot Scan Delay', 'Seconds to wait before first scan after startup')}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-scan-delay">Delay (seconds)</label>
          <input v-model="editValue" id="edit-scan-delay" required type="number" min="1">
        </div>
      </div>
      ${mFoot('Update', 'Updating')}
    </form>`,
  mounted: function () {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/boot-scan-delay`,
          data: { bootScanDelay: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.dbParams, 'bootScanDelay', this.editValue);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: 'Updated Successfully',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editScanIntervalView = Vue.component('edit-scan-interval-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.scanInterval
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead('Scan Interval', 'Automatic library scan frequency (hours)')}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-scan-interval">Interval (hours)</label>
          <input v-model="editValue" id="edit-scan-interval" required type="number" min="0">
          <span class="field-hint">Set to 0 to disable automatic scans.</span>
        </div>
      </div>
      ${mFoot('Update', 'Updating')}
    </form>`,
  mounted: function () {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/scan-interval`,
          data: { scanInterval: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.dbParams, 'scanInterval', this.editValue);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: 'Updated Successfully',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editMaxZipMbModal = Vue.component('edit-max-zip-mb-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.maxZipMb || 500
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead('Max ZIP Download Size', 'Maximum total size of a ZIP download (MB)')}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-max-zip-mb">Max size (MB)</label>
          <input v-model.number="editValue" id="edit-max-zip-mb" required type="number" min="1" step="1">
          <span class="field-hint">ZIP downloads exceeding this limit are rejected. Default: 500 MB.</span>
        </div>
      </div>
      ${mFoot('Update', 'Updating')}
    </form>`,
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/max-zip-mb`,
          data: { maxZipMb: this.editValue }
        });
        Vue.set(ADMINDATA.dbParams, 'maxZipMb', this.editValue);
        modVM.closeModal();
        iziToast.success({ title: 'Updated Successfully', position: 'topCenter', timeout: 3500 });
      } catch(err) {
        iziToast.error({ title: 'Update Failed', position: 'topCenter', timeout: 3500 });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

const editSslModal =  Vue.component('edit-ssl-modal', {
  data() {
    const ssl = ADMINDATA.serverParams && ADMINDATA.serverParams.ssl;
    return {
      certPath: (ssl && ssl.cert) || '',
      keyPath: (ssl && ssl.key) || '',
      submitPending: false
    };
  },
  template: `
    <form @submit.prevent="updateSSL">
      ${mHead('SSL Certificate', 'Enable HTTPS by providing certificate files')}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-ssl-cert">Certificate File Path</label>
          <input v-model="certPath" id="edit-ssl-cert" required type="text" placeholder="/path/to/cert.pem">
        </div>
        <div class="field-group">
          <label for="edit-ssl-key">Key File Path</label>
          <input v-model="keyPath" id="edit-ssl-key" required type="text" placeholder="/path/to/key.pem">
          <span class="field-hint">&#9888; Requires a reboot. You will be redirected to HTTPS automatically.</span>
        </div>
      </div>
      ${mFoot('Update', 'Updating')}
    </form>`,
  methods: {
    updateSSL: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/ssl`,
          data: { cert: this.certPath, key: this.keyPath }
        });

        // update frontend data
        if (!ADMINDATA.serverParams.ssl) Vue.set(ADMINDATA.serverParams, 'ssl', {});
        Vue.set(ADMINDATA.serverParams.ssl, 'cert', this.certPath);
        Vue.set(ADMINDATA.serverParams.ssl, 'key', this.keyPath);
  
        modVM.closeModal();

        iziToast.success({
          title: 'Updated. Rebooting — you will be redirected to HTTPS shortly.',
          position: 'topCenter',
          timeout: 5000
        });

        setTimeout(() => {
          window.location.href = window.location.href.replace('http://', 'https://');
        }, 5000);
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

const serverAudioMpvBinModal = Vue.component('server-audio-mpvbin-modal', {
  data() {
    return {
      editValue: ADMINDATA.serverAudioParams.mpvBin || 'mpv',
      submitPending: false,
    };
  },
  template: `
    <form @submit.prevent="save">
      ${(()=>'')()}
      <div class="modal-header"><div><div class="modal-title">mpv Binary Path</div><div class="modal-subtitle">Full path or just 'mpv' if it's on your PATH</div></div><button class="modal-close-x" type="button" @click="closeModal">&times;</button></div>
      <div class="modal-body">
        <label class="modal-label">Binary path</label>
        <input class="modal-input" type="text" v-model="editValue" placeholder="mpv" spellcheck="false" autocorrect="off">
        <p style="color:var(--t2);font-size:.82rem;margin-top:6px">Example: <code>/usr/bin/mpv</code> or leave as <code>mpv</code> if installed system-wide.</p>
      </div>
      <div class="modal-footer-row">
        <button class="btn-flat" type="button" @click="closeModal">Cancel</button>
        <button class="btn" type="submit" :disabled="submitPending">{{submitPending ? 'Saving...' : 'Save'}}</button>
      </div>
    </form>`,
  methods: {
    async save() {
      this.submitPending = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/server-audio`, data: { mpvBin: this.editValue } });
        Vue.set(ADMINDATA.serverAudioParams, 'mpvBin', this.editValue);
        this.closeModal();
      } finally { this.submitPending = false; }
    }
  }
});

const editTranscodeCodecModal = Vue.component('edit-transcode-codec-modal', {
  data() {
    return {
      params: ADMINDATA.transcodeParams,
      submitPending: false,
      editValue: ADMINDATA.transcodeParams.defaultCodec,
      selectInstance: null
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead('Default Codec', 'Format used when transcoding audio')}
      <div class="modal-body">
        <div class="field-group">
          <label for="transcode-codec-dropdown">Codec</label>
          <select v-model="editValue" id="transcode-codec-dropdown">
            <option value="mp3">MP3 — best compatibility</option>
            <option value="opus">Opus — best quality / size ratio</option>
            <option value="aac">AAC — iOS &amp; Apple devices</option>
          </select>
        </div>
      </div>
      ${mFoot('Update', 'Updating')}
    </form>`,
  mounted: function () {
  },
  beforeDestroy: function() {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/transcode/default-codec`,
          data: { defaultCodec: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.transcodeParams, 'defaultCodec', this.editValue);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: 'Updated Successfully',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editTranscodeDefaultAlgorithm = Vue.component('edit-transcode-algorithm-modal', {
  data() {
    return {
      params: ADMINDATA.transcodeParams,
      submitPending: false,
      editValue: ADMINDATA.transcodeParams.algorithm,
      selectInstance: null
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead('Transcode Algorithm', 'How audio is processed and delivered')}
      <div class="modal-body">
        <div class="field-group">
          <label for="transcode-algorithm-dropdown">Algorithm</label>
          <select v-model="editValue" id="transcode-algorithm-dropdown">
            <option value="buffer">Buffer — slower start, maximum compatibility</option>
            <option value="stream">Stream — instant start, may not work on all devices</option>
          </select>
        </div>
      </div>
      ${mFoot('Update', 'Updating')}
    </form>`,
  mounted: function () {
  },
  beforeDestroy: function() {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/transcode/default-algorithm`,
          data: { algorithm: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.transcodeParams, 'algorithm', this.editValue);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: 'Updated Successfully',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editTranscodeDefaultBitrate = Vue.component('edit-transcode-bitrate-modal', {
  data() {
    return {
      params: ADMINDATA.transcodeParams,
      submitPending: false,
      editValue: ADMINDATA.transcodeParams.defaultBitrate,
      selectInstance: null
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead('Default Bitrate', 'Quality setting for transcoded streams')}
      <div class="modal-body">
        <div class="field-group">
          <label for="transcode-bitrate-dropdown">Bitrate</label>
          <select v-model="editValue" id="transcode-bitrate-dropdown">
            <option value="64k">64k — low bandwidth</option>
            <option value="96k">96k — moderate</option>
            <option value="128k">128k — good quality</option>
            <option value="192k">192k — high quality</option>
          </select>
        </div>
      </div>
      ${mFoot('Update', 'Updating')}
    </form>`,
  mounted: function () {
  },
  beforeDestroy: function() {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/transcode/default-bitrate`,
          data: { defaultBitrate: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.transcodeParams, 'defaultBitrate', this.editValue);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: 'Updated Successfully',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const federationGenerateInvite = Vue.component('federation-generate-invite-modal', {
  data() {
    return {
      submitPending: false,
      selectInstance: null,
      fedDirs: [],
      directories: ADMINDATA.folders,
      federationInviteToken: ADMINDATA.federationInviteToken
    };
  },
  template: `
    <div>
      ${mHead('Federation Invite', 'Tokens expire after 30 minutes')}
      <form @submit.prevent="generateToken">
        <div class="modal-body">
          <div class="field-group">
            <label for="fed-invite-dirs">Folders to Share</label>
            <select id="fed-invite-dirs" :disabled="Object.keys(directories).length === 0" multiple :size="Math.max(2, Object.keys(directories).length)" v-model="fedDirs">
              <option disabled value="" v-if="Object.keys(directories).length === 0">No directories &mdash; add one first</option>
              <option v-for="(val, key) in directories" :key="key" :value="key">{{ key }}</option>
            </select>
            <span class="field-hint">Hold Ctrl / Cmd to select multiple folders.</span>
          </div>
          <div class="field-group" v-if="federationInviteToken.val">
            <label>Invite Token</label>
            <textarea v-model="federationInviteToken.val" id="fed-textarea" rows="5" readonly style="resize:none;font-size:.82rem;font-family:monospace;"></textarea>
            <a href="#" class="fed-copy-button btn-flat btn-small" data-clipboard-target="#fed-textarea" style="align-self:flex-start;margin-top:.25rem;">Copy to Clipboard</a>
          </div>
        </div>
        ${mFoot('Create Invite', 'Creating')}
      </form>
    </div>`,
  mounted: function () {
  },
  beforeDestroy: function() {
  },
  methods: {
    generateToken: async function() {
      try {
        this.submitPending = true;
        const selectedDirs = this.fedDirs;

        if(selectedDirs.length === 0) {
          iziToast.warning({
            title: 'Nothing to Federate',
            position: 'topCenter',
            timeout: 3500
          });
          return;
        }

        const postData =  { vpaths: selectedDirs };
        if (window.location.protocol === 'https:') {
          postData.url = window.location.origin;
        }

        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/federation/invite/generate`,
          data: postData
        });

        this.federationInviteToken.val = res.data.token;
      } catch (err) {
        console.log(err)
        iziToast.error({
          title: 'Failed to make invite',
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.submitPending = false;
      }
    }
  }
});


const editDbEngineModal = Vue.component('edit-db-engine-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.engine,
      selectInstance: null
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead('Database Engine', '⚠ Requires a server reboot to apply')}
      <div class="modal-body">
        <div class="field-group">
          <label for="db-engine-dropdown">Engine</label>
          <select v-model="editValue" id="db-engine-dropdown">
            <option value="loki">LokiJS — in-memory, fast</option>
            <option value="sqlite">SQLite — persistent, reliable</option>
          </select>
        </div>
      </div>
      ${mFoot('Update', 'Updating')}
    </form>`,
  mounted: function () {
  },
  beforeDestroy: function() {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/engine`,
          data: { engine: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.dbParams, 'engine', this.editValue);

        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: 'Server Rebooting',
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: 'Update Failed',
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

const nullModal = Vue.component('null-modal', {
  template: '<div>NULL MODAL ERROR: How did you get here?</div>'
});

const modVM = new Vue({
  el: '#admin-modal-wrapper',
  components: {
    'user-password-modal': userPasswordView,
    'user-vpaths-modal': usersVpathsView,
    'user-access-modal': userAccessView,
    'file-explorer-modal': fileExplorerModal,
    'edit-port-modal': editPortModal,
    'edit-request-size-modal': editRequestSizeModal,
    'edit-address-modal': editAddressModal,
    'edit-scan-interval-modal': editScanIntervalView,
    'edit-boot-scan-delay-modal': editBootScanView,
    'edit-transcode-codec-modal': editTranscodeCodecModal,
    'edit-transcode-bitrate-modal': editTranscodeDefaultBitrate,
    'edit-transcode-algorithm-modal': editTranscodeDefaultAlgorithm,
    'server-audio-mpvbin-modal': serverAudioMpvBinModal,
    'edit-max-scan-modal': editMaxScanModal,
    'edit-ssl-modal': editSslModal,
    'federation-generate-invite-modal': federationGenerateInvite,
    'edit-db-engine-modal': editDbEngineModal,
    'edit-max-zip-mb-modal': editMaxZipMbModal,
    'dir-access-test-modal': dirAccessTestModal,
    'null-modal': nullModal
  },
  data: {
    currentViewModal: 'null-modal',
    modalOpen: false
  },
  methods: {
    openModal() { this.modalOpen = true; },
    closeModal() { this.modalOpen = false; this.currentViewModal = 'null-modal'; }
  }
});


const confirmVM = new Vue({
  el: '#confirm-modal-wrapper',
  data: {
    show: false,
    title: '',
    message: '',
    confirmLabel: 'Confirm',
    _onConfirm: null
  },
  methods: {
    ask(title, message, confirmLabel, onConfirm) {
      this.title = title;
      this.message = message || '';
      this.confirmLabel = confirmLabel || 'Confirm';
      this._onConfirm = onConfirm;
      this.show = true;
    },
    confirm() {
      this.show = false;
      if (this._onConfirm) this._onConfirm();
    },
    cancel() {
      this.show = false;
    }
  }
});
