// IndexedDB storage layer. All data lives on the device.
//
// UPGRADE NOTES
// - DB_VERSION is the *IndexedDB structure* version (object stores / indexes).
//   Bump it only when you add a store or index, and add an `if (old < N)` block
//   in onupgradeneeded. Never remove or rewrite existing blocks.
// - The *shape of records* is versioned separately by SCHEMA_VERSION in schema.js;
//   record migrations run in app.js at startup via migrate().

const DB_NAME = 'expense-manager';
const DB_VERSION = 1;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const old = e.oldVersion;
      if (old < 1) {
        const ex = db.createObjectStore('expenses', { keyPath: 'id' });
        ex.createIndex('date', 'date');
        db.createObjectStore('recurring', { keyPath: 'id' });
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      // if (old < 2) { ...future structural changes... }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); location.reload(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other open copies of the app and try again.'));
  });
  return dbPromise;
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (t) => new Promise((res, rej) => {
  t.oncomplete = () => res();
  t.onerror = () => rej(t.error);
  t.onabort = () => rej(t.error || new Error('Transaction aborted'));
});

export async function getAll(store) {
  const db = await openDB();
  return reqP(db.transaction(store).objectStore(store).getAll());
}

export async function getAllMeta() {
  const rows = await getAll('meta');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * One atomic write across stores. Either everything is saved or nothing is.
 * { expenses, recurring, deleteExpenses, deleteRecurring, meta, clear }
 */
export async function writeBatch({ expenses = [], recurring = [], deleteExpenses = [], deleteRecurring = [], meta = {}, clear = false } = {}) {
  const db = await openDB();
  const t = db.transaction(['expenses', 'recurring', 'meta'], 'readwrite');
  const ex = t.objectStore('expenses'), rc = t.objectStore('recurring'), mt = t.objectStore('meta');
  if (clear) { ex.clear(); rc.clear(); }
  deleteExpenses.forEach((id) => ex.delete(id));
  deleteRecurring.forEach((id) => rc.delete(id));
  expenses.forEach((x) => ex.put(x));
  recurring.forEach((x) => rc.put(x));
  Object.entries(meta).forEach(([key, value]) => mt.put({ key, value }));
  return txDone(t);
}

export async function wipeEverything() {
  const db = await openDB();
  const t = db.transaction(['expenses', 'recurring', 'meta'], 'readwrite');
  t.objectStore('expenses').clear();
  t.objectStore('recurring').clear();
  t.objectStore('meta').clear();
  return txDone(t);
}
