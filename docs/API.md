# mStream API

mStream uses a REST based API for everything.  

All calls to the API are done through GET and POST requests.  Make sure to set your `Content-Type` header to `application/json` when making a POST request

```
// jQuery Example

var request = $.ajax({
  url: "login",
  type: "POST",
  contentType: "application/json",
  dataType: "json",
  data: JSON.stringify(
    {
      username: "Bojack",
      password: "family"
    }
  )
});
```

## Streaming Files

To stream a file you need a three pieces  of information:
- The filepath - this is the relative filepath as it would show up on your disk
- The vPath - This is a virtual directory that's created on boot for security reasons.  It can be obtained through ['/ping'](API/ping.md) or ['/login'](API/login.md)
- The token - The user token (the token is only needed if user system is enable)

To stream a file create a URL with the following structure
```
https://yourserver.com/media/[your vPath]/path/to/song.mp3?token=XXXXXXXX
```


## File Explorer

[/dirparser](API/dirparser.md)

[/upload](API/upload.md) — audio-only file type restriction enforced *(GitHub Copilot, 2026-02-27)*

[/api/v1/files/art — on-demand embedded album art extraction for unscanned files](API/files_art.md) *(v5.16.32)*

## Playlists

[/playlist/getall](API/playlist_getall.md)

[/playlist/load](API/playlist_load.md)

[/playlist/save](API/playlist_save.md)

[/playlist/delete](API/playlist_delete.md)

[/playlist/rename](API/playlist_rename.md) *(v6.0.1-velvet)*

[/playlist/new, /playlist/add-song, /playlist/remove-song](API/playlist_manage.md) *(GitHub Copilot, 2026-02-27)*

## Metadata (Albums/Artists/Etc)

[/db/metadata](API/db_metadata.md)

[/db/search](API/db_search.md)

[/db/albums](API/db_albums.md) — GET (all) and POST with `ignoreVPaths`, `excludeFilepathPrefixes`, `includeFilepathPrefixes` (whitelist) *(updated v5.16.30)*

[/db/artists](API/db_artists.md)

[/db/artists-albums](API/db_artists-albums.md) — accepts same filter params as `/db/albums` *(updated v5.16.30)*

[/db/album-songs](API/db_album-songs.md)

[/db/status](API/db_status.md)

[/db/recursive-scan](API/db_recursive-scan.md)

[/db/cuepoints](API/db_cuepoints.md) — CUE sheet chapter markers for a file *(GitHub Copilot, 2026-03-02)*

## Album Library *(v6.1.0-velvet)*

[/api/v1/albums/browse — full DB-driven album tree with series, discs, tracks, and art](API/albums_browse.md)

[/api/v1/albums/art-file — serve an on-disk cover art image by relative path](API/albums_browse.md#get-apiv1albumsart-file)

### Play Statistics *(GitHub Copilot, 2026-02-27)*

[/db/recent/added, /db/stats/recently-played, /db/stats/most-played](API/db_stats-queries.md)

[/db/stats/log-play — record a play (always active, no scrobbling required)](API/db_stats-queries.md#log-a-play) *(GitHub Copilot, 2026-03-27)*

[/db/stats/reset-play-counts, /db/stats/reset-recently-played](API/db_stats-reset.md)

### Your Stats — Listening Events *(GitHub Copilot, 2026-04-03)*

`POST /api/v1/wrapped/play-start` · `play-end` · `play-skip` · `play-stop` · `session-end` — song player event hooks

`POST /api/v1/wrapped/radio-start` · `radio-stop` — radio station tracking

`POST /api/v1/wrapped/podcast-start` · `podcast-end` — podcast episode tracking

`GET /api/v1/user/wrapped` · `GET /api/v1/user/wrapped/periods` — per-user statistics

`GET /api/v1/admin/wrapped/stats` · `POST /api/v1/admin/wrapped/purge` — admin overview + purge

See [docs/your-stats.md](your-stats.md) for full schema and field reference.

[/db/rate-song](API/db_rate-song.md)

[/db/rated](API/db_rated.md)

[/db/random-songs](API/db_random-songs.md)

[/db/genres, /db/genre/songs](API/db_genres.md) — normalised genre list + songs by genre *(GitHub Copilot, 2026-03-04)*

[/db/decades, /db/decade/albums](API/db_decades.md) — decade list + albums by decade *(GitHub Copilot, 2026-03-04)*

[/db/waveform](API/db_waveform.md) — waveform amplitude array for the scrubber *(GitHub Copilot, 2026-03-05)*

## Last.fm

[Last.fm integration — scrobbling, connect/disconnect, similar artists, admin key config](API/lastfm.md) *(GitHub Copilot, 2026-03-05)*

[/lastfm/similar-artists](API/lastfm_similar-artists.md) *(GitHub Copilot, 2026-03-04)*

## Discogs

[Discogs cover art — search, embed, admin config](API/discogs.md) *(GitHub Copilot, 2026-03-07)*

## Admin — Directory Flags

[/admin/directory/flags — PATCH albumsOnly and allowRecordDelete per folder](API/admin_directory-flags.md) *(GitHub Copilot, 2026-03-29)*

## Admin — ID3 Tag Editing

[ID3 tag write — enable setting, write tags to file](API/admin_id3-tags.md) *(GitHub Copilot, 2026-03-09)*

## User Settings *(GitHub Copilot, 2026-03-18)*

[/user/settings — persist and restore prefs + queue across devices](API/user-settings.md)

## Radio *(GitHub Copilot, 2026-03-20)*

[/radio — stations CRUD, reorder, stream proxy, ICY now-playing, logo caching, admin config; recording stop returns `relPath`, `vpath`, `stationName`, `artFile`](API/radio.md) *(stop response enriched v5.16.32)*

## Podcasts *(GitHub Copilot, 2026-03-21)*

[/podcast — subscribe, list, refresh, rename, reorder, delete feeds; episode list; playback progress](API/podcasts.md)

## Smart Playlists *(GitHub Copilot, 2026-03-22)*

[/api/v1/smart-playlists — run, count, save, update, delete; filter schema with Fresh Picks and library selection](API/smart-playlists.md)

## Genre Groups *(GitHub Copilot, 2026-03-22)*

[/api/v1/db/genre-groups, /api/v1/admin/genre-groups — admin-configurable display groupings used in genre browser and smart playlist builder](API/admin_genre-groups.md)

## Albums-Only Folders *(GitHub Copilot, 2026-03-29)*

[Albums-Only — restrict the Albums view to designated folders](albums-only.md)

## Home View *(GitHub Copilot, 2026-03-27)*

[Home view — shelves, drag-to-reorder, Customize mode, Recently Played](home-view.md)

## JukeBox

[/jukebox/sessions](API/jukebox_sessions.md) *(admin)*

## YouTube Download *(v5.16.32)*

[/api/v1/ytdl — preview metadata, download & tag to YouTube folder; Opus METADATA_BLOCK_PICTURE art; temp-isolated; auto-managed yt-dlp + ffmpeg](API/ytdl.md)

## Download

[/download](API/download.md)

## Share

[/shared/make-shared](API/shared_make-shared.md) *(legacy)*

[/shared/get-token-and-playlist](API/shared_get-token-and-playlist.md) *(legacy)*

[/api/v1/share — create, list, revoke + expired-link page](API/shared_share.md) *(GitHub Copilot, 2026-02-27)*


## Login System & Authentication

mStream uses a token based authentication.  The token you get when logging in can be used to access the API endpoints and the music files.

Login Functions:

* [/login](API/login.md)
* [/ping](API/ping.md) — now returns `supportedAudioFiles` map *(GitHub Copilot, 2026-02-27)*
* /change-password - Coming Soon

Failure Endpoints:

* /access-denied

The security layer is written as a plugin.  If you don't set the username and password on boot the plugin won't load and your server will be accessible by to anyone.  All API endpoints require a token to access if the login system is enabled.  Tokens can be passed in through the GET or POST param token.  Tokens can also be put in the request header under 'x-access-token'

If you want your tokens to work between reboots you can set the `secret` flag when booting by using `mstream -s YOUR_SECERT_STRING_HERE`.  The secret key is used to sign the tokens. If you do not set the secret key mStream will generate a random key on boot

## Scanner (Internal)

> These endpoints are protected by the internal scanner middleware and are not
> intended for external use.

[/scanner/update-art](API/scanner_update-art.md) *(GitHub Copilot, 2026-02-27)*

[/scanner/update-cue](API/scanner_update-cue.md) — write cue point data for a file (internal scanner only) *(GitHub Copilot, 2026-03-02)*

## Pages

These endpoints server various parts of the webapp

* /
* /remote
* /shared/playlist/[PLAYLIST ID]
