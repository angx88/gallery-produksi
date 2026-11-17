// Helper & konstanta Gallery Produksi (dipindah dari App.jsx supaya App.jsx lebih ringkas).
// Isi fungsi tidak diubah.
export const C = {
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

export const KONVEKSI_RATE_DEDUCTION = 500;

export function inputValue(valueOrEvent) {
  if (valueOrEvent && typeof valueOrEvent === "object" && "target" in valueOrEvent) {
    return valueOrEvent.target?.value ?? "";
  }
  return valueOrEvent;
}

export function friendlyErrorMessage(action, error) {
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


export const PROD_STATUS = ["Antri", "Potong", "Jahit", "Pengemasan QC", "Selesai"];
export const GENERAL_RATE_PROCESSES = ["Potong", "Pengemasan QC"];
export const MODEL_SPECIFIC_PROCESSES = ["Jahit"];
export const PROCESSES_WITH_MODEL = [...GENERAL_RATE_PROCESSES, ...MODEL_SPECIFIC_PROCESSES];
export const ALL_PROCESSES = PROCESSES_WITH_MODEL;
export const PRODUCT_TYPES = ["Kerudung", "Mukena", "Baju Anak", "Gamis", "Lainnya"];

export function isGeneralRateProcess(process) {
  return GENERAL_RATE_PROCESSES.some((p) => normalizeProcessKey(p) === normalizeProcessKey(process));
}

export function isModelSpecificProcess(process) {
  return MODEL_SPECIFIC_PROCESSES.some((p) => normalizeProcessKey(p) === normalizeProcessKey(process));
}

export const PROD_COLORS = {
  Antri: { bg: "#fef3c7", text: "#92400e", icon: "⏳" },
  Potong: { bg: "#dbeafe", text: "#1e40af", icon: "✂️" },
  Jahit: { bg: "#ede9fe", text: "#5b21b6", icon: "🧵" },
  "Pengemasan QC": { bg: "#fce7f3", text: "#9d174d", icon: "📦" },
  Selesai: { bg: "#d1fae5", text: "#065f46", icon: "✅" },
};

export const lower = (v) => String(v || "").toLowerCase();

export function isSentStatus(status) {
  const s = lower(status);
  return s.includes("kirim") || s.includes("sent") || s.includes("shipped") || s.includes("terkirim");
}

export function isDoneStatus(status) {
  const s = lower(status);
  // "Lunas" adalah status pembayaran, bukan bukti produksi/pengiriman selesai.
  return s === "selesai" || s.includes("done") || s.includes("complete");
}

export function isShortShipmentClosed(order) {
  const raw = order?.raw || order || {};
  return raw.shortShipmentClosed === true
    || raw.deliveryStatus === "Ditutup Kurang Kirim"
    || raw.shippingStatus === "Kurang Kirim Final"
    || raw.status === "Ditutup Kurang Kirim";
}


export function safeDocId(value, fallback = "doc") {
  const raw = String(value || "").trim().toLowerCase();
  const clean = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  // Tambah timestamp jika hasil bersih kosong agar tidak semua dokumen tanpa nilai
  // yang valid mendapat ID "doc" yang sama dan konflik di Firestore.
  return clean || `${fallback}_${Date.now()}`;
}

export function getDeliveryArray(orderLike) {
  if (Array.isArray(orderLike?.raw?.deliveries)) return orderLike.raw.deliveries;
  if (Array.isArray(orderLike?.deliveries)) return orderLike.deliveries;
  return [];
}

export function isOrderStatusClosedForShipment(status) {
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
  // "selesai" tidak ditutup — admin perlu bisa input ulang untuk koreksi
  return false;
}

export function sameText(a, b) {
  return String(a || "").trim() !== "" && String(b || "").trim() !== "" && String(a).trim() === String(b).trim();
}


export function parseIndoNumber(value) {
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

export function qtyValue(value) {
  const n = parseIndoNumber(value);
  return Number.isFinite(n) ? n : 0;
}

export function moneyValue(value) {
  const n = parseIndoNumber(value);
  return Number.isFinite(n) ? n : 0;
}

export function nonNegativeQty(value) {
  return Math.max(0, qtyValue(value));
}

export function nonNegativeMoney(value) {
  return Math.max(0, moneyValue(value));
}

export function lineMoneyTotal(qty, price) {
  return nonNegativeQty(qty) * nonNegativeMoney(price);
}

export function fmtQty(value) {
  const n = qtyValue(value);
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.00$/, "").replace(/0$/, "");
}

export function materialNameFromItem(item) {
  return (
    item?.mainMaterial ||
    item?.materialName ||
    item?.kain ||
    item?.namaKain ||
    item?.material ||
    ""
  );
}

export function materialQtyPerPcsFromItem(item) {
  return qtyValue(
    item?.materialQtyPerPcs ??
    item?.kebutuhanKainPerPcs ??
    item?.kebutuhanKain ??
    item?.kainPerPcs ??
    item?.qtyKainPerPcs ??
    0
  );
}

export function orderItemsForMaterial(order) {
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

export function normalizeKey(value) {
  return lower(value).replace(/[^a-z0-9]/g, "");
}

export function todayStr() {
  return new Date().toISOString().split("T")[0];
}

export function localDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function currentSundayToSaturdayPeriod(baseDate = new Date()) {
  const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  // JavaScript: Minggu = 0, Senin = 1, ..., Sabtu = 6.
  // Periode rekap yang benar adalah Minggu s/d Sabtu.
  start.setDate(start.getDate() - start.getDay());

  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  return { dari: localDateStr(start), sampai: localDateStr(end) };
}


export function dateKey(value) {
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

export function dateInRange(value, dari, sampai) {
  const t = dateKey(value);
  const d = dateKey(dari);
  const s = dateKey(sampai);
  return Boolean(t && d && s && t >= d && t <= s);
}

export function dateBefore(value, compareTo) {
  const t = dateKey(value);
  const c = dateKey(compareTo);
  return Boolean(t && c && t < c);
}

export function dateRangesOverlap(startA, endA, startB, endB) {
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
export function stripDiacritics(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function toTitleCase(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\b[a-z0-9]+/g, (word) => {
      if (/^[ivxlcdm]+$/i.test(word) && word.length <= 4) return word.toUpperCase();
      if (/^[a-z]$/i.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    });
}

export function cleanMasterText(value) {
  return stripDiacritics(value)
    .replace(/[’`]/g, "'")
    .replace(/[._\-/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMasterKey(value) {
  return cleanMasterText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCompactKey(value) {
  return normalizeMasterKey(value).replace(/\s+/g, "");
}

export function normalizeProcessKey(value) {
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

export function sameProcess(a, b) {
  return normalizeProcessKey(a) === normalizeProcessKey(b);
}

export function displayProcessName(value) {
  const key = normalizeProcessKey(value);
  if (key === "potong") return "Potong";
  if (key === "jahit") return "Jahit";
  if (key === "pengemasan qc") return "Pengemasan QC";
  return toTitleCase(cleanMasterText(value));
}

export const WORKER_PROCESS_WORDS = new Set([
  "jahit", "potong", "qc", "packing", "pack", "pengemasan", "borongan",
  "pcs", "pc", "setor", "hasil"
]);

export const WORKER_TITLE_WORDS = new Set(["teh", "ibu", "mbak", "mba", "pak"]);

export const WORKER_NOISE_WORDS = new Set([...WORKER_PROCESS_WORDS, ...WORKER_TITLE_WORDS]);

export function normalizeWorkerNameKey(name) {
  const words = normalizeMasterKey(name)
    .split(" ")
    .filter(Boolean)
    .filter((w) => !WORKER_NOISE_WORDS.has(w));
  return words.join(" ") || normalizeMasterKey(name);
}

export function displayWorkerName(name) {
  // Tampilan tetap mempertahankan panggilan seperti Teh/Ibu/Mbak/Pak jika memang ada.
  // Yang dibuang dari tampilan hanya kata proses yang sering ikut salah ketik di nama pekerja.
  const words = cleanMasterText(name)
    .split(" ")
    .filter(Boolean)
    .filter((w) => !WORKER_PROCESS_WORDS.has(w.toLowerCase()));
  const clean = words.join(" ");
  return clean ? toTitleCase(clean) : "Tidak Diketahui";
}

export function workerDisplayScore(name) {
  const words = normalizeMasterKey(name).split(" ").filter(Boolean);
  const hasTitle = words.some((w) => WORKER_TITLE_WORDS.has(w));
  const cleanLen = displayWorkerName(name).length;
  return (hasTitle ? 1000 : 0) - cleanLen;
}

export function normalizeModelKey(name) {
  return normalizeMasterKey(name);
}

export function displayModelName(name) {
  const clean = cleanMasterText(name);
  return clean ? toTitleCase(clean) : "-";
}

export function normalizeProductTypeKey(name) {
  return normalizeMasterKey(name);
}

export function displayProductTypeName(name) {
  const key = normalizeProductTypeKey(name);
  const found = PRODUCT_TYPES.find((p) => normalizeProductTypeKey(p) === key);
  return found || (cleanMasterText(name) ? toTitleCase(cleanMasterText(name)) : "Kerudung");
}

export function canonicalByExisting(value, candidates, kind = "text") {
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
export function getMingguPeriod(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const minggu = new Date(d); minggu.setDate(d.getDate() - day);
  const sabtu = new Date(d); sabtu.setDate(d.getDate() + (6 - day));
  return { dari: localDateStr(minggu), sampai: localDateStr(sabtu) };
}

export function getMingguIni() { return getMingguPeriod(todayStr()); }

export function getDaftarMinggu(n = 7) {
  const hasil = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i * 7);
    const period = getMingguPeriod(localDateStr(d));
    const key = period.dari + "_" + period.sampai;
    if (!hasil.find((x) => x.key === key)) hasil.push({ key, ...period });
  }
  return hasil;
}

export function money(v) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(moneyValue(v));
}


export function normalizeSetorHistory(entry) {
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

export function setorTotals(entry) {
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

export function setorHistoryInRange(entry, dari, sampai) {
  return normalizeSetorHistory(entry).filter((h) => dateInRange(h.tanggalSetor || h.tanggal || "", dari, sampai));
}

export function setorTotalsFromHistory(history) {
  return {
    qtySetor: (history || []).reduce((s, h) => s + nonNegativeQty(h.qtySetor || 0), 0),
    qtyReject: (history || []).reduce((s, h) => s + nonNegativeQty(h.qtyReject || 0), 0),
    totalWageSetor: (history || []).reduce((s, h) => s + nonNegativeMoney(h.totalWageSetor || 0), 0),
  };
}

export function safeOrder(d) {
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


export function rawOrderItemsForDelivery(order) {
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

export function hasDeliveryDetail(order) {
  const raw = order?.raw || order || {};
  return (
    (Array.isArray(raw.deliveries) && raw.deliveries.length > 0) ||
    (Array.isArray(raw.shippedItems) && raw.shippedItems.length > 0) ||
    moneyValue(raw.deliveredTotal || 0) > 0 ||
    nonNegativeQty(raw.totalKirim || raw.totalShipped || 0) > 0
  );
}

export function dashboardTotalOrderedQty(order) {
  return rawOrderItemsForDelivery(order).reduce((sum, item) => sum + Number(item.orderedQty || item.qty || 0), 0);
}

export function dashboardTotalShippedQty(order) {
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

export function isLegacyDoneOrSentOrder(order) {
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

export function shouldAutoSyncLegacyDelivery(order) {
  const raw = order?.raw || order || {};
  if (!order?.id) return false;
  if (raw.legacyDeliverySynced === true) return false;
  if (hasDeliveryDetail(order)) return false;
  if (!isLegacyDoneOrSentOrder(order)) return false;
  return rawOrderItemsForDelivery(order).reduce((s, it) => s + Number(it.orderedQty || 0), 0) > 0;
}

export function buildFullDeliveryPayload(order) {
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

export function shipmentLineItems(shipment) {
  if (Array.isArray(shipment?.deliveryItems) && shipment.deliveryItems.length > 0) return shipment.deliveryItems;
  if (Array.isArray(shipment?.items) && shipment.items.length > 0) return shipment.items;
  return [];
}

export function shipmentItemsForOrder(shipment, order) {
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

export function shipmentDeliveredQtyForOrder(order, shipmentByOrderId) {
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

export function isOrderFullyDelivered(order, shipmentByOrderId = null) {
  const ordered = dashboardTotalOrderedQty(order);
  let shipped = dashboardTotalShippedQty(order);
  const shipmentQty = shipmentDeliveredQtyForOrder(order, shipmentByOrderId);
  if (shipmentQty > shipped) shipped = shipmentQty;
  if (!hasDeliveryDetail(order) && shipmentQty <= 0 && isLegacyDoneOrSentOrder(order) && ordered > 0 && shipped <= 0) shipped = ordered;
  return ordered > 0 && shipped >= ordered;
}

export function orderHasCompletedProduction(order, produksiByOrderId, shipmentByOrderId) {
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

export function isOrderClosedForNewWork(order, shipmentByOrderId = null) {
  const raw = order?.raw || order || {};
  const status = lower(raw.status || order?.status || "");
  if (status.includes("batal") || status.includes("cancel")) return true;
  if (status.includes("ditutup") || status.includes("closed")) return true;
  if (isShortShipmentClosed(order)) return true;
  return isOrderFullyDelivered(order, shipmentByOrderId);
}


export function productionStatusRank(status) {
  const idx = PROD_STATUS.indexOf(String(status || ""));
  return idx >= 0 ? idx : 0;
}

export function chooseBetterProduction(current, candidate) {
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

export function normalizedInvoice(value) {
  return String(value || "").trim();
}

export function buildProductionItemsFromOrder(order, fallbackProd = null) {
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

export function entriesForProductionOrder(entries, prod, order) {
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

export function inferProductionStatusFromReality(prod, order, entries, shipmentByOrderId) {
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

export function orderBaseItems(order) {
  const raw = order?.raw || {};
  const rawItems = Array.isArray(order?.raw?.items) && order.raw.items.length > 0
    ? order.raw.items
    : Array.isArray(order?.items) && order.items.length > 0
      ? order.items
      : [];

  if (rawItems.length > 0) {
    return rawItems.map((it, idx) => {
      const name = it.name || it.nama || it.item || it.productName || it.model || order?.item || raw.item || "Produk";
      const qty = Number(it.qty ?? it.quantity ?? it.jumlah ?? order?.qty ?? raw.qty ?? 0);
      // Baca harga dari semua kemungkinan field — termasuk fallback ke level order
      const price = Number(
        it.price ?? it.harga ?? it.hargaJual ?? it.sellingPrice ?? it.unitPrice ?? it.hargaSatuan ?? it.hargaPcs ??
        raw.hargaPcs ?? raw.price ?? raw.hargaJual ?? raw.sellingPrice ?? raw.unitPrice ?? 0
      );
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

  // Fallback: order lama tanpa items array — pakai hargaPcs level order
  const fallbackPrice = Number(raw.hargaPcs ?? raw.price ?? raw.hargaJual ?? raw.sellingPrice ?? raw.unitPrice ?? raw.hargaSatuan ?? 0);
  return [{
    itemIndex: 0,
    name: order?.item || raw.item || raw.productName || "Produk",
    orderedQty: Number(order?.qty ?? raw.qty ?? 0),
    qty: Number(order?.qty ?? raw.qty ?? 0),
    price: fallbackPrice,
    bahanCost: 0,
    hppPerPcs: 0,
    mainMaterial: "",
    materialQtyPerPcs: 0,
    unit: "yard",
  }];
}

export function safeMaterial(d) {
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

export function safeShipment(d) {
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
