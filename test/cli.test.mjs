import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/fixture-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(ROOT, 'bin', 'doctor.mjs');
const FIXTURES = path.join(ROOT, 'fixtures');

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
    });
  });
}

async function withFixture(name, fn) {
  const fixture = await startFixtureServer(path.join(FIXTURES, name));
  try {
    return await fn(fixture.baseUrl);
  } finally {
    await fixture.close();
  }
}

test('--help exits 0 and prints usage', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('Usage:'));
});

test('--version exits 0 and prints the version', async () => {
  const result = await runCli(['--version']);
  assert.equal(result.code, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('missing url exits 2', async () => {
  const result = await runCli([]);
  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes('Error'));
});

test('conformant site exits 0', async () => {
  await withFixture('good', async (baseUrl) => {
    const result = await runCli(['--allow-private', baseUrl]);
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('CONFORMANT'));
  });
});

test('errors exit 1 by default', async () => {
  await withFixture('broken-front-man', async (baseUrl) => {
    const result = await runCli(['--allow-private', baseUrl]);
    assert.equal(result.code, 1);
    assert.ok(result.stdout.includes('ERROR'));
  });
});

test('warnings exit 0 by default and 1 with --fail-on warn', async () => {
  await withFixture('warn-only', async (baseUrl) => {
    const relaxed = await runCli(['--allow-private', baseUrl]);
    assert.equal(relaxed.code, 0);
    assert.ok(relaxed.stdout.includes('WARNINGS'));
    const strict = await runCli(['--allow-private', '--fail-on', 'warn', baseUrl]);
    assert.equal(strict.code, 1);
  });
});

test('--json prints only the report', async () => {
  await withFixture('good', async (baseUrl) => {
    const result = await runCli(['--json', '--allow-private', baseUrl]);
    assert.equal(result.code, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'conformant');
    assert.equal(report.schemaVersion, 1);
  });
});

test('--report writes the JSON report while keeping human output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awd-cli-report-'));
  const reportPath = path.join(dir, 'report.json');
  try {
    await withFixture('good', async (baseUrl) => {
      const result = await runCli(['--allow-private', '--report', reportPath, baseUrl]);
      assert.equal(result.code, 0);
      assert.ok(result.stdout.includes('Status: CONFORMANT'));
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      assert.equal(report.status, 'conformant');
      assert.equal(report.schemaVersion, 1);
      assert.ok(Array.isArray(report.checks));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--badge writes the SVG and --pin detects a changed manifest', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awd-cli-badge-'));
  const badgePath = path.join(dir, 'badge.svg');
  try {
    await withFixture('good', async (baseUrl) => {
      const jsonRun = await runCli(['--json', '--allow-private', baseUrl]);
      assert.equal(jsonRun.code, 0);
      const sha = JSON.parse(jsonRun.stdout).artifacts.find((artifact) => artifact.kind === 'manifest').sha256;

      const matching = await runCli(['--allow-private', '--pin', sha, '--badge', badgePath, baseUrl]);
      assert.equal(matching.code, 0);
      const svg = await readFile(badgePath, 'utf8');
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.includes('>conformant</text>'));
      assert.ok(svg.includes('>agentic web</text>'));

      const mismatch = await runCli(['--allow-private', '--pin', 'f'.repeat(64), '--badge', badgePath, baseUrl]);
      assert.equal(mismatch.code, 1);
      assert.ok(mismatch.stderr.includes('Manifest changed'));
      assert.ok((await readFile(badgePath, 'utf8')).includes('>changed</text>'));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('human output prints every check with aligned status and summary', async () => {
  await withFixture('good', async (baseUrl) => {
    const jsonRun = await runCli(['--json', '--allow-private', baseUrl]);
    const report = JSON.parse(jsonRun.stdout);
    const result = await runCli(['--allow-private', baseUrl]);
    assert.equal(result.code, 0);

    const lines = result.stdout.split('\n');
    assert.match(lines[0], /^Agentic Web Doctor \d+\.\d+\.\d+ \(spec mvp-0\.2\)$/);
    assert.ok(result.stdout.includes(`Base URL: ${baseUrl}`));
    assert.match(result.stdout, /^Status: CONFORMANT {2}Score: 100\/100 {2}Duration: \d+ms$/m);
    assert.match(
      result.stdout,
      new RegExp(`^Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.error} error, ${report.summary.skip} skip$`, 'm')
    );

    for (const check of report.checks) {
      const expected = `${check.status.toUpperCase().padEnd(5)} ${check.id.padEnd(26)} ${check.message}`;
      assert.ok(lines.includes(expected), `missing line for ${check.id}: ${expected}`);
    }
    assert.ok(lines.some((line) => line.startsWith('SKIP  actions.module')));
  });
});

test('human output indents hints and details under failing checks', async () => {
  await withFixture('broken-front-man', async (baseUrl) => {
    const result = await runCli(['--allow-private', baseUrl]);
    assert.equal(result.code, 1);
    const lines = result.stdout.split('\n');
    const index = lines.findIndex((line) => line.startsWith('ERROR') && line.includes('network.front_man'));
    assert.ok(index > 0, 'missing network.front_man line');
    assert.ok(lines[index + 1].startsWith('      hint: '));
    assert.ok(lines.some((line) => line.startsWith('      - ')));
  });
});

test('--timeout bounds each request and a total transport failure exits 2', async () => {
  const slow = http.createServer(() => {});
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${slow.address().port}`;
  try {
    const result = await runCli(['--allow-private', '--timeout', '50', baseUrl]);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /timed out after 50ms/);
  } finally {
    slow.closeAllConnections();
    await new Promise((resolve) => slow.close(resolve));
  }

  const invalid = await runCli(['--allow-private', '--timeout', '0', 'http://127.0.0.1']);
  assert.equal(invalid.code, 2);
  assert.ok(invalid.stderr.includes('--timeout must be a positive number'));
});

test('a blocked URL exits 2 without fetching', async () => {
  const loopback = await runCli(['http://127.0.0.1']);
  assert.equal(loopback.code, 2);
  assert.ok(loopback.stdout.includes('NON-CONFORMANT'));
  assert.ok(loopback.stdout.includes('Blocked private address'));

  const port = await runCli(['http://127.0.0.1:1']);
  assert.equal(port.code, 2);
  assert.ok(port.stdout.includes('Blocked port'));
});
