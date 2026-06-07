// App.jsx Gallery Produksi - BORONGAN SEARCH PINTAR FIX RUNTIME - 2026-06-08
// Audit final: fokus produksi, borongan/upah, kasbon pegawai, stok siap kirim, dan pengiriman real ke App Kerudung.
// Perbaikan: pengiriman atomic, gajian-kasbon atomic, produksi/borongan/setor anti data yatim,
// legacy sync lebih aman, dropdown pengiriman baca deliveries dengan benar, UI lebih terbaca.
// PERFORMA: (1) work_rates, master_pekerja, materials, payroll, gajian_history pakai getDocs.
// (2) SHIPMENTS, KASBON, PAYROLL_EXPENSES: getDocs + refreshData() setelah write — tidak lagi
//     onSnapshot sehingga setiap write tidak memicu re-read seluruh collection.
// (3) ORDERS, PRODUKSI, dan PRODUCTION_ENTRIES tidak lagi realtime onSnapshot;
//     dimuat manual dan di-refresh setelah simpan agar hemat reads.
// (4) debounce search 250ms, (5) dashboardInsights dipecah useMemo terpisah.
// (6) backfill legacy hanya jalan sekali per sesi (flag backfillDoneRef dll).
// (7) Audit bersih: hapus CardHeader/Title/Desc/Content/Footer, dateAfter, PROCESSES_NO_MODEL,
//     deleteStep. rateDocId dipindah ke luar App(). Toast cleanup via toastTimerRef.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { db, auth } from "./firebase";
import {
  collection,
  addDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  doc,
  query,
  where,
  runTransaction,
  writeBatch,
} from "firebase/firestore";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import "./index.css";

/*
  Gallery Produksi
  - Pesanan dari Gallery Kerudung: orders
  - Kain dari Gallery Kerudung: materials
  - Pengiriman link ke Gallery Kerudung: shipments
  - Produksi lokal: produksi
  - Tarif borongan: work_rates
  - Hasil borongan: production_entries
  - Gaji masuk pengeluaran: payroll_expenses
*/

const provider = new GoogleAuthProvider();

const C = {
  ORDERS: "orders",
  MATERIALS: "materials",
  SHIPMENTS: "shipments",
  SHIPMENT_BATCHES: "shipment_batches",
  PRODUKSI: "produksi",
  WORK_RATES: "work_rates",
  PRODUCTION_ENTRIES: "production_entries",
  PAYROLL_EXPENSES: "payroll_expenses",
  GAJIAN_HISTORY: "gajian_history",
  KASBON: "kasbon_pegawai",
};

// HEMAT KUOTA FIRESTORE:
// Background backfill/migrasi otomatis dimatikan agar app tidak menulis/membaca data lama
// setiap kali dibuka. Jalankan perbaikan data lama secara manual saja bila memang diperlukan.
const ENABLE_AUTO_BACKFILL = false;
const KONVEKSI_RATE_DEDUCTION = 500;

const FIRESTORE_CACHE_VERSION = "v1";
const FIRESTORE_CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12 jam, cukup untuk hemat reads harian

function safeReadJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function canUseLocalStorage() {
  return typeof window !== "undefined" && !!window.localStorage;
}

function inputValue(valueOrEvent) {
  if (valueOrEvent && typeof valueOrEvent === "object" && "target" in valueOrEvent) {
    return valueOrEvent.target?.value ?? "";
  }
  return valueOrEvent;
}

function friendlyErrorMessage(action, error) {
  const raw = String(error?.code || error?.message || error || "").toLowerCase();

  if (raw.includes("quota") || raw.includes("resource-exhausted")) {
    return `${action} gagal. Kuota Firebase/Firestore sedang penuh. Coba lagi nanti, cek Usage Firebase, atau kurangi pemakaian data.`;
  }

  if (raw.includes("permission-denied") || raw.includes("missing or insufficient permissions")) {
    return `${action} gagal. Akses database ditolak. Cek login dan aturan Firestore.`;
  }

  if (raw.includes("unavailable") || raw.includes("deadline-exceeded") || raw.includes("network") || raw.includes("offline")) {
    return `${action} gagal. Koneksi internet/server sedang bermasalah. Coba ulang beberapa saat lagi.`;
  }

  if (raw.includes("already-exists")) {
    return `${action} gagal. Data yang sama sudah ada.`;
  }

  if (raw.includes("failed-precondition")) {
    return `${action} gagal. Ada syarat database yang belum terpenuhi. Coba refresh data lalu ulangi.`;
  }

  return `${action} gagal. ${error?.message || error || "Silakan coba ulang."}`;
}


const PROD_STATUS = ["Antri", "Potong", "Jahit", "Pengemasan QC", "Selesai"];
const GENERAL_RATE_PROCESSES = ["Potong", "Pengemasan QC"];
const MODEL_SPECIFIC_PROCESSES = ["Jahit"];
const PROCESSES_WITH_MODEL = [...GENERAL_RATE_PROCESSES, ...MODEL_SPECIFIC_PROCESSES];
const ALL_PROCESSES = PROCESSES_WITH_MODEL;
const PRODUCT_TYPES = ["Kerudung", "Mukena", "Baju Anak", "Gamis", "Lainnya"];

function isGeneralRateProcess(process) {
  return GENERAL_RATE_PROCESSES.some((p) => normalizeProcessKey(p) === normalizeProcessKey(process));
}

function isModelSpecificProcess(process) {
  return MODEL_SPECIFIC_PROCESSES.some((p) => normalizeProcessKey(p) === normalizeProcessKey(process));
}

const PROD_COLORS = {
  Antri: { bg: "#fef3c7", text: "#92400e", icon: "⏳" },
  Potong: { bg: "#dbeafe", text: "#1e40af", icon: "✂️" },
  Jahit: { bg: "#ede9fe", text: "#5b21b6", icon: "🧵" },
  "Pengemasan QC": { bg: "#fce7f3", text: "#9d174d", icon: "📦" },
  Selesai: { bg: "#d1fae5", text: "#065f46", icon: "✅" },
};

const lower = (v) => String(v || "").toLowerCase();

function isSentStatus(status) {
  const s = lower(status);
  return s.includes("kirim") || s.includes("sent") || s.includes("shipped") || s.includes("terkirim");
}

function isDoneStatus(status) {
  const s = lower(status);
  // "Lunas" adalah status pembayaran, bukan bukti produksi/pengiriman selesai.
  return s === "selesai" || s.includes("done") || s.includes("complete");
}

function isShortShipmentClosed(order) {
  const raw = order?.raw || order || {};
  return raw.shortShipmentClosed === true
    || raw.deliveryStatus === "Ditutup Kurang Kirim"
    || raw.shippingStatus === "Kurang Kirim Final"
    || raw.status === "Ditutup Kurang Kirim";
}


function safeDocId(value, fallback = "doc") {
  const raw = String(value || "").trim().toLowerCase();
  const clean = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return clean || fallback;
}

function getDeliveryArray(orderLike) {
  if (Array.isArray(orderLike?.raw?.deliveries)) return orderLike.raw.deliveries;
  if (Array.isArray(orderLike?.deliveries)) return orderLike.deliveries;
  return [];
}

function isOrderStatusClosedForShipment(status) {
  const s = lower(status);
  if (!s) return false;
  // Dikirim sebagian masih harus muncul di menu Kirim agar admin bisa kirim sisa.
  if (s.includes("dikirim sebagian") || s.includes("sebagian") || s.includes("partial")) return false;
  if (s.includes("kurang kirim") && !s.includes("final") && !s.includes("ditutup")) return false;
  if (s.includes("selesai produksi")) return false;
  if (s.includes("kelebihan kirim")) return true;
  if (s.includes("ditutup") || s.includes("closed")) return true;
  if (s.includes("dikirim") || s.includes("terkirim") || s.includes("kirim selesai")) return true;
  if (s.includes("done") || s.includes("complete")) return true;
  if (s === "selesai") return true;
  return false;
}

function sameText(a, b) {
  return String(a || "").trim() !== "" && String(b || "").trim() !== "" && String(a).trim() === String(b).trim();
}


function parseIndoNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let raw = String(value).trim();
  if (!raw) return 0;
  const negative = /^-/.test(raw) || /\(.*\)/.test(raw);
  raw = raw.replace(/[^\d,.-]/g, "");
  if (!raw) return 0;

  const hasComma = raw.includes(",");
  const hasDot = raw.includes(".");
  let normalized = raw;

  if (hasComma && hasDot) {
    const lastComma = raw.lastIndexOf(",");
    const lastDot = raw.lastIndexOf(".");
    if (lastComma > lastDot) {
      normalized = raw.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = raw.replace(/,/g, "");
    }
  } else if (hasComma) {
    const parts = raw.split(",");
    normalized = parts.length === 2 && parts[1].length <= 2
      ? `${parts[0].replace(/\./g, "")}.${parts[1]}`
      : raw.replace(/,/g, "");
  } else if (hasDot) {
    const parts = raw.split(".");
    const last = parts[parts.length - 1];
    normalized = parts.length > 1 && last.length === 3
      ? raw.replace(/\./g, "")
      : raw;
  }

  const n = Number(normalized);
  if (!Number.isFinite(n)) return 0;
  return negative ? -Math.abs(n) : n;
}

function qtyValue(value) {
  const n = parseIndoNumber(value);
  return Number.isFinite(n) ? n : 0;
}

function moneyValue(value) {
  const n = parseIndoNumber(value);
  return Number.isFinite(n) ? n : 0;
}

function nonNegativeQty(value) {
  return Math.max(0, qtyValue(value));
}

function nonNegativeMoney(value) {
  return Math.max(0, moneyValue(value));
}

function lineMoneyTotal(qty, price) {
  return nonNegativeQty(qty) * nonNegativeMoney(price);
}

function fmtQty(value) {
  const n = qtyValue(value);
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.00$/, "").replace(/0$/, "");
}

function materialNameFromItem(item) {
  return (
    item?.mainMaterial ||
    item?.materialName ||
    item?.kain ||
    item?.namaKain ||
    item?.material ||
    ""
  );
}

function materialQtyPerPcsFromItem(item) {
  return qtyValue(
    item?.materialQtyPerPcs ??
    item?.kebutuhanKainPerPcs ??
    item?.kebutuhanKain ??
    item?.kainPerPcs ??
    item?.qtyKainPerPcs ??
    0
  );
}

function orderItemsForMaterial(order) {
  const rawItems = Array.isArray(order?.raw?.items) && order.raw.items.length > 0
    ? order.raw.items
    : Array.isArray(order?.items) && order.items.length > 0
      ? order.items
      : [order?.raw || order];

  return rawItems.map((it) => ({
    name: it?.name || it?.item || order?.item || "-",
    qty: nonNegativeQty(it?.qty ?? it?.quantity ?? order?.qty ?? 0),
    mainMaterial: materialNameFromItem(it) || materialNameFromItem(order?.raw) || materialNameFromItem(order),
    materialQtyPerPcs: materialQtyPerPcsFromItem(it) || materialQtyPerPcsFromItem(order?.raw) || materialQtyPerPcsFromItem(order),
  }));
}

function normalizeKey(value) {
  return lower(value).replace(/[^a-z0-9]/g, "");
}

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function localDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function currentSundayToSaturdayPeriod(baseDate = new Date()) {
  const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  // JavaScript: Minggu = 0, Senin = 1, ..., Sabtu = 6.
  // Periode rekap yang benar adalah Minggu s/d Sabtu.
  start.setDate(start.getDate() - start.getDay());

  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  return { dari: localDateStr(start), sampai: localDateStr(end) };
}


function dateKey(value) {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (!raw) return "";

  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${String(isoMatch[2]).padStart(2, "0")}-${String(isoMatch[3]).padStart(2, "0")}`;
  }

  const slashMatch = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (slashMatch) {
    return `${slashMatch[3]}-${String(slashMatch[2]).padStart(2, "0")}-${String(slashMatch[1]).padStart(2, "0")}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return "";
}

function dateInRange(value, dari, sampai) {
  const t = dateKey(value);
  const d = dateKey(dari);
  const s = dateKey(sampai);
  return Boolean(t && d && s && t >= d && t <= s);
}

function dateBefore(value, compareTo) {
  const t = dateKey(value);
  const c = dateKey(compareTo);
  return Boolean(t && c && t < c);
}

function dateRangesOverlap(startA, endA, startB, endB) {
  const a1 = dateKey(startA);
  const a2 = dateKey(endA);
  const b1 = dateKey(startB);
  const b2 = dateKey(endB);
  if (!a1 || !a2 || !b1 || !b2) return false;
  return a1 <= b2 && b1 <= a2;
}

// ─── Master Data Normalization ──────────────────────────────────────────────
// Tujuan: data lama yang beda kapital, titik, strip, spasi, atau typo ringan
// tetap dianggap satu master. Contoh: "A muslim", "A. Muslim", "a-muslim"
// → "A Muslim". Untuk model: "Alya L", "alya-l", "Alya  L" → "Alya L".
function stripDiacritics(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function toTitleCase(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\b[a-z0-9]+/g, (word) => {
      if (/^[ivxlcdm]+$/i.test(word) && word.length <= 4) return word.toUpperCase();
      if (/^[a-z]$/i.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    });
}

function cleanMasterText(value) {
  return stripDiacritics(value)
    .replace(/[’`]/g, "'")
    .replace(/[._\-/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMasterKey(value) {
  return cleanMasterText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCompactKey(value) {
  return normalizeMasterKey(value).replace(/\s+/g, "");
}

function normalizeProcessKey(value) {
  const key = normalizeMasterKey(value);
  const compact = normalizeCompactKey(value);
  if (!key) return "";
  if (key.includes("potong")) return "potong";
  if (key.includes("jahit")) return "jahit";
  const isPackingQc =
    compact === "qcpacking" ||
    compact === "packingqc" ||
    compact === "pengemasanqc" ||
    compact === "qcpengemasan" ||
    key.includes("qc packing") ||
    key.includes("packing qc") ||
    key.includes("pengemasan qc") ||
    key.includes("qc pengemasan") ||
    ((key.includes("qc") || key.includes("quality control")) && (key.includes("packing") || key.includes("pengemasan")));
  if (isPackingQc) return "pengemasan qc";
  return key;
}

function sameProcess(a, b) {
  return normalizeProcessKey(a) === normalizeProcessKey(b);
}

function displayProcessName(value) {
  const key = normalizeProcessKey(value);
  if (key === "potong") return "Potong";
  if (key === "jahit") return "Jahit";
  if (key === "pengemasan qc") return "Pengemasan QC";
  return toTitleCase(cleanMasterText(value));
}

const WORKER_PROCESS_WORDS = new Set([
  "jahit", "potong", "qc", "packing", "pack", "pengemasan", "borongan",
  "pcs", "pc", "setor", "hasil"
]);

const WORKER_TITLE_WORDS = new Set(["teh", "ibu", "mbak", "mba", "pak"]);

const WORKER_NOISE_WORDS = new Set([...WORKER_PROCESS_WORDS, ...WORKER_TITLE_WORDS]);

function normalizeWorkerNameKey(name) {
  const words = normalizeMasterKey(name)
    .split(" ")
    .filter(Boolean)
    .filter((w) => !WORKER_NOISE_WORDS.has(w));
  return words.join(" ") || normalizeMasterKey(name);
}

function displayWorkerName(name) {
  // Tampilan tetap mempertahankan panggilan seperti Teh/Ibu/Mbak/Pak jika memang ada.
  // Yang dibuang dari tampilan hanya kata proses yang sering ikut salah ketik di nama pekerja.
  const words = cleanMasterText(name)
    .split(" ")
    .filter(Boolean)
    .filter((w) => !WORKER_PROCESS_WORDS.has(w.toLowerCase()));
  const clean = words.join(" ");
  return clean ? toTitleCase(clean) : "Tidak Diketahui";
}

function workerDisplayScore(name) {
  const words = normalizeMasterKey(name).split(" ").filter(Boolean);
  const hasTitle = words.some((w) => WORKER_TITLE_WORDS.has(w));
  const cleanLen = displayWorkerName(name).length;
  return (hasTitle ? 1000 : 0) - cleanLen;
}

function normalizeModelKey(name) {
  return normalizeMasterKey(name);
}

function displayModelName(name) {
  const clean = cleanMasterText(name);
  return clean ? toTitleCase(clean) : "-";
}

function normalizeProductTypeKey(name) {
  return normalizeMasterKey(name);
}

function displayProductTypeName(name) {
  const key = normalizeProductTypeKey(name);
  const found = PRODUCT_TYPES.find((p) => normalizeProductTypeKey(p) === key);
  return found || (cleanMasterText(name) ? toTitleCase(cleanMasterText(name)) : "Kerudung");
}

function canonicalByExisting(value, candidates, kind = "text") {
  const keyFn = kind === "worker" ? normalizeWorkerNameKey : kind === "model" ? normalizeModelKey : normalizeMasterKey;
  const displayFn = kind === "worker" ? displayWorkerName : kind === "model" ? displayModelName : toTitleCase;
  const key = keyFn(value);
  if (!key) return displayFn(value);
  const direct = (candidates || []).find((x) => keyFn(x) === key);
  if (direct) return displayFn(direct);
  const compact = normalizeCompactKey(value);
  const fuzzy = (candidates || []).find((x) => normalizeCompactKey(x) === compact);
  return displayFn(fuzzy || value);
}

// Hitung periode minggu (Minggu s/d Sabtu) dari tanggal tertentu
function getMingguPeriod(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const minggu = new Date(d); minggu.setDate(d.getDate() - day);
  const sabtu = new Date(d); sabtu.setDate(d.getDate() + (6 - day));
  return { dari: minggu.toISOString().slice(0, 10), sampai: sabtu.toISOString().slice(0, 10) };
}

function getMingguIni() { return getMingguPeriod(todayStr()); }

function getDaftarMinggu(n = 7) {
  const hasil = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i * 7);
    const period = getMingguPeriod(d.toISOString().slice(0, 10));
    const key = period.dari + "_" + period.sampai;
    if (!hasil.find((x) => x.key === key)) hasil.push({ key, ...period });
  }
  return hasil;
}

function money(v) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(moneyValue(v));
}


function normalizeSetorHistory(entry) {
  const raw = Array.isArray(entry?.setorHistory) ? entry.setorHistory : [];
  const normalized = raw
    .map((h, idx) => {
      const qtySetor = nonNegativeQty(h?.qtySetor || 0);
      const qtyReject = nonNegativeQty(h?.qtyReject || 0);
      const rate = nonNegativeMoney(h?.rate ?? entry?.rate ?? 0);
      return {
        id: h?.id || `${entry?.id || "entry"}-${idx}`,
        tanggalSetor: h?.tanggalSetor || h?.tanggal || entry?.tanggalSetor || entry?.tanggal || todayStr(),
        qtySetor,
        qtyReject,
        rate,
        totalWageSetor: Math.max(0, moneyValue(h?.totalWageSetor ?? (qtySetor * rate) ?? 0)),
        catatan: h?.catatan || h?.catatanSetor || "",
        createdAt: h?.createdAt || "",
      };
    })
    .filter((h) => Number(h.qtySetor || 0) > 0 || Number(h.qtyReject || 0) > 0);

  // Dukungan data lama: entry lama hanya punya qtySetor/qtyReject tanpa setorHistory.
  if (normalized.length === 0 && (nonNegativeQty(entry?.qtySetor || 0) > 0 || nonNegativeQty(entry?.qtyReject || 0) > 0 || entry?.statusSetor === "sudah_setor")) {
    const qtySetor = nonNegativeQty(entry?.qtySetor || 0);
    const qtyReject = nonNegativeQty(entry?.qtyReject || 0);
    const rate = nonNegativeMoney(entry?.rate || 0);
    normalized.push({
      id: `${entry?.id || "legacy"}-legacy-setor`,
      tanggalSetor: entry?.tanggalSetor || entry?.tanggal || todayStr(),
      qtySetor,
      qtyReject,
      rate,
      totalWageSetor: Math.max(0, moneyValue(entry?.totalWageSetor ?? (qtySetor * rate) ?? 0)),
      catatan: entry?.catatanSetor || "",
      createdAt: entry?.updatedAt || entry?.createdAt || "",
    });
  }

  return normalized;
}

function setorTotals(entry) {
  const history = normalizeSetorHistory(entry);
  const qtySetor = history.reduce((s, h) => s + nonNegativeQty(h.qtySetor || 0), 0);
  const qtyReject = history.reduce((s, h) => s + nonNegativeQty(h.qtyReject || 0), 0);
  const totalWageSetor = history.reduce((s, h) => s + nonNegativeMoney(h.totalWageSetor || 0), 0);
  const qtyAwal = nonNegativeQty(entry?.qty || 0);
  const sisaSetor = Math.max(0, qtyAwal - qtySetor - qtyReject);
  const tanggalSetor = history.length > 0 ? history[history.length - 1].tanggalSetor : (entry?.tanggalSetor || "");
  const statusSetor = sisaSetor <= 0 && (qtySetor + qtyReject) > 0
    ? "sudah_setor"
    : (qtySetor + qtyReject) > 0 ? "setor_sebagian" : "belum_setor";
  return { history, qtySetor, qtyReject, totalWageSetor, sisaSetor, tanggalSetor, statusSetor };
}

function setorHistoryInRange(entry, dari, sampai) {
  return normalizeSetorHistory(entry).filter((h) => dateInRange(h.tanggalSetor || h.tanggal || "", dari, sampai));
}

function setorTotalsFromHistory(history) {
  return {
    qtySetor: (history || []).reduce((s, h) => s + nonNegativeQty(h.qtySetor || 0), 0),
    qtyReject: (history || []).reduce((s, h) => s + nonNegativeQty(h.qtyReject || 0), 0),
    totalWageSetor: (history || []).reduce((s, h) => s + nonNegativeMoney(h.totalWageSetor || 0), 0),
  };
}

function safeOrder(d) {
  // Ambil items per model dari berbagai kemungkinan field Gallery Kerudung
  let items = [];
  const rawItems = Array.isArray(d.items) && d.items.length > 0
    ? d.items
    : Array.isArray(d.products) && d.products.length > 0
      ? d.products
      : Array.isArray(d.modelItems) && d.modelItems.length > 0
        ? d.modelItems
        : [];

  if (rawItems.length > 0) {
    items = rawItems.map((it) => ({
      name: displayModelName(it.name || it.nama || it.item || it.productName || it.model || "-"),
      qty: nonNegativeQty(it.qty || it.quantity || it.jumlah || 0),
      price: nonNegativeMoney(it.price || it.harga || it.hargaJual || it.sellingPrice || it.unitPrice || it.hargaSatuan || it.hargaPcs || 0),
    })).filter((it) => it.qty > 0 || it.name !== "-");
  }

  const totalQty = nonNegativeQty(d.qty || d.quantity || d.jumlah || d.totalQty || 0);

  if (items.length === 0) {
    items = [{ name: displayModelName(d.item || d.productName || d.produk || d.product || "Pesanan"), qty: totalQty, price: nonNegativeMoney(d.hargaPcs || d.hargaJual || d.sellingPrice || d.unitPrice || d.hargaSatuan || d.price || 0) }];
  }

  return {
    id: d.id,
    customer: d.customer || d.customerName || d.nama || d.name || "-",
    item: displayModelName(d.item || d.productName || d.produk || d.product || "-"),
    qty: totalQty,
    items,
    invoice: d.invoice || d.orderId || d.kode || d.code || "",
    status: d.status || "Baru",
    createdAt: d.createdAt || d.tanggal || d.date || d.orderDate || "",
    warna: d.warna || d.color || "",
    ukuran: d.ukuran || d.size || "",
    catatan: d.catatanProduksi || d.catatan || d.note || "",
    raw: d,
  };
}


function rawOrderItemsForDelivery(order) {
  const raw = order?.raw || order || {};
  const rawItems = Array.isArray(raw.items) && raw.items.length > 0
    ? raw.items
    : Array.isArray(order?.items) && order.items.length > 0
      ? order.items
      : [{ name: order?.item || raw.item || raw.productName || "Produk", qty: order?.qty || raw.qty || 0, price: raw.hargaPcs || raw.price || 0 }];

  return rawItems.map((it, idx) => {
    const name = displayModelName(it?.name || it?.nama || it?.item || it?.productName || it?.model || order?.item || raw.item || "Produk");
    const orderedQty = nonNegativeQty(it?.qty ?? it?.quantity ?? it?.jumlah ?? order?.qty ?? raw.qty ?? 0);
    const price = nonNegativeMoney(it?.price ?? it?.harga ?? it?.hargaJual ?? it?.sellingPrice ?? it?.unitPrice ?? it?.hargaSatuan ?? it?.hargaPcs ?? raw.hargaJual ?? raw.sellingPrice ?? raw.unitPrice ?? raw.hargaSatuan ?? raw.hargaPcs ?? raw.price ?? 0);
    const hppPerPcs = nonNegativeMoney(it?.hppPerPcs ?? it?.hpp ?? it?.bahanCost ?? it?.materialCost ?? 0);
    return {
      itemIndex: idx,
      name,
      orderedQty,
      qty: orderedQty,
      price,
      bahanCost: nonNegativeMoney(it?.bahanCost ?? it?.materialCost ?? 0),
      hppPerPcs,
      mainMaterial: it?.mainMaterial || it?.materialName || it?.kain || it?.namaKain || "",
      materialQtyPerPcs: nonNegativeQty(it?.materialQtyPerPcs ?? it?.kebutuhanKainPerPcs ?? it?.kebutuhanKain ?? it?.kainPerPcs ?? 0),
      unit: it?.unit || it?.satuan || "yard",
    };
  }).filter((it) => it.name && Number(it.orderedQty || 0) > 0);
}

function hasDeliveryDetail(order) {
  const raw = order?.raw || order || {};
  return (
    (Array.isArray(raw.deliveries) && raw.deliveries.length > 0) ||
    (Array.isArray(raw.shippedItems) && raw.shippedItems.length > 0) ||
    moneyValue(raw.deliveredTotal || 0) > 0 ||
    nonNegativeQty(raw.totalKirim || raw.totalShipped || 0) > 0
  );
}

function dashboardTotalOrderedQty(order) {
  return rawOrderItemsForDelivery(order).reduce((sum, item) => sum + Number(item.orderedQty || item.qty || 0), 0);
}

function dashboardTotalShippedQty(order) {
  const raw = order?.raw || order || {};

  if (Array.isArray(raw.deliveries) && raw.deliveries.length > 0) {
    return raw.deliveries.reduce((deliverySum, delivery) => {
      return deliverySum + (delivery.items || []).reduce((itemSum, item) => {
        return itemSum + nonNegativeQty(item.qty ?? item.shippedQty ?? item.qtyKirim ?? item.sentQty ?? 0);
      }, 0);
    }, 0);
  }

  if (Array.isArray(raw.shippedItems) && raw.shippedItems.length > 0) {
    return raw.shippedItems.reduce((sum, item) => {
      return sum + nonNegativeQty(item.shippedQty ?? item.qtyKirim ?? item.qty ?? item.quantity ?? item.sentQty ?? 0);
    }, 0);
  }

  return nonNegativeQty(raw.totalKirim ?? raw.totalShipped ?? raw.shippedQty ?? raw.sentQty ?? 0);
}

function isLegacyDoneOrSentOrder(order) {
  const raw = order?.raw || order || {};
  const statusText = [
    raw.status,
    raw.deliveryStatus,
    raw.shippingStatus,
    raw.statusKirim,
    raw.statusPengiriman,
    raw.paymentStatus,
  ].map((v) => lower(v)).join(" ");

  // Legacy sync hanya boleh berjalan untuk status yang benar-benar bermakna sudah dikirim.
  // Status lunas/selesai tidak otomatis berarti barang sudah dikirim fisik.
  return (
    isSentStatus(statusText) ||
    statusText.includes("terkirim") ||
    statusText.includes("dikirim") ||
    statusText.includes("shipped")
  );
}

function shouldAutoSyncLegacyDelivery(order) {
  const raw = order?.raw || order || {};
  if (!order?.id) return false;
  if (raw.legacyDeliverySynced === true) return false;
  if (hasDeliveryDetail(order)) return false;
  if (!isLegacyDoneOrSentOrder(order)) return false;
  return rawOrderItemsForDelivery(order).reduce((s, it) => s + Number(it.orderedQty || 0), 0) > 0;
}

function buildFullDeliveryPayload(order) {
  const items = rawOrderItemsForDelivery(order);
  const syncDate = order?.raw?.tanggalKirim || order?.raw?.deliveryDate || order?.raw?.shippedAt || order?.createdAt || todayStr();
  const deliveryItems = items.map((it) => ({
    itemIndex: nonNegativeQty(it.itemIndex || 0),
    name: it.name || "Produk",
    qty: nonNegativeQty(it.orderedQty || 0),
    shippedQty: nonNegativeQty(it.orderedQty || 0),
    orderedQty: nonNegativeQty(it.orderedQty || 0),
    price: nonNegativeMoney(it.price || 0),
    bahanCost: nonNegativeMoney(it.bahanCost || 0),
    hppPerPcs: nonNegativeMoney(it.hppPerPcs || 0),
    mainMaterial: it.mainMaterial || "",
    materialQtyPerPcs: nonNegativeQty(it.materialQtyPerPcs || 0),
    unit: it.unit || "yard",
  }));

  const shippedItems = items.map((it) => ({
    name: it.name || "Produk",
    orderedQty: nonNegativeQty(it.orderedQty || 0),
    shippedQty: nonNegativeQty(it.orderedQty || 0),
    price: nonNegativeMoney(it.price || 0),
    bahanCost: nonNegativeMoney(it.bahanCost || 0),
    hppPerPcs: nonNegativeMoney(it.hppPerPcs || 0),
    mainMaterial: it.mainMaterial || "",
    materialQtyPerPcs: nonNegativeQty(it.materialQtyPerPcs || 0),
    unit: it.unit || "yard",
    note: "Sesuai pesanan",
  }));

  const deliveredTotal = shippedItems.reduce((s, it) => s + lineMoneyTotal(it.shippedQty || 0, it.price || 0), 0);
  const deliveredHppTotal = shippedItems.reduce((s, it) => s + lineMoneyTotal(it.shippedQty || 0, it.hppPerPcs || it.bahanCost || 0), 0);
  const totalShipped = shippedItems.reduce((s, it) => s + nonNegativeQty(it.shippedQty || 0), 0);
  const totalOrdered = shippedItems.reduce((s, it) => s + nonNegativeQty(it.orderedQty || 0), 0);

  const legacyDelivery = {
    date: syncDate,
    createdAt: new Date().toISOString(),
    source: "gallery-produksi-legacy-sync",
    receiver: order?.customer || order?.raw?.customer || "Customer",
    penerima: order?.customer || order?.raw?.customer || "Customer",
    courier: "Data Lama",
    ekspedisi: "Data Lama",
    note: "Auto sinkron dari status lama yang sudah dikirim/terkirim.",
    items: deliveryItems,
    total: deliveredTotal,
  };

  return {
    deliveries: [legacyDelivery],
    shippedItems,
    deliveredTotal,
    deliveredHppTotal,
    totalKirim: totalShipped,
    totalPesan: totalOrdered,
    tanggalKirim: syncDate,
    deliveryStatus: "Selesai",
    shippingStatus: "Selesai",
    status: lower(order?.raw?.status).includes("lunas") ? "Lunas" : "Dikirim",
    legacyDeliverySynced: true,
    legacyDeliverySyncedAt: todayStr(),
    legacyDeliverySyncNote: "Auto sinkron data lama dari status dikirim/terkirim",
    updatedAt: todayStr(),
  };
}

function shipmentLineItems(shipment) {
  if (Array.isArray(shipment?.deliveryItems) && shipment.deliveryItems.length > 0) return shipment.deliveryItems;
  if (Array.isArray(shipment?.items) && shipment.items.length > 0) return shipment.items;
  return [];
}

function shipmentItemsForOrder(shipment, order) {
  const items = shipmentLineItems(shipment);
  if (!order) return items;

  const orderId = String(order.id || "").trim();
  const invoice = String(order.invoice || "").trim();
  const topOrderId = String(shipment?.orderId || shipment?.pesananId || "").trim();
  const topInvoice = String(shipment?.invoice || shipment?.raw?.orderCode || shipment?.raw?.kode || "").trim();
  const orderIds = Array.isArray(shipment?.orderIds) ? shipment.orderIds.map((id) => String(id || "").trim()) : [];
  const invoices = Array.isArray(shipment?.invoices) ? shipment.invoices.map((id) => String(id || "").trim()) : [];

  const itemHasOrderIdentity = items.some((it) => it?.orderId || it?.pesananId || it?.invoice || it?.orderInvoice);
  if (itemHasOrderIdentity) {
    return items.filter((it) => {
      const itemOrderId = String(it?.orderId || it?.pesananId || "").trim();
      const itemInvoice = String(it?.invoice || it?.orderInvoice || "").trim();
      return (orderId && itemOrderId === orderId) || (invoice && itemInvoice === invoice);
    });
  }

  if (orderId && (topOrderId === orderId || orderIds.includes(orderId))) return items;
  if (invoice && (topInvoice === invoice || invoices.includes(invoice))) return items;
  return [];
}

function shipmentDeliveredQtyForOrder(order, shipmentByOrderId) {
  const rows = shipmentByOrderId?.get?.(order?.id) || [];
  return rows.reduce((sum, shipment) => {
    const items = shipmentItemsForOrder(shipment, order);
    if (items.length > 0) {
      return sum + items.reduce((itemSum, item) => itemSum + nonNegativeQty(item.qtyKirim ?? item.shippedQty ?? item.qty ?? 0), 0);
    }
    const shipmentOrderIds = Array.isArray(shipment?.orderIds) ? shipment.orderIds.map((id) => String(id || "").trim()) : [];
    const isTopLevelMatch =
      String(shipment?.orderId || shipment?.pesananId || "").trim() === String(order?.id || "").trim() ||
      shipmentOrderIds.includes(String(order?.id || "").trim()) ||
      String(shipment?.invoice || "").trim() === String(order?.invoice || "").trim();
    return isTopLevelMatch ? sum + nonNegativeQty(shipment.totalKirim ?? shipment.qty ?? shipment.raw?.qty ?? 0) : sum;
  }, 0);
}

function isOrderFullyDelivered(order, shipmentByOrderId = null) {
  const ordered = dashboardTotalOrderedQty(order);
  let shipped = dashboardTotalShippedQty(order);
  const shipmentQty = shipmentDeliveredQtyForOrder(order, shipmentByOrderId);
  if (shipmentQty > shipped) shipped = shipmentQty;
  if (!hasDeliveryDetail(order) && shipmentQty <= 0 && isLegacyDoneOrSentOrder(order) && ordered > 0 && shipped <= 0) shipped = ordered;
  return ordered > 0 && shipped >= ordered;
}

function orderHasCompletedProduction(order, produksiByOrderId, shipmentByOrderId) {
  const raw = order?.raw || order || {};
  const prod = produksiByOrderId?.get?.(order?.id);
  return (
    prod?.status === "Selesai" ||
    raw.statusProduksi === "Selesai" ||
    raw.produksiStatus === "Selesai" ||
    isShortShipmentClosed(order) ||
    isOrderFullyDelivered(order, shipmentByOrderId) ||
    isSentStatus(raw.status) ||
    isDoneStatus(raw.status) ||
    isLegacyDoneOrSentOrder(order)
  );
}

function isOrderClosedForNewWork(order, shipmentByOrderId = null) {
  const raw = order?.raw || order || {};
  const status = lower(raw.status || order?.status || "");
  if (status.includes("batal") || status.includes("cancel")) return true;
  if (status.includes("ditutup") || status.includes("closed")) return true;
  if (isShortShipmentClosed(order)) return true;
  return isOrderFullyDelivered(order, shipmentByOrderId);
}


function productionStatusRank(status) {
  const idx = PROD_STATUS.indexOf(String(status || ""));
  return idx >= 0 ? idx : 0;
}

function chooseBetterProduction(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;

  const currentRank = productionStatusRank(current.status);
  const candidateRank = productionStatusRank(candidate.status);
  if (candidateRank !== currentRank) return candidateRank > currentRank ? candidate : current;

  const currentCompleteness = [
    current.orderId,
    current.pesananId,
    current.invoice,
    current.customer,
    current.item,
    Array.isArray(current.items) && current.items.length > 0,
  ].filter(Boolean).length;
  const candidateCompleteness = [
    candidate.orderId,
    candidate.pesananId,
    candidate.invoice,
    candidate.customer,
    candidate.item,
    Array.isArray(candidate.items) && candidate.items.length > 0,
  ].filter(Boolean).length;
  if (candidateCompleteness !== currentCompleteness) return candidateCompleteness > currentCompleteness ? candidate : current;

  return String(candidate.updatedAt || candidate.createdAt || candidate.tanggalMulai || "") >= String(current.updatedAt || current.createdAt || current.tanggalMulai || "")
    ? candidate
    : current;
}

function normalizedInvoice(value) {
  return String(value || "").trim();
}

function buildProductionItemsFromOrder(order, fallbackProd = null) {
  const parsedItems = (order?.items || [])
    .filter((it) => it && it.name && it.name !== "-" && Number(it.qty || 0) > 0)
    .map((it) => ({ name: it.name || it.item || "Pesanan", qty: Number(it.qty || 0) }));
  if (parsedItems.length > 0) return parsedItems;

  const rawItems = Array.isArray(order?.raw?.items) ? order.raw.items : [];
  const mappedRawItems = rawItems
    .filter((it) => Number(it?.qty || it?.quantity || it?.jumlah || 0) > 0)
    .map((it) => ({
      name: displayModelName(it?.name || it?.item || it?.productName || it?.model || order?.item || "Pesanan"),
      qty: Number(it?.qty || it?.quantity || it?.jumlah || 0),
    }));
  if (mappedRawItems.length > 0) return mappedRawItems;

  const qty = dashboardTotalOrderedQty(order) || Number(order?.qty || fallbackProd?.qty || 0);
  return [{ name: order?.item || fallbackProd?.item || "Pesanan", qty: Number(qty || 0) }];
}

function entriesForProductionOrder(entries, prod, order) {
  const orderId = String(order?.id || prod?.orderId || prod?.pesananId || "").trim();
  const invoice = normalizedInvoice(order?.invoice || prod?.invoice || order?.raw?.invoice);
  const prodId = String(prod?.id || "").trim();
  return (entries || []).filter((entry) => {
    const entryOrderId = String(entry?.orderId || entry?.pesananId || "").trim();
    const entryInvoice = normalizedInvoice(entry?.invoice || entry?.orderInvoice);
    const entryProdId = String(entry?.produksiId || entry?.productionId || "").trim();
    return (orderId && entryOrderId === orderId) || (invoice && entryInvoice === invoice) || (prodId && entryProdId === prodId);
  });
}

function inferProductionStatusFromReality(prod, order, entries, shipmentByOrderId) {
  if (order && (isOrderClosedForNewWork(order, shipmentByOrderId) || orderHasCompletedProduction(order, new Map([[order.id, prod]]), shipmentByOrderId))) {
    return "Selesai";
  }

  const qtyPesanan = Math.max(0, Number(prod?.qty || dashboardTotalOrderedQty(order) || 0));
  const relatedEntries = entriesForProductionOrder(entries, prod, order);

  const totalGiven = (process) => relatedEntries
    .filter((e) => sameProcess(e.process, process))
    .reduce((sum, e) => sum + Number(e.qty || 0), 0);
  const totalSetor = (process) => relatedEntries
    .filter((e) => sameProcess(e.process, process))
    .reduce((sum, e) => sum + Number(setorTotals(e).qtySetor || 0), 0);

  const qcSetor = totalSetor("Pengemasan QC");
  const qcGiven = totalGiven("Pengemasan QC");
  if (qtyPesanan > 0 && qcSetor >= qtyPesanan) return "Selesai";
  if (qcGiven > 0 || qcSetor > 0) return "Pengemasan QC";

  const items = buildProductionItemsFromOrder(order, prod).filter((it) => Number(it.qty || 0) > 0);
  const jahitSetor = totalSetor("Jahit");
  const jahitGiven = totalGiven("Jahit");
  const potongSetor = totalSetor("Potong");
  const potongGiven = totalGiven("Potong");

  const allJahitModelDone = items.length > 0 && items.every((item) => {
    const modelKey = normalizeModelKey(item.name || "");
    const modelQty = Number(item.qty || 0);
    const modelSetor = relatedEntries
      .filter((e) => sameProcess(e.process, "Jahit") && normalizeModelKey(e.model || "") === modelKey)
      .reduce((sum, e) => sum + Number(setorTotals(e).qtySetor || 0), 0);
    return modelQty <= 0 || modelSetor >= modelQty;
  });

  if ((qtyPesanan > 0 && jahitSetor >= qtyPesanan) || allJahitModelDone) return "Pengemasan QC";
  if (jahitGiven > 0 || jahitSetor > 0) return "Jahit";
  if (qtyPesanan > 0 && potongSetor >= qtyPesanan) return "Jahit";
  if (potongGiven > 0 || potongSetor > 0) return "Potong";
  return "Antri";
}

function orderBaseItems(order) {
  const rawItems = Array.isArray(order?.raw?.items) && order.raw.items.length > 0
    ? order.raw.items
    : Array.isArray(order?.items) && order.items.length > 0
      ? order.items
      : [{ name: order?.item || "Produk", qty: order?.qty || 0, price: order?.raw?.hargaPcs || order?.raw?.price || 0 }];

  return rawItems.map((it, idx) => {
    const name = it.name || it.nama || it.item || it.productName || it.model || order?.item || "Produk";
    const qty = Number(it.qty ?? it.quantity ?? it.jumlah ?? order?.qty ?? 0);
    const price = Number(it.price ?? it.harga ?? it.hargaPcs ?? order?.raw?.hargaPcs ?? 0);
    return {
      itemIndex: idx,
      name,
      orderedQty: qty,
      qty,
      price,
      bahanCost: Number(it.bahanCost ?? it.materialCost ?? 0),
      hppPerPcs: Number(it.hppPerPcs ?? 0),
      mainMaterial: it.mainMaterial || it.materialName || it.kain || it.namaKain || "",
      materialQtyPerPcs: Number(it.materialQtyPerPcs ?? it.kebutuhanKainPerPcs ?? it.kebutuhanKain ?? it.kainPerPcs ?? 0),
      unit: it.unit || it.satuan || "yard",
    };
  });
}

function safeMaterial(d) {
  const name = d.namaKain || d.nama || d.name || d.materialName || d.title || d.jenis || "-";
  const satuan = d.satuan || d.unit || d.uom || "";

  let warnas = [];
  if (Array.isArray(d.warnas)) warnas = d.warnas;
  else if (Array.isArray(d.colors)) warnas = d.colors;
  else warnas = [d];

  return {
    id: d.id,
    namaKain: name,
    satuan,
    warnas: warnas.map((w) => {
      const stok = Number(w.stok ?? w.stock ?? w.qty ?? d.stok ?? d.stock ?? d.qty ?? 0);
      const dipotong = Number(w.dipotong ?? w.used ?? w.cut ?? d.dipotong ?? d.used ?? d.cut ?? 0);
      const sisa = Number(w.sisa ?? w.remaining ?? d.sisa ?? d.remaining ?? stok - dipotong);
      return {
        warna: w.warna || w.color || w.name || d.warna || d.color || "-",
        stok,
        dipotong,
        sisa,
      };
    }),
    raw: d,
  };
}

function safeShipment(d) {
  const orderRef =
    d.pesananId ||
    d.orderId ||
    d.orderDocId ||
    d.orderRef ||
    d.order_id ||
    d.pesanan ||
    "";

  const invoice =
    d.invoice ||
    d.orderCode ||
    d.code ||
    d.kode ||
    d.noOrder ||
    d.orderNumber ||
    d.orderNo ||
    "";

  const customer =
    d.customer ||
    d.customerName ||
    d.namaCustomer ||
    d.nama ||
    d.receiver ||
    d.penerima ||
    "";

  const produk =
    d.produk ||
    d.productName ||
    d.product ||
    d.item ||
    d.namaProduk ||
    d.namaBarang ||
    "";

  const qtyBase = Number(
    d.qtyKirim ??
    d.sentQty ??
    d.totalKirim ??
    d.totalQty ??
    d.qty ??
    d.quantity ??
    d.jumlah ??
    0
  );

  let items = [];
  if (Array.isArray(d.items) && d.items.length > 0) {
    items = d.items.map((x) => ({
      nama: x.nama || x.name || x.item || x.productName || produk || "-",
      qtyPesan: Number(x.qtyPesan ?? x.qtyOrder ?? x.qty ?? x.quantity ?? qtyBase ?? 0),
      qtyKirim: Number(x.qtyKirim ?? x.sentQty ?? x.qty ?? x.quantity ?? qtyBase ?? 0),
    }));
  } else if (Array.isArray(d.products) && d.products.length > 0) {
    items = d.products.map((x) => ({
      nama: x.nama || x.name || x.item || x.productName || produk || "-",
      qtyPesan: Number(x.qtyPesan ?? x.qtyOrder ?? x.qty ?? x.quantity ?? qtyBase ?? 0),
      qtyKirim: Number(x.qtyKirim ?? x.sentQty ?? x.qty ?? x.quantity ?? qtyBase ?? 0),
    }));
  } else {
    items = [{
      nama: produk || "-",
      qtyPesan: Number(d.qtyPesan ?? d.qtyOrder ?? qtyBase ?? 0),
      qtyKirim: Number(d.qtyKirim ?? d.sentQty ?? d.qty ?? d.quantity ?? qtyBase ?? 0),
    }];
  }

  const tanggalKirim =
    d.tanggalKirim ||
    d.shippedAt ||
    d.sentAt ||
    d.createdAt ||
    d.date ||
    d.tanggal ||
    "";

  return {
    id: d.id,
    pesananId: orderRef,
    orderId: orderRef,
    invoice,
    customer,
    produk,
    tanggalKirim,
    ekspedisi: d.ekspedisi || d.courier || d.kurir || d.delivery || "",
    penerima: d.penerima || d.receiver || customer || "",
    items,
    totalKirim: items.reduce((s, x) => s + Number(x.qtyKirim || 0), 0),
    raw: d,
  };
}

function Button({ children, onClick, className = "", style = {}, disabled }) {
  return (
    <button
      type="button"
      disabled={Boolean(disabled)}
      onClick={onClick}
      className={`px-4 py-3 text-white transition-all active:scale-95 shadow-sm ${className}`}
      style={{ borderRadius: 16, fontWeight: 800, opacity: disabled ? 0.55 : 1, ...style }}
    >
      {children}
    </button>
  );
}

function Input({ label, value, onChange, placeholder, type = "text", readOnly = false }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-bold" style={{ color: "#9333ea" }}>{label}</label>
      <input
        value={value}
        type={type}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-full px-4 py-3 outline-none text-base"
        style={{
          borderRadius: 14,
          border: "1.5px solid #f9a8d4",
          background: readOnly ? "#f1f5f9" : "#fdf2f8",
          color: readOnly ? "#64748b" : "#2d1b69",
        }}
      />
    </div>
  );
}

function Select({ label, value, onChange, children }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-bold" style={{ color: "#9333ea" }}>{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-3 outline-none text-base"
        style={{
          borderRadius: 14,
          border: "1.5px solid #f9a8d4",
          background: "#fdf2f8",
          color: "#2d1b69",
        }}
      >
        {children}
      </select>
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.25)" }}>
      <motion.div
        initial={{ y: 80 }}
        animate={{ y: 0 }}
        className="max-h-[92vh] w-full overflow-auto p-5"
        style={{ background: "white", borderRadius: "32px 32px 0 0", borderTop: "3px solid #f9a8d4" }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold" style={{ color: "#ec4899" }}>{title}</h2>
          <button
            onClick={onClose}
            className="rounded-2xl px-4 py-2 text-base font-semibold"
            style={{ background: "#fdf2f8", color: "#ec4899" }}
          >
            Tutup
          </button>
        </div>
        {children}
      </motion.div>
    </div>
  );
}


function Card({ children, className = "", style = {}, onClick }) {
  return (
    <div
      onClick={onClick}
      className={`rounded-3xl bg-white p-4 shadow-sm ${className}`}
      style={{ border: "1px solid #fce7f3", ...style }}
    >
      {children}
    </div>
  );
}

function GlobalReadableStyle() {
  return (
    <style>{`
      html { -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
      body { color: #0f172a; }
      button, input, select, textarea { font-size: 16px; }
      input::placeholder, textarea::placeholder { color: #64748b; opacity: 1; }
      .text-\[10px\] { font-size: 12px !important; line-height: 1.35 !important; }
      .text-\[11px\] { font-size: 12.5px !important; line-height: 1.4 !important; }
      .text-xs { font-size: 13px !important; line-height: 1.45 !important; }
      .text-sm { font-size: 15px !important; line-height: 1.5 !important; }
      .shadow-sm { box-shadow: 0 6px 18px rgba(148, 163, 184, 0.14) !important; }
    `}</style>
  );
}

function StatusBadge({ status }) {
  const s = PROD_COLORS[status] || { bg: "#f1f5f9", text: "#64748b", icon: "❓" };
  return (
    <span className="rounded-full px-3 py-1 text-xs font-bold inline-flex items-center gap-1" style={{ background: s.bg, color: s.text }}>
      {s.icon} {status || "Antri"}
    </span>
  );
}

function ProgressBar({ status }) {
  const idx = PROD_STATUS.indexOf(status);
  const pct = idx < 0 ? 0 : Math.round(((idx + 1) / PROD_STATUS.length) * 100);
  return (
    <div className="mt-2">
      <div className="flex justify-between text-xs mb-1" style={{ color: "#a855f7" }}>
        <span>Progress</span><span className="font-bold">{pct}%</span>
      </div>
      <div className="w-full rounded-full h-2" style={{ background: "#fce7f3" }}>
        <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, background: "linear-gradient(90deg,#ec4899,#a855f7)" }} />
      </div>
    </div>
  );
}


function isOfficialGajiPayroll(row) {
  if (!row) return false;
  const amount = nonNegativeMoney(row.totalAmount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return false;

  const source = String(row.source || "").toLowerCase();
  const type = String(row.type || "").toLowerCase();

  // Marker status gajian tidak boleh ikut total gaji/pengeluaran.
  if (source === "gallery-produksi-gaji-marker") return false;
  if (type === "status_gajian_periode") return false;

  // Data baru resmi dari Gallery Produksi.
  if (type === "gaji_borongan") return true;

  // Fallback data lama sebelum field type distandarkan.
  // Tetap dibaca kalau jelas berasal dari setor borongan.
  if (source === "gallery-produksi" && (row.entryId || row.setorBatchId || row.employeeName)) return true;

  return false;
}

function officialGajiPayrollTotal(rows = []) {
  return (rows || [])
    .filter(isOfficialGajiPayroll)
    .reduce((sum, row) => sum + nonNegativeMoney(row.totalAmount || 0), 0);
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [tab, setTab] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [pesananOnlyNeedCheck, setPesananOnlyNeedCheck] = useState(false);
  const [needCheckContextId, setNeedCheckContextId] = useState("");
  const [search, setSearch] = useState("");
  const initialRekapPeriod = useMemo(() => currentSundayToSaturdayPeriod(), []);
  const [rekapDari, setRekapDari] = useState(initialRekapPeriod.dari);
  const [rekapSampai, setRekapSampai] = useState(initialRekapPeriod.sampai);
  const rekapManualPeriodRef = useRef(false);
  const [toast, setToast] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshingData, setIsRefreshingData] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [setorModal, setSetorModal] = useState(null); // entry object yang akan disetor
  const [setorForm, setSetorForm] = useState({ qtySetor: "", qtyReject: "", tanggalSetor: todayStr(), catatan: "" });
  const [editEntryModal, setEditEntryModal] = useState(null); // entry yang sedang diedit
  const [editEntryForm, setEditEntryForm] = useState({ qty: "", tanggal: "", catatan: "", model: "" });
  const [slipPreview, setSlipPreview] = useState(null); // { nama, r, dari, sampai }
  const [rekapDetailModal, setRekapDetailModal] = useState(null); // sudah | belum | total | pekerja | setor | belumSetor
  const [boronganOnlyBelumSetor, setBoronganOnlyBelumSetor] = useState(false);
  const [kasbonList, setKasbonList] = useState([]); // daftar semua kasbon pegawai dari Firestore (kasbon_pegawai)
  const [masterPekerja, setMasterPekerja] = useState([]); // daftar nama pekerja dari Gallery Kerudung (read-only)
  const [boronganOnlyOverSetor, setBoronganOnlyOverSetor] = useState(false); // filter tab borongan hanya setor melebihi diberi
  const [boronganOnlyTanpaPesanan, setBoronganOnlyTanpaPesanan] = useState(false); // filter tab borongan hanya entry tanpa pesanan
  const [produksiOnlyBelumSelesai, setProduksiOnlyBelumSelesai] = useState(false); // filter tab produksi hanya belum selesai
  const [kirimOnlyBelumLengkap, setKirimOnlyBelumLengkap] = useState(false); // filter tab kirim hanya belum lengkap
  const [alertDetailModal, setAlertDetailModal] = useState(false); // modal popup alert bermasalah dari dashboard
  const [tugasDetailModal, setTugasDetailModal] = useState(false); // modal popup semua tugas hari ini
  const [kaitkanModal, setKaitkanModal] = useState(null); // entry borongan lama/tanpa pesanan yang akan dikaitkan
  const [kaitkanOrderId, setKaitkanOrderId] = useState(""); // pesanan target untuk kaitkan borongan
  const slipRef = useRef(null);
  const backUiRef = useRef({});
  const lastBackPressRef = useRef(0);
  const toastTimerRef = useRef(null);

  // Helper toast yang aman: selalu clear timer sebelumnya sehingga toast tidak
  // tumpang tindih, dan tidak ada timer menggantung di memori (penting di HP).
  const showToast = React.useCallback((msg, duration = 3000) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(""), duration);
  }, []);

  // Pengaman khusus tombol Simpan:
  // kalau proses simpan gagal/terputus dan isSaving tersangkut true,
  // tombol simpan dibuka lagi supaya input tidak terkunci.
  useEffect(() => {
    if (!isSaving) return undefined;
    const timer = setTimeout(() => {
      setIsSaving(false);
      showToast("⚠️ Proses simpan terlalu lama. Tombol Simpan dibuka lagi.", 3500);
    }, 30000);
    return () => clearTimeout(timer);
  }, [isSaving, showToast]);

  useEffect(() => {
    const syncAutoPeriod = () => {
      if (rekapManualPeriodRef.current) return;
      const next = currentSundayToSaturdayPeriod();
      setRekapDari((prev) => (prev === next.dari ? prev : next.dari));
      setRekapSampai((prev) => (prev === next.sampai ? prev : next.sampai));
    };

    syncAutoPeriod();
    const timer = window.setInterval(syncAutoPeriod, 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  function handleRekapDariChange(value) {
    rekapManualPeriodRef.current = true;
    setRekapDari(value);
  }

  function handleRekapSampaiChange(value) {
    rekapManualPeriodRef.current = true;
    setRekapSampai(value);
  }

  function resetRekapToCurrentWeek() {
    const next = currentSundayToSaturdayPeriod();
    rekapManualPeriodRef.current = false;
    setRekapDari(next.dari);
    setRekapSampai(next.sampai);
  }

  const [orders, setOrders] = useState([]);
  const [produksi, setProduksi] = useState([]);
  const [workRates, setWorkRates] = useState([]);
  const [productionEntries, setProductionEntries] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [shipments, setShipments] = useState([]);
  const [payrollExpenses, setPayrollExpenses] = useState([]);
  const [gajianHistory, setGajianHistory] = useState([]);
  const [showFormGajianLama, setShowFormGajianLama] = useState(false);
  const [formGajianLama, setFormGajianLama] = useState({ employeeName: "", tanggalGaji: todayStr(), periodeGajiDari: "", periodeGajiSampai: "", jumlah: "" });

  const previousOrderIdsRef = useRef(new Set());
  const firstOrderLoadRef = useRef(true);
  const legacyDeliverySyncingRef = useRef(new Set());
  const productionBackfillSyncingRef = useRef(new Set());
  const loadedDataRef = useRef(new Map()); // key -> Promise data yang sudah/sedang dimuat per sesi/tab
  // HEMAT KUOTA: flag agar backfill hanya jalan sekali per sesi.
  const legacySyncDoneRef = useRef(false);
  const itemsMigrationDoneRef = useRef(false);
  const backfillDoneRef = useRef(false);

  const [prodForm, setProdForm] = useState({ orderId: "", tanggalMulai: todayStr(), catatan: "" });
  const [rateForm, setRateForm] = useState({ productType: "Kerudung", model: "", process: "Jahit", rate: "" });
  const [entryForm, setEntryForm] = useState({
    employeeName: "",
    orderId: "",
    productType: "Kerudung",
    model: "",
    process: "Jahit",
    qty: "",
    tanggal: todayStr(),
    catatan: "",
  });
  const [entryOrderSearch, setEntryOrderSearch] = useState("");
  const [kirimForm, setKirimForm] = useState({
    pesananId: "",
    orderIds: [],
    customerKey: "",
    tanggalKirim: todayStr(),
    penerima: "",
    ekspedisi: "",
    items: [{ nama: "", qtyPesan: 0, qtyKirim: 0 }],
    shortShipmentMode: "temporary",
    shortShipmentReason: "Stok kain habis",
    shortShipmentNote: "",
    catatan: "",
  });


  const resetProdForm = React.useCallback(() => {
    setProdForm({ orderId: "", tanggalMulai: todayStr(), catatan: "" });
  }, []);

  const resetRateForm = React.useCallback(() => {
    setRateForm({ productType: "Kerudung", model: "", process: "Jahit", rate: "" });
  }, []);

  const resetEntryForm = React.useCallback(() => {
    setEntryForm({
      employeeName: "",
      orderId: "",
      productType: "Kerudung",
      model: "",
      process: "Jahit",
      qty: "",
      tanggal: todayStr(),
      catatan: "",
    });
  }, []);

  const resetKirimForm = React.useCallback(() => {
    setKirimForm({
      pesananId: "",
      orderIds: [],
      customerKey: "",
      tanggalKirim: todayStr(),
      penerima: "",
      ekspedisi: "",
      items: [{ nama: "", qtyPesan: 0, qtyKirim: 0 }],
      shortShipmentMode: "temporary",
      shortShipmentReason: "Stok kain habis",
      shortShipmentNote: "",
      catatan: "",
    });
  }, []);

  const closeMainModal = React.useCallback(() => {
    setModal(null);
    resetProdForm();
    resetRateForm();
    resetEntryForm();
    resetKirimForm();
  }, [resetProdForm, resetRateForm, resetEntryForm, resetKirimForm]);

  const closeSetorModal = React.useCallback(() => {
    setSetorModal(null);
    setSetorForm({ qtySetor: "", qtyReject: "", tanggalSetor: todayStr(), catatan: "" });
  }, []);

  const closeEditEntryModal = React.useCallback(() => {
    setEditEntryModal(null);
    setEditEntryForm({ qty: "", tanggal: "", catatan: "", model: "" });
  }, []);

  const cacheStorageKey = React.useCallback((key) => {
    const uid = user?.uid || "anon";
    return `gallery-produksi:${FIRESTORE_CACHE_VERSION}:${uid}:${key}`;
  }, [user?.uid]);

  const readCachedData = React.useCallback((key) => {
    if (!canUseLocalStorage()) return null;
    const payload = safeReadJson(window.localStorage.getItem(cacheStorageKey(key)), null);
    if (!payload || !Array.isArray(payload.data)) return null;
    if (Date.now() - Number(payload.savedAt || 0) > FIRESTORE_CACHE_TTL_MS) return null;
    return payload.data;
  }, [cacheStorageKey]);

  const writeCachedData = React.useCallback((key, data) => {
    if (!canUseLocalStorage() || !Array.isArray(data)) return;
    try {
      window.localStorage.setItem(cacheStorageKey(key), JSON.stringify({ savedAt: Date.now(), data }));
    } catch (e) {
      console.warn("Cache localStorage penuh/tidak tersedia:", e);
    }
  }, [cacheStorageKey]);

  const applyCachedData = React.useCallback((key) => {
    const cached = readCachedData(key);
    if (!cached) return null;

    if (key === "orders") {
      setOrders(cached);
      previousOrderIdsRef.current = new Set(cached.map((x) => x.id));
      firstOrderLoadRef.current = false;
    } else if (key === "produksi") {
      setProduksi(cached);
    } else if (key === "production_entries") {
      setProductionEntries(cached);
    } else if (key === "work_rates") {
      setWorkRates(cached);
    } else if (key === "master_pekerja") {
      setMasterPekerja(cached);
    } else if (key === "shipments") {
      setShipments(cached);
    } else if (key === "kasbon") {
      setKasbonList(cached);
    } else if (key === "materials") {
      setMaterials(cached);
    } else if (key === "payroll_expenses") {
      setPayrollExpenses(cached);
    } else if (key === "gajian_history") {
      setGajianHistory(cached);
    } else {
      return null;
    }

    return cached;
  }, [readCachedData]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u || null);
      setAuthLoading(false);
    });
    return () => unsub();
  }, []);

  // ── Refresh helpers (getDocs manual) ──────────────────────────────────────
  // HEMAT KUOTA: tidak memakai onSnapshot realtime untuk collection besar.
  // Data dimuat sekali saat app dibuka / saat tab terkait dibuka, lalu di-refresh manual setelah write.
  const refreshOrders = React.useCallback(() => {
    return getDocs(collection(db, C.ORDERS)).then((snap) => {
      const list = snap.docs.map((d) => safeOrder({ id: d.id, ...d.data() }));
      setOrders(list);
      writeCachedData("orders", list);
      previousOrderIdsRef.current = new Set(list.map((x) => x.id));
      firstOrderLoadRef.current = false;
      return list;
    });
  }, [writeCachedData]);

  const refreshProduksi = React.useCallback(() => {
    return getDocs(collection(db, C.PRODUKSI)).then((snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setProduksi(list);
      writeCachedData("produksi", list);
      return list;
    });
  }, [writeCachedData]);

  const refreshProductionEntries = React.useCallback(() => {
    return getDocs(collection(db, C.PRODUCTION_ENTRIES)).then((snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setProductionEntries(list);
      writeCachedData("production_entries", list);
      return list;
    });
  }, [writeCachedData]);

  const refreshWorkRates = React.useCallback(() => {
    return getDocs(collection(db, C.WORK_RATES)).then((snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setWorkRates(list);
      writeCachedData("work_rates", list);
      return list;
    });
  }, [writeCachedData]);

  const refreshMasterPekerja = React.useCallback(() => {
    return getDocs(collection(db, "master_pekerja")).then((snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setMasterPekerja(list);
      writeCachedData("master_pekerja", list);
      return list;
    });
  }, [writeCachedData]);

  const refreshShipments = React.useCallback(() => {
    return getDocs(collection(db, C.SHIPMENTS)).then((snap) => {
      const list = snap.docs.map((d) => safeShipment({ id: d.id, ...d.data() }));
      setShipments(list);
      writeCachedData("shipments", list);
      return list;
    });
  }, [writeCachedData]);

  const refreshKasbon = React.useCallback(() => {
    return getDocs(collection(db, C.KASBON)).then((snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setKasbonList(list);
      writeCachedData("kasbon", list);
      return list;
    });
  }, [writeCachedData]);

  const refreshMaterials = React.useCallback(() => {
    return getDocs(collection(db, C.MATERIALS)).then((snap) => {
      const list = snap.docs.map((d) => safeMaterial({ id: d.id, ...d.data() }));
      setMaterials(list);
      writeCachedData("materials", list);
      return list;
    });
  }, [writeCachedData]);

  const refreshPayroll = React.useCallback(() => {
    return getDocs(collection(db, C.PAYROLL_EXPENSES)).then((snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setPayrollExpenses(list);
      writeCachedData("payroll_expenses", list);
      return list;
    });
  }, [writeCachedData]);

  const refreshGajianHistory = React.useCallback(() => {
    return getDocs(collection(db, C.GAJIAN_HISTORY)).then((snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setGajianHistory(list);
      writeCachedData("gajian_history", list);
      return list;
    });
  }, [writeCachedData]);

  const loadOnce = React.useCallback((key, loader) => {
    if (loadedDataRef.current.has(key)) return loadedDataRef.current.get(key);

    const cached = applyCachedData(key);
    if (cached) {
      const cachedPromise = Promise.resolve(cached);
      loadedDataRef.current.set(key, cachedPromise);
      return cachedPromise;
    }

    const loadPromise = Promise.resolve(loader()).catch((e) => {
      loadedDataRef.current.delete(key);
      throw e;
    });

    loadedDataRef.current.set(key, loadPromise);
    return loadPromise;
  }, [applyCachedData]);

  const refreshDataSaatIni = React.useCallback(async () => {
    if (!user || isRefreshingData) return;
    setIsRefreshingData(true);

    const forceRefresh = async (key, loader) => {
      const result = await loader();
      loadedDataRef.current.set(key, Promise.resolve(result));
      return result;
    };

    try {
      const jobs = [
        forceRefresh("orders", refreshOrders),
        forceRefresh("produksi", refreshProduksi),
        forceRefresh("production_entries", refreshProductionEntries),
      ];

      if (["dashboard", "pesanan", "produksi", "kirim"].includes(tab)) {
        jobs.push(forceRefresh("shipments", refreshShipments));
      }

      if (["borongan", "tarif"].includes(tab)) {
        jobs.push(forceRefresh("work_rates", refreshWorkRates));
      }

      if (tab === "borongan") {
        jobs.push(forceRefresh("master_pekerja", refreshMasterPekerja));
      }

      if (["kain", "tarif", "rekap"].includes(tab)) {
        jobs.push(forceRefresh("materials", refreshMaterials));
      }

      if (tab === "rekap") {
        jobs.push(
          forceRefresh("payroll_expenses", refreshPayroll),
          forceRefresh("gajian_history", refreshGajianHistory),
          forceRefresh("kasbon", refreshKasbon)
        );
      }

      await Promise.all(jobs);
      showToast("✅ Data sudah diperbarui", 2200);
    } catch (e) {
      console.warn("Gagal refresh data:", e);
      showToast("⚠️ Gagal refresh data. Coba lagi.", 3500);
    } finally {
      setIsRefreshingData(false);
    }
  }, [
    user,
    tab,
    isRefreshingData,
    refreshOrders,
    refreshProduksi,
    refreshProductionEntries,
    refreshShipments,
    refreshWorkRates,
    refreshMasterPekerja,
    refreshMaterials,
    refreshPayroll,
    refreshGajianHistory,
    refreshKasbon,
    showToast,
  ]);

  useEffect(() => {
    backUiRef.current = {
      tab,
      modal,
      confirmDelete,
      setorModal,
      editEntryModal,
      slipPreview,
      rekapDetailModal,
      tugasDetailModal,
      alertDetailModal,
      kaitkanModal,
      search,
    };
  });

  useEffect(() => {
    if (!user || typeof window === "undefined") return;

    const pushGuardState = () => {
      window.history.pushState({ galleryProduksiBackGuard: true }, "", window.location.href);
    };

    pushGuardState();

    const closeTopLayer = () => {
      const ui = backUiRef.current || {};
      if (ui.confirmDelete) { setConfirmDelete(null); return true; }
      if (ui.setorModal) { closeSetorModal(); return true; }
      if (ui.editEntryModal) { closeEditEntryModal(); return true; }
      if (ui.slipPreview) { setSlipPreview(null); return true; }
      if (ui.rekapDetailModal) { setRekapDetailModal(null); return true; }
      if (ui.tugasDetailModal) { setTugasDetailModal(false); return true; }
      if (ui.alertDetailModal) { setAlertDetailModal(false); return true; }
      if (ui.kaitkanModal) { setKaitkanModal(null); setKaitkanOrderId(""); return true; }
      if (ui.modal) { closeMainModal(); return true; }
      if (ui.search) { setSearch(""); return true; }
      if (ui.tab && ui.tab !== "dashboard") { setTab("dashboard"); return true; }
      return false;
    };

    const onPopState = () => {
      if (closeTopLayer()) {
        pushGuardState();
        return;
      }

      const now = Date.now();
      if (now - lastBackPressRef.current < 1600) {
        window.removeEventListener("popstate", onPopState);
        window.history.back();
        return;
      }

      lastBackPressRef.current = now;
      showToast("Tekan tombol back sekali lagi untuk keluar", 1600);
      pushGuardState();
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [user, closeMainModal, closeSetorModal, closeEditEntryModal, showToast]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    (async () => {
      try {
        // Core data yang dibutuhkan agar dashboard/menu utama tetap berjalan.
        // Semua getDocs sekali jalan, tidak realtime listener, supaya tidak boros reads.
        await Promise.all([
          loadOnce("orders", refreshOrders),
          loadOnce("produksi", refreshProduksi),
          loadOnce("production_entries", refreshProductionEntries),
          loadOnce("work_rates", refreshWorkRates),
          loadOnce("master_pekerja", refreshMasterPekerja),
          loadOnce("shipments", refreshShipments),
        ]);
      } catch (e) {
        if (!cancelled) {
          console.warn("Gagal memuat data awal:", e);
          showToast("⚠️ Gagal memuat sebagian data. Coba refresh aplikasi.", 4000);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [user, loadOnce, refreshOrders, refreshProduksi, refreshProductionEntries, refreshWorkRates, refreshMasterPekerja, refreshShipments, showToast]);

  useEffect(() => {
    if (!user) return;

    // Lazy load: data berat hanya dimuat ketika tab yang membutuhkan dibuka.
    if (tab === "kain" || tab === "tarif") {
      loadOnce("materials", refreshMaterials).catch((e) => console.warn("Gagal memuat kain:", e));
      loadOnce("work_rates", refreshWorkRates).catch((e) => console.warn("Gagal memuat tarif:", e));
    }

    if (tab === "borongan") {
      loadOnce("work_rates", refreshWorkRates).catch((e) => console.warn("Gagal memuat tarif:", e));
      loadOnce("master_pekerja", refreshMasterPekerja).catch((e) => console.warn("Gagal memuat pekerja:", e));
    }

    if (tab === "kirim") {
      loadOnce("shipments", refreshShipments).catch((e) => console.warn("Gagal memuat pengiriman:", e));
    }

    if (tab === "rekap") {
      loadOnce("payroll_expenses", refreshPayroll).catch((e) => console.warn("Gagal memuat payroll:", e));
      loadOnce("gajian_history", refreshGajianHistory).catch((e) => console.warn("Gagal memuat gajian:", e));
      loadOnce("kasbon", refreshKasbon).catch((e) => console.warn("Gagal memuat kasbon:", e));
      loadOnce("materials", refreshMaterials).catch((e) => console.warn("Gagal memuat kain:", e));
    }
  }, [user, tab, loadOnce, refreshMaterials, refreshWorkRates, refreshMasterPekerja, refreshShipments, refreshPayroll, refreshGajianHistory, refreshKasbon]);

  // Auto sinkron data lama yang aman: hanya order lama yang benar-benar sudah dikirim/terkirim
  // tetapi belum punya deliveries/shippedItems akan dianggap terkirim penuh.
  // Ini mencegah pesanan lama muncul lagi sebagai belum dikirim / belum produksi.
  useEffect(() => {
    if (!ENABLE_AUTO_BACKFILL) return;
    if (!user || orders.length === 0) return;
    // HEMAT KUOTA: sudah selesai di sesi ini, skip.
    if (legacySyncDoneRef.current) return;
    const candidates = orders.filter((o) => shouldAutoSyncLegacyDelivery(o));
    if (candidates.length === 0) { legacySyncDoneRef.current = true; return; }

    // Proses secara sequential (bukan paralel forEach async) agar tidak membanjiri Firestore quota.
    // Batasi 5 per run jika backfill manual dinyalakan lagi.
    (async () => {
      const batch = candidates.slice(0, 5);
      for (const order of batch) {
        if (legacyDeliverySyncingRef.current.has(order.id)) continue;
        legacyDeliverySyncingRef.current.add(order.id);
        try {
          // Baca snapshot terbaru dari Firestore sebelum update, agar tidak
          // double-fire jika useEffect dipanggil lagi sebelum Firestore selesai update.
          await runTransaction(db, async (transaction) => {
            const orderRef = doc(db, C.ORDERS, order.id);
            const snap = await transaction.get(orderRef);
            if (!snap.exists()) return;
            const live = snap.data();
            // Jika sudah ter-sync (oleh proses lain atau trigger sebelumnya), skip
            if (live.legacyDeliverySynced === true) return;
            if (Array.isArray(live.deliveries) && live.deliveries.length > 0) return;
            transaction.update(orderRef, buildFullDeliveryPayload(order));
          });
        } catch (e) {
          console.warn("Auto sinkron pengiriman data lama gagal:", order.invoice || order.id, e);
        } finally {
          legacyDeliverySyncingRef.current.delete(order.id);
        }
      }
    })();
  }, [user, orders]);

  // Migrasi otomatis: isi field `items` per model untuk produksi lama yang hanya punya qty total.
  // Matching tidak hanya lewat orderId, tapi juga invoice agar data manual lama tetap tersambung.
  useEffect(() => {
    if (!ENABLE_AUTO_BACKFILL) return;
    if (produksi.length === 0 || orders.length === 0) return;
    // HEMAT KUOTA: sudah selesai di sesi ini, skip.
    if (itemsMigrationDoneRef.current) return;
    const orderById = new Map(orders.map((o) => [String(o.id || "").trim(), o]));
    const orderByInvoice = new Map();
    orders.forEach((o) => {
      const inv = normalizedInvoice(o.invoice || o.raw?.invoice);
      if (inv) orderByInvoice.set(inv, o);
    });

    const needsMigration = produksi.filter((p) => {
      const order = orderById.get(String(p.orderId || p.pesananId || "").trim()) || orderByInvoice.get(normalizedInvoice(p.invoice));
      if (!order) return false;
      if (!Array.isArray(p.items) || p.items.length === 0) return true;
      if (p.items.length === 1 && Number(p.items[0].qty) === Number(p.qty)) {
        if (order && Array.isArray(order.items) && order.items.length > 1) return true;
      }
      return false;
    });
    if (needsMigration.length === 0) { itemsMigrationDoneRef.current = true; return; }

    (async () => {
      for (const p of needsMigration.slice(0, 8)) {
        const order = orderById.get(String(p.orderId || p.pesananId || "").trim()) || orderByInvoice.get(normalizedInvoice(p.invoice));
        if (!order) continue;
        const key = `items-${p.id}`;
        if (productionBackfillSyncingRef.current.has(key)) continue;
        productionBackfillSyncingRef.current.add(key);
        try {
          await updateDoc(doc(db, C.PRODUKSI, p.id), {
            items: buildProductionItemsFromOrder(order, p),
            orderId: p.orderId || order.id,
            invoice: p.invoice || order.invoice || "",
            updatedAt: todayStr(),
          });
        } catch (_) {
        } finally {
          productionBackfillSyncingRef.current.delete(key);
        }
      }
    })();
  }, [produksi, orders]);

  // PERFORMA: debounce search 250ms agar tidak filter ulang semua data
  // setiap ketukan keyboard — terasa nyata di HP dengan data banyak.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const q = debouncedSearch.toLowerCase();

  const produksiByOrderId = useMemo(() => {
    // Matching produksi harus tahan data lama: orderId, pesananId, dan invoice.
    // Jika ada duplikat, pilih dokumen yang paling maju/lengkap, bukan asal dokumen terakhir.
    const orderByInvoice = new Map();
    orders.forEach((o) => {
      const inv = normalizedInvoice(o.invoice || o.raw?.invoice);
      if (inv) orderByInvoice.set(inv, o);
    });

    const map = new Map();
    produksi.forEach((p) => {
      const matchedOrderIds = new Set();
      const directId = String(p.orderId || p.pesananId || "").trim();
      if (directId) matchedOrderIds.add(directId);
      const byInvoice = orderByInvoice.get(normalizedInvoice(p.invoice || p.orderInvoice || p.kode || p.code));
      if (byInvoice?.id) matchedOrderIds.add(byInvoice.id);

      matchedOrderIds.forEach((orderId) => {
        map.set(orderId, chooseBetterProduction(map.get(orderId), p));
      });
    });
    return map;
  }, [produksi, orders]);

  const shipmentByOrderId = useMemo(() => {
    // Bangun index orders terlebih dahulu (O(n)) sebelum loop shipments,
    // sehingga pencocokan keseluruhan menjadi O(n+m) bukan O(n*m).
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const orderByInvoice = new Map();
    orders.forEach((o) => {
      const inv = normalizedInvoice(o.invoice || o.raw?.invoice);
      if (inv) orderByInvoice.set(inv, o);
    });

    const map = new Map();
    shipments.forEach((p) => {
      const candidates = new Set();

      // Cari lewat ID langsung, termasuk format nota kirim gabungan.
      const directIds = [p.pesananId, p.orderId, ...(Array.isArray(p.orderIds) ? p.orderIds : []), ...(Array.isArray(p.pesananIds) ? p.pesananIds : [])]
        .map((id) => String(id || "").trim())
        .filter(Boolean);
      directIds.forEach((id) => {
        const found = orderById.get(id);
        if (found) candidates.add(found);
      });

      // Cari lewat invoice, termasuk invoice dalam items/orders nota gabungan.
      const invoiceKeys = [p.invoice, p.raw?.orderCode, p.raw?.kode, ...(Array.isArray(p.invoices) ? p.invoices : [])]
        .map((inv) => String(inv || "").trim())
        .filter(Boolean);
      if (Array.isArray(p.orders)) {
        p.orders.forEach((row) => {
          const id = String(row?.orderId || row?.pesananId || "").trim();
          const inv = String(row?.invoice || "").trim();
          if (id && orderById.get(id)) candidates.add(orderById.get(id));
          if (inv) invoiceKeys.push(inv);
        });
      }
      shipmentLineItems(p).forEach((item) => {
        const id = String(item?.orderId || item?.pesananId || "").trim();
        const inv = String(item?.invoice || item?.orderInvoice || "").trim();
        if (id && orderById.get(id)) candidates.add(orderById.get(id));
        if (inv) invoiceKeys.push(inv);
      });
      invoiceKeys.forEach((inv) => {
        const byInv = orderByInvoice.get(inv);
        if (byInv) candidates.add(byInv);
      });

      candidates.forEach((o) => {
        const arr = map.get(o.id) || [];
        arr.push(p);
        map.set(o.id, arr);
      });
    });

    return map;
  }, [shipments, orders]);

  // Backfill dan normalisasi produksi lama.
  // Tujuan: data lama/manual tidak perlu diklik ulang satu-satu.
  // - Produksi lama tanpa orderId dilink lewat invoice.
  // - Pesanan lama tanpa dokumen produksi dibuatkan otomatis.
  // - Status produksi dihitung dari kondisi nyata: pengiriman, potong, jahit, QC/setor.
  useEffect(() => {
    if (!ENABLE_AUTO_BACKFILL) return;
    if (!user || orders.length === 0) return;
    // HEMAT KUOTA: backfill besar hanya jalan sekali per sesi.
    // Tanpa ini, backfill lama bisa memicu baca/tulis besar dan boros kuota.
    if (backfillDoneRef.current) return;

    const orderById = new Map(orders.map((o) => [String(o.id || "").trim(), o]));
    const orderByInvoice = new Map();
    orders.forEach((o) => {
      const inv = normalizedInvoice(o.invoice || o.raw?.invoice);
      if (inv) orderByInvoice.set(inv, o);
    });

    const tasks = [];

    produksi.forEach((prod) => {
      const directOrder = orderById.get(String(prod.orderId || prod.pesananId || "").trim());
      const invoiceOrder = orderByInvoice.get(normalizedInvoice(prod.invoice || prod.orderInvoice || prod.kode || prod.code));
      const order = directOrder || invoiceOrder;
      if (!order) return;

      const inferredStatus = inferProductionStatusFromReality(prod, order, productionEntries, shipmentByOrderId);
      const shouldLink = !prod.orderId || prod.orderId !== order.id || !prod.invoice;
      const shouldUpgradeStatus = productionStatusRank(inferredStatus) > productionStatusRank(prod.status);
      const shouldFixItems = !Array.isArray(prod.items) || prod.items.length === 0;

      if (shouldLink || shouldUpgradeStatus || shouldFixItems) {
        tasks.push({ type: "update", prod, order, inferredStatus, shouldLink, shouldUpgradeStatus, shouldFixItems });
      }
    });

    orders.forEach((order) => {
      if (lower(order.status).includes("batal") || lower(order.status).includes("cancel")) return;
      const existing = produksiByOrderId.get(order.id);
      if (existing) return;
      const inferredStatus = orderHasCompletedProduction(order, produksiByOrderId, shipmentByOrderId) ? "Selesai" : "Antri";
      tasks.push({ type: "create", order, inferredStatus });
    });

    if (tasks.length === 0) { backfillDoneRef.current = true; return; }

    // Sequential processing agar tidak memicu burst write ke Firestore.
    // Batasi 8 per run — sisanya diproses di run berikutnya.
    (async () => {
      for (const task of tasks.slice(0, 8)) {
        const key = task.type === "create"
          ? `create-${task.order.id}`
          : `update-${task.prod.id}-${task.inferredStatus}`;
        if (productionBackfillSyncingRef.current.has(key)) continue;
        productionBackfillSyncingRef.current.add(key);

      try {
        if (task.type === "create") {
          const order = task.order;
          const prodId = `prod_${safeDocId(order.id, "order")}`;
          const prodRef = doc(db, C.PRODUKSI, prodId);
          const orderRef = doc(db, C.ORDERS, order.id);
          const orderItems = buildProductionItemsFromOrder(order);
          await runTransaction(db, async (transaction) => {
            const prodSnap = await transaction.get(prodRef);
            const orderSnap = await transaction.get(orderRef);
            if (!orderSnap.exists()) return;
            if (!prodSnap.exists()) {
              transaction.set(prodRef, {
                orderId: order.id,
                invoice: order.invoice || "",
                customer: order.customer || "-",
                item: order.item || orderItems[0]?.name || "Pesanan",
                qty: dashboardTotalOrderedQty(order),
                items: orderItems,
                warna: order.warna || "",
                ukuran: order.ukuran || "",
                status: task.inferredStatus,
                workers: [],
                tanggalMulai: order.createdAt || todayStr(),
                catatan: task.inferredStatus === "Selesai" ? "Backfill otomatis: pesanan lama sudah selesai/dikirim." : "Backfill otomatis: pesanan lama masuk antrian produksi.",
                source: "gallery-produksi-auto-backfill",
                createdAt: todayStr(),
                updatedAt: todayStr(),
                history: [{ tanggal: todayStr(), status: task.inferredStatus, catatan: "Backfill otomatis dari data pesanan lama" }],
              });
            }
            const liveOrder = orderSnap.data();
            transaction.update(orderRef, {
              statusProduksi: task.inferredStatus,
              produksiStatus: task.inferredStatus,
              produksiSource: "gallery-produksi-auto-backfill",
              produksiUpdatedAt: todayStr(),
              ...(isSentStatus(liveOrder?.status) || lower(liveOrder?.status) === "lunas" || lower(liveOrder?.status).includes("batal") || lower(liveOrder?.status).includes("ditutup")
                ? {}
                : { status: task.inferredStatus === "Selesai" ? "Selesai Produksi" : "Proses" }),
              updatedAt: todayStr(),
            });
          });
        } else {
          const { prod, order, inferredStatus, shouldLink, shouldUpgradeStatus, shouldFixItems } = task;
          const prodRef = doc(db, C.PRODUKSI, prod.id);
          const orderRef = doc(db, C.ORDERS, order.id);
          await runTransaction(db, async (transaction) => {
            const prodSnap = await transaction.get(prodRef);
            const orderSnap = await transaction.get(orderRef);
            if (!prodSnap.exists() || !orderSnap.exists()) return;
            const liveProd = prodSnap.data();
            const liveOrder = orderSnap.data();
            const nextStatus = productionStatusRank(inferredStatus) > productionStatusRank(liveProd.status) ? inferredStatus : liveProd.status || "Antri";
            const prodPatch = { updatedAt: todayStr() };
            if (shouldLink) {
              prodPatch.orderId = order.id;
              prodPatch.invoice = liveProd.invoice || order.invoice || "";
              prodPatch.customer = liveProd.customer || order.customer || "-";
            }
            if (shouldFixItems) prodPatch.items = buildProductionItemsFromOrder(order, liveProd);
            if (shouldUpgradeStatus && nextStatus !== liveProd.status) {
              prodPatch.status = nextStatus;
              prodPatch.history = [
                ...(Array.isArray(liveProd.history) ? liveProd.history : []),
                { tanggal: todayStr(), status: nextStatus, catatan: "Status otomatis dihitung ulang dari data lama/pengiriman/setor" },
              ];
            }
            transaction.update(prodRef, prodPatch);
            transaction.update(orderRef, {
              statusProduksi: nextStatus,
              produksiStatus: nextStatus,
              produksiSource: "gallery-produksi-auto-backfill",
              produksiUpdatedAt: todayStr(),
              ...(isSentStatus(liveOrder?.status) || lower(liveOrder?.status) === "lunas" || lower(liveOrder?.status).includes("batal") || lower(liveOrder?.status).includes("ditutup")
                ? {}
                : nextStatus === "Selesai" ? { status: "Selesai Produksi" } : { status: "Proses" }),
              updatedAt: todayStr(),
            });
          });
        }
        } catch (e) {
          console.warn("Backfill/normalisasi produksi gagal:", task.order?.invoice || task.prod?.invoice || task.prod?.id, e);
        } finally {
          productionBackfillSyncingRef.current.delete(key);
        }
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, orders, produksi, productionEntries]);
  // SENGAJA: produksiByOrderId dan shipmentByOrderId tidak masuk dependency.
  // Keduanya adalah useMemo derivasi dari produksi/orders yang sudah ada di atas.
  // Jika dimasukkan, setiap kali Map dibuat ulang (setiap render) effect akan re-run
  // → memicu write Firestore → state berubah → loop tak berujung.

  function orderSmallStatus(order) {
    const kirim = shipmentByOrderId.get(order.id);
    const prod = produksiByOrderId.get(order.id);

    if ((kirim && kirim.length > 0) || hasDeliveryDetail(order) || isSentStatus(order.status)) return { label: "🚚 Sudah dikirim", color: "#2563eb" };
    if (prod) {
      if (prod.status === "Selesai") return { label: "✅ Selesai produksi", color: "#16a34a" };
      return { label: "🧵 Sedang produksi", color: "#7c3aed" };
    }
    if (isDoneStatus(order.status)) return { label: "✅ Selesai di Gallery Kerudung", color: "#16a34a" };
    return { label: "⚠ Belum masuk produksi", color: "#d97706" };
  }

  const filteredOrders = useMemo(() => {
    const isBelumProduksi = (o) => {
      const alreadyInProduction = produksiByOrderId.has(o.id);
      const finishedOrDelivered = orderHasCompletedProduction(o, produksiByOrderId, shipmentByOrderId);
      return !alreadyInProduction && !finishedOrDelivered;
    };

    return orders
      .filter((o) => {
        const txt = `${o.customer} ${o.item} ${o.invoice} ${o.status} ${o.warna}`.toLowerCase();
        return q === "" || txt.includes(q);
      })
      .sort((a, b) => {
        const aBelum = isBelumProduksi(a) ? 0 : 1;
        const bBelum = isBelumProduksi(b) ? 0 : 1;
        // Belum produksi naik ke atas
        if (aBelum !== bBelum) return aBelum - bBelum;
        // Dalam grup yang sama: terbaru di atas (descending)
        return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
      });
  }, [orders, q, produksiByOrderId, shipmentByOrderId]);

  const ordersBelumProduksi = useMemo(() => {
    return orders.filter((o) => {
      if (isOrderClosedForNewWork(o, shipmentByOrderId)) return false;
      const alreadyInProduction = produksiByOrderId.has(o.id);
      const finishedOrDelivered = orderHasCompletedProduction(o, produksiByOrderId, shipmentByOrderId);
      return !alreadyInProduction && !finishedOrDelivered;
    });
  }, [orders, produksiByOrderId, shipmentByOrderId]);

  const ordersForBoronganLinkAll = useMemo(() => {
    return orders
      .filter((o) => !isOrderClosedForNewWork(o, shipmentByOrderId))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }, [orders, shipmentByOrderId]);

  const productionQtyIndex = useMemo(() => {
    const byOrderProcess = new Map();
    const byOrderProcessModel = new Map();

    productionEntries.forEach((e) => {
      const orderId = String(e.orderId || "").trim();
      if (!orderId) return;
      const processKey = normalizeProcessKey(e.process || "");
      const modelKey = normalizeModelKey(e.model || "");
      const qty = Number(e.qty || 0);

      const processMapKey = `${orderId}||${processKey}`;
      byOrderProcess.set(processMapKey, (byOrderProcess.get(processMapKey) || 0) + qty);

      if (modelKey) {
        const modelMapKey = `${orderId}||${processKey}||${modelKey}`;
        byOrderProcessModel.set(modelMapKey, (byOrderProcessModel.get(modelMapKey) || 0) + qty);
      }
    });

    return { byOrderProcess, byOrderProcessModel };
  }, [productionEntries]);

  const ordersForBoronganLink = useMemo(() => {
    const qRaw = entryOrderSearch.trim();
    const q = normalizeMasterKey(qRaw);
    const qCompact = normalizeCompactKey(qRaw);
    const modelKey = normalizeModelKey(entryForm.model || "");
    const processKey = normalizeProcessKey(entryForm.process || "");

    const scored = ordersForBoronganLinkAll.map((o) => {
      const itemNames = (o.items || []).map((it) => it.name || it.item || it.model || "").filter(Boolean);
      const text = [o.customer, o.invoice, o.orderNo, o.noOrder, o.item, o.status, ...itemNames].filter(Boolean).join(" ");
      const textKey = normalizeMasterKey(text);
      const textCompact = normalizeCompactKey(text);
      const prod = produksiByOrderId.get(o.id);
      const hasProduction = !!prod;
      const modelMatch = modelKey && itemNames.some((name) => normalizeModelKey(name) === modelKey);
      const processAlready = processQtyForOrder(o.id, processKey);
      const orderQty = dashboardTotalOrderedQty(o) || nonNegativeQty(o.qty || 0);
      const remainingProcess = Math.max(0, orderQty - processAlready);

      let score = 0;
      if (q) {
        if (textKey.includes(q)) score += 80;
        if (textCompact.includes(qCompact)) score += 60;
        if (normalizeMasterKey(o.customer || "").includes(q)) score += 40;
        if (itemNames.some((name) => normalizeMasterKey(name).includes(q))) score += 35;
      } else {
        score += 10;
      }
      if (modelMatch) score += 50;
      if (remainingProcess > 0) score += 25;
      if (hasProduction) score += 10;
      return { o, score, remainingProcess, itemNames };
    });

    return scored
      .filter((row) => !q || row.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return String(b.o.createdAt || "").localeCompare(String(a.o.createdAt || ""));
      })
      .slice(0, 8)
      .map((row) => row.o);
  }, [ordersForBoronganLinkAll, entryOrderSearch, entryForm.model, entryForm.process, produksiByOrderId, productionQtyIndex]);

  const boronganTanpaPesanan = useMemo(() => {
    const periode = getMingguIni();
    return (productionEntries || []).filter((e) => {
      const noOrder = !e.orderId && !e.pesananId;
      if (!noOrder) return false;

      // Banner Tab Kirim tidak boleh menghitung semua data legacy.
      // Yang perlu dikejar sebelum kirim adalah borongan aktif/periode berjalan.
      const tanggalEntry = e.tanggal || e.tanggalMulai || e.createdAt || e.updatedAt || "";
      const masukPeriodeBerjalan = dateInRange(tanggalEntry, periode.dari, periode.sampai);

      const proses = lower(e.process || e.proses || "");
      const prosesRelevan =
        proses.includes("potong") ||
        proses.includes("jahit") ||
        proses.includes("qc") ||
        proses.includes("pengemasan");

      const tidakDihapus = !e.deletedAt && !e.cancelledAt && e.status !== "deleted";
      return masukPeriodeBerjalan && prosesRelevan && tidakDihapus;
    });
  }, [productionEntries]);

  const boronganTanpaPesananIds = useMemo(() => {
    return new Set((boronganTanpaPesanan || []).map((e) => e.id));
  }, [boronganTanpaPesanan]);

  const ordersForShipment = useMemo(() => {
    return orders
      .filter((o) => !isOrderClosedForNewWork(o, shipmentByOrderId) && !isOrderStatusClosedForShipment(o.status))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }, [orders, shipmentByOrderId]);

  const shipmentCustomerOptions = useMemo(() => {
    const map = new Map();
    ordersForShipment.forEach((o) => {
      const key = normalizeKey(o.customer || "");
      if (!key) return;
      if (!map.has(key)) map.set(key, { key, name: o.customer, count: 0 });
      map.get(key).count += 1;
    });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [ordersForShipment]);

  const filteredProduksi = useMemo(() => {
    const statusPriority = (p) => {
      // Yang belum/sedang proses naik ke atas, Selesai turun ke bawah
      if (p.status === "Selesai") return 1;
      return 0;
    };
    return [...produksi]
      .filter((p) => {
        const txt = `${p.customer} ${p.item} ${p.invoice} ${p.status}`.toLowerCase();
        return q === "" || txt.includes(q);
      })
      .sort((a, b) => {
        const pa = statusPriority(a);
        const pb = statusPriority(b);
        if (pa !== pb) return pa - pb; // belum selesai naik ke atas
        // Dalam grup yang sama: terbaru di atas
        return String(b.tanggalMulai || b.updatedAt || b.createdAt || "").localeCompare(
          String(a.tanggalMulai || a.updatedAt || a.createdAt || "")
        );
      });
  }, [produksi, q]);

  const filteredEntries = useMemo(() => {
    const statusPriority = (e) => {
      const s = setorTotals(e).statusSetor;
      if (s === "belum_setor") return 0;
      if (s === "setor_sebagian") return 1;
      return 2; // sudah_setor
    };
    return [...productionEntries]
      .sort((a, b) => {
        const pa = statusPriority(a);
        const pb = statusPriority(b);
        if (pa !== pb) return pa - pb; // belum setor dulu
        return String(b.tanggal || "").localeCompare(String(a.tanggal || "")); // dalam grup: terbaru di atas
      })
      .filter((e) => {
        const txt = `${e.employeeName} ${e.productType} ${e.model} ${e.process} ${e.invoice}`.toLowerCase();
        return q === "" || txt.includes(q);
      });
  }, [productionEntries, q]);


  const materialUsageByName = useMemo(() => {
    const usage = {};

    orders.forEach((order) => {
      // Dipotong otomatis dari Gallery Kerudung:
      // qty pesanan x kebutuhan kain per pcs.
      // Dipakai hanya untuk order yang sudah masuk produksi / selesai / dikirim,
      // supaya order baru yang belum produksi tidak langsung mengurangi sisa kain.
      const isProductionRelated =
        produksiByOrderId.has(order.id) ||
        hasDeliveryDetail(order) ||
        isSentStatus(order.status);

      if (!isProductionRelated) return;

      orderItemsForMaterial(order).forEach((item) => {
        const materialName = item.mainMaterial;
        const qtyPerPcs = Number(item.materialQtyPerPcs || 0);
        const qtyOrder = Number(item.qty || 0);
        if (!materialName || qtyPerPcs <= 0 || qtyOrder <= 0) return;

        const key = normalizeKey(materialName);
        usage[key] = (usage[key] || 0) + qtyOrder * qtyPerPcs;
      });
    });

    return usage;
  }, [orders, produksiByOrderId]);

  const filteredMaterials = useMemo(() => {
    return materials
      .filter((k) => q === "" || `${k.namaKain} ${k.satuan}`.toLowerCase().includes(q))
      .map((k) => {
        const usage = Number(materialUsageByName[normalizeKey(k.namaKain)] || 0);
        return {
          ...k,
          warnas: (k.warnas || []).map((w, idx) => {
            const currentDipotong = Number(w.dipotong || 0);
            const autoDipotong = idx === 0 ? usage : 0;
            const dipotong = Math.max(currentDipotong, autoDipotong);
            return {
              ...w,
              dipotong,
              sisa: Number(w.stok || 0) - dipotong,
            };
          }),
        };
      });
  }, [materials, q, materialUsageByName]);

  const filteredShipments = useMemo(() => {
    const rows = [];
    const orderById = new Map(orders.map((o) => [String(o.id || "").trim(), o]));
    const orderByInvoice = new Map();
    orders.forEach((o) => {
      const inv = String(o.invoice || "").trim();
      if (inv) orderByInvoice.set(inv, o);
    });
    const orderIdsWithShipment = new Set();

    shipments.forEach((shipment) => {
      const matchedOrder =
        orderById.get(String(shipment.pesananId || "").trim()) ||
        orderById.get(String(shipment.orderId || "").trim()) ||
        orderByInvoice.get(String(shipment.invoice || "").trim()) ||
        null;
      if (matchedOrder?.id) orderIdsWithShipment.add(matchedOrder.id);
      rows.push({
        ...shipment,
        id: shipment.id,
        pesananId: shipment.pesananId || shipment.orderId || matchedOrder?.id || "",
        orderId: shipment.orderId || shipment.pesananId || matchedOrder?.id || "",
        customer: shipment.customer || matchedOrder?.customer || "-",
        produk: shipment.produk || matchedOrder?.item || "-",
        invoice: shipment.invoice || matchedOrder?.invoice || "-",
        tanggalKirim: shipment.tanggalKirim || shipment.raw?.date || matchedOrder?.createdAt || "",
        ekspedisi: shipment.ekspedisi || "",
        penerima: shipment.penerima || shipment.customer || matchedOrder?.customer || "-",
        items: Array.isArray(shipment.items) && shipment.items.length > 0
          ? shipment.items
          : [{ nama: shipment.produk || matchedOrder?.item || "-", qtyPesan: Number(matchedOrder?.qty || 0), qtyKirim: Number(shipment.totalKirim || shipment.raw?.qty || 0) }],
        totalKirim: Number(shipment.totalKirim || 0),
        sourceRow: "shipment",
      });
    });

    orders.forEach((o) => {
      if (!(isDoneStatus(o.status) || isSentStatus(o.status))) return;
      if (orderIdsWithShipment.has(o.id)) return;
      rows.push({
        id: o.id,
        pesananId: o.id,
        orderId: o.id,
        customer: o.customer || "-",
        produk: o.item || "-",
        invoice: o.invoice || "-",
        tanggalKirim:
          o.raw?.updatedAt ||
          o.raw?.completedAt ||
          o.raw?.shippedAt ||
          o.raw?.createdAt ||
          o.createdAt ||
          o.raw?.date ||
          "",
        ekspedisi: o.raw?.ekspedisi || o.raw?.courier || "",
        penerima: o.customer || "-",
        items: (o.items || []).length > 0
          ? (o.items || []).map((it) => ({ nama: it.name || o.item || "-", qtyPesan: Number(it.qty || 0), qtyKirim: Number(it.qty || 0) }))
          : [{ nama: o.item || "-", qtyPesan: Number(o.qty || 0), qtyKirim: Number(o.qty || 0) }],
        totalKirim: Number(o.qty || 0),
        raw: o.raw,
        sourceRow: "order_status",
      });
    });

    return rows
      .filter((s) => {
        const txt = `${s.customer} ${s.produk} ${s.invoice} ${s.ekspedisi}`.toLowerCase();
        return q === "" || txt.includes(q);
      })
      .sort((a, b) => String(b.tanggalKirim || "").localeCompare(String(a.tanggalKirim || "")));
  }, [shipments, orders, q]);

  const orderLookupForCards = useMemo(() => {
    const byId = new Map();
    const byInvoice = new Map();
    orders.forEach((o) => {
      const id = String(o.id || "").trim();
      if (id) byId.set(id, o);
      const inv = normalizedInvoice(o.invoice || o.raw?.invoice);
      if (inv) byInvoice.set(inv, o);
    });
    return { byId, byInvoice };
  }, [orders]);

  const ordersPerluDicek = useMemo(() => {
    return (orders || [])
      .map((order) => {
        const raw = order?.raw || {};
        const prod = produksiByOrderId.get(order.id);
        const sudahProduksi = !!prod || raw.statusProduksi || raw.produksiStatus;
        const sedangProduksi = prod && prod.status !== "Selesai";
        const selesaiProduksi = prod?.status === "Selesai" || raw.statusProduksi === "Selesai" || raw.produksiStatus === "Selesai";
        const sudahKirim = hasDeliveryDetail(order) || shipmentByOrderId.has(order.id) || isSentStatus(order.status) || isLegacyDoneOrSentOrder(order);
        const selesaiNormal = selesaiProduksi || sudahKirim || isDoneStatus(order.status);
        const belumNormal = !sudahProduksi && !selesaiNormal;
        const ordered = dashboardTotalOrderedQty(order);
        let shipped = dashboardTotalShippedQty(order);
        if (!hasDeliveryDetail(order) && isLegacyDoneOrSentOrder(order) && ordered > 0 && shipped <= 0) shipped = ordered;

        const reasons = [];
        if (isShortShipmentClosed(order)) {
          reasons.push(`Kurang kirim final${raw.shortShipmentReason ? `: ${raw.shortShipmentReason}` : ""}. Sisa tidak dihitung sebagai tanggungan aktif.`);
        }
        if (ordered <= 0) reasons.push("Qty/item pesanan kosong atau tidak terbaca.");
        if (shipped > ordered && ordered > 0) reasons.push(`Kelebihan kirim ${fmtQty(shipped - ordered)} pcs. Pastikan sudah disetujui customer karena ikut tagihan.`);
        if (shipped > 0 && shipped < ordered && !isShortShipmentClosed(order)) reasons.push(`Dikirim sebagian, sisa ${fmtQty(ordered - shipped)} pcs masih aktif.`);
        if (!belumNormal && !sedangProduksi && !selesaiNormal) reasons.push(`Status belum masuk kategori utama${order.status ? `: ${order.status}` : ""}.`);
        if (raw.deliveryStatus && !["Belum Dikirim", "Dikirim Sebagian", "Selesai", "Kelebihan Kirim", "Ditutup Kurang Kirim"].includes(raw.deliveryStatus)) {
          reasons.push(`Status pengiriman tidak umum: ${raw.deliveryStatus}.`);
        }

        if (reasons.length === 0) return null;
        return {
          id: order.id,
          customer: order.customer || raw.customer || raw.namaCustomer || "Tanpa nama",
          invoice: order.invoice || raw.invoice || raw.orderId || raw.kode || "-",
          status: order.status || raw.status || "Status kosong",
          alasan: reasons.join(" "),
        };
      })
      .filter(Boolean);
  }, [orders, produksiByOrderId, shipmentByOrderId]);

  const ordersPerluDicekIds = useMemo(() => new Set(ordersPerluDicek.map((o) => o.id)), [ordersPerluDicek]);

  const visiblePesananOrders = useMemo(() => {
    if (!pesananOnlyNeedCheck) return filteredOrders;
    return filteredOrders.filter((o) => ordersPerluDicekIds.has(o.id));
  }, [filteredOrders, pesananOnlyNeedCheck, ordersPerluDicekIds]);

  function shipmentProgressForOrder(order) {
    const baseItems = orderBaseItems(order || {});
    const deliveries = getDeliveryArray(order || {});
    return baseItems.map((base, idx) => {
      const sudahKirim = deliveries.reduce((sum, delivery) => {
        const found = (delivery.items || []).filter((di) => {
          const hasItemIndex = di.itemIndex !== undefined && di.itemIndex !== null && di.itemIndex !== "";
          if (hasItemIndex) return Number(di.itemIndex) === idx;
          return normalizeModelKey(di.name || di.nama || "") === normalizeModelKey(base.name || "");
        });
        return sum + found.reduce((itemSum, di) => itemSum + Number(di.qty ?? di.shippedQty ?? di.qtyKirim ?? 0), 0);
      }, 0);
      const qtyPesan = Number(base.orderedQty || base.qty || 0);
      const sisa = Math.max(0, qtyPesan - sudahKirim);
      const lebih = Math.max(0, sudahKirim - qtyPesan);
      return {
        orderId: order?.id || "",
        invoice: order?.invoice || "",
        customer: order?.customer || "",
        nama: base.name || order?.item || "Produk",
        qtyPesan,
        sudahKirim,
        sisa,
        lebih,
        itemIndex: idx,
      };
    });
  }

  function openPengirimanForOrder(order) {
    const items = Array.isArray(order?.items) && order.items.length > 0
      ? order.items.map((it, idx) => ({
          nama: it.name || it.item || order.item || "",
          qtyPesan: Number(it.qty || 0),
          qtyKirim: 0,
          itemIndex: idx,
        }))
      : [{ nama: order?.item || "", qtyPesan: Number(order?.qty || 0), qtyKirim: 0, itemIndex: 0 }];

    setKirimForm({
      pesananId: order?.id || "",
      orderIds: order?.id ? [order.id] : [],
      tanggalKirim: todayStr(),
      penerima: order?.customer || "",
      ekspedisi: "",
      items,
      shortShipmentMode: "temporary",
      shortShipmentReason: "Stok kain habis",
      shortShipmentNote: "",
      catatan: "",
    });
    setModal("kirim");
  }

  function openKirimSisaForOrder(order) {
    const progress = shipmentProgressForOrder(order);
    const items = progress
      .filter((it) => Number(it.sisa || 0) > 0)
      .map((it) => ({ ...it, qtyKirim: it.sisa }));
    if (items.length === 0) {
      const lebihTotal = progress.reduce((sum, it) => sum + Number(it.lebih || 0), 0);
      if (lebihTotal > 0) return alert("Pesanan ini sudah lebih kirim. Tidak ada sisa yang perlu dikirim.");
      return alert("Pesanan ini sudah tidak memiliki sisa kirim.");
    }
    setKirimForm({
      pesananId: order?.id || "",
      orderIds: order?.id ? [order.id] : [],
      customerKey: normalizeKey(order?.customer || ""),
      tanggalKirim: todayStr(),
      penerima: order?.customer || "",
      ekspedisi: "",
      items,
      shortShipmentMode: "temporary",
      shortShipmentReason: "Stok kain habis",
      shortShipmentNote: "",
      catatan: "Pengiriman sisa",
    });
    setModal("kirim");
  }

  async function closeOverDeliveryOrder(order) {
    if (!order?.id) return;
    const ordered = dashboardTotalOrderedQty(order);
    const shipped = dashboardTotalShippedQty(order);
    const lebih = Math.max(0, shipped - ordered);
    if (lebih <= 0) return alert("Pesanan ini tidak terdeteksi lebih kirim.");
    const ok = window.confirm(`Tandai lebih kirim ${fmtQty(lebih)} pcs sebagai sudah dicek dan selesai?`);
    if (!ok) return;
    setIsSaving(true);
    try {
      await updateDoc(doc(db, C.ORDERS, order.id), {
        status: "Kelebihan Kirim",
        deliveryStatus: "Kelebihan Kirim",
        shippingStatus: "Kelebihan Kirim",
        overDeliveryReviewed: true,
        overDeliveryReviewedAt: new Date().toISOString(),
        statusProduksi: "Selesai",
        produksiStatus: "Selesai",
        updatedAt: todayStr(),
      });
      await Promise.all([refreshOrders(), refreshProduksi(), refreshShipments()]);
      showToast("✅ Lebih kirim sudah ditandai dicek.", 3000);
    } catch (e) {
      alert(friendlyErrorMessage("Tandai lebih kirim", e));
    } finally {
      setIsSaving(false);
    }
  }

  const stats = useMemo(() => {
    const category = { pesanan: orders.length, belum: 0, proses: 0, selesai: 0, perluDicek: 0 };

    (orders || []).forEach((order) => {
      // perluDicek bisa overlap dengan selesai/proses/belum — hitung keduanya agar
      // total Pesanan = Belum + Sedang + Selesai + Perlu Dicek tidak tumpang-tindih.
      // Contoh: order sudah terkirim semua tapi ada kelebihan kirim → masuk selesai DAN perluDicek.
      if (ordersPerluDicekIds.has(order.id)) {
        category.perluDicek += 1;
        // TIDAK return — lanjut ke kategorisasi status utama di bawah
      }
      if (orderHasCompletedProduction(order, produksiByOrderId, shipmentByOrderId)) {
        category.selesai += 1;
      } else if (produksiByOrderId.has(order.id)) {
        category.proses += 1;
      } else {
        category.belum += 1;
      }
    });
    // Konsistensi: belum + proses + selesai == total pesanan (perluDicek adalah subset overlay)

    return {
      ...category,
      kirim: category.selesai,
      boronganPcs: productionEntries.reduce((s, e) => s + Number(e.qty || 0), 0),
      payroll: officialGajiPayrollTotal(payrollExpenses),
    };
  }, [orders, productionEntries, payrollExpenses, ordersPerluDicekIds, produksiByOrderId, shipmentByOrderId]);

  const dashboardSummary = useMemo(() => {
    const entryTotals = (productionEntries || []).map((e) => setorTotals(e));
    const totalDiberi = (productionEntries || []).reduce((sum, e) => sum + Number(e.qty || 0), 0);
    const totalSetor = entryTotals.reduce((sum, t) => sum + Number(t.qtySetor || 0), 0);
    const totalReject = entryTotals.reduce((sum, t) => sum + Number(t.qtyReject || 0), 0);
    const totalSisaSetor = entryTotals.reduce((sum, t) => sum + Number(t.sisaSetor || 0), 0);
    const gajiKeseluruhan = officialGajiPayrollTotal(payrollExpenses);
    const produksiAktif = (produksi || []).filter((p) => p.status !== "Selesai").length;
    const boronganAktif = entryTotals.filter((t) => Number(t.sisaSetor || 0) > 0).length;

    const orderQtySummary = (orders || []).reduce((acc, order) => {
      const ordered = dashboardTotalOrderedQty(order);
      let shipped = dashboardTotalShippedQty(order);

      // Data lama Gallery Kerudung sering hanya punya status Dikirim/Selesai/Lunas
      // tanpa detail deliveries/shippedItems. Untuk Dashboard, jangan hitung data lama
      // seperti itu sebagai sisa kirim. Anggap sudah terkirim penuh sambil menunggu
      // auto-sync legacy mengisi deliveries di Firestore.
      if (!hasDeliveryDetail(order) && isLegacyDoneOrSentOrder(order) && ordered > 0 && shipped <= 0) {
        shipped = ordered;
      }

      const remaining = Math.max(0, ordered - shipped);
      const over = Math.max(0, shipped - ordered);
      const shortClosed = isShortShipmentClosed(order);
      const activeRemaining = shortClosed ? 0 : remaining;
      const alreadyInProduction = produksiByOrderId.has(order.id);
      const finishedOrDelivered = orderHasCompletedProduction(order, produksiByOrderId, shipmentByOrderId);
      const belumProduksi = !alreadyInProduction && !finishedOrDelivered;
      const siapKirim = !belumProduksi && activeRemaining > 0;

      acc.pesananPcs += ordered;
      acc.terkirimPcs += shipped;
      acc.sisaKirimTotal += activeRemaining;
      acc.kelebihanKirim += over;
      if (shortClosed) acc.kurangKirimFinal += remaining;
      if (belumProduksi) acc.pcsBelumProduksi += activeRemaining;
      if (siapKirim) acc.sisaKirimSiap += activeRemaining;
      return acc;
    }, { pesananPcs: 0, terkirimPcs: 0, sisaKirimTotal: 0, sisaKirimSiap: 0, pcsBelumProduksi: 0, kelebihanKirim: 0, kurangKirimFinal: 0 });

    const bahanTotal = (materials || []).length;
    const shipmentTotal = (shipments || []).length;

    return {
      totalDiberi, totalSetor, totalReject, totalSisaSetor, gajiKeseluruhan,
      produksiAktif, boronganAktif,
      pesananPcs: orderQtySummary.pesananPcs,
      terkirimPcs: orderQtySummary.terkirimPcs,
      sisaKirim: orderQtySummary.sisaKirimSiap,
      sisaKirimTotal: orderQtySummary.sisaKirimTotal,
      pcsBelumProduksi: orderQtySummary.pcsBelumProduksi,
      kelebihanKirim: orderQtySummary.kelebihanKirim,
      kurangKirimFinal: orderQtySummary.kurangKirimFinal,
      bahanTotal, shipmentTotal,
    };
  }, [orders, produksi, productionEntries, payrollExpenses, materials, shipments, produksiByOrderId, shipmentByOrderId]);

  // PERFORMA: dashboardInsights dipecah jadi 3 useMemo terpisah dengan
  // dependencies yang lebih sempit — sehingga tidak semua bagian
  // dihitung ulang hanya karena orders berubah (padahal grafik mingguan
  // hanya butuh productionEntries), atau sebaliknya.

  // (A) Grafik mingguan — hanya butuh productionEntries
  const dashboardWeeklyRows = useMemo(() => {
    const weeklyRows = getDaftarMinggu(6).reverse().map((period) => {
      let pcsSetor = 0;
      let pcsReject = 0;
      let gaji = 0;
      (productionEntries || []).forEach((entry) => {
        const totals = setorTotalsFromHistory(setorHistoryInRange(entry, period.dari, period.sampai));
        pcsSetor += Number(totals.qtySetor || 0);
        pcsReject += Number(totals.qtyReject || 0);
        gaji += Number(totals.totalWageSetor || 0);
      });
      return { ...period, pcsSetor, pcsReject, gaji };
    });
    const maxWeeklyPcs = Math.max(1, ...weeklyRows.map((row) => Number(row.pcsSetor || 0) + Number(row.pcsReject || 0)));
    return { weeklyRows, maxWeeklyPcs };
  }, [productionEntries]);

  // (B) Top pekerja bulan ini — hanya butuh productionEntries
  const dashboardTopPekerja = useMemo(() => {
    const monthNow = new Date();
    const monthStart = localDateStr(new Date(monthNow.getFullYear(), monthNow.getMonth(), 1));
    const monthEnd = localDateStr(new Date(monthNow.getFullYear(), monthNow.getMonth() + 1, 0));
    const workerMap = new Map();
    (productionEntries || []).forEach((entry) => {
      const history = setorHistoryInRange(entry, monthStart, monthEnd);
      if (history.length === 0) return;
      const totals = setorTotalsFromHistory(history);
      const key = normalizeWorkerNameKey(entry.employeeName);
      if (!key) return;
      const prev = workerMap.get(key) || { nama: displayWorkerName(entry.employeeName), pcs: 0, gaji: 0, transaksi: 0 };
      prev.pcs += Number(totals.qtySetor || 0);
      prev.gaji += Number(totals.totalWageSetor || 0);
      prev.transaksi += history.length;
      workerMap.set(key, prev);
    });
    const topPekerja = Array.from(workerMap.values())
      .filter((row) => row.pcs > 0 || row.gaji > 0)
      .sort((a, b) => Number(b.pcs || 0) - Number(a.pcs || 0) || Number(b.gaji || 0) - Number(a.gaji || 0))
      .slice(0, 5);
    const monthLabel = monthStart.slice(0, 7);
    return { topPekerja, monthLabel };
  }, [productionEntries]);

  const cleanDuplicateProduksi = React.useCallback(async (duplicateKey) => {
    const key = normalizedInvoice(duplicateKey);
    if (!key) return showToast("Data produksi duplikat tidak punya kode order yang jelas.", 3500);

    const rows = (produksi || []).filter((prod) => {
      const prodKey = normalizedInvoice(prod.invoice || prod.orderInvoice || prod.orderId || prod.pesananId || prod.id);
      return prodKey === key;
    });

    if (rows.length <= 1) {
      await refreshProduksi();
      return showToast("Duplikat sudah tidak ditemukan.", 3000);
    }

    const rowsWithUsage = rows.map((row) => ({
      row,
      relatedEntries: entriesForProductionOrder(productionEntries || [], row, null),
    }));

    const usedRows = rowsWithUsage.filter(({ relatedEntries }) => relatedEntries.length > 0);
    if (usedRows.length > 1) {
      setSearch(key);
      setTab("produksi");
      return showToast("Ada lebih dari 1 data produksi yang sudah dipakai borongan/setor. Cek manual, tidak dihapus otomatis.", 6000);
    }

    const keepRow = usedRows[0]?.row || rows.reduce((best, row) => chooseBetterProduction(best, row), null);
    const deletableRows = rowsWithUsage
      .filter(({ row, relatedEntries }) => row.id !== keepRow?.id && relatedEntries.length === 0)
      .map(({ row }) => row);

    if (deletableRows.length === 0) {
      setSearch(key);
      setTab("produksi");
      return showToast("Tidak ada duplikat yang aman dihapus otomatis.", 4500);
    }

    const ok = window.confirm(
      `Bersihkan ${deletableRows.length} data produksi duplikat yang belum punya borongan/setor?\n\n` +
      `Data yang sudah dipakai borongan/setor tidak akan dihapus.`
    );
    if (!ok) return;

    setIsSaving(true);
    try {
      const batch = writeBatch(db);
      deletableRows.forEach((row) => batch.delete(doc(db, C.PRODUKSI, row.id)));
      await batch.commit();
      setProduksi((prev) => (prev || []).filter((row) => !deletableRows.some((del) => del.id === row.id)));
      await refreshProduksi();
      showToast(`✅ ${deletableRows.length} produksi duplikat dibersihkan.`, 3500);
    } catch (e) {
      console.error(e);
      alert(friendlyErrorMessage("Membersihkan duplikat", e));
    } finally {
      setIsSaving(false);
    }
  }, [produksi, productionEntries, refreshProduksi, showToast]);

  // (C) Tugas hari ini & alerts — butuh orders, produksi, productionEntries
  const dashboardInsights = useMemo(() => {
    const activeBorongan = (productionEntries || [])
      .map((entry) => ({ entry, totals: setorTotals(entry) }))
      .filter(({ totals }) => Number(totals.sisaSetor || 0) > 0)
      .sort((a, b) => Number(b.totals.sisaSetor || 0) - Number(a.totals.sisaSetor || 0));

    const activeProduksi = (produksi || [])
      .filter((item) => item.status !== "Selesai")
      .sort((a, b) => String(b.tanggalMulai || b.createdAt || "").localeCompare(String(a.tanggalMulai || a.createdAt || "")));

    const kirimBelumLengkap = (orders || [])
      .map((order) => {
        const ordered = dashboardTotalOrderedQty(order);
        let shipped = dashboardTotalShippedQty(order);
        if (!hasDeliveryDetail(order) && isLegacyDoneOrSentOrder(order) && ordered > 0 && shipped <= 0) shipped = ordered;
        const sisa = isShortShipmentClosed(order) ? 0 : Math.max(0, ordered - shipped);
        return { order, ordered, shipped, sisa };
      })
      .filter(({ sisa }) => sisa > 0)
      .sort((a, b) => Number(b.sisa || 0) - Number(a.sisa || 0));

    const alerts = [];

    const productionDuplicateMap = new Map();
    (produksi || []).forEach((prod) => {
      const key = normalizedInvoice(prod.invoice || prod.orderInvoice || prod.orderId || prod.pesananId || prod.id);
      if (!key) return;
      const arr = productionDuplicateMap.get(key) || [];
      arr.push(prod);
      productionDuplicateMap.set(key, arr);
    });
    productionDuplicateMap.forEach((rows) => {
      if (rows.length <= 1) return;
      const sample = rows[0] || {};
      const duplicateKey = normalizedInvoice(sample.invoice || sample.orderInvoice || sample.orderId || sample.pesananId || sample.id);
      alerts.push({
        type: "Produksi duplikat",
        text: `${sample.customer || "Customer"} · ${sample.invoice || sample.orderId || sample.id || "-"} · ${rows.length} data produksi ditemukan`,
        tab: "produksi",
        search: sample.invoice || sample.orderId || sample.customer || "",
        duplicateKey,
      });
    });

    (productionEntries || []).forEach((entry) => {
      const totals = setorTotals(entry);
      const totalAktivitas = Number(totals.qtySetor || 0) + Number(totals.qtyReject || 0);
      const diberi = Number(entry.qty || 0);
      if (diberi > 0 && totalAktivitas > diberi) {
        alerts.push({
          type: "Setor melebihi diberi",
          text: `${displayWorkerName(entry.employeeName)} · ${entry.process || "-"} · ${displayModelName(entry.model || "-")} (${fmtQty(totalAktivitas)} dari ${fmtQty(diberi)} pcs)`,
          tab: "borongan",
          search: displayWorkerName(entry.employeeName),
        });
      }
      if (Number(entry.rate || 0) <= 0) {
        alerts.push({
          type: "Tarif kosong",
          text: `${displayWorkerName(entry.employeeName)} · ${entry.process || "-"} · ${displayModelName(entry.model || "-")}`,
          tab: "tarif",
          search: displayModelName(entry.model || ""),
        });
      }
    });

    (orders || []).forEach((order) => {
      if (dashboardTotalOrderedQty(order) <= 0) {
        alerts.push({
          type: "Order tanpa produk/qty",
          text: `${order.customer || order.raw?.customer || "Tanpa nama"} · ${order.invoice || order.raw?.invoice || order.id}`,
          tab: "pesanan",
          search: order.invoice || order.customer || "",
        });
      }
      const deliveries = Array.isArray(order.raw?.deliveries) ? order.raw.deliveries : [];
      deliveries.forEach((delivery, dIdx) => {
        const items = Array.isArray(delivery.items) ? delivery.items : [];
        items.forEach((item, iIdx) => {
          if (item && (item.itemIndex === undefined || item.itemIndex === null || item.itemIndex === "")) {
            alerts.push({
              type: "Pengiriman tanpa itemIndex",
              text: `${order.customer || "Tanpa nama"} · ${order.invoice || order.id} · kirim ${dIdx + 1}.${iIdx + 1}`,
              tab: "kirim",
              search: order.invoice || order.customer || "",
            });
          }
        });
      });
    });

    return {
      tugas: {
        boronganBelumSetor: activeBorongan.length,
        produksiBelumSelesai: activeProduksi.length,
        kirimanBelumLengkap: kirimBelumLengkap.length,
        activeBorongan: activeBorongan.slice(0, 4),
        activeProduksi: activeProduksi.slice(0, 4),
        kirimBelumLengkap: kirimBelumLengkap.slice(0, 4),
        kirimBelumLengkapAll: kirimBelumLengkap,
      },
      topPekerja: dashboardTopPekerja.topPekerja,
      alerts: alerts.slice(0, 8),
      alertCount: alerts.length,
      weeklyRows: dashboardWeeklyRows.weeklyRows,
      maxWeeklyPcs: dashboardWeeklyRows.maxWeeklyPcs,
      monthLabel: dashboardTopPekerja.monthLabel,
    };
  }, [orders, produksi, productionEntries, dashboardWeeklyRows, dashboardTopPekerja]);

  const workerNameOptions = useMemo(() => {
    const map = new Map();
    const addName = (raw) => {
      const key = normalizeWorkerNameKey(raw);
      if (!key) return;
      const display = displayWorkerName(raw);
      if (!map.has(key)) map.set(key, display);
      else if (workerDisplayScore(display) > workerDisplayScore(map.get(key))) map.set(key, display);
    };
    masterPekerja.forEach((p) => p.nama && addName(p.nama)); // dari master daftar pekerja Gallery Kerudung
    productionEntries.forEach((e) => addName(e.employeeName));
    produksi.forEach((p) => (p.workers || []).forEach((w) => addName(w.employeeName)));
    payrollExpenses.forEach((p) => addName(p.employeeName));
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
  }, [masterPekerja, productionEntries, produksi, payrollExpenses]);

  const modelNameOptions = useMemo(() => {
    const map = new Map();
    const addModel = (raw) => {
      const key = normalizeModelKey(raw);
      if (!key || key === "-") return;
      const display = displayModelName(raw);
      if (!map.has(key)) map.set(key, display);
    };
    productionEntries.forEach((e) => addModel(e.model));
    workRates.forEach((r) => addModel(r.model));
    orders.forEach((o) => (o.items || []).forEach((it) => addModel(it.name || it.item)));
    produksi.forEach((p) => (p.items || []).forEach((it) => addModel(it.name || it.item)));
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
  }, [productionEntries, workRates, orders, produksi]);



  function processQtyForOrder(orderId, process) {
    const key = `${String(orderId || "").trim()}||${normalizeProcessKey(process || "")}`;
    return Number(productionQtyIndex.byOrderProcess.get(key) || 0);
  }

  function processQtyForOrderModel(orderId, process, model, excludeEntryId = "") {
    // Untuk validasi edit, excludeEntryId tetap dihitung langsung agar tidak memasukkan entry yang sedang diedit.
    if (excludeEntryId) {
      return productionEntries
        .filter((e) =>
          e.id !== excludeEntryId &&
          e.orderId === orderId &&
          sameProcess(e.process, process) &&
          normalizeModelKey(e.model || "") === normalizeModelKey(model || "")
        )
        .reduce((sum, e) => sum + Number(e.qty || 0), 0);
    }
    const key = `${String(orderId || "").trim()}||${normalizeProcessKey(process || "")}||${normalizeModelKey(model || "")}`;
    return Number(productionQtyIndex.byOrderProcessModel.get(key) || 0);
  }

  function getOrderProcessLimit(order, process, model) {
    if (!order) return { limit: 0, label: "pesanan" };
    if (isModelSpecificProcess(process) && model) {
      const item = (order.items || []).find((it) => normalizeModelKey(it.name || it.item || "") === normalizeModelKey(model));
      if (item) return { limit: Number(item.qty || 0), label: `model ${item.name || item.item}` };
    }
    return { limit: Number(order.qty || 0), label: "pesanan" };
  }

  function chooseOrderForBorongan(order) {
    if (!order?.id) return;
    const models = getOrderItemModelOptions(order);
    const nextModel = models.length === 1 ? models[0] : (models.some((m) => normalizeModelKey(m) === normalizeModelKey(entryForm.model)) ? entryForm.model : "");
    const nextQty = nextModel
      ? String(Math.max(0, getOrderProcessLimit(order, entryForm.process, nextModel).limit - processQtyForOrderModel(order.id, entryForm.process, nextModel)) || "")
      : "";
    setEntryForm((f) => ({ ...f, orderId: order.id, model: nextModel, qty: nextQty || f.qty }));
    setEntryOrderSearch(`${order.customer || ""} ${order.invoice || order.orderNo || ""}`.trim());
  }

  function isDuplicateEntry(payload) {
    return productionEntries.some((e) =>
      normalizeWorkerNameKey(e.employeeName) === normalizeWorkerNameKey(payload.employeeName) &&
      e.orderId === payload.orderId &&
      sameProcess(e.process, payload.process) &&
      normalizeModelKey(e.model) === normalizeModelKey(payload.model) &&
      String(e.tanggal || "") === String(payload.tanggal || "")
    );
  }

function rateDocId(productType, model, process) {
  const typeKey = safeDocId(normalizeProductTypeKey(productType || "kerudung"), "type");
  const processKey = safeDocId(normalizeProcessKey(process || "proses") || lower(process || "proses"), "process");
  const modelKey = safeDocId(normalizeModelKey(model || "all"), "model");
  return `rate_${typeKey}_${processKey}_${modelKey}`;
}

  function effectiveRateValue(rawRate, employeeName) {
    const base = Number(rawRate || 0);
    if (!Number.isFinite(base) || base <= 0) return 0;
    const isKonveksi = normalizeWorkerNameKey(employeeName).includes("konveksi");
    const effective = isKonveksi ? base - KONVEKSI_RATE_DEDUCTION : base;
    return Number.isFinite(effective) ? Math.max(0, effective) : 0;
  }

  function findRate(productType, model, process) {
    const expectedId = rateDocId(productType, model, process);
    const typeKey = normalizeProductTypeKey(productType);
    const processKey = normalizeProcessKey(process);
    const modelKey = normalizeModelKey(model || "");
    const matches = workRates.filter((r) =>
      normalizeProductTypeKey(r.productType) === typeKey && normalizeProcessKey(r.process) === processKey
    );
    const exact = matches.filter((r) => normalizeModelKey(r.model || "") === modelKey);
    const fallback = matches.filter((r) => {
      const rk = normalizeModelKey(r.model || "");
      return !rk || rk === "all" || rk === "umum" || rk === typeKey;
    });
    const pool = exact.length > 0 ? exact : fallback;
    return pool.sort((a, b) => {
      if (a.id === expectedId && b.id !== expectedId) return -1;
      if (b.id === expectedId && a.id !== expectedId) return 1;
      return String(b.updatedAt || b.createdAt || b.id || "").localeCompare(String(a.updatedAt || a.createdAt || a.id || ""));
    })[0] || null;
  }

  function getRateForEmployee(productType, model, process, employeeName) {
    const rate = findRate(productType, model, process);
    if (!rate) return null;
    const effectiveRate = effectiveRateValue(rate.rate, employeeName);
    if (effectiveRate <= 0) return null;
    return { ...rate, baseRate: Number(rate.rate || 0), rate: effectiveRate };
  }

  function getOrderItemModelOptions(order) {
    const map = new Map();
    (order?.items || []).forEach((it) => {
      const raw = it?.name || it?.item || it?.model || "";
      const key = normalizeModelKey(raw);
      if (!key || key === "-") return;
      if (!map.has(key)) map.set(key, displayModelName(raw));
    });
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
  }

  function getRateModelOptions(productType, process, selectedOrder = null) {
    // Potong dan QC/Packing memakai acuan model dari Master Tarif umum.
    // Contoh: Kerudung · Potong · Kerudung.
    // Proses model-spesifik seperti Jahit memakai model/item dari pesanan terkait,
    // lalu tarifnya dicari otomatis di Master Tarif.
    if (isModelSpecificProcess(process)) {
      return getOrderItemModelOptions(selectedOrder);
    }

    const typeKey = normalizeProductTypeKey(productType);
    const processKey = normalizeProcessKey(process);
    const map = new Map();
    workRates
      .filter((r) => normalizeProductTypeKey(r.productType) === typeKey && normalizeProcessKey(r.process) === processKey)
      .forEach((r) => {
        const rawModel = normalizeModelKey(r.model || "") ? r.model : (productType || "Umum");
        const key = normalizeModelKey(rawModel || "");
        if (!key) return;
        if (!map.has(key)) map.set(key, displayModelName(rawModel));
      });
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
  }

  function getRatePreview(productType, model, process, employeeName) {
    if (!productType || !process || !model) return { status: "incomplete" };
    const rate = findRate(productType, model, process);
    if (!rate) return { status: "missing" };
    const baseRate = Number(rate.rate || 0);
    const effectiveRate = effectiveRateValue(baseRate, employeeName);
    if (!Number.isFinite(effectiveRate) || effectiveRate <= 0) return { status: "invalid", baseRate, effectiveRate };
    return { status: "found", rate, baseRate, effectiveRate };
  }

  async function addProduksi() {
    if (!prodForm.orderId) return alert("Pilih pesanan dulu");

    const order = orders.find((o) => o.id === prodForm.orderId);
    if (!order) return alert("Pesanan tidak ditemukan");
    if (produksiByOrderId.has(order.id)) return alert("Pesanan ini sudah masuk produksi");

    const orderItems = (order.items || []).length > 0
      ? order.items.map((it) => ({ name: it.name || it.item || "Pesanan", qty: Number(it.qty || 0), price: Number(it.price || 0) }))
      : [{ name: order.item || "Pesanan", qty: Number(order.qty || 0), price: 0 }];

    const prodRef = doc(db, C.PRODUKSI, `prod_${safeDocId(order.id, "order")}`);
    const orderRef = doc(db, C.ORDERS, order.id);

    setIsSaving(true);
    try {
      // Pengaman tambahan: cek langsung ke Firestore, bukan hanya state lokal.
      // Ini mencegah duplikat kalau data lokal belum refresh atau pernah ada dokumen produksi lama dengan ID berbeda.
      const existingProduksiSnap = await getDocs(query(collection(db, C.PRODUKSI), where("orderId", "==", order.id)));
      if (!existingProduksiSnap.empty) {
        await refreshProduksi();
        throw new Error("Pesanan ini sudah masuk produksi. Data produksi tidak dibuat dobel.");
      }

      await runTransaction(db, async (transaction) => {
        const prodSnap = await transaction.get(prodRef);
        if (prodSnap.exists()) throw new Error("Pesanan ini sudah masuk produksi.");

        transaction.set(prodRef, {
          orderId: order.id,
          invoice: order.invoice,
          customer: order.customer,
          item: order.item,
          qty: order.qty,
          items: orderItems,
          warna: order.warna || "",
          ukuran: order.ukuran || "",
          status: "Antri",
          workers: [],
          tanggalMulai: prodForm.tanggalMulai,
          catatan: prodForm.catatan || "",
          source: "gallery-produksi",
          createdAt: todayStr(),
          updatedAt: todayStr(),
          history: [{ tanggal: todayStr(), status: "Antri", catatan: "Masuk produksi" }],
        });

        transaction.update(orderRef, {
          statusProduksi: "Antri",
          produksiStatus: "Antri",
          produksiSource: "gallery-produksi",
          produksiUpdatedAt: todayStr(),
          status: isSentStatus(order.status) || lower(order.status) === "lunas" ? order.status : "Proses",
          updatedAt: todayStr(),
        });
      });

      await Promise.all([refreshOrders(), refreshProduksi()]);
      setProdForm({ orderId: "", tanggalMulai: todayStr(), catatan: "" });
      setModal(null);
    } catch (e) {
      alert(friendlyErrorMessage("Menyimpan produksi", e));
    } finally {
      setIsSaving(false);
    }
  }

  // Auto-update status produksi berdasarkan progress setor borongan
  // Dipanggil setelah simpanSetor berhasil
  async function autoUpdateProduksiStatus(entryUpdated, nextHistory) {
    if (!entryUpdated?.orderId) return;

    const prod = produksi.find((p) => p.orderId === entryUpdated.orderId);
    if (!prod) return;
    if (prod.status === "Selesai") return; // Sudah selesai, tidak perlu update

    // Kumpulkan semua entries untuk order ini (termasuk yang baru saja diupdate)
    const allEntries = productionEntries
      .map((e) => e.id === entryUpdated.id ? { ...e, setorHistory: nextHistory } : e)
      .filter((e) => e.orderId === entryUpdated.orderId);

    const qtyPesanan = Number(prod.qty || 0);
    if (qtyPesanan <= 0) return;

    // Hitung total setor per proses.
    // Untuk Jahit/Potong: setor dihitung per model, lalu ambil minimum progress
    // lintas model agar tidak dianggap "selesai" saat baru 1 model yang tuntas.
    const orderItems = (prod.items || []).filter((it) => Number(it.qty || 0) > 0);

    function totalSetorProcess(process) {
      return allEntries
        .filter((e) => sameProcess(e.process, process))
        .reduce((s, e) => s + setorTotals(e).qtySetor, 0);
    }

    // Untuk proses per-model: selesai jika SETIAP model sudah tersetor >= qty-nya,
    // atau jika tidak ada breakdown model → cek total saja (backward compat).
    function allModelsCompleted(process) {
      if (orderItems.length === 0) {
        return totalSetorProcess(process) >= qtyPesanan;
      }
      return orderItems.every((item) => {
        const modelQty = Number(item.qty || 0);
        if (modelQty <= 0) return true;
        const modelKey = normalizeModelKey(item.name || "");
        const modelSetor = allEntries
          .filter((e) => sameProcess(e.process, process) && normalizeModelKey(e.model || "") === modelKey)
          .reduce((s, e) => s + setorTotals(e).qtySetor, 0);
        return modelSetor >= modelQty;
      });
    }

    const totalQcSetor = totalSetorProcess("Pengemasan QC");
    const jahitSelesai = allModelsCompleted("jahit");
    const totalPotongSetor = totalSetorProcess("potong");
    const potongSelesai = totalPotongSetor >= qtyPesanan;
    const totalJahitSetor = totalSetorProcess("jahit");

    let newStatus = prod.status;
    if (totalQcSetor >= qtyPesanan) {
      newStatus = "Selesai";
    } else if (jahitSelesai) {
      newStatus = "Pengemasan QC";
    } else if (totalJahitSetor > 0) {
      newStatus = "Jahit";
    } else if (potongSelesai) {
      newStatus = "Jahit"; // Potong sudah selesai semua → lanjut ke Jahit
    } else if (totalPotongSetor > 0) {
      newStatus = "Potong";
    }

    // Hanya update jika status berubah ke yang lebih maju
    const statusOrder = ["Antri", "Potong", "Jahit", "Pengemasan QC", "Selesai"];
    const currentIdx = statusOrder.indexOf(prod.status);
    const newIdx = statusOrder.indexOf(newStatus);
    if (newIdx <= currentIdx) return; // Tidak mundurkan status

    try {
      await runTransaction(db, async (transaction) => {
        const prodRef = doc(db, C.PRODUKSI, prod.id);
        const orderRef = prod.orderId ? doc(db, C.ORDERS, prod.orderId) : null;
        const prodSnap = await transaction.get(prodRef);
        if (!prodSnap.exists()) return;

        const liveProd = { id: prodSnap.id, ...prodSnap.data() };
        const liveStatus = liveProd.status || prod.status || "Antri";
        const liveIdx = statusOrder.indexOf(liveStatus);
        if (liveIdx >= newIdx) return; // Data server sudah sama/lebih maju, jangan overwrite.

        transaction.update(prodRef, {
          status: newStatus,
          updatedAt: todayStr(),
          history: [
            ...(Array.isArray(liveProd.history) ? liveProd.history : []),
            {
              tanggal: todayStr(),
              status: newStatus,
              catatan: `Otomatis dari progress setor borongan (${newStatus})`,
            },
          ],
        });

        if (orderRef) {
          transaction.update(orderRef, {
            statusProduksi: newStatus,
            produksiStatus: newStatus,
            produksiSource: "gallery-produksi",
            produksiUpdatedAt: todayStr(),
            ...(newStatus === "Selesai" ? { status: "Selesai Produksi" } : {}),
            updatedAt: todayStr(),
          });
        }
      });
      await Promise.all([refreshProduksi(), refreshOrders()]);
    } catch (e) {
      console.warn("Auto-update status produksi gagal:", e);
    }
  }

  async function updateProduksiStatus(id, newStatus) {
    const item = produksi.find((p) => p.id === id);
    if (!item || item.status === newStatus) return;

    const statusOrderMap = {
      "Antri": "Proses",
      "Potong": "Proses",
      "Jahit": "Proses",
      "Pengemasan QC": "Proses",
      "Selesai": "Selesai Produksi",
    };

    const prodRef = doc(db, C.PRODUKSI, id);
    const orderRef = item.orderId ? doc(db, C.ORDERS, item.orderId) : null;
    const orderStatusBaru = statusOrderMap[newStatus];

    setIsSaving(true);
    try {
      await runTransaction(db, async (transaction) => {
        const prodSnap = await transaction.get(prodRef);
        if (!prodSnap.exists()) throw new Error("Data produksi tidak ditemukan.");
        const liveProd = prodSnap.data();

        let liveOrder = null;
        if (orderRef && orderStatusBaru) {
          const orderSnap = await transaction.get(orderRef);
          if (!orderSnap.exists()) {
            throw new Error("Pesanan terkait tidak ditemukan. Status produksi tidak diubah agar data tetap sinkron.");
          }
          liveOrder = orderSnap.data();
        }

        transaction.update(prodRef, {
          status: newStatus,
          updatedAt: todayStr(),
          history: [
            ...(Array.isArray(liveProd.history) ? liveProd.history : []),
            { tanggal: todayStr(), status: newStatus, catatan: "Update status manual" },
          ],
        });

        if (orderRef && orderStatusBaru) {
          const currentOrderStatus = String(liveOrder?.status || "");
          transaction.update(orderRef, {
            statusProduksi: newStatus,
            produksiStatus: newStatus,
            produksiSource: "gallery-produksi",
            produksiUpdatedAt: todayStr(),
            ...(isSentStatus(currentOrderStatus) || lower(currentOrderStatus) === "lunas"
              ? {}
              : { status: newStatus === "Selesai" ? "Selesai Produksi" : orderStatusBaru }),
            updatedAt: todayStr(),
          });
        }
      });
      showToast("✅ Status produksi diperbarui", 2500);
    } catch (e) {
      alert(friendlyErrorMessage("Update status", e));
    } finally {
      setIsSaving(false);
    }
  }

  async function addWorkRate() {
    const cleanProductType = displayProductTypeName(rateForm.productType);
    const cleanProcess = rateForm.process;
    const cleanModel = canonicalByExisting(rateForm.model, modelNameOptions, "model");
    const cleanRate = nonNegativeMoney(rateForm.rate || 0);

    if (!cleanProductType.trim()) return alert("Jenis produk wajib diisi");
    if (!cleanModel.trim()) return alert("Model wajib diisi sesuai Master Tarif");
    if (!Number.isFinite(cleanRate) || cleanRate <= 0) return alert("Tarif wajib diisi dan harus lebih dari 0");
    if (cleanRate > 1000000) return alert("Tarif terlalu besar. Periksa kembali nominal tarif.");

    const rateRef = doc(db, C.WORK_RATES, rateDocId(cleanProductType, cleanModel, cleanProcess));

    setIsSaving(true);
    try {
      await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(rateRef);
        transaction.set(rateRef, {
          productType: cleanProductType,
          model: cleanModel,
          process: cleanProcess,
          rate: cleanRate,
          source: "gallery-produksi",
          createdAt: snap.exists() ? (snap.data().createdAt || todayStr()) : todayStr(),
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      });
      await refreshWorkRates();
      setRateForm({ productType: "Kerudung", model: "", process: "Jahit", rate: "" });
      setModal(null);
      showToast("✅ Tarif berhasil disimpan", 2500);
    } catch (e) {
      alert(friendlyErrorMessage("Simpan tarif", e));
    } finally {
      setIsSaving(false);
    }
  }

  async function addProductionEntry() {
    if (!entryForm.employeeName.trim()) return alert("Nama pekerja wajib diisi");
    if (!entryForm.qty || nonNegativeQty(entryForm.qty) <= 0) return alert("Qty wajib diisi");
    if (!entryForm.model.trim()) return alert("Model wajib diisi sesuai Master Tarif");
    if (!entryForm.orderId) {
      return alert(`Pilih pesanan dulu. Semua produksi wajib dikaitkan ke pesanan karena produksi dibuat sesuai order.`);
    }

    const cleanEmployeeName = canonicalByExisting(entryForm.employeeName, workerNameOptions, "worker");
    const cleanProductType = displayProductTypeName(entryForm.productType);
    const cleanModel = canonicalByExisting(entryForm.model, modelNameOptions, "model");
    const rate = getRateForEmployee(cleanProductType, cleanModel, entryForm.process, cleanEmployeeName);
    if (!rate) return alert("Tarif belum ada di Master Tarif. Silakan buat tarif baru di menu Master Tarif.");

    const order = orders.find((o) => o.id === entryForm.orderId);
    const prod = order ? produksiByOrderId.get(order.id) : null;
    const effectiveRate = nonNegativeMoney(rate.rate || 0);
    if (!Number.isFinite(effectiveRate) || effectiveRate <= 0) return alert("Tarif efektif tidak valid. Periksa tarif dasar dan aturan potongan konveksi.");
    const entryQty = nonNegativeQty(entryForm.qty);
    const totalWage = entryQty * effectiveRate;

    const draftPayloadForCheck = {
      employeeName: cleanEmployeeName,
      orderId: entryForm.orderId || "",
      process: entryForm.process,
      model: cleanModel,
      tanggal: entryForm.tanggal,
    };

    if (isDuplicateEntry(draftPayloadForCheck)) {
      return alert("Data borongan ini sudah pernah diinput untuk pekerja, proses, tanggal, dan pesanan yang sama.");
    }

    if (order) {
      const { limit, label } = getOrderProcessLimit(order, entryForm.process, cleanModel);
      const alreadyQty = isGeneralRateProcess(entryForm.process)
        ? processQtyForOrder(order.id, entryForm.process)
        : processQtyForOrderModel(order.id, entryForm.process, cleanModel);
      const nextQty = alreadyQty + entryQty;
      if (limit > 0 && nextQty > limit) {
        return alert(
          `Qty ${entryForm.process} melebihi qty ${label}.\n` +
          `Batas: ${limit} pcs\n` +
          `Sudah input: ${alreadyQty} pcs\n` +
          `Input baru: ${entryForm.qty} pcs`
        );
      }
    }

    const entryId = `entry_${safeDocId(cleanEmployeeName, "worker")}_${safeDocId(entryForm.orderId || "umum", "order")}_${safeDocId(entryForm.process, "process")}_${safeDocId(cleanModel || "all", "model")}_${safeDocId(entryForm.tanggal, "date")}`;
    const entryRef = doc(db, C.PRODUCTION_ENTRIES, entryId);
    const prodRef = prod?.id ? doc(db, C.PRODUKSI, prod.id) : null;

    setIsSaving(true);
    try {
      const entryPayload = {
        employeeName: cleanEmployeeName,
        orderId: entryForm.orderId || "",
        produksiId: prod?.id || "",
        invoice: order?.invoice || "",
        customer: order?.customer || "",
        item: order?.item || "",
        productType: cleanProductType,
        model: cleanModel,
        process: entryForm.process,
        qty: entryQty,
        rate: effectiveRate,
        totalWage,
        tanggal: entryForm.tanggal,
        catatan: entryForm.catatan || "",
        source: "gallery-produksi",
        createdAt: todayStr(),
      };

      await runTransaction(db, async (transaction) => {
        const entrySnap = await transaction.get(entryRef);
        if (entrySnap.exists()) throw new Error("Data borongan ini sudah pernah diinput untuk pekerja, proses, tanggal, dan pesanan yang sama.");

        let liveWorkers = [];
        let liveProdData = null;
        if (prodRef) {
          const prodSnap = await transaction.get(prodRef);
          if (prodSnap.exists()) {
            liveProdData = prodSnap.data();
            liveWorkers = Array.isArray(liveProdData.workers) ? liveProdData.workers : [];
          }
        }

        if (liveProdData) {
          const processKey = normalizeProcessKey(entryPayload.process);
          const modelKey = normalizeModelKey(entryPayload.model || "");
          const liveItems = Array.isArray(liveProdData.items) ? liveProdData.items : [];
          const matchedLiveItem = liveItems.find((it) => normalizeModelKey(it.name || it.item || "") === modelKey);
          const generalProcess = GENERAL_RATE_PROCESSES.some((p) => normalizeProcessKey(p) === processKey);
          const limit = generalProcess
            ? Number(liveProdData.qty || 0)
            : Number(matchedLiveItem?.qty || liveProdData.qty || 0);
          const alreadyInWorkers = liveWorkers
            .filter((w) => normalizeProcessKey(w.process) === processKey)
            .filter((w) => generalProcess || normalizeModelKey(w.model || "") === modelKey)
            .reduce((sum, w) => sum + Number(w.qty || 0), 0);
          if (limit > 0 && alreadyInWorkers + Number(entryPayload.qty || 0) > limit) {
            throw new Error(`Qty ${entryPayload.process} melebihi batas produksi. Batas ${limit} pcs, sudah input ${alreadyInWorkers} pcs, input baru ${entryPayload.qty} pcs.`);
          }
        }

        transaction.set(entryRef, entryPayload);
        if (prodRef) {
          transaction.update(prodRef, {
            workers: [
              ...liveWorkers,
              {
                employeeName: entryPayload.employeeName,
                process: entryPayload.process,
                productType: entryPayload.productType,
                model: entryPayload.model,
                qty: entryPayload.qty,
                tanggal: entryPayload.tanggal,
                entryId,
              },
            ],
            updatedAt: todayStr(),
          });
        }
      });

      await Promise.all([refreshProductionEntries(), refreshProduksi()]);
      setEntryForm({
        employeeName: "",
        orderId: "",
        productType: "Kerudung",
        model: "",
        process: "Jahit",
        qty: "",
        tanggal: todayStr(),
        catatan: "",
      });
      setModal(null);
    } catch (e) {
      alert(friendlyErrorMessage("Simpan borongan", e));
    } finally {
      setIsSaving(false);
    }
  }

  async function simpanSetor() {
    if (!setorModal) return;

    const qtySetor = Number(setorForm.qtySetor || 0);
    const qtyReject = Number(setorForm.qtyReject || 0);
    if (qtySetor < 0 || qtyReject < 0) return alert("Qty setor/reject tidak boleh minus.");
    if (qtySetor + qtyReject <= 0) return alert("Isi qty setor atau qty reject terlebih dahulu.");

    const tanggalSetor = setorForm.tanggalSetor || todayStr();
    const setorBatchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entryRef = doc(db, C.PRODUCTION_ENTRIES, setorModal.id);
    const payrollRef = doc(db, C.PAYROLL_EXPENSES, `payroll_setor_${safeDocId(setorModal.id, "entry")}_${safeDocId(setorBatchId, "batch")}`);

    let nextHistoryForStatus = [];
    let nextSisaForToast = 0;

    setIsSaving(true);
    try {
      await runTransaction(db, async (transaction) => {
        const entrySnap = await transaction.get(entryRef);
        if (!entrySnap.exists()) throw new Error("Entry borongan tidak ditemukan.");
        const liveEntry = { id: setorModal.id, ...entrySnap.data() };
        const existingTotals = setorTotals(liveEntry);
        const sisaSebelum = Number(existingTotals.sisaSetor || 0);
        if (sisaSebelum <= 0) throw new Error("Entry ini sudah selesai disetor.");
        if (qtySetor + qtyReject > sisaSebelum) {
          throw new Error(`Total setor + reject (${qtySetor + qtyReject} pcs) melebihi sisa belum setor (${sisaSebelum} pcs).`);
        }

        const rate = Number(liveEntry.rate || 0);
        if (!Number.isFinite(rate) || rate <= 0) throw new Error("Tarif entry tidak valid. Perbaiki tarif/entry sebelum menyetor.");
        const totalWageSetor = qtySetor * rate;
        const newHistoryItem = {
          id: setorBatchId,
          tanggalSetor,
          qtySetor,
          qtyReject,
          rate,
          totalWageSetor,
          catatan: setorForm.catatan || "",
          createdAt: new Date().toISOString(),
        };
        const nextHistory = [...normalizeSetorHistory(liveEntry), newHistoryItem];
        const nextQtySetor = nextHistory.reduce((sum, h) => sum + Number(h.qtySetor || 0), 0);
        const nextQtyReject = nextHistory.reduce((sum, h) => sum + Number(h.qtyReject || 0), 0);
        const nextTotalWageSetor = nextHistory.reduce((sum, h) => sum + Number(h.totalWageSetor || 0), 0);
        const nextSisa = Math.max(0, Number(liveEntry.qty || 0) - nextQtySetor - nextQtyReject);
        const nextStatusSetor = nextSisa <= 0 ? "sudah_setor" : "setor_sebagian";

        transaction.update(entryRef, {
          setorHistory: nextHistory,
          qtySetor: nextQtySetor,
          qtyReject: nextQtyReject,
          totalWageSetor: nextTotalWageSetor,
          sisaSetor: nextSisa,
          statusSetor: nextStatusSetor,
          tanggalSetor,
          catatanSetor: setorForm.catatan || "",
          updatedAt: todayStr(),
        });

        if (totalWageSetor > 0) {
          transaction.set(payrollRef, {
            source: "gallery-produksi",
            type: "gaji_borongan",
            employeeName: displayWorkerName(liveEntry.employeeName),
            orderId: liveEntry.orderId || "",
            invoice: liveEntry.invoice || "",
            productType: liveEntry.productType,
            model: liveEntry.model || "",
            process: liveEntry.process,
            totalPcs: qtySetor,
            totalAmount: totalWageSetor,
            status: "belum_dibayar",
            tanggal: tanggalSetor,
            createdAt: todayStr(),
            entryId: setorModal.id,
            setorBatchId,
            qtyAwal: liveEntry.qty,
            qtyReject,
            sisaSetor: nextSisa,
          });
        }

        nextHistoryForStatus = nextHistory;
        nextSisaForToast = nextSisa;
      });

      showToast(nextSisaForToast > 0 ? `✅ Setor sebagian tersimpan. Sisa ${nextSisaForToast} pcs.` : "✅ Setor selesai tersimpan.", 3500);

      await autoUpdateProduksiStatus(setorModal, nextHistoryForStatus);
      await Promise.all([refreshProductionEntries(), refreshPayroll(), refreshProduksi(), refreshOrders()]); // setor membuat dokumen payroll baru dan bisa mengubah status produksi

      setSetorModal(null);
      setSetorForm({ qtySetor: "", qtyReject: "", tanggalSetor: todayStr(), catatan: "" });
    } catch (e) {
      alert(friendlyErrorMessage("Simpan setor", e));
    } finally {
      setIsSaving(false);
    }
  }

  async function addPengiriman() {
    const selectedIds = Array.isArray(kirimForm.orderIds) && kirimForm.orderIds.length > 0
      ? kirimForm.orderIds
      : (kirimForm.pesananId ? [kirimForm.pesananId] : []);
    if (selectedIds.length === 0) return alert("Pilih minimal satu pesanan dulu");
    if (!kirimForm.penerima.trim()) return alert("Penerima wajib diisi");

    const selectedOrders = selectedIds.map((id) => orders.find((o) => o.id === id)).filter(Boolean);
    if (selectedOrders.length !== selectedIds.length) return alert("Ada pesanan yang tidak ditemukan");

    const allItems = (kirimForm.items || []).map((it) => ({ ...it, orderId: it.orderId || kirimForm.pesananId || selectedIds[0] }));
    if (allItems.some((i) => Number(i.qtyKirim || 0) < 0)) return alert("Qty kirim tidak boleh negatif.");
    if (allItems.reduce((sum, item) => sum + Number(item.qtyKirim || 0), 0) <= 0) return alert("Minimal ada qty kirim lebih dari 0 pcs.");

    const groupId = `nota_${safeDocId(kirimForm.tanggalKirim || todayStr(), "tgl")}_${safeDocId(kirimForm.penerima, "customer")}_${Date.now()}`;
    const deliveryCreatedAt = new Date().toISOString();

    const totalDeliveredForItem = (base, idx, delArray) => delArray.reduce((sum, delivery) => {
      const found = (delivery.items || []).filter((it) => {
        const hasItemIndex = it.itemIndex !== undefined && it.itemIndex !== null && it.itemIndex !== "";
        if (hasItemIndex) return Number(it.itemIndex) === idx;
        return normalizeModelKey(it.name || it.nama) === normalizeModelKey(base.name);
      });
      return sum + found.reduce((s, it) => s + Number(it.qty ?? it.shippedQty ?? it.qtyKirim ?? 0), 0);
    }, 0);

    const buildShippedItems = (baseItems, deliveriesArr) => baseItems.map((base, idx) => {
      const shippedQty = totalDeliveredForItem(base, idx, deliveriesArr);
      const ordered = Number(base.orderedQty || 0);
      const diff = shippedQty - ordered;
      return {
        name: base.name,
        orderedQty: ordered,
        shippedQty,
        price: Number(base.price || 0),
        bahanCost: Number(base.bahanCost || 0),
        hppPerPcs: Number(base.hppPerPcs || 0),
        mainMaterial: base.mainMaterial || "",
        materialQtyPerPcs: Number(base.materialQtyPerPcs || 0),
        unit: base.unit || "yard",
        note: diff === 0 ? "Sesuai pesanan" : diff < 0 ? `Kekurangan pengiriman ${Math.abs(diff)} pcs` : `Kelebihan pengiriman ${diff} pcs`,
      };
    });

    let localHasOverDelivery = false;
    selectedOrders.forEach((order) => {
      const baseItems = orderBaseItems(order);
      const itemsForOrder = allItems.filter((it) => it.orderId === order.id && Number(it.qtyKirim || 0) > 0);
      if (itemsForOrder.length === 0) return;
      const deliveryItems = itemsForOrder.map((i, idx) => {
        const preferredIndex = Number.isInteger(Number(i.itemIndex)) ? Number(i.itemIndex) : idx;
        const base = baseItems[preferredIndex] || baseItems[idx] || baseItems[0] || {};
        return { itemIndex: Number(base.itemIndex ?? preferredIndex), name: i.nama || base.name || "Produk", qty: Number(i.qtyKirim || 0), shippedQty: Number(i.qtyKirim || 0) };
      });
      const draftDelivery = { createdAt: deliveryCreatedAt, items: deliveryItems };
      const calc = buildShippedItems(baseItems, [...getDeliveryArray(order), draftDelivery]);
      if (calc.some((i) => Number(i.shippedQty || 0) > Number(i.orderedQty || 0))) localHasOverDelivery = true;
    });

    let overDeliveryConfirmed = false;
    if (localHasOverDelivery) {
      overDeliveryConfirmed = window.confirm("Ada pesanan yang akan lebih kirim. Kelebihan ini akan menambah tagihan customer di Gallery Kerudung. Lanjut simpan?");
      if (!overDeliveryConfirmed) return;
    }

    const totalOrderedLocal = selectedOrders.reduce((sum, order) => sum + dashboardTotalOrderedQty(order), 0);
    const totalKirimLocal = allItems.reduce((sum, item) => sum + Number(item.qtyKirim || 0), 0);
    const localIsShortShipment = totalOrderedLocal > 0 && totalKirimLocal > 0 && totalKirimLocal < totalOrderedLocal;
    const isShortFinal = localIsShortShipment && kirimForm.shortShipmentMode === "final";
    const shortShipmentReason = isShortFinal ? String(kirimForm.shortShipmentReason || "").trim() : "";
    const shortShipmentNote = isShortFinal ? String(kirimForm.shortShipmentNote || "").trim() : "";
    if (isShortFinal && !shortShipmentReason) return alert("Pilih alasan kurang kirim final terlebih dahulu.");

    const orderRows = selectedOrders.map((order) => ({ order, orderRef: doc(db, C.ORDERS, order.id), prod: produksiByOrderId.get(order.id) }));

    setIsSaving(true);
    try {
      const batchRef = doc(collection(db, C.SHIPMENT_BATCHES));
      const shipmentRefsByOrderId = new Map(orderRows.map((row) => [row.order.id, doc(collection(db, C.SHIPMENTS))]));
      await runTransaction(db, async (transaction) => {
        const liveRows = [];
        const batchOrderSummaries = [];
        const batchItems = [];
        const batchShipmentIds = [];
        for (const row of orderRows) {
          const orderSnap = await transaction.get(row.orderRef);
          if (!orderSnap.exists()) throw new Error(`Order ${row.order.invoice || row.order.id} tidak ditemukan`);
          let prodSnapData = null;
          let prodRef = null;
          if (row.prod?.id) {
            prodRef = doc(db, C.PRODUKSI, row.prod.id);
            const prodSnap = await transaction.get(prodRef);
            prodSnapData = prodSnap.exists() ? prodSnap.data() : null;
          }
          liveRows.push({ ...row, orderData: orderSnap.data(), prodRef, prodSnapData });
        }

        for (const row of liveRows) {
          const order = row.order;
          const currentData = row.orderData;
          const baseItems = orderBaseItems({ ...order, raw: { ...(order.raw || {}), ...currentData }, items: currentData.items || order.items });
          const currentDeliveries = Array.isArray(currentData.deliveries) ? currentData.deliveries : [];
          const itemsForOrder = allItems.filter((it) => it.orderId === order.id && Number(it.qtyKirim || 0) > 0);
          if (itemsForOrder.length === 0) continue;

          const cleanDeliveryItems = itemsForOrder.map((i, idx) => {
            const preferredIndex = Number.isInteger(Number(i.itemIndex)) ? Number(i.itemIndex) : idx;
            const base = baseItems[preferredIndex] || baseItems[idx] || baseItems[0] || {};
            const qtyKirim = Number(i.qtyKirim || 0);
            return {
              itemIndex: Number(base.itemIndex ?? preferredIndex),
              name: i.nama || base.name || "Produk",
              qty: qtyKirim,
              shippedQty: qtyKirim,
              orderedQty: Number(i.qtyPesan || base.orderedQty || 0),
              price: Number(base.price || 0),
              bahanCost: Number(base.bahanCost || 0),
              hppPerPcs: Number(base.hppPerPcs || 0),
              mainMaterial: base.mainMaterial || "",
              materialQtyPerPcs: Number(base.materialQtyPerPcs || 0),
              unit: base.unit || "yard",
            };
          });

          const newDelivery = {
            date: kirimForm.tanggalKirim || todayStr(),
            createdAt: deliveryCreatedAt,
            source: "gallery-produksi",
            groupId,
            noteNumber: groupId,
            receiver: kirimForm.penerima.trim(),
            penerima: kirimForm.penerima.trim(),
            courier: kirimForm.ekspedisi || "",
            ekspedisi: kirimForm.ekspedisi || "",
            note: kirimForm.catatan || "",
            shortShipmentMode: kirimForm.shortShipmentMode || "temporary",
            shortShipmentReason: kirimForm.shortShipmentReason || "",
            shortShipmentNote: kirimForm.shortShipmentNote || "",
            items: cleanDeliveryItems,
            total: cleanDeliveryItems.reduce((s, i) => s + Number(i.qty || 0) * Number(i.price || 0), 0),
          };

          const finalDeliveries = [...currentDeliveries, newDelivery];
          const finalShippedItems = buildShippedItems(baseItems, finalDeliveries);
          const totalOrdered = finalShippedItems.reduce((s, i) => s + Number(i.orderedQty || 0), 0);
          const totalShipped = finalShippedItems.reduce((s, i) => s + Number(i.shippedQty || 0), 0);
          const deliveredTotal = finalShippedItems.reduce((s, i) => s + Number(i.shippedQty || 0) * Number(i.price || 0), 0);
          const deliveredHppTotal = finalShippedItems.reduce((s, i) => s + Number(i.shippedQty || 0) * Number(i.hppPerPcs || i.bahanCost || 0), 0);
          const hasOverDelivery = finalShippedItems.some((i) => Number(i.shippedQty || 0) > Number(i.orderedQty || 0));
          if (hasOverDelivery && !overDeliveryConfirmed) throw new Error("Data terbaru menunjukkan pengiriman akan melebihi qty pesanan. Muat ulang data lalu konfirmasi ulang.");

          const isShortShipment = totalOrdered > 0 && totalShipped > 0 && totalShipped < totalOrdered;
          const finalShort = isShortShipment && kirimForm.shortShipmentMode === "final";
          const deliveryStatusRaw = totalShipped <= 0 ? "Belum Dikirim" : hasOverDelivery ? "Kelebihan Kirim" : totalShipped < totalOrdered ? "Dikirim Sebagian" : "Selesai";
          const deliveryStatus = finalShort ? "Ditutup Kurang Kirim" : deliveryStatusRaw;
          const orderStatus = deliveryStatus === "Selesai" ? "Dikirim" : deliveryStatus === "Kelebihan Kirim" ? "Kelebihan Kirim" : finalShort ? "Ditutup Kurang Kirim" : "Dikirim Sebagian";
          const shippingStatus = finalShort ? "Kurang Kirim Final" : orderStatus;
          const shortShipmentRemaining = Math.max(0, totalOrdered - totalShipped);
          const productionDoneByDelivery = finalShort || (totalOrdered > 0 && totalShipped >= totalOrdered);
          const nextProduksiStatus = productionDoneByDelivery ? "Selesai" : (currentData.statusProduksi || currentData.produksiStatus || "Proses");

          const shipmentRef = shipmentRefsByOrderId.get(order.id) || doc(collection(db, C.SHIPMENTS));
          batchShipmentIds.push(shipmentRef.id);
          batchOrderSummaries.push({
            orderId: order.id,
            pesananId: order.id,
            invoice: order.invoice || "",
            customer: order.customer || "",
            totalPesanBatch: cleanDeliveryItems.reduce((s, i) => s + Number(i.orderedQty || 0), 0),
            totalKirimBatch: cleanDeliveryItems.reduce((s, i) => s + Number(i.shippedQty || 0), 0),
            totalTagihanBatch: cleanDeliveryItems.reduce((s, i) => s + Number(i.shippedQty || 0) * Number(i.price || 0), 0),
            totalPesanAkumulasi: totalOrdered,
            totalKirimAkumulasi: totalShipped,
            shortShipmentRemaining,
            deliveryStatus,
            shippingStatus,
            items: cleanDeliveryItems.map((it) => ({
              orderId: order.id,
              pesananId: order.id,
              invoice: order.invoice || "",
              customer: order.customer || "",
              ...it,
              qtyPesan: it.orderedQty,
              qtyKirim: it.shippedQty,
              total: Number(it.shippedQty || 0) * Number(it.price || 0),
            })),
          });
          cleanDeliveryItems.forEach((it) => batchItems.push({
            orderId: order.id,
            pesananId: order.id,
            invoice: order.invoice || "",
            customer: order.customer || "",
            ...it,
            qtyPesan: it.orderedQty,
            qtyKirim: it.shippedQty,
            total: Number(it.shippedQty || 0) * Number(it.price || 0),
          }));

          transaction.set(shipmentRef, {
            pesananId: order.id,
            orderId: order.id,
            groupId,
            noteNumber: groupId,
            batchId: batchRef.id,
            shipmentType: selectedOrders.length > 1 ? "combined_customer" : "single_order",
            isCombinedShipment: selectedOrders.length > 1,
            customer: order.customer,
            produk: order.item,
            productName: order.item,
            invoice: order.invoice,
            tanggalKirim: kirimForm.tanggalKirim,
            date: kirimForm.tanggalKirim,
            penerima: kirimForm.penerima.trim(),
            receiver: kirimForm.penerima.trim(),
            ekspedisi: kirimForm.ekspedisi || "",
            courier: kirimForm.ekspedisi || "",
            items: cleanDeliveryItems.map((it) => ({ ...it, qtyPesan: it.orderedQty, qtyKirim: it.shippedQty })),
            deliveryItems: cleanDeliveryItems,
            qty: cleanDeliveryItems.reduce((s, i) => s + Number(i.qty || 0), 0),
            totalPesan: totalOrdered,
            totalKirim: totalShipped,
            totalSelisih: cleanDeliveryItems.reduce((s, i) => s + (Number(i.shippedQty || 0) - Number(i.orderedQty || 0)), 0),
            deliveryStatus,
            shippingStatus,
            shortShipmentClosed: finalShort,
            shortShipmentMode: finalShort ? "final" : (isShortShipment ? "temporary" : ""),
            shortShipmentReason: finalShort ? shortShipmentReason : "",
            shortShipmentNote: finalShort ? shortShipmentNote : "",
            shortShipmentRemaining,
            deliveredTotal,
            deliveredHppTotal,
            catatan: kirimForm.catatan || "",
            note: kirimForm.catatan || "",
            source: "gallery-produksi",
            createdAt: todayStr(),
          });

          transaction.update(row.orderRef, {
            status: orderStatus,
            shippingStatus,
            deliveryStatus,
            shortShipmentClosed: finalShort,
            shortShipmentMode: finalShort ? "final" : (isShortShipment ? "temporary" : ""),
            shortShipmentReason: finalShort ? shortShipmentReason : "",
            shortShipmentNote: finalShort ? shortShipmentNote : "",
            shortShipmentRemaining,
            tanggalKirim: kirimForm.tanggalKirim || todayStr(),
            deliveries: finalDeliveries,
            shippedItems: finalShippedItems,
            deliveredTotal,
            deliveredHppTotal,
            totalKirim: totalShipped,
            totalPesan: totalOrdered,
            statusProduksi: nextProduksiStatus,
            produksiStatus: nextProduksiStatus,
            produksiSource: "gallery-produksi",
            produksiUpdatedAt: todayStr(),
            updatedAt: todayStr(),
          });

          if (row.prodRef && productionDoneByDelivery && row.prod?.status !== "Selesai") {
            transaction.update(row.prodRef, {
              status: "Selesai",
              updatedAt: todayStr(),
              history: [
                ...(Array.isArray(row.prodSnapData?.history) ? row.prodSnapData.history : []),
                { tanggal: todayStr(), status: "Selesai", catatan: "Otomatis selesai karena pengiriman sudah memenuhi pesanan" },
              ],
            });
          }
        }

        if (batchItems.length > 0) {
          const batchOrderIds = [...new Set(batchOrderSummaries.map((o) => o.orderId).filter(Boolean))];
          const batchInvoices = [...new Set(batchOrderSummaries.map((o) => o.invoice).filter(Boolean))];
          transaction.set(batchRef, {
            groupId,
            noteNumber: groupId,
            shipmentType: selectedOrders.length > 1 ? "combined_customer" : "single_order",
            isCombinedShipment: selectedOrders.length > 1,
            source: "gallery-produksi",
            customer: batchOrderSummaries[0]?.customer || kirimForm.penerima.trim() || "",
            customerName: batchOrderSummaries[0]?.customer || kirimForm.penerima.trim() || "",
            tanggalKirim: kirimForm.tanggalKirim || todayStr(),
            date: kirimForm.tanggalKirim || todayStr(),
            createdAt: todayStr(),
            receiver: kirimForm.penerima.trim(),
            penerima: kirimForm.penerima.trim(),
            courier: kirimForm.ekspedisi || "",
            ekspedisi: kirimForm.ekspedisi || "",
            note: kirimForm.catatan || "",
            catatan: kirimForm.catatan || "",
            orderIds: batchOrderIds,
            pesananIds: batchOrderIds,
            invoices: batchInvoices,
            shipmentIds: batchShipmentIds,
            orders: batchOrderSummaries,
            items: batchItems,
            totalKirimBatch: batchItems.reduce((s, i) => s + Number(i.qtyKirim || i.shippedQty || i.qty || 0), 0),
            totalTagihanBatch: batchItems.reduce((s, i) => s + Number(i.total || 0), 0),
            totalHppBatch: batchItems.reduce((s, i) => s + Number(i.qtyKirim || i.shippedQty || i.qty || 0) * Number(i.hppPerPcs || i.bahanCost || 0), 0),
            status: "Aktif",
          });
        }
      });

      setKirimForm({
        pesananId: "",
        orderIds: [],
        customerKey: "",
        tanggalKirim: todayStr(),
        penerima: "",
        ekspedisi: "",
        items: [{ nama: "", qtyPesan: 0, qtyKirim: 0 }],
        shortShipmentMode: "temporary",
        shortShipmentReason: "Stok kain habis",
        shortShipmentNote: "",
        catatan: "",
      });
      setModal(null);
      await Promise.all([refreshShipments(), refreshOrders(), refreshProduksi()]); // sinkron data pengiriman tanpa onSnapshot
    } catch (e) {
      alert(friendlyErrorMessage("Simpan pengiriman", e));
    } finally {
      setIsSaving(false);
    }
  }

  function deleteRate(id) {
    setConfirmDelete({ type: "rate", id, step: 1 });
  }

  function requestDeleteEntry(entry) {
    setConfirmDelete({ type: "entry", id: entry.id, entry, step: 1 });
  }

  async function confirmDeleteAction() {
    if (!confirmDelete) return;
    // 2x konfirmasi: step 1 → tampilkan konfirmasi 2, step 2 → eksekusi hapus
    if (confirmDelete.step === 1) {
      setConfirmDelete({ ...confirmDelete, step: 2 });
      return;
    }
    const { type, id } = confirmDelete;
    setConfirmDelete(null);
    try {
      if (type === "rate") { await deleteDoc(doc(db, C.WORK_RATES, id)); await refreshWorkRates(); }
      if (type === "entry") {
        const payrollSnap = await getDocs(query(collection(db, C.PAYROLL_EXPENSES), where("entryId", "==", id)));
        const batch = writeBatch(db);
        batch.delete(doc(db, C.PRODUCTION_ENTRIES, id));
        payrollSnap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        await Promise.all([refreshProductionEntries(), refreshPayroll(), refreshProduksi()]);
      }
      showToast("🗑️ Data berhasil dihapus", 3000);
    } catch (e) {
      alert(friendlyErrorMessage("Hapus data", e));
    }
  }

  function openEditEntry(entry) {
    setEditEntryModal(entry);
    setEditEntryForm({
      qty: String(entry.qty || ""),
      tanggal: entry.tanggal || todayStr(),
      catatan: entry.catatan || "",
      model: entry.model || "",
    });
  }

  async function saveEditEntry() {
    if (!editEntryModal) return;
    const nextQty = nonNegativeQty(editEntryForm.qty || 0);
    if (!Number.isFinite(nextQty) || nextQty <= 0) return alert("Qty wajib diisi dan harus lebih dari 0.");

    const nextModel = canonicalByExisting(editEntryForm.model || editEntryModal.model || "", modelNameOptions, "model");

    const editOrder = orders.find((o) => o.id === editEntryModal.orderId);
    if (editOrder) {
      const { limit, label } = getOrderProcessLimit(editOrder, editEntryModal.process, nextModel);
      const alreadyQty = isGeneralRateProcess(editEntryModal.process)
        ? productionEntries
            .filter((e) => e.id !== editEntryModal.id && e.orderId === editOrder.id && sameProcess(e.process, editEntryModal.process))
            .reduce((sum, e) => sum + Number(e.qty || 0), 0)
        : processQtyForOrderModel(editOrder.id, editEntryModal.process, nextModel, editEntryModal.id);
      const combinedQty = alreadyQty + nextQty;
      if (limit > 0 && combinedQty > limit) {
        return alert(
          `Qty ${editEntryModal.process} melebihi qty ${label}.\n` +
          `Batas: ${limit} pcs\n` +
          `Sudah input lain: ${alreadyQty} pcs\n` +
          `Qty baru: ${editEntryForm.qty} pcs`
        );
      }
    }

    const entryRef = doc(db, C.PRODUCTION_ENTRIES, editEntryModal.id);
    const prodRef = editEntryModal.produksiId
      ? doc(db, C.PRODUKSI, editEntryModal.produksiId)
      : null;

    setIsSaving(true);
    try {
      await runTransaction(db, async (transaction) => {
        const entrySnap = await transaction.get(entryRef);
        if (!entrySnap.exists()) throw new Error("Entry borongan tidak ditemukan.");
        const liveEntry = { id: editEntryModal.id, ...entrySnap.data() };
        const liveTotals = setorTotals(liveEntry);
        const hasSetor = Number(liveTotals.qtySetor || 0) > 0 || Number(liveTotals.qtyReject || 0) > 0;

        const modelChanged = normalizeModelKey(nextModel) !== normalizeModelKey(liveEntry.model || "");
        const qtyChanged = Number(liveEntry.qty || 0) !== nextQty;
        const tanggalChanged = String(liveEntry.tanggal || "") !== String(editEntryForm.tanggal || "");

        if (hasSetor && (modelChanged || qtyChanged || tanggalChanged)) {
          throw new Error("Entry yang sudah disetor tidak bisa diubah qty/model/tanggal karena sudah terkait payroll. Hapus setor/payroll terkait atau buat koreksi baru.");
        }

        let newRate = nonNegativeMoney(liveEntry.rate || 0);
        if (!hasSetor) {
          const rateInfo = getRateForEmployee(liveEntry.productType || editEntryModal.productType || "Kerudung", nextModel, liveEntry.process, liveEntry.employeeName);
          if (!rateInfo) throw new Error("Tarif belum ada di Master Tarif. Silakan buat tarif baru di menu Master Tarif.");
          newRate = nonNegativeMoney(rateInfo.rate || 0);
        }

        const updates = {
          qty: hasSetor ? Number(liveEntry.qty || 0) : nextQty,
          tanggal: hasSetor ? (liveEntry.tanggal || editEntryForm.tanggal) : editEntryForm.tanggal,
          catatan: editEntryForm.catatan || "",
          rate: newRate,
          totalWage: (hasSetor ? Number(liveEntry.qty || 0) : nextQty) * newRate,
          updatedAt: todayStr(),
        };
        updates.model = nextModel;

        if (prodRef) {
          const prodSnap = await transaction.get(prodRef);
          if (prodSnap.exists()) {
            const liveProdData = prodSnap.data();
            const liveWorkers = Array.isArray(liveProdData.workers) ? liveProdData.workers : [];
            if (!hasSetor) {
              const processKey = normalizeProcessKey(liveEntry.process || "");
              const modelKey = normalizeModelKey(nextModel);
              const liveItems = Array.isArray(liveProdData.items) ? liveProdData.items : [];
              const generalProcess = GENERAL_RATE_PROCESSES.some((p) => normalizeProcessKey(p) === processKey);
              const matchedLiveItem = liveItems.find((it) => normalizeModelKey(it.name || it.item || "") === modelKey);
              const limit = generalProcess
                ? Number(liveProdData.qty || 0)
                : Number(matchedLiveItem?.qty || liveProdData.qty || 0);
              const alreadyInWorkers = liveWorkers
                .filter((w) => w.entryId !== liveEntry.id)
                .filter((w) => normalizeProcessKey(w.process) === processKey)
                .filter((w) => generalProcess || normalizeModelKey(w.model || "") === modelKey)
                .reduce((sum, w) => sum + Number(w.qty || 0), 0);
              if (limit > 0 && alreadyInWorkers + Number(updates.qty || 0) > limit) {
                throw new Error(`Qty ${liveEntry.process} melebihi batas produksi. Batas ${limit} pcs, sudah input ${alreadyInWorkers} pcs, input baru ${updates.qty} pcs.`);
              }
            }
            const nextWorkers = liveWorkers.map((w) => {
              if (w.entryId !== liveEntry.id) return w;
              return {
                ...w,
                model: nextModel,
                qty: updates.qty,
                tanggal: updates.tanggal,
                productType: liveEntry.productType || w.productType,
                process: liveEntry.process || w.process,
              };
            });
            transaction.update(prodRef, {
              workers: nextWorkers,
              updatedAt: todayStr(),
            });
          }
        }

        transaction.update(entryRef, updates);
      });

      setEditEntryModal(null);
      showToast("✅ Entry berhasil diupdate", 3000);
    } catch (e) {
      alert(friendlyErrorMessage("Update data", e));
    } finally {
      setIsSaving(false);
    }
  }


  function isGajianMarker(p) {
    if (!p || !normalizeWorkerNameKey(p.employeeName)) return false;

    // Hanya dokumen marker status gajian yang boleh dipakai untuk badge
    // Sudah/Belum Gajian. Jangan membaca payroll gaji asli hanya karena
    // punya status "sudah_dibayar", supaya nominal gaji tidak salah dianggap
    // sebagai marker periode.
    const isMarkerSource = p.source === "gallery-produksi-gaji-marker";
    const isMarkerType = p.type === "status_gajian_periode";
    const zeroAmount = Number(p.totalAmount || 0) === 0;

    return Boolean((isMarkerSource || isMarkerType) && zeroAmount);
  }

  function markerMatchesPeriode(p, dari = rekapDari, sampai = rekapSampai) {
    const targetDari = dateKey(dari);
    const targetSampai = dateKey(sampai);
    if (!targetDari || !targetSampai) return false;

    const markerDari = dateKey(p?.periodeGajiDari || p?.periodeDari || p?.tanggalDari || p?.startDate);
    const markerSampai = dateKey(p?.periodeGajiSampai || p?.periodeSampai || p?.tanggalSampai || p?.endDate);

    // Data marker lama disimpan dengan periode exact. Setelah periode rekap dibetulkan
    // menjadi Minggu-Sabtu, marker lama seperti 2026-05-16 s/d 2026-05-23
    // harus tetap terbaca untuk periode baru 2026-05-17 s/d 2026-05-23.
    if (markerDari === targetDari && markerSampai === targetSampai) return true;
    return dateRangesOverlap(markerDari, markerSampai, targetDari, targetSampai);
  }

  function payrollMarkerFor(nama, dari = rekapDari, sampai = rekapSampai) {
    const workerKey = normalizeWorkerNameKey(nama);
    if (!workerKey) return null;

    return payrollExpenses.find((p) =>
      isGajianMarker(p) &&
      normalizeWorkerNameKey(p.employeeName) === workerKey &&
      markerMatchesPeriode(p, dari, sampai)
    ) || null;
  }

  function sudahGajian(nama, dari = rekapDari, sampai = rekapSampai) {
    return Boolean(payrollMarkerFor(nama, dari, sampai));
  }

  async function batalkanSudahGajian(nama, dari = rekapDari, sampai = rekapSampai) {
    const marker = payrollMarkerFor(nama, dari, sampai);
    if (!marker?.id) return alert("Data status gajian tidak ditemukan.");
    if (marker.source !== "gallery-produksi-gaji-marker" && marker.type !== "status_gajian_periode") {
      return alert("Status ini berasal dari data payroll lama, tidak bisa dibatalkan otomatis dari tombol ini.");
    }

    const employeeDisplay = displayWorkerName(nama);
    const workerKey = normalizeWorkerNameKey(nama);
    const periodeKey = `${dateKey(dari)}_${dateKey(sampai)}`;
    const historyRef = doc(db, C.GAJIAN_HISTORY, `gajian_${safeDocId(workerKey, "worker")}_${safeDocId(periodeKey, "periode")}`);

    const relatedKasbon = kasbonList.filter((k) => {
      if (normalizeWorkerNameKey(k.employeeName || "") !== workerKey) return false;
      return (Array.isArray(k.cicilan) ? k.cicilan : []).some((c) =>
        c?.sumber === "rekap_gaji" &&
        dateKey(c?.periodeGajiDari) === dateKey(dari) &&
        dateKey(c?.periodeGajiSampai) === dateKey(sampai)
      );
    });

    let pesan = `Batalkan status sudah gajian untuk ${employeeDisplay}?`;
    if (Number(marker.potonganKasbon || 0) > 0 || relatedKasbon.length > 0) {
      pesan += `\n\nPotongan kasbon periode ini juga akan dikembalikan dan riwayat gajian otomatis akan dihapus.`;
    }
    const ok = window.confirm(pesan);
    if (!ok) return;

    setIsSaving(true);
    try {
      await runTransaction(db, async (transaction) => {
        const markerRef = doc(db, C.PAYROLL_EXPENSES, marker.id);
        const markerSnap = await transaction.get(markerRef);
        if (!markerSnap.exists()) throw new Error("Marker gajian sudah tidak ditemukan.");
        const liveMarker = markerSnap.data();
        if (liveMarker.source !== "gallery-produksi-gaji-marker" && liveMarker.type !== "status_gajian_periode") {
          throw new Error("Marker gajian ini bukan marker otomatis Gallery Produksi.");
        }

        const kasbonRefs = relatedKasbon.map((k) => doc(db, C.KASBON, k.id));
        const kasbonRollbackUpdates = [];
        for (const ref of kasbonRefs) {
          const snap = await transaction.get(ref);
          if (!snap.exists()) continue;
          const data = snap.data();
          const cicilan = Array.isArray(data.cicilan) ? data.cicilan : [];
          const filteredCicilan = cicilan.filter((c) => !(
            c?.sumber === "rekap_gaji" &&
            dateKey(c?.periodeGajiDari) === dateKey(dari) &&
            dateKey(c?.periodeGajiSampai) === dateKey(sampai)
          ));
          if (filteredCicilan.length === cicilan.length) continue;
          const totalCicilanBaru = filteredCicilan.reduce((sum, c) => sum + Number(c.jumlah || 0), 0);
          const sisaKasbonBaru = Math.max(0, Number(data.jumlah || 0) - totalCicilanBaru);
          kasbonRollbackUpdates.push({
            ref,
            payload: {
              cicilan: filteredCicilan,
              sisaKasbon: sisaKasbonBaru,
              status: sisaKasbonBaru <= 0 ? "lunas" : "aktif",
              updatedAt: new Date().toISOString(),
            },
          });
        }

        kasbonRollbackUpdates.forEach(({ ref, payload }) => transaction.update(ref, payload));
        transaction.delete(markerRef);
        transaction.delete(historyRef);
      });
      showToast("↩️ Status gajian dibatalkan dan kasbon dikembalikan", 3500);
      refreshKasbon();
      refreshPayroll();
      refreshGajianHistory();
    } catch (e) {
      alert(friendlyErrorMessage("Membatalkan status gajian", e));
    } finally {
      setIsSaving(false);
    }
  }




  async function kaitkanEntryKePesanan() {
    if (!kaitkanModal) return;
    if (!kaitkanOrderId) return alert("Pilih pesanan tujuan terlebih dahulu.");

    const targetOrder = orders.find((o) => o.id === kaitkanOrderId);
    if (!targetOrder) return alert("Pesanan tidak ditemukan.");

    const entry = kaitkanModal;
    const alreadyLinked = entry.orderId || entry.pesananId;
    if (alreadyLinked && alreadyLinked !== kaitkanOrderId) {
      const okRelink = window.confirm(
        `Entry ini sudah terkait pesanan lain.\n\n` +
        `Lanjut pindahkan kaitan ke ${targetOrder.invoice || targetOrder.customer}?`
      );
      if (!okRelink) return;
    }

    const totals = setorTotals(entry);
    const hasSetor = Number(totals.qtySetor || 0) > 0 || Number(totals.qtyReject || 0) > 0;
    if (hasSetor) {
      const ok = window.confirm(
        `Entry ini sudah punya data setor (${totals.qtySetor || 0} pcs).\n` +
        `Mengubah pesanan tidak akan menghapus data setor/gaji yang sudah tersimpan.\n\n` +
        `Lanjut kaitkan ke pesanan ${targetOrder.invoice || targetOrder.customer}?`
      );
      if (!ok) return;
    }

    const prod = produksiByOrderId.get(kaitkanOrderId);
    const nextProduksiId = prod?.id || "";
    const currentProduksiId = String(entry.produksiId || entry.productionId || "").trim();
    const entryRef = doc(db, C.PRODUCTION_ENTRIES, entry.id);
    const oldProdRef = currentProduksiId && currentProduksiId !== nextProduksiId
      ? doc(db, C.PRODUKSI, currentProduksiId)
      : null;
    const prodRef = nextProduksiId ? doc(db, C.PRODUKSI, nextProduksiId) : null;

    setIsSaving(true);
    try {
      await runTransaction(db, async (transaction) => {
        const entrySnap = await transaction.get(entryRef);
        if (!entrySnap.exists()) throw new Error("Entry borongan tidak ditemukan.");

        const oldProdSnap = oldProdRef ? await transaction.get(oldProdRef) : null;
        const prodSnap = prodRef ? await transaction.get(prodRef) : null;
        const liveEntry = { id: entry.id, ...entrySnap.data() };
        const liveOldProduksiId = String(liveEntry.produksiId || liveEntry.productionId || currentProduksiId || "").trim();
        const shouldRemoveFromOldProd = oldProdRef && liveOldProduksiId && liveOldProduksiId !== nextProduksiId;

        if (shouldRemoveFromOldProd && oldProdSnap?.exists()) {
          const oldWorkers = Array.isArray(oldProdSnap.data().workers) ? oldProdSnap.data().workers : [];
          const nextOldWorkers = oldWorkers.filter((w) => w.entryId !== entry.id);
          if (nextOldWorkers.length !== oldWorkers.length) {
            transaction.update(oldProdRef, {
              workers: nextOldWorkers,
              updatedAt: todayStr(),
            });
          }
        }

        transaction.update(entryRef, {
          orderId: kaitkanOrderId,
          pesananId: kaitkanOrderId,
          invoice: targetOrder.invoice || "",
          customer: targetOrder.customer || "",
          item: targetOrder.item || "",
          productType: liveEntry.productType || targetOrder.productType || "Kerudung",
          model: liveEntry.model || targetOrder.model || "",
          produksiId: nextProduksiId,
          updatedAt: new Date().toISOString(),
          linkedAt: new Date().toISOString(),
          linkedBy: user?.email || user?.uid || "",
        });

        if (prodRef && prodSnap?.exists()) {
          const liveWorkers = Array.isArray(prodSnap.data().workers) ? prodSnap.data().workers : [];
          const nextWorker = {
            employeeName: liveEntry.employeeName,
            process: liveEntry.process,
            productType: liveEntry.productType || targetOrder.productType || "Kerudung",
            model: liveEntry.model || targetOrder.model || "",
            qty: Number(liveEntry.qty || 0),
            tanggal: liveEntry.tanggal || todayStr(),
            entryId: entry.id,
          };
          const hasWorker = liveWorkers.some((w) => w.entryId === entry.id);
          transaction.update(prodRef, {
            workers: hasWorker ? liveWorkers.map((w) => w.entryId === entry.id ? { ...w, ...nextWorker } : w) : [...liveWorkers, nextWorker],
            updatedAt: todayStr(),
          });
        }
      });

      showToast(`✅ Borongan ${displayWorkerName(entry.employeeName)} berhasil dikaitkan ke ${targetOrder.invoice || targetOrder.customer}`, 3500);
      setKaitkanModal(null);
      setKaitkanOrderId("");
      await Promise.all([refreshProductionEntries(), refreshProduksi()]);
    } catch (e) {
      alert(friendlyErrorMessage("Mengaitkan borongan ke pesanan", e));
    } finally {
      setIsSaving(false);
    }
  }


  async function simpanGajianLama(form) {
    if (!form.employeeName || !form.tanggalGaji || !form.periodeGajiDari || !form.periodeGajiSampai || !form.jumlah) {
      return alert("Lengkapi semua field: nama pekerja, tanggal gaji, periode, dan jumlah.");
    }
    const jumlah = nonNegativeMoney(form.jumlah);
    if (jumlah <= 0) return alert("Jumlah gaji harus lebih dari 0.");
    setIsSaving(true);
    try {
      await addDoc(collection(db, C.GAJIAN_HISTORY), {
        employeeName: displayWorkerName(form.employeeName),
        tanggalGaji: form.tanggalGaji,
        periodeGajiDari: form.periodeGajiDari,
        periodeGajiSampai: form.periodeGajiSampai,
        jumlah,
        source: "input_manual_lama",
        createdAt: todayStr(),
      });
      showToast("✅ Riwayat gajian berhasil disimpan", 3000);
      refreshGajianHistory();
      setFormGajianLama({ employeeName: "", tanggalGaji: todayStr(), periodeGajiDari: "", periodeGajiSampai: "", jumlah: "" });
    } catch (e) {
      alert(friendlyErrorMessage("Menyimpan data", e));
    } finally {
      setIsSaving(false);
    }
  }

  // ── Helper Kasbon ────────────────────────────────────────────────────────────
  function kasbonAktifUntukPekerja(nama) {
    const key = normalizeWorkerNameKey(nama);
    return kasbonList.filter((k) =>
      k.status === "aktif" &&
      normalizeWorkerNameKey(k.employeeName || "") === key &&
      nonNegativeMoney(k.sisaKasbon || 0) > 0
    ).sort((a, b) => (a.tanggal || "").localeCompare(b.tanggal || ""));
  }

  function totalSisaKasbonPekerja(nama) {
    return kasbonAktifUntukPekerja(nama).reduce((s, k) => s + nonNegativeMoney(k.sisaKasbon || 0), 0);
  }

  async function tandaiSudahGajianDanSimpanHistory(nama, r, dari = rekapDari, sampai = rekapSampai, carryOver = []) {
    if (!nama) return;
    if (sudahGajian(nama, dari, sampai)) {
      showToast("✅ Status gajian sudah tercatat", 2500);
      return;
    }
    const jumlah = nonNegativeMoney(r?.gaji || 0);
    if (jumlah <= 0) return alert("Total gaji masih Rp 0, tidak bisa ditandai sudah gajian.");

    const kasbonAktif = kasbonAktifUntukPekerja(nama);
    const totalKasbon = kasbonAktif.reduce((s, k) => s + nonNegativeMoney(k.sisaKasbon || 0), 0);
    const potonganKasbonEstimasi = Math.min(totalKasbon, jumlah);
    const gajiDiterimaEstimasi = jumlah - potonganKasbonEstimasi;

    let konfirmasiMsg = `Tandai ${nama} sudah gajian untuk periode ${dari} s/d ${sampai}?\nGaji kotor: ${money(jumlah)}`;
    if (totalKasbon > 0) {
      konfirmasiMsg += `\n\n💰 Kasbon aktif: ${money(totalKasbon)}\nPotongan kasbon: ${money(potonganKasbonEstimasi)}\nGaji diterima: ${money(gajiDiterimaEstimasi)}`;
    }
    const ok = window.confirm(konfirmasiMsg);
    if (!ok) return;

    const employeeDisplay = displayWorkerName(nama);
    const workerKey = normalizeWorkerNameKey(nama);
    const periodeKey = `${dateKey(dari)}_${dateKey(sampai)}`;
    const markerRef = doc(db, C.PAYROLL_EXPENSES, `gaji_marker_${safeDocId(workerKey, "worker")}_${safeDocId(periodeKey, "periode")}`);
    const historyRef = doc(db, C.GAJIAN_HISTORY, `gajian_${safeDocId(workerKey, "worker")}_${safeDocId(periodeKey, "periode")}`);
    const kasbonRefs = kasbonAktif.map((k) => ({ local: k, ref: doc(db, C.KASBON, k.id) }));

    let actualPotonganKasbon = 0;
    let actualGajiDiterima = jumlah;

    setIsSaving(true);
    try {
      const existingSnap = await getDocs(
        query(
          collection(db, C.PAYROLL_EXPENSES),
          where("source", "==", "gallery-produksi-gaji-marker"),
          where("employeeName", "==", employeeDisplay),
          where("periodeGajiDari", "==", dari),
          where("periodeGajiSampai", "==", sampai)
        )
      );
      if (!existingSnap.empty) {
        showToast("✅ Status gajian sudah tercatat (cek server)", 2500);
        return;
      }

      await runTransaction(db, async (transaction) => {
        const markerSnap = await transaction.get(markerRef);
        if (markerSnap.exists()) throw new Error("Status gajian periode ini sudah tercatat.");

        const liveKasbon = [];
        for (const item of kasbonRefs) {
          const snap = await transaction.get(item.ref);
          if (!snap.exists()) continue;
          const data = snap.data();
          const sisaLive = nonNegativeMoney(data.sisaKasbon || 0);
          if (sisaLive > 0 && data.status === "aktif") {
            liveKasbon.push({ ref: item.ref, data, sisaLive, id: item.local.id });
          }
        }

        let sisaPotong = Math.min(jumlah, liveKasbon.reduce((s, k) => s + k.sisaLive, 0));
        actualPotonganKasbon = sisaPotong;
        actualGajiDiterima = jumlah - actualPotonganKasbon;

        for (const kasbon of liveKasbon) {
          if (sisaPotong <= 0) break;
          const actualPotong = Math.min(sisaPotong, kasbon.sisaLive);
          const newCicilan = {
            id: (typeof crypto !== "undefined" && crypto.randomUUID)
              ? crypto.randomUUID()
              : `gaji-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            tanggal: todayStr(),
            jumlah: actualPotong,
            sumber: "rekap_gaji",
            periodeGajiDari: dari,
            periodeGajiSampai: sampai,
          };
          const existingCicilan = Array.isArray(kasbon.data.cicilan) ? kasbon.data.cicilan : [];
          const updatedCicilan = [...existingCicilan, newCicilan];
          const totalCicilan = updatedCicilan.reduce((s, c) => s + nonNegativeMoney(c.jumlah || 0), 0);
          const sisaBaru = Math.max(0, nonNegativeMoney(kasbon.data.jumlah || 0) - totalCicilan);
          transaction.update(kasbon.ref, {
            cicilan: updatedCicilan,
            sisaKasbon: sisaBaru,
            status: sisaBaru <= 0 ? "lunas" : "aktif",
            updatedAt: new Date().toISOString(),
          });
          sisaPotong -= actualPotong;
        }

        transaction.set(markerRef, {
          source: "gallery-produksi-gaji-marker",
          type: "status_gajian_periode",
          employeeName: employeeDisplay,
          periodeGajiDari: dari,
          periodeGajiSampai: sampai,
          tanggal: todayStr(),
          tanggalBayar: todayStr(),
          status: "sudah_dibayar",
          totalAmount: 0,
          gajiAmount: jumlah,
          potonganKasbon: actualPotonganKasbon,
          gajiDiterima: actualGajiDiterima,
          totalPcs: Number(r?.pcsSetor || 0),
          totalReject: Number(r?.pcsReject || 0),
          detailCount: Array.isArray(r?.detail) ? r.detail.length : 0,
          createdAt: todayStr(),
        });

        transaction.set(historyRef, {
          employeeName: employeeDisplay,
          tanggalGaji: todayStr(),
          periodeGajiDari: dari,
          periodeGajiSampai: sampai,
          jumlah,
          potonganKasbon: actualPotonganKasbon,
          gajiDiterima: actualGajiDiterima,
          totalPcs: Number(r?.pcsSetor || 0),
          totalReject: Number(r?.pcsReject || 0),
          source: "tandai_sudah_gajian",
          createdAt: todayStr(),
        });
      });

      const toastMsg = actualPotonganKasbon > 0
        ? `✅ Gajian tersimpan · Kasbon dipotong ${money(actualPotonganKasbon)}`
        : "✅ Status berubah menjadi Sudah gajian";
      showToast(toastMsg, 3500);
      refreshKasbon();
      refreshPayroll();
      refreshGajianHistory();
    } catch (e) {
      alert(friendlyErrorMessage("Menandai sudah gajian", e));
    } finally {
      setIsSaving(false);
    }
  }

  async function hapusGajianHistory(id) {
    if (!window.confirm("Hapus riwayat gajian ini?")) return;
    try {
      await deleteDoc(doc(db, C.GAJIAN_HISTORY, id));
      await refreshGajianHistory();
      showToast("🗑️ Riwayat gajian dihapus", 2500);
    } catch (e) {
      alert(friendlyErrorMessage("Menghapus data", e));
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeFileName(value) {
    return String(value || "SlipGaji")
      .trim()
      .replace(/[^a-zA-Z0-9-_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "SlipGaji";
  }

  function buildSlipHtml(nama, r, dari = rekapDari, sampai = rekapSampai, carryOver = []) {
    const fmt = (v) => new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(Number(v || 0));

    const sortedDetail = [...(r?.detail || [])].sort((a, b) => {
      const da = a.tanggalSetor || a.tanggal || "";
      const db = b.tanggalSetor || b.tanggal || "";
      return da.localeCompare(db);
    });

    const rows = sortedDetail.map((d, i) => {
      const tgl = escapeHtml(d.tanggalSetor || d.tanggal || "-");
      const invoice = d.invoice ? `<br><span style="font-size:10px;color:#94a3b8;">${escapeHtml(d.invoice)}</span>` : "";
      const pesanan = d.customer && d.customer !== "-" ? `${escapeHtml(d.customer)}${invoice}` : escapeHtml(d.invoice || "-");
      const prosesModel = `${escapeHtml(d.process || "")}${d.model && d.model !== "-" ? " · " + escapeHtml(d.model) : ""}`;
      const setor = d.sudahSetor ? Number(d.qtySetor || 0) : null;
      const reject = Number(d.qtyReject || 0);
      const pendapatan = d.sudahSetor
        ? `<strong style="color:#16a34a;">${fmt(d.gaji)}</strong>`
        : `<span style="color:#b45309;">Belum setor</span>`;

      return `<tr>
        <td>${i + 1}</td>
        <td>${tgl}</td>
        <td>${pesanan}</td>
        <td>${prosesModel}</td>
        <td class="center">${Number(d.qty || 0)} pcs</td>
        <td class="center ${setor !== null ? "ok" : "muted"}">${setor !== null ? setor + " pcs" : "-"}</td>
        <td class="center ${reject > 0 ? "bad" : "muted"}">${reject > 0 ? reject + " pcs" : "-"}</td>
        <td class="right">${Number(d.rate || 0) > 0 ? fmt(d.rate) + "/pcs" : "-"}</td>
        <td class="right">${pendapatan}</td>
      </tr>`;
    }).join("");

    const carryRows = (carryOver || []).map((e) => {
      const entryOrder = orders.find((o) => o.id === e.orderId);
      const model = e.model && e.model !== "-" ? ` · ${escapeHtml(e.model)}` : "";
      const periodeAsli = e.tanggal ? getMingguPeriod(e.tanggal) : null;
      const periode = periodeAsli ? `${periodeAsli.dari} s/d ${periodeAsli.sampai}` : (e.tanggal || "-");
      const cust = e.customer || entryOrder?.customer || "-";
      const sisaSetor = Number(setorTotals(e).sisaSetor || 0);
      return `<div class="carry-item">
        <strong>${escapeHtml(e.process || "")}${model}</strong>
        <span>${escapeHtml(cust)}${e.invoice ? " · " + escapeHtml(e.invoice) : ""}</span>
        <span>${escapeHtml(periode)} · ${sisaSetor} pcs belum disetor</span>
      </div>`;
    }).join("");

    const cetakTgl = new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
    const logoSrc = "/logo-gk.png";

    return `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Slip Pendapatan - ${escapeHtml(nama)}</title>
      <style>
        *{box-sizing:border-box} body{font-family:Segoe UI,Arial,sans-serif;background:#fdf2f8;margin:0;padding:18px;color:#2d1b69}
        .toolbar{position:sticky;top:0;z-index:5;display:flex;gap:10px;justify-content:center;margin-bottom:14px}.toolbar button{background:linear-gradient(135deg,#ec4899,#a855f7);color:#fff;border:0;border-radius:14px;padding:12px 22px;font-size:14px;font-weight:800;cursor:pointer}
        .slip{max-width:900px;margin:0 auto;background:#fff;border-radius:22px;overflow:hidden;box-shadow:0 8px 30px rgba(124,58,237,.18)}
        .header{background:linear-gradient(135deg,#ec4899,#a855f7);color:#fff;padding:24px 28px;display:flex;align-items:center;gap:16px}.header img{width:62px;height:62px;border-radius:16px;border:3px solid rgba(255,255,255,.45);background:#fff;object-fit:cover}.header h1{margin:0 0 4px;font-size:22px}.header p{margin:0;font-size:13px;opacity:.88}.body{padding:24px 28px}.info{background:#fdf4ff;border:1px solid #e9d5ff;border-radius:16px;padding:14px 16px;margin-bottom:16px}.info-row{display:flex;justify-content:space-between;gap:14px;font-size:13px;padding:4px 0}.info-row span{color:#94a3b8}.info-row strong{text-align:right;color:#2d1b69}
        table{width:100%;border-collapse:collapse;font-size:12px;overflow:hidden;border-radius:14px}thead tr{background:linear-gradient(135deg,#ede9fe,#fce7f3)}th{padding:10px 8px;text-align:left;color:#7c3aed;font-size:11px;white-space:nowrap}td{padding:9px 8px;border-bottom:1px solid #f3e8ff;vertical-align:top}.center{text-align:center}.right{text-align:right}.ok{color:#16a34a}.bad{color:#ef4444}.muted{color:#94a3b8}.total-row{background:linear-gradient(135deg,#ede9fe,#fce7f3);font-weight:800}.warning{margin-top:12px;background:#fefce8;border:1px solid #fde68a;border-radius:12px;padding:10px 14px;font-size:12px;color:#b45309}.total-box{margin-top:16px;background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:1.5px solid #bbf7d0;border-radius:16px;padding:16px 18px}.total-box div:first-child{font-size:12px;color:#64748b;margin-bottom:4px}.total-box div:last-child{font-size:28px;font-weight:900;color:#16a34a}.carry{margin-top:16px;background:#fff7ed;border:1.5px solid #fed7aa;border-radius:16px;padding:14px;color:#92400e}.carry h3{margin:0 0 8px;font-size:13px;color:#b45309}.carry-item{background:#fef3c7;border:1px solid #fde68a;border-radius:10px;padding:8px 10px;margin-top:7px;font-size:12px;display:grid;gap:2px}.carry-item span{color:#92400e}.ttd{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:24px}.ttd-box{border:1px solid #e9d5ff;border-radius:14px;padding:14px;text-align:center}.ttd-box .label{font-size:11px;color:#94a3b8;margin-bottom:54px}.ttd-box .name{font-size:12px;font-weight:800;border-top:1.5px solid #c4b5fd;padding-top:7px}.footer{text-align:center;font-size:11px;color:#a855f7;padding:15px 20px;border-top:1px solid #fce7f3}
        @media(max-width:720px){body{padding:8px}.body{padding:16px}.header{padding:18px}.header h1{font-size:18px}table{font-size:10px}th,td{padding:7px 5px}.ttd{grid-template-columns:1fr}.toolbar{padding:8px;background:#fdf2f8}}
        @media print{body{background:#fff;padding:0}.toolbar{display:none}.slip{box-shadow:none;border-radius:0;max-width:none}@page{margin:1cm}}
      </style>
    </head><body>
      <div class="toolbar"><button onclick="window.print()">Cetak / Simpan PDF</button></div>
      <div class="slip">
        <div class="header"><img src="${logoSrc}" onerror="this.style.display='none'" /><div><h1>Slip Pendapatan Borongan</h1><p>Gallery Kerudung · Dokumen resmi penggajian borongan</p></div></div>
        <div class="body">
          <div class="info">
            <div class="info-row"><span>Nama Pekerja</span><strong>${escapeHtml(nama)}</strong></div>
            <div class="info-row"><span>Periode</span><strong>${escapeHtml(dari)} s/d ${escapeHtml(sampai)}</strong></div>
            <div class="info-row"><span>Tanggal Cetak</span><strong>${escapeHtml(cetakTgl)}</strong></div>
          </div>
          <table><thead><tr><th>#</th><th>Tanggal</th><th>Pesanan</th><th>Proses / Model</th><th class="center">Diberi</th><th class="center">Setor</th><th class="center">Reject</th><th class="right">Tarif</th><th class="right">Pendapatan</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="9" class="center muted">Tidak ada detail pekerjaan</td></tr>`}</tbody>
          <tfoot><tr class="total-row"><td colspan="4">TOTAL</td><td class="center">${Number(r?.pcsAwal || 0)} pcs</td><td class="center ok">${Number(r?.pcsSetor || 0)} pcs</td><td class="center ${Number(r?.pcsReject || 0) > 0 ? "bad" : "muted"}">${Number(r?.pcsReject || 0) > 0 ? Number(r.pcsReject) + " pcs" : "-"}</td><td></td><td class="right ok">${fmt(r?.gaji)}</td></tr></tfoot></table>
          ${Number(r?.belumSetor || 0) > 0 ? `<div class="warning">Masih ada <strong>${Number(r.belumSetor)} pcs</strong> belum disetor, belum termasuk total di atas.</div>` : ""}
          <div class="total-box"><div>Total Pendapatan Bersih</div><div>${fmt(r?.gaji)}</div></div>
          ${carryRows ? `<div class="carry"><h3>Tanggungan Minggu Lalu (Belum Disetor)</h3>${carryRows}</div>` : ""}
          <div class="ttd"><div class="ttd-box"><div class="label">Hormat kami,</div><div class="name">${escapeHtml(nama)}</div></div><div class="ttd-box"><div class="label">Mengetahui, Gallery Kerudung</div><div class="name">Astri Apriani</div></div></div>
        </div>
        <div class="footer">Dicetak otomatis oleh sistem Gallery Kerudung · ${escapeHtml(cetakTgl)}</div>
      </div>
    </body></html>`;
  }

  function downloadSlipGaji(nama, r, dari = rekapDari, sampai = rekapSampai, carryOver = []) {
    try {
      const html = buildSlipHtml(nama, r, dari, sampai, carryOver);
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const filename = `SlipGaji_${safeFileName(nama)}_${safeFileName(dari)}_sd_${safeFileName(sampai)}.html`;

      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);

      const printTab = window.open("", "_blank", "noopener,noreferrer");
      if (printTab) {
        printTab.document.open();
        printTab.document.write(html);
        printTab.document.close();
      }

      showToast("✅ Slip gaji berhasil dibuat. Buka file HTML lalu pilih Cetak / Simpan PDF.", 4500);
      return html;
    } catch (e) {
      alert(friendlyErrorMessage("Membuat slip gaji", e));
      return "";
    }
  }

  function drawRoundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 2) {
    const words = String(text || "").split(/\s+/);
    let line = "";
    let lines = 0;
    for (let n = 0; n < words.length; n++) {
      const testLine = line ? line + " " + words[n] : words[n];
      if (ctx.measureText(testLine).width > maxWidth && line) {
        ctx.fillText(line, x, y);
        line = words[n];
        y += lineHeight;
        lines += 1;
        if (lines >= maxLines - 1) break;
      } else {
        line = testLine;
      }
    }
    if (line) ctx.fillText(line, x, y);
    return y + lineHeight;
  }

  function loadImageForCanvas(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function drawFallbackLogo(ctx, x, y, size) {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ec4899";
    ctx.font = `bold ${Math.round(size * 0.38)}px Segoe UI, Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("GK", x + size / 2, y + size / 2 + 1);
    ctx.restore();
  }

  async function createSlipImageFile(nama, r, dari = rekapDari, sampai = rekapSampai, carryOver = []) {
    try {
      const fmt = (v) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(v || 0));
      const sortedDetail = [...(r?.detail || [])].sort((a, b) => (a.tanggalSetor || a.tanggal || "").localeCompare(b.tanggalSetor || b.tanggal || ""));
      const detailRows = sortedDetail.slice(0, 14);
      const extraRows = Math.max(0, sortedDetail.length - detailRows.length);
      const W = 900;
      const hasWarning = Number(r?.belumSetor || 0) > 0;
      const hasCarryOver = (carryOver || []).length > 0;
      const H = 870 + detailRows.length * 74 + (extraRows > 0 ? 28 : 0) + (hasWarning ? 56 : 0) + (hasCarryOver ? 72 : 0);
      // Render 2× resolusi agar gambar tajam di layar HP (retina/high-DPI)
      const DPR = 2;
      const canvas = document.createElement("canvas");
      canvas.width = W * DPR;
      canvas.height = H * DPR;
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas tidak tersedia di browser ini.");
      ctx.scale(DPR, DPR);

      ctx.fillStyle = "#fdf2f8";
      ctx.fillRect(0, 0, W, H);

      const grad = ctx.createLinearGradient(0, 0, W, 120);
      grad.addColorStop(0, "#ec4899");
      grad.addColorStop(1, "#a855f7");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, 120);

      const logoImg = await loadImageForCanvas("/logo-gk.png");
      if (logoImg) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(70, 60, 38, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(32, 22, 76, 76);
        ctx.drawImage(logoImg, 32, 22, 76, 76);
        ctx.restore();
      } else {
        drawFallbackLogo(ctx, 32, 22, 76);
      }

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 30px Segoe UI, Arial";
      ctx.fillText("Slip Pendapatan Borongan", 126, 48);
      ctx.font = "18px Segoe UI, Arial";
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.fillText("Gallery Kerudung", 126, 76);
      ctx.font = "15px Segoe UI, Arial";
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.fillText(`Periode ${dari} s/d ${sampai}`, 126, 100);

      let y = 148;
      drawRoundedRect(ctx, 28, y, W - 56, 96, 18);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.font = "16px Segoe UI, Arial";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText("Nama Pekerja", 52, y + 34);
      ctx.fillText("Tanggal Cetak", 52, y + 68);
      ctx.textAlign = "right";
      ctx.font = "bold 18px Segoe UI, Arial";
      ctx.fillStyle = "#2d1b69";
      ctx.fillText(String(nama || "-"), W - 52, y + 34);
      ctx.fillText(new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" }), W - 52, y + 68);
      ctx.textAlign = "left";

      y += 118;
      const statW = (W - 76) / 3;
      [["Diberikan", r?.pcsAwal || 0, "#ede9fe", "#5b21b6"], ["Disetor", r?.pcsSetor || 0, "#dcfce7", "#16a34a"], ["Reject", r?.pcsReject || 0, Number(r?.pcsReject || 0) > 0 ? "#fee2e2" : "#f1f5f9", Number(r?.pcsReject || 0) > 0 ? "#ef4444" : "#64748b"]].forEach(([label, val, bg, color], i) => {
        const x = 28 + i * (statW + 10);
        drawRoundedRect(ctx, x, y, statW, 70, 16);
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.textAlign = "center";
        ctx.fillStyle = color;
        ctx.font = "bold 24px Segoe UI, Arial";
        ctx.fillText(String(val), x + statW / 2, y + 31);
        ctx.font = "15px Segoe UI, Arial";
        ctx.fillStyle = "#64748b";
        ctx.fillText(label, x + statW / 2, y + 54);
        ctx.textAlign = "left";
      });

      y += 94;
      drawRoundedRect(ctx, 28, y, W - 56, 44, 14);
      const hgrad = ctx.createLinearGradient(28, y, W - 28, y + 44);
      hgrad.addColorStop(0, "#ede9fe");
      hgrad.addColorStop(1, "#fce7f3");
      ctx.fillStyle = hgrad;
      ctx.fill();
      ctx.fillStyle = "#7c3aed";
      ctx.font = "bold 16px Segoe UI, Arial";
      ctx.fillText("Detail Pekerjaan", 50, y + 28);
      y += 54;

      detailRows.forEach((d) => {
        drawRoundedRect(ctx, 28, y, W - 56, 64, 14);
        ctx.fillStyle = d.sudahSetor ? "#f0fdf4" : "#fefce8";
        ctx.fill();
        ctx.fillStyle = "#2d1b69";
        ctx.font = "bold 16px Segoe UI, Arial";
        drawWrappedText(ctx, `${d.process || ""}${d.model && d.model !== "-" ? " · " + d.model : ""}`, 50, y + 23, 450, 18, 1);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "13px Segoe UI, Arial";
        drawWrappedText(ctx, `${d.customer || "-"}${d.invoice ? " / " + d.invoice : ""}`, 50, y + 45, 440, 16, 1);
        ctx.textAlign = "right";
        ctx.font = "bold 16px Segoe UI, Arial";
        ctx.fillStyle = d.sudahSetor ? "#16a34a" : "#b45309";
        ctx.fillText(d.sudahSetor ? `${Number(d.qtySetor || 0)} pcs` : `${Number(d.qty || 0)} pcs`, W - 50, y + 24);
        ctx.font = "bold 16px Segoe UI, Arial";
        ctx.fillStyle = "#7c3aed";
        ctx.fillText(d.sudahSetor ? fmt(d.gaji) : "Belum setor", W - 50, y + 48);
        ctx.textAlign = "left";
        y += 74;
      });

      if (extraRows > 0) {
        ctx.fillStyle = "#64748b";
        ctx.font = "14px Segoe UI, Arial";
        ctx.fillText(`+ ${extraRows} detail lain ada di slip PDF/HTML`, 50, y + 8);
        y += 28;
      }

      if (Number(r?.belumSetor || 0) > 0) {
        drawRoundedRect(ctx, 28, y, W - 56, 42, 12);
        ctx.fillStyle = "#fefce8";
        ctx.fill();
        ctx.fillStyle = "#b45309";
        ctx.font = "bold 15px Segoe UI, Arial";
        ctx.fillText(`Masih ada ${Number(r.belumSetor)} pcs belum disetor`, 50, y + 27);
        y += 56;
      }

      if ((carryOver || []).length > 0) {
        drawRoundedRect(ctx, 28, y, W - 56, 58, 12);
        ctx.fillStyle = "#fff7ed";
        ctx.fill();
        ctx.fillStyle = "#b45309";
        ctx.font = "bold 15px Segoe UI, Arial";
        ctx.fillText(`Tanggungan minggu lalu: ${(carryOver || []).reduce((s, e) => s + Number(setorTotals(e).sisaSetor || 0), 0)} pcs`, 50, y + 34);
        y += 72;
      }

      drawRoundedRect(ctx, 28, y, W - 56, 86, 18);
      const totalGrad = ctx.createLinearGradient(28, y, W - 28, y + 86);
      totalGrad.addColorStop(0, "#f0fdf4");
      totalGrad.addColorStop(1, "#dcfce7");
      ctx.fillStyle = totalGrad;
      ctx.fill();
      ctx.fillStyle = "#64748b";
      ctx.font = "16px Segoe UI, Arial";
      ctx.fillText("Total Pendapatan Bersih", 52, y + 30);
      ctx.fillStyle = "#16a34a";
      ctx.font = "bold 34px Segoe UI, Arial";
      ctx.fillText(fmt(r?.gaji), 52, y + 66);

      y += 112;

      // Tanda tangan ikut digambar ke PNG supaya hasil Share WA sama lengkapnya
      // dengan slip HTML/PDF.
      const signY = y;
      const signGap = 24;
      const signW = (W - 56 - signGap) / 2;
      const signH = 126;
      const signBoxes = [
        { x: 28, label: "Hormat kami,", name: String(nama || "-") },
        { x: 28 + signW + signGap, label: "Mengetahui, Gallery Kerudung", name: "Astri Apriani" },
      ];
      signBoxes.forEach((box) => {
        drawRoundedRect(ctx, box.x, signY, signW, signH, 16);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = "#e9d5ff";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.textAlign = "center";
        ctx.fillStyle = "#94a3b8";
        ctx.font = "13px Segoe UI, Arial";
        ctx.fillText(box.label, box.x + signW / 2, signY + 28);

        ctx.strokeStyle = "#c4b5fd";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(box.x + signW * 0.2, signY + 92);
        ctx.lineTo(box.x + signW * 0.8, signY + 92);
        ctx.stroke();

        ctx.fillStyle = "#2d1b69";
        ctx.font = "bold 14px Segoe UI, Arial";
        ctx.fillText(box.name, box.x + signW / 2, signY + 112);
        ctx.textAlign = "left";
      });

      y = signY + signH + 38;
      ctx.fillStyle = "#c084fc";
      ctx.font = "bold 14px Segoe UI, Arial";
      ctx.textAlign = "center";
      ctx.fillText(`Gallery Kerudung · ${new Date().toLocaleDateString("id-ID")}`, W / 2, y);
      ctx.textAlign = "left";

      // Cara share dibuat sama seperti app Gallery Kerudung:
      // 1) Canvas diubah menjadi data URL PNG.
      // 2) Data URL diubah menjadi File.
      // 3) Jika browser/device mendukung Web Share file, buka share sheet agar WhatsApp bisa dipilih.
      // 4) Jika tidak mendukung, baru fallback download PNG.
      const imgUrl = canvas.toDataURL("image/png");
      const res = await fetch(imgUrl);
      const blob = await res.blob();
      if (!blob) throw new Error("Gagal membuat gambar slip.");

      const filename = `SlipGaji_${safeFileName(nama)}_${safeFileName(dari)}_sd_${safeFileName(sampai)}.png`;
      const file = new File([blob], filename, { type: "image/png" });
      return { imgUrl, file, filename, nama, dari, sampai, total: fmt(r?.gaji) };
    } catch (e) {
      alert(friendlyErrorMessage("Membuat gambar slip gaji", e));
      return null;
    }
  }

  async function shareSlipGajiAsImage(nama, r, dari = rekapDari, sampai = rekapSampai, carryOver = []) {
    const slipImage = await createSlipImageFile(nama, r, dari, sampai, carryOver);
    if (!slipImage?.file) return;

    try {
      if (navigator.canShare && navigator.canShare({ files: [slipImage.file] }) && navigator.share) {
        await navigator.share({
          files: [slipImage.file],
          title: `Slip Gaji ${slipImage.nama}`,
          text: `Slip Pendapatan Borongan - ${slipImage.nama} (${slipImage.dari} s/d ${slipImage.sampai})`,
        });
        showToast("✅ Pilih WhatsApp di menu share untuk mengirim slip sebagai gambar.", 3500);
        return;
      }

      const a = document.createElement("a");
      a.href = slipImage.imgUrl;
      a.download = slipImage.filename || "SlipGaji.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast("⚠️ Browser ini tidak mendukung share gambar langsung. Gambar slip diunduh sebagai PNG.", 6000);
    } catch (e) {
      if (e?.name === "AbortError") return;
      alert(friendlyErrorMessage("Share slip gaji", e));
    }
  }

  const rekapData = useMemo(() => {
  const rekapPeriodReady = Boolean(rekapDari && rekapSampai);
  const inRange = (tanggal) => rekapPeriodReady && dateInRange(tanggal, rekapDari, rekapSampai);
  const filtered = productionEntries.filter((e) => {
    const hasInputInRange = inRange(e.tanggal);
    const hasSetorInRange = setorHistoryInRange(e, rekapDari, rekapSampai).length > 0;
    return hasInputInRange || hasSetorInRange;
  });
  const byProses = {};
  filtered.forEach((e) => {
    const p = e.process || "Lainnya";
    const allTotals = setorTotals(e);
    const rangeTotals = setorTotalsFromHistory(setorHistoryInRange(e, rekapDari, rekapSampai));
    const inputInRange = inRange(e.tanggal);
    // Basis "Diberi" di Rekap tidak boleh hanya melihat tanggal pemberian.
    // Kalau pekerjaan diberi minggu lalu tetapi disetor minggu ini, qty tersebut tetap harus menjadi basis rekap periode ini.
    // Ini mencegah tampilan tidak logis seperti Diberi 174 tetapi Setor 554.
    const aktivitasSetorPeriode = Number(rangeTotals.qtySetor || 0) + Number(rangeTotals.qtyReject || 0);
    const qtyBasisPeriode = inputInRange
      ? Math.max(Number(e.qty || 0), aktivitasSetorPeriode)
      : aktivitasSetorPeriode;
    if (!byProses[p]) byProses[p] = { qty: 0, qtySetor: 0, qtyReject: 0, gaji: 0 };
    byProses[p].qty += Math.max(0, qtyBasisPeriode);
    byProses[p].qtySetor += Number(rangeTotals.qtySetor || 0);
    byProses[p].qtyReject += Number(rangeTotals.qtyReject || 0);
    byProses[p].gaji += Number(rangeTotals.totalWageSetor || 0);
    if (inputInRange && rangeTotals.qtySetor === 0 && rangeTotals.qtyReject === 0 && allTotals.statusSetor !== "belum_setor") {
      // Entry masuk periode ini tetapi setor terjadi di luar periode: tetap tampil sebagai belum masuk gaji periode.
    }
  });
  const totalQty = filtered.reduce((s, e) => {
    const inputInRange = inRange(e.tanggal);
    const rangeTotals = setorTotalsFromHistory(setorHistoryInRange(e, rekapDari, rekapSampai));
    const aktivitasSetorPeriode = Number(rangeTotals.qtySetor || 0) + Number(rangeTotals.qtyReject || 0);
    const qtyBasisPeriode = inputInRange
      ? Math.max(Number(e.qty || 0), aktivitasSetorPeriode)
      : aktivitasSetorPeriode;
    return s + Math.max(0, qtyBasisPeriode);
  }, 0);
  const totalSetor = filtered.reduce((s, e) => s + Number(setorTotalsFromHistory(setorHistoryInRange(e, rekapDari, rekapSampai)).qtySetor || 0), 0);
  const totalReject = filtered.reduce((s, e) => s + Number(setorTotalsFromHistory(setorHistoryInRange(e, rekapDari, rekapSampai)).qtyReject || 0), 0);
  const totalGaji = filtered.reduce((s, e) => s + Number(setorTotalsFromHistory(setorHistoryInRange(e, rekapDari, rekapSampai)).totalWageSetor || 0), 0);
  const prosesOrder = ["Potong", "Jahit", "Pengemasan QC"];
  const prosesKeys = [...prosesOrder.filter((p) => byProses[p]), ...Object.keys(byProses).filter((p) => !prosesOrder.includes(p))];
  // Rekap per proses harus berdiri sendiri per proses, bukan memakai rantai Potong -> Jahit -> QC.
  // Alasannya: banyak pekerjaan carry-over dari periode sebelumnya disetor pada periode ini.
  // Jadi angka "Diberi" minimal mengikuti aktivitas setor/reject periode ini agar tidak muncul Diberi < Setor.
  Object.keys(byProses).forEach((p) => {
    const aktivitasSetorPeriode = Number(byProses[p].qtySetor || 0) + Number(byProses[p].qtyReject || 0);
    byProses[p].qtyDiberikan = Math.max(Number(byProses[p].qty || 0), aktivitasSetorPeriode);
  });

  // Rekap per pekerja: gaji dihitung dari transaksi setor yang masuk periode, bukan sekadar qty awal.
  const rekapMap = {};
  filtered.forEach((e) => {
    const namaKey = normalizeWorkerNameKey(e.employeeName);
    const nama = canonicalByExisting(e.employeeName, workerNameOptions, "worker");
    const inputInRange = inRange(e.tanggal);
    const rangeHistory = setorHistoryInRange(e, rekapDari, rekapSampai);
    const rangeTotals = setorTotalsFromHistory(rangeHistory);
    const allTotals = setorTotals(e);
    if (!rekapMap[nama]) rekapMap[nama] = { pcsAwal: 0, pcsSetor: 0, pcsReject: 0, gaji: 0, belumSetor: 0, detail: [] };
    // Basis "Diberi" per pekerja: pekerjaan yang diberi dalam periode + pekerjaan lama yang disetor/reject dalam periode.
    // Jadi angka Diberi tidak lebih kecil dari Setor karena carry-over minggu sebelumnya.
    const aktivitasSetorPeriode = Number(rangeTotals.qtySetor || 0) + Number(rangeTotals.qtyReject || 0);
    const qtyBasisPeriode = inputInRange
      ? Math.max(Number(e.qty || 0), aktivitasSetorPeriode)
      : aktivitasSetorPeriode;
    rekapMap[nama].pcsAwal += Math.max(0, qtyBasisPeriode);
    rekapMap[nama].pcsSetor += Number(rangeTotals.qtySetor || 0);
    rekapMap[nama].pcsReject += Number(rangeTotals.qtyReject || 0);
    rekapMap[nama].gaji += Number(rangeTotals.totalWageSetor || 0);
    if (inputInRange) rekapMap[nama].belumSetor += Number(allTotals.sisaSetor || 0);
    // Fallback customer dari orders jika entry lama tidak punya field customer
    const entryOrder = orderLookupForCards.byId.get(String(e.orderId || "").trim());
    rekapMap[nama].detail.push({
      customer: e.customer || entryOrder?.customer || "-",
      invoice: e.invoice || entryOrder?.invoice || "",
      model: displayModelName(e.model || "-"),
      process: e.process || "",
      qty: Math.max(0, qtyBasisPeriode),
      qtyAsli: Number(e.qty || 0),
      qtySetor: Number(rangeTotals.qtySetor || 0),
      qtyReject: Number(rangeTotals.qtyReject || 0),
      totalSetorSemua: Number(allTotals.qtySetor || 0),
      sisaSetor: Number(allTotals.sisaSetor || 0),
      rate: Number(e.rate || 0),
      sudahSetor: Number(rangeTotals.qtySetor || 0) > 0 || Number(rangeTotals.qtyReject || 0) > 0,
      setorSebagian: allTotals.statusSetor === "setor_sebagian",
      gaji: Number(rangeTotals.totalWageSetor || 0),
      tanggal: e.tanggal || "",
      tanggalSetor: rangeHistory.length > 0 ? rangeHistory[rangeHistory.length - 1].tanggalSetor : (allTotals.tanggalSetor || ""),
      setorHistory: rangeHistory,
    });
  });
  const rekapPerkerja = Object.entries(rekapMap)
    // Rekap Gaji Per Orang hanya menampilkan pekerja yang punya aktivitas setor/reject/gaji pada periode.
    // Borongan yang baru diberikan tetapi belum setor tetap tampil di bagian "Borongan Belum Masuk Rekap".
    .filter(([, r]) => Number(r.pcsSetor || 0) > 0 || Number(r.pcsReject || 0) > 0 || Number(r.gaji || 0) > 0)
    .sort((a, b) => b[1].gaji - a[1].gaji);
  const rekapGajianKeseluruhan = rekapPerkerja.reduce((acc, [nama, r]) => {
    const sudah = sudahGajian(nama, rekapDari, rekapSampai);
    const nominal = Number(r?.gaji || 0);
    acc.totalPekerja += 1;
    acc.totalGaji += nominal;
    acc.totalPcsSetor += Number(r?.pcsSetor || 0);
    acc.totalPcsReject += Number(r?.pcsReject || 0);
    acc.totalBelumSetor += Number(r?.belumSetor || 0);
    if (sudah) {
      acc.sudahGajian += 1;
      acc.totalSudahDibayar += nominal;
    } else {
      acc.belumGajian += 1;
      acc.totalBelumDibayar += nominal;
    }
    return acc;
  }, {
    totalPekerja: 0,
    sudahGajian: 0,
    belumGajian: 0,
    totalGaji: 0,
    totalSudahDibayar: 0,
    totalBelumDibayar: 0,
    totalPcsSetor: 0,
    totalPcsReject: 0,
    totalBelumSetor: 0,
  });

  const allTimePayrollRows = payrollExpenses
    .filter(isOfficialGajiPayroll)
    .sort((a, b) => String(dateKey(b.tanggal || b.tanggalSetor || b.createdAt || "")).localeCompare(String(dateKey(a.tanggal || a.tanggalSetor || a.createdAt || ""))));

  const allTimePayrollMap = {};
  allTimePayrollRows.forEach((p) => {
    const nama = canonicalByExisting(p.employeeName, workerNameOptions, "worker");
    const key = normalizeWorkerNameKey(nama);
    if (!key) return;
    if (!allTimePayrollMap[nama]) {
      allTimePayrollMap[nama] = { pcsAwal: 0, pcsSetor: 0, pcsReject: 0, gaji: 0, belumSetor: 0, transaksi: 0, firstDate: "", lastDate: "", detail: [] };
    }

    const tanggal = dateKey(p.tanggal || p.tanggalSetor || p.createdAt || "");
    const pcs = Number(p.totalPcs || p.qtySetor || p.qty || 0);
    const reject = Number(p.totalReject || p.qtyReject || 0);
    const gaji = Number(p.totalAmount || 0);

    allTimePayrollMap[nama].pcsSetor += pcs;
    allTimePayrollMap[nama].pcsReject += reject;
    allTimePayrollMap[nama].pcsAwal += Math.max(0, pcs + reject);
    allTimePayrollMap[nama].gaji += gaji;
    allTimePayrollMap[nama].transaksi += 1;
    if (tanggal) {
      if (!allTimePayrollMap[nama].firstDate || tanggal < allTimePayrollMap[nama].firstDate) allTimePayrollMap[nama].firstDate = tanggal;
      if (!allTimePayrollMap[nama].lastDate || tanggal > allTimePayrollMap[nama].lastDate) allTimePayrollMap[nama].lastDate = tanggal;
    }
    allTimePayrollMap[nama].detail.push({
      tanggalSetor: tanggal || "-",
      process: p.process || "-",
      model: canonicalByExisting(p.model || p.productType || "-", modelNameOptions, "model"),
      invoice: p.invoice || "",
      customer: p.customer || "-",
      qtySetor: pcs,
      qtyReject: reject,
      wage: gaji,
      source: p.source || "payroll_expenses",
    });
  });

  const rekapGajiAllTimeRows = Object.entries(allTimePayrollMap)
    .filter(([, r]) => Number(r.gaji || 0) > 0 || Number(r.pcsSetor || 0) > 0)
    .sort((a, b) => Number(b[1].gaji || 0) - Number(a[1].gaji || 0));

  const rekapGajiAllTimeSummary = rekapGajiAllTimeRows.reduce((acc, [, r]) => {
    acc.totalPekerja += 1;
    acc.totalGaji += Number(r.gaji || 0);
    acc.totalPcsSetor += Number(r.pcsSetor || 0);
    acc.totalPcsReject += Number(r.pcsReject || 0);
    acc.totalTransaksi += Number(r.transaksi || 0);
    return acc;
  }, { totalPekerja: 0, totalGaji: 0, totalPcsSetor: 0, totalPcsReject: 0, totalTransaksi: 0 });

  const boronganBelumMasukRekap = !rekapPeriodReady ? [] : productionEntries
    .map((e) => {
      const totals = setorTotals(e);
      const rangeHistory = setorHistoryInRange(e, rekapDari, rekapSampai);
      const rangeTotals = setorTotalsFromHistory(rangeHistory);
      const inputInRange = inRange(e.tanggal);
      const entryOrder = orderLookupForCards.byId.get(String(e.orderId || "").trim());
      const totalProgress = Number(totals.qtySetor || 0) + Number(totals.qtyReject || 0);
      const sisaSetor = Number(totals.sisaSetor || 0);
      let alasan = "";
      if (sisaSetor > 0 && inputInRange && rangeHistory.length === 0) alasan = "Diberikan periode ini, belum setor";
      else if (sisaSetor > 0 && inputInRange && rangeHistory.length > 0) alasan = "Setor sebagian, masih ada sisa";
      else if (sisaSetor > 0 && dateBefore(e.tanggal, rekapDari)) alasan = "Tanggungan dari periode sebelumnya";
      // Borongan setelah periode rekap tidak ditampilkan di sini agar tidak membingungkan.
      return {
        ...e,
        customer: e.customer || entryOrder?.customer || "-",
        invoice: e.invoice || entryOrder?.invoice || "",
        totalSetorSemua: Number(totals.qtySetor || 0),
        totalRejectSemua: Number(totals.qtyReject || 0),
        totalWageSemua: Number(totals.totalWageSetor || 0),
        sisaSetor,
        statusSetorHitung: totals.statusSetor,
        tanggalSetorTerakhir: totals.tanggalSetor || "",
        qtySetorPeriode: Number(rangeTotals.qtySetor || 0),
        qtyRejectPeriode: Number(rangeTotals.qtyReject || 0),
        gajiPeriode: Number(rangeTotals.totalWageSetor || 0),
        alasan,
      };
    })
    .filter((e) => e.alasan && Number(e.sisaSetor || 0) > 0)
    .sort((a, b) => {
      if (a.tanggal !== b.tanggal) return String(a.tanggal || "").localeCompare(String(b.tanggal || ""));
      return displayWorkerName(a.employeeName).localeCompare(displayWorkerName(b.employeeName));
    });

  const totalBoronganBelumMasukPcs = boronganBelumMasukRekap.reduce((s, e) => s + Number(e.sisaSetor || 0), 0);
  const totalBoronganBelumMasukGajiPotensi = boronganBelumMasukRekap.reduce((s, e) => s + (Number(e.sisaSetor || 0) * Number(e.rate || 0)), 0);


    return {
      rekapPeriodReady,
      inRange,
      filtered,
      byProses,
      totalQty,
      totalSetor,
      totalReject,
      totalGaji,
      prosesOrder,
      prosesKeys,
      rekapMap,
      rekapPerkerja,
      rekapGajianKeseluruhan,
      allTimePayrollRows,
      allTimePayrollMap,
      rekapGajiAllTimeRows,
      rekapGajiAllTimeSummary,
      boronganBelumMasukRekap,
      totalBoronganBelumMasukPcs,
      totalBoronganBelumMasukGajiPotensi,
    };
  }, [productionEntries, rekapDari, rekapSampai, workerNameOptions, modelNameOptions, payrollExpenses, orders, orderLookupForCards]);

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: "#fdf2f8" }}>
        <GlobalReadableStyle />
        <div style={{ color: "#ec4899" }} className="text-lg font-semibold">Memuat...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center p-6"
        style={{ background: "linear-gradient(135deg,#fdf2f8 0%,#fce7f3 50%,#ede9fe 100%)" }}
      >
        <GlobalReadableStyle />
        <div className="w-full max-w-sm rounded-3xl bg-white/80 p-8 shadow-xl text-center" style={{ border: "1.5px solid #f9a8d4" }}>
          <div className="mb-2 text-4xl">🏭✨</div>
          <div
            className="mb-1 text-3xl font-bold"
            style={{
              background: "linear-gradient(135deg,#ec4899,#a855f7)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            Gallery Produksi
          </div>
          <div className="mb-6 text-sm font-medium" style={{ color: "#c084fc" }}>
            by Gallery Kerudung
          </div>
          {authError && <div className="mb-4 rounded-2xl bg-rose-50 p-3 text-sm text-rose-500">{authError}</div>}
          <button
            onClick={() => {
              setAuthError("");
              signInWithPopup(auth, provider).catch((e) => setAuthError(friendlyErrorMessage("Login", e)));
            }}
            className="w-full rounded-2xl px-6 py-4 font-bold text-white"
            style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}
          >
            Masuk dengan Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-md" style={{ background: "#fdf2f8" }}>
      <GlobalReadableStyle />
      {toast && (
        <div className="fixed left-4 right-4 top-4 z-[60] rounded-2xl bg-white px-4 py-3 text-sm font-bold shadow-xl"
          style={{ color: "#7c3aed", border: "1.5px solid #e9d5ff" }}>
          {toast}
        </div>
      )}

      <div className="p-6 text-white relative overflow-hidden" style={{ background: "linear-gradient(135deg,#ec4899 0%,#a855f7 100%)" }}>
        <div className="flex items-start justify-between relative z-10">
          <div>
            <div className="text-4xl font-extrabold leading-tight">Gallery Produksi</div>
            <div className="mt-2 text-lg opacity-90">💕 made by order ✨</div>
          </div>
          <div className="flex flex-col items-center gap-3">
            <img
              src="/logo-gk.png"
              alt="Gallery Kerudung"
              className="w-20 h-20 rounded-3xl object-cover"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
              style={{ background: "rgba(255,255,255,0.14)", border: "3px solid rgba(255,255,255,0.35)" }}
            />
            <button onClick={() => signOut(auth)} className="rounded-full px-6 py-2 text-sm font-bold" style={{ background: "rgba(255,255,255,0.25)" }}>
              Keluar
            </button>
          </div>
        </div>
        <div className="mt-7 rounded-3xl px-5 py-4 flex items-center gap-4 relative z-10" style={{ background: "rgba(255,255,255,0.22)" }}>
          <span className="text-2xl">🔍</span>
          <input
            value={search}
            onChange={(v) => setSearch(inputValue(v))}
            placeholder="Cari pesanan, produksi, kain, pengiriman..."
            className="bg-transparent outline-none flex-1 text-white placeholder-pink-100 text-base"
          />
          <button
            type="button"
            onClick={refreshDataSaatIni}
            disabled={isRefreshingData}
            className="rounded-full px-4 py-2 text-xs font-black text-white shrink-0 disabled:opacity-60 flex items-center gap-1.5"
            style={{ background: "rgba(255,255,255,0.24)", border: "1px solid rgba(255,255,255,0.35)" }}
            title="Refresh data"
          >
            <span>{isRefreshingData ? "..." : "↻"}</span>
            <span>{isRefreshingData ? "Memuat" : "Refresh"}</span>
          </button>
          {search && <button type="button" onClick={() => setSearch("")} className="text-pink-100 font-bold">✕</button>}
        </div>
      </div>

      <div className="grid grid-cols-5 gap-2 p-4">
        {[
          { label: "Pesanan", value: stats.pesanan, color: "#6366f1", icon: "📋" },
          { label: "Belum Produksi", value: stats.belum, color: "#f59e0b", icon: "⏳" },
          { label: "Sedang", value: stats.proses, color: "#a855f7", icon: "🧵" },
          { label: "Selesai", value: stats.selesai, color: "#10b981", icon: "✅" },
          { label: "Perlu Dicek", value: stats.perluDicek, color: stats.perluDicek > 0 ? "#e11d48" : "#94a3b8", icon: "🔎" },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl p-2 text-center bg-white shadow-sm" style={{ border: "1px solid #fce7f3" }}>
            <div className="text-base">{s.icon}</div>
            <div className="text-lg font-bold" style={{ color: s.color }}>{s.value}</div>
            <div className="text-xs" style={{ color: "#94a3b8" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Alert utama dipasang paling atas setelah statistik agar admin langsung melihat data bermasalah. */}
      <div className="px-4 pb-2">
          <div className="rounded-3xl bg-white p-4 space-y-3 shadow-sm" style={{ border: "1px solid #fecaca", background: "linear-gradient(135deg,#fff1f2,#ffffff)" }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-black" style={{ color: "#be123c" }}>🚨 Alert Data Bermasalah</div>
                <div className="text-[11px]" style={{ color: "#64748b" }}>{dashboardInsights.alertCount} temuan perlu dicek</div>
              </div>
              <button onClick={() => setAlertDetailModal(true)} className="rounded-full px-3 py-1 text-[11px] font-bold" style={{ background: "#ffe4e6", color: "#be123c" }}>Cek ›</button>
            </div>
            {dashboardInsights.alerts.length === 0 ? (
              <div className="rounded-2xl p-3 text-xs font-bold" style={{ background: "#f0fdf4", color: "#16a34a" }}>Tidak ada alert data bermasalah.</div>
            ) : (
              <div className="space-y-2">
                {dashboardInsights.alerts.map((alert, idx) => (
                  <button
                    key={`${alert.type}-${idx}`}
                    onClick={() => {
                      setSearch(alert.search || "");
                      if (alert.type === "Setor melebihi diberi") {
                        setBoronganOnlyOverSetor(true);
                        setBoronganOnlyBelumSetor(false);
                      } else {
                        setBoronganOnlyOverSetor(false);
                      }
                      if (alert.tab === "pesanan") setPesananOnlyNeedCheck(true);
                      setTab(alert.tab);
                    }}
                    className="w-full rounded-2xl p-2 text-left"
                    style={{ background: "#fff7f7", border: "1px solid #fecaca" }}
                  >
                    <div className="text-[11px] font-black" style={{ color: "#be123c" }}>{alert.type}</div>
                    <div className="text-[10px]" style={{ color: "#64748b" }}>{alert.text}</div>
                  </button>
                ))}
                {dashboardInsights.alertCount > dashboardInsights.alerts.length && (
                  <div className="text-[10px]" style={{ color: "#94a3b8" }}>+{dashboardInsights.alertCount - dashboardInsights.alerts.length} temuan lain</div>
                )}
              </div>
            )}
          </div>
      </div>

      {stats.belum > 0 && (
        <div className="mx-4 mb-2 rounded-2xl px-4 py-3 flex items-center gap-3"
          style={{ background: "linear-gradient(135deg,#fef3c7,#fde68a)", border: "1.5px solid #fbbf24" }}>
          <span className="text-xl">⚠️</span>
          <div className="flex-1">
            <div className="text-xs font-bold" style={{ color: "#92400e" }}>{stats.belum} pesanan belum masuk produksi</div>
            <div className="text-xs" style={{ color: "#b45309" }}>Tambahkan dari tab Produksi</div>
          </div>
          <button
            onClick={() => { setTab("produksi"); setModal("produksi"); }}
            className="text-xs font-bold px-3 py-1.5 rounded-full text-white"
            style={{ background: "linear-gradient(135deg,#f59e0b,#d97706)" }}
          >
            + Tambah
          </button>
        </div>
      )}

      {stats.perluDicek > 0 && (
        <div className="mx-4 mb-2 rounded-2xl px-4 py-3"
          style={{ background: "linear-gradient(135deg,#fff1f2,#fff7ed)", border: "1.5px solid #fb7185" }}>
          <div className="flex items-start gap-3">
            <span className="text-xl">🔎</span>
            <div className="flex-1">
              <div className="text-xs font-black" style={{ color: "#be123c" }}>{stats.perluDicek} pesanan perlu dicek</div>
              <div className="text-xs mt-1" style={{ color: "#9f1239" }}>Keterangan ini membantu admin baru memahami kenapa pesanan tidak masuk kategori normal.</div>
              <div className="mt-2 space-y-1">
                {ordersPerluDicek.slice(0, 4).map((o) => (
                  <div key={o.id} className="rounded-xl bg-white px-3 py-2 text-[11px]" style={{ border: "1px solid #fecdd3" }}>
                    <div className="font-bold" style={{ color: "#2d1b69" }}>{o.customer} · {o.invoice}</div>
                    <div style={{ color: "#be123c" }}>{o.alasan}</div>
                  </div>
                ))}
                {ordersPerluDicek.length > 4 && (
                  <div className="text-[11px] font-bold" style={{ color: "#be123c" }}>+ {ordersPerluDicek.length - 4} pesanan lain. Klik Buka untuk melihat daftar khusus pesanan perlu dicek.</div>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => { setPesananOnlyNeedCheck(true); setNeedCheckContextId(""); setSearch(""); setTab("pesanan"); }}
              className="text-xs font-bold px-3 py-1.5 rounded-full text-white shrink-0"
              style={{ background: "linear-gradient(135deg,#e11d48,#f97316)" }}
            >
              Buka
            </button>
          </div>
        </div>
      )}

      <div className="sticky top-0 z-40 flex overflow-x-auto bg-white shadow-sm no-scrollbar" style={{ borderBottom: "2px solid #fce7f3" }}>
        {[
          { id: "dashboard", label: "Dashboard", icon: "🏠" },
          { id: "pesanan", label: "Pesanan", icon: "📋", badge: stats.belum },
          { id: "produksi", label: "Produksi", icon: "🧵" },
          { id: "borongan", label: "Borongan", icon: "💪" },
          { id: "kirim", label: "Kirim", icon: "🚚" },
          { id: "rekap", label: "Rekap", icon: "📊" },
          { id: "master", label: "Master", icon: "🗂️" },
        ].map((t) => {
          const isMasterTab = t.id === "master" && (tab === "kain" || tab === "tarif");
          const isActive = tab === t.id || isMasterTab;
          return (
          <button
            key={t.id}
            onClick={() => {
              const nextTab = t.id === "master" ? ((tab === "kain" || tab === "tarif") ? tab : "kain") : t.id;
              if (nextTab === "pesanan") setPesananOnlyNeedCheck(false);
              if (nextTab !== "borongan") setBoronganOnlyBelumSetor(false);
              if (nextTab !== "borongan") setBoronganOnlyOverSetor(false);
              if (nextTab !== "produksi") setProduksiOnlyBelumSelesai(false);
              if (nextTab !== "kirim") setKirimOnlyBelumLengkap(false);
              setTab(nextTab);
            }}
            className="flex-none min-w-[76px] px-2 py-3 text-[11px] font-bold flex flex-col items-center gap-1 relative"
            style={{
              color: isActive ? "#ec4899" : "#64748b",
              borderBottom: isActive ? "3px solid #ec4899" : "3px solid transparent",
              background: isActive ? "#fdf2f8" : "white",
            }}
          >
            <span className="text-base">{t.icon}</span>
            {t.label}
            {t.badge > 0 && (
              <span className="absolute top-1 right-1 w-4 h-4 rounded-full text-white flex items-center justify-center"
                style={{ background: "#ef4444", fontSize: 9, fontWeight: 900 }}>
                {t.badge}
              </span>
            )}
          </button>
          );
        })}
      </div>

      {tab === "dashboard" && (
        <div className="space-y-4 p-4">
          <div className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: "1px solid #fce7f3" }}>
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <div className="text-lg font-black" style={{ color: "#ec4899" }}>📌 Dashboard Produksi</div>
                <div className="text-xs" style={{ color: "#94a3b8" }}>Ringkas, fokus ke pekerjaan yang harus dicek admin.</div>
              </div>
              <button onClick={() => setTugasDetailModal(true)} className="rounded-full px-3 py-1.5 text-xs font-bold" style={{ background: "#fdf2f8", color: "#ec4899" }}>Detail tugas ›</button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => { setBoronganOnlyBelumSetor(true); setBoronganOnlyOverSetor(false); setSearch(""); setTab("borongan"); }}
                className="rounded-3xl bg-orange-50 p-4 text-left active:scale-[0.99] transition-transform"
                style={{ border: "1px solid #fed7aa" }}
              >
                <div className="flex items-center justify-between gap-2"><span className="text-xl">💪</span><span className="text-[10px] font-bold" style={{ color: "#c2410c" }}>Buka borongan ›</span></div>
                <div className="mt-2 text-2xl font-black" style={{ color: dashboardInsights.tugas.boronganBelumSetor > 0 ? "#c2410c" : "#16a34a" }}>{dashboardInsights.tugas.boronganBelumSetor.toLocaleString()}</div>
                <div className="text-xs font-bold" style={{ color: "#2d1b69" }}>Borongan Belum Setor</div>
                <div className="text-[10px]" style={{ color: "#94a3b8" }}>Hanya tampilkan pekerja yang masih punya sisa setor.</div>
              </button>

              <button
                type="button"
                onClick={() => { setProduksiOnlyBelumSelesai(true); setSearch(""); setTab("produksi"); }}
                className="rounded-3xl bg-violet-50 p-4 text-left active:scale-[0.99] transition-transform"
                style={{ border: "1px solid #ddd6fe" }}
              >
                <div className="flex items-center justify-between gap-2"><span className="text-xl">🧵</span><span className="text-[10px] font-bold" style={{ color: "#7c3aed" }}>Buka produksi ›</span></div>
                <div className="mt-2 text-2xl font-black" style={{ color: dashboardInsights.tugas.produksiBelumSelesai > 0 ? "#7c3aed" : "#16a34a" }}>{dashboardInsights.tugas.produksiBelumSelesai.toLocaleString()}</div>
                <div className="text-xs font-bold" style={{ color: "#2d1b69" }}>Produksi Belum Selesai</div>
                <div className="text-[10px]" style={{ color: "#94a3b8" }}>Masuk ke daftar produksi yang masih berjalan.</div>
              </button>

              <button
                type="button"
                onClick={() => { setKirimOnlyBelumLengkap(true); setSearch(""); setTab("kirim"); }}
                className="rounded-3xl bg-sky-50 p-4 text-left active:scale-[0.99] transition-transform"
                style={{ border: "1px solid #bae6fd" }}
              >
                <div className="flex items-center justify-between gap-2"><span className="text-xl">🚚</span><span className="text-[10px] font-bold" style={{ color: "#0284c7" }}>Buka kirim ›</span></div>
                <div className="mt-2 text-2xl font-black" style={{ color: dashboardInsights.tugas.kirimanBelumLengkap > 0 ? "#0284c7" : "#16a34a" }}>{dashboardInsights.tugas.kirimanBelumLengkap.toLocaleString()}</div>
                <div className="text-xs font-bold" style={{ color: "#2d1b69" }}>Kirim Belum Lengkap</div>
                <div className="text-[10px]" style={{ color: "#94a3b8" }}>Order yang masih punya sisa kirim.</div>
              </button>

              <button
                type="button"
                onClick={() => { setPesananOnlyNeedCheck(true); setNeedCheckContextId(""); setSearch(""); setTab("pesanan"); }}
                className="rounded-3xl bg-rose-50 p-4 text-left active:scale-[0.99] transition-transform"
                style={{ border: "1px solid #fecdd3" }}
              >
                <div className="flex items-center justify-between gap-2"><span className="text-xl">🔎</span><span className="text-[10px] font-bold" style={{ color: "#be123c" }}>Buka pesanan ›</span></div>
                <div className="mt-2 text-2xl font-black" style={{ color: ordersPerluDicekIds.size > 0 ? "#be123c" : "#16a34a" }}>{ordersPerluDicekIds.size.toLocaleString()}</div>
                <div className="text-xs font-bold" style={{ color: "#2d1b69" }}>Pesanan Perlu Dicek</div>
                <div className="text-[10px]" style={{ color: "#94a3b8" }}>Filter khusus, bukan membuka semua pesanan.</div>
              </button>
            </div>
          </div>

          <div className="rounded-3xl bg-white p-4 space-y-3 shadow-sm" style={{ border: "1px solid #fed7aa", background: "linear-gradient(135deg,#fff7ed,#ffffff)" }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-black" style={{ color: "#c2410c" }}>✅ Prioritas Kerja Hari Ini</div>
                <div className="text-[11px]" style={{ color: "#9a3412" }}>Maksimal beberapa item penting. Ketuk untuk langsung membuka data terkait.</div>
              </div>
              <button onClick={() => setTugasDetailModal(true)} className="rounded-full px-3 py-1 text-[11px] font-bold" style={{ background: "#ffedd5", color: "#c2410c" }}>Lihat semua ›</button>
            </div>

            {(dashboardInsights.tugas.activeBorongan.length === 0 && dashboardInsights.tugas.activeProduksi.length === 0 && dashboardInsights.tugas.kirimBelumLengkap.length === 0) ? (
              <div className="rounded-2xl p-3 text-xs" style={{ background: "#f0fdf4", color: "#15803d", border: "1px solid #bbf7d0" }}>✅ Tidak ada pekerjaan mendesak dari dashboard.</div>
            ) : (
              <div className="space-y-2 text-[12px]" style={{ color: "#7c2d12" }}>
                {dashboardInsights.tugas.activeBorongan.slice(0, 3).map(({ entry, totals }) => (
                  <button
                    key={`bor-${entry.id}`}
                    onClick={() => { setBoronganOnlyBelumSetor(true); setBoronganOnlyOverSetor(false); setSearch(displayWorkerName(entry.employeeName)); setTab("borongan"); }}
                    className="w-full text-left rounded-2xl bg-white p-3 active:bg-orange-100 transition-colors"
                    style={{ border: "1px solid #fed7aa" }}
                  >
                    <div className="font-black">{displayWorkerName(entry.employeeName)} belum setor {fmtQty(totals.sisaSetor)} pcs</div>
                    <div className="text-[10px] opacity-80">{entry.process || "-"} {displayModelName(entry.model || "-")}</div>
                  </button>
                ))}
                {dashboardInsights.tugas.activeProduksi.slice(0, 2).map((item) => (
                  <button
                    key={`prod-${item.id}`}
                    onClick={() => { setProduksiOnlyBelumSelesai(true); setSearch(item.customer || item.orderCustomer || ""); setTab("produksi"); }}
                    className="w-full text-left rounded-2xl bg-white p-3 active:bg-orange-100 transition-colors"
                    style={{ border: "1px solid #fed7aa" }}
                  >
                    <div className="font-black">Produksi {item.customer || item.orderCustomer || item.orderId || "pesanan"}</div>
                    <div className="text-[10px] opacity-80">Status: {item.status || "proses"}</div>
                  </button>
                ))}
                {dashboardInsights.tugas.kirimBelumLengkap.slice(0, 2).map(({ order, sisa }) => (
                  <button
                    key={`ship-${order.id}`}
                    onClick={() => { setKirimOnlyBelumLengkap(true); setSearch(order.customer || order.invoice || ""); setTab("kirim"); }}
                    className="w-full text-left rounded-2xl bg-white p-3 active:bg-orange-100 transition-colors"
                    style={{ border: "1px solid #fed7aa" }}
                  >
                    <div className="font-black">{order.customer || "Customer"} sisa kirim {fmtQty(sisa)} pcs</div>
                    <div className="text-[10px] opacity-80">Ketuk untuk membuka data kirim yang relevan.</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button type="button" onClick={() => setRekapDetailModal("belumSetor")} className="rounded-3xl bg-white p-4 text-left shadow-sm active:scale-[0.99]" style={{ border: "1px solid #fce7f3" }}>
              <div className="text-[10px] font-bold" style={{ color: "#94a3b8" }}>Rincian belum setor ›</div>
              <div className="mt-1 text-xl font-black" style={{ color: dashboardSummary.totalSisaSetor > 0 ? "#b45309" : "#16a34a" }}>{dashboardSummary.totalSisaSetor.toLocaleString()}</div>
              <div className="text-xs font-bold" style={{ color: "#64748b" }}>Sisa Setor Pcs</div>
            </button>
            <button type="button" onClick={() => setRekapDetailModal("allTime")} className="rounded-3xl bg-white p-4 text-left shadow-sm active:scale-[0.99]" style={{ border: "1px solid #ddd6fe" }}>
              <div className="text-[10px] font-bold" style={{ color: "#94a3b8" }}>Rincian gaji ›</div>
              <div className="mt-1 text-lg font-black" style={{ color: "#7c3aed" }}>{money(dashboardSummary.gajiKeseluruhan)}</div>
              <div className="text-xs font-bold" style={{ color: "#64748b" }}>Total Gaji Tercatat</div>
            </button>
          </div>
        </div>
      )}

      {tab === "pesanan" && (
        <div className="space-y-3 p-4">
          <InfoBox title="Sumber: Gallery Kerudung" subtitle="Data realtime dari collection orders" icon="🏪" />
          {pesananOnlyNeedCheck && (
            <div className="rounded-2xl px-4 py-3 flex items-start gap-3" style={{ background: "#fff1f2", border: "1.5px solid #fb7185" }}>
              <span className="text-xl">🔎</span>
              <div className="flex-1">
                <div className="text-sm font-black" style={{ color: "#be123c" }}>Hanya menampilkan pesanan yang perlu dicek</div>
                <div className="text-xs mt-1" style={{ color: "#9f1239" }}>Admin bisa langsung membuka pengiriman dari kartu ini. Pesanan lain disembunyikan sementara agar tidak membingungkan.</div>
              </div>
              <button
                type="button"
                onClick={() => setPesananOnlyNeedCheck(false)}
                className="text-xs font-bold px-3 py-2 rounded-full text-white shrink-0"
                style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}
              >
                Tampilkan Semua
              </button>
            </div>
          )}
          {visiblePesananOrders.length === 0 && <Empty text={pesananOnlyNeedCheck ? "Tidak ada pesanan yang perlu dicek" : "Tidak ada data pesanan"} />}
          {visiblePesananOrders.map((o) => {
            const prod = produksiByOrderId.get(o.id);
            const small = orderSmallStatus(o);
            const canStart = ordersBelumProduksi.some((x) => x.id === o.id);
            const needCheckInfo = ordersPerluDicek.find((x) => x.id === o.id);
            return (
              <div key={o.id} className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: canStart ? "2px solid #fbbf24" : "1px solid #fce7f3" }}>
                <div className="flex justify-between items-start">
                  <div className="flex-1 mr-2">
                    <div className="font-bold text-base" style={{ color: "#2d1b69" }}>👤 {o.customer}</div>
                    <div className="text-xs mt-1" style={{ color: "#a855f7" }}>👗 <b>{o.item}</b></div>
                    {o.invoice && <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>🧾 {o.invoice}</div>}
                    {o.createdAt && <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>📅 {o.createdAt}</div>}
                    {o.warna && <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>🎨 {o.warna}</div>}
                    <div className="mt-2 text-xs font-bold" style={{ color: small.color }}>{small.label}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold" style={{ color: "#ec4899" }}>{o.qty}</div>
                    <div className="text-xs" style={{ color: "#94a3b8" }}>total pcs</div>
                  </div>
                </div>

                {/* Breakdown per model - selalu tampil jika ada items */}
                {(() => {
                  const its = (o.items || []).filter(it => it.name && it.name !== "-" && Number(it.qty) > 0);
                  if (its.length === 0) return null;
                  const isMulti = its.length > 1;
                  return (
                    <div className="mt-2">
                      {isMulti && (
                        <div className="text-xs font-bold mb-1" style={{ color: "#7c3aed" }}>
                          📦 {its.length} model
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1">
                        {its.map((it, i) => (
                          <span key={i} className="rounded-xl px-3 py-1 text-xs font-semibold"
                            style={{ background: "#ede9fe", color: "#5b21b6", border: "1px solid #c4b5fd" }}>
                            {it.name}: <strong>{it.qty} pcs</strong>
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {prod && (
                  <div className="mt-3 rounded-2xl px-3 py-2" style={{ background: "#ede9fe" }}>
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-bold" style={{ color: "#5b21b6" }}>🧵 Status produksi</span>
                      <StatusBadge status={prod.status} />
                    </div>
                    {(prod.workers || []).length > 0 && (
                      <div className="mt-2 space-y-1">
                        {(prod.workers || []).slice(-3).map((w, idx) => (
                          <div key={idx} className="text-xs" style={{ color: "#7c3aed" }}>
                            👤 {displayWorkerName(w.employeeName)} · {w.process} · {w.qty} pcs
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {needCheckInfo && (
                  <div className="mt-3 rounded-2xl px-3 py-2" style={{ background: "#fff1f2", border: "1px solid #fecdd3" }}>
                    <div className="text-xs font-black" style={{ color: "#be123c" }}>🔎 Perlu Dicek</div>
                    <div className="text-xs mt-1" style={{ color: "#9f1239" }}>{needCheckInfo.alasan}</div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      {(() => {
                        const ordered = dashboardTotalOrderedQty(o);
                        let shipped = dashboardTotalShippedQty(o);
                        if (!hasDeliveryDetail(o) && isLegacyDoneOrSentOrder(o) && ordered > 0 && shipped <= 0) shipped = ordered;
                        const sisa = Math.max(0, ordered - shipped);
                        const lebih = Math.max(0, shipped - ordered);
                        if (sisa > 0) {
                          return (
                            <Button
                              type="button"
                              onClick={() => openKirimSisaForOrder(o)}
                              className="text-xs"
                              style={{ background: "linear-gradient(135deg,#0ea5e9,#2563eb)" }}
                            >
                              🚚 Kirim Sisa
                            </Button>
                          );
                        }
                        if (lebih > 0) {
                          return (
                            <Button
                              type="button"
                              onClick={() => closeOverDeliveryOrder(o)}
                              className="text-xs"
                              style={{ background: "linear-gradient(135deg,#f97316,#ec4899)" }}
                            >
                              ✅ Tandai Dicek
                            </Button>
                          );
                        }
                        return (
                          <Button
                            type="button"
                            onClick={() => openPengirimanForOrder(o)}
                            className="text-xs"
                            style={{ background: "linear-gradient(135deg,#0ea5e9,#2563eb)" }}
                          >
                            🚚 Update Kiriman
                          </Button>
                        );
                      })()}
                      <Button
                        type="button"
                        onClick={() => setNeedCheckContextId((id) => (id === o.id ? "" : o.id))}
                        className="text-xs"
                        style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}
                      >
                        {needCheckContextId === o.id ? "Tutup Detail" : "Detail Masalah"}
                      </Button>
                    </div>
                    {needCheckContextId === o.id && (() => {
                      const ordered = dashboardTotalOrderedQty(o);
                      let shipped = dashboardTotalShippedQty(o);
                      if (!hasDeliveryDetail(o) && isLegacyDoneOrSentOrder(o) && ordered > 0 && shipped <= 0) shipped = ordered;
                      const sisa = Math.max(0, ordered - shipped);
                      const lebih = Math.max(0, shipped - ordered);
                      const rawStatus = o.status || o.deliveryStatus || o.shippingStatus || "-";
                      return (
                        <div className="mt-2 rounded-2xl bg-white px-3 py-3 text-[11px] space-y-2" style={{ border: "1px solid #fecdd3" }}>
                          <div
                            className="font-black"
                            style={{ color: "#be123c" }}
                          >
                            Detail masalah pengiriman
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="rounded-xl px-2 py-2" style={{ background: "#f8fafc" }}>
                              <div style={{ color: "#64748b" }}>Pesanan</div>
                              <div className="font-black" style={{ color: "#1e1b4b" }}>{fmtQty(ordered)} pcs</div>
                            </div>
                            <div className="rounded-xl px-2 py-2" style={{ background: "#ecfdf5" }}>
                              <div style={{ color: "#64748b" }}>Terkirim</div>
                              <div className="font-black" style={{ color: "#16a34a" }}>{fmtQty(shipped)} pcs</div>
                            </div>
                            <div className="rounded-xl px-2 py-2" style={{ background: "#fff7ed" }}>
                              <div style={{ color: "#64748b" }}>Sisa aktif</div>
                              <div className="font-black" style={{ color: "#ea580c" }}>{fmtQty(sisa)} pcs</div>
                            </div>
                            <div className="rounded-xl px-2 py-2" style={{ background: "#fff1f2" }}>
                              <div style={{ color: "#64748b" }}>Lebih kirim</div>
                              <div className="font-black" style={{ color: "#e11d48" }}>{fmtQty(lebih)} pcs</div>
                            </div>
                          </div>
                          <div><b>Invoice:</b> {o.invoice || "-"}</div>
                          <div><b>Status:</b> {rawStatus}</div>
                          <div><b>Alasan dicek:</b> {needCheckInfo.alasan}</div>
                          {isShortShipmentClosed(o) && (
                            <div><b>Alasan kurang kirim final:</b> {o.shortShipmentReason || "-"}</div>
                          )}
                          <div className="rounded-xl px-3 py-2" style={{ background: "#fef2f2", color: "#9f1239" }}>
                            Gunakan <b>Edit Pengiriman</b> jika qty/status belum benar. Jika sisa tidak akan dikirim lagi, pilih <b>Kurang kirim final</b> dan isi alasannya.
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {canStart && (
                  <Button
                    onClick={() => {
                      setProdForm({ orderId: o.id, tanggalMulai: todayStr(), catatan: "" });
                      setModal("produksi");
                    }}
                    className="mt-3 w-full"
                    style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}
                  >
                    🧵 Mulai Produksi
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === "produksi" && (
        <div className="space-y-3 p-4">
          <Button onClick={() => setModal("produksi")} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
            🧵 + Tambah ke Produksi
          </Button>

          {/* Banner filter belum selesai */}
          {produksiOnlyBelumSelesai && (
            <div className="rounded-2xl px-4 py-3 flex items-start gap-3" style={{ background: "#ede9fe", border: "1.5px solid #c4b5fd" }}>
              <span className="text-xl">🧵</span>
              <div className="flex-1">
                <div className="text-sm font-black" style={{ color: "#5b21b6" }}>Hanya menampilkan produksi belum selesai</div>
                <div className="text-xs mt-1" style={{ color: "#7c3aed" }}>Kalau produksi sebenarnya sudah selesai, kemungkinan hasil borongan belum dikaitkan ke pesanan.</div>
              </div>
              <button
                type="button"
                onClick={() => setProduksiOnlyBelumSelesai(false)}
                className="text-xs font-bold px-3 py-2 rounded-full text-white shrink-0"
                style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}
              >
                Tampilkan Semua
              </button>
            </div>
          )}

          {boronganTanpaPesanan.length > 0 && (
            <div className="rounded-2xl px-4 py-3 flex items-start gap-3" style={{ background: "#fffbeb", border: "1.5px solid #f59e0b" }}>
              <span className="text-xl">🔗</span>
              <div className="flex-1">
                <div className="text-sm font-black" style={{ color: "#92400e" }}>{boronganTanpaPesanan.length} hasil borongan belum dikaitkan</div>
                <div className="text-xs mt-1" style={{ color: "#b45309" }}>Buka daftar ini kalau progress produksi terlihat kurang, padahal kerjaan sudah selesai.</div>
              </div>
              <button
                type="button"
                onClick={() => { setBoronganOnlyBelumSetor(false); setBoronganOnlyOverSetor(false); setBoronganOnlyTanpaPesanan(true); setQ(""); setTab("borongan"); }}
                className="text-xs font-bold px-3 py-2 rounded-full text-white shrink-0"
                style={{ background: "linear-gradient(135deg,#f59e0b,#d97706)" }}
              >
                Kaitkan Hasil
              </button>
            </div>
          )}

          {(() => {
            const displayedProduksi = produksiOnlyBelumSelesai
              ? filteredProduksi.filter((p) => p.status !== "Selesai")
              : filteredProduksi;
            return (
              <>
                {displayedProduksi.length === 0 && <Empty text={produksiOnlyBelumSelesai ? "Semua produksi sudah selesai" : "Tidak ada data produksi"} />}
                {displayedProduksi.map((p) => {
            const qtyPesanan = Number(p.qty || 0);
            const rekapProses = [
              { label: "✂️ Potong", qty: processQtyForOrder(p.orderId, "Potong") },
              { label: "🧵 Jahit", qty: processQtyForOrder(p.orderId, "Jahit") },
              { label: "📦 Pengemasan QC", qty: processQtyForOrder(p.orderId, "Pengemasan QC") },
            ].filter((r) => r.qty > 0);
            return (
            <div key={p.id} className="rounded-2xl bg-white shadow-sm overflow-hidden" style={{ border: "1px solid #fce7f3" }}>
              {/* Header compact */}
              <div className="flex items-center justify-between px-4 pt-3 pb-2">
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm truncate" style={{ color: "#2d1b69" }}>{p.customer}</div>
                  <div className="text-xs truncate" style={{ color: "#94a3b8" }}>{p.invoice}</div>
                </div>
                <div className="flex items-center gap-2 ml-2">
                  <div className="text-right">
                    <div className="text-lg font-bold" style={{ color: "#ec4899" }}>{p.qty}</div>
                    <div className="text-xs" style={{ color: "#94a3b8" }}>pcs</div>
                  </div>
                  <StatusBadge status={p.status} />
                </div>
              </div>

              {/* Per model — breakdown jelas dengan progress per proses */}
              {(() => {
                const order = orderLookupForCards.byId.get(String(p.orderId || "").trim());
                const orderItems = (order?.items || []).filter(it => it.name && it.name !== "-" && Number(it.qty) > 0);
                const prodItems = (p.items || []).filter(it => it.name && it.name !== "-" && Number(it.qty) > 0);

                // Deteksi data lama: p.items hanya 1 item dengan qty = total order
                // atau p.items berbeda jumlah model dengan order.items → pakai order.items
                const isStaleData = prodItems.length === 1 && orderItems.length > 1 &&
                  Number(prodItems[0]?.qty) === Number(p.qty);
                const displayItems = (isStaleData || prodItems.length === 0) ? orderItems : prodItems;
                if (displayItems.length === 0) return null;
                return (
                  <div className="px-4 pb-2">
                    <div className="text-xs font-bold mb-1.5" style={{ color: "#7c3aed" }}>
                      📋 Rincian Model ({displayItems.length} model · {p.qty} pcs total):
                    </div>
                    <div className="space-y-1.5">
                      {displayItems.map((it, i) => {
                        const modelName = it.name || it.item || "-";
                        const modelQty = Number(it.qty || 0);
                        const potongQty = processQtyForOrderModel(p.orderId, "Potong", modelName);
                        const jahitQty = processQtyForOrderModel(p.orderId, "Jahit", modelName);
                        const qcQty = processQtyForOrder(p.orderId, "Pengemasan QC");
                        const jahitDone = jahitQty >= modelQty;
                        return (
                          <div key={i} className="rounded-xl p-2.5" style={{ background: jahitDone ? "#dcfce7" : "#ede9fe", border: `1px solid ${jahitDone ? "#bbf7d0" : "#c4b5fd"}` }}>
                            <div className="flex justify-between items-center mb-1">
                              <div className="font-bold text-xs" style={{ color: jahitDone ? "#16a34a" : "#5b21b6" }}>
                                {modelName} {jahitDone ? "✅" : ""}
                              </div>
                              <div className="text-xs font-bold" style={{ color: "#2d1b69" }}>{modelQty} pcs</div>
                            </div>
                            <div className="flex gap-2 text-xs">
                              {potongQty > 0 && (
                                <span className="rounded-full px-2 py-0.5" style={{ background: "#dbeafe", color: "#1e40af" }}>
                                  ✂️ {potongQty}/{modelQty}
                                </span>
                              )}
                              <span className="rounded-full px-2 py-0.5" style={{ background: jahitDone ? "#bbf7d0" : "#fce7f3", color: jahitDone ? "#16a34a" : "#be185d" }}>
                                🧵 {jahitQty}/{modelQty}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              <ProgressBar status={p.status} />

              {/* Rekap proses — compact grid */}
              {rekapProses.length > 0 && (
                <div className="px-4 py-2 grid grid-cols-3 gap-1">
                  {rekapProses.map((r) => {
                    const sesuai = r.qty >= qtyPesanan;
                    return (
                      <div key={r.label} className="rounded-xl p-2 text-center" style={{ background: sesuai ? "#dcfce7" : "#fef3c7" }}>
                        <div className="text-xs font-bold" style={{ color: sesuai ? "#16a34a" : "#b45309" }}>{r.qty}</div>
                        <div className="text-xs" style={{ color: "#94a3b8" }}>{r.label}</div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Ubah status — compact pills */}
              <div className="px-4 pb-3">
                {p.status !== "Selesai" && boronganTanpaPesanan.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setBoronganOnlyBelumSetor(false);
                      setBoronganOnlyOverSetor(false);
                      setBoronganOnlyTanpaPesanan(true);
                      setQ(p.customer || p.item || "");
                      setTab("borongan");
                    }}
                    className="mb-2 w-full rounded-full px-3 py-2 text-xs font-black text-white"
                    style={{ background: "linear-gradient(135deg,#f59e0b,#d97706)" }}
                  >
                    🔗 Cari/Kaitkan Hasil Borongan
                  </button>
                )}
                <div className="flex gap-1 flex-wrap">
                  {PROD_STATUS.map((s) => (
                    <button key={s} onClick={() => updateProduksiStatus(p.id, s)}
                      className="rounded-full px-2 py-1 text-xs font-semibold"
                      style={{
                        background: p.status === s ? "linear-gradient(135deg,#ec4899,#a855f7)" : "#fdf2f8",
                        color: p.status === s ? "white" : "#a855f7",
                        border: "1px solid #f9a8d4",
                      }}>
                      {PROD_COLORS[s]?.icon} {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            );
          })}
              </>
            );
          })()}
        </div>
      )}

      {tab === "borongan" && (
        <div className="space-y-3 p-4">
          <Button onClick={() => setModal("borongan")} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
            💪 + Input Hasil Borongan
          </Button>

          {/* Banner filter belum setor */}
          {boronganOnlyBelumSetor && (
            <div className="rounded-2xl px-4 py-3 flex items-start gap-3" style={{ background: "#fefce8", border: "1.5px solid #fbbf24" }}>
              <span className="text-xl">🟡</span>
              <div className="flex-1">
                <div className="text-sm font-black" style={{ color: "#92400e" }}>Hanya menampilkan yang belum setor</div>
                <div className="text-xs mt-1" style={{ color: "#b45309" }}>Setor hasil kerjaan di bawah ini agar masuk rekap gaji.</div>
              </div>
              <button
                type="button"
                onClick={() => setBoronganOnlyBelumSetor(false)}
                className="text-xs font-bold px-3 py-2 rounded-full text-white shrink-0"
                style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}
              >
                Tampilkan Semua
              </button>
            </div>
          )}

          {boronganOnlyOverSetor && (
            <div className="rounded-2xl px-4 py-3 flex items-start gap-3" style={{ background: "#fff1f2", border: "1.5px solid #fecaca" }}>
              <span className="text-xl">🚨</span>
              <div className="flex-1">
                <div className="text-sm font-black" style={{ color: "#be123c" }}>Hanya menampilkan yang setor melebihi diberi</div>
                <div className="text-xs mt-1" style={{ color: "#9f1239" }}>Data ini perlu dicek — total setor + reject melebihi qty yang diberikan.</div>
              </div>
              <button
                type="button"
                onClick={() => setBoronganOnlyOverSetor(false)}
                className="text-xs font-bold px-3 py-2 rounded-full text-white shrink-0"
                style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}
              >
                Tampilkan Semua
              </button>
            </div>
          )}

          {boronganOnlyTanpaPesanan && (
            <div className="rounded-2xl px-4 py-3 flex items-start gap-3" style={{ background: "#fffbeb", border: "1.5px solid #f59e0b" }}>
              <span className="text-xl">⚠️</span>
              <div className="flex-1">
                <div className="text-sm font-black" style={{ color: "#92400e" }}>Hanya menampilkan borongan minggu ini belum dikaitkan</div>
                <div className="text-xs mt-1" style={{ color: "#b45309" }}>Semua produksi dibuat sesuai pesanan, jadi entry periode berjalan perlu dikaitkan agar masuk progress produksi sebelum kirim.</div>
              </div>
              <button
                type="button"
                onClick={() => setBoronganOnlyTanpaPesanan(false)}
                className="text-xs font-bold px-3 py-2 rounded-full text-white shrink-0"
                style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}
              >
                Tampilkan Semua
              </button>
            </div>
          )}

          <div className="rounded-2xl bg-white p-4" style={{ border: "1px solid #fce7f3" }}>
            <div className="text-xs font-bold" style={{ color: "#a855f7" }}>Total hasil borongan</div>
            <div className="text-2xl font-bold" style={{ color: "#ec4899" }}>{stats.boronganPcs} pcs</div>
            <div className="text-xs" style={{ color: "#94a3b8" }}>Upah tersimpan untuk pengeluaran Gallery Kerudung</div>
          </div>


          {(boronganOnlyTanpaPesanan
            ? filteredEntries.filter((e) => boronganTanpaPesananIds.has(e.id))
            : boronganOnlyBelumSetor
              ? filteredEntries.filter((e) => setorTotals(e).statusSetor !== "sudah_setor")
              : boronganOnlyOverSetor
                ? filteredEntries.filter((e) => {
                    const totals = setorTotals(e);
                    return (Number(totals.qtySetor || 0) + Number(totals.qtyReject || 0)) > Number(e.qty || 0);
                  })
                : filteredEntries
          ).map((e) => {
            const totals = setorTotals(e);
            const sudahSetor = totals.statusSetor === "sudah_setor";
            const setorSebagian = totals.statusSetor === "setor_sebagian";
            const qtyReject = Number(totals.qtyReject || 0);
            const qtySetor = Number(totals.qtySetor || 0);
            const selisih = Number(totals.sisaSetor || 0);
            const statusSetorPanel = (sudahSetor || setorSebagian) ? (
              <div className="mt-3 rounded-2xl p-3 space-y-2" style={{ background: sudahSetor ? "#f0fdf4" : "#fff7ed", border: `1px solid ${sudahSetor ? "#bbf7d0" : "#fed7aa"}` }}>
                <div className="text-xs font-bold" style={{ color: sudahSetor ? "#16a34a" : "#b45309" }}>
                  {sudahSetor ? "✅ Sudah Setor" : "🟠 Setor Sebagian"} — terakhir {totals.tanggalSetor || "-"}
                </div>
                <div className="flex flex-wrap gap-3 text-sm">
                  <span>✔️ Setor: <strong>{qtySetor} pcs</strong></span>
                  {qtyReject > 0 && <span>❌ Reject: <strong style={{ color: "#ef4444" }}>{qtyReject} pcs</strong></span>}
                  {selisih > 0 && <span>⚠️ Sisa: <strong style={{ color: "#f59e0b" }}>{selisih} pcs</strong></span>}
                </div>
                {totals.totalWageSetor > 0 && (
                  <div className="text-sm font-bold" style={{ color: "#a855f7" }}>💰 Total gaji setor: {money(totals.totalWageSetor)}</div>
                )}
                {totals.history.length > 0 && (
                  <div className="space-y-1">
                    {totals.history.slice(-3).map((h, idx) => (
                      <div key={h.id || idx} className="rounded-xl px-3 py-2 text-xs" style={{ background: "rgba(255,255,255,.75)", color: "#64748b", border: "1px solid #f3e8ff" }}>
                        📅 {h.tanggalSetor} · Setor {Number(h.qtySetor || 0)} pcs{Number(h.qtyReject || 0) > 0 ? ` · Reject ${Number(h.qtyReject || 0)} pcs` : ""} · {money(h.totalWageSetor || 0)}
                      </div>
                    ))}
                  </div>
                )}
                {selisih > 0 && (
                  <button
                    onClick={() => { setSetorModal(e); setSetorForm({ qtySetor: String(selisih), qtyReject: "", tanggalSetor: todayStr(), catatan: "" }); }}
                    className="mt-1 rounded-xl px-3 py-1.5 text-xs font-bold text-white"
                    style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}
                  >
                    Setor Lanjutan
                  </button>
                )}
              </div>
            ) : (
              <div className="mt-3 flex items-center justify-between rounded-2xl px-3 py-2" style={{ background: "#fefce8", border: "1px solid #fde68a" }}>
                <span className="text-xs font-bold" style={{ color: "#b45309" }}>🟡 Belum Setor</span>
                <button
                  onClick={() => { const t = setorTotals(e); setSetorModal(e); setSetorForm({ qtySetor: String(t.sisaSetor || e.qty || ""), qtyReject: "", tanggalSetor: todayStr(), catatan: "" }); }}
                  className="rounded-xl px-3 py-1 text-xs font-bold text-white"
                  style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}
                >
                  Setor Hasil
                </button>
              </div>
            );
            return (
              <div key={e.id} className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: `1.5px solid ${sudahSetor ? "#bbf7d0" : setorSebagian ? "#fed7aa" : "#fde68a"}` }}>
                <div className="flex justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold" style={{ color: "#2d1b69" }}>👤 {displayWorkerName(e.employeeName)}</div>
                    <div className="text-xs mt-1" style={{ color: "#a855f7" }}>{e.productType} · {e.process}{e.model ? ` · ${e.model}` : ""}</div>
                    {e.invoice && <div className="text-xs" style={{ color: "#94a3b8" }}>🧾 {e.invoice}</div>}
                    <div className="text-xs" style={{ color: "#94a3b8" }}>📅 {e.tanggal}</div>
                    {!e.orderId && !e.pesananId && (
                      <div className="mt-1.5 inline-flex items-center gap-1 rounded-full px-2.5 py-1" style={{ background: "#fefce8", border: "1px solid #fbbf24" }}>
                        <span className="text-xs">⚠️</span>
                        <span className="text-xs font-bold" style={{ color: "#92400e" }}>Tanpa Pesanan</span>
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-2xl font-bold" style={{ color: "#10b981" }}>{e.qty}</div>
                    <div className="text-xs" style={{ color: "#94a3b8" }}>pcs diberikan</div>
                  </div>
                </div>

                {statusSetorPanel}

                {!e.orderId && !e.pesananId && (
                  <div className="mt-2 rounded-2xl px-3 py-2.5 flex items-center justify-between gap-2" style={{ background: "#fffbeb", border: "1.5px dashed #f59e0b" }}>
                    <div className="text-xs" style={{ color: "#92400e" }}>
                      Entry ini belum terkait pesanan. Setor/gaji tetap bisa untuk data lama, tapi progress produksi baru terhitung setelah dikaitkan.
                    </div>
                    <button
                      type="button"
                      onClick={() => { setKaitkanModal(e); setKaitkanOrderId(""); }}
                      className="shrink-0 rounded-xl px-3 py-1.5 text-xs font-bold text-white"
                      style={{ background: "linear-gradient(135deg,#f59e0b,#d97706)" }}
                    >
                      🔗 Kaitkan
                    </button>
                  </div>
                )}

                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => openEditEntry(e)}
                    className="flex-1 rounded-2xl py-2 text-xs font-bold"
                    style={{ background: "#eff6ff", color: "#2563eb", border: "1px solid #bfdbfe" }}
                  >
                    ✏️ Edit
                  </button>
                  {!e.orderId && !e.pesananId && (
                    <button
                      type="button"
                      onClick={() => { setKaitkanModal(e); setKaitkanOrderId(""); }}
                      className="flex-1 rounded-2xl py-2 text-xs font-bold"
                      style={{ background: "#fffbeb", color: "#b45309", border: "1px solid #fbbf24" }}
                    >
                      🔗 Kaitkan
                    </button>
                  )}
                  <button
                    onClick={() => requestDeleteEntry(e)}
                    className="flex-1 rounded-2xl py-2 text-xs font-bold"
                    style={{ background: "#fff1f2", color: "#e11d48", border: "1px solid #fecaca" }}
                  >
                    🗑️ Hapus
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "rekap" && (() => {
        const {
          rekapPeriodReady,
          inRange,
          filtered,
          byProses,
          totalQty,
          totalSetor,
          totalReject,
          totalGaji,
          prosesOrder,
          prosesKeys,
          rekapMap,
          rekapPerkerja,
          rekapGajianKeseluruhan,
          allTimePayrollRows,
          allTimePayrollMap,
          rekapGajiAllTimeRows,
          rekapGajiAllTimeSummary,
          boronganBelumMasukRekap,
          totalBoronganBelumMasukPcs,
          totalBoronganBelumMasukGajiPotensi,
        } = rekapData;
        return (
          <div className="space-y-3 p-4">
            {/* Filter Tanggal Manual */}
            <div className="rounded-2xl bg-white p-4" style={{ border: "1px solid #e9d5ff" }}>
              <div className="text-xs font-bold mb-3" style={{ color: "#7c3aed" }}>📅 Filter Periode</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs mb-1" style={{ color: "#94a3b8" }}>Dari</div>
                  <input type="date" value={rekapDari} onChange={(v) => handleRekapDariChange(inputValue(v))}
                    className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#e9d5ff" }} />
                </div>
                <div>
                  <div className="text-xs mb-1" style={{ color: "#94a3b8" }}>Sampai</div>
                  <input type="date" value={rekapSampai} onChange={(v) => handleRekapSampaiChange(inputValue(v))}
                    className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#e9d5ff" }} />
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 text-xs" style={{ color: "#94a3b8" }}>
                <span>Periode otomatis: Minggu s/d Sabtu</span>
                <button
                  type="button"
                  onClick={resetRekapToCurrentWeek}
                  className="rounded-full px-3 py-1 font-bold"
                  style={{ background: "#f5f3ff", color: "#7c3aed" }}
                >
                  Minggu ini
                </button>
              </div>
            </div>

            {!rekapPeriodReady && (
              <div className="rounded-2xl bg-yellow-50 p-4 text-sm font-semibold" style={{ border: "1px solid #fde68a", color: "#92400e" }}>
                📌 Pilih tanggal <strong>Dari</strong> dan <strong>Sampai</strong> dulu untuk menampilkan rekap gaji.
              </div>
            )}

            {/* Form Input Riwayat Gajian Lama */}
            <div className="rounded-2xl bg-white p-4 space-y-3" style={{ border: "1px solid #a7f3d0" }}>
              <button
                type="button"
                onClick={() => setShowFormGajianLama((v) => !v)}
                className="w-full flex items-center justify-between"
              >
                <div className="text-xs font-bold" style={{ color: "#065f46" }}>📝 Input Riwayat Gajian Lama</div>
                <span className="text-xs" style={{ color: "#94a3b8" }}>{showFormGajianLama ? "▲ Tutup" : "▼ Buka"}</span>
              </button>
              {showFormGajianLama && (
                <div className="space-y-2 pt-1">
                  <div>
                    <div className="text-[11px] mb-1" style={{ color: "#64748b" }}>Nama Pekerja</div>
                    <select
                      value={formGajianLama.employeeName}
                      onChange={(e) => setFormGajianLama((f) => ({ ...f, employeeName: e.target.value }))}
                      className="w-full rounded-xl border px-3 py-2 text-sm"
                      style={{ borderColor: "#a7f3d0" }}
                    >
                      <option value="">-- Pilih Pekerja --</option>
                      {workerNameOptions.map((w) => (
                        <option key={w} value={w}>{displayWorkerName(w)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: "#64748b" }}>Tanggal Digaji</div>
                      <input type="date" value={formGajianLama.tanggalGaji}
                        onChange={(v) => setFormGajianLama((f) => ({ ...f, tanggalGaji: inputValue(v) }))}
                        className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#a7f3d0" }} />
                    </div>
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: "#64748b" }}>Jumlah Dibayar</div>
                      <input type="number" placeholder="0" value={formGajianLama.jumlah}
                        onChange={(v) => setFormGajianLama((f) => ({ ...f, jumlah: inputValue(v) }))}
                        className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#a7f3d0" }} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: "#64748b" }}>Periode Dari</div>
                      <input type="date" value={formGajianLama.periodeGajiDari}
                        onChange={(v) => setFormGajianLama((f) => ({ ...f, periodeGajiDari: inputValue(v) }))}
                        className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#a7f3d0" }} />
                    </div>
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: "#64748b" }}>Periode Sampai</div>
                      <input type="date" value={formGajianLama.periodeGajiSampai}
                        onChange={(v) => setFormGajianLama((f) => ({ ...f, periodeGajiSampai: inputValue(v) }))}
                        className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#a7f3d0" }} />
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() => simpanGajianLama(formGajianLama)}
                    className="w-full rounded-xl py-2.5 text-sm font-bold text-white"
                    style={{ background: "linear-gradient(135deg,#065f46,#16a34a)" }}
                  >
                    {isSaving ? "Menyimpan..." : "💾 Simpan Riwayat Gajian"}
                  </button>
                </div>
              )}
            </div>

            {/* Daftar Riwayat Gajian Tersimpan */}
            {gajianHistory.length > 0 && (
              <div className="rounded-2xl bg-white p-4" style={{ border: "1px solid #a7f3d0" }}>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-black" style={{ color: "#065f46" }}>📋 Semua Riwayat Gajian ({gajianHistory.length})</div>
                    <div className="text-xs" style={{ color: "#64748b" }}>Daftar bisa discroll agar halaman tidak terlalu panjang.</div>
                  </div>
                </div>
                <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1 overscroll-contain">
                  {[...gajianHistory]
                    .sort((a, b) => String(b.tanggalGaji || "").localeCompare(String(a.tanggalGaji || "")))
                    .map((g) => (
                      <div key={g.id} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2" style={{ background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-black truncate" style={{ color: "#065f46" }}>{displayWorkerName(g.employeeName)}</div>
                          <div className="text-xs leading-snug" style={{ color: "#64748b" }}>
                            Digaji: {g.tanggalGaji} · Periode: {g.periodeGajiDari} s/d {g.periodeGajiSampai}
                          </div>
                          {g.source === "input_manual_lama" && (
                            <div className="text-xs font-bold" style={{ color: "#a855f7" }}>input manual lama</div>
                          )}
                        </div>
                        <div className="text-right shrink-0 flex flex-col items-end gap-1">
                          <div className="text-sm font-black" style={{ color: "#16a34a" }}>{money(g.jumlah)}</div>
                          {g.source === "input_manual_lama" && (
                            <button type="button" onClick={() => hapusGajianHistory(g.id)}
                              className="text-xs font-bold" style={{ color: "#ef4444" }}>Hapus</button>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* Ringkasan total */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-2xl bg-white p-3 text-center" style={{ border: "1px solid #fce7f3" }}>
                <div className="text-xl font-bold" style={{ color: "#ec4899" }}>{totalQty.toLocaleString()}</div>
                <div className="text-xs" style={{ color: "#94a3b8" }}>pcs diberikan</div>
              </div>
              <div className="rounded-2xl bg-white p-3 text-center" style={{ border: "1px solid #bbf7d0" }}>
                <div className="text-xl font-bold" style={{ color: "#16a34a" }}>{totalSetor.toLocaleString()}</div>
                <div className="text-xs" style={{ color: "#94a3b8" }}>pcs disetor</div>
              </div>
              <div className="rounded-2xl bg-white p-3 text-center" style={{ border: "1px solid #fde68a" }}>
                <div className="text-xl font-bold" style={{ color: "#d97706" }}>{totalReject.toLocaleString()}</div>
                <div className="text-xs" style={{ color: "#94a3b8" }}>pcs reject</div>
              </div>
              <div className="rounded-2xl bg-white p-3 text-center" style={{ border: "1px solid #e9d5ff" }}>
                <div className="text-base font-bold" style={{ color: "#7c3aed" }}>{money(totalGaji)}</div>
                <div className="text-xs" style={{ color: "#94a3b8" }}>total gaji</div>
              </div>
            </div>

            {rekapPerkerja.length > 0 && (
              <div className="rounded-2xl bg-white p-4 space-y-3" style={{ border: "1px solid #e9d5ff" }}>
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold" style={{ color: "#7c3aed" }}>💰 Rekap Gajian Keseluruhan</div>
                  <div className="text-xs" style={{ color: "#94a3b8" }}>{rekapPeriodReady ? `${rekapDari} s/d ${rekapSampai}` : "Periode belum dipilih"}</div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setRekapDetailModal("sudah")} className="rounded-xl p-3 text-left active:scale-[0.99] transition-transform" style={{ background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
                    <div className="text-xs font-bold" style={{ color: "#16a34a" }}>Sudah Gajian</div>
                    <div className="text-lg font-black" style={{ color: "#16a34a" }}>{money(rekapGajianKeseluruhan.totalSudahDibayar)}</div>
                    <div className="text-xs flex items-center justify-between" style={{ color: "#64748b" }}><span>{rekapGajianKeseluruhan.sudahGajian} pekerja</span><span>Rincian ›</span></div>
                  </button>
                  <button type="button" onClick={() => setRekapDetailModal("belum")} className="rounded-xl p-3 text-left active:scale-[0.99] transition-transform" style={{ background: "#fef3c7", border: "1px solid #fde68a" }}>
                    <div className="text-xs font-bold" style={{ color: "#b45309" }}>Belum Gajian</div>
                    <div className="text-lg font-black" style={{ color: "#b45309" }}>{money(rekapGajianKeseluruhan.totalBelumDibayar)}</div>
                    <div className="text-xs flex items-center justify-between" style={{ color: "#64748b" }}><span>{rekapGajianKeseluruhan.belumGajian} pekerja</span><span>Rincian ›</span></div>
                  </button>
                </div>
                <div onClick={() => setRekapDetailModal("total")} className="w-full rounded-xl p-3 text-left active:scale-[0.99] transition-transform cursor-pointer" style={{ background: "linear-gradient(135deg,#ede9fe,#fce7f3)", border: "1px solid #e9d5ff" }}>
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-bold" style={{ color: "#7c3aed" }}>Total Gaji Periode Ini</span>
                    <span className="text-xl font-black" style={{ color: "#7c3aed" }}>{money(rekapGajianKeseluruhan.totalGaji)}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
                    <button type="button" onClick={(e) => { e.stopPropagation(); setRekapDetailModal("pekerja"); }} className="rounded-lg py-2 active:scale-[0.98]" style={{ background: "rgba(255,255,255,0.7)" }}>
                      <div className="font-bold" style={{ color: "#2d1b69" }}>{rekapGajianKeseluruhan.totalPekerja}</div>
                      <div style={{ color: "#94a3b8" }}>pekerja</div>
                    </button>
                    <button type="button" onClick={(e) => { e.stopPropagation(); setRekapDetailModal("setor"); }} className="rounded-lg py-2 active:scale-[0.98]" style={{ background: "rgba(255,255,255,0.7)" }}>
                      <div className="font-bold" style={{ color: "#16a34a" }}>{rekapGajianKeseluruhan.totalPcsSetor.toLocaleString()}</div>
                      <div style={{ color: "#94a3b8" }}>pcs setor</div>
                    </button>
                    <button type="button" onClick={(e) => { e.stopPropagation(); setRekapDetailModal("belumSetor"); }} className="rounded-lg py-2 active:scale-[0.98]" style={{ background: "rgba(255,255,255,0.7)" }}>
                      <div className="font-bold" style={{ color: rekapGajianKeseluruhan.totalBelumSetor > 0 ? "#b45309" : "#94a3b8" }}>{rekapGajianKeseluruhan.totalBelumSetor.toLocaleString()}</div>
                      <div style={{ color: "#94a3b8" }}>blm setor</div>
                    </button>
                  </div>
                  <div className="mt-2 text-center text-[10px] font-semibold" style={{ color: "#a855f7" }}>Ketuk kotak untuk melihat rincian</div>
                  {rekapGajianKeseluruhan.totalBelumDibayar > 0 && (
                    <div className="mt-2 rounded-lg px-3 py-2 text-xs font-semibold" style={{ background: "#fff7ed", color: "#92400e", border: "1px solid #fed7aa" }}>
                      Sisa yang belum ditandai gajian: <strong>{money(rekapGajianKeseluruhan.totalBelumDibayar)}</strong>. Tandai dari modal slip tiap pekerja.
                    </div>
                  )}
                </div>
              </div>
            )}

            {rekapDetailModal && (() => {
              const getCarryOver = (nama) => productionEntries.filter((e) =>
                normalizeWorkerNameKey(e.employeeName) === normalizeWorkerNameKey(nama) &&
                setorTotals(e).sisaSetor > 0 &&
                dateBefore(e.tanggal, rekapDari)
              );
              const isAllTimeDetail = rekapDetailModal === "allTime";
              const baseRows = isAllTimeDetail
                ? rekapGajiAllTimeRows.map(([nama, r]) => ({ nama, r, sudah: false, carryOver: [] }))
                : rekapPerkerja.map(([nama, r]) => ({
                    nama,
                    r,
                    sudah: sudahGajian(nama, rekapDari, rekapSampai),
                    carryOver: getCarryOver(nama),
                  }));
              const filteredRows = baseRows
                .filter((row) => {
                  if (isAllTimeDetail) return true;
                  if (rekapDetailModal === "sudah") return row.sudah;
                  if (rekapDetailModal === "belum") return !row.sudah;
                  if (rekapDetailModal === "belumSetor") return Number(row.r?.belumSetor || 0) > 0;
                  if (rekapDetailModal === "setor") return Number(row.r?.pcsSetor || 0) > 0;
                  return true;
                })
                .sort((a, b) => {
                  if (rekapDetailModal === "setor") return Number(b.r?.pcsSetor || 0) - Number(a.r?.pcsSetor || 0);
                  if (rekapDetailModal === "belumSetor") return Number(b.r?.belumSetor || 0) - Number(a.r?.belumSetor || 0);
                  return Number(b.r?.gaji || 0) - Number(a.r?.gaji || 0);
                });
              const titleMap = {
                sudah: "Rincian Sudah Gajian",
                belum: "Rincian Belum Gajian",
                total: "Rincian Total Gaji Periode Ini",
                pekerja: "Rincian Semua Pekerja",
                setor: "Rincian PCS Setor",
                belumSetor: "Rincian Belum Setor",
                allTime: "Rincian Gaji Total Keseluruhan",
              };
              const modalTotalGaji = filteredRows.reduce((sum, row) => sum + Number(row.r?.gaji || 0), 0);
              const modalTotalSetor = filteredRows.reduce((sum, row) => sum + Number(row.r?.pcsSetor || 0), 0);
              const modalTotalBelum = filteredRows.reduce((sum, row) => sum + Number(row.r?.belumSetor || 0), 0);
              return (
                <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.4)" }}>
                  <div className="w-full max-h-[88vh] overflow-auto bg-white" style={{ borderRadius: "28px 28px 0 0", borderTop: "3px solid #a855f7" }}>
                    <div className="sticky top-0 z-10 px-4 py-4 bg-white" style={{ borderBottom: "1px solid #f3e8ff" }}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-base font-black" style={{ color: "#2d1b69" }}>{titleMap[rekapDetailModal] || "Rincian Rekap"}</div>
                          <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>{isAllTimeDetail ? "Semua waktu" : (rekapPeriodReady ? `${rekapDari} s/d ${rekapSampai}` : "Periode belum dipilih")} · {filteredRows.length} pekerja</div>
                        </div>
                        <button type="button" onClick={() => setRekapDetailModal(null)} className="rounded-full px-3 py-1.5 text-xs font-bold" style={{ background: "#f1f5f9", color: "#64748b" }}>Tutup</button>
                      </div>
                      <div className="grid grid-cols-3 gap-2 mt-3 text-center text-xs">
                        <div className="rounded-xl py-2" style={{ background: "#f5f3ff" }}>
                          <div className="font-black" style={{ color: "#7c3aed" }}>{money(modalTotalGaji)}</div>
                          <div style={{ color: "#94a3b8" }}>gaji</div>
                        </div>
                        <div className="rounded-xl py-2" style={{ background: "#f0fdf4" }}>
                          <div className="font-black" style={{ color: "#16a34a" }}>{modalTotalSetor.toLocaleString()}</div>
                          <div style={{ color: "#94a3b8" }}>pcs setor</div>
                        </div>
                        <div className="rounded-xl py-2" style={{ background: "#fff7ed" }}>
                          <div className="font-black" style={{ color: modalTotalBelum > 0 ? "#b45309" : "#94a3b8" }}>{modalTotalBelum.toLocaleString()}</div>
                          <div style={{ color: "#94a3b8" }}>blm setor</div>
                        </div>
                      </div>
                    </div>
                    <div className="p-4 space-y-2">
                      {filteredRows.length === 0 ? (
                        <div className="rounded-2xl p-6 text-center text-sm" style={{ background: "#f8fafc", color: "#94a3b8" }}>Tidak ada data untuk kategori ini.</div>
                      ) : filteredRows.map(({ nama, r, sudah, carryOver }) => (
                        <div key={nama} className="rounded-2xl p-3" style={{ border: "1px solid #e9d5ff", background: sudah ? "#f0fdf4" : "#fff7ed" }}>
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>👤 {nama}</div>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {isAllTimeDetail ? (
                                  <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: "#ecfdf5", color: "#047857" }}>
                                    📚 Semua waktu · {Number(r.transaksi || 0).toLocaleString()} transaksi
                                  </span>
                                ) : (
                                  <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: sudah ? "#dcfce7" : "#fef3c7", color: sudah ? "#16a34a" : "#b45309" }}>
                                    {sudah ? "✅ Sudah gajian" : "⏳ Belum gajian"}
                                  </span>
                                )}
                                {Number(r.belumSetor || 0) > 0 && <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: "#fffbeb", color: "#b45309" }}>⏳ {r.belumSetor} blm setor</span>}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="text-sm font-black" style={{ color: "#16a34a" }}>{money(r.gaji)}</div>
                              <div className="text-[10px]" style={{ color: "#94a3b8" }}>{r.pcsSetor} pcs setor</div>
                            </div>
                          </div>
                          <div className="grid grid-cols-3 gap-1 mt-3 text-center text-xs">
                            <div className="rounded-lg py-1.5" style={{ background: "rgba(255,255,255,0.7)" }}><strong>{r.pcsAwal}</strong><div style={{ color: "#94a3b8" }}>diberi</div></div>
                            <div className="rounded-lg py-1.5" style={{ background: "rgba(255,255,255,0.7)" }}><strong style={{ color: "#16a34a" }}>{r.pcsSetor}</strong><div style={{ color: "#94a3b8" }}>setor</div></div>
                            <div className="rounded-lg py-1.5" style={{ background: "rgba(255,255,255,0.7)" }}><strong style={{ color: r.pcsReject > 0 ? "#ef4444" : "#94a3b8" }}>{r.pcsReject}</strong><div style={{ color: "#94a3b8" }}>reject</div></div>
                          </div>
                          {!isAllTimeDetail && (
                            <button
                              type="button"
                              onClick={() => { setRekapDetailModal(null); setSlipPreview({ nama, r, dari: rekapDari, sampai: rekapSampai, carryOver }); }}
                              className="mt-3 w-full rounded-xl py-2 text-xs font-bold text-white"
                              style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}
                            >
                              👁️ Lihat Slip
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })()}

            {boronganBelumMasukRekap.length > 0 && (
              <div className="rounded-2xl bg-white p-4 space-y-3" style={{ border: "1px solid #fed7aa", background: "#fff7ed" }}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-bold" style={{ color: "#c2410c" }}>⚠️ Borongan Belum Masuk Rekap Gaji</div>
                    <div className="text-[11px] mt-1" style={{ color: "#9a3412" }}>
                      Data ini ada di Borongan, tapi belum menghasilkan gaji pada periode {rekapPeriodReady ? `${rekapDari} s/d ${rekapSampai}` : "Periode belum dipilih"}.
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-black" style={{ color: "#c2410c" }}>{totalBoronganBelumMasukPcs.toLocaleString()} pcs</div>
                    <div className="text-[10px]" style={{ color: "#9a3412" }}>potensi {money(totalBoronganBelumMasukGajiPotensi)}</div>
                  </div>
                </div>
                <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                  {boronganBelumMasukRekap.map((e) => (
                    <div key={e.id} className="rounded-xl p-3" style={{ background: "rgba(255,255,255,0.85)", border: "1px solid #fed7aa" }}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>👤 {e.employeeName || "Tidak diketahui"}</div>
                          <div className="text-xs mt-0.5" style={{ color: "#64748b" }}>
                            {e.process || "-"} · {e.model || "-"} · {e.customer || "-"}{e.invoice ? ` · ${e.invoice}` : ""}
                          </div>
                          <div className="text-[11px] mt-1 font-semibold" style={{ color: "#c2410c" }}>{e.alasan}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-black" style={{ color: "#c2410c" }}>{Number(e.sisaSetor || 0).toLocaleString()} pcs</div>
                          <div className="text-[10px]" style={{ color: "#94a3b8" }}>sisa setor</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-1 mt-3 text-center text-[11px]">
                        <div className="rounded-lg py-1.5" style={{ background: "#f8fafc" }}>
                          <strong>{Number(e.qty || 0).toLocaleString()}</strong>
                          <div style={{ color: "#94a3b8" }}>diberi</div>
                        </div>
                        <div className="rounded-lg py-1.5" style={{ background: "#ecfdf5" }}>
                          <strong style={{ color: "#16a34a" }}>{Number(e.totalSetorSemua || 0).toLocaleString()}</strong>
                          <div style={{ color: "#94a3b8" }}>setor</div>
                        </div>
                        <div className="rounded-lg py-1.5" style={{ background: Number(e.totalRejectSemua || 0) > 0 ? "#fee2e2" : "#f8fafc" }}>
                          <strong style={{ color: Number(e.totalRejectSemua || 0) > 0 ? "#ef4444" : "#94a3b8" }}>{Number(e.totalRejectSemua || 0).toLocaleString()}</strong>
                          <div style={{ color: "#94a3b8" }}>reject</div>
                        </div>
                        <div className="rounded-lg py-1.5" style={{ background: "#fff7ed" }}>
                          <strong style={{ color: "#c2410c" }}>{money(Number(e.sisaSetor || 0) * Number(e.rate || 0))}</strong>
                          <div style={{ color: "#94a3b8" }}>potensi</div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between mt-2 text-[11px]" style={{ color: "#94a3b8" }}>
                        <span>📅 Diberikan: {e.tanggal || "-"}</span>
                        <span>{e.tanggalSetorTerakhir ? `Setor terakhir: ${e.tanggalSetorTerakhir}` : "Belum ada setor"}</span>
                      </div>
                      {Number(e.sisaSetor || 0) > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            // Selalu pakai entry asli dari productionEntries agar setorTotals
                            // tidak membaca field derived (qtySetor, statusSetor, dll) sebagai legacy data.
                            const rawEntry = productionEntries.find((pe) => pe.id === e.id) || e;
                            const t = setorTotals(rawEntry);
                            setSetorModal(rawEntry);
                            setSetorForm({ qtySetor: String(t.sisaSetor || ""), qtyReject: "", tanggalSetor: todayStr(), catatan: "" });
                          }}
                          className="mt-3 w-full rounded-xl py-2 text-xs font-bold text-white"
                          style={{ background: "linear-gradient(135deg,#f97316,#ec4899)" }}
                        >
                          ✅ Setor Hasil / Masukkan ke Rekap
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Rekap per proses */}
            {prosesKeys.length > 0 ? (
              <div className="rounded-2xl bg-white p-4 space-y-3" style={{ border: "1px solid #e9d5ff" }}>
                <div className="text-xs font-bold" style={{ color: "#7c3aed" }}>📋 Per Proses</div>
                {prosesKeys.map((p) => {
                  const r = byProses[p];
                  const icon = p === "Potong" ? "✂️" : p === "Jahit" ? "🧵" : sameProcess(p, "Pengemasan QC") ? "📦" : "🔧";
                  const reject = r.qtyReject;
                  return (
                    <div key={p} className="rounded-xl p-3" style={{ background: "#fdf4ff", border: "1px solid #f3e8ff" }}>
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-bold text-sm" style={{ color: "#2d1b69" }}>{icon} {p}</span>
                        <span className="text-xs font-bold" style={{ color: "#7c3aed" }}>{money(r.gaji)}</span>
                      </div>
                      <div className="grid grid-cols-3 gap-1 text-center text-xs">
                        <div className="rounded-lg py-1" style={{ background: "#ede9fe" }}>
                          <div className="font-bold" style={{ color: "#5b21b6" }}>{(r.qtyDiberikan ?? r.qty).toLocaleString()}</div>
                          <div style={{ color: "#94a3b8" }}>diberikan</div>
                        </div>
                        <div className="rounded-lg py-1" style={{ background: "#dcfce7" }}>
                          <div className="font-bold" style={{ color: "#16a34a" }}>{r.qtySetor.toLocaleString()}</div>
                          <div style={{ color: "#94a3b8" }}>disetor</div>
                        </div>
                        <div className="rounded-lg py-1" style={{ background: reject > 0 ? "#fee2e2" : "#f1f5f9" }}>
                          <div className="font-bold" style={{ color: reject > 0 ? "#ef4444" : "#94a3b8" }}>{reject.toLocaleString()}</div>
                          <div style={{ color: "#94a3b8" }}>reject</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty text="Tidak ada data borongan di periode ini" />
            )}

            {/* Rekap Gaji per Pekerja + Download Slip */}
            {rekapPerkerja.length > 0 && (
              <div className="rounded-2xl bg-white p-4 space-y-3" style={{ border: "1px solid #e9d5ff" }}>
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold" style={{ color: "#7c3aed" }}>📊 Rekap Gaji per Pekerja</div>
                  <div className="text-xs" style={{ color: "#94a3b8" }}>{rekapPerkerja.length} pekerja</div>
                </div>
                {rekapPerkerja.map(([nama, r]) => {
                  const sudahGajianPerkerja = sudahGajian(nama, rekapDari, rekapSampai);
                  const carryOver = productionEntries.filter((e) =>
                    normalizeWorkerNameKey(e.employeeName) === normalizeWorkerNameKey(nama) &&
                    Number(setorTotals(e).sisaSetor || 0) > 0 &&
                    dateBefore(e.tanggal, rekapDari)
                  );
                  const totalCarryOverPcs = carryOver.reduce((s, e) => s + Number(setorTotals(e).sisaSetor || 0), 0);
                  return (
                  <div key={nama} className="rounded-xl overflow-hidden" style={{ border: "1px solid #e9d5ff" }}>
                    {/* Header pekerja */}
                    <div className="px-3 py-2" style={{ background: "linear-gradient(135deg,#ede9fe,#fce7f3)" }}>
                      <div className="flex justify-between items-start">
                        <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>👤 {nama}</div>
                        <div className="text-sm font-bold" style={{ color: "#16a34a" }}>{money(r.gaji)}</div>
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {sudahGajianPerkerja
                          ? <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "#dcfce7", color: "#16a34a" }}>✅ Sudah gajian</span>
                          : <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "#fef3c7", color: "#b45309" }}>⏳ Belum gajian</span>}
                        {totalCarryOverPcs > 0 && (
                          <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "#fff1f2", color: "#e11d48" }}>
                            ⚠️ {totalCarryOverPcs} pcs tanggungan minggu lalu
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Ringkasan */}
                    <div className="flex gap-3 px-3 py-1.5 text-xs border-b" style={{ color: "#64748b", borderColor: "#f3e8ff" }}>
                      <span>📦 Diberi: <strong>{r.pcsAwal}</strong></span>
                      <span>✅ Setor: <strong style={{ color: "#16a34a" }}>{r.pcsSetor}</strong></span>
                      {r.pcsReject > 0 && <span>❌ Reject: <strong style={{ color: "#ef4444" }}>{r.pcsReject}</strong></span>}
                      {r.belumSetor > 0 && <span style={{ color: "#b45309" }}>⏳ <strong>{r.belumSetor}</strong> blm setor</span>}
                    </div>
                    {/* Detail per pesanan & model */}
                    <div className="px-3 py-2 space-y-1.5">
                      {r.detail.map((d, i) => (
                        <div key={i} className="flex justify-between items-start text-xs rounded-lg px-2 py-1.5"
                          style={{ background: d.sudahSetor ? "#f0fdf4" : "#fefce8" }}>
                          <div>
                            <div className="font-semibold" style={{ color: "#2d1b69" }}>
                              👗 {d.model} — {d.process}
                            </div>
                            <div style={{ color: "#94a3b8" }}>
                              {d.customer}{d.invoice ? ` · ${d.invoice}` : ""}
                            </div>
                          </div>
                          <div className="text-right ml-2">
                            <div className="font-bold" style={{ color: d.sudahSetor ? "#16a34a" : "#b45309" }}>
                              {d.sudahSetor ? d.qtySetor : d.qty} pcs
                            </div>
                            {d.sudahSetor && d.gaji > 0 && (
                              <div style={{ color: "#a855f7" }}>{money(d.gaji)}</div>
                            )}
                            {!d.sudahSetor && <div style={{ color: "#b45309" }}>⏳ blm setor</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* Tombol Lihat & Download Slip */}
                    <div className="px-3 pb-3">
                      <button
                        onClick={() => setSlipPreview({ nama, r, dari: rekapDari, sampai: rekapSampai, carryOver })}
                        className="w-full rounded-xl py-2.5 text-xs font-bold text-white flex items-center justify-center gap-2"
                        style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}
                      >
                        👁️ Lihat Slip Gaji · {rekapPeriodReady ? `${rekapDari} s/d ${rekapSampai}` : "Periode belum dipilih"}
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {tab === "kain" && (
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-2 rounded-2xl bg-white p-2 shadow-sm" style={{ border: "1px solid #fce7f3" }}>
            <button
              type="button"
              onClick={() => setTab("kain")}
              className="rounded-xl px-3 py-2 text-sm font-black transition-transform active:scale-[0.99]"
              style={{ background: tab === "kain" ? "#fdf2f8" : "#f8fafc", color: tab === "kain" ? "#ec4899" : "#64748b", border: tab === "kain" ? "1.5px solid #f9a8d4" : "1px solid #e2e8f0" }}
            >
              🎨 Kain
            </button>
            <button
              type="button"
              onClick={() => setTab("tarif")}
              className="rounded-xl px-3 py-2 text-sm font-black transition-transform active:scale-[0.99]"
              style={{ background: tab === "tarif" ? "#fdf2f8" : "#f8fafc", color: tab === "tarif" ? "#ec4899" : "#64748b", border: tab === "tarif" ? "1.5px solid #f9a8d4" : "1px solid #e2e8f0" }}
            >
              🏷️ Tarif
            </button>
          </div>
          <InfoBox title="Data kain dari Gallery Kerudung" subtitle="Sumber data: collection materials. Gallery Produksi hanya melihat stok kain." icon="🎨" />
          {filteredMaterials.length === 0 && <Empty text="Tidak ada data kain/materials" />}
          {filteredMaterials.map((k) => (
            <div key={k.id} className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: "1px solid #fce7f3" }}>
              <div className="font-bold text-lg" style={{ color: "#2d1b69" }}>🎨 {k.namaKain}</div>
              <div className="text-xs" style={{ color: "#a855f7" }}>Satuan: {k.satuan || "-"}</div>
              <div className="mt-3 space-y-2">
                {(k.warnas || []).map((w, idx) => (
                  <div key={idx} className="rounded-2xl p-3" style={{ background: "#fdf2f8", border: "1px solid #fce7f3" }}>
                    <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>{w.warna || "-"}</div>
                    <div className="grid grid-cols-3 gap-2 mt-2 text-center">
                      <MiniStat label="Stok" value={fmtQty(w.stok)} bg="#ede9fe" color="#5b21b6" />
                      <MiniStat label="Dipotong" value={fmtQty(w.dipotong)} bg="#fce7f3" color="#be185d" />
                      <MiniStat label="Sisa" value={fmtQty(w.sisa)} bg="#d1fae5" color="#059669" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "kirim" && (
        <div className="space-y-3 p-4">
          <Button onClick={() => setModal("kirim")} className="w-full" style={{ background: "linear-gradient(135deg,#10b981,#34d399)" }}>
            🚚 + Catat Pengiriman
          </Button>

          {boronganTanpaPesanan.length > 0 && (
            <div className="rounded-2xl px-4 py-3 flex items-start gap-3" style={{ background: "#fffbeb", border: "1.5px solid #f59e0b" }}>
              <span className="text-xl">⚠️</span>
              <div className="flex-1">
                <div className="text-sm font-black" style={{ color: "#92400e" }}>{boronganTanpaPesanan.length} borongan minggu ini belum dikaitkan ke pesanan</div>
                <div className="text-xs mt-1" style={{ color: "#b45309" }}>Semua produksi wajib terkait pesanan. Sebelum kirim, kaitkan dulu dari Tab Borongan agar qty masuk progress.</div>
              </div>
              <button
                type="button"
                onClick={() => { setBoronganOnlyBelumSetor(false); setBoronganOnlyOverSetor(false); setBoronganOnlyTanpaPesanan(true); setTab("borongan"); }}
                className="text-xs font-bold px-3 py-2 rounded-full text-white shrink-0"
                style={{ background: "linear-gradient(135deg,#f59e0b,#d97706)" }}
              >
                Buka Borongan
              </button>
            </div>
          )}

          {/* Banner filter belum lengkap */}
          {kirimOnlyBelumLengkap && (
            <div className="rounded-2xl px-4 py-3 flex items-start gap-3" style={{ background: "#dbeafe", border: "1.5px solid #93c5fd" }}>
              <span className="text-xl">🚚</span>
              <div className="flex-1">
                <div className="text-sm font-black" style={{ color: "#1d4ed8" }}>Hanya menampilkan pengiriman belum lengkap</div>
                <div className="text-xs mt-1" style={{ color: "#2563eb" }}>Catat sisa pengiriman untuk pesanan di bawah ini.</div>
              </div>
              <button
                type="button"
                onClick={() => setKirimOnlyBelumLengkap(false)}
                className="text-xs font-bold px-3 py-2 rounded-full text-white shrink-0"
                style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}
              >
                Tampilkan Semua
              </button>
            </div>
          )}

          {(() => {
            const kirimBelumLengkapIds = new Set(
              (dashboardInsights.tugas.kirimBelumLengkapAll || dashboardInsights.tugas.kirimBelumLengkap).map(({ order }) => order.id)
            );
            const displayedBase = kirimOnlyBelumLengkap
              ? filteredShipments.filter((k) => kirimBelumLengkapIds.has(k.orderId) || kirimBelumLengkapIds.has(k.pesananId))
              : filteredShipments;
            const shipmentIssuePriority = (k) => {
              const relatedOrder =
                orderLookupForCards.byId.get(String(k.orderId || k.pesananId || "").trim()) ||
                orderLookupForCards.byId.get(String(k.pesananId || k.orderId || "").trim()) ||
                orderLookupForCards.byInvoice.get(normalizedInvoice(k.invoice || "")) ||
                null;
              const ordered = relatedOrder ? dashboardTotalOrderedQty(relatedOrder) : (k.items || []).reduce((s, item) => s + Number(item.qtyPesan || item.orderedQty || 0), 0);
              const shipped = relatedOrder ? dashboardTotalShippedQty(relatedOrder) : (k.items || []).reduce((s, item) => s + Number(item.qtyKirim || item.shippedQty || item.qty || 0), 0);
              if (ordered > 0 && shipped > ordered) return 0;
              if (ordered > 0 && shipped < ordered) return 1;
              return 2;
            };
            const displayed = [...displayedBase].sort((a, b) => {
              const pa = shipmentIssuePriority(a);
              const pb = shipmentIssuePriority(b);
              if (pa !== pb) return pa - pb;
              return String(b.tanggalKirim || "").localeCompare(String(a.tanggalKirim || ""));
            });
            if (displayed.length === 0) return <Empty text={kirimOnlyBelumLengkap ? "Semua pengiriman sudah lengkap" : "Tidak ada data pengiriman"} />;
            return displayed.map((k) => {
              const relatedOrder =
                orderLookupForCards.byId.get(String(k.orderId || k.pesananId || "").trim()) ||
                orderLookupForCards.byId.get(String(k.pesananId || k.orderId || "").trim()) ||
                orderLookupForCards.byInvoice.get(normalizedInvoice(k.invoice || "")) ||
                null;
              return (
            <div key={k.id} className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: "1px solid #fce7f3" }}>
              {(() => {
                const ordered = relatedOrder ? dashboardTotalOrderedQty(relatedOrder) : (k.items || []).reduce((s, item) => s + Number(item.qtyPesan || item.orderedQty || 0), 0);
                const shipped = relatedOrder ? dashboardTotalShippedQty(relatedOrder) : (k.items || []).reduce((s, item) => s + Number(item.qtyKirim || item.shippedQty || item.qty || 0), 0);
                const sisa = Math.max(0, ordered - shipped);
                const lebih = Math.max(0, shipped - ordered);
                const statusLabel = lebih > 0 ? `Lebih kirim ${fmtQty(lebih)} pcs` : sisa > 0 ? `Sisa kirim ${fmtQty(sisa)} pcs` : "Pengiriman lengkap";
                const statusStyle = lebih > 0
                  ? { background: "#fff7ed", color: "#c2410c", border: "1px solid #fed7aa" }
                  : sisa > 0
                    ? { background: "#dbeafe", color: "#1d4ed8", border: "1px solid #93c5fd" }
                    : { background: "#dcfce7", color: "#16a34a", border: "1px solid #86efac" };
                return (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-bold" style={{ color: "#2d1b69" }}>{k.customer || relatedOrder?.customer || "-"}</div>
                        <div className="text-xs" style={{ color: "#a855f7" }}>👗 {k.produk || relatedOrder?.item || "-"}</div>
                        <div className="text-xs" style={{ color: "#94a3b8" }}>🚚 {k.tanggalKirim || "-"} · {k.ekspedisi || "-"}</div>
                      </div>
                      <span className="shrink-0 rounded-full px-3 py-1 text-[11px] font-black" style={statusStyle}>{statusLabel}</span>
                    </div>
                    <div className="mt-3 rounded-2xl p-3" style={{ background: "#fdf2f8" }}>
                      {(k.items || []).map((item, i) => (
                        <div key={i} className="flex justify-between text-xs py-1 gap-2">
                          <span>{item.nama || item.name || "-"}</span>
                          <span className="font-bold">{item.qtyPesan || item.orderedQty || 0} / {item.qtyKirim || item.shippedQty || item.qty || 0} pcs</span>
                        </div>
                      ))}
                      {relatedOrder && (sisa > 0 || lebih > 0) && (
                        <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                          <div className="rounded-xl bg-white px-2 py-2"><b>Pesan</b><br/>{fmtQty(ordered)} pcs</div>
                          <div className="rounded-xl bg-white px-2 py-2"><b>Terkirim</b><br/>{fmtQty(shipped)} pcs</div>
                          <div className="rounded-xl bg-white px-2 py-2"><b>{lebih > 0 ? "Lebih" : "Sisa"}</b><br/>{fmtQty(lebih > 0 ? lebih : sisa)} pcs</div>
                        </div>
                      )}
                    </div>
                    {relatedOrder && (
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        {sisa > 0 ? (
                          <Button
                            type="button"
                            onClick={() => openKirimSisaForOrder(relatedOrder)}
                            className="text-xs"
                            style={{ background: "linear-gradient(135deg,#0ea5e9,#2563eb)" }}
                          >
                            🚚 Kirim Sisa
                          </Button>
                        ) : lebih > 0 ? (
                          <Button
                            type="button"
                            onClick={() => closeOverDeliveryOrder(relatedOrder)}
                            disabled={isSaving || relatedOrder.raw?.overDeliveryReviewed || relatedOrder.overDeliveryReviewed}
                            className="text-xs"
                            style={{ background: "linear-gradient(135deg,#f97316,#ec4899)" }}
                          >
                            {relatedOrder.raw?.overDeliveryReviewed || relatedOrder.overDeliveryReviewed ? "✅ Sudah Dicek" : "✅ Tandai Dicek"}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            onClick={() => openPengirimanForOrder(relatedOrder)}
                            className="text-xs"
                            style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}
                          >
                            Detail Order
                          </Button>
                        )}
                        <Button
                          type="button"
                          onClick={() => { setPesananOnlyNeedCheck(false); setQ(relatedOrder.invoice || relatedOrder.customer || ""); setTab("pesanan"); }}
                          className="text-xs"
                          style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}
                        >
                          Buka Pesanan
                        </Button>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
              );
            });
          })()}
        </div>
      )}

      {tab === "tarif" && (
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-2 rounded-2xl bg-white p-2 shadow-sm" style={{ border: "1px solid #fce7f3" }}>
            <button
              type="button"
              onClick={() => setTab("kain")}
              className="rounded-xl px-3 py-2 text-sm font-black transition-transform active:scale-[0.99]"
              style={{ background: tab === "kain" ? "#fdf2f8" : "#f8fafc", color: tab === "kain" ? "#ec4899" : "#64748b", border: tab === "kain" ? "1.5px solid #f9a8d4" : "1px solid #e2e8f0" }}
            >
              🎨 Kain
            </button>
            <button
              type="button"
              onClick={() => setTab("tarif")}
              className="rounded-xl px-3 py-2 text-sm font-black transition-transform active:scale-[0.99]"
              style={{ background: tab === "tarif" ? "#fdf2f8" : "#f8fafc", color: tab === "tarif" ? "#ec4899" : "#64748b", border: tab === "tarif" ? "1.5px solid #f9a8d4" : "1px solid #e2e8f0" }}
            >
              🏷️ Tarif
            </button>
          </div>
          <Button onClick={() => setModal("tarif")} className="w-full" style={{ background: "linear-gradient(135deg,#a855f7,#ec4899)" }}>
            🏷️ + Tambah Tarif Borongan
          </Button>
          {workRates.map((r) => (
            <div key={r.id} className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: "1px solid #fce7f3" }}>
              <div className="flex justify-between items-start gap-3">
                <div>
                  <div className="font-bold" style={{ color: "#2d1b69" }}>{r.productType}{r.model ? ` · ${r.model}` : ""}</div>
                  <div className="text-xs" style={{ color: "#a855f7" }}>{r.process}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold" style={{ color: "#ec4899" }}>{money(r.rate)} / pcs</div>
                  <button onClick={() => deleteRate(r.id)} className="mt-1 text-xs font-bold text-rose-500">Hapus</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal === "produksi" && (
        <Modal title="🧵 Tambah ke Produksi" onClose={closeMainModal}>
          <div className="space-y-3">
            <Select label="Pilih Pesanan" value={prodForm.orderId} onChange={(v) => setProdForm((f) => ({ ...f, orderId: v }))}>
              <option value="">-- Pilih Pesanan --</option>
              {ordersBelumProduksi.map((o) => <option key={o.id} value={o.id}>{o.customer} · {o.item} · {o.qty} pcs</option>)}
            </Select>
            <Input label="Tanggal Mulai" type="date" value={prodForm.tanggalMulai} onChange={(v) => setProdForm((f) => ({ ...f, tanggalMulai: v }))} />
            <Input label="Catatan" value={prodForm.catatan} onChange={(v) => setProdForm((f) => ({ ...f, catatan: v }))} placeholder="Catatan produksi" />
            <Button onClick={addProduksi} disabled={isSaving} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
              Simpan Produksi
            </Button>
          </div>
        </Modal>
      )}

      {modal === "borongan" && (
        <Modal title="💪 Input Hasil Borongan" onClose={closeMainModal}>
          <div className="space-y-3">
            <div>
              <Input
                label="Nama Pekerja"
                value={entryForm.employeeName}
                onChange={(v) => setEntryForm((f) => ({ ...f, employeeName: v }))}
                placeholder="Contoh: Teh Emy"
              />
              {workerNameOptions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {workerNameOptions.slice(0, 8).map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setEntryForm((f) => ({ ...f, employeeName: name }))}
                      className="rounded-full px-3 py-1 text-xs font-bold"
                      style={{ background: "#fdf2f8", color: "#a855f7", border: "1px solid #f9a8d4" }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-2 rounded-xl px-3 py-2 text-[11px] font-semibold" style={{ background: "#f8fafc", color: "#64748b", border: "1px solid #e2e8f0" }}>
                Master data otomatis dari nama yang sudah pernah dipakai. Nama mirip akan dirapikan dan digabung saat disimpan.
              </div>
            </div>
            <div className="space-y-2">
              <Input
                label="Cari pesanan terkait"
                value={entryOrderSearch}
                onChange={(v) => setEntryOrderSearch(v)}
                placeholder="Ketik customer, produk/model, atau nomor order"
              />
              <div className="rounded-2xl border p-3 text-xs font-bold" style={{ background: "#fff7ed", borderColor: "#fed7aa", color: "#9a3412" }}>
                ⚠️ Pesanan tetap wajib dipilih. App hanya menampilkan rekomendasi terbatas agar admin tidak scroll semua pesanan.
              </div>
              <div className="space-y-2">
                {ordersForBoronganLink.length === 0 ? (
                  <div className="rounded-2xl border p-3 text-xs font-semibold" style={{ background: "#f8fafc", borderColor: "#e2e8f0", color: "#64748b" }}>
                    Tidak ada pesanan cocok. Coba ketik nama customer atau model yang lebih spesifik.
                  </div>
                ) : ordersForBoronganLink.map((o) => {
                  const selected = entryForm.orderId === o.id;
                  const prod = produksiByOrderId.get(o.id);
                  const itemNames = getOrderItemModelOptions(o);
                  const processDone = processQtyForOrder(o.id, entryForm.process);
                  const orderQty = dashboardTotalOrderedQty(o) || nonNegativeQty(o.qty || 0);
                  const remaining = Math.max(0, orderQty - processDone);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => chooseOrderForBorongan(o)}
                      className="w-full rounded-2xl p-3 text-left text-xs font-bold transition"
                      style={{
                        background: selected ? "#fdf2f8" : "#fff",
                        border: selected ? "2px solid #ec4899" : "1px solid #f9a8d4",
                        color: "#1e1b4b",
                      }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-black">{o.customer || "Tanpa Customer"}</div>
                          <div className="mt-0.5" style={{ color: "#64748b" }}>{o.invoice || o.orderNo || "Tanpa No Order"} · {orderQty} pcs</div>
                          <div className="mt-1" style={{ color: "#7c3aed" }}>{itemNames.slice(0, 2).join(", ") || o.item || "-"}</div>
                          {prod && <div className="mt-1" style={{ color: "#059669" }}>Sudah ada di produksi: {prod.status || "Aktif"}</div>}
                        </div>
                        <div className="shrink-0 rounded-full px-2 py-1 text-[11px] font-black" style={{ background: selected ? "#ec4899" : "#fce7f3", color: selected ? "#fff" : "#be185d" }}>
                          {selected ? "Dipilih" : `Sisa ${entryForm.process} ${remaining} pcs`}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {!entryForm.orderId && (
              <div className="rounded-2xl border p-3 text-xs font-bold" style={{ background: "#fff1f2", borderColor: "#fecdd3", color: "#be123c" }}>
                ⚠️ Belum ada pesanan yang dipilih. Pilih salah satu rekomendasi di atas sebelum simpan.
              </div>
            )}

            <Select label="Jenis Produk" value={entryForm.productType} onChange={(v) => setEntryForm((f) => ({ ...f, productType: v }))}>
              {PRODUCT_TYPES.map((p) => <option key={p}>{p}</option>)}
            </Select>
            <Select label="Proses" value={entryForm.process} onChange={(v) => setEntryForm((f) => ({ ...f, process: v, model: "" }))}>
              {ALL_PROCESSES.map((p) => <option key={p}>{p}</option>)}
            </Select>

            {(() => {
              const selectedOrder = orders.find((o) => o.id === entryForm.orderId);
              const rateModels = getRateModelOptions(entryForm.productType, entryForm.process, selectedOrder);
              const selectedPreview = getRatePreview(entryForm.productType, entryForm.model, entryForm.process, entryForm.employeeName);
              const { limit, label } = selectedOrder && entryForm.model
                ? getOrderProcessLimit(selectedOrder, entryForm.process, entryForm.model)
                : { limit: 0, label: "pesanan" };
              const alreadyQty = selectedOrder && entryForm.model
                ? processQtyForOrderModel(selectedOrder.id, entryForm.process, entryForm.model)
                : 0;
              const sisaQty = limit > 0 ? Math.max(0, limit - alreadyQty) : 0;
              return (
                <div className="space-y-2">
                  <Select
                    label="Model / Acuan Tarif"
                    value={entryForm.model}
                    onChange={(v) => setEntryForm((f) => ({ ...f, model: v, qty: sisaQty > 0 ? String(sisaQty) : f.qty }))}
                  >
                    <option value="">{isModelSpecificProcess(entryForm.process) ? "-- Pilih model dari pesanan terkait --" : "-- Pilih acuan tarif dari Master Tarif --"}</option>
                    {rateModels.map((name) => <option key={name} value={name}>{name}</option>)}
                  </Select>
                  {!selectedOrder && (
                    <div className="rounded-2xl border p-3 text-xs font-bold" style={{ background: "#fff7ed", borderColor: "#fed7aa", color: "#9a3412" }}>
                      ⚠️ Pesanan wajib dipilih untuk semua proses produksi.
                    </div>
                  )}
                  {rateModels.length === 0 && (!isModelSpecificProcess(entryForm.process) || selectedOrder) && (
                    <div className="rounded-2xl border p-3 text-xs font-bold" style={{ background: "#fff7ed", borderColor: "#fed7aa", color: "#9a3412" }}>
                      ⚠️ {isModelSpecificProcess(entryForm.process)
                        ? `Pesanan terkait belum memiliki item/model untuk proses ${entryForm.process}.`
                        : `Tarif belum ada di Master Tarif untuk ${entryForm.productType} · ${entryForm.process}. Silakan buat tarif baru di menu Master Tarif.`}
                    </div>
                  )}
                  {selectedPreview.status === "found" && (
                    <div className="rounded-2xl border p-3 text-xs" style={{ background: "#ecfdf5", borderColor: "#86efac", color: "#166534" }}>
                      <div className="font-black">✅ Tarif yang dipakai</div>
                      <div className="mt-1 font-bold">{entryForm.productType} · {entryForm.process} · {entryForm.model}</div>
                      <div className="mt-1 text-base font-black">{money(selectedPreview.effectiveRate)} / pcs</div>
                      {normalizeWorkerNameKey(entryForm.employeeName).includes("konveksi") && (
                        <div className="mt-1 text-[11px] font-semibold">Tarif Master {money(selectedPreview.baseRate)} / pcs · Tarif Konveksi {money(selectedPreview.effectiveRate)} / pcs</div>
                      )}
                    </div>
                  )}
                  {selectedPreview.status === "missing" && (
                    <div className="rounded-2xl border p-3 text-xs font-bold" style={{ background: "#fff1f2", borderColor: "#fecdd3", color: "#be123c" }}>
                      ⚠️ Tarif belum ada di Master Tarif. Silakan buat tarif baru di menu Master Tarif.
                    </div>
                  )}
                  {selectedPreview.status === "invalid" && (
                    <div className="rounded-2xl border p-3 text-xs font-bold" style={{ background: "#fff1f2", borderColor: "#fecdd3", color: "#be123c" }}>
                      ⚠️ Tarif Konveksi tidak valid. Silakan perbaiki tarif di Master Tarif.
                    </div>
                  )}
                  {selectedOrder && entryForm.model && limit > 0 && (
                    <div className="rounded-2xl px-3 py-2 text-xs font-semibold" style={{ background: "#f8fafc", color: "#475569", border: "1px solid #e2e8f0" }}>
                      Batas {label}: {limit} pcs · sudah input {alreadyQty} pcs · sisa {sisaQty} pcs.
                    </div>
                  )}
                </div>
              );
            })()}

            <Input label="Jumlah pcs" type="number" value={entryForm.qty} onChange={(v) => setEntryForm((f) => ({ ...f, qty: v }))} placeholder="Contoh: 500" />
            <Input label="Tanggal" type="date" value={entryForm.tanggal} onChange={(v) => setEntryForm((f) => ({ ...f, tanggal: v }))} />
            <Input label="Catatan" value={entryForm.catatan} onChange={(v) => setEntryForm((f) => ({ ...f, catatan: v }))} placeholder="Opsional" />
            <Button onClick={addProductionEntry} disabled={isSaving} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
              Simpan Hasil Borongan
            </Button>
          </div>
        </Modal>
      )}

      {/* Modal Setor Hasil Borongan Bertahap */}
      {setorModal && (() => {
        const modalTotals = setorTotals(setorModal);
        const sisa = Number(modalTotals.sisaSetor || 0);
        const inputSetor = Number(setorForm.qtySetor || 0);
        const inputReject = Number(setorForm.qtyReject || 0);
        const sisaSetelahInput = Math.max(0, sisa - inputSetor - inputReject);
        return (
        <Modal title="📦 Setor Hasil Borongan" onClose={closeSetorModal}>
          <div className="space-y-3">
            <div className="rounded-2xl p-3" style={{ background: "#fdf2f8", border: "1px solid #fce7f3" }}>
              <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>👤 {displayWorkerName(setorModal.employeeName)}</div>
              <div className="text-xs" style={{ color: "#a855f7" }}>{setorModal.productType} · {setorModal.process}{setorModal.model ? ` · ${setorModal.model}` : ""}</div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-xl py-2" style={{ background: "#ede9fe", color: "#5b21b6" }}><strong>{setorModal.qty}</strong><br/>diberi</div>
                <div className="rounded-xl py-2" style={{ background: "#dcfce7", color: "#16a34a" }}><strong>{modalTotals.qtySetor}</strong><br/>sudah setor</div>
                <div className="rounded-xl py-2" style={{ background: sisa > 0 ? "#fef3c7" : "#f1f5f9", color: sisa > 0 ? "#b45309" : "#64748b" }}><strong>{sisa}</strong><br/>sisa</div>
              </div>
            </div>
            {modalTotals.history.length > 0 && (
              <div className="rounded-2xl p-3 text-xs space-y-1" style={{ background: "#fff7ed", border: "1px solid #fed7aa", color: "#92400e" }}>
                <div className="font-bold">Riwayat setor sebelumnya</div>
                {modalTotals.history.map((h, idx) => (
                  <div key={h.id || idx}>• {h.tanggalSetor}: setor {Number(h.qtySetor || 0)} pcs{Number(h.qtyReject || 0) > 0 ? `, reject ${Number(h.qtyReject || 0)} pcs` : ""} · {money(h.totalWageSetor || 0)}</div>
                ))}
              </div>
            )}
            <Input
              label="Qty Disetor (pcs)"
              type="number"
              value={setorForm.qtySetor}
              onChange={(v) => setSetorForm((f) => ({ ...f, qtySetor: v }))}
              placeholder={`Maks ${sisa} pcs`}
            />
            <Input
              label="Qty Reject (pcs) — opsional"
              type="number"
              value={setorForm.qtyReject}
              onChange={(v) => setSetorForm((f) => ({ ...f, qtyReject: v }))}
              placeholder="0 jika tidak ada reject"
            />
            {inputSetor + inputReject > sisa && (
              <div className="rounded-xl px-3 py-2 text-xs font-bold" style={{ background: "#fee2e2", color: "#b91c1c" }}>
                ⚠️ Total input melebihi sisa {sisa} pcs.
              </div>
            )}
            {inputSetor + inputReject > 0 && inputSetor + inputReject <= sisa && sisaSetelahInput > 0 && (
              <div className="rounded-xl px-3 py-2 text-xs font-bold" style={{ background: "#fef3c7", color: "#b45309" }}>
                ⚠️ Setelah setor ini masih tersisa {sisaSetelahInput} pcs.
              </div>
            )}
            {inputSetor > 0 && Number(setorModal.rate) > 0 && (
              <div className="rounded-xl px-3 py-2 text-sm font-bold" style={{ background: "#f3e8ff", color: "#7c3aed" }}>
                💰 Gaji transaksi ini: {money(inputSetor * Number(setorModal.rate))}
                <span className="font-normal text-xs ml-1">({setorForm.qtySetor} pcs × {money(setorModal.rate)})</span>
              </div>
            )}
            <Input
              label="Tanggal Setor"
              type="date"
              value={setorForm.tanggalSetor}
              onChange={(v) => setSetorForm((f) => ({ ...f, tanggalSetor: v }))}
            />
            <Input
              label="Catatan"
              value={setorForm.catatan}
              onChange={(v) => setSetorForm((f) => ({ ...f, catatan: v }))}
              placeholder="Opsional"
            />
            <Button onClick={simpanSetor} disabled={isSaving || sisa <= 0 || inputSetor + inputReject > sisa} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
              {sisaSetelahInput > 0 ? "Simpan Setor Sebagian" : "Simpan Setor Selesai"}
            </Button>
          </div>
        </Modal>
        );
      })()}


      {modal === "tarif" && (
        <Modal title="🏷️ Tambah Tarif Borongan" onClose={closeMainModal}>
          <div className="space-y-3">
            <Select label="Jenis Produk" value={rateForm.productType} onChange={(v) => setRateForm((f) => ({ ...f, productType: v }))}>
              {PRODUCT_TYPES.map((p) => <option key={p}>{p}</option>)}
            </Select>
            <Select label="Proses" value={rateForm.process} onChange={(v) => setRateForm((f) => ({ ...f, process: v }))}>
              {ALL_PROCESSES.map((p) => <option key={p}>{p}</option>)}
            </Select>
            <div>
              <Input label="Model / Acuan Tarif" value={rateForm.model} onChange={(v) => setRateForm((f) => ({ ...f, model: v }))} placeholder="Contoh: Kerudung / Alya L / Gamis" />
              <div className="mt-1 text-[11px] font-semibold" style={{ color: "#64748b" }}>
                Isi sesuai Master Tarif. Untuk Potong/Pengemasan-QC boleh memakai acuan umum seperti Kerudung.
              </div>
              {modelNameOptions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {modelNameOptions.slice(0, 10).map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setRateForm((f) => ({ ...f, model: name }))}
                      className="rounded-full px-3 py-1 text-xs font-bold"
                      style={{ background: "#f5f3ff", color: "#7c3aed", border: "1px solid #ddd6fe" }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Input label="Tarif per pcs" type="number" value={rateForm.rate} onChange={(v) => setRateForm((f) => ({ ...f, rate: v }))} placeholder="Contoh: 2000" />
            <Button onClick={addWorkRate} disabled={isSaving} className="w-full" style={{ background: "linear-gradient(135deg,#a855f7,#ec4899)" }}>
              Simpan Tarif
            </Button>
          </div>
        </Modal>
      )}

      {modal === "kirim" && (
        <Modal title="🚚 Catat / Kirim Sisa" onClose={closeMainModal}>
          <div className="space-y-3">
            <Select
              label="Pilih Customer"
              value={kirimForm.customerKey || ""}
              onChange={(v) => {
                const customerOrders = ordersForShipment.filter((o) => normalizeKey(o.customer || "") === v);
                const orderIds = customerOrders.map((o) => o.id);
                const nextItems = customerOrders.flatMap((p) => {
                  const existingDeliveries = getDeliveryArray(p);
                  return orderBaseItems(p).map((it, idx) => {
                    const qtyPesan = Number(it.orderedQty || it.qty || 0);
                    const sudahKirim = existingDeliveries.reduce((sum, delivery) => {
                      const found = (delivery.items || []).find((di) =>
                        di.itemIndex !== undefined ? Number(di.itemIndex) === idx
                          : normalizeModelKey(di.name || "") === normalizeModelKey(it.name || "")
                      );
                      return sum + Number(found?.qty ?? found?.shippedQty ?? found?.qtyKirim ?? 0);
                    }, 0);
                    const sisa = Math.max(0, qtyPesan - sudahKirim);
                    return { orderId: p.id, invoice: p.invoice || "", customer: p.customer || "", nama: it.name || p.item || "", qtyPesan, qtyKirim: sisa, itemIndex: idx };
                  }).filter((it) => Number(it.qtyKirim || 0) > 0);
                });
                const first = customerOrders[0];
                setKirimForm((f) => ({
                  ...f,
                  customerKey: v,
                  pesananId: orderIds[0] || "",
                  orderIds,
                  penerima: first?.customer || "",
                  items: nextItems.length > 0 ? nextItems : [{ nama: "", qtyPesan: 0, qtyKirim: 0 }],
                  shortShipmentMode: "temporary",
                  shortShipmentReason: "Stok kain habis",
                  shortShipmentNote: "",
                }));
              }}
            >
              <option value="">-- Pilih Customer --</option>
              {shipmentCustomerOptions.map((c) => <option key={c.key} value={c.key}>{c.name} · {c.count} pesanan siap/sisa kirim</option>)}
            </Select>
            {kirimForm.customerKey && (
              <div className="rounded-2xl border p-3 text-xs space-y-2" style={{ background: "#f8fafc", borderColor: "#e2e8f0", color: "#475569" }}>
                <div className="font-black" style={{ color: "#0f172a" }}>Pesanan dalam nota ini</div>
                {ordersForShipment.filter((o) => normalizeKey(o.customer || "") === kirimForm.customerKey).map((o) => {
                  const checked = (kirimForm.orderIds || []).includes(o.id);
                  return (
                    <label key={o.id} className="flex items-center gap-2 rounded-xl bg-white p-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const isChecked = e?.target?.checked ?? Boolean(e);
                          const nextIds = isChecked
                            ? Array.from(new Set([...(kirimForm.orderIds || []), o.id]))
                            : (kirimForm.orderIds || []).filter((id) => id !== o.id);
                          const selectedOrders = ordersForShipment.filter((x) => nextIds.includes(x.id));
                          const nextItems = selectedOrders.flatMap((p) => {
                            const existingDeliveries = getDeliveryArray(p);
                            return orderBaseItems(p).map((it, idx) => {
                              const qtyPesan = Number(it.orderedQty || it.qty || 0);
                              const sudahKirim = existingDeliveries.reduce((sum, delivery) => {
                                const found = (delivery.items || []).find((di) =>
                                  di.itemIndex !== undefined ? Number(di.itemIndex) === idx
                                    : normalizeModelKey(di.name || "") === normalizeModelKey(it.name || "")
                                );
                                return sum + Number(found?.qty ?? found?.shippedQty ?? found?.qtyKirim ?? 0);
                              }, 0);
                              const sisa = Math.max(0, qtyPesan - sudahKirim);
                              return { orderId: p.id, invoice: p.invoice || "", customer: p.customer || "", nama: it.name || p.item || "", qtyPesan, qtyKirim: sisa, itemIndex: idx };
                            }).filter((it) => Number(it.qtyKirim || 0) > 0);
                          });
                          setKirimForm((f) => ({ ...f, orderIds: nextIds, pesananId: nextIds[0] || "", items: nextItems.length > 0 ? nextItems : [{ nama: "", qtyPesan: 0, qtyKirim: 0 }] }));
                        }}
                      />
                      <span className="flex-1"><b>{o.invoice || o.item}</b> · {o.item} · {o.qty} pcs</span>
                    </label>
                  );
                })}
              </div>
            )}
            <Input label="Tanggal Kirim" type="date" value={kirimForm.tanggalKirim} onChange={(v) => setKirimForm((f) => ({ ...f, tanggalKirim: v }))} />
            <Input label="Penerima" value={kirimForm.penerima} onChange={(v) => setKirimForm((f) => ({ ...f, penerima: v }))} />
            <Input label="Ekspedisi" value={kirimForm.ekspedisi} onChange={(v) => setKirimForm((f) => ({ ...f, ekspedisi: v }))} placeholder="JNE, J&T, Gojek" />
            {kirimForm.items.map((item, idx) => (
              <div key={idx} className="rounded-2xl p-3" style={{ background: "#fdf2f8" }}>
                {(item.invoice || item.customer) && <div className="mb-2 text-xs font-bold" style={{ color: "#7c3aed" }}>{item.invoice || "Pesanan"} · {item.customer || kirimForm.penerima}</div>}
                <Input
                  label="Item"
                  value={item.nama}
                  onChange={(v) => {
                    const items = [...kirimForm.items];
                    items[idx] = { ...items[idx], nama: v };
                    setKirimForm((f) => ({ ...f, items }));
                  }}
                />
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <Input label="Qty Pesan" value={item.qtyPesan} readOnly />
                  <Input
                    label="Qty Kirim"
                    type="number"
                    value={item.qtyKirim}
                    onChange={(v) => {
                      const items = [...kirimForm.items];
                      items[idx] = { ...items[idx], qtyKirim: v };
                      setKirimForm((f) => ({ ...f, items }));
                    }}
                  />
                </div>
              </div>
            ))}
            {(() => {
              const totalPesan = (kirimForm.items || []).reduce((s, it) => s + Number(it.qtyPesan || 0), 0);
              const totalKirim = (kirimForm.items || []).reduce((s, it) => s + Number(it.qtyKirim || 0), 0);
              const sisa = Math.max(0, totalPesan - totalKirim);
              const lebih = Math.max(0, totalKirim - totalPesan);
              if (!kirimForm.pesananId || totalKirim <= 0 || (sisa <= 0 && lebih <= 0)) return null;
              if (lebih > 0) {
                return (
                  <div className="rounded-2xl border p-3 text-xs" style={{ background: "#fff7ed", borderColor: "#fed7aa", color: "#9a3412" }}>
                    <div className="font-bold mb-1">⚠️ Kelebihan kirim {lebih.toLocaleString("id-ID")} pcs</div>
                    <div>Qty kirim lebih besar dari pesanan. Kelebihan ini akan ikut menambah tagihan customer di Gallery Kerudung karena invoice mengikuti qty terkirim.</div>
                  </div>
                );
              }
              return (
                <div className="rounded-2xl border p-3 text-xs space-y-3" style={{ background: "#fffbeb", borderColor: "#fde68a", color: "#92400e" }}>
                  <div>
                    <div className="font-bold mb-1">⚠️ Pengiriman kurang dari pesanan</div>
                    <div>Pesanan {totalPesan.toLocaleString("id-ID")} pcs · dikirim {totalKirim.toLocaleString("id-ID")} pcs · sisa {sisa.toLocaleString("id-ID")} pcs.</div>
                  </div>
                  <div className="grid gap-2">
                    <label className="flex items-start gap-2 rounded-xl bg-white/70 p-2">
                      <input type="radio" checked={(kirimForm.shortShipmentMode || "temporary") === "temporary"} onChange={() => setKirimForm((f) => ({ ...f, shortShipmentMode: "temporary" }))} />
                      <span><b>Kurang kirim sementara</b><br/>Pilih ini jika sisa barang masih akan diproduksi/dikirim lagi nanti. Status menjadi Dikirim Sebagian dan sisa tetap tampil di Dashboard.</span>
                    </label>
                    <label className="flex items-start gap-2 rounded-xl bg-white/70 p-2">
                      <input type="radio" checked={kirimForm.shortShipmentMode === "final"} onChange={() => setKirimForm((f) => ({ ...f, shortShipmentMode: "final" }))} />
                      <span><b>Kurang kirim final</b><br/>Pilih ini jika sisa tidak akan dikirim lagi. Order ditutup sebagai Kurang Kirim Final, sisa tidak jadi tanggungan aktif, dan tagihan tetap hanya dari qty terkirim.</span>
                    </label>
                  </div>
                  {kirimForm.shortShipmentMode === "final" && (
                    <div className="grid gap-2">
                      <Select label="Alasan kurang kirim final" value={kirimForm.shortShipmentReason || "Stok kain habis"} onChange={(v) => setKirimForm((f) => ({ ...f, shortShipmentReason: v }))}>
                        <option value="Stok kain habis">Stok kain habis</option>
                        <option value="Produksi hanya jadi segitu">Produksi hanya jadi segitu</option>
                        <option value="Customer setuju dikurangi">Customer setuju dikurangi</option>
                        <option value="Lainnya">Lainnya</option>
                      </Select>
                      <Input label="Catatan penutupan" value={kirimForm.shortShipmentNote || ""} onChange={(v) => setKirimForm((f) => ({ ...f, shortShipmentNote: v }))} placeholder="Opsional" />
                    </div>
                  )}
                </div>
              );
            })()}
            <Input label="Catatan" value={kirimForm.catatan} onChange={(v) => setKirimForm((f) => ({ ...f, catatan: v }))} placeholder="Opsional" />
            <Button onClick={addPengiriman} disabled={isSaving} className="w-full" style={{ background: "linear-gradient(135deg,#10b981,#34d399)" }}>
              Simpan Kiriman
            </Button>
          </div>
        </Modal>
      )}

      {/* Konfirmasi Hapus 2x */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
            {confirmDelete.step === 1 ? (
              <>
                <div className="text-center mb-4">
                  <div className="text-4xl mb-2">🗑️</div>
                  <div className="text-lg font-bold" style={{ color: "#1e293b" }}>Hapus Data?</div>
                  <div className="text-sm mt-1" style={{ color: "#64748b" }}>
                    {confirmDelete.entry
                      ? `Entry borongan ${displayWorkerName(confirmDelete.entry.employeeName)} — ${confirmDelete.entry.model || confirmDelete.entry.process} · ${confirmDelete.entry.qty} pcs`
                      : "Data ini akan dihapus."
                    }
                  </div>
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setConfirmDelete(null)}
                    className="flex-1 rounded-2xl border py-3 font-semibold"
                    style={{ borderColor: "#e2e8f0", color: "#64748b" }}>
                    Batal
                  </button>
                  <button onClick={confirmDeleteAction}
                    className="flex-1 rounded-2xl py-3 font-semibold text-white"
                    style={{ background: "#f97316" }}>
                    Ya, Lanjut
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="text-center mb-4">
                  <div className="text-4xl mb-2">⚠️</div>
                  <div className="text-lg font-bold" style={{ color: "#e11d48" }}>Yakin Hapus Permanen?</div>
                  <div className="text-sm mt-2 rounded-xl px-3 py-2" style={{ background: "#fff1f2", color: "#b91c1c" }}>
                    Data yang dihapus <strong>tidak bisa dikembalikan</strong>. Termasuk data payroll terkait.
                  </div>
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setConfirmDelete(null)}
                    className="flex-1 rounded-2xl border py-3 font-semibold"
                    style={{ borderColor: "#e2e8f0", color: "#64748b" }}>
                    Batal
                  </button>
                  <button onClick={confirmDeleteAction}
                    className="flex-1 rounded-2xl py-3 font-semibold text-white"
                    style={{ background: "#e11d48" }}>
                    🗑️ Hapus Sekarang
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Modal Edit Entry Borongan */}
      {editEntryModal && (
        <Modal title="✏️ Edit Entry Borongan" onClose={closeEditEntryModal}>
          <div className="space-y-3">
            {/* Info tidak bisa diubah */}
            <div className="rounded-2xl p-3" style={{ background: "#fdf2f8", border: "1px solid #fce7f3" }}>
              <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>👤 {displayWorkerName(editEntryModal.employeeName)}</div>
              <div className="text-xs mt-0.5" style={{ color: "#a855f7" }}>
                {editEntryModal.productType} · {editEntryModal.process}
                {editEntryModal.customer ? ` · ${editEntryModal.customer}` : ""}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>
                ⚠️ Nama pekerja & proses tidak bisa diubah di sini
              </div>
            </div>

            {/* Model — hanya untuk non-QC */}
            {!isGeneralRateProcess(editEntryModal.process) && (
              <Input
                label="Model"
                value={editEntryForm.model}
                onChange={(v) => setEditEntryForm(f => ({ ...f, model: v }))}
                placeholder="Contoh: Alya L"
              />
            )}

            <Input
              label="Jumlah pcs diberikan"
              type="number"
              value={editEntryForm.qty}
              onChange={(v) => setEditEntryForm(f => ({ ...f, qty: v }))}
              placeholder="Contoh: 62"
            />
            <Input
              label="Tanggal"
              type="date"
              value={editEntryForm.tanggal}
              onChange={(v) => setEditEntryForm(f => ({ ...f, tanggal: v }))}
            />
            <Input
              label="Catatan"
              value={editEntryForm.catatan}
              onChange={(v) => setEditEntryForm(f => ({ ...f, catatan: v }))}
              placeholder="Opsional"
            />

            {setorTotals(editEntryModal).statusSetor !== "belum_setor" && (
              <div className="rounded-xl px-3 py-2 text-xs font-semibold" style={{ background: "#fef3c7", color: "#b45309" }}>
                ⚠️ Entry ini sudah pernah disetor. Perubahan qty tidak otomatis mengubah riwayat setor & payroll.
              </div>
            )}

            <Button onClick={saveEditEntry} disabled={isSaving} className="w-full"
              style={{ background: "linear-gradient(135deg,#2563eb,#7c3aed)" }}>
              💾 Simpan Perubahan
            </Button>
          </div>
        </Modal>
      )}

      {/* Modal Preview Slip Gaji */}
      {slipPreview && (() => {
        const { nama, r, dari, sampai, carryOver = [] } = slipPreview;
        const fmt = (v) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(v || 0));
        const slipSudahGajian = sudahGajian(nama, dari, sampai);
        return (
          <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.4)" }}>
            <div className="w-full max-h-[92vh] overflow-auto bg-white" style={{ borderRadius: "32px 32px 0 0", borderTop: "3px solid #a855f7" }}>
              {/* Header */}
              <div className="px-5 pt-5 pb-3" style={{ background: "linear-gradient(135deg,#a855f7,#ec4899)" }}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-3">
                    <img src="/logo-gk.png" alt="Gallery Kerudung" className="h-12 w-12 rounded-2xl bg-white object-cover" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                    <div className="text-white font-extrabold text-lg">🧾 Slip Pendapatan Borongan</div>
                  </div>
                  <button onClick={() => setSlipPreview(null)}
                    className="rounded-full px-4 py-1.5 text-sm font-bold"
                    style={{ background: "rgba(255,255,255,0.25)", color: "white" }}>
                    ✕ Tutup
                  </button>
                </div>
                <div className="text-white text-sm opacity-90">Gallery Kerudung</div>
              </div>

              <div ref={slipRef} className="p-5 space-y-4">
                {/* Info pekerja & periode */}
                <div className="rounded-2xl p-4 space-y-2" style={{ background: "#fdf4ff", border: "1px solid #e9d5ff" }}>
                  <div className="flex justify-between text-sm">
                    <span style={{ color: "#94a3b8" }}>Nama Pekerja</span>
                    <strong style={{ color: "#2d1b69" }}>👤 {nama}</strong>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span style={{ color: "#94a3b8" }}>Periode</span>
                    <strong style={{ color: "#2d1b69" }}>📅 {dari} s/d {sampai}</strong>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span style={{ color: "#94a3b8" }}>Tanggal Cetak</span>
                    <strong style={{ color: "#2d1b69" }}>{new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" })}</strong>
                  </div>
                </div>

                {/* Ringkasan */}
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl p-2" style={{ background: "#ede9fe" }}>
                    <div className="font-bold text-base" style={{ color: "#5b21b6" }}>{r.pcsAwal}</div>
                    <div className="text-xs" style={{ color: "#94a3b8" }}>Diberikan</div>
                  </div>
                  <div className="rounded-xl p-2" style={{ background: "#dcfce7" }}>
                    <div className="font-bold text-base" style={{ color: "#16a34a" }}>{r.pcsSetor}</div>
                    <div className="text-xs" style={{ color: "#94a3b8" }}>Disetor</div>
                  </div>
                  <div className="rounded-xl p-2" style={{ background: r.pcsReject > 0 ? "#fee2e2" : "#f1f5f9" }}>
                    <div className="font-bold text-base" style={{ color: r.pcsReject > 0 ? "#ef4444" : "#94a3b8" }}>{r.pcsReject}</div>
                    <div className="text-xs" style={{ color: "#94a3b8" }}>Reject</div>
                  </div>
                </div>

                {/* Detail per entry */}
                <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid #e9d5ff" }}>
                  <div className="px-3 py-2 text-xs font-bold" style={{ background: "linear-gradient(135deg,#ede9fe,#fce7f3)", color: "#7c3aed" }}>
                    Detail Pekerjaan
                  </div>
                  <div className="divide-y" style={{ borderColor: "#f3e8ff" }}>
                    {[...r.detail].sort((a,b) => (a.tanggalSetor||a.tanggal||"").localeCompare(b.tanggalSetor||b.tanggal||"")).map((d, i) => (
                      <div key={i} className="px-3 py-2.5 flex justify-between items-start"
                        style={{ background: d.sudahSetor ? "#f0fdf4" : "#fefce8" }}>
                        <div className="flex-1 mr-2">
                          <div className="text-xs font-bold" style={{ color: "#2d1b69" }}>
                            {d.process}{d.model && d.model !== "-" ? " · " + d.model : ""}
                          </div>
                          <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>
                            {d.customer}{d.invoice ? " / " + d.invoice : ""}
                          </div>
                          <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>
                            📅 {d.tanggalSetor || d.tanggal || "-"}
                          </div>
                          {d.rate > 0 && (
                            <div className="text-xs mt-0.5" style={{ color: "#a855f7" }}>
                              {fmt(d.rate)}/pcs × {d.sudahSetor ? d.qtySetor : d.qty} pcs
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          {d.sudahSetor ? (
                            <>
                              <div className="text-xs font-bold" style={{ color: "#16a34a" }}>{d.qtySetor} pcs</div>
                              {d.qtyReject > 0 && <div className="text-xs" style={{ color: "#ef4444" }}>❌ {d.qtyReject} reject</div>}
                              <div className="text-sm font-bold mt-0.5" style={{ color: "#7c3aed" }}>{fmt(d.gaji)}</div>
                            </>
                          ) : (
                            <>
                              <div className="text-xs font-bold" style={{ color: "#b45309" }}>{d.qty} pcs</div>
                              <div className="text-xs mt-0.5" style={{ color: "#b45309" }}>⏳ Blm setor</div>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Belum setor warning */}
                {r.belumSetor > 0 && (
                  <div className="rounded-xl px-4 py-3 text-xs font-semibold" style={{ background: "#fefce8", border: "1px solid #fde68a", color: "#b45309" }}>
                    ⚠️ Masih ada <strong>{r.belumSetor} pcs</strong> belum disetor, belum termasuk total di bawah.
                  </div>
                )}

                {/* Total pendapatan */}
                <div className="rounded-2xl p-4" style={{ background: "linear-gradient(135deg,#f0fdf4,#dcfce7)", border: "1.5px solid #bbf7d0" }}>
                  <div className="text-xs mb-1" style={{ color: "#64748b" }}>Total Pendapatan Bersih</div>
                  <div className="text-3xl font-black" style={{ color: "#16a34a" }}>{fmt(r.gaji)}</div>
                </div>

                {/* Info kasbon aktif — tampil sebelum tombol gajian */}
                {(() => {
                  const kasbonAktif = kasbonAktifUntukPekerja(nama);
                  if (kasbonAktif.length === 0) return null;
                  const totalKasbon = kasbonAktif.reduce((s, k) => s + nonNegativeMoney(k.sisaKasbon || 0), 0);
                  const potongan = Math.min(totalKasbon, Number(r.gaji || 0));
                  const diterima = Number(r.gaji || 0) - potongan;
                  return (
                    <div className="rounded-2xl p-4 space-y-2" style={{ background: "#fefce8", border: "1.5px solid #fde68a" }}>
                      <div className="text-xs font-black" style={{ color: "#92400e" }}>💰 Kasbon Aktif — akan dipotong saat gajian</div>
                      {kasbonAktif.map((k) => (
                        <div key={k.id} className="flex justify-between text-xs" style={{ color: "#78716c" }}>
                          <span>📅 {k.tanggal}{k.keterangan ? ` · ${k.keterangan}` : ""}</span>
                          <span className="font-bold text-amber-700">{money(k.sisaKasbon)} sisa</span>
                        </div>
                      ))}
                      <div className="border-t border-amber-200 pt-2 space-y-1">
                        <div className="flex justify-between text-xs font-bold">
                          <span style={{ color: "#92400e" }}>Total potongan kasbon</span>
                          <span style={{ color: "#dc2626" }}>- {money(potongan)}</span>
                        </div>
                        <div className="flex justify-between text-sm font-black">
                          <span style={{ color: "#16a34a" }}>Gaji diterima</span>
                          <span style={{ color: "#16a34a" }}>{money(diterima)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Status gajian - hanya tampil di modal slip agar rekap tetap rapi */}
                <div className="rounded-2xl p-4 space-y-3" style={{ background: slipSudahGajian ? "#f0fdf4" : "#fff7ed", border: `1.5px solid ${slipSudahGajian ? "#bbf7d0" : "#fed7aa"}` }}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-bold" style={{ color: slipSudahGajian ? "#16a34a" : "#b45309" }}>
                        {slipSudahGajian ? "✅ Sudah gajian" : "⏳ Belum gajian"}
                      </div>
                      <div className="mt-1 text-xs" style={{ color: "#64748b" }}>
                        Status ini hanya untuk periode {dari} s/d {sampai}.
                      </div>
                    </div>
                    {slipSudahGajian ? (
                      <button
                        type="button"
                        onClick={() => batalkanSudahGajian(nama, dari, sampai)}
                        className="rounded-xl px-3 py-2 text-xs font-bold"
                        style={{ background: "#fee2e2", color: "#e11d48", border: "1px solid #fecaca" }}
                      >
                        Batalkan
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => tandaiSudahGajianDanSimpanHistory(nama, r, dari, sampai)}
                        className="rounded-xl px-3 py-2 text-xs font-bold text-white"
                        style={{ background: "linear-gradient(135deg,#16a34a,#22c55e)" }}
                      >
                        Tandai Sudah Gajian
                      </button>
                    )}
                  </div>
                </div>

                {/* Tanggungan minggu lalu (carry over) */}
                {carryOver.length > 0 && (
                  <div className="rounded-2xl p-4 space-y-2" style={{ background: "#fff7ed", border: "1.5px solid #fed7aa" }}>
                    <div className="text-xs font-bold" style={{ color: "#b45309" }}>
                      ⚠️ Tanggungan Minggu Lalu (Belum Disetor)
                    </div>
                    <div className="text-xs" style={{ color: "#92400e" }}>
                      Pekerjaan berikut belum disetor dan <strong>akan masuk gaji minggu depan</strong> setelah disetor:
                    </div>
                    {carryOver.map((e, i) => {
                      const entryOrder = orderLookupForCards.byId.get(String(e.orderId || "").trim());
                      const namaModel = e.model && e.model !== "-" ? e.model : "-";
                      const periodeAsli = e.tanggal ? getMingguPeriod(e.tanggal) : null;
                      return (
                        <div key={i} className="rounded-xl px-3 py-2 text-xs" style={{ background: "#fef3c7", border: "1px solid #fde68a" }}>
                          <div className="font-semibold" style={{ color: "#2d1b69" }}>
                            🧵 {e.process}{namaModel !== "-" ? ` · ${namaModel}` : ""}
                          </div>
                          {(e.customer || entryOrder?.customer) && (
                            <div style={{ color: "#94a3b8" }}>{e.customer || entryOrder?.customer}{e.invoice ? ` · ${e.invoice}` : ""}</div>
                          )}
                          <div className="flex justify-between mt-1">
                            <span style={{ color: "#b45309" }}>
                              📅 {periodeAsli ? `${periodeAsli.dari} s/d ${periodeAsli.sampai}` : e.tanggal}
                            </span>
                            <span className="font-bold" style={{ color: "#b45309" }}>{Number(setorTotals(e).sisaSetor || 0)} pcs · belum disetor</span>
                          </div>
                        </div>
                      );
                    })}
                    <div className="text-xs font-semibold text-center" style={{ color: "#b45309" }}>
                      Total tanggungan: {carryOver.reduce((s, e) => s + Number(setorTotals(e).sisaSetor || 0), 0)} pcs
                    </div>
                  </div>
                )}

                {/* Tombol Download Slip */}
                <button
                  onClick={() => downloadSlipGaji(nama, r, dari, sampai, carryOver)}
                  className="w-full rounded-2xl py-3.5 font-bold text-white flex items-center justify-center gap-2 text-sm"
                  style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}
                >
                  🖨️ Download / Cetak Slip PDF
                </button>

                {/* Tombol Share WA sebagai Gambar (Canvas Native) */}
                <button
                  onClick={() => shareSlipGajiAsImage(nama, r, dari, sampai, carryOver)}
                  className="w-full rounded-2xl py-3.5 font-bold text-white flex items-center justify-center gap-2 text-sm"
                  style={{ background: "linear-gradient(135deg,#25d366,#128c7e)" }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.116 1.523 5.847L.057 23.882l6.19-1.438A11.945 11.945 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.885 0-3.653-.51-5.173-1.4l-.371-.22-3.674.853.884-3.561-.242-.381A9.956 9.956 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
                  Share Gambar ke WA
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal Tugas Hari Ini */}
      {tugasDetailModal && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.35)" }}>
          <motion.div
            initial={{ y: 80 }}
            animate={{ y: 0 }}
            className="max-h-[92vh] w-full overflow-auto p-5"
            style={{ background: "white", borderRadius: "32px 32px 0 0", borderTop: "3px solid #fb923c" }}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-black" style={{ color: "#c2410c" }}>✅ Tugas Hari Ini</h2>
                <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>Ketuk item untuk langsung ke datanya</div>
              </div>
              <button
                onClick={() => setTugasDetailModal(false)}
                className="rounded-2xl px-4 py-2 text-base font-semibold"
                style={{ background: "#fdf2f8", color: "#ec4899" }}
              >
                Tutup
              </button>
            </div>

            {/* Bagian Borongan Belum Setor */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-black" style={{ color: "#c2410c" }}>
                  💪 Borongan Belum Setor
                  <span className="ml-2 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "#ffedd5", color: "#c2410c" }}>
                    {dashboardInsights.tugas.boronganBelumSetor}
                  </span>
                </div>
                <button
                  onClick={() => { setTugasDetailModal(false); setBoronganOnlyBelumSetor(true); setTab("borongan"); }}
                  className="text-xs font-bold px-3 py-1.5 rounded-full text-white"
                  style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}
                >
                  Lihat Semua ›
                </button>
              </div>
              {dashboardInsights.tugas.activeBorongan.length === 0 ? (
                <div className="rounded-2xl p-3 text-xs font-bold" style={{ background: "#f0fdf4", color: "#16a34a" }}>✅ Semua sudah setor</div>
              ) : (
                <div className="space-y-2">
                  {dashboardInsights.tugas.activeBorongan.map(({ entry, totals }) => (
                    <button
                      key={`tugas-bor-${entry.id}`}
                      onClick={() => { setTugasDetailModal(false); setBoronganOnlyBelumSetor(true); setTab("borongan"); }}
                      className="w-full rounded-2xl p-3 text-left"
                      style={{ background: "#fefce8", border: "1.5px solid #fde68a" }}
                    >
                      <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>👤 {displayWorkerName(entry.employeeName)}</div>
                      <div className="text-xs mt-0.5" style={{ color: "#a855f7" }}>{entry.process || "-"}{entry.model && entry.model !== "-" ? ` · ${displayModelName(entry.model)}` : ""}</div>
                      {entry.customer && <div className="text-xs" style={{ color: "#94a3b8" }}>{entry.customer}{entry.invoice ? ` · ${entry.invoice}` : ""}</div>}
                      <div className="mt-1 text-sm font-black" style={{ color: "#c2410c" }}>⏳ Sisa {fmtQty(totals.sisaSetor)} pcs belum setor</div>
                    </button>
                  ))}
                  {dashboardInsights.tugas.boronganBelumSetor > dashboardInsights.tugas.activeBorongan.length && (
                    <button
                      onClick={() => { setTugasDetailModal(false); setBoronganOnlyBelumSetor(true); setTab("borongan"); }}
                      className="w-full rounded-2xl py-2 text-xs font-bold"
                      style={{ background: "#ffedd5", color: "#c2410c" }}
                    >
                      + {dashboardInsights.tugas.boronganBelumSetor - dashboardInsights.tugas.activeBorongan.length} lainnya → Lihat semua borongan belum setor
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Bagian Produksi Belum Selesai */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-black" style={{ color: "#c2410c" }}>
                  🧵 Produksi Belum Selesai
                  <span className="ml-2 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "#ffedd5", color: "#c2410c" }}>
                    {dashboardInsights.tugas.produksiBelumSelesai}
                  </span>
                </div>
                <button
                  onClick={() => { setTugasDetailModal(false); setProduksiOnlyBelumSelesai(true); setTab("produksi"); }}
                  className="text-xs font-bold px-3 py-1.5 rounded-full text-white"
                  style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}
                >
                  Lihat Semua ›
                </button>
              </div>
              {dashboardInsights.tugas.activeProduksi.length === 0 ? (
                <div className="rounded-2xl p-3 text-xs font-bold" style={{ background: "#f0fdf4", color: "#16a34a" }}>✅ Semua produksi selesai</div>
              ) : (
                <div className="space-y-2">
                  {dashboardInsights.tugas.activeProduksi.map((item) => (
                    <button
                      key={`tugas-prod-${item.id}`}
                      onClick={() => { setTugasDetailModal(false); setProduksiOnlyBelumSelesai(true); setTab("produksi"); }}
                      className="w-full rounded-2xl p-3 text-left"
                      style={{ background: "#ede9fe", border: "1.5px solid #c4b5fd" }}
                    >
                      <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>👤 {item.customer || item.orderCustomer || "-"}</div>
                      {item.invoice && <div className="text-xs" style={{ color: "#94a3b8" }}>🧾 {item.invoice}</div>}
                      <div className="mt-1 text-sm font-black" style={{ color: "#7c3aed" }}>
                        Status: {item.status || "Antri"}
                      </div>
                    </button>
                  ))}
                  {dashboardInsights.tugas.produksiBelumSelesai > dashboardInsights.tugas.activeProduksi.length && (
                    <button
                      onClick={() => { setTugasDetailModal(false); setProduksiOnlyBelumSelesai(true); setTab("produksi"); }}
                      className="w-full rounded-2xl py-2 text-xs font-bold"
                      style={{ background: "#ede9fe", color: "#7c3aed" }}
                    >
                      + {dashboardInsights.tugas.produksiBelumSelesai - dashboardInsights.tugas.activeProduksi.length} lainnya → Lihat semua produksi
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Bagian Kirim Belum Lengkap */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-black" style={{ color: "#c2410c" }}>
                  🚚 Kirim Belum Lengkap
                  <span className="ml-2 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "#ffedd5", color: "#c2410c" }}>
                    {dashboardInsights.tugas.kirimanBelumLengkap}
                  </span>
                </div>
                <button
                  onClick={() => { setTugasDetailModal(false); setKirimOnlyBelumLengkap(true); setTab("kirim"); }}
                  className="text-xs font-bold px-3 py-1.5 rounded-full text-white"
                  style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}
                >
                  Lihat Semua ›
                </button>
              </div>
              {dashboardInsights.tugas.kirimBelumLengkap.length === 0 ? (
                <div className="rounded-2xl p-3 text-xs font-bold" style={{ background: "#f0fdf4", color: "#16a34a" }}>✅ Semua pengiriman lengkap</div>
              ) : (
                <div className="space-y-2">
                  {dashboardInsights.tugas.kirimBelumLengkap.map(({ order, sisa }) => (
                    <button
                      key={`tugas-kirim-${order.id}`}
                      onClick={() => { setTugasDetailModal(false); setKirimOnlyBelumLengkap(true); setTab("kirim"); }}
                      className="w-full rounded-2xl p-3 text-left"
                      style={{ background: "#dbeafe", border: "1.5px solid #93c5fd" }}
                    >
                      <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>👤 {order.customer || "-"}</div>
                      {order.invoice && <div className="text-xs" style={{ color: "#94a3b8" }}>🧾 {order.invoice}</div>}
                      <div className="mt-1 text-sm font-black" style={{ color: "#1d4ed8" }}>⏳ Sisa kirim {fmtQty(sisa)} pcs</div>
                    </button>
                  ))}
                  {dashboardInsights.tugas.kirimanBelumLengkap > dashboardInsights.tugas.kirimBelumLengkap.length && (
                    <button
                      onClick={() => { setTugasDetailModal(false); setKirimOnlyBelumLengkap(true); setTab("kirim"); }}
                      className="w-full rounded-2xl py-2 text-xs font-bold"
                      style={{ background: "#dbeafe", color: "#1d4ed8" }}
                    >
                      + {dashboardInsights.tugas.kirimanBelumLengkap - dashboardInsights.tugas.kirimBelumLengkap.length} lainnya → Lihat semua pengiriman
                    </button>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}

      {/* Modal Alert Data Bermasalah */}
      {alertDetailModal && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.35)" }}>
          <motion.div
            initial={{ y: 80 }}
            animate={{ y: 0 }}
            className="max-h-[88vh] w-full overflow-auto p-5"
            style={{ background: "white", borderRadius: "32px 32px 0 0", borderTop: "3px solid #fb7185" }}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-black" style={{ color: "#be123c" }}>🚨 Data Bermasalah</h2>
                <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>{dashboardInsights.alertCount} temuan perlu dicek</div>
              </div>
              <button
                onClick={() => setAlertDetailModal(false)}
                className="rounded-2xl px-4 py-2 text-base font-semibold"
                style={{ background: "#fdf2f8", color: "#ec4899" }}
              >
                Tutup
              </button>
            </div>
            {dashboardInsights.alerts.length === 0 ? (
              <div className="rounded-2xl p-6 text-center text-sm font-bold" style={{ background: "#f0fdf4", color: "#16a34a" }}>
                ✅ Tidak ada data bermasalah saat ini.
              </div>
            ) : (
              <div className="space-y-3">
                {dashboardInsights.alerts.map((alert, idx) => (
                  <div key={`alert-modal-${alert.type}-${idx}`} className="rounded-2xl p-4" style={{ background: "#fff7f7", border: "1.5px solid #fecaca" }}>
                    <div className="font-black text-sm mb-1" style={{ color: "#be123c" }}>{alert.type}</div>
                    <div className="text-xs" style={{ color: "#64748b" }}>{alert.text}</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setAlertDetailModal(false);
                          setSearch(alert.search || "");
                          if (alert.type === "Setor melebihi diberi") {
                            setBoronganOnlyOverSetor(true);
                            setBoronganOnlyBelumSetor(false);
                          } else {
                            setBoronganOnlyOverSetor(false);
                          }
                          if (alert.tab === "pesanan") setPesananOnlyNeedCheck(true);
                          setTab(alert.tab);
                        }}
                        className="rounded-xl px-4 py-2 text-xs font-bold text-white"
                        style={{ background: "linear-gradient(135deg,#e11d48,#f97316)" }}
                      >
                        Buka Tab {alert.tab === "borongan" ? "Borongan" : alert.tab === "tarif" ? "Master" : alert.tab === "pesanan" ? "Pesanan" : alert.tab === "kirim" ? "Kirim" : alert.tab} ›
                      </button>
                      {alert.type === "Produksi duplikat" && (
                        <button
                          type="button"
                          onClick={() => cleanDuplicateProduksi(alert.duplicateKey || alert.search)}
                          className="rounded-xl px-4 py-2 text-xs font-bold"
                          style={{ background: "#f0fdf4", color: "#15803d", border: "1px solid #86efac" }}
                        >
                          Bersihkan Duplikat Aman
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {dashboardInsights.alertCount > dashboardInsights.alerts.length && (
                  <div className="rounded-2xl px-4 py-3 text-xs font-semibold text-center" style={{ background: "#fff1f2", color: "#be123c", border: "1px solid #fecaca" }}>
                    + {dashboardInsights.alertCount - dashboardInsights.alerts.length} temuan lain tersembunyi. Periksa tiap tab untuk melihat semua.
                  </div>
                )}
              </div>
            )}
          </motion.div>
        </div>
      )}


      {kaitkanModal && (
        <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.35)" }}>
          <motion.div
            initial={{ y: 80 }}
            animate={{ y: 0 }}
            className="w-full p-5 max-h-[88vh] overflow-y-auto"
            style={{ background: "white", borderRadius: "32px 32px 0 0", borderTop: "3px solid #f59e0b" }}
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-black" style={{ color: "#92400e" }}>🔗 Kaitkan ke Pesanan</h2>
                <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>
                  👤 {displayWorkerName(kaitkanModal.employeeName)} · {kaitkanModal.process}{kaitkanModal.model ? ` · ${kaitkanModal.model}` : ""} · {kaitkanModal.qty} pcs
                </div>
              </div>
              <button
                onClick={() => { setKaitkanModal(null); setKaitkanOrderId(""); }}
                className="rounded-2xl px-4 py-2 text-sm font-semibold"
                style={{ background: "#fefce8", color: "#92400e" }}
              >
                Tutup
              </button>
            </div>

            <div className="rounded-2xl p-3 mb-4" style={{ background: "#fefce8", border: "1px solid #fbbf24" }}>
              <div className="text-xs font-bold mb-1" style={{ color: "#92400e" }}>⚠️ Entry ini belum terkait pesanan</div>
              <div className="text-xs" style={{ color: "#78350f" }}>Tanggal input: {kaitkanModal.tanggal || "-"} · Qty: {kaitkanModal.qty || 0} pcs</div>
              {kaitkanModal.invoice && <div className="text-xs" style={{ color: "#78350f" }}>Invoice tercatat: {kaitkanModal.invoice}</div>}
            </div>

            <div className="mb-4">
              <div className="text-sm font-bold mb-2" style={{ color: "#92400e" }}>Pilih Pesanan Tujuan</div>
              <select
                value={kaitkanOrderId}
                onChange={(ev) => setKaitkanOrderId(ev.target.value)}
                className="w-full px-4 py-3 rounded-2xl text-sm outline-none"
                style={{ border: "1.5px solid #fbbf24", background: "#fffbeb", color: "#1e1b4b" }}
              >
                <option value="">-- Pilih pesanan --</option>
                {ordersForBoronganLinkAll.map((o) => {
                  const prod = produksiByOrderId.get(o.id);
                  const statusProd = prod?.status || "Belum produksi";
                  const label = [
                    o.customer || "-",
                    o.invoice ? `· ${o.invoice}` : "",
                    o.item ? `· ${o.item}` : "",
                    `· ${o.qty} pcs`,
                    `· ${statusProd}`,
                  ].filter(Boolean).join(" ");
                  return <option key={o.id} value={o.id}>{label}</option>;
                })}
              </select>
            </div>

            {kaitkanOrderId && (() => {
              const selectedOrder = orders.find((o) => o.id === kaitkanOrderId);
              const prod = produksiByOrderId.get(kaitkanOrderId);
              if (!selectedOrder) return null;
              return (
                <div className="rounded-2xl p-3 mb-4" style={{ background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
                  <div className="text-xs font-black mb-1" style={{ color: "#15803d" }}>✅ Pesanan dipilih:</div>
                  <div className="text-sm font-bold" style={{ color: "#14532d" }}>{selectedOrder.customer} {selectedOrder.invoice ? `· ${selectedOrder.invoice}` : ""}</div>
                  <div className="text-xs mt-0.5" style={{ color: "#64748b" }}>{selectedOrder.item} · {selectedOrder.qty} pcs · Status: {selectedOrder.status || "-"}</div>
                  {prod && <div className="text-xs mt-0.5" style={{ color: "#7c3aed" }}>Produksi: {prod.status || "Ada"}</div>}
                </div>
              );
            })()}

            <button
              type="button"
              disabled={isSaving || !kaitkanOrderId}
              onClick={kaitkanEntryKePesanan}
              className="w-full rounded-2xl py-3.5 text-sm font-black text-white"
              style={{
                background: kaitkanOrderId ? "linear-gradient(135deg,#f59e0b,#d97706)" : "#d1d5db",
                opacity: isSaving ? 0.6 : 1,
              }}
            >
              {isSaving ? "Menyimpan..." : "🔗 Kaitkan ke Pesanan Ini"}
            </button>

            <div className="mt-3 text-center text-xs" style={{ color: "#94a3b8" }}>
              Data lama tetap bisa setor/gaji · Progress produksi baru terhitung setelah dikaitkan
            </div>
          </motion.div>
        </div>
      )}

      {isSaving && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="rounded-2xl bg-white px-8 py-5 shadow-xl flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "#ec4899", borderTopColor: "transparent" }} />
            <span className="font-semibold" style={{ color: "#2d1b69" }}>Menyimpan...</span>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoBox({ title, subtitle, icon }) {
  return (
    <div className="rounded-2xl px-4 py-3 flex items-center gap-3" style={{ background: "linear-gradient(135deg,#ede9fe,#fce7f3)", border: "1px solid #e9d5ff" }}>
      <span className="text-2xl">{icon}</span>
      <div>
        <div className="text-xs font-bold" style={{ color: "#7c3aed" }}>{title}</div>
        <div className="text-xs" style={{ color: "#a855f7" }}>{subtitle}</div>
      </div>
      <span className="ml-auto text-green-500 text-lg">●</span>
    </div>
  );
}

function Empty({ text }) {
  return <div className="text-center py-10" style={{ color: "#c084fc" }}>{text}</div>;
}

function MiniStat({ label, value, bg, color }) {
  return (
    <div className="rounded-xl p-2" style={{ background: bg }}>
      <div className="text-xs" style={{ color }}>{label}</div>
      <div className="font-bold text-sm" style={{ color }}>{value}</div>
    </div>
  );
}
