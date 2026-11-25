const LABEL_COLOR = '#3c3f44';
const COLORS = {
  conformant: '#1f7a3d',
  warnings: '#b7791f',
  'non-conformant': '#b42318',
  changed: '#6b21a8',
  unavailable: '#6b7280'
};

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeLabel(label) {
  const cleaned = String(label).replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 20).trim();
  return cleaned || 'agentic web';
}

function badgeSvg(label, message, color) {
  const safeLabel = sanitizeLabel(label);
  const labelWidth = Math.round(safeLabel.length * 7 + 12);
  const messageWidth = Math.round(message.length * 7 + 12);
  const width = labelWidth + messageWidth;
  const title = `${escapeXml(safeLabel)}: ${escapeXml(message)}`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="20" role="img" aria-label="' + title + '">',
    '  <title>' + title + '</title>',
    '  <rect width="' + width + '" height="20" rx="3" fill="' + LABEL_COLOR + '"/>',
    '  <rect x="' + labelWidth + '" width="' + messageWidth + '" height="20" rx="3" fill="' + color + '"/>',
    '  <rect x="' + (labelWidth - 3) + '" width="6" height="20" fill="' + color + '"/>',
    '  <text x="' + labelWidth / 2 + '" y="14" fill="#ffffff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">' + escapeXml(safeLabel) + '</text>',
    '  <text x="' + (labelWidth + messageWidth / 2) + '" y="14" fill="#ffffff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">' + escapeXml(message) + '</text>',
    '</svg>'
  ].join('\n');
}

export function renderBadge(report, { label = 'agentic web', pin = null } = {}) {
  const status = report?.status ?? 'non-conformant';
  const summary = report?.summary ?? { warn: 0, error: 0 };

  if (pin) {
    const manifest = report?.artifacts?.find((artifact) => artifact.kind === 'manifest');
    if (!manifest || manifest.sha256 !== pin) return badgeSvg(label, 'changed', COLORS.changed);
  }

  if (status === 'conformant') return badgeSvg(label, 'conformant', COLORS.conformant);
  if (status === 'warnings') return badgeSvg(label, `${summary.warn} warnings`, COLORS.warnings);
  return badgeSvg(label, `${summary.error} errors`, COLORS['non-conformant']);
}

export function renderUnavailableBadge(label = 'agentic web') {
  return badgeSvg(label, 'unavailable', COLORS.unavailable);
}
