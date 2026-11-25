import { fetchText } from './fetch.mjs';
import { runChecks } from './checks.mjs';
import { CATALOG_BY_ID } from './catalog.mjs';
import { SCHEMA_VERSION, SPEC_PROFILE } from './version.mjs';

const MAX_NETWORKS = 5;
const DEFAULT_TOTAL_TIMEOUT_MS = 20000;

const SCHEME_PREFIX = /^([a-zA-Z][a-zA-Z0-9+.-]*):([\s\S]*)$/;
const PORT_SUFFIX = /^\d+(?:[/?#]|$)/;
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || LOOPBACK_IPV4.test(host);
}

function defaultScheme(raw) {
  try {
    return isLoopbackHost(new URL(`http://${raw}`).hostname) ? 'http' : 'https';
  } catch {
    return 'https';
  }
}

function withDefaultScheme(raw) {
  const scheme = raw.match(SCHEME_PREFIX);
  if (!scheme) return `${defaultScheme(raw)}://${raw}`;
  const [, name, rest] = scheme;
  if (/^https?$/i.test(name)) return raw;
  const hostLike =
    PORT_SUFFIX.test(rest) || name.includes('.') || name.toLowerCase() === 'localhost' || rest.includes('@');
  if (hostLike) return `${defaultScheme(raw)}://${raw}`;
  throw new TypeError('Only http and https URLs can be audited');
}

export function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new TypeError('A base URL is required');
  const candidate = withDefaultScheme(raw.trim());
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new TypeError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Only http and https URLs can be audited');
  }
  if (url.username || url.password) throw new TypeError('URLs with credentials are not supported');
  url.hash = '';
  url.search = '';
  const href = url.href;
  return href.endsWith('/') ? href.slice(0, -1) : href;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function auditSite(baseUrl, options = {}) {
  const started = Date.now();
  const base = normalizeBaseUrl(baseUrl);
  const timeoutMs = options.timeoutMs ?? 8000;
  const allowPrivate = Boolean(options.allowPrivate);
  const maxNetworks = options.maxNetworks ?? MAX_NETWORKS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const deadline = started + totalTimeoutMs;
  const fetchOptions = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Audit exceeded the ${totalTimeoutMs}ms total budget`);
    return { timeoutMs: Math.min(timeoutMs, remaining), allowPrivate };
  };
  const artifacts = [];
  const record = (kind, response) => {
    artifacts.push({ kind, url: response.url, status: response.status, bytes: response.bytes, sha256: response.sha256 });
  };

  const manifestUrl = `${base}/agent-manifest.json`;
  const ctx = {
    baseUrl: base,
    allowPrivate,
    manifest: null,
    networks: null,
    links: { url: `${base}/links.json`, state: 'missing' },
    actions: null
  };

  try {
    const response = await fetchText(manifestUrl, fetchOptions());
    record('manifest', response);
    ctx.manifest = {
      url: response.url,
      status: response.status,
      headers: response.headers,
      text: response.text,
      bytes: response.bytes,
      json: response.status === 200 ? parseJson(response.text) : null
    };
  } catch (error) {
    ctx.manifest = { url: manifestUrl, error: error.message };
  }

  const manifestJson = ctx.manifest?.json;
  if (manifestJson) {
    const declared = Array.isArray(manifestJson.networks) ? manifestJson.networks.slice(0, maxNetworks) : [];
    ctx.networks = [];
    for (const entry of declared) {
      if (!entry || typeof entry.hocon !== 'string' || !entry.hocon.trim()) continue;
      let target;
      try {
        target = new URL(entry.hocon, `${base}/`).href;
      } catch {
        continue;
      }
      const network = { entry, url: target };
      try {
        const response = await fetchText(target, fetchOptions());
        record('network', response);
        Object.assign(network, {
          status: response.status,
          headers: response.headers,
          text: response.text,
          bytes: response.bytes,
          json: response.status === 200 ? parseJson(response.text) : null
        });
      } catch (error) {
        network.error = error.message;
      }
      ctx.networks.push(network);
    }
  }

  try {
    const response = await fetchText(ctx.links.url, fetchOptions());
    record('links', response);
    if (response.status === 200) {
      const json = parseJson(response.text);
      ctx.links = json
        ? { url: response.url, state: 'ok', status: 200, headers: response.headers, text: response.text, bytes: response.bytes, json }
        : { url: response.url, state: 'invalid', status: 200, text: response.text, bytes: response.bytes };
    } else if (response.status === 404) {
      ctx.links = { url: response.url, state: 'missing' };
    } else {
      ctx.links = { url: response.url, state: 'error', status: response.status, error: `HTTP ${response.status}` };
    }
  } catch (error) {
    ctx.links = { url: ctx.links.url, state: 'error', error: error.message };
  }

  const actions = manifestJson?.actions;
  if (actions) {
    const info = { moduleUrl: null, moduleOk: false };
    if (typeof actions.module === 'string' && actions.module.trim()) {
      try {
        info.moduleUrl = new URL(actions.module, `${base}/`).href;
        const response = await fetchText(info.moduleUrl, fetchOptions());
        record('actions', response);
        info.moduleOk = response.status === 200;
        if (!info.moduleOk) info.moduleError = `HTTP ${response.status}`;
      } catch (error) {
        info.moduleError = error.message;
      }
    }
    ctx.actions = info;
  }

  const ledgerMeta = {
    networkNames: Array.isArray(manifestJson?.networks)
      ? manifestJson.networks.map((entry) => entry?.name).filter((name) => typeof name === 'string')
      : [],
    frontMans: Array.isArray(manifestJson?.networks)
      ? manifestJson.networks.map((entry) => entry?.front_man).filter((name) => typeof name === 'string')
      : []
  };
  if (options.ledger && artifacts.length) ctx.ledger = options.ledger.compare(artifacts, ledgerMeta);

  const checks = runChecks(ctx).map((result) => {
    const meta = CATALOG_BY_ID.get(result.id);
    const check = {
      id: result.id,
      category: meta.category,
      title: meta.title,
      severity: meta.severity,
      status: result.status,
      message: result.message,
      specRef: meta.specRef
    };
    if ((result.status === 'warn' || result.status === 'error') && meta.hint) check.hint = meta.hint;
    if (result.details?.length) check.details = result.details;
    if (result.evidence) check.evidence = result.evidence;
    return check;
  });

  const summary = { pass: 0, warn: 0, error: 0, skip: 0 };
  for (const check of checks) summary[check.status] += 1;
  const score = Math.max(0, 100 - 15 * summary.error - 4 * summary.warn);
  const status = summary.error > 0 ? 'non-conformant' : summary.warn > 0 ? 'warnings' : 'conformant';

  if (options.ledger) options.ledger.record(artifacts, ledgerMeta);

  return {
    schemaVersion: SCHEMA_VERSION,
    specProfile: SPEC_PROFILE,
    baseUrl: base,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    status,
    score,
    summary,
    artifacts,
    checks
  };
}
