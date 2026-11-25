import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { actions } from '../public/actions/doctor-actions.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.location;
});

test('run_audit stores a compact summary for get_last_report', async () => {
  assert.deepEqual(await actions.get_last_report.handler({}), {
    available: false,
    message: 'No audit has run in this session yet.'
  });

  const report = {
    baseUrl: 'https://site.example',
    generatedAt: '2026-11-19T00:00:00.000Z',
    status: 'warnings',
    score: 96,
    summary: { pass: 20, warn: 1, error: 0, skip: 2 },
    checks: [
      { id: 'manifest.fetch', category: 'publication', status: 'pass', message: 'ok' },
      { id: 'network.budget', category: 'execution', status: 'warn', message: 'No budget', hint: 'Add a budget' }
    ],
    artifacts: [{ kind: 'manifest', url: 'https://site.example/agent-manifest.json' }]
  };
  let requested;
  globalThis.fetch = async (url) => {
    requested = url;
    return new Response(JSON.stringify(report), { status: 200 });
  };

  const summary = await actions.run_audit.handler({ url: 'https://site.example' });
  assert.equal(requested, '/api/audit?url=https%3A%2F%2Fsite.example');
  assert.deepEqual(summary, {
    url: 'https://site.example',
    generatedAt: '2026-11-19T00:00:00.000Z',
    status: 'warnings',
    score: 96,
    summary: { pass: 20, warn: 1, error: 0, skip: 2 },
    artifactCount: 1,
    findings: [
      { id: 'network.budget', category: 'execution', status: 'warn', message: 'No budget', hint: 'Add a budget' }
    ]
  });
  assert.deepEqual(await actions.get_last_report.handler({}), { available: true, ...summary });
});

test('run_audit surfaces API errors', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Audit failed: boom' }), { status: 502 });
  await assert.rejects(actions.run_audit.handler({ url: 'https://site.example' }), /Audit failed: boom/);
});

test('explain_check returns catalog guidance and reports unknown ids', async () => {
  const catalog = [
    {
      id: 'manifest.cors',
      category: 'publication',
      severity: 'error',
      title: 'Manifest is CORS-readable',
      hint: 'Send Access-Control-Allow-Origin.',
      specRef: 'MVP 2.1'
    }
  ];
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/catalog');
    return new Response(JSON.stringify(catalog), { status: 200 });
  };

  assert.deepEqual(await actions.explain_check.handler({ check_id: 'manifest.cors' }), {
    found: true,
    id: 'manifest.cors',
    category: 'publication',
    severity: 'error',
    title: 'Manifest is CORS-readable',
    hint: 'Send Access-Control-Allow-Origin.',
    specRef: 'MVP 2.1'
  });
  assert.deepEqual(await actions.explain_check.handler({ check_id: 'nope.check' }), {
    found: false,
    check_id: 'nope.check',
    message: 'Unknown check "nope.check".'
  });
});

test('propose_badge builds same-origin snippets and escapes HTML', async () => {
  globalThis.location = { origin: 'https://doctor.example' };
  const target = encodeURIComponent('https://site.example/');

  const badge = await actions.propose_badge.handler({ url: 'https://site.example' });
  assert.equal(badge.badgeUrl, `https://doctor.example/api/badge?url=${target}`);
  assert.equal(badge.pageUrl, `https://doctor.example/?url=${target}`);
  assert.equal(badge.markdown, `[![agentic web](${badge.badgeUrl})](${badge.pageUrl})`);
  assert.equal(badge.html, `<a href="${badge.pageUrl}"><img src="${badge.badgeUrl}" alt="agentic web"></a>`);

  const custom = await actions.propose_badge.handler({ url: 'https://site.example', label: 'my <badge>' });
  assert.ok(custom.badgeUrl.includes('label=my+%3Cbadge%3E'));
  assert.ok(custom.html.includes('alt="my &lt;badge&gt;"'));
});
