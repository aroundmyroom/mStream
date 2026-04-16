// ── i18n Vue-reactivity bridge ───────────────────────────────────────────────
// I18NSTATE.tick increments each time a language loads.  Vue templates that
// call this.t('key') read the tick value, making them automatically re-render.
const I18NSTATE = Vue.observable({ tick: 0 });
Vue.prototype.t = function(key, params) {
  void I18NSTATE.tick; // reactive dependency — forces re-render on lang change
  return I18N.t(key, params);
};
I18N.onChange(() => { I18NSTATE.tick++; });
I18N.loadLanguage(); // detect from localStorage / browser navigator
// ─────────────────────────────────────────────────────────────────────────────

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
      // Use Vue.set so each folder object enters Vue's reactive system immediately.
      Vue.set(module.folders, key, res.data[key]);
    });

    module.foldersUpdated.ts = Date.now();
  };

  module.getUsers = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/users`
    });

    Object.keys(res.data).forEach(key=>{
      const u = res.data[key];
      // Normalise permission flags so keys always exist as explicit booleans.
      // Vue 2 cannot reactively track a property that was never defined on the object.
      if (!Object.prototype.hasOwnProperty.call(u, 'allow-upload')) u['allow-upload'] = true;
      if (!Object.prototype.hasOwnProperty.call(u, 'allow-radio-recording')) u['allow-radio-recording'] = false;
      if (!Object.prototype.hasOwnProperty.call(u, 'allow-youtube-download')) u['allow-youtube-download'] = false;
      // Use Vue.set so each user object enters Vue's reactive system.
      // Plain assignment (module.users[key] = u) bypasses reactivity — subsequent
      // Vue.set() calls on the child object would never trigger template updates.
      Vue.set(module.users, key, u);
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
    const pad = n => String(n).padStart(2, '0');
    const fmtLocal = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const now = new Date();
    return {
      loading:    false,
      loaded:     false,
      stats:      null,
      purgeUser:  '',
      fromDt:     fmtLocal(new Date(now.getTime() - 3600000)), // 1h ago
      toDt:       fmtLocal(now),
      purging:    false,
      backfilling: false,
    };
  },
  computed: {
    storageKB() {
      return this.stats ? (this.stats.storage_bytes / 1024).toFixed(1) : '—';
    },
  },
  mounted() { this.load(); },
  methods: {
    // Format a Date as the value expected by <input type="datetime-local">: "YYYY-MM-DDTHH:MM"
    _fmtLocal(d) {
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
    setPreset(hoursAgo) {
      const now = new Date();
      this.toDt   = this._fmtLocal(now);
      this.fromDt = this._fmtLocal(new Date(now.getTime() - hoursAgo * 3600000));
    },
    setPresetDay(daysAgo) {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      d.setHours(0, 0, 0, 0);
      const end = new Date(d);
      end.setHours(23, 59, 59, 0);
      this.fromDt = this._fmtLocal(d);
      this.toDt   = this._fmtLocal(daysAgo === 0 ? new Date() : end);
    },
    async load() {
      this.loading = true;
      try {
        const r = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/wrapped/stats` });
        this.stats = r.data;
        this.loaded = true;
        if (this.stats.per_user.length) this.purgeUser = this.stats.per_user[0].user_id;
      } catch (e) {
        iziToast.error({ title: this.t('admin.playStats.toastFailedLoad'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.loading = false;
      }
    },
    doPurge() {
      if (!this.purgeUser || !this.fromDt || !this.toDt) return;
      const fromMs = new Date(this.fromDt).getTime();
      const toMs   = new Date(this.toDt).getTime();
      if (isNaN(fromMs) || isNaN(toMs)) {
        iziToast.error({ title: this.t('admin.playStats.toastInvalidDate'), position: 'topCenter', timeout: 3000 });
        return;
      }
      if (toMs < fromMs) {
        iziToast.error({ title: this.t('admin.playStats.toastToBeforeFrom'), position: 'topCenter', timeout: 3000 });
        return;
      }
      const fmt = dt => new Date(dt).toLocaleString();
      adminConfirm(
        this.t('admin.playStats.confirmDeleteTitle', { user: this.purgeUser }),
        this.t('admin.playStats.confirmDeleteMsg', { from: fmt(fromMs), to: fmt(toMs) }),
        this.t('admin.playStats.confirmDeleteLabel'),
        async () => {
          this.purging = true;
          try {
            const r = await API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/wrapped/purge`,
              data: { userId: this.purgeUser, fromMs, toMs },
            });
            iziToast.success({ title: this.t('admin.playStats.toastDeletedEvents', { count: r.data.deleted }), position: 'topCenter', timeout: 3000 });
            this.load();
          } catch (e) {
            iziToast.error({ title: this.t('admin.playStats.toastDeleteFailed'), message: e.message, position: 'topCenter', timeout: 4000 });
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
    doBackfill() {
      adminConfirm(
        this.t('admin.playStats.confirmBackfillTitle'),
        this.t('admin.playStats.confirmBackfillMsg'),
        this.t('admin.playStats.confirmBackfillLabel'),
        async () => {
          this.backfilling = true;
          try {
            const r = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/wrapped/backfill-folder-metadata` });
            iziToast.success({ title: this.t('admin.playStats.toastUpdatedFiles', { count: r.data.updated }), position: 'topCenter', timeout: 4000 });
          } catch (e) {
            iziToast.error({ title: this.t('admin.playStats.toastBackfillFailed'), message: e.message, position: 'topCenter', timeout: 4000 });
          } finally {
            this.backfilling = false;
          }
        }
      );
    },
  },
  template: `
    <div>
      <div class="card">
        <div class="card-content">
          <span class="card-title">{{ t('admin.playStats.title') }}</span>
          <p class="grey-text">{{ t('admin.playStats.subtitle') }}</p>
          <div v-if="loading" class="center-align" style="padding:2rem;">{{ t('admin.playStats.loading') }}</div>
          <div v-else-if="loaded && stats">
            <div style="display:flex;gap:2rem;flex-wrap:wrap;margin-bottom:1.5rem;">
              <div class="admin-stat-box">
                <div class="admin-stat-value">{{ stats.total_events.toLocaleString() }}</div>
                <div class="admin-stat-label">{{ t('admin.playStats.statSongEvents') }}</div>
              </div>
              <div class="admin-stat-box">
                <div class="admin-stat-value">{{ stats.total_radio.toLocaleString() }}</div>
                <div class="admin-stat-label">{{ t('admin.playStats.statRadioSessions') }}</div>
              </div>
              <div class="admin-stat-box">
                <div class="admin-stat-value">{{ stats.total_podcast.toLocaleString() }}</div>
                <div class="admin-stat-label">{{ t('admin.playStats.statPodcastEpisodes') }}</div>
              </div>
              <div class="admin-stat-box">
                <div class="admin-stat-value">{{ storageKB }} KB</div>
                <div class="admin-stat-label">{{ t('admin.playStats.statDbStorage') }}</div>
              </div>
            </div>
            <table class="striped" v-if="stats.per_user.length">
              <thead><tr><th>{{ t('admin.playStats.tableUser') }}</th><th>{{ t('admin.playStats.tableSongs') }}</th><th>{{ t('admin.playStats.tableSongTime') }}</th><th>{{ t('admin.playStats.tableRadioSessions') }}</th><th>{{ t('admin.playStats.tableRadioTime') }}</th><th>{{ t('admin.playStats.tablePodcastEps') }}</th><th>{{ t('admin.playStats.tablePodcastTime') }}</th></tr></thead>
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
            <p v-else class="grey-text">{{ t('admin.playStats.noEventsYet') }}</p>
          </div>
        </div>
      </div>

      <div class="card" v-if="loaded && stats && stats.per_user.length">
        <div class="card-content">
          <span class="card-title">{{ t('admin.playStats.deleteRangeTitle') }}</span>
          <p class="grey-text">{{ t('admin.playStats.deleteRangeDesc') }}</p>

          <div style="margin-bottom:1rem;">
            <div style="font-size:.8rem;color:var(--fg-muted);margin-bottom:.4rem;">{{ t('admin.playStats.labelUser') }}</div>
            <select v-model="purgeUser" style="padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);">
              <option v-for="u in stats.per_user" :key="u.user_id" :value="u.user_id">{{ u.user_id }}</option>
            </select>
          </div>

          <div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:1rem;">
            <div>
              <div style="font-size:.8rem;color:var(--fg-muted);margin-bottom:.3rem;">{{ t('admin.playStats.labelFrom') }}</div>
              <input type="datetime-local" v-model="fromDt" style="padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);" />
            </div>
            <div>
              <div style="font-size:.8rem;color:var(--fg-muted);margin-bottom:.3rem;">{{ t('admin.playStats.labelTo') }}</div>
              <input type="datetime-local" v-model="toDt" style="padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);" />
            </div>
          </div>

          <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:1.2rem;">
            <span style="font-size:.8rem;color:var(--fg-muted);">{{ t('admin.playStats.quickSelect') }}</span>
            <button class="btn btn-small" style="height:2rem;line-height:2rem;padding:0 .75rem;font-size:.8rem;" @click="setPreset(1)">{{ t('admin.playStats.presetLast1h') }}</button>
            <button class="btn btn-small" style="height:2rem;line-height:2rem;padding:0 .75rem;font-size:.8rem;" @click="setPreset(6)">{{ t('admin.playStats.presetLast6h') }}</button>
            <button class="btn btn-small" style="height:2rem;line-height:2rem;padding:0 .75rem;font-size:.8rem;" @click="setPreset(12)">{{ t('admin.playStats.presetLast12h') }}</button>
            <button class="btn btn-small" style="height:2rem;line-height:2rem;padding:0 .75rem;font-size:.8rem;" @click="setPresetDay(0)">{{ t('admin.playStats.presetToday') }}</button>
            <button class="btn btn-small" style="height:2rem;line-height:2rem;padding:0 .75rem;font-size:.8rem;" @click="setPresetDay(1)">{{ t('admin.playStats.presetYesterday') }}</button>
          </div>

          <button class="btn red darken-1" :disabled="purging" @click="doPurge">
            {{ purging ? t('admin.playStats.btnDeleting') : t('admin.playStats.btnDelete') }}
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-content">
          <span class="card-title">{{ t('admin.playStats.fixMetadataTitle') }}</span>
          <p class="grey-text">{{ t('admin.playStats.fixMetadataDesc') }}</p>
          <p class="grey-text" style="margin-top:.5rem;">{{ t('admin.playStats.fixMetadataNote') }}</p>
          <button class="btn" :disabled="backfilling" @click="doBackfill" style="margin-top:.5rem;">
            {{ backfilling ? t('admin.playStats.btnApplying') : t('admin.playStats.btnDerive') }}
          </button>
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
        iziToast.error({ title: this.t('admin.scanErrors.toastFailedLoad'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.loading = false;
      }
    },
    confirmClear() {
      adminConfirm(
        this.t('admin.scanErrors.confirmClearTitle'),
        this.t('admin.scanErrors.confirmClearMsg'),
        this.t('admin.scanErrors.confirmClearLabel'),
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
        iziToast.success({ title: this.t('admin.scanErrors.toastCleared'), position: 'topCenter', timeout: 2500 });
      } catch (err) {
        iziToast.error({ title: this.t('admin.scanErrors.toastFailedClear'), position: 'topCenter', timeout: 3000 });
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
        iziToast.success({ title: this.t('admin.scanErrors.toastRetentionSaved'), position: 'topCenter', timeout: 2000 });
      } catch (err) {
        iziToast.error({ title: this.t('admin.scanErrors.toastRetentionFailed'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.savingRetention = false;
      }
    },
    toggleRow(guid) {
      this.expandedRow = this.expandedRow === guid ? null : guid;
    },
    typeLabel(t) {
      return {
        parse: this.t('admin.scanErrors.typeParseError'),
        art: this.t('admin.scanErrors.typeAlbumArt'),
        cue: this.t('admin.scanErrors.typeCueSheet'),
        insert: this.t('admin.scanErrors.typeDbInsert'),
        other: this.t('admin.scanErrors.typeOther')
      }[t] || t;
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
      const map = {
        12: this.t('admin.scanErrors.retention12h'),
        24: this.t('admin.scanErrors.retention1d'),
        48: this.t('admin.scanErrors.retention2d'),
        72: this.t('admin.scanErrors.retention3d'),
        168: this.t('admin.scanErrors.retention1w'),
        336: this.t('admin.scanErrors.retention2w'),
        720: this.t('admin.scanErrors.retention30d')
      };
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
        iziToast.info({ title: this.t('admin.scanErrors.toastPathCopied'), position: 'topCenter', timeout: 1500 });
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
        const labels = {
          art_fixed: this.t('admin.scanErrors.fixActionArtFixed'),
          remuxed: this.t('admin.scanErrors.fixActionRemuxed'),
          reencoded: this.t('admin.scanErrors.fixActionReencoded'),
          cue_dismissed: this.t('admin.scanErrors.fixActionCueDismissed'),
          dismissed: this.t('admin.scanErrors.fixActionDismissed'),
          unrecoverable: this.t('admin.scanErrors.fixActionUnrecoverable')
        };
        if (r.data.action === 'unrecoverable') {
          iziToast.error({ title: this.t('admin.scanErrors.toastFileUnrecoverable'), message: this.t('admin.scanErrors.toastFileUnrecoverableMsg'), position: 'topCenter', timeout: 0, close: true });
        } else {
          const msg = (labels[r.data.action] || this.t('admin.scanErrors.toastFixed')) + (r.data.note ? ' — ' + r.data.note : '');
          iziToast.success({ title: this.t('admin.scanErrors.toastFixed'), message: msg, position: 'topCenter', timeout: 4000 });
        }
        // Sync fix_action from server response into the local row so the badge
        // reflects the correct state immediately (before page reload).
        if (idx >= 0) this.errors[idx].fix_action = r.data.action;
      } catch (e) {
        iziToast.error({ title: this.t('admin.scanErrors.toastFixFailed'), message: e?.response?.data?.error || this.t('admin.scanErrors.typeOther'), position: 'topCenter', timeout: 0, close: true });
      } finally {
        Vue.delete(this.fixing, err.guid);
      }
    },
    fixActionLabel(action) {
      return {
        art_fixed: this.t('admin.scanErrors.fixActionArtFixed'),
        remuxed: this.t('admin.scanErrors.fixActionRemuxed'),
        reencoded: this.t('admin.scanErrors.fixActionReencoded'),
        cue_dismissed: this.t('admin.scanErrors.fixActionCueDismissed'),
        dismissed: this.t('admin.scanErrors.fixActionDismissed'),
        unrecoverable: this.t('admin.scanErrors.fixActionUnrecoverable')
      }[action] || this.t('admin.scanErrors.toastFixed');
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
                      <div class="se-main-title">{{ t('admin.scanErrors.title') }}</div>
                      <div class="se-sub">{{ t('admin.scanErrors.subtitle') }}</div>
                    </div>
                    <span class="se-total-pill" v-if="loaded && unfixedCount > 0">
                      {{ t('admin.scanErrors.pillIssues', { count: unfixedCount }) }}{{total > errors.length ? ' ' + t('admin.scanErrors.pillShowing', { shown: errors.length.toLocaleString(), total: total.toLocaleString() }) : ''}}
                    </span>
                    <span class="se-total-pill se-total-ok" v-else-if="loaded && errors.length === 0">
                      {{ t('admin.scanErrors.pillClean') }}
                    </span>
                    <span class="se-total-pill se-total-ok" v-else-if="loaded && unfixedCount === 0">
                      {{ t('admin.scanErrors.pillNoActionable') }}
                    </span>
                  </div>
                  <div class="se-controls-row">
                    <div class="se-retention-group">
                      <label class="se-retention-label">{{ t('admin.scanErrors.retentionLabel') }}</label>
                      <select v-model.number="retentionHours" @change="saveRetention" class="se-retention-sel" :disabled="savingRetention">
                        <option :value="12">{{ t('admin.scanErrors.retention12h') }}</option>
                        <option :value="24">{{ t('admin.scanErrors.retention1d') }}</option>
                        <option :value="48">{{ t('admin.scanErrors.retention2d') }}</option>
                        <option :value="72">{{ t('admin.scanErrors.retention3d') }}</option>
                        <option :value="168">{{ t('admin.scanErrors.retention1w') }}</option>
                        <option :value="336">{{ t('admin.scanErrors.retention2w') }}</option>
                        <option :value="720">{{ t('admin.scanErrors.retention30d') }}</option>
                      </select>
                      <span class="se-retention-hint">{{ t('admin.scanErrors.retentionHint') }}</span>
                    </div>
                    <div class="se-action-group">
                      <button class="btn-flat btn-small" @click="load" :disabled="loading">
                        <svg v-if="!loading" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        <svg v-else class="se-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                        {{loading ? t('admin.scanErrors.btnLoading') : t('admin.scanErrors.btnRefresh')}}
                      </button>
                      <button class="btn btn-small red" @click="confirmClear" v-if="errors.length > 0">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                        {{ t('admin.scanErrors.btnClearAll') }}
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
                <div class="se-empty-title">{{ t('admin.scanErrors.emptyTitle') }}</div>
                <div class="se-empty-msg">{{ t('admin.scanErrors.emptyMsg') }}</div>
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
                {{ t('admin.scanErrors.truncationWarning', { shown: errors.length.toLocaleString(), total: total.toLocaleString() }) }}
              </div>
            </div>
          </div>

          <!-- ── Type filter chips ── -->
          <div class="row">
            <div class="col s12">
              <div class="se-filter-strip">
                <button class="se-fchip" :class="{active: typeFilter === null}" @click="typeFilter = null">
                  {{ t('admin.scanErrors.filterAll') }}
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
                    <div class="se-th se-col-type">{{ t('admin.scanErrors.colType') }}</div>
                    <div class="se-th se-col-file">{{ t('admin.scanErrors.colFile') }}</div>
                    <div class="se-th se-col-msg">{{ t('admin.scanErrors.colIssue') }}</div>
                    <div class="se-th se-col-count">{{ t('admin.scanErrors.colDetections') }}</div>
                    <div class="se-th se-col-first">{{ t('admin.scanErrors.colFirstSeen') }}</div>
                    <div class="se-th se-col-last">{{ t('admin.scanErrors.colLastSeen') }}</div>
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
                        <span class="se-fixed-badge" v-if="err.fixed_at && err.fix_action !== 'unrecoverable'">{{ t('admin.scanErrors.badgeFixed') }}</span>
                        <span class="se-unrecoverable-badge" v-if="err.fix_action === 'unrecoverable'">{{ t('admin.scanErrors.badgeUnrecoverable') }}</span>
                        <span class="se-deleted-badge" v-if="!err.file_in_db && !(err.error_msg && (err.error_msg.includes('EPIPE') || err.error_msg.includes('ECONNRESET') || err.error_msg.includes('ECONNREFUSED')))">{{ t('admin.scanErrors.badgeGoneFromLibrary') }}</span>
                        <span class="se-deleted-badge" v-if="!err.file_in_db && err.error_msg && (err.error_msg.includes('EPIPE') || err.error_msg.includes('ECONNRESET') || err.error_msg.includes('ECONNREFUSED'))">{{ t('admin.scanErrors.badgeScanInterrupted') }}</span>
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
                        <span class="se-errmsg">{{err.error_msg || '(' + t('admin.scanErrors.noMessage') + ')'}}</span>
                      </div>

                      <!-- Detection count -->
                      <div class="se-col-count">
                        <span class="se-count-badge" v-if="err.count > 1" :title="t('admin.scanErrors.countDetected', { count: err.count })">
                          {{ t('admin.scanErrors.countDetected', { count: err.count }) }}
                        </span>
                        <span class="se-count-once" v-else>{{ t('admin.scanErrors.countOnce') }}</span>
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
                          <div class="se-detail-label">{{ t('admin.scanErrors.detailFullPath') }}</div>
                          <div class="se-detail-value se-detail-path" @click="copyPath(err.filepath)" title="Click to copy">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            {{err.filepath || '—'}}
                          </div>
                        </div>
                        <div class="se-detail-section">
                          <div class="se-detail-label">{{ t('admin.scanErrors.detailErrorMsg') }}</div>
                          <div class="se-detail-value">{{err.error_msg || '(' + t('admin.scanErrors.none') + ')'}}</div>
                        </div>
                        <div class="se-detail-section" v-if="err.stack">
                          <div class="se-detail-label">{{ t('admin.scanErrors.detailStackTrace') }}</div>
                          <pre class="se-stack">{{err.stack}}</pre>
                        </div>
                        <div class="se-detail-meta-row">
                          <div class="se-detail-meta-chip">
                            <span class="se-detail-meta-k">{{ t('admin.scanErrors.detailLibraryPath') }}</span>
                            <span class="se-detail-meta-v">{{err.vpath}}</span>
                          </div>
                          <div class="se-detail-meta-chip">
                            <span class="se-detail-meta-k">{{ t('admin.scanErrors.detailFirstDetected') }}</span>
                            <span class="se-detail-meta-v">{{absTime(err.first_seen)}}</span>
                          </div>
                          <div class="se-detail-meta-chip">
                            <span class="se-detail-meta-k">{{ t('admin.scanErrors.detailLastDetected') }}</span>
                            <span class="se-detail-meta-v">{{absTime(err.last_seen)}}</span>
                          </div>
                          <div class="se-detail-meta-chip">
                            <span class="se-detail-meta-k">{{ t('admin.scanErrors.detailTotalDetections') }}</span>
                            <span class="se-detail-meta-v" :style="{color: err.count > 1 ? typeColor(err.error_type) : 'inherit'}">
                              {{ t('admin.scanErrors.detailTimePlural', { count: err.count }) }}
                            </span>
                          </div>
                        </div>

                        <!-- ── Deleted-from-library banner ── -->
                        <div class="se-deleted-banner" v-if="!err.file_in_db">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                          <div>
                            <div class="se-deleted-title">{{ t('admin.scanErrors.deletedBannerTitle') }}</div>
                            <div class="se-deleted-body" v-if="err.error_msg && (err.error_msg.includes('EPIPE') || err.error_msg.includes('ECONNRESET') || err.error_msg.includes('ECONNREFUSED'))">
                              {{ t('admin.scanErrors.deletedBodyInterrupted') }}
                            </div>
                            <div class="se-deleted-body" v-else>{{ t('admin.scanErrors.deletedBodyRemoved') }}</div>
                          </div>
                        </div>

                        <!-- ── Fix action row ── -->
                        <div class="se-unrecoverable-banner" v-if="err.fix_action === 'unrecoverable'">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                          <div>
                            <div class="se-unrecoverable-title">{{ t('admin.scanErrors.unrecoverableTitle') }}</div>
                            <div class="se-unrecoverable-body">{{ t('admin.scanErrors.unrecoverableBody') }}</div>
                          </div>
                        </div>
                        <div class="se-detail-fix-row" v-else-if="err.fixed_at && err.fix_action !== 'unrecoverable'">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--se-green,#4caf50)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                          <span class="se-fix-done-txt">
                            Fixed {{relTime(err.fixed_at)}}
                            <span v-if="err.fix_action" style="opacity:.65;margin-left:.35rem">({{fixActionLabel(err.fix_action)}})</span>
                            <span v-if="err.confirmed_at" class="se-confirmed-chip">&#10003; Rescan confirmed OK {{relTime(err.confirmed_at)}}</span>
                            <span v-else style="opacity:.5;margin-left:.5rem;font-size:.8em">{{ t('admin.scanErrors.fixRescanWaiting') }}</span>
                          </span>
                        </div>
                        <div class="se-detail-fix-row" v-else-if="!err.file_in_db">
                          <span style="opacity:.5;font-size:.85em">{{ t('admin.scanErrors.fixNoActionNeeded') }}</span>
                        </div>
                        <div class="se-detail-fix-row" v-else>
                          <button class="se-fix-btn" @click.stop="fixError(err)" :disabled="fixing[err.guid]">
                            <svg v-if="!fixing[err.guid]" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                            <svg v-else class="se-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                            {{fixing[err.guid] ? t('admin.scanErrors.btnFixing') : t('admin.scanErrors.btnFixError')}}
                          </button>
                          <span class="se-fix-hint" v-if="err.error_type === 'art'">{{ t('admin.scanErrors.fixHintArt') }}</span>
                          <span class="se-fix-hint" v-else-if="err.error_type === 'cue'">{{ t('admin.scanErrors.fixHintCue') }}</span>
                          <span class="se-fix-hint" v-else-if="err.error_type === 'parse' || err.error_type === 'duration'">{{ t('admin.scanErrors.fixHintParse') }}</span>
                          <span class="se-fix-hint" v-else>{{ t('admin.scanErrors.fixHintOther') }}</span>
                        </div>

                      </div>
                    </div>

                  </template>

                  <!-- Row count footer -->
                  <div class="se-table-footer">
                    {{ t('admin.scanErrors.tableFooter', { shown: filteredErrors.length, total: errors.length }) }}
                    <span v-if="typeFilter"> {{ t('admin.scanErrors.filteredBy', { type: typeLabel(typeFilter) }) }}</span>
                    <a v-if="typeFilter" @click="typeFilter = null" style="margin-left:.5rem">{{ t('admin.scanErrors.clearFilter') }}</a>
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
          <span class="card-title">{{ t('admin.folders.addTitle') }}</span>
          <form id="choose-directory-form" @submit.prevent="submitForm">

            <div class="input-field">
              <label for="folder-name">{{ t('admin.folders.labelPath') }}</label>
              <div style="display:flex;gap:.5rem;align-items:stretch;">
                <input
                  v-on:click="addFolderDialog()"
                  v-model="folder.value"
                  id="folder-name" required type="text"
                  :placeholder="t('admin.folders.pathPlaceholder')"
                  style="cursor:pointer;flex:1;margin-bottom:0;"
                  readonly />
                <button type="button" class="btn" @click="addFolderDialog()" style="flex-shrink:0;height:38px;align-self:center;" title="Open folder browser">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 48 48" style="vertical-align:middle;margin-right:4px;"><path fill="#FFA000" d="M38 12H22l-4-4H8c-2.2 0-4 1.8-4 4v24c0 2.2 1.8 4 4 4h31c1.7 0 3-1.3 3-3V16c0-2.2-1.8-4-4-4z"/><path fill="#FFCA28" d="M42.2 18H15.3c-1.9 0-3.6 1.4-3.9 3.3L8 40h31.7c1.9 0 3.6-1.4 3.9-3.3l2.5-14c.5-2.4-1.4-4.7-3.9-4.7z"/></svg>{{ t('admin.folders.btnBrowse') }}
                </button>
              </div>
            </div>

            <div class="input-field">
              <label for="add-directory-name">{{ t('admin.folders.labelAlias') }} <span style="color:var(--t3);font-weight:400;">{{ t('admin.folders.aliasSuffix') }}</span></label>
              <input
                pattern="[a-zA-Z0-9-]+"
                v-model="dirName"
                id="add-directory-name" required type="text"
                :placeholder="t('admin.folders.aliasPlaceholder')" />
              <small style="display:block;color:var(--t2);font-size:.82rem;margin-top:.25rem;">
                {{ t('admin.folders.aliasHint') }}
              </small>
            </div>

            <div style="display:flex;flex-direction:column;gap:.85rem;margin:.25rem 0 .5rem;">

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-auto-access" type="checkbox" checked style="width:auto;margin-top:3px;flex-shrink:0;" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">{{ t('admin.folders.optionAutoAccess') }}</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">{{ t('admin.folders.optionAutoAccessDesc') }}</small>
                </span>
              </label>

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-is-audiobooks" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;"
                  @change="if ($event.target.checked) { document.getElementById('folder-is-excluded').checked = false; document.getElementById('folder-is-excluded').dispatchEvent(new Event('change')); }" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">{{ t('admin.folders.optionAudiobooks') }}</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">{{ t('admin.folders.optionAudiobooksDesc') }}</small>
                </span>
              </label>

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-is-excluded" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;"
                  @change="
                    const excl = $event.target.checked;
                    if (excl) {
                      document.getElementById('folder-auto-access').checked = false;
                      document.getElementById('folder-is-audiobooks').checked = false;
                      document.getElementById('folder-is-recordings').checked = false;
                      document.getElementById('folder-is-youtube').checked = false;
                      document.getElementById('folder-allow-record-delete').checked = false;
                      document.getElementById('folder-allow-record-delete-row').style.display = 'none';
                    }
                    ['folder-is-audiobooks','folder-is-recordings','folder-is-youtube'].forEach(id => document.getElementById(id).disabled = excl);" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">{{ t('admin.folders.optionExcluded') }}</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">{{ t('admin.folders.optionExcludedDesc') }}</small>
                </span>
              </label>

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-is-recordings" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;"
                  @change="
                    if ($event.target.checked) { document.getElementById('folder-is-excluded').checked = false; document.getElementById('folder-is-excluded').dispatchEvent(new Event('change')); }
                    const any = $event.target.checked || document.getElementById('folder-is-youtube').checked;
                    document.getElementById('folder-allow-record-delete-row').style.display = any ? 'flex' : 'none';
                    if (!any) document.getElementById('folder-allow-record-delete').checked = false;" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">{{ t('admin.folders.optionRecordings') }}</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">{{ t('admin.folders.optionRecordingsDesc') }}</small>
                </span>
              </label>

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-is-youtube" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;"
                  @change="
                    if ($event.target.checked) { document.getElementById('folder-is-excluded').checked = false; document.getElementById('folder-is-excluded').dispatchEvent(new Event('change')); }
                    const any = $event.target.checked || document.getElementById('folder-is-recordings').checked;
                    document.getElementById('folder-allow-record-delete-row').style.display = any ? 'flex' : 'none';
                    if (!any) document.getElementById('folder-allow-record-delete').checked = false;" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">{{ t('admin.folders.optionYoutube') }}</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">{{ t('admin.folders.optionYoutubeDesc') }}</small>
                </span>
              </label>

              <label id="folder-allow-record-delete-row" style="display:none;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-allow-record-delete" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">{{ t('admin.folders.optionAllowDelete') }}</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">{{ t('admin.folders.optionAllowDeleteDesc') }}</small>
                </span>
              </label>

            </div>
          </form>
        </div>
        <div class="card-action">
          <button class="btn" type="submit" form="choose-directory-form" :disabled="submitPending === true">
            {{ submitPending ? t('admin.folders.btnAdding') : t('admin.folders.btnAdd') }}
          </button>
        </div>
      </div>

      <div v-show="foldersTS.ts === 0" style="display:flex;justify-content:center;padding:2rem;">
        <svg class="spinner" width="48" height="48" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>

      <div v-show="foldersTS.ts > 0" class="card">
        <div class="card-content">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;">
            <span class="card-title" style="margin-bottom:0;">{{ t('admin.folders.listTitle') }}</span>
            <button class="btn-small" type="button" @click="testAccess" :title="t('admin.folders.btnTestAccess')">{{ t('admin.folders.btnTestAccess') }}</button>
          </div>
          <div v-if="Object.keys(folders).length === 0" style="color:var(--t2);padding:.5rem 0;">{{ t('admin.folders.noDirectories') }}</div>
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
                   v.type === 'excluded'   ? 'background:rgba(156,163,175,.12);color:#9ca3af;' :
                                            'background:rgba(16,185,129,.12);color:#10b981;')">
                  {{ v.type === 'recordings' ? t('admin.folders.typeRadioRecordings') :
                     v.type === 'youtube'    ? t('admin.folders.typeYoutubeDownloads') :
                     v.type === 'audio-books'? t('admin.folders.typeAudiobooks') :
                     v.type === 'excluded'   ? t('admin.folders.typeExcluded') : t('admin.folders.typeMusic') }}
                </span>
                <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;">
                  <button class="btn-small" type="button" @click="toggleEditFolder(k)">
                    {{ editingFolder === k ? t('admin.folders.btnCancelEdit') : t('admin.folders.btnEdit') }}
                  </button>
                  <button v-if="v.type === 'recordings' || v.type === 'youtube'" class="btn-small" type="button"
                    :style="v.allowRecordDelete ? 'background:var(--primary);color:#fff;' : ''"
                    :title="v.allowRecordDelete ? t('admin.folders.btnDeleteOn') : t('admin.folders.btnDeleteOff')"
                    @click="toggleRecordDelete(k)">
                    {{v.allowRecordDelete ? t('admin.folders.btnDeleteOn') : t('admin.folders.btnDeleteOff')}}
                  </button>
                  <button v-if="v.type !== 'recordings' && v.type !== 'youtube' && v.type !== 'excluded'" class="btn-small" type="button"
                    :style="v.albumsOnly ? 'background:var(--primary);color:#fff;' : ''"
                    :title="v.albumsOnly ? t('admin.folders.btnAlbumsOnlyOn') : t('admin.folders.btnAlbumsOnlyOff')"
                    @click="toggleAlbumsOnly(k)">
                    {{v.albumsOnly ? t('admin.folders.btnAlbumsOnlyOn') : t('admin.folders.btnAlbumsOnlyOff')}}
                  </button>
                  <button v-if="v.type !== 'excluded'" class="btn-small" type="button"
                    :style="v.artistsOn !== false ? 'background:var(--primary);color:#fff;' : ''"
                    :title="v.artistsOn !== false ? t('admin.folders.btnArtistsOn') : t('admin.folders.btnArtistsOff')"
                    @click="toggleArtistsOn(k)">
                    {{v.artistsOn !== false ? t('admin.folders.btnArtistsOn') : t('admin.folders.btnArtistsOff')}}
                  </button>
                  <button class="btn-small red" type="button" @click="removeFolder(k, v.root)">{{ t('admin.folders.btnRemove') }}</button>
                </div>
              </div>

              <!-- Row 2: directory path -->
              <div style="display:flex;align-items:baseline;gap:8px;">
                <span style="font-size:11px;color:var(--t3);flex-shrink:0;min-width:60px;">{{ t('admin.folders.labelPathRow') }}</span>
                <div style="display:flex;flex-direction:column;gap:3px;min-width:0;">
                  <span style="font-size:12px;color:var(--t2);word-break:break-all;font-family:monospace;">{{v.root}}</span>
                  <small v-if="v.type !== 'excluded'" style="color:var(--t3);font-size:.76rem;line-height:1.35;">
                    {{ t('admin.folders.artistsHint') }}
                  </small>
                </div>
              </div>

              <!-- Row 3: user access -->
              <div style="display:flex;align-items:flex-start;gap:8px;">
                <span style="font-size:11px;color:var(--t3);flex-shrink:0;min-width:60px;padding-top:2px;">{{ t('admin.folders.labelAccessRow') }}</span>
                <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                  <span v-for="uname in admin_users" :key="'admin-'+uname"
                        title="Admin — always has full access to all folders"
                        style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:11px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);color:#f59e0b;font-weight:600;">
                    ★ {{uname}}
                  </span>
                  <span v-if="(directories_users[k] || []).length >= non_admin_count && non_admin_count > 0"
                        style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:11px;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);color:#10b981;font-weight:600;">{{ t('admin.folders.allUsers') }}</span>
                  <template v-else-if="(directories_users[k] || []).length > 0">
                    <span v-for="uname in (directories_users[k] || [])" :key="uname"
                          style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:11px;background:var(--card);border:1px solid var(--border);color:var(--t2);">
                      {{uname}}
                    </span>
                  </template>
                  <span v-else-if="non_admin_count > 0"
                        style="font-size:12px;color:var(--t3);">{{ t('admin.folders.noUsersAssigned') }}</span>
                </div>
              </div>

              <!-- Edit panel (inline, expands when Edit is clicked) -->
              <div v-if="editingFolder === k"
                   style="margin-top:6px;padding:14px;border-radius:var(--r);background:var(--card);border:1px solid var(--border);display:flex;flex-direction:column;gap:12px;">

                <!-- Path -->
                <div>
                  <label style="font-size:12px;font-weight:600;color:var(--t2);display:block;margin-bottom:4px;">{{ t('admin.folders.editLabelPath') }}</label>
                  <div style="display:flex;gap:6px;">
                    <input v-model="editForm.root" type="text" class="settings-select" style="flex:1;font-family:monospace;font-size:.82rem;" />
                    <button class="btn-small" type="button" @click="pickEditFolder(k)" title="Browse">…</button>
                  </div>
                  <small style="color:var(--t3);font-size:.78rem;">{{ t('admin.folders.editPathHint') }}</small>
                </div>

                <!-- Type (checkboxes for radio/youtube, like add form) -->
                <div>
                  <label style="font-size:12px;font-weight:600;color:var(--t2);display:block;margin-bottom:6px;">{{ t('admin.folders.editLabelType') }}</label>
                  <div style="display:flex;flex-wrap:wrap;gap:18px;align-items:center;">
                    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;color:var(--t1);">
                      <input type="checkbox" v-model="editForm.isRecording" style="width:auto;" :disabled="editForm.isExcluded"
                        @change="if (editForm.isRecording) editForm.isExcluded = false;" />
                      {{ t('admin.folders.typeRadioRecordings') }}
                    </label>
                    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;color:var(--t1);">
                      <input type="checkbox" v-model="editForm.isYoutube" style="width:auto;" :disabled="editForm.isExcluded"
                        @change="if (editForm.isYoutube) editForm.isExcluded = false;" />
                      {{ t('admin.folders.typeYoutubeDownloads') }}
                    </label>
                    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;color:var(--t1);">
                      <input type="checkbox" v-model="editForm.isAudioBooks" style="width:auto;" :disabled="editForm.isExcluded"
                        @change="if (editForm.isAudioBooks) editForm.isExcluded = false;" />
                      {{ t('admin.folders.typeAudiobooks') }}
                    </label>
                    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;color:var(--t1);">
                      <input type="checkbox" v-model="editForm.isExcluded" style="width:auto;"
                        @change="if (editForm.isExcluded) { editForm.isRecording=false; editForm.isYoutube=false; editForm.isAudioBooks=false; }" />
                      {{ t('admin.folders.typeExcluded') }}
                    </label>
                  </div>
                  <small style="color:var(--t3);font-size:.78rem;">Check one or both. Both checked = Radio+YouTube combined folder. Excluded = never scanned or indexed.</small>
                </div>

                <!-- User access (non-admin users only) -->
                <div v-if="non_admin_count > 0">
                  <label style="font-size:12px;font-weight:600;color:var(--t2);display:block;margin-bottom:6px;">{{ t('admin.folders.editLabelUsers') }}</label>
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
                  <button class="btn-small" type="button" @click="editingFolder = null">{{ t('admin.folders.editBtnCancel') }}</button>
                  <button class="btn-small btn-primary" type="button" @click="saveEditFolder(k)">{{ t('admin.folders.editBtnSave') }}</button>
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
            title: this.t('admin.folders.toastAlreadyInUse'),
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
              allowRecordDelete: document.getElementById('folder-allow-record-delete').checked,
              isExcluded: document.getElementById('folder-is-excluded').checked
            }
          });

          if (document.getElementById('folder-auto-access').checked) {
            Object.values(ADMINDATA.users).forEach(user => {
              user.vpaths.push(this.dirName);
            });
          }

          const isExcl = document.getElementById('folder-is-excluded').checked;
          const isAB   = document.getElementById('folder-is-audiobooks').checked;
          const isRec  = document.getElementById('folder-is-recordings').checked;
          const isYT   = document.getElementById('folder-is-youtube').checked;
          const isARD  = document.getElementById('folder-allow-record-delete').checked;
          let addedType = 'music';
          if (isExcl) addedType = 'excluded';
          else if (isAB) addedType = 'audio-books';
          else if (isRec && isYT) addedType = 'recordings';
          else if (isYT) addedType = 'youtube';
          else if (isRec) addedType = 'recordings';
          const addedFolder = { root: this.folder.value, type: addedType, artistsOn: true };
          if ((isRec || isYT) && isARD) addedFolder.allowRecordDelete = true;
          Vue.set(ADMINDATA.folders, this.dirName, addedFolder);
          this.dirName = '';
          this.folder.value = '';
          this.$nextTick(() => {
          });
        }catch(err) {
          iziToast.error({
            title: this.t('admin.folders.toastFailedAdd'),
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
            title: newVal ? this.t('admin.folders.toastDeleteEnabled') : this.t('admin.folders.toastDeleteDisabled'),
            position: 'topCenter', timeout: 3000
          });
        } catch (_e) {
          iziToast.error({ title: this.t('admin.folders.toastFailedUpdate'), position: 'topCenter', timeout: 3000 });
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
            title: newVal ? this.t('admin.folders.toastAlbumsOnlyEnabled') : this.t('admin.folders.toastAlbumsOnlyDisabled'),
            position: 'topCenter', timeout: 3000
          });
        } catch (_e) {
          iziToast.error({ title: this.t('admin.folders.toastFailedUpdate'), position: 'topCenter', timeout: 3000 });
        }
      },
      toggleArtistsOn: async function(vpath) {
        const folder = ADMINDATA.folders[vpath];
        const newVal = folder.artistsOn === false;
        Vue.set(ADMINDATA.folders[vpath], 'artistsOn', newVal);
        try {
          await API.axios({
            method: 'PATCH',
            url: `${API.url()}/api/v1/admin/directory/flags`,
            data: { vpath, artistsOn: newVal }
          });
          iziToast.success({
            title: newVal ? this.t('admin.folders.toastArtistsEnabled') : this.t('admin.folders.toastArtistsDisabled'),
            message: this.t('admin.folders.toastArtistsRebuild'),
            position: 'topCenter', timeout: 3500
          });
        } catch (_e) {
          Vue.set(ADMINDATA.folders[vpath], 'artistsOn', !newVal);
          iziToast.error({ title: this.t('admin.folders.toastFailedUpdate'), position: 'topCenter', timeout: 3000 });
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
          isExcluded: folder.type === 'excluded',
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
        if (this.editForm.isExcluded) {
          newType = 'excluded';
        } else if (this.editForm.isAudioBooks) {
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
            if (isRecordLike || newType === 'excluded') Vue.delete(ADMINDATA.folders[vpath], 'albumsOnly');
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
              title: this.t('admin.folders.toastPathChanged'),
              position: 'topCenter', timeout: 5000
            });
          } catch (err) {
            errors.push('path');
            iziToast.error({
              title: this.t('admin.folders.toastInvalidPath', { error: err?.response?.data?.error || 'not a valid directory' }),
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
          iziToast.success({ title: this.t('admin.folders.toastFolderUpdated'), position: 'topCenter', timeout: 2500 });
          this.editingFolder = null;
        } else if (errors.length < 3) {
          iziToast.warning({ title: this.t('admin.folders.toastSomeChangesFailed', { fields: errors.join(', ') }), position: 'topCenter', timeout: 4000 });
        }
      },
      removeFolder: async function(vpath, folder) {
                adminConfirm(this.t('admin.folders.confirmRemoveTitle', { folder: folder }), this.t('admin.folders.confirmRemoveMsg'), this.t('admin.folders.confirmRemoveLabel'), () => {
          API.axios({
                          method: 'DELETE',
                          url: `${API.url()}/api/v1/admin/directory`,
                          data: { vpath: vpath }
                        }).then(() => {
                          iziToast.warning({
                            title: this.t('admin.folders.toastServerRebooting'),
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
                            title: this.t('admin.folders.toastFailedRemove'),
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
          <span class="card-title">{{ t('admin.users.addTitle') }}</span>
          <p style="color:var(--t2);font-size:.88rem;margin:.25rem 0 1rem;">{{ t('admin.users.addDesc') }}</p>
          <form id="add-user-form" @submit.prevent="addUser" autocomplete="off">

            <div style="display:flex;gap:.75rem;flex-wrap:wrap;">
              <div class="input-field" style="flex:1;min-width:160px;">
                <label for="new-username">{{ t('admin.users.labelUsername') }}</label>
                <input v-model="newUsername" id="new-username" required type="text" :placeholder="t('admin.users.usernamePlaceholder')" autocomplete="off">
              </div>
              <div class="input-field" style="flex:1;min-width:160px;">
                <label for="new-password">{{ t('admin.users.labelPassword') }}</label>
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
              <label for="new-user-dirs">{{ t('admin.users.labelFolderAccess') }} <span style="color:var(--red);font-size:.8rem;">*</span></label>
              <select id="new-user-dirs" :disabled="Object.keys(directories).length === 0" multiple :size="Math.max(2, Object.keys(directories).length)" v-model="newUserDirs">
                <option disabled value="" v-if="Object.keys(directories).length === 0">{{ t('admin.users.noDirectoriesToSelect') }}</option>
                <option v-for="(val, key) in directories" :key="key" :value="key">{{ key }}</option>
              </select>
              <small style="display:block;color:var(--t2);font-size:.82rem;margin-top:.25rem;" v-if="Object.keys(directories).length > 0">{{ t('admin.users.folderSelectHint') }}</small>
              <small style="display:block;color:var(--t2);font-size:.82rem;margin-top:.25rem;" v-else>Add a music directory before creating users.</small>
            </div>

            <label style="display:flex;align-items:center;gap:.6rem;cursor:pointer;margin:.25rem 0 .5rem;">
              <input id="make-admin-cb" type="checkbox" v-model="makeAdmin" style="width:auto;margin:0;flex-shrink:0;">
              <span><span style="color:var(--t1);font-weight:600;">{{ t('admin.users.grantAdmin') }}</span><br><small style="color:var(--t2);font-size:.82rem;">{{ t('admin.users.grantAdminDesc') }}</small></span>
            </label>

          </form>
        </div>
        <div class="card-action">
          <button class="btn" type="submit" form="add-user-form" :disabled="submitPending === true">
            {{submitPending === false ? t('admin.users.btnAdd') : t('admin.users.btnAdding')}}
          </button>
        </div>
      </div>

      <div v-if="usersTS.ts === 0" style="display:flex;justify-content:center;padding:2rem;">
        <svg class="spinner" width="48" height="48" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>

      <div v-else class="card">
        <div class="card-content">
          <span class="card-title">{{ t('admin.users.listTitle') }}</span>
          <p v-if="Object.keys(users).length === 0" style="color:var(--t2);margin:.5rem 0 0;">No users &mdash; authentication is currently <strong>disabled</strong>. The first user you create must have admin access.</p>
          <div v-if="Object.keys(users).length === 0" style="margin-top:.85rem;padding:.65rem .85rem;border-radius:6px;background:var(--raised);border:1px solid var(--border);font-size:.85rem;color:var(--t2);line-height:1.5;">
            <strong style="color:var(--t1);">Subsonic API (no-auth mode)</strong><br>
            Subsonic-compatible apps (Ultrasonic, DSub, Symfonium&hellip;) require a username.<br>
            Use <code style="background:var(--bg);padding:.1rem .35rem;border-radius:3px;color:var(--primary);font-size:.9em;">mstream-user</code> as the username with any password.
          </div>
          <table v-else>
            <thead>
              <tr>
                <th style="width:140px;">{{ t('admin.users.colUsername') }}</th>
                <th>{{ t('admin.users.colFolders') }}</th>
                <th style="width:70px;">{{ t('admin.users.colRole') }}</th>
                <th style="width:130px;">{{ t('admin.users.colPermissions') }}</th>
                <th style="text-align:right;white-space:nowrap;">{{ t('admin.users.colActions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(v, k) in users">
                <td style="font-weight:600;color:var(--t1);">{{k}}</td>
                <td><span style="color:var(--t2);font-size:.85rem;">{{v.vpaths.join(', ') || '&mdash;'}}</span></td>
                <td>
                  <span v-if="v.admin === true" style="background:rgba(139,92,246,.15);color:var(--primary);font-size:.75rem;font-weight:700;padding:.15rem .45rem;border-radius:4px;">{{ t('admin.users.roleAdmin') }}</span>
                  <span v-else style="background:var(--raised);color:var(--t2);font-size:.75rem;padding:.15rem .45rem;border-radius:4px;">{{ t('admin.users.roleUser') }}</span>
                </td>
                <td>
                  <div style="display:flex;flex-direction:column;gap:.3rem;">
                    <button type="button" class="btn-small btn-flat"
                      :title="v['allow-radio-recording'] ? 'Click to disable radio recording' : 'Click to enable radio recording'"
                      :style="v['allow-radio-recording'] ? 'background:rgba(40,167,69,.12);color:#28a745;border-color:rgba(40,167,69,.35);font-weight:600;' : 'background:rgba(220,50,50,.12);color:#e05555;border-color:rgba(220,50,50,.35);font-weight:600;'"
                      style="text-align:left;width:100%;"
                      @click="toggleRadioRecording(k, v)">
                      &#9679;&nbsp;Record&nbsp;<span style="opacity:.6;font-size:.68rem;">{{v['allow-radio-recording'] ? 'ON' : 'off'}}</span>
                    </button>
                    <button type="button" class="btn-small btn-flat"
                      :title="v['allow-youtube-download'] ? 'Click to disable YouTube download' : 'Click to enable YouTube download'"
                      :style="v['allow-youtube-download'] ? 'background:rgba(40,167,69,.12);color:#28a745;border-color:rgba(40,167,69,.35);font-weight:600;' : 'background:rgba(220,50,50,.12);color:#e05555;border-color:rgba(220,50,50,.35);font-weight:600;'"
                      style="text-align:left;width:100%;"
                      @click="toggleYoutubeDownload(k, v)">
                      &#9654;&nbsp;YouTube&nbsp;<span style="opacity:.6;font-size:.68rem;">{{v['allow-youtube-download'] ? 'ON' : 'off'}}</span>
                    </button>
                    <button type="button" class="btn-small btn-flat"
                      :title="v['allow-upload'] !== false ? 'Click to disable file upload' : 'Click to enable file upload'"
                      :style="v['allow-upload'] === false ? 'background:rgba(220,50,50,.12);color:#e05555;border-color:rgba(220,50,50,.35);font-weight:600;' : 'background:rgba(40,167,69,.12);color:#28a745;border-color:rgba(40,167,69,.35);font-weight:600;'"
                      style="text-align:left;width:100%;"
                      @click="toggleUpload(k, v)">
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" style="vertical-align:-.15em;margin-right:3px"><path d="m3.75 2.75h8.5m-8.5 6.5 4-3.5 4 3.5m-4 5v-8.5"/></svg>Upload&nbsp;<span style="opacity:.6;font-size:.68rem;">{{v['allow-upload'] === false ? 'off' : 'ON'}}</span>
                    </button>
                  </div>
                </td>
                <td>
                  <div style="display:flex;gap:.4rem;justify-content:flex-end;flex-wrap:wrap;">
                    <button class="btn-small btn-flat" type="button" @click="changePassword(k)">{{ t('admin.users.btnPassword') }}</button>
                    <button class="btn-small btn-flat" type="button" @click="changeVPaths(k)">{{ t('admin.users.btnFolders') }}</button>
                    <button class="btn-small btn-flat" type="button" @click="changeAccess(k)">{{ t('admin.users.btnAccess') }}</button>
                    <button class="btn-small" type="button" style="background:var(--red);border-color:var(--red);" @click="deleteUser(k)">{{ t('admin.users.btnDelete') }}</button>
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
                adminConfirm(this.t('admin.users.confirmDeleteTitle', { username }), '', this.t('admin.users.confirmDeleteLabel'), async () => {
          try {
                          await API.axios({
                            method: 'DELETE',
                            url: `${API.url()}/api/v1/admin/users`,
                            data: { username: username }
                          });
                          Vue.delete(ADMINDATA.users, username);
                        } catch (err) {
                          iziToast.error({
                            title: this.t('admin.users.toastFailedUpdate'),
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
              title: this.t('admin.users.toastNoFolder'),
              message: this.t('admin.users.toastNoFolderMsg'),
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

          iziToast.success({ title: this.t('admin.users.toastUserAdded'), position: 'topCenter', timeout: 3000 });

          if (isFirstUser) {
            adminConfirm('First user created', 'You will now be taken to the login page.', 'Go to Login', () => {
              window.location.href = '/login';
            });
          }
        }catch(err) {
          iziToast.error({
            title: this.t('admin.users.toastFailedAdd'),
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
      },
      toggleUpload: async function (username, user) {
        const newVal = user['allow-upload'] === false ? true : false;
        try {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/allow-upload`,
            data: { username, allow: newVal }
          });
          Vue.set(ADMINDATA.users[username], 'allow-upload', newVal);
          iziToast.success({ title: newVal ? 'Upload enabled' : 'Upload disabled', position: 'topCenter', timeout: 3000 });
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
      paramsTS: ADMINDATA.serverParamsUpdated,
      uiSelect: ADMINDATA.serverParams.ui || 'velvet'
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
                <span class="card-title">{{ t('admin.settings.uiTitle') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.settings.labelDefaultTheme') }}</b></td>
                      <td>
                        <select v-model="uiSelect" v-on:change="setUi(uiSelect)" style="width:auto;padding:4px 8px">
                          <option value="velvet">{{ t('admin.settings.themeVelvetDefault') }}</option>
                          <option value="velvet-dark">{{ t('admin.settings.themeVelvetDark') }}</option>
                          <option value="velvet-light">{{ t('admin.settings.themeVelvetLight') }}</option>
                        </select>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p style="color:#888;font-size:12px;margin-top:8px">{{ t('admin.settings.themeHint') }}</p>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.settings.securityTitle') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.settings.labelFileUploading') }}</b> {{ params.noUpload === false ? t('admin.settings.fileUploadingEnabled') : t('admin.settings.fileUploadingDisabled') }}</td>
                      <td>
                        <a v-on:click="toggleFileUpload()" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.labelAuthKey') }}</b> ****************{{params.secret}}</td>
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
                <span class="card-title">{{ t('admin.settings.networkTitle') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.settings.labelPort') }}</b> {{params.port}}</td>
                      <td>
                        <a v-on:click="openModal('edit-port-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.labelMaxRequestSize') }}</b> {{params.maxRequestSize}}</td>
                      <td>
                        <a v-on:click="openModal('edit-request-size-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.labelAddress') }}</b> {{params.address}}</td>
                      <td>
                        <a v-on:click="openModal('edit-address-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
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
                  <span class="card-title">{{ t('admin.settings.sslTitle') }}</span>
                  <a v-on:click="openModal('edit-ssl-modal')" class="btn">{{ t('admin.settings.btnAddSslCerts') }}</a>
                </div>
              </div>
              <div v-else>
                <div class="card-content">
                  <span class="card-title">{{ t('admin.settings.sslTitle') }}</span>
                  <table>
                    <tbody>
                      <tr>
                        <td><b>{{ t('admin.settings.labelCert') }}</b> {{params.ssl.cert}}</td>
                      </tr>
                      <tr>
                        <td><b>{{ t('admin.settings.labelKey') }}</b> {{params.ssl.key}}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div class="card-action">
                  <a v-on:click="openModal('edit-ssl-modal')" class="btn">{{ t('admin.settings.btnEditSsl') }}</a>
                  <a v-on:click="removeSSL()" class="btn">{{ t('admin.settings.btnRemoveSsl') }}</a>
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
                        title: this.t('admin.settings.toastCertsDeleted'),
                        position: 'topCenter',
                        timeout: 8500
                      });
                    } catch (err) {
                      iziToast.error({
                        title: this.t('admin.settings.toastFailedDeleteCert'),
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
    setUi: function(ui) {
      API.axios({
        method: 'POST',
        url: `${API.url()}/api/v1/admin/config/theme`,
        data: { ui }
      }).then(() => {
        Vue.set(ADMINDATA.serverParams, 'ui', ui);
        this.uiSelect = ui;
        iziToast.success({ title: this.t('admin.settings.toastThemeUpdated'), position: 'topCenter', timeout: 3000 });
      }).catch(() => {
        this.uiSelect = ADMINDATA.serverParams.ui || 'velvet';
        iziToast.error({ title: this.t('admin.common.failed'), position: 'topCenter', timeout: 3000 });
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
      rebuildingArtists: false,
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
                <span class="card-title">{{ t('admin.db.scanSettingsTitle') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.db.labelScanInterval') }}</b> {{dbParams.scanInterval}} {{ t('admin.db.scanIntervalUnit') }}</td>
                      <td>
                        <a v-on:click="openModal('edit-scan-interval-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelBootScanDelay') }}</b> {{dbParams.bootScanDelay}} {{ t('admin.db.bootScanDelayUnit') }}</td>
                      <td>
                        <a v-on:click="openModal('edit-boot-scan-delay-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelBootScanEnabled') }}</b> {{dbParams.bootScanEnabled}}</td>
                      <td>
                        <a v-on:click="toggleBootScanEnabled()" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelSkipImageMetadata') }}</b> {{dbParams.skipImg}}</td>
                      <td>
                        <a v-on:click="toggleSkipImg()" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelCompressImages') }}</b> {{dbParams.compressImage}}</td>
                      <td>
                        <a v-on:click="recompressImages()" class="btn-sm">{{ t('admin.db.btnRecompress') }}</a>
                        <a v-on:click="toggleCompressImage()" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelMaxConcurrentScans') }}</b> {{dbParams.maxConcurrentTasks}}</td>
                      <td>
                        <a v-on:click="openModal('edit-max-scan-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelAllowId3Edit') }}</b> {{dbParams.allowId3Edit || false}}</td>
                      <td>
                        <a v-on:click="toggleAllowId3Edit()" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelMaxZipSize') }}</b> {{dbParams.maxZipMb || 500}} {{ t('admin.db.maxZipUnit') }}</td>
                      <td>
                        <a v-on:click="openModal('edit-max-zip-mb-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
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
                <span class="card-title">{{ t('admin.db.queueStatsTitle') }}</span>
                <a v-on:click="scanDB" class="btn">{{ t('admin.db.btnStartScan') }}</a>
                <a v-if="scanProgress.length > 0" v-on:click="stopScan" class="btn red" style="margin-left:.5rem">{{ t('admin.db.btnStopScanning') }}</a>
                <a v-on:click="pullStats" class="btn">{{ t('admin.db.btnPullStats') }}</a>
                <a class="btn" :disabled="rebuildingArtists" v-on:click="doRebuildArtists" style="margin-left:.5rem">{{ rebuildingArtists ? t('admin.db.btnRebuildingArtists') : t('admin.db.btnRebuildArtistIndex') }}</a>
                <span v-if="rebuildingArtists" style="display:inline-flex;align-items:center;gap:.4rem;margin-left:.7rem;color:#666;font-size:.92rem;vertical-align:middle;">
                  <svg class="spinner" width="18px" height="18px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
                  {{ t('admin.db.rebuildingArtistMsg') }}
                </span>
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
                      <div class="sc-label">{{ t('admin.db.statTotalTracks') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.totalArtists||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statArtists') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.totalAlbums||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statAlbums') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.totalGenres||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statGenres') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.withArt||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statWithArt') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--t2)">{{(dbStats.withoutArt||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statNoArt') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.artEmbedded||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statArtEmbedded') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.artFromDirectory||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statArtFromFolder') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--accent)">{{(dbStats.artFromDiscogs||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statArtFromDiscogs') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--accent)">{{(dbStats.withReplaygain||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statReplayGain') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--accent)">{{(dbStats.withCue||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statCueFiles') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--t2)">{{(dbStats.cueUnchecked||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statCueNotScanned') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.addedLast7Days||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statAdded7Days') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.addedLast30Days||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statAdded30Days') }}</div>
                    </div>
                    <div class="stat-chip" v-if="dbStats.oldestYear">
                      <div class="sc-num">{{dbStats.oldestYear}}&thinsp;&ndash;&thinsp;{{dbStats.newestYear}}</div>
                      <div class="sc-label">{{ t('admin.db.statYearRange') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--accent)">{{(dbStats.waveformCount||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statWaveforms') }}</div>
                    </div>
                    <div class="stat-chip" v-if="dbStats.totalDurationSec > 0">
                      <div class="sc-num" style="color:var(--primary)">{{formatDuration(dbStats.totalDurationSec)}}</div>
                      <div class="sc-label">{{ t('admin.db.statTotalDuration') }}</div>
                    </div>
                  </div>

                  <div class="stat-section-row">
                    <div class="stat-section" v-if="dbStats.formats.length > 1">
                      <div class="stat-section-title">{{ t('admin.db.statSectionFormats') }}</div>
                      <div v-for="f in dbStats.formats" class="stat-bar-row">
                        <span class="stat-bar-label">{{f.format ? f.format.toUpperCase() : '?'}}</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(f.cnt/dbStats.totalFiles*100)+'%'}"></div></div>
                        <span class="stat-bar-count">{{f.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                    <div class="stat-section" v-if="dbStats.topArtists.length > 0">
                      <div class="stat-section-title">{{ t('admin.db.statSectionTopArtists') }}</div>
                      <div v-for="a in dbStats.topArtists" class="stat-bar-row">
                        <span class="stat-bar-label">{{a.artist}}</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(a.cnt/dbStats.topArtists[0].cnt*100)+'%', background:'var(--accent)'}"></div></div>
                        <span class="stat-bar-count">{{a.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                    <div class="stat-section" v-if="dbStats.topGenres.length > 0">
                      <div class="stat-section-title">{{ t('admin.db.statSectionTopGenres') }}</div>
                      <div v-for="g in dbStats.topGenres" class="stat-bar-row">
                        <span class="stat-bar-label">{{g.genre}}</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(g.cnt/dbStats.topGenres[0].cnt*100)+'%', background:'var(--red)'}"></div></div>
                        <span class="stat-bar-count">{{g.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                    <div class="stat-section" v-if="dbStats.decades && dbStats.decades.length > 1">
                      <div class="stat-section-title">{{ t('admin.db.statSectionMusicByDecade') }}</div>
                      <div v-for="d in dbStats.decades" class="stat-bar-row">
                        <span class="stat-bar-label">{{d.decade}}s</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(d.cnt / Math.max(...dbStats.decades.map(x=>x.cnt)) * 100)+'%', background:'var(--t2)'}"></div></div>
                        <span class="stat-bar-count">{{d.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                    <div class="stat-section" v-if="dbStats.perVpath.length > 1">
                      <div class="stat-section-title">{{ t('admin.db.statSectionTracksPerFolder') }}</div>
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
                <span class="card-title">{{ t('admin.db.sharedPlaylistsTitle') }}</span>
                <a v-on:click="loadShared" class="btn">{{ t('admin.db.btnLoadPlaylists') }}</a>
                <br><br>
                <div v-if="isPullingShared === true">
                  <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
                </div>
                <div v-else-if="sharedPlaylistsTS.ts !== 0 && sharedPlaylists.length > 0">
                  <a v-on:click="deleteUnxpShared" class="btn-sm">{{ t('admin.db.btnDeleteNoExpiry') }}</a>
                  <br>
                  <a v-on:click="deleteExpiredShared" class="btn-sm">{{ t('admin.db.btnDeleteExpired') }}</a>
                  <br>
                  <table>
                    <thead>
                      <tr>
                        <th>{{ t('admin.db.colPlaylistId') }}</th>
                        <th>{{ t('admin.db.colUser') }}</th>
                        <th>{{ t('admin.db.colExpires') }}</th>
                        <th>{{ t('admin.db.colActions') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(v, k) in sharedPlaylists">
                        <th><a target="_blank" v-bind:href="'/shared/'+ v.playlistId">{{v.playlistId}}</a></th>
                        <th>{{v.user}}</th>
                        <th>{{new Date(v.expires * 1000).toLocaleString()}}</th>
                        <th><a v-on:click="deletePlaylist(v)" class="btn-sm btn-sm-delete">{{ t('admin.common.delete') }}</a></th>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div v-else-if="sharedPlaylistsTS.ts !== 0 && sharedPlaylists.length === 0">
                  {{ t('admin.db.noSharedPlaylists') }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    async doRebuildArtists() {
      this.rebuildingArtists = true;
      try {
        // Start rebuild (or get 409 if one is already running) then poll status.
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/artists/rebuild-index` });

        let done = false;
        for (let i = 0; i < 600; i++) { // up to 10 minutes
          await new Promise(r => setTimeout(r, 1000));
          const st = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/artists/rebuild-status` });
          if (st.data && st.data.running === false) {
            done = true;
            if (st.data.lastError) {
              iziToast.error({ title: this.t('admin.db.toastRebuildFailed'), message: st.data.lastError, position: 'topCenter', timeout: 7000 });
            } else {
              iziToast.success({ title: this.t('admin.db.toastArtistIndexRebuilt'), message: this.t('admin.db.toastReloadArtistLibrary'), position: 'topCenter', timeout: 4000 });
            }
            break;
          }
        }
        if (!done) {
          iziToast.error({ title: this.t('admin.db.toastRebuildTimedOut'), message: this.t('admin.db.toastRebuildTimedOutMsg'), position: 'topCenter', timeout: 7000 });
        }
      } catch (e) {
        const msg = (e && e.response && e.response.data && e.response.data.error)
          ? e.response.data.error
          : (e && e.message ? e.message : 'Unknown error');
        // If rebuild is already running, keep loader visible and poll anyway.
        if (e && e.response && e.response.status === 409) {
          try {
            let done = false;
            for (let i = 0; i < 600; i++) {
              await new Promise(r => setTimeout(r, 1000));
              const st = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/artists/rebuild-status` });
              if (st.data && st.data.running === false) {
                done = true;
                if (st.data.lastError) iziToast.error({ title: this.t('admin.db.toastRebuildFailed'), message: st.data.lastError, position: 'topCenter', timeout: 7000 });
                else iziToast.success({ title: this.t('admin.db.toastArtistIndexRebuilt'), message: this.t('admin.db.toastReloadArtistLibrary'), position: 'topCenter', timeout: 4000 });
                break;
              }
            }
            if (!done) iziToast.error({ title: this.t('admin.db.toastRebuildTimedOut'), message: this.t('admin.db.toastRebuildTimedOutMsg'), position: 'topCenter', timeout: 7000 });
          } catch (pollErr) {
            const pmsg = (pollErr && pollErr.message) ? pollErr.message : msg;
            iziToast.error({ title: this.t('admin.db.toastRebuildStatusCheckFailed'), message: pmsg, position: 'topCenter', timeout: 7000 });
          }
        } else {
          iziToast.error({ title: this.t('admin.db.toastRebuildFailed'), message: msg, position: 'topCenter', timeout: 7000 });
        }
      } finally {
        this.rebuildingArtists = false;
      }
    },
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
          title: this.t('admin.db.toastFailedPullData'),
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
          title: this.t('admin.db.toastFailedPullData'),
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
                        title: this.t('admin.db.toastFailedDeletePlaylist'),
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
                        title: this.t('admin.db.toastFailedDeleteSharedPlaylists'),
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
          title: this.t('admin.db.toastFailedPullData'),
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
          title: this.t('admin.db.toastScanStarted'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch (err) {
        iziToast.error({
          title: this.t('admin.db.toastFailedStartScan'),
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    stopScan: async function() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/scan/stop` });
        iziToast.success({ title: this.t('admin.db.toastScanStopped'), position: 'topCenter', timeout: 3500 });
        this.scanProgress = [];
      } catch (err) {
        iziToast.error({ title: this.t('admin.db.toastFailedStopScan'), position: 'topCenter', timeout: 3500 });
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
    toggleBootScanEnabled: function() {
      const enabling = !this.dbParams.bootScanEnabled;
      adminConfirm(
        `<b>${enabling ? 'Enable' : 'Disable'} Boot Scan?</b>`,
        enabling
          ? 'The database will be scanned automatically when the server starts.'
          : 'The database will NOT be scanned on startup. You can still trigger a manual scan at any time.',
        enabling ? 'Enable' : 'Disable',
        () => {
          API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/db/params/boot-scan-enabled`,
            data: { bootScanEnabled: enabling }
          }).then(() => {
            Vue.set(ADMINDATA.dbParams, 'bootScanEnabled', enabling);
            iziToast.success({ title: this.t('admin.common.updated'), position: 'topCenter', timeout: 3500 });
          }).catch(() => {
            iziToast.error({ title: this.t('admin.common.failed'), position: 'topCenter', timeout: 3500 });
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
              <span class="card-title">{{ t('admin.backup.title') }}</span>
              <p style="color:var(--t2);margin-bottom:1rem;">{{ t('admin.backup.desc') }}</p>
              <div v-if="isLoading" style="text-align:center;padding:2rem 0;">
                <svg class="spinner" width="40px" height="40px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else>
                <div v-if="backups.length === 0" style="color:var(--t2);margin:.5rem 0 1rem;">{{ t('admin.backup.noBackups') }}</div>
                <table v-else>
                  <thead>
                    <tr>
                      <th>{{ t('admin.backup.colFilename') }}</th>
                      <th>{{ t('admin.backup.colSize') }}</th>
                      <th>{{ t('admin.backup.colCreated') }}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="b in backups" :key="b.filename">
                      <td style="font-family:monospace;font-size:.85rem;">{{b.filename}}</td>
                      <td>{{formatBytes(b.size)}}</td>
                      <td>{{formatDate(b.mtime)}}</td>
                      <td><a class="btn-sm btn-sm-download" title="Download" style="cursor:pointer;" @click="downloadBackup(b.filename)">{{ t('admin.backup.btnDownload') }}</a></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div class="card-action">
              <button class="btn" type="button" :disabled="isCreating" @click="createBackup()">
                <span v-if="isCreating">{{ t('admin.backup.btnCreating') }}</span>
                <span v-else>{{ t('admin.backup.btnCreate') }}</span>
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
        iziToast.error({ title: this.t('admin.backup.toastFailedLoad'), position: 'topCenter', timeout: 3500 });
      }
      this.isLoading = false;
    },
    createBackup: async function() {
      this.isCreating = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/backup` });
        iziToast.success({ title: this.t('admin.backup.toastCreated'), position: 'topCenter', timeout: 3500 });
        await this.loadBackups();
      } catch (_) {
        iziToast.error({ title: this.t('admin.backup.toastFailed'), position: 'topCenter', timeout: 3500 });
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
        iziToast.error({ title: this.t('admin.backup.toastDownloadFailed'), position: 'topCenter', timeout: 3500 });
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
          <div style="font-size:.8rem;color:var(--t3);margin-top:2px;">{{t('admin.info.adminPanel')}}</div>
        </div>
      </div>
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <h4 style="margin:0 0 .25rem;font-size:1.3rem;font-weight:700;color:var(--t1);"><span style="font-weight:300;color:var(--t2);">m</span><span style="font-weight:700;color:var(--t1);">Stream</span> <span style="font-size:10px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:var(--primary);opacity:.85;vertical-align:middle;position:relative;top:-1px;">Velvet</span> <span style="color:var(--primary);font-size:1rem;">v{{version.val}}</span> <span style="color:var(--t2);font-size:.8rem;font-weight:400;">{{t('admin.info.forkLabel')}}</span></h4>
              <p style="margin:0 0 1.25rem;color:var(--t2);font-size:.85rem;">{{t('admin.info.creditDeveloper')}}<br>{{t('admin.info.creditMaintainer')}}</p>
              <div style="margin-bottom:1.25rem;display:flex;gap:.75rem;flex-wrap:wrap;">
                <a href="https://github.com/aroundmyroom/mStream" target="_blank" style="display:inline-flex;align-items:center;gap:8px;background:var(--raised);border:1px solid var(--border);color:var(--t1);text-decoration:none;padding:.5rem 1rem;border-radius:6px;font-size:.85rem;font-weight:600;">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/></svg>
                  {{t('admin.info.btnGithub')}}
                </a>
                <a href="https://discord.gg/KfsTCYrTkS" target="_blank" style="display:inline-flex;align-items:center;gap:8px;background:#5865F2;color:#fff;text-decoration:none;padding:.5rem 1rem;border-radius:6px;font-size:.85rem;font-weight:600;">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
                  {{t('admin.info.btnDiscord')}}
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
              <span class="card-title">{{t('admin.info.telemetryTitle')}}</span>
              <p style="color:var(--t2);margin-bottom:.75rem;">{{t('admin.info.telemetryDesc')}}</p>
              <p style="color:var(--t2);margin-bottom:.5rem;font-size:.85rem;"><strong style="color:var(--t1);">{{t('admin.info.telemetryDataTitle')}}</strong></p>
              <pre style="background:var(--raised);border:1px solid var(--border);border-radius:6px;padding:.65rem .9rem;font-size:.78rem;color:var(--t2);margin:0 0 1rem;overflow-x:auto;">{"id":"&lt;random UUID, generated once on first boot&gt;","version":"&lt;current version&gt;","platform":"linux","runtime":"docker","lastSeen":"2026-04-04T12:34:49.943Z"}</pre>
              <p style="color:var(--t2);font-size:.85rem;margin-bottom:0;">{{t('admin.info.telemetryPrivacy')}}</p>
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
              <span class="card-title">{{t('admin.serverAudio.title')}} <span style="font-size:.7em;font-weight:400;color:var(--t2)">{{t('admin.serverAudio.subtitleMpv')}}</span></span>
              <p style="color:var(--t2);font-size:.92rem;margin-bottom:18px">
                {{t('admin.serverAudio.desc')}}
                {{t('admin.serverAudio.remoteHint')}}
              </p>
              <div v-if="paramsTS.ts === 0" style="padding:16px 0;display:flex;justify-content:center">
                <svg class="spinner" width="48px" height="48px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{t('admin.serverAudio.labelStatus')}}</b>&nbsp;
                        <span v-if="params.enabled">
                          <span v-if="params.running" style="color:var(--green)">{{t('admin.serverAudio.statusRunning')}}</span>
                          <span v-else style="color:var(--orange,#f97316)">{{t('admin.serverAudio.statusEnabled')}}</span>
                        </span>
                        <span v-else style="color:var(--t3)">{{t('admin.serverAudio.statusDisabled')}}</span>
                      </td>
                      <td><a v-on:click="toggleEnabled()" class="btn-sm btn-sm-edit">{{params.enabled ? t('admin.serverAudio.btnDisable') : t('admin.serverAudio.btnEnable')}}</a></td>
                    </tr>
                    <tr>
                      <td><b>{{t('admin.serverAudio.labelMpvEnabled')}}</b> {{params.enabled ? t('admin.common.yes') || 'Yes' : t('admin.common.no') || 'No'}}</td>
                      <td></td>
                    </tr>
                    <tr>
                      <td><b>{{t('admin.serverAudio.labelMpvPath')}}</b> <code>{{params.mpvBin || 'mpv'}}</code></td>
                      <td>
                        <a v-on:click="changeMpvBin()" class="btn-sm btn-sm-edit">{{t('admin.common.edit')}}</a>
                      </td>
                    </tr>
                    <tr>
                      <td colspan="2" style="padding-top:10px;padding-bottom:4px">
                        <a v-on:click="detectMpv()" class="btn-sm" style="margin-right:6px">{{t('admin.serverAudio.btnDetectMpv')}}</a>
                        <a v-on:click="startMpv()"  class="btn-sm" style="margin-right:6px">{{t('admin.serverAudio.btnStart')}}</a>
                        <a v-on:click="stopMpv()"   class="btn-sm">{{t('admin.serverAudio.btnStop')}}</a>
                      </td>
                    </tr>
                    <tr v-if="detectResult !== null">
                      <td colspan="2" style="font-size:.87rem;color:var(--t2)">
                        <span v-if="detectResult.found" style="color:var(--green)">
                          {{t('admin.serverAudio.detectFound', { version: detectResult.version, path: detectResult.path })}}
                        </span>
                        <span v-else style="color:var(--red)">
                          {{t('admin.serverAudio.detectNotFound', { path: detectResult.path })}}
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td colspan="2" style="padding-top:12px">
                        <a href="/server-remote" target="_blank" class="btn-sm btn-sm-edit">{{t('admin.serverAudio.btnOpenRemote')}}</a>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{t('admin.serverAudio.howItWorksTitle')}}</span>
              <ul style="color:var(--t2);font-size:.9rem;line-height:1.7;padding-left:1.2em;list-style:disc">
                <li>{{t('admin.serverAudio.how1')}}</li>
                <li>{{t('admin.serverAudio.how2')}}</li>
                <li>{{t('admin.serverAudio.how3')}}</li>
                <li>{{t('admin.serverAudio.how4before')}} <a href="https://github.com/AroundMyRoom/mStream/blob/master/docs/server-audio.md" target="_blank" style="color:var(--primary)">{{t('admin.serverAudio.how4link')}}</a> {{t('admin.serverAudio.how4after')}}</li>
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
        `<b>${next ? this.t('admin.serverAudio.confirmEnableTitle') : this.t('admin.serverAudio.confirmDisableTitle')}</b>`,
        next ? this.t('admin.serverAudio.confirmEnableMsg') : this.t('admin.serverAudio.confirmDisableMsg'),
        next ? this.t('admin.common.enable') : this.t('admin.common.disable'),
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
        <span class="powered-by-label">{{t('admin.transcode.poweredBy')}}</span>
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
              <span class="card-title">{{t('admin.transcode.settingsTitle')}}</span>
              <table>
                <tbody>
                  <tr>
                    <td><b>{{t('admin.transcode.labelEnabled')}}</b> {{params.enabled === true ? t('admin.common.enabled') : t('admin.common.disabled')}}</td>
                    <td>
                      <a v-on:click="toggleEnabled()" class="btn-sm btn-sm-edit">{{t('admin.common.edit')}}</a>
                    </td>
                  </tr>
                  <tr>
                    <td><b>{{t('admin.transcode.labelFfmpegDir')}}</b> {{params.ffmpegDirectory}}</td>
                    <td style="color:var(--t2);font-size:.82rem">{{t('admin.transcode.editInConfig')}}</td>
                  </tr>
                  <tr>
                    <td><b>{{t('admin.transcode.labelFfmpegDownloaded')}}</b> {{downloadPending.val === true ? t('admin.transcode.pending') : params.downloaded}}</td>
                    <td>
                      <a v-on:click="downloadFFMpeg()" class="btn-sm">{{t('admin.transcode.btnDownload')}}</a>
                    </td>
                  </tr>
                  <tr>
                    <td><b>{{t('admin.transcode.labelDefaultCodec')}}</b> {{params.defaultCodec}}</td>
                    <td>
                      <a v-on:click="changeCodec()" class="btn-sm btn-sm-edit">{{t('admin.common.edit')}}</a>
                    </td>
                  </tr>
                  <tr>
                    <td><b>{{t('admin.transcode.labelDefaultBitrate')}}</b> {{params.defaultBitrate}}</td>
                    <td>
                      <a v-on:click="changeBitrate()" class="btn-sm btn-sm-edit">{{t('admin.common.edit')}}</a>
                    </td>
                  </tr>
                  <tr>
                  <td><b>{{t('admin.transcode.labelDefaultAlgorithm')}}</b> {{params.algorithm}}</td>
                  <td>
                    <a v-on:click="changeAlgorithm()" class="btn-sm btn-sm-edit">{{t('admin.common.edit')}}</a>
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
            adminConfirm(
              `<b>${this.params.enabled === true ? this.t('admin.transcode.confirmDisableTitle') : this.t('admin.transcode.confirmEnableTitle')}</b>`,
              this.t('admin.transcode.confirmToggleMsg'),
              this.params.enabled === true ? this.t('admin.common.disable') : this.t('admin.common.enable'),
              async () => {
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
                        title: this.t('admin.common.updatedSuccessfully'),
                        position: 'topCenter',
                        timeout: 3500
                      });
                    } catch (err) {
                      iziToast.error({
                        title: this.t('admin.common.failed'),
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }
      }
      );
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
          title: this.t('admin.transcode.toastFfmpegDownloaded'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch (err) {
        iziToast.error({
          title: this.t('admin.transcode.toastFailedDownload'),
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
        <div class="tab"><button :class="{active: activeTab==='federation'}" @click="activeTab='federation'">{{t('admin.federation.tabFederation')}}</button></div>
        <div class="tab"><button :class="{active: activeTab==='syncthing'}" @click="activeTab='syncthing'; setSyncthingUrl()">{{t('admin.federation.tabSyncthing')}}</button></div>
      </div>
      <div id="sync-tab-1" v-show="activeTab==='federation'">
        <div class="container">
          <div class="row">
            <div class="col s12">
              <div class="card">
                <div class="card-content">
                  <span class="card-title">{{t('admin.federation.title')}}</span>
                  <table>
                    <tbody>
                      <tr>
                        <td><b>{{t('admin.federation.labelDeviceId')}}</b> {{params.deviceId}}</td>
                      </tr>
                    </tbody>
                  </table>
                  <button type="button" class="btn-flat btn-small" style="margin-top:.25rem;" @click="openFederationGenerateInviteModal()">{{t('admin.federation.btnGenerateInvite')}}</button>
                </div>
                <div class="card-action flow-root">
                  <a v-on:click="enableFederation()" v-bind:class="{ 'red': enabled.val }" class="btn">{{enabled.val ? t('admin.federation.btnDisable') : t('admin.federation.btnEnable')}}</a>
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
                  <span class="card-title">{{t('admin.federation.acceptInviteTitle')}}</span>
                  <div class="row">
                    <div class="col s12 m12 l6">
                      <div class="row">
                        <div class="col s12">
                          <label for="fed-invite-token">{{t('admin.federation.labelToken')}}</label>
                          <textarea id="fed-invite-token" v-model="currentToken" style="height: auto;" rows="4" cols="60" :placeholder="t('admin.federation.tokenPlaceholder')"></textarea>
                        </div>
                      </div>
                      <div class="input-field" style="margin-top:.5rem;">
                        <label for="fed-invite-url">{{t('admin.federation.labelServerUrl')}}</label>
                        <input id="fed-invite-url" v-model="inviteServerUrl" type="text" placeholder="https://your-server.example.com">
                      </div>
                    </div>
                    <div class="col s12 m12 l6">
                      <form @submit.prevent="acceptInvite" v-if="parsedTokenData !== null">
                        <p>{{t('admin.federation.labelSelectFolders')}}</p>
                        <div v-for="(item, key, index) in parsedTokenData.vPaths">
                          <label>
                            <input type="checkbox" checked/>
                            <span>{{key}}</span>
                          </label>
                        </div>
                        <button class="btn" type="submit" :disabled="submitPending === true">
                          {{submitPending === false ? t('admin.federation.btnAcceptInvite') : t('admin.federation.btnWorking')}}
                        </button>
                      </form>
                      <div v-else>
                        <p>{{t('admin.federation.tokenHint')}}</p>
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
          title: this.t('admin.federation.toastFailedAccept'),
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
      adminConfirm(
        this.enabled.val === true ? this.t('admin.federation.confirmDisableTitle') : this.t('admin.federation.confirmEnableTitle'),
        '',
        this.enabled.val === true ? this.t('admin.common.disable') : this.t('admin.common.enable'),
        async () => {
        try {
          this.enablePending = true;
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/federation/enable`,
            data: { enable: !this.enabled.val }
          });
          Vue.set(ADMINDATA.federationEnabled, 'val', !this.enabled.val);
          iziToast.success({
            title: this.enabled.val === true ? this.t('admin.federation.toastEnabled') : this.t('admin.federation.toastDisabled'),
            position: 'topCenter',
            timeout: 3500
          });
        } catch(err) {
          iziToast.error({
            title: this.t('admin.federation.toastToggleFailed'),
            position: 'topCenter',
            timeout: 3500
          });
        } finally {
          this.enablePending = false;
        }
      }
      );
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
          <span class="powered-by-label">{{t('admin.federation.poweredBy')}}</span>
          <svg xmlns="http://www.w3.org/2000/svg" class="syncthing-logo" viewBox="0 0 429 117.3"><linearGradient id="a" gradientUnits="userSpaceOnUse" x1="58.666" y1="117.332" x2="58.666" y2="0"><stop offset="0" stop-color="#0882c8"/><stop offset="1" stop-color="#26b6db"/></linearGradient><circle fill="url(#a)" cx="58.7" cy="58.7" r="58.7"/><circle fill="none" stroke="#FFF" stroke-width="6" stroke-miterlimit="10" cx="58.7" cy="58.5" r="43.7"/><path fill="#FFF" d="M94.7 47.8c4.7 1.6 9.8-.9 11.4-5.6 1.6-4.7-.9-9.8-5.6-11.4-4.7-1.6-9.8.9-11.4 5.6-1.6 4.7.9 9.8 5.6 11.4z"/><path fill="none" stroke="#FFF" stroke-width="6" stroke-miterlimit="10" d="M97.6 39.4l-30.1 25"/><path fill="#FFF" d="M77.6 91c-.4 4.9 3.2 9.3 8.2 9.8 5 .4 9.3-3.2 9.8-8.2.4-4.9-3.2-9.3-8.2-9.8-5-.4-9.4 3.2-9.8 8.2z"/><path fill="none" stroke="#FFF" stroke-width="6" stroke-miterlimit="10" d="M86.5 91.8l-19-27.4"/><path fill="#FFF" d="M60 69.3c2.7 4.2 8.3 5.4 12.4 2.7 4.2-2.7 5.4-8.3 2.7-12.4-2.7-4.2-8.3-5.4-12.4-2.7-4.2 2.6-5.4 8.2-2.7 12.4z"/><g><path fill="#FFF" d="M21.2 61.4c-4.3-2.5-9.8-1.1-12.3 3.1-2.5 4.3-1.1 9.8 3.1 12.3 4.3 2.5 9.8 1.1 12.3-3.1s1.1-9.7-3.1-12.3z"/><path fill="none" stroke="#FFF" stroke-width="6" stroke-miterlimit="10" d="M16.6 69.1l50.9-4.7"/></g><g fill="#0891D1"><path d="M163.8 50.2c-.6-.7-6.3-4.1-11.4-4.1-3.4 0-5.2 1.2-5.2 3.5 0 2.9 3.2 3.7 8.9 5.2 8.2 2.2 13.3 5 13.3 12.9 0 9.7-7.8 13-16 13-6.2 0-13.1-2-18.2-5.3l4.3-8.6c.8.8 7.5 5 14 5 3.5 0 5.2-1.1 5.2-3.2 0-3.2-4.4-4-10.3-5.8-7.9-2.4-11.5-5.3-11.5-11.8 0-9 7.2-13.9 15.7-13.9 6.1 0 11.6 2.5 15.4 4.7l-4.2 8.4zM175 85.1c1.7.5 3.3.8 4.4.8 2 0 3.3-1.5 4.2-5.5l-11.9-31.5h9.8l7.4 23.3 6.3-23.3h8.9L192 85.5c-1.7 5.3-6.2 8.7-11.8 8.8-1.7 0-3.5-.2-5.3-.9v-8.3zM239.3 80.3h-9.6V62.6c0-4.1-1.7-5.9-4.3-5.9-2.6 0-5.8 2.3-7 5.6v18.1h-9.6V48.8h8.6v5.3c2.3-3.7 6.8-5.9 12.2-5.9 8.2 0 9.5 6.7 9.5 11.9v20.2zM261.6 48.2c7.2 0 12.3 3.4 14.8 8.3l-9.4 2.8c-1.2-1.9-3.1-3-5.5-3-4 0-7 3.2-7 8.2 0 5 3.1 8.3 7 8.3 2.4 0 4.6-1.3 5.5-3.1l9.4 2.9c-2.3 4.9-7.6 8.3-14.8 8.3-10.6 0-16.9-7.7-16.9-16.4s6.2-16.3 16.9-16.3zM302.1 78.7c-2.6 1.1-6.2 2.3-9.7 2.3-4.7 0-8.8-2.3-8.8-8.4V56.1h-4v-7.3h4v-10h9.6v10h6.4v7.3h-6.4v13.1c0 2.1 1.2 2.9 2.8 2.9 1.4 0 3-.6 4.2-1.1l1.9 7.7zM337.2 80.3h-9.6V62.6c0-4.1-1.8-5.9-4.6-5.9-2.3 0-5.5 2.2-6.7 5.6v18.1h-9.6V36.5h9.6v17.6c2.3-3.7 6.3-5.9 10.9-5.9 8.5 0 9.9 6.5 9.9 11.9v20.2zM343.4 45.2v-8.7h9.6v8.7h-9.6zm0 35.1V48.8h9.6v31.5h-9.6zM389.9 80.3h-9.6V62.6c0-4.1-1.7-5.9-4.3-5.9-2.6 0-5.8 2.3-7 5.6v18.1h-9.6V48.8h8.6v5.3c2.3-3.7 6.8-5.9 12.2-5.9 8.2 0 9.5 6.7 9.5 11.9v20.2zM395.5 64.6c0-9.2 6-16.3 14.6-16.3 4.7 0 8.4 2.2 10.6 5.8v-5.2h8.3v29.3c0 9.6-7.5 15.5-18.2 15.5-6.8 0-11.5-2.3-15-6.3l5.1-5.2c2.3 2.6 6 4.3 9.9 4.3 4.6 0 8.6-2.4 8.6-8.3v-3.1c-1.9 3.5-5.9 5.3-10 5.3-8.3.1-13.9-7.1-13.9-15.8zm23.9 3.9v-6.6c-1.3-3.3-4.2-5.5-7.1-5.5-4.1 0-7 4-7 8.4 0 4.6 3.2 8 7.5 8 2.9 0 5.3-1.8 6.6-4.3z"/></g></svg>
        </div>
        <a v-on:click="enableFederation()" class="btn-large">{{t('admin.federation.btnEnable')}}</a>
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
          title: this.enabled.val === true ? this.t('admin.federation.toastEnabled') : this.t('admin.federation.toastDisabled'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch(err) {
        iziToast.error({
          title: this.t('admin.federation.toastToggleFailed'),
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
                <span class="card-title">{{ t('admin.logs.title') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.logs.labelWriteLogs') }}</b> {{params.writeLogs === true ? t('admin.logs.writeLogsEnabled') : t('admin.logs.writeLogsDisabled')}}</td>
                      <td>
                        <a v-on:click="toggleWriteLogs" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.logs.labelLogsDirectory') }}</b> {{params.storage.logsDirectory}}</td>
                      <td style="color:var(--t2);font-size:.82rem">{{ t('admin.settings.editInConfigHint') }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="card-action">
                <a v-on:click="downloadLogs()" class="btn">{{ t('admin.logs.btnDownload') }}</a>
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
          title: this.t('admin.logs.toastDownloadFailed'),
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
          <span class="card-title">{{ t('admin.lock.title') }}</span>
          <p style="color:var(--t2);">{{ t('admin.lock.desc') }}</p>
          <p style="color:var(--t2);">{{ t('admin.lock.reenableIntro') }}</p>
          <ul style="color:var(--t2);padding-left:1.25rem;margin:.25rem 0 1rem;line-height:1.9;">
            <li>{{ t('admin.lock.step1') }}</li>
            <li>{{ t('admin.lock.step2') }}</li>
            <li>{{ t('admin.lock.step3') }}</li>
          </ul>
        </div>
        <div class="card-action">
          <button class="btn red" type="button" @click="disableAdmin()">{{ t('admin.lock.btnDisable') }}</button>
        </div>
      </div>
    </div>`,

    methods: {
      disableAdmin: function() {
                adminConfirm(this.t('admin.lock.confirmTitle'), '', this.t('admin.lock.confirmLabel'), () => {
          API.axios({
                          method: 'POST',
                          url: `${API.url()}/api/v1/admin/lock-api`,
                          data: { lock: true }
                        }).then(() => {
                          window.location.reload();
                        }).catch(() => {
                          iziToast.error({
                            title: this.t('admin.lock.toastFailed'),
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
              <span class="card-title">{{ t('admin.lyrics.title') }}</span>
              <p style="margin-bottom:0.5rem;">{{t('admin.lyrics.desc1before')}} <a href="https://lrclib.net" target="_blank" rel="noopener">lrclib.net</a> {{t('admin.lyrics.desc1after')}}</p>
              <p style="margin-bottom:1rem;font-size:0.85rem;color:#999;">{{t('admin.lyrics.desc2')}}</p>
              <table>
                <tbody>
                  <tr>
                    <td style="width:140px"><b>{{ t('admin.lyrics.labelEnable') }}</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.lyrics.checkboxEnable') }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
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
        iziToast.success({ title: this.t('admin.lyrics.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch(err) {
        iziToast.error({ title: this.t('admin.lyrics.toastFailed'), position: 'topCenter', timeout: 3000 });
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
              <span class="card-title">{{ t('admin.lastfm.title') }}</span>
              <p style="margin-bottom:0.5rem;">{{t('admin.lastfm.desc1')}} <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener">{{t('admin.lastfm.ownKeyLink')}}</a>.</p>
              <p style="margin-bottom:1rem;font-size:0.85rem;color:#999;">{{t('admin.lastfm.secretHint')}}</p>
              <table>
                <tbody>
                  <tr>
                    <td style="width:140px"><b>{{ t('admin.lastfm.labelEnable') }}</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.lastfm.checkboxEnable') }}</td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.lastfm.labelApiKey') }}</b></td>
                    <td><input v-model="apiKey" type="text" :placeholder="t('admin.lastfm.apiKeyPlaceholder')" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore spellcheck="false" style="margin:0" /></td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.lastfm.labelSharedSecret') }}</b></td>
                    <td><input v-model="apiSecret" type="password" :placeholder="t('admin.lastfm.secretPlaceholder')" autocomplete="new-password" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore style="margin:0" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
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
        iziToast.success({ title: this.t('admin.lastfm.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch(err) {
        iziToast.error({ title: this.t('admin.lastfm.toastFailed'), position: 'topCenter', timeout: 3000 });
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
              <span class="card-title">{{ t('admin.listenbrainz.title') }}</span>
              <p style="margin-bottom:1rem;">{{t('admin.listenbrainz.desc1')}} <a href="https://listenbrainz.org/profile/" target="_blank" rel="noopener">{{t('admin.listenbrainz.profileLink')}}</a>.</p>
              <table><tbody>
                <tr>
                  <td style="width:140px"><b>{{ t('admin.listenbrainz.labelEnable') }}</b></td>
                  <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.listenbrainz.checkboxEnable') }}</td>
                </tr>
              </tbody></table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
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
        iziToast.success({ title: this.t('admin.listenbrainz.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch(err) {
        iziToast.error({ title: this.t('admin.listenbrainz.toastFailed'), position: 'topCenter', timeout: 3000 });
      } finally { this.pending = false; }
    }
  }
});

const languagesView = Vue.component('languages-view', {
  data() {
    return {
      all: [
        { code: 'en', name: 'English' },
        { code: 'nl', name: 'Nederlands' },
        { code: 'de', name: 'Deutsch' },
        { code: 'fr', name: 'Français' },
        { code: 'es', name: 'Español' },
        { code: 'it', name: 'Italiano' },
        { code: 'pt', name: 'Português' },
        { code: 'pl', name: 'Polski' },
        { code: 'ru', name: 'Русский' },
        { code: 'zh', name: '中文' },
        { code: 'ja', name: '日本語' },
        { code: 'ko', name: '한국어' },
      ],
      enabled: [],
      pending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.languages.title') }}</span>
              <p style="margin-bottom:1rem;">{{ t('admin.languages.desc') }}</p>
              <table>
                <tbody>
                  <tr v-for="lang in all" :key="lang.code">
                    <td style="width:40px;padding:6px 4px;">
                      <input
                        type="checkbox"
                        :checked="isEnabled(lang.code)"
                        :disabled="lang.code === 'en'"
                        @change="toggle(lang.code)"
                        style="margin:0;width:auto;height:auto;"
                      />
                    </td>
                    <td style="padding:6px 8px;"><b>{{ lang.name }}</b> <small style="color:#888;">({{ lang.code }})</small></td>
                    <td style="padding:6px 4px;color:#888;font-size:.82rem;font-style:italic;">
                      <span v-if="lang.code === 'en'">{{ t('admin.languages.alwaysOn') }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" @click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/languages/config` });
      this.enabled = res.data.enabled || this.all.map(l => l.code);
    } catch(e) {
      this.enabled = this.all.map(l => l.code);
    }
  },
  methods: {
    isEnabled(code) {
      return code === 'en' || this.enabled.includes(code);
    },
    toggle(code) {
      if (code === 'en') return;
      const idx = this.enabled.indexOf(code);
      if (idx === -1) this.enabled = [...this.enabled, code];
      else this.enabled = this.enabled.filter(c => c !== code);
    },
    save: async function() {
      this.pending = true;
      try {
        const toSave = ['en', ...this.enabled.filter(c => c !== 'en')];
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/languages/config`,
          data: { enabled: toSave }
        });
        iziToast.success({ title: this.t('admin.languages.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch(err) {
        iziToast.error({ title: this.t('admin.languages.toastFailed'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.pending = false;
      }
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
      itunesEnabled: true,
      deezerEnabled: true,
      pending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.discogs.title') }}</span>
              <p style="margin-bottom:0.5rem;">{{t('admin.discogs.desc1')}}</p>
              <p style="margin-bottom:0.5rem;">{{t('admin.discogs.desc2')}}</p>
              <p style="margin-bottom:1rem; font-size:0.85rem; color:#999;">{{t('admin.discogs.secretHint')}}</p>
              <table>
                <tbody>
                  <tr>
                    <td style="width:160px"><b>{{ t('admin.discogs.labelEnable') }}</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.discogs.checkboxEnable') }}</td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.discogs.labelAllowArtUpdate') }}</b></td>
                    <td>
                      <input type="checkbox" v-model="allowArtUpdate" style="margin:0;width:auto;height:auto;" /> {{ t('admin.discogs.checkboxAllowArtUpdate') }}
                      <div style="font-size:0.78rem;color:#999;margin-top:4px;">{{t('admin.discogs.allowArtUpdateDesc')}}</div>
                    </td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.discogs.labelApiKey') }}</b></td>
                    <td><input v-model="apiKey" type="text" :placeholder="t('admin.discogs.apiKeyPlaceholder')" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore spellcheck="false" style="margin:0" /></td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.discogs.labelApiSecret') }}</b></td>
                    <td><input v-model="apiSecret" type="password" :placeholder="t('admin.discogs.apiSecretPlaceholder')" autocomplete="new-password" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore style="margin:0" /></td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.discogs.labelInstanceTag') }}</b></td>
                    <td>
                      <input v-model="userAgentTag" type="text" maxlength="4" placeholder="e.g. amr" autocomplete="off" spellcheck="false" style="margin:0;width:80px;text-transform:lowercase" />
                      <div style="font-size:0.78rem;color:#999;margin-top:4px;">{{t('admin.discogs.instanceTagDesc')}}</div>
                    </td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.discogs.labelItunes') }}</b></td>
                    <td>
                      <input type="checkbox" v-model="itunesEnabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.discogs.checkboxItunes') }}
                      <div style="font-size:0.78rem;color:#999;margin-top:4px;">{{t('admin.discogs.itunesDesc')}}</div>
                    </td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.discogs.labelDeezer') }}</b></td>
                    <td>
                      <input type="checkbox" v-model="deezerEnabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.discogs.checkboxDeezer') }}
                      <div style="font-size:0.78rem;color:#999;margin-top:4px;">{{t('admin.discogs.deezerDesc')}}</div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
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
      this.itunesEnabled  = res.data.itunesEnabled !== false;
      this.deezerEnabled  = res.data.deezerEnabled !== false;
    } catch(e) { /* ignore */ }
  },
  methods: {
    save: async function() {
      this.pending = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/discogs/config`,
          data: {
            enabled: this.enabled,
            allowArtUpdate: this.allowArtUpdate,
            apiKey: this.apiKey.trim(),
            apiSecret: this.apiSecret.trim(),
            userAgentTag: this.userAgentTag.trim().slice(0,4).replace(/[^a-zA-Z0-9]/g,''),
            itunesEnabled: this.itunesEnabled,
            deezerEnabled: this.deezerEnabled,
          }
        });
        iziToast.success({ title: this.t('admin.discogs.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch(err) {
        iziToast.error({ title: this.t('admin.discogs.toastFailed'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.pending = false;
      }
    }
  }
});

const acoustidView = Vue.component('acoustid-view', {
  data() {
    return {
      enabled:  false,
      apiKey:   '',
      hasKey:   false,
      pending:  false,
      // worker status
      running:  false,
      stopping: false,
      stats: { total: 0, found: 0, not_found: 0, errors: 0, pending: 0, queued: 0 },
      _pollTimer: null,
    };
  },
  computed: {
    fingerprinted() { return (this.stats.found || 0) + (this.stats.not_found || 0); },
    pct() {
      const t = this.stats.total || 0;
      if (!t) return 0;
      return Math.round((this.fingerprinted / t) * 100);
    },
    statusLabel() {
      if (this.stopping) return this.t('admin.acoustid.statusStopping');
      if (this.running)  return this.t('admin.acoustid.statusRunning');
      return this.t('admin.acoustid.statusIdle');
    },
    statusColor() {
      if (this.running)  return 'var(--accent)';
      if (this.stopping) return '#f0a500';
      return '#888';
    },
    canStart() {
      return this.enabled && this.hasKey && !this.running && !this.stopping;
    },
    canStop() {
      return this.running && !this.stopping;
    },
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">

          <!-- Settings card -->
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.acoustid.title') }}</span>
              <p style="margin-bottom:0.5rem;">{{ t('admin.acoustid.desc1') }}</p>
              <p style="margin-bottom:0.5rem; font-size:0.85rem; color:#999;">{{ t('admin.acoustid.secretHint') }}</p>
              <div v-if="!hasKey" style="background:#3a2a00;border-left:3px solid #f0a500;padding:8px 12px;border-radius:4px;margin-bottom:1rem;font-size:0.85rem;">
                ⚠ {{ t('admin.acoustid.warnNoKey') }}
              </div>
              <table>
                <tbody>
                  <tr>
                    <td style="width:160px"><b>{{ t('admin.acoustid.labelEnable') }}</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.acoustid.checkboxEnable') }}</td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.acoustid.labelApiKey') }}</b></td>
                    <td>
                      <input v-model="apiKey" type="password"
                        :placeholder="t('admin.acoustid.apiKeyPlaceholder')"
                        autocomplete="new-password" data-form-type="other"
                        data-lpignore="true" data-1p-ignore data-bwignore
                        spellcheck="false" style="margin:0;font-family:monospace;" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
              </button>
            </div>
          </div>

          <!-- Progress card -->
          <div class="card">
            <div class="card-content">
              <span class="card-title">
                {{ t('admin.acoustid.progressTitle') }}
                <span :style="{ color: statusColor, fontSize: '0.75rem', marginLeft: '10px', fontWeight: 'normal' }">
                  ● {{ statusLabel }}
                </span>
              </span>
              <div style="margin-bottom:1rem;">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:0.9rem;">
                  <span>{{ t('admin.acoustid.statsFingerprinted') }}: <b>{{ fingerprinted.toLocaleString() }} / {{ stats.total.toLocaleString() }}</b></span>
                  <span><b>{{ pct }}%</b></span>
                </div>
                <div style="background:#333;border-radius:4px;height:8px;overflow:hidden;">
                  <div :style="{ width: pct + '%', background: 'var(--accent)', height: '100%', transition: 'width 0.5s' }"></div>
                </div>
              </div>
              <table style="font-size:0.85rem;width:auto;">
                <tbody>
                  <tr>
                    <td style="padding:2px 12px 2px 0;color:#4caf50;">{{ t('admin.acoustid.statsFound') }}</td>
                    <td><b>{{ (stats.found||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 12px 2px 0;color:#888;">{{ t('admin.acoustid.statsNotFound') }}</td>
                    <td><b>{{ (stats.not_found||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 12px 2px 0;color:#e57373;">{{ t('admin.acoustid.statsErrors') }}</td>
                    <td><b>{{ (stats.errors||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 12px 2px 0;color:#aaa;">{{ t('admin.acoustid.statsQueued') }}</td>
                    <td><b>{{ (stats.queued||0).toLocaleString() }}</b></td>
                  </tr>
                </tbody>
              </table>
              <p style="margin-top:0.75rem;font-size:0.78rem;color:#888;">{{ t('admin.acoustid.rateNote') }}</p>
            </div>
            <div class="card-action" style="display:flex;gap:0.5rem;">
              <button class="btn" v-on:click="startScan()" :disabled="!canStart">
                {{ t('admin.acoustid.btnStart') }}
              </button>
              <button class="btn btn-flat" v-on:click="stopScan()" :disabled="!canStop" style="margin-left:0;">
                {{ stopping ? t('admin.acoustid.btnStopping') : t('admin.acoustid.btnStop') }}
              </button>
            </div>
          </div>

        </div>
      </div>
    </div>`,
  async mounted() {
    await this.loadConfig();
    await this.loadStatus();
    // Poll status every 5 s while component is mounted
    this._pollTimer = setInterval(() => this.loadStatus(), 5000);
  },
  beforeUnmount() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },
  methods: {
    async loadConfig() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/acoustid/config` });
        this.enabled = !!res.data.enabled;
        this.apiKey  = res.data.apiKey  || '';
        this.hasKey  = !!res.data.hasKey;
      } catch(_e) {}
    },
    async loadStatus() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/acoustid/status` });
        this.running  = !!res.data.running;
        this.stopping = !!res.data.stopping;
        if (res.data.stats) this.stats = res.data.stats;
      } catch(_e) {}
    },
    async save() {
      this.pending = true;
      try {
        await API.axios({
          method: 'POST',
          url:  `${API.url()}/api/v1/admin/acoustid/config`,
          data: { enabled: this.enabled, apiKey: this.apiKey.trim() },
        });
        iziToast.success({ title: this.t('admin.acoustid.toastSaved'), position: 'topCenter', timeout: 3000 });
        await this.loadConfig();
      } catch(_err) {
        iziToast.error({ title: this.t('admin.acoustid.toastFailed'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.pending = false;
      }
    },
    async startScan() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/acoustid/start` });
        await this.loadStatus();
      } catch(err) {
        const msg = err?.response?.data?.error || err.message || 'Unknown error';
        iziToast.error({ title: msg, position: 'topCenter', timeout: 4000 });
      }
    },
    async stopScan() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/acoustid/stop` });
        this.stopping = true;
      } catch(_err) {}
    },
  }
});

const tagWorkshopView = Vue.component('tagworkshop-view', {
  data() {
    return {
      // status overview
      mb: { total: 0, done: 0, errors: 0, no_data: 0, queued: 0, acoustid_attempted: 0, acoustid_found: 0 },
      tags: { needs_review: 0, confirmed: 0, accepted: 0, skipped: 0 },
      enrich: { running: false, stopping: false },
      // album list
      albums: [], total: 0, page: 1, pageSize: 40,
      filter: 'all', sort: 'broken',
      search: '', searchDebounce: null,
      pageJump: '',
      // shelved tab
      tab: 'review',  // 'review' | 'shelved'
      shelvedAlbums: [], shelvedTotal: 0, shelvedPage: 1,
      // multi-select + batch accept
      selectedAlbums: [],
      batchRunning: false,
      batchAlbumDone: 0,
      batchAlbumTotal: 0,
      batchTrackDone: 0,
      batchTrackTotal: 0,
      batchCurrentAlbum: '',
      _lastFilter: '', _lastSort: '',
      // album detail modal
      showDetail: false,
      detailTracks: [],
      detailEdits: {},
      detailReleaseId: '',
      detailAlbumDir: '',
      detailLabel: '',
      detailArtistOverride: '',
      detailAlbumOverride: '',
      acceptErrors: [],
      acceptWriteDone: 0,
      acceptWriteTotal: 0,
      pending: false,
      bulkCasingConfirm: false,
      showEnrichErrors: false,
      enrichErrors: [],
      msg: '',
    };
  },
  computed: {
    totalPages() { return Math.ceil(this.total / (this.pageSize || 20)); },
    shelvedTotalPages() { return Math.ceil(this.shelvedTotal / (this.pageSize || 20)); },
    enrichProgress() {
      if (!this.mb.total) return 0;
      return Math.round(((this.mb.done + this.mb.errors + this.mb.no_data) / this.mb.total) * 100);
    },
    allOnPageSelected() {
      return this.albums.length > 0 && this.albums.every(a => this.isSelected(a));
    },
  },
  mounted() { this.loadStatus(); this.loadAlbums(); this.loadShelved(); },
  beforeUnmount() {
    if (this._statusTimer) { clearTimeout(this._statusTimer); this._statusTimer = null; }
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
      <div class="card">
        <div class="card-content">
        <span class="card-title">{{ t('admin.tagworkshop.title') }}</span>
        <p style="margin-bottom:0.5rem; color:#aaa; font-size:0.88rem;">{{ t('admin.tagworkshop.desc') }}</p>
        <div style="background:rgba(255,255,255,0.04); border-left:3px solid var(--primary); border-radius:0 4px 4px 0; padding:0.5rem 0.75rem; margin-bottom:1rem; font-size:0.82rem; color:#bbb; line-height:1.7;">
          <div>ℹ {{ t('admin.tagworkshop.infoWriteFiles') }}</div>
          <div>ℹ {{ t('admin.tagworkshop.infoNoRecentlyAdded') }}</div>
        </div>

        <!-- Step 1: MB Enrichment section -->
        <div style="background:var(--raised2); border-radius:8px; padding:1rem; margin-bottom:1.25rem;">
          <b style="display:block; margin-bottom:0.25rem;">{{ t('admin.tagworkshop.enrichTitle') }}</b>
          <p style="color:#aaa; font-size:0.82rem; margin:0 0 0.75rem 0;">{{ t('admin.tagworkshop.enrichHint') }}</p>

          <!-- Prereq: AcoustID never ran -->
          <div v-if="mb.acoustid_attempted === 0" style="background:rgba(255,152,0,0.1); border:1px solid rgba(255,152,0,0.35); border-radius:6px; padding:0.65rem 0.9rem; margin-bottom:0.85rem; font-size:0.83rem; color:#ffb74d; line-height:1.6;">
            ⚠ {{ t('admin.tagworkshop.prereqNoAcoustid') }}
            <span style="display:block; margin-top:0.2rem; font-size:0.78rem; color:#e6a020;">{{ t('admin.tagworkshop.prereqNoAcoustidHint') }}</span>
          </div>
          <!-- Prereq: AcoustID ran but zero matches -->
          <div v-else-if="mb.acoustid_found === 0" style="background:rgba(229,115,115,0.08); border:1px solid rgba(229,115,115,0.3); border-radius:6px; padding:0.65rem 0.9rem; margin-bottom:0.85rem; font-size:0.83rem; color:#ef9a9a; line-height:1.6;">
            ⚠ {{ t('admin.tagworkshop.prereqNoMatches', { attempted: mb.acoustid_attempted.toLocaleString() }) }}
          </div>
          <!-- All already enriched — nothing queued -->
          <div v-else-if="mb.queued === 0 && mb.total > 0 && !enrich.running" style="background:rgba(76,175,80,0.08); border:1px solid rgba(76,175,80,0.25); border-radius:6px; padding:0.65rem 0.9rem; margin-bottom:0.85rem; font-size:0.83rem; color:#81c784; line-height:1.5;">
            ✓ {{ t('admin.tagworkshop.prereqAllDone', { total: mb.total.toLocaleString() }) }}
          </div>

          <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-bottom:0.75rem;">
            <button class="btn" style="min-width:140px;" :disabled="enrich.running || enrich.stopping || mb.queued === 0" @click="startEnrich">{{ t('admin.tagworkshop.btnStartEnrich') }}</button>
            <button class="btn btn-secondary" :disabled="!enrich.running || enrich.stopping" @click="stopEnrich">{{ enrich.stopping ? t('admin.tagworkshop.btnStopping') : t('admin.tagworkshop.btnStopEnrich') }}</button>
            <span v-if="enrich.running" style="color:#4caf50; font-size:0.85rem;">● {{ t('admin.tagworkshop.enrichRunning') }}</span>
            <span v-else-if="enrich.stopping" style="color:#ff9800; font-size:0.85rem;">● {{ t('admin.tagworkshop.enrichStopping') }}</span>
            <span v-else style="color:#888; font-size:0.85rem;">{{ t('admin.tagworkshop.enrichIdle') }}</span>
          </div>
          <div v-if="mb.total > 0">
            <div style="background:var(--raised3); border-radius:4px; height:6px; margin-bottom:0.4rem; overflow:hidden;">
              <div :style="{width: enrichProgress + '%', background:'#4caf50', height:'100%', transition:'width .3s'}"></div>
            </div>
            <div style="display:flex; gap:1.5rem; font-size:0.82rem; flex-wrap:wrap; align-items:center;">
              <span>{{ t('admin.tagworkshop.statsMbTotal') }}: <b>{{ mb.total.toLocaleString() }}</b></span>
              <span style="color:#4caf50;">{{ t('admin.tagworkshop.statsMbDone') }}: <b>{{ mb.done.toLocaleString() }}</b></span>
              <span style="color:#888;">{{ t('admin.tagworkshop.statsMbNoData') }}: <b>{{ mb.no_data.toLocaleString() }}</b></span>
              <span style="color:#e57373;">
                {{ t('admin.tagworkshop.statsMbErrors') }}: <b>{{ mb.errors.toLocaleString() }}</b>
                <button v-if="mb.errors > 0" class="btn-flat btn-small" style="margin-left:0.35rem; font-size:0.75rem; color:#e57373; padding:1px 7px;" @click="toggleEnrichErrors">{{ showEnrichErrors ? '▲' : '▼' }}</button>
              </span>
              <span style="color:#aaa;">{{ t('admin.tagworkshop.statsMbQueued') }}: <b>{{ mb.queued.toLocaleString() }}</b></span>
            </div>
            <!-- Error file list -->
            <div v-if="showEnrichErrors && enrichErrors.length > 0" style="margin-top:0.65rem; max-height:220px; overflow-y:auto; background:var(--raised3); border-radius:5px; border:1px solid rgba(229,115,115,0.25); padding:0.5rem 0.75rem;">
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.5rem;">
                <div style="font-size:0.75rem; color:#e57373; font-weight:600;">{{ t('admin.tagworkshop.enrichErrorsTitle') }} ({{ enrichErrors.length }})</div>
                <button class="btn-flat btn-small" style="font-size:0.75rem; color:#e57373; border-color:rgba(229,115,115,0.4);" @click="retryEnrichErrors" :title="t('admin.tagworkshop.enrichRetryHint')">{{ t('admin.tagworkshop.enrichRetry') }}</button>
              </div>
              <div v-for="row in enrichErrors" :key="row.filepath" style="font-size:0.75rem; padding:0.2rem 0; border-bottom:1px solid rgba(255,255,255,0.04);">
                <div style="color:#bbb; word-break:break-all;">{{ row.filepath }}</div>
                <div style="color:#e57373; margin-top:1px;">{{ row.mb_enrichment_error || t('admin.tagworkshop.enrichErrorUnknown') }}</div>
              </div>
            </div>
          </div>
          <p v-else style="color:#666; font-size:0.81rem; margin:0.5rem 0 0 0; line-height:1.5;">{{ t('admin.tagworkshop.enrichExplainLong') }}</p>
        </div>

        <!-- Step 2: Tab bar -->
        <div v-if="tags.needs_review > 0 || tags.accepted > 0 || tags.skipped > 0">
          <div style="display:flex; border-bottom:2px solid var(--border); margin-bottom:1rem; gap:0;">
            <button @click="tab='review'" class="btn-flat" :style="{borderBottom: tab==='review' ? '2px solid var(--primary)' : 'none', marginBottom:'-2px', fontWeight: tab==='review' ? '600':'normal', paddingBottom:'6px'}">
              {{ t('admin.tagworkshop.reviewTitle') }}
              <span v-if="tags.needs_review > 0" style="margin-left:5px; background:#ff9800; color:#000; border-radius:10px; padding:1px 7px; font-size:0.75rem;">{{ tags.needs_review }}</span>
            </button>
            <button @click="tab='shelved'; loadShelved()" class="btn-flat" :style="{borderBottom: tab==='shelved' ? '2px solid var(--primary)' : 'none', marginBottom:'-2px', fontWeight: tab==='shelved' ? '600':'normal', paddingBottom:'6px'}">
              {{ t('admin.tagworkshop.shelvedTitle') }}
              <span v-if="tags.skipped > 0" style="margin-left:5px; background:var(--raised3); color:#aaa; border-radius:10px; padding:1px 7px; font-size:0.75rem;">{{ tags.skipped }}</span>
            </button>
          </div>

          <!-- REVIEW tab -->
          <div v-if="tab==='review'">
            <p style="color:#aaa; font-size:0.82rem; margin:0 0 0.75rem 0; line-height:1.5;">{{ t('admin.tagworkshop.reviewExplain') }}</p>
            <div style="display:flex; gap:1.5rem; font-size:0.85rem; flex-wrap:wrap; margin-bottom:0.9rem;">
              <span style="color:#ff9800;">{{ t('admin.tagworkshop.statsNeedsReview') }}: <b>{{ tags.needs_review.toLocaleString() }}</b></span>
              <span style="color:#aaa;">{{ t('admin.tagworkshop.statsConfirmed') }}: <b>{{ tags.confirmed.toLocaleString() }}</b></span>
              <span style="color:#4caf50;">{{ t('admin.tagworkshop.statsAccepted') }}: <b>{{ tags.accepted.toLocaleString() }}</b></span>
            </div>

            <!-- Search box -->
            <div style="margin-bottom:0.75rem;">
              <input v-model="search" @input="onSearchInput" type="text" style="width:100%; box-sizing:border-box; padding:0.45rem 0.65rem; border-radius:6px; border:1px solid var(--border); background:var(--raised2); color:var(--t1); font-size:0.88rem;" :placeholder="t('admin.tagworkshop.searchPlaceholder')">
            </div>

            <!-- Filters + bulk actions -->
            <div style="display:flex; flex-direction:column; gap:0.35rem; margin-bottom:0.75rem;">
              <!-- Row 1: Filter -->
              <div style="display:flex; gap:0.4rem; flex-wrap:wrap; align-items:center;">
                <span style="font-size:0.75rem; color:#666; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; white-space:nowrap; min-width:44px;">{{ t('admin.tagworkshop.labelFilter') }}</span>
                <button class="btn-flat btn-small" :class="{select: filter==='all'}"   :title="t('admin.tagworkshop.filterHint_all')"    @click="filter='all';    page=1; loadAlbums()">{{ t('admin.tagworkshop.filter_all') }}</button>
                <button class="btn-flat btn-small" :class="{select: filter==='missing'}" :title="t('admin.tagworkshop.filterHint_missing')" @click="filter='missing'; page=1; loadAlbums()">{{ t('admin.tagworkshop.filter_missing') }}</button>
                <button class="btn-flat btn-small" :class="{select: filter==='year'}"  :title="t('admin.tagworkshop.filterHint_year')"   @click="filter='year';   page=1; loadAlbums()">{{ t('admin.tagworkshop.filter_year') }}</button>
                <button class="btn-flat btn-small" :class="{select: filter==='artist'}" :title="t('admin.tagworkshop.filterHint_artist')" @click="filter='artist'; page=1; loadAlbums()">{{ t('admin.tagworkshop.filter_artist') }}</button>
              </div>
              <!-- Row 2: Sort + bulk actions -->
              <div style="display:flex; gap:0.4rem; flex-wrap:wrap; align-items:center;">
                <span style="font-size:0.75rem; color:#666; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; white-space:nowrap; min-width:44px;">{{ t('admin.tagworkshop.labelSort') }}</span>
                <button class="btn-flat btn-small" :class="{select: sort==='broken'}" :title="t('admin.tagworkshop.sortHint_broken')" @click="sort='broken'; page=1; loadAlbums()">{{ t('admin.tagworkshop.sort_broken') }}</button>
                <button class="btn-flat btn-small" :class="{select: sort==='tracks'}" :title="t('admin.tagworkshop.sortHint_tracks')" @click="sort='tracks'; page=1; loadAlbums()">{{ t('admin.tagworkshop.sort_tracks') }}</button>
                <button class="btn-flat btn-small" :class="{select: sort==='alpha'}"  :title="t('admin.tagworkshop.sortHint_alpha')"  @click="sort='alpha';  page=1; loadAlbums()">{{ t('admin.tagworkshop.sort_alpha') }}</button>
                <span style="margin:0 0.3rem; color:#555;">|</span>
                <button class="btn-flat btn-small" :disabled="pending"
                  :title="bulkCasingConfirm ? t('admin.tagworkshop.btnBulkCasingConfirmHint') : t('admin.tagworkshop.btnBulkCasingHint')"
                  :style="bulkCasingConfirm ? 'color:#e53935; font-weight:600;' : ''"
                  @click="bulkCasingConfirm ? bulkAcceptCasing() : (bulkCasingConfirm=true)"
                  @blur="bulkCasingConfirm=false">
                  {{ bulkCasingConfirm ? t('admin.tagworkshop.btnBulkCasingConfirm') : t('admin.tagworkshop.btnBulkCasing') }}
                </button>
              </div>
            </div>

            <!-- Batch selection bar (always visible to prevent layout shift) -->
            <div style="padding:0.5rem 0.75rem; background:rgba(76,175,80,0.06); border:1px solid rgba(76,175,80,0.18); border-radius:6px; margin-bottom:0.75rem;">
              <div style="display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap; margin-bottom:0.35rem;">
                <span v-if="!batchRunning" style="font-size:0.85rem; font-weight:600;" :style="selectedAlbums.length > 0 ? 'color:#4caf50;' : 'color:#666;'">{{ t('admin.tagworkshop.selectedCount', { count: selectedAlbums.length }) }}</span>
                <span v-else style="font-size:0.85rem; color:#4caf50; font-weight:600;">{{ t('admin.tagworkshop.batchProgressAlbum', { done: batchAlbumDone, total: batchAlbumTotal }) }}</span>
                <button class="btn btn-small" :disabled="pending || batchRunning || selectedAlbums.length === 0" @click="batchAcceptSelected" style="min-width:155px;">{{ t('admin.tagworkshop.btnAcceptSelected') }}</button>
                <!-- Select all + Deselect all grouped together on the right -->
                <div style="display:flex; align-items:center; gap:0.4rem; margin-left:auto; flex-shrink:0;">
                  <label style="display:flex; align-items:center; gap:0.3rem; font-size:0.82rem; cursor:pointer; color:var(--t2); white-space:nowrap; user-select:none;" :title="t('admin.tagworkshop.selectAllHint')">
                    <input type="checkbox" :checked="allOnPageSelected" @change="allOnPageSelected ? deselectAll() : selectAll()" :disabled="pending || batchRunning" style="cursor:pointer; width:15px; height:15px; accent-color:var(--primary);">
                    {{ t('admin.tagworkshop.selectAll') }}
                  </label>
                  <button class="btn-flat btn-small" :disabled="pending || batchRunning || selectedAlbums.length === 0" @click="deselectAll">{{ t('admin.tagworkshop.deselectAll') }}</button>
                </div>
              </div>
              <div v-if="batchRunning">
                <!-- Track progress bar -->
                <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.2rem;">
                  <div style="flex:1; background:var(--border); border-radius:4px; height:5px; overflow:hidden;">
                    <div :style="{ width: (batchTrackTotal ? (batchTrackDone/batchTrackTotal*100) : 0)+'%', background:'#4caf50', height:'100%', transition:'width 0.15s' }"></div>
                  </div>
                  <span style="font-size:0.78rem; color:#aaa; white-space:nowrap;">{{ batchTrackDone }} / {{ batchTrackTotal }} {{ t('admin.tagworkshop.tracksSuffix') }}</span>
                </div>
                <div v-if="batchCurrentAlbum" style="font-size:0.75rem; color:#888; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ batchCurrentAlbum }}</div>
              </div>
            </div>

            <!-- Album cards -->
            <div v-if="albums.length === 0" style="color:#888; font-size:0.88rem; padding:1rem 0;">{{ t('admin.tagworkshop.noAlbums') }}</div>
            <div v-else>
              <div v-for="alb in albums" :key="alb.mb_release_id + '|' + (alb.mb_album_dir || '')"
                style="display:flex; align-items:center; gap:0.75rem; padding:0.65rem 0; border-bottom:1px solid var(--border);">
                <input type="checkbox" :checked="isSelected(alb)" @change="toggleSelect(alb)" :disabled="batchRunning" style="cursor:pointer; flex-shrink:0; width:16px; height:16px; accent-color:var(--primary);" :title="t('admin.tagworkshop.selectHint')">
                <img v-if="alb.album_art" :src="'/album-art/' + alb.album_art" style="width:48px; height:48px; border-radius:4px; object-fit:cover; flex-shrink:0;" alt="">
                <div v-else style="width:48px; height:48px; border-radius:4px; background:var(--raised3); flex-shrink:0;"></div>
                <div style="flex:1; min-width:0;">
                  <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ alb.mb_album }}</div>
                  <div style="font-size:0.82rem; color:#aaa;">{{ alb.mb_artist }}<span v-if="alb.mb_year"> · {{ alb.mb_year }}</span></div>
                  <div style="font-size:0.78rem; margin-top:3px;">
                    <span v-if="alb.tracks_needing_fix" style="color:#ff9800;">
                      ⚠ {{ alb.tracks_needing_fix }}/{{ alb.track_count }} {{ t('admin.tagworkshop.tracksNeedFix') }}
                    </span>
                    <span v-else style="color:#4caf50;">✓ {{ t('admin.tagworkshop.allTracksMatch') }}</span>
                  </div>
                </div>
                <div style="display:flex; flex-direction:column; gap:0.3rem; flex-shrink:0; align-items:flex-end;">
                  <button class="btn btn-small" :disabled="pending" @click="openDetail(alb)" style="white-space:nowrap; min-width:130px;">{{ t('admin.tagworkshop.btnReview') }}</button>
                  <button class="btn-flat btn-small" style="font-size:0.75rem; color:#888;" :disabled="pending" @click="shelve(alb.mb_release_id, alb.mb_album_dir || '')" :title="t('admin.tagworkshop.shelveHint')">{{ t('admin.tagworkshop.btnShelve') }}</button>
                </div>
              </div>

              <!-- Pagination -->
              <div style="display:flex; gap:0.5rem; justify-content:center; margin-top:0.75rem; font-size:0.85rem; align-items:center; flex-wrap:wrap;">
                <button class="btn-flat btn-small" :disabled="page<=1" @click="page=1; loadAlbums()">«</button>
                <button class="btn-flat btn-small" :disabled="page<=1" @click="page--; loadAlbums()">‹</button>
                <span style="color:#aaa;">{{ t('admin.tagworkshop.pageOf', { page, total: totalPages || 1 }) }}</span>
                <span style="color:#666; font-size:0.78rem;">({{ total.toLocaleString() }} {{ t('admin.tagworkshop.albumsTotal') }})</span>
                <input v-model.number="pageJump" @keydown.enter="jumpToPage" type="number" min="1" :max="totalPages" :placeholder="t('admin.tagworkshop.goToPage')" style="width:70px; padding:2px 6px; border-radius:4px; border:1px solid var(--border); background:var(--raised2); color:var(--t1); font-size:0.82rem; text-align:center;">
                <button class="btn-flat btn-small" @click="jumpToPage">{{ t('admin.tagworkshop.btnGo') }}</button>
                <button class="btn-flat btn-small" :disabled="page>=totalPages" @click="page++; loadAlbums()">›</button>
                <button class="btn-flat btn-small" :disabled="page>=totalPages" @click="page=totalPages; loadAlbums()">»</button>
              </div>
            </div>
          </div><!-- /review tab -->

          <!-- SHELVED tab -->
          <div v-if="tab==='shelved'">
            <p style="color:#aaa; font-size:0.82rem; margin:0 0 0.75rem 0; line-height:1.5;">{{ t('admin.tagworkshop.shelvedExplain') }}</p>
            <div v-if="shelvedAlbums.length === 0" style="color:#888; font-size:0.88rem; padding:1rem 0;">{{ t('admin.tagworkshop.shelvedEmpty') }}</div>
            <div v-else>
              <div v-for="alb in shelvedAlbums" :key="alb.mb_release_id + '|' + (alb.mb_album_dir || '')"
                style="display:flex; align-items:center; gap:0.75rem; padding:0.65rem 0; border-bottom:1px solid var(--border);">
                <img v-if="alb.album_art" :src="'/album-art/' + alb.album_art" style="width:48px; height:48px; border-radius:4px; object-fit:cover; flex-shrink:0; opacity:0.5;" alt="">
                <div v-else style="width:48px; height:48px; border-radius:4px; background:var(--raised3); flex-shrink:0;"></div>
                <div style="flex:1; min-width:0;">
                  <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:0.7;">{{ alb.mb_album }}</div>
                  <div style="font-size:0.82rem; color:#777;">{{ alb.mb_artist }}<span v-if="alb.mb_year"> · {{ alb.mb_year }}</span></div>
                  <div style="font-size:0.78rem; color:#666;">{{ alb.track_count }} {{ t('admin.tagworkshop.tracks') }}</div>
                </div>
                <div style="flex-shrink:0;">
                  <button class="btn btn-secondary btn-small" :disabled="pending" @click="unshelve(alb.mb_release_id, alb.mb_album_dir || '')">{{ t('admin.tagworkshop.btnUnshelve') }}</button>
                </div>
              </div>
              <!-- Pagination -->
              <div style="display:flex; gap:0.5rem; justify-content:center; margin-top:0.75rem; font-size:0.85rem; align-items:center;">
                <button class="btn-flat btn-small" :disabled="shelvedPage<=1" @click="shelvedPage--; loadShelved()">&laquo;</button>
                <span>{{ shelvedPage }} / {{ shelvedTotalPages || 1 }}</span>
                <button class="btn-flat btn-small" :disabled="shelvedPage>=shelvedTotalPages" @click="shelvedPage++; loadShelved()">&raquo;</button>
              </div>
            </div>
          </div><!-- /shelved tab -->
        </div>
        <div v-else-if="mb.done > 0" style="color:#4caf50; font-size:0.9rem; padding:0.5rem 0;">{{ t('admin.tagworkshop.allClean') }}</div>

        <p v-if="msg" style="margin-top:0.75rem; font-size:0.85rem; color:#4caf50;">{{ msg }}</p>
        </div><!-- /card-content -->
      </div><!-- /card -->
        </div><!-- /col -->
      </div><!-- /row -->

      <!-- Detail modal -->
      <div v-if="showDetail" style="position:fixed; inset:0; background:rgba(0,0,0,0.72); z-index:9999; display:flex; align-items:flex-start; justify-content:center; padding:2rem 1rem; overflow-y:auto;">
        <div style="background:var(--bg); border-radius:10px; max-width:960px; width:100%; padding:1.5rem; position:relative;">
          <button @click="showDetail=false; acceptErrors=[]" style="position:absolute; top:.75rem; right:.75rem; background:none; border:none; color:var(--t1); font-size:1.4rem; cursor:pointer;">&times;</button>
          <h5 style="margin:0 0 0.2rem;">{{ t('admin.tagworkshop.reviewModalTitle') }}</h5>
          <p v-if="detailLabel" style="color:#aaa; font-size:0.85rem; margin:0 0 1rem 0;">{{ detailLabel }}</p>

          <!-- What will happen notice -->
          <div style="background:rgba(255,152,0,0.1); border:1px solid rgba(255,152,0,0.3); border-radius:6px; padding:0.65rem 0.9rem; margin-bottom:1rem; font-size:0.83rem; color:#ffb74d; line-height:1.5;">
            {{ t('admin.tagworkshop.acceptWarning', { count: detailTracks.length }) }}
          </div>

          <!-- Tracks comparison table -->
          <div style="overflow-x:auto; margin-bottom:0.75rem;">
            <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
              <thead>
                <tr style="text-align:left; border-bottom:2px solid var(--border);">
                  <th style="padding:4px 8px; color:#aaa; font-weight:normal;">#</th>
                  <th style="padding:4px 8px; color:#aaa; font-weight:normal;">{{ t('admin.tagworkshop.colTitle') }}</th>
                  <th style="padding:4px 8px; color:#aaa; font-weight:normal;">{{ t('admin.tagworkshop.colArtist') }}</th>
                  <th style="padding:4px 8px; color:#aaa; font-weight:normal;">{{ t('admin.tagworkshop.colAlbum') }}</th>
                  <th style="padding:4px 8px; color:#aaa; font-weight:normal;">{{ t('admin.tagworkshop.colYear') }}</th>
                  <th style="padding:4px 8px; color:#aaa; font-weight:normal;"></th>
                </tr>
              </thead>
              <tbody>
                <template v-for="t_ in detailTracks" :key="t_.filepath">
                  <!-- Label row -->
                  <tr>
                    <td colspan="6" style="padding:6px 8px 1px 8px; font-size:0.72rem; color:#888; font-style:italic; border-top:1px solid var(--border); word-break:break-all;">{{ t_.filepath }}</td>
                  </tr>
                  <!-- Current file row -->
                  <tr style="opacity:0.7;" :title="t('admin.tagworkshop.yourFile')">
                    <td style="padding:2px 8px; color:#888; font-size:0.78rem;">{{ t_.track || '–' }}</td>
                    <td style="padding:2px 8px; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{{ t_.title || '–' }}</td>
                    <td style="padding:2px 8px; white-space:nowrap;">{{ t_.artist || '–' }}</td>
                    <td style="padding:2px 8px; white-space:nowrap;">{{ t_.album || '–' }}</td>
                    <td style="padding:2px 8px;">{{ t_.year || '–' }}</td>
                    <td style="padding:2px 8px; font-size:0.72rem; color:#888; white-space:nowrap;">← {{ t('admin.tagworkshop.labelYourFile') }}</td>
                  </tr>
                  <!-- MusicBrainz suggestion row — per-cell color, inline-editable -->
                  <tr style="font-weight:500; border-bottom:1px solid var(--border);" :title="t('admin.tagworkshop.cellEditHint')">
                    <td style="padding:2px 8px; font-size:0.78rem;" :style="{color: cellColor(t_,'track')}">{{ t_.mb_track || '–' }}</td>
                    <td style="padding:2px 8px; max-width:180px;" :style="{color: cellColor(t_,'title')}"><input type="text" :value="detailEdits[t_.filepath] !== undefined && detailEdits[t_.filepath].title !== undefined ? detailEdits[t_.filepath].title : (t_.mb_title || '')" @input="setDetailEdit(t_.filepath, 'title', $event.target.value)" style="border:none; background:transparent; color:inherit; font:inherit; width:100%; padding:0; cursor:text;" /></td>
                    <td style="padding:2px 8px;" :style="{color: cellColor(t_,'artist')}"><input type="text" :value="detailEdits[t_.filepath] !== undefined && detailEdits[t_.filepath].artist !== undefined ? detailEdits[t_.filepath].artist : (t_.mb_artist || '')" @input="setDetailEdit(t_.filepath, 'artist', $event.target.value)" style="border:none; background:transparent; color:inherit; font:inherit; width:100%; padding:0; cursor:text;" /></td>
                    <td style="padding:2px 8px;" :style="{color: cellColor(t_,'album')}"><input type="text" :value="detailEdits[t_.filepath] !== undefined && detailEdits[t_.filepath].album !== undefined ? detailEdits[t_.filepath].album : (t_.mb_album || '')" @input="setDetailEdit(t_.filepath, 'album', $event.target.value)" style="border:none; background:transparent; color:inherit; font:inherit; width:100%; padding:0; cursor:text;" /></td>
                    <td style="padding:2px 8px;" :style="{color: cellColor(t_,'year')}"><input type="text" :value="detailEdits[t_.filepath] !== undefined && detailEdits[t_.filepath].year !== undefined ? detailEdits[t_.filepath].year : (t_.mb_year || '')" @input="setDetailEdit(t_.filepath, 'year', $event.target.value)" style="border:none; background:transparent; color:inherit; font:inherit; width:60px; padding:0; cursor:text;" /></td>
                    <td style="padding:2px 8px; font-size:0.72rem; white-space:nowrap;" :style="{color: '#aaa'}">← {{ t('admin.tagworkshop.labelMbSuggestion') }}</td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>

          <!-- Legend -->
          <div style="font-size:0.78rem; color:#aaa; margin-bottom:1rem; display:flex; gap:1.25rem; flex-wrap:wrap;">
            <span style="opacity:0.5;">── {{ t('admin.tagworkshop.labelYourFile') }}</span>
            <span><b style="color:#4caf50;">■</b> {{ t('admin.tagworkshop.legendMatch') }}</span>
            <span><b style="color:#ff9800;">■</b> {{ t('admin.tagworkshop.legendDiff') }}</span>
          </div>

          <!-- Optional overrides -->
          <details style="margin-bottom:1.25rem; border:1px solid var(--border); border-radius:6px; padding:0.6rem 0.75rem;">
            <summary style="font-size:0.84rem; color:#aaa; cursor:pointer; user-select:none;">{{ t('admin.tagworkshop.overrideTitle') }}</summary>
            <p style="font-size:0.8rem; color:#aaa; margin:0.5rem 0 0.75rem 0; line-height:1.5;">{{ t('admin.tagworkshop.overrideNote') }}</p>
            <div style="display:flex; gap:1rem; flex-wrap:wrap;">
              <div style="flex:1; min-width:160px;">
                <label style="font-size:0.8rem; color:#888;">{{ t('admin.tagworkshop.overrideArtist') }}</label>
                <input v-model="detailArtistOverride" type="text" style="width:100%; box-sizing:border-box;" :placeholder="t('admin.tagworkshop.overridePlaceholder')">
              </div>
              <div style="flex:1; min-width:160px;">
                <label style="font-size:0.8rem; color:#888;">{{ t('admin.tagworkshop.overrideAlbum') }}</label>
                <input v-model="detailAlbumOverride" type="text" style="width:100%; box-sizing:border-box;" :placeholder="t('admin.tagworkshop.overridePlaceholder')">
              </div>
            </div>
          </details>

          <!-- Write errors (shown after a failed accept) -->
          <div v-if="acceptErrors.length" style="background:rgba(229,115,115,0.1); border:1px solid rgba(229,115,115,0.4); border-radius:6px; padding:0.65rem 0.9rem; margin-bottom:1rem; font-size:0.83rem; color:#ef9a9a; line-height:1.5;">
            <b>{{ t('admin.tagworkshop.writeErrorsTitle') }}</b><br>
            <span v-for="e in acceptErrors" :key="e.filepath" style="display:block; font-size:0.78rem; margin-top:2px; opacity:0.85;">{{ e.filepath.split('/').pop() }}: {{ e.error }}</span>
          </div>

          <!-- Write progress (shown while accepting) -->
          <div v-if="pending && acceptWriteTotal > 0" style="margin-bottom:1rem;">
            <div style="font-size:0.83rem; color:#aaa; margin-bottom:0.4rem;">{{ t('admin.tagworkshop.progressWriting', { done: acceptWriteDone, total: acceptWriteTotal }) }}</div>
            <div style="background:var(--border); border-radius:4px; height:6px; overflow:hidden;">
              <div :style="{ width: (acceptWriteTotal ? (acceptWriteDone / acceptWriteTotal * 100) : 0) + '%', background: '#4caf50', height: '100%', transition: 'width 0.2s' }"></div>
            </div>
          </div>

          <div style="display:flex; gap:0.75rem; justify-content:flex-end; align-items:center; flex-wrap:wrap;">
            <button class="btn btn-secondary" :disabled="pending" @click="showDetail=false; acceptErrors=[]">{{ t('admin.tagworkshop.btnCancel') }}</button>
            <button class="btn btn-secondary" :disabled="pending" @click="shelveDetail" :title="t('admin.tagworkshop.shelveHint')">{{ t('admin.tagworkshop.btnShelve') }}</button>
            <button class="btn" style="min-width:170px;" :disabled="pending" @click="acceptDetail">{{ pending ? t('admin.tagworkshop.btnAccepting') : t('admin.tagworkshop.btnAccept') }}</button>
          </div>
        </div>
      </div>
    </div>
  `,
  methods: {
    cellColor(t_, field) {
      const n = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      switch (field) {
        case 'track':  return (!t_.mb_track  || t_.mb_track == t_.track)                           ? '#4caf50' : '#ff9800';
        case 'title':  return (!t_.mb_title  || n(t_.title)  === n(t_.mb_title))                   ? '#4caf50' : '#ff9800';
        case 'artist': return (!t_.mb_artist || n(t_.artist) === n(t_.mb_artist))                  ? '#4caf50' : '#ff9800';
        case 'album':  return (!t_.mb_album  || n(t_.album)  === n(t_.mb_album))                   ? '#4caf50' : '#ff9800';
        case 'year':   return (!t_.mb_year   || Math.abs((t_.year || 0) - t_.mb_year) <= 1)        ? '#4caf50' : '#ff9800';
        default: return '';
      }
    },
    async loadStatus() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/tagworkshop/status` });
        this.mb   = res.data.mb   || this.mb;
        this.tags = res.data.tags || this.tags;
        this.enrich = res.data.enrich || this.enrich;
        // Only reschedule when the request succeeded and the worker is still running
        if (this.enrich.running) {
          this._statusTimer = setTimeout(() => { this.loadStatus(); this.loadAlbums(); }, 8000);
        }
      } catch(_) {
        // Server unreachable — stop polling to avoid console flood
      }
    },
    async loadAlbums() {
      try {
        // Clear selection when filter or sort changes (but not on page change alone)
        if (this.filter !== this._lastFilter || this.sort !== this._lastSort) {
          this.selectedAlbums = [];
          this._lastFilter = this.filter;
          this._lastSort = this.sort;
        }
        const q = this.search.trim();
        const url = `${API.url()}/api/v1/tagworkshop/albums?page=${this.page}&filter=${this.filter}&sort=${this.sort}${q ? '&q=' + encodeURIComponent(q) : ''}`;
        const res = await API.axios({ method: 'GET', url });
        this.albums   = res.data.albums   || [];
        this.total    = res.data.total    || 0;
        this.pageSize = res.data.pageSize || 40;
      } catch(_) {}
    },
    onSearchInput() {
      clearTimeout(this.searchDebounce);
      this.searchDebounce = setTimeout(() => { this.page = 1; this.loadAlbums(); }, 350);
    },
    jumpToPage() {
      const p = parseInt(this.pageJump, 10);
      if (p >= 1 && p <= (this.totalPages || 1)) {
        this.page = p;
        this.loadAlbums();
      }
      this.pageJump = '';
    },
    async startEnrich() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/enrich/start` });
        this.enrich.running = true;
        this._statusTimer = setTimeout(() => { this.loadStatus(); }, 2000);
      } catch(_) {}
    },
    async stopEnrich() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/enrich/stop` });
        this.enrich.stopping = true;
      } catch(_) {}
    },
    async toggleEnrichErrors() {
      this.showEnrichErrors = !this.showEnrichErrors;
      if (this.showEnrichErrors && this.enrichErrors.length === 0) {
        try {
          const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/tagworkshop/enrich/errors` });
          this.enrichErrors = res.data.errors || [];
        } catch(_) {}
      }
    },
    async retryEnrichErrors() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/enrich/retry-errors` });
        this.enrichErrors = [];
        this.showEnrichErrors = false;
        await this.loadStatus();
      } catch(_) {}
    },
    setDetailEdit(fp, field, val) {
      this.detailEdits = { ...this.detailEdits, [fp]: { ...(this.detailEdits[fp] || {}), [field]: val } };
    },
    async openDetail(alb) {
      this.detailReleaseId     = alb.mb_release_id;
      this.detailAlbumDir      = alb.mb_album_dir || '';
      this.detailLabel         = [alb.mb_artist, alb.mb_album, alb.mb_year ? '(' + alb.mb_year + ')' : ''].filter(Boolean).join(' — ');
      this.detailArtistOverride = '';
      this.detailAlbumOverride  = '';
      this.detailEdits = {};
      this.acceptErrors = [];
      this.detailTracks = [];
      this.showDetail = true;
      try {
        const albumDirParam = this.detailAlbumDir !== '' ? `&album_dir=${encodeURIComponent(this.detailAlbumDir)}` : '';
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/tagworkshop/album/${encodeURIComponent(alb.mb_release_id)}?dummy=1${albumDirParam}` });
        this.detailTracks = res.data.tracks || [];
      } catch(_) {}
    },
    async acceptDetail() {
      if (!this.detailReleaseId) return;
      this.pending = true;
      this.acceptErrors = [];
      this.acceptWriteDone  = 0;
      this.acceptWriteTotal = this.detailTracks.length;
      try {
        const albumOverrides = {};
        if (this.detailArtistOverride.trim()) albumOverrides.artist = this.detailArtistOverride.trim();
        if (this.detailAlbumOverride.trim())  albumOverrides.album  = this.detailAlbumOverride.trim();

        let accepted = 0;
        for (const track of this.detailTracks) {
          try {
            const perTrack = this.detailEdits[track.filepath] || {};
            const overrides = {
              ...albumOverrides,
              ...(perTrack.artist !== undefined ? { artist: perTrack.artist } : {}),
              ...(perTrack.album  !== undefined ? { album:  perTrack.album  } : {}),
              ...(perTrack.title  !== undefined ? { title:  perTrack.title  } : {}),
              ...(perTrack.year   !== undefined ? { year:   perTrack.year   } : {}),
            };
            const r = await API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/tagworkshop/accept-track`,
              data: { mb_release_id: this.detailReleaseId, filepath: track.filepath, vpath: track.vpath, overrides },
            });
            if (r.data.error) {
              this.acceptErrors.push({ filepath: track.filepath, error: r.data.error });
            } else if (!r.data.skipped) {
              accepted++;
            }
          } catch(_) {
            this.acceptErrors.push({ filepath: track.filepath, error: this.t('admin.tagworkshop.toastError') });
          }
          this.acceptWriteDone++;
        }

        if (this.acceptErrors.length) {
          this.msg = this.t('admin.tagworkshop.toastWritePartial', { written: accepted, failed: this.acceptErrors.length });
        } else {
          this.msg = this.t('admin.tagworkshop.toastAccepted', { count: accepted });
          this.showDetail = false;
        }
        await this.loadStatus();
        await this.loadAlbums();
      } catch(_) {
        this.msg = this.t('admin.tagworkshop.toastError');
      } finally {
        this.pending = false;
        this.acceptWriteTotal = 0;
        this.acceptWriteDone  = 0;
      }
    },
    async shelve(mb_release_id, album_dir = '') {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/skip`, data: { mb_release_id, album_dir } });
        await this.loadAlbums();
        await this.loadStatus();
        await this.loadShelved();
      } catch(_) {}
    },
    async shelveDetail() {
      await this.shelve(this.detailReleaseId, this.detailAlbumDir);
      this.showDetail = false;
    },
    async unshelve(mb_release_id, album_dir = '') {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/unshelve`, data: { mb_release_id, album_dir } });
        await this.loadShelved();
        await this.loadAlbums();
        await this.loadStatus();
      } catch(_) {}
    },
    async loadShelved() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/tagworkshop/shelved?page=${this.shelvedPage}` });
        this.shelvedAlbums = res.data.albums || [];
        this.shelvedTotal  = res.data.total  || 0;
      } catch(_) {}
    },
    albumKey(a) { return a.mb_release_id + '|' + (a.mb_album_dir || ''); },
    isSelected(a) { const k = this.albumKey(a); return this.selectedAlbums.some(s => this.albumKey(s) === k); },
    toggleSelect(a) {
      const k = this.albumKey(a);
      const idx = this.selectedAlbums.findIndex(s => this.albumKey(s) === k);
      if (idx === -1) this.selectedAlbums.push(a);
      else this.selectedAlbums.splice(idx, 1);
    },
    selectAll() {
      for (const a of this.albums) { if (!this.isSelected(a)) this.selectedAlbums.push(a); }
    },
    deselectAll() { this.selectedAlbums = []; },
    async batchAcceptSelected() {
      if (!this.selectedAlbums.length || this.batchRunning) return;
      this.batchRunning = true;
      const batch = [...this.selectedAlbums];
      this.batchAlbumTotal = batch.length;
      this.batchAlbumDone  = 0;
      this.batchTrackDone  = 0;
      this.batchTrackTotal = 0;
      this.batchCurrentAlbum = '';
      let totalTracks = 0, totalErrors = 0;
      try {
        // Phase 1: fetch all track lists to get a total track count up-front
        const trackLists = [];
        for (const alb of batch) {
          try {
            const albumDirParam = alb.mb_album_dir ? `&album_dir=${encodeURIComponent(alb.mb_album_dir)}` : '';
            const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/tagworkshop/album/${encodeURIComponent(alb.mb_release_id)}?dummy=1${albumDirParam}` });
            trackLists.push({ alb, tracks: res.data.tracks || [] });
            this.batchTrackTotal += (res.data.tracks || []).length;
          } catch(_) { trackLists.push({ alb, tracks: [] }); totalErrors++; }
        }
        // Phase 2: write tracks, update counters immediately after each one
        for (const { alb, tracks } of trackLists) {
          this.batchCurrentAlbum = [alb.mb_artist, alb.mb_album].filter(Boolean).join(' — ');
          for (const track of tracks) {
            try {
              const r = await API.axios({
                method: 'POST',
                url: `${API.url()}/api/v1/tagworkshop/accept-track`,
                data: { mb_release_id: alb.mb_release_id, filepath: track.filepath, vpath: track.vpath, overrides: {} },
              });
              if (r.data.error) totalErrors++;
              else if (!r.data.skipped) totalTracks++;
            } catch(_) { totalErrors++; }
            this.batchTrackDone++;
          }
          this.batchAlbumDone++;
        }
        this.selectedAlbums = [];
        this.batchCurrentAlbum = '';
        this.msg = totalErrors > 0
          ? this.t('admin.tagworkshop.batchErrors', { albums: batch.length, errors: totalErrors })
          : this.t('admin.tagworkshop.batchDone', { albums: batch.length, tracks: totalTracks });
        await this.loadStatus();
        await this.loadAlbums();
      } catch(_) {
        this.msg = this.t('admin.tagworkshop.toastError');
      } finally {
        this.batchRunning = false;
        this.batchAlbumDone  = 0;
        this.batchAlbumTotal = 0;
        this.batchTrackDone  = 0;
        this.batchTrackTotal = 0;
        this.batchCurrentAlbum = '';
      }
    },
    async bulkAcceptCasing() {
      this.bulkCasingConfirm = false;
      this.pending = true;
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/bulk-accept-casing` });
        this.msg = this.t('admin.tagworkshop.toastBulkAccepted', { count: res.data.accepted + res.data.dbOnly });
        await this.loadStatus();
        await this.loadAlbums();
      } catch(_) {
        this.msg = this.t('admin.tagworkshop.toastError');
      } finally {
        this.pending = false;
      }
    },
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
              <span class="card-title">{{ t('admin.radio.title') }}</span>
              <p style="margin-bottom:0.5rem;">{{t('admin.radio.desc1')}}</p>
              <p style="margin-bottom:1rem;font-size:0.85rem;color:#999;">{{t('admin.radio.desc2')}}</p>
              <table>
                <tbody>
                  <tr>
                    <td style="width:140px"><b>{{ t('admin.radio.labelEnable') }}</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.radio.checkboxEnable') }}</td>
                  </tr>
                  <tr v-if="enabled">
                    <td><b>{{ t('admin.radio.labelMaxRecording') }}</b></td>
                    <td>
                      <input type="number" v-model.number="maxRecordingMinutes" min="1" step="1" style="width:80px;display:inline-block;margin:0 6px 0 0;" />
                      {{ t('admin.radio.maxRecordingUnit') }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
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
        iziToast.success({ title: this.t('admin.radio.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch(err) {
        iziToast.error({ title: this.t('admin.radio.toastFailed'), position: 'topCenter', timeout: 3000 });
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
              <span class="card-title">{{ t('admin.genreGroups.title') }}</span>
              <p style="margin-bottom:.5rem;">{{ t('admin.genreGroups.desc') }}<br><small style="color:var(--t2)">{{ t('admin.genreGroups.hint') }} {{ t('admin.genreGroups.dropHintNoDelete') }}</small></p>
              <div v-if="isDefault" style="background:var(--raised);border-left:3px solid var(--accent,#6366f1);padding:10px 14px;border-radius:4px;margin-top:10px;font-size:.875rem;color:var(--t2);">{{ t('admin.genreGroups.autoDetectedNotice') }}</div>
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
            <span class="gg-chevron-sm" @click="toggleCollapse(gi)" :title="grp.collapsed ? t('admin.genreGroups.expand') : t('admin.genreGroups.collapse')">{{grp.collapsed ? '▶' : '▼'}}</span>
            <span v-if="renamingIdx !== gi" class="gg-left-name" @dblclick="startRename(gi)" :title="t('admin.genreGroups.doubleClickRename')">{{grp.name}}</span>
            <input v-else v-model="renamingVal" class="gg-rename-inp gg-left-rename" @blur="commitRename(gi)" @keydown.enter="commitRename(gi)" @keydown.esc="renamingIdx=null" ref="renameInput">
            <span class="gg-left-cnt">{{grp.genres.length}}</span>
            <button v-if="grp.genres.length === 0" class="gg-del-btn" @click.stop="deleteGroup(gi)" :title="t('admin.genreGroups.deleteEmptyGroup')">&#x2715;</button>
          </div>
          <div class="gg-add-row">
            <input v-model="newGroupName" type="text" :placeholder="t('admin.genreGroups.newGroupPlaceholder')" class="gg-add-inp" @keydown.enter="addGroup">
            <button class="btn btn-small" @click="addGroup" :disabled="!newGroupName.trim()">+</button>
          </div>
        </div>

        <!-- RIGHT: search + collapsible genre sections -->
        <div class="gg-right">
          <!-- Search bar -->
          <div class="gg-search-row">
            <span class="gg-search-icon">&#128269;</span>
            <input v-model="searchQuery" type="text" :placeholder="t('admin.genreGroups.searchPlaceholder')" class="gg-search-inp" @keydown.esc="searchQuery=''">
            <button v-if="searchQuery" class="gg-search-clear" @click="searchQuery=''" :title="t('admin.common.delete')">&#x2715;</button>
          </div>

          <!-- Search results panel -->
          <div v-if="searchQuery.trim()" class="gg-search-panel">
            <div class="gg-search-panel-head">{{ t('admin.genreGroups.resultsFor') }} <b>"{{searchQuery.trim()}}"</b> <span style="color:var(--t3);font-weight:400;">{{ t('admin.genreGroups.syntaxHint') }}</span></div>
            <div class="gg-chips" style="padding:10px 14px;">
              <span v-if="searchResults.length === 0" class="gg-empty-hint">{{ t('admin.genreGroups.noGenresMatch') }}</span>
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
                {{g}}<span v-if="gi !== otherGroupIdx && otherGroupIdx !== -1" class="gg-chip-remove" @click.stop="moveToOther(gi, gei)" :title="t('admin.genreGroups.moveToOther')">↓</span>
              </span>
              <span v-if="grp.genres.length === 0" class="gg-empty-hint">{{ t('admin.genreGroups.dropHere') }}</span>
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button class="btn-flat" @click="resetToDefault">{{ t('admin.genreGroups.btnResetToAuto') }}</button>
            <button class="btn" @click="save" :disabled="pending">{{ pending ? t('admin.genreGroups.btnSaving') : t('admin.genreGroups.btnSave') }}</button>
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
      } catch(e) { iziToast.error({ title: this.t('admin.genreGroups.toastFailedLoad'), position: 'topCenter', timeout: 3000 }); }
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
      return grp ? grp.name : this.t('admin.genreGroups.unassigned');
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
      } catch(e) { iziToast.error({ title: this.t('admin.genreGroups.toastAutoSaveFailed'), position: 'topCenter', timeout: 3000 }); }
    },
    resetToDefault() {
      adminConfirm(this.t('admin.genreGroups.confirmResetTitle'), this.t('admin.genreGroups.confirmResetMsg'), this.t('admin.genreGroups.confirmResetLabel'), async () => {
        try {
          await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/genre-groups`, data: [] });
          await this.load();
          iziToast.success({ title: this.t('admin.genreGroups.toastReset'), position: 'topCenter', timeout: 2500 });
        } catch(e) { iziToast.error({ title: this.t('admin.genreGroups.toastResetFailed'), position: 'topCenter', timeout: 3000 }); }
      });
    },
    async save() {
      this.pending = true;
      try {
        // Save all groups (including empty ones) so renamed group names are preserved
        const payload = this.groups.map(g => ({ name: g.name, genres: g.genres }));
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/genre-groups`, data: payload });
        this.isDefault = false;
        iziToast.success({ title: this.t('admin.genreGroups.toastSaved'), position: 'topCenter', timeout: 2500 });
      } catch(e) { iziToast.error({ title: this.t('admin.genreGroups.toastSaveFailed'), position: 'topCenter', timeout: 3000 }); }
      finally { this.pending = false; }
    }
  }
});

const artistsAdminView = Vue.component('artists-admin-view', {
  data() {
    return {
      loading: false,
      kind: 'missing',
      counts: { missing: 0, noImage: 0, wrong: 0, withImage: 0 },
      sessionStartMissing: null,
      artists: [],
      selected: null,
      candidateLoading: false,
      candidates: [],
      customImageUrl: '',
      customImagePreviewError: false,
      applying: false,
      hydration: {
        running: false,
        queueLength: 0,
        queueLimit: 0,
        stats: { startedAt: 0, enqueued: 0, dropped: 0, processed: 0, succeeded: 0, noImage: 0, failed: 0 },
        delayMs: { ok: 0, noImage: 0, error: 0 },
        discogs: { enabled: false, hasApiCredentials: false },
      },
      seedPending: false,
      pollTimer: null,
    };
  },
  mounted() {
    this.load('missing');
    this.startPolling();
  },
  beforeDestroy() {
    this.stopPolling();
  },
  computed: {
    discogsReady() {
      return !!(this.hydration.discogs && this.hydration.discogs.enabled && this.hydration.discogs.hasApiCredentials);
    },
    hydratedThisSession() {
      if (!Number.isFinite(this.sessionStartMissing)) return null;
      return Math.max(0, this.sessionStartMissing - (this.counts.missing || 0));
    },
    customImagePreviewUrl() {
      const url = String(this.customImageUrl || '').trim();
      if (!/^https?:\/\//i.test(url)) return '';
      return url;
    },
  },
  methods: {
    startPolling() {
      this.stopPolling();
      this.pollTimer = setInterval(() => {
        this.loadHydrationStatus();
      }, 5000);
      this.loadHydrationStatus();
    },
    stopPolling() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    },
    async loadHydrationStatus() {
      try {
        const res = await API.axios({
          method: 'GET',
          url: `${API.url()}/api/v1/admin/artists/hydration-status`
        });
        this.hydration = res.data || this.hydration;
        const c = res.data?.counts || null;
        if (c) {
          this.counts = c;
          if (!Number.isFinite(this.sessionStartMissing)) this.sessionStartMissing = c.missing || 0;
        }
      } catch (_e) {
        // Non-fatal polling failure; keep existing status UI.
      }
    },
    async load(kind = this.kind) {
      this.loading = true;
      this.kind = kind;
      this.selected = null;
      this.candidates = [];
      try {
        const res = await API.axios({
          method: 'GET',
          url: `${API.url()}/api/v1/admin/artists/image-audit`,
          params: { kind, limit: 300 }
        });
        this.counts = res.data.counts || { missing: 0, noImage: 0, wrong: 0, withImage: 0 };
        if (!Number.isFinite(this.sessionStartMissing)) this.sessionStartMissing = this.counts.missing || 0;
        this.artists = res.data.artists || [];
      } catch (e) {
        iziToast.error({ title: this.t('admin.artists.toastFailedLoad'), message: e.message || '', position: 'topCenter', timeout: 3000 });
      } finally {
        this.loading = false;
      }
    },
    async seedHydration(limit = 500) {
      if (this.seedPending) return;
      this.seedPending = true;
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/artists/hydration-seed`,
          data: { limit }
        });
        this.hydration = res.data || this.hydration;
        this.counts = res.data?.counts || this.counts;
        iziToast.success({ title: this.t('admin.artists.toastQueued', { count: res.data?.enqueued || 0 }), position: 'topCenter', timeout: 1800 });
      } catch (e) {
        iziToast.error({ title: this.t('admin.artists.toastFailedQueue'), message: e.message || '', position: 'topCenter', timeout: 2500 });
      } finally {
        this.seedPending = false;
      }
    },
    async selectArtist(row) {
      this.selected = row;
      this.candidates = [];
      this.customImageUrl = '';
      this.customImagePreviewError = false;
      if (!this.discogsReady) {
        this.candidateLoading = false;
        return;
      }
      this.candidateLoading = true;
      try {
        const res = await API.axios({
          method: 'GET',
          url: `${API.url()}/api/v1/admin/artists/discogs-candidates`,
          params: { artistKey: row.artistKey }
        });
        this.candidates = res.data.candidates || [];
      } catch (e) {
        iziToast.error({ title: this.t('admin.artists.toastFailedCandidates'), message: e.message || '', position: 'topCenter', timeout: 3000 });
      } finally {
        this.candidateLoading = false;
      }
    },
    async applyImage(url, source = 'discogs') {
      if (!this.selected || !url || this.applying) return;
      this.applying = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/artists/apply-image`,
          data: { artistKey: this.selected.artistKey, imageUrl: url, source }
        });
        iziToast.success({ title: this.t('admin.artists.toastImageUpdated'), position: 'topCenter', timeout: 1800 });
        await this.load(this.kind);
      } catch (e) {
        iziToast.error({ title: this.t('admin.artists.toastFailedSetImage'), message: e.message || '', position: 'topCenter', timeout: 3000 });
      } finally {
        this.applying = false;
      }
    },
    onCustomPreviewLoad() {
      this.customImagePreviewError = false;
    },
    onCustomPreviewError() {
      this.customImagePreviewError = true;
    },
    async setWrong(row, wrong) {
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/artists/mark-image-wrong`,
          data: { artistKey: row.artistKey, wrong: !!wrong }
        });
        iziToast.success({
          title: wrong ? this.t('admin.artists.toastMarkedWrong') : this.t('admin.artists.toastMarkedOk'),
          position: 'topCenter',
          timeout: 1500
        });
        await this.load(this.kind);
      } catch (e) {
        iziToast.error({ title: this.t('admin.artists.toastFailedUpdateStatus'), message: e.message || '', position: 'topCenter', timeout: 2500 });
      }
    },
    imgSrc(imageFile) {
      return `${API.url()}/api/v1/artists/images/${encodeURIComponent(imageFile)}`;
    }
  },
  template: `
  <div>
    <div class="card z-depth-1" style="padding:18px 20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div>
          <span class="card-title">{{ t('admin.artists.title') }}</span>
          <div style="font-size:.9rem;color:var(--t2);margin-top:2px;">{{ t('admin.artists.desc') }}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn-flat" @click="load('missing')" :style="kind==='missing' ? 'border-color:var(--primary);color:var(--primary);' : ''">{{ t('admin.artists.tabPending', { count: counts.missing || 0 }) }}</button>
          <button class="btn-flat" @click="load('no-image')" :style="kind==='no-image' ? 'border-color:var(--warn,#b45309);color:var(--warn,#b45309);' : ''">{{ t('admin.artists.tabNoImage', { count: counts.noImage || 0 }) }}</button>
          <button class="btn-flat" @click="load('with-image')" :style="kind==='with-image' ? 'border-color:var(--ok,#16a34a);color:var(--ok,#16a34a);' : ''">{{ t('admin.artists.tabWithImage', { count: counts.withImage || 0 }) }}</button>
          <button class="btn-flat" @click="load('wrong')" :style="kind==='wrong' ? 'border-color:var(--warn,#b45309);color:var(--warn,#b45309);' : ''">{{ t('admin.artists.tabWrong', { count: counts.wrong || 0 }) }}</button>
          <button class="btn-flat" @click="seedHydration(500)" :disabled="seedPending">{{ seedPending ? t('admin.artists.btnQueueing') : t('admin.artists.btnQueueNext') }}</button>
          <button class="btn" @click="load(kind)" :disabled="loading">{{ loading ? t('admin.artists.btnRefreshing') : t('admin.artists.btnRefresh') }}</button>
        </div>
      </div>

      <div style="margin-top:12px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface);display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;">
        <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.hydrationStatus') }} <b :style="hydration.running ? 'color:var(--ok,#16a34a);' : 'color:var(--t2);'">{{ hydration.running ? t('admin.artists.hydrationRunning') : t('admin.artists.hydrationIdle') }}</b></div>
        <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.hydrationQueue') }} <b>{{ hydration.queueLength || 0 }}</b> / {{ hydration.queueLimit || 0 }}</div>
        <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.hydrationSessionFixed') }} <b>{{ hydratedThisSession == null ? 0 : hydratedThisSession }}</b></div>
        <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.hydrationSuccessRate') }} <b>{{ hydration.stats.succeeded || 0 }}</b> / {{ hydration.stats.noImage || 0 }} / {{ hydration.stats.failed || 0 }}</div>
        <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.hydrationDropped') }} <b>{{ hydration.stats.dropped || 0 }}</b></div>
        <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.hydrationDiscogs') }} <b :style="discogsReady ? 'color:var(--ok,#16a34a);' : 'color:var(--warn,#b45309);'">{{ discogsReady ? t('admin.artists.discogsReady') : t('admin.artists.discogsNotReady') }}</b></div>
      </div>
      <div v-if="!hydration.running && (hydration.queueLength || 0) === 0 && (counts.missing || 0) > 0" style="margin-top:8px;font-size:.82rem;color:var(--t2);">
        {{ t('admin.artists.hydrationIdleHint') }}
      </div>
      <div v-if="(counts.noImage || 0) > 0" style="margin-top:8px;font-size:.82rem;color:var(--t2);">
        {{ t('admin.artists.noImageHint', { count: counts.noImage || 0 }) }}
      </div>
    </div>

    <div style="display:grid;grid-template-columns:minmax(340px,1fr) minmax(360px,1fr);gap:12px;margin-top:12px;align-items:start;">
      <div class="card z-depth-1" style="padding:10px 0;">
        <div style="padding:0 14px 8px;font-size:.86rem;color:var(--t2);">{{ t('admin.artists.artistCount', { count: artists.length }) }}</div>
        <div style="max-height:64vh;overflow:auto;">
          <div v-if="!artists.length && !loading" style="padding:12px 14px;color:var(--t2);">{{ t('admin.artists.listEmpty') }}</div>
          <button v-for="a in artists" :key="a.artistKey" @click="selectArtist(a)" class="btn-flat" style="width:100%;text-align:left;display:flex;align-items:center;gap:10px;border-radius:0;border-left:none;border-right:none;border-top:none;padding:9px 14px;">
            <img v-if="a.imageFile" :src="imgSrc(a.imageFile)" alt="" style="width:42px;height:42px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--border);" />
            <div v-else style="width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--raised);color:var(--t2);font-weight:700;flex-shrink:0;">{{ (a.canonicalName||'?').replace(/^The\s+/i,'').charAt(0).toUpperCase() }}</div>
            <div style="min-width:0;flex:1;">
              <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{{ a.canonicalName }}</div>
              <div style="font-size:.78rem;color:var(--t2);">{{ t('admin.artists.songCount', { count: a.songCount || 0 }) }}<span v-if="a.imageSource"> • {{ a.imageSource }}</span><span v-if="kind === 'no-image'"> • {{ t('admin.artists.statusNoImageTried') }}</span></div>
            </div>
            <span v-if="a.wrongFlag" style="font-size:.72rem;padding:3px 7px;border-radius:999px;background:rgba(180,83,9,.18);color:var(--warn,#b45309);">{{ t('admin.artists.badgeWrong') }}</span>
          </button>
        </div>
      </div>

      <div class="card z-depth-1" style="padding:14px;min-height:220px;">
        <div v-if="!selected" style="color:var(--t2);">{{ t('admin.artists.selectPrompt') }}</div>
        <div v-else>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
            <div>
              <div style="font-size:1rem;font-weight:700;">{{ selected.canonicalName }}</div>
              <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.songCount', { count: selected.songCount || 0 }) }}<span v-if="kind === 'no-image'"> • {{ t('admin.artists.statusNoImageTried') }}</span></div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button v-if="kind === 'with-image' || selected.wrongFlag" class="btn-flat" @click="setWrong(selected, false)">{{ t('admin.artists.btnImageOk') }}</button>
              <button v-if="kind === 'with-image' || !selected.wrongFlag" class="btn-flat" style="border-color:var(--warn,#b45309);color:var(--warn,#b45309);" @click="setWrong(selected, true)">{{ t('admin.artists.btnMarkWrong') }}</button>
            </div>
          </div>

          <div style="margin-bottom:12px;">
            <div style="font-size:.82rem;color:var(--t2);margin-bottom:6px;">{{ t('admin.artists.labelApplyUrl') }}</div>
            <div style="display:flex;gap:8px;">
              <input v-model="customImageUrl" @input="customImagePreviewError = false" type="url" :placeholder="t('admin.artists.urlPlaceholder')" style="flex:1;" />
              <button class="btn" @click="applyImage(customImageUrl, 'custom')" :disabled="!customImageUrl || applying">{{ t('admin.artists.btnApply') }}</button>
            </div>
            <div v-if="customImagePreviewUrl" style="margin-top:10px;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--surface);display:flex;gap:12px;align-items:flex-start;">
              <img v-show="!customImagePreviewError" :src="customImagePreviewUrl" @load="onCustomPreviewLoad" @error="onCustomPreviewError" alt="Custom preview" style="width:112px;height:112px;border-radius:10px;object-fit:cover;display:block;background:var(--raised);border:1px solid var(--border);flex-shrink:0;" />
              <div style="min-width:0;display:flex;flex-direction:column;gap:6px;">
                <div style="font-size:.82rem;font-weight:600;">{{ t('admin.artists.previewTitle') }}</div>
                <div v-if="customImagePreviewError" style="font-size:.8rem;color:var(--warn,#b45309);line-height:1.4;">{{ t('admin.artists.previewError') }}</div>
                <div v-else style="font-size:.8rem;color:var(--t2);line-height:1.4;">{{ t('admin.artists.previewDesc', { artist: selected.canonicalName }) }}</div>
                <div style="font-size:.74rem;color:var(--t3);word-break:break-all;">{{ customImagePreviewUrl }}</div>
              </div>
            </div>
          </div>

          <div style="font-size:.82rem;color:var(--t2);margin-bottom:8px;">{{ t('admin.artists.labelDiscogsSuggestions') }}</div>
          <div v-if="!discogsReady" style="padding:8px 0;color:var(--warn,#b45309);">{{ t('admin.artists.discogsDisabledHint') }}</div>
          <div v-else-if="candidateLoading" style="padding:8px 0;color:var(--t2);">{{ t('admin.artists.discogsLoading') }}</div>
          <div v-else-if="!candidates.length" style="padding:8px 0;color:var(--t2);">{{ t('admin.artists.discogsNone') }}</div>
          <div v-else style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;">
            <div v-for="c in candidates" :key="c.imageUrl" style="border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface);">
              <img :src="c.thumbUrl || c.imageUrl" alt="" style="width:100%;aspect-ratio:1;object-fit:cover;display:block;" />
              <div style="padding:8px;">
                <div style="font-size:.76rem;font-weight:600;line-height:1.3;max-height:2.2em;overflow:hidden;">{{ c.title }}</div>
                <div style="display:flex;gap:6px;margin-top:7px;">
                  <button class="btn btn-small" style="flex:1;" @click="applyImage(c.imageUrl, 'discogs')" :disabled="applying || !discogsReady">{{ t('admin.artists.btnUse') }}</button>
                  <a v-if="c.sourceUrl" class="btn-flat btn-small" :href="c.sourceUrl" target="_blank" rel="noopener" style="padding:0 8px;">{{ t('admin.artists.btnView') }}</a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  `
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
    'acoustid-view': acoustidView,
    'tagworkshop-view': tagWorkshopView,
    'genre-groups-view': genreGroupsView,
    'artists-admin-view': artistsAdminView,
    'languages-view': languagesView,
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
