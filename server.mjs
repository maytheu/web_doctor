import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditSite, normalizeBaseUrl } from './src/audit.mjs';
import { renderBadge, renderUnavailableBadge } from './src/badge.mjs';
import { CATALOG } from './src/catalog.mjs';
import { VERSION, SPEC_PROFILE } from './src/version.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy':
    "default-src 'self'; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

function forwardedChain(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  const realIp = req.headers['x-real-ip'];
  return typeof realIp === 'string' && realIp.trim() ? [realIp.trim()] : [];
}

function clientKey(req, trustProxy) {
  const socketIp = req.socket.remoteAddress || 'unknown';
  if (!trustProxy) return socketIp;
  const chain = forwardedChain(req);
  const index = chain.length - trustProxy;
  return index >= 0 && index < chain.length ? chain[index] : socketIp;
}

function createLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((time) => now - time < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 1000) {
      for (const [candidate, times] of hits) {
        if (now - (times[times.length - 1] ?? 0) >= windowMs) hits.delete(candidate);
      }
      while (hits.size > 1000) hits.delete(hits.keys().next().value);
    }
    return true;
  };
}

function sendJson(res, status, payload, extra = {}, { allowOrigin = true } = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    ...(allowOrigin ? { 'access-control-allow-origin': '*' } : {}),
    'cache-control': 'no-store',
    ...extra
  });
  res.end(JSON.stringify(payload));
}

function sendAuditJson(res, status, payload, extra = {}) {
  sendJson(res, status, payload, extra, { allowOrigin: false });
}

function sendSvg(res, svg) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'image/svg+xml; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=300'
  });
  res.end(svg);
}

function sendNotFound(res) {
  res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

export function createServer({ allowPrivate = false, audit = auditSite, limits = {}, trustProxy = 0 } = {}) {
  const trustedProxyHops = Number.isInteger(trustProxy) && trustProxy > 0 ? trustProxy : 0;
  const auditLimiter = createLimiter(limits.audit ?? 30, 60 * 60 * 1000);
  const badgeLimiter = createLimiter(limits.badge ?? 120, 60 * 60 * 1000);
  const badgeCache = new Map();

  async function handleApi(req, res, pathname, query) {
    const ip = clientKey(req, trustedProxyHops);
    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, version: VERSION, specProfile: SPEC_PROFILE });
    }
    if (pathname === '/api/catalog') {
      return sendJson(res, 200, CATALOG);
    }
    if (pathname === '/api/audit') {
      if (!auditLimiter(ip)) return sendAuditJson(res, 429, { error: 'Rate limit exceeded' }, { 'retry-after': '3600' });
      const url = query.get('url');
      if (!url) return sendAuditJson(res, 400, { error: 'Missing url parameter' });
      try {
        normalizeBaseUrl(url);
      } catch (error) {
        return sendAuditJson(res, 400, { error: error.message });
      }
      try {
        const report = await audit(url, { allowPrivate });
        return sendAuditJson(res, 200, report);
      } catch (error) {
        return sendAuditJson(res, 502, { error: `Audit failed: ${error.message}` });
      }
    }
    if (pathname === '/api/badge') {
      if (!badgeLimiter(ip)) return sendJson(res, 429, { error: 'Rate limit exceeded' }, { 'retry-after': '3600' });
      const url = query.get('url');
      if (!url) return sendJson(res, 400, { error: 'Missing url parameter' });
      try {
        normalizeBaseUrl(url);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      const label = query.get('label') || 'agentic web';
      const pin = query.get('pin') || null;
      const key = `${url}|${label}|${pin || ''}`;
      const cached = badgeCache.get(key);
      if (cached && cached.expires > Date.now()) return sendSvg(res, cached.svg);
      let svg;
      try {
        const report = await audit(url, { allowPrivate });
        svg = renderBadge(report, { label, pin });
      } catch {
        svg = renderUnavailableBadge(label);
      }
      if (badgeCache.size >= 500) badgeCache.delete(badgeCache.keys().next().value);
      badgeCache.set(key, { svg, expires: Date.now() + 300 * 1000 });
      return sendSvg(res, svg);
    }
    return sendJson(res, 404, { error: 'Unknown API route' });
  }

  async function handleStatic(res, pathname) {
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.includes(':')) return sendNotFound(res);
    const relative = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.resolve(PUBLIC_DIR, '.' + relative);
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) return sendNotFound(res);
    try {
      const info = await stat(filePath);
      const target = info.isDirectory() ? path.join(filePath, 'index.html') : filePath;
      const body = await readFile(target);
      const type = CONTENT_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
      const isPublishedArtifact =
        relative === '/agent-manifest.json' ||
        relative === '/links.json' ||
        relative.startsWith('/networks/') ||
        relative.startsWith('/runtime/');
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': type,
        'cache-control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=60',
        ...(isPublishedArtifact ? { 'access-control-allow-origin': '*' } : {})
      });
      res.end(body);
    } catch {
      sendNotFound(res);
    }
  }

  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' }, { allow: 'GET, HEAD' });
      return;
    }
    const raw = req.url || '/';
    const [rawPath, rawQuery] = raw.split('?');
    let pathname;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      sendJson(res, 400, { error: 'Malformed path' });
      return;
    }
    const query = new URLSearchParams(rawQuery || '');
    const task = pathname.startsWith('/api/') ? handleApi(req, res, pathname, query) : handleStatic(res, pathname);
    task.catch(() => {
      if (!res.headersSent) {
        if (pathname === '/api/audit') sendAuditJson(res, 500, { error: 'Internal error' });
        else sendJson(res, 500, { error: 'Internal error' });
      } else {
        res.end();
      }
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  let port = 8787;
  let allowPrivate = false;
  let trustProxy = 0;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--port') port = Number(args[(i += 1)]);
    else if (args[i] === '--allow-private') allowPrivate = true;
    else if (args[i] === '--trust-proxy') trustProxy = Number(args[(i += 1)]);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('Error: --port must be a valid port number');
    process.exit(2);
  }
  if (!Number.isInteger(trustProxy) || trustProxy < 0) {
    console.error('Error: --trust-proxy must be a non-negative integer hop count');
    process.exit(2);
  }
  const server = createServer({ allowPrivate, trustProxy });
  server.listen(port, () => {
    const actual = server.address().port;
    console.log(
      `Agentic Web Doctor listening on http://localhost:${actual}${allowPrivate ? ' (private addresses allowed)' : ''}${trustProxy ? ` (trusting ${trustProxy} proxy hop${trustProxy === 1 ? '' : 's'})` : ''}`
    );
  });
}
