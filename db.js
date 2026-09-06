// db.js - the ONLY file that touches IndexedDB.
// Database: artic. Everything the app remembers lives here, on this device only.
// Nothing in here is ever sent anywhere.

const DB_NAME = 'artic';
const DB_VERSION = 1;

// Store name -> keyPath. Note one deliberate change from the design doc:
// `words` is keyed by `id` ("deckId::word"), not by `word`, because the Core 300
// deck and the Verbal Advantage deck share five headwords and a bare word key
// would silently merge them into one card.
const STORES = {
  settings: { keyPath: 'key' },
  sessions: { keyPath: 'id' },
  reps:     { keyPath: 'id', indexes: { session_id: 'session_id', mode: 'mode', created_at: 'created_at' } },
  clips:    { keyPath: 'id', indexes: { rep_id: 'rep_id', created_at: 'created_at' } },
  words:    { keyPath: 'id', indexes: { due_date: 'due_date', deck: 'deck', box: 'box' } },
  texts:    { keyPath: 'id' },
  prompts:  { keyPath: 'id', indexes: { category: 'category' } },
  people:   { keyPath: 'id', indexes: { last_touch_date: 'last_touch_date' } },
  touches:  { keyPath: 'id', indexes: { person_id: 'person_id', date: 'date' } }
};

let _db = null;
let _openError = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      _openError = e;
      return reject(e);
    }
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      for (const [name, spec] of Object.entries(STORES)) {
        let store;
        if (!db.objectStoreNames.contains(name)) {
          store = db.createObjectStore(name, { keyPath: spec.keyPath });
        } else {
          store = ev.target.transaction.objectStore(name);
        }
        for (const [idxName, idxKey] of Object.entries(spec.indexes || {})) {
          if (!store.indexNames.contains(idxName)) store.createIndex(idxName, idxKey);
        }
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => { _openError = req.error; reject(req.error); };
    req.onblocked = () => reject(new Error('Database blocked by another open tab'));
  });
}

function tx(names, mode) {
  return open().then(db => db.transaction(names, mode));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const db = {
  openError: () => _openError,

  async ready() { await open(); return true; },

  async put(store, value) {
    const t = await tx([store], 'readwrite');
    const r = await wrap(t.objectStore(store).put(value));
    return r;
  },

  async putAll(store, values) {
    if (!values.length) return 0;
    const t = await tx([store], 'readwrite');
    const os = t.objectStore(store);
    for (const v of values) os.put(v);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
    return values.length;
  },

  async get(store, key) {
    const t = await tx([store], 'readonly');
    return wrap(t.objectStore(store).get(key));
  },

  async all(store) {
    const t = await tx([store], 'readonly');
    return wrap(t.objectStore(store).getAll());
  },

  async byIndex(store, index, value) {
    const t = await tx([store], 'readonly');
    return wrap(t.objectStore(store).index(index).getAll(value));
  },

  async count(store) {
    const t = await tx([store], 'readonly');
    return wrap(t.objectStore(store).count());
  },

  async del(store, key) {
    const t = await tx([store], 'readwrite');
    return wrap(t.objectStore(store).delete(key));
  },

  async clear(store) {
    const t = await tx([store], 'readwrite');
    return wrap(t.objectStore(store).clear());
  },

  async wipeAll() {
    const names = Object.keys(STORES);
    const t = await tx(names, 'readwrite');
    for (const n of names) t.objectStore(n).clear();
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },

  // settings helpers
  async setting(key, fallback) {
    const row = await this.get('settings', key);
    return row === undefined ? fallback : row.value;
  },
  async setSetting(key, value) {
    return this.put('settings', { key, value });
  },

  // ---- export / import ----
  // Clips (audio blobs) are excluded on purpose: they are the only thing that
  // makes the file huge, and they are practice takes, not history worth keeping.
  async exportJson() {
    const out = { format: 'articulation-trainer-export', schema: DB_VERSION, exported_at: new Date().toISOString(), stores: {} };
    for (const name of Object.keys(STORES)) {
      if (name === 'clips') { out.stores[name] = []; continue; }
      out.stores[name] = await this.all(name);
    }
    return out;
  },

  async importJson(obj, { replace = true } = {}) {
    if (!obj || obj.format !== 'articulation-trainer-export') {
      throw new Error('That file is not an articulation trainer export.');
    }
    const counts = {};
    for (const [name, rows] of Object.entries(obj.stores || {})) {
      if (!STORES[name]) continue;
      if (replace && name !== 'clips') await this.clear(name);
      await this.putAll(name, rows || []);
      counts[name] = (rows || []).length;
    }
    return counts;
  }
};

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

export function daysBetween(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  const da = Date.UTC(pa[0], pa[1] - 1, pa[2]), dbb = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((dbb - da) / 86400000);
}
