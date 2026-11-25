export function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function createReceiptTracker() {
  const origins = new Set();
  const peerOrigins = new Set();
  const consentDecisions = [];
  let router = null;
  let auditArtifacts = null;

  function observe(event) {
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'router.request') {
      router = {
        host: String(event.host ?? 'unknown'),
        model: String(event.model ?? ''),
        keyUsed: Boolean(event.hasKey)
      };
      origins.add(router.host);
    } else if (event.type === 'action.call' && event.origin) {
      origins.add(String(event.origin));
    } else if (event.type === 'action.result') {
      if (Number.isInteger(event.result?.artifactCount)) auditArtifacts = event.result.artifactCount;
    } else if (event.type === 'consent.decision' && event.origin) {
      consentDecisions.push({
        origin: String(event.origin),
        allowed: Boolean(event.allowed),
        at: event.at ?? null
      });
    } else if (event.type === 'peer.request' && event.origin) {
      peerOrigins.add(String(event.origin));
      origins.add(String(event.origin));
    }
  }

  function snapshot() {
    return {
      router,
      keySentToPeer: 'no',
      slyDataForwarded: 'none',
      peerOrigins: [...peerOrigins],
      origins: [...origins],
      consentDecisions: consentDecisions.map((decision) => ({ ...decision })),
      auditArtifacts: auditArtifacts ?? 'not observable'
    };
  }

  function lines() {
    const state = snapshot();
    const routerLine = state.router
      ? `${state.router.host} (${state.router.keyUsed ? 'your key, stored locally' : 'no key'})`
      : 'not used this session';
    const consentLine = state.consentDecisions.length
      ? state.consentDecisions
          .map((decision) => `${decision.origin} ${decision.allowed ? 'allowed' : 'denied'} (${formatTimestamp(decision.at)})`)
          .join(', ')
      : 'none';
    return [
      `Router: ${routerLine}`,
      `Key sent to peer sites: ${state.keySentToPeer}`,
      `sly_data forwarded to peers: ${state.slyDataForwarded}`,
      `Origins contacted this session: ${state.origins.length ? state.origins.join(', ') : 'none'}`,
      `Consent decisions: ${consentLine}`,
      `Audit artifacts fetched server-side: ${state.auditArtifacts}`
    ];
  }

  return { observe, snapshot, lines };
}
