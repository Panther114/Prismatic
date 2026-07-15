const DB_NAME = "prismatic-client";
const DB_VERSION = 1;
const STORE = "tracks";

export type StoredClientTrack = {
  id: string;
  fileName: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  format: string;
  waveform: number[];
  /** Audio bytes */
  audio: ArrayBuffer;
  audioType: string;
  /** Optional cover image bytes */
  cover?: ArrayBuffer;
  coverType?: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, {keyPath: "id"});
      }
    };
  });
}

function reqToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

export async function idbPutTrack(record: StoredClientTrack) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await reqToPromise(tx.objectStore(STORE).put(record));
  } finally {
    db.close();
  }
}

export async function idbDeleteTrack(id: string) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await reqToPromise(tx.objectStore(STORE).delete(id));
  } finally {
    db.close();
  }
}

export async function idbListTracks(): Promise<StoredClientTrack[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    return await reqToPromise(tx.objectStore(STORE).getAll()) as StoredClientTrack[];
  } finally {
    db.close();
  }
}
