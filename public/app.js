import { openBrowserLedger } from './ledger.js';

const form = document.getElementById('audit-form');
const input = document.getElementById('url-input');
const runButton = document.getElementById('run-button');
const statusRegion = document.getElementById('status-region');
const errorRegion = document.getElementById('error-region');
const errorMessage = document.getElementById('error-message');
const results = document.getElementById('results');
const statusBanner = document.getElementById('status-banner');
const statusText = document.getElementById('status-text');
const scoreText = document.getElementById('score-text');
const countsText = document.getElementById('counts-text');
const durationText = document.getElementById('duration-text');
const ledgerText = document.getElementById('ledger-text');
const ledgerReset = document.getElementById('ledger-reset');
const checkGroups = document.getElementById('check-groups');
const filters = document.getElementById('filters');
const badgeSection = document.getElementById('badge-section');
const badgePreview = document.getElementById('badge-preview');
const badgeMarkdown = document.getElementById('badge-markdown');
const badgeHtml = document.getElementById('badge-html');
const themeToggle = document.getElementById('theme-toggle');
const confirmRegion = document.getElementById('confirm-region');
const confirmText = document.getElementById('confirm-text');
const confirmRun = document.getElementById('confirm-run');
const confirmCancel = document.getElementById('confirm-cancel');
const recentSection = document.getElementById('recent-section');
const recentList = document.getElementById('recent-list');

const CATEGORY_ORDER = ['publication', 'network', 'execution', 'composition', 'inference', 'security'];
const FILTER_LABELS = { all: 'All', error: 'Errors', warn: 'Warnings', pass: 'Passes' };
const STATUS_LABELS = { pass: 'PASS', warn: 'WARN', error: 'ERROR', skip: 'SKIP' };
const RECENT_KEY = 'awd.recent';
const RECENT_LIMIT = 10;

let report = null;
let activeFilter = 'all';
let pendingUrl = null;

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
  themeToggle.setAttribute('aria-pressed', String(theme === 'light'));
  try {
    localStorage.setItem('awd.theme', theme);
  } catch {
    /* storage is optional */
  }
}

try {
  const saved = localStorage.getItem('awd.theme');
  if (saved === 'light' || saved === 'dark') setTheme(saved);
} catch {
  /* storage is optional */
}

themeToggle.addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

const initialUrl = new URLSearchParams(location.search).get('url');
if (initialUrl) input.value = initialUrl;

function setBusy(busy) {
  runButton.disabled = busy;
  runButton.textContent = busy ? 'Auditing…' : 'Run audit';
  statusRegion.setAttribute('aria-busy', String(busy));
}

function showError(message) {
  errorMessage.textContent = message;
  errorRegion.hidden = false;
}

function hideError() {
  errorRegion.hidden = true;
  errorMessage.textContent = '';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

function renderCheckRow(check) {
  const row = document.createElement('article');
  row.className = `check-row check-${check.status}`;

  const top = document.createElement('div');
  top.className = 'check-top';
  const chip = document.createElement('span');
  chip.className = `chip chip-${check.status}`;
  chip.textContent = STATUS_LABELS[check.status] || check.status.toUpperCase();
  const title = document.createElement('h3');
  title.textContent = check.title;
  const id = document.createElement('code');
  id.className = 'check-id';
  id.textContent = check.id;
  top.append(chip, title, id);
  row.append(top);

  const message = document.createElement('p');
  message.className = 'check-message';
  message.textContent = check.message;
  row.append(message);

  if (check.hint) {
    const hint = document.createElement('p');
    hint.className = 'check-hint';
    hint.textContent = `Hint: ${check.hint}`;
    row.append(hint);
  }

  if (check.evidence) {
    const evidence = document.createElement('p');
    evidence.className = 'check-evidence';
    evidence.textContent = check.evidence.length > 200 ? `${check.evidence.slice(0, 200)}…` : check.evidence;
    evidence.title = check.evidence;
    row.append(evidence);
  }

  if (check.specRef) {
    const spec = document.createElement('p');
    spec.className = 'check-spec';
    spec.textContent = `Spec: ${check.specRef}`;
    row.append(spec);
  }

  if (Array.isArray(check.details) && check.details.length) {
    const list = document.createElement('ul');
    list.className = 'check-details';
    for (const detail of check.details) {
      const item = document.createElement('li');
      item.textContent = detail;
      list.append(item);
    }
    row.append(list);
  }

  return row;
}

function renderChecks() {
  checkGroups.replaceChildren();
  if (!report) return;
  const groups = new Map();
  for (const check of report.checks) {
    if (activeFilter !== 'all' && check.status !== activeFilter) continue;
    if (!groups.has(check.category)) groups.set(check.category, []);
    groups.get(check.category).push(check);
  }
  for (const category of CATEGORY_ORDER) {
    const checks = groups.get(category);
    if (!checks || checks.length === 0) continue;
    const section = document.createElement('section');
    section.className = 'card category';
    const heading = document.createElement('h2');
    heading.textContent = `${category} (${checks.length})`;
    section.append(heading);
    for (const check of checks) section.append(renderCheckRow(check));
    checkGroups.append(section);
  }
  if (groups.size === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No checks match this filter.';
    checkGroups.append(empty);
  }
}

function updateFilterCounts() {
  const counts = { all: report.checks.length, error: report.summary.error, warn: report.summary.warn, pass: report.summary.pass };
  for (const button of filters.querySelectorAll('button[data-filter]')) {
    const key = button.dataset.filter;
    button.textContent = `${FILTER_LABELS[key]} (${counts[key] ?? 0})`;
  }
}

function renderBadge(url) {
  badgeSection.hidden = false;
  const encoded = encodeURIComponent(url);
  const image = `${location.origin}/api/badge?url=${encoded}`;
  const page = `${location.origin}/?url=${encoded}`;
  badgePreview.src = image;
  badgeMarkdown.textContent = `[![agentic web](${image})](${page})`;
  badgeHtml.textContent = `<a href="${page}"><img src="${image}" alt="agentic web conformance badge"></a>`;
}

function renderLedger(comparison) {
  if (!comparison) {
    ledgerText.hidden = true;
    ledgerText.textContent = '';
    ledgerText.title = '';
    ledgerText.dataset.state = '';
    ledgerReset.hidden = true;
    return;
  }
  let message;
  if (comparison.firstVisit) message = `Baseline saved for this origin (${comparison.total} artifacts).`;
  else if (comparison.changed.length) message = `${comparison.changed.length} changed since your last visit.`;
  else if (comparison.added.length || comparison.removed.length) {
    const parts = [];
    if (comparison.added.length) parts.push(`${comparison.added.length} added`);
    if (comparison.removed.length) parts.push(`${comparison.removed.length} removed`);
    message = `${parts.join(' · ')} since your last visit.`;
  } else message = `All ${comparison.total} artifacts unchanged since your last visit.`;
  ledgerText.textContent = `History: ${message}`;
  ledgerText.title = comparison.changed.map((item) => item.url).join('\n');
  ledgerText.dataset.state = comparison.changed.length ? 'changed' : 'stable';
  ledgerText.hidden = false;
  ledgerReset.hidden = false;
}

let ledgerPromise;
function loadLedger() {
  if (!ledgerPromise) ledgerPromise = openBrowserLedger().catch(() => null);
  return ledgerPromise;
}

function readRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry) =>
        entry &&
        typeof entry.url === 'string' &&
        typeof entry.status === 'string' &&
        typeof entry.score === 'number'
    );
  } catch {
    return [];
  }
}

function renderRecent(entries = readRecent()) {
  recentList.replaceChildren();
  recentSection.hidden = entries.length === 0;
  for (const entry of entries) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = `${entry.url} — ${entry.status.toUpperCase()} · ${entry.score}/100`;
    if (typeof entry.at === 'string') button.title = `Audited ${entry.at}`;
    button.addEventListener('click', () => {
      input.value = entry.url;
      hideError();
      showConfirm(entry.url);
    });
    item.append(button);
    recentList.append(item);
  }
}

function rememberRecent(currentReport) {
  const entry = {
    url: currentReport.baseUrl,
    status: currentReport.status,
    score: currentReport.score,
    at: new Date().toISOString()
  };
  const entries = [entry, ...readRecent().filter((item) => item.url !== entry.url)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(entries));
  } catch {
    /* storage is optional */
  }
  renderRecent(entries);
}

async function updateLedger(currentReport) {
  try {
    const ledger = await loadLedger();
    if (ledger) renderLedger(await ledger.remember(currentReport));
  } catch {
    renderLedger(null);
  }
}

ledgerReset.addEventListener('click', async () => {
  if (!report) return;
  try {
    const ledger = await loadLedger();
    if (ledger) await ledger.forget(report.baseUrl);
  } catch {
    /* reset is best effort */
  }
  renderLedger(null);
});

function renderReport() {
  results.hidden = false;
  statusBanner.className = `card status-banner status-${report.status}`;
  statusText.textContent = report.status.toUpperCase();
  scoreText.textContent = `${report.score}/100`;
  countsText.textContent = `${report.summary.pass} pass · ${report.summary.warn} warn · ${report.summary.error} error · ${report.summary.skip} skip`;
  durationText.textContent = `${report.durationMs} ms`;
  renderLedger(null);
  renderChecks();
  updateFilterCounts();
  renderBadge(report.baseUrl);
  statusBanner.setAttribute('tabindex', '-1');
  statusBanner.focus({ preventScroll: true });
}

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function defaultScheme(raw) {
  try {
    return isLoopbackHost(new URL(`http://${raw}`).hostname) ? 'http' : 'https';
  } catch {
    return 'https';
  }
}

function withDefaultScheme(raw) {
  const scheme = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):([\s\S]*)$/);
  if (!scheme) return `${defaultScheme(raw)}://${raw}`;
  const [, name, rest] = scheme;
  if (/^https?$/i.test(name)) return raw;
  const hostLike =
    /^\d+(?:[/?#]|$)/.test(rest) || name.includes('.') || name.toLowerCase() === 'localhost' || rest.includes('@');
  if (hostLike) return `${defaultScheme(raw)}://${raw}`;
  return null;
}

function validateInput(raw) {
  const text = raw.trim();
  if (!text) return { error: 'Enter an http or https URL.' };
  const candidate = withDefaultScheme(text);
  if (candidate === null) return { error: 'Only http and https URLs can be audited' };
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { error: 'Enter an absolute http or https URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Only http and https URLs can be audited' };
  }
  if (url.username || url.password) return { error: 'URLs with credentials are not supported' };
  return { url: url.href };
}

function showConfirm(url) {
  pendingUrl = url;
  confirmText.textContent = `This will contact ${new URL(url).host} from this server.`;
  confirmRegion.hidden = false;
  confirmRun.focus({ preventScroll: true });
}

function hideConfirm() {
  pendingUrl = null;
  confirmRegion.hidden = true;
}

async function startAudit(url) {
  hideConfirm();
  hideError();
  setBusy(true);
  try {
    const response = await fetch(`/api/audit?url=${encodeURIComponent(url)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    report = payload;
    input.value = payload.baseUrl;
    renderReport();
    rememberRecent(payload);
    await updateLedger(payload);
  } catch (error) {
    showError(error.message || 'The audit could not be completed.');
  } finally {
    setBusy(false);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = input.value.trim();
  if (!raw) return;
  hideError();
  const checked = validateInput(raw);
  if (checked.error) {
    hideConfirm();
    showError(checked.error);
    return;
  }
  showConfirm(checked.url);
});

confirmRun.addEventListener('click', () => {
  if (pendingUrl) startAudit(pendingUrl);
});

confirmCancel.addEventListener('click', () => {
  hideConfirm();
  input.focus();
});

filters.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (!button) return;
  activeFilter = button.dataset.filter;
  for (const candidate of filters.querySelectorAll('button')) {
    candidate.setAttribute('aria-pressed', String(candidate === button));
  }
  renderChecks();
});

document.getElementById('copy-json').addEventListener('click', () => {
  if (report) copyText(JSON.stringify(report, null, 2));
});

document.getElementById('download-json').addEventListener('click', () => {
  if (!report) return;
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `audit-${new URL(report.baseUrl).hostname}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

for (const button of document.querySelectorAll('[data-copy-target]')) {
  button.addEventListener('click', () => {
    const target = document.getElementById(button.dataset.copyTarget);
    if (target) copyText(target.textContent);
  });
}

renderRecent();
