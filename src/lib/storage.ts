import type { PersistedSession } from "../types";

const DB_NAME = "whisperbox-secure-store";
const STORE_NAME = "vault";
const SESSION_KEY = "session";

export class StorageUnavailableError extends Error {
  constructor(message = "Secure device storage is unavailable in this browser.") {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new StorageUnavailableError());
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onerror = () => {
      reject(request.error ?? new Error("Unable to open secure storage."));
    };

    request.onblocked = () => {
      reject(new StorageUnavailableError("Secure storage is blocked by another tab or the browser."));
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

export function loadPersistedSession(): Promise<PersistedSession | null> {
  return openDatabase().then(
    (database) =>
      new Promise<PersistedSession | null>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(SESSION_KEY);

        request.onerror = () => {
          reject(request.error ?? new Error("Unable to read secure storage."));
        };
        request.onsuccess = () => {
          resolve((request.result as PersistedSession | undefined) ?? null);
        };
        transaction.oncomplete = () => {
          database.close();
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error ?? new Error("IndexedDB transaction failed."));
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
        };
      }),
  );
}

export function savePersistedSession(session: PersistedSession): Promise<void> {
  return openDatabase().then(
    (database) =>
      new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(session, SESSION_KEY);

        request.onerror = () => {
          reject(request.error ?? new Error("Unable to persist secure session."));
        };
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error ?? new Error("IndexedDB transaction failed."));
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
        };
      }),
  );
}

export function clearPersistedSession(): Promise<void> {
  return openDatabase().then(
    (database) =>
      new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(SESSION_KEY);

        request.onerror = () => {
          reject(request.error ?? new Error("Unable to clear secure session."));
        };
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error ?? new Error("IndexedDB transaction failed."));
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
        };
      }),
  );
}
