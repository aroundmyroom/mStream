var JUKEBOX = (function () {
  let mstreamModule = {};

  mstreamModule.connection = false;

  // jukebox global variable
  mstreamModule.stats = {
    // connection: false,
    live: false,
    adminCode: false,
    error: false,
    accessAddress: false
  };

  mstreamModule.createWebsocket = function(accessKey, code, callback){
    if(mstreamModule.stats.live ===true ){
      return false;
    }
    mstreamModule.stats.live = true;
    // if user is running mozilla then use it's built-in WebSocket
    window.WebSocket = window.WebSocket || window.MozWebSocket;

    // if browser doesn't support WebSocket, just show some notification and exit
    if (!window.WebSocket) {
      iziToast.error({
        title: 'Jukebox Not Started',
        message: 'WebSockets Are Not Supported!',
        position: 'topCenter',
        timeout: 3500
      });
      return;
    }

    // TODO: Check if websocket has already been created

    // open connection
    let wsLink = '';
    if (MSTREAMAPI.currentServer.host) {
      wsLink = MSTREAMAPI.currentServer.host;
      wsLink = wsLink.replace('https://', 'wss://');
      wsLink = wsLink.replace('http://', 'ws://');
      wsLink += '?';
    }else {
      wsLink = ((window.location.protocol === "https:") ? "wss://" : "ws://") + window.location.host + '?';
    }

    if (accessKey) {
      wsLink = wsLink + 'token=' + accessKey;
      if (code) {
        wsLink = wsLink + '&';
      }
    } 
    if (code) {
      wsLink = wsLink + 'code=' + code;
    }
    mstreamModule.connection = new WebSocket(wsLink);

    mstreamModule.connection.onclose = function (event) {
      iziToast.warning({
        title: 'Jukebox Connection Closed',
        position: 'topCenter',
        timeout: 3500
      });
      mstreamModule.stats.live = false;
      mstreamModule.stats.adminCode = false;
      mstreamModule.stats.error = false;
      mstreamModule.stats.accessAddress = false;

      mstreamModule.connection = false;
    };

    mstreamModule.connection.onerror = function (error) {
      iziToast.error({
        title: 'Jukebox Connection Error',
        position: 'topCenter',
        timeout: 3500
      });
      console.log('Jukebox Connection Error!')
      console.log(error);
    };

    // most important part - incoming messages
    mstreamModule.connection.onmessage = function (message) {
      // try to parse JSON message. Because we know that the server always returns
      // JSON this should work without any problem but we should make sure that
      // the message is not chunked or otherwise damaged.
      try {
        var json = JSON.parse(message.data);
      } catch (e) {
        return;
      }

      // Handle Code
      if(json.code){
        mstreamModule.stats.adminCode = json.code;
        callback();
      }


      if(!json.command){
        return;
      }

      if(json.command === 'next'){
        MSTREAMPLAYER.nextSong();
        return;
      }
      if( json.command === 'playPause'){
        MSTREAMPLAYER.playPause();
      }
      if( json.command === 'previous'){
        MSTREAMPLAYER.previousSong();
        return;
      }
      if( json.command === 'addSong' && json.file){
        VUEPLAYERCORE.addSongWizard(json.file, {}, true);
        return;
      }

      if (json.command === 'getPlaylist') {
        var playlist = MSTREAMPLAYER.playlist.map(function(song, index) {
          return {
            index: index,
            filepath: song.rawFilePath || song.filepath || '',
            title: song.metadata ? song.metadata.title : null,
            artist: song.metadata ? song.metadata.artist : null,
            album: song.metadata ? song.metadata.album : null,
            albumArt: song.metadata ? song.metadata['album-art'] : null
          };
        });
        fetch('/api/v1/jukebox/update-playlist', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-access-token': MSTREAMAPI.currentServer.token
          },
          body: JSON.stringify({ code: mstreamModule.stats.adminCode, playlist: playlist })
        }).catch(function(e) { console.error('update-playlist failed:', e); });
        return;
      }

      if (json.command === 'getNowPlaying') {
        var meta = MSTREAMPLAYER.playerStats.metadata;
        var currentSong = MSTREAMPLAYER.playlist[MSTREAMPLAYER.positionCache.val];
        var ct = MSTREAMPLAYER.playerStats.currentTime;
        var dur = MSTREAMPLAYER.playerStats.duration;
        var nowPlaying = {
          title: meta.title || '',
          artist: meta.artist || '',
          album: meta.album || '',
          albumArt: meta['album-art'] || '',
          filepath: currentSong ? (currentSong.filepath || currentSong.url || '') : '',
          playing: MSTREAMPLAYER.playerStats.playing,
          index: MSTREAMPLAYER.positionCache.val,
          currentTime: (ct && isFinite(ct)) ? ct : 0,
          duration: (dur && isFinite(dur)) ? dur : 0
        };
        fetch('/api/v1/jukebox/update-now-playing', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-access-token': MSTREAMAPI.currentServer.token
          },
          body: JSON.stringify({ code: mstreamModule.stats.adminCode, nowPlaying: nowPlaying })
        }).catch(function(e) { console.error('update-now-playing failed:', e); });
        return;
      }

      if (json.command === 'goToSong') {
        var goIdx = parseInt(json.file);
        if (!isNaN(goIdx)) {
          MSTREAMPLAYER.goToSongAtPosition(goIdx);
        }
        return;
      }

      if (json.command === 'removeSong') {
        var removeIdx = parseInt(json.file);
        if (!isNaN(removeIdx)) {
          MSTREAMPLAYER.removeSongAtPosition(removeIdx);
        }
        return;
      }
    };
  }

  mstreamModule.autoConnect = false;
  mstreamModule.setAutoConnect = function(code) {
    if (mstreamModule.autoConnect) {
      return;
    }

    mstreamModule.autoConnect = setInterval(function() {
      if (mstreamModule.connection) {
        return;
      }

      mstreamModule.createWebsocket(MSTREAMAPI.currentServer.token, code, function() {
        iziToast.success({
          title: 'Jukebox Connected',
          position: 'topCenter',
          timeout: 3500
        });
      });
    }, 5000);
  }

  return mstreamModule;
}());
