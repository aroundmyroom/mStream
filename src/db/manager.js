import winston from 'winston';
import * as config from '../state/config.js';

let backend;
let clearShared;

export async function initDB() {
  if (config.program.db.engine === 'sqlite') {
    backend = await import('./sqlite-backend.js');
  } else {
    backend = await import('./loki-backend.js');
  }

  await backend.init(config.program.storage.dbDirectory, config.program.db);

  // Shared playlist cleanup interval
  if (clearShared) {
    clearInterval(clearShared);
    clearShared = undefined;
  }

  if (config.program.db.clearSharedInterval) {
    clearShared = setInterval(() => {
      try {
        backend.removeExpiredSharedPlaylists();
        backend.saveShareDB();
        winston.info('Successfully cleared shared playlists');
      } catch (err) {
        winston.error('Failed to clear expired saved playlists', { stack: err });
      }
    }, config.program.db.clearSharedInterval * 60 * 60 * 1000);
  }
}

// Save operations
export function saveFilesDB() { backend.saveFilesDB(); }
export function saveUserDB() { backend.saveUserDB(); }
export function saveShareDB() { backend.saveShareDB(); }

// File Operations
export function findFileByPath(filepath, vpath) { return backend.findFileByPath(filepath, vpath); }
export function updateFileScanId(file, scanId) { return backend.updateFileScanId(file, scanId); }
export function insertFile(fileData) { return backend.insertFile(fileData); }
export function removeFileByPath(filepath, vpath) { return backend.removeFileByPath(filepath, vpath); }
export function getLiveArtFilenames() { return backend.getLiveArtFilenames(); }
export function getLiveHashes() { return backend.getLiveHashes(); }
export function getStaleFileHashes(vpath, scanId) { return backend.getStaleFileHashes(vpath, scanId); }
export function removeStaleFiles(vpath, scanId) { return backend.removeStaleFiles(vpath, scanId); }
export function removeFilesByVpath(vpath) { return backend.removeFilesByVpath(vpath); }
export function countFilesByVpath(vpath) { return backend.countFilesByVpath(vpath); }
export function getStats() { return backend.getStats(); }

// Metadata Queries
export function updateFileArt(filepath, vpath, aaFile, scanId, artSource) { return backend.updateFileArt(filepath, vpath, aaFile, scanId, artSource); }
export function countArtUsage(aaFile) { return backend.countArtUsage(aaFile); }
export function updateFileCue(filepath, vpath, cuepoints) { return backend.updateFileCue(filepath, vpath, cuepoints); }
export function updateFileDuration(filepath, vpath, duration) { return backend.updateFileDuration(filepath, vpath, duration); }
export function getFileDuration(filepath) { return backend.getFileDuration(filepath); }
export function updateFileTags(filepath, vpath, tags) { return backend.updateFileTags(filepath, vpath, tags); }
export function getFileWithMetadata(filepath, vpath, username) { return backend.getFileWithMetadata(filepath, vpath, username); }
export function getArtists(vpaths, ignoreVPaths) { return backend.getArtists(vpaths, ignoreVPaths); }
export function getArtistAlbums(artist, vpaths, ignoreVPaths) { return backend.getArtistAlbums(artist, vpaths, ignoreVPaths); }
export function getAlbums(vpaths, ignoreVPaths) { return backend.getAlbums(vpaths, ignoreVPaths); }
export function getAlbumSongs(album, vpaths, username, opts) { return backend.getAlbumSongs(album, vpaths, username, opts); }
export function searchFiles(searchCol, searchTerm, vpaths, ignoreVPaths, filepathPrefix) { return backend.searchFiles(searchCol, searchTerm, vpaths, ignoreVPaths, filepathPrefix); }
export function searchFilesAllWords(tokens, vpaths, ignoreVPaths, filepathPrefix) { return backend.searchFilesAllWords(tokens, vpaths, ignoreVPaths, filepathPrefix); }
export function getRatedSongs(vpaths, username, ignoreVPaths) { return backend.getRatedSongs(vpaths, username, ignoreVPaths); }
export function getRecentlyAdded(vpaths, username, limit, ignoreVPaths, opts) { return backend.getRecentlyAdded(vpaths, username, limit, ignoreVPaths, opts); }
export function getRecentlyPlayed(vpaths, username, limit, ignoreVPaths, opts) { return backend.getRecentlyPlayed(vpaths, username, limit, ignoreVPaths, opts); }
export function getMostPlayed(vpaths, username, limit, ignoreVPaths, opts) { return backend.getMostPlayed(vpaths, username, limit, ignoreVPaths, opts); }
export function getAllFilesWithMetadata(vpaths, username, opts) { return backend.getAllFilesWithMetadata(vpaths, username, opts); }
export function countFilesForRandom(vpaths, username, opts) { return backend.countFilesForRandom(vpaths, username, opts); }
export function pickFileAtOffset(vpaths, username, opts, offset) { return backend.pickFileAtOffset(vpaths, username, opts, offset); }
export function getGenres(vpaths, ignoreVPaths, opts) { return backend.getGenres(vpaths, ignoreVPaths, opts); }
export function getSongsByGenre(genre, vpaths, username, ignoreVPaths, opts) { return backend.getSongsByGenre(genre, vpaths, username, ignoreVPaths, opts); }
export function getSongsByGenreRaw(rawGenres, vpaths, username, ignoreVPaths) { return backend.getSongsByGenreRaw(rawGenres, vpaths, username, ignoreVPaths); }
export function getDecades(vpaths, ignoreVPaths) { return backend.getDecades(vpaths, ignoreVPaths); }
export function getAlbumsByDecade(decade, vpaths, ignoreVPaths) { return backend.getAlbumsByDecade(decade, vpaths, ignoreVPaths); }
export function getSongsByDecade(decade, vpaths, username, ignoreVPaths) { return backend.getSongsByDecade(decade, vpaths, username, ignoreVPaths); }
export function getAlbumsByGenre(rawGenres, vpaths, ignoreVPaths) { return backend.getAlbumsByGenre(rawGenres, vpaths, ignoreVPaths); }

// User Metadata
export function findUserMetadata(hash, username) { return backend.findUserMetadata(hash, username); }
export function insertUserMetadata(obj) { return backend.insertUserMetadata(obj); }
export function updateUserMetadata(obj) { return backend.updateUserMetadata(obj); }
export function removeUserMetadataByUser(username) { return backend.removeUserMetadataByUser(username); }
export function resetPlayCounts(username) { return backend.resetPlayCounts(username); }
export function resetRecentlyPlayed(username) { return backend.resetRecentlyPlayed(username); }

// Playlists
export function getUserPlaylists(username) { return backend.getUserPlaylists(username); }
export function findPlaylist(username, playlistName) { return backend.findPlaylist(username, playlistName); }
export function createPlaylistEntry(entry) { return backend.createPlaylistEntry(entry); }
export function deletePlaylist(username, playlistName) { return backend.deletePlaylist(username, playlistName); }
export function getPlaylistEntryById(id) { return backend.getPlaylistEntryById(id); }
export function removePlaylistEntryById(id) { return backend.removePlaylistEntryById(id); }
export function loadPlaylistEntries(username, playlistName) { return backend.loadPlaylistEntries(username, playlistName); }
export function removePlaylistsByUser(username) { return backend.removePlaylistsByUser(username); }

// Shared Playlists
export function findSharedPlaylist(playlistId) { return backend.findSharedPlaylist(playlistId); }
export function insertSharedPlaylist(item) { return backend.insertSharedPlaylist(item); }
export function getAllSharedPlaylists() { return backend.getAllSharedPlaylists(); }
export function removeSharedPlaylistById(playlistId) { return backend.removeSharedPlaylistById(playlistId); }
export function removeExpiredSharedPlaylists() { return backend.removeExpiredSharedPlaylists(); }
export function removeEternalSharedPlaylists() { return backend.removeEternalSharedPlaylists(); }
export function removeSharedPlaylistsByUser(username) { return backend.removeSharedPlaylistsByUser(username); }
// Scan Error Audit
export function insertScanError(guid, filepath, vpath, errorType, errorMsg, stack) { return backend.insertScanError(guid, filepath, vpath, errorType, errorMsg, stack); }
export function getScanErrors() { return backend.getScanErrors(); }
export function clearScanErrors() { return backend.clearScanErrors(); }
export function pruneScanErrors(retentionHours) { return backend.pruneScanErrors(retentionHours); }
export function getScanErrorCount() { return backend.getScanErrorCount(); }
export function markScanErrorFixed(guid, fixAction) { return backend.markScanErrorFixed(guid, fixAction); }
export function confirmScanErrorOk(filepath, vpath) { return backend.confirmScanErrorOk(filepath, vpath); }
export function markFileArtChecked(filepath, vpath) { return backend.markFileArtChecked(filepath, vpath); }
export function markFileCueChecked(filepath, vpath) { return backend.markFileCueChecked(filepath, vpath); }

// Subsonic queries
export function getFilesByArtistId(artistId, vpaths, username, opts) { return backend.getFilesByArtistId(artistId, vpaths, username, opts); }
export function getFilesByAlbumId(albumId, vpaths, username, opts) { return backend.getFilesByAlbumId(albumId, vpaths, username, opts); }
export function getSongByHash(hash, username) { return backend.getSongByHash(hash, username); }
export function getAaFileById(id) { return backend.getAaFileById(id); }
export function getAaFileForDir(vpath, dirRelPath) { return backend.getAaFileForDir(vpath, dirRelPath); }
export function clearAaFileForDirCache() { if (backend.clearAaFileForDirCache) backend.clearAaFileForDirCache(); }
export function getStarredSongs(vpaths, username, opts) { return backend.getStarredSongs(vpaths, username, opts); }
export function getStarredAlbums(vpaths, username, opts) { return backend.getStarredAlbums(vpaths, username, opts); }
export function setStarred(hash, username, starred) { return backend.setStarred(hash, username, starred); }
export function getRandomSongs(vpaths, username, opts) { return backend.getRandomSongs(vpaths, username, opts); }
export function getAlbumsByArtistId(artistId, vpaths, opts) { return backend.getAlbumsByArtistId(artistId, vpaths, opts); }
export function getAllAlbumIds(vpaths, opts) { return backend.getAllAlbumIds(vpaths, opts); }
export function getAllArtistIds(vpaths, opts) { return backend.getAllArtistIds(vpaths, opts); }
export function getDirectoryContents(vpath, dirRelPath, username) { return backend.getDirectoryContents(vpath, dirRelPath, username); }
// User settings sync
export function getUserSettings(username) { return backend.getUserSettings(username); }
export function saveUserSettings(username, patch) { return backend.saveUserSettings(username, patch); }