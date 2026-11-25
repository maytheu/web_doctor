import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBadge, renderUnavailableBadge } from '../src/badge.mjs';

function makeReport(status, summary = {}) {
  return { status, summary: { pass: 0, warn: 0, error: 0, skip: 0, ...summary }, artifacts: [] };
}

test('conformant badge uses the green message', () => {
  const svg = renderBadge(makeReport('conformant'));
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('<title>'));
  assert.ok(svg.includes('#1f7a3d'));
  assert.ok(svg.includes('>conformant</text>'));
});

test('badge geometry is 20px tall with two 3px-rounded segments and a seam', () => {
  const svg = renderBadge(makeReport('conformant'));
  const header = svg.match(/<svg[^>]*width="(\d+)" height="20" role="img"/);
  assert.ok(header, 'svg root must be 20px tall and carry role="img"');
  const width = Number(header[1]);
  const labelWidth = 'agentic web'.length * 7 + 12;
  const messageWidth = 'conformant'.length * 7 + 12;
  assert.equal(width, labelWidth + messageWidth);
  assert.equal((svg.match(/rx="3"/g) ?? []).length, 2);
  assert.ok(svg.includes(`<rect width="${width}" height="20" rx="3" fill="#3c3f44"/>`));
  assert.ok(svg.includes(`<rect x="${labelWidth}" width="${messageWidth}" height="20" rx="3" fill="#1f7a3d"/>`));
  assert.ok(svg.includes(`<rect x="${labelWidth - 3}" width="6" height="20" fill="#1f7a3d"/>`));
});

test('warnings badge shows the warning count', () => {
  const svg = renderBadge(makeReport('warnings', { warn: 2 }));
  assert.ok(svg.includes('#b7791f'));
  assert.ok(svg.includes('>2 warnings</text>'));
});

test('non-conformant badge shows the error count', () => {
  const svg = renderBadge(makeReport('non-conformant', { error: 1 }));
  assert.ok(svg.includes('#b42318'));
  assert.ok(svg.includes('>1 errors</text>'));
});

test('a pin mismatch renders changed', () => {
  const report = makeReport('conformant');
  report.artifacts = [{ kind: 'manifest', sha256: 'abc123' }];
  const svg = renderBadge(report, { pin: 'def456' });
  assert.ok(svg.includes('#6b21a8'));
  assert.ok(svg.includes('>changed</text>'));
});

test('a matching pin keeps the status message', () => {
  const report = makeReport('conformant');
  report.artifacts = [{ kind: 'manifest', sha256: 'abc123' }];
  const svg = renderBadge(report, { pin: 'abc123' });
  assert.ok(svg.includes('>conformant</text>'));
});

test('label sanitization strips markup and keeps the badge valid', () => {
  const svg = renderBadge(makeReport('conformant'), { label: '<script>alert("x")</script>' });
  assert.ok(!svg.includes('<script'));
  assert.ok(svg.includes('>scriptalertxscript</text>'));
});

test('label is capped at 20 characters and the width follows it', () => {
  const svg = renderBadge(makeReport('conformant'), { label: 'abcdefghijklmnopqrstuvwxyz' });
  assert.ok(svg.includes('>abcdefghijklmnopqrst</text>'));
  assert.ok(svg.includes('width="234"'));
});

test('an empty sanitized label falls back to agentic web', () => {
  const svg = renderBadge(makeReport('conformant'), { label: '!!!' });
  assert.ok(svg.includes('>agentic web</text>'));
});

test('label whitespace is trimmed after truncation', () => {
  const svg = renderBadge(makeReport('conformant'), { label: '  my label  ' });
  assert.ok(svg.includes('>my label</text>'));
});

test('message text and attribute values are XML-escaped', () => {
  const svg = renderBadge(makeReport('warnings', { warn: '<5 & "6">' }));
  assert.ok(svg.includes('&lt;5 &amp; &quot;6&quot;&gt; warnings'));
  assert.ok(!svg.includes('<5 &'));
  assert.ok(svg.includes('aria-label="agentic web: &lt;5 &amp; &quot;6&quot;&gt; warnings"'));
});

test('unavailable badge is neutral and sanitizes its label', () => {
  const svg = renderUnavailableBadge('doctor <x>');
  assert.ok(svg.includes('#6b7280'));
  assert.ok(svg.includes('>unavailable</text>'));
  assert.ok(svg.includes('>doctor x</text>'));
  assert.ok(!svg.includes('<x>'));
});
