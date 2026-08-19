/**
 * IndexedDB persistence for the rewind history.
 *
 * A saved configuration's design + running sim state are small and live in
 * localStorage, but the rewind history (up to 1000 full-state snapshots +
 * the dt log) runs to tens of megabytes - far past the localStorage quota.
 * IndexedDB has no such practical limit AND stores structured clones
 * directly, so the snapshot Maps go in as-is with no JSON round trip.
 *
 * Records are keyed by the configuration name; saving under the same name
 * overwrites, deleting a configuration deletes its history.
 */

const DB_NAME = 'meltdown-history';
const DB_VERSION = 1;
const STORE = 'histories';

export interface SavedHistoryRecord {
  version: 1;
  savedAt: string;      // ISO timestamp, informational
  simTime: number;      // sim time of the accompanying saved state
  history: unknown;     // StateHistory.exportForSave() payload
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function requestDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function saveHistoryRecord(name: string, record: SavedHistoryRecord): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    await requestDone(tx.objectStore(STORE).put(record, name));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
  } finally {
    db.close();
  }
}

export async function loadHistoryRecord(name: string): Promise<SavedHistoryRecord | null> {
  const db = await openDb();
  try {
    const result = await requestDone(db.transaction(STORE, 'readonly').objectStore(STORE).get(name));
    return (result as SavedHistoryRecord | undefined) ?? null;
  } finally {
    db.close();
  }
}

export async function deleteHistoryRecord(name: string): Promise<void> {
  const db = await openDb();
  try {
    await requestDone(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(name));
  } finally {
    db.close();
  }
}
