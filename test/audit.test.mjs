import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSite, normalizeBaseUrl } from '../src/audit.mjs';
import { CATALOG_BY_ID } from '../src/catalog.mjs';
import { startFixtureServer } from './helpers/fixture-server.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

async function withFixture(name, fn, options) {
  const fixture = await startFixtureServer(path.join(FIXTURES, name), options);
  try {
    return await fn(fixture.baseUrl);
  } finally {
    await fixture.close();
  }
}

async function editManifest(dir, mutate) {
  const manifestPath = path.join(dir, 'agent-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  mutate(manifest);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

async function withPreparedFixture(name, prepare, fn, options) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awd-audit-'));
  try {
    await cp(path.join(FIXTURES, name), dir, { recursive: true });
    await prepare(dir);
    const fixture = await startFixtureServer(dir, options);
    try {
      return await fn(fixture.baseUrl);
    } finally {
      await fixture.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const check = (report, id) => report.checks.find((entry) => entry.id === id);

test('good fixture is conformant with a perfect score', async () => {
  await withFixture('good', async (baseUrl) => {
    const report = await auditSite(baseUrl, { allowPrivate: true });
    assert.equal(report.status, 'conformant');
    assert.equal(report.score, 100);
    assert.equal(report.summary.error, 0);
    assert.equal(report.summary.warn, 0);
    assert.equal(check(report, 'actions.module').status, 'skip');
    assert.equal(report.artifacts.length, 3);
    assert.ok(report.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
  });
});

test('the report fulfils the published contract', async () => {
  await withFixture('good', async (baseUrl) => {
    const report = await auditSite(baseUrl, { allowPrivate: true });

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.specProfile, 'mvp-0.2');
    assert.equal(report.baseUrl, baseUrl);
    assert.ok(!Number.isNaN(Date.parse(report.generatedAt)));
    assert.ok(Number.isInteger(report.durationMs) && report.durationMs >= 0);

    const counts = { pass: 0, warn: 0, error: 0, skip: 0 };
    for (const entry of report.checks) {
      counts[entry.status] += 1;
      assert.equal(typeof entry.id, 'string');
      assert.equal(typeof entry.category, 'string');
      assert.equal(typeof entry.title, 'string');
      assert.ok(['error', 'warn', 'info'].includes(entry.severity));
      assert.ok(['pass', 'warn', 'error', 'skip'].includes(entry.status));
      assert.equal(typeof entry.message, 'string');
      assert.equal(typeof entry.specRef, 'string');
      assert.equal(entry.specRef, CATALOG_BY_ID.get(entry.id).specRef);
      if (entry.status === 'warn' || entry.status === 'error') assert.equal(typeof entry.hint, 'string');
      else assert.equal('hint' in entry, false);
    }
    assert.deepEqual(report.summary, counts);
    assert.equal(report.score, Math.max(0, 100 - 15 * counts.error - 4 * counts.warn));
    assert.equal(report.status, counts.error ? 'non-conformant' : counts.warn ? 'warnings' : 'conformant');

    assert.deepEqual(report.artifacts.map((artifact) => artifact.kind), ['manifest', 'network', 'links']);
    for (const artifact of report.artifacts) {
      assert.equal(typeof artifact.url, 'string');
      assert.equal(artifact.status, 200);
      assert.ok(Number.isInteger(artifact.bytes) && artifact.bytes > 0);
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    }

    const again = await auditSite(baseUrl, { allowPrivate: true });
    const volatile = ({ generatedAt, durationMs, ...rest }) => rest;
    assert.deepEqual(volatile(again), volatile(report));
  });
});

test('broken-front-man reports a front_man error', async () => {
  await withFixture('broken-front-man', async (baseUrl) => {
    const report = await auditSite(baseUrl, { allowPrivate: true });
    assert.equal(check(report, 'network.front_man').status, 'error');
    assert.equal(report.status, 'non-conformant');
  });
});

test('dangling-ref reports an unresolved tool reference', async () => {
  await withFixture('dangling-ref', async (baseUrl) => {
    const report = await auditSite(baseUrl, { allowPrivate: true });
    const refs = check(report, 'network.refs');
    assert.equal(refs.status, 'error');
    assert.ok(JSON.stringify(refs).includes('missing_agent'));
  });
});

test('bad-peer reports a denied peer origin', async () => {
  await withFixture('bad-peer', async (baseUrl) => {
    const report = await auditSite(baseUrl, { allowPrivate: true });
    const peers = check(report, 'peers.allowed');
    assert.equal(peers.status, 'error');
    assert.ok(JSON.stringify(peers).includes('https://evil.example'));
  });
});

test('secret-leak reports credentials with masked evidence', async () => {
  await withFixture('secret-leak', async (baseUrl) => {
    const report = await auditSite(baseUrl, { allowPrivate: true });
    const secrets = check(report, 'security.secrets');
    assert.equal(secrets.status, 'error');
    assert.equal(secrets.evidence, 'sk-t…');
    assert.ok(secrets.details.includes('provider-style secret key: sk-t…'));
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('sk-test-abcdefghijklmnopqrstuvwxyz'));
    assert.ok(!serialized.includes('abcdefghijklmnopqrstuvwxyz'));
  });
});

test('warn-only fixture stays conformant but scores 96', async () => {
  await withFixture('warn-only', async (baseUrl) => {
    const report = await auditSite(baseUrl, { allowPrivate: true });
    assert.equal(check(report, 'network.budget').status, 'warn');
    assert.equal(report.status, 'warnings');
    assert.equal(report.score, 96);
    assert.equal(report.summary.warn, 1);
  });
});

test('missing manifest errors and skips dependent checks', async () => {
  await withFixture('missing-manifest', async (baseUrl) => {
    const report = await auditSite(baseUrl, { allowPrivate: true });
    assert.equal(check(report, 'manifest.fetch').status, 'error');
    assert.equal(check(report, 'manifest.required').status, 'skip');
    assert.equal(check(report, 'network.fetch').status, 'skip');
    assert.equal(report.status, 'non-conformant');
  });
});

test('a fixture server without CORS fails manifest.cors', async () => {
  await withFixture(
    'good',
    async (baseUrl) => {
      const report = await auditSite(baseUrl, { allowPrivate: true });
      assert.equal(check(report, 'manifest.cors').status, 'error');
      assert.equal(check(report, 'network.cors').status, 'error');
    },
    { cors: false }
  );
});

test('missing links.json is a skip, not an error', async () => {
  await withFixture('no-links', async (baseUrl) => {
    const report = await auditSite(baseUrl, { allowPrivate: true });
    assert.equal(check(report, 'links.fetch').status, 'skip');
    assert.equal(check(report, 'links.valid').status, 'skip');
    assert.equal(report.summary.error, 0);
    assert.equal(report.status, 'conformant');
  });
});

test('the engine rejects malformed, non-http and credentialed URLs', async () => {
  await assert.rejects(() => auditSite(''), /A base URL is required/);
  await assert.rejects(() => auditSite('not a url'), /Invalid URL/);
  await assert.rejects(() => auditSite('ftp://example.com'), /http and https/);
  await assert.rejects(() => auditSite('https://user:pass@example.com'), /credentials/);
});

test('bare hostnames default to https while non-http schemes stay rejected', () => {
  assert.equal(normalizeBaseUrl('example.com'), 'https://example.com');
  assert.equal(normalizeBaseUrl('  example.com  '), 'https://example.com');
  assert.equal(normalizeBaseUrl('example.com/path?x=1#frag'), 'https://example.com/path');
  assert.equal(normalizeBaseUrl('example.com:8080'), 'https://example.com:8080');
  assert.equal(normalizeBaseUrl('localhost'), 'http://localhost');
  assert.equal(normalizeBaseUrl('localhost:8787'), 'http://localhost:8787');
  assert.equal(normalizeBaseUrl('app.localhost:3000'), 'http://app.localhost:3000');
  assert.equal(normalizeBaseUrl('127.0.0.1:54321'), 'http://127.0.0.1:54321');
  assert.equal(normalizeBaseUrl('[::1]:8787'), 'http://[::1]:8787');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normalizeBaseUrl('https://example.com/'), 'https://example.com');

  for (const rejected of [
    'ftp://example.com',
    'ws://example.com',
    'file:///etc/passwd',
    'file:/etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<svg>'
  ]) {
    assert.throws(() => normalizeBaseUrl(rejected), /Only http and https URLs can be audited/, rejected);
  }
  assert.throws(() => normalizeBaseUrl('user:pass@example.com'), /credentials/);
});

test('a loopback audit without allowPrivate is blocked before fetching', async () => {
  const report = await auditSite('http://127.0.0.1');
  assert.equal(report.status, 'non-conformant');
  assert.match(check(report, 'manifest.fetch').message, /Blocked private address: 127\.0\.0\.1/);
  assert.equal(check(report, 'network.fetch').status, 'skip');
  assert.deepEqual(report.artifacts, []);
});

test('a non-standard port is blocked at the engine level without contacting the server', async () => {
  const requests = [];
  await withFixture(
    'good',
    async (baseUrl) => {
      const report = await auditSite(baseUrl);
      assert.equal(report.status, 'non-conformant');
      assert.match(check(report, 'manifest.fetch').message, /Blocked port/);
      assert.deepEqual(report.artifacts, []);
      assert.deepEqual(requests, []);
    },
    { onRequest: (req) => requests.push(req.url) }
  );
});

test('audits every declared network', async () => {
  await withPreparedFixture(
    'good',
    async (dir) => {
      const source = path.join(dir, 'assistant.network.json');
      const second = JSON.parse(await readFile(source, 'utf8'));
      second.name = 'littleoven_agents_two';
      await writeFile(path.join(dir, 'second.network.json'), JSON.stringify(second, null, 2));
      await editManifest(dir, (manifest) => {
        manifest.networks.push({ ...manifest.networks[0], name: 'littleoven_agents_two', hocon: './second.network.json' });
      });
    },
    async (baseUrl) => {
      const report = await auditSite(baseUrl, { allowPrivate: true });
      assert.equal(report.status, 'conformant');
      assert.equal(check(report, 'manifest.required').message, 'Manifest declares 2 network(s)');
      assert.equal(check(report, 'network.fetch').message, 'Fetched 2 network artifact(s)');
      const networks = report.artifacts.filter((artifact) => artifact.kind === 'network');
      assert.deepEqual(
        networks.map((artifact) => new URL(artifact.url).pathname),
        ['/assistant.network.json', '/second.network.json']
      );
    }
  );
});

test('caps network fetches at five per audit', async () => {
  const requests = [];
  await withPreparedFixture(
    'good',
    async (dir) => {
      await editManifest(dir, (manifest) => {
        manifest.networks = Array.from({ length: 7 }, (_, index) => ({
          ...manifest.networks[0],
          name: `littleoven_agents_${index + 1}`
        }));
      });
    },
    async (baseUrl) => {
      const report = await auditSite(baseUrl, { allowPrivate: true });
      assert.equal(check(report, 'network.fetch').message, 'Fetched 5 network artifact(s)');
      assert.equal(report.artifacts.filter((artifact) => artifact.kind === 'network').length, 5);
      assert.equal(requests.filter((url) => url === '/assistant.network.json').length, 5);
    },
    { onRequest: (req) => requests.push(req.url) }
  );
});

test('the total audit budget stops work across fetches', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/agent-manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      setTimeout(() => res.end('{}'), 200);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const report = await auditSite(baseUrl, { allowPrivate: true, timeoutMs: 5000, totalTimeoutMs: 50 });
    assert.equal(check(report, 'manifest.fetch').status, 'error');
    assert.match(check(report, 'manifest.fetch').message, /timed out after \d{1,2}ms/);
    assert.equal(check(report, 'links.fetch').status, 'error');
    assert.match(check(report, 'links.fetch').message, /total budget/);
    assert.ok(report.durationMs < 1000);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a full-scale run exhausts the real 20s budget across stalled fetches', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/agent-manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: 'budget-fixture',
          networks: Array.from({ length: 5 }, (_, index) => ({
            name: `slow_${index}`,
            hocon: `./slow-${index}.network.json`
          })),
          actions: { module: './actions.js' }
        })
      );
      return;
    }
    req.on('close', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const report = await auditSite(baseUrl, { allowPrivate: true });
    assert.deepEqual(report.artifacts.map((artifact) => artifact.kind), ['manifest']);
    assert.ok(report.durationMs >= 19500, `audit should use the full 20s budget (used ${report.durationMs}ms)`);
    assert.ok(report.durationMs < 25000, `audit should stop at the budget (used ${report.durationMs}ms)`);

    const network = check(report, 'network.fetch');
    assert.equal(network.status, 'error');
    assert.equal(network.details.length, 5);
    assert.equal(network.details.filter((line) => line.includes('timed out after 8000ms')).length, 2);
    assert.equal(network.details.filter((line) => line.includes('total budget')).length, 2);
    assert.ok(network.details.some((line) => /timed out after [1-4]\d{3}ms/.test(line)));

    assert.match(check(report, 'links.fetch').message, /total budget/);
    assert.ok(check(report, 'actions.module').details.some((line) => line.includes('total budget')));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
