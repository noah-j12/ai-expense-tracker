// IndexedDB storage. Everything the app knows lives on the phone in three stores:
//   kv      - settings and small bits of state
//   entries - one record per expense
//   files   - receipt photos / PDFs, stored as ArrayBuffers (more reliable than Blobs on older iOS)

const DB_NAME = 'ai-expense-tracker';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // If iOS closes the connection in the background, reopen on next use.
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const kvGet = (key) => run('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key, value) => run('kv', 'readwrite', (s) => s.put(value, key));

export const getEntry = (id) => run('entries', 'readonly', (s) => s.get(id));
export const putEntry = (entry) => run('entries', 'readwrite', (s) => s.put(entry));
export const deleteEntryRecord = (id) => run('entries', 'readwrite', (s) => s.delete(id));
export const getAllEntries = () => run('entries', 'readonly', (s) => s.getAll());

export async function putFile(id, blob) {
  const data = await blob.arrayBuffer();
  return run('files', 'readwrite', (s) => s.put({ id, type: blob.type, data }));
}

export async function getFile(id) {
  const rec = await run('files', 'readonly', (s) => s.get(id));
  return rec ? new Blob([rec.data], { type: rec.type }) : null;
}

export const deleteFile = (id) => run('files', 'readwrite', (s) => s.delete(id));

export async function clearEverything() {
  for (const name of ['kv', 'entries', 'files']) await run(name, 'readwrite', (s) => s.clear());
}
