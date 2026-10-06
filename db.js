// Storage. Small settings live in localStorage; the diary (entries, water, weights) in IndexedDB.
// Nothing leaves the phone except the API calls the user triggers.

// --- localStorage --------------------------------------------------------------------------------
// localStorage can be unavailable (private mode) - fall back to memory so the app still works.

const memory = {};
export function load(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return key in memory ? memory[key] : fallback;
  }
}
export function save(key, value) {
  memory[key] = value;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* memory only */ }
}

// --- IndexedDB -----------------------------------------------------------------------------------

const DB_NAME = "calorielens";
const DB_VERSION = 1;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const entries = db.createObjectStore("entries", { keyPath: "id" });
      entries.createIndex("day", "day");
      db.createObjectStore("water", { keyPath: "day" });
      db.createObjectStore("weights", { keyPath: "day" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function run(storeName, mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const entriesForDay = (day) =>
  run("entries", "readonly", (store) => store.index("day").getAll(day))
    .then((list) => list.sort((a, b) => a.time - b.time));
// Day keys are "YYYY-MM-DD", so a string range is a date range (both ends included).
export const entriesBetween = (fromDay, toDay) =>
  run("entries", "readonly", (store) => store.index("day").getAll(IDBKeyRange.bound(fromDay, toDay)));
export const getEntry =(id) => run("entries", "readonly", (store) => store.get(id));
export const putEntry =(entry) => run("entries", "readwrite", (store) => store.put(entry));
export const deleteEntry = (id) => run("entries", "readwrite", (store) => store.delete(id));

export const waterForDay = (day) =>
  run("water", "readonly", (store) => store.get(day)).then((row) => row?.ml ?? 0);
export const setWater = (day, ml) => run("water", "readwrite", (store) => store.put({ day, ml }));

export const allWeights = () => run("weights", "readonly", (store) => store.getAll());
export const putWeight = (day, kg) => run("weights", "readwrite", (store) => store.put({ day, kg }));

// Asks iOS not to evict the diary under storage pressure. Granted more readily to home-screen apps.
export async function requestPersistence() {
  try {
    return (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false;
  } catch {
    return false;
  }
}
