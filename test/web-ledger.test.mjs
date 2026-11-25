import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareArtifacts, createLedger, openBrowserLedger } from '../public/ledger.js';
import { createFakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { startFixtureServer } from './helpers/fixture-server.mjs';
import { auditSite } from '../src/audit.mjs';

const GOOD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'good');

function memoryStorage() {
  const data = new Map();
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async put(key, value) {
      data.set(key, structuredClone(value));
    },
    async delete(key) {
      data.delete(key);
    }
  };
}

function artifact(url, sha256, bytes = 10) {
  return { url, sha256, bytes };
}

test('compareArtifacts records a baseline on the first visit', () => {
  const stamp = '2026-11-19T00:00:00.000Z';
  const url = 'https://site.example/agent-manifest.json';
  const result = compareArtifacts(undefined, [artifact(url, 'a')], stamp);

  assert.equal(result.firstVisit, true);
  assert.equal(result.total, 1);
  assert.deepEqual(result.added, [url]);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.snapshot[url], { sha256: 'a', bytes: 10, firstSeen: stamp, lastSeen: stamp });
});

test('compareArtifacts keeps firstSeen and detects changes, additions, and removals', () => {
  const unchangedUrl = 'https://site.example/agent-manifest.json';
  const removedUrl = 'https://site.example/old.json';
  const previous = {
    artifacts: {
      [unchangedUrl]: { sha256: 'a', bytes: 1, firstSeen: 't0', lastSeen: 't0' },
      [removedUrl]: { sha256: 'o', bytes: 1, firstSeen: 't0', lastSeen: 't0' }
    }
  };

  const result = compareArtifacts(
    previous,
    [artifact(unchangedUrl, 'a', 1), artifact('https://site.example/new.json', 'n', 3)],
    't1'
  );

  assert.equal(result.firstVisit, false);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.added, ['https://site.example/new.json']);
  assert.deepEqual(result.removed, [removedUrl]);
  assert.equal(result.snapshot[unchangedUrl].firstSeen, 't0');
  assert.equal(result.snapshot[unchangedUrl].lastSeen, 't1');

  const drifted = compareArtifacts(
    { artifacts: { [unchangedUrl]: { sha256: 'a', bytes: 1, firstSeen: 't0', lastSeen: 't0' } } },
    [artifact(unchangedUrl, 'b', 2)],
    't2'
  );
  assert.deepEqual(drifted.changed, [
    {
      url: unchangedUrl,
      previousSha256: 'a',
      sha256: 'b',
      previousBytes: 1,
      bytes: 2
    }
  ]);
});

test('createLedger keeps snapshots per origin and ignores reports without artifacts', async () => {
  const storage = memoryStorage();
  const ledger = createLedger(storage, () => '2026-11-19T00:00:00.000Z');
  const a = 'https://a.example/agent-manifest.json';
  const b = 'https://b.example/agent-manifest.json';

  assert.equal((await ledger.remember({ baseUrl: 'https://a.example', artifacts: [artifact(a, 'a')] })).firstVisit, true);
  assert.equal((await ledger.remember({ baseUrl: 'https://b.example', artifacts: [artifact(b, 'b')] })).firstVisit, true);

  const revisit = await ledger.remember({ baseUrl: 'https://a.example', artifacts: [artifact(a, 'a')] });
  assert.equal(revisit.firstVisit, false);
  assert.equal(revisit.unchanged, 1);

  const stored = storage.data.get('https://a.example');
  assert.deepEqual(Object.keys(stored.artifacts), [a]);
  assert.equal(stored.artifacts[a].sha256, 'a');
  assert.equal('text' in stored.artifacts[a], false);

  assert.equal(await ledger.remember({ baseUrl: 'https://c.example', artifacts: [] }), null);
  assert.equal(storage.data.has('https://c.example'), false);

  await ledger.forget('https://a.example');
  assert.equal(storage.data.has('https://a.example'), false);
});

test('openBrowserLedger compares hashes across IndexedDB connections', async () => {
  const factory = createFakeIndexedDB();
  const url = 'https://site.example/agent-manifest.json';

  const first = await openBrowserLedger(factory);
  assert.ok(first);
  const baseline = await first.remember({ baseUrl: 'https://site.example', artifacts: [artifact(url, 'a')] });
  assert.equal(baseline.firstVisit, true);

  const second = await openBrowserLedger(factory);
  const revisit = await second.remember({ baseUrl: 'https://site.example', artifacts: [artifact(url, 'b', 20)] });
  assert.equal(revisit.firstVisit, false);
  assert.equal(revisit.changed.length, 1);
  assert.equal(revisit.changed[0].previousSha256, 'a');

  await second.forget('https://site.example');
  const third = await openBrowserLedger(factory);
  assert.equal((await third.remember({ baseUrl: 'https://site.example', artifacts: [artifact(url, 'b', 20)] })).firstVisit, true);

  assert.equal(await openBrowserLedger(null), null);
});

test('the web ledger compares real report hashes between fixture audits', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awd-web-ledger-'));
  await cp(GOOD_DIR, dir, { recursive: true });
  const fixture = await startFixtureServer(dir);
  try {
    const ledger = createLedger(memoryStorage());

    const baseline = await ledger.remember(await auditSite(fixture.baseUrl, { allowPrivate: true }));
    assert.equal(baseline.firstVisit, true);
    assert.equal(baseline.total, 3);

    const repeat = await ledger.remember(await auditSite(fixture.baseUrl, { allowPrivate: true }));
    assert.equal(repeat.firstVisit, false);
    assert.equal(repeat.unchanged, 3);
    assert.deepEqual(repeat.changed, []);

    const networkPath = path.join(dir, 'assistant.network.json');
    const network = await readFile(networkPath, 'utf8');
    await writeFile(networkPath, network.replace('"littleoven_agents"', '"littleoven_agents_v2"'));

    const drifted = await ledger.remember(await auditSite(fixture.baseUrl, { allowPrivate: true }));
    assert.equal(drifted.unchanged, 2);
    assert.equal(drifted.changed.length, 1);
    assert.ok(drifted.changed[0].url.endsWith('/assistant.network.json'));
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});
