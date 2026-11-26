// ============================================
// Synced-profile log (IndexedDB). Shared by the service worker (via
// importScripts) and the extension pages. One record per profile, keyed by
// LinkedIn URN, updated every time that profile is sent to Clay.
// ============================================

var ProfileLog = (() => {
  const DB_NAME = 'linkedin-clay-sync';
  const STORE = 'profiles';
  let opening = null;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('lastSyncedAt', 'lastSyncedAt');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { opening = null; reject(req.error); };
      });
    }
    return opening;
  }

  const finished = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

  async function recordSynced(profile, run) {
    const key = profile.entityUrn || profile.profileUrl || profile.fullName;
    if (!key) return;
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const get = store.get(key);
    get.onsuccess = () => {
      const prev = get.result;
      const now = Date.now();
      store.put({
        ...profile,
        key,
        firstSyncedAt: prev?.firstSyncedAt ?? now,
        lastSyncedAt: now,
        timesSent: (prev?.timesSent ?? 0) + 1,
        lastRunAt: run?.at ?? now,
        lastTrigger: run?.trigger ?? 'manual',
      });
    };
    return finished(tx);
  }

  async function all() {
    const db = await open();
    const tx = db.transaction(STORE);
    const req = tx.objectStore(STORE).getAll();
    await finished(tx);
    return req.result;
  }

  async function count() {
    const db = await open();
    const tx = db.transaction(STORE);
    const req = tx.objectStore(STORE).count();
    await finished(tx);
    return req.result;
  }

  async function clear() {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    return finished(tx);
  }

  return { recordSynced, all, count, clear };
})();
