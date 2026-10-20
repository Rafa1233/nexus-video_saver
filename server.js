const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const ipaddr = require('ipaddr.js');
const path = require('node:path');
const { Transform } = require('node:stream');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 100 * 1024 * 1024); // 100 MB
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 45000);

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '20kb', strict: true }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan. Coba lagi beberapa menit.' }
});
const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Batas unduhan sementara tercapai. Coba lagi nanti.' }
});
app.use('/api/', apiLimiter);

function isTikTokHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'tiktok.com' || host.endsWith('.tiktok.com');
}
function parseHttpUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) {
    const error = new Error('URL wajib diisi dan maksimal 2048 karakter.');
    error.status = 400; throw error;
  }
  let url;
  try { url = new URL(raw); } catch {
    const error = new Error('Format URL tidak valid.'); error.status = 400; throw error;
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    const error = new Error('Hanya URL HTTP/HTTPS yang diperbolehkan.'); error.status = 400; throw error;
  }
  if (url.username || url.password) {
    const error = new Error('URL yang berisi username/password tidak diperbolehkan.'); error.status = 400; throw error;
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    const error = new Error('Port URL khusus tidak diperbolehkan.'); error.status = 400; throw error;
  }
  return url;
}
function assertPublicIp(address) {
  let parsed;
  try { parsed = ipaddr.parse(address); } catch {
    const error = new Error('Alamat server tujuan tidak valid.'); error.status = 400; throw error;
  }
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
  if (parsed.range() !== 'unicast') {
    const error = new Error('URL menuju alamat jaringan privat atau khusus tidak diperbolehkan.');
    error.status = 400; throw error;
  }
}
async function resolvePublicHost(hostname) {
  // IP literal juga harus diperiksa agar localhost/private IP tidak lolos.
  if (ipaddr.isValid(hostname)) {
    assertPublicIp(hostname);
    return [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }];
  }
  let records;
  try { records = await dns.lookup(hostname, { all: true, verbatim: true }); }
  catch {
    const error = new Error('Host URL tidak dapat ditemukan.'); error.status = 400; throw error;
  }
  if (!records.length) {
    const error = new Error('Host URL tidak memiliki alamat IP.'); error.status = 400; throw error;
  }
  // Reject the whole hostname if any resolved address is private/reserved.
  for (const record of records) assertPublicIp(record.address);
  return records;
}
function requestPinned(url, method = 'GET', headers = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise(async (resolve, reject) => {
    let records;
    try { records = await resolvePublicHost(url.hostname); } catch (e) { reject(e); return; }
    const chosen = records[0];
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method,
      headers,
      timeout: timeoutMs,
      // Pin the connection to the public IP resolved and validated above.
      lookup: (_hostname, _options, callback) => callback(null, chosen.address, chosen.family)
    }, res => resolve({ req, res }));
    req.on('timeout', () => req.destroy(new Error('Server tujuan terlalu lama merespons.')));
    req.on('error', reject);
    req.end();
  });
}
async function requestFollowingRedirects(rawUrl, method = 'GET', headers = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  let url = parseHttpUrl(rawUrl);
  for (let hop = 0; hop <= 3; hop++) {
    const { req, res } = await requestPinned(url, method, headers, timeoutMs);
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      if (hop === 3) throw Object.assign(new Error('Terlalu banyak redirect.'), { status: 400 });
      const next = new URL(res.headers.location, url);
      url = parseHttpUrl(next.href); // each redirect gets a fresh DNS/IP safety check
      if (res.statusCode === 303) method = 'GET';
      continue;
    }
    return { req, res, url };
  }
  throw Object.assign(new Error('Redirect tidak valid.'), { status: 400 });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'nexus-video-saver', mode: 'mvp', time: new Date().toISOString() });
});

app.post('/api/metadata', async (req, res, next) => {
  try {
    const url = parseHttpUrl(req.body && req.body.url);
    if (!isTikTokHost(url.hostname)) {
      return res.status(400).json({ error: 'Endpoint metadata ini hanya menerima URL TikTok.' });
    }
    // Use the official TikTok oEmbed endpoint; this returns metadata/embed markup, not an MP4.
    const endpoint = new URL('https://www.tiktok.com/oembed');
    endpoint.searchParams.set('url', url.href);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(endpoint, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': 'NEXUS-Video-Saver/1.0' },
        signal: controller.signal,
        redirect: 'error'
      });
    } finally { clearTimeout(timer); }
    if (!upstream.ok) {
      return res.status(502).json({ error: `TikTok oEmbed menolak atau tidak dapat memproses tautan (HTTP ${upstream.status}). Pastikan video publik dan URL benar.` });
    }
    const data = await upstream.json();
    if (!data || data.provider_name !== 'TikTok') {
      return res.status(502).json({ error: 'Respons oEmbed tidak dikenali.' });
    }
    res.json({
      ok: true,
      url: url.href,
      title: String(data.title || 'Video TikTok'),
      author_name: String(data.author_name || ''),
      author_url: typeof data.author_url === 'string' ? data.author_url : '',
      thumbnail_url: typeof data.thumbnail_url === 'string' && data.thumbnail_url.startsWith('https://') ? data.thumbnail_url : '',
      thumbnail_width: Number(data.thumbnail_width || 0),
      thumbnail_height: Number(data.thumbnail_height || 0),
      provider_name: 'TikTok',
      type: String(data.type || 'video'),
      note: 'oEmbed memberikan metadata dan embed, bukan file video MP4.'
    });
  } catch (error) {
    if (error.name === 'AbortError') return res.status(504).json({ error: 'TikTok oEmbed timeout. Coba lagi nanti.' });
    next(error);
  }
});

app.post('/api/validate-video', async (req, res, next) => {
  let upstream;
  try {
    const url = parseHttpUrl(req.body && req.body.url);
    // Fetch only a single byte so we can verify a public, accessible video without downloading it all.
    const result = await requestFollowingRedirects(url.href, 'GET', {
      'Range': 'bytes=0-0',
      'User-Agent': 'NEXUS-Video-Saver/1.0',
      'Accept': 'video/*,application/octet-stream;q=0.8,*/*;q=0.1'
    }, REQUEST_TIMEOUT_MS);
    upstream = result.res;
    const type = String(upstream.headers['content-type'] || '').split(';')[0].toLowerCase();
    const contentRange = String(upstream.headers['content-range'] || '');
    const rangeMatch = contentRange.match(/\/([0-9]+)$/);
    const length = Number((rangeMatch && rangeMatch[1]) || upstream.headers['content-length'] || 0);
    const validStatus = upstream.statusCode === 200 || upstream.statusCode === 206;
    const isVideoType = type.startsWith('video/') || type === 'application/octet-stream';
    const extLooksVideo = /\.(mp4|webm|mov|m4v|ogv)(?:$|[?#])/i.test(result.url.href);
    upstream.resume();
    if (!validStatus) return res.status(400).json({ error: `URL video tidak bisa diakses (HTTP ${upstream.statusCode}).` });
    if (!isVideoType && !extLooksVideo) return res.status(415).json({ error: 'URL tidak terlihat seperti file video langsung.' });
    if (length > MAX_VIDEO_BYTES) return res.status(413).json({ error: 'File melebihi batas ukuran demo 100 MB.' });
    res.json({
      ok: true,
      url: result.url.href,
      contentType: type || 'video/*',
      size: length ? `${(length / 1024 / 1024).toFixed(2)} MB` : 'Ukuran tidak diketahui',
      maxBytes: MAX_VIDEO_BYTES,
      note: 'Pemeriksaan awal berhasil. Unduhan tetap bergantung pada akses dan respons server sumber.'
    });
  } catch (error) {
    if (upstream && !upstream.destroyed) upstream.destroy();
    next(error);
  }
});

app.get('/api/download', downloadLimiter, async (req, res, next) => {
  let upstream;
  try {
    const url = parseHttpUrl(req.query.url);
    const result = await requestFollowingRedirects(url.href, 'GET', {
      'User-Agent': 'NEXUS-Video-Saver/1.0',
      'Accept': 'video/*,application/octet-stream;q=0.8,*/*;q=0.1'
    }, DOWNLOAD_TIMEOUT_MS);
    upstream = result.res;
    const type = String(upstream.headers['content-type'] || '').split(';')[0].toLowerCase();
    const extLooksVideo = /\.(mp4|webm|mov|m4v|ogv)(?:$|[?#])/i.test(result.url.href);
    if (upstream.statusCode !== 200 && upstream.statusCode !== 206) {
      upstream.resume();
      return res.status(400).json({ error: `Server sumber tidak mengizinkan unduhan (HTTP ${upstream.statusCode}).` });
    }
    if (!(type.startsWith('video/') || type === 'application/octet-stream' || extLooksVideo)) {
      upstream.resume();
      return res.status(415).json({ error: 'Sumber tidak mengembalikan tipe file video.' });
    }
    const contentLength = Number(upstream.headers['content-length'] || 0);
    if (contentLength > MAX_VIDEO_BYTES) {
      upstream.resume();
      return res.status(413).json({ error: 'File melebihi batas ukuran demo 100 MB.' });
    }
    const ext = type.includes('webm') ? 'webm' : type.includes('quicktime') ? 'mov' : type.includes('ogg') ? 'ogv' : 'mp4';
    res.status(200);
    res.setHeader('Content-Type', type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="nexus-video.${ext}"`);
    res.setHeader('Cache-Control', 'no-store');
    if (contentLength) res.setHeader('Content-Length', String(contentLength));
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_VIDEO_BYTES) return callback(Object.assign(new Error('File melebihi batas ukuran demo 100 MB.'), { code: 'LIMIT_EXCEEDED' }));
        callback(null, chunk);
      }
    });
    upstream.on('error', err => { if (!res.headersSent) next(err); else res.destroy(err); });
    limiter.on('error', err => {
      if (err.code === 'LIMIT_EXCEEDED') {
        if (!res.headersSent) res.status(413).json({ error: err.message });
        else res.destroy(err);
      } else if (!res.destroyed) res.destroy(err);
    });
    upstream.pipe(limiter).pipe(res);
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
  } catch (error) {
    if (upstream && !upstream.destroyed) upstream.destroy();
    next(error);
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint API tidak ditemukan.' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => {
    if (err) next(err);
  });
});

app.use((err, _req, res, _next) => {
  console.error('[NEXUS]', err.message);
  if (res.headersSent) return res.destroy();
  const status = Number(err.status) || 500;
  res.status(status).json({
    error: status >= 500 ? 'Terjadi kesalahan pada server atau sumber video. Coba lagi nanti.' : err.message
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`NEXUS Video Saver listening on 0.0.0.0:${PORT}`);
});
