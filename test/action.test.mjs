import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/fixture-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(ROOT, 'bin', 'doctor.mjs');
const OUTPUT_HELPER = path.join(ROOT, 'scripts', 'action-output.mjs');
const FIXTURES = path.join(ROOT, 'fixtures');

function exec(file, args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [file, ...args],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })
    );
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

function parseOutputs(text) {
  const outputs = {};
  for (const line of text.trim().split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) outputs[line.slice(0, index)] = line.slice(index + 1);
  }
  return outputs;
}

async function runAction(baseUrl) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'awd-action-'));
  const reportPath = path.join(work, 'report.json');
  const outputPath = path.join(work, 'output.txt');
  const summaryPath = path.join(work, 'summary.md');

  const audit = await exec(BIN, [
    baseUrl,
    '--fail-on',
    'error',
    '--timeout',
    '8000',
    '--report',
    reportPath,
    '--allow-private'
  ]);
  const helper = await exec(OUTPUT_HELPER, [reportPath, String(audit.code)], {
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath
  });

  return {
    ...audit,
    helperCode: helper.code,
    helperStdout: helper.stdout,
    reportPath,
    summary: await readFile(summaryPath, 'utf8'),
    outputs: parseOutputs(await readFile(outputPath, 'utf8')),
    work
  };
}

test('action.yml targets the CLI with --fail-on error and exposes outputs', async () => {
  const yaml = await readFile(path.join(ROOT, 'action.yml'), 'utf8');
  assert.match(yaml, /using:\s*composite/);
  assert.match(yaml, /--fail-on/);
  assert.match(yaml, /--report/);
  assert.match(yaml, /\$GITHUB_ACTION_PATH/);
  for (const input of ['url:', 'fail-on:', 'timeout:', 'allow-private:', 'report-path:']) {
    assert.ok(yaml.includes(input), `action.yml should declare ${input}`);
  }
  for (const output of ['status:', 'score:', 'errors:', 'warnings:', 'report:', 'exit-code:']) {
    assert.ok(yaml.includes(output), `action.yml should declare ${output}`);
  }
});

test('the action passes a conformant audit and writes a summary', async () => {
  await withFixture('good', async (baseUrl) => {
    const result = await runAction(baseUrl);
    try {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.helperCode, 0);
      assert.equal(result.outputs.status, 'conformant');
      assert.equal(result.outputs.score, '100');
      assert.equal(result.outputs.errors, '0');
      assert.equal(result.outputs.warnings, '0');
      assert.equal(result.outputs.report, result.reportPath);
      assert.equal(result.outputs['exit-code'], '0');
      assert.ok(result.summary.includes('Agentic Web Doctor: conformant'));
      assert.ok(result.summary.includes('No warnings or errors.'));
    } finally {
      await rm(result.work, { recursive: true, force: true });
    }
  });
});

test('the action fails on errors but still sets outputs', async () => {
  await withFixture('bad-peer', async (baseUrl) => {
    const result = await runAction(baseUrl);
    try {
      assert.equal(result.code, 1);
      assert.equal(result.helperCode, 0);
      assert.equal(result.outputs.status, 'non-conformant');
      assert.equal(result.outputs['exit-code'], '1');
      assert.ok(Number(result.outputs.errors) >= 1);
      assert.ok(result.helperStdout.includes('::error'));
      assert.ok(result.summary.includes('peers.allowed'));
    } finally {
      await rm(result.work, { recursive: true, force: true });
    }
  });
});

test('the action passes warnings when failing on errors only', async () => {
  await withFixture('warn-only', async (baseUrl) => {
    const result = await runAction(baseUrl);
    try {
      assert.equal(result.code, 0);
      assert.equal(result.outputs.status, 'warnings');
      assert.equal(result.outputs.warnings, '1');
      assert.equal(result.outputs['exit-code'], '0');
      assert.ok(result.helperStdout.includes('::warning'));
      assert.ok(result.summary.includes('network.budget'));
    } finally {
      await rm(result.work, { recursive: true, force: true });
    }
  });
});

test('the output helper marks a missing report as unknown', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'awd-action-missing-'));
  try {
    const outputPath = path.join(work, 'output.txt');
    const result = await exec(OUTPUT_HELPER, [path.join(work, 'missing.json'), '2'], {
      GITHUB_OUTPUT: outputPath
    });
    const outputs = parseOutputs(await readFile(outputPath, 'utf8'));
    assert.equal(result.code, 0);
    assert.equal(outputs.status, 'unknown');
    assert.equal(outputs['exit-code'], '2');
    assert.match(result.stderr, /No agentic web report/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
