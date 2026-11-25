export const DB_NAME = 'agentic-web-doctor';
export const DB_VERSION = 1;
export const STORE_NAME = 'artifact-ledger';

export function compareArtifacts(previous, artifacts, stamp) {
  const before = previous?.artifacts ?? {};
  const snapshot = {};
  const added = [];
  const changed = [];
  let unchanged = 0;

  for (const artifact of artifacts || []) {
    if (!artifact || typeof artifact.url !== 'string' || typeof artifact.sha256 !== 'string') continue;
    const prior = before[artifact.url];
    if (!prior) added.push(artifact.url);
    else if (prior.sha256 === artifact.sha256) unchanged += 1;
    else {
      changed.push({
        url: artifact.url,
        previousSha256: prior.sha256,
        sha256: artifact.sha256,
        previousBytes: prior.bytes,
        bytes: artifact.bytes
      });
    }
    snapshot[artifact.url] = {
      sha256: artifact.sha256,
      bytes: typeof artifact.bytes === 'number' ? artifact.bytes : 0,
      firstSeen: prior?.firstSeen || stamp,
      lastSeen: stamp
    };
  }

  return {
    firstVisit: !previous,
    total: Object.keys(snapshot).length,
    unchanged,
    added,
    changed,
    removed: Object.keys(before).filter((url) => !(url in snapshot)),
    snapshot
  };
}

export function createLedger(storage, now = () => new Date().toISOString()) {
  return {
    async remember(report) {
      const artifacts = Array.isArray(report.artifacts) ? report.artifacts : [];
      if (artifacts.length === 0) return null;
      const origin = report.baseUrl;
      const previous = await storage.get(origin);
      const stamp = now();
      const comparison = compareArtifacts(previous, artifacts, stamp);
      await storage.put(origin, {
        version: 1,
        origin,
        updatedAt: stamp,
        artifacts: comparison.snapshot
      });
      return comparison;
    },

    async forget(origin) {
      await storage.delete(origin);
    }
  };
}

function transactionDone(transaction, request) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(request ? request.result : undefined);
    transaction.onerror = () => reject(transaction.error || request?.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

export function createIndexedDbStorage(db) {
  const write = (action) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    return transactionDone(transaction, action(transaction.objectStore(STORE_NAME)));
  };
  return {
    get(origin) {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      return transactionDone(transaction, transaction.objectStore(STORE_NAME).get(origin));
    },
    put(origin, entry) {
      return write((store) => store.put({ ...entry, origin }));
    },
    delete(origin) {
      return write((store) => store.delete(origin));
    }
  };
}

export function openLedger(factory) {
  if (!factory?.open) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'origin' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

export async function openBrowserLedger(factory = globalThis.indexedDB) {
  const db = await openLedger(factory);
  return db ? createLedger(createIndexedDbStorage(db)) : null;
}
