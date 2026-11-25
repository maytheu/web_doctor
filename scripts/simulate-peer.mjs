import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../test/helpers/fixture-server.mjs';
import { createConsentSession, simulatePeerLoad } from '../src/peer-sim.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PEER_DIR = path.join(ROOT, '..', 'fixtures', 'demo-peer');
const deny = process.argv.includes('--deny');

async function startRouter() {
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'mock-router',
        choices: [
          { message: { role: 'assistant', content: 'The demo peer explains what it publishes.' } }
        ]
      })
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function createSite(peerBaseUrl) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'awd-peer-site-'));
  await writeFile(
    path.join(dir, 'agent-manifest.json'),
    JSON.stringify(
      {
        brand: 'Peer Load Demo Site',
        networks: [{ name: 'doctor_audit_assistant', front_man: 'audit_concierge', hocon: './site.network.json' }],
        allowed_peers: [peerBaseUrl],
        peer_policy: { mode: 'closed', deny_origins: [] }
      },
      null,
      2
    )
  );
  await writeFile(
    path.join(dir, 'links.json'),
    JSON.stringify(
      {
        version: 1,
        networks: {
          doctor_audit_assistant: { demo_peer: `${peerBaseUrl}/demo.network.json` }
        }
      },
      null,
      2
    )
  );
  return dir;
}

const peer = await startFixtureServer(PEER_DIR);
const siteDir = await createSite(peer.baseUrl);
const site = await startFixtureServer(siteDir);
const router = await startRouter();

try {
  const receipt = await simulatePeerLoad({
    siteBaseUrl: site.baseUrl,
    peerSymbol: 'demo_peer',
    session: createConsentSession(),
    consent: async () => !deny,
    routerUrl: router.url,
    key: 'demo-byok-key-not-a-secret',
    allowPrivate: true
  });
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  if (deny ? receipt.loaded || receipt.reason !== 'consent-denied' : !receipt.loaded) {
    process.exitCode = 1;
  }
} finally {
  await Promise.all([site.close(), peer.close(), router.close()]);
  await rm(siteDir, { recursive: true, force: true });
}
