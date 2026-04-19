/**
 * DLNA / UPnP MediaServer for mStream Velvet
 *
 * Architecture
 * ────────────
 * Runs a dedicated plain-HTTP Express server (default port 10293) alongside
 * the main mStream server.  Most DLNA clients (smart TVs, AV receivers) cannot
 * handle HTTPS or mStream's JWT auth, so a separate unprotected HTTP endpoint
 * is the standard approach.
 *
 * Feature is DISABLED by default.  Admin enables it via the admin panel.
 * When enabled, SSDP multicast advertises the server on the LAN so devices
 * can discover it automatically — no manual IP entry needed.
 *
 * Browse hierarchy exposed to DLNA clients
 * ─────────────────────────────────────────
 *   Root (id=0)
 *   └── All Albums (id='albums')
 *       ├── <Album A> (id='alb_<base64>', container)
 *       │   └── Track 01 … N (item, id='itm_<base64>')
 *       └── …
 *
 * Security note
 * ─────────────
 * The DLNA port serves all music-type vpaths without authentication.
 * It must only be exposed on a trusted LAN — never port-forward it to the internet.
 * This is documented in the admin UI and in docs/dlna.md.
 */

import os   from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { createRequire } from 'module';
import winston from 'winston';
import Joi from 'joi';

import * as config from '../state/config.js';
import * as db     from '../db/manager.js';
import * as adminUtil from '../util/admin.js';
import { joiValidate } from '../util/validation.js';
import { resolveAlbumsSources } from './albums-browse.js';

const require = createRequire(import.meta.url);

// ─── Module state ─────────────────────────────────────────────────────────────

/** @type {import('node-ssdp').Server|null} */
let _ssdpServer = null;
/** @type {import('http').Server|null} */
let _httpServer = null;
let _running = false;

// ─── Utilities ────────────────────────────────────────────────────────────────

/** First non-loopback IPv4 address, used in SSDP Location header */
function getLanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ─── Source file cache ───────────────────────────────────────────────────────
// All files for each albumsOnly source are loaded once and cached for 5 minutes.
// listChildren() filters from the in-memory array so any folder level can be
// browsed without extra DB queries per request.

const _sourceFilesCache = new Map();
const SOURCE_FILES_CACHE_TTL = 5 * 60 * 1000;

function getSourceFiles(source) {
  const cached = _sourceFilesCache.get(source.vpathName);
  if (cached && Date.now() - cached.ts < SOURCE_FILES_CACHE_TTL) return cached.files;
  const files = db.getFilesForAlbumsBrowse([{ vpath: source.dbVpath, prefix: source.prefix }]);
  _sourceFilesCache.set(source.vpathName, { files, ts: Date.now() });
  return files;
}

/**
 * List immediate children (subdirs + direct songs) under parentPrefix.
 * parentPrefix MUST end with '/'  (e.g. 'Albums/' or 'Albums/Top 700/')
 * Works entirely from the per-source in-memory cache — no extra DB queries.
 */
function listChildren(source, parentPrefix) {
  const allFiles = getSourceFiles(source);
  const prefixLen = parentPrefix.length;
  const dirsMap = new Map(); // dirName → { name, sampleFile }
  const songs = [];

  for (const row of allFiles) {
    const fp = String(row.filepath);
    if (!fp.startsWith(parentPrefix)) continue;
    const rel   = fp.slice(prefixLen);
    const slash = rel.indexOf('/');
    if (slash === -1) {
      songs.push(row); // direct-child song
    } else {
      const dirName = rel.slice(0, slash);
      if (!dirsMap.has(dirName)) dirsMap.set(dirName, { name: dirName, sampleFile: row });
    }
  }

  const dirs = [...dirsMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
  songs.sort((a, b) =>
    ((a.track || 999) - (b.track || 999)) ||
    String(a.filepath).localeCompare(String(b.filepath))
  );
  return { dirs, songs };
}

/** XML-escape a string for inclusion in XML element content or attribute values */
function xmlEsc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Map file extension to MIME type for DLNA protocolInfo */
function ext2mime(fp) {
  return ({
    '.mp3':  'audio/mpeg',
    '.flac': 'audio/flac',
    '.ogg':  'audio/ogg',
    '.opus': 'audio/opus',
    '.m4a':  'audio/mp4',
    '.m4b':  'audio/mp4',
    '.aac':  'audio/aac',
    '.wav':  'audio/wav',
  })[path.extname(String(fp)).toLowerCase()] || 'audio/mpeg';
}

/** Format seconds as HH:MM:SS.mmm for DIDL <res duration="..."> */
function durFmt(secs) {
  if (!secs || secs <= 0) return '0:00:00.000';
  const s = parseFloat(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3).padStart(6, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
}

// ─── Object-ID encoding ───────────────────────────────────────────────────────
// All IDs are opaque base64url strings so special characters in album names and
// file paths don't cause XML / URL issues.

/** Encode an albumsOnly source (vpathName) into a DLNA container objectId */
function encSrc(vpathName) {
  return 'src_' + Buffer.from(String(vpathName)).toString('base64url');
}
/** Decode source objectId back to vpathName */
function decSrc(id) {
  try { return Buffer.from(id.replace(/^src_/, ''), 'base64url').toString(); }
  catch { return null; }
}
/** Encode a directory path into a DLNA container objectId */
function encDir(dbVpath, dirPath) {
  return 'dir_' + Buffer.from(String(dbVpath) + '\x00' + String(dirPath)).toString('base64url');
}
/** Decode directory objectId back to { dbVpath, dirPath } */
function decDir(id) {
  try {
    const raw = Buffer.from(id.replace(/^dir_/, ''), 'base64url').toString();
    const sep = raw.indexOf('\x00');
    return { dbVpath: raw.slice(0, sep), dirPath: raw.slice(sep + 1) };
  } catch { return { dbVpath: '', dirPath: '' }; }
}
/** Encode a vpath + filepath into a stable DLNA item objectId */
function encItem(vpath, filepath) {
  return 'itm_' + Buffer.from(String(vpath) + '\x00' + String(filepath)).toString('base64url');
}

/** Extract the value of a named SOAP parameter from the request XML body */
function soapParam(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)<\/${name}>`, 'i'));
  return m ? m[1].trim() : '';
}

// ─── DIDL-Lite builders ───────────────────────────────────────────────────────

const NS_DIDL = 'urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/';
const NS_DC   = 'http://purl.org/dc/elements/1.1/';
const NS_UPNP = 'urn:schemas-upnp-org:metadata-1-0/upnp/';

function buildDIDL(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<DIDL-Lite xmlns="${NS_DIDL}" xmlns:dc="${NS_DC}" xmlns:upnp="${NS_UPNP}">` +
    items.join('') +
    `</DIDL-Lite>`;
}

function containerXml({ id, parentId, childCount, title, artUri }) {
  const art = artUri ? `<upnp:albumArtURI>${xmlEsc(artUri)}</upnp:albumArtURI>` : '';
  return (
    `<container id="${xmlEsc(id)}" parentID="${xmlEsc(parentId)}"` +
    ` childCount="${childCount}" restricted="1" searchable="0">` +
    `<dc:title>${xmlEsc(title)}</dc:title>` +
    `<upnp:class>object.container.album.musicAlbum</upnp:class>` +
    art +
    `</container>`
  );
}

function itemXml({ id, parentId, song, baseUrl }) {
  const vp = encodeURIComponent(song.vpath);
  const fp = String(song.filepath).split('/').map(encodeURIComponent).join('/');
  const mediaUrl = `${baseUrl}/media/${vp}/${fp}`;
  const mime = ext2mime(song.filepath);
  const dur  = durFmt(song.duration);
  const artUrl = song.aaFile ? `${baseUrl}/album-art/${encodeURIComponent(song.aaFile)}` : '';
  const title  = song.title || path.basename(String(song.filepath), path.extname(String(song.filepath)));
  return (
    `<item id="${xmlEsc(id)}" parentID="${xmlEsc(parentId)}" restricted="1">` +
    `<dc:title>${xmlEsc(title)}</dc:title>` +
    `<dc:creator>${xmlEsc(song.artist || '')}</dc:creator>` +
    `<upnp:class>object.item.audioItem.musicTrack</upnp:class>` +
    `<upnp:artist>${xmlEsc(song.artist || '')}</upnp:artist>` +
    `<upnp:album>${xmlEsc(song.album || '')}</upnp:album>` +
    (song.year ?  `<upnp:date>${song.year}-01-01</upnp:date>` : '') +
    (song.track ? `<upnp:originalTrackNumber>${song.track}</upnp:originalTrackNumber>` : '') +
    (artUrl ?     `<upnp:albumArtURI>${xmlEsc(artUrl)}</upnp:albumArtURI>` : '') +
    `<res protocolInfo="http-get:*:${mime}:*" duration="${dur}">${xmlEsc(mediaUrl)}</res>` +
    `</item>`
  );
}

// ─── SOAP envelope helpers ────────────────────────────────────────────────────

const NS_S  = 'http://schemas.xmlsoap.org/soap/envelope/';
const NS_CD = 'urn:schemas-upnp-org:service:ContentDirectory:1';

function soapEnvelope(action, body) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="${NS_S}" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body>` +
    `<u:${action}Response xmlns:u="${NS_CD}">` +
    body +
    `</u:${action}Response>` +
    `</s:Body></s:Envelope>`
  );
}

function browseResponse(didl, returned, total) {
  return soapEnvelope('Browse',
    `<Result>${xmlEsc(didl)}</Result>` +
    `<NumberReturned>${returned}</NumberReturned>` +
    `<TotalMatches>${total}</TotalMatches>` +
    `<UpdateID>1</UpdateID>`
  );
}

function soapError(code, description) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="${NS_S}"><s:Body><s:Fault>` +
    `<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>` +
    `<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">` +
    `<errorCode>${code}</errorCode>` +
    `<errorDescription>${xmlEsc(description)}</errorDescription>` +
    `</UPnPError></detail>` +
    `</s:Fault></s:Body></s:Envelope>`
  );
}

// ─── Browse logic ─────────────────────────────────────────────────────────────

async function handleBrowse(body, baseUrl) {
  const objectId = soapParam(body, 'ObjectID');
  const flag     = soapParam(body, 'BrowseFlag');
  const start    = Math.max(0, parseInt(soapParam(body, 'StartingIndex') || '0', 10) || 0);
  const reqCount = Math.max(0, parseInt(soapParam(body, 'RequestedCount') || '0', 10) || 0);
  const sources  = await resolveAlbumsSources();

  /** Slice array according to UPnP StartingIndex / RequestedCount (0 = all) */
  function pg(arr) {
    return reqCount > 0 ? arr.slice(start, start + reqCount) : arr.slice(start);
  }

  // ── id=0  Root ────────────────────────────────────────────────────────────
  if (objectId === '0') {
    if (flag === 'BrowseMetadata') {
      return browseResponse(buildDIDL([
        containerXml({ id: '0', parentId: '-1', childCount: sources.length,
          title: config.program.dlna?.name || 'mStream Velvet' }),
      ]), 1, 1);
    }
    if (flag === 'BrowseDirectChildren') {
      const all = sources.map(s =>
        containerXml({ id: encSrc(s.vpathName), parentId: '0', childCount: -1, title: s.vpathName })
      );
      const page = pg(all);
      return browseResponse(buildDIDL(page), page.length, all.length);
    }
  }

  // ── id='src_*'  Top-level albumsOnly source (e.g. "Albums", "Disco") ──────
  if (objectId.startsWith('src_')) {
    const vpathName = decSrc(objectId);
    const source = sources.find(s => s.vpathName === vpathName);
    if (!source) return browseResponse(buildDIDL([]), 0, 0);

    // Prefix always ends with '/'.  For root albumsOnly vpaths prefix is null → top of tree.
    const srcPrefix = source.prefix || '';

    if (flag === 'BrowseMetadata') {
      return browseResponse(buildDIDL([
        containerXml({ id: objectId, parentId: '0', childCount: -1, title: vpathName }),
      ]), 1, 1);
    }
    if (flag === 'BrowseDirectChildren') {
      const { dirs, songs } = listChildren(source, srcPrefix);
      const all = [
        ...dirs.map(d => containerXml({
          id:         encDir(source.dbVpath, srcPrefix + d.name),
          parentId:   objectId,
          childCount: -1,
          title:      d.name,
          artUri:     d.sampleFile?.aaFile
            ? `${baseUrl}/album-art/${encodeURIComponent(d.sampleFile.aaFile)}` : '',
        })),
        ...songs.map(song => itemXml({ id: encItem(song.vpath, song.filepath),
          parentId: objectId, song, baseUrl })),
      ];
      const page = pg(all);
      return browseResponse(buildDIDL(page), page.length, all.length);
    }
  }

  // ── id='dir_*'  Subdirectory within a source (any depth) ─────────────────
  if (objectId.startsWith('dir_')) {
    const { dbVpath, dirPath } = decDir(objectId);
    if (!dbVpath || !dirPath) return browseResponse(buildDIDL([]), 0, 0);

    // Find the originating source so we use the correct file cache
    const source = sources.find(s =>
      s.dbVpath === dbVpath && dirPath.startsWith(s.prefix || '')
    );
    if (!source) return browseResponse(buildDIDL([]), 0, 0);

    const dirPrefix = dirPath + '/';

    if (flag === 'BrowseMetadata') {
      return browseResponse(buildDIDL([
        containerXml({ id: objectId, parentId: '-1', childCount: -1,
          title: path.basename(dirPath) }),
      ]), 1, 1);
    }
    if (flag === 'BrowseDirectChildren') {
      const { dirs, songs } = listChildren(source, dirPrefix);
      const all = [
        ...dirs.map(d => containerXml({
          id:         encDir(dbVpath, dirPrefix + d.name),
          parentId:   objectId,
          childCount: -1,
          title:      d.name,
          artUri:     d.sampleFile?.aaFile
            ? `${baseUrl}/album-art/${encodeURIComponent(d.sampleFile.aaFile)}` : '',
        })),
        ...songs.map(song => itemXml({ id: encItem(song.vpath, song.filepath),
          parentId: objectId, song, baseUrl })),
      ];
      const page = pg(all);
      return browseResponse(buildDIDL(page), page.length, all.length);
    }
  }

  return browseResponse(buildDIDL([]), 0, 0);
}

// ─── Device description XML ───────────────────────────────────────────────────

function deviceXml(baseUrl) {
  const uuid = xmlEsc(config.program.instanceId || 'mstream-default');
  const name = xmlEsc(config.program.dlna?.name || 'mStream');
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<root xmlns="urn:schemas-upnp-org:device-1-0">`,
    `  <specVersion><major>1</major><minor>0</minor></specVersion>`,
    `  <URLBase>${xmlEsc(baseUrl)}</URLBase>`,
    `  <device>`,
    `    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>`,
    `    <friendlyName>${name}</friendlyName>`,
    `    <manufacturer>mStream Velvet</manufacturer>`,
    `    <manufacturerURL>https://github.com/aroundmyroom/mStream</manufacturerURL>`,
    `    <modelDescription>mStream Velvet Media Server</modelDescription>`,
    `    <modelName>mStream Velvet</modelName>`,
    `    <modelNumber>1</modelNumber>`,
    `    <UDN>uuid:${uuid}</UDN>`,
    `    <dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">DMS-1.50</dlna:X_DLNADOC>`,
    `    <serviceList>`,
    `      <service>`,
    `        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>`,
    `        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>`,
    `        <SCPDURL>/dlna/cd.xml</SCPDURL>`,
    `        <controlURL>/dlna/cd/control</controlURL>`,
    `        <eventSubURL>/dlna/cd/events</eventSubURL>`,
    `      </service>`,
    `    </serviceList>`,
    `  </device>`,
    `</root>`,
  ].join('\n');
}

// ContentDirectory service descriptor — tells devices what actions we support
const CD_SERVICE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action>
      <name>Browse</name>
      <argumentList>
        <argument><name>ObjectID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
        <argument><name>BrowseFlag</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument>
        <argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
        <argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
        <argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
        <argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
        <argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetSystemUpdateID</name>
      <argumentList>
        <argument><name>Id</name><direction>out</direction><relatedStateVariable>SystemUpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetSearchCapabilities</name>
      <argumentList>
        <argument><name>SearchCaps</name><direction>out</direction><relatedStateVariable>SearchCapabilities</relatedStateVariable></argument>
      </argumentList>
    </action>
    <action>
      <name>GetSortCapabilities</name>
      <argumentList>
        <argument><name>SortCaps</name><direction>out</direction><relatedStateVariable>SortCapabilities</relatedStateVariable></argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType>
      <allowedValueList>
        <allowedValue>BrowseMetadata</allowedValue>
        <allowedValue>BrowseDirectChildren</allowedValue>
      </allowedValueList>
    </stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Filter</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SortCriteria</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SearchCapabilities</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>SortCapabilities</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

// ─── DLNA Express app ─────────────────────────────────────────────────────────

function buildDlnaApp(baseUrl) {
  const app = express();

  // Parse SOAP bodies (text/xml, application/xml, application/soap+xml)
  app.use(express.text({
    type: ['text/xml', 'application/xml', 'application/soap+xml'],
    limit: '512kb',
  }));

  // UPnP device description — used by DLNA clients to discover service structure
  app.get('/dlna/description.xml', (_req, res) => {
    res.set('Content-Type', 'text/xml; charset="utf-8"');
    res.send(deviceXml(baseUrl));
  });

  // ContentDirectory service descriptor
  app.get('/dlna/cd.xml', (_req, res) => {
    res.set('Content-Type', 'text/xml; charset="utf-8"');
    res.send(CD_SERVICE_XML);
  });

  // SSDP event subscription stub — many DLNA clients send SUBSCRIBE before Browse
  // We accept but don't track subscriptions (no real eventing needed for read-only Browse)
  app.all('/dlna/cd/events', (req, res) => {
    if (req.method === 'SUBSCRIBE') {
      res.set('SID', `uuid:${config.program.instanceId || 'mstream'}-cd`);
      res.set('TIMEOUT', 'Second-1800');
      res.status(200).end();
    } else if (req.method === 'UNSUBSCRIBE') {
      res.status(200).end();
    } else {
      res.status(405).end();
    }
  });

  // ContentDirectory SOAP control endpoint
  app.post('/dlna/cd/control', async (req, res) => {
    const body   = typeof req.body === 'string' ? req.body : '';
    const action = (req.headers['soapaction'] || '').replace(/["']/g, '');
    let xml;

    try {
      if (action.endsWith('#Browse') || body.includes(':Browse')) {
        xml = await handleBrowse(body, baseUrl);
      } else if (action.endsWith('#GetSystemUpdateID') || body.includes('GetSystemUpdateID')) {
        xml = soapEnvelope('GetSystemUpdateID', '<Id>1</Id>');
      } else if (action.endsWith('#GetSearchCapabilities') || body.includes('GetSearchCapabilities')) {
        xml = soapEnvelope('GetSearchCapabilities', '<SearchCaps></SearchCaps>');
      } else if (action.endsWith('#GetSortCapabilities') || body.includes('GetSortCapabilities')) {
        xml = soapEnvelope('GetSortCapabilities', '<SortCaps></SortCaps>');
      } else {
        xml = soapError(401, 'Invalid Action');
      }
    } catch (err) {
      winston.error('[DLNA] SOAP handler error: ' + err.message);
      xml = soapError(501, 'Action Failed');
    }

    res.set('Content-Type', 'text/xml; charset="utf-8"');
    res.status(200).send(xml);
  });

  // Media file serving — dynamic vpath static mount so changes to folders config
  // are picked up without restarting the DLNA server
  app.use('/media/:vpath', (req, res, next) => {
    const folder = config.program.folders[req.params.vpath];
    if (!folder) return res.status(404).end();
    express.static(folder.root)(req, res, next);
  });

  // Album art serving (proxied from the main art cache directory)
  app.use('/album-art', express.static(config.program.storage.albumArtDirectory));

  return app;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export function isRunning() { return _running; }

export async function start() {
  if (_running) return;

  const port = config.program.dlna?.port || 10293;
  const ip   = getLanIp();
  const baseUrl = `http://${ip}:${port}`;

  try {
    // Stand up the HTTP server
    const app = buildDlnaApp(baseUrl);
    _httpServer = http.createServer(app);

    await new Promise((resolve, reject) => {
      _httpServer.once('error', reject);
      _httpServer.listen(port, resolve);
    });

    // Start SSDP multicast advertisement
    const { Server: SsdpServer } = require('node-ssdp');
    const uuid = config.program.instanceId || 'mstream-default';

    _ssdpServer = new SsdpServer({
      location:       { port, path: '/dlna/description.xml' },
      udn:            `uuid:${uuid}`,
      ssdpSig:        'mStream Velvet/1.0',
      allowWildcards: true,
    });
    _ssdpServer.addUSN('upnp:rootdevice');
    _ssdpServer.addUSN(`uuid:${uuid}`);
    _ssdpServer.addUSN('urn:schemas-upnp-org:device:MediaServer:1');
    _ssdpServer.addUSN('urn:schemas-upnp-org:service:ContentDirectory:1');

    await _ssdpServer.start();

    _running = true;
    winston.info(`[DLNA] started → http://${ip}:${port}/dlna/description.xml — SSDP advertising`);
  } catch (err) {
    winston.error('[DLNA] failed to start: ' + err.message);
    await stop().catch(() => {});
    throw err;
  }
}

export async function stop() {
  _running = false;

  if (_ssdpServer) {
    try { await _ssdpServer.stop(); } catch (_e) {}
    _ssdpServer = null;
  }

  if (_httpServer) {
    await new Promise(resolve => _httpServer.close(() => resolve()));
    _httpServer = null;
  }

  winston.info('[DLNA] stopped');
}

// ─── Admin API + boot wiring ──────────────────────────────────────────────────

/**
 * Called from server.js to register admin API routes and (optionally) auto-start.
 * @param {import('express').Application} mstream
 */
export function setup(mstream) {

  // GET /api/v1/admin/dlna/config — read current DLNA settings
  mstream.get('/api/v1/admin/dlna/config', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({
      enabled: config.program.dlna?.enabled || false,
      port:    config.program.dlna?.port    || 10293,
      name:    config.program.dlna?.name    || 'mStream',
      running: isRunning(),
    });
  });

  // POST /api/v1/admin/dlna/config — update settings and start/stop the service
  mstream.post('/api/v1/admin/dlna/config', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({
      enabled: Joi.boolean().optional(),
      port:    Joi.number().integer().min(1024).max(65535).optional(),
      name:    Joi.string().allow('').max(64).optional(),
    }).min(1);
    joiValidate(schema, req.body);

    // Update in-memory config
    if (!config.program.dlna) config.program.dlna = {};
    if (req.body.enabled !== undefined) config.program.dlna.enabled = req.body.enabled;
    if (req.body.port    !== undefined) config.program.dlna.port    = req.body.port;
    if (req.body.name    !== undefined) config.program.dlna.name    = req.body.name;

    // Persist to disk
    const raw = await adminUtil.loadFile(config.configFile);
    if (!raw.dlna) raw.dlna = {};
    if (req.body.enabled !== undefined) raw.dlna.enabled = req.body.enabled;
    if (req.body.port    !== undefined) raw.dlna.port    = req.body.port;
    if (req.body.name    !== undefined) raw.dlna.name    = req.body.name;
    await adminUtil.saveFile(raw, config.configFile);

    // Apply the enabled/disabled state live (no restart needed)
    if (req.body.enabled === true  && !isRunning()) {
      await start().catch(e => { throw new Error('DLNA failed to start: ' + e.message); });
    }
    if (req.body.enabled === false &&  isRunning()) {
      await stop().catch(e => winston.warn('[DLNA] stop error: ' + e.message));
    }

    res.json({ running: isRunning() });
  });

  // Auto-start on boot if previously enabled
  if (config.program.dlna?.enabled) {
    start().catch(e => winston.warn('[DLNA] auto-start failed: ' + e.message));
  }
}
