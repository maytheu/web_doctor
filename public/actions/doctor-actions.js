const AUDIT_URL = '/api/audit';
const CATALOG_URL = '/api/catalog';
const DEFAULT_BADGE_LABEL = 'agentic web';

let lastReport = null;
let catalogRequest = null;

async function readJson(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `Request failed with HTTP ${response.status}`);
  if (!body) throw new Error('Response was not valid JSON');
  return body;
}

function summarize(report) {
  return {
    url: report.baseUrl,
    generatedAt: report.generatedAt,
    status: report.status,
    score: report.score,
    summary: report.summary,
    artifactCount: Array.isArray(report.artifacts) ? report.artifacts.length : null,
    findings: report.checks
      .filter((check) => check.status !== 'pass')
      .slice(0, 8)
      .map(({ id, category, status, message, hint }) => ({ id, category, status, message, hint }))
  };
}

function loadCatalog() {
  if (!catalogRequest) {
    catalogRequest = fetch(CATALOG_URL, { headers: { accept: 'application/json' } })
      .then(readJson)
      .catch((error) => {
        catalogRequest = null;
        throw error;
      });
  }
  return catalogRequest;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[char];
  });
}

export const actions = {
  run_audit: {
    effect: 'read',
    description: 'Audit an Open Agentic Web site and return its conformance summary.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', format: 'uri' } },
      required: ['url']
    },
    async handler({ url }) {
      const response = await fetch(`${AUDIT_URL}?url=${encodeURIComponent(url)}`, {
        headers: { accept: 'application/json' }
      });
      lastReport = summarize(await readJson(response));
      return lastReport;
    }
  },

  get_last_report: {
    effect: 'read',
    description: 'Return the summary of the most recent audit in this session.',
    parameters: { type: 'object', properties: {} },
    async handler() {
      if (!lastReport) return { available: false, message: 'No audit has run in this session yet.' };
      return { available: true, ...lastReport };
    }
  },

  explain_check: {
    effect: 'read',
    description: 'Explain one conformance check and how to fix it.',
    parameters: {
      type: 'object',
      properties: { check_id: { type: 'string', description: 'Check identifier, for example manifest.cors' } },
      required: ['check_id']
    },
    async handler({ check_id }) {
      const catalog = await loadCatalog();
      const entry = catalog.find((check) => check.id === check_id);
      if (!entry) return { found: false, check_id, message: `Unknown check "${check_id}".` };
      return {
        found: true,
        id: entry.id,
        category: entry.category,
        severity: entry.severity,
        title: entry.title,
        hint: entry.hint,
        specRef: entry.specRef
      };
    }
  },

  propose_badge: {
    effect: 'read',
    description: 'Produce Markdown and HTML snippets for an agentic web badge.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        label: { type: 'string' }
      },
      required: ['url']
    },
    async handler({ url, label = DEFAULT_BADGE_LABEL }) {
      const origin = globalThis.location?.origin ?? '';
      const target = new URL(url).href;
      const badgeQuery = new URLSearchParams({ url: target });
      if (label !== DEFAULT_BADGE_LABEL) badgeQuery.set('label', label);
      const pageQuery = new URLSearchParams({ url: target });
      const badgeUrl = `${origin}/api/badge?${badgeQuery}`;
      const pageUrl = `${origin}/?${pageQuery}`;
      return {
        badgeUrl,
        pageUrl,
        markdown: `[![${label}](${badgeUrl})](${pageUrl})`,
        html: `<a href="${escapeHtml(pageUrl)}"><img src="${escapeHtml(badgeUrl)}" alt="${escapeHtml(label)}"></a>`
      };
    }
  }
};
