#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { auditSite } from '../src/audit.mjs';
import { renderBadge } from '../src/badge.mjs';
import { createFileLedger } from '../src/ledger.mjs';
import { VERSION, SPEC_PROFILE } from '../src/version.mjs';

const HELP = `Agentic Web Doctor ${VERSION} (spec ${SPEC_PROFILE})

Audit an Open Agentic Web site before your agent loads it.

Usage:
  agentic-web-doctor <url> [options]

Options:
  --json               Print only the JSON report
  --report <path>      Write the JSON report to <path>
  --badge <path>       Write the SVG badge to <path>
  --fail-on <level>    Exit 1 on "warn" or "error" (default: error)
  --allow-private      Allow loopback and private addresses (local development)
  --timeout <ms>       Per-request timeout in milliseconds (default: 8000)
  --ledger <path>      Compare and update an artifact hash ledger
                       (e.g. ~/.agentic-web-doctor/ledger.json)
  --pin <sha256>       Compare the manifest hash against a known value
  -h, --help           Show this help
  --version            Print the version

Exit codes:
  0  conformant, or warnings when failing on errors only
  1  errors, or warnings with --fail-on warn
  2  usage error, or no artifact could be fetched (blocked URL or transport failure)`;

function usage(message) {
  console.error(`Error: ${message}\n`);
  console.error(HELP);
  process.exit(2);
}

const args = process.argv.slice(2);
let url = null;
let json = false;
let reportPath = null;
let badgePath = null;
let failOn = 'error';
let allowPrivate = false;
let timeoutMs = 8000;
let ledgerPath = null;
let pin = null;
let help = false;
let version = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  const value = () => {
    i += 1;
    if (i >= args.length) usage(`Missing value for ${arg}`);
    return args[i];
  };
  if (arg === '-h' || arg === '--help') help = true;
  else if (arg === '--version') version = true;
  else if (arg === '--json') json = true;
  else if (arg === '--report') reportPath = value();
  else if (arg === '--allow-private') allowPrivate = true;
  else if (arg === '--badge') badgePath = value();
  else if (arg === '--fail-on') {
    const level = value();
    if (level !== 'warn' && level !== 'error') usage('--fail-on must be "warn" or "error"');
    failOn = level;
  } else if (arg === '--timeout') {
    const parsed = Number(value());
    if (!Number.isFinite(parsed) || parsed <= 0) usage('--timeout must be a positive number of milliseconds');
    timeoutMs = parsed;
  } else if (arg === '--ledger') ledgerPath = value();
  else if (arg === '--pin') pin = value();
  else if (arg.startsWith('-')) usage(`Unknown option: ${arg}`);
  else if (!url) url = arg;
  else usage(`Unexpected argument: ${arg}`);
}

function clean(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function printReport(report) {
  console.log(`Agentic Web Doctor ${VERSION} (spec ${report.specProfile})`);
  console.log(`Base URL: ${clean(report.baseUrl)}`);
  console.log(`Status: ${report.status.toUpperCase()}  Score: ${report.score}/100  Duration: ${report.durationMs}ms`);
  console.log(
    `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.error} error, ${report.summary.skip} skip`
  );
  console.log('');
  for (const check of report.checks) {
    console.log(`${check.status.toUpperCase().padEnd(5)} ${check.id.padEnd(26)} ${clean(check.message)}`);
    if (check.evidence) console.log(`      evidence: ${clean(check.evidence)}`);
    if (check.hint) console.log(`      hint: ${clean(check.hint)}`);
    for (const detail of check.details || []) console.log(`      - ${clean(detail)}`);
  }
}

async function main() {
  if (help) {
    console.log(HELP);
    return;
  }
  if (version) {
    console.log(VERSION);
    return;
  }
  if (!url) usage('A site URL is required');

  try {
    const report = await auditSite(url, {
      allowPrivate,
      timeoutMs,
      ledger: ledgerPath ? createFileLedger(ledgerPath) : undefined
    });
    if (json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    if (badgePath) writeFileSync(badgePath, renderBadge(report, { pin }));
    if (pin) {
      const manifest = report.artifacts.find((artifact) => artifact.kind === 'manifest');
      if (!manifest || manifest.sha256 !== pin) {
        console.error(`Manifest changed: expected ${clean(pin)}, got ${manifest?.sha256 ?? 'none'}`);
        process.exitCode = 1;
        return;
      }
    }
    if (report.status === 'non-conformant') process.exitCode = report.artifacts.length === 0 ? 2 : 1;
    else if (report.status === 'warnings' && failOn === 'warn') process.exitCode = 1;
  } catch (error) {
    console.error(`Error: ${clean(error.message)}`);
    process.exitCode = 2;
  }
}

await main();
