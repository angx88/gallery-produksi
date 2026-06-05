// App.jsx Gallery Produksi - audit fix komprehensif - 2026-06-03
// Perbaikan: pengiriman atomic, gajian-kasbon atomic, produksi/borongan/setor anti data yatim,
// legacy sync lebih aman, dropdown pengiriman baca deliveries dengan benar, UI lebih terbaca.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { db, auth } from "./firebase";
import {
  collection,
  addDoc,
  getDocs,
  onSnapshot,
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
  PRODUKSI: "produksi",
  WORK_RATES: "work_rates",
  PRODUCTION_ENTRIES: "production_entries",
  PAYROLL_EXPENSES: "payroll_expenses",
  GAJIAN_HISTORY: "gajian_history",
  KASBON: "kasbon_pegawai",
};

const PROD_STATUS = ["Antri", "Potong", "Jahit", "Pengemasan QC", "Selesai"];
const GENERAL_RATE_PROCESSES = ["Potong", "Pengemasan QC"];
const MODEL_SPECIFIC_PROCESSES = ["Jahit"];
const PROCESSES_WITH_MODEL = [...GENERAL_RATE_PROCESSES, ...MODEL_SPECIFIC_PROCESSES];
const PROCESSES_NO_MODEL = [];
const ALL_PROCESSES = [...PROCESSES_WITH_MODEL, ...PROCESSES_NO_MODEL];
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
  if (s.includes("selesai produksi")) return false;
  if (s.includes("dikirim") || s.includes("terkirim") || s.includes("kirim selesai")) return true;
  if (s.includes("done") || s.includes("complete")) return true;
  if (s === "selesai") return true;
  return false;
}

function sameText(a, b) {
  return String(a || "").trim() !== "" && String(b || "").trim() !== "" && String(a).trim() === String(b).trim();
}

function fmtQty(value) {
  const n = Number(value || 0);
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
  return Number(
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
    qty: Number(it?.qty ?? it?.quantity ?? order?.qty ?? 0),
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

function dateAfter(value, compareTo) {
  const t = dateKey(value);
  const c = dateKey(compareTo);
  return Boolean(t && c && t > c);
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
  }).format(Number(v || 0));
}


function normalizeSetorHistory(entry) {
  const raw = Array.isArray(entry?.setorHistory) ? entry.setorHistory : [];
  const normalized = raw
    .map((h, idx) => {
      const qtySetor = Number(h?.qtySetor || 0);
      const qtyReject = Number(h?.qtyReject || 0);
      const rate = Number(h?.rate ?? entry?.rate ?? 0);
      return {
        id: h?.id || `${entry?.id || "entry"}-${idx}`,
        tanggalSetor: h?.tanggalSetor || h?.tanggal || entry?.tanggalSetor || entry?.tanggal || todayStr(),
        qtySetor,
        qtyReject,
        rate,
        totalWageSetor: Math.max(0, Number(h?.totalWageSetor ?? (qtySetor * rate) ?? 0)),
        catatan: h?.catatan || h?.catatanSetor || "",
        createdAt: h?.createdAt || "",
      };
    })
    .filter((h) => Number(h.qtySetor || 0) > 0 || Number(h.qtyReject || 0) > 0);

  // Dukungan data lama: entry lama hanya punya qtySetor/qtyReject tanpa setorHistory.
  if (normalized.length === 0 && (Number(entry?.qtySetor || 0) > 0 || Number(entry?.qtyReject || 0) > 0 || entry?.statusSetor === "sudah_setor")) {
    const qtySetor = Number(entry?.qtySetor || 0);
    const qtyReject = Number(entry?.qtyReject || 0);
    const rate = Number(entry?.rate || 0);
    normalized.push({
      id: `${entry?.id || "legacy"}-legacy-setor`,
      tanggalSetor: entry?.tanggalSetor || entry?.tanggal || todayStr(),
      qtySetor,
      qtyReject,
      rate,
      totalWageSetor: Math.max(0, Number(entry?.totalWageSetor ?? (qtySetor * rate) ?? 0)),
      catatan: entry?.catatanSetor || "",
      createdAt: entry?.updatedAt || entry?.createdAt || "",
    });
  }

  return normalized;
}

function setorTotals(entry) {
  const history = normalizeSetorHistory(entry);
  const qtySetor = history.reduce((s, h) => s + Number(h.qtySetor || 0), 0);
  const qtyReject = history.reduce((s, h) => s + Number(h.qtyReject || 0), 0);
  const totalWageSetor = history.reduce((s, h) => s + Number(h.totalWageSetor || 0), 0);
  const qtyAwal = Number(entry?.qty || 0);
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
    qtySetor: (history || []).reduce((s, h) => s + Number(h.qtySetor || 0), 0),
    qtyReject: (history || []).reduce((s, h) => s + Number(h.qtyReject || 0), 0),
    totalWageSetor: (history || []).reduce((s, h) => s + Math.max(0, Number(h.totalWageSetor || 0)), 0),
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
      qty: Number(it.qty || it.quantity || it.jumlah || 0),
      price: Number(it.price || it.harga || it.hargaPcs || 0),
    })).filter((it) => it.qty > 0 || it.name !== "-");
  }

  const totalQty = Number(d.qty || d.quantity || d.jumlah || d.totalQty || 0);

  if (items.length === 0) {
    items = [{ name: displayModelName(d.item || d.productName || d.produk || d.product || "Pesanan"), qty: totalQty, price: Number(d.hargaPcs || d.price || 0) }];
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
    const orderedQty = Number(it?.qty ?? it?.quantity ?? it?.jumlah ?? order?.qty ?? raw.qty ?? 0);
    const price = Number(it?.price ?? it?.harga ?? it?.hargaPcs ?? raw.hargaPcs ?? raw.price ?? 0);
    const hppPerPcs = Number(it?.hppPerPcs ?? it?.hpp ?? it?.bahanCost ?? it?.materialCost ?? 0);
    return {
      itemIndex: idx,
      name,
      orderedQty,
      qty: orderedQty,
      price,
      bahanCost: Number(it?.bahanCost ?? it?.materialCost ?? 0),
      hppPerPcs,
      mainMaterial: it?.mainMaterial || it?.materialName || it?.kain || it?.namaKain || "",
      materialQtyPerPcs: Number(it?.materialQtyPerPcs ?? it?.kebutuhanKainPerPcs ?? it?.kebutuhanKain ?? it?.kainPerPcs ?? 0),
      unit: it?.unit || it?.satuan || "yard",
    };
  }).filter((it) => it.name && Number(it.orderedQty || 0) > 0);
}

function hasDeliveryDetail(order) {
  const raw = order?.raw || order || {};
  return (
    (Array.isArray(raw.deliveries) && raw.deliveries.length > 0) ||
    (Array.isArray(raw.shippedItems) && raw.shippedItems.length > 0) ||
    Number(raw.deliveredTotal || 0) > 0 ||
    Number(raw.totalKirim || raw.totalShipped || 0) > 0
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
        return itemSum + Number(item.qty ?? item.shippedQty ?? item.qtyKirim ?? item.sentQty ?? 0);
      }, 0);
    }, 0);
  }

  if (Array.isArray(raw.shippedItems) && raw.shippedItems.length > 0) {
    return raw.shippedItems.reduce((sum, item) => {
      return sum + Number(item.shippedQty ?? item.qtyKirim ?? item.qty ?? item.quantity ?? item.sentQty ?? 0);
    }, 0);
  }

  return Number(raw.totalKirim ?? raw.totalShipped ?? raw.shippedQty ?? raw.sentQty ?? 0);
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
    itemIndex: Number(it.itemIndex || 0),
    name: it.name || "Produk",
    qty: Number(it.orderedQty || 0),
    shippedQty: Number(it.orderedQty || 0),
    orderedQty: Number(it.orderedQty || 0),
    price: Number(it.price || 0),
    bahanCost: Number(it.bahanCost || 0),
    hppPerPcs: Number(it.hppPerPcs || 0),
    mainMaterial: it.mainMaterial || "",
    materialQtyPerPcs: Number(it.materialQtyPerPcs || 0),
    unit: it.unit || "yard",
  }));

  const shippedItems = items.map((it) => ({
    name: it.name || "Produk",
    orderedQty: Number(it.orderedQty || 0),
    shippedQty: Number(it.orderedQty || 0),
    price: Number(it.price || 0),
    bahanCost: Number(it.bahanCost || 0),
    hppPerPcs: Number(it.hppPerPcs || 0),
    mainMaterial: it.mainMaterial || "",
    materialQtyPerPcs: Number(it.materialQtyPerPcs || 0),
    unit: it.unit || "yard",
    note: "Sesuai pesanan",
  }));

  const deliveredTotal = shippedItems.reduce((s, it) => s + Number(it.shippedQty || 0) * Number(it.price || 0), 0);
  const deliveredHppTotal = shippedItems.reduce((s, it) => s + Number(it.shippedQty || 0) * Number(it.hppPerPcs || it.bahanCost || 0), 0);
  const totalShipped = shippedItems.reduce((s, it) => s + Number(it.shippedQty || 0), 0);
  const totalOrdered = shippedItems.reduce((s, it) => s + Number(it.orderedQty || 0), 0);

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
      return sum + items.reduce((itemSum, item) => itemSum + Number(item.qtyKirim ?? item.shippedQty ?? item.qty ?? 0), 0);
    }
    const shipmentOrderIds = Array.isArray(shipment?.orderIds) ? shipment.orderIds.map((id) => String(id || "").trim()) : [];
    const isTopLevelMatch =
      String(shipment?.orderId || shipment?.pesananId || "").trim() === String(order?.id || "").trim() ||
      shipmentOrderIds.includes(String(order?.id || "").trim()) ||
      String(shipment?.invoice || "").trim() === String(order?.invoice || "").trim();
    return isTopLevelMatch ? sum + Number(shipment.totalKirim ?? shipment.qty ?? shipment.raw?.qty ?? 0) : sum;
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
      disabled={disabled}
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

function CardHeader({ children, className = "", style = {} }) {
  return (
    <div className={`mb-3 ${className}`} style={style}>
      {children}
    </div>
  );
}

function CardTitle({ children, className = "", style = {} }) {
  return (
    <div className={`font-bold ${className}`} style={{ color: "#2d1b69", ...style }}>
      {children}
    </div>
  );
}

function CardDescription({ children, className = "", style = {} }) {
  return (
    <div className={`text-sm ${className}`} style={{ color: "#64748b", ...style }}>
      {children}
    </div>
  );
}

function CardContent({ children, className = "", style = {} }) {
  return (
    <div className={className} style={style}>
      {children}
    </div>
  );
}

function CardFooter({ children, className = "", style = {} }) {
  return (
    <div className={`mt-3 ${className}`} style={style}>
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
  const amount = Number(row.totalAmount || 0);
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
    .reduce((sum, row) => sum + Number(row.totalAmount || 0), 0);
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
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [setorModal, setSetorModal] = useState(null); // entry object yang akan disetor
  const [setorForm, setSetorForm] = useState({ qtySetor: "", qtyReject: "", tanggalSetor: todayStr(), catatan: "" });
  const [editEntryModal, setEditEntryModal] = useState(null); // entry yang sedang diedit
  const [editEntryForm, setEditEntryForm] = useState({ qty: "", tanggal: "", catatan: "", model: "" });
  const [deleteStep, setDeleteStep] = useState(0); // 0=idle, 1=konfirmasi1, 2=konfirmasi2
  const [slipPreview, setSlipPreview] = useState(null); // { nama, r, dari, sampai }
  const [rekapDetailModal, setRekapDetailModal] = useState(null); // sudah | belum | total | pekerja | setor | belumSetor
  const [boronganOnlyBelumSetor, setBoronganOnlyBelumSetor] = useState(false);
  const [kasbonList, setKasbonList] = useState([]); // daftar semua kasbon pegawai dari Firestore (kasbon_pegawai)
  const [masterPekerja, setMasterPekerja] = useState([]); // daftar nama pekerja dari Gallery Kerudung (read-only)
  const [boronganOnlyOverSetor, setBoronganOnlyOverSetor] = useState(false); // filter tab borongan hanya setor melebihi diberi
  const [produksiOnlyBelumSelesai, setProduksiOnlyBelumSelesai] = useState(false); // filter tab produksi hanya belum selesai
  const [kirimOnlyBelumLengkap, setKirimOnlyBelumLengkap] = useState(false); // filter tab kirim hanya belum lengkap
  const [alertDetailModal, setAlertDetailModal] = useState(false); // modal popup alert bermasalah dari dashboard
  const [tugasDetailModal, setTugasDetailModal] = useState(false); // modal popup semua tugas hari ini
  const slipRef = useRef(null);
  const backUiRef = useRef({});
  const lastBackPressRef = useRef(0);

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

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u || null);
      setAuthLoading(false);
    });
    return () => unsub();
  }, []);

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
      if (ui.setorModal) { setSetorModal(null); return true; }
      if (ui.editEntryModal) { setEditEntryModal(null); return true; }
      if (ui.slipPreview) { setSlipPreview(null); return true; }
      if (ui.rekapDetailModal) { setRekapDetailModal(null); return true; }
      if (ui.tugasDetailModal) { setTugasDetailModal(false); return true; }
      if (ui.alertDetailModal) { setAlertDetailModal(false); return true; }
      if (ui.modal) { setModal(null); return true; }
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
      setToast("Tekan tombol back sekali lagi untuk keluar");
      setTimeout(() => setToast(""), 1600);
      pushGuardState();
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [user]);

  useEffect(() => {
    if (!user) return;

    const unsubOrders = onSnapshot(collection(db, C.ORDERS), (snap) => {
      const list = snap.docs.map((d) => safeOrder({ id: d.id, ...d.data() }));

      const ids = new Set(list.map((x) => x.id));
      if (!firstOrderLoadRef.current) {
        const added = list.filter((x) => !previousOrderIdsRef.current.has(x.id));
        if (added.length > 0) {
          setToast(`🔔 ${added.length} pesanan baru masuk dari Gallery Kerudung`);
          setTimeout(() => setToast(""), 5000);
        }
      }
      previousOrderIdsRef.current = ids;
      firstOrderLoadRef.current = false;
      setOrders(list);
    });

    const unsubProduksi = onSnapshot(collection(db, C.PRODUKSI), (snap) => setProduksi(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    const unsubRates = onSnapshot(collection(db, C.WORK_RATES), (snap) => setWorkRates(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    const unsubEntries = onSnapshot(collection(db, C.PRODUCTION_ENTRIES), (snap) => setProductionEntries(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    const unsubMaterials = onSnapshot(collection(db, C.MATERIALS), (snap) => setMaterials(snap.docs.map((d) => safeMaterial({ id: d.id, ...d.data() }))));
    const unsubShipments = onSnapshot(collection(db, C.SHIPMENTS), (snap) => setShipments(snap.docs.map((d) => safeShipment({ id: d.id, ...d.data() }))));
    const unsubPayroll = onSnapshot(collection(db, C.PAYROLL_EXPENSES), (snap) => setPayrollExpenses(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    const unsubGajianHistory = onSnapshot(collection(db, C.GAJIAN_HISTORY), (snap) => setGajianHistory(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    const unsubKasbon = onSnapshot(collection(db, C.KASBON), (snap) => setKasbonList(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    const unsubMasterPekerja = onSnapshot(collection(db, "master_pekerja"), (snap) => setMasterPekerja(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));

    return () => {
      unsubOrders();
      unsubProduksi();
      unsubRates();
      unsubEntries();
      unsubMaterials();
      unsubShipments();
      unsubPayroll();
      unsubGajianHistory();
      unsubKasbon();
      unsubMasterPekerja();
    };
  }, [user]);

  // Auto sinkron data lama yang aman: hanya order lama yang benar-benar sudah dikirim/terkirim
  // tetapi belum punya deliveries/shippedItems akan dianggap terkirim penuh.
  // Ini mencegah pesanan lama muncul lagi sebagai belum dikirim / belum produksi.
  useEffect(() => {
    if (!user || orders.length === 0) return;
    const candidates = orders.filter((o) => shouldAutoSyncLegacyDelivery(o));
    if (candidates.length === 0) return;

    candidates.slice(0, 20).forEach(async (order) => {
      if (legacyDeliverySyncingRef.current.has(order.id)) return;
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
    });
  }, [user, orders]);

  // Migrasi otomatis: isi field `items` per model untuk produksi lama yang hanya punya qty total
  useEffect(() => {
    if (produksi.length === 0 || orders.length === 0) return;
    const needsMigration = produksi.filter((p) => {
      if (!Array.isArray(p.items) || p.items.length === 0) return true;
      // Juga migrasi jika hanya 1 item dengan qty sama dengan total (fallback lama)
      if (p.items.length === 1 && Number(p.items[0].qty) === Number(p.qty)) {
        const order = orders.find((o) => o.id === p.orderId);
        if (order && Array.isArray(order.items) && order.items.length > 1) return true;
      }
      return false;
    });
    if (needsMigration.length === 0) return;

    needsMigration.forEach(async (p) => {
      const order = orders.find((o) => o.id === p.orderId);
      if (!order) return;
      // Gunakan order.items yang sudah di-parse oleh safeOrder (termasuk semua model dari Gallery Kerudung)
      const orderItems = (order.items || []).filter(it => it.name && it.name !== "-" && Number(it.qty) > 0).length > 0
        ? order.items.filter(it => it.name && it.name !== "-" && Number(it.qty) > 0).map((it) => ({ name: it.name || "", qty: Number(it.qty || 0) }))
        : [{ name: order.item || p.item || "Pesanan", qty: Number(order.qty || p.qty || 0) }];
      try {
        await updateDoc(doc(db, C.PRODUKSI, p.id), { items: orderItems });
      } catch (_) {}
    });
  }, [produksi, orders]);

  const q = search.toLowerCase();

  const produksiByOrderId = useMemo(() => {
    // Simpan SEMUA produksi per orderId dalam array sementara, lalu pilih
    // yang statusnya paling maju (atau updatedAt terbaru jika status sama).
    // Ini mencegah data produksi tertimpa diam-diam jika ada duplikat orderId.
    const mapArr = new Map();
    produksi.forEach((p) => {
      if (!p.orderId) return;
      const arr = mapArr.get(p.orderId) || [];
      arr.push(p);
      mapArr.set(p.orderId, arr);
    });
    const statusOrder = ["Antri", "Potong", "Jahit", "Pengemasan QC", "Selesai"];
    const map = new Map();
    mapArr.forEach((arr, orderId) => {
      const best = arr.reduce((a, b) => {
        const ia = statusOrder.indexOf(a.status);
        const ib = statusOrder.indexOf(b.status);
        if (ib !== ia) return ib > ia ? b : a;
        return String(b.updatedAt || b.createdAt || "") >= String(a.updatedAt || a.createdAt || "") ? b : a;
      });
      map.set(orderId, best);
    });
    return map;
  }, [produksi]);

  const shipmentByOrderId = useMemo(() => {
    // Bangun index orders terlebih dahulu (O(n)) sebelum loop shipments,
    // sehingga pencocokan keseluruhan menjadi O(n+m) bukan O(n*m).
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const orderByInvoice = new Map();
    orders.forEach((o) => {
      if (o.invoice) orderByInvoice.set(String(o.invoice).trim(), o);
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

  const ordersForBoronganLink = useMemo(() => {
    return orders
      .filter((o) => !isOrderClosedForNewWork(o, shipmentByOrderId))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }, [orders, shipmentByOrderId]);

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
      const matchedOrders = new Set();
      const directIds = [
        shipment.pesananId,
        shipment.orderId,
        ...(Array.isArray(shipment.orderIds) ? shipment.orderIds : []),
        ...(Array.isArray(shipment.pesananIds) ? shipment.pesananIds : []),
      ].map((id) => String(id || "").trim()).filter(Boolean);
      directIds.forEach((id) => {
        const found = orderById.get(id);
        if (found) matchedOrders.add(found);
      });

      const invoiceKeys = [
        shipment.invoice,
        shipment.raw?.orderCode,
        shipment.raw?.kode,
        ...(Array.isArray(shipment.invoices) ? shipment.invoices : []),
      ].map((inv) => String(inv || "").trim()).filter(Boolean);
      if (Array.isArray(shipment.orders)) {
        shipment.orders.forEach((row) => {
          const id = String(row?.orderId || row?.pesananId || "").trim();
          const inv = String(row?.invoice || "").trim();
          if (id && orderById.get(id)) matchedOrders.add(orderById.get(id));
          if (inv) invoiceKeys.push(inv);
        });
      }
      shipmentLineItems(shipment).forEach((item) => {
        const id = String(item?.orderId || item?.pesananId || "").trim();
        const inv = String(item?.invoice || item?.orderInvoice || "").trim();
        if (id && orderById.get(id)) matchedOrders.add(orderById.get(id));
        if (inv) invoiceKeys.push(inv);
      });
      invoiceKeys.forEach((inv) => {
        const found = orderByInvoice.get(inv);
        if (found) matchedOrders.add(found);
      });

      const matchedOrder = Array.from(matchedOrders)[0] || null;
      matchedOrders.forEach((o) => {
        if (o?.id) orderIdsWithShipment.add(o.id);
      });
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

  const stats = useMemo(() => {
    const selesaiOrders = orders.filter((o) => isDoneStatus(o.status) || isSentStatus(o.status));

    return {
      pesanan: orders.length,
      belum: ordersBelumProduksi.length,
      proses: produksi.filter((p) => p.status !== "Selesai").length,
      selesai: selesaiOrders.length,
      kirim: selesaiOrders.length,
      perluDicek: ordersPerluDicek.length,
      boronganPcs: productionEntries.reduce((s, e) => s + Number(e.qty || 0), 0),
      payroll: officialGajiPayrollTotal(payrollExpenses),
    };
  }, [orders, produksi, productionEntries, payrollExpenses, ordersBelumProduksi, ordersPerluDicek]);

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
      const prev = workerMap.get(key) || {
        nama: displayWorkerName(entry.employeeName),
        pcs: 0,
        gaji: 0,
        transaksi: 0,
      };
      prev.pcs += Number(totals.qtySetor || 0);
      prev.gaji += Number(totals.totalWageSetor || 0);
      prev.transaksi += history.length;
      workerMap.set(key, prev);
    });

    const topPekerja = Array.from(workerMap.values())
      .filter((row) => row.pcs > 0 || row.gaji > 0)
      .sort((a, b) => Number(b.pcs || 0) - Number(a.pcs || 0) || Number(b.gaji || 0) - Number(a.gaji || 0))
      .slice(0, 5);

    const alerts = [];
    (productionEntries || []).forEach((entry) => {
      const totals = setorTotals(entry);
      const totalAktivitas = Number(totals.qtySetor || 0) + Number(totals.qtyReject || 0);
      const diberi = Number(entry.qty || 0);
      if (diberi > 0 && totalAktivitas > diberi) {
        alerts.push({
          type: "Setor melebihi diberi",
          text: `${displayWorkerName(entry.employeeName)} · ${entry.process || "-"} · ${displayModelName(entry.model || "-")} (${fmtQty(totalAktivitas)} dari ${fmtQty(diberi)} pcs)`,
          tab: "borongan",
        });
      }
      if (Number(entry.rate || 0) <= 0) {
        alerts.push({
          type: "Tarif kosong",
          text: `${displayWorkerName(entry.employeeName)} · ${entry.process || "-"} · ${displayModelName(entry.model || "-")}`,
          tab: "tarif",
        });
      }
    });

    (orders || []).forEach((order) => {
      if (dashboardTotalOrderedQty(order) <= 0) {
        alerts.push({
          type: "Order tanpa produk/qty",
          text: `${order.customer || order.raw?.customer || "Tanpa nama"} · ${order.invoice || order.raw?.invoice || order.id}`,
          tab: "pesanan",
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
            });
          }
        });
      });
    });

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

    return {
      tugas: {
        boronganBelumSetor: activeBorongan.length,
        produksiBelumSelesai: activeProduksi.length,
        kirimanBelumLengkap: kirimBelumLengkap.length,
        activeBorongan: activeBorongan.slice(0, 4),
        activeProduksi: activeProduksi.slice(0, 4),
        kirimBelumLengkap: kirimBelumLengkap.slice(0, 4),
      },
      topPekerja,
      alerts: alerts.slice(0, 8),
      alertCount: alerts.length,
      weeklyRows,
      maxWeeklyPcs,
      monthLabel: monthStart.slice(0, 7),
    };
  }, [orders, produksi, productionEntries]);

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
    return productionEntries
      .filter((e) => e.orderId === orderId && sameProcess(e.process, process))
      .reduce((sum, e) => sum + Number(e.qty || 0), 0);
  }

  function processQtyForOrderModel(orderId, process, model, excludeEntryId = "") {
    return productionEntries
      .filter((e) =>
        e.id !== excludeEntryId &&
        e.orderId === orderId &&
        sameProcess(e.process, process) &&
        normalizeModelKey(e.model || "") === normalizeModelKey(model || "")
      )
      .reduce((sum, e) => sum + Number(e.qty || 0), 0);
  }

  function getOrderProcessLimit(order, process, model) {
    if (!order) return { limit: 0, label: "pesanan" };
    if (isModelSpecificProcess(process) && model) {
      const item = (order.items || []).find((it) => normalizeModelKey(it.name || it.item || "") === normalizeModelKey(model));
      if (item) return { limit: Number(item.qty || 0), label: `model ${item.name || item.item}` };
    }
    return { limit: Number(order.qty || 0), label: "pesanan" };
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
    const effective = isKonveksi ? base - 500 : base;
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

      setProdForm({ orderId: "", tanggalMulai: todayStr(), catatan: "" });
      setModal(null);
    } catch (e) {
      alert("Gagal menyimpan produksi: " + e.message);
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
      await updateDoc(doc(db, C.PRODUKSI, prod.id), {
        status: newStatus,
        updatedAt: todayStr(),
        history: [
          ...(prod.history || []),
          {
            tanggal: todayStr(), status: newStatus,
            catatan: `Otomatis dari progress setor borongan (${newStatus})`,
          },
        ],
      });
      // Sync ke Gallery Kerudung
      if (prod.orderId) {
        try {
          await updateDoc(doc(db, C.ORDERS, prod.orderId), {
            statusProduksi: newStatus,
            produksiStatus: newStatus,
            produksiSource: "gallery-produksi",
            produksiUpdatedAt: todayStr(),
            ...(newStatus === "Selesai" ? { status: "Selesai Produksi" } : {}),
            updatedAt: todayStr(),
          });
        } catch (_) {}
      }
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
      setToast("✅ Status produksi diperbarui");
      setTimeout(() => setToast(""), 2500);
    } catch (e) {
      alert("Gagal update status: " + (e?.message || e));
    } finally {
      setIsSaving(false);
    }
  }

  async function addWorkRate() {
    const cleanProductType = displayProductTypeName(rateForm.productType);
    const cleanProcess = rateForm.process;
    const cleanModel = canonicalByExisting(rateForm.model, modelNameOptions, "model");
    const cleanRate = Number(rateForm.rate || 0);

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
      setRateForm({ productType: "Kerudung", model: "", process: "Jahit", rate: "" });
      setModal(null);
      setToast("✅ Tarif berhasil disimpan");
      setTimeout(() => setToast(""), 2500);
    } catch (e) {
      alert("Gagal simpan tarif: " + (e?.message || e));
    } finally {
      setIsSaving(false);
    }
  }

  async function addProductionEntry() {
    if (!entryForm.employeeName.trim()) return alert("Nama pekerja wajib diisi");
    if (!entryForm.qty || Number(entryForm.qty) <= 0) return alert("Qty wajib diisi");
    if (!entryForm.model.trim()) return alert("Model wajib diisi sesuai Master Tarif");
    if (PROCESSES_WITH_MODEL.includes(entryForm.process) && !entryForm.orderId) {
      return alert(`Proses ${entryForm.process} wajib dikaitkan ke pesanan.\nPilih pesanan di dropdown "Pesanan terkait".`);
    }

    const cleanEmployeeName = canonicalByExisting(entryForm.employeeName, workerNameOptions, "worker");
    const cleanProductType = displayProductTypeName(entryForm.productType);
    const cleanModel = canonicalByExisting(entryForm.model, modelNameOptions, "model");
    const rate = getRateForEmployee(cleanProductType, cleanModel, entryForm.process, cleanEmployeeName);
    if (!rate) return alert("Tarif belum ada di Master Tarif. Silakan buat tarif baru di menu Master Tarif.");

    const order = orders.find((o) => o.id === entryForm.orderId);
    const prod = order ? produksiByOrderId.get(order.id) : null;
    const effectiveRate = Number(rate.rate || 0);
    if (!Number.isFinite(effectiveRate) || effectiveRate <= 0) return alert("Tarif efektif tidak valid. Periksa tarif dasar dan aturan potongan konveksi.");
    const totalWage = Number(entryForm.qty) * effectiveRate;

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
      const nextQty = alreadyQty + Number(entryForm.qty || 0);
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
        qty: Number(entryForm.qty),
        rate: Number(rate.rate || 0),
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
      alert("Gagal simpan borongan: " + e.message);
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

      setToast(nextSisaForToast > 0 ? `✅ Setor sebagian tersimpan. Sisa ${nextSisaForToast} pcs.` : "✅ Setor selesai tersimpan.");
      setTimeout(() => setToast(""), 3500);

      await autoUpdateProduksiStatus(setorModal, nextHistoryForStatus);

      setSetorModal(null);
      setSetorForm({ qtySetor: "", qtyReject: "", tanggalSetor: todayStr(), catatan: "" });
    } catch (e) {
      alert("Gagal simpan setor: " + e.message);
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
      await runTransaction(db, async (transaction) => {
        const liveRows = [];
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

        const combinedShipmentItems = [];
        const combinedOrderSummaries = [];
        const combinedInvoices = [];
        const combinedOrderIds = [];
        let combinedTotalKirim = 0;
        let combinedTotalPesan = 0;
        let combinedDeliveredTotal = 0;
        let combinedDeliveredHppTotal = 0;
        let combinedTotalKirimAkumulasi = 0;
        let combinedRemainingAfterShipment = 0;
        let combinedDeliveredTotalAkumulasi = 0;
        let combinedDeliveredHppTotalAkumulasi = 0;
        let combinedHasShortFinal = false;
        let combinedHasOverDelivery = false;
        let combinedHasPartialDelivery = false;

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

          const deliveryQtyNow = cleanDeliveryItems.reduce((s, i) => s + Number(i.qty || i.shippedQty || 0), 0);
          const deliveryValueNow = cleanDeliveryItems.reduce((s, i) => s + Number(i.qty || i.shippedQty || 0) * Number(i.price || 0), 0);
          const deliveryHppNow = cleanDeliveryItems.reduce((s, i) => s + Number(i.qty || i.shippedQty || 0) * Number(i.hppPerPcs || i.bahanCost || 0), 0);
          const orderShipmentItems = cleanDeliveryItems.map((it) => ({
            ...it,
            orderId: order.id,
            pesananId: order.id,
            invoice: order.invoice || "",
            customer: order.customer || "",
            productName: it.name || order.item || "Produk",
            qtyPesan: it.orderedQty,
            qtyKirim: it.shippedQty,
          }));
          combinedShipmentItems.push(...orderShipmentItems);
          combinedOrderSummaries.push({
            orderId: order.id,
            pesananId: order.id,
            invoice: order.invoice || "",
            customer: order.customer || "",
            produk: order.item || "",
            qtyPesan: totalOrdered,
            qtyKirim: deliveryQtyNow,
            qtyKirimAkumulasi: totalShipped,
            deliveryStatus,
            shippingStatus,
            shortShipmentClosed: finalShort,
            shortShipmentRemaining,
            deliveredTotal,
            deliveredHppTotal,
          });
          combinedOrderIds.push(order.id);
          if (order.invoice) combinedInvoices.push(order.invoice);
          combinedTotalKirim += deliveryQtyNow;
          combinedTotalPesan += totalOrdered;
          combinedDeliveredTotal += deliveryValueNow;
          combinedDeliveredHppTotal += deliveryHppNow;
          combinedTotalKirimAkumulasi += totalShipped;
          combinedRemainingAfterShipment += shortShipmentRemaining;
          combinedDeliveredTotalAkumulasi += deliveredTotal;
          combinedDeliveredHppTotalAkumulasi += deliveredHppTotal;
          combinedHasShortFinal = combinedHasShortFinal || finalShort;
          combinedHasOverDelivery = combinedHasOverDelivery || hasOverDelivery;
          combinedHasPartialDelivery = combinedHasPartialDelivery || (totalShipped > 0 && totalShipped < totalOrdered);

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

        if (combinedShipmentItems.length === 0) {
          throw new Error("Tidak ada item pengiriman yang valid untuk disimpan.");
        }

        const uniqueOrderIds = Array.from(new Set(combinedOrderIds.filter(Boolean)));
        const uniqueInvoices = Array.from(new Set(combinedInvoices.filter(Boolean)));
        const combinedDeliveryStatus = combinedHasShortFinal
          ? "Ditutup Kurang Kirim"
          : combinedHasOverDelivery
            ? "Kelebihan Kirim"
            : combinedHasPartialDelivery
              ? "Dikirim Sebagian"
              : "Selesai";
        const shipmentRef = doc(collection(db, C.SHIPMENTS));
        transaction.set(shipmentRef, {
          shipmentType: uniqueOrderIds.length > 1 ? "combined_customer" : "single_order",
          isCombinedShipment: uniqueOrderIds.length > 1,
          groupId,
          noteNumber: groupId,
          pesananId: uniqueOrderIds[0] || "",
          orderId: uniqueOrderIds[0] || "",
          orderIds: uniqueOrderIds,
          pesananIds: uniqueOrderIds,
          invoice: uniqueInvoices.join(", "),
          invoices: uniqueInvoices,
          customer: kirimForm.penerima.trim(),
          penerima: kirimForm.penerima.trim(),
          receiver: kirimForm.penerima.trim(),
          produk: uniqueOrderIds.length > 1 ? `${combinedShipmentItems.length} item dari ${uniqueOrderIds.length} pesanan` : (combinedShipmentItems[0]?.name || combinedShipmentItems[0]?.productName || "Produk"),
          productName: uniqueOrderIds.length > 1 ? `${combinedShipmentItems.length} item gabungan` : (combinedShipmentItems[0]?.name || combinedShipmentItems[0]?.productName || "Produk"),
          tanggalKirim: kirimForm.tanggalKirim || todayStr(),
          date: kirimForm.tanggalKirim || todayStr(),
          ekspedisi: kirimForm.ekspedisi || "",
          courier: kirimForm.ekspedisi || "",
          items: combinedShipmentItems,
          deliveryItems: combinedShipmentItems,
          orders: combinedOrderSummaries,
          qty: combinedShipmentItems.reduce((s, i) => s + Number(i.qty || i.shippedQty || i.qtyKirim || 0), 0),
          totalPesan: combinedTotalPesan,
          totalKirim: combinedTotalKirim,
          totalKirimBatch: combinedTotalKirim,
          totalKirimAkumulasi: combinedTotalKirimAkumulasi,
          totalSelisih: combinedTotalKirimAkumulasi - combinedTotalPesan,
          totalSelisihBatch: combinedTotalKirim - combinedTotalPesan,
          deliveryStatus: combinedDeliveryStatus,
          shippingStatus: combinedDeliveryStatus,
          shortShipmentClosed: combinedHasShortFinal,
          shortShipmentMode: combinedHasShortFinal ? "final" : (combinedHasPartialDelivery ? "temporary" : ""),
          shortShipmentReason: combinedHasShortFinal ? shortShipmentReason : "",
          shortShipmentNote: combinedHasShortFinal ? shortShipmentNote : "",
          shortShipmentRemaining: combinedRemainingAfterShipment,
          deliveredTotal: combinedDeliveredTotal,
          deliveredHppTotal: combinedDeliveredHppTotal,
          deliveredTotalAkumulasi: combinedDeliveredTotalAkumulasi,
          deliveredHppTotalAkumulasi: combinedDeliveredHppTotalAkumulasi,
          catatan: kirimForm.catatan || "",
          note: kirimForm.catatan || "",
          source: "gallery-produksi",
          createdAt: todayStr(),
          createdAtIso: deliveryCreatedAt,
        });
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
    } catch (e) {
      alert("Gagal simpan pengiriman: " + e.message);
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
    setDeleteStep(0);
    try {
      if (type === "rate") await deleteDoc(doc(db, C.WORK_RATES, id));
      if (type === "entry") {
        const payrollSnap = await getDocs(query(collection(db, C.PAYROLL_EXPENSES), where("entryId", "==", id)));
        const batch = writeBatch(db);
        batch.delete(doc(db, C.PRODUCTION_ENTRIES, id));
        payrollSnap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      setToast("🗑️ Data berhasil dihapus");
      setTimeout(() => setToast(""), 3000);
    } catch (e) {
      alert("Gagal hapus: " + e.message);
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
    const nextQty = Number(editEntryForm.qty || 0);
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

        let newRate = Number(liveEntry.rate || 0);
        if (!hasSetor) {
          const rateInfo = getRateForEmployee(liveEntry.productType || editEntryModal.productType || "Kerudung", nextModel, liveEntry.process, liveEntry.employeeName);
          if (!rateInfo) throw new Error("Tarif belum ada di Master Tarif. Silakan buat tarif baru di menu Master Tarif.");
          newRate = Number(rateInfo.rate || 0);
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
      setToast("✅ Entry berhasil diupdate");
      setTimeout(() => setToast(""), 3000);
    } catch (e) {
      alert("Gagal update: " + (e?.message || e));
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
      setToast("↩️ Status gajian dibatalkan dan kasbon dikembalikan");
      setTimeout(() => setToast(""), 3500);
    } catch (e) {
      alert("Gagal membatalkan status gajian: " + (e?.message || e));
    } finally {
      setIsSaving(false);
    }
  }



  async function simpanGajianLama(form) {
    if (!form.employeeName || !form.tanggalGaji || !form.periodeGajiDari || !form.periodeGajiSampai || !form.jumlah) {
      return alert("Lengkapi semua field: nama pekerja, tanggal gaji, periode, dan jumlah.");
    }
    const jumlah = Number(String(form.jumlah).replace(/[^0-9]/g, ""));
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
      setToast("✅ Riwayat gajian berhasil disimpan");
      setTimeout(() => setToast(""), 3000);
      setFormGajianLama({ employeeName: "", tanggalGaji: todayStr(), periodeGajiDari: "", periodeGajiSampai: "", jumlah: "" });
    } catch (e) {
      alert("Gagal menyimpan: " + (e?.message || e));
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
      Number(k.sisaKasbon || 0) > 0
    ).sort((a, b) => (a.tanggal || "").localeCompare(b.tanggal || ""));
  }

  function totalSisaKasbonPekerja(nama) {
    return kasbonAktifUntukPekerja(nama).reduce((s, k) => s + Number(k.sisaKasbon || 0), 0);
  }

  async function tandaiSudahGajianDanSimpanHistory(nama, r, dari = rekapDari, sampai = rekapSampai, carryOver = []) {
    if (!nama) return;
    if (sudahGajian(nama, dari, sampai)) {
      setToast("✅ Status gajian sudah tercatat");
      setTimeout(() => setToast(""), 2500);
      return;
    }
    const jumlah = Number(r?.gaji || 0);
    if (jumlah <= 0) return alert("Total gaji masih Rp 0, tidak bisa ditandai sudah gajian.");

    const kasbonAktif = kasbonAktifUntukPekerja(nama);
    const totalKasbon = kasbonAktif.reduce((s, k) => s + Number(k.sisaKasbon || 0), 0);
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
        setToast("✅ Status gajian sudah tercatat (cek server)");
        setTimeout(() => setToast(""), 2500);
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
          const sisaLive = Math.max(0, Number(data.sisaKasbon || 0));
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
          const totalCicilan = updatedCicilan.reduce((s, c) => s + Number(c.jumlah || 0), 0);
          const sisaBaru = Math.max(0, Number(kasbon.data.jumlah || 0) - totalCicilan);
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
      setToast(toastMsg);
      setTimeout(() => setToast(""), 3500);
    } catch (e) {
      alert("Gagal menandai sudah gajian: " + (e?.message || e));
    } finally {
      setIsSaving(false);
    }
  }

  async function hapusGajianHistory(id) {
    if (!window.confirm("Hapus riwayat gajian ini?")) return;
    try {
      await deleteDoc(doc(db, C.GAJIAN_HISTORY, id));
      setToast("🗑️ Riwayat gajian dihapus");
      setTimeout(() => setToast(""), 2500);
    } catch (e) {
      alert("Gagal menghapus: " + (e?.message || e));
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

      setToast("✅ Slip gaji berhasil dibuat. Buka file HTML lalu pilih Cetak / Simpan PDF.");
      setTimeout(() => setToast(""), 4500);
      return html;
    } catch (e) {
      alert("Gagal membuat slip gaji: " + (e?.message || e));
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
      alert("Gagal membuat gambar slip gaji: " + (e?.message || e));
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
        setToast("✅ Pilih WhatsApp di menu share untuk mengirim slip sebagai gambar.");
        setTimeout(() => setToast(""), 3500);
        return;
      }

      const a = document.createElement("a");
      a.href = slipImage.imgUrl;
      a.download = slipImage.filename || "SlipGaji.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setToast("⚠️ Browser ini tidak mendukung share gambar langsung. Gambar slip diunduh sebagai PNG.");
      setTimeout(() => setToast(""), 6000);
    } catch (e) {
      if (e?.name === "AbortError") return;
      alert("Gagal share slip gaji: " + (e?.message || e));
    }
  }

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
              signInWithPopup(auth, provider).catch((e) => setAuthError("Login gagal: " + e.message));
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
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari pesanan, produksi, kain, pengiriman..."
            className="bg-transparent outline-none flex-1 text-white placeholder-pink-100 text-base"
          />
          {search && <button onClick={() => setSearch("")} className="text-pink-100 font-bold">✕</button>}
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
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-lg font-black" style={{ color: "#ec4899" }}>📌 Dashboard Produksi</div>
                <div className="text-xs" style={{ color: "#94a3b8" }}>Ringkasan total keseluruhan dan periode berjalan</div>
              </div>
              <button onClick={() => setTab("rekap")} className="rounded-full px-3 py-1.5 text-xs font-bold" style={{ background: "#fdf2f8", color: "#ec4899" }}>Rekap ›</button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "Pcs diberikan", value: dashboardSummary.totalDiberi.toLocaleString(), color: "#ec4899", sub: "semua borongan", tab: "borongan" },
                { label: "Pcs disetor", value: dashboardSummary.totalSetor.toLocaleString(), color: "#16a34a", sub: "semua waktu", tab: "rekap" },
                { label: "Pcs reject", value: dashboardSummary.totalReject.toLocaleString(), color: "#d97706", sub: "semua waktu", tab: "rekap" },
                { label: "Sisa setor", value: dashboardSummary.totalSisaSetor.toLocaleString(), color: dashboardSummary.totalSisaSetor > 0 ? "#b45309" : "#94a3b8", sub: "belum disetor", tab: "borongan" },
              ].map((card) => (
                <button key={card.label} onClick={() => setTab(card.tab)} className="rounded-2xl bg-white p-3 text-left active:scale-[0.99] transition-transform" style={{ border: "1px solid #fce7f3" }}>
                  <div className="text-xl font-black" style={{ color: card.color }}>{card.value}</div>
                  <div className="text-xs font-bold" style={{ color: "#2d1b69" }}>{card.label}</div>
                  <div className="text-[10px]" style={{ color: "#94a3b8" }}>{card.sub}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Total gaji", value: money(dashboardSummary.gajiKeseluruhan), color: "#7c3aed", icon: "💰", detail: "allTime" },
              { label: "Produksi aktif", value: dashboardSummary.produksiAktif.toLocaleString(), color: "#a855f7", icon: "🧵", tab: "produksi" },
              { label: "Borongan aktif", value: dashboardSummary.boronganAktif.toLocaleString(), color: "#f59e0b", icon: "💪", tab: "borongan" },
              { label: "Pesanan belum produksi", value: stats.belum.toLocaleString(), color: "#ef4444", icon: "⏳", tab: "produksi" },
              { label: "Pcs pesanan", value: dashboardSummary.pesananPcs.toLocaleString(), color: "#6366f1", icon: "📋", tab: "pesanan" },
              { label: "Pcs terkirim", value: dashboardSummary.terkirimPcs.toLocaleString(), color: "#0ea5e9", icon: "🚚", tab: "kirim" },
              { label: "Pcs belum produksi", value: dashboardSummary.pcsBelumProduksi.toLocaleString(), color: dashboardSummary.pcsBelumProduksi > 0 ? "#d97706" : "#94a3b8", icon: "🧵", tab: "pesanan" },
              { label: "Sisa kirim siap", value: dashboardSummary.sisaKirim.toLocaleString(), color: dashboardSummary.sisaKirim > 0 ? "#b45309" : "#94a3b8", icon: "📦", tab: "kirim" },
              { label: "Kelebihan kirim", value: dashboardSummary.kelebihanKirim.toLocaleString(), color: dashboardSummary.kelebihanKirim > 0 ? "#e11d48" : "#94a3b8", icon: "⚠️", tab: "kirim" },
              { label: "Kurang kirim final", value: dashboardSummary.kurangKirimFinal.toLocaleString(), color: dashboardSummary.kurangKirimFinal > 0 ? "#b45309" : "#94a3b8", icon: "📌", tab: "kirim" },
              { label: "Master data", value: dashboardSummary.bahanTotal.toLocaleString(), color: "#10b981", icon: "🗂️", tab: "kain" },
            ].map((card) => (
              <button key={card.label} onClick={() => card.detail ? setRekapDetailModal(card.detail) : setTab(card.tab)} className="rounded-3xl bg-white p-4 text-left shadow-sm active:scale-[0.99] transition-transform" style={{ border: "1px solid #fce7f3" }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xl">{card.icon}</span>
                  <span className="text-[10px] font-bold" style={{ color: "#94a3b8" }}>Rincian ›</span>
                </div>
                <div className="mt-2 text-xl font-black break-words" style={{ color: card.color }}>{card.value}</div>
                <div className="text-xs font-semibold" style={{ color: "#64748b" }}>{card.label}</div>
              </button>
            ))}
          </div>

          <div className="rounded-3xl bg-white p-4 space-y-3 shadow-sm" style={{ border: "1px solid #fed7aa", background: "linear-gradient(135deg,#fff7ed,#ffffff)" }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-black" style={{ color: "#c2410c" }}>✅ Tugas Hari Ini</div>
                <div className="text-[11px]" style={{ color: "#9a3412" }}>Ringkasan yang perlu dicek admin.</div>
              </div>
              <button onClick={() => setTugasDetailModal(true)} className="rounded-full px-3 py-1 text-[11px] font-bold" style={{ background: "#ffedd5", color: "#c2410c" }}>Lihat kerjaan ›</button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => { setBoronganOnlyBelumSetor(true); setTab("borongan"); }}
                className="rounded-2xl bg-white p-2 text-left active:scale-[0.97] transition-transform"
                style={{ border: "1px solid #fed7aa" }}
              >
                <div className="text-lg font-black" style={{ color: dashboardInsights.tugas.boronganBelumSetor > 0 ? "#c2410c" : "#16a34a" }}>{dashboardInsights.tugas.boronganBelumSetor.toLocaleString()}</div>
                <div className="text-[10px] font-semibold leading-tight" style={{ color: "#9a3412" }}>Borongan belum setor</div>
              </button>
              <button
                onClick={() => { setProduksiOnlyBelumSelesai(true); setTab("produksi"); }}
                className="rounded-2xl bg-white p-2 text-left active:scale-[0.97] transition-transform"
                style={{ border: "1px solid #fed7aa" }}
              >
                <div className="text-lg font-black" style={{ color: dashboardInsights.tugas.produksiBelumSelesai > 0 ? "#c2410c" : "#16a34a" }}>{dashboardInsights.tugas.produksiBelumSelesai.toLocaleString()}</div>
                <div className="text-[10px] font-semibold leading-tight" style={{ color: "#9a3412" }}>Produksi belum selesai</div>
              </button>
              <button
                onClick={() => { setKirimOnlyBelumLengkap(true); setTab("kirim"); }}
                className="rounded-2xl bg-white p-2 text-left active:scale-[0.97] transition-transform"
                style={{ border: "1px solid #fed7aa" }}
              >
                <div className="text-lg font-black" style={{ color: dashboardInsights.tugas.kirimanBelumLengkap > 0 ? "#c2410c" : "#16a34a" }}>{dashboardInsights.tugas.kirimanBelumLengkap.toLocaleString()}</div>
                <div className="text-[10px] font-semibold leading-tight" style={{ color: "#9a3412" }}>Kirim belum lengkap</div>
              </button>
            </div>
            {(dashboardInsights.tugas.activeBorongan.length > 0 || dashboardInsights.tugas.activeProduksi.length > 0 || dashboardInsights.tugas.kirimBelumLengkap.length > 0) && (
              <div className="space-y-1 text-[11px]" style={{ color: "#7c2d12" }}>
                {dashboardInsights.tugas.activeBorongan.slice(0, 2).map(({ entry, totals }) => (
                  <button
                    key={`bor-${entry.id}`}
                    onClick={() => { setBoronganOnlyBelumSetor(true); setTab("borongan"); }}
                    className="w-full text-left rounded-xl px-2 py-1 active:bg-orange-100 transition-colors"
                  >
                    • {displayWorkerName(entry.employeeName)} belum setor {fmtQty(totals.sisaSetor)} pcs ({entry.process || "-"} {displayModelName(entry.model || "-")})
                  </button>
                ))}
                {dashboardInsights.tugas.activeProduksi.slice(0, 1).map((item) => (
                  <button
                    key={`prod-${item.id}`}
                    onClick={() => { setProduksiOnlyBelumSelesai(true); setTab("produksi"); }}
                    className="w-full text-left rounded-xl px-2 py-1 active:bg-orange-100 transition-colors"
                  >
                    • Produksi {item.customer || item.orderCustomer || item.orderId || "pesanan"} masih {item.status || "proses"}
                  </button>
                ))}
                {dashboardInsights.tugas.kirimBelumLengkap.slice(0, 1).map(({ order, sisa }) => (
                  <button
                    key={`ship-${order.id}`}
                    onClick={() => { setKirimOnlyBelumLengkap(true); setTab("kirim"); }}
                    className="w-full text-left rounded-xl px-2 py-1 active:bg-orange-100 transition-colors"
                  >
                    • {order.customer || "Customer"} sisa kirim {fmtQty(sisa)} pcs
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-3xl bg-white p-4 space-y-3 shadow-sm" style={{ border: "1px solid #bbf7d0", background: "linear-gradient(135deg,#f0fdf4,#ffffff)" }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-black" style={{ color: "#15803d" }}>🏆 Top Pekerja Bulan Ini</div>
                <div className="text-[11px]" style={{ color: "#64748b" }}>{dashboardInsights.monthLabel} · berdasarkan pcs setor</div>
              </div>
              <button onClick={() => setTab("rekap")} className="rounded-full px-3 py-1 text-[11px] font-bold" style={{ background: "#dcfce7", color: "#15803d" }}>Rekap ›</button>
            </div>
            {dashboardInsights.topPekerja.length === 0 ? (
              <div className="rounded-2xl p-3 text-xs" style={{ background: "#f8fafc", color: "#94a3b8" }}>Belum ada setor bulan ini.</div>
            ) : (
              <div className="space-y-2">
                {dashboardInsights.topPekerja.map((row, idx) => (
                  <div key={row.nama} className="flex items-center justify-between gap-2 rounded-2xl p-2" style={{ background: "#f8fafc" }}>
                    <div className="min-w-0">
                      <div className="text-xs font-black truncate" style={{ color: "#14532d" }}>{idx + 1}. {row.nama}</div>
                      <div className="text-[10px]" style={{ color: "#64748b" }}>{row.transaksi} transaksi</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-black" style={{ color: "#16a34a" }}>{fmtQty(row.pcs)} pcs</div>
                      <div className="text-[10px]" style={{ color: "#64748b" }}>{money(row.gaji)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

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
                  <button key={`${alert.type}-${idx}`} onClick={() => setTab(alert.tab)} className="w-full rounded-2xl p-2 text-left" style={{ background: "#fff7f7", border: "1px solid #fecaca" }}>
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

          <div className="rounded-3xl bg-white p-4 space-y-3 shadow-sm" style={{ border: "1px solid #ddd6fe", background: "linear-gradient(135deg,#faf5ff,#ffffff)" }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-black" style={{ color: "#7c3aed" }}>📈 Grafik Mingguan</div>
                <div className="text-[11px]" style={{ color: "#64748b" }}>Pcs setor, reject, dan gaji per minggu.</div>
              </div>
              <button onClick={() => setTab("rekap")} className="rounded-full px-3 py-1 text-[11px] font-bold" style={{ background: "#f3e8ff", color: "#7c3aed" }}>Detail ›</button>
            </div>
            <div className="space-y-2">
              {dashboardInsights.weeklyRows.map((row) => {
                const totalPcs = Number(row.pcsSetor || 0) + Number(row.pcsReject || 0);
                const width = Math.max(2, Math.round((totalPcs / dashboardInsights.maxWeeklyPcs) * 100));
                return (
                  <div key={row.key} className="space-y-1">
                    <div className="flex justify-between text-[10px]" style={{ color: "#64748b" }}>
                      <span>{row.dari.slice(5)} s/d {row.sampai.slice(5)}</span>
                      <span>{fmtQty(row.pcsSetor)} setor · {fmtQty(row.pcsReject)} reject · {money(row.gaji)}</span>
                    </div>
                    <div className="h-3 rounded-full overflow-hidden" style={{ background: "#f3e8ff" }}>
                      <div className="h-full rounded-full" style={{ width: `${width}%`, background: "linear-gradient(90deg,#a855f7,#ec4899)" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section Riwayat Gajian */}
          <div className="rounded-3xl bg-white p-4 space-y-3 shadow-sm" style={{ border: "1px solid #a7f3d0", background: "linear-gradient(135deg,#f0fdf4,#ffffff)" }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-black" style={{ color: "#065f46" }}>💸 Riwayat Gajian</div>
                <div className="text-[11px]" style={{ color: "#64748b" }}>{gajianHistory.length} catatan gajian tersimpan</div>
              </div>
              <button onClick={() => setTab("rekap")} className="rounded-full px-3 py-1 text-[11px] font-bold" style={{ background: "#d1fae5", color: "#065f46" }}>Input ›</button>
            </div>
            {gajianHistory.length === 0 ? (
              <div className="rounded-2xl p-3 text-xs" style={{ background: "#f8fafc", color: "#94a3b8" }}>Belum ada riwayat gajian. Input data lama di menu Rekap.</div>
            ) : (
              <div className="space-y-2">
                {[...gajianHistory]
                  .sort((a, b) => String(b.tanggalGaji || "").localeCompare(String(a.tanggalGaji || "")))
                  .slice(0, 5)
                  .map((g) => (
                    <div key={g.id} className="flex items-center justify-between gap-2 rounded-2xl p-2.5" style={{ background: "#f8fafc", border: "1px solid #d1fae5" }}>
                      <div className="min-w-0">
                        <div className="text-xs font-black truncate" style={{ color: "#065f46" }}>{displayWorkerName(g.employeeName)}</div>
                        <div className="text-[10px]" style={{ color: "#64748b" }}>
                          {g.tanggalGaji} · Periode {g.periodeGajiDari} s/d {g.periodeGajiSampai}
                        </div>
                        {g.source === "input_manual_lama" && (
                          <div className="text-[9px] font-bold" style={{ color: "#a855f7" }}>input manual</div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-black" style={{ color: "#16a34a" }}>{money(g.jumlah)}</div>
                        {g.totalPcs > 0 && <div className="text-[10px]" style={{ color: "#64748b" }}>{fmtQty(g.totalPcs)} pcs</div>}
                      </div>
                    </div>
                  ))}
                {gajianHistory.length > 5 && (
                  <div className="text-[10px] text-center" style={{ color: "#94a3b8" }}>+{gajianHistory.length - 5} riwayat lainnya di menu Rekap</div>
                )}
              </div>
            )}
          </div>

          {/* Section Riwayat Setor Terbaru */}
          <div className="rounded-3xl bg-white p-4 space-y-3 shadow-sm" style={{ border: "1px solid #bfdbfe", background: "linear-gradient(135deg,#eff6ff,#ffffff)" }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-black" style={{ color: "#1e40af" }}>📦 Riwayat Setor Terbaru</div>
                <div className="text-[11px]" style={{ color: "#64748b" }}>10 transaksi setor terakhir</div>
              </div>
              <button onClick={() => setTab("borongan")} className="rounded-full px-3 py-1 text-[11px] font-bold" style={{ background: "#dbeafe", color: "#1e40af" }}>Borongan ›</button>
            </div>
            {(() => {
              const recentSetor = productionEntries
                .flatMap((e) =>
                  normalizeSetorHistory(e).map((s) => ({
                    nama: displayWorkerName(e.employeeName),
                    process: e.process || "-",
                    model: displayModelName(e.model || "-"),
                    tanggalSetor: s.tanggalSetor || "-",
                    qtySetor: Number(s.qtySetor || 0),
                    qtyReject: Number(s.qtyReject || 0),
                    gaji: Number(s.totalWageSetor || 0),
                    key: s.id || `${e.id}-${s.tanggalSetor}`,
                  }))
                )
                .filter((s) => s.qtySetor > 0 || s.qtyReject > 0)
                .sort((a, b) => String(b.tanggalSetor).localeCompare(String(a.tanggalSetor)))
                .slice(0, 10);
              if (recentSetor.length === 0) return (
                <div className="rounded-2xl p-3 text-xs" style={{ background: "#f8fafc", color: "#94a3b8" }}>Belum ada transaksi setor.</div>
              );
              return (
                <div className="space-y-2">
                  {recentSetor.map((s) => (
                    <div key={s.key} className="flex items-center justify-between gap-2 rounded-2xl p-2.5" style={{ background: "#f8fafc", border: "1px solid #bfdbfe" }}>
                      <div className="min-w-0">
                        <div className="text-xs font-black truncate" style={{ color: "#1e3a8a" }}>{s.nama}</div>
                        <div className="text-[10px]" style={{ color: "#64748b" }}>{s.tanggalSetor} · {s.process} {s.model !== "-" ? `· ${s.model}` : ""}</div>
                        {s.qtyReject > 0 && <div className="text-[10px]" style={{ color: "#ef4444" }}>reject: {fmtQty(s.qtyReject)} pcs</div>}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-black" style={{ color: "#16a34a" }}>{money(s.gaji)}</div>
                        <div className="text-[10px]" style={{ color: "#64748b" }}>{fmtQty(s.qtySetor)} pcs</div>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
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
                      <Button
                        type="button"
                        onClick={() => openPengirimanForOrder(o)}
                        className="text-xs"
                        style={{ background: "linear-gradient(135deg,#0ea5e9,#2563eb)" }}
                      >
                        🚚 Edit Pengiriman
                      </Button>
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
                <div className="text-xs mt-1" style={{ color: "#7c3aed" }}>Update status produksi di bawah ini.</div>
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
                const order = orders.find(o => o.id === p.orderId);
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
                        const potongQty = productionEntries
                          .filter(e => e.orderId === p.orderId && sameProcess(e.process, "Potong") && normalizeModelKey(e.model || "") === normalizeModelKey(modelName))
                          .reduce((s, e) => s + Number(e.qty || 0), 0);
                        const jahitQty = productionEntries
                          .filter(e => e.orderId === p.orderId && sameProcess(e.process, "Jahit") && normalizeModelKey(e.model || "") === normalizeModelKey(modelName))
                          .reduce((s, e) => s + Number(e.qty || 0), 0);
                        const qcQty = productionEntries
                          .filter(e => e.orderId === p.orderId && sameProcess(e.process, "Pengemasan QC"))
                          .reduce((s, e) => s + Number(e.qty || 0), 0);
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

          <div className="rounded-2xl bg-white p-4" style={{ border: "1px solid #fce7f3" }}>
            <div className="text-xs font-bold" style={{ color: "#a855f7" }}>Total hasil borongan</div>
            <div className="text-2xl font-bold" style={{ color: "#ec4899" }}>{stats.boronganPcs} pcs</div>
            <div className="text-xs" style={{ color: "#94a3b8" }}>Upah tersimpan untuk pengeluaran Gallery Kerudung</div>
          </div>


          {(boronganOnlyBelumSetor
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
              <div className="flex justify-between">
                <div>
                  <div className="font-bold" style={{ color: "#2d1b69" }}>👤 {displayWorkerName(e.employeeName)}</div>
                  <div className="text-xs mt-1" style={{ color: "#a855f7" }}>{e.productType} · {e.process}{e.model ? ` · ${e.model}` : ""}</div>
                  {e.invoice && <div className="text-xs" style={{ color: "#94a3b8" }}>🧾 {e.invoice}</div>}
                  <div className="text-xs" style={{ color: "#94a3b8" }}>📅 {e.tanggal}</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold" style={{ color: "#10b981" }}>{e.qty}</div>
                  <div className="text-xs" style={{ color: "#94a3b8" }}>pcs diberikan</div>
                </div>
              </div>

              {/* Status setor bertahap */}
              {statusSetorPanel}

              {/* Tombol Edit & Hapus */}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => openEditEntry(e)}
                  className="flex-1 rounded-2xl py-2 text-xs font-bold"
                  style={{ background: "#eff6ff", color: "#2563eb", border: "1px solid #bfdbfe" }}
                >
                  ✏️ Edit
                </button>
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
          const entryOrder = orders.find(o => o.id === e.orderId);
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
            const entryOrder = orders.find(o => o.id === e.orderId);
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

        return (
          <div className="space-y-3 p-4">
            {/* Filter Tanggal Manual */}
            <div className="rounded-2xl bg-white p-4" style={{ border: "1px solid #e9d5ff" }}>
              <div className="text-xs font-bold mb-3" style={{ color: "#7c3aed" }}>📅 Filter Periode</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs mb-1" style={{ color: "#94a3b8" }}>Dari</div>
                  <input type="date" value={rekapDari} onChange={(e) => handleRekapDariChange(e.target.value)}
                    className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#e9d5ff" }} />
                </div>
                <div>
                  <div className="text-xs mb-1" style={{ color: "#94a3b8" }}>Sampai</div>
                  <input type="date" value={rekapSampai} onChange={(e) => handleRekapSampaiChange(e.target.value)}
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
                        onChange={(e) => setFormGajianLama((f) => ({ ...f, tanggalGaji: e.target.value }))}
                        className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#a7f3d0" }} />
                    </div>
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: "#64748b" }}>Jumlah Dibayar</div>
                      <input type="number" placeholder="0" value={formGajianLama.jumlah}
                        onChange={(e) => setFormGajianLama((f) => ({ ...f, jumlah: e.target.value }))}
                        className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#a7f3d0" }} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: "#64748b" }}>Periode Dari</div>
                      <input type="date" value={formGajianLama.periodeGajiDari}
                        onChange={(e) => setFormGajianLama((f) => ({ ...f, periodeGajiDari: e.target.value }))}
                        className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#a7f3d0" }} />
                    </div>
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: "#64748b" }}>Periode Sampai</div>
                      <input type="date" value={formGajianLama.periodeGajiSampai}
                        onChange={(e) => setFormGajianLama((f) => ({ ...f, periodeGajiSampai: e.target.value }))}
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
                          onClick={() => { setSetorModal(e); setSetorForm({ qtySetor: String(e.sisaSetor || ""), qtyReject: "", tanggalSetor: todayStr(), catatan: "" }); }}
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
              dashboardInsights.tugas.kirimBelumLengkap.map(({ order }) => order.id)
            );
            const displayed = kirimOnlyBelumLengkap
              ? filteredShipments.filter((k) => kirimBelumLengkapIds.has(k.orderId) || kirimBelumLengkapIds.has(k.pesananId))
              : filteredShipments;
            if (displayed.length === 0) return <Empty text={kirimOnlyBelumLengkap ? "Semua pengiriman sudah lengkap" : "Tidak ada data pengiriman"} />;
            return displayed.map((k) => (
            <div key={k.id} className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: "1px solid #fce7f3" }}>
              <div className="font-bold" style={{ color: "#2d1b69" }}>{k.customer || orders.find((o) => sameText(o.id, k.pesananId) || sameText(o.invoice, k.invoice))?.customer || "-"}</div>
              <div className="text-xs" style={{ color: "#a855f7" }}>👗 {k.produk || orders.find((o) => sameText(o.id, k.pesananId) || sameText(o.invoice, k.invoice))?.item || "-"}</div>
              <div className="text-xs" style={{ color: "#94a3b8" }}>🚚 {k.tanggalKirim || "-"} · {k.ekspedisi || "-"}</div>
              <div className="mt-3 rounded-2xl p-3" style={{ background: "#fdf2f8" }}>
                {(k.items || []).map((item, i) => (
                  <div key={i} className="flex justify-between text-xs py-1">
                    <span>{item.nama || "-"}</span>
                    <span className="font-bold">{item.qtyPesan || 0} / {item.qtyKirim || 0} pcs</span>
                  </div>
                ))}
              </div>
            </div>
          ));
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
        <Modal title="🧵 Tambah ke Produksi" onClose={() => setModal(null)}>
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
        <Modal title="💪 Input Hasil Borongan" onClose={() => setModal(null)}>
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
            <Select
              label="Pesanan terkait"
              value={entryForm.orderId}
              onChange={(v) => {
                const o = orders.find((x) => x.id === v);
                setEntryForm((f) => ({ ...f, orderId: v, model: "", qty: "" }));
              }}
            >
              <option value="">Tidak dikaitkan ke pesanan</option>
              {ordersForBoronganLink.map((o) => <option key={o.id} value={o.id}>{o.customer} · {o.invoice || o.item} · {o.qty} pcs</option>)}
            </Select>

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
                  {isModelSpecificProcess(entryForm.process) && !selectedOrder && (
                    <div className="rounded-2xl border p-3 text-xs font-bold" style={{ background: "#fff7ed", borderColor: "#fed7aa", color: "#9a3412" }}>
                      ⚠️ Proses {entryForm.process} wajib dikaitkan ke pesanan agar model pesanan bisa dipilih.
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
        <Modal title="📦 Setor Hasil Borongan" onClose={() => setSetorModal(null)}>
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
        <Modal title="🏷️ Tambah Tarif Borongan" onClose={() => setModal(null)}>
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
        <Modal title="🚚 Catat Pengiriman" onClose={() => setModal(null)}>
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
                          const nextIds = e.target.checked
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
              Simpan Pengiriman
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
        <Modal title="✏️ Edit Entry Borongan" onClose={() => setEditEntryModal(null)}>
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
                  const totalKasbon = kasbonAktif.reduce((s, k) => s + Number(k.sisaKasbon || 0), 0);
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
                      const entryOrder = orders.find(o => o.id === e.orderId);
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
                    <button
                      type="button"
                      onClick={() => {
                        setAlertDetailModal(false);
                        if (alert.type === "Setor melebihi diberi") {
                          setBoronganOnlyOverSetor(true);
                          setBoronganOnlyBelumSetor(false);
                        }
                        setTab(alert.tab);
                      }}
                      className="mt-3 rounded-xl px-4 py-2 text-xs font-bold text-white"
                      style={{ background: "linear-gradient(135deg,#e11d48,#f97316)" }}
                    >
                      Buka Tab {alert.tab === "borongan" ? "Borongan" : alert.tab === "tarif" ? "Master" : alert.tab === "pesanan" ? "Pesanan" : alert.tab === "kirim" ? "Kirim" : alert.tab} ›
                    </button>
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
