import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOOPBACK = 'http://127.0.0.1:8788';
const raw = process.argv[2];

if (!raw) {
  console.error('Usage: node scripts/set-peer-origin.mjs https://<peer-host>');
  process.exit(2);
}

let url;
try {
  url = new URL(raw);
} catch {
  console.error(`Not a valid URL: ${raw}`);
  process.exit(2);
}
if (url.protocol !== 'http:' && url.protocol !== 'https:') {
  console.error('The peer origin must use http or https.');
  process.exit(2);
}
if (url.pathname !== '/' || url.search || url.hash) {
  console.error('Pass an origin only, for example https://agentic-web-doctor-peer.onrender.com');
  process.exit(2);
}
const origin = url.origin;

const manifestPath = path.join(ROOT, 'public', 'agent-manifest.json');
const linksPath = path.join(ROOT, 'public', 'links.json');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.allowed_peers = [...new Set([origin, LOOPBACK])];
manifest.peer_policy = {
  ...manifest.peer_policy,
  mode: 'closed',
  note:
    origin === LOOPBACK
      ? 'The bundled demo peer is pre-approved for local demos. Replace it with your deployed peer origin.'
      : `The bundled demo peer (${origin}) and the local fixture are pre-approved.`
};

const links = JSON.parse(await readFile(linksPath, 'utf8'));
links.networks ??= {};
links.networks.doctor_audit_assistant ??= {};
links.networks.doctor_audit_assistant.demo_peer = `${origin}/demo.network.json`;

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(linksPath, `${JSON.stringify(links, null, 2)}\n`);

console.log(`allowed_peers: ${manifest.allowed_peers.join(', ')}`);
console.log(`demo_peer: ${links.networks.doctor_audit_assistant.demo_peer}`);
console.log('Re-run the self-audit, commit the two files and redeploy.');
