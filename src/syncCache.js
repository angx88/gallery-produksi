// syncCache.js — dipakai bersama oleh Gallery Kerudung & Gallery Produksi.
//
// Tujuan: hemat kuota read Firestore dan app cepat dibuka.
// - Data tiap collection disimpan di IndexedDB browser (kapasitas besar, tidak penuh seperti localStorage).
// - Saat app dibuka, data diambil dari IndexedDB lalu hanya dokumen yang BERUBAH sejak sinkron
//   terakhir yang dibaca dari Firestore (berdasarkan field `_syncAt` = waktu server).
// - Setiap simpan/edit di kedua app wajib memakai withSync(...) supaya `_syncAt` terisi.
// - Setiap hapus dicatat di collection `deletedDocs` supaya app lain ikut menghapus dari cache.
// - Baca penuh tetap dilakukan otomatis tiap 12 jam sebagai pengaman.
//
// PENTING: kalau app satunya menulis data, pastikan juga memakai withSync / deleteWithTombstone.
import {
  collection,
  doc,
  getDocs,
  query,
  where,
  Timestamp,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { getAuth } from "firebase/auth";

export const SYNC_FIELD = "_syncAt";
export const TOMBSTONE_COLLECTION = "deletedDocs";

const DB_NAME = "gk-sync-cache";
const STORE = "collections";
const CACHE_VERSION = 1;
const FULL_SYNC_MS = 12 * 60 * 60 * 1000; // baca penuh maksimal tiap 12 jam
const OVERLAP_MS = 10 * 60 * 1000; // toleransi selisih jam perangkat
const TOMB_KEEP_MS = 3 * 24 * 60 * 60 * 1000; // catatan hapus disimpan lokal 3 hari

// ─── Penulisan ───────────────────────────────────────────────────────────────
export function withSync(data) {
  return { ...(data || {}), [SYNC_FIELD]: serverTimestamp() };
}

function tombstoneData(ref) {
  return { col: ref.parent.id, docId: ref.id, [SYNC_FIELD]: serverTimestamp() };
}

// Untuk writeBatch / transaction: hapus dokumen + catat penghapusannya dalam satu proses.
export function deleteWithTombstone(db, writer, ref) {
  writer.delete(ref);
  writer.set(doc(collection(db, TOMBSTONE_COLLECTION)), tombstoneData(ref));
  return writer;
}

// Pengganti deleteDoc(ref).
export async function deleteDocSynced(db, ref) {
  const batch = writeBatch(db);
  deleteWithTombstone(db, batch, ref);
  await batch.commit();
}

// ─── IndexedDB ───────────────────────────────────────────────────────────────
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, CACHE_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function idbGet(key) {
  const d = await openDb();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const req = d.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbSet(key, value) {
  const d = await openDb();
  if (!d) return;
  await new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

// ─── Helper ──────────────────────────────────────────────────────────────────
function userKey() {
  try {
    return getAuth().currentUser?.uid || "anon";
  } catch {
    return "anon";
  }
}

function toMs(value) {
  return value && typeof value.toMillis === "function" ? value.toMillis() : 0;
}

function splitDoc(d) {
  const data = d.data() || {};
  const t = toMs(data[SYNC_FIELD]);
  const rest = { ...data };
  delete rest[SYNC_FIELD];
  return { id: d.id, data: rest, t };
}

// Bentuk hasil sama seperti QuerySnapshot (docs[].id, docs[].data()) supaya kode lama tidak berubah.
function snapshotLike(rows) {
  const docs = rows.map(([id, data]) => ({ id, exists: () => true, data: () => data }));
  return {
    docs,
    size: docs.length,
    empty: docs.length === 0,
    forEach: (fn) => docs.forEach(fn),
  };
}

// ─── Catatan hapus (tombstone) ───────────────────────────────────────────────
let tombInflight = null;
let tombStartedAt = 0;

function syncTombstones(db, uk) {
  if (tombInflight && Date.now() - tombStartedAt < 5000) return tombInflight;
  tombStartedAt = Date.now();
  tombInflight = (async () => {
    const key = `${uk}|__tombstones`;
    const state = (await idbGet(key)) || { lastSync: 0, items: [] };
    const sinceMs = state.lastSync ? state.lastSync - OVERLAP_MS : Date.now() - TOMB_KEEP_MS;
    const snap = await getDocs(
      query(collection(db, TOMBSTONE_COLLECTION), where(SYNC_FIELD, ">", Timestamp.fromMillis(Math.max(0, sinceMs))))
    );
    const seen = new Set(state.items.map((i) => i.k));
    let max = state.lastSync || 0;
    snap.docs.forEach((d) => {
      const x = d.data() || {};
      const t = toMs(x[SYNC_FIELD]);
      if (t > max) max = t;
      if (!seen.has(d.id) && x.col && x.docId) {
        state.items.push({ k: d.id, col: x.col, docId: x.docId, t });
        seen.add(d.id);
      }
    });
    const cutoff = Date.now() - TOMB_KEEP_MS;
    state.items = state.items.filter((i) => i.t >= cutoff);
    state.lastSync = max;
    await idbSet(key, state);
    return state.items;
  })().catch((err) => {
    console.warn("Sinkron catatan hapus gagal:", err);
    return [];
  });
  return tombInflight;
}

// ─── Baca collection ─────────────────────────────────────────────────────────
const inflight = new Map();
let fullRequestedAt = 0;

// Dipanggil dari tombol Refresh: sinkron berikutnya membaca ulang SEMUA data dari server,
// supaya hasil kerja staf (termasuk dari perangkat yang masih versi lama) pasti ikut tampil.
export function requestFullSync() {
  fullRequestedAt = Date.now();
  inflight.clear();
}

// Pengganti getDocs(collection(db, colName)) untuk membaca SELURUH collection.
export function getDocsSynced(db, colName) {
  const uk = userKey();
  const key = `${uk}|${colName}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = syncCollection(db, colName, uk, key)
    .catch(async (err) => {
      // Kalau Firestore gagal (mis. kuota harian habis / offline), tampilkan data tersimpan terakhir.
      const cached = await idbGet(key);
      if (cached && Array.isArray(cached.rows)) {
        console.warn(`Firestore gagal untuk ${colName}, memakai data tersimpan:`, err);
        return snapshotLike(cached.rows);
      }
      throw err;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function syncCollection(db, colName, uk, key) {
  const now = Date.now();
  let entry = await idbGet(key);
  const needFull = !entry || !Array.isArray(entry.rows) || now - (entry.fullAt || 0) > FULL_SYNC_MS || now < (entry.fullAt || 0) || (entry.fullAt || 0) < fullRequestedAt;

  if (needFull) {
    const snap = await getDocs(collection(db, colName));
    const rows = [];
    const times = {};
    let max = 0;
    snap.docs.forEach((d) => {
      const s = splitDoc(d);
      rows.push([s.id, s.data]);
      if (s.t) times[s.id] = s.t;
      if (s.t > max) max = s.t;
    });
    // majukan penanda catatan hapus agar penghapusan lama tidak diterapkan ulang
    await syncTombstones(db, uk);
    entry = { rows, times, lastSync: max || now, fullAt: now };
  } else {
    const since = Timestamp.fromMillis(Math.max(0, (entry.lastSync || 0) - OVERLAP_MS));
    const snap = await getDocs(query(collection(db, colName), where(SYNC_FIELD, ">", since)));
    const map = new Map(entry.rows);
    const times = { ...(entry.times || {}) };
    let max = entry.lastSync || 0;
    snap.docs.forEach((d) => {
      const s = splitDoc(d);
      map.set(s.id, s.data);
      if (s.t) times[s.id] = s.t;
      if (s.t > max) max = s.t;
    });

    const tombs = await syncTombstones(db, uk);
    const minTomb = (entry.fullAt || 0) - OVERLAP_MS;
    tombs.forEach((tb) => {
      if (tb.col !== colName || tb.t < minTomb) return;
      if ((times[tb.docId] || 0) > tb.t) return; // dibuat ulang sesudah dihapus
      map.delete(tb.docId);
      delete times[tb.docId];
    });

    // urutkan per ID seperti urutan bawaan Firestore
    const rows = Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    entry = { ...entry, rows, times, lastSync: max };
  }

  await idbSet(key, entry);
  return snapshotLike(entry.rows);
}

// Hapus cache lama di localStorage (penyebab "QuotaExceededError").
export function clearLegacyLocalCache(prefixes = []) {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && prefixes.some((p) => k.startsWith(p))) keys.push(k);
    }
    keys.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* abaikan */
  }
}
