import { createRuntime } from './core.js';
import { createPanel } from './panel.js';

export function boot({ mount, manifest = '/agent-manifest.json', actions, storage, fetchImpl, loadActions, now } = {}) {
  const target = typeof mount === 'string' ? document.querySelector(mount) : mount;
  if (!target) throw new Error(`Agent mount not found: ${mount}`);
  const panel = createPanel({ mount: target });
  const runtime = createRuntime({
    manifestUrl: manifest,
    actionsUrl: actions,
    storage,
    fetchImpl,
    loadActions,
    now,
    consent: panel.requestConsent
  });
  panel.attach(runtime);
  return runtime;
}
