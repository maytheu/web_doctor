import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText, isPrivateIp, requestOnce } from '../src/fetch.mjs';
import { startFixtureServer } from './helpers/fixture-server.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

test('blocks loopback literal addresses', async () => {
  await assert.rejects(() => fetchText('http://127.0.0.1/'), /Blocked private/);
});

test('blocks localhost hostnames', async () => {
  await assert.rejects(() => fetchText('http://localhost/'), /Blocked private host/);
});

test('blocks private and link-local ranges', async () => {
  await assert.rejects(() => fetchText('http://10.0.0.1/'), /Blocked private/);
  await assert.rejects(() => fetchText('http://169.254.169.254/latest/meta-data/'), /Blocked private/);
});

test('classifies mapped, expanded and NAT64 IPv6 forms', () => {
  const blocked = [
    '::1',
    '::',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    '::127.0.0.1',
    '[fe80::1]',
    'fd00::1',
    'fec0::1',
    'ff02::1',
    '64:ff9b::7f00:1'
  ];
  for (const address of blocked) assert.equal(isPrivateIp(address), true, address);
  const allowed = ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:808:808'];
  for (const address of allowed) assert.equal(isPrivateIp(address), false, address);
});

test('blocks private IPv6 literal URLs before contacting them', async () => {
  const urls = [
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[0:0:0:0:0:ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[0:0:0:0:0:0:0:1]/'
  ];
  for (const url of urls) await assert.rejects(() => fetchText(url), /Blocked private/, url);
});

test('rejects non-http protocols', async () => {
  await assert.rejects(() => fetchText('file:///etc/passwd'), /http and https/);
});

test('rejects embedded credentials', async () => {
  await assert.rejects(() => fetchText('http://user:pass@example.com/'), /credentials/);
});

test('rejects non-standard ports by default', async () => {
  await assert.rejects(() => fetchText('http://127.0.0.1:3000/'), /Blocked port/);
});

test('pinned lookup satisfies the autoSelectFamily callback shape', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = new URL(`http://localhost:${server.address().port}/`);
    const response = await requestOnce(url, { address: '127.0.0.1', family: 4 }, 2000, 1024);
    assert.equal(response.status, 200);
    assert.equal(response.text, 'ok');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('accepts loopback when allowPrivate is true', async () => {
  const fixture = await startFixtureServer(path.join(FIXTURES, 'good'));
  try {
    const response = await fetchText(`${fixture.baseUrl}/agent-manifest.json`, { allowPrivate: true });
    assert.equal(response.status, 200);
    assert.ok(response.text.includes('Little Oven'));
    assert.match(response.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await fixture.close();
  }
});

function handleLimitsAndRedirects(req, res) {
  res.on('error', () => {});
  const route = (req.url || '/').split('?')[0];
  const origin = `http://127.0.0.1:${req.socket.localPort}`;
  if (route === '/ok') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (route === '/exact') {
    res.writeHead(200, { 'content-length': '64' });
    res.end('x'.repeat(64));
    return;
  }
  if (route.startsWith('/chain/')) {
    const remaining = Number(route.slice('/chain/'.length));
    res.writeHead(302, { location: remaining <= 1 ? `${origin}/ok` : `${origin}/chain/${remaining - 1}` });
    res.end();
    return;
  }
  if (route === '/to-relative') {
    res.writeHead(302, { location: 'ok' });
    res.end();
    return;
  }
  if (route === '/to-file') {
    res.writeHead(302, { location: 'file:///etc/passwd' });
    res.end();
    return;
  }
  if (route === '/to-creds') {
    res.writeHead(302, { location: `http://user:pass@127.0.0.1:${req.socket.localPort}/ok` });
    res.end();
    return;
  }
  if (route === '/large') {
    res.writeHead(200, { 'content-length': '512' });
    try {
      res.end('x'.repeat(512));
    } catch {
      /* the client already hung up */
    }
    return;
  }
  if (route === '/large-stream') {
    res.writeHead(200);
    const timer = setInterval(() => {
      if (!res.writableEnded) res.write('y'.repeat(64));
    }, 5);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (route === '/drip') {
    const timer = setInterval(() => {
      if (!res.writableEnded) res.write('z');
    }, 10);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (route === '/slow') return;
  res.writeHead(404);
  res.end();
}

async function withFetchServer(fn) {
  const server = http.createServer(handleLimitsAndRedirects);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('follows three redirects and reports the final URL', async () => {
  await withFetchServer(async (base) => {
    const response = await fetchText(`${base}/chain/3`, { allowPrivate: true });
    assert.equal(response.status, 200);
    assert.equal(response.url, `${base}/ok`);
    assert.deepEqual(JSON.parse(response.text), { ok: true });
  });
});

test('rejects a fourth redirect', async () => {
  await withFetchServer(async (base) => {
    await assert.rejects(() => fetchText(`${base}/chain/4`, { allowPrivate: true }), /Too many redirects/);
  });
});

test('re-validates the protocol of every redirect hop', async () => {
  await withFetchServer(async (base) => {
    await assert.rejects(() => fetchText(`${base}/to-file`, { allowPrivate: true }), /http and https/);
  });
});

test('re-validates credentials on every redirect hop', async () => {
  await withFetchServer(async (base) => {
    await assert.rejects(() => fetchText(`${base}/to-creds`, { allowPrivate: true }), /credentials/);
  });
});

test('re-validates the private range of every redirect hop before contacting it', async () => {
  const cases = [
    { location: 'http://169.254.169.254/latest/meta-data/', pattern: /Blocked private address: 169\.254\.169\.254/ },
    { location: 'http://localhost/secret', pattern: /Blocked private host: localhost/ }
  ];
  for (const { location, pattern } of cases) {
    const hops = [];
    await assert.rejects(
      () =>
        fetchText('http://93.184.216.34/start', {
          request: async (url) => {
            hops.push(url.href);
            return { status: 302, headers: { location }, text: '', bytes: 0, sha256: '' };
          }
        }),
      pattern
    );
    assert.deepEqual(hops, ['http://93.184.216.34/start'], 'the redirect target should never be contacted');
  }
});

test('resolves a relative redirect location against the current hop', async () => {
  await withFetchServer(async (base) => {
    const response = await fetchText(`${base}/to-relative`, { allowPrivate: true });
    assert.equal(response.status, 200);
    assert.equal(response.url, `${base}/ok`);
  });
});

test('rejects a body that declares more than maxBytes', async () => {
  await withFetchServer(async (base) => {
    await assert.rejects(() => fetchText(`${base}/large`, { allowPrivate: true, maxBytes: 64 }), /exceeded 64 bytes/);
  });
});

test('rejects a streamed body once it passes maxBytes', async () => {
  await withFetchServer(async (base) => {
    await assert.rejects(() => fetchText(`${base}/large-stream`, { allowPrivate: true, maxBytes: 64 }), /exceeded 64 bytes/);
  });
});

test('accepts a body exactly at maxBytes', async () => {
  await withFetchServer(async (base) => {
    const response = await fetchText(`${base}/exact`, { allowPrivate: true, maxBytes: 64 });
    assert.equal(response.status, 200);
    assert.equal(response.bytes, 64);
  });
});

test('aborts a request that exceeds the timeout', async () => {
  await withFetchServer(async (base) => {
    await assert.rejects(() => fetchText(`${base}/slow`, { allowPrivate: true, timeoutMs: 50 }), /timed out after 50ms/);
  });
});

test('enforces the timeout against a slow-drip response', async () => {
  await withFetchServer(async (base) => {
    const started = Date.now();
    await assert.rejects(
      () => fetchText(`${base}/drip`, { allowPrivate: true, timeoutMs: 150 }),
      /timed out after 150ms/
    );
    assert.ok(Date.now() - started < 2000, 'the hard timeout should fire promptly');
  });
});
