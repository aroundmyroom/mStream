const MSTREAMAPI = (() => {
  const m = {};

  m.fileExplorerArray = [{ name: '/', position: 0 }];

  function apiPost(url, data) {
    return axios({
      method: 'POST',
      url: url,
      headers: { 'x-access-token': window.remoteProperties.token },
      data: data
    });
  }

  // ── File Explorer ─────────────────────────────────────────────────────────────

  m.getCurrentDirectoryContents = function () {
    var directoryString = m.fileExplorerArray
      .filter(function(e) { return e.name !== '/'; })
      .map(function(e) { return e.name + '/'; })
      .join('');

    return apiPost('/api/v1/file-explorer', { directory: directoryString });
  };

  m.goToNextDirectory = function (folder) {
    m.fileExplorerArray.push({ name: folder, position: 0 });
  };

  m.goBackDirectory = function () {
    if (m.fileExplorerArray.length > 1) {
      m.fileExplorerArray.pop();
    }
  };

  // ── Albums ────────────────────────────────────────────────────────────────────

  m.getAlbums = function () {
    return apiPost('/api/v1/db/albums', {});
  };

  m.getAlbumSongs = function (album, artist, year) {
    var data = { album: album };
    if (artist) { data.artist = artist; }
    if (year)   { data.year = year; }
    return apiPost('/api/v1/db/album-songs', data);
  };

  // ── Artists ───────────────────────────────────────────────────────────────────

  m.getArtists = function () {
    return apiPost('/api/v1/db/artists', {});
  };

  m.getArtistAlbums = function (artist) {
    return apiPost('/api/v1/db/artists-albums', { artist: artist });
  };

  // ── Search ────────────────────────────────────────────────────────────────────

  m.search = function (query) {
    return apiPost('/api/v1/db/search', { search: query });
  };

  // ── Playlist ──────────────────────────────────────────────────────────────────

  m.fetchPlaylist = function (code) {
    return axios.get('/api/v1/jukebox/get-playlist?code=' + code);
  };

  m.fetchNowPlaying = function (code) {
    return axios.get('/api/v1/jukebox/get-now-playing?code=' + code);
  };

  return m;
})();
