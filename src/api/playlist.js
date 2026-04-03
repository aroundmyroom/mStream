import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const _pkg = _require('../../package.json');

export function setup(mstream) {
  // TODO: This is a legacy endpoint that should be improved
  mstream.get('/api/v1/ping', (req, res) => {
    let transcode = false;
    if (config.program.transcode && config.program.transcode.enabled) {
      transcode = {
        defaultCodec: config.program.transcode.defaultCodec,
        defaultBitrate: config.program.transcode.defaultBitrate,
        defaultAlgorithm: config.program.transcode.algorithm
      }
    }

    const returnThis = {
      vpaths: req.user.vpaths,
      playlists: db.getUserPlaylists(req.user.username),
      transcode,
      noUpload: config.program.noUpload === true,
      supportedAudioFiles: config.program.supportedAudioFiles,
      vpathMetaData: {}
    };

    const allFolders = config.program.folders;
    const allKeys = Object.keys(allFolders);
    req.user.vpaths.forEach(p => {
      if (!allFolders[p]) { return; }
      const myRoot = allFolders[p].root.replace(/\/?$/, '/');
      // Find if this vpath's root sits inside another vpath the user has access to
      const parentVpath = req.user.vpaths.find(other =>
        other !== p &&
        allFolders[other] &&
        myRoot.startsWith(allFolders[other].root.replace(/\/?$/, '/')) &&
        allFolders[other].root.replace(/\/?$/, '/') !== myRoot
      );
      returnThis.vpathMetaData[p] = {
        type: allFolders[p].type,
        // parentVpath: the vpath that physically covers this folder's files in the DB
        // filepathPrefix: the relative path prefix to filter by inside the parent vpath
        parentVpath: parentVpath || null,
        // Normalize child root with a trailing slash before slicing so the
        // prefix always ends with '/' (e.g. "Disco/" not "Disco").
        // Without the slash, SQLite LIKE 'Disco%' would incorrectly match
        // sibling folders like "Disco Mix Club Series/".
        filepathPrefix: parentVpath
          ? allFolders[p].root.replace(/\/?$/, '/').slice(allFolders[parentVpath].root.replace(/\/?$/, '/').length)
          : null,
        allowRecordDelete: allFolders[p].allowRecordDelete === true,
        albumsOnly: allFolders[p].albumsOnly === true
      };
    });

    returnThis.allowRadioRecording = req.user['allow-radio-recording'] === true;
    returnThis.allowYoutubeDownload = req.user['allow-youtube-download'] === true;
    returnThis.version = _pkg.version;

    res.json(returnThis);
  });

  mstream.post('/api/v1/playlist/delete', (req, res) => {
    const schema = Joi.object({ playlistname: Joi.string().required() });
    joiValidate(schema, req.body);

    db.deletePlaylist(req.user.username, req.body.playlistname);
    db.saveUserDB();
    res.json({});
  });

  mstream.post('/api/v1/playlist/rename', (req, res) => {
    const schema = Joi.object({
      oldName: Joi.string().required(),
      newName: Joi.string().required()
    });
    joiValidate(schema, req.body);

    if (db.findPlaylist(req.user.username, req.body.newName) !== null) {
      return res.status(400).json({ error: 'Playlist name already in use' });
    }

    db.renamePlaylist(req.user.username, req.body.oldName, req.body.newName);
    db.saveUserDB();
    res.json({});
  });

  mstream.post('/api/v1/playlist/add-song', (req, res) => {
    const schema = Joi.object({
      song: Joi.string().required(),
      playlist: Joi.string().required()
    });
    joiValidate(schema, req.body);

    db.createPlaylistEntry({
      name: req.body.playlist,
      filepath: req.body.song,
      user: req.user.username
    });

    db.saveUserDB();
    res.json({});
  });

  mstream.post('/api/v1/playlist/remove-song', (req, res) => {
    const schema = Joi.object({ id: Joi.number().integer().required() });
    joiValidate(schema, req.body);

    const result = db.getPlaylistEntryById(req.body.id);
    if (!result || result.user !== req.user.username) {
      throw new Error(`User ${req.user.username} tried accessing a resource they don't have access to. Playlist ID: ${req.body.id}`);
    }

    db.removePlaylistEntryById(req.body.id);
    db.saveUserDB();
    res.json({});
  });

  mstream.post('/api/v1/playlist/new', (req, res) => {
    const schema = Joi.object({ title: Joi.string().required() });
    joiValidate(schema, req.body);

    const results = db.findPlaylist(req.user.username, req.body.title);
    if (results !== null) {
      return res.status(400).json({ error: 'Playlist Already Exists' });
    }

    // insert null entry
    db.createPlaylistEntry({
      name: req.body.title,
      filepath: null,
      user: req.user.username,
      live: false
    });

    db.saveUserDB();
    res.json({});
  });

  mstream.post('/api/v1/playlist/save', (req, res) => {
    const schema = Joi.object({
      title: Joi.string().required(),
      songs: Joi.array().items(Joi.string()),
      live: Joi.boolean().optional()
    });
    joiValidate(schema, req.body);

    // Delete existing playlist
    db.deletePlaylist(req.user.username, req.body.title);

    for (const song of req.body.songs) {
      db.createPlaylistEntry({
        name: req.body.title,
        filepath: song,
        user: req.user.username
      });
    }

    // insert null entry
    db.createPlaylistEntry({
      name: req.body.title,
      filepath: null,
      user: req.user.username,
      live: typeof req.body.live === 'boolean' ? req.body.live : false
    });

    db.saveUserDB();
    res.json({});
  });

  mstream.get('/api/v1/playlist/getall', (req, res) => {
    res.json(db.getUserPlaylists(req.user.username));
  });
}
