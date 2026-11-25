const KEY_PREFIX = 'awd.byok.';

export function byokStorageKey(origin) {
  return `${KEY_PREFIX}${origin || 'unknown-origin'}`;
}

export function normalizeRouterUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('Router base URL must be a valid URL.');
  }
  if (url.username || url.password) throw new Error('Router base URL must not include credentials.');
  url.search = '';
  url.hash = '';
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Router base URL must use HTTPS (HTTP is allowed only for loopback development).');
  }
  return url.href.replace(/\/+$/, '');
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createByokStore({ storage = defaultStorage(), origin = globalThis.location?.origin ?? '', prefix = KEY_PREFIX } = {}) {
  const storageKey = `${prefix}${origin || 'unknown-origin'}`;

  function read() {
    if (!storage) return null;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return null;
      const record = JSON.parse(raw);
      if (!record || typeof record.key !== 'string' || !record.key) return null;
      return {
        baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
        model: typeof record.model === 'string' ? record.model : '',
        key: record.key
      };
    } catch {
      return null;
    }
  }

  return {
    storageKey,
    load: read,
    hasKey: () => Boolean(read()?.key),
    save({ baseUrl, model, key } = {}) {
      const trimmed = String(key ?? '').trim();
      if (!trimmed) throw new Error('A router key is required.');
      if (!storage) throw new Error('Browser storage is unavailable; the key cannot be saved.');
      const record = {
        baseUrl: normalizeRouterUrl(baseUrl),
        model: String(model ?? '').trim(),
        key: trimmed
      };
      storage.setItem(storageKey, JSON.stringify(record));
      return record;
    },
    clear() {
      try {
        storage?.removeItem(storageKey);
      } catch {
        /* storage is optional */
      }
    }
  };
}
