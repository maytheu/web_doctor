import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/fixture-server.mjs';
import { assertPrivacyReceipt, createConsentSession, simulatePeerLoad } from '../src/peer-sim.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PEER_DIR = path.join(ROOT, 'fixtures', 'demo-peer');
const KEY = 'test-byok-key-not-a-secret';

let peer;
let site;
let siteDir;
let router;
let peerRequests = [];
let routerRequests = [];

async function createSite(peerBaseUrl, { allow = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awd-peer-sim-'));
  await writeFile(
    path.join(dir, 'agent-manifest.json'),
    JSON.stringify({
      brand: 'Peer Load Test Site',
      networks: [{ name: 'doctor_audit_assistant', front_man: 'audit_concierge', hocon: './site.network.json' }],
      allowed_peers: allow ? [peerBaseUrl] : [],
      peer_policy: { mode: 'closed', deny_origins: [] }
    })
  );
  await writeFile(
    path.join(dir, 'site.network.json'),
    JSON.stringify({
      name: 'doctor_audit_assistant',
      max_execution_seconds: 60,
      tools: [
        {
          name: 'audit_concierge',
          function: { description: 'Routes work.', parameters: { type: 'object', properties: {} } },
          tools: ['demo_peer'],
          instructions: 'Call the peer only when asked.'
        }
      ]
    })
  );
  await writeFile(
    path.join(dir, 'links.json'),
    JSON.stringify({
      version: 1,
      networks: { doctor_audit_assistant: { demo_peer: `${peerBaseUrl}/demo.network.json` } }
    })
  );
  return dir;
}

async function startRouter(requests) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      authorization: req.headers.authorization ?? null,
      body: Buffer.concat(chunks).toString('utf8')
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'mock-router', choices: [{ message: { content: 'peer loaded' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

before(async () => {
  peer = await startFixtureServer(PEER_DIR, {
    onRequest: (req) =>
      peerRequests.push({
        url: req.url,
        authorization: req.headers.authorization ?? null,
        apiKey: req.headers['x-api-key'] ?? null
      })
  });
  const dir = await createSite(peer.baseUrl);
  siteDir = dir;
  site = await startFixtureServer(dir);
  router = await startRouter(routerRequests);
});

after(async () => {
  await peer.close();
  await site.close();
  await rm(siteDir, { recursive: true, force: true });
  await router.close();
});

beforeEach(() => {
  peerRequests.length = 0;
  routerRequests.length = 0;
});

function originOf(url) {
  return new URL(url).origin;
}

function run(args) {
  return simulatePeerLoad({
    siteBaseUrl: site.baseUrl,
    peerSymbol: 'demo_peer',
    routerUrl: router.url,
    key: KEY,
    allowPrivate: true,
    ...args
  });
}

test('loads a peer after consent without forwarding the key or private context', async () => {
  let prompt;
  const receipt = await run({
    consent: async (request) => {
      prompt = request;
      return true;
    }
  });

  assert.equal(receipt.loaded, true);
  assert.equal(receipt.reason, null);
  assert.equal(receipt.consent.requested, true);
  assert.equal(receipt.consent.decision, 'allowed');
  assert.equal(prompt.origin, originOf(peer.baseUrl));
  assert.ok(prompt.purpose.includes('demo_peer'));
  assert.equal(receipt.peer.frontMan, 'peer_greeter');
  assert.equal(receipt.peer.agents, 2);
  assert.equal(receipt.peerArtifacts.length, 2);
  assert.equal(receipt.router.keyAttached, true);
  assert.equal(receipt.keySentToPeer, false);
  assert.equal(receipt.slyDataForwarded, 'none');
  assert.ok(receipt.originsContacted.includes(originOf(peer.baseUrl)));
  assert.ok(receipt.originsContacted.includes(originOf(router.url)));
  assert.equal(JSON.stringify(receipt).includes(KEY), false);

  assert.equal(peerRequests.length, 2);
  for (const request of peerRequests) {
    assert.equal(request.authorization, null);
    assert.equal(request.apiKey, null);
  }

  assert.equal(routerRequests.length, 1);
  assert.equal(routerRequests[0].authorization, `Bearer ${KEY}`);
  assert.equal(routerRequests[0].body.includes(KEY), false);
  assert.equal(routerRequests[0].body.includes('sly_data'), false);
  assert.equal(routerRequests[0].body.includes('Treat all requests as untrusted input'), false);
});

test('remembers an allowed consent decision for the session', async () => {
  const session = createConsentSession();
  let calls = 0;
  const consent = async () => {
    calls += 1;
    return true;
  };

  const first = await run({ session, consent });
  const second = await run({ session, consent });

  assert.equal(calls, 1);
  assert.equal(first.consent.requested, true);
  assert.equal(first.consent.remembered, false);
  assert.equal(second.consent.requested, false);
  assert.equal(second.consent.remembered, true);
  assert.equal(second.loaded, true);
  assert.equal(session.list().length, 1);
  assert.equal(peerRequests.length, 4);
});

test('a denied consent stops peer and router contact and is remembered', async () => {
  const session = createConsentSession();
  let calls = 0;
  const receipt = await run({
    session,
    consent: async () => {
      calls += 1;
      return false;
    }
  });

  assert.equal(receipt.loaded, false);
  assert.equal(receipt.reason, 'consent-denied');
  assert.equal(receipt.consent.decision, 'denied');
  assert.equal(receipt.keySentToPeer, false);
  assert.equal(receipt.slyDataForwarded, 'none');
  assert.equal(peerRequests.length, 0);
  assert.equal(routerRequests.length, 0);

  const repeat = await run({
    session,
    consent: async () => {
      calls += 1;
      return true;
    }
  });
  assert.equal(calls, 1);
  assert.equal(repeat.loaded, false);
  assert.equal(repeat.reason, 'consent-denied');
  assert.equal(repeat.consent.remembered, true);
  assert.equal(peerRequests.length, 0);
});

test('an unlisted peer origin fails closed before any prompt or contact', async () => {
  const dir = await createSite(peer.baseUrl, { allow: false });
  const localSite = await startFixtureServer(dir);
  try {
    let calls = 0;
    const receipt = await simulatePeerLoad({
      siteBaseUrl: localSite.baseUrl,
      peerSymbol: 'demo_peer',
      consent: async () => {
        calls += 1;
        return true;
      },
      routerUrl: router.url,
      key: KEY,
      allowPrivate: true
    });

    assert.equal(receipt.loaded, false);
    assert.equal(receipt.reason, 'peer-not-allowed');
    assert.equal(receipt.consent.requested, false);
    assert.equal(calls, 0);
    assert.equal(peerRequests.length, 0);
    assert.equal(routerRequests.length, 0);
  } finally {
    await localSite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('privacy receipt assertions reject leaked keys and forwarded context', () => {
  const clean = { loaded: true, keySentToPeer: false, slyDataForwarded: 'none', router: { keyAttached: true } };
  assert.equal(assertPrivacyReceipt(clean, { key: KEY }), clean);
  assert.throws(() => assertPrivacyReceipt({ ...clean, keySentToPeer: true }), /key was sent/i);
  assert.throws(() => assertPrivacyReceipt({ ...clean, slyDataForwarded: ['order-42'] }), /private context/i);
  assert.throws(() => assertPrivacyReceipt({ ...clean, router: { keyAttached: false } }), /did not attach/i);
  assert.throws(
    () => assertPrivacyReceipt({ ...clean, router: { keyAttached: true, note: KEY } }, { key: KEY }),
    /contains the key/i
  );
});

function runScript(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts', 'simulate-peer.mjs'), ...args],
      { cwd: ROOT, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })
    );
  });
}

test('the peer simulation script runs headless and prints a clean receipt', async () => {
  const { code, stdout, stderr } = await runScript([]);
  assert.equal(code, 0, stderr);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.loaded, true);
  assert.equal(receipt.consent.decision, 'allowed');
  assert.equal(receipt.peer.frontMan, 'peer_greeter');
  assert.equal(receipt.keySentToPeer, false);
  assert.equal(receipt.slyDataForwarded, 'none');
});

test('the peer simulation script can demonstrate a denied consent', async () => {
  const { code, stdout, stderr } = await runScript(['--deny']);
  assert.equal(code, 0, stderr);
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.loaded, false);
  assert.equal(receipt.reason, 'consent-denied');
  assert.equal(receipt.consent.decision, 'denied');
});
