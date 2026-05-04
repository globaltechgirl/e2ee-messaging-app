import type { PersistedSession } from "../types";

const DB_NAME = "whisperbox-secure-store";
const STORE_NAME = "vault";
const SESSION_KEY = "session";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onerror = () => {
      reject(request.error ?? new Error("Unable to open secure storage."));
    };

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T> {
  const database = await openDatabase();

  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);

    transaction.oncomplete = () => {
      database.close();
    };

    transaction.onerror = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    };

    run(store, resolve, reject);
  });
}

export function loadPersistedSession(): Promise<PersistedSession | null> {
  return withStore<PersistedSession | null>("readonly", (store, resolve, reject) => {
    const request = store.get(SESSION_KEY);

    request.onerror = () => reject(request.error ?? new Error("Unable to read secure storage."));
    request.onsuccess = () => resolve((request.result as PersistedSession | undefined) ?? null);
  });
}

export function savePersistedSession(session: PersistedSession): Promise<void> {
  return withStore<void>("readwrite", (store, resolve, reject) => {
    const request = store.put(session, SESSION_KEY);

    request.onerror = () => reject(request.error ?? new Error("Unable to persist secure session."));
    request.onsuccess = () => resolve();
  });
}

export function clearPersistedSession(): Promise<void> {
  return withStore<void>("readwrite", (store, resolve, reject) => {
    const request = store.delete(SESSION_KEY);

    request.onerror = () => reject(request.error ?? new Error("Unable to clear secure session."));
    request.onsuccess = () => resolve();
  });
}
