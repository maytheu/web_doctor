import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';
import { CATALOG } from '../src/catalog.mjs';
import { startFixtureServer } from './helpers/fixture-server.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
let fixture;
let server;
let base;

before(async () => {
  fixture = await startFixtureServer(path.join(FIXTURES, 'good'));
  server = createServer({ allowPrivate: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fixture.close();
});

function rawGet(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: server.address().port, path: pathname }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
  });
}

test('GET /api/health', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('content-type').includes('application/json'));
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.specProfile, 'mvp-0.2');
  assert.match(body.version, /^\d+\.\d+\.\d+/);
});

test('GET /api/catalog returns the check catalog', async () => {
  const response = await fetch(`${base}/api/catalog`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body, CATALOG);
  assert.ok(body.some((entry) => entry.id === 'manifest.cors'));
});

test('GET /api/audit returns a report without CORS access', async () => {
  const response = await fetch(`${base}/api/audit?url=${encodeURIComponent(fixture.baseUrl)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const report = await response.json();
  assert.equal(report.status, 'conformant');
  assert.equal(report.score, 100);
});

test('GET /api/audit without url is 400', async () => {
  const response = await fetch(`${base}/api/audit`);
  assert.equal(response.status, 400);
});

test('GET /api/badge returns svg', async () => {
  const response = await fetch(`${base}/api/badge?url=${encodeURIComponent(fixture.baseUrl)}`);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-type').includes('image/svg+xml'));
  const body = await response.text();
  assert.ok(body.startsWith('<svg'));
});

test('GET / serves the report UI', async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-type').includes('text/html'));
  const body = await response.text();
  assert.ok(body.includes('Agentic Web Doctor'));
  assert.ok(body.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml"'));
});

test('GET /favicon.svg serves the linked icon', async () => {
  const response = await fetch(`${base}/favicon.svg`);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-type').includes('image/svg+xml'));
  const body = await response.text();
  assert.ok(body.startsWith('<svg'));
});

async function withServer(options, fn) {
  const aux = createServer(options);
  await new Promise((resolve) => aux.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${aux.address().port}`);
  } finally {
    await new Promise((resolve) => aux.close(resolve));
  }
}

test('audit and badge routes limit per IP with independent buckets', async () => {
  await withServer({ allowPrivate: true, limits: { audit: 2, badge: 2 } }, async (auxBase) => {
    const target = encodeURIComponent(fixture.baseUrl);

    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`${auxBase}/api/audit?url=${target}`);
      assert.equal(response.status, 200);
    }
    const limitedAudit = await fetch(`${auxBase}/api/audit?url=${target}`);
    assert.equal(limitedAudit.status, 429);
    assert.equal(limitedAudit.headers.get('retry-after'), '3600');
    assert.equal(limitedAudit.headers.get('access-control-allow-origin'), null);
    assert.equal((await limitedAudit.json()).error, 'Rate limit exceeded');

    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`${auxBase}/api/badge?url=${target}`);
      assert.equal(response.status, 200);
    }
    const limitedBadge = await fetch(`${auxBase}/api/badge?url=${target}`, { headers: { accept: 'image/svg+xml' } });
    assert.equal(limitedBadge.status, 429);
    assert.equal(limitedBadge.headers.get('retry-after'), '3600');
  });
});

test('rate limits ignore forwarded headers unless proxy trust is configured', async () => {
  const report = { status: 'conformant', summary: { pass: 1, warn: 0, error: 0, skip: 0 }, artifacts: [] };
  await withServer({ audit: async () => report, limits: { audit: 1 } }, async (auxBase) => {
    const target = encodeURIComponent('https://target.example');
    const first = await fetch(`${auxBase}/api/audit?url=${target}`, { headers: { 'x-forwarded-for': '203.0.113.10' } });
    assert.equal(first.status, 200);
    const second = await fetch(`${auxBase}/api/audit?url=${target}`, { headers: { 'x-forwarded-for': '203.0.113.11' } });
    assert.equal(second.status, 429);
  });
});

test('trusted proxy hops key rate limits by forwarded client address', async () => {
  const report = { status: 'conformant', summary: { pass: 1, warn: 0, error: 0, skip: 0 }, artifacts: [] };
  await withServer({ audit: async () => report, limits: { audit: 1 }, trustProxy: 1 }, async (auxBase) => {
    const target = encodeURIComponent('https://target.example');
    const clientA = () =>
      fetch(`${auxBase}/api/audit?url=${target}`, { headers: { 'x-forwarded-for': '203.0.113.10' } });
    const clientB = () =>
      fetch(`${auxBase}/api/audit?url=${target}`, { headers: { 'x-forwarded-for': '203.0.113.11' } });
    assert.equal((await clientA()).status, 200);
    assert.equal((await clientB()).status, 200);
    assert.equal((await clientA()).status, 429);
  });
});

test('trusted proxy hop count ignores client-supplied earlier entries', async () => {
  const report = { status: 'conformant', summary: { pass: 1, warn: 0, error: 0, skip: 0 }, artifacts: [] };
  await withServer({ audit: async () => report, limits: { audit: 1 }, trustProxy: 2 }, async (auxBase) => {
    const target = encodeURIComponent('https://target.example');
    const first = await fetch(`${auxBase}/api/audit?url=${target}`, {
      headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.10, 10.0.0.1' }
    });
    const spoofed = await fetch(`${auxBase}/api/audit?url=${target}`, {
      headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.10, 10.0.0.2' }
    });
    assert.equal(first.status, 200);
    assert.equal(spoofed.status, 429);
  });
});

test('trusted proxy hops fall back to X-Real-IP', async () => {
  const report = { status: 'conformant', summary: { pass: 1, warn: 0, error: 0, skip: 0 }, artifacts: [] };
  await withServer({ audit: async () => report, limits: { audit: 1 }, trustProxy: 1 }, async (auxBase) => {
    const target = encodeURIComponent('https://target.example');
    const first = await fetch(`${auxBase}/api/audit?url=${target}`, { headers: { 'x-real-ip': '203.0.113.20' } });
    const repeat = await fetch(`${auxBase}/api/audit?url=${target}`, { headers: { 'x-real-ip': '203.0.113.20' } });
    const other = await fetch(`${auxBase}/api/audit?url=${target}`, { headers: { 'x-real-ip': '203.0.113.21' } });
    assert.equal(first.status, 200);
    assert.equal(repeat.status, 429);
    assert.equal(other.status, 200);
  });
});

test('badge responses are cached per url, label and pin', async () => {
  let audits = 0;
  const report = { status: 'conformant', summary: { pass: 1, warn: 0, error: 0, skip: 0 }, artifacts: [] };
  await withServer({ audit: async () => { audits += 1; return report; } }, async (auxBase) => {
    const target = encodeURIComponent('https://target.example');

    const first = await fetch(`${auxBase}/api/badge?url=${target}`);
    const second = await fetch(`${auxBase}/api/badge?url=${target}`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(audits, 1);
    assert.equal(await first.text(), await second.text());

    const labelled = await fetch(`${auxBase}/api/badge?url=${target}&label=custom`);
    assert.equal(labelled.status, 200);
    assert.equal(audits, 2);

    const pinned = await fetch(`${auxBase}/api/badge?url=${target}&pin=abc123`);
    assert.equal(pinned.status, 200);
    assert.equal(audits, 3);
  });
});

test('path traversal cannot leak package.json', async () => {
  const response = await rawGet('/../package.json');
  assert.equal(response.status, 404);
  assert.ok(!response.body.includes('agentic-web-doctor'));
});

test('GET /api/audit rejects an invalid URL before auditing', async () => {
  let audits = 0;
  await withServer({ audit: async () => { audits += 1; return {}; } }, async (auxBase) => {
    const protocol = await fetch(`${auxBase}/api/audit?url=${encodeURIComponent('ftp://example.com')}`);
    assert.equal(protocol.status, 400);
    assert.equal((await protocol.json()).error, 'Only http and https URLs can be audited');
    assert.equal(protocol.headers.get('access-control-allow-origin'), null);
    assert.equal(protocol.headers.get('cache-control'), 'no-store');

    const credentials = await fetch(`${auxBase}/api/audit?url=${encodeURIComponent('https://user:pass@example.com')}`);
    assert.equal(credentials.status, 400);
    assert.match((await credentials.json()).error, /credentials/);
    assert.equal(audits, 0);
  });
});

test('GET /api/audit accepts a bare hostname', async () => {
  const report = { status: 'conformant', summary: { pass: 1, warn: 0, error: 0, skip: 0 }, artifacts: [] };
  let seen = null;
  await withServer({ audit: async (url) => { seen = url; return report; } }, async (auxBase) => {
    const response = await fetch(`${auxBase}/api/audit?url=example.com`);
    assert.equal(response.status, 200);
    assert.equal(seen, 'example.com');
  });
});

test('GET /api/audit returns 502 when the audit fails', async () => {
  await withServer({ audit: async () => { throw new Error('upstream exploded'); } }, async (auxBase) => {
    const response = await fetch(`${auxBase}/api/audit?url=${encodeURIComponent('https://down.example')}`);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).error, 'Audit failed: upstream exploded');
  });
});

test('GET /api/badge validates the URL and falls back to an unavailable badge', async () => {
  let audits = 0;
  await withServer({ audit: async () => { audits += 1; throw new Error('upstream down'); } }, async (auxBase) => {
    const missing = await fetch(`${auxBase}/api/badge`);
    assert.equal(missing.status, 400);
    const invalid = await fetch(`${auxBase}/api/badge?url=${encodeURIComponent('ftp://example.com')}`);
    assert.equal(invalid.status, 400);
    assert.equal(audits, 0);

    const response = await fetch(`${auxBase}/api/badge?url=${encodeURIComponent('https://down.example')}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').includes('image/svg+xml'));
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
    const svg = await response.text();
    assert.ok(svg.includes('>unavailable</text>'));
    assert.ok(svg.includes('#6b7280'));
    assert.equal(audits, 1);
  });
});

test('API routes reject non-GET methods and answer HEAD', async () => {
  const rejected = await fetch(`${base}/api/health`, { method: 'POST' });
  assert.equal(rejected.status, 405);
  assert.equal((await rejected.json()).error, 'Method not allowed');

  const head = await fetch(`${base}/api/health`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('405 responses advertise Allow: GET, HEAD', async () => {
  for (const pathname of ['/api/health', '/api/audit', '/', '/missing']) {
    const response = await fetch(`${base}${pathname}`, { method: 'POST' });
    assert.equal(response.status, 405, `${pathname} should reject POST`);
    assert.equal(response.headers.get('allow'), 'GET, HEAD', `${pathname} should advertise the allowed methods`);
  }
});

test('HTML is served with no-store, CSP and nosniff headers', async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("script-src 'self'"));
});

test('malformed percent-encoding is a 400', async () => {
  const response = await rawGet('/%E0%A4%A');
  assert.equal(response.status, 400);
  assert.equal(JSON.parse(response.body).error, 'Malformed path');
});
