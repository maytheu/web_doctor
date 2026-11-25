import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';

let server;
let baseUrl;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('runtime modules are served as CORS-readable JavaScript', async () => {
  for (const pathname of ['/runtime/index.js', '/runtime/core.js', '/runtime/byok.js', '/runtime/panel.js']) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 200, `${pathname} should return 200`);
    assert.ok(response.headers.get('content-type').includes('text/javascript'), `${pathname} should be JavaScript`);
    assert.equal(response.headers.get('access-control-allow-origin'), '*', `${pathname} should be CORS-readable`);
  }
});

test('site.js boots the runtime and subscribes to activity for the receipt', async () => {
  const response = await fetch(`${baseUrl}/site.js`);
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.ok(source.includes("mount: '#agent-panel'"));
  assert.ok(source.includes("manifest: '/agent-manifest.json'"));
  assert.ok(source.includes("actions: '/actions/doctor-actions.js'"));
  assert.ok(source.includes('createReceiptTracker'));
  assert.ok(source.includes("on('activity'"));

  const page = await (await fetch(`${baseUrl}/`)).text();
  assert.ok(page.includes('id="agent-panel"'));
  assert.ok(page.includes('id="receipt-list"'));
  assert.ok(page.includes('src="/site.js"'));
});

test('the page CSP allows an HTTPS BYOK router', async () => {
  const response = await fetch(`${baseUrl}/`);
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp.includes("connect-src 'self' https:"));
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(!csp.includes('unsafe-inline'));
});
