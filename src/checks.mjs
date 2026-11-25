import { CATALOG } from './catalog.mjs';

const SHORT_DESCRIPTION = 20;
const WARN_AGENT_COUNT = 50;
const MAX_AGENTS = 200;
const MAX_INSTRUCTION_CHARS = 20000;
const SECRET_PATTERNS = [
  { label: 'provider-style secret key', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { label: 'Google API key', re: /AIza[0-9A-Za-z_-]{10,}/ },
  { label: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { label: 'api_key assignment', re: /\bapi_key\b['"]?\s*[:=]\s*['"]?[A-Za-z0-9_-]{8,}/i }
];
const SCRIPT_PATTERNS = [
  { label: '<script> tag', re: /<script/i },
  { label: 'javascript: URL', re: /javascript:/i },
  { label: 'inline event handler', re: /\bon[a-z]{3,}\s*=/i }
];

function absoluteHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function corsValue(headers) {
  const value = headers?.['access-control-allow-origin'];
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed === '*') return trimmed;
  return absoluteHttpUrl(trimmed) ? trimmed : null;
}

function agentsOf(network) {
  return Array.isArray(network?.json?.tools) ? network.json.tools : [];
}

function isLoopbackHost(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}

function nameOf(network, index) {
  return network?.entry?.name || `network[${index}]`;
}

function mask(sample) {
  return `${sample.slice(0, 4)}…`;
}

export function runChecks(ctx) {
  const results = [];
  const add = (id, status, message, extra = {}) => results.push({ id, status, message, ...extra });

  const manifest = ctx.manifest;
  const manifestJson = manifest?.json ?? null;
  const manifestReady = Boolean(manifestJson && manifest.status === 200);
  const networks = Array.isArray(ctx.networks) ? ctx.networks : null;
  const networksReady = Boolean(networks && networks.length > 0);

  if (!manifest || manifest.error) {
    add('manifest.fetch', 'error', `Could not fetch /agent-manifest.json: ${manifest?.error || 'no response'}`, {
      evidence: `${ctx.baseUrl}/agent-manifest.json`
    });
  } else if (manifest.status !== 200) {
    add('manifest.fetch', 'error', `agent-manifest.json returned HTTP ${manifest.status}`, { evidence: manifest.url });
  } else if (!manifest.json) {
    add('manifest.fetch', 'error', 'agent-manifest.json is not valid JSON', { evidence: manifest.url });
  } else {
    const contentType = manifest.headers?.['content-type'] || '';
    if (!/json/i.test(contentType)) {
      add('manifest.fetch', 'error', `agent-manifest.json served as "${contentType || 'unknown content type'}"`, {
        evidence: manifest.url
      });
    } else {
      add('manifest.fetch', 'pass', `Fetched agent-manifest.json (${manifest.bytes} bytes)`);
    }
  }

  if (!manifestReady) {
    add('manifest.required', 'skip', 'Skipped because the manifest is unavailable');
  } else {
    const issues = [];
    const declared = manifestJson.networks;
    if (!Array.isArray(declared) || declared.length === 0) {
      issues.push('"networks" must be a non-empty array');
    } else {
      const seen = new Set();
      declared.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') {
          issues.push(`networks[${index}] must be an object`);
          return;
        }
        for (const field of ['name', 'front_man', 'hocon']) {
          if (typeof entry[field] !== 'string' || !entry[field].trim()) {
            issues.push(`networks[${index}].${field} must be a non-empty string`);
          }
        }
        if (typeof entry.name === 'string' && entry.name.trim()) {
          if (seen.has(entry.name)) issues.push(`duplicate network name "${entry.name}"`);
          seen.add(entry.name);
        }
      });
    }
    if (issues.length) add('manifest.required', 'error', 'Manifest structure is invalid', { details: issues });
    else add('manifest.required', 'pass', `Manifest declares ${manifestJson.networks.length} network(s)`);
  }

  if (!manifest || manifest.error) {
    add('manifest.cors', 'skip', 'Skipped because the manifest is unavailable');
  } else {
    const value = corsValue(manifest.headers);
    if (value) add('manifest.cors', 'pass', `Access-Control-Allow-Origin: ${value}`);
    else {
      add('manifest.cors', 'error', 'Manifest response has no usable Access-Control-Allow-Origin header', {
        evidence: manifest.url
      });
    }
  }

  const base = new URL(ctx.baseUrl);
  if (base.protocol === 'https:') {
    add('hosting.https', 'pass', 'Site is served over HTTPS');
  } else if (isLoopbackHost(base.hostname)) {
    add('hosting.https', 'pass', 'Loopback HTTP allowed for local development', { evidence: ctx.baseUrl });
  } else {
    add('hosting.https', 'error', 'Site is served over plain HTTP', { evidence: ctx.baseUrl });
  }

  const links = ctx.links || { state: 'missing' };
  if (links.state === 'missing') {
    add('links.fetch', 'skip', 'No links.json published');
  } else if (links.state === 'invalid') {
    add('links.fetch', 'error', 'links.json is not valid JSON', { evidence: links.url });
  } else if (links.state === 'error') {
    add('links.fetch', 'error', `Could not fetch /links.json: ${links.error || `HTTP ${links.status}`}`, {
      evidence: links.url
    });
  } else {
    add('links.fetch', 'pass', `Fetched links.json (${links.bytes} bytes)`);
  }

  if (links.state !== 'ok') {
    add('links.valid', 'skip', 'Skipped because links.json is unavailable');
  } else {
    const issues = [];
    const doc = links.json;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      issues.push('root must be an object');
    } else {
      if (doc.version !== 1) issues.push('"version" must be 1');
      const nets = doc.networks;
      if (!nets || typeof nets !== 'object' || Array.isArray(nets)) {
        issues.push('"networks" must be an object');
      } else {
        for (const [networkName, mapping] of Object.entries(nets)) {
          if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
            issues.push(`networks.${networkName} must be an object`);
            continue;
          }
          for (const [symbol, url] of Object.entries(mapping)) {
            if (!absoluteHttpUrl(url)) issues.push(`networks.${networkName}.${symbol} must be an absolute http(s) URL`);
          }
        }
      }
    }
    if (issues.length) {
      add('links.valid', 'error', 'links.json structure is invalid', { details: issues });
    } else if (manifestReady) {
      const declared = new Set(
        (Array.isArray(manifestJson.networks) ? manifestJson.networks : [])
          .map((entry) => entry?.name)
          .filter((name) => typeof name === 'string')
      );
      const unknown = Object.keys(doc.networks).filter((name) => !declared.has(name));
      if (unknown.length) {
        add('links.valid', 'warn', 'links.json references networks missing from the manifest', { details: unknown });
      } else {
        add('links.valid', 'pass', 'links.json is valid');
      }
    } else {
      add('links.valid', 'pass', 'links.json is valid');
    }
  }

  if (!networksReady) {
    add('network.fetch', 'skip', 'Skipped because no network artifacts were collected');
  } else {
    const issues = [];
    networks.forEach((network, index) => {
      const label = nameOf(network, index);
      if (network.error) issues.push(`${label}: ${network.error}`);
      else if (network.status !== 200) issues.push(`${label}: HTTP ${network.status}`);
      else if (!network.json) issues.push(`${label}: not valid JSON`);
    });
    if (issues.length) add('network.fetch', 'error', 'One or more network artifacts failed to load', { details: issues });
    else add('network.fetch', 'pass', `Fetched ${networks.length} network artifact(s)`);
  }

  if (!networksReady) {
    add('network.cors', 'skip', 'Skipped because no network artifacts were collected');
  } else {
    const issues = [];
    networks.forEach((network, index) => {
      const label = nameOf(network, index);
      if (!network.headers) issues.push(`${label}: response unavailable`);
      else if (!corsValue(network.headers)) issues.push(`${label}: missing Access-Control-Allow-Origin`);
    });
    if (issues.length) add('network.cors', 'error', 'One or more network artifacts are not CORS-readable', { details: issues });
    else add('network.cors', 'pass', 'Network artifacts are CORS-readable');
  }

  if (!networksReady) {
    add('network.tools', 'skip', 'Skipped because no network artifacts were collected');
  } else {
    const issues = [];
    networks.forEach((network, index) => {
      if (!network.json) {
        issues.push(`${nameOf(network, index)}: not valid JSON`);
        return;
      }
      if (!Array.isArray(network.json.tools) || network.json.tools.length === 0) {
        issues.push(`${nameOf(network, index)}: "tools" must be a non-empty array`);
      }
    });
    if (issues.length) add('network.tools', 'error', 'Network tools are missing', { details: issues });
    else add('network.tools', 'pass', 'Network tools are declared');
  }

  if (!networksReady) {
    add('network.duplicates', 'skip', 'Skipped because no network artifacts were collected');
  } else {
    const issues = [];
    networks.forEach((network, index) => {
      const agents = agentsOf(network);
      const seen = new Set();
      agents.forEach((agent, agentIndex) => {
        const name = agent?.name;
        if (typeof name !== 'string' || !name.trim()) {
          issues.push(`${nameOf(network, index)} agent[${agentIndex}]: missing name`);
          return;
        }
        if (seen.has(name)) issues.push(`${nameOf(network, index)}: duplicate agent name "${name}"`);
        seen.add(name);
      });
    });
    if (issues.length) add('network.duplicates', 'error', 'Agent names are missing or duplicated', { details: issues });
    else add('network.duplicates', 'pass', 'Agent names are unique');
  }

  if (!networksReady) {
    add('network.front_man', 'skip', 'Skipped because no network artifacts were collected');
  } else {
    const issues = [];
    networks.forEach((network, index) => {
      if (!network.json) return;
      const frontMan = network.entry?.front_man;
      const matches = agentsOf(network).filter((agent) => agent?.name === frontMan).length;
      if (matches !== 1) {
        issues.push(`${nameOf(network, index)}: front_man "${frontMan}" matches ${matches} agents`);
      }
    });
    if (issues.length) add('network.front_man', 'error', 'front_man does not resolve to exactly one agent', { details: issues });
    else add('network.front_man', 'pass', 'front_man resolves to exactly one agent');
  }

  if (!networksReady) {
    add('network.agent.fields', 'skip', 'Skipped because no network artifacts were collected');
  } else {
    const issues = [];
    const missingTools = [];
    networks.forEach((network, index) => {
      agentsOf(network).forEach((agent, agentIndex) => {
        const label = `${nameOf(network, index)} agent[${agentIndex}]`;
        if (!agent || typeof agent !== 'object') {
          issues.push(`${label}: must be an object`);
          return;
        }
        if (typeof agent.function?.description !== 'string' || !agent.function.description.trim()) {
          issues.push(`${label}: missing function.description`);
        }
        if (!Array.isArray(agent.tools)) missingTools.push(`${label}: missing tools array, defaulting to none`);
        if ('instructions' in agent && typeof agent.instructions !== 'string') {
          issues.push(`${label}: instructions must be a string`);
        }
        if (typeof agent.instructions === 'string' && agent.instructions.length > MAX_INSTRUCTION_CHARS) {
          issues.push(`${label}: instructions exceed ${MAX_INSTRUCTION_CHARS} characters`);
        }
        if (agent.function?.parameters) {
          const parameters = agent.function.parameters;
          if (typeof parameters !== 'object' || Array.isArray(parameters) || parameters.type !== 'object') {
            issues.push(`${label}: function.parameters must be an object with type "object"`);
          }
        }
      });
    });
    if (issues.length) {
      add('network.agent.fields', 'error', 'One or more agents have invalid fields', {
        details: missingTools.length ? [...issues, ...missingTools] : issues
      });
    } else if (missingTools.length) {
      add('network.agent.fields', 'warn', 'Some agents omit the tools array', { details: missingTools });
    } else {
      add('network.agent.fields', 'pass', 'Agent fields are well formed');
    }
  }

  if (!networksReady) {
    add('network.descriptions', 'skip', 'Skipped because no network artifacts were collected');
  } else {
    const shorts = [];
    networks.forEach((network, index) => {
      agentsOf(network).forEach((agent) => {
        const description = agent?.function?.description;
        if (typeof description === 'string' && description.trim() && description.trim().length < SHORT_DESCRIPTION) {
          shorts.push(`${nameOf(network, index)} agent "${agent.name}": ${description.trim().length} characters`);
        }
      });
    });
    if (shorts.length) {
      add('network.descriptions', 'warn', `${shorts.length} agent description(s) are shorter than ${SHORT_DESCRIPTION} characters`, {
        details: shorts
      });
    } else {
      add('network.descriptions', 'pass', `All agent descriptions are at least ${SHORT_DESCRIPTION} characters`);
    }
  }

  if (!networksReady) {
    add('network.refs', 'skip', 'Skipped because no network artifacts were collected');
  } else {
    const issues = [];
    networks.forEach((network, index) => {
      const label = nameOf(network, index);
      const agents = agentsOf(network);
      const names = new Set(agents.map((agent) => agent?.name).filter((name) => typeof name === 'string'));
      agents.forEach((agent) => {
        if (!Array.isArray(agent?.tools)) return;
        for (const ref of agent.tools) {
          if (typeof ref === 'string') {
            if (!names.has(ref) && !absoluteHttpUrl(ref)) {
              issues.push(`${label}: "${ref}" is neither a local agent nor an absolute http(s) URL`);
            }
          } else if (ref && typeof ref === 'object') {
            if (typeof ref.url !== 'string' || !ref.url.trim()) issues.push(`${label}: descriptor entry is missing a string url`);
            if ('tools' in ref && (!Array.isArray(ref.tools) || !ref.tools.every((tool) => typeof tool === 'string'))) {
              issues.push(`${label}: descriptor tools must be an array of strings`);
            }
          } else {
            issues.push(`${label}: tool reference must be a string or descriptor object`);
          }
        }
      });
    });
    if (issues.length) add('network.refs', 'error', `${issues.length} unresolved tool reference(s)`, { details: issues });
    else add('network.refs', 'pass', 'All tool references resolve');
  }

  if (!networksReady) {
    add('network.budget', 'skip', 'Skipped because no network artifacts were collected');
  } else {
    const missing = [];
    networks.forEach((network, index) => {
      const budget = network.json?.max_execution_seconds;
      if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
        missing.push(`${nameOf(network, index)}: missing max_execution_seconds`);
      }
    });
    if (missing.length) add('network.budget', 'warn', 'Network has no execution time bound', { details: missing });
    else add('network.budget', 'pass', 'Network declares max_execution_seconds');
  }

  if (!networksReady) {
    add('network.agent_count', 'skip', 'Skipped because no network artifacts were collected');
  } else {
    const oversized = [];
    const crowded = [];
    networks.forEach((network, index) => {
      const count = agentsOf(network).length;
      if (count > MAX_AGENTS) oversized.push(`${nameOf(network, index)}: ${count} agents (limit ${MAX_AGENTS})`);
      else if (count > WARN_AGENT_COUNT) crowded.push(`${nameOf(network, index)}: ${count} agents`);
    });
    if (oversized.length) add('network.agent_count', 'error', `Network exceeds ${MAX_AGENTS} agents`, { details: oversized });
    else if (crowded.length) add('network.agent_count', 'warn', `Network exceeds ${WARN_AGENT_COUNT} agents`, { details: crowded });
    else add('network.agent_count', 'pass', `Networks stay at or below ${WARN_AGENT_COUNT} agents`);
  }

  if (!manifestReady) {
    add('peers.allowed', 'skip', 'Skipped because the manifest is unavailable');
  } else {
    const origins = new Set();
    for (const network of networks || []) {
      for (const agent of agentsOf(network)) {
        if (!Array.isArray(agent?.tools)) continue;
        for (const ref of agent.tools) {
          const value = typeof ref === 'string' ? ref : ref?.url;
          const url = absoluteHttpUrl(value);
          if (url) origins.add(url.origin);
        }
      }
    }
    const linkNetworks = links.state === 'ok' ? links.json?.networks : null;
    if (linkNetworks && typeof linkNetworks === 'object') {
      for (const mapping of Object.values(linkNetworks)) {
        if (!mapping || typeof mapping !== 'object') continue;
        for (const value of Object.values(mapping)) {
          const url = absoluteHttpUrl(value);
          if (url) origins.add(url.origin);
        }
      }
    }
    if (origins.size === 0) {
      add('peers.allowed', 'pass', 'No external peer origins referenced');
    } else {
      const open = manifestJson.peer_policy?.mode === 'open';
      const allowed = new Set();
      if (Array.isArray(manifestJson.allowed_peers)) {
        for (const entry of manifestJson.allowed_peers) {
          const url = absoluteHttpUrl(entry);
          if (url) allowed.add(url.origin);
        }
      }
      const denied = [...origins].filter((origin) => !open && !allowed.has(origin));
      if (denied.length) {
        add('peers.allowed', 'error', `${denied.length} peer origin(s) are not allowed`, {
          details: denied.map((origin) => `${origin} is not listed in allowed_peers`),
          evidence: denied[0]
        });
      } else {
        add('peers.allowed', 'pass', `${origins.size} peer origin(s) allowed`);
      }
    }
  }

  if (!manifestReady) {
    add('actions.module', 'skip', 'Skipped because the manifest is unavailable');
  } else if (!manifestJson.actions) {
    add('actions.module', 'skip', 'No site actions declared');
  } else {
    const actions = manifestJson.actions;
    const issues = [];
    if (typeof actions.module !== 'string' || !actions.module.trim()) {
      issues.push('actions.module must be a non-empty string');
    }
    if (!Array.isArray(actions.agentTools) || actions.agentTools.length === 0) {
      issues.push('actions.agentTools must be a non-empty array of strings');
    } else if (!actions.agentTools.every((tool) => typeof tool === 'string' && tool.trim())) {
      issues.push('actions.agentTools must contain only strings');
    }
    if (typeof actions.module === 'string' && actions.module.trim() && !ctx.actions?.moduleOk) {
      issues.push(`actions.module could not be loaded${ctx.actions?.moduleError ? `: ${ctx.actions.moduleError}` : ''}`);
    }
    if (issues.length) add('actions.module', 'error', 'Actions module is misconfigured', { details: issues });
    else add('actions.module', 'pass', 'Actions module is loadable');
  }

  if (!manifestReady) {
    add('inference.configured', 'skip', 'Skipped because the manifest is unavailable');
  } else {
    const router = manifestJson.llm_router || {};
    const baseUrl = typeof router.base_url === 'string' ? router.base_url.trim() : '';
    const byok = typeof router.byok_router === 'string' ? router.byok_router.trim() : '';
    if (baseUrl || byok) add('inference.configured', 'pass', `Inference router: ${baseUrl || byok}`, { evidence: baseUrl || byok });
    else add('inference.configured', 'warn', 'Manifest declares no inference router');
  }

  if (!manifestReady) {
    add('inference.router_https', 'skip', 'Skipped because the manifest is unavailable');
  } else {
    const router = manifestJson.llm_router || {};
    const raw = [router.base_url, router.byok_router].find((value) => typeof value === 'string' && value.trim());
    if (!raw) {
      add('inference.router_https', 'skip', 'Skipped because no router is configured');
    } else {
      let url = null;
      try {
        url = new URL(raw.trim());
      } catch {
        url = null;
      }
      if (url?.protocol === 'https:') add('inference.router_https', 'pass', 'Inference router uses HTTPS');
      else if (url && isLoopbackHost(url.hostname)) {
        add('inference.router_https', 'pass', 'Loopback HTTP router allowed for local development');
      } else {
        add('inference.router_https', 'warn', 'Inference router does not use HTTPS', { evidence: raw.trim() });
      }
    }
  }

  const texts = [manifest?.text, ...(networks || []).map((network) => network.text), links.text].filter(
    (text) => typeof text === 'string' && text
  );
  if (texts.length === 0) {
    add('security.secrets', 'skip', 'Skipped because no artifacts were fetched');
  } else {
    const findings = [];
    for (const text of texts) {
      for (const pattern of SECRET_PATTERNS) {
        const match = text.match(pattern.re);
        if (match) findings.push({ label: pattern.label, sample: match[0] });
      }
    }
    if (findings.length) {
      add('security.secrets', 'error', `${findings.length} credential-like string(s) found in published artifacts`, {
        details: findings.map((finding) => `${finding.label}: ${mask(finding.sample)}`),
        evidence: mask(findings[0].sample)
      });
    } else {
      add('security.secrets', 'pass', 'No credential-like strings found in published artifacts');
    }
  }

  if (!networksReady) {
    add('security.script_vectors', 'skip', 'Skipped because no network artifacts were collected');
  } else {
    const findings = [];
    networks.forEach((network, index) => {
      agentsOf(network).forEach((agent) => {
        if (typeof agent?.instructions !== 'string') return;
        for (const pattern of SCRIPT_PATTERNS) {
          if (pattern.re.test(agent.instructions)) {
            findings.push(`${nameOf(network, index)} agent "${agent.name}": ${pattern.label}`);
          }
        }
      });
    });
    if (findings.length) {
      add('security.script_vectors', 'warn', `${findings.length} script vector(s) found in instructions`, { details: findings });
    } else {
      add('security.script_vectors', 'pass', 'Instructions contain no script vectors');
    }
  }

  if (!ctx.ledger) {
    add('integrity.changed', 'skip', 'No ledger data available');
  } else {
    const compared = ctx.ledger;
    const details = compared.changed.map(
      (change) => `${change.url}: sha256 ${change.previousSha256.slice(0, 8)}… -> ${change.sha256.slice(0, 8)}…`
    );
    if (compared.networks.added.length) details.push(`networks added: ${compared.networks.added.join(', ')}`);
    if (compared.networks.removed.length) details.push(`networks removed: ${compared.networks.removed.join(', ')}`);
    if (compared.frontMans.changed) {
      details.push(
        `front_man changed: ${compared.frontMans.previous.join(', ') || 'none'} -> ${compared.frontMans.current.join(', ') || 'none'}`
      );
    }
    if (compared.frontMans.changed && compared.changed.length) {
      add('integrity.changed', 'error', 'front_man changed since last audit', { details });
    } else if (compared.changed.length) {
      add('integrity.changed', 'warn', `${compared.changed.length} artifact(s) changed since last audit`, {
        details,
        evidence: compared.changed[0].url
      });
    } else if (compared.unchanged.length) {
      add('integrity.changed', 'pass', 'Artifacts unchanged since last audit');
    } else {
      add('integrity.changed', 'pass', 'No previous ledger entries; baseline recorded');
    }
  }

  const order = new Map(CATALOG.map((entry, index) => [entry.id, index]));
  results.sort((a, b) => order.get(a.id) - order.get(b.id));
  return results;
}
