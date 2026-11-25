import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { createHash } from 'node:crypto';

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function parseIpv4(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function isPrivateIpv4(value) {
  const a = (value >>> 24) & 0xff;
  const b = (value >>> 16) & 0xff;
  const c = (value >>> 8) & 0xff;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Words(part) {
  if (part.includes('.')) {
    const value = parseIpv4(part);
    return value === null ? null : [(value >>> 16) & 0xffff, value & 0xffff];
  }
  if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
  return [parseInt(part, 16)];
}

function parseIpv6(address) {
  let text = String(address).trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const halves = text.split('::');
  if (halves.length > 2) return null;

  const parseSide = (side, allowEmbeddedV4) => {
    if (!side) return [];
    const parts = side.split(':');
    const words = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part) return null;
      if (part.includes('.') && !(allowEmbeddedV4 && index === parts.length - 1)) return null;
      const parsed = ipv6Words(part);
      if (!parsed) return null;
      words.push(...parsed);
    }
    return words;
  };

  if (halves.length === 1) {
    const words = parseSide(halves[0], true);
    return words && words.length === 8 ? words : null;
  }
  const left = parseSide(halves[0], false);
  const right = parseSide(halves[1], true);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function isPrivateIpv6(words) {
  if (!words) return true;
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;
  const lowPrefix = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0;
  if (lowPrefix && w5 === 0) return true; // ::/96: unspecified, loopback and IPv4-compatible
  if (lowPrefix && w5 === 0xffff) return isPrivateIpv4(((w6 << 16) | w7) >>> 0); // IPv4-mapped
  if ((w0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((w0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site local
  if ((w0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return isPrivateIpv4(((w6 << 16) | w7) >>> 0); // 64:ff9b::/96 NAT64
  }
  return false;
}

export function isPrivateIp(address) {
  const text = String(address ?? '').trim();
  if (!text) return true;
  const ipv4 = parseIpv4(text);
  if (ipv4 !== null) return isPrivateIpv4(ipv4);
  if (text.includes(':')) return isPrivateIpv6(parseIpv6(text));
  return true;
}

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function parseTarget(rawUrl, allowPrivate) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed');
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }
  if (!allowPrivate && url.port && url.port !== '80' && url.port !== '443') {
    throw new Error(`Blocked port ${url.port}; only 80 and 443 are allowed`);
  }
  return url;
}

async function resolveAllowed(url, allowPrivate) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (allowPrivate) return null;
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`Blocked private host: ${host}`);
  }
  if (isIpLiteral(host)) {
    if (isPrivateIp(host)) throw new Error(`Blocked private address: ${host}`);
    return { address: host, family: host.includes(':') ? 6 : 4 };
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  if (!records.length) throw new Error(`Could not resolve host: ${host}`);
  for (const record of records) {
    if (isPrivateIp(record.address)) throw new Error(`Blocked private address for host: ${host}`);
  }
  return records.find((record) => record.family === 4) ?? records[0];
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function requestOnce(url, pinned, timeoutMs, maxBytes, deadline = null) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const options = {
      method: 'GET',
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
        'user-agent': 'AgenticWebDoctor/0.1'
      }
    };
    if (pinned) {
      options.lookup = (hostname, lookupOptions, callback) => {
        if (lookupOptions && lookupOptions.all) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          callback(null, pinned.address, pinned.family);
        }
      };
    }
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    const fail = (message) => finish(reject, new Error(message));
    const req = client.request(options, (res) => {
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > maxBytes) {
        res.destroy();
        fail(`Response exceeded ${maxBytes} bytes`);
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          req.destroy();
          fail(`Response exceeded ${maxBytes} bytes`);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        const body = Buffer.concat(chunks);
        finish(resolve, {
          status: res.statusCode,
          headers: res.headers,
          text: body.toString('utf8'),
          bytes: body.length,
          sha256: sha256(body)
        });
      });
      res.on('error', () => fail(`Request to ${url.origin} failed`));
    });
    // The socket timeout only fires while idle; the hard timer also caps slow-drip responses.
    const budget = deadline === null ? timeoutMs : deadline - Date.now();
    timer = setTimeout(() => req.destroy(new Error('timeout')), Math.max(1, Math.min(timeoutMs, budget)));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (error) => {
      if (error.message === 'timeout') fail(`Request to ${url.origin} timed out after ${timeoutMs}ms`);
      else fail(`Request to ${url.origin} failed (${error.code || 'network error'})`);
    });
    req.end();
  });
}

export async function fetchText(rawUrl, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    allowPrivate = false,
    redirects = MAX_REDIRECTS,
    request = requestOnce
  } = options;
  const deadline = Date.now() + timeoutMs;
  let url = parseTarget(rawUrl, allowPrivate);
  for (let hop = 0; ; hop += 1) {
    if (Date.now() >= deadline) throw new Error(`Request to ${url.origin} timed out after ${timeoutMs}ms`);
    const pinned = await resolveAllowed(url, allowPrivate);
    const response = await request(url, pinned, timeoutMs, maxBytes, deadline);
    const location = response.headers.location;
    const isRedirect = response.status >= 301 && response.status <= 308 && response.status !== 304;
    if (isRedirect && location) {
      if (hop >= redirects) throw new Error(`Too many redirects for ${url.origin}`);
      url = parseTarget(new URL(location, url).href, allowPrivate);
      continue;
    }
    return { url: url.href, ...response };
  }
}
