function createRequest(work) {
  const request = { result: undefined, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    try {
      request.result = work();
      request.onsuccess?.();
    } catch (error) {
      request.error = error;
      request.onerror?.();
    }
  });
  return request;
}

function createTransaction(record) {
  const transaction = { error: null, oncomplete: null, onerror: null, onabort: null };
  const finish = () => queueMicrotask(() => transaction.oncomplete?.());

  transaction.objectStore = (name) => {
    const map = record.stores.get(name);
    if (!map) throw new Error(`Missing object store: ${name}`);
    return {
      get(key) {
        const request = createRequest(() => map.get(key));
        finish();
        return request;
      },
      put(value) {
        const request = createRequest(() => {
          map.set(value.origin, structuredClone(value));
          return value.origin;
        });
        finish();
        return request;
      },
      delete(key) {
        const request = createRequest(() => {
          map.delete(key);
        });
        finish();
        return request;
      }
    };
  };

  return transaction;
}

export function createFakeIndexedDB() {
  const databases = new Map();

  return {
    open(name, version) {
      const request = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null
      };
      queueMicrotask(() => {
        let record = databases.get(name);
        if (!record) {
          record = { version: 0, stores: new Map() };
          databases.set(name, record);
        }
        request.result = {
          objectStoreNames: { contains: (store) => record.stores.has(store) },
          createObjectStore: (store) => {
            record.stores.set(store, new Map());
            return { name: store };
          },
          transaction: () => createTransaction(record)
        };
        const upgraded = version > record.version;
        if (upgraded) record.version = version;
        if (upgraded) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
}
