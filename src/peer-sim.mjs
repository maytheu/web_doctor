import { fetchText } from './fetch.mjs';

export function createConsentSession() {
  const decisions = new Map();
  return {
    recall(origin) {
      return decisions.get(origin) ?? null;
    },
    remember(origin, decision) {
      decisions.set(origin, decision);
    },
    list() {
      return [...decisions].map(([origin, decision]) => ({ origin, ...decision }));
    }
  };
}

export function assertPrivacyReceipt(receipt, { key } = {}) {
  const issues = [];
  if (!receipt || receipt.keySentToPeer !== false) issues.push('the key was sent to a peer');
  if (receipt?.slyDataForwarded !== 'none') issues.push('private context was forwarded to a peer');
  if (receipt?.loaded && receipt.router?.keyAttached !== true) issues.push('the router request did not attach the key');
  if (key && JSON.stringify(receipt).includes(key)) issues.push('the receipt contains the key');
  if (issues.length) throw new Error(`Privacy receipt failed: ${issues.join('; ')}`);
  return receipt;
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function policyFor(manifest) {
  const allowed = new Set();
  for (const entry of Array.isArray(manifest?.allowed_peers) ? manifest.allowed_peers : []) {
    const origin = originOf(entry);
    if (origin) allowed.add(origin);
  }
  const denied = new Set();
  for (const entry of Array.isArray(manifest?.peer_policy?.deny_origins) ? manifest.peer_policy.deny_origins : []) {
    const origin = originOf(entry);
    if (origin) denied.add(origin);
  }
  return { allowed, denied, open: manifest?.peer_policy?.mode === 'open' };
}

function corsReadable(response, siteOrigin, label) {
  const value = response.headers['access-control-allow-origin'];
  if (value !== '*' && value !== siteOrigin) {
    throw new Error(`${label} is not CORS-readable from ${siteOrigin}`);
  }
}

function findNetworkEntry(peerManifest, peerUrl, peerOrigin) {
  const entries = Array.isArray(peerManifest?.networks) ? peerManifest.networks : [];
  const match = entries.find((entry) => {
    if (typeof entry?.hocon !== 'string') return false;
    try {
      return new URL(entry.hocon, `${peerOrigin}/`).href === new URL(peerUrl).href;
    } catch {
      return false;
    }
  });
  return match || entries[0] || null;
}

export async function simulatePeerLoad(options) {
  const {
    siteBaseUrl,
    peerSymbol,
    siteNetwork,
    consent,
    session = createConsentSession(),
    routerUrl,
    model = 'alibaba/qwen3.8-flash',
    key,
    userRequest = 'Introduce the peer network.',
    allowPrivate = false,
    timeoutMs = 8000
  } = options;

  const site = new URL(siteBaseUrl);
  const siteOrigin = site.origin;
  const base = siteBaseUrl.replace(/\/+$/, '');
  const contacts = [];

  async function getJson(url, label) {
    contacts.push(new URL(url).origin);
    const response = await fetchText(url, { allowPrivate, timeoutMs });
    if (response.status !== 200) throw new Error(`${label} returned HTTP ${response.status}`);
    let json;
    try {
      json = JSON.parse(response.text);
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
    return { response, json };
  }

  function finish(receipt) {
    return assertPrivacyReceipt(receipt, { key });
  }

  function stopped(reason, peerOrigin, decisionInfo) {
    return finish({
      loaded: false,
      reason,
      peer: { symbol: peerSymbol, origin: peerOrigin },
      router: null,
      keySentToPeer: false,
      slyDataForwarded: 'none',
      originsContacted: [...new Set(contacts)],
      consent: decisionInfo,
      peerArtifacts: [],
      result: null
    });
  }

  const noConsent = {
    requested: false,
    remembered: false,
    decision: null,
    origin: null,
    purpose: null,
    at: null
  };

  const { json: manifest } = await getJson(`${base}/agent-manifest.json`, 'Site manifest');
  const { json: links } = await getJson(`${base}/links.json`, 'Site links');

  const networkName = siteNetwork || manifest?.networks?.[0]?.name;
  const peerUrl = networkName ? links?.networks?.[networkName]?.[peerSymbol] : null;
  if (!peerUrl) return stopped('peer-not-linked', null, noConsent);

  let peer;
  try {
    peer = new URL(peerUrl);
  } catch {
    throw new Error(`links.json resolved ${peerSymbol} to an invalid URL`);
  }
  if (peer.protocol !== 'http:' && peer.protocol !== 'https:') {
    throw new Error(`links.json resolved ${peerSymbol} to a non-HTTP URL`);
  }
  const peerOrigin = peer.origin;

  const policy = policyFor(manifest);
  if (policy.denied.has(peerOrigin) || (!policy.open && !policy.allowed.has(peerOrigin))) {
    return stopped('peer-not-allowed', peerOrigin, noConsent);
  }

  const purpose = `Load peer "${peerSymbol}" from ${peerOrigin} using your router.`;
  let decisionInfo = session.recall(peerOrigin);
  let requested = false;
  if (!decisionInfo) {
    if (typeof consent !== 'function') throw new Error('Loading a new peer origin requires a consent callback');
    const approved = await consent({ origin: peerOrigin, purpose, symbol: peerSymbol });
    decisionInfo = { decision: approved ? 'allowed' : 'denied', at: new Date().toISOString(), purpose };
    session.remember(peerOrigin, decisionInfo);
    requested = true;
  }

  const consentState = {
    requested,
    remembered: !requested,
    decision: decisionInfo.decision,
    origin: peerOrigin,
    purpose: decisionInfo.purpose || purpose,
    at: decisionInfo.at
  };
  if (decisionInfo.decision !== 'allowed') return stopped('consent-denied', peerOrigin, consentState);

  const peerManifestArtifact = await getJson(`${peerOrigin}/agent-manifest.json`, 'Peer manifest');
  corsReadable(peerManifestArtifact.response, siteOrigin, 'Peer manifest');
  const peerNetworkArtifact = await getJson(peerUrl, 'Peer network');
  corsReadable(peerNetworkArtifact.response, siteOrigin, 'Peer network');

  const agents = Array.isArray(peerNetworkArtifact.json?.tools) ? peerNetworkArtifact.json.tools : [];
  if (agents.length === 0) throw new Error('Peer network defines no agents');

  const entry = findNetworkEntry(peerManifestArtifact.json, peerUrl, peerOrigin);
  const frontMan = peerNetworkArtifact.json?.front_man || entry?.front_man || agents[0]?.name;
  const frontAgent = agents.find((agent) => agent?.name === frontMan);
  if (!frontMan || !frontAgent) throw new Error(`Peer front man "${frontMan}" is not defined in the network`);

  if (!routerUrl) throw new Error('A router URL is required to run the peer');
  if (!key) throw new Error('A router key is required to run the peer');
  const router = new URL(routerUrl);
  contacts.push(router.origin);

  const description = frontAgent.function?.description || '';
  const routerResponse = await fetch(routerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: `You are ${frontMan}, front man for peer network "${peerSymbol}". ${description}`.trim() },
        { role: 'user', content: userRequest }
      ]
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!routerResponse.ok) throw new Error(`Router returned HTTP ${routerResponse.status}`);
  const result = await routerResponse.json().catch(() => ({}));

  return finish({
    loaded: true,
    reason: null,
    peer: {
      symbol: peerSymbol,
      origin: peerOrigin,
      network: entry?.name || peerNetworkArtifact.json?.name || null,
      frontMan,
      agents: agents.length
    },
    router: { origin: router.origin, model, keyAttached: true },
    keySentToPeer: false,
    slyDataForwarded: 'none',
    originsContacted: [...new Set(contacts)],
    consent: consentState,
    peerArtifacts: [
      {
        url: peerManifestArtifact.response.url,
        bytes: peerManifestArtifact.response.bytes,
        sha256: peerManifestArtifact.response.sha256
      },
      {
        url: peerNetworkArtifact.response.url,
        bytes: peerNetworkArtifact.response.bytes,
        sha256: peerNetworkArtifact.response.sha256
      }
    ],
    result
  });
}
