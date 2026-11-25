import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFileLedger } from '../src/ledger.mjs';
import { auditSite } from '../src/audit.mjs';
import { startFixtureServer } from './helpers/fixture-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.join(ROOT, 'fixtures');
const BIN = path.join(ROOT, 'bin', 'doctor.mjs');

const MANIFEST = 'https://site.example/agent-manifest.json';
const META = { networkNames: ['net_a', 'net_b'], frontMans: ['front'] };
const artifact = (sha256 = 'a'.repeat(64)) => [{ url: MANIFEST, sha256, bytes: 10 }];

async function withTempLedger(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'awd-ledger-'));
  try {
    return await fn(path.join(dir, 'ledger.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withFixture(name, fn) {
  const fixture = await startFixtureServer(path.join(FIXTURES, name));
  try {
    return await fn(fixture.baseUrl);
  } finally {
    await fixture.close();
  }
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
    });
  });
}

const integrity = (report) => report.checks.find((entry) => entry.id === 'integrity.changed');

test('record stores hashes and metadata but no artifact content', async () => {
  await withTempLedger(async (file) => {
    const ledger = createFileLedger(file);
    ledger.record(artifact(), META);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    const entry = stored.entries[MANIFEST];
    assert.equal(entry.sha256, 'a'.repeat(64));
    assert.equal(entry.bytes, 10);
    assert.deepEqual(entry.networkNames, ['net_a', 'net_b']);
    assert.deepEqual(entry.frontMans, ['front']);
    assert.ok(entry.firstSeen);
    assert.ok(entry.lastSeen);
    assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'firstSeen', 'frontMans', 'lastSeen', 'networkNames', 'sha256']);
  });
});

test('record preserves firstSeen for an unchanged artifact', async () => {
  await withTempLedger(async (file) => {
    const ledger = createFileLedger(file);
    ledger.record(artifact(), META);
    const firstSeg = JSON.parse(readFileSync(file, 'utf8')).entries[MANIFEST].firstSeen;
    ledger.record(artifact(), META);
    const secondEntry = JSON.parse(readFileSync(file, 'utf8')).entries[MANIFEST];
    assert.equal(secondEntry.firstSeen, firstSeg);
  });
});

test('compare reports unchanged artifacts', async () => {
  await withTempLedger(async (file) => {
    const ledger = createFileLedger(file);
    ledger.record(artifact(), META);
    const result = ledger.compare(artifact(), META);
    assert.deepEqual(result.unchanged, [MANIFEST]);
    assert.equal(result.changed.length, 0);
    assert.equal(result.frontMans.changed, false);
  });
});

test('compare reports changed hashes with the previous value', async () => {
  await withTempLedger(async (file) => {
    const ledger = createFileLedger(file);
    ledger.record(artifact(), META);
    const result = ledger.compare(artifact('b'.repeat(64)), META);
    assert.equal(result.changed.length, 1);
    assert.equal(result.changed[0].previousSha256, 'a'.repeat(64));
    assert.equal(result.changed[0].sha256, 'b'.repeat(64));
  });
});

test('compare detects network and front_man changes', async () => {
  await withTempLedger(async (file) => {
    const ledger = createFileLedger(file);
    ledger.record(artifact(), META);
    const result = ledger.compare(artifact(), { networkNames: ['net_a'], frontMans: ['other'] });
    assert.equal(result.frontMans.changed, true);
    assert.deepEqual(result.frontMans.previous, ['front']);
    assert.deepEqual(result.frontMans.current, ['other']);
    assert.deepEqual(result.networks.removed, ['net_b']);
  });
});

test('reset removes the ledger file', async () => {
  await withTempLedger(async (file) => {
    const ledger = createFileLedger(file);
    ledger.record(artifact(), META);
    assert.equal(existsSync(file), true);
    ledger.reset();
    assert.equal(existsSync(file), false);
  });
});

test('audit records a baseline then reports artifacts unchanged', async () => {
  await withTempLedger(async (file) => {
    const ledger = createFileLedger(file);
    await withFixture('good', async (baseUrl) => {
      const first = await auditSite(baseUrl, { allowPrivate: true, ledger });
      assert.equal(integrity(first).status, 'pass');
      assert.equal(integrity(first).message, 'No previous ledger entries; baseline recorded');
      assert.equal(first.score, 100);

      const second = await auditSite(baseUrl, { allowPrivate: true, ledger });
      assert.equal(integrity(second).status, 'pass');
      assert.equal(integrity(second).message, 'Artifacts unchanged since last audit');
      assert.equal(second.status, 'conformant');
    });
  });
});

test('audit warns when a seeded ledger diverges', async () => {
  await withTempLedger(async (file) => {
    const ledger = createFileLedger(file);
    await withFixture('good', async (baseUrl) => {
      ledger.record(
        ['agent-manifest.json', 'assistant.network.json', 'links.json'].map((name) => ({
          url: `${baseUrl}/${name}`,
          sha256: '0'.repeat(64),
          bytes: 1
        })),
        { networkNames: ['littleoven_agents'], frontMans: ['front_desk'] }
      );
      const report = await auditSite(baseUrl, { allowPrivate: true, ledger });
      const check = integrity(report);
      assert.equal(check.status, 'warn');
      assert.ok(check.message.includes('3 artifact(s) changed'));
      assert.equal(report.status, 'warnings');
      assert.equal(report.score, 96);
    });
  });
});

test('audit errors when front_man drifts', async () => {
  await withTempLedger(async (file) => {
    const ledger = createFileLedger(file);
    await withFixture('good', async (baseUrl) => {
      ledger.record(
        ['agent-manifest.json', 'assistant.network.json', 'links.json'].map((name) => ({
          url: `${baseUrl}/${name}`,
          sha256: '0'.repeat(64),
          bytes: 1
        })),
        { networkNames: ['littleoven_agents'], frontMans: ['night_manager'] }
      );
      const report = await auditSite(baseUrl, { allowPrivate: true, ledger });
      const check = integrity(report);
      assert.equal(check.status, 'error');
      assert.equal(check.message, 'front_man changed since last audit');
      assert.equal(report.status, 'non-conformant');
      assert.equal(report.score, 85);
    });
  });
});

test('CLI --ledger records a baseline and detects no change on rerun', async () => {
  await withTempLedger(async (file) => {
    await withFixture('good', async (baseUrl) => {
      const first = await runCli(['--allow-private', '--ledger', file, baseUrl]);
      assert.equal(first.code, 0);
      assert.ok(first.stdout.includes('No previous ledger entries; baseline recorded'));

      const second = await runCli(['--json', '--allow-private', '--ledger', file, baseUrl]);
      assert.equal(second.code, 0);
      const report = JSON.parse(second.stdout);
      const check = integrity(report);
      assert.equal(check.status, 'pass');
      assert.equal(check.message, 'Artifacts unchanged since last audit');
    });
  });
});
