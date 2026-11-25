import { appendFileSync, readFileSync } from 'node:fs';

const [reportPath, exitCodeArg] = process.argv.slice(2);
const exitCode = Number.isFinite(Number(exitCodeArg)) ? Number(exitCodeArg) : 0;

let report = null;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch {
  report = null;
}

const outputs = {
  status: report?.status ?? 'unknown',
  score: report ? String(report.score) : '',
  errors: report ? String(report.summary.error) : '',
  warnings: report ? String(report.summary.warn) : '',
  report: reportPath,
  'exit-code': String(exitCode)
};

if (process.env.GITHUB_OUTPUT) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
}

if (!report) {
  console.error(`No agentic web report was produced at ${reportPath}.`);
  process.exit(0);
}

function stripControl(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function escapeCommand(value) {
  return stripControl(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeCell(value) {
  return stripControl(value).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

const findings = report.checks.filter((check) => check.status === 'error' || check.status === 'warn');

console.log(`Agentic Web Doctor: ${stripControl(report.baseUrl)} is ${stripControl(report.status)} (${report.score}/100)`);
for (const check of findings) {
  const level = check.status === 'error' ? 'error' : 'warning';
  console.log(`::${level} title=${escapeCommand(check.id)}::${escapeCommand(check.message)}`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    `## Agentic Web Doctor: ${stripControl(report.status)}`,
    '',
    `**${stripControl(report.baseUrl)}** — score ${report.score}/100 · ${report.summary.pass} pass · ${report.summary.warn} warn · ${report.summary.error} error · ${report.summary.skip} skip`,
    ''
  ];
  if (findings.length) {
    lines.push('| Status | Check | Message |', '|---|---|---|');
    for (const check of findings.slice(0, 20)) {
      lines.push(`| ${check.status.toUpperCase()} | \`${check.id}\` | ${escapeCell(check.message)} |`);
    }
    if (findings.length > 20) lines.push(`| | | ${findings.length - 20} more finding(s) |`);
  } else {
    lines.push('No warnings or errors.');
  }
  lines.push('');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
}
