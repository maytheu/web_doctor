import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const LEDGER_VERSION = 1;

function emptyLedger() {
  return { version: LEDGER_VERSION, entries: {} };
}

function normalizeList(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((value) => typeof value === 'string' && value.trim()))].sort();
}

export function createFileLedger(filePath) {
  const resolved = path.resolve(filePath);

  function load() {
    let raw;
    try {
      raw = readFileSync(resolved, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyLedger();
      throw new Error(`Ledger file is unreadable: ${resolved}`);
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object' || !parsed.entries) {
        return emptyLedger();
      }
      return { version: LEDGER_VERSION, entries: parsed.entries };
    } catch {
      throw new Error(`Ledger file is not valid JSON: ${resolved}`);
    }
  }

  function save(ledger) {
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, JSON.stringify(ledger, null, 2) + '\n');
  }

  function compare(artifacts, meta = {}) {
    const ledger = load();
    const result = {
      new: [],
      unchanged: [],
      changed: [],
      frontMans: { previous: [], current: normalizeList(meta.frontMans), changed: false },
      networks: { added: [], removed: [] }
    };
    let baseline = null;
    for (const artifact of artifacts || []) {
      if (!artifact || typeof artifact.url !== 'string' || typeof artifact.sha256 !== 'string') continue;
      const entry = ledger.entries[artifact.url];
      if (!entry) {
        result.new.push(artifact.url);
        continue;
      }
      baseline = baseline || entry;
      if (entry.sha256 === artifact.sha256) {
        result.unchanged.push(artifact.url);
      } else {
        result.changed.push({
          url: artifact.url,
          previousSha256: entry.sha256,
          sha256: artifact.sha256,
          previousBytes: entry.bytes,
          bytes: artifact.bytes
        });
      }
    }
    if (baseline) {
      result.frontMans.previous = normalizeList(baseline.frontMans);
      result.frontMans.changed = result.frontMans.previous.join('|') !== result.frontMans.current.join('|');
      const previousNetworks = normalizeList(baseline.networkNames);
      const currentNetworks = normalizeList(meta.networkNames);
      result.networks.added = currentNetworks.filter((name) => !previousNetworks.includes(name));
      result.networks.removed = previousNetworks.filter((name) => !currentNetworks.includes(name));
    }
    return result;
  }

  function record(artifacts, meta = {}) {
    const ledger = load();
    const stamp = new Date().toISOString();
    const networkNames = normalizeList(meta.networkNames);
    const frontMans = normalizeList(meta.frontMans);
    let touched = 0;
    for (const artifact of artifacts || []) {
      if (!artifact || typeof artifact.url !== 'string' || typeof artifact.sha256 !== 'string') continue;
      const existing = ledger.entries[artifact.url];
      ledger.entries[artifact.url] = {
        sha256: artifact.sha256,
        bytes: typeof artifact.bytes === 'number' ? artifact.bytes : 0,
        firstSeen: existing?.firstSeen || stamp,
        lastSeen: stamp,
        networkNames,
        frontMans
      };
      touched += 1;
    }
    if (touched > 0) save(ledger);
    return ledger;
  }

  function reset() {
    rmSync(resolved, { force: true });
  }

  return { path: resolved, compare, record, reset };
}
