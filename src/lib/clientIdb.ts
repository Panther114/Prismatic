const DB_NAME = "prismatic-client";
const DB_VERSION = 2;
const LEGACY_STORE = "tracks";
const META_STORE = "track-meta";
const AUDIO_STORE = "track-audio";
const COVER_STORE = "track-cover";

export type StoredTrackMeta = {
  id: string;
  fileName: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  format: string;
  waveform: number[];
};

export type StoredTrackAudio = {
  id: string;
  fileName: string;
  audio: ArrayBuffer;
  audioType: string;
};

export type StoredTrackCover = {
  id: string;
  cover: ArrayBuffer;
  coverType: string;
};

export type StoredClientTrack = StoredTrackMeta & Omit<StoredTrackAudio, "id" | "fileName"> & {
  cover?: ArrayBuffer;
  coverType?: string;
};

function reqToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, {keyPath: "id"});
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE, {keyPath: "id"});
      if (!db.objectStoreNames.contains(COVER_STORE)) db.createObjectStore(COVER_STORE, {keyPath: "id"});

      // v1 stored every audio byte inline and getAll() loaded the entire library.
      // Copy into split stores during the version-change transaction.
      if (event.oldVersion < 2 && db.objectStoreNames.contains(LEGACY_STORE)) {
        const transaction = request.transaction;
        if (!transaction) return;
        const legacy = transaction.objectStore(LEGACY_STORE);
        const meta = transaction.objectStore(META_STORE);
        const audio = transaction.objectStore(AUDIO_STORE);
        const covers = transaction.objectStore(COVER_STORE);
        legacy.openCursor().onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cursor) return;
          const row = cursor.value as StoredClientTrack;
          meta.put({
            id: row.id,
            fileName: row.fileName,
            title: row.title,
            artist: row.artist,
            album: row.album,
            duration: row.duration,
            format: row.format,
            waveform: row.waveform || [],
          } satisfies StoredTrackMeta);
          audio.put({
            id: row.id,
            fileName: row.fileName,
            audio: row.audio,
            audioType: row.audioType || "audio/mpeg",
          } satisfies StoredTrackAudio);
          if (row.cover?.byteLength) {
            covers.put({
              id: row.id,
              cover: row.cover,
              coverType: row.coverType || "image/jpeg",
            } satisfies StoredTrackCover);
          }
          cursor.continue();
        };
      }
    };
  });
}

/** Clear legacy inline records only after the split metadata count verifies. */
async function clearVerifiedLegacy(db: IDBDatabase) {
  if (!db.objectStoreNames.contains(LEGACY_STORE)) return;
  const check = db.transaction([LEGACY_STORE, META_STORE], "readonly");
  const [legacyCount, metaCount] = await Promise.all([
    reqToPromise(check.objectStore(LEGACY_STORE).count()),
    reqToPromise(check.objectStore(META_STORE).count()),
  ]);
  if (legacyCount > 0 && metaCount >= legacyCount) {
    const cleanup = db.transaction(LEGACY_STORE, "readwrite");
    cleanup.objectStore(LEGACY_STORE).clear();
    await transactionDone(cleanup);
  }
}

export async function idbPutTrack(record: StoredClientTrack) {
  const db = await openDb();
  try {
    const transaction = db.transaction([META_STORE, AUDIO_STORE, COVER_STORE], "readwrite");
    transaction.objectStore(META_STORE).put({
      id: record.id,
      fileName: record.fileName,
      title: record.title,
      artist: record.artist,
      album: record.album,
      duration: record.duration,
      format: record.format,
      waveform: record.waveform || [],
    } satisfies StoredTrackMeta);
    transaction.objectStore(AUDIO_STORE).put({
      id: record.id,
      fileName: record.fileName,
      audio: record.audio,
      audioType: record.audioType || "audio/mpeg",
    } satisfies StoredTrackAudio);
    if (record.cover?.byteLength) {
      transaction.objectStore(COVER_STORE).put({
        id: record.id,
        cover: record.cover,
        coverType: record.coverType || "image/jpeg",
      } satisfies StoredTrackCover);
    }
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function idbDeleteTrack(id: string) {
  const db = await openDb();
  try {
    const transaction = db.transaction([META_STORE, AUDIO_STORE, COVER_STORE], "readwrite");
    transaction.objectStore(META_STORE).delete(id);
    transaction.objectStore(AUDIO_STORE).delete(id);
    transaction.objectStore(COVER_STORE).delete(id);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function idbListTrackMetadata(): Promise<StoredTrackMeta[]> {
  const db = await openDb();
  try {
    const result = await reqToPromise(db.transaction(META_STORE, "readonly").objectStore(META_STORE).getAll()) as StoredTrackMeta[];
    await clearVerifiedLegacy(db);
    return result;
  } finally {
    db.close();
  }
}

export async function idbGetTrackAudio(id: string): Promise<StoredTrackAudio | undefined> {
  const db = await openDb();
  try {
    return await reqToPromise(db.transaction(AUDIO_STORE, "readonly").objectStore(AUDIO_STORE).get(id)) as StoredTrackAudio | undefined;
  } finally {
    db.close();
  }
}

export async function idbGetTrackCover(id: string): Promise<StoredTrackCover | undefined> {
  const db = await openDb();
  try {
    return await reqToPromise(db.transaction(COVER_STORE, "readonly").objectStore(COVER_STORE).get(id)) as StoredTrackCover | undefined;
  } finally {
    db.close();
  }
}
