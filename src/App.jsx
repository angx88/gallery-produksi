// Gallery Kerudung - scan manual & repair data produk 2026-06-13
import SimpleModal from "./components/SimpleModal";
import StatusBadge from "./components/StatusBadge";
import Card from "./components/Card";
import Input from "./components/Input";
import Button from "./components/Button";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { db } from "./firebase";
import {
  collection, addDoc, getDocs, updateDoc, deleteDoc, doc, runTransaction, writeBatch,
} from "firebase/firestore";
import "./App.css";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "firebase/auth";

// Firebase deduplicates getAuth() calls secara internal sehingga selalu
// mengembalikan instance yang sama. Ini aman dan tidak memerlukan import dinamis.
const auth = getAuth();
const provider = new GoogleAuthProvider();
const ALLOWED_EMAILS = ["angx89@gmail.com", "astriapriani.aa@gmail.com"];

// jsPDF cukup dimuat saat tombol export PDF dipakai, bukan saat app pertama dibuka.
let pdfToolsPromise = null;
async function loadPdfTools() {
  if (!pdfToolsPromise) {
    pdfToolsPromise = Promise.all([import("jspdf"), import("jspdf-autotable")]).then(([jspdfModule, autoTableModule]) => ({
      jsPDF: jspdfModule.default || jspdfModule.jsPDF,
      autoTable: autoTableModule.default || autoTableModule,
    }));
  }
  return pdfToolsPromise;
}

const KASBON_COLLECTION = "kasbon_pegawai"; // collection bersama dengan Gallery Produksi

// Mode hemat reads Firestore:
// - Cache lokal mencegah app membaca ulang semua collection saat halaman direfresh berulang.
// - Realtime listener dimatikan; data tetap bisa diperbarui lewat tombol Refresh Data
//   dan otomatis sesudah simpan/edit/hapus.
const FIRESTORE_CACHE_KEY = "gk_firestore_cache_v2";
const FIRESTORE_CACHE_TTL_MS = 5 * 60 * 1000;
const FIRESTORE_REFRESH_DEBOUNCE_MS = 700;


// ─── Helpers ────────────────────────────────────────────────────────────────

function rupiah(num) {
  const n = Math.round(Number(num || 0));
  return `Rp ${n.toLocaleString("id-ID")}`;
}

function parseMoney(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : 0;

  const raw = String(value).trim();
  if (!raw) return 0;

  const clean = raw
    .replace(/Rp/gi, "")
    .replace(/\s/g, "")
    .replace(/,/g, ".")
    .replace(/[^0-9.-]/g, "");

  if (!clean || clean === "-" || clean === ".") return 0;

  const negative = clean.startsWith("-");
  const withoutSign = clean.replace(/-/g, "");
  const parts = withoutSign.split(".").filter(Boolean);

  let numericText = "0";
  if (parts.length === 1) {
    numericText = parts[0] || "0";
  } else if (parts.length === 2) {
    const [left, right] = parts;
    // Satu titik dengan 3 digit di belakang biasanya pemisah ribuan: 13.875 => 13875.
    // Satu titik dengan <=2 digit atau >3 digit di belakang dianggap desimal/artefak float: 13875849.986124152 => 13875850.
    if (right.length === 3 && left.length <= 3) numericText = left + right;
    else numericText = String(Math.round(Number(`${left}.${right}`) || 0));
  } else {
    const last = parts[parts.length - 1];
    const looksLikeDecimal = last.length > 0 && last.length <= 2;
    numericText = looksLikeDecimal ? parts.slice(0, -1).join("") : parts.join("");
  }

  const result = Number(numericText || 0);
  return Number.isFinite(result) ? (negative ? -Math.round(result) : Math.round(result)) : 0;
}

// moneyValue dihapus — langsung pakai parseMoney di seluruh file
const moneyValue = parseMoney;

function moneySum(rows = [], picker = (x) => x) {
  return Math.round((rows || []).reduce((sum, row) => sum + moneyValue(picker(row) || 0), 0));
}



const LIMITS = {
  MAX_MONEY_INPUT: 10_000_000_000,
  MAX_PRICE_PER_UNIT: 1_000_000_000,
  MAX_QTY: 1_000_000,
  MAX_STOCK_VALUE_PER_MATERIAL: 1_000_000_000,
  MAX_AVG_COST: 100_000_000,
};

const SAFE_SUMMARY_MAX = 10_000_000_000;

function isReasonableMoney(n, max = SAFE_SUMMARY_MAX) {
  return Number.isFinite(Number(n)) && Number(n) >= 0 && Number(n) <= max;
}

function safeSummaryMoney(value, max = SAFE_SUMMARY_MAX) {
  const n = moneyValue(value);
  return isReasonableMoney(n, max) ? Math.round(n) : 0;
}

function hasAbnormalMoney(value, max = SAFE_SUMMARY_MAX) {
  const raw = value === null || value === undefined || value === "" ? 0 : moneyValue(value);
  return Number.isFinite(Number(raw)) && Number(raw) > max;
}

function normalizeAbnormalMoneyToSafe(value, max = SAFE_SUMMARY_MAX) {
  let n = moneyValue(value);
  if (!Number.isFinite(Number(n)) || n < 0) return 0;
  if (n <= max) return Math.round(n);

  // Data lama tertentu pernah tersimpan dengan pemisah ribuan/desimal berulang,
  // contoh 16.746.329.999.999.998 yang sebenarnya adalah 16.746.330.
  // Turunkan per 1.000 sampai kembali ke rentang bisnis yang wajar.
  let fixed = Number(n);
  let guard = 0;
  while (fixed > max && guard < 8) {
    fixed = Math.round(fixed / 1000);
    guard += 1;
  }
  return isReasonableMoney(fixed, max) ? Math.round(fixed) : 0;
}

function sanitizePurchaseMaterialForRepair(item, purchase = {}) {
  const name = item?.name || item?.material || purchase?.material || "Bahan Baku";
  const qty = numberValue(item?.qty ?? purchase?.qty ?? 0);
  const unit = normalizeMaterialUnit(name, item?.unit || purchase?.unit);
  const rawPrice = item?.pricePerUnit ?? item?.unitPrice ?? item?.hargaSatuan ?? 0;
  const rawTotal = item?.total ?? 0;

  let pricePerUnit = normalizeAbnormalMoneyToSafe(rawPrice, LIMITS.MAX_PRICE_PER_UNIT);
  let total = normalizeAbnormalMoneyToSafe(rawTotal, LIMITS.MAX_MONEY_INPUT);

  if (qty > 0 && total > 0 && (pricePerUnit <= 0 || hasAbnormalMoney(rawPrice, LIMITS.MAX_PRICE_PER_UNIT))) {
    pricePerUnit = Math.round(total / qty);
  }
  if (qty > 0 && pricePerUnit > 0 && (total <= 0 || hasAbnormalMoney(rawTotal, LIMITS.MAX_MONEY_INPUT))) {
    total = Math.round(qty * pricePerUnit);
  }

  return {
    name: capitalizeWords(name),
    category: item?.category || purchase?.category || "Kain",
    qty,
    unit,
    pricePerUnit,
    total,
  };
}

function purchaseHasAbnormalData(purchase) {
  return hasAbnormalMoney(purchase?.total) ||
    hasAbnormalMoney(purchase?.subtotal) ||
    hasAbnormalMoney(purchase?.shippingCost ?? purchase?.ongkir) ||
    normalizePurchaseMaterials(purchase).some((it) =>
      hasAbnormalMoney(it.total) ||
      hasAbnormalMoney(it.pricePerUnit || it.unitPrice || it.hargaSatuan)
    );
}

function buildSupplierRepairPayload(purchase) {
  const rawMaterials = Array.isArray(purchase?.materials) && purchase.materials.length > 0
    ? purchase.materials
    : normalizePurchaseMaterials(purchase);

  const materials = rawMaterials
    .map((it) => sanitizePurchaseMaterialForRepair(it, purchase))
    .filter((it) => it.name && Number(it.qty || 0) > 0 && Number(it.pricePerUnit || 0) > 0 && Number(it.total || 0) > 0);

  const subtotal = materials.reduce((sum, it) => sum + moneyValue(it.total || 0), 0);
  const shippingCost = normalizeAbnormalMoneyToSafe(purchase?.shippingCost ?? purchase?.ongkir ?? 0, LIMITS.MAX_MONEY_INPUT);
  const total = subtotal + shippingCost;

  if (subtotal <= 0 || total <= 0) {
    throw new Error("Data supplier tidak cukup untuk diperbaiki otomatis. Edit manual di tab Supplier.");
  }

  return {
    materials,
    material: materials.map((it) => it.name).join(", "),
    qty: materials.map((it) => `${it.qty} ${it.unit}`).join(", "),
    category: materials[0]?.category || purchase?.category || "Kain",
    subtotal,
    shippingCost,
    ongkir: shippingCost,
    total,
    repairedSupplierData: true,
    repairedAt: new Date().toISOString(),
    repairNote: "Nominal supplier abnormal diperbaiki otomatis dari qty dan harga/total yang masih wajar.",
  };
}


function assertReasonableMoney(value, label = "Nominal", max = LIMITS.MAX_MONEY_INPUT) {
  const n = moneyValue(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} tidak valid.`);
  if (n > max) throw new Error(`${label} terlalu besar/tidak masuk akal: ${rupiah(n)}.`);
  return n;
}

function assertReasonableQty(value, label = "Qty") {
  const n = numberValue(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} tidak valid.`);
  if (n > LIMITS.MAX_QTY) throw new Error(`${label} terlalu besar/tidak masuk akal.`);
  return n;
}

function safeMaterialPurchaseCostInfo(material, purchases = []) {
  const materialKey = normalizeName(material?.name || "");
  if (!materialKey) return { qty: 0, total: 0, avgCost: 0 };

  let qtyTotal = 0;
  let costTotal = 0;

  (purchases || []).forEach((purchase) => {
    const rawRows = Array.isArray(purchase?.materials) && purchase.materials.length > 0
      ? purchase.materials
      : normalizePurchaseMaterials(purchase);

    rawRows.forEach((raw) => {
      let row;
      try {
        row = sanitizePurchaseMaterialForRepair(raw, purchase);
      } catch (_) {
        row = normalizePurchaseMaterials({ ...purchase, materials: [raw] })[0];
      }

      if (normalizeName(row?.name || row?.material || "") !== materialKey) return;

      const qty = numberValue(row?.qty || 0);
      const price = moneyValue(row?.pricePerUnit || row?.unitPrice || row?.hargaSatuan || 0);
      const total = moneyValue(row?.total || 0);
      const cost = total > 0 ? total : (qty > 0 && price > 0 ? Math.round(qty * price) : 0);
      const avg = qty > 0 ? Math.round(cost / qty) : 0;

      if (
        qty > 0 && qty <= LIMITS.MAX_QTY &&
        cost > 0 && isReasonableMoney(cost, LIMITS.MAX_MONEY_INPUT) &&
        avg > 0 && avg <= LIMITS.MAX_PRICE_PER_UNIT
      ) {
        qtyTotal += qty;
        costTotal += cost;
      }
    });
  });

  return {
    qty: qtyTotal,
    total: costTotal,
    avgCost: qtyTotal > 0 ? Math.round(costTotal / qtyTotal) : 0,
  };
}

function safeMaterialStockInfo(material, purchases = []) {
  const rawStock = Number(material?.stock || 0);
  const safeStock = Number.isFinite(rawStock) && rawStock >= 0 && rawStock <= LIMITS.MAX_QTY ? rawStock : 0;
  const rawAvgCost = moneyValue(material?.avgCost || 0);
  const rawTotalValue = moneyValue(material?.totalValue || 0);
  let repaired = false;
  let source = "stored";

  const purchaseCost = safeMaterialPurchaseCostInfo(material, purchases);
  let avgCost = purchaseCost.avgCost > 0 ? purchaseCost.avgCost : rawAvgCost;

  // Jika ada riwayat pembelian yang valid, gunakan itu sebagai sumber utama.
  // Ini mencegah kasus Balon dinormalisasi terlalu jauh menjadi Rp 2 ribuan/kg.
  if (purchaseCost.avgCost > 0) {
    source = "purchaseHistory";
    repaired = rawAvgCost > 0 && Math.abs(rawAvgCost - purchaseCost.avgCost) > Math.max(1000, purchaseCost.avgCost * 5);
  } else if (safeStock > 0 && rawTotalValue > 0 && isReasonableMoney(rawTotalValue, LIMITS.MAX_MONEY_INPUT)) {
    const avgFromValue = Math.round(rawTotalValue / safeStock);
    if (avgFromValue > 0 && avgFromValue <= LIMITS.MAX_PRICE_PER_UNIT && (avgCost <= 0 || hasAbnormalMoney(avgCost, LIMITS.MAX_PRICE_PER_UNIT))) {
      avgCost = avgFromValue;
      source = "storedTotalValue";
      repaired = true;
    }
  } else if (hasAbnormalMoney(avgCost, LIMITS.MAX_PRICE_PER_UNIT)) {
    // Fallback terakhir untuk data lama tanpa riwayat pembelian: turunkan sekali-sekali,
    // tapi jangan dipaksa sampai nilai stok di bawah batas kecil yang bisa membuat harga jadi tidak realistis.
    avgCost = normalizeAbnormalMoneyToSafe(avgCost, LIMITS.MAX_PRICE_PER_UNIT);
    repaired = true;
  }

  const safeAvgCost = Number.isFinite(avgCost) && avgCost >= 0 && avgCost <= LIMITS.MAX_PRICE_PER_UNIT ? Math.round(avgCost) : 0;
  const calculatedValue = Math.round(safeStock * safeAvgCost);
  const safeTotalValue = Number.isFinite(calculatedValue) && calculatedValue >= 0 ? calculatedValue : 0;

  return {
    stock: safeStock,
    avgCost: safeAvgCost,
    totalValue: safeTotalValue,
    repaired,
    source,
    purchaseQty: purchaseCost.qty,
    abnormal: repaired || rawAvgCost > LIMITS.MAX_AVG_COST || rawTotalValue > LIMITS.MAX_STOCK_VALUE_PER_MATERIAL,
  };
}

function safeMaterialStockValue(material, purchases = []) {
  return safeMaterialStockInfo(material, purchases).totalValue;
}

function validateMaterialPayload({ name, qty, pricePerUnit, total }) {
  if (!String(name || "").trim()) throw new Error("Nama bahan wajib diisi.");
  const cleanQty = assertReasonableQty(qty, `Qty ${name}`);
  const cleanPrice = assertReasonableMoney(pricePerUnit, `Harga bahan ${name}`, LIMITS.MAX_PRICE_PER_UNIT);
  const cleanTotal = total !== undefined ? assertReasonableMoney(total, `Total bahan ${name}`, LIMITS.MAX_MONEY_INPUT) : cleanQty * cleanPrice;
  if (cleanQty <= 0) throw new Error(`Qty ${name} harus lebih dari 0.`);
  if (cleanPrice <= 0) throw new Error(`Harga ${name} harus lebih dari 0.`);
  return { qty: cleanQty, pricePerUnit: cleanPrice, total: cleanTotal };
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const clean = String(value)
    .trim()
    .replace(/,/g, ".")
    .replace(/[^0-9.-]/g, "");
  const result = Number(clean);
  return Number.isFinite(result) ? result : 0;
}

function todayStr() {
  return new Date().toLocaleDateString("sv-SE");
}

function dateSerial(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const datePart = text.includes("T") ? text.slice(0, 10) : text;
  const match = datePart.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    return y * 10000 + m * 100 + d;
  }
  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return parsed.getFullYear() * 10000 + (parsed.getMonth() + 1) * 100 + parsed.getDate();
  }
  return 0;
}

function getRowDate(row) {
  return row?.date || row?.createdAt || row?.tanggal || row?.tanggalBelanja || "";
}

function sortOldestBottom(a, b) {
  return dateSerial(getRowDate(b)) - dateSerial(getRowDate(a));
}

function sortOldestTop(a, b) {
  return dateSerial(getRowDate(a)) - dateSerial(getRowDate(b));
}

function sortPurchaseNewestFirst(a, b) {
  const dateDiff = dateSerial(b?.createdAt || b?.date || "") - dateSerial(a?.createdAt || a?.date || "");
  if (dateDiff !== 0) return dateDiff;
  const createdDiff = String(b?.createdAt || "").localeCompare(String(a?.createdAt || ""));
  if (createdDiff !== 0) return createdDiff;
  return String(b?.id || "").localeCompare(String(a?.id || ""));
}

function getDateValue(text) {
  if (!text) return new Date();
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

function samePeriod(dateStr, period) {
  const now = new Date();
  const d = getDateValue(dateStr);
  if (period === "month") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  if (period === "year") return d.getFullYear() === now.getFullYear();
  return true;
}

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase();
}

// Unit yang dipilih user adalah sumber utama.
// Whitelist nama hanya sebagai fallback saat unit tidak diisi sama sekali.
const MATERIAL_KG_NAMES = new Set(["balon", "jaguard", "rayon"]);
function normalizeMaterialUnit(name, unit) {
  if (unit === "kg") return "kg";
  if (unit === "yard") return "yard";
  if (!unit && MATERIAL_KG_NAMES.has(normalizeName(name))) return "kg";
  return "yard";
}

function capitalizeWords(name) {
  return String(name ?? "").trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function orderInvoiceDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const safeDate = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${safeDate.getFullYear()}${String(safeDate.getMonth() + 1).padStart(2, "0")}${String(safeDate.getDate()).padStart(2, "0")}`;
}

async function generateInvoice() {
  // Nomor invoice harus dibuat di dalam transaction supaya aman saat 2 admin
  // menyimpan pesanan di waktu bersamaan. Counter dipisah per tanggal.
  const dateKey = orderInvoiceDateKey();
  const counterRef = doc(db, "appCounters", "orderInvoice");

  return runTransaction(db, async (transaction) => {
    const snap = await transaction.get(counterRef);
    const data = snap.exists() ? snap.data() : {};
    const lastByDate = data?.lastByDate && typeof data.lastByDate === "object" ? data.lastByDate : {};
    const current = Number(lastByDate[dateKey] || 0);
    const next = Number.isFinite(current) && current >= 0 ? Math.floor(current) + 1 : 1;
    const invoice = `ORD-${dateKey}-${String(next).padStart(4, "0")}`;

    transaction.set(counterRef, {
      lastDate: dateKey,
      lastNumber: next,
      lastInvoice: invoice,
      lastByDate: { ...lastByDate, [dateKey]: next },
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    return invoice;
  });
}

function emptyOrderItem() {
  return {
    productId: "",
    name: "",
    category: "",
    qty: "",
    price: 0,
    bahanCost: 0,
    hppPerPcs: 0,
    mainMaterial: "",
    materialQtyPerPcs: 0,
    unit: "yard",
    hppMaterials: [],
  };
}

function emptyHppMaterialLine() {
  return { part: "", name: "", usagePerPcs: "", unit: "yard", pricePerUnit: 0, total: 0 };
}

function emptyPurchaseMaterial() {
  return { name: "", category: "Kain", qty: "", unit: "yard", pricePerUnit: 0, total: 0 };
}

function normalizePurchaseMaterials(purchase) {
  const raw = Array.isArray(purchase?.materials) && purchase.materials.length > 0
    ? purchase.materials
    : [{
        name: purchase?.material || "Bahan Baku",
        category: purchase?.category || "Kain",
        qty: Number(String(purchase?.qty || "0").replace(/[^0-9.]/g, "")) || 0,
        unit: String(purchase?.qty || "").toLowerCase().includes("kg") ? "kg" : "yard",
        total: moneyValue(purchase?.subtotal ?? purchase?.total ?? 0),
      }];

  return raw.map((it) => {
    const qty = numberValue(it.qty || 0);
    const savedTotal = moneyValue(it.total || 0);
    const savedPrice = moneyValue(it.pricePerUnit || it.unitPrice || it.hargaSatuan || 0);
    const total = savedPrice > 0 && qty > 0 ? Math.round(qty * savedPrice) : savedTotal;
    return {
      name: it.name || it.material || "Bahan Baku",
      category: it.category || "Kain",
      qty,
      unit: normalizeMaterialUnit(it.name || it.material || purchase?.material, it.unit),
      total,
      pricePerUnit: savedPrice > 0 ? savedPrice : (qty > 0 ? Math.round(total / qty) : 0),
    };
  });
}

function purchaseMaterialTotal(it) {
  const qty = numberValue(it?.qty || 0);
  const pricePerUnit = moneyValue(it?.pricePerUnit || it?.unitPrice || it?.hargaSatuan || 0);
  const savedTotal = moneyValue(it?.total || 0);

  // Guard untuk data lama/rusak agar 1 field aneh tidak merusak Ringkasan Bisnis.
  // Contoh bug: total supplier terbaca 16.746.330.349.310.308.
  if (qty > 0 && qty <= LIMITS.MAX_QTY && pricePerUnit > 0 && pricePerUnit <= LIMITS.MAX_PRICE_PER_UNIT) {
    const calculated = Math.round(qty * pricePerUnit);
    if (isReasonableMoney(calculated)) return calculated;
  }

  return isReasonableMoney(savedTotal) ? Math.round(savedTotal) : 0;
}

function purchaseMaterialsTotal(items) {
  return (items || []).reduce((sum, it) => sum + purchaseMaterialTotal(it), 0);
}

function purchaseInvoiceTotal(purchase) {
  const hasMaterialRows = Array.isArray(purchase?.materials) && purchase.materials.length > 0;
  const materialsTotal = purchaseMaterialsTotal(normalizePurchaseMaterials(purchase));
  const shippingCost = safeSummaryMoney(purchase?.shippingCost ?? purchase?.ongkir ?? 0);
  const savedSubtotal = safeSummaryMoney(purchase?.subtotal || 0);
  const savedTotal = safeSummaryMoney(purchase?.total || 0);

  // Sumber kebenaran supplier:
  // 1) Jika ada rincian bahan, total wajib dihitung dari rincian bahan + ongkir.
  //    Jangan pakai subtotal/total tersimpan karena bisa stale setelah edit.
  // 2) Jika data lama belum punya rincian bahan, pakai subtotal+ongkir atau total tersimpan.
  if (hasMaterialRows && materialsTotal > 0) {
    const calculated = materialsTotal + shippingCost;
    return isReasonableMoney(calculated) ? Math.round(calculated) : 0;
  }

  if (savedSubtotal > 0) {
    const calculated = savedSubtotal + shippingCost;
    return isReasonableMoney(calculated) ? Math.round(calculated) : 0;
  }

  if (savedTotal > 0) return savedTotal;

  const fallback = materialsTotal + shippingCost;
  return isReasonableMoney(fallback) ? Math.round(fallback) : 0;
}

function normalizeHppMaterials(source) {
  const rawRows = Array.isArray(source?.hppMaterials) && source.hppMaterials.length > 0
    ? source.hppMaterials
    : (Array.isArray(source?.materialsHpp) && source.materialsHpp.length > 0 ? source.materialsHpp : []);

  const rows = rawRows.map((row) => {
    const name = capitalizeWords(row?.name || row?.materialName || row?.mainMaterial || row?.bahan || "");
    const usagePerPcs = numberValue(row?.usagePerPcs ?? row?.materialQtyPerPcs ?? row?.qtyPerPcs ?? row?.qty ?? 0);
    const unit = normalizeMaterialUnit(name || row?.name || row?.materialName, row?.unit);
    const pricePerUnit = moneyValue(row?.pricePerUnit ?? row?.unitCost ?? row?.bahanPricePerUnit ?? row?.hargaPerUnit ?? row?.hargaBahan ?? 0);
    const savedTotal = moneyValue(row?.total ?? row?.subtotal ?? row?.bahanCost ?? row?.materialCost ?? 0);
    const total = pricePerUnit > 0 && usagePerPcs > 0 ? Math.round(pricePerUnit * usagePerPcs) : savedTotal;
    return {
      part: capitalizeWords(row?.part || row?.bagian || ""),
      name,
      usagePerPcs,
      unit,
      pricePerUnit,
      total,
    };
  }).filter((row) => row.name && (row.usagePerPcs > 0 || row.pricePerUnit > 0 || row.total > 0));

  if (rows.length > 0) return rows;

  const legacyName = capitalizeWords(source?.mainMaterial || source?.materialName || "");
  const legacyUsage = numberValue(source?.materialQtyPerPcs ?? source?.usagePerPcs ?? 0);
  const legacyUnit = normalizeMaterialUnit(legacyName, source?.unit);
  const legacyPrice = moneyValue(source?.bahanPricePerUnit ?? source?.pricePerUnit ?? 0);
  const legacyCost = moneyValue(source?.bahanCost ?? source?.materialCost ?? 0);
  const legacyTotal = legacyPrice > 0 && legacyUsage > 0 ? Math.round(legacyPrice * legacyUsage) : legacyCost;

  if (legacyName && (legacyUsage > 0 || legacyPrice > 0 || legacyTotal > 0)) {
    return [{ part: "Utama", name: legacyName, usagePerPcs: legacyUsage, unit: legacyUnit, pricePerUnit: legacyPrice, total: legacyTotal }];
  }

  return [];
}

function hppMaterialsCost(source) {
  return normalizeHppMaterials(source).reduce((sum, row) => sum + moneyValue(row.total || 0), 0);
}

function calculateProductHpp(product) {
  const bahanMulti = hppMaterialsCost(product);
  const bahan = bahanMulti > 0 ? bahanMulti : moneyValue(product?.bahanCost || product?.materialCost || 0);
  const produksi = moneyValue(product?.productionCost || 0);
  const distribusi = moneyValue(product?.distributionCost || 0);
  const lain = moneyValue(product?.otherCost || 0);
  const manual = moneyValue(product?.hppPerPcs || 0);
  const total = bahan + produksi + distribusi + lain;
  return total > 0 ? total : manual;
}

function hppItemsTotal(items) {
  return (items || []).reduce((sum, it) => sum + Number(it.qty || it.shippedQty || 0) * moneyValue(it.hppPerPcs || 0), 0);
}

function orderItemsHppTotal(items) {
  return (items || []).reduce((sum, it) => sum + Number(it.qty || 0) * moneyValue(it.hppPerPcs || 0), 0);
}

function purchaseMaterialsSummary(purchase) {
  const items = normalizePurchaseMaterials(purchase);
  if (items.length === 0) return "Bahan Baku";
  if (items.length === 1) return `${items[0].name} · ${items[0].qty} ${items[0].unit}`;
  return `${items.length} bahan · ${items.map((it) => `${it.qty} ${it.unit}`).join(", ")}`;
}

function normalizeMaterialKey(name) {
  return normalizeName(name);
}

function materialLineKey(name, unit = "yard") {
  return `${normalizeMaterialKey(name)}__${unit === "kg" ? "kg" : "yard"}`;
}

function aggregateMaterialLines(items = []) {
  const map = {};
  (items || []).forEach((it) => {
    const name = capitalizeWords(it.name || it.mainMaterial || "");
    if (!name) return;
    const unit = normalizeMaterialUnit(name || it.name || it.mainMaterial, it.unit);
    const key = materialLineKey(name, unit);
    if (!map[key]) {
      map[key] = {
        name,
        category: it.category || "Bahan",
        unit,
        qty: 0,
        total: 0,
        source: it.source || "",
      };
    }
    map[key].qty += Number(it.qty || 0);
    map[key].total += moneyValue(it.total || 0);
  });
  return Object.values(map).filter((it) => it.name && Number(it.qty || 0) !== 0);
}

function buildMaterialUsageFromDeliveryItems(items = []) {
  const materialRows = [];
  (items || []).forEach((it) => {
    const qty = Number(it.qty || 0);
    if (qty <= 0) return;
    const hppMaterials = normalizeHppMaterials(it);
    if (hppMaterials.length > 0) {
      hppMaterials.forEach((mat) => {
        if (!mat.name || Number(mat.usagePerPcs || 0) <= 0) return;
        materialRows.push({
          name: mat.name,
          category: "Kain",
          unit: normalizeMaterialUnit(mat.name, mat.unit),
          qty: qty * Number(mat.usagePerPcs || 0),
          total: moneyValue(mat.total || 0) * qty,
          source: mat.part ? `${it.name || "Produksi"} - ${mat.part}` : (it.name || "Produksi"),
        });
      });
      return;
    }
    if (it.mainMaterial && Number(it.materialQtyPerPcs || 0) > 0) {
      materialRows.push({
        name: it.mainMaterial,
        category: "Kain",
        unit: normalizeMaterialUnit(it.mainMaterial || it.name, it.unit),
        qty: qty * Number(it.materialQtyPerPcs || 0),
        total: moneyValue(it.bahanCost || 0) * qty,
        source: it.name || "Produksi",
      });
    }
  });
  return aggregateMaterialLines(materialRows);
}

function normalizeOrderItems(order) {
  const rawItems = Array.isArray(order?.items) && order.items.length > 0
    ? order.items
    : [{ name: order?.item || "Pesanan Kerudung", qty: order?.qty || 0, price: order?.hargaPcs || 0 }];

  return rawItems.map((it) => {
    const qty = Number(it.qty || 0);
    let price = resolveSalePrice(it, {}, order);

    if (!price && moneyValue(order?.hargaPcs || 0) > 0) {
      price = moneyValue(order.hargaPcs || 0);
    }

    if (!price && qty > 0 && moneyValue(order?.total || 0) > 0) {
      price = moneyValue(order.total || 0) / qty;
    }

    return {
      productId: it.productId || "",
      name: it.name || it.item || "Produk",
      category: it.category || it.productCategory || "Lainnya",
      qty,
      price,
      bahanCost: moneyValue(it.bahanCost || it.materialCost || 0),
      hppPerPcs: moneyValue(it.hppPerPcs || 0),
      mainMaterial: it.mainMaterial || it.materialName || "",
      materialQtyPerPcs: Number(it.materialQtyPerPcs || 0),
      unit: normalizeMaterialUnit(it.mainMaterial || it.materialName || it.name, it.unit),
      hppMaterials: normalizeHppMaterials(it),
    };
  });
}


function firstPositiveMoney(...values) {
  for (const value of values) {
    const n = moneyValue(value);
    if (n > 0) return n;
  }
  return 0;
}

function findProductMaster(productMasters = [], item = {}, base = {}) {
  if (!Array.isArray(productMasters) || productMasters.length === 0) return null;
  const ids = [
    item?.productId, item?.product_id, item?.masterProductId, item?.productMasterId,
    base?.productId, base?.product_id, base?.masterProductId, base?.productMasterId,
  ].map((x) => String(x || "").trim()).filter(Boolean);
  if (ids.length > 0) {
    const byId = productMasters.find((p) => ids.includes(String(p.id || p.productId || p.product_id || p.masterProductId || "").trim()));
    if (byId) return byId;
  }

  const names = [
    item?.name, item?.nama, item?.productName, item?.originalName,
    base?.name, base?.nama, base?.productName,
  ].map((x) => normalizeName(x || "")).filter(Boolean);
  if (names.length === 0) return null;
  return productMasters.find((p) => names.includes(normalizeName(p.name || p.nama || p.productName || ""))) || null;
}

function unitPriceFromLineTotal(source = {}, fallbackQty = 0) {
  const qty = Number(source?.shippedQty ?? source?.qtyKirim ?? source?.kirim ?? source?.qty ?? fallbackQty ?? 0);
  if (qty <= 0) return 0;
  const lineTotal = firstPositiveMoney(
    source?.lineTotal, source?.subtotal, source?.subTotal, source?.totalHarga, source?.hargaTotal,
    source?.totalJual, source?.jumlah, source?.amount, source?.total
  );
  if (lineTotal <= 0) return 0;
  return Math.round(lineTotal / qty);
}

function findMatchingOrderItem(rawOrderItems = [], item = {}, fallbackIndex = null) {
  if (!Array.isArray(rawOrderItems) || rawOrderItems.length === 0) return null;

  const itemIndex = item?.itemIndex !== undefined && item?.itemIndex !== null ? Number(item.itemIndex) : null;
  if (itemIndex !== null && rawOrderItems[itemIndex]) return rawOrderItems[itemIndex];

  const ids = [item?.productId, item?.product_id, item?.masterProductId, item?.productMasterId]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  if (ids.length > 0) {
    const byId = rawOrderItems.find((row) => ids.includes(String(row?.productId || row?.product_id || row?.masterProductId || row?.productMasterId || "").trim()));
    if (byId) return byId;
  }

  const itemName = normalizeName(item?.name || item?.nama || item?.productName || item?.item || "");
  if (itemName) {
    const byName = rawOrderItems.find((row) => normalizeName(row?.name || row?.nama || row?.productName || row?.item || "") === itemName);
    if (byName) return byName;
  }

  if (fallbackIndex !== null && fallbackIndex !== undefined && rawOrderItems[Number(fallbackIndex)]) return rawOrderItems[Number(fallbackIndex)];
  if (rawOrderItems.length === 1) return rawOrderItems[0];
  return null;
}

function orderSubtotalForUnitPrice(order = {}) {
  const explicitSubtotal = firstPositiveMoney(order?.subtotal, order?.subTotal, order?.itemsTotal, order?.produkTotal);
  if (explicitSubtotal > 0) return explicitSubtotal;

  const grand = firstPositiveMoney(order?.grandTotal, order?.total);
  if (grand <= 0) return 0;
  const shipping = orderShippingCost(order);
  const withoutShipping = grand - shipping;
  return withoutShipping > 0 ? withoutShipping : grand;
}

function resolveSalePrice(item = {}, base = {}, order = {}, productMasters = []) {
  const direct = firstPositiveMoney(
    item?.price, item?.harga, item?.hargaJual, item?.hargaPcs, item?.sellingPrice, item?.salePrice, item?.unitPrice, item?.hargaSatuan
  );
  if (direct > 0) return direct;

  const qtyForItem = Number(item?.shippedQty ?? item?.qtyKirim ?? item?.kirim ?? item?.qty ?? base?.qty ?? order?.qty ?? 0);
  const directFromLineTotal = unitPriceFromLineTotal(item, qtyForItem);
  if (directFromLineTotal > 0) return directFromLineTotal;

  const basePrice = firstPositiveMoney(
    base?.price, base?.harga, base?.hargaJual, base?.hargaPcs, base?.sellingPrice, base?.salePrice, base?.unitPrice, base?.hargaSatuan
  );
  if (basePrice > 0) return basePrice;

  const baseFromLineTotal = unitPriceFromLineTotal(base, base?.qty ?? qtyForItem);
  if (baseFromLineTotal > 0) return baseFromLineTotal;

  const rawOrderItems = Array.isArray(order?.items) && order.items.length > 0
    ? order.items
    : (order?.item || order?.qty || order?.hargaPcs ? [{ name: order?.item, qty: order?.qty, price: order?.hargaPcs }] : []);

  const matchedOrderItem = findMatchingOrderItem(rawOrderItems, item, item?.itemIndex);
  if (matchedOrderItem) {
    const matchedPrice = firstPositiveMoney(
      matchedOrderItem?.price, matchedOrderItem?.harga, matchedOrderItem?.hargaJual, matchedOrderItem?.hargaPcs,
      matchedOrderItem?.sellingPrice, matchedOrderItem?.salePrice, matchedOrderItem?.unitPrice, matchedOrderItem?.hargaSatuan
    );
    if (matchedPrice > 0) return matchedPrice;

    const matchedFromLineTotal = unitPriceFromLineTotal(matchedOrderItem, matchedOrderItem?.qty ?? qtyForItem);
    if (matchedFromLineTotal > 0) return matchedFromLineTotal;
  }

  const master = findProductMaster(productMasters, item, base);
  const masterPrice = firstPositiveMoney(master?.defaultPrice, master?.price, master?.hargaJual, master?.sellingPrice, master?.salePrice, master?.hargaPcs, master?.unitPrice);
  if (masterPrice > 0) return masterPrice;

  const singlePrice = rawOrderItems.length === 1
    ? firstPositiveMoney(rawOrderItems[0]?.price, rawOrderItems[0]?.harga, rawOrderItems[0]?.hargaJual, rawOrderItems[0]?.hargaPcs, order?.hargaPcs, order?.price, order?.hargaJual)
    : 0;
  if (singlePrice > 0) return singlePrice;

  const qty = Number(item?.shippedQty ?? item?.qtyKirim ?? item?.qty ?? base?.qty ?? order?.qty ?? 0);
  const orderSubtotal = orderSubtotalForUnitPrice(order);
  if (qty > 0 && orderSubtotal > 0 && rawOrderItems.length <= 1) return Math.round(orderSubtotal / qty);

  return 0;
}

function orderItemsTotal(items) {
  return (items || []).reduce((sum, it) => sum + Number(it.qty || 0) * moneyValue(it.price || 0), 0);
}

function orderItemsSummary(order) {
  const items = normalizeOrderItems(order);
  if (items.length === 0) return "Produk";
  if (items.length === 1) return `${items[0].name} · ${items[0].qty} pcs`;
  return `${items.length} produk · ${items.reduce((sum, it) => sum + Number(it.qty || 0), 0)} pcs`;
}

function shipmentAutoNote(orderedQty, shippedQty) {
  const ordered = Number(orderedQty || 0);
  const shipped = Number(shippedQty || 0);
  const diff = shipped - ordered;
  if (diff === 0) return "Sesuai pesanan";
  if (diff < 0) return `Kekurangan pengiriman ${Math.abs(diff)} pcs`;
  return `Kelebihan pengiriman ${diff} pcs`;
}

function getDeliveryHistory(order) {
  if (Array.isArray(order?.deliveries)) return order.deliveries;
  if (Array.isArray(order?.raw?.deliveries)) return order.raw.deliveries;
  return [];
}


function invoiceDateKeyFromValue(value) {
  if (!value) return "";
  const raw = String(value || "").trim();
  const m = raw.match(/\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const d = new Date(raw.includes("T") ? raw : raw + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getDeliveryDateKey(delivery, order) {
  // Urutan prioritas: tanggal di delivery dulu, lalu tanggalKirim order (lebih akurat dari createdAt),
  // baru fallback ke tanggal order dibuat. Ini mencegah invoice menampilkan tanggal pesanan
  // sebagai tanggal kirim untuk data lama yang delivery.date-nya kosong.
  return invoiceDateKeyFromValue(
    delivery?.date || delivery?.tanggal || delivery?.deliveredAt || delivery?.shippedAt ||
    delivery?.batchDate || delivery?.createdAt ||
    order?.tanggalKirim || order?.deliveryDate || order?.shippedAt ||
    order?.createdAt || order?.date || order?.tanggal || ""
  );
}

function deliveryItemsToInvoiceItems(order, delivery, productMasters = []) {
  const orderItems = normalizeOrderItems(order);
  const rawItems = Array.isArray(delivery?.items) ? delivery.items : [];
  if (rawItems.length === 0) return [];
  return rawItems.map((it, idx) => {
    const itemIndex = it.itemIndex !== undefined && it.itemIndex !== null ? Number(it.itemIndex) : null;
    const base = orderItemForDeliveryItem(order, it, idx) || {};
    const orderedQty = Number(it.orderedQty ?? base.qty ?? 0);
    const shippedQty = Number(it.shippedQty ?? it.qty ?? it.kirim ?? 0);

    // Prioritas harga: order item (harga saat pesanan dibuat) → delivery item → fallback lainnya
    // Ini mencegah harga delivery yang salah input menimpa harga yang sudah benar di order.
    const basePrice = firstPositiveMoney(
      base?.price, base?.harga, base?.hargaJual, base?.hargaPcs,
      base?.sellingPrice, base?.salePrice, base?.unitPrice, base?.hargaSatuan
    );
    const price = basePrice > 0
      ? basePrice
      : resolveSalePrice(it, base, order, productMasters);

    return {
      // Nama yang tampil mengikuti pesanan customer terbaru. Nama lama dari riwayat kirim
      // disimpan sebagai originalName supaya HPP masih bisa dicari bila perlu.
      name: base.name || it.name || "Produk",
      originalName: it.name || "",
      productId: base.productId || it.productId || it.product_id || it.masterProductId || "",
      itemIndex: itemIndex ?? idx,
      orderedQty,
      shippedQty,
      price,
      bahanCost: moneyValue(it.bahanCost ?? base.bahanCost ?? 0),
      hppPerPcs: moneyValue(it.hppPerPcs ?? base.hppPerPcs ?? 0),
      mainMaterial: it.mainMaterial || base.mainMaterial || "",
      materialQtyPerPcs: Number(it.materialQtyPerPcs ?? base.materialQtyPerPcs ?? 0),
      unit: it.unit || base.unit || "yard",
      note: it.note || it.keterangan || shipmentAutoNote(orderedQty, shippedQty),
    };
  }).filter((it) => Number(it.shippedQty || 0) > 0);
}

function getOrderInvoiceBatches(order, productMasters = [], lookupPrice = null) {
  const deliveries = getDeliveryHistory(order);
  if (deliveries.length > 0) {
    return deliveries.map((delivery, idx) => {
      const items = deliveryItemsToInvoiceItems(order, delivery, productMasters);
      const dateKey = getDeliveryDateKey(delivery, order);
      const total = deliveryItemsTotal(items, lookupPrice);
      return {
        id: delivery.id || delivery.deliveryId || `${order?.id || order?.invoice || "order"}-${dateKey || "no-date"}-${idx}`,
        order,
        delivery,
        index: idx,
        dateKey,
        items,
        total,
      };
    }).filter((batch) => batch.items.length > 0 || batch.total > 0);
  }

  const fallbackItems = normalizeShipmentItems(order, productMasters).filter((it) => Number(it.shippedQty || 0) > 0);
  if (fallbackItems.length === 0) return [];
  const dateKey = invoiceDateKeyFromValue(order?.deliveryDate || order?.shippedAt || order?.tanggalKirim || order?.createdAt || order?.date || order?.tanggal || "");
  return [{
    id: `${order?.id || order?.invoice || "order"}-${dateKey || "fallback"}`,
    order,
    delivery: null,
    index: 0,
    dateKey,
    items: fallbackItems,
    total: shipmentItemsTotal(fallbackItems, lookupPrice),
  }];
}

function isDateKeyInRange(dateKey, startDate = "", endDate = "") {
  const hasDateFilter = Boolean(startDate || endDate);
  const s = dateSerial(dateKey || "");
  if (!s) return !hasDateFilter;
  if (startDate && s < dateSerial(startDate)) return false;
  if (endDate && s > dateSerial(endDate)) return false;
  return true;
}

function totalDeliveredQtyForItem(order, itemIndex, itemName) {
  return getDeliveryHistory(order).reduce((sum, delivery) => {
    const items = delivery.items || [];
    // Prioritas 1: cocokkan berdasarkan nama — itemIndex dari Gallery Produksi bisa salah urutan
    if (itemName) {
      const byName = items.find((it) => normalizeName(it.name || "") === normalizeName(itemName));
      if (byName) return sum + Number(byName.qty ?? byName.shippedQty ?? 0);
    }
    // Prioritas 2: itemIndex sebagai fallback untuk data lama tanpa nama
    const byIndex = items.find((it) => it.itemIndex !== undefined && it.itemIndex !== null && Number(it.itemIndex) === itemIndex);
    if (byIndex) return sum + Number(byIndex.qty ?? byIndex.shippedQty ?? 0);
    // Prioritas 3: posisi array untuk data lama tanpa itemIndex
    const legacyByPosition = items[itemIndex];
    if (legacyByPosition && (legacyByPosition.itemIndex === undefined || legacyByPosition.itemIndex === null)) {
      return sum + Number(legacyByPosition.qty ?? legacyByPosition.shippedQty ?? 0);
    }
    return sum;
  }, 0);
}

function orderItemForDeliveryItem(order, deliveryItem, fallbackIndex = null) {
  const orderItems = normalizeOrderItems(order);
  // Prioritas 1: cocokkan berdasarkan nama — lebih reliable karena itemIndex bisa beda urutan
  const byName = orderItems.find((x) => normalizeName(x.name) === normalizeName(deliveryItem?.name));
  if (byName) return byName;
  // Prioritas 2: itemIndex sebagai fallback kalau nama tidak ketemu
  const itemIndex = deliveryItem?.itemIndex !== undefined && deliveryItem?.itemIndex !== null ? Number(deliveryItem.itemIndex) : null;
  if (itemIndex !== null && orderItems[itemIndex]) return orderItems[itemIndex];
  if (fallbackIndex !== null && fallbackIndex !== undefined && orderItems[Number(fallbackIndex)]) return orderItems[Number(fallbackIndex)];
  if (orderItems.length === 1) return orderItems[0];
  return null;
}

function normalizeShipmentItems(order, productMasters = []) {
  const orderItems = normalizeOrderItems(order);
  const deliveries = getDeliveryHistory(order);

  if (deliveries.length > 0) {
    return orderItems.map((it, idx) => {
      const shippedQty = totalDeliveredQtyForItem(order, idx, it.name);
      return {
        name: it.name,
        productId: it.productId || it.product_id || it.masterProductId || "",
        category: it.category || "",
        orderedQty: Number(it.qty || 0),
        shippedQty,
        price: resolveSalePrice(it, it, order, productMasters),
        bahanCost: moneyValue(it.bahanCost || 0),
        hppPerPcs: moneyValue(it.hppPerPcs || 0),
        mainMaterial: it.mainMaterial || "",
        materialQtyPerPcs: Number(it.materialQtyPerPcs || 0),
        unit: it.unit || "yard",
        note: shipmentAutoNote(Number(it.qty || 0), shippedQty),
      };
    });
  }

  const shipped = Array.isArray(order?.shippedItems) && order.shippedItems.length > 0
    ? order.shippedItems
    : null;

  if (!shipped) {
    return orderItems.map((it) => ({
      name: it.name,
      productId: it.productId || it.product_id || it.masterProductId || "",
      category: it.category || "",
      orderedQty: Number(it.qty || 0),
      shippedQty: 0,
      price: resolveSalePrice(it, it, order, productMasters),
      bahanCost: moneyValue(it.bahanCost || 0),
      hppPerPcs: moneyValue(it.hppPerPcs || 0),
      mainMaterial: it.mainMaterial || "",
      materialQtyPerPcs: Number(it.materialQtyPerPcs || 0),
      unit: it.unit || "yard",
      note: `Belum dikirim ${Number(it.qty || 0)} pcs`,
    }));
  }

  return shipped.map((it, idx) => {
    const base = orderItems[idx] || {};
    const orderedQty = Number(it.orderedQty ?? base.qty ?? it.qty ?? 0);
    const shippedQty = Number(it.shippedQty ?? it.qty ?? 0);
    return {
      name: it.name || base.name || "Produk",
      productId: it.productId || it.product_id || it.masterProductId || base.productId || base.product_id || base.masterProductId || "",
      category: it.category || base.category || "",
      orderedQty,
      shippedQty,
      price: resolveSalePrice(it, base, order, productMasters),
      bahanCost: moneyValue(it.bahanCost ?? base.bahanCost ?? 0),
      hppPerPcs: moneyValue(it.hppPerPcs ?? base.hppPerPcs ?? 0),
      mainMaterial: it.mainMaterial || base.mainMaterial || "",
      materialQtyPerPcs: Number(it.materialQtyPerPcs ?? base.materialQtyPerPcs ?? 0),
      unit: it.unit || base.unit || "yard",
      note: it.note || it.keterangan || shipmentAutoNote(orderedQty, shippedQty),
    };
  });
}

function shipmentItemsTotal(items, lookupPrice = null) {
  return (items || []).reduce((sum, it) => {
    let price = moneyValue(it.price || 0);
    if (!price && lookupPrice) price = lookupPrice(it.name || it.nama || "");
    return sum + Number(it.shippedQty || 0) * price;
  }, 0);
}

function shipmentItemsHppTotal(items) {
  return (items || []).reduce((sum, it) => sum + Number(it.shippedQty || 0) * moneyValue(it.hppPerPcs || 0), 0);
}

function billableOrderHppTotal(order) {
  const deliveries = getDeliveryHistory(order);
  if (deliveries.length > 0) return shipmentItemsHppTotal(normalizeShipmentItems(order));
  if (Array.isArray(order?.shippedItems) && order.shippedItems.length > 0) return shipmentItemsHppTotal(normalizeShipmentItems(order));
  return 0;
}

function deliveryItemsTotal(items, lookupPrice = null) {
  // Invoice batch harus memakai qty yang dikirim pada batch/tanggal itu.
  // Data lama bisa memakai `qty`, sedangkan data baru dari App Produksi memakai
  // `shippedQty` / `qtyKirim`. Tanpa fallback ini, nota gabungan resmi dari
  // shipment_batches bisa tampil dengan total Rp 0 walaupun itemnya ada.
  // lookupPrice: opsional, dipakai sebagai fallback jika harga item = 0 (misal dari master produk).
  return (items || []).reduce((sum, it) => {
    const qty = Number(it.shippedQty ?? it.qtyKirim ?? it.qty ?? it.kirim ?? 0);
    let price = moneyValue(it.price || it.harga || 0);
    if (!price && lookupPrice) price = lookupPrice(it.name || it.nama || "");
    return sum + qty * price;
  }, 0);
}

function orderShippingCost(order) {
  // Ongkir dari order (diisi saat buat pesanan)
  const fromOrder = moneyValue(order?.shippingCost ?? order?.ongkir ?? 0);
  if (fromOrder > 0) return fromOrder;
  // Fallback: ongkir dari deliveries (dikirim dari gallery-produksi)
  const deliveries = Array.isArray(order?.deliveries) ? order.deliveries : [];
  const fromDeliveries = deliveries.reduce((sum, d) => sum + moneyValue(d?.ongkir ?? d?.shippingCost ?? 0), 0);
  return fromDeliveries;
}

function orderGrandTotal(items, shippingCost = 0) {
  return orderItemsTotal(items) + moneyValue(shippingCost || 0);
}

function billableOrderTotal(order) {
  const deliveries = getDeliveryHistory(order);
  const ongkir = orderShippingCost(order);

  if (deliveries.length > 0) {
    return shipmentItemsTotal(normalizeShipmentItems(order)) + ongkir;
  }

  if (Array.isArray(order?.shippedItems) && order.shippedItems.length > 0) {
    return shipmentItemsTotal(normalizeShipmentItems(order)) + ongkir;
  }

  if (order?.deliveredTotal !== undefined && order?.deliveredTotal !== null) {
    return Number(order.deliveredTotal || 0) + ongkir;
  }

  return 0;
}

function orderDeliveryStatus(order) {
  if (order?.shortShipmentClosed === true) return "Ditutup Kurang Kirim";
  const items = normalizeShipmentItems(order);
  const totalOrdered = items.reduce((sum, it) => sum + Number(it.orderedQty || 0), 0);
  const totalShipped = items.reduce((sum, it) => sum + Number(it.shippedQty || 0), 0);
  if (totalShipped <= 0) return "Proses";
  if (totalOrdered > 0 && totalShipped < totalOrdered) return "Dikirim Sebagian";
  // App Kerudung hanya membaca realisasi kirim dari App Produksi.
  // Kelebihan kirim adalah kondisi bisnis valid, bukan bug/penolakan.
  if (totalOrdered > 0 && totalShipped > totalOrdered) return "Kelebihan Kirim";
  return "Selesai";
}

function isFinalDeliveryStatus(status) {
  return ["Selesai", "Kelebihan Kirim", "Ditutup Kurang Kirim", "Lunas"].includes(String(status || ""));
}

// ─── UI Primitives ───────────────────────────────────────────────────────────

function Select({ label, value, onChange, children }) {
  return (
    <div className="space-y-1 relative z-30">
      <label className="text-sm font-medium text-slate-700">{label}</label>
      <select
        className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none focus:border-pink-400 bg-white relative z-30"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </div>
  );
}

// ─── DatePicker ──────────────────────────────────────────────────────────────
const BULAN_FULL = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
const HARI = ["Min","Sen","Sel","Rab","Kam","Jum","Sab"];

function DatePicker({ label, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState("day");
  const today = new Date();
  const parsed = value ? new Date(value + "T00:00:00") : today;
  const [cursor, setCursor] = useState({ year: parsed.getFullYear(), month: parsed.getMonth() });

  function selectDay(day) {
    const y = cursor.year;
    const m = String(cursor.month + 1).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    onChange(`${y}-${m}-${d}`);
    setOpen(false);
    setView("day");
  }

  function selectMonth(m) { setCursor({ ...cursor, month: m }); setView("day"); }
  function selectYear(y) { setCursor({ ...cursor, year: y }); setView("month"); }
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function firstDayOfMonth(y, m) { return new Date(y, m, 1).getDay(); }

  const displayValue = value
    ? (() => {
        const d = new Date(value + "T00:00:00");
        return `${d.getDate()} ${BULAN_FULL[d.getMonth()]} ${d.getFullYear()}`;
      })()
    : "Pilih tanggal";

  const yearRange = [];
  for (let y = today.getFullYear() - 5; y <= today.getFullYear() + 2; y++) yearRange.push(y);

  const totalDays = daysInMonth(cursor.year, cursor.month);
  const firstDay = firstDayOfMonth(cursor.year, cursor.month);
  const selectedDay = value && new Date(value + "T00:00:00").getMonth() === cursor.month
    && new Date(value + "T00:00:00").getFullYear() === cursor.year
    ? new Date(value + "T00:00:00").getDate() : null;

  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-slate-700">{label}</label>
      <button type="button" onClick={() => { setOpen(!open); setView("day"); }}
        className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-left outline-none focus:border-pink-400 bg-white flex items-center justify-between">
        <span className={value ? "text-slate-800" : "text-slate-400"}>{displayValue}</span>
        <span className="text-lg">📅</span>
      </button>

      {open && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-lg p-3 mt-1 z-50 relative">
          <div className="flex items-center justify-between mb-3">
            {view === "day" && (
              <button type="button"
                onClick={() => setCursor({ ...cursor, month: cursor.month === 0 ? 11 : cursor.month - 1, year: cursor.month === 0 ? cursor.year - 1 : cursor.year })}
                className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center font-bold text-slate-600">‹</button>
            )}
            {view !== "day" && <div />}
            <div className="flex gap-2">
              <button type="button" onClick={() => setView(view === "month" ? "day" : "month")}
                className="rounded-xl bg-pink-50 text-pink-700 font-semibold px-3 py-1 text-sm">
                {BULAN_FULL[cursor.month]}
              </button>
              <button type="button" onClick={() => setView(view === "year" ? "day" : "year")}
                className="rounded-xl bg-pink-50 text-pink-700 font-semibold px-3 py-1 text-sm">
                {cursor.year}
              </button>
            </div>
            {view === "day" && (
              <button type="button"
                onClick={() => setCursor({ ...cursor, month: cursor.month === 11 ? 0 : cursor.month + 1, year: cursor.month === 11 ? cursor.year + 1 : cursor.year })}
                className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center font-bold text-slate-600">›</button>
            )}
            {view !== "day" && <div />}
          </div>

          {view === "year" && (
            <div className="grid grid-cols-4 gap-2">
              {yearRange.map((y) => (
                <button key={y} type="button" onClick={() => selectYear(y)}
                  className={`rounded-xl py-2 text-sm font-semibold transition-all ${y === cursor.year ? "bg-pink-600 text-white" : "bg-slate-50 text-slate-700 hover:bg-pink-50"}`}>
                  {y}
                </button>
              ))}
            </div>
          )}

          {view === "month" && (
            <div className="grid grid-cols-3 gap-2">
              {BULAN_FULL.map((b, i) => (
                <button key={i} type="button" onClick={() => selectMonth(i)}
                  className={`rounded-xl py-2 text-sm font-semibold transition-all ${i === cursor.month ? "bg-pink-600 text-white" : "bg-slate-50 text-slate-700 hover:bg-pink-50"}`}>
                  {b}
                </button>
              ))}
            </div>
          )}

          {view === "day" && (
            <>
              <div className="grid grid-cols-7 mb-1">
                {HARI.map((h) => (
                  <div key={h} className="text-center text-xs font-semibold text-slate-400 py-1">{h}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-y-1">
                {Array(firstDay).fill(null).map((_, i) => <div key={`e-${i}`} />)}
                {Array(totalDays).fill(null).map((_, i) => {
                  const day = i + 1;
                  const isToday = today.getDate() === day && today.getMonth() === cursor.month && today.getFullYear() === cursor.year;
                  const isSelected = selectedDay === day;
                  return (
                    <button key={day} type="button" onClick={() => selectDay(day)}
                      className={`mx-auto w-9 h-9 rounded-full text-sm font-medium transition-all flex items-center justify-center ${isSelected ? "bg-pink-600 text-white" : isToday ? "border-2 border-pink-400 text-pink-600 font-bold" : "text-slate-700 hover:bg-pink-50"}`}>
                      {day}
                    </button>
                  );
                })}
              </div>
              <button type="button"
                onClick={() => {
                  const y = today.getFullYear();
                  const m = String(today.getMonth() + 1).padStart(2, "0");
                  const d = String(today.getDate()).padStart(2, "0");
                  setCursor({ year: y, month: today.getMonth() });
                  onChange(`${y}-${m}-${d}`);
                  setOpen(false);
                  setView("day");
                }}
                className="mt-3 w-full rounded-xl bg-slate-100 text-slate-600 font-semibold py-2 text-sm">
                Hari Ini
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function KasbonCard({ kasbon, onCicilan, onHapus, onBatalCicilan, isSaving, lunas = false }) {
  const [showCicilan, setShowCicilan] = useState(false);
  const [cicilanForm, setCicilanForm] = useState({ jumlah: "", tanggal: "" });
  const totalKasbon = parseMoney(kasbon.jumlah ?? kasbon.amount ?? 0);
  const totalCicilan = moneySum(kasbon.cicilan || [], (c) => c.jumlah ?? c.amount ?? 0);
  // Prioritaskan sisaKasbon dari Firestore (sudah termasuk potongan gaji dari Gallery Produksi).
  // Fallback ke kalkulasi manual hanya jika field tidak ada (data sangat lama).
  const sisaKasbon = kasbon.sisaKasbon !== undefined && kasbon.sisaKasbon !== null
    ? Math.max(0, parseMoney(kasbon.sisaKasbon))
    : Math.max(0, totalKasbon - totalCicilan);

  function rupiah(num) {
    return `Rp ${Math.round(Number(num || 0)).toLocaleString("id-ID")}`;
  }
  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  return (
    <div className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: lunas ? "1.5px solid #bbf7d0" : "1.5px solid #fde68a" }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-black text-base" style={{ color: "#2d1b69" }}>👤 {kasbon.employeeName}</div>
          <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>📅 {kasbon.tanggal}{kasbon.keterangan ? ` · ${kasbon.keterangan}` : ""}</div>
        </div>
        <div className={`rounded-full px-3 py-1 text-xs font-bold shrink-0 ${lunas ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
          {lunas ? "✅ Lunas" : "⏳ Aktif"}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-2xl p-2" style={{ background: "#f8fafc" }}>
          <div className="text-[10px] text-slate-400">Total Kasbon</div>
          <div className="text-sm font-black" style={{ color: "#2d1b69" }}>{rupiah(totalKasbon)}</div>
        </div>
        <div className="rounded-2xl p-2" style={{ background: "#f0fdf4" }}>
          <div className="text-[10px] text-slate-400">Sudah Cicil</div>
          <div className="text-sm font-black text-emerald-600">{rupiah(totalCicilan)}</div>
        </div>
        <div className="rounded-2xl p-2" style={{ background: lunas ? "#f0fdf4" : "#fefce8" }}>
          <div className="text-[10px] text-slate-400">Sisa</div>
          <div className={`text-sm font-black ${lunas ? "text-emerald-600" : "text-amber-600"}`}>{rupiah(sisaKasbon)}</div>
        </div>
      </div>

      {/* Riwayat cicilan */}
      {(kasbon.cicilan || []).length > 0 && (
        <div className="mt-3 rounded-2xl p-3 space-y-1" style={{ background: "#f8fafc" }}>
          <div className="text-[10px] font-bold text-slate-500 mb-2">Riwayat Bayar/Cicil</div>
          {[...kasbon.cicilan].sort((a, b) => (a.tanggal || "").localeCompare(b.tanggal || "")).map((c, i) => (
            <div key={c.id || i} className="flex justify-between items-center text-xs gap-2">
              <span className="text-slate-500">
                {c.tanggal}{" "}
                {c.sumber === "rekap_gaji"
                  ? <span className="inline-flex items-center gap-0.5 text-blue-500 font-semibold">🔄 Dipotong gaji</span>
                  : "· Manual"}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-bold text-emerald-600">{rupiah(c.jumlah)}</span>
                {onBatalCicilan && c.sumber === "rekap_gaji" && (
                  <button
                    type="button"
                    onClick={() => onBatalCicilan(kasbon.id, c)}
                    disabled={isSaving}
                    className="rounded-xl px-2 py-0.5 text-[10px] font-bold text-rose-500 disabled:opacity-40"
                    style={{ background: "#fff1f2", border: "1px solid #fecaca" }}
                  >Batal</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Form tambah cicilan */}
      {!lunas && showCicilan && (
        <div className="mt-3 rounded-2xl p-3 space-y-2" style={{ background: "#fefce8", border: "1px solid #fde68a" }}>
          <div className="text-xs font-bold text-amber-700">Bayar/Cicil Kasbon</div>
          <input
            type="date"
            value={cicilanForm.tanggal || todayStr()}
            onChange={(e) => setCicilanForm(f => ({ ...f, tanggal: e.target.value }))}
            className="w-full px-3 py-2 text-sm rounded-xl outline-none"
            style={{ border: "1.5px solid #fde68a", background: "white" }}
          />
          <input
            type="text"
            inputMode="numeric"
            placeholder="Jumlah bayar/cicil"
            value={cicilanForm.jumlah}
            onChange={(e) => setCicilanForm(f => ({ ...f, jumlah: e.target.value }))}
            className="w-full px-3 py-2 text-sm rounded-xl outline-none"
            style={{ border: "1.5px solid #fde68a", background: "white" }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setShowCicilan(false); setCicilanForm({ jumlah: "", tanggal: "" }); }}
              className="flex-1 rounded-xl py-2 text-xs font-bold text-slate-500"
              style={{ border: "1px solid #e2e8f0" }}
            >Batal</button>
            <button
              type="button"
              disabled={isSaving}
              onClick={async () => {
                await onCicilan(kasbon.id, parseMoney(cicilanForm.jumlah), cicilanForm.tanggal || todayStr());
                setShowCicilan(false);
                setCicilanForm({ jumlah: "", tanggal: "" });
              }}
              className="flex-1 rounded-xl py-2 text-xs font-bold text-white"
              style={{ background: "linear-gradient(135deg,#f59e0b,#d97706)" }}
            >Simpan Bayar/Cicil</button>
          </div>
        </div>
      )}

      <div className="mt-3 flex gap-2">
        {!lunas && (
          <button
            type="button"
            onClick={() => setShowCicilan(!showCicilan)}
            className="flex-1 rounded-2xl py-2.5 text-xs font-bold"
            style={{ background: "#fef3c7", color: "#d97706", border: "1px solid #fde68a" }}
          >
            {showCicilan ? "Tutup" : "💵 Bayar/Cicil"}
          </button>
        )}
        <button
          type="button"
          onClick={() => onHapus(kasbon.id)}
          className="rounded-2xl px-4 py-2.5 text-xs font-bold text-rose-500"
          style={{ background: "#fff1f2", border: "1px solid #fecaca" }}
        >
          Hapus
        </button>
      </div>
    </div>
  );
}

function TabBar({ tab, setTab, badgeCount = 0 }) {
  const tabs = [
    { id: "dashboard", label: "Dashboard", icon: "🏠" },
    { id: "orders", label: "Pesanan", icon: "🧾" },
    { id: "products", label: "Produk", icon: "🏷️" },
    { id: "purchases", label: "Supplier", icon: "🛍️" },
    { id: "expenses", label: "Pengeluaran", icon: "💸" },
    { id: "kasbon", label: "Kasbon", icon: "💰" },
    { id: "stock", label: "Stok", icon: "🧵" },
    { id: "rekap", label: "Rekap", icon: "📊" },
  ];
  return (
    <div className="sticky top-0 z-40 flex bg-white shadow-sm" style={{ borderBottom: "2px solid #fce7f3" }}>
      {tabs.map((t) => (
        <button key={t.id} onClick={() => setTab(t.id)}
          className="flex-1 py-3 text-xs font-semibold flex flex-col items-center gap-1 transition-all"
          style={{
            color: tab === t.id ? "#ec4899" : "#94a3b8",
            borderBottom: tab === t.id ? "3px solid #ec4899" : "3px solid transparent",
            background: tab === t.id ? "#fdf2f8" : "white",
          }}>
          <span className="relative text-lg">
            {t.icon}
            {t.id === "orders" && badgeCount > 0 && (
              <span className="absolute -top-1 -right-2 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center font-bold"
                style={{ fontSize: 9, background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
                {badgeCount}
              </span>
            )}
          </span>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ─── Invoice Modal ────────────────────────────────────────────────────────────
function InvoiceModal({ customerName, orders, shipmentBatches = [], transfers = [], onClose, getOrderPayments = (order) => order?.payments || [], getOrderTagihan = null, startDate = "", endDate = "", periodLabel = "", statusFilter = "semua", overrideTotalTagihan = null, overrideTotalBayar = null, overrideTotalSisa = null, productMasters = [] }) {
  const canvasRef = React.useRef(null);
  const [imgUrl, setImgUrl] = React.useState(null);
  const [invoiceAction, setInvoiceAction] = React.useState(null);

  const today = new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });

  // Lookup harga dari master produk sebagai fallback terakhir jika harga di item/order = 0
  const lookupMasterPrice = (name) => {
    if (!name || !productMasters.length) return 0;
    const norm = normalizeName(name);
    const found = productMasters.find((p) => normalizeName(p.name) === norm);
    return moneyValue(found?.defaultPrice ?? found?.price ?? found?.hargaJual ?? found?.sellingPrice ?? found?.salePrice ?? found?.hargaPcs ?? found?.unitPrice ?? 0);
  };

  // Hitung total invoice dari qty TERKIRIM × harga satuan + ongkir.
  // Bukan dari qty pesanan — karena selisih kirim tidak ditagihkan.
  const invoiceOrderTotal = (order) => {
    // Satu sumber nilai tagihan: kalau parent menyediakan kalkulator resmi,
    // pakai itu agar total invoice, kartu customer, FIFO pembayaran, dan sisa tagihan selalu sinkron.
    const official = typeof getOrderTagihan === "function" ? moneyValue(getOrderTagihan(order) || 0) : 0;
    if (official > 0) return official;
    return shipmentItemsTotal(normalizeShipmentItems(order, productMasters), lookupMasterPrice) + orderShippingCost(order);
  };
  const invoiceOrderPaid = (order) => getOrderPayments(order).reduce((a, p) => a + Number(moneyValue(p.amount || 0) || 0), 0);
  const invoiceOrderSisa = (order) => Math.max(invoiceOrderTotal(order) - invoiceOrderPaid(order), 0);
  const allCustomerOrders = orders
    .filter((o) => normalizeName(o.customer) === normalizeName(customerName));

  const orderById = new Map(allCustomerOrders.map((o) => [String(o.id || "").trim(), o]));
  const orderByInvoice = new Map(allCustomerOrders.map((o) => [String(o.invoice || "").trim(), o]));
  const customerOrderKeys = new Set([
    ...allCustomerOrders.map((o) => String(o.id || "").trim()).filter(Boolean),
    ...allCustomerOrders.map((o) => String(o.invoice || "").trim()).filter(Boolean),
  ]);

  const officialShipmentBatches = (shipmentBatches || [])
    .filter((batch) => {
      const batchCustomer = normalizeName(batch.customerName || batch.customer || batch.receiver || batch.penerima || "");
      if (batchCustomer && batchCustomer === normalizeName(customerName)) return true;
      const ids = [
        ...(Array.isArray(batch.orderIds) ? batch.orderIds : []),
        ...(Array.isArray(batch.pesananIds) ? batch.pesananIds : []),
        ...(Array.isArray(batch.invoices) ? batch.invoices : []),
      ].map((x) => String(x || "").trim()).filter(Boolean);
      return ids.some((id) => customerOrderKeys.has(id));
    })
    .flatMap((batch) => {
      const dateKey = invoiceDateKeyFromValue(batch.tanggalKirim || batch.date || batch.shippedAt || batch.deliveredAt || batch.createdAt || "");
      const batchGroupId = batch.groupId || batch.noteNumber || batch.id || "";
      const batchItems = Array.isArray(batch.items) ? batch.items : [];
      const batchOrders = Array.isArray(batch.orders) && batch.orders.length > 0
        ? batch.orders
        : [{
            orderId: batch.orderId || batch.pesananId || (Array.isArray(batch.orderIds) ? batch.orderIds[0] : ""),
            invoice: batch.invoice || (Array.isArray(batch.invoices) ? batch.invoices[0] : ""),
            customer: batch.customerName || batch.customer || customerName,
            items: batchItems,
          }];

      return batchOrders.map((row, idx) => {
        const rowOrderId = String(row.orderId || row.pesananId || "").trim();
        const rowInvoice = String(row.invoice || "").trim();
        const order = orderById.get(rowOrderId) || orderByInvoice.get(rowInvoice) || {
          id: rowOrderId || `${batch.id || batchGroupId}-${idx}`,
          invoice: rowInvoice || batch.noteNumber || batchGroupId,
          customer: row.customer || batch.customerName || batch.customer || customerName,
          items: [],
          payments: [],
        };
        const rawItems = Array.isArray(row.items) && row.items.length > 0
          ? row.items
          : batchItems.filter((it) => {
              const itOrderId = String(it.orderId || it.pesananId || "").trim();
              const itInvoice = String(it.invoice || "").trim();
              return (rowOrderId && itOrderId === rowOrderId) || (rowInvoice && itInvoice === rowInvoice);
            });
        const items = rawItems.map((it, iIdx) => {
          const shippedQty = Number(it.shippedQty ?? it.qtyKirim ?? it.qty ?? 0);
          const base = orderItemForDeliveryItem(order, it, iIdx) || {};
          const orderedQty = Number(it.orderedQty ?? it.qtyPesan ?? base.qty ?? 0);
          return {
            name: base.name || it.name || it.nama || it.productName || "Produk",
            originalName: it.name || it.nama || it.productName || "",
            productId: base.productId || it.productId || it.product_id || it.masterProductId || "",
            itemIndex: Number(it.itemIndex ?? iIdx),
            orderedQty,
            shippedQty,
            price: resolveSalePrice(it, base, order, productMasters) || lookupMasterPrice(base.name || it.name || it.nama || ""),
            bahanCost: moneyValue(it.bahanCost ?? base.bahanCost ?? 0),
            hppPerPcs: moneyValue(it.hppPerPcs ?? it.hpp ?? base.hppPerPcs ?? 0),
            mainMaterial: it.mainMaterial || base.mainMaterial || "",
            materialQtyPerPcs: Number(it.materialQtyPerPcs ?? base.materialQtyPerPcs ?? 0),
            unit: it.unit || base.unit || "yard",
            note: it.note || it.keterangan || shipmentAutoNote(orderedQty, shippedQty),
          };
        }).filter((it) => Number(it.shippedQty || 0) > 0);

        return {
          id: `official-${batch.id || batchGroupId}-${order.id || order.invoice || idx}`,
          order,
          delivery: { ...batch, groupId: batchGroupId },
          officialBatch: true,
          groupId: batchGroupId,
          index: idx,
          dateKey,
          items,
          // Prioritaskan ongkir dari shipment_batches (dikirim dari gallery-produksi),
          // fallback ke order.shippingCost (diisi saat buat pesanan di gallery-kerudung).
          // Jika batch punya beberapa order, ongkir sudah include di batch level — jangan dobel.
          // Ongkir hanya dari batch langsung — JANGAN fallback ke orderShippingCost.
          // orderShippingCost(order) adalah ongkir order keseluruhan, bukan per batch,
          // sehingga akan dikali jumlah batch dan menyebabkan Grand Total > Total Tagihan.
          total: deliveryItemsTotal(items, lookupMasterPrice) + (batchOrders.length <= 1 ? moneyValue(batch.ongkir ?? batch.shippingCost ?? 0) : 0),
        };
      });
    })
    .filter((batch) => batch.items.length > 0 || Number(batch.total || 0) > 0);

  const officialKeys = new Set(officialShipmentBatches.map((batch) => {
    const orderKey = batch.order?.id || batch.order?.invoice || batch.id;
    const groupKey = batch.groupId || batch.delivery?.groupId || batch.delivery?.noteNumber || "";
    return `${orderKey}|${groupKey}|${batch.dateKey || ""}`;
  }));

  // Set order yang sudah punya official batch dari Gallery Produksi (apapun tanggalnya).
  // Delivery lama dari order ini tidak perlu ditampilkan karena sudah digantikan official batch.
  const ordersWithOfficialBatch = new Set(
    officialShipmentBatches.map((batch) => batch.order?.id || batch.order?.invoice || "").filter(Boolean)
  );

  const deliveryInvoiceBatches = allCustomerOrders.flatMap((order) =>
    getOrderInvoiceBatches(order, productMasters, lookupMasterPrice)
      .map((batch) => ({ ...batch, order }))
      .filter((batch) => {
        const groupKey = batch.delivery?.groupId || batch.delivery?.noteNumber || "";
        const orderKey = order.id || order.invoice || batch.id;
        const dateKey = batch.dateKey || "";

        if (!groupKey) {
          // Delivery lama (tanpa groupId): skip jika order sudah punya official batch
          // dari Gallery Produksi, apapun tanggalnya. Ini mencegah delivery lama tampil
          // dengan tanggal salah (tanggal pesanan) saat official batch sudah ada.
          if (ordersWithOfficialBatch.has(order.id) || ordersWithOfficialBatch.has(order.invoice)) return false;
          const coveredByOfficial = Array.from(officialKeys).some(
            (k) => k.startsWith(`${orderKey}|`) && k.endsWith(`|${dateKey}`)
          );
          return !coveredByOfficial;
        }
        return !officialKeys.has(`${orderKey}|${groupKey}|${dateKey}`);
      })
  );

  // Perbaikan kecil khusus invoice: ongkir hanya masuk di invoice, tanpa mengubah
  // Dashboard/Rekap/Piutang. Aturan bisnis: ongkir diambil dari salah satu sumber.
  // Jika App Kerudung mengisi ongkir order, pakai itu sebagai koreksi/manual.
  // Jika kosong, pakai ongkir dari App Produksi/batch. Jangan dijumlahkan.
  const rawInvoiceBatches = [...officialShipmentBatches, ...deliveryInvoiceBatches];
  const usedOrderOngkirKeys = new Set();
  const allInvoiceBatches = rawInvoiceBatches
    .slice()
    .sort((a, b) => `${a.dateKey || "9999-99-99"}-${a.order?.invoice || a.order?.id || ""}`.localeCompare(`${b.dateKey || "9999-99-99"}-${b.order?.invoice || b.order?.id || ""}`))
    .map((batch) => {
      const orderKey = String(batch.order?.id || batch.order?.invoice || batch.id || "").trim();
      const barangDariItem = deliveryItemsTotal(batch.items || [], lookupMasterPrice);
      const ongkirProduksi = moneyValue(batch.delivery?.ongkir ?? batch.delivery?.shippingCost ?? batch.ongkir ?? batch.shippingCost ?? 0);
      const ongkirKerudung = moneyValue(batch.order?.shippingCost ?? batch.order?.ongkir ?? 0);
      const rawTotal = moneyValue(batch.total || 0);
      const rawTotalSudahTermasukOngkirProduksi = ongkirProduksi > 0 && Math.abs(rawTotal - (barangDariItem + ongkirProduksi)) <= 1;
      const barangTotal = rawTotalSudahTermasukOngkirProduksi ? Math.max(0, rawTotal - ongkirProduksi) : (barangDariItem > 0 ? barangDariItem : rawTotal);

      let invoiceOngkir = 0;
      if (ongkirKerudung > 0 && orderKey && !usedOrderOngkirKeys.has(orderKey)) {
        invoiceOngkir = ongkirKerudung;
        usedOrderOngkirKeys.add(orderKey);
      } else if (ongkirKerudung <= 0) {
        invoiceOngkir = ongkirProduksi;
      }

      return {
        ...batch,
        invoiceOngkir,
        barangTotal,
        total: Math.round(barangTotal + invoiceOngkir),
      };
    });

  const orderDeliveredTotalMap = allInvoiceBatches.reduce((map, batch) => {
    const key = batch.order?.id || batch.order?.invoice || batch.id;
    if (!key) return map;
    map.set(key, (map.get(key) || 0) + Number(batch.total || 0));
    return map;
  }, new Map());

  const orderInvoiceKey = (order, fallback = "") => String(order?.id || order?.invoice || fallback || "").trim();
  const getOrderFullDeliveredTotal = (order, fallback = "") => {
    const key = orderInvoiceKey(order, fallback);
    return Math.max(orderDeliveredTotalMap.get(key) || 0, invoiceOrderTotal(order));
  };
  const getOrderSisaBelumTerbayar = (order, fallback = "") => {
    const totalKirimOrder = getOrderFullDeliveredTotal(order, fallback);
    return Math.max(totalKirimOrder - invoiceOrderPaid(order), 0);
  };

  const batchAllocationDirectTransferRows = (transfers || [])
    .filter((pay) => normalizeName(pay.customer) === normalizeName(customerName) && moneyValue(pay.amount || 0) > 0)
    .map((pay) => ({
      date: pay.date || pay.createdAt?.slice?.(0, 10) || "",
      createdAt: pay.createdAt || "",
      rowNo: pay.id || "",
      note: pay.bank || pay.note || "Pembayaran customer",
      amount: moneyValue(pay.amount || 0),
    }));

  const batchAllocationFallbackPaymentRows = allCustomerOrders
    .flatMap((order) => getOrderPayments(order).map((pay) => ({
      date: pay.date || "",
      createdAt: pay.createdAt || "",
      rowNo: pay.id || pay.transferId || "",
      note: pay.note || pay.transferNote || "Pembayaran customer",
      amount: moneyValue(pay.transferAmount || pay.amount || 0),
      transferId: pay.transferId || "",
    })))
    .filter((row) => Number(row.amount || 0) > 0)
    .reduce((map, row) => {
      const key = row.transferId || `${row.date}__${row.note}__${row.amount}`;
      if (!map.has(key)) map.set(key, row);
      return map;
    }, new Map());

  const batchAllocationRawPaymentRows = batchAllocationDirectTransferRows.length > 0
    ? batchAllocationDirectTransferRows
    : Array.from(batchAllocationFallbackPaymentRows.values());

  // FINAL RULE 2026-06-09:
  // Tagihan invoice harus sesuai pengiriman, bukan sesuai total pesanan/order.
  // Karena pembayaran customer tidak menempel ke batch kirim tertentu, alokasi sisa invoice
  // dibuat FIFO terhadap batch pengiriman: pembayaran melunasi pengiriman paling lama dulu.
  // Dengan begitu filter tanggal dan filter Belum Lunas hanya menghitung sisa dari barang
  // yang benar-benar sudah dikirim pada tanggal/batch yang tampil.
  const sortedAllInvoiceBatchesForPayment = [...allInvoiceBatches]
    .filter((batch) => Number(batch.total || 0) > 0)
    .sort((a, b) => {
      const dateDiff = dateSerial(a.dateKey || "") - dateSerial(b.dateKey || "");
      if (dateDiff !== 0) return dateDiff;
      const invDiff = String(a.order?.invoice || a.order?.id || "").localeCompare(String(b.order?.invoice || b.order?.id || ""));
      if (invDiff !== 0) return invDiff;
      return String(a.id || "").localeCompare(String(b.id || ""));
    })
    .map((batch) => ({ ...batch, remainingForPayment: Math.max(0, Math.round(Number(batch.total || 0))) }));

  const invoiceBatchPaymentMap = new Map();
  const paymentRowsForBatchAllocation = [...batchAllocationRawPaymentRows]
    .filter((row) => moneyValue(row.amount || 0) > 0)
    .sort((a, b) => {
      const dateDiff = dateSerial(a.date || "") - dateSerial(b.date || "");
      if (dateDiff !== 0) return dateDiff;
      return String(a.createdAt || a.rowNo || "").localeCompare(String(b.createdAt || b.rowNo || ""));
    });

  let batchPaymentIndex = 0;
  paymentRowsForBatchAllocation.forEach((payment) => {
    let paymentLeft = moneyValue(payment.amount || 0);
    while (paymentLeft > 0 && batchPaymentIndex < sortedAllInvoiceBatchesForPayment.length) {
      const batch = sortedAllInvoiceBatchesForPayment[batchPaymentIndex];
      if (batch.remainingForPayment <= 0) {
        batchPaymentIndex += 1;
        continue;
      }
      const paid = Math.min(paymentLeft, batch.remainingForPayment);
      if (paid > 0) {
        invoiceBatchPaymentMap.set(batch.id, (invoiceBatchPaymentMap.get(batch.id) || 0) + paid);
        batch.remainingForPayment = Math.max(0, batch.remainingForPayment - paid);
        paymentLeft = Math.max(0, paymentLeft - paid);
      }
      if (batch.remainingForPayment <= 0) batchPaymentIndex += 1;
    }
  });

  const getInvoiceBatchPaid = (batch) => Math.round(invoiceBatchPaymentMap.get(batch.id) || 0);
  const getInvoiceBatchSisa = (batch) => Math.max(Math.round(Number(batch.total || 0)) - getInvoiceBatchPaid(batch), 0);

  const representedOrderIds = new Set();
  const invoiceBatches = allInvoiceBatches
    .filter((batch) => isDateKeyInRange(batch.dateKey, startDate, endDate))
    .sort((a, b) => `${a.dateKey || "9999-99-99"}-${a.order?.invoice || ""}`.localeCompare(`${b.dateKey || "9999-99-99"}-${b.order?.invoice || ""}`))
    .filter((batch) => {
      representedOrderIds.add(batch.order?.id || batch.order?.invoice || batch.id);
      const batchSisa = getInvoiceBatchSisa(batch);
      if (statusFilter === "belum") return batchSisa > 0;
      if (statusFilter === "lunas") return batchSisa <= 0;
      return true;
    });

  const customerOrders = Array.from(new Map(invoiceBatches.map((batch) => [batch.order?.id || batch.order?.invoice || batch.id, batch.order])).values());

  const invoiceGroups = Object.values(invoiceBatches.reduce((map, batch) => {
    const key = batch.dateKey || "tanpa-tanggal";
    if (!map[key]) map[key] = { dateKey: key, batches: [], total: 0 };
    map[key].batches.push(batch);
    map[key].total += Number(batch.total || 0);
    return map;
  }, {})).sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));

  const totalTagihan = invoiceBatches.reduce((s, batch) => s + Number(batch.total || 0), 0);

  const customerTagihanRows = allCustomerOrders
    .map((order) => ({
      order,
      date: order?.date || order?.createdAt || order?.tanggal || "",
      invoice: order?.invoice || order?.id || "-",
      tagihan: Math.max(orderDeliveredTotalMap.get(order?.id || order?.invoice || "") || 0, invoiceOrderTotal(order)),
    }))
    .filter((row) => Number(row.tagihan || 0) > 0)
    .sort((a, b) => `${a.date || "9999-99-99"}-${a.invoice}`.localeCompare(`${b.date || "9999-99-99"}-${b.invoice}`));

  const directTransferRows = (transfers || [])
    .filter((pay) => normalizeName(pay.customer) === normalizeName(customerName) && moneyValue(pay.amount || 0) > 0)
    .map((pay) => ({
      date: pay.date || pay.createdAt?.slice?.(0, 10) || "",
      note: pay.bank || pay.note || "Pembayaran customer",
      amount: moneyValue(pay.amount || 0),
    }));

  const fallbackPaymentRows = allCustomerOrders
    .flatMap((order) => getOrderPayments(order).map((pay) => ({
      date: pay.date || "",
      note: pay.note || pay.transferNote || "Pembayaran customer",
      amount: moneyValue(pay.transferAmount || pay.amount || 0),
      transferId: pay.transferId || "",
    })))
    .filter((row) => Number(row.amount || 0) > 0)
    .reduce((map, row) => {
      const key = row.transferId || `${row.date}__${row.note}__${row.amount}`;
      if (!map.has(key)) map.set(key, row);
      return map;
    }, new Map());

  const rawPaymentRows = directTransferRows.length > 0 ? directTransferRows : Array.from(fallbackPaymentRows.values());
  const paymentDetailRows = rawPaymentRows
    .map((row, idx) => ({
      ...row,
      rowNo: idx + 1,
      date: row.date || "tanpa-tanggal",
      amount: moneyValue(row.amount || 0),
    }))
    .sort((a, b) => `${a.date || "9999-99-99"}-${String(a.rowNo).padStart(4, "0")}`.localeCompare(`${b.date || "9999-99-99"}-${String(b.rowNo).padStart(4, "0")}`));
  const latestPaymentRows = paymentDetailRows.slice(-3).reverse();
  const latestPayment = latestPaymentRows[0] || null;

  // FINAL AUDIT RULE:
  // Total tagihan invoice harus mengikuti baris invoice yang sedang tampil.
  // Jika baris resmi tidak tersedia, baru fallback ke kalkulator parent yang sama dengan kartu customer/FIFO.
  const fallbackTagihanCustomer = overrideTotalTagihan !== null
    ? moneyValue(overrideTotalTagihan || 0)
    : allCustomerOrders.reduce((s, o) => s + Math.max(0, invoiceOrderTotal(o)), 0);
  const totalTagihanCustomerKeseluruhan = totalTagihan > 0
    ? Math.round(totalTagihan)
    : Math.round(fallbackTagihanCustomer);
  const totalBayarCustomerKeseluruhan = overrideTotalBayar !== null
    ? Math.round(moneyValue(overrideTotalBayar || 0))
    : rawPaymentRows.reduce((s, row) => s + Number(row.amount || 0), 0);
  // overrideTotalSisa dari parent (App scope) adalah sumber paling akurat —
  // dihitung dari FIFO yang sama dengan kartu customer. Selalu dipakai jika tersedia.
  // Fallback ke kalkulasi lokal hanya jika parent tidak mengirim override.
  const totalSisaCustomerKeseluruhan = overrideTotalSisa !== null
    ? Math.round(moneyValue(overrideTotalSisa || 0))
    : Math.max(totalTagihanCustomerKeseluruhan - totalBayarCustomerKeseluruhan, 0);
  const hasScopedInvoiceFilter = Boolean(startDate || endDate) || statusFilter === "belum";
  const visibleSisaBelumTerbayar = invoiceBatches.reduce((sum, batch) => sum + getInvoiceBatchSisa(batch), 0);
  const totalBayar = totalBayarCustomerKeseluruhan;
  // AUDIT FIX: totalSisa selalu pakai overrideTotalSisa dari App scope (= c.sisa di kartu customer).
  // visibleSisaBelumTerbayar tidak dipakai karena FIFO batch modal beda scope dengan FIFO App,
  // sehingga angkanya selalu berbeda dari kartu customer. Konsistensi lebih penting dari visibilitas per filter.
  const totalSisa = totalSisaCustomerKeseluruhan;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setImgUrl(null);

    const formatTgl = (str) => {
      if (!str) return "-";
      const dp = String(str).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dp)) return dp || "-";
      const d = new Date(dp + "T00:00:00");
      if (isNaN(d.getTime())) return dp;
      return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
    };
    const trunc = (s, n = 32) => {
      const t = String(s || "");
      return t.length > n ? t.slice(0, n - 1) + "\u2026" : t;
    };

    // Satu invoice = satu customer + satu tanggal kirim.
    // Semua pesanan customer pada tanggal yang sama digabung, tanpa label Pesanan #1/#2.
    // Jika produk yang sama dikirim dari beberapa order pada hari yang sama, qty dan nominalnya dijumlahkan.
    const groupsByDate = new Map();
    invoiceGroups.forEach((group) => {
      const dateKey = group.dateKey || "tanpa-tanggal";
      const label = formatTgl(dateKey);
      if (!groupsByDate.has(dateKey)) {
        groupsByDate.set(dateKey, { dateKey, label, itemMap: new Map(), total: 0, qty: 0 });
      }
      const target = groupsByDate.get(dateKey);
      group.batches.forEach((batch) => {
        // Ongkir invoice sudah dihitung satu sumber di batch.invoiceOngkir.
        // Tampilkan sebagai satu baris "Ongkir" saja.
        const batchOngkir = moneyValue(batch.invoiceOngkir || 0);
        if (batchOngkir > 0) {
          const ongkirKey = `__ongkir__|${batch.id || batch.dateKey || batchOngkir}`;
          const existing = target.itemMap.get(ongkirKey) || { name: "Ongkir", shippedQty: 1, price: batchOngkir, subtotal: 0, isOngkir: true };
          existing.subtotal += batchOngkir;
          target.itemMap.set(ongkirKey, existing);
          target.total += batchOngkir;
        }
        (batch.items || []).forEach((it) => {
          const shippedQty = Number(it.shippedQty || 0);
          if (shippedQty <= 0) return;
          const name = String(it.name || it.nama || it.productName || "Pesanan").trim() || "Pesanan";
          const price = Number(moneyValue(it.price ?? it.harga ?? it.unitPrice ?? it.sellingPrice ?? 0) || 0) || lookupMasterPrice(name);
          const subtotal = shippedQty * price;
          const rowKey = `${normalizeName(name)}|${price}`;
          const existing = target.itemMap.get(rowKey) || { name, shippedQty: 0, price, subtotal: 0 };
          existing.shippedQty += shippedQty;
          existing.subtotal += subtotal;
          target.itemMap.set(rowKey, existing);
          target.qty += shippedQty;
          target.total += subtotal;
        });
      });
    });

    const dateGroups = Array.from(groupsByDate.values())
      .map((group) => ({
        ...group,
        rows: Array.from(group.itemMap.values()).sort((a, b) => {
          // Ongkir selalu di bawah semua produk, baru diurutkan alphabetical antar produk
          if (a.isOngkir && !b.isOngkir) return 1;
          if (!a.isOngkir && b.isOngkir) return -1;
          return a.name.localeCompare(b.name, "id");
        }),
      }))
      .sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));
    const rowsCount = dateGroups.reduce((sum, group) => sum + group.rows.length, 0);

    const C = {
      bg: "#FFFFFF",
      pageBg: "#FFF7FB",
      title: "#111827",
      body: "#1F2937",
      muted: "#64748B",
      border: "#E5E7EB",
      borderStrong: "#F9A8D4",
      accent: "#DB2777",
      accentDark: "#9D174D",
      accentSoft: "#FCE7F3",
      green: "#059669",
      greenSoft: "#D1FAE5",
      redSoft: "#FFE4E6",
      graySoft: "#F8FAFC",
      tableText: "#0F172A",
      white: "#FFFFFF",
    };

    const W = 1440;
    const PAD = 56;
    const headerH = 155;
    const infoH = 78;
    const tableHeadH = 36;
    const rowH = 36;
    const summaryH = 125;
    const isBelumLunasInvoice = statusFilter === "belum";
    // Saat filter Belum Lunas dipilih, invoice difokuskan ke tagihan yang masih perlu ditagih.
    // Nominal pembayaran customer disembunyikan agar tidak muncul dua angka besar yang membingungkan.
    const showCustomerSummary = !isBelumLunasInvoice;
    const showPaymentSummary = !isBelumLunasInvoice;
    const summaryEffectiveH = showCustomerSummary ? summaryH : 0;
    const paymentSummaryTitleH = showPaymentSummary ? 40 : 0;
    const paymentSummaryHeadH = showPaymentSummary ? 64 : 0;
    const paymentSummaryRecentTitleH = showPaymentSummary && paymentDetailRows.length > 0 ? 30 : 0;
    const paymentSummaryRowH = showPaymentSummary ? 30 : 0;
    const paymentSummaryFooterH = showPaymentSummary ? 38 : 0;
    const paymentSummaryRowsH = showPaymentSummary
      ? (paymentDetailRows.length > 0 ? latestPaymentRows.length * paymentSummaryRowH : paymentSummaryRowH)
      : 0;
    const paymentSummaryCardH = showPaymentSummary
      ? paymentSummaryHeadH + paymentSummaryRecentTitleH + paymentSummaryRowsH + paymentSummaryFooterH + 18
      : 0;
    const paymentDetailH = showPaymentSummary ? paymentSummaryTitleH + paymentSummaryCardH + 22 : 0;
    const footerH = 48;
    // Flat rows: semua item dari semua tanggal digabung dalam satu tabel
    const flatRows = dateGroups.flatMap((group) =>
      group.rows.map((row) => ({ ...row, dateLabel: group.label }))
    );
    const totalFlatRows = Math.max(1, flatRows.length);
    const grandTotalNominalPreview = flatRows.reduce((sum, r) => sum + Number(r.subtotal || 0), 0);
    // Baris kelebihan bayar dihapus — hanya sisa tagihan yang ditampilkan
    const kelebihanBayarH = (totalSisa > 0) ? 32 : 0;
    const contentRowsH = tableHeadH + totalFlatRows * rowH + rowH + kelebihanBayarH + 18;
    const H = Math.max(420, headerH + infoH + 42 + contentRowsH + summaryEffectiveH + paymentDetailH + footerH + 36);
    const DPR = 2;

    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(DPR, DPR);
    ctx.textBaseline = "alphabetic";

    const roundRect = (x, y, w, h, r, fill, stroke) => {
      const radius = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + w - radius, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
      ctx.lineTo(x + w, y + h - radius);
      ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
      ctx.lineTo(x + radius, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
      if (fill) ctx.fill();
      if (stroke) ctx.stroke();
    };
    const drawShadowCard = (x, y, w, h, r, fill = C.white, stroke = C.border) => {
      ctx.save();
      ctx.shadowColor = "rgba(15, 23, 42, 0.08)";
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = fill;
      roundRect(x, y, w, h, r, true, false);
      ctx.restore();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      roundRect(x, y, w, h, r, false, true);
    };
    const line = (x1, y1, x2, y2, color = C.border, width = 1) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };

    ctx.fillStyle = C.pageBg;
    ctx.fillRect(0, 0, W, H);

    const headerGradient = ctx.createLinearGradient(0, 0, W, headerH);
    headerGradient.addColorStop(0, "#FCE7F3");
    headerGradient.addColorStop(0.55, "#FDF2F8");
    headerGradient.addColorStop(1, "#FFF7ED");
    ctx.fillStyle = headerGradient;
    ctx.fillRect(0, 0, W, headerH);

    ctx.fillStyle = "rgba(219, 39, 119, 0.10)";
    ctx.beginPath();
    ctx.arc(W - 120, 12, 150, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(168, 85, 247, 0.08)";
    ctx.beginPath();
    ctx.arc(W - 300, 138, 95, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = C.accent;
    ctx.font = "800 32px Arial";
    ctx.textAlign = "left";
    ctx.fillText("Gallery Kerudung", PAD, 54);
    ctx.fillStyle = C.title;
    ctx.font = "900 48px Arial";
    ctx.fillText("Invoice Pengiriman", PAD, 108);

    const chipW = 220;
    drawShadowCard(W - PAD - chipW, 34, chipW, 68, 18, "rgba(255,255,255,0.88)", "rgba(249,168,212,0.9)");
    ctx.textAlign = "right";
    ctx.fillStyle = C.muted;
    ctx.font = "600 14px Arial";
    ctx.fillText(`Dicetak: ${today}`, W - PAD - 14, 58);
    ctx.fillStyle = C.accentDark;
    ctx.font = "800 16px Arial";
    ctx.fillText("087822864625", W - PAD - 14, 84);

    let curY = headerH + 24;
    const infoGap = 18;
    const infoW = (W - PAD * 2 - infoGap) / 2;
    drawShadowCard(PAD, curY, infoW, infoH, 18, C.white, C.border);
    drawShadowCard(PAD + infoW + infoGap, curY, infoW, infoH, 18, C.white, C.border);

    ctx.textAlign = "left";
    ctx.fillStyle = C.muted;
    ctx.font = "800 13px Arial";
    ctx.fillText("CUSTOMER", PAD + 16, curY + 26);
    ctx.fillStyle = C.title;
    ctx.font = "900 24px Arial";
    ctx.fillText(trunc(customerName, 34), PAD + 16, curY + 58);

    ctx.textAlign = "right";
    ctx.fillStyle = C.muted;
    ctx.font = "800 13px Arial";
    ctx.fillText("PERIODE", W - PAD - 16, curY + 26);
    ctx.fillStyle = C.title;
    ctx.font = "900 20px Arial";
    const statusText = statusFilter === "belum" ? "Belum Lunas" : statusFilter === "lunas" ? "Lunas" : "Semua";
    ctx.fillText(periodLabel || statusText || `${customerOrders.length} pesanan`, W - PAD - 16, curY + 58);
    curY += infoH + 24;

    const tableX = PAD;
    const tableW = W - PAD * 2;
    const colDate = tableX + 24;
    const colProduct = tableX + 230;
    const colPrice = tableX + 820;
    const colQty = tableX + 1020;
    const colSubtotal = tableX + tableW - 24;
    const colDateEnd = tableX + 208;
    const colProductEnd = tableX + 710;
    const colPriceEnd = tableX + 890;
    const colQtyEnd = tableX + 1080;
    const tableGridLines = [colDateEnd, colProductEnd, colPriceEnd, colQtyEnd];

    const drawTableHead = () => {
      const g = ctx.createLinearGradient(tableX, curY, tableX + tableW, curY);
      g.addColorStop(0, C.accentDark);
      g.addColorStop(1, C.accent);
      ctx.fillStyle = g;
      ctx.fillRect(tableX, curY, tableW, tableHeadH);
      tableGridLines.forEach((x) => line(x, curY, x, curY + tableHeadH, "rgba(255,255,255,0.45)", 1));
      ctx.fillStyle = C.white;
      ctx.font = "900 14px Arial";
      ctx.textAlign = "left";
      ctx.fillText("Tanggal", colDate, curY + 23);
      ctx.fillText("Nama Produk", colProduct, curY + 23);
      ctx.textAlign = "right";
      ctx.fillText("Harga Satuan", colPrice, curY + 23);
      ctx.fillText("Jumlah Dikirim", colQty, curY + 23);
      ctx.fillText("Total", colSubtotal, curY + 23);
      line(tableX, curY + tableHeadH, tableX + tableW, curY + tableHeadH, C.borderStrong, 1.2);
      curY += tableHeadH;
    };

    if (flatRows.length === 0) {
      drawShadowCard(tableX, curY, tableW, tableHeadH + rowH, 18, C.white, C.border);
      drawTableHead();
      ctx.fillStyle = C.muted;
      ctx.font = "600 14px Arial";
      ctx.textAlign = "center";
      ctx.fillText("Tidak ada data pengiriman pada periode ini.", W / 2, curY + 22);
      curY += rowH + 18;
    } else {
      drawShadowCard(tableX, curY, tableW, tableHeadH + flatRows.length * rowH, 18, C.white, C.border);
      drawTableHead();
      let prevDate = null;
      flatRows.forEach((row, idx) => {
        const isNewDate = row.dateLabel !== prevDate;
        ctx.fillStyle = idx % 2 === 0 ? C.white : "#FDF2F8";
        ctx.fillRect(tableX, curY, tableW, rowH);
        line(tableX, curY + rowH, tableX + tableW, curY + rowH, C.border, 1);
        tableGridLines.forEach((x) => line(x, curY, x, curY + rowH, C.border, 1));

        // Kolom tanggal — tampilkan hanya di baris pertama grup tanggal. Border grid membuat baris lanjutan tetap mudah diikuti.
        if (isNewDate) {
          ctx.fillStyle = C.accentDark;
          ctx.font = "900 13px Arial";
          ctx.textAlign = "left";
          ctx.fillText(row.dateLabel, colDate, curY + 23);
          prevDate = row.dateLabel;
        }

        if (row.isOngkir) {
          // Baris ongkir — ditampilkan italic/muted, tanpa kolom harga satuan dan qty
          ctx.fillStyle = C.muted;
          ctx.font = "600 13px Arial";
          ctx.textAlign = "left";
          ctx.fillText("Ongkir", colProduct, curY + 23);
          ctx.textAlign = "right";
          ctx.fillStyle = C.body;
          ctx.font = "700 13px Arial";
          ctx.fillText("-", colPrice, curY + 23);
          ctx.fillStyle = C.muted;
          ctx.font = "700 13px Arial";
          ctx.fillText("-", colQty - 6, curY + 23);
          ctx.fillStyle = C.accent;
          ctx.font = "900 14px Arial";
          ctx.fillText(rupiah(row.subtotal || 0), colSubtotal, curY + 23);
        } else {
          ctx.fillStyle = C.tableText;
          ctx.font = "700 14px Arial";
          ctx.textAlign = "left";
          ctx.fillText(trunc(row.name, 42), colProduct, curY + 23);

          ctx.textAlign = "right";
          ctx.fillStyle = row.price > 0 ? C.body : C.muted;
          ctx.font = row.price > 0 ? "700 13px Arial" : "600 12px Arial";
          ctx.fillText(row.price > 0 ? rupiah(row.price) : "— harga belum diisi", colPrice, curY + 23);

          ctx.fillStyle = C.accentSoft;
          roundRect(colQty - 82, curY + 7, 82, 22, 11, true, false);
          ctx.fillStyle = C.accentDark;
          ctx.font = "800 13px Arial";
          ctx.fillText(`${Number(row.shippedQty || 0).toLocaleString("id-ID")} pcs`, colQty - 6, curY + 23);

          ctx.fillStyle = C.accent;
          ctx.font = "900 14px Arial";
          ctx.fillText(rupiah(row.subtotal || 0), colSubtotal, curY + 23);
        }
        curY += rowH;
      });

      // Baris Grand Total
      const grandTotalQty = flatRows
        .filter((r) => !r.isOngkir)
        .reduce((sum, r) => sum + Number(r.shippedQty || 0), 0);
      const grandTotalNominal = flatRows.reduce((sum, r) => sum + Number(r.subtotal || 0), 0);

      const grandTotalH = rowH;
      ctx.fillStyle = C.accentDark;
      ctx.fillRect(tableX, curY, tableW, grandTotalH);
      line(tableX, curY, tableX + tableW, curY, C.borderStrong, 1.5);
      tableGridLines.forEach((x) => line(x, curY, x, curY + grandTotalH, "rgba(255,255,255,0.25)", 1));

      ctx.fillStyle = C.white;
      ctx.font = "900 14px Arial";
      ctx.textAlign = "left";
      ctx.fillText("GRAND TOTAL", colProduct, curY + 23);

      ctx.textAlign = "right";
      ctx.fillStyle = C.white;
      ctx.font = "800 13px Arial";
      ctx.fillText(`${grandTotalQty.toLocaleString("id-ID")} pcs`, colQty - 6, curY + 23);

      ctx.font = "900 14px Arial";
      ctx.fillText(rupiah(grandTotalNominal), colSubtotal, curY + 23);

      curY += grandTotalH;

      {
        const subRowH = 32;
        const subX = tableX + tableW * 0.38;
        const subW = tableW * 0.62;
        const subRows = [
          { label: "Total Tagihan Keseluruhan", value: rupiah(totalTagihanCustomerKeseluruhan), bg: "#F3F4F6", labelColor: "#6B7280", valueColor: "#1F2937" },
          ...(isBelumLunasInvoice ? [] : [{ label: "Sudah Dibayar", value: rupiah(totalBayar), bg: "#F0FDF4", labelColor: "#16A34A", valueColor: "#16A34A" }]),
          { label: totalSisa > 0 ? "Sisa Tagihan" : "Status", value: totalSisa > 0 ? rupiah(totalSisa) : "Lunas ✅", bg: totalSisa > 0 ? C.redSoft : "#F0FDF4", labelColor: totalSisa > 0 ? C.accent : "#16A34A", valueColor: totalSisa > 0 ? C.accent : "#16A34A" },
        ];
        subRows.forEach(({ label, value, bg, labelColor, valueColor }) => {
          ctx.fillStyle = bg;
          ctx.fillRect(subX, curY, subW, subRowH);
          line(subX, curY, subX + subW, curY, C.border, 0.8);
          ctx.textAlign = "left";
          ctx.fillStyle = labelColor;
          ctx.font = "700 12px Arial";
          ctx.fillText(label, subX + 16, curY + 20);
          ctx.textAlign = "right";
          ctx.fillStyle = valueColor;
          ctx.font = "900 13px Arial";
          ctx.fillText(value, colSubtotal, curY + 20);
          curY += subRowH;
        });
      }

      curY += 18;
    }

    if (showCustomerSummary) {
      curY += 4;
      ctx.fillStyle = C.title;
      ctx.font = "900 20px Arial";
      ctx.textAlign = "left";
      ctx.fillText("Ringkasan Customer", PAD, curY + 4);
      curY += 14;

      const summaryGap = 16;
      const summaryY = curY + 12;
      const summaries = [
        { label: "Total Tagihan", value: rupiah(totalTagihanCustomerKeseluruhan || 0), bg: C.graySoft, color: C.title },
        { label: "Realisasi Pembayaran", value: rupiah(totalBayar || 0), bg: C.greenSoft, color: C.green },
        { label: totalSisa > 0 ? "Sisa Tagihan" : "Status Pembayaran", value: totalSisa > 0 ? rupiah(totalSisa || 0) : "Lunas ✅", bg: totalSisa > 0 ? C.redSoft : C.greenSoft, color: totalSisa > 0 ? C.accent : C.green, strong: true },
      ];
      const summaryCardW = summaries.length === 1
        ? W - PAD * 2
        : (W - PAD * 2 - summaryGap * (summaries.length - 1)) / summaries.length;
      summaries.forEach((item, i) => {
        const x = PAD + i * (summaryCardW + summaryGap);
        drawShadowCard(x, summaryY, summaryCardW, summaryH - 24, 18, item.bg, item.strong ? C.borderStrong : C.border);
        ctx.textAlign = "left";
        ctx.fillStyle = C.muted;
        ctx.font = "900 13px Arial";
        ctx.fillText(item.label, x + 18, summaryY + 30);
        ctx.fillStyle = item.color;
        ctx.font = "900 21px Arial";
        ctx.fillText(item.value, x + 18, summaryY + 66);
      });
      curY += summaryH + 12;
    }

    if (showPaymentSummary) {
      ctx.fillStyle = C.title;
      ctx.font = "900 19px Arial";
      ctx.textAlign = "left";
      ctx.fillText("Ringkasan Pembayaran", PAD, curY + 8);
      curY += paymentSummaryTitleH;

      drawShadowCard(PAD, curY, W - PAD * 2, paymentSummaryCardH, 18, C.white, C.border);
      const payCardX = PAD;
      const payCardW = W - PAD * 2;
      const payPad = 20;
      const payColW = (payCardW - payPad * 2) / 3;
      const payTop = curY + 18;
      const paymentSummaryItems = [
        { label: "Total Sudah Dibayar", value: rupiah(totalBayar || 0), color: C.green },
        { label: "Jumlah Transaksi", value: `${paymentDetailRows.length.toLocaleString("id-ID")}x`, color: C.title },
        { label: "Pembayaran Terakhir", value: latestPayment ? `${formatTgl(latestPayment.date)} - ${rupiah(latestPayment.amount || 0)}` : "Belum ada", color: latestPayment ? C.green : C.muted },
      ];
      paymentSummaryItems.forEach((item, i) => {
        const x = payCardX + payPad + i * payColW;
        if (i > 0) line(x, payTop - 4, x, payTop + paymentSummaryHeadH - 6, C.border, 1);
        ctx.textAlign = "left";
        ctx.fillStyle = C.muted;
        ctx.font = "900 12px Arial";
        ctx.fillText(item.label, x + (i > 0 ? 16 : 0), payTop + 16);
        ctx.fillStyle = item.color;
        ctx.font = i === 2 ? "900 15px Arial" : "900 20px Arial";
        ctx.fillText(trunc(item.value, i === 2 ? 36 : 24), x + (i > 0 ? 16 : 0), payTop + 46);
      });
      curY += paymentSummaryHeadH + 18;
      line(PAD + 20, curY - 4, W - PAD - 20, curY - 4, C.border, 1);

      if (paymentDetailRows.length === 0) {
        ctx.fillStyle = C.muted;
        ctx.font = "700 14px Arial";
        ctx.textAlign = "left";
        ctx.fillText("Belum ada realisasi pembayaran yang tercatat.", PAD + 20, curY + 22);
        curY += paymentSummaryRowH;
      } else {
        ctx.fillStyle = C.title;
        ctx.font = "900 14px Arial";
        ctx.textAlign = "left";
        ctx.fillText("3 Pembayaran Terakhir", PAD + 20, curY + 20);
        ctx.fillStyle = C.muted;
        ctx.font = "700 12px Arial";
        ctx.textAlign = "right";
        ctx.fillText("Detail lengkap tersimpan di riwayat pembayaran customer.", W - PAD - 20, curY + 20);
        curY += paymentSummaryRecentTitleH;

        latestPaymentRows.forEach((row, idx) => {
          const rowY = curY;
          ctx.fillStyle = idx % 2 === 0 ? C.white : C.graySoft;
          ctx.fillRect(PAD + 20, rowY, W - PAD * 2 - 40, paymentSummaryRowH);
          line(PAD + 20, rowY + paymentSummaryRowH, W - PAD - 20, rowY + paymentSummaryRowH, C.border, 1);
          ctx.fillStyle = C.body;
          ctx.font = "800 13px Arial";
          ctx.textAlign = "left";
          ctx.fillText(formatTgl(row.date), PAD + 30, rowY + 21);
          ctx.fillStyle = C.green;
          ctx.font = "900 14px Arial";
          ctx.textAlign = "right";
          ctx.fillText(rupiah(row.amount || 0), W - PAD - 30, rowY + 21);
          curY += paymentSummaryRowH;
        });
      }

      ctx.fillStyle = C.accentSoft;
      ctx.fillRect(PAD + 20, curY + 8, W - PAD * 2 - 40, paymentSummaryFooterH);
      ctx.fillStyle = C.accentDark;
      ctx.font = "900 13px Arial";
      ctx.textAlign = "left";
      ctx.fillText("Invoice ini mencakup seluruh barang yang sudah dikirim. Pembayaran otomatis mengurangi total tagihan customer.", PAD + 34, curY + 33);
      curY += paymentSummaryFooterH + 18;

      curY += 18;
    }
    ctx.fillStyle = C.muted;
    ctx.font = "700 12px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Terima kasih — Gallery Kerudung", W / 2, curY + 10);

    setImgUrl(canvas.toDataURL("image/jpeg", 0.88));
  }, [customerName, orders, startDate, endDate, statusFilter, periodLabel, shipmentBatches, transfers, totalTagihanCustomerKeseluruhan, totalBayar, totalSisa, hasScopedInvoiceFilter, getOrderTagihan]);

  function downloadGambar() {
    if (!imgUrl) return;
    const safeName = customerName.replace(/\s+/g, "-").toLowerCase();
    const link = document.createElement("a");
    link.download = `invoice-${safeName}.jpg`;
    link.href = imgUrl;
    link.click();
  }

  async function shareGambar() {
    if (!imgUrl) return;
    try {
      const { jsPDF } = await loadPdfTools();
      const canvas = canvasRef.current;
      const imgW = canvas.width / (window.devicePixelRatio || 1);
      const imgH = canvas.height / (window.devicePixelRatio || 1);
      // A4 lebar 210mm, hitung tinggi proporsional
      const pdfW = 210;
      const pdfH = Math.round((imgH / imgW) * pdfW);
      const pdf = new jsPDF({ orientation: pdfH > pdfW ? "portrait" : "landscape", unit: "mm", format: [pdfW, pdfH] });
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, pdfW, pdfH);
      const safeName = customerName.replace(/\s+/g, "-").toLowerCase();
      const pdfBlob = pdf.output("blob");
      const file = new File([pdfBlob], `invoice-${safeName}.pdf`, { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `Invoice ${customerName}`, text: `Rincian pesanan ${customerName} dari Gallery Kerudung 💕` });
      } else {
        const url = URL.createObjectURL(pdfBlob);
        const link = document.createElement("a");
        link.download = `invoice-${safeName}.pdf`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        // fallback ke gambar
        const safeName = customerName.replace(/\s+/g, "-").toLowerCase();
        const link = document.createElement("a");
        link.download = `invoice-${safeName}.jpg`;
        link.href = imgUrl;
        link.click();
      }
    }
  }

  return (
    <SimpleModal title={`Invoice — ${customerName}`} onClose={onClose}>
      <div style={{ maxWidth: "700px", margin: "0 auto" }}>
      <canvas ref={canvasRef} className="hidden" />

      {customerOrders.length === 0 && (
        <div className="rounded-xl px-4 py-6 text-center text-sm" style={{ background: "#f9fafb", color: "#94a3b8" }}>
          Tidak ada pesanan sesuai periode dan filter status untuk <strong>{customerName}</strong>.
        </div>
      )}

      {!imgUrl && customerOrders.length > 0 && (
        <div className="flex items-center justify-center py-10 gap-3">
          <div className="w-5 h-5 border-2 border-pink-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-slate-500">Membuat invoice...</span>
        </div>
      )}
      {imgUrl && (
        <div className="space-y-3">
          <img src={imgUrl} alt="invoice" className="w-full rounded-2xl border border-slate-100" />
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => setInvoiceAction("download")} className="w-full" style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>⬇️ Download</Button>
            <Button onClick={() => setInvoiceAction("share")} className="w-full" style={{ background: "linear-gradient(135deg,#10b981,#25d366)" }}>📤 Kirim WA</Button>
          </div>
        </div>
      )}
      {invoiceAction && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-6">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl">
            <div className="text-xl font-bold text-slate-800 mb-2">
              {invoiceAction === "download" ? "Download Invoice?" : "Kirim Invoice ke WhatsApp?"}
            </div>
            <div className="text-slate-500 text-sm mb-5">
              Invoice atas nama <strong>{customerName}</strong> akan {invoiceAction === "download" ? "diunduh sebagai gambar." : "dibagikan lewat menu share/WhatsApp."}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setInvoiceAction(null)} className="flex-1 rounded-2xl border border-slate-200 py-3 font-semibold text-slate-600">Batal</button>
              <button
                onClick={() => { const action = invoiceAction; setInvoiceAction(null); if (action === "download") downloadGambar(); else shareGambar(); }}
                className="flex-1 rounded-2xl py-3 font-semibold text-white"
                style={{ background: invoiceAction === "download" ? "linear-gradient(135deg,#7c3aed,#a855f7)" : "linear-gradient(135deg,#10b981,#25d366)" }}>
                Ya, lanjut
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </SimpleModal>
  );
}

// ─── Grafik Kas ──────────────────────────────────────────────────────────────
function GrafikKas({ transfers, transfersOut, expenses }) {
  const BLN = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"];
  const data = useMemo(() => {
    const map = {};
    const getKey = (d) => {
      if (!d) return todayStr().slice(0, 7);
      const raw = d.includes("T") ? d : d + "T00:00:00";
      const date = new Date(raw);
      const safeDate = isNaN(date.getTime()) ? new Date() : date;
      return `${safeDate.getFullYear()}-${String(safeDate.getMonth() + 1).padStart(2, "0")}`;
    };
    (transfers || []).forEach((t) => {
      const k = getKey(t.date);
      if (!map[k]) map[k] = { bulan: k, masuk: 0, keluar: 0 };
      map[k].masuk += moneyValue(t.amount || 0);
    });
    (transfersOut || []).forEach((t) => {
      const k = getKey(t.date);
      if (!map[k]) map[k] = { bulan: k, masuk: 0, keluar: 0 };
      map[k].keluar += moneyValue(t.amount || 0);
    });
    expenses.forEach((e) => {
      const k = getKey(e.date);
      if (!map[k]) map[k] = { bulan: k, masuk: 0, keluar: 0 };
      map[k].keluar += moneyValue(e.amount || 0);
    });
    return Object.values(map).sort((a, b) => a.bulan.localeCompare(b.bulan)).slice(-6);
  }, [transfers, transfersOut, expenses]);

  if (data.length === 0) return null;

  const maxVal = Math.max(...data.flatMap((d) => [d.masuk, d.keluar]), 1);
  const H = 130;
  const fmt = (n) => n >= 1000000 ? (n/1000000).toFixed(1)+"jt" : n >= 1000 ? (n/1000).toFixed(0)+"rb" : n;

  return (
    <div className="mx-4 mb-4 rounded-3xl bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-1">
        <div className="font-bold text-slate-700">Kas Masuk vs Keluar</div>
        <div className="flex gap-3">
          <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-full bg-emerald-500"/><span className="text-xs text-slate-400">Masuk</span></div>
          <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-full bg-rose-400"/><span className="text-xs text-slate-400">Keluar</span></div>
        </div>
      </div>
      <div className="text-xs text-slate-400 mb-5">6 bulan terakhir</div>
      <div className="flex items-end gap-1.5 justify-between" style={{ height: H + 32 }}>
        {data.map((d) => {
          const hMasuk = Math.max(Math.round((d.masuk / maxVal) * H), d.masuk > 0 ? 4 : 0);
          const hKeluar = Math.max(Math.round((d.keluar / maxVal) * H), d.keluar > 0 ? 4 : 0);
          const bulanIdx = parseInt(d.bulan.slice(5)) - 1;
          const label = BLN[bulanIdx] || d.bulan.slice(5);
          const isMax = d.masuk === Math.max(...data.map(x => x.masuk));
          return (
            <div key={d.bulan} className="flex flex-col items-center flex-1 gap-1">
              <div className="flex items-end gap-0.5 w-full justify-center" style={{ height: H }}>
                <div className="flex flex-col items-center gap-0.5" style={{ height: H, justifyContent: "flex-end" }}>
                  {d.masuk > 0 && <div className="text-xs font-semibold text-emerald-600" style={{ fontSize: 9 }}>{fmt(d.masuk)}</div>}
                  <div style={{ height: hMasuk || 2, width: 14, background: isMax ? "linear-gradient(to top, #059669, #34d399)" : "#6ee7b7", borderRadius: "4px 4px 2px 2px" }} />
                </div>
                <div className="flex flex-col items-center gap-0.5" style={{ height: H, justifyContent: "flex-end" }}>
                  {d.keluar > 0 && <div className="text-xs font-semibold text-rose-500" style={{ fontSize: 9 }}>{fmt(d.keluar)}</div>}
                  <div style={{ height: hKeluar || 2, width: 14, background: "#fca5a5", borderRadius: "4px 4px 2px 2px" }} />
                </div>
              </div>
              <div className="text-xs text-slate-400 font-medium">{label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GrafikPesanan({ orders }) {
  const BLN = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"];
  const data = useMemo(() => {
    const map = {};
    orders.forEach((o) => {
      const raw = o.createdAt || todayStr();
      const date = new Date(raw.includes("T") ? raw : raw + "T00:00:00");
      const safeDate = isNaN(date.getTime()) ? new Date() : date;
      const k = `${safeDate.getFullYear()}-${String(safeDate.getMonth() + 1).padStart(2, "0")}`;
      if (!map[k]) map[k] = { bulan: k, jumlah: 0, nilai: 0 };
      map[k].jumlah += 1;
      map[k].nilai += moneyValue(o.total || 0);
    });
    return Object.values(map).sort((a, b) => a.bulan.localeCompare(b.bulan)).slice(-6);
  }, [orders]);

  if (data.length === 0) return null;

  const maxJumlah = Math.max(...data.map((d) => d.jumlah), 1);
  const H = 130;
  const BAR_W = Math.min(36, Math.floor(280 / data.length) - 8);

  return (
    <div className="mx-4 mb-4 rounded-3xl bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-1">
        <div className="font-bold text-slate-700">Pesanan per Bulan</div>
        <div className="text-xs text-slate-400 bg-pink-50 text-pink-600 font-semibold px-2 py-1 rounded-full">
          Total {orders.length} pesanan
        </div>
      </div>
      <div className="text-xs text-slate-400 mb-5">6 bulan terakhir</div>
      <div className="flex items-end justify-around" style={{ height: H + 52, gap: 4 }}>
        {data.map((d) => {
          const hBar = Math.max(Math.round((d.jumlah / maxJumlah) * H), 4);
          const bulanIdx = parseInt(d.bulan.slice(5)) - 1;
          const label = BLN[bulanIdx] || d.bulan.slice(5);
          const isMax = d.jumlah === maxJumlah;
          const nilaiStr = d.nilai >= 1000000 ? (d.nilai/1000000).toFixed(1)+"jt" : (d.nilai/1000).toFixed(0)+"rb";
          return (
            <div key={d.bulan} className="flex flex-col items-center gap-1" style={{ minWidth: BAR_W }}>
              <div className="text-xs font-bold text-pink-600">{d.jumlah}</div>
              <div style={{
                height: hBar, width: BAR_W,
                background: isMax ? "linear-gradient(to top, #be185d, #f472b6)" : "linear-gradient(to top, #f9a8d4, #fce7f3)",
                borderRadius: "8px 8px 4px 4px", transition: "height 0.3s ease",
                boxShadow: isMax ? "0 4px 12px rgba(236,72,153,0.3)" : "none",
              }} />
              <div className="text-xs font-semibold text-slate-500">{label}</div>
              <div className="text-xs text-slate-400" style={{ fontSize: 9 }}>{nilaiStr}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────
export default function GalleryKerudungApp() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [firestoreError, setFirestoreError] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (u && ALLOWED_EMAILS.includes(u.email)) { setUser(u); setAuthError(""); }
      else if (u) { signOut(auth); setAuthError("Email " + u.email + " tidak diizinkan."); setUser(null); }
      else setUser(null);
      setAuthLoading(false);
    });
    return () => unsub();
  }, []);

  async function handleLogin() {
    if (loginLoading) return;

    setLoginLoading(true);
    try {
      setAuthError("");
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (e) {
      const code = e?.code || "";
      if (code === "auth/cancelled-popup-request" || code === "auth/popup-closed-by-user") {
        setAuthError("Login dibatalkan. Refresh halaman lalu klik Masuk dengan Google satu kali.");
      } else if (code === "auth/popup-blocked") {
        setAuthError("Popup login diblokir browser. Izinkan popup untuk situs ini, lalu coba lagi.");
      } else {
        setAuthError("Login gagal: " + (e?.message || code || "Terjadi kesalahan"));
      }
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() { await signOut(auth); }

  const [tab, setTab] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [orders, setOrders] = useState([]);
  const [shipmentBatches, setShipmentBatches] = useState([]);
  const [payrollExpenses, setPayrollExpenses] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [transfersOut, setTransfersOut] = useState([]);
  const [materialsStock, setMaterialsStock] = useState([]);
  const [productMasters, setProductMasters] = useState([]);
  const [productCategories, setProductCategories] = useState([]);
  const [editData, setEditData] = useState(null);
  const [search, setSearch] = useState("");
  const [filterTransferInName, setFilterTransferInName] = useState("semua");
  const [filterTransferOutName, setFilterTransferOutName] = useState("semua");
  const [rekapStartDate, setRekapStartDate] = useState("");
  const [rekapEndDate, setRekapEndDate] = useState("");
  const [rekapDateBasis, setRekapDateBasis] = useState("kirim"); // "kirim" = tanggal kirim/realisasi, "order" = tanggal order
  const [invoiceStartDate, setInvoiceStartDate] = useState("");
  const [invoiceEndDate, setInvoiceEndDate] = useState("");
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState("semua");
  const [loading, setLoading] = useState(true);
  const [refreshingData, setRefreshingData] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [filterOrder, setFilterOrder] = useState("semua");
  const [productQuickFilter, setProductQuickFilter] = useState("semua");
  const [sortOrder, setSortOrder] = useState("terbaru");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmResetSupplier, setConfirmResetSupplier] = useState(false); // step 1
  const [confirmResetSupplier2, setConfirmResetSupplier2] = useState(false); // step 2 (double confirm)
  const [rekapConfirm, setRekapConfirm] = useState(null);
  const [showAllProducts, setShowAllProducts] = useState(false);
  const [kirimModal, setKirimModal] = useState(null);
  const [tanggalKirim, setTanggalKirim] = useState(todayStr());
  const [kirimItems, setKirimItems] = useState([]);
  const [invoiceCustomer, setInvoiceCustomer] = useState(null);
  const [invoiceCustomerSisa, setInvoiceCustomerSisa] = useState(null);
  const [dashboardDetail, setDashboardDetail] = useState(null);
  const [issueCenterOpen, setIssueCenterOpen] = useState(false);
  const [issueCenterFilter, setIssueCenterFilter] = useState("semua");
  const [repairingSupplierData, setRepairingSupplierData] = useState(false);
  const [auditLogs, setAuditLogs] = useState([]);
  const [kasbonList, setKasbonList] = useState([]);
  const [kasbonForm, setKasbonForm] = useState({ employeeName: "", tanggal: "", jumlah: "", keterangan: "" });
  const [masterPekerja, setMasterPekerja] = useState([]); // daftar nama pekerja dari Firestore master_pekerja
  const [showKelolaPekerja, setShowKelolaPekerja] = useState(false);
  const [namaPekerjaInput, setNamaPekerjaInput] = useState("");
  const backUiRef = useRef({});
  const lastBackPressRef = useRef(0);
  const refreshTimerRef = useRef(null);
  const pendingRefreshRef = useRef(null);

  const [orderForm, setOrderForm] = useState({
    date: todayStr(), customer: "", phone: "", items: [emptyOrderItem()], shippingCost: 0, dp: 0,
  });
  const [orderDraftLoaded, setOrderDraftLoaded] = useState(false);

  // ── Repair produk ──
  const [repairModal, setRepairModal] = useState(null);
  const [repairIssues, setRepairIssues] = useState({});
  const [repairPriceEdits, setRepairPriceEdits] = useState({});
  const [repairScanned, setRepairScanned] = useState(false);

  // ── Repair qty pengiriman terbalik ──
  const [repairQtyModal, setRepairQtyModal] = useState(false);
  const [repairQtyIssues, setRepairQtyIssues] = useState([]);
  const [repairQtyScanning, setRepairQtyScanning] = useState(false);

  // ── Edit qty delivery langsung ──
  const [editDeliveryModal, setEditDeliveryModal] = useState(null); // { order, deliveryIdx, items }
  const [editDeliveryItems, setEditDeliveryItems] = useState([]);

  const [purchaseForm, setPurchaseForm] = useState({
    date: todayStr(), supplier: "", materials: [emptyPurchaseMaterial()], shippingCost: 0, dp: 0,
  });
  const emptyProductForm = {
    imageUrl: "", name: "", category: "", defaultPrice: 0, mainMaterial: "", materialQtyPerPcs: "",
    unit: "yard", bahanPricePerUnit: 0, bahanCost: 0, hppMaterials: [emptyHppMaterialLine()], productionCost: 0, distributionCost: 0, otherCost: 0, isActive: true,
  };
  const [productForm, setProductForm] = useState(emptyProductForm);

  // ── Transfer form ──
  const [transferForm, setTransferForm] = useState({
    date: todayStr(), customer: "", bank: "", note: "", amount: 0,
  });
  const [transferOutForm, setTransferOutForm] = useState({
    date: todayStr(), supplier: "", bank: "", note: "", amount: 0,
  });

  async function handleProductImageUpload(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return alert("File harus berupa gambar.");
    if (file.size > 8 * 1024 * 1024) return alert("Ukuran foto maksimal 8 MB.");
    try {
      const dataUrl = await resizeImageToDataUrl(file, 520, 0.72);
      setProductForm((f) => ({ ...f, imageUrl: dataUrl }));
    } catch (e) { alert("Gagal membaca foto: " + e.message); }
  }

  function resizeImageToDataUrl(file, maxSize = 520, quality = 0.72) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          const width = Math.max(1, Math.round(img.width * scale));
          const height = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = () => reject(new Error("Foto tidak bisa dibuka."));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error("File tidak bisa dibaca."));
      reader.readAsDataURL(file);
    });
  }

  // ── Scan semua orders untuk temukan item yang namanya tidak cocok master ──
  // Bermasalah HANYA jika nama beda kapital/spasi dari master.
  // Harga TIDAK dicek — harga per pesanan adalah harga yang disepakati saat itu.
  function scanRepairIssues(ordersData, mastersData) {
    if (!Array.isArray(ordersData) || !Array.isArray(mastersData) || mastersData.length === 0) return {};
    const result = {}; // { masterProductId: [issue, ...] }

    const addIssue = (key, issue) => {
      if (!result[key]) result[key] = [];
      const dupKey = `${issue.orderId}_${issue.source}_${issue.deliveryIdx}_${issue.itemIdx}`;
      const already = result[key].some(
        (x) => `${x.orderId}_${x.source}_${x.deliveryIdx}_${x.itemIdx}` === dupKey
      );
      if (!already) result[key].push(issue);
    };

    ordersData.forEach((order) => {
      const deliveries = Array.isArray(order.deliveries) ? order.deliveries : [];
      const orderItems = Array.isArray(order.items) ? order.items : [];

      // Scan di deliveries
      deliveries.forEach((delivery, deliveryIdx) => {
        const dItems = Array.isArray(delivery.items) ? delivery.items : [];
        dItems.forEach((dItem, itemIdx) => {
          const rawName = dItem.name || dItem.nama || "";
          if (!rawName) return;
          const master = mastersData.find((p) => normalizeName(p.name || "") === normalizeName(rawName));
          if (!master) return; // tidak dikenali di master → lewati
          if ((dItem.name || "") === master.name) return; // nama sudah persis benar → skip
          // Nama beda kapital/spasi → bermasalah
          // Sertakan harga dari order.items untuk koreksi otomatis di delivery
          const orderItems = Array.isArray(order.items) ? order.items : [];
          const matchedOrderItem = orderItems.find((oi) =>
            normalizeName(oi.name || "") === normalizeName(rawName)
          ) || orderItems[itemIdx] || {};
          const orderItemPrice = moneyValue(matchedOrderItem.price || matchedOrderItem.harga || 0);

          addIssue(master.id, {
            orderId: order.id,
            orderDoc: order,
            deliveryIdx,
            itemIdx,
            source: "delivery",
            customer: order.customer || order.customerName || "-",
            date: delivery.date || delivery.tanggal || order.tanggalKirim || order.date || "-",
            oldName: dItem.name || rawName,
            oldPrice: moneyValue(dItem.price || dItem.harga || 0),
            orderItemPrice,
            newName: master.name,
            shippedQty: Number(dItem.shippedQty || dItem.qty || 0),
          });
        });
      });

      // Scan di order.items
      orderItems.forEach((oItem, itemIdx) => {
        const rawName = oItem.name || oItem.nama || "";
        if (!rawName) return;
        const master = mastersData.find((p) => normalizeName(p.name || "") === normalizeName(rawName));
        if (!master) return;
        if ((oItem.name || "") === master.name) return;
        addIssue(master.id, {
          orderId: order.id,
          orderDoc: order,
          deliveryIdx: null,
          itemIdx,
          source: "orderItem",
          customer: order.customer || order.customerName || "-",
          date: order.date || order.tanggal || order.createdAt || "-",
          oldName: oItem.name || rawName,
          oldPrice: moneyValue(oItem.price || oItem.harga || 0),
          newName: master.name,
          shippedQty: Number(oItem.qty || 0),
        });
      });
    });

    return result;
  }

  // Scan manual — dipanggil saat user klik tombol Scan Data
  function jalankanScan() {
    if (!orders.length || !productMasters.length) {
      alert("Data orders atau produk belum dimuat. Coba Refresh Data dulu.");
      return;
    }
    const issues = scanRepairIssues(orders, productMasters);
    setRepairIssues(issues);
    setRepairScanned(true);
    const totalIssues = Object.values(issues).reduce((sum, arr) => sum + arr.length, 0);
    const totalProduk = Object.keys(issues).length;
    if (totalIssues === 0) {
      alert("✅ Semua data produk sudah benar. Tidak ada yang perlu diperbaiki.");
    } else {
      alert(`⚠️ Ditemukan ${totalIssues} data bermasalah di ${totalProduk} produk. Lihat indikator ⚠️ di kartu produk.`);
    }
  }

  // ── Scan qty pengiriman terbalik dari Gallery Produksi ──
  async function scanRepairQtyPengiriman() {
    setRepairQtyScanning(true);
    setRepairQtyIssues([]);
    try {
      const issues = [];
      orders.forEach((order) => {
        const rawOrder = order.raw || order;
        const deliveries = getDeliveryHistory(order);
        const orderItems = normalizeOrderItems(order);
        if (orderItems.length < 2) return;

        deliveries.forEach((delivery, deliveryIdx) => {
          const dItems = Array.isArray(delivery.items) ? delivery.items : [];
          if (dItems.length < 2) return;

          const mismatches = [];
          dItems.forEach((dItem) => {
            const dName = normalizeName(dItem.name || "");
            const dQty = Number(dItem.shippedQty || dItem.qty || 0);
            if (!dName || dQty <= 0) return;

            const matchedOrderItem = orderItems.find((oi) => normalizeName(oi.name || "") === dName);
            if (!matchedOrderItem) return;

            const oQty = Number(matchedOrderItem.qty || 0);
            if (oQty <= 0) return;

            if (dQty !== oQty) {
              mismatches.push({ name: dItem.name || "-", deliveryQty: dQty, orderQty: oQty });
            }
          });

          if (mismatches.length === 0) return;

          const correctItems = dItems.map((dItem) => {
            const matched = orderItems.find((oi) => normalizeName(oi.name || "") === normalizeName(dItem.name || ""));
            return { name: dItem.name || "-", qty: Number(matched?.qty || dItem.shippedQty || dItem.qty || 0) };
          });

          issues.push({
            orderId: order.id, orderDoc: rawOrder, deliveryIdx,
            customer: rawOrder.customer || "-",
            date: delivery.date || delivery.tanggalKirim || "-",
            currentItems: dItems.map((it) => ({ name: it.name || "-", qty: Number(it.shippedQty || it.qty || 0) })),
            correctItems, mismatches,
          });
        });
      });

      setRepairQtyIssues(issues);
      setRepairQtyModal(true);


    } catch (err) {
      alert("Gagal scan: " + err.message);
    } finally {
      setRepairQtyScanning(false);
    }
  }

  async function runRepairQtyPengiriman() {
    if (repairQtyIssues.length === 0) return;
    setIsSaving(true);
    try {
      const batch = writeBatch(db);

      // Group by orderId
      const byOrder = {};
      repairQtyIssues.forEach((issue) => {
        if (!byOrder[issue.orderId]) byOrder[issue.orderId] = { orderDoc: issue.orderDoc, issues: [] };
        byOrder[issue.orderId].issues.push(issue);
      });

      Object.entries(byOrder).forEach(([orderId, { orderDoc, issues }]) => {
        const deliveriesSource = Array.isArray(orderDoc.deliveries) ? orderDoc.deliveries
          : Array.isArray(orderDoc.raw?.deliveries) ? orderDoc.raw.deliveries : [];
        const newDeliveries = JSON.parse(JSON.stringify(deliveriesSource));

        issues.forEach((issue) => {
          const delivery = newDeliveries[issue.deliveryIdx];
          if (!delivery) return;

          // Koreksi qty setiap item berdasarkan nama dari shipment (sumber kebenaran)
          if (Array.isArray(delivery.items)) {
            delivery.items = delivery.items.map((dItem) => {
              const correct = issue.correctItems.find(
                (ci) => normalizeName(ci.name) === normalizeName(dItem.name || "")
              );
              if (!correct) return dItem;
              return {
                ...dItem,
                shippedQty: correct.qty,
                qty: correct.qty,
              };
            });
          }
        });

        batch.update(doc(db, "orders", orderId), {
          deliveries: newDeliveries,
          updatedAt: new Date().toISOString(),
        });
      });

      await batch.commit();

      // Refresh orders
      const snap = await getDocs(collection(db, "orders"));
      const newOrders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setOrders(newOrders);
      setRepairQtyModal(false);
      setRepairQtyIssues([]);
      alert(`✅ ${repairQtyIssues.length} delivery berhasil dikoreksi.`);
    } catch (err) {
      alert("Gagal repair: " + err.message);
    } finally {
      setIsSaving(false);
    }
  }

  // Hitung total issue per produk
  function getIssueCountForProduct(productId) {
    return (repairIssues[productId] || []).length;
  }

  // Jalankan repair untuk satu produk
  async function runRepairForProduct(productId) {
    const issues = repairIssues[productId] || [];
    if (issues.length === 0) return;
    setIsSaving(true);
    try {
      // Group issues by orderId agar update per dokumen order
      const byOrder = {};
      issues.forEach((issue) => {
        if (!byOrder[issue.orderId]) byOrder[issue.orderId] = { orderDoc: issue.orderDoc, issues: [] };
        byOrder[issue.orderId].issues.push(issue);
      });

      const batch = writeBatch(db);

      Object.entries(byOrder).forEach(([orderId, { orderDoc, issues: orderIssues }]) => {
        // Clone deliveries dan items dari order
        const newDeliveries = JSON.parse(JSON.stringify(Array.isArray(orderDoc.deliveries) ? orderDoc.deliveries : []));
        const newItems = JSON.parse(JSON.stringify(Array.isArray(orderDoc.items) ? orderDoc.items : []));

        orderIssues.forEach((issue) => {
          if (issue.source === "delivery" && issue.deliveryIdx !== null) {
            const dItem = newDeliveries[issue.deliveryIdx]?.items?.[issue.itemIdx];
            if (dItem) {
              dItem.name = issue.newName;
              // Koreksi harga otomatis dari order.items (harga saat pesanan dibuat)
              if (issue.orderItemPrice > 0) dItem.price = issue.orderItemPrice;
            }
          } else if (issue.source === "orderItem") {
            const oItem = newItems[issue.itemIdx];
            if (oItem) {
              oItem.name = issue.newName;
              // harga order.items sudah benar, tidak perlu diubah
            }
          }
        });

        const orderRef = doc(db, "orders", orderId);
        const patch = {};
        if (newDeliveries.length > 0) patch.deliveries = newDeliveries;
        if (newItems.length > 0) patch.items = newItems;
        patch.updatedAt = new Date().toISOString();
        batch.update(orderRef, patch);
      });

      await batch.commit();

      // Refresh orders setelah repair
      const snap = await getDocs(collection(db, "orders"));
      const newOrders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setOrders(newOrders);
      // Scan ulang langsung pakai data baru agar indikator ⚠️ hilang tanpa perlu klik manual
      const freshIssues = scanRepairIssues(newOrders, productMasters);
      setRepairIssues(freshIssues);
      setRepairScanned(true);
      setRepairModal(null);
      setRepairPriceEdits({});
      alert(`✅ ${issues.length} data berhasil diperbaiki.`);
    } catch (err) {
      alert("Gagal repair: " + err.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function saveEditDelivery() {
    if (!editDeliveryModal) return;
    const { order, deliveryIdx } = editDeliveryModal;
    setIsSaving(true);
    try {
      const rawOrder = order.raw || order;
      const deliveries = JSON.parse(JSON.stringify(
        Array.isArray(rawOrder.deliveries) ? rawOrder.deliveries :
        Array.isArray(order.deliveries) ? order.deliveries : []
      ));
      if (!deliveries[deliveryIdx]) throw new Error("Delivery tidak ditemukan.");

      // Update qty setiap item
      deliveries[deliveryIdx].items = editDeliveryItems.map((it) => ({
        ...it,
        qty: Number(it.qty || 0),
        shippedQty: Number(it.qty || 0),
      }));

      // Hitung ulang shippedItems ringkasan
      const orderItems = normalizeOrderItems(order);
      const shippedItems = orderItems.map((base, idx) => {
        const totalShipped = deliveries.reduce((sum, d) => {
          const found = (d.items || []).find((it) =>
            normalizeName(it.name || "") === normalizeName(base.name || "")
          );
          return sum + Number(found?.shippedQty || found?.qty || 0);
        }, 0);
        return {
          name: base.name,
          orderedQty: Number(base.qty || 0),
          shippedQty: totalShipped,
          price: moneyValue(base.price || 0),
        };
      });

      await updateDoc(doc(db, "orders", order.id), {
        deliveries,
        shippedItems,
        updatedAt: new Date().toISOString(),
      });

      const snap = await getDocs(collection(db, "orders"));
      setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setEditDeliveryModal(null);
      setEditDeliveryItems([]);
      alert("✅ Qty pengiriman berhasil dikoreksi.");
    } catch (err) {
      alert("Gagal: " + err.message);
    } finally {
      setIsSaving(false);
    }
  }

  const [expenseForm, setExpenseForm] = useState({ date: todayStr(), category: "", note: "", amount: 0 });
  const [orderPayForm, setOrderPayForm] = useState({ customer: "", date: todayStr(), bank: "", note: "", amount: 0 });
  const [supplierPayForm, setSupplierPayForm] = useState({ supplier: "", date: todayStr(), note: "", amount: 0 });

  const loadedRef = useRef({ orders: false, shipmentBatches: false, purchases: false, expenses: false, materials: false, products: false, productCategories: false, transfers: false, transfersOut: false, payroll: false, kasbon: false, masterPekerja: false });

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("gk_audit_logs") || "[]");
      setAuditLogs(Array.isArray(saved) ? saved.slice(0, 50) : []);
    } catch (e) { setAuditLogs([]); }
  }, []);

  // Sync state ke backUiRef agar back button guard selalu punya state terbaru
  useEffect(() => {
    backUiRef.current = {
      tab,
      modal,
      confirmDelete,
      confirmResetSupplier,
      confirmResetSupplier2,
      kirimModal,
      invoiceCustomer,
      dashboardDetail,
      issueCenterOpen,
      rekapConfirm,
      search,
    };
  });

  // Back button guard — tombol back HP menutup modal dulu sebelum keluar
  useEffect(() => {
    if (!user || typeof window === "undefined") return;

    const pushGuardState = () => {
      window.history.pushState({ galleryKerudungBackGuard: true }, "", window.location.href);
    };

    pushGuardState();

    const closeTopLayer = () => {
      const ui = backUiRef.current || {};
      if (ui.confirmDelete) { setConfirmDelete(null); return true; }
      if (ui.confirmResetSupplier2) { setConfirmResetSupplier2(false); return true; }
      if (ui.confirmResetSupplier) { setConfirmResetSupplier(false); return true; }
      if (ui.rekapConfirm) { setRekapConfirm(null); return true; }
      if (ui.invoiceCustomer) { setInvoiceCustomer(null); return true; }
      if (ui.kirimModal) { setKirimModal(null); return true; }
      if (ui.dashboardDetail) { setDashboardDetail(null); return true; }
      if (ui.issueCenterOpen) { setIssueCenterOpen(false); return true; }
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
      // Toast tidak ada di Kerudung, cukup push guard ulang
      pushGuardState();
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [user]);

  useEffect(() => {
    if (!user || orderDraftLoaded) return;
    try {
      const saved = JSON.parse(localStorage.getItem("gk_order_draft") || "null");
      if (saved && typeof saved === "object") {
        setOrderForm({
          date: saved.date || todayStr(),
          customer: saved.customer || "",
          phone: saved.phone || "",
          items: Array.isArray(saved.items) && saved.items.length > 0 ? saved.items : [emptyOrderItem()],
          shippingCost: moneyValue(saved.shippingCost || saved.ongkir || 0),
          dp: Number(saved.dp || 0),
        });
      }
    } catch (e) {}
    finally { setOrderDraftLoaded(true); }
  }, [user, orderDraftLoaded]);

  useEffect(() => {
    if (!user || !orderDraftLoaded) return;
    const hasDraft = Boolean(orderForm.customer || orderForm.phone || moneyValue(orderForm.dp || 0) > 0 || moneyValue(orderForm.shippingCost || 0) > 0 || (orderForm.items || []).some((it) => it.name || Number(it.qty || 0) > 0 || moneyValue(it.price || 0) > 0));
    try {
      if (hasDraft) localStorage.setItem("gk_order_draft", JSON.stringify(orderForm));
      else localStorage.removeItem("gk_order_draft");
    } catch (e) {}
  }, [user, orderDraftLoaded, orderForm]);

  async function loadFirestoreData({ showLoading = false, useCache = true } = {}) {
    if (!user) return;
    if (showLoading) setLoading(true);
    else setRefreshingData(true);
    setFirestoreError("");

    const cacheKey = `${FIRESTORE_CACHE_KEY}_${user?.email || "anon"}`;
    const applyRows = (rows = {}) => {
      setOrders(Array.isArray(rows.ordersRows) ? rows.ordersRows : []);
      setShipmentBatches(Array.isArray(rows.shipmentBatchRows) ? rows.shipmentBatchRows : []);
      setPurchases(Array.isArray(rows.purchaseRows) ? rows.purchaseRows : []);
      setExpenses(Array.isArray(rows.expenseRows) ? rows.expenseRows : []);
      setMaterialsStock(Array.isArray(rows.materialRows) ? rows.materialRows : []);
      setProductMasters(Array.isArray(rows.productRows) ? rows.productRows : []);
      setProductCategories(Array.isArray(rows.productCategoryRows) ? rows.productCategoryRows : []);
      setTransfers(Array.isArray(rows.transferRows) ? rows.transferRows : []);
      setTransfersOut(Array.isArray(rows.transferOutRows) ? rows.transferOutRows : []);
      setPayrollExpenses(Array.isArray(rows.payrollRows) ? rows.payrollRows : []);
      setKasbonList(Array.isArray(rows.kasbonRows) ? rows.kasbonRows : []);
      setMasterPekerja(Array.isArray(rows.masterPekerjaRows) ? rows.masterPekerjaRows : []);
      loadedRef.current = {
        orders: true,
        shipmentBatches: true,
        purchases: true,
        expenses: true,
        materials: true,
        products: true,
        productCategories: true,
        transfers: true,
        transfersOut: true,
        payroll: true,
        kasbon: true,
        masterPekerja: true,
      };
    };

    try {
      if (useCache) {
        try {
          const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
          if (cached?.savedAt && Date.now() - cached.savedAt < FIRESTORE_CACHE_TTL_MS && cached?.rows) {
            applyRows(cached.rows);
            setLoading(false);
            setRefreshingData(false);
            return;
          }
        } catch (e) {}
      }

      const errors = [];
      const readCollection = async (collectionName, label, optional = false) => {
        try {
          const snap = await getDocs(collection(db, collectionName));
          return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        } catch (err) {
          console.error(`${label}:`, err);
          if (!optional) errors.push(`${label}: ${err?.message || "Gagal memuat data"}`);
          return [];
        }
      };

      const rows = {};
      [
        rows.ordersRows,
        rows.shipmentBatchRows,
        rows.purchaseRows,
        rows.expenseRows,
        rows.materialRows,
        rows.productRows,
        rows.productCategoryRows,
        rows.transferRows,
        rows.transferOutRows,
        rows.payrollRows,
        rows.kasbonRows,
        rows.masterPekerjaRows,
      ] = await Promise.all([
        readCollection("orders", "orders"),
        readCollection("shipment_batches", "shipment_batches", true),
        readCollection("purchases", "purchases"),
        readCollection("expenses", "expenses"),
        readCollection("materials", "materials"),
        readCollection("products", "products"),
        readCollection("productCategories", "productCategories"),
        readCollection("transfers", "transfers"),
        readCollection("transfersOut", "transfersOut"),
        readCollection("payroll_expenses", "payroll_expenses"),
        readCollection(KASBON_COLLECTION, KASBON_COLLECTION),
        readCollection("master_pekerja", "master_pekerja"),
      ]);

      applyRows(rows);
      try { localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), rows })); } catch (e) {}
      if (errors.length > 0) setFirestoreError(errors.join("\n"));
    } finally {
      setLoading(false);
      setRefreshingData(false);
    }
  }

  useEffect(() => {
    if (!user) {
      setOrders([]); setShipmentBatches([]); setPurchases([]); setExpenses([]); setMaterialsStock([]); setProductMasters([]); setProductCategories([]); setTransfers([]); setTransfersOut([]); setPayrollExpenses([]); setKasbonList([]); setMasterPekerja([]);
      loadedRef.current = { orders: false, shipmentBatches: false, purchases: false, expenses: false, materials: false, products: false, productCategories: false, transfers: false, transfersOut: false, payroll: false, kasbon: false, masterPekerja: false };
      setFirestoreError(""); setLoading(false); setRefreshingData(false);
      // Reset draft agar akun berikutnya tidak melihat draft akun sebelumnya
      setOrderDraftLoaded(false);
      return;
    }

    // Hemat reads Firestore:
    // Tidak memasang onSnapshot ke collection besar. App membaca data sekali saat masuk,
    // memakai cache 5 menit, lalu bisa diperbarui dari tombol Refresh Data atau otomatis
    // setelah simpan/edit/hapus. Ini menjaga fungsi tetap sama, tetapi mengurangi reads
    // yang biasanya muncul dari realtime listener dan refresh berulang.
    loadFirestoreData({ showLoading: true, useCache: true }).catch((err) => {
      console.warn("Load data gagal:", err);
      setLoading(false);
      setRefreshingData(false);
    });

    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [user]);

  // Peta: nama logis → { collectionName, setter, rowKey }
  const COLLECTION_MAP = {
    orders:            { col: "orders",             setter: setOrders,           rowKey: "ordersRows" },
    shipmentBatches:   { col: "shipment_batches",   setter: setShipmentBatches,  rowKey: "shipmentBatchRows", optional: true },
    purchases:         { col: "purchases",           setter: setPurchases,         rowKey: "purchaseRows" },
    expenses:          { col: "expenses",            setter: setExpenses,          rowKey: "expenseRows" },
    materials:         { col: "materials",           setter: setMaterialsStock,    rowKey: "materialRows" },
    products:          { col: "products",            setter: setProductMasters,    rowKey: "productRows" },
    productCategories: { col: "productCategories",  setter: setProductCategories, rowKey: "productCategoryRows" },
    transfers:         { col: "transfers",           setter: setTransfers,         rowKey: "transferRows" },
    transfersOut:      { col: "transfersOut",        setter: setTransfersOut,      rowKey: "transferOutRows" },
    kasbon:            { col: KASBON_COLLECTION,     setter: setKasbonList,        rowKey: "kasbonRows" },
    masterPekerja:     { col: "master_pekerja",      setter: setMasterPekerja,     rowKey: "masterPekerjaRows" },
  };

  // Targeted refresh: hanya baca collection yang benar-benar berubah.
  // Jauh lebih hemat reads dibanding loadFirestoreData() yang membaca semua 12 collection.
  // Cache localStorage diperbarui parsial agar tombol Refresh manual tetap dapat data terbaru.
  async function refreshCollections(...names) {
    if (!user) return;
    const readOne = async ({ col, optional = false }) => {
      try {
        const snap = await getDocs(collection(db, col));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      } catch (err) {
        console.warn(`refreshCollections ${col}:`, err);
        if (!optional) throw err;
        return null; // optional → biarkan state lama tetap
      }
    };

    const results = await Promise.allSettled(
      names.map((name) => {
        const entry = COLLECTION_MAP[name];
        if (!entry) return Promise.resolve(null);
        return readOne(entry);
      })
    );

    // Update state + patch cache parsial
    const cacheKey = `${FIRESTORE_CACHE_KEY}_${user?.email || "anon"}`;
    let cachedRows = {};
    try { cachedRows = JSON.parse(localStorage.getItem(cacheKey) || "null")?.rows || {}; } catch (_) {}

    results.forEach((result, i) => {
      const name = names[i];
      const entry = COLLECTION_MAP[name];
      if (!entry) return;
      if (result.status === "fulfilled" && result.value !== null) {
        entry.setter(result.value);
        cachedRows[entry.rowKey] = result.value;
      }
    });

    try { localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), rows: cachedRows })); } catch (_) {}
  }

  // Helper: jadwalkan refreshCollections dengan debounce (mencegah double-call
  // jika satu aksi memanggil refreshCollections dua kali berturutan).
  function scheduleRefresh(...names) {
    if (pendingRefreshRef.current) clearTimeout(pendingRefreshRef.current);
    pendingRefreshRef.current = setTimeout(() => {
      refreshCollections(...names).catch((err) => console.warn("Targeted refresh gagal:", err));
    }, FIRESTORE_REFRESH_DEBOUNCE_MS);
  }

  // ── Helper functions ──
  function orderSortValue(order) {
    return dateSerial(order?.createdAt || order?.date || order?.tanggal || "");
  }

  // Lookup harga dari master produk — fallback terakhir jika harga di item = 0.
  // Fungsi ini mirror dari lookupMasterPrice di InvoiceModal agar scope App punya akses yang sama.
  function lookupProductMasterPrice(name) {
    if (!name || !productMasters.length) return 0;
    const norm = normalizeName(name);
    const found = productMasters.find((p) => normalizeName(p.name) === norm);
    return moneyValue(found?.defaultPrice ?? found?.price ?? found?.hargaJual ?? found?.sellingPrice ?? found?.salePrice ?? found?.hargaPcs ?? found?.unitPrice ?? 0);
  }

  function officialShipmentSubtotalForOrder(order) {
    if (!order?.id && !order?.invoice) return 0;
    const orderId = String(order?.id || "").trim();
    const invoice = String(order?.invoice || "").trim();
    const customerKey = normalizeName(order?.customer || "");

    return (shipmentBatches || []).reduce((sum, batch) => {
      const batchItems = Array.isArray(batch.items) ? batch.items : [];
      const batchCustomer = normalizeName(batch.customerName || batch.customer || batch.receiver || batch.penerima || "");
      const batchOrderIds = [
        batch.orderId, batch.pesananId,
        ...(Array.isArray(batch.orderIds) ? batch.orderIds : []),
        ...(Array.isArray(batch.pesananIds) ? batch.pesananIds : []),
      ].map((x) => String(x || "").trim()).filter(Boolean);
      const batchInvoices = [
        batch.invoice,
        ...(Array.isArray(batch.invoices) ? batch.invoices : []),
      ].map((x) => String(x || "").trim()).filter(Boolean);

      const batchMatchesOrder = (orderId && batchOrderIds.includes(orderId)) || (invoice && batchInvoices.includes(invoice));
      const batchMatchesCustomer = customerKey && batchCustomer === customerKey;

      // Untuk tagihan per pesanan, jangan cocokkan batch hanya dari nama customer.
      // Satu customer bisa punya beberapa pesanan; customer-only match bisa menggandakan invoice
      // ke semua pesanan customer tersebut. Data lama tanpa orderId/invoice tetap dihitung dari
      // order.deliveries/shippedItems melalui normalizeShipmentItems().
      if (!batchMatchesOrder) return sum;

      const rows = Array.isArray(batch.orders) && batch.orders.length > 0 ? batch.orders : [];
      let rawItems = [];

      const matchedRows = rows.filter((row) => {
        const rowOrderId = String(row.orderId || row.pesananId || "").trim();
        const rowInvoice = String(row.invoice || "").trim();
        const rowCustomer = normalizeName(row.customer || row.customerName || "");
        return (orderId && rowOrderId === orderId) || (invoice && rowInvoice === invoice) || (!rowOrderId && !rowInvoice && batchMatchesOrder) || (!rowOrderId && !rowInvoice && batchMatchesCustomer && rowCustomer === customerKey);
      });

      if (matchedRows.length > 0) {
        rawItems = matchedRows.flatMap((row) => Array.isArray(row.items) && row.items.length > 0 ? row.items : batchItems.filter((it) => {
          const itOrderId = String(it.orderId || it.pesananId || "").trim();
          const itInvoice = String(it.invoice || "").trim();
          return (orderId && itOrderId === orderId) || (invoice && itInvoice === invoice);
        }));
      } else if (batchMatchesOrder) {
        rawItems = batchItems.filter((it) => {
          const itOrderId = String(it.orderId || it.pesananId || "").trim();
          const itInvoice = String(it.invoice || "").trim();
          return (!itOrderId && !itInvoice) || (orderId && itOrderId === orderId) || (invoice && itInvoice === invoice);
        });
      } else if (batchMatchesCustomer && rows.length === 0 && batchItems.length > 0) {
        rawItems = batchItems.filter((it) => {
          const itOrderId = String(it.orderId || it.pesananId || "").trim();
          const itInvoice = String(it.invoice || "").trim();
          return (orderId && itOrderId === orderId) || (invoice && itInvoice === invoice);
        });
      }

      const batchOngkir = moneyValue(batch.ongkir ?? batch.shippingCost ?? 0);

      if (rawItems.length > 0) {
        const lineTotal = rawItems.reduce((lineSum, it, idx) => {
          const qty = Number(it.shippedQty ?? it.qtyKirim ?? it.qty ?? it.kirim ?? 0);
          if (qty <= 0) return lineSum;
          const base = orderItemForDeliveryItem(order, it, idx) || {};
          let price = resolveSalePrice(it, base, order, productMasters);
          if (!price) price = lookupProductMasterPrice(base.name || it.name || it.nama || "");
          return lineSum + qty * price;
        }, 0);
        // Kalau detail item tersedia, hitung ulang dari qty kirim × harga pesanan.
        // totalTagihanBatch hanya fallback untuk data lama yang tidak punya detail item.
        if (lineTotal > 0) return sum + lineTotal + batchOngkir;
      }

      const totalTagihanBatch = moneyValue(batch.totalTagihanBatch ?? batch.totalTagihan ?? batch.totalBatch ?? 0);
      if (batchMatchesOrder && totalTagihanBatch > 0) {
        return sum + totalTagihanBatch + batchOngkir;
      }

      return sum;
    }, 0);
  }

  function orderPaymentTarget(order) {
    // Tagihan = semua barang yang sudah dikirim, belum dibayar.
    // Ambil MAX dari dua sumber supaya tidak ada kiriman yang terlewat.
    const orderId = String(order?.id || "").trim();
    const invoice = String(order?.invoice || "").trim();

    // Ongkir: cek dari order dulu, fallback ke shipment_batches.
    // orderShippingCost hanya baca order.shippingCost dan order.deliveries —
    // tidak baca shipment_batches. Jadi kita tambahkan fallback di sini.
    const ongkirFromOrder = orderShippingCost(order);
    const ongkirFromBatches = ongkirFromOrder > 0 ? 0 : (shipmentBatches || []).reduce((max, batch) => {
      const batchOrderIds = [
        batch.orderId, batch.pesananId,
        ...(Array.isArray(batch.orderIds) ? batch.orderIds : []),
      ].map(x => String(x || "").trim()).filter(Boolean);
      const batchInvoices = [
        batch.invoice,
        ...(Array.isArray(batch.invoices) ? batch.invoices : []),
      ].map(x => String(x || "").trim()).filter(Boolean);
      const matches = (orderId && batchOrderIds.includes(orderId)) || (invoice && batchInvoices.includes(invoice));
      if (!matches) return max;
      const batchOngkir = moneyValue(batch.ongkir ?? batch.shippingCost ?? 0);
      return Math.max(max, batchOngkir);
    }, 0);
    const ongkir = ongkirFromOrder > 0 ? ongkirFromOrder : ongkirFromBatches;

    const officialSubtotal = officialShipmentSubtotalForOrder(order);
    const deliverySubtotal = shipmentItemsTotal(normalizeShipmentItems(order, productMasters), lookupProductMasterPrice) + ongkir;
    return Math.max(0, Math.round(Math.max(officialSubtotal, deliverySubtotal)));
  }

  function customerOrdersSorted(customerName) {
    const key = normalizeName(customerName || "");
    return [...(orders || [])]
      .filter((o) => normalizeName(o.customer || "") === key)
      .sort((a, b) => {
        const dateDiff = orderSortValue(a) - orderSortValue(b);
        if (dateDiff !== 0) return dateDiff;
        return String(a.id || "").localeCompare(String(b.id || ""));
      });
  }

  function cleanCustomerPaymentNote(note) {
    const text = String(note || "").trim();
    if (!text) return "Pembayaran Customer";
    if (text.toLowerCase().includes("migrasi")) return "Pembayaran Customer";
    return text;
  }

  function isMigratedPaymentSource(value) {
    const haystack = typeof value === "object" && value !== null
      ? [value.source, value.note, value.bank, value.transferNote, value.legacyGroupKey, value.id].join(" ")
      : String(value || "");
    const text = haystack.toLowerCase();
    return text.includes("migrasi") || text.includes("saldo awal") || text.includes("opening balance");
  }

  function sortPaymentEvents(a, b) {
    const dateDiff = dateSerial(b.date || "") - dateSerial(a.date || "");
    if (dateDiff !== 0) return dateDiff;
    const createdDiff = String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    if (createdDiff !== 0) return createdDiff;
    return String(b.id || "").localeCompare(String(a.id || ""));
  }

  function sortPaymentEventsAsc(a, b) {
    const dateDiff = dateSerial(a.date || "") - dateSerial(b.date || "");
    if (dateDiff !== 0) return dateDiff;
    const createdDiff = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    if (createdDiff !== 0) return createdDiff;
    return String(a.id || "").localeCompare(String(b.id || ""));
  }

  function customerPaymentEventsSorted(customerName) {
    const key = normalizeName(customerName || "");
    if (!key) return [];

    // Sumber utama pembayaran customer adalah transfers, karena ini catatan kas masuk yang utuh.
    // Data migrasi lama bisa berisi pecahan alokasi lama, jadi jika ada transfer input asli,
    // riwayat FIFO memakai transfer input asli saja agar tanggal/nominal tidak terlihat acak.
    const allTransferEvents = [...(transfers || [])]
      .filter((t) => normalizeName(t.customer || "") === key && moneyValue(t.amount || 0) > 0)
      .map((t) => ({
        id: t.id || "",
        date: t.date || t.createdAt?.slice?.(0, 10) || todayStr(),
        createdAt: t.createdAt || "",
        note: cleanCustomerPaymentNote(t.note || t.bank || "Pembayaran Customer"),
        amount: moneyValue(t.amount || 0),
        source: t.source || "transfers",
        transferId: t.id || "",
        transferAmount: moneyValue(t.amount || 0),
        transferNote: t.note || "",
      }));

    const transferEventKeys = new Set(allTransferEvents.map((t) => `${t.date}__${moneyValue(t.amount || 0)}__${normalizeName(t.note || "")}`));
    const standaloneOrderPaymentEvents = customerOrdersSorted(customerName).flatMap((order) =>
      (order.payments || [])
        .filter((pay) => moneyValue(pay.amount || 0) > 0)
        .filter((pay) => !pay.transferId && !isMigratedPaymentSource(pay))
        .map((pay, idx) => ({
          id: `${order.id || "order"}-standalone-${idx}`,
          date: pay.date || order.createdAt || todayStr(),
          createdAt: pay.createdAt || order.createdAt || "",
          note: cleanCustomerPaymentNote(pay.note || "Pembayaran Customer"),
          amount: moneyValue(pay.amount || 0),
          source: pay.source || "standalone_order_payment",
          transferId: "",
          transferAmount: moneyValue(pay.amount || 0),
          transferNote: pay.note || "",
        }))
        .filter((pay) => !transferEventKeys.has(`${pay.date}__${moneyValue(pay.amount || 0)}__${normalizeName(pay.note || "")}`))
    );

    // Semua transfer valid tetap ikut FIFO untuk menghitung sisa tagihan.
    // Pembayaran yang tersimpan langsung di order tanpa transferId (mis. DP Awal)
    // tetap ikut FIFO agar tidak hilang saat customer juga punya transfer kas masuk.
    if (allTransferEvents.length > 0) {
      return [...allTransferEvents, ...standaloneOrderPaymentEvents]
        .map((t) => ({ ...t, hiddenFromHistory: isMigratedPaymentSource(t) }))
        .sort(sortPaymentEvents);
    }

    // Fallback hanya untuk data lama yang benar-benar belum pernah punya transfers.
    const legacyEvents = customerOrdersSorted(customerName).flatMap((order) =>
      (order.payments || [])
        .filter((pay) => moneyValue(pay.amount || 0) > 0)
        .map((pay, idx) => ({
          id: `${order.id || "legacy"}-${idx}`,
          date: pay.date || order.createdAt || todayStr(),
          createdAt: order.createdAt || "",
          note: cleanCustomerPaymentNote(pay.note || "Pembayaran Customer"),
          amount: moneyValue(pay.amount || 0),
          source: "legacy_order_payment",
          transferId: pay.transferId || "",
          transferAmount: moneyValue(pay.transferAmount || pay.amount || 0),
          transferNote: pay.transferNote || pay.note || "",
        }))
    );

    return legacyEvents.sort(sortPaymentEvents);
  }

  function customerFifoPaymentMap(customerName) {
    const customerKey = normalizeName(customerName || "");
    const result = {};
    if (!customerKey) return result;

    const customerOrderList = customerOrdersSorted(customerName)
      .map((o) => ({ ...o, remaining: Math.max(0, orderPaymentTarget(o)) }))
      .filter((o) => o.id && o.remaining > 0);

    const customerPayments = customerPaymentEventsSorted(customerName).sort(sortPaymentEventsAsc);

    let orderIndex = 0;
    for (const payment of customerPayments) {
      let paymentLeft = moneyValue(payment.amount || 0);
      while (paymentLeft > 0 && orderIndex < customerOrderList.length) {
        const order = customerOrderList[orderIndex];
        if (order.remaining <= 0) { orderIndex += 1; continue; }

        const amount = Math.min(paymentLeft, order.remaining);
        if (amount > 0) {
          if (!result[order.id]) result[order.id] = [];
          result[order.id].push({
            date: payment.date || todayStr(),
            note: cleanCustomerPaymentNote(payment.note || "Pembayaran Customer"),
            amount,
            transferId: payment.transferId || "",
            transferAmount: payment.transferAmount || moneyValue(payment.amount || 0),
            transferNote: payment.transferNote || "",
            source: payment.source || "fifo_customer_payment",
            hiddenFromHistory: payment.hiddenFromHistory === true,
          });
          order.remaining = Math.max(0, order.remaining - amount);
          paymentLeft = Math.max(0, paymentLeft - amount);
        }

        if (order.remaining <= 0) orderIndex += 1;
      }
    }

    return result;
  }

  function customerHasDirectTransfer(customerName) {
    const key = normalizeName(customerName || "");
    return key && (transfers || []).some((t) => normalizeName(t.customer || "") === key && moneyValue(t.amount || 0) > 0);
  }

  function orderPaymentRowsForCalculation(order) {
    if (!order?.id) return [];
    const fifoRows = customerFifoPaymentMap(order.customer)[order.id] || [];
    if (fifoRows.length > 0) return fifoRows;
    // Jika customer sudah punya catatan transfer utuh, jangan fallback ke order.payments
    // untuk order yang tidak mendapat alokasi FIFO. Ini mencegah dobel hitung
    // antara transfers dan payments lama yang tersimpan di order.
    if (customerHasDirectTransfer(order.customer)) return [];
    return Array.isArray(order?.payments) ? order.payments : [];
  }


  function paymentHistoryForDisplay(rows, defaultNote) {
    const list = Array.isArray(rows) ? rows : [];

    // FINAL AUDIT RULE:
    // 1) Baris pembayaran asli harus tampil per tanggal input dan boleh terpotong sesuai FIFO.
    // 2) Baris migrasi/saldo lama TIDAK boleh disamar menjadi pembayaran asli,
    //    karena nominal itu bukan input user per tanggal. Kalau masih ikut melunasi nota,
    //    tampilkan sebagai "Saldo Awal" agar total pembayaran dan sisa tagihan tetap sinkron
    //    tanpa membuat riwayat pembayaran palsu.
    // 3) Jangan gabungkan saldo awal ke baris pembayaran asli.
    const visible = list
      .filter((p) => p.hiddenFromHistory !== true && !isMigratedPaymentSource(p) && moneyValue(p.amount || 0) > 0)
      .map((p) => ({ ...p, note: p.note || defaultNote, isOpeningBalance: false }));

    const openingBalance = list
      .filter((p) => (p.hiddenFromHistory === true || isMigratedPaymentSource(p)) && moneyValue(p.amount || 0) > 0)
      .map((p) => ({
        ...p,
        hiddenFromHistory: false,
        note: "Saldo Awal",
        isOpeningBalance: true,
      }));

    // CLEAN FINAL DISPLAY RULE:
    // Kalau saldo awal hampir melunasi nota lalu ada potongan pembayaran kecil
    // hanya untuk menutup selisih receh FIFO, gabungkan ke Saldo Awal.
    // Contoh Teh Susi: Saldo Awal 20.001.460 + Pembayaran 1.000
    // tampil sebagai Saldo Awal 20.002.460 agar riwayat tidak terlihat aneh.
    const SMALL_FIFO_REMAINDER = 10000;
    const visibleTotal = visible.reduce((sum, p) => sum + moneyValue(p.amount || 0), 0);
    if (openingBalance.length > 0 && visible.length > 0 && visibleTotal > 0 && visibleTotal <= SMALL_FIFO_REMAINDER) {
      const sortedOpening = [...openingBalance].sort(sortPaymentEvents);
      const firstOpening = sortedOpening[0];
      const mergedOpening = {
        ...firstOpening,
        amount: moneyValue(firstOpening.amount || 0) + visibleTotal,
        note: "Saldo Awal",
        isOpeningBalance: true,
      };
      return [mergedOpening, ...sortedOpening.slice(1)].sort(sortPaymentEvents);
    }

    return [...openingBalance, ...visible].sort(sortPaymentEvents);
  }

  function orderPaymentHistory(order) {
    return paymentHistoryForDisplay(orderPaymentRowsForCalculation(order), "Pembayaran Customer");
  }

  function orderPaidTotal(order) {
    return Math.round(orderPaymentRowsForCalculation(order).reduce((s, p) => s + moneyValue(p.amount || 0), 0));
  }

  function sisaOrder(order) {
    return Math.max(0, Math.round(Number(orderPaymentTarget(order) || 0) - Number(orderPaidTotal(order) || 0)));
  }

  function sisaOrderUntukAlokasi(order) {
    const target = orderPaymentTarget(order);
    return Math.max(0, Math.round(Number(target || 0) - Number(orderPaidTotal(order) || 0)));
  }

  function effectiveOrderStatus(order) {
    const deliveryStatus = orderDeliveryStatus(order);
    if (isFinalDeliveryStatus(deliveryStatus) && sisaOrder(order) <= 0 && orderPaymentTarget(order) > 0) return "Lunas";
    return deliveryStatus;
  }

  function isDeliveryComplete(order) {
    return isFinalDeliveryStatus(orderDeliveryStatus(order));
  }

  function supplierTransferOutTotal(supplierName) {
    const key = normalizeName(supplierName || "");
    if (!key) return 0;
    return Math.round((transfersOut || [])
      .filter((t) => normalizeName(t.supplier || "") === key && moneyValue(t.amount || 0) > 0)
      .reduce((s, t) => s + moneyValue(t.amount || 0), 0));
  }

  function purchaseSortValue(purchase) {
    return dateSerial(purchase?.createdAt || purchase?.date || purchase?.tanggal || "");
  }

  function supplierPurchasesSorted(supplierName) {
    const key = normalizeName(supplierName || "");
    return [...(purchases || [])]
      .filter((p) => normalizeName(p.supplier || "") === key)
      .sort((a, b) => {
        const dateDiff = purchaseSortValue(a) - purchaseSortValue(b);
        if (dateDiff !== 0) return dateDiff;
        return String(a.id || "").localeCompare(String(b.id || ""));
      });
  }

  function cleanSupplierPaymentNote(note) {
    const text = String(note || "").trim();
    if (!text) return "Pembayaran Supplier";
    if (text.toLowerCase().includes("migrasi")) return "Pembayaran Supplier";
    return text;
  }

  function usesOpeningBalanceForSupplier(supplierName) {
    // Business rule: Teh Susi notes were historically always paid lunas.
    // Opening balance / migration rows may be used only for these suppliers.
    // Other suppliers (example: Cii Dian) must rely on real payment inputs so
    // fake aggregate migration amounts do not appear as cicilan.
    const key = normalizeName(supplierName || "");
    return ["teh susi"].includes(key);
  }

  function supplierPaymentEventsSorted(supplierName) {
    const key = normalizeName(supplierName || "");
    if (!key) return [];

    // Sumber utama pembayaran supplier adalah transfersOut, karena ini catatan kas keluar yang utuh.
    // Data migrasi lama bisa berisi pecahan alokasi lama, jadi jika ada transfer input asli,
    // riwayat FIFO memakai transfer input asli saja agar tanggal/nominal mengikuti input Bayar Supplier.
    const allTransferEvents = [...(transfersOut || [])]
      .filter((t) => normalizeName(t.supplier || "") === key && moneyValue(t.amount || 0) > 0)
      .map((t) => ({
        id: t.id || "",
        date: t.date || t.createdAt?.slice?.(0, 10) || todayStr(),
        createdAt: t.createdAt || "",
        note: cleanSupplierPaymentNote(t.note || t.bank || "Pembayaran Supplier"),
        amount: moneyValue(t.amount || 0),
        source: t.source || "transfersOut",
        transferOutId: t.id || "",
        transferOutAmount: moneyValue(t.amount || 0),
        transferOutNote: t.note || "",
      }));

    // Semua transfer valid tetap ikut FIFO untuk menghitung sisa tagihan.
    // Namun transfer migrasi hanya dipakai sebagai saldo/alokasi internal, bukan ditampilkan sebagai riwayat pembayaran real.
    if (allTransferEvents.length > 0) {
      return allTransferEvents
        .map((t) => ({ ...t, hiddenFromHistory: isMigratedPaymentSource(t) }))
        .sort(sortPaymentEvents);
    }

    // Fallback hanya untuk data lama yang benar-benar belum pernah punya transfersOut.
    const legacyEvents = supplierPurchasesSorted(supplierName).flatMap((purchase) =>
      (purchase.payments || [])
        .filter((pay) => moneyValue(pay.amount || 0) > 0)
        .map((pay, idx) => ({
          id: `${purchase.id || "legacy"}-${idx}`,
          date: pay.date || purchase.createdAt || todayStr(),
          createdAt: purchase.createdAt || "",
          note: cleanSupplierPaymentNote(pay.note || "Pembayaran Supplier"),
          amount: moneyValue(pay.amount || 0),
          source: "legacy_purchase_payment",
          transferOutId: pay.transferOutId || "",
          transferOutAmount: moneyValue(pay.transferOutAmount || pay.amount || 0),
          transferOutNote: pay.transferOutNote || pay.note || "",
        }))
    );

    return legacyEvents.sort(sortPaymentEvents);
  }

  function supplierFifoPaymentMap(supplierName) {
    const supplierKey = normalizeName(supplierName || "");
    const result = {};
    if (!supplierKey) return result;

    const supplierPurchases = supplierPurchasesSorted(supplierName)
      .map((p) => ({ ...p, remaining: Math.max(0, purchaseInvoiceTotal(p)) }))
      .filter((p) => p.id && p.remaining > 0);

    const supplierPayments = supplierPaymentEventsSorted(supplierName).sort(sortPaymentEventsAsc);
    const allowOpeningBalance = usesOpeningBalanceForSupplier(supplierName);

    let purchaseIndex = 0;
    for (const payment of supplierPayments) {
      // Do not let aggregate migration/saldo rows pay suppliers that should show
      // real cicilan history only. This prevents fake values like 29.336.910
      // from making Cii Dian look lunas without real payment rows.
      if (payment.hiddenFromHistory === true && !allowOpeningBalance) continue;
      let paymentLeft = moneyValue(payment.amount || 0);
      while (paymentLeft > 0 && purchaseIndex < supplierPurchases.length) {
        const purchase = supplierPurchases[purchaseIndex];
        if (purchase.remaining <= 0) { purchaseIndex += 1; continue; }

        const amount = Math.min(paymentLeft, purchase.remaining);
        if (amount > 0) {
          if (!result[purchase.id]) result[purchase.id] = [];
          result[purchase.id].push({
            date: payment.date || todayStr(),
            note: cleanSupplierPaymentNote(payment.note || "Pembayaran Supplier"),
            amount,
            transferOutId: payment.transferOutId || "",
            transferOutAmount: payment.transferOutAmount || moneyValue(payment.amount || 0),
            transferOutNote: payment.transferOutNote || "",
            source: payment.source || "fifo_supplier_payment",
            hiddenFromHistory: payment.hiddenFromHistory === true,
          });
          purchase.remaining = Math.max(0, purchase.remaining - amount);
          paymentLeft = Math.max(0, paymentLeft - amount);
        }

        if (purchase.remaining <= 0) purchaseIndex += 1;
      }
    }

    return result;
  }

  function supplierTransferAllocationDetails(transferOut) {
    const supplierName = transferOut?.supplier || "";
    const transferId = transferOut?.id || "";
    if (!supplierName || !transferId) return [];

    const fifoMap = supplierFifoPaymentMap(supplierName);
    return supplierPurchasesSorted(supplierName).flatMap((purchase) => {
      const rows = fifoMap[purchase.id] || [];
      return rows
        .filter((payment) => payment.transferOutId === transferId)
        .map((payment) => ({
          purchaseId: purchase.id,
          purchaseDate: purchase.createdAt || purchase.date || todayStr(),
          material: purchaseMaterialsSummary(purchase),
          amount: moneyValue(payment.amount || 0),
          purchaseTotal: purchaseInvoiceTotal(purchase),
        }));
    });
  }

  function supplierHasDirectTransfer(supplierName) {
    const key = normalizeName(supplierName || "");
    return key && (transfersOut || []).some((t) => normalizeName(t.supplier || "") === key && moneyValue(t.amount || 0) > 0);
  }

  function purchasePaymentRowsForCalculation(purchase) {
    if (!purchase?.id) return [];
    const fifoRows = supplierFifoPaymentMap(purchase.supplier)[purchase.id] || [];
    if (fifoRows.length > 0) return fifoRows;
    // Sama seperti customer: kalau sudah ada transfersOut utuh untuk supplier ini,
    // jangan fallback ke purchase.payments agar tidak dobel hitung.
    if (supplierHasDirectTransfer(purchase.supplier)) return [];
    return Array.isArray(purchase?.payments) ? purchase.payments : [];
  }

  function purchasePaymentHistory(purchase) {
    return paymentHistoryForDisplay(purchasePaymentRowsForCalculation(purchase), "Pembayaran Supplier");
  }

  function purchasePaidTotal(purchase) {
    const paid = purchasePaymentRowsForCalculation(purchase)
      .reduce((s, p) => s + moneyValue(p.amount || 0), 0);
    return Math.round(paid);
  }

  function sisaPurchase(purchase) {
    const total = Math.round(Number(purchaseInvoiceTotal(purchase) || 0));
    const paid = Math.round(Number(purchasePaidTotal(purchase) || 0));
    return Math.max(0, total - paid);
  }

  function hutangPurchase(purchase) {
    return Math.max(0, Math.round(sisaPurchase(purchase)));
  }

  function depositSupplier(purchase) {
    return Math.max(0, Math.round(purchasePaidTotal(purchase) - purchaseInvoiceTotal(purchase)));
  }


  // ── Stats ──
  const stats = useMemo(() => {
    const customerNames = [...new Set((orders || []).map((o) => normalizeName(o.customer || "")).filter(Boolean))];
    const customerPaid = customerNames.reduce((sum, key) => {
      const order = (orders || []).find((o) => normalizeName(o.customer || "") === key);
      return sum + moneySum(customerPaymentEventsSorted(order?.customer || key), (p) => p.amount);
    }, 0);
    const transferTotal = customerPaid;
    const receivable = totalPiutangCustomerAktif();
    const supplierNames = [...new Set((purchases || []).map((p) => normalizeName(p.supplier || "")).filter(Boolean))];
    const supplierPaid = supplierNames.reduce((sum, key) => {
      const purchase = (purchases || []).find((p) => normalizeName(p.supplier || "") === key);
      return sum + moneySum(supplierPaymentEventsSorted(purchase?.supplier || key), (p) => p.amount);
    }, 0);
    const supplierDebt = purchases.reduce((s, p) => s + hutangPurchase(p), 0);
    const otherExpense = moneySum(expenses, (e) => e.amount);
    const cashOut = supplierPaid + otherExpense;
    const netCash = customerPaid - cashOut;
    return { customerPaid, transferTotal, cashOut, receivable, supplierDebt, netCash };
  }, [orders, purchases, expenses, transfers, transfersOut]);

  const pesananTelat = useMemo(() => {
    const now = new Date();
    return orders.filter((o) => {
      if (effectiveOrderStatus(o) === "Lunas") return false;
      const sisa = sisaOrder(o);
      if (sisa <= 0) return false;
      const paymentHistory = orderPaymentHistory(o);
      const lastPayStr = paymentHistory.length > 0 ? paymentHistory[paymentHistory.length - 1].date : (o.createdAt || null);
      if (!lastPayStr) return true;
      const lastPayDate = new Date(lastPayStr + "T00:00:00");
      if (isNaN(lastPayDate.getTime())) return true;
      const diffDays = Math.floor((now - lastPayDate) / (1000 * 60 * 60 * 24));
      return diffDays >= 7;
    });
  }, [orders, transfers]);

  const uniqueCustomers = useMemo(() => {
    const map = {};
    orders.forEach(o => {
      const name = capitalizeWords(o.customer || "");
      const key = normalizeName(name);
      if (!key) return;
      if (!map[key]) map[key] = { name, totalSisa: 0, sisa: 0, tagihan: 0, totalBayar: 0, totalPesanan: 0, pesananAktif: 0, totalRealisasiSisa: 0 };
      map[key].totalPesanan += 1;
      const sisaAlokasi = Math.max(0, sisaOrderUntukAlokasi(o));
      const sisaRealisasi = Math.max(0, sisaOrder(o));
      map[key].tagihan += Math.max(0, orderPaymentTarget(o));
      map[key].totalBayar += Math.max(0, orderPaidTotal(o));
      map[key].sisa += sisaRealisasi;
      if (sisaAlokasi > 0) {
        map[key].totalSisa += sisaAlokasi;
        map[key].totalRealisasiSisa += sisaRealisasi;
        map[key].pesananAktif += 1;
      }
    });
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  }, [orders, transfers]);

  function customerReceivableTotals(customerName) {
    const key = normalizeName(customerName || "");
    if (!key) return { name: "", orders: [], totalTagihan: 0, totalBayar: 0, sisa: 0, orderCount: 0 };
    const customerOrders = (orders || []).filter((o) => normalizeName(o.customer || "") === key);
    const totalTagihan = customerOrders.reduce((sum, o) => sum + Math.max(0, orderPaymentTarget(o)), 0);
    const totalBayar = customerOrders.reduce((sum, o) => sum + Math.max(0, orderPaidTotal(o)), 0);
    const sisa = customerOrders.reduce((sum, o) => sum + Math.max(0, sisaOrder(o)), 0);
    return {
      name: capitalizeWords(customerOrders[0]?.customer || customerName || ""),
      orders: customerOrders,
      totalTagihan: Math.round(totalTagihan),
      totalBayar: Math.round(totalBayar),
      sisa: Math.round(sisa),
      orderCount: customerOrders.length,
    };
  }

  function totalPiutangCustomerAktif() {
    const customerKeys = [...new Set((orders || []).map((o) => normalizeName(o.customer || "")).filter(Boolean))];
    return customerKeys.reduce((sum, key) => sum + customerReceivableTotals(key).sisa, 0);
  }

  const uniqueSuppliers = useMemo(() => {
    const map = {};
    purchases.forEach(p => {
      const name = capitalizeWords(p.supplier || "");
      const key = normalizeName(name);
      if (!key) return;
      if (!map[key]) map[key] = { name, totalSisa: 0, totalBelanja: 0, belanjaAktif: 0 };
      map[key].totalBelanja += 1;
      const sisa = hutangPurchase(p);
      if (sisa > 0) { map[key].totalSisa += sisa; map[key].belanjaAktif += 1; }
    });
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  }, [purchases, transfersOut]);

  // ── Search filter ──
  const q = search.toLowerCase();
  const filteredOrders = useMemo(() => orders
    .filter((o) => {
      const itemText = normalizeOrderItems(o).map((it) => it.name).join(" ").toLowerCase();
      return !q || o.customer?.toLowerCase().includes(q) || o.invoice?.toLowerCase().includes(q) || itemText.includes(q);
    })
    .sort(sortOldestBottom), [orders, q]);

  const filteredPurchases = useMemo(() => [...purchases]
    .filter((p) => {
      const bahanText = normalizePurchaseMaterials(p).map((it) => it.name).join(" ").toLowerCase();
      return !q || p.supplier?.toLowerCase().includes(q) || p.material?.toLowerCase().includes(q) || bahanText.includes(q);
    })
    .sort(sortPurchaseNewestFirst), [purchases, q]);

  const filteredMaterialsStock = useMemo(() => (materialsStock || []).filter((m) => {
    return !q || String(m?.name || "").toLowerCase().includes(q) || String(m?.category || "").toLowerCase().includes(q);
  }), [materialsStock, q]);

  const productsWithoutHpp = useMemo(() => (productMasters || []).filter((p) => p?.isActive !== false && calculateProductHpp(p) <= 0), [productMasters]);

  const filteredProductMasters = useMemo(() => (productMasters || []).filter((p) => {
    if (productQuickFilter === "missing-hpp" && !(p?.isActive !== false && calculateProductHpp(p) <= 0)) return false;
    return !q || String(p?.name || "").toLowerCase().includes(q) || String(p?.category || "").toLowerCase().includes(q) || String(p?.mainMaterial || "").toLowerCase().includes(q);
  }), [productMasters, q, productQuickFilter]);

  const filteredExpenses = useMemo(() => (expenses || [])
    .filter((e) => !q || String(e?.category || "").toLowerCase().includes(q) || String(e?.note || "").toLowerCase().includes(q))
    .sort(sortOldestBottom), [expenses, q]);

  const combinedExpenseRows = useMemo(() => {
    const manualRows = (filteredExpenses || []).map((e) => ({
      id: e.id,
      rowType: "expense",
      date: e.date || todayStr(),
      title: e.category || "Pengeluaran",
      subtitle: e.note || "Biaya operasional",
      amount: moneyValue(e.amount || 0),
      raw: e,
    }));

    const supplierTransferRows = (transfersOut || [])
      .map((t) => ({
        id: t.id || `${t.date || todayStr()}-${t.supplier || "supplier"}-${t.amount || 0}`,
        rowType: "supplier_transfer",
        date: t.date || t.createdAt?.slice?.(0, 10) || todayStr(),
        title: t.supplier || "Supplier",
        subtitle: `${t.bank || "Bayar Supplier"}${t.note ? ` · ${t.note}` : ""}`,
        amount: moneyValue(t.amount || 0),
        raw: t,
      }))
      .filter((t) => t.amount > 0 && (!q || String(t.title || "").toLowerCase().includes(q) || String(t.subtitle || "").toLowerCase().includes(q)));

    return [...manualRows, ...supplierTransferRows].sort(sortOldestBottom);
  }, [filteredExpenses, transfersOut, q]);

  const totalCombinedExpenses = useMemo(() => (
    combinedExpenseRows.reduce((s, row) => s + moneyValue(row.amount || 0), 0)
  ), [combinedExpenseRows]);

  const filteredTransfers = useMemo(() => (transfers || [])
    .filter((t) => !q || String(t?.customer || "").toLowerCase().includes(q) || String(t?.bank || "").toLowerCase().includes(q) || String(t?.note || "").toLowerCase().includes(q))
    .sort(sortOldestBottom), [transfers, q]);

  const filteredTransfersOut = useMemo(() => (transfersOut || [])
    .filter((t) => !q || String(t?.supplier || "").toLowerCase().includes(q) || String(t?.bank || "").toLowerCase().includes(q) || String(t?.note || "").toLowerCase().includes(q))
    .sort(sortOldestBottom), [transfersOut, q]);

  const autoTransferInRows = useMemo(() => {
    return (transfers || [])
      .map((t) => ({
        id: t.id || `${t.date || todayStr()}-${t.customer || "customer"}-${t.amount || 0}`,
        date: t.date || t.createdAt?.slice?.(0, 10) || todayStr(),
        customer: t.customer || "Customer",
        bank: t.bank || "Bayar Customer",
        note: cleanCustomerPaymentNote(t.note || ""),
        amount: moneyValue(t.amount || 0),
      }))
      .filter((t) => t.amount > 0 && (!q || String(t.customer || "").toLowerCase().includes(q) || String(t.bank || "").toLowerCase().includes(q) || String(t.note || "").toLowerCase().includes(q)))
      .sort(sortOldestBottom);
  }, [transfers, q]);

  const autoTransferOutRows = useMemo(() => {
    return (transfersOut || [])
      .map((t) => ({
        id: t.id || `${t.date || todayStr()}-${t.supplier || "supplier"}-${t.amount || 0}`,
        date: t.date || t.createdAt?.slice?.(0, 10) || todayStr(),
        supplier: t.supplier || "Supplier",
        bank: t.bank || "Bayar Supplier",
        note: cleanSupplierPaymentNote(t.note || ""),
        amount: moneyValue(t.amount || 0),
      }))
      .filter((t) => t.amount > 0 && (!q || String(t.supplier || "").toLowerCase().includes(q) || String(t.bank || "").toLowerCase().includes(q) || String(t.note || "").toLowerCase().includes(q)))
      .sort(sortOldestBottom);
  }, [transfersOut, q]);

  const transferInNameOptions = useMemo(() => {
    const names = new Set();
    autoTransferInRows.forEach((t) => {
      const name = capitalizeWords(t.customer || "");
      if (name) names.add(name);
    });
    return ["semua", ...Array.from(names).sort((a, b) => a.localeCompare(b))];
  }, [autoTransferInRows]);

  const transferOutNameOptions = useMemo(() => {
    const names = new Set();
    autoTransferOutRows.forEach((t) => {
      const name = capitalizeWords(t.supplier || "");
      if (name) names.add(name);
    });
    return ["semua", ...Array.from(names).sort((a, b) => a.localeCompare(b))];
  }, [autoTransferOutRows]);

  const selectedTransferInRows = useMemo(() => {
    if (filterTransferInName === "semua") return autoTransferInRows;
    const selected = normalizeName(filterTransferInName);
    return autoTransferInRows.filter((t) => normalizeName(t.customer) === selected);
  }, [autoTransferInRows, filterTransferInName]);

  const selectedTransferOutRows = useMemo(() => {
    if (filterTransferOutName === "semua") return autoTransferOutRows;
    const selected = normalizeName(filterTransferOutName);
    return autoTransferOutRows.filter((t) => normalizeName(t.supplier) === selected);
  }, [autoTransferOutRows, filterTransferOutName]);

  const totalSelectedTransferIn = useMemo(() => (
    selectedTransferInRows.reduce((s, t) => s + moneyValue(t.amount || 0), 0)
  ), [selectedTransferInRows]);

  const totalSelectedTransferOut = useMemo(() => (
    selectedTransferOutRows.reduce((s, t) => s + moneyValue(t.amount || 0), 0)
  ), [selectedTransferOutRows]);

  const productCategoryOptions = useMemo(() => {
    const map = {};
    productCategories.forEach((c) => { const name = capitalizeWords(c.name || ""); if (name) map[normalizeName(name)] = name; });
    productMasters.forEach((p) => { const name = capitalizeWords(p.category || ""); if (name) map[normalizeName(name)] = name; });
    ["Kerudung", "Mukena", "Baju Anak", "Gamis", "Lainnya"].forEach((name) => { if (!map[normalizeName(name)]) map[normalizeName(name)] = name; });
    return Object.values(map).sort((a, b) => a.localeCompare(b));
  }, [productCategories, productMasters]);

  function findProductMaster(name) {
    return productMasters.find((p) => normalizeName(p.name) === normalizeName(name));
  }

  // ── CRUD ──
  async function upsertProductCategory(categoryName) {
    const name = capitalizeWords(categoryName || "Lainnya");
    if (!name) return;
    const existing = productCategories.find((c) => normalizeName(c.name) === normalizeName(name));
    if (!existing?.id) await addDoc(collection(db, "productCategories"), { name, createdAt: todayStr(), updatedAt: todayStr(), source: "auto_dari_pesanan" });
  }

  async function upsertProductMastersFromOrder(items) {
    for (const it of items) {
      const name = capitalizeWords(it.name || "");
      if (!name) continue;
      const category = capitalizeWords(it.category || "Lainnya");
      await upsertProductCategory(category);
      const existing = productMasters.find((p) => normalizeName(p.name) === normalizeName(name));
      const latestPrice = moneyValue(it.price || 0);
      const existingPrice = firstPositiveMoney(existing?.defaultPrice, existing?.price, existing?.hargaJual, existing?.sellingPrice, existing?.salePrice, existing?.hargaPcs, existing?.unitPrice);
      const priceForMaster = latestPrice > 0 ? latestPrice : existingPrice;
      const priceFields = priceForMaster > 0 ? {
        // Harga produk fluktuatif: harga input pesanan customer adalah harga terbaru
        // untuk default pesanan berikutnya. Invoice pesanan lama tetap memakai
        // harga yang tersimpan di item pesanan lama. Jika item lama tidak punya harga,
        // jangan menimpa master produk yang sudah ada menjadi Rp 0.
        defaultPrice: priceForMaster,
        price: priceForMaster,
        hargaJual: priceForMaster,
        sellingPrice: priceForMaster,
        salePrice: priceForMaster,
        hargaPcs: priceForMaster,
        unitPrice: priceForMaster,
      } : {};
      const itemHppMaterials = normalizeHppMaterials(it);
      const existingHppMaterials = normalizeHppMaterials(existing);
      const savedHppMaterials = itemHppMaterials.length > 0 ? itemHppMaterials : existingHppMaterials;
      const savedBahanCost = hppMaterialsCost({ hppMaterials: savedHppMaterials }) || moneyValue(it.bahanCost || existing?.bahanCost || 0);
      const payload = {
        name, category,
        ...priceFields,
        bahanCost: savedBahanCost,
        hppPerPcs: moneyValue(it.hppPerPcs || existing?.hppPerPcs || 0),
        mainMaterial: savedHppMaterials[0]?.name || it.mainMaterial || existing?.mainMaterial || "",
        materialQtyPerPcs: Number(savedHppMaterials[0]?.usagePerPcs || it.materialQtyPerPcs || existing?.materialQtyPerPcs || 0),
        bahanPricePerUnit: moneyValue(savedHppMaterials[0]?.pricePerUnit || existing?.bahanPricePerUnit || 0),
        hppMaterials: savedHppMaterials,
        unit: savedHppMaterials[0]?.unit || it.unit || existing?.unit || "yard",
        updatedAt: todayStr(), source: "auto_dari_pesanan",
      };
      if (existing?.id) await updateDoc(doc(db, "products", existing.id), payload);
      else await addDoc(collection(db, "products"), { ...payload, createdAt: todayStr() });
    }
  }

  async function recordMaterialMutation(line) {
    try {
      await addDoc(collection(db, "materialMutations"), {
        date: line.date || todayStr(), type: line.type || "adjustment",
        materialName: capitalizeWords(line.name || line.materialName || ""),
        category: line.category || "Bahan", unit: normalizeMaterialUnit(line.name || line.materialName, line.unit),
        qty: Number(line.qty || 0), total: moneyValue(line.total || 0),
        refType: line.refType || "manual", refId: line.refId || "", refLabel: line.refLabel || "",
        note: line.note || "", createdAt: new Date().toISOString(), user: user?.email || "-",
      });
    } catch (e) { console.warn("Gagal mencatat mutasi bahan:", e); }
  }

  async function applyMaterialMovements(items, options = {}) {
    const direction = Number(options.direction || 1) >= 0 ? 1 : -1;
    const refType = options.refType || "manual";
    const refId = options.refId || "";
    const refLabel = options.refLabel || "";
    const date = options.date || todayStr();
    const allowMinus = options.allowMinus === true;
    const aggregated = aggregateMaterialLines(items);
    if (aggregated.length === 0) return;

    const localMap = {};
    (materialsStock || []).forEach((m) => {
      const unit = normalizeMaterialUnit(m.name, m.unit);
      localMap[materialLineKey(m.name, unit)] = { ...m, unit };
    });

    for (const it of aggregated) {
      const name = capitalizeWords(it.name || "");
      const unit = normalizeMaterialUnit(name, it.unit);
      const key = materialLineKey(name, unit);
      const qty = assertReasonableQty(it.qty || 0, `Qty ${name}`);
      const qtyDelta = qty * direction;
      let existing = localMap[key];
      let mutationTotalDelta = 0;

      if (!existing?.id && direction < 0) throw new Error(`Stok bahan ${name} belum ada, tidak bisa dikurangi.`);
      if (existing?.id && existing.unit && existing.unit !== unit) throw new Error(`Satuan bahan ${name} sudah tercatat sebagai ${existing.unit}. Tidak bisa digabung dengan ${unit}.`);

      if (!existing?.id) {
        const stock = Math.max(0, qty);
        const totalValue = Math.round(Math.max(0, moneyValue(it.total || 0)));
        mutationTotalDelta = totalValue;
        const avgCost = stock > 0 ? Math.round(totalValue / stock) : 0;
        if (avgCost > LIMITS.MAX_AVG_COST || totalValue > LIMITS.MAX_STOCK_VALUE_PER_MATERIAL) {
          throw new Error(`Nilai stok ${name} tidak masuk akal. Cek harga/qty sebelum menyimpan.`);
        }
        const payload = { name, category: it.category || "Bahan", unit, stock, minStock: unit === "kg" ? 5 : 20, avgCost, totalValue, createdAt: todayStr(), updatedAt: todayStr(), source: refType === "purchase" ? "auto_dari_belanja_supplier" : "auto_dari_mutasi" };
        const created = await addDoc(collection(db, "materials"), payload);
        existing = { id: created.id, ...payload };
        localMap[key] = existing;
      } else {
        const oldStock = Number(existing.stock || 0);
        const oldValue = safeMaterialStockValue(existing);
        const movementValue = direction < 0
          ? (moneyValue(it.total || 0) > 0 ? Math.round(moneyValue(it.total || 0)) : Math.round(qty * Math.round(Number(existing.avgCost || 0))))
          : Math.round(moneyValue(it.total || 0));
        const totalDelta = movementValue * direction;
        mutationTotalDelta = totalDelta;
        const nextStockRaw = oldStock + qtyDelta;
        if (!allowMinus && nextStockRaw < -0.000001) throw new Error(`Stok ${name} tidak cukup. Sisa ${oldStock.toLocaleString("id-ID")} ${unit}, butuh ${Math.abs(qtyDelta).toLocaleString("id-ID")} ${unit}.`);
        const newStock = allowMinus ? nextStockRaw : Math.max(0, nextStockRaw);
        const newValue = Math.round(Math.max(0, oldValue + totalDelta));
        const avgCost = newStock > 0 ? Math.round(newValue / newStock) : Math.round(Number(existing.avgCost || 0));
        if (avgCost > LIMITS.MAX_AVG_COST || newValue > LIMITS.MAX_STOCK_VALUE_PER_MATERIAL) {
          throw new Error(`Nilai stok ${name} tidak masuk akal. Cek harga/qty atau bersihkan data stok lama terlebih dahulu.`);
        }
        const payload = { name, category: it.category || existing.category || "Bahan", unit, stock: newStock, avgCost, totalValue: newValue, updatedAt: todayStr() };
        await updateDoc(doc(db, "materials", existing.id), payload);
        existing = { ...existing, ...payload };
        localMap[key] = existing;
      }

      await recordMaterialMutation({ date, type: direction > 0 ? "masuk" : "keluar", name, category: it.category || existing.category || "Bahan", unit, qty: qtyDelta, total: mutationTotalDelta, refType, refId, refLabel, note: options.note || (direction > 0 ? "Stok masuk" : "Stok keluar") });
    }
  }

  async function applyPurchaseStock(purchase) {
    await applyMaterialMovements(normalizePurchaseMaterials(purchase), { direction: 1, refType: "purchase", refId: purchase?.id || "", refLabel: purchase?.supplier || "Belanja supplier", date: purchase?.createdAt || todayStr(), note: "Belanja supplier" });
  }

  async function rollbackPurchaseStock(purchase) {
    await applyMaterialMovements(normalizePurchaseMaterials(purchase), { direction: -1, refType: "purchase_rollback", refId: purchase?.id || "", refLabel: purchase?.supplier || "Rollback supplier", date: todayStr(), note: "Rollback edit/hapus belanja supplier", allowMinus: false });
  }

  async function saveProductTemplate() {
    if (!String(productForm.name || "").trim()) return alert("Nama produk wajib diisi");
    if (!String(productForm.category || "").trim()) return alert("Kategori wajib diisi");
    if (!moneyValue(productForm.defaultPrice || 0)) return alert("Harga jual wajib diisi");
    setIsSaving(true);
    try {
      const name = capitalizeWords(productForm.name);
      const category = capitalizeWords(productForm.category || "Lainnya");
      await upsertProductCategory(category);
      const existing = productMasters.find((p) => normalizeName(p.name) === normalizeName(name));
      const materialRows = normalizeHppMaterials(productForm);
      const firstMaterial = materialRows[0] || null;
      const materialQtyPerPcs = firstMaterial ? numberValue(firstMaterial.usagePerPcs || 0) : numberValue(productForm.materialQtyPerPcs || 0);
      const bahanPricePerUnit = firstMaterial ? moneyValue(firstMaterial.pricePerUnit || 0) : moneyValue(productForm.bahanPricePerUnit || 0);
      const multiBahanCost = materialRows.reduce((sum, row) => sum + moneyValue(row.total || 0), 0);
      const bahanCost = multiBahanCost > 0
        ? multiBahanCost
        : (bahanPricePerUnit > 0 && materialQtyPerPcs > 0 ? Math.round(bahanPricePerUnit * materialQtyPerPcs) : moneyValue(productForm.bahanCost || 0));
      const hppPerPcs = calculateProductHpp({ ...productForm, bahanCost, hppMaterials: materialRows });
      const payload = {
        imageUrl: productForm.imageUrl || "", name, category,
        defaultPrice: moneyValue(productForm.defaultPrice || 0),
        price: moneyValue(productForm.defaultPrice || 0),
        hargaJual: moneyValue(productForm.defaultPrice || 0),
        sellingPrice: moneyValue(productForm.defaultPrice || 0),
        salePrice: moneyValue(productForm.defaultPrice || 0),
        hargaPcs: moneyValue(productForm.defaultPrice || 0),
        unitPrice: moneyValue(productForm.defaultPrice || 0),
        mainMaterial: firstMaterial?.name || capitalizeWords(productForm.mainMaterial || ""),
        materialQtyPerPcs,
        unit: firstMaterial?.unit || (productForm.unit === "kg" ? "kg" : "yard"),
        bahanPricePerUnit,
        bahanCost,
        hppMaterials: materialRows,
        productionCost: moneyValue(productForm.productionCost || 0),
        distributionCost: moneyValue(productForm.distributionCost || 0),
        otherCost: moneyValue(productForm.otherCost || 0),
        hppPerPcs,
        isActive: productForm.isActive !== false,
        updatedAt: todayStr(), source: "manual_template",
      };
      if (existing?.id) await updateDoc(doc(db, "products", existing.id), payload);
      else await addDoc(collection(db, "products"), { ...payload, createdAt: todayStr() });
      addAuditLog("Simpan Template Produk", `${name} - HPP ${rupiah(payload.hppPerPcs)}`);
      setProductForm(emptyProductForm); setModal(null);
    } catch (e) { alert("Gagal menyimpan produk: " + e.message); }
    finally { setIsSaving(false); scheduleRefresh("products", "productCategories"); }
  }

  async function addOrder() {
    if (!String(orderForm.customer || "").trim()) return alert("Nama customer wajib diisi");
    const cleanItems = (orderForm.items || [])
      .map((it) => ({
        name: String(it.name || "").trim(), category: capitalizeWords(it.category || "Lainnya"),
        qty: Number(it.qty || 0), price: moneyValue(it.price || 0),
        bahanCost: moneyValue(it.bahanCost || 0), hppPerPcs: moneyValue(it.hppPerPcs || 0),
        productId: it.productId || "", mainMaterial: it.mainMaterial || "",
        materialQtyPerPcs: numberValue(it.materialQtyPerPcs || 0), unit: normalizeMaterialUnit(it.mainMaterial || it.name, it.unit),
        hppMaterials: normalizeHppMaterials(it),
        note: shipmentAutoNote(Number(it.qty || 0), 0),
      }))
      .filter((it) => it.name && it.qty > 0 && it.price >= 0);
    if (cleanItems.length === 0) return alert("Minimal isi 1 produk dengan nama dan jumlah pcs.");
    if (cleanItems.some((it) => it.qty < 0)) return alert("Jumlah pcs tidak boleh negatif");
    const subtotal = orderItemsTotal(cleanItems);
    const shippingCost = moneyValue(orderForm.shippingCost || 0);
    const total = subtotal + shippingCost;
    if (!total) return alert("Total pesanan wajib diisi");
    setIsSaving(true);
    try {
      const dp = moneyValue(orderForm.dp || 0);
      const firstItem = cleanItems[0] || {};
      await upsertProductMastersFromOrder(cleanItems);
      const newOrder = {
        invoice: await generateInvoice(), customer: capitalizeWords(orderForm.customer),
        phone: orderForm.phone || "", items: cleanItems,
        item: firstItem.name || "Produk", qty: cleanItems.reduce((s, it) => s + Number(it.qty || 0), 0),
        hargaPcs: moneyValue(firstItem.price || 0), subtotal, shippingCost, ongkir: shippingCost, total,
        status: "Proses", createdAt: orderForm.date || todayStr(),
        payments: dp > 0 ? [{ date: todayStr(), note: "DP Awal", amount: dp }] : [],
      };
      await addDoc(collection(db, "orders"), newOrder);
      addAuditLog("Tambah Pesanan", `${newOrder.customer} - ${newOrder.invoice} - ${rupiah(newOrder.total)}`);
      resetOrderDraft(); setModal(null);
    } catch (e) { alert("Gagal menyimpan: " + e.message); }
    finally { setIsSaving(false); scheduleRefresh("orders", "products", "productCategories"); }
  }

  async function addPurchase() {
    if (!purchaseForm.supplier.trim()) return alert("Nama supplier wajib diisi");
    const cleanMaterials = (purchaseForm.materials || [])
      .map((it) => {
        const name = capitalizeWords(it.name || "");
        const qty = assertReasonableQty(it.qty || 0, `Qty ${name || "bahan"}`);
        const pricePerUnit = assertReasonableMoney(it.pricePerUnit || 0, `Harga ${name || "bahan"}`, LIMITS.MAX_PRICE_PER_UNIT);
        return { name, category: it.category || "Kain", qty, unit: normalizeMaterialUnit(name, it.unit), pricePerUnit, total: qty * pricePerUnit };
      })
      .filter((it) => it.name && it.qty > 0 && it.pricePerUnit > 0);
    if (cleanMaterials.length === 0) return alert("Minimal isi 1 bahan, qty, dan harga per yard/kg.");
    if (cleanMaterials.some((it) => it.qty < 0)) return alert("Qty bahan tidak boleh negatif");
    const subtotal = purchaseMaterialsTotal(cleanMaterials);
    const shippingCost = moneyValue(purchaseForm.shippingCost || purchaseForm.ongkir || 0);
    const total = subtotal + shippingCost;
    if (!total) return alert("Total belanja wajib diisi");
    setIsSaving(true);
    let purchaseRef = null; let stockApplied = false;
    try {
      const dp = moneyValue(purchaseForm.dp || 0);
      const firstMaterial = cleanMaterials[0] || {};
      const newPurchasePayload = {
        supplier: purchaseForm.supplier.trim(), materials: cleanMaterials,
        material: cleanMaterials.map((it) => it.name).join(", ") || "Bahan Baku",
        qty: cleanMaterials.map((it) => `${it.qty} ${it.unit}`).join(", "),
        category: firstMaterial.category || "Kain", subtotal, shippingCost, ongkir: shippingCost, total, createdAt: purchaseForm.date || todayStr(),
        payments: dp > 0 ? [{ date: todayStr(), note: "DP Supplier", amount: dp }] : [],
      };
      purchaseRef = await addDoc(collection(db, "purchases"), newPurchasePayload);
      if (dp > 0) {
        await addDoc(collection(db, "transfersOut"), {
          date: todayStr(),
          supplier: capitalizeWords(newPurchasePayload.supplier),
          bank: "DP Supplier",
          note: `DP awal · ${purchaseMaterialsSummary(newPurchasePayload)}`,
          amount: dp,
          source: "dp_supplier",
          purchaseId: purchaseRef.id,
          createdAt: new Date().toISOString(),
          user: user?.email || "-",
        });
      }
      await applyPurchaseStock({ id: purchaseRef.id, ...newPurchasePayload });
      stockApplied = true;
      addAuditLog("Tambah Supplier", `${newPurchasePayload.supplier} - ${rupiah(newPurchasePayload.total)}`);
      setPurchaseForm({ date: todayStr(), supplier: "", materials: [emptyPurchaseMaterial()], shippingCost: 0, dp: 0 }); setModal(null);
    } catch (e) {
      try {
        if (stockApplied && purchaseRef?.id) { const cp = purchases.find((p) => p.id === purchaseRef.id); if (cp) await rollbackPurchaseStock(cp); }
        if (purchaseRef?.id) await deleteDoc(doc(db, "purchases", purchaseRef.id));
      } catch (cleanupErr) { console.warn("Cleanup tambah supplier gagal:", cleanupErr); }
      alert("Gagal menyimpan: " + e.message);
    }
    finally { setIsSaving(false); scheduleRefresh("purchases", "materials", "transfersOut"); }
  }

  async function addExpense() {
    if (!expenseForm.category.trim()) return alert("Kategori wajib diisi");
    if (!expenseForm.amount) return alert("Nominal wajib diisi");
    setIsSaving(true);
    try {
      const payload = { date: expenseForm.date || todayStr(), category: expenseForm.category.trim(), note: expenseForm.note || "", amount: moneyValue(expenseForm.amount || 0) };
      await addDoc(collection(db, "expenses"), payload);
      addAuditLog("Tambah Pengeluaran", `${payload.category} - ${rupiah(payload.amount)}`);
      setExpenseForm({ date: todayStr(), category: "", note: "", amount: 0 }); setModal(null);
    } catch (e) { alert("Gagal menyimpan: " + e.message); }
    finally { setIsSaving(false); scheduleRefresh("expenses"); }
  }

  // ── Tambah Transfer ──
  async function addTransfer() {
    if (!transferForm.customer.trim()) return alert("Nama customer/pengirim wajib diisi");
    if (!transferForm.bank.trim()) return alert("Bank/metode transfer wajib diisi");
    if (!parseMoney(transferForm.amount)) return alert("Nominal wajib diisi");
    setIsSaving(true);
    try {
      const payload = {
        date: transferForm.date || todayStr(),
        customer: capitalizeWords(transferForm.customer),
        bank: transferForm.bank.trim(),
        note: transferForm.note || "",
        amount: parseMoney(transferForm.amount),
        createdAt: new Date().toISOString(),
        user: user?.email || "-",
      };
      await addDoc(collection(db, "transfers"), payload);
      addAuditLog("Catat Transfer Masuk", `${payload.customer} - ${payload.bank} - ${rupiah(payload.amount)}`);
      setTransferForm({ date: todayStr(), customer: "", bank: "", note: "", amount: 0 });
      setModal(null);
    } catch (e) { alert("Gagal menyimpan: " + e.message); }
    finally { setIsSaving(false); scheduleRefresh("transfers"); }
  }

  // ── Tambah Transfer Keluar ──
  async function addTransferOut() {
    if (!transferOutForm.supplier.trim()) return alert("Nama supplier/penerima wajib diisi");
    if (!transferOutForm.bank.trim()) return alert("Bank/metode transfer wajib diisi");
    if (!parseMoney(transferOutForm.amount)) return alert("Nominal wajib diisi");
    setIsSaving(true);
    try {
      const payload = {
        date: transferOutForm.date || todayStr(),
        supplier: capitalizeWords(transferOutForm.supplier),
        bank: transferOutForm.bank.trim(),
        note: transferOutForm.note || "",
        amount: parseMoney(transferOutForm.amount),
        createdAt: new Date().toISOString(),
        user: user?.email || "-",
      };
      await addDoc(collection(db, "transfersOut"), payload);
      addAuditLog("Catat Transfer Keluar", `${payload.supplier} - ${payload.bank} - ${rupiah(payload.amount)}`);
      setTransferOutForm({ date: todayStr(), supplier: "", bank: "", note: "", amount: 0 });
      setModal(null);
    } catch (e) { alert("Gagal menyimpan: " + e.message); }
    finally { setIsSaving(false); scheduleRefresh("transfersOut"); }
  }

  async function addOrderPayment() {
    if (!orderPayForm.customer.trim()) return alert("Nama customer/pengirim wajib diisi");
    if (!orderPayForm.bank.trim()) return alert("Bank/metode transfer wajib diisi");
    const paymentAmount = parseMoney(orderPayForm.amount);
    if (paymentAmount <= 0) return alert("Nominal pembayaran wajib diisi");

    const customerName = capitalizeWords(orderPayForm.customer);
    const normQ = normalizeName(customerName);
    const customerOrders = orders
      .filter((o) => normalizeName(o.customer) === normQ && sisaOrderUntukAlokasi(o) > 0)
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

    setIsSaving(true);
    try {
      const date = orderPayForm.date || todayStr();
      const bank = orderPayForm.bank.trim();
      const note = orderPayForm.note || "Pembayaran customer";

      // Gunakan writeBatch agar transfer masuk + alokasi order tersimpan atomik.
      // Kalau salah satu gagal, semua dibatalkan — tidak ada data setengah tersimpan.
      const batch = writeBatch(db);

      const transferRef = doc(collection(db, "transfers"));
      batch.set(transferRef, {
        date,
        customer: customerName,
        bank,
        note,
        amount: paymentAmount,
        source: "bayar_customer_utuh",
        createdAt: new Date().toISOString(),
        user: user?.email || "-",
      });

      let sisa = paymentAmount;
      const alokasi = [];
      for (const order of customerOrders) {
        if (sisa <= 0) break;
        const sisaOrder_ = Math.max(0, sisaOrderUntukAlokasi(order));
        if (sisaOrder_ <= 0) continue;
        const bayar = Math.min(sisa, sisaOrder_);
        sisa -= bayar;
        const newPayment = {
          date,
          note: bank,
          amount: bayar,
          transferId: transferRef.id,
          transferAmount: paymentAmount,
          transferNote: note,
        };
        const updatedPayments = [...(order.payments || []), newPayment];
        const billable = orderPaymentTarget(order);
        const totalPaid = Math.round(updatedPayments.reduce((s, p) => s + moneyValue(p.amount || 0), 0));
        const lunas = totalPaid >= billable && billable > 0;
        batch.update(doc(db, "orders", order.id), {
          payments: updatedPayments,
          ...(lunas ? { status: "Lunas" } : {}),
        });
        alokasi.push({ invoice: order.invoice, bayar });
      }

      await batch.commit();

      addAuditLog("Bayar Customer", `${customerName} - ${bank} - ${rupiah(paymentAmount)}${alokasi.length ? "" : ""}`);
      const info = alokasi.length > 0
        ? `\n\nRincian pembayaran:\n${alokasi.map(a => `${a.invoice || "Pesanan"}: ${rupiah(a.bayar)}`).join("\n")}`
        : "\n\nTidak ada pesanan aktif, jadi hanya dicatat sebagai transfer masuk.";
      const sisaMsg = sisa > 0 ? `\nSisa ${rupiah(sisa)} dicatat sebagai kelebihan pembayaran.` : "";
      alert(`✅ Realisasi pembayaran customer tersimpan: ${rupiah(paymentAmount)}`);
      setOrderPayForm({ customer: "", date: todayStr(), bank: "", note: "", amount: 0 });
      setModal(null);
    } catch (e) { alert("Gagal menyimpan: " + e.message); }
    finally { setIsSaving(false); scheduleRefresh("transfers", "orders"); }
  }

  async function addSupplierPayment() {
    if (!supplierPayForm.supplier) return alert("Pilih nama supplier terlebih dahulu");
    const supplierPaymentAmount = parseMoney(supplierPayForm.amount);
    if (supplierPaymentAmount <= 0) return alert("Nominal pembayaran wajib diisi");
    if (supplierPaymentAmount > LIMITS.MAX_MONEY_INPUT) return alert(`Nominal pembayaran terlalu besar: ${rupiah(supplierPaymentAmount)}`);

    const supplierName = capitalizeWords(supplierPayForm.supplier);
    const normQ = normalizeName(supplierName);
    const supplierPurchases = purchases
      .filter((p) => normalizeName(p.supplier) === normQ && sisaPurchase(p) > 0)
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

    if (supplierPurchases.length === 0) return alert("Tidak ada tagihan aktif untuk supplier ini.");

    setIsSaving(true);
    try {
      let sisa = supplierPaymentAmount;
      const date = supplierPayForm.date || todayStr();
      const note = supplierPayForm.note || "Pembayaran Supplier";

      // Gunakan writeBatch agar transfer keluar + alokasi tagihan tersimpan atomik.
      const batch = writeBatch(db);

      const transferOutRef = doc(collection(db, "transfersOut"));
      batch.set(transferOutRef, {
        date,
        supplier: supplierName,
        bank: note,
        note,
        amount: supplierPaymentAmount,
        source: "bayar_supplier_utuh",
        createdAt: new Date().toISOString(),
        user: user?.email || "-",
      });

      const alokasi = [];
      for (const purchase of supplierPurchases) {
        if (sisa <= 0) break;
        const sisaTagihan = Math.max(0, sisaPurchase(purchase));
        if (sisaTagihan <= 0) continue;
        const bayar = Math.min(sisa, sisaTagihan);
        sisa -= bayar;
        const newPayment = {
          date,
          note,
          amount: bayar,
          transferOutId: transferOutRef.id,
          transferOutAmount: supplierPaymentAmount,
          transferOutNote: note,
        };
        const updatedPayments = [...(purchase.payments || []), newPayment];
        batch.update(doc(db, "purchases", purchase.id), { payments: updatedPayments });
        alokasi.push({ tanggal: purchase.createdAt || "-", material: purchaseMaterialsSummary(purchase), bayar });
      }

      await batch.commit();

      const info = alokasi.map(a => `${a.tanggal} - ${a.material}: ${rupiah(a.bayar)}`).join("\n");
      const sisaMsg = sisa > 0 ? `\n\nSisa ${rupiah(sisa)} dicatat sebagai transfer keluar, dicatat sebagai kelebihan pembayaran supplier.` : "";
      addAuditLog("Pembayaran Supplier", `${supplierName} - ${rupiah(supplierPaymentAmount)}`);
      alert(`✅ Realisasi pembayaran supplier tersimpan: ${rupiah(supplierPaymentAmount)}`);
      setSupplierPayForm({ supplier: "", date: todayStr(), note: "", amount: 0 }); setModal(null);
    } catch (e) { alert("Gagal menyimpan: " + e.message); }
    finally { setIsSaving(false); scheduleRefresh("transfersOut", "purchases"); }
  }

  // ── Kasbon Pegawai ──────────────────────────────────────────────────────────

  async function addKasbon() {
    const nama = (kasbonForm.employeeName || "").trim();
    const jumlah = moneyValue(kasbonForm.jumlah || 0);
    if (!nama) return alert("Nama pegawai wajib diisi");
    if (jumlah <= 0) return alert("Jumlah kasbon wajib diisi");
    if (jumlah > 50_000_000) return alert("Jumlah kasbon terlalu besar");
    const tanggal = kasbonForm.tanggal || todayStr();

    setIsSaving(true);
    try {
      const batch = writeBatch(db);

      // Simpan kasbon ke collection kasbon_pegawai (dibaca juga oleh Gallery Produksi)
      const kasbonRef = doc(collection(db, KASBON_COLLECTION));
      batch.set(kasbonRef, {
        employeeName: nama,
        tanggal,
        jumlah,
        sisaKasbon: jumlah,
        keterangan: (kasbonForm.keterangan || "").trim(),
        status: "aktif", // aktif | lunas
        cicilan: [],
        createdAt: new Date().toISOString(),
        createdBy: user?.email || "-",
      });

      // Otomatis catat ke pengeluaran Gallery Kerudung
      const expenseRef = doc(collection(db, "expenses"));
      batch.set(expenseRef, {
        date: tanggal,
        category: "Kasbon Pegawai",
        note: `Kasbon ${nama}${kasbonForm.keterangan ? " – " + kasbonForm.keterangan : ""}`,
        amount: jumlah,
        kasbonId: kasbonRef.id,
        createdAt: new Date().toISOString(),
      });

      await batch.commit();
      addAuditLog("Kasbon", `${nama} – ${rupiah(jumlah)}`);
      setKasbonForm({ employeeName: "", tanggal: "", jumlah: "", keterangan: "" });
      setModal(null);
    } catch (e) { alert("Gagal simpan kasbon: " + e.message); }
    finally { setIsSaving(false); scheduleRefresh("kasbon", "expenses"); }
  }

  async function tambahCicilanKasbon(kasbonId, jumlahCicilan, tanggalCicilan) {
    const kasbon = kasbonList.find((k) => k.id === kasbonId);
    if (!kasbon) return alert("Data kasbon tidak ditemukan");
    const cicilan = moneyValue(jumlahCicilan || 0);
    if (cicilan <= 0) return alert("Jumlah bayar/cicil wajib diisi");

    // Hitung sisa dari Firestore sebagai sumber kebenaran.
    // Cicilan dari Gallery Produksi (sumber: "rekap_gaji") sudah memotong sisaKasbon
    // di Firestore secara atomic. Jangan recalculate dari jumlah-totalCicilan agar
    // potongan gaji tidak "dikembalikan" saat cicilan manual baru ditambahkan.
    const sisaSekarang = Math.max(0, moneyValue(kasbon.sisaKasbon ?? (moneyValue(kasbon.jumlah ?? kasbon.amount ?? 0) - moneySum(kasbon.cicilan || [], (c) => c.jumlah ?? c.amount ?? 0))));
    if (cicilan > sisaSekarang) return alert(`Bayar/cicil (${rupiah(cicilan)}) melebihi sisa kasbon (${rupiah(sisaSekarang)})`);

    setIsSaving(true);
    try {
      const newCicilan = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        tanggal: tanggalCicilan || todayStr(),
        jumlah: cicilan,
        sumber: "manual",
      };
      const updatedCicilan = [...(kasbon.cicilan || []), newCicilan];
      // Sisa baru = sisa sekarang (sudah termasuk potongan gaji) dikurangi cicilan manual ini.
      const sisaBaru = Math.max(0, sisaSekarang - cicilan);
      const statusBaru = sisaBaru <= 0 ? "lunas" : "aktif";

      await updateDoc(doc(db, KASBON_COLLECTION, kasbonId), {
        cicilan: updatedCicilan,
        sisaKasbon: sisaBaru,
        status: statusBaru,
        updatedAt: new Date().toISOString(),
      });
      addAuditLog("Cicilan Kasbon", `${kasbon.employeeName} – ${rupiah(cicilan)}${statusBaru === "lunas" ? " (LUNAS)" : ""}`);
    } catch (e) { alert("Gagal simpan cicilan: " + e.message); }
    finally { setIsSaving(false); scheduleRefresh("kasbon"); }
  }

  async function hapusKasbon(kasbonId) {
    const kasbon = kasbonList.find((k) => k.id === kasbonId);
    if (!kasbon) return;
    const totalKasbon = moneyValue(kasbon.jumlah ?? kasbon.amount ?? 0);
    if (!window.confirm(`Hapus kasbon ${kasbon.employeeName} (${rupiah(totalKasbon)})? Data ini tidak bisa dikembalikan.`)) return;
    setIsSaving(true);
    try {
      await deleteDoc(doc(db, KASBON_COLLECTION, kasbonId));
      addAuditLog("Hapus Kasbon", `${kasbon.employeeName} – ${rupiah(totalKasbon)}`);
    } catch (e) { alert("Gagal hapus kasbon: " + e.message); }
    finally { setIsSaving(false); scheduleRefresh("kasbon"); }
  }

  // Batalkan cicilan rekap_gaji (potongan dari Gallery Produksi) — kembalikan sisa kasbon.
  // Dipakai jika admin salah input gajian atau gajian dibatalkan di Gallery Produksi.
  async function batalCicilanRekap(kasbonId, cicilan) {
    const kasbon = kasbonList.find((k) => k.id === kasbonId);
    if (!kasbon) return;
    const jumlahCicilan = parseMoney(cicilan.jumlah ?? cicilan.amount ?? 0);
    if (jumlahCicilan <= 0) return;
    const periodeInfo = cicilan.periodeGajiDari && cicilan.periodeGajiSampai
      ? ` (periode ${cicilan.periodeGajiDari} s/d ${cicilan.periodeGajiSampai})`
      : "";
    if (!window.confirm(`Batalkan potongan gaji ${rupiah(jumlahCicilan)} untuk ${kasbon.employeeName}${periodeInfo}?\n\nIni akan mengembalikan sisa kasbon sebesar ${rupiah(jumlahCicilan)}. Pastikan gajian terkait sudah dibatalkan di Gallery Produksi.`)) return;
    setIsSaving(true);
    try {
      const existingCicilan = Array.isArray(kasbon.cicilan) ? kasbon.cicilan : [];
      const updatedCicilan = existingCicilan.filter((c) => c.id !== cicilan.id);
      const sisaSekarang = Math.max(0, parseMoney(kasbon.sisaKasbon ?? 0));
      const sisaBaru = Math.min(parseMoney(kasbon.jumlah ?? kasbon.amount ?? 0), sisaSekarang + jumlahCicilan);
      const statusBaru = sisaBaru <= 0 ? "lunas" : "aktif";
      await updateDoc(doc(db, KASBON_COLLECTION, kasbonId), {
        cicilan: updatedCicilan,
        sisaKasbon: sisaBaru,
        status: statusBaru,
        updatedAt: new Date().toISOString(),
      });
      addAuditLog("Batal Cicilan Rekap Gaji", `${kasbon.employeeName} – ${rupiah(jumlahCicilan)} dikembalikan${periodeInfo}`);
    } catch (e) { alert("Gagal membatalkan cicilan: " + e.message); }
    finally { setIsSaving(false); scheduleRefresh("kasbon"); }
  }

  async function tambahMasterPekerja(nama) {
    const clean = (nama || "").trim();
    if (!clean) return alert("Nama pekerja tidak boleh kosong.");
    const sudahAda = masterPekerja.some(p => p.nama?.toLowerCase() === clean.toLowerCase());
    if (sudahAda) return alert(`Nama "${clean}" sudah ada dalam daftar.`);
    setIsSaving(true);
    try {
      await addDoc(collection(db, "master_pekerja"), { nama: clean, createdAt: new Date().toISOString() });
      setNamaPekerjaInput("");
    } catch (e) { alert("Gagal menambah pekerja: " + e.message); }
    finally { setIsSaving(false); scheduleRefresh("masterPekerja"); }
  }

  async function hapusMasterPekerja(id, nama) {
    if (!window.confirm(`Hapus "${nama}" dari daftar pekerja?`)) return;
    setIsSaving(true);
    try {
      await deleteDoc(doc(db, "master_pekerja", id));
    } catch (e) { alert("Gagal hapus pekerja: " + e.message); }
    finally { setIsSaving(false); scheduleRefresh("masterPekerja"); }
  }

  function deleteItem(type, id) { setConfirmDelete({ type, id }); }

  async function confirmDeleteAction() {
    if (!confirmDelete) return;
    const { type, id } = confirmDelete;
    setConfirmDelete(null);
    let oldPurchase = null; let stockRolledBack = false;
    try {
      if (type === "purchases") {
        oldPurchase = purchases.find((p) => p.id === id) || null;
        if (oldPurchase) { await rollbackPurchaseStock(oldPurchase); stockRolledBack = true; }
      }
      await deleteDoc(doc(db, type, id));
      addAuditLog("Hapus Data", `${type} - ${id}`);
    } catch (e) {
      try { if (type === "purchases" && oldPurchase && stockRolledBack) await applyPurchaseStock(oldPurchase); } catch (restoreErr) { console.warn("Restore stok gagal:", restoreErr); }
      alert("Gagal menghapus: " + e.message);
    }
    // Targeted: hanya refresh collection yang benar-benar diubah
    const collectionsToRefresh = type === "purchases"
      ? ["purchases", "materials"]
      : type === "orders" ? ["orders"]
      : type === "expenses" ? ["expenses"]
      : type === "transfers" ? ["transfers"]
      : type === "transfersOut" ? ["transfersOut"]
      : ["orders"]; // fallback
    scheduleRefresh(...collectionsToRefresh);
  }

  async function resetSemuaSupplier() {
    setConfirmResetSupplier2(false);
    setIsSaving(true);
    try {
      // Hapus semua purchases
      const purchaseDeletes = purchases.map((p) => deleteDoc(doc(db, "purchases", p.id)));
      // Hapus semua transfersOut
      const transfersOutDeletes = transfersOut.map((t) => deleteDoc(doc(db, "transfersOut", t.id)));
      await Promise.all([...purchaseDeletes, ...transfersOutDeletes]);
      addAuditLog(
        "Reset Semua Supplier",
        `Hapus ${purchases.length} purchase + ${transfersOut.length} transfersOut. Tanpa rollback stok.`
      );
      alert(`✅ Reset selesai.\n${purchases.length} nota purchase & ${transfersOut.length} pembayaran supplier telah dihapus.\nStok bahan tidak diubah.`);
    } catch (e) {
      alert("Gagal reset: " + e.message);
    } finally {
      setIsSaving(false);
      scheduleRefresh("purchases", "transfersOut");
    }
  }

  async function tandaiDikirim() {
    if (!kirimModal) return;
    const order = orders.find((o) => o.id === kirimModal);
    if (!order) return alert("Pesanan tidak ditemukan.");

    const cleanDeliveryItems = kirimItems
      .map((it, idx) => ({
        itemIndex: Number(it.itemIndex ?? idx),
        name: it.name || "Produk",
        qty: Number(it.shippedQty || 0),
        shippedQty: Number(it.shippedQty || 0),
        orderedQty: Number(it.orderedQty || 0),
        price: parseMoney(it.price || 0),
        bahanCost: parseMoney(it.bahanCost || 0),
        hppPerPcs: parseMoney(it.hppPerPcs || 0),
        mainMaterial: it.mainMaterial || "",
        materialQtyPerPcs: Number(it.materialQtyPerPcs || 0),
        unit: normalizeMaterialUnit(it.mainMaterial || it.name, it.unit),
      }))
      .filter((it) => it.name && it.qty > 0);

    if (cleanDeliveryItems.length === 0) return alert("Isi minimal 1 qty pengiriman hari ini.");

    // Sumber order items untuk kalkulasi shippedItems total
    const orderItems = normalizeOrderItems(order);
    const newDelivery = {
      date: tanggalKirim || todayStr(),
      createdAt: new Date().toISOString(),
      source: "gallery-kerudung-koreksi",
      items: cleanDeliveryItems,
      total: deliveryItemsTotal(cleanDeliveryItems.map((it) => ({ qty: it.qty, price: it.price }))),
    };
    const nextDeliveries = [...getDeliveryHistory(order), newDelivery];
    const tempOrder = { ...order, deliveries: nextDeliveries };

    // Hitung shippedItems ringkasan per item (sama seperti addPengiriman di Produksi)
    const shippedItems = orderItems.map((base, idx) => {
      const totalShippedForItem = nextDeliveries.reduce((sum, delivery) => {
        const found = (delivery.items || []).find((it) =>
          it.itemIndex !== undefined ? Number(it.itemIndex) === idx : normalizeName(it.name) === normalizeName(base.name)
        );
        return sum + Number(found?.qty ?? found?.shippedQty ?? 0);
      }, 0);
      const diff = totalShippedForItem - Number(base.qty || 0);
      return {
        name: base.name,
        orderedQty: Number(base.qty || 0),
        shippedQty: totalShippedForItem,
        price: parseMoney(base.price || 0),
        bahanCost: parseMoney(base.bahanCost || 0),
        hppPerPcs: parseMoney(base.hppPerPcs || 0),
        mainMaterial: base.mainMaterial || "",
        materialQtyPerPcs: Number(base.materialQtyPerPcs || 0),
        unit: base.unit || "yard",
        note: diff === 0 ? "Sesuai pesanan" : diff < 0 ? `Kekurangan pengiriman ${Math.abs(diff)} pcs` : `Kelebihan pengiriman ${diff} pcs`,
      };
    });

    const totalOrdered = shippedItems.reduce((s, it) => s + Number(it.orderedQty || 0), 0);
    const totalShipped = shippedItems.reduce((s, it) => s + Number(it.shippedQty || 0), 0);
    const deliveredTotal = billableOrderTotal(tempOrder);
    const deliveredHppTotal = billableOrderHppTotal(tempOrder);
    const deliveryStatus = orderDeliveryStatus(tempOrder);
    const paid = orderPaidTotal(order);
    const newStatus = paid >= deliveredTotal && deliveredTotal > 0 && deliveryStatus === "Selesai" ? "Lunas" : deliveryStatus;

    setIsSaving(true);
    const usage = buildMaterialUsageFromDeliveryItems(cleanDeliveryItems);
    let stockDeducted = false;
    try {
      if (usage.length > 0) {
        await applyMaterialMovements(usage, {
          direction: -1, refType: "delivery", refId: kirimModal,
          refLabel: order.invoice || order.customer || "Koreksi Pengiriman",
          date: tanggalKirim || todayStr(), note: "Pemakaian bahan saat koreksi pengiriman",
        });
        stockDeducted = true;
      }

      // Tulis semua field yang sama dengan addPengiriman di Produksi
      // agar badge dan status di Produksi tetap sinkron.
      await updateDoc(doc(db, "orders", kirimModal), {
        status: newStatus,
        deliveryStatus,
        shippingStatus: deliveryStatus,
        tanggalKirim: tanggalKirim || todayStr(),
        deliveries: nextDeliveries,
        shippedItems,
        totalKirim: totalShipped,
        totalPesan: totalOrdered,
        deliveredTotal,
        deliveredHppTotal,
        updatedAt: todayStr(),
      });

      addAuditLog("Koreksi Pengiriman", `${order.customer} - ${rupiah(deliveredTotal)}`);
      setKirimModal(null); setTanggalKirim(todayStr()); setKirimItems([]);
    } catch (e) {
      try {
        if (stockDeducted && usage.length > 0) {
          await applyMaterialMovements(usage, {
            direction: 1, refType: "delivery_rollback", refId: kirimModal,
            refLabel: order.invoice || order.customer || "Rollback",
            date: tanggalKirim || todayStr(), note: "Rollback stok koreksi",
          });
        }
      } catch (rb) { console.warn("Rollback stok gagal:", rb); }
      alert("Gagal menyimpan: " + e.message);
    } finally {
      setIsSaving(false);
      scheduleRefresh("orders", "materials");
    }
  }

  function openKirimModal(order) {
    const deliveryItems = normalizeShipmentItems(order).map((it, idx) => {
      const remaining = Math.max(Number(it.orderedQty || 0) - Number(it.shippedQty || 0), 0);
      return { itemIndex: idx, name: it.name, orderedQty: Number(it.orderedQty || 0), alreadyShipped: Number(it.shippedQty || 0), remainingQty: remaining, shippedQty: remaining, price: moneyValue(it.price || 0), bahanCost: moneyValue(it.bahanCost || 0), hppPerPcs: moneyValue(it.hppPerPcs || 0), mainMaterial: it.mainMaterial || "", materialQtyPerPcs: Number(it.materialQtyPerPcs || 0), unit: it.unit || "yard", note: it.note || shipmentAutoNote(Number(it.orderedQty || 0), Number(it.shippedQty || 0)) };
    });
    setKirimModal(order.id); setTanggalKirim(todayStr()); setKirimItems(deliveryItems);
  }

  async function hapusDelivery(order, deliveryIndex) {
    if (!order?.id) return;
    const deliveries = getDeliveryHistory(order);
    const target = deliveries[deliveryIndex];
    if (!target) return;
    const tgl = target.date || "-";
    const totalPcs = (target.items || []).reduce((s, it) => s + Number(it.qty || it.shippedQty || 0), 0);
    const ok = window.confirm(`Hapus riwayat pengiriman tanggal ${tgl} (${totalPcs.toLocaleString("id-ID")} pcs)?\n\nStok bahan akan dikembalikan. Data ini tidak bisa dikembalikan.`);
    if (!ok) return;

    setIsSaving(true);

    // Rollback stok bahan yang sempat dikurangi saat pengiriman ini diinput.
    // Hanya delivery dari Gallery Kerudung (source: gallery-kerudung-koreksi) yang
    // mencatat usage bahan; delivery dari Produksi tidak mengurangi stok di sini.
    const deliveryItems = target.items || [];
    const usage = buildMaterialUsageFromDeliveryItems(deliveryItems);

    try {
      // Kembalikan stok dulu (best-effort; jika gagal, lanjut hapus delivery)
      if (usage.length > 0) {
        try {
          await applyMaterialMovements(usage, {
            direction: 1, refType: "delivery_rollback", refId: order.id,
            refLabel: order.invoice || order.customer || "Hapus Delivery",
            date: tgl, note: "Rollback stok dari hapus riwayat pengiriman",
          });
        } catch (stockErr) {
          throw new Error("Rollback stok delivery gagal, proses hapus dibatalkan: " + (stockErr?.message || stockErr));
        }
      }

      const nextDeliveries = deliveries.filter((_, i) => i !== deliveryIndex);
      const tempOrder = { ...order, deliveries: nextDeliveries };
      const deliveredTotal = billableOrderTotal(tempOrder);
      const deliveredHppTotal = billableOrderHppTotal(tempOrder);
      const deliveryStatus = orderDeliveryStatus(tempOrder);
      const paid = orderPaidTotal(order);
      const newStatus = paid >= deliveredTotal && deliveredTotal > 0 && deliveryStatus === "Selesai" ? "Lunas" : deliveryStatus;

      // Hitung ulang shippedItems dari deliveries yang tersisa
      const orderItems = normalizeOrderItems(order);
      const shippedItems = orderItems.map((base, idx) => {
        const shipped = nextDeliveries.reduce((sum, delivery) => {
          const found = (delivery.items || []).find((it) =>
            it.itemIndex !== undefined ? Number(it.itemIndex) === idx : normalizeName(it.name) === normalizeName(base.name)
          );
          return sum + Number(found?.qty ?? found?.shippedQty ?? 0);
        }, 0);
        const diff = shipped - Number(base.qty || 0);
        return {
          name: base.name, orderedQty: Number(base.qty || 0), shippedQty: shipped,
          price: parseMoney(base.price || 0), hppPerPcs: parseMoney(base.hppPerPcs || 0),
          note: diff === 0 ? "Sesuai pesanan" : diff < 0 ? `Kekurangan pengiriman ${Math.abs(diff)} pcs` : `Kelebihan pengiriman ${diff} pcs`,
        };
      });

      await updateDoc(doc(db, "orders", order.id), {
        deliveries: nextDeliveries,
        shippedItems,
        totalKirim: shippedItems.reduce((s, it) => s + Number(it.shippedQty || 0), 0),
        deliveredTotal,
        deliveredHppTotal,
        deliveryStatus,
        shippingStatus: deliveryStatus,
        status: newStatus,
        updatedAt: todayStr(),
      });

      addAuditLog("Hapus Riwayat Pengiriman", `${order.customer} · ${order.invoice || "-"} · tgl ${tgl} · ${totalPcs} pcs`);
      alert("Riwayat pengiriman dihapus");
    } catch (e) {
      alert("Gagal menghapus: " + (e?.message || e));
    } finally {
      setIsSaving(false);
      scheduleRefresh("orders", "materials");
    }
  }

  function statusSetelahPembayaran(order, payments = order?.payments || []) {
    const paid = (payments || []).reduce((s, p) => s + moneyValue(p.amount || 0), 0);
    const tagihan = orderPaymentTarget({ ...order, payments });
    const deliveryStatus = orderDeliveryStatus(order);
    if (isFinalDeliveryStatus(deliveryStatus) && tagihan > 0 && paid >= tagihan) return "Lunas";
    return deliveryStatus;
  }

  async function cekDanUpdateLunas(orderId, total, updatedPayments, orderRef = null) {
    const paid = updatedPayments.reduce((s, p) => s + moneyValue(p.amount || 0), 0);
    const complete = orderRef ? isDeliveryComplete(orderRef) : true;
    if (complete && paid >= moneyValue(total || 0) && moneyValue(total || 0) > 0) {
      try { await updateDoc(doc(db, "orders", orderId), { status: "Lunas" }); } catch (e) {}
    }
  }

  async function realokasiTransferMasuk(transferId, payload) {
    const customerName = capitalizeWords(payload.customer || "");
    const amount = parseMoney(payload.amount || 0);

    // 1) Hapus dulu alokasi lama dari semua order yang pernah memakai transfer ini.
    const cleanedOrders = [];
    for (const order of orders) {
      const oldPayments = order.payments || [];
      const nextPayments = oldPayments.filter((p) => p.transferId !== transferId);
      if (nextPayments.length !== oldPayments.length) {
        const nextStatus = statusSetelahPembayaran(order, nextPayments);
        await updateDoc(doc(db, "orders", order.id), { payments: nextPayments, status: nextStatus });
        cleanedOrders.push({ ...order, payments: nextPayments, status: nextStatus });
      } else {
        cleanedOrders.push(order);
      }
    }

    // 2) Update mutasi rekening utuh.
    await updateDoc(doc(db, "transfers", transferId), payload);

    // 3) Alokasikan ulang hanya untuk transfer pembayaran customer.
    if (!payload.source || !(String(payload.source).includes("bayar_customer") || String(payload.source).includes("migrasi_order_payment"))) return [];

    let sisa = amount;
    const alokasi = [];
    const targetOrders = cleanedOrders
      .filter((o) => normalizeName(o.customer) === normalizeName(customerName) && sisaOrderUntukAlokasi(o) > 0)
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

    for (const order of targetOrders) {
      if (sisa <= 0) break;
      const sisaOrder_ = Math.max(0, sisaOrderUntukAlokasi(order));
      if (sisaOrder_ <= 0) continue;
      const bayar = Math.min(sisa, sisaOrder_);
      sisa -= bayar;
      const newPayment = {
        date: payload.date || todayStr(),
        note: payload.bank || "Pembayaran customer",
        amount: bayar,
        transferId,
        transferAmount: amount,
        transferNote: payload.note || "",
      };
      const updatedPayments = [...(order.payments || []), newPayment];
      await updateDoc(doc(db, "orders", order.id), { payments: updatedPayments, status: statusSetelahPembayaran(order, updatedPayments) });
      alokasi.push({ invoice: order.invoice || "Pesanan", bayar });
    }
    return alokasi;
  }

  async function realokasiTransferKeluar(transferOutId, payload) {
    const supplierName = capitalizeWords(payload.supplier || "");
    const amount = parseMoney(payload.amount || 0);

    // 1) Hapus dulu alokasi lama dari semua belanja supplier.
    const cleanedPurchases = [];
    for (const purchase of purchases) {
      const oldPayments = purchase.payments || [];
      const nextPayments = oldPayments.filter((p) => p.transferOutId !== transferOutId);
      if (nextPayments.length !== oldPayments.length) {
        await updateDoc(doc(db, "purchases", purchase.id), { payments: nextPayments });
        cleanedPurchases.push({ ...purchase, payments: nextPayments });
      } else {
        cleanedPurchases.push(purchase);
      }
    }

    // 2) Update mutasi kas keluar utuh.
    await updateDoc(doc(db, "transfersOut", transferOutId), payload);

    // 3) Alokasikan ulang hanya untuk transfer pembayaran supplier.
    if (!payload.source || !(String(payload.source).includes("bayar_supplier") || String(payload.source).includes("migrasi_supplier_payment"))) return [];

    let sisa = amount;
    const alokasi = [];
    const targetPurchases = cleanedPurchases
      .filter((p) => normalizeName(p.supplier) === normalizeName(supplierName) && sisaPurchase(p) > 0)
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

    for (const purchase of targetPurchases) {
      if (sisa <= 0) break;
      const sisaTagihan = Math.max(0, sisaPurchase(purchase));
      if (sisaTagihan <= 0) continue;
      const bayar = Math.min(sisa, sisaTagihan);
      sisa -= bayar;
      const newPayment = {
        date: payload.date || todayStr(),
        note: payload.note || payload.bank || "Pembayaran Supplier",
        amount: bayar,
        transferOutId,
        transferOutAmount: amount,
        transferOutNote: payload.note || "",
      };
      const updatedPayments = [...(purchase.payments || []), newPayment];
      await updateDoc(doc(db, "purchases", purchase.id), { payments: updatedPayments });
      alokasi.push({ tanggal: purchase.createdAt || "-", material: purchaseMaterialsSummary(purchase), bayar });
    }
    return alokasi;
  }


  async function pulihkanHistoriPembayaranSupplier(purchaseId) {
    const purchase = purchases.find((p) => p.id === purchaseId);
    if (!purchase) return alert("Data supplier tidak ditemukan.");

    const supplierName = capitalizeWords(purchase.supplier || "");
    if (!supplierName) return alert("Nama supplier kosong.");

    const totalTagihan = hutangPurchase(purchase);
    if (totalTagihan <= 0) return alert("Data supplier ini sudah tidak memiliki tagihan aktif.");

    const usedTransferOutIds = new Set();
    purchases.forEach((p) => {
      if (p.id === purchaseId) return;
      (p.payments || []).forEach((pay) => {
        if (pay.transferOutId) usedTransferOutIds.add(pay.transferOutId);
      });
    });

    const existingPaymentTransferIds = new Set((purchase.payments || []).map((pay) => pay.transferOutId).filter(Boolean));
    const relatedTransfers = (transfersOut || [])
      .filter((t) => {
        const sameSupplier = normalizeName(t.supplier) === normalizeName(supplierName);
        const validAmount = moneyValue(t.amount || 0) > 0;
        const notAlreadyInThisPurchase = !existingPaymentTransferIds.has(t.id);
        const notUsedByOtherPurchase = !usedTransferOutIds.has(t.id);
        return sameSupplier && validAmount && notAlreadyInThisPurchase && notUsedByOtherPurchase;
      })
      .sort((a, b) => (a.date || a.createdAt || "").localeCompare(b.date || b.createdAt || ""));

    if (relatedTransfers.length === 0) {
      return alert(`Tidak ada transfer keluar lama yang belum terpakai untuk supplier ${supplierName}.`);
    }

    const totalTransfer = relatedTransfers.reduce((sum, t) => sum + moneyValue(t.amount || 0), 0);
    const lanjut = window.confirm(
      `Pulihkan histori pembayaran supplier ${supplierName}?\n\n` +
      `Ditemukan ${relatedTransfers.length} transfer keluar lama.\n` +
      `Total transfer: ${rupiah(totalTransfer)}\n` +
      `Sisa tagihan data ini: ${rupiah(totalTagihan)}\n\n` +
      `Transfer akan ditempel ke data supplier ini tanpa membuat kas keluar baru.`
    );
    if (!lanjut) return;

    let sisaTagihan = totalTagihan;
    const restoredPayments = [];

    for (const transfer of relatedTransfers) {
      if (sisaTagihan <= 0) break;
      const transferAmount = moneyValue(transfer.amount || 0);
      const amount = Math.min(transferAmount, sisaTagihan);
      if (amount <= 0) continue;

      restoredPayments.push({
        date: transfer.date || transfer.createdAt?.slice?.(0, 10) || todayStr(),
        note: transfer.note || transfer.bank || "Pembayaran Supplier Lama",
        amount,
        transferOutId: transfer.id,
        transferOutAmount: transferAmount,
        transferOutNote: transfer.note || "",
        restoredFromDeletedPurchase: true,
      });

      sisaTagihan -= amount;
    }

    if (restoredPayments.length === 0) return alert("Tidak ada pembayaran yang bisa dipulihkan.");

    await updateDoc(doc(db, "purchases", purchaseId), {
      payments: [...(purchase.payments || []), ...restoredPayments],
    });

    addAuditLog("Pulihkan Histori Supplier", `${supplierName} - ${restoredPayments.length} pembayaran - ${rupiah(restoredPayments.reduce((s, p) => s + moneyValue(p.amount || 0), 0))}`);
    alert(`✅ ${restoredPayments.length} histori pembayaran berhasil dipulihkan ke ${supplierName}.`);
    setEditData(null);
  }

  async function saveEdit() {
    if (!editData) return;
    setIsSaving(true);
    try {
      const { type, id } = editData;
      let payload = {};
      if (type === "orders") {
        const cleanItems = normalizeOrderItems(editData).map((it) => ({ productId: it.productId || "", name: String(it.name || "").trim(), category: capitalizeWords(it.category || "Lainnya"), qty: Number(it.qty || 0), price: moneyValue(it.price || 0), bahanCost: moneyValue(it.bahanCost || 0), hppPerPcs: moneyValue(it.hppPerPcs || 0), mainMaterial: it.mainMaterial || "", materialQtyPerPcs: Number(it.materialQtyPerPcs || 0), unit: normalizeMaterialUnit(it.mainMaterial || it.name, it.unit), hppMaterials: normalizeHppMaterials(it) })).filter((it) => it.name && it.qty > 0);
        const subtotal = orderItemsTotal(cleanItems);
        const shippingCost = moneyValue(editData.shippingCost || editData.ongkir || 0);
        const total = subtotal + shippingCost;
        const firstItem = cleanItems[0] || {};
        const originalOrder = orders.find((o) => o.id === id) || {};
        const originalItems = normalizeOrderItems(originalOrder);
        const changedPriceItems = cleanItems.filter((it, idx) => {
          const original = findMatchingOrderItem(originalItems, it, idx) || originalItems[idx] || {};
          const oldPrice = firstPositiveMoney(original?.price, original?.harga, original?.hargaJual, original?.hargaPcs, original?.sellingPrice, original?.salePrice, original?.unitPrice, original?.hargaSatuan);
          const newPrice = moneyValue(it.price || 0);
          return newPrice > 0 && (!oldPrice || newPrice !== oldPrice);
        });
        if (changedPriceItems.length > 0) await upsertProductMastersFromOrder(changedPriceItems);
        payload = { customer: capitalizeWords(editData.customer || ""), phone: editData.phone || "", items: cleanItems, item: firstItem.name || "", qty: cleanItems.reduce((s, it) => s + Number(it.qty || 0), 0), hargaPcs: moneyValue(firstItem.price || 0), subtotal, shippingCost, ongkir: shippingCost, total, status: editData.status || "Proses", createdAt: editData.createdAt || todayStr() };
      } else if (type === "purchases") {
        const cleanMaterials = normalizePurchaseMaterials(editData).map((it) => {
          const materialName = capitalizeWords(it.name || "");
          const qty = numberValue(it.qty || 0);
          const pricePerUnit = moneyValue(it.pricePerUnit || 0);
          return { name: materialName, category: it.category || "Kain", qty, unit: normalizeMaterialUnit(materialName, it.unit), pricePerUnit, total: qty * pricePerUnit };
        }).filter((it) => it.name && it.qty > 0 && it.pricePerUnit > 0);
        const subtotal = cleanMaterials.length > 0 ? purchaseMaterialsTotal(cleanMaterials) : moneyValue(editData.subtotal || editData.total || 0);
        const shippingCost = moneyValue(editData.shippingCost ?? editData.ongkir ?? 0);
        const total = subtotal + shippingCost;
        const firstMaterial = cleanMaterials[0] || {};
        payload = {
          supplier: editData.supplier || "",
          materials: cleanMaterials,
          material: cleanMaterials.map((it) => it.name).join(", ") || editData.material || "Bahan Baku",
          qty: cleanMaterials.map((it) => `${it.qty} ${it.unit}`).join(", ") || editData.qty || "",
          category: firstMaterial.category || editData.category || "Kain",
          subtotal,
          shippingCost,
          ongkir: shippingCost,
          total,
          createdAt: editData.createdAt || todayStr()
        };
      } else if (type === "expenses") {
        payload = { category: editData.category || "", note: editData.note || "", amount: moneyValue(editData.amount || 0), date: editData.date || todayStr() };
      } else if (type === "transfers") {
        payload = {
          date: editData.date || todayStr(),
          customer: capitalizeWords(editData.customer || ""),
          bank: editData.bank || "",
          note: editData.note || "",
          amount: parseMoney(editData.amount || 0),
          source: editData.source || "transfer_manual",
          updatedAt: new Date().toISOString(),
          updatedBy: user?.email || "-",
        };
      } else if (type === "transfersOut") {
        payload = {
          date: editData.date || todayStr(),
          supplier: capitalizeWords(editData.supplier || ""),
          bank: editData.bank || "",
          note: editData.note || "",
          amount: parseMoney(editData.amount || 0),
          source: editData.source || "transfer_keluar_manual",
          updatedAt: new Date().toISOString(),
          updatedBy: user?.email || "-",
        };
      }

      if (type === "transfers") {
        const alokasi = await realokasiTransferMasuk(id, payload);
        addAuditLog("Edit Transfer Masuk", `${payload.customer} - ${rupiah(payload.amount)}${alokasi.length ? " · realokasi order" : ""}`);
        setEditData(null); return;
      }

      if (type === "transfersOut") {
        const alokasi = await realokasiTransferKeluar(id, payload);
        addAuditLog("Edit Transfer Keluar", `${payload.supplier} - ${rupiah(payload.amount)}${alokasi.length ? " · realokasi tagihan" : ""}`);
        setEditData(null); return;
      }

      if (type !== "purchases") {
        await updateDoc(doc(db, type, id), payload);
        addAuditLog("Edit Data", `${type} - ${id}`);
        setEditData(null); return;
      }

      const oldPurchase = purchases.find((p) => p.id === id) || null;
      let oldStockRolledBack = false; let newStockApplied = false;
      try {
        if (oldPurchase) { await rollbackPurchaseStock(oldPurchase); oldStockRolledBack = true; }
        await updateDoc(doc(db, type, id), payload);
        await applyPurchaseStock({ ...editData, ...payload, id }); newStockApplied = true;
      } catch (purchaseErr) {
        try {
          if (newStockApplied) await rollbackPurchaseStock({ ...editData, ...payload, id });
          if (oldPurchase) {
            await updateDoc(doc(db, type, id), {
              supplier: oldPurchase.supplier || "",
              materials: normalizePurchaseMaterials(oldPurchase),
              material: oldPurchase.material || "",
              qty: oldPurchase.qty || "",
              category: oldPurchase.category || "Kain",
              subtotal: purchaseMaterialsTotal(normalizePurchaseMaterials(oldPurchase)),
              shippingCost: moneyValue(oldPurchase.shippingCost ?? oldPurchase.ongkir ?? 0),
              ongkir: moneyValue(oldPurchase.shippingCost ?? oldPurchase.ongkir ?? 0),
              total: purchaseInvoiceTotal(oldPurchase),
              createdAt: oldPurchase.createdAt || todayStr(),
              payments: oldPurchase.payments || []
            });
            if (oldStockRolledBack) await applyPurchaseStock(oldPurchase);
          }
        } catch (restoreErr) { console.warn("Restore edit supplier gagal:", restoreErr); }
        throw purchaseErr;
      }
      addAuditLog("Edit Data", `${type} - ${id}`); setEditData(null);
    } catch (e) { alert("Gagal menyimpan: " + e.message); }
    finally {
      setIsSaving(false);
      // Targeted: pilih collection sesuai type yang diedit
      const { type: t } = editData || {};
      if (t === "purchases") scheduleRefresh("purchases", "materials");
      else if (t === "orders") scheduleRefresh("orders");
      else if (t === "expenses") scheduleRefresh("expenses");
      else if (t === "transfers") scheduleRefresh("transfers", "orders");
      else if (t === "transfersOut") scheduleRefresh("transfersOut", "purchases");
      else scheduleRefresh("orders");
    }
  }

  // ── Rekap ──
  function buildRows(period) {
    const rows = [];
    transfers.forEach((t) => {
      if (period === "all" || samePeriod(t.date, period))
        rows.push({ tanggal: t.date, jenis: "Transfer Masuk", nama: t.customer || "Customer", keterangan: `${t.bank || "Bayar Customer"}${t.note ? ` · ${t.note}` : ""}`, masuk: t.amount, keluar: 0 });
    });
    transfersOut.forEach((t) => {
      if (period === "all" || samePeriod(t.date, period))
        rows.push({ tanggal: t.date, jenis: "Transfer Keluar", nama: t.supplier || "Supplier", keterangan: `${t.bank || "Bayar Supplier"}${t.note ? ` · ${t.note}` : ""}`, masuk: 0, keluar: t.amount });
    });
    expenses.forEach((expense) => {
      if (period === "all" || samePeriod(expense.date, period))
        rows.push({ tanggal: expense.date, jenis: "Biaya", nama: expense.category, keterangan: expense.note, masuk: 0, keluar: expense.amount });
    });
    return rows.sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal));
  }

  function buildSupplierRows(period) {
    const rows = [];
    purchases.filter((p) => period === "all" || samePeriod(p.createdAt, period)).forEach((purchase) => {
      const sudahDibayar = purchasePaidTotal(purchase);
      const totalPurchase = purchaseInvoiceTotal(purchase);
      const sisaUtang = Math.max(0, Math.round(totalPurchase - sudahDibayar));
      const bahanList = normalizePurchaseMaterials(purchase);
      const bahanSubtotal = purchaseMaterialsTotal(bahanList);
      let akumulasiDibayar = 0; let akumulasiSisa = 0;
      bahanList.forEach((bahan, idx) => {
        const bahanTotal = purchaseMaterialTotal(bahan);
        const proporsi = bahanSubtotal > 0 ? bahanTotal / bahanSubtotal : 0;
        const isLast = idx === bahanList.length - 1;
        const dibayarMaterialTotal = Math.min(sudahDibayar, bahanSubtotal);
        const sisaMaterialTotal = Math.min(sisaUtang, bahanSubtotal);
        const dibayarBaris = isLast ? Math.max(0, dibayarMaterialTotal - akumulasiDibayar) : Math.round(dibayarMaterialTotal * proporsi);
        const sisaBaris = isLast ? Math.max(0, sisaMaterialTotal - akumulasiSisa) : Math.round(sisaMaterialTotal * proporsi);
        akumulasiDibayar += dibayarBaris; akumulasiSisa += sisaBaris;
        rows.push({ tanggalBelanja: purchase.createdAt || "", supplier: purchase.supplier || "", jenisBahan: bahan.name || "Bahan Baku", kategori: bahan.category || "Kain", banyak: `${Number(bahan.qty || 0).toLocaleString("id-ID")} ${bahan.unit || "yard"}`, hargaSatuan: moneyValue(bahan.pricePerUnit || 0), totalBelanja: bahanTotal, sudahDibayar: dibayarBaris, sisaUtang: sisaBaris });
      });
      const ongkirSupplier = moneyValue(purchase.shippingCost ?? purchase.ongkir ?? 0);
      if (ongkirSupplier > 0) {
        const paidMaterials = rows
          .filter((r) => r.tanggalBelanja === (purchase.createdAt || "") && r.supplier === (purchase.supplier || ""))
          .reduce((sum, r) => sum + moneyValue(r.sudahDibayar || 0), 0);
        const sisaMaterials = rows
          .filter((r) => r.tanggalBelanja === (purchase.createdAt || "") && r.supplier === (purchase.supplier || ""))
          .reduce((sum, r) => sum + moneyValue(r.sisaUtang || 0), 0);
        rows.push({
          tanggalBelanja: purchase.createdAt || "",
          supplier: purchase.supplier || "",
          jenisBahan: "Ongkir Supplier",
          kategori: "Ongkir",
          banyak: "1 x",
          hargaSatuan: ongkirSupplier,
          totalBelanja: ongkirSupplier,
          sudahDibayar: Math.max(0, sudahDibayar - paidMaterials),
          sisaUtang: Math.max(0, sisaUtang - sisaMaterials),
        });
      }
    });
    return rows.sort((a, b) => new Date(a.tanggalBelanja || 0) - new Date(b.tanggalBelanja || 0));
  }

  function buildCustomerRows(period) {
    const map = {};
    orders.filter((o) => period === "all" || samePeriod(o.createdAt, period)).forEach((order) => {
      const key = normalizeName(order.customer || "Tanpa Nama");
      const name = capitalizeWords(order.customer || "Tanpa Nama");
      const total = orderPaymentTarget(order);
      const paid = orderPaidTotal(order);
      const sisa = total - paid;
      if (!map[key]) map[key] = { customer: name, jumlahPesanan: 0, totalTagihan: 0, sudahDibayar: 0, sisaTagihan: 0, invoices: [] };
      map[key].jumlahPesanan += 1; map[key].totalTagihan += total; map[key].sudahDibayar += paid; map[key].sisaTagihan += sisa;
      if (order.invoice) map[key].invoices.push(order.invoice);
    });
    return Object.values(map).sort((a, b) => b.totalTagihan - a.totalTagihan);
  }

  function pdfPeriodLabel(period) {
    const now = new Date();
    if (period === "month") return `${BULAN_FULL[now.getMonth()]} ${now.getFullYear()}`;
    if (period === "year") return `Tahun ${now.getFullYear()}`;
    return "Semua Data";
  }

  function addPdfHeader(pdf, title, period) {
    pdf.setFillColor(236, 72, 153);
    pdf.rect(0, 0, 210, 28, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(16); pdf.setFont("helvetica", "bold");
    pdf.text("Gallery Kerudung", 14, 12);
    pdf.setFontSize(10); pdf.setFont("helvetica", "normal");
    pdf.text("made by order", 14, 19);
    pdf.setTextColor(30, 41, 59);
    pdf.setFontSize(14); pdf.setFont("helvetica", "bold");
    pdf.text(title, 14, 40);
    pdf.setFontSize(10); pdf.setFont("helvetica", "normal");
    pdf.text(`Periode: ${pdfPeriodLabel(period)}`, 14, 47);
    pdf.text(`Dicetak: ${new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}`, 14, 53);
  }

  async function downloadFinancialRekapPdf(period) {
    const { jsPDF, autoTable } = await loadPdfTools();
    const label = { month: "bulanan", year: "tahunan", all: "semua" }[period];
    const rows = buildRows(period);
    if (rows.length === 0) return alert("Tidak ada data rekap untuk periode ini.");
    const totalMasuk = rows.reduce((s, r) => s + Number(r.masuk || 0), 0);
    const totalKeluar = rows.reduce((s, r) => s + Number(r.keluar || 0), 0);
    const saldo = totalMasuk - totalKeluar;
    const pdf = new jsPDF("p", "mm", "a4");
    addPdfHeader(pdf, "Rekap Keuangan", period);
    autoTable(pdf, {
      startY: 62,
      head: [["Tanggal", "Jenis", "Nama", "Keterangan", "Kas Masuk", "Kas Keluar"]],
      body: rows.map((r) => [r.tanggal || "-", r.jenis || "-", r.nama || "-", r.keterangan || "-", Number(r.masuk || 0) > 0 ? rupiah(r.masuk) : "-", Number(r.keluar || 0) > 0 ? rupiah(r.keluar) : "-"]),
      foot: [["", "", "", "TOTAL", rupiah(totalMasuk), rupiah(totalKeluar)]],
      theme: "grid", headStyles: { fillColor: [236, 72, 153], textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [253, 242, 248], textColor: [190, 24, 93], fontStyle: "bold" },
      styles: { fontSize: 8, cellPadding: 2 }, columnStyles: { 4: { halign: "right" }, 5: { halign: "right" } },
    });
    const finalY = pdf.lastAutoTable?.finalY || 70;
    pdf.setFontSize(11); pdf.setFont("helvetica", "bold");
    pdf.setTextColor(saldo >= 0 ? 5 : 225, saldo >= 0 ? 150 : 29, saldo >= 0 ? 105 : 72);
    pdf.text(`Saldo Bersih: ${rupiah(saldo)}`, 14, Math.min(finalY + 12, 285));
    pdf.save(`rekap-keuangan-${label}.pdf`);
  }

  async function downloadSupplierRekapPdf(period) {
    const { jsPDF, autoTable } = await loadPdfTools();
    const label = { month: "bulanan", year: "tahunan", all: "semua" }[period];
    const rows = buildSupplierRows(period);
    if (rows.length === 0) return alert("Tidak ada data supplier untuk periode ini.");
    const totalBelanja = rows.reduce((s, r) => s + moneyValue(r.totalBelanja || 0), 0);
    const totalDibayar = rows.reduce((s, r) => s + moneyValue(r.sudahDibayar || 0), 0);
    const totalSisa = rows.reduce((s, r) => s + moneyValue(r.sisaUtang || 0), 0);
    const pdf = new jsPDF("p", "mm", "a4");
    addPdfHeader(pdf, "Rekap Pembayaran Supplier", period);
    autoTable(pdf, {
      startY: 62,
      head: [["Tanggal", "Supplier", "Jenis Bahan", "Banyak", "Total", "Dibayar", "Sisa Tagihan"]],
      body: rows.map((r) => [r.tanggalBelanja || "-", r.supplier || "-", r.jenisBahan || "-", r.banyak || "-", rupiah(r.totalBelanja), rupiah(r.sudahDibayar), rupiah(r.sisaUtang)]),
      foot: [["", "", "", "TOTAL", rupiah(totalBelanja), rupiah(totalDibayar), rupiah(totalSisa)]],
      theme: "grid", headStyles: { fillColor: [168, 85, 247], textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [253, 242, 248], textColor: [190, 24, 93], fontStyle: "bold" },
      styles: { fontSize: 8, cellPadding: 2 }, columnStyles: { 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" } },
    });
    pdf.save(`rekap-supplier-${label}.pdf`);
  }

  async function downloadCustomerRekapPdf(period) {
    const { jsPDF, autoTable } = await loadPdfTools();
    const label = { month: "bulanan", year: "tahunan", all: "semua" }[period];
    const rows = buildCustomerRows(period);
    if (rows.length === 0) return alert("Tidak ada data customer untuk periode ini.");
    const totalTagihan = rows.reduce((s, r) => s + moneyValue(r.totalTagihan || 0), 0);
    const totalDibayar = rows.reduce((s, r) => s + moneyValue(r.sudahDibayar || 0), 0);
    const totalSisa = rows.reduce((s, r) => s + moneyValue(r.sisaTagihan || 0), 0);
    const pdf = new jsPDF("p", "mm", "a4");
    addPdfHeader(pdf, "Rekap Customer", period);
    autoTable(pdf, {
      startY: 62,
      head: [["Customer", "Pesanan", "Invoice", "Total Tagihan", "Dibayar", "Sisa"]],
      body: rows.map((r) => [r.customer || "-", r.jumlahPesanan, r.invoices.slice(0, 4).join(", ") + (r.invoices.length > 4 ? "..." : ""), rupiah(r.totalTagihan), rupiah(r.sudahDibayar), rupiah(r.sisaTagihan)]),
      foot: [["TOTAL", rows.reduce((s, r) => s + Number(r.jumlahPesanan || 0), 0), "", rupiah(totalTagihan), rupiah(totalDibayar), rupiah(totalSisa)]],
      theme: "grid", headStyles: { fillColor: [236, 72, 153], textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [253, 242, 248], textColor: [190, 24, 93], fontStyle: "bold" },
      styles: { fontSize: 8, cellPadding: 2 }, columnStyles: { 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } },
    });
    pdf.save(`rekap-customer-${label}.pdf`);
  }

  async function downloadLabaRugiPdf() {
    const { jsPDF, autoTable } = await loadPdfTools();
    const pdf = new jsPDF("p", "mm", "a4");
    addPdfHeader(pdf, "Laporan Laba Rugi & Cashflow", "all");
    const bs = businessSummary;
    const rows = [
      ["Total Pesanan Awal", rupiah(bs.totalPesananAwal)],
      ["Realisasi Penjualan", rupiah(bs.totalRealisasi)],
      ["Total Belanja Supplier", rupiah(bs.totalBelanjaSupplier)],
      ["Nilai Stok Bahan", rupiah(bs.nilaiStok)],
      ["HPP Terkirim Final", rupiah(bs.estimasiHppBahanTerpakai)],
      ["Gaji Produksi (info, sudah masuk HPP)", rupiah(bs.totalGajiProduksi)],
      ["Total Pengeluaran Operasional", rupiah(bs.totalPengeluaran)],
      ["Laba Kotor", rupiah(bs.labaKotor)],
      [bs.labaBersih < 0 ? "Rugi Bersih" : "Laba Bersih", `${bs.labaBersih < 0 ? "-" : ""}${rupiah(Math.abs(bs.labaBersih))}`],
      ["Status Laba", bs.hppIsValid ? "Valid" : `Belum valid (${Number(bs.hppMissingQty || 0).toLocaleString("id-ID")} pcs tanpa HPP final)`],
      ["Transfer Masuk dari Bayar Customer", rupiah(bs.totalPembayaranCustomer)],
      ["Realisasi Pembayaran ke Supplier", rupiah(bs.totalBayarSupplier)],
      ["Cashflow Bersih", rupiah(bs.cashflowBersih)],
      ["Piutang Customer", rupiah(bs.piutang)],
      ["Tagihan Supplier", rupiah(bs.hutangSupplier)],
    ];
    autoTable(pdf, {
      startY: 62, head: [["Keterangan", "Nominal"]], body: rows, theme: "grid",
      headStyles: { fillColor: [236, 72, 153], textColor: 255, fontStyle: "bold" },
      styles: { fontSize: 10, cellPadding: 3 }, columnStyles: { 1: { halign: "right" } },
    });
    pdf.save(`laporan-laba-rugi-cashflow-${todayStr()}.pdf`);
    addAuditLog("Download Laba Rugi PDF", "Export laporan bisnis lengkap");
  }

  function downloadRekap(period) { downloadFinancialRekapPdf(period); }
  function doDownloadRekap() { if (!rekapConfirm) return; downloadFinancialRekapPdf(rekapConfirm); setRekapConfirm(null); }

  function rangeLabel() {
    const dari = rekapStartDate || "awal";
    const sampai = rekapEndDate || "akhir";
    return `${dari} s/d ${sampai}`;
  }

  function inRekapRange(dateValue) {
    const serial = dateSerial(dateValue || "");
    if (!serial) return false;
    const start = rekapStartDate ? dateSerial(rekapStartDate) : 0;
    const end = rekapEndDate ? dateSerial(rekapEndDate) : 99999999;
    return serial >= start && serial <= end;
  }

  function productMasterHppValue(product) {
    if (!product) return 0;
    return Math.max(0,
      componentHpp(product),
      firstPositiveMoney(
        product?.hppPerPcs,
        product?.hpp,
        product?.hppFinal,
        product?.finalHpp,
        product?.hppSatuan,
        product?.hppFinalPerPcs,
        product?.totalHppPerPcs,
        product?.costPerPcs,
        product?.modalPerPcs,
        product?.modalPcs,
        product?.modalSatuan,
        product?.hargaModal,
        product?.hargaPokok,
        product?.unitCost,
        product?.unitHpp,
        product?.finalCost,
        product?.cost,
        product?.modal
      ),
      calculateProductHpp(product)
    );
  }

  function productNameCandidates(item) {
    return [
      item?.name,
      item?.item,
      item?.productName,
      item?.namaProduk,
      item?.title,
      item?.displayName,
      item?.masterName,
      item?.baseProductName,
      item?.variantName,
      item?.originalName,
      item?.oldName,
      item?.previousName,
      item?.sku,
      item?.code,
      item?.kode,
    ].map((x) => normalizeName(x || "")).filter(Boolean);
  }

  function productMasterForItem(item) {
    const productId = item?.productId || item?.product_id || item?.masterProductId || "";
    const byId = productId ? productMasters.find((p) => p.id === productId) : null;

    const itemNames = Array.from(new Set(productNameCandidates(item)));
    const masters = (productMasters || []).filter((p) => normalizeName(p.name || ""));

    // Kalau productId masih mengarah ke master lama yang HPP-nya kosong,
    // jangan langsung berhenti di master lama. Cari lagi berdasarkan nama terbaru
    // dari pesanan customer, supaya setelah nama produk diedit HPP ikut terbaca.
    if (byId && productMasterHppValue(byId) > 0) return byId;
    if (itemNames.length === 0) return byId || null;

    const exactMatches = masters.filter((p) => itemNames.includes(normalizeName(p.name || "")));
    const exactWithHpp = exactMatches.find((p) => productMasterHppValue(p) > 0);
    if (exactWithHpp) return exactWithHpp;
    if (byId && exactMatches.length === 0) return byId;
    if (exactMatches.length > 0) return exactMatches[0];

    // Fallback untuk data lama: kadang item pesanan hanya berubah nama,
    // sementara link productId/HPP lama tidak ikut tersimpan. Cocokkan nama yang
    // sangat mirip dan prioritaskan master yang sudah punya HPP.
    const scored = masters.map((p) => {
      const masterName = normalizeName(p.name || "");
      const masterTokens = masterName.split(" ").filter(Boolean);
      let score = 0;
      itemNames.forEach((itemName) => {
        const itemTokens = itemName.split(" ").filter(Boolean);
        const common = itemTokens.filter((w) => masterTokens.includes(w)).length;
        const ratio = Math.max(itemTokens.length, masterTokens.length) > 0 ? common / Math.max(itemTokens.length, masterTokens.length) : 0;
        const contains = itemName.length >= 4 && masterName.length >= 4 && (itemName.includes(masterName) || masterName.includes(itemName));
        const nextScore = contains ? 0.95 : ratio;
        if (nextScore > score) score = nextScore;
      });
      return { product: p, score, hasHpp: productMasterHppValue(p) > 0 };
    })
      .filter((x) => x.score >= 0.75)
      .sort((a, b) => (Number(b.hasHpp) - Number(a.hasHpp)) || b.score - a.score);

    return scored[0]?.product || byId || null;
  }

  function firstPositiveMoney(...values) {
    for (const value of values) {
      const n = moneyValue(value || 0);
      if (n > 0 && isReasonableMoney(n)) return n;
    }
    return 0;
  }

  function hppFromTotalFields(item, qtyHint = 0) {
    const qty = Number(qtyHint || item?.shippedQty || item?.qty || item?.orderedQty || 0);
    if (qty <= 0) return 0;
    const totalHpp = firstPositiveMoney(
      item?.deliveredHppTotal,
      item?.deliveryHppTotal,
      item?.hppTotal,
      item?.totalHpp,
      item?.hppSubtotal,
      item?.totalCost,
      item?.costTotal
    );
    return totalHpp > 0 ? Math.round(totalHpp / qty) : 0;
  }

  function componentHpp(product) {
    return firstPositiveMoney(product?.bahanCost || product?.materialCost || 0)
      + firstPositiveMoney(product?.productionCost || 0)
      + firstPositiveMoney(product?.accessoriesCost || product?.accessoryCost || product?.aksesorisCost || 0)
      + firstPositiveMoney(product?.packingCost || 0)
      + firstPositiveMoney(product?.distributionCost || 0)
      + firstPositiveMoney(product?.otherCost || 0);
  }

  function hppPerPcsForItem(item) {
    const master = productMasterForItem(item);
    const candidates = [];

    // 1) Total HPP tersimpan dari pengiriman/produksi dibagi qty kirim.
    candidates.push(hppFromTotalFields(item));

    // 2) HPP final per pcs yang tersimpan langsung di item pesanan/pengiriman.
    candidates.push(firstPositiveMoney(
      item?.hppPerPcs,
      item?.hpp,
      item?.hppFinal,
      item?.finalHpp,
      item?.hppSatuan,
      item?.hppFinalPerPcs,
      item?.totalHppPerPcs,
      item?.costPerPcs,
      item?.modalPerPcs,
      item?.modalPcs,
      item?.modalSatuan,
      item?.hargaModal,
      item?.hargaPokok,
      item?.unitCost,
      item?.unitHpp,
      item?.finalCost,
      item?.cost,
      item?.modal
    ));

    // 3) Komponen biaya item lama. HPP di app ini dianggap HPP final,
    //    jadi kalau komponen tersimpan lengkap kita pakai total komponennya.
    candidates.push(componentHpp(item));

    // 4) Master produk sebagai fallback sekaligus pembetul data order lama
    //    yang belum menyimpan HPP final.
    if (master) {
      candidates.push(productMasterHppValue(master));
    }

    // 5) Fallback terakhir: bahanCost. Ini menjaga HPP tidak nol,
    //    tapi Pusat Kendala tetap menandai jika data final HPP tidak lengkap.
    candidates.push(firstPositiveMoney(item?.bahanCost, item?.materialCost));

    const valid = candidates.filter((n) => Number(n || 0) > 0 && isReasonableMoney(n));
    if (valid.length === 0) return 0;

    // Jangan lagi mengambil nilai terbesar, karena pada data lama ada field total/modal
    // yang bisa terbaca sebagai HPP per pcs dan membuat laba produk menjadi minus palsu.
    // Prioritaskan HPP yang masuk akal terhadap harga jual item.
    const price = moneyValue(item?.price || item?.salePrice || item?.defaultPrice || 0);
    if (price > 0) {
      const notMinus = valid.find((n) => n <= price);
      if (notMinus > 0) return notMinus;
    }
    return valid[0];
  }

  function orderHppTotalWithMaster(order) {
    // Untuk laporan bisnis, HPP harus mengikuti basis yang sama dengan realisasi penjualan:
    // hanya barang yang sudah dikirim. Perhitungan memakai fallback HPP master/komponen/hasil produksi.
    return deliveryBusinessTotals(order).hpp;
  }

  function deliveryItemHppPerPcs(order, deliveryItem, fallbackIndex = null) {
    const base = orderItemForDeliveryItem(order, deliveryItem, fallbackIndex) || {};
    return hppPerPcsForItem({
      ...(deliveryItem || {}),
      ...base,
      name: base?.name || deliveryItem?.name,
      originalName: deliveryItem?.name || "",
      oldName: deliveryItem?.name || "",
      productId: base?.productId || base?.product_id || base?.masterProductId || deliveryItem?.productId || deliveryItem?.product_id || deliveryItem?.masterProductId || "",
    });
  }

  function deliveryLevelHppTotal(delivery) {
    return firstPositiveMoney(
      delivery?.deliveredHppTotal,
      delivery?.deliveryHppTotal,
      delivery?.hppTotal,
      delivery?.totalHpp,
      delivery?.hppSubtotal,
      delivery?.totalCost,
      delivery?.costTotal
    );
  }

  function orderLevelDeliveredHppTotal(order) {
    return firstPositiveMoney(
      order?.deliveredHppTotal,
      order?.deliveryHppTotal,
      order?.hppDeliveredTotal,
      order?.hppTotalDelivered,
      order?.totalDeliveredHpp,
      order?.hppTotal,
      order?.totalHpp
    );
  }

  function deliveryBusinessTotals(order, deliveryDatePredicate = null) {
    const deliveries = getDeliveryHistory(order);
    let revenue = 0;
    let hpp = 0;

    if (deliveries.length > 0) {
      deliveries.forEach((delivery) => {
        const d = delivery.date || delivery.tanggal || delivery.createdAt?.slice?.(0, 10) || order?.tanggalKirim || order?.createdAt || order?.date || "";
        if (deliveryDatePredicate && !deliveryDatePredicate(d)) return;
        let deliveryRevenue = 0;
        let deliveryItemHpp = 0;
        (delivery.items || []).forEach((it, itemIdx) => {
          const qty = Number(it.qty ?? it.shippedQty ?? 0);
          if (qty <= 0) return;
          const base = orderItemForDeliveryItem(order, it, itemIdx) || {};
          deliveryRevenue += qty * moneyValue(it.price ?? base.price ?? 0);
          deliveryItemHpp += qty * deliveryItemHppPerPcs(order, it, itemIdx);
        });
        revenue += deliveryRevenue;
        const deliveryTotalHpp = deliveryLevelHppTotal(delivery);
        hpp += Math.max(deliveryItemHpp, deliveryTotalHpp);
      });
      const hasIncludedDelivery = !deliveryDatePredicate || deliveries.some((delivery) => {
        const d = delivery.date || delivery.tanggal || delivery.createdAt?.slice?.(0, 10) || order?.tanggalKirim || order?.createdAt || order?.date || "";
        return deliveryDatePredicate(d);
      });
      if (hasIncludedDelivery && revenue > 0) revenue += orderShippingCost(order);
      return { revenue, hpp };
    }

    // Fallback untuk data lama yang hanya punya shippedItems/deliveredTotal tanpa deliveries.
    // Anggap tanggal realisasi dari tanggalKirim, lalu fallback ke tanggal order.
    const fallbackDate = order?.tanggalKirim || order?.deliveryDate || order?.shippingDate || order?.createdAt || order?.date || order?.tanggal || "";
    if (deliveryDatePredicate && !deliveryDatePredicate(fallbackDate)) return { revenue: 0, hpp: 0 };
    const revenueFallback = orderPaymentTarget(order);
    const itemHppFallback = normalizeShipmentItems(order).reduce((sum, it) => sum + Number(it.shippedQty || 0) * hppPerPcsForItem(it), 0);
    const totalHppFallback = orderLevelDeliveredHppTotal(order);
    return { revenue: revenueFallback, hpp: Math.max(itemHppFallback, totalHppFallback) };
  }

  function orderBusinessTotalsInRekap(order) {
    if (rekapDateBasis === "order") {
      if (!inRekapRange(order.createdAt || order.date || order.tanggal || "")) return { revenue: 0, hpp: 0 };
      return { revenue: orderPaymentTarget(order), hpp: orderHppTotalWithMaster(order) };
    }
    return deliveryBusinessTotals(order, (dateValue) => inRekapRange(dateValue));
  }

  function rekapScopedData() {
    const scopedOrders = (orders || []).filter((o) => {
      const totals = orderBusinessTotalsInRekap(o);
      if (totals.revenue > 0 || totals.hpp > 0) return true;
      if (rekapDateBasis === "order") return inRekapRange(o.createdAt || o.date || o.tanggal || "");
      return false;
    });
    const scopedPurchases = (purchases || []).filter((p) => inRekapRange(p.createdAt || p.date || p.tanggal || ""));
    const scopedExpenses = (expenses || []).filter((e) => inRekapRange(e.date || e.createdAt || ""));
    const scopedTransfers = (transfers || []).filter((t) => inRekapRange(t.date || t.createdAt || ""));
    const scopedTransfersOut = (transfersOut || []).filter((t) => inRekapRange(t.date || t.createdAt || ""));
    return { scopedOrders, scopedPurchases, scopedExpenses, scopedTransfers, scopedTransfersOut };
  }

  function rekapSummary() {
    const { scopedOrders, scopedPurchases, scopedExpenses, scopedTransfers, scopedTransfersOut } = rekapScopedData();
    const realisasi = scopedOrders.reduce((s, o) => s + orderBusinessTotalsInRekap(o).revenue, 0);
    const hpp = scopedOrders.reduce((s, o) => s + orderBusinessTotalsInRekap(o).hpp, 0);
    const bayarCustomer = scopedTransfers.reduce((s, t) => s + moneyValue(t.amount || 0), 0);
    const bayarSupplier = scopedTransfersOut.reduce((s, t) => s + moneyValue(t.amount || 0), 0);
    const pengeluaran = scopedExpenses.reduce((s, e) => s + moneyValue(e.amount || 0), 0);
    // Piutang customer adalah saldo hutang aktif saat ini, bukan angka periode.
    // Dashboard dan Rekap harus memakai satu sumber kebenaran yang sama agar tidak
    // muncul dua nominal piutang berbeda untuk customer yang sama. Filter tanggal
    // tetap berlaku untuk omzet/HPP/pembayaran/pengeluaran, tetapi piutang selalu
    // menunjukkan saldo belum lunas terbaru dari seluruh invoice terkirim.
    const piutang = totalPiutangCustomerAktif();
    const hutangSupplier = scopedPurchases.reduce((s, p) => s + Math.max(0, sisaPurchase(p)), 0);
    const gajiProduksi = payrollExpenseRows
      .filter((p) => inRekapRange(p.tanggalSetor || p.tanggalBayar || p.date || p.tanggal || p.createdAt?.slice?.(0, 10) || ""))
      .reduce((s, p) => s + safeSummaryMoney(p.safeAmount || 0), 0);
    // HPP produk saat ini sudah termasuk biaya produksi/accessories, jadi gaji produksi
    // tidak dikurangkan lagi dari laba agar tidak double count.
    const laba = realisasi - hpp - pengeluaran;
    return { scopedOrders, scopedPurchases, scopedExpenses, scopedTransfers, scopedTransfersOut, omzet: realisasi, realisasi, hpp, bayarCustomer, bayarSupplier, pengeluaran, gajiProduksi, piutang, hutangSupplier, laba };
  }

  function customerRowsInRekapRange() {
    // Piutang customer tidak lagi dihitung sebagai angka periode.
    // Semua tampilan piutang wajib memakai saldo aktif saat ini agar tidak ada 2 nominal.
    const customerKeys = [...new Set((orders || []).map((o) => normalizeName(o.customer || "")).filter(Boolean))];
    return customerKeys
      .map((key) => customerReceivableTotals(key))
      .filter((row) => Number(row.sisa || 0) > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function downloadRekapTanggalPdf() {
    const { jsPDF, autoTable } = await loadPdfTools();
    const s = rekapSummary();
    const pdf = new jsPDF("p", "mm", "a4");
    addPdfHeader(pdf, "Rekap Gallery Kerudung", "all");
    pdf.setFontSize(10);
    pdf.setTextColor(100);
    pdf.text(`Periode: ${rangeLabel()}`, 14, 58);
    const rows = [
      ["Realisasi Penjualan", rupiah(s.realisasi)],
      ["Realisasi Terkirim", rupiah(s.realisasi)],
      ["HPP Terkirim", rupiah(s.hpp)],
      ["Pengeluaran Operasional", rupiah(s.pengeluaran)],
      ["Laba", rupiah(s.laba)],
      ["Pembayaran Customer", rupiah(s.bayarCustomer)],
      ["Transfer Keluar Supplier", rupiah(s.bayarSupplier)],
      ["Piutang Customer Saat Ini", rupiah(s.piutang)],
      ["Tagihan Supplier", rupiah(s.hutangSupplier)],
      ["Jumlah Pesanan", `${s.scopedOrders.length} pesanan`],
    ];
    autoTable(pdf, {
      startY: 66,
      head: [["Ringkasan", "Nilai"]],
      body: rows,
      theme: "grid",
      headStyles: { fillColor: [236, 72, 153], textColor: 255, fontStyle: "bold" },
      styles: { fontSize: 10, cellPadding: 3 },
      columnStyles: { 1: { halign: "right" } },
    });

    const customerRows = customerRowsInRekapRange();
    if (customerRows.length > 0) {
      autoTable(pdf, {
        startY: pdf.lastAutoTable.finalY + 10,
        head: [["Customer", "Pesanan", "Tagihan Saat Ini", "Dibayar FIFO", "Piutang Saat Ini"]],
        body: customerRows.map((c) => [c.name, c.orderCount || c.orders.length, rupiah(c.totalTagihan), rupiah(c.totalBayar), rupiah(c.sisa)]),
        theme: "grid",
        headStyles: { fillColor: [168, 85, 247], textColor: 255, fontStyle: "bold" },
        styles: { fontSize: 8, cellPadding: 2 },
        columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" } },
      });
    }

    pdf.save(`rekap-gallery-kerudung-${rekapStartDate || "awal"}-${rekapEndDate || "akhir"}.pdf`);
    addAuditLog("Download Rekap PDF", `Periode ${rangeLabel()}`);
  }

  function shareRekapTanggalWA() {
    const s = rekapSummary();
    const text = [
      "📊 Rekap Gallery Kerudung",
      `Periode: ${rangeLabel()}`,
      "",
      `Pesanan: ${s.scopedOrders.length}`,
      `Realisasi Penjualan: ${rupiah(s.realisasi)}`,
      `Realisasi: ${rupiah(s.realisasi)}`,
      `HPP Terkirim: ${rupiah(s.hpp)}`,
      `Pengeluaran: ${rupiah(s.pengeluaran)}`,
      `${s.laba < 0 ? "Rugi Bersih" : "Laba Bersih"}: ${s.laba < 0 ? "-" : ""}${rupiah(Math.abs(s.laba))}`,
      `Status Laba: ${businessSummary.hppIsValid ? "Valid" : "Belum valid - ada barang terkirim tanpa HPP final"}`,
      `Piutang Saat Ini: ${rupiah(s.piutang)}`,
      `Tagihan Supplier: ${rupiah(s.hutangSupplier)}`,
      "",
      "Log:",
      `Transfer Masuk: ${rupiah(s.bayarCustomer)}`,
      `Transfer Keluar: ${rupiah(s.bayarSupplier)}`,
    ].join("\\n");
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
    addAuditLog("Kirim Rekap WA", `Periode ${rangeLabel()}`);
  }

  function addAuditLog(action, detail = "") {
    try {
      const entry = { time: new Date().toLocaleString("id-ID"), action, detail, user: user?.email || "-" };
      const next = [entry, ...auditLogs].slice(0, 50);
      setAuditLogs(next);
      localStorage.setItem("gk_audit_logs", JSON.stringify(next));
      if (user?.email) {
        addDoc(collection(db, "auditLogs"), { ...entry, createdAt: new Date().toISOString() }).catch(() => {});
      }
    } catch (e) {}
  }

  function openOrderModal(prefill = null) { if (prefill) setOrderForm(prefill); setModal("order"); }

  function resetOrderDraft() {
    const blank = { date: todayStr(), customer: "", phone: "", items: [emptyOrderItem()], shippingCost: 0, dp: 0 };
    setOrderForm(blank);
    try { localStorage.removeItem("gk_order_draft"); } catch (e) {}
  }

  function duplicateOrder(order) {
    const items = normalizeOrderItems(order).map((it) => ({ name: it.name || "", category: it.category || "Lainnya", qty: it.qty || "", price: moneyValue(it.price || 0), bahanCost: moneyValue(it.bahanCost || 0), hppPerPcs: moneyValue(it.hppPerPcs || 0), mainMaterial: it.mainMaterial || "", materialQtyPerPcs: it.materialQtyPerPcs || 0, unit: it.unit || "yard" }));
    openOrderModal({ date: todayStr(), customer: order.customer || "", phone: order.phone || "", items: items.length > 0 ? items : [emptyOrderItem()], shippingCost: orderShippingCost(order), dp: 0 });
  }

  function shareOrderWhatsApp(order) {
    const phone = String(order.phone || "").replace(/\D/g, "").replace(/^0/, "62");
    const paid = orderPaidTotal(order);
    const total = orderPaymentTarget(order);
    const ongkir = orderShippingCost(order);
    const sisa = total - paid;
    const items = normalizeShipmentItems(order).map((it) => `- ${it.name}: kirim ${Number(it.shippedQty || 0)}/${Number(it.orderedQty || 0)} pcs x ${rupiah(it.price)}`).join("\n");
    const text = [`Halo Kak ${order.customer || ""},`, `Invoice: ${order.invoice || "-"}`, items, ongkir > 0 ? `Ongkir: ${rupiah(ongkir)}` : "", `Total tagihan: ${rupiah(total)}`, `Sudah dibayar: ${rupiah(paid)}`, sisa > 0 ? `Sisa: ${rupiah(sisa)}` : `Status: Lunas`, `Terima kasih 🙏`].filter(Boolean).join("\n");
    const url = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank");
  }


  function payrollExpenseAmount(row) {
    const amount = safeSummaryMoney(row?.totalAmount ?? row?.amount ?? 0);
    if (amount <= 0) return 0;
    const type = String(row?.type || "").toLowerCase();
    const source = String(row?.source || "").toLowerCase();
    const status = String(row?.status || "").toLowerCase();
    if (type.includes("marker") || type.includes("status") || type.includes("sudah") || status.includes("marker") || status.includes("sudah")) return 0;
    if (type && !type.includes("gaji") && !type.includes("payroll")) return 0;
    if (source && source.includes("marker")) return 0;
    return amount;
  }

  const payrollExpenseRows = useMemo(() => (payrollExpenses || [])
    .map((p) => ({ ...p, safeAmount: payrollExpenseAmount(p) }))
    .filter((p) => p.safeAmount > 0)
    .sort((a, b) => dateSerial(b.tanggalSetor || b.tanggalBayar || b.date || b.tanggal || b.createdAt || "") - dateSerial(a.tanggalSetor || a.tanggalBayar || a.date || a.tanggal || a.createdAt || "")),
  [payrollExpenses]);

  function orderHppCoverage(order, deliveryDatePredicate = null) {
    const rows = [];
    let totalQty = 0;
    let missingQty = 0;
    const addRow = (item, qty, date = "", hasDeliveryLevelHpp = false) => {
      if (qty <= 0) return;
      totalQty += qty;
      const hppPerPcs = hppPerPcsForItem(item);
      if (hppPerPcs <= 0 && !hasDeliveryLevelHpp) {
        missingQty += qty;
        rows.push({
          orderId: order?.id || "",
          invoice: order?.invoice || order?.orderNumber || "",
          customer: order?.customer || "",
          product: item?.name || item?.item || "Produk",
          qty,
          date,
        });
      }
    };

    const deliveries = getDeliveryHistory(order);
    if (deliveries.length > 0) {
      deliveries.forEach((delivery) => {
        const date = delivery.date || delivery.tanggal || delivery.createdAt?.slice?.(0, 10) || order?.tanggalKirim || order?.createdAt || order?.date || "";
        if (deliveryDatePredicate && !deliveryDatePredicate(date)) return;
        const hasDeliveryLevelHpp = deliveryLevelHppTotal(delivery) > 0;
        (delivery.items || []).forEach((it, itemIdx) => {
          const qty = Number(it.qty ?? it.shippedQty ?? 0);
          const base = orderItemForDeliveryItem(order, it, itemIdx);
          addRow({ ...(base || {}), ...(it || {}), name: base?.name || it?.name, originalName: it?.name || "" }, qty, date, hasDeliveryLevelHpp);
        });
      });
      return { totalQty, missingQty, missingRows: rows };
    }

    const fallbackDate = order?.tanggalKirim || order?.deliveryDate || order?.shippingDate || order?.createdAt || order?.date || order?.tanggal || "";
    if (deliveryDatePredicate && !deliveryDatePredicate(fallbackDate)) return { totalQty: 0, missingQty: 0, missingRows: [] };
    const hasOrderLevelHpp = orderLevelDeliveredHppTotal(order) > 0;
    normalizeShipmentItems(order).forEach((it) => addRow(it, Number(it.shippedQty || 0), fallbackDate, hasOrderLevelHpp));
    return { totalQty, missingQty, missingRows: rows };
  }

  const productProfitSummary = useMemo(() => {
    const map = {};
    orders.forEach((o) => normalizeShipmentItems(o).forEach((it) => {
      const qty = Number(it.shippedQty || 0);
      if (qty <= 0) return;
      const key = normalizeName(it.name || "Produk");
      const revenue = qty * moneyValue(it.price || 0);
      const hppPerPcs = hppPerPcsForItem(it);
      const rawHpp = qty * hppPerPcs;
      // Di kartu Laba per Produk, HPP yang lebih besar dari nilai jual biasanya berasal
      // dari data lama/field total yang terbaca sebagai HPP satuan. Supaya tampilan
      // tidak menjadi minus palsu, batasi HPP maksimal sebesar omzet item.
      const hpp = revenue > 0 ? Math.min(rawHpp, revenue) : rawHpp;
      if (!map[key]) map[key] = { name: it.name || "Produk", qty: 0, revenue: 0, hpp: 0, laba: 0, missingHpp: 0 };
      map[key].qty += qty; map[key].revenue += revenue; map[key].hpp += hpp; map[key].laba += Math.max(0, revenue - hpp);
      if (hppPerPcs <= 0) map[key].missingHpp += qty;
    }));
    return Object.values(map).sort((a, b) => b.laba - a.laba);
  }, [orders, productMasters]);

  const businessSummary = useMemo(() => {
    const totalPesananAwal = orders.reduce((s, o) => s + moneyValue(o.total || 0), 0);
    const totalRealisasi = orders.reduce((s, o) => s + orderPaymentTarget(o), 0);
    const customerNamesForSummary = [...new Set((orders || []).map((o) => normalizeName(o.customer || "")).filter(Boolean))];
    const totalPembayaranCustomer = customerNamesForSummary.reduce((sum, key) => {
      const order = (orders || []).find((o) => normalizeName(o.customer || "") === key);
      return sum + moneySum(customerPaymentEventsSorted(order?.customer || key), (p) => p.amount);
    }, 0);
    const totalBelanjaSupplier = purchases.reduce((s, p) => s + purchaseInvoiceTotal(p), 0);
    const supplierNamesForSummary = [...new Set((purchases || []).map((p) => normalizeName(p.supplier || "")).filter(Boolean))];
    const totalBayarSupplier = supplierNamesForSummary.reduce((sum, key) => {
      const purchase = (purchases || []).find((p) => normalizeName(p.supplier || "") === key);
      return sum + moneySum(supplierPaymentEventsSorted(purchase?.supplier || key), (p) => p.amount);
    }, 0);
    const totalPengeluaran = moneySum(expenses, (e) => e.amount);
    const totalGajiProduksi = payrollExpenseRows.reduce((s, p) => s + safeSummaryMoney(p.safeAmount || 0), 0);
    const nilaiStok = materialsStock.reduce((s, m) => s + safeMaterialStockValue(m, purchases), 0);
    const hppDariProduk = orders.reduce((s, o) => s + orderHppTotalWithMaster(o), 0);
    const estimasiHppBahanTerpakai = hppDariProduk > 0 ? hppDariProduk : 0;
    const hppCoverage = orders.reduce((acc, o) => {
      const c = orderHppCoverage(o);
      acc.totalQty += c.totalQty;
      acc.missingQty += c.missingQty;
      acc.missingRows += c.missingRows.length;
      if (c.missingRows.length > 0) acc.samples.push(...c.missingRows.slice(0, 3));
      return acc;
    }, { totalQty: 0, missingQty: 0, missingRows: 0, samples: [] });
    const labaKotor = totalRealisasi - estimasiHppBahanTerpakai;
    // HPP produk sudah termasuk biaya produksi/accessories, jadi Gaji Produksi
    // hanya ditampilkan sebagai info operasional dan tidak dikurangkan lagi dari laba.
    const labaBersih = totalRealisasi - estimasiHppBahanTerpakai - totalPengeluaran;
    const cashflowBersih = totalPembayaranCustomer - totalBayarSupplier - totalPengeluaran - totalGajiProduksi;
    const piutang = totalPiutangCustomerAktif();
    const hutangSupplier = purchases.reduce((s, p) => s + Math.max(0, sisaPurchase(p)), 0);
    const stokKritis = materialsStock.filter((m) => Number(m.minStock || 0) > 0 && Number(m.stock || 0) <= Number(m.minStock || 0));
    const customerBelumLunas = uniqueCustomers.filter((c) => Number(c.totalSisa || 0) > 0);
    const supplierBelumLunas = uniqueSuppliers.filter((s) => Number(s.totalSisa || 0) > 0);
    const supplierDataWarnings = purchases.filter((p) => purchaseHasAbnormalData(p));
    return { totalPesananAwal, totalRealisasi, totalPembayaranCustomer, totalBelanjaSupplier, totalBayarSupplier, totalPengeluaran, totalGajiProduksi, nilaiStok, estimasiHppBahanTerpakai, labaKotor, labaBersih, cashflowBersih, piutang, hutangSupplier, stokKritis, customerBelumLunas, supplierBelumLunas, supplierDataWarnings, hppCoverage, hppMissingQty: hppCoverage.missingQty, hppMissingRows: hppCoverage.missingRows, hppMissingSamples: hppCoverage.samples.slice(0, 8), hppIsValid: hppCoverage.missingQty <= 0 };
  }, [orders, purchases, expenses, transfers, transfersOut, materialsStock, uniqueCustomers, uniqueSuppliers, productMasters, payrollExpenseRows]);


  async function repairOneSupplierPurchase(purchase) {
    if (!purchase?.id) return;
    const payload = buildSupplierRepairPayload(purchase);
    await updateDoc(doc(db, "purchases", purchase.id), payload);
    addAuditLog("Perbaiki Data Supplier", `${purchase.supplier || "Supplier"} - ${rupiah(payload.total)}`);
  }

  async function repairSupplierWarningData() {
    const rows = businessSummary.supplierDataWarnings || [];
    if (rows.length === 0) return alert("Tidak ada data supplier bermasalah.");
    const ok = window.confirm(`Perbaiki otomatis ${rows.length} data supplier bermasalah?\n\nApp akan menormalkan nominal rusak seperti 16.746.329.999.999.998 menjadi nominal wajar berdasarkan qty dan harga/total yang masih bisa dihitung.`);
    if (!ok) return;
    setRepairingSupplierData(true);
    try {
      for (const purchase of rows) {
        await repairOneSupplierPurchase(purchase);
      }
      alert(`✅ ${rows.length} data supplier berhasil diperbaiki. Ringkasan Bisnis akan update otomatis.`);
      setDashboardDetail(null);
    } catch (e) {
      alert("Gagal memperbaiki data supplier: " + (e?.message || e));
    } finally {
      setRepairingSupplierData(false);
    }
  }

  function buildDashboardDetailData() {
    const orderRows = [...(orders || [])]
      .sort(sortOldestBottom)
      .map((o) => ({
        id: o.id,
        title: `${o.customer || "Customer"}${o.invoice ? ` · ${o.invoice}` : ""}`,
        subtitle: `Tanggal ${o.createdAt || o.date || "-"} · Status ${effectiveOrderStatus(o)}`,
        amount: orderPaymentTarget(o),
        rightNote: `Bayar ${rupiah(orderPaidTotal(o))} · Sisa ${rupiah(sisaOrder(o))}`,
      }));

    const labaRows = [
      { id: "realisasi", title: "Realisasi Penjualan", subtitle: "Nilai barang yang sudah dikirim", amount: businessSummary.totalRealisasi, tone: "plus" },
      { id: "hpp", title: "HPP Terkirim", subtitle: "HPP final barang yang sudah dikirim", amount: -businessSummary.estimasiHppBahanTerpakai, tone: "minus" },
      { id: "gaji", title: "Gaji Produksi", subtitle: "Info operasional; tidak dikurangkan lagi karena sudah masuk HPP", amount: businessSummary.totalGajiProduksi, tone: "info" },
      { id: "expense", title: "Pengeluaran Lain", subtitle: "Biaya operasional manual", amount: -businessSummary.totalPengeluaran, tone: "minus" },
      { id: "net", title: businessSummary.labaBersih < 0 ? "Rugi Bersih" : "Laba Bersih", subtitle: "Realisasi Penjualan - HPP Terkirim - Pengeluaran Lain", amount: businessSummary.labaBersih, tone: businessSummary.labaBersih >= 0 ? "plus" : "minus" },
    ];

    const piutangRows = [...(uniqueCustomers || [])]
      .filter((c) => Number(c.totalSisa || 0) > 0)
      .sort((a, b) => Number(b.totalSisa || 0) - Number(a.totalSisa || 0))
      .map((c) => ({
        id: c.name,
        title: c.name,
        subtitle: `${c.pesananAktif || 0} pesanan aktif · ${c.totalPesanan || 0} total pesanan`,
        amount: Number(c.totalSisa || 0),
      }));

    const hutangRows = [...(uniqueSuppliers || [])]
      .filter((s) => Number(s.totalSisa || 0) > 0)
      .sort((a, b) => Number(b.totalSisa || 0) - Number(a.totalSisa || 0))
      .map((sp) => ({
        id: sp.name,
        title: sp.name,
        subtitle: `${sp.belanjaAktif || 0} nota aktif · ${sp.totalBelanja || 0} total nota`,
        amount: Number(sp.totalSisa || 0),
      }));

    const hppRows = [...(productProfitSummary || [])]
      .sort((a, b) => Number(b.hpp || 0) - Number(a.hpp || 0))
      .map((p) => ({
        id: p.name,
        title: p.name,
        subtitle: `Terjual ${Number(p.qty || 0).toLocaleString("id-ID")} pcs · omzet ${rupiah(p.revenue || 0)}`,
        amount: Number(p.hpp || 0),
        rightNote: `Laba ${rupiah(p.laba || 0)}`,
      }));

    const gajiRows = payrollExpenseRows.map((p, idx) => {
      const worker = p.employeeName || p.nama || p.workerName || p.pekerja || "Pekerja";
      const proses = [p.process || p.proses, p.model || p.productModel || p.productType].filter(Boolean).join(" · ");
      const tanggal = p.tanggalSetor || p.tanggalBayar || p.date || p.tanggal || p.createdAt?.slice?.(0, 10) || "-";
      const pcs = Number(p.qtySetor || p.qty || p.pcs || 0);
      return {
        id: p.id || `${worker}-${idx}`,
        title: worker,
        subtitle: `${tanggal}${proses ? ` · ${proses}` : ""}${pcs > 0 ? ` · ${pcs.toLocaleString("id-ID")} pcs` : ""}`,
        amount: Number(p.safeAmount || 0),
        rightNote: p.invoice || p.orderInvoice || p.customer || "",
      };
    });

    const expenseRows = [...(expenses || [])]
      .sort(sortOldestBottom)
      .map((e) => ({
        id: e.id,
        title: e.category || "Pengeluaran",
        subtitle: `${e.date || e.createdAt || "-"}${e.note ? ` · ${e.note}` : ""}`,
        amount: safeSummaryMoney(e.amount || 0),
      }));

    const stockRows = [...(materialsStock || [])]
      .sort((a, b) => safeMaterialStockValue(b, purchases) - safeMaterialStockValue(a, purchases))
      .map((m) => ({
        id: m.id || m.name,
        title: m.name || "Bahan",
        subtitle: (() => { const info = safeMaterialStockInfo(m, purchases); return `Stok ${Number(info.stock || 0).toLocaleString("id-ID")} ${m.unit || "yard"} · Avg ${rupiah(info.avgCost || 0)}${info.abnormal ? " · diperbaiki" : ""}`; })(),
        amount: safeMaterialStockValue(m, purchases),
        rightNote: Number(m.minStock || 0) > 0 && Number(m.stock || 0) <= Number(m.minStock || 0) ? "Stok kritis" : "",
      }));

    const supplierWarningRows = (businessSummary.supplierDataWarnings || []).map((p) => {
      const tanggal = p.createdAt || p.date || "-";
      const bahan = purchaseMaterialsSummary(p);
      let rightNote = "Nominal lama rusak. Klik Perbaiki Otomatis di atas, atau edit manual di tab Supplier.";
      try {
        const repairPayload = buildSupplierRepairPayload(p);
        rightNote = `Nominal lama rusak. Estimasi perbaikan ${rupiah(repairPayload.total)}. Klik Perbaiki Otomatis di atas.`;
      } catch (e) {
        rightNote = "Nominal lama rusak dan belum cukup data untuk diperbaiki otomatis. Edit manual di tab Supplier.";
      }
      return {
        id: p.id || `${p.supplier}-${tanggal}`,
        title: p.supplier || "Supplier",
        subtitle: `${tanggal} · ${bahan}`,
        amount: 0,
        amountLabel: "Perlu edit",
        rightNote,
        tone: "minus",
      };
    });

    return {
      omzet: { title: "Rincian Realisasi Penjualan", total: businessSummary.totalRealisasi, subtitle: "Nilai barang yang sudah dikirim", rows: orderRows },
      laba: { title: businessSummary.labaBersih < 0 ? "Rincian Rugi Bersih" : "Rincian Laba Bersih", total: businessSummary.labaBersih, subtitle: "Realisasi Penjualan - HPP Terkirim - Pengeluaran Lain", rows: labaRows },
      piutang: { title: "Rincian Piutang Customer", total: businessSummary.piutang, subtitle: "Customer dengan sisa tagihan", rows: piutangRows },
      hutang: { title: "Rincian Tagihan Supplier", total: businessSummary.hutangSupplier, subtitle: "Supplier dengan sisa tagihan aktif", rows: hutangRows },
      hpp: { title: "Rincian HPP Terkirim", total: businessSummary.estimasiHppBahanTerpakai, subtitle: "HPP final per produk berdasarkan barang terkirim", rows: hppRows },
      gaji: { title: "Rincian Gaji Produksi", total: businessSummary.totalGajiProduksi, subtitle: "Info operasional; tidak dikurangkan lagi dari laba karena sudah masuk HPP", rows: gajiRows },
      pengeluaran: { title: "Rincian Pengeluaran Lain", total: businessSummary.totalPengeluaran, subtitle: "Biaya operasional manual", rows: expenseRows },
      stok: { title: "Rincian Nilai Stok", total: businessSummary.nilaiStok, subtitle: "Nilai stok bahan saat ini", rows: stockRows },
      supplierWarnings: { title: "Data Supplier Perlu Dicek", total: supplierWarningRows.length, subtitle: "Data lama bernominal rusak tidak dihitung di Ringkasan Bisnis. Buka tab Supplier lalu edit nota yang ditandai.", rows: supplierWarningRows },
    };
  }

  function openDashboardDetail(type) {
    setDashboardDetail(type);
  }

  const auditData = useMemo(() => {
    const supplierAbnormal = (purchases || []).filter((p) => purchaseHasAbnormalData(p));
    const stockAbnormal = (materialsStock || []).filter((m) => safeMaterialStockInfo(m, purchases).abnormal);
    const orderWithoutItems = (orders || []).filter((o) => normalizeOrderItems(o).length === 0 || normalizeOrderItems(o).every((it) => Number(it.qty || 0) <= 0));
    const deliveryWithoutIndex = [];
    const shortFinal = [];
    const overDelivered = [];
    const legacySentNoDetail = [];

    (orders || []).forEach((o) => {
      const items = normalizeShipmentItems(o);
      const ordered = items.reduce((s, it) => s + Number(it.orderedQty || 0), 0);
      const shipped = items.reduce((s, it) => s + Number(it.shippedQty || 0), 0);
      if (o.shortShipmentClosed === true) shortFinal.push(o);
      if (ordered > 0 && shipped > ordered) overDelivered.push({ ...o, overQty: shipped - ordered });
      if ((o.deliveries || []).some((d) => (d.items || []).some((it) => it.itemIndex === undefined || it.itemIndex === null))) deliveryWithoutIndex.push(o);
      const rawStatus = `${o.status || ""} ${o.deliveryStatus || ""} ${o.shippingStatus || ""}`.toLowerCase();
      const looksSent = /(dikirim|terkirim|selesai|lunas)/.test(rawStatus);
      const hasDetail = getDeliveryHistory(o).length > 0 || (Array.isArray(o.shippedItems) && o.shippedItems.length > 0);
      if (looksSent && !hasDetail) legacySentNoDetail.push(o);
    });

    const payrollAbnormal = (payrollExpenses || []).filter((p) => payrollExpenseAmount(p) <= 0 && moneyValue(p.totalAmount ?? p.amount ?? 0) > 0);

    return { supplierAbnormal, stockAbnormal, orderWithoutItems, deliveryWithoutIndex, shortFinal, overDelivered, legacySentNoDetail, payrollAbnormal };
  }, [purchases, materialsStock, orders, payrollExpenses]);

  const issueCenter = useMemo(() => {
    const issues = [];
    const seen = new Set();
    const addIssue = (issue) => {
      const id = issue.id || `${issue.category || "umum"}-${issue.title || "kendala"}-${issue.search || ""}`;
      if (seen.has(id)) return;
      seen.add(id);
      issues.push({ priority: "sedang", category: "Umum", tone: "amber", ...issue, id });
    };

    const orderByCustomer = {};
    (orders || []).forEach((o) => {
      const key = normalizeName(o.customer || "");
      if (!key) return;
      if (!orderByCustomer[key]) orderByCustomer[key] = [];
      orderByCustomer[key].push(o);
    });

    (orders || []).forEach((o) => {
      const customer = o.customer || "Customer";
      const invoice = o.invoice || o.kode || "Pesanan";
      const searchText = invoice || customer;
      const items = normalizeOrderItems(o);
      const shipmentItems = normalizeShipmentItems(o);
      const orderedQty = shipmentItems.reduce((sum, it) => sum + Number(it.orderedQty || 0), 0);
      const shippedQty = shipmentItems.reduce((sum, it) => sum + Number(it.shippedQty || 0), 0);
      const savedTotal = moneyValue(o.total || 0);
      const calculatedTotal = orderGrandTotal(items, orderShippingCost(o));
      const paid = orderPaidTotal(o);
      const hasDelivery = getDeliveryHistory(o).length > 0 || (Array.isArray(o.shippedItems) && o.shippedItems.length > 0) || shippedQty > 0;

      // 1. Barang terkirim tapi harga = 0 → tagihan jadi Rp 0
      const kirimTanpaHarga = shipmentItems.filter((it) => Number(it.shippedQty || 0) > 0 && moneyValue(it.price || 0) <= 0);
      if (kirimTanpaHarga.length > 0) addIssue({ id: `kirim-harga-kosong-${o.id}`, category: "Tagihan", priority: "tinggi", tone: "rose", title: `${customer} barang terkirim tanpa harga → tagihan Rp 0`, subtitle: `${invoice} · ${kirimTanpaHarga.slice(0, 3).map((it) => it.name || "Produk").join(", ")}. Edit harga di pesanan.`, targetTab: "orders", search: searchText });

      // 2. Total invoice tidak cocok dengan perhitungan item → tagihan salah
      if (savedTotal > 0 && calculatedTotal > 0 && Math.abs(savedTotal - calculatedTotal) > 100) addIssue({ id: `order-total-tidak-cocok-${o.id}`, category: "Tagihan", priority: "tinggi", tone: "rose", title: `${customer} total tagihan tidak cocok`, subtitle: `${invoice} · tersimpan ${rupiah(savedTotal)}, hitung ulang ${rupiah(calculatedTotal)}. Edit pesanan untuk sinkronkan.`, targetTab: "orders", search: searchText });

      // 3. Lebih bayar → ada uang customer yang tidak tercatat dengan benar
      if (paid > Math.max(savedTotal, orderPaymentTarget(o), calculatedTotal) && paid > 0) addIssue({ id: `order-bayar-lebih-${o.id}`, category: "Tagihan", priority: "tinggi", tone: "amber", title: `${customer} lebih bayar`, subtitle: `${invoice} · bayar ${rupiah(paid)}, tagihan ${rupiah(orderPaymentTarget(o))}. Cek apakah ada pembayaran dobel.`, targetTab: "orders", search: searchText });

      // 4. Data kirim dari Gallery Produksi tidak terbaca → qty terkirim = 0, tagihan tidak muncul
      if (hasDelivery && orderedQty > 0 && shippedQty <= 0) addIssue({ id: `kirim-tidak-terbaca-${o.id}`, category: "Tagihan", priority: "tinggi", tone: "rose", title: `${customer} data kirim tidak terbaca → tagihan hilang`, subtitle: `${invoice} · ada riwayat kirim tapi qty terkirim 0. Gunakan Repair Qty di tab Pesanan.`, targetTab: "orders", search: searchText });

      // 5. Qty pengiriman tertukar dari Gallery Produksi → tagihan salah hitung
      const rawDeliveries = Array.isArray((o.raw || o).deliveries) ? (o.raw || o).deliveries : [];
      rawDeliveries.forEach((d, dIdx) => {
        const dItems = Array.isArray(d.items) ? d.items : [];
        const orderItemsList = normalizeOrderItems(o);
        if (dItems.length < 2 || orderItemsList.length < 2) return;
        const hasMismatch = dItems.some((dItem) => {
          const byName = orderItemsList.find((oi) => normalizeName(oi.name || "") === normalizeName(dItem.name || ""));
          if (!byName) return false;
          const dQty = Number(dItem.shippedQty || dItem.qty || 0);
          const oQty = Number(byName.qty || 0);
          return dQty > 0 && oQty > 0 && dQty > oQty * 3;
        });
        if (hasMismatch) addIssue({ id: `qty-tertukar-${o.id}-${dIdx}`, category: "Tagihan", priority: "tinggi", tone: "rose", title: `${customer} qty pengiriman tertukar → tagihan salah`, subtitle: `${invoice} · pengiriman ${d.date || d.tanggal || "-"}. Gunakan Repair Qty di tab Pesanan.`, targetTab: "orders", search: searchText });
      });

    });

    const phoneGroups = {};
    (orders || []).forEach((o) => {
      const phoneKey = String(o.phone || "").replace(/\D/g, "");
      if (!phoneKey || phoneKey.length < 8) return;
      if (!phoneGroups[phoneKey]) phoneGroups[phoneKey] = [];
      phoneGroups[phoneKey].push(o);
    });
    Object.entries(phoneGroups).forEach(([phoneKey, rows]) => {
      const customerNames = Array.from(new Set(rows.map((o) => normalizeName(o.customer || "")).filter(Boolean)));
      if (customerNames.length > 1) {

      }
    });

    Object.values(orderByCustomer).forEach((rows) => {


    });

    (productMasters || []).forEach((p) => {
      const name = p.name || "Produk";
      const hpp = calculateProductHpp(p);
      const price = moneyValue(p.defaultPrice || p.price || 0);
      const soldBefore = (orders || []).some((o) => normalizeOrderItems(o).some((it) => normalizeName(it.name) === normalizeName(name) || (p.id && it.productId === p.id)));

      if (price <= 0) addIssue({ id: `produk-harga-kosong-${p.id}`, category: "Produk", priority: "tinggi", tone: "rose", title: `${name} harga jual kosong`, subtitle: `Harga jual wajib diisi sebelum produk dipakai.`, targetTab: "products", search: name });

      // Kendala margin minus tidak ditampilkan agar dashboard tidak dipenuhi peringatan
      // dari data lama yang HPP/totalnya belum seragam.

    });

    (productProfitSummary || []).forEach((p) => {
      // Kendala "terjual tapi HPP kosong" sengaja tidak ditampilkan di pusat kendala
      // agar daftar kendala tidak penuh oleh produk lama yang sudah pernah terjual.

    });



    (materialsStock || []).forEach((m) => {
      const stock = Number(m.stock || 0);
      const name = m.name || "Stok";



      const info = safeMaterialStockInfo(m, purchases);

    });

    (purchases || []).forEach((p) => {
      const supplier = p.supplier || "Supplier";
      const searchText = supplier;




    });

    (transfers || []).forEach((t) => {
      const name = t.customer || "Transfer masuk";



    });

    (transfersOut || []).forEach((t) => {
      const name = t.supplier || "Transfer keluar";



    });

    (kasbonList || []).forEach((k) => {
      const name = k.employeeName || k.nama || "Kasbon";
      const amount = moneyValue(k.jumlah || k.amount || 0);
      // Pakai sisaKasbon dari Firestore (sudah dipotong gaji dari Gallery Produksi).
      const sisa = k.sisaKasbon !== undefined && k.sisaKasbon !== null
        ? Math.max(0, parseMoney(k.sisaKasbon))
        : Math.max(0, amount - moneySum(k.cicilan || [], (c) => c.jumlah ?? c.amount ?? 0));




    });

    const priorityRank = { tinggi: 0, sedang: 1, rendah: 2 };
    return issues.sort((a, b) => (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9) || Number(b.amount || 0) - Number(a.amount || 0) || String(a.category).localeCompare(String(b.category)));
  }, [orders, purchases, materialsStock, productMasters, productProfitSummary, transfers, transfersOut, kasbonList, pesananTelat]);

  const issueSummary = useMemo(() => {
    const categories = ["Keuangan", "Produk", "Kirim", "Invoice/Nota", "Customer", "Supplier", "Stok", "Kasbon", "Sinkron Produksi", "Pesanan"];
    // Tampilkan semua kategori yang count > 0 saja (untuk ringkasan dashboard)
    return categories.map((category) => ({ category, count: issueCenter.filter((x) => x.category === category).length })).filter((x) => x.count > 0);
  }, [issueCenter]);

  // Filter list selalu menampilkan semua kategori utama (meski count 0) agar konsisten
  const issueFilters = ["semua", "Prioritas Tinggi", "Tagihan", "Pesanan", "Produk", "Customer", "Kirim", "Invoice/Nota", "Keuangan", "Supplier", "Kasbon", "Stok", "Sinkron Produksi"];

  const filteredIssueCenter = useMemo(() => {
    if (issueCenterFilter === "semua") return issueCenter;
    if (issueCenterFilter === "Prioritas Tinggi") return issueCenter.filter((x) => x.priority === "tinggi");
    return issueCenter.filter((x) => x.category === issueCenterFilter);
  }, [issueCenter, issueCenterFilter]);

  function openIssueTarget(issue) {
    if (!issue) return;
    setIssueCenterOpen(false);
    setDashboardDetail(null);
    setModal(null);
    setTab(issue.targetTab || "orders");
    setSearch(issue.search || "");
    if (issue.targetTab === "orders" && issue.customerForInvoice) {
      setInvoiceCustomer(issue.customerForInvoice);
    }
  }

  function IssueCenterCard() {
    const topIssues = issueCenter.slice(0, 5);
    return (
      <div className="mx-4 mt-4 rounded-3xl bg-white p-5 shadow-sm" style={{ border: "1.5px solid #f9a8d4" }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-black text-rose-600">⚠️ Pusat Kendala Kerudung</div>
            <div className="mt-1 text-xs text-slate-500">Semua data yang perlu dilengkapi, diperbaiki, atau dicek ulang.</div>
          </div>
          <button type="button" onClick={() => { setIssueCenterFilter("semua"); setIssueCenterOpen(true); }} className="rounded-full px-3 py-1.5 text-xs font-bold text-white" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>Buka Semua</button>
        </div>

        {issueCenter.length === 0 ? (
          <div className="mt-4 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-700" style={{ border: "1px solid #bbf7d0" }}>
            ✅ <b>Semua data utama aman.</b><br />Tidak ada pesanan bermasalah, produk tanpa HPP, pengiriman belum lengkap, atau nota/invoice yang perlu diperbaiki.
          </div>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {issueSummary.slice(0, 6).map((x) => (
                <button key={x.category} type="button" onClick={() => { setIssueCenterFilter(x.category); setIssueCenterOpen(true); }} className="rounded-2xl bg-rose-50 px-3 py-2 text-left" style={{ border: "1px solid #fecdd3" }}>
                  <div className="text-lg font-black text-rose-600">{x.count}</div>
                  <div className="text-[11px] font-bold text-rose-700">{x.category}</div>
                </button>
              ))}
            </div>
            <div className="mt-4 space-y-2">
              {topIssues.map((issue) => (
                <button key={issue.id} type="button" onClick={() => openIssueTarget(issue)} className="w-full rounded-2xl bg-slate-50 p-3 text-left active:scale-[0.99]" style={{ border: "1px solid #f1f5f9" }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-slate-800 truncate">{issue.title}</div>
                      <div className="mt-0.5 text-xs text-slate-500 leading-relaxed">{issue.subtitle}</div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${issue.priority === "tinggi" ? "bg-rose-100 text-rose-700" : issue.priority === "sedang" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>{issue.priority}</span>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  function IssueCenterModal() {
    if (!issueCenterOpen) return null;
    return (
      <SimpleModal title="Pusat Kendala Kerudung" onClose={() => setIssueCenterOpen(false)}>
        <div className="space-y-3">
          <div className="rounded-3xl p-4" style={{ background: "linear-gradient(135deg,#fff1f2,#fdf2f8)", border: "1.5px solid #fecdd3" }}>
            <div className="text-xs font-semibold text-slate-500">Total Kendala</div>
            <div className="text-3xl font-black text-rose-600">{issueCenter.length} data</div>
            <div className="mt-1 text-xs text-slate-500">Ketuk item untuk langsung pindah ke tab dan pencarian data bermasalah.</div>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {issueFilters.map((filter) => {
              const count = filter === "semua"
                ? issueCenter.length
                : filter === "Prioritas Tinggi"
                  ? issueCenter.filter((x) => x.priority === "tinggi").length
                  : issueCenter.filter((x) => x.category === filter).length;
              return (
                <button key={filter} type="button" onClick={() => setIssueCenterFilter(filter)} className="shrink-0 rounded-full px-3 py-2 text-xs font-bold" style={{ background: issueCenterFilter === filter ? "#ec4899" : "#fdf2f8", color: issueCenterFilter === filter ? "white" : "#be185d", border: "1px solid #f9a8d4" }}>
                  {filter}{count > 0 ? ` (${count})` : ""}
                </button>
              );
            })}
          </div>
          {filteredIssueCenter.length === 0 ? (
            <div className="rounded-2xl bg-emerald-50 p-5 text-center text-sm text-emerald-700">✅ Tidak ada kendala pada filter ini.</div>
          ) : (
            <div className="max-h-[64vh] space-y-2 overflow-auto pr-1">
              {filteredIssueCenter.map((issue) => (
                <button key={issue.id} type="button" onClick={() => openIssueTarget(issue)} className="w-full rounded-2xl bg-white p-3 text-left active:scale-[0.99]" style={{ border: "1px solid #f1f5f9" }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{issue.category}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${issue.priority === "tinggi" ? "bg-rose-100 text-rose-700" : issue.priority === "sedang" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>{issue.priority}</span>
                      </div>
                      <div className="mt-1 text-sm font-bold text-slate-800">{issue.title}</div>
                      <div className="mt-0.5 text-xs text-slate-500 leading-relaxed">{issue.subtitle}</div>
                    </div>
                    <div className="shrink-0 text-xs font-bold text-pink-600">Buka ›</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </SimpleModal>
    );
  }

  function AuditSection({ title, count, tone = "rose", children }) {
    const cls = tone === "amber" ? "border-amber-200 bg-amber-50 text-amber-800" : tone === "emerald" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800";
    return (
      <div className={`rounded-3xl border p-4 ${cls}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="font-bold">{title}</div>
          <div className="rounded-full bg-white/70 px-3 py-1 text-xs font-bold">{count} data</div>
        </div>
        <div className="mt-3 space-y-2 text-sm">{children}</div>
      </div>
    );
  }

  function SummaryDetailCard({ type, label, value, colorClass, bgClass, negative = false }) {
    return (
      <button type="button" onClick={() => openDashboardDetail(type)} className={`rounded-2xl ${bgClass} p-3 text-left active:scale-[0.99] transition-all`}>
        <div className="text-xs text-slate-400">{label}</div>
        <div className={`text-lg font-bold ${colorClass}`}>{Number(value || 0) < 0 || (negative && value > 0) ? "-" : ""}{rupiah(Math.abs(Number(value || 0)))}</div>
        <div className="mt-1 text-[10px] font-semibold text-slate-400">Ketuk untuk rincian</div>
      </button>
    );
  }

  function DashboardDetailModal() {
    const detail = buildDashboardDetailData()[dashboardDetail];
    if (!detail) return null;
    const rows = Array.isArray(detail.rows) ? detail.rows : [];
    return (
      <SimpleModal title={detail.title} onClose={() => setDashboardDetail(null)}>
        <div className="space-y-3">
          <div className="rounded-3xl p-4" style={{ background: "linear-gradient(135deg,#fdf2f8,#ede9fe)", border: "1.5px solid #f9a8d4" }}>
            <div className="text-xs font-semibold text-slate-500">{dashboardDetail === "supplierWarnings" ? "Jumlah Data" : "Total"}</div>
            <div className={`text-2xl font-black ${Number(detail.total || 0) < 0 ? "text-rose-600" : "text-pink-600"}`}>
              {dashboardDetail === "supplierWarnings" ? `${rows.length} data` : `${Number(detail.total || 0) < 0 ? "-" : ""}${rupiah(Math.abs(Number(detail.total || 0)))}`}
            </div>
            <div className="mt-1 text-xs text-slate-500">{detail.subtitle}</div>
            {dashboardDetail === "supplierWarnings" && rows.length > 0 && (
              <button
                type="button"
                disabled={repairingSupplierData}
                onClick={repairSupplierWarningData}
                className="mt-3 w-full rounded-2xl px-4 py-3 text-sm font-bold text-white disabled:opacity-60"
                style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}
              >
                {repairingSupplierData ? "Memperbaiki data..." : `Perbaiki Otomatis ${rows.length} Data Supplier`}
              </button>
            )}
          </div>
          {rows.length === 0 ? (
            <div className="rounded-2xl bg-slate-50 p-5 text-center text-sm text-slate-400">Belum ada rincian untuk kategori ini.</div>
          ) : (
            <div className="space-y-2 max-h-[62vh] overflow-auto pr-1">
              {rows.map((row, idx) => (
                <div key={row.id || idx} className="rounded-2xl bg-white p-3" style={{ border: "1px solid #f1f5f9" }}>
                  <div className="flex justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-slate-800 truncate">{row.title}</div>
                      <div className="text-xs text-slate-400 leading-relaxed">{row.subtitle}</div>
                      {row.rightNote && <div className="mt-1 text-[11px] font-semibold text-slate-500">{row.rightNote}</div>}
                    </div>
                    <div className={`shrink-0 text-right font-bold ${Number(row.amount || 0) < 0 || row.tone === "minus" ? "text-rose-600" : row.tone === "plus" ? "text-emerald-600" : "text-pink-600"}`}>
                      {row.amountLabel || `${Number(row.amount || 0) < 0 ? "-" : ""}${rupiah(Math.abs(Number(row.amount || 0)))}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </SimpleModal>
    );
  }

  const topCustomers = useMemo(() => {
    const map = {};
    orders.forEach((o) => { const key = normalizeName(o.customer || ""); if (!key) return; if (!map[key]) map[key] = { name: capitalizeWords(o.customer || ""), count: 0, total: 0 }; map[key].count += 1; map[key].total += orderPaymentTarget(o); });
    return Object.values(map).sort((a, b) => b.count - a.count || b.total - a.total).slice(0, 6);
  }, [orders]);

  const topProducts = useMemo(() => {
    const map = {};
    orders.forEach((o) => normalizeOrderItems(o).forEach((it) => { const key = normalizeName(it.name || ""); if (!key) return; if (!map[key]) map[key] = { name: it.name, qty: 0, total: 0 }; map[key].qty += Number(it.qty || 0); map[key].total += Number(it.qty || 0) * moneyValue(it.price || 0); }));
    return Object.values(map).sort((a, b) => b.qty - a.qty || b.total - a.total).slice(0, 6);
  }, [orders]);



  function exportBackupJson() {
    const payload = { app: "Gallery Kerudung", exportedAt: new Date().toISOString(), exportedBy: user?.email || "-", version: "backup-manual-v1", orders, purchases, expenses, transfers, transfersOut, materialsStock, productMasters, productCategories, auditLogs };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = `backup-gallery-kerudung-${todayStr()}.json`; link.click();
    addAuditLog("Backup JSON", "Export semua data bisnis");
  }

  function exportBackupTsv() {
    const SEP = "\t";
    const bs = businessSummary;
    const lines = [
      "Gallery Kerudung - Backup Ringkas",
      `Tanggal Export${SEP}${new Date().toLocaleString("id-ID")}`,
      `User${SEP}${user?.email || "-"}`, "",
      "RINGKASAN",
      ["Total Realisasi", bs.totalRealisasi].join(SEP),
      ["Transfer Masuk dari Bayar Customer", bs.totalPembayaranCustomer].join(SEP),
      ["Belanja Supplier", bs.totalBelanjaSupplier].join(SEP),
      ["Realisasi Pembayaran ke Supplier", bs.totalBayarSupplier].join(SEP),
      ["Biaya Operasional", bs.totalPengeluaran].join(SEP),
      ["Transfer Keluar Supplier", bs.totalBayarSupplier].join(SEP),
      ["Total Pengeluaran Kas", bs.totalPengeluaran + bs.totalBayarSupplier].join(SEP),
      [businessSummary.labaBersih < 0 ? "Rugi Bersih" : "Laba Bersih", bs.labaBersih].join(SEP),
      ["Cashflow Bersih", bs.cashflowBersih].join(SEP),
      ["Piutang", bs.piutang].join(SEP),
      ["Tagihan Supplier", bs.hutangSupplier].join(SEP), "",
      "PESANAN",
      ["Tanggal", "Invoice", "Customer", "Subtotal", "Ongkir", "Total", "Tagihan", "Dibayar", "Sisa", "Status"].join(SEP),
      ...orders.map((o) => [o.createdAt || "", o.invoice || "", o.customer || "", orderItemsTotal(normalizeOrderItems(o)), orderShippingCost(o), moneyValue(o.total || 0), orderPaymentTarget(o), orderPaidTotal(o), sisaOrder(o), o.status || ""].join(SEP)), "",
      "SUPPLIER",
      ["Tanggal", "Supplier", "Bahan", "Total", "Dibayar", "Sisa"].join(SEP),
      ...purchases.map((p) => [p.createdAt || "", p.supplier || "", purchaseMaterialsSummary(p), purchaseInvoiceTotal(p), purchasePaidTotal(p), sisaPurchase(p)].join(SEP)), "",
      "PENGELUARAN",
      ["Tanggal", "Jenis", "Nama/Kategori", "Catatan", "Nominal"].join(SEP),
      ...expenses.map((e) => [e.date || "", "Biaya Operasional", e.category || "", e.note || "", moneyValue(e.amount || 0)].join(SEP)),
      ...transfersOut.map((t) => [t.date || t.createdAt?.slice?.(0, 10) || "", "Transfer Keluar Supplier", t.supplier || "", `${t.bank || "Bayar Supplier"}${t.note ? ` · ${t.note}` : ""}`, moneyValue(t.amount || 0)].join(SEP)),
    ];
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/tab-separated-values;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = `backup-ringkas-gallery-kerudung-${todayStr()}.tsv`; link.click();
    addAuditLog("Backup Excel/TSV", "Export ringkasan, pesanan, transfer, supplier, pengeluaran");
  }

  // ══════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════

  if (authLoading) return (
    <div className="flex min-h-screen items-center justify-center bg-pink-50">
      <div className="text-pink-600 text-lg font-semibold">Memuat...</div>
    </div>
  );

  if (!user) return (
    <div className="flex min-h-screen flex-col items-center justify-center p-6"
      style={{ background: "linear-gradient(135deg, #fdf2f8 0%, #fce7f3 50%, #ede9fe 100%)" }}>
      <div className="w-full max-w-sm rounded-3xl bg-white/80 backdrop-blur p-8 shadow-xl text-center" style={{ border: "1.5px solid #f9a8d4" }}>
        <div className="mb-2 text-4xl">🧕✨</div>
        <div className="mb-1 text-3xl font-bold" style={{ background: "linear-gradient(135deg, #ec4899, #a855f7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Gallery Kerudung</div>
        <div className="mb-6 text-sm font-medium" style={{ color: "#c084fc" }}>💕 made by order 💕</div>
        {authError && <div className="mb-4 rounded-2xl bg-rose-50 p-3 text-sm text-rose-500 border border-rose-100">{authError}</div>}
        <button onClick={handleLogin} disabled={loginLoading} className="flex w-full items-center justify-center gap-3 rounded-2xl px-6 py-4 font-bold text-white shadow-lg disabled:opacity-60" style={{ background: "linear-gradient(135deg, #ec4899, #a855f7)" }}>
          <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20H24v8h11.3C33.6 32.8 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1L37 9.9C33.5 6.7 29 4.8 24 4.8 12.9 4.8 4 13.7 4 24.8s8.9 20 20 20c11 0 19.5-7.7 19.5-20 0-1.3-.1-2.6-.3-3.8z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.4 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1L37 9.9C33.5 6.7 29 4.8 24 4.8c-7.5 0-14 4.2-17.7 9.9z"/><path fill="#4CAF50" d="M24 44c4.9 0 9.3-1.8 12.7-4.6l-5.9-4.9C29 36.3 26.6 37 24 37c-5.3 0-9.6-3.2-11.3-7.8L6 34.2C9.7 39.8 16.3 44 24 44z"/><path fill="#1976D2" d="M43.6 20H24v8h11.3c-.9 2.4-2.5 4.4-4.6 5.8l5.9 4.9C40.2 35.2 44 30.4 44 24c0-1.3-.1-2.6-.4-4z"/></svg>
          {loginLoading ? "Memproses login..." : "Masuk dengan Google"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="gk-hd-ui mx-auto min-h-screen max-w-md" style={{ background: "#fdf2f8" }}>
      <style>{`
        .gk-hd-ui {
          color: #0f172a;
          -webkit-font-smoothing: antialiased;
          text-rendering: geometricPrecision;
        }
        .gk-hd-ui button {
          min-height: 44px;
          touch-action: manipulation;
          letter-spacing: .01em;
        }
        .gk-hd-ui input,
        .gk-hd-ui select,
        .gk-hd-ui textarea {
          min-height: 46px;
          font-size: 15px;
        }
        .gk-hd-ui .rounded-2xl,
        .gk-hd-ui .rounded-3xl {
          box-shadow: 0 1px 0 rgba(15, 23, 42, .04);
        }
        .gk-hd-ui .shadow-sm {
          box-shadow: 0 8px 24px rgba(15, 23, 42, .07);
        }
        .gk-hd-ui .text-slate-400 { color: #64748b; }
        .gk-hd-ui .text-slate-500 { color: #475569; }
        .gk-hd-ui .text-slate-600 { color: #334155; }
        .gk-hd-ui .text-xs { font-size: 12px; line-height: 1.45; }
        .gk-hd-ui .text-sm { font-size: 14.5px; line-height: 1.5; }
        .gk-hd-ui .text-lg { font-size: 19px; line-height: 1.35; }
        .gk-hd-ui .truncate {
          overflow: hidden;
          text-overflow: ellipsis;
        }
        @media (max-width: 430px) {
          .gk-hd-ui .p-3 { padding: .9rem; }
          .gk-hd-ui .p-4 { padding: 1.05rem; }
          .gk-hd-ui .px-3 { padding-left: .9rem; padding-right: .9rem; }
          .gk-hd-ui .py-2 { padding-top: .62rem; padding-bottom: .62rem; }
          .gk-hd-ui .py-3 { padding-top: .88rem; padding-bottom: .88rem; }
          .gk-hd-ui .gap-2 { gap: .62rem; }
          .gk-hd-ui .gap-3 { gap: .85rem; }
        }
      `}</style>
      {/* Header */}
      <div className="p-5 text-white relative overflow-hidden" style={{ background: "linear-gradient(135deg, #ec4899 0%, #a855f7 100%)" }}>
        <div className="flex items-center justify-between relative z-10">
          <div>
            <div className="text-3xl font-bold tracking-tight">Gallery Kerudung</div>
            <div className="mt-1 text-sm font-medium opacity-80">💕 made by order ✨</div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <img src="/logo-gk.png" className="h-16 w-16 rounded-2xl shadow-lg" alt="logo" style={{ border: "2px solid rgba(255,255,255,0.4)" }} />
            <button onClick={handleLogout} className="rounded-full px-3 py-1 text-xs font-semibold text-white" style={{ background: "rgba(255,255,255,0.25)" }}>Keluar</button>
          </div>
        </div>
        <div className="mt-4 rounded-2xl px-4 py-3 flex items-center gap-3 relative z-10" style={{ background: "rgba(255,255,255,0.2)" }}>
          <span>🔍</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cari pesanan, supplier, transfer..." className="bg-transparent outline-none flex-1 text-white placeholder-pink-100 text-sm" />
          {search && <button type="button" onClick={() => setSearch("")} className="text-pink-200 font-bold">✕</button>}
          <button
            type="button"
            onClick={() => loadFirestoreData({ showLoading: false, useCache: false })}
            disabled={loading || refreshingData}
            className="rounded-full px-3 py-1 text-xs font-bold text-white disabled:opacity-60"
            style={{ background: "rgba(255,255,255,0.25)", border: "1px solid rgba(255,255,255,0.35)" }}
          >
            {refreshingData ? "... Memuat" : "↻ Refresh"}
          </button>
        </div>
      </div>

      <TabBar tab={tab} setTab={setTab} badgeCount={pesananTelat.length} />

      {loading && <div className="flex justify-center py-10 text-slate-400">Memuat data...</div>}

      {firestoreError && (
        <div className="mx-4 mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 whitespace-pre-line">
          <div className="font-bold mb-1">Data gagal dimuat dari Firebase</div>
          <div>{firestoreError}</div>
        </div>
      )}

      {/* ── DASHBOARD SIMPLE HEMAT READS ── */}
      {!loading && tab === "dashboard" && (
        <>
          <div className="grid grid-cols-3 gap-2 p-4 pb-0">
            <button onClick={() => openOrderModal()} className="rounded-2xl bg-white p-3 text-xs font-bold shadow-sm" style={{ color: "#ec4899", border: "1.5px solid #f9a8d4" }}>+ Pesanan</button>
            <button onClick={() => setModal("pay")} className="rounded-2xl bg-white p-3 text-xs font-bold shadow-sm" style={{ color: "#059669", border: "1.5px solid #bbf7d0" }}>+ Bayar</button>
            <button onClick={() => setModal("expense")} className="rounded-2xl bg-white p-3 text-xs font-bold shadow-sm" style={{ color: "#64748b", border: "1.5px solid #e2e8f0" }}>+ Biaya</button>
          </div>

          <div className="mx-4 mt-4 rounded-3xl bg-white p-5 shadow-sm" style={{ border: "1.5px solid #f9a8d4" }}>
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <div className="text-lg font-black" style={{ color: "#ec4899" }}>📌 Dashboard Kerudung</div>
                <div className="text-xs text-slate-500">Ringkas, fokus ke tagihan dan data yang perlu tindakan.</div>
              </div>
              <button type="button" onClick={() => loadFirestoreData({ showLoading: false, useCache: false })} disabled={loading || refreshingData} className="rounded-full px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
                {refreshingData ? "Memuat..." : "Refresh"}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => { setSearch(""); setFilterOrder("belum-lunas"); setTab("orders"); }}
                className="rounded-3xl bg-rose-50 p-4 text-left active:scale-[0.99] transition-transform"
                style={{ border: "1px solid #fecdd3" }}
              >
                <div className="flex items-center justify-between gap-2"><span className="text-xl">💰</span><span className="text-[10px] font-bold text-rose-500">Buka piutang ›</span></div>
                <div className="mt-2 text-xl font-black text-rose-600">{rupiah(businessSummary.piutang || 0)}</div>
                <div className="text-xs font-bold text-slate-700">Belum Lunas</div>
                <div className="text-[10px] text-slate-500">Customer yang masih punya sisa tagihan.</div>
              </button>

              <button
                type="button"
                onClick={() => { setSearch(""); setFilterOrder("sebagian"); setTab("orders"); }}
                className="rounded-3xl bg-amber-50 p-4 text-left active:scale-[0.99] transition-transform"
                style={{ border: "1px solid #fde68a" }}
              >
                <div className="flex items-center justify-between gap-2"><span className="text-xl">🚚</span><span className="text-[10px] font-bold text-amber-600">Buka kirim ›</span></div>
                <div className="mt-2 text-2xl font-black text-amber-600">{(orders || []).filter((o) => orderDeliveryStatus(o) === "Dikirim Sebagian").length.toLocaleString("id-ID")}</div>
                <div className="text-xs font-bold text-slate-700">Kirim Belum Lengkap</div>
                <div className="text-[10px] text-slate-500">Pesanan yang sudah kirim sebagian.</div>
              </button>

              <button
                type="button"
                onClick={() => { setSearch(""); setProductQuickFilter("missing-hpp"); setTab("products"); }}
                className="rounded-3xl bg-pink-50 p-4 text-left active:scale-[0.99] transition-transform"
                style={{ border: "1px solid #f9a8d4" }}
              >
                <div className="flex items-center justify-between gap-2"><span className="text-xl">🏷️</span><span className="text-[10px] font-bold text-pink-600">Cek HPP ›</span></div>
                <div className="mt-2 text-2xl font-black text-pink-600">{productsWithoutHpp.length.toLocaleString("id-ID")}</div>
                <div className="text-xs font-bold text-slate-700">Produk Belum Punya HPP</div>
                <div className="text-[10px] text-slate-500">Lengkapi HPP agar laba dan laporan tidak kosong.</div>
              </button>

              <button
                type="button"
                onClick={() => { setIssueCenterFilter("Prioritas Tinggi"); setIssueCenterOpen(true); }}
                className="rounded-3xl bg-violet-50 p-4 text-left active:scale-[0.99] transition-transform"
                style={{ border: "1px solid #ddd6fe" }}
              >
                <div className="flex items-center justify-between gap-2"><span className="text-xl">⚠️</span><span className="text-[10px] font-bold text-violet-600">Buka kendala ›</span></div>
                <div className="mt-2 text-2xl font-black text-violet-600">{issueCenter.filter((x) => x.priority === "tinggi").length.toLocaleString("id-ID")}</div>
                <div className="text-xs font-bold text-slate-700">Prioritas Tinggi</div>
                <div className="text-[10px] text-slate-500">Data yang paling berisiko ke uang/invoice.</div>
              </button>
            </div>
          </div>

          <div className="mx-4 mt-4 rounded-3xl bg-white p-5 shadow-sm" style={{ border: "1.5px solid #fed7aa", background: "linear-gradient(135deg,#fff7ed,#ffffff)" }}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div>
                <div className="text-sm font-black" style={{ color: "#c2410c" }}>✅ Prioritas Hari Ini</div>
                <div className="text-[11px]" style={{ color: "#9a3412" }}>Maksimal 5 data terpenting. Ketuk item untuk langsung membuka data terkait.</div>
              </div>
              <button type="button" onClick={() => { setIssueCenterFilter("semua"); setIssueCenterOpen(true); }} className="rounded-full px-3 py-1 text-[11px] font-bold" style={{ background: "#ffedd5", color: "#c2410c" }}>Lihat semua ›</button>
            </div>
            {issueCenter.length === 0 ? (
              <div className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-700" style={{ border: "1px solid #bbf7d0" }}>✅ Semua data utama aman.</div>
            ) : (
              <div className="space-y-2">
                {issueCenter.slice(0, 5).map((issue) => (
                  <button key={issue.id} type="button" onClick={() => openIssueTarget(issue)} className="w-full rounded-2xl bg-white p-3 text-left active:scale-[0.99]" style={{ border: "1px solid #fed7aa" }}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-slate-800 truncate">{issue.title}</div>
                        <div className="mt-0.5 text-xs text-slate-500 leading-relaxed">{issue.subtitle}</div>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${issue.priority === "tinggi" ? "bg-rose-100 text-rose-700" : issue.priority === "sedang" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"}`}>{issue.priority}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 p-4">
            <button type="button" onClick={() => openDashboardDetail("hutang")} className="rounded-3xl bg-white p-4 text-left shadow-sm active:scale-[0.99]" style={{ border: "1px solid #fecdd3" }}>
              <div className="text-[10px] font-bold text-slate-400">Rincian supplier ›</div>
              <div className="mt-1 text-lg font-black text-rose-600">{rupiah(businessSummary.hutangSupplier || 0)}</div>
              <div className="text-xs font-bold text-slate-700">Tagihan Supplier</div>
            </button>
            <button type="button" onClick={() => openDashboardDetail("stok")} className="rounded-3xl bg-white p-4 text-left shadow-sm active:scale-[0.99]" style={{ border: "1px solid #bbf7d0" }}>
              <div className="text-[10px] font-bold text-slate-400">Buka stok kritis ›</div>
              <div className="mt-1 text-lg font-black text-emerald-600">{(businessSummary.stokKritis || []).length.toLocaleString("id-ID")}</div>
              <div className="text-xs font-bold text-slate-700">Stok Kritis</div>
            </button>
          </div>
        </>
      )}

      {/* ── ORDERS TAB ── */}
      {!loading && tab === "orders" && (
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => openOrderModal()} style={{ background: "linear-gradient(135deg,#ec4899,#f472b6)" }}>+ Pesanan</Button>
            <Button onClick={() => setModal("pay")} style={{ background: "linear-gradient(135deg,#10b981,#34d399)" }}>+ Bayar Masuk</Button>
          </div>
          <div className="flex gap-2 flex-wrap">
            <select className="flex-1 rounded-2xl border px-3 py-2 text-sm bg-white outline-none" style={{ borderColor: "#f9a8d4", minWidth: 100 }} value={filterOrder} onChange={(e) => setFilterOrder(e.target.value)}>
              <option value="semua">Semua</option>
              <option value="belum-kirim">Belum Kirim</option>
              <option value="sebagian">Sebagian</option>
              <option value="belum-lunas">Belum Lunas</option>
              <option value="selesai">Selesai</option>
              <option value="lunas">Lunas</option>
            </select>
            <select className="flex-1 rounded-2xl border px-3 py-2 text-sm bg-white outline-none" style={{ borderColor: "#f9a8d4", minWidth: 100 }} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)}>
              <option value="terbaru">Terbaru</option>
              <option value="terlama">Terlama</option>
              <option value="customer">Per Customer</option>
            </select>
          </div>

          {(() => {
            let list = [...filteredOrders];
            if (filterOrder === "belum-kirim") list = list.filter(o => orderDeliveryStatus(o) === "Proses");
            if (filterOrder === "sebagian") list = list.filter(o => orderDeliveryStatus(o) === "Dikirim Sebagian");
            if (filterOrder === "belum-lunas") list = list.filter(o => sisaOrder(o) > 0);
            if (filterOrder === "selesai") list = list.filter(o => orderDeliveryStatus(o) === "Selesai");
            if (filterOrder === "lunas") list = list.filter(o => sisaOrder(o) <= 0);
            if (sortOrder === "terbaru") list.sort(sortOldestBottom);
            if (sortOrder === "terlama") list.sort(sortOldestTop);
            if (sortOrder === "customer") list.sort((a, b) => (a.customer||"").localeCompare(b.customer||"") || sortOldestBottom(a, b));
            if (list.length === 0) return <div className="text-center py-10 text-slate-400">Tidak ada pesanan ditemukan</div>;
            return list.map((o) => {
              const paid = orderPaidTotal(o);
              const sisa = sisaOrder(o); // Math.max(0, ...) sudah ada di sisaOrder()
              return (
                <div key={o.id} className="rounded-3xl bg-white p-5 shadow-sm">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-bold text-lg">{o.customer}</div>
                      {o.phone && <a href={`https://wa.me/62${o.phone.replace(/^0/, "")}`} target="_blank" rel="noreferrer" className="text-xs text-emerald-600 font-semibold">📱 WA {o.phone}</a>}
                      <div className="text-sm text-slate-500">{o.invoice} · {orderItemsSummary(o)}</div>
                      <div className="mt-2 rounded-2xl bg-slate-50 p-3 space-y-1">
                        {normalizeShipmentItems(o).map((it, idx) => {
                          const orderedQty = Number(it.orderedQty || 0);
                          const shippedQty = Number(it.shippedQty || 0);
                          const sisaKirim = Math.max(orderedQty - shippedQty, 0);
                          const selisih = shippedQty - orderedQty;
                          const subtotal = shippedQty * moneyValue(it.price || 0);
                          return (
                            <div key={idx} className="rounded-xl bg-white px-3 py-2 text-xs">
                              <div className="flex justify-between gap-2"><span className="font-bold text-slate-700">{it.name}</span><span className="font-semibold text-purple-600">{rupiah(subtotal)}</span></div>
                              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-slate-500">
                                <span>Pesan {orderedQty} pcs</span><span>· Terkirim {shippedQty} pcs</span><span>· Sisa kirim {sisaKirim} pcs</span>
                                {selisih !== 0 && <span className={selisih < 0 ? "font-bold text-rose-600" : "font-bold text-emerald-600"}>· {selisih < 0 ? `Kurang kirim ${Math.abs(selisih)} pcs` : `Lebih kirim ${selisih} pcs`}</span>}
                              </div>
                              <div className={selisih < 0 ? "mt-1 text-rose-500" : selisih > 0 ? "mt-1 text-emerald-600" : "mt-1 text-slate-400"}>{it.note || shipmentAutoNote(orderedQty, shippedQty)}</div>
                            </div>
                          );
                        })}
                      </div>
                      {o.createdAt && <div className="text-xs text-slate-400">📅 {o.createdAt}</div>}
                      <div className="mt-1 flex flex-wrap gap-2">
                        <StatusBadge status={effectiveOrderStatus(o)} />
                        {o.statusProduksi && (
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold"
                            style={{
                              background: o.statusProduksi === "Selesai" ? "#dcfce7" : "#ede9fe",
                              color: o.statusProduksi === "Selesai" ? "#16a34a" : "#7c3aed",
                            }}>
                            {o.statusProduksi === "Selesai" ? "✅" : "🧵"} Produksi: {o.statusProduksi}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right space-y-0.5 min-w-[120px]">
                      <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Total Pesanan</div>
                      <div className="font-bold text-slate-700">{rupiah(moneyValue(o.total || 0))}</div>
                      <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mt-1">Terkirim</div>
                      <div className="font-bold text-purple-600">{rupiah(orderPaymentTarget(o))}</div>
                      <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mt-1">Sudah Dibayar</div>
                      <div className="font-bold text-emerald-600">{rupiah(paid)}</div>
                      <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mt-1">Sisa Tagihan</div>
                      {sisa > 0
                        ? <div className="font-bold text-rose-500">{rupiah(sisa)}</div>
                        : paid > 0
                          ? <div className="font-bold text-emerald-600">Lunas ✅</div>
                          : <div className="font-bold text-slate-400">Rp 0</div>
                      }
                    </div>
                  </div>
                  {orderPaymentHistory(o).length > 0 && (
                    <div className="mt-3 rounded-2xl bg-slate-50 p-3 space-y-1">
                      <div className="text-xs font-semibold text-slate-500 mb-2">Riwayat Pembayaran</div>
                      {orderPaymentHistory(o).map((p, i) => (
                        <div key={i} className="flex justify-between text-sm"><span className="text-slate-500">{p.date} · {cleanCustomerPaymentNote(p.note)}</span><span className="font-semibold text-emerald-600">{rupiah(p.amount)}</span></div>
                      ))}
                      <div className="mt-3 flex justify-between border-t border-slate-200 pt-3 text-sm font-bold">
                        <span className="text-slate-700">Total Pembayaran</span>
                        <span className="text-emerald-600">{rupiah(paid)}</span>
                      </div>
                    </div>
                  )}
                  <div className="mt-3 space-y-2">
                    {orderDeliveryStatus(o) !== "Selesai" && (
                      <button onClick={() => openKirimModal(o)} className="w-full rounded-2xl bg-sky-600 py-2 text-sm font-semibold text-white">✏️ Koreksi Pengiriman</button>
                    )}
                    {o.tanggalKirim && <div className="text-xs text-slate-400">🚚 Dikirim: {o.tanggalKirim}</div>}
                    {effectiveOrderStatus(o) === "Lunas" && <div className="text-xs text-emerald-600 font-semibold">✅ Lunas otomatis</div>}
                    {getDeliveryHistory(o).length > 0 && (
                      <div className="mt-2 rounded-2xl bg-sky-50 p-3 space-y-2" style={{ border: "1px solid #bae6fd" }}>
                        <div className="text-xs font-bold text-sky-700">🚚 Riwayat Pengiriman ({getDeliveryHistory(o).length}x)</div>
                        {getDeliveryHistory(o).map((delivery, dIdx) => (
                          <div key={dIdx} className="rounded-xl bg-white p-2.5 space-y-1" style={{ border: "1px solid #e0f2fe" }}>
                            <div className="flex items-center justify-between">
                              <div className="text-xs font-bold text-sky-800">
                                📦 {delivery.date || "-"} {delivery.courier || delivery.ekspedisi ? `· ${delivery.courier || delivery.ekspedisi}` : ""}
                              </div>
                              <div className="flex gap-1">
                                <button
                                  onClick={() => {
                                    setEditDeliveryModal({ order: o, deliveryIdx: dIdx });
                                    setEditDeliveryItems((delivery.items || []).map((it) => ({
                                      ...it,
                                      qty: Number(it.qty ?? it.shippedQty ?? 0),
                                    })));
                                  }}
                                  className="text-[10px] font-bold px-2 py-1 rounded-lg"
                                  style={{ background: "#dbeafe", color: "#1d4ed8" }}
                                >
                                  Edit Qty
                                </button>
                                <button
                                  onClick={() => hapusDelivery(o, dIdx)}
                                  className="text-[10px] font-bold px-2 py-1 rounded-lg"
                                  style={{ background: "#fee2e2", color: "#dc2626" }}
                                >
                                  Hapus
                                </button>
                              </div>
                            </div>
                            {(delivery.items || []).map((it, iIdx) => {
                              const base = orderItemForDeliveryItem(o, it, iIdx) || {};
                              const qty = Number(it.qty ?? it.shippedQty ?? 0);
                              const price = moneyValue(it.price ?? base.price ?? 0);
                              return (
                                <div key={iIdx} className="text-xs text-slate-600 flex justify-between gap-3">
                                  <span className="min-w-0 truncate">{base.name || it.name || "Produk"}</span>
                                  <span className="font-semibold text-right shrink-0">{qty.toLocaleString("id-ID")} pcs · {rupiah(qty * price)}</span>
                                </div>
                              );
                            })}
                            {delivery.source === "gallery-produksi" && (
                              <div className="text-[10px] font-bold" style={{ color: "#7c3aed" }}>via Gallery Produksi</div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <Button className="bg-sky-600" onClick={() => setEditData({ type: "orders", ...o })}>Edit</Button>
                    <Button className="bg-rose-600" onClick={() => deleteItem("orders", o.id)}>Hapus</Button>
                  </div>
                </div>
              );
            });
          })()}
        </div>
      )}

      {/* ── PURCHASES TAB ── */}
      {!loading && tab === "purchases" && (
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => setModal("purchase")} style={{ background: "linear-gradient(135deg,#a855f7,#c084fc)" }}>+ Supplier</Button>
            <Button onClick={() => setModal("supplierPay")} style={{ background: "linear-gradient(135deg,#f97316,#fb923c)" }}>+ Bayar Supplier</Button>
          </div>
          <button
            onClick={() => setConfirmResetSupplier(true)}
            className="w-full rounded-2xl border border-rose-300 py-2 text-xs font-bold text-rose-500 bg-rose-50"
          >
            🗑️ Reset Semua Data Supplier (Hapus Purchases + Pembayaran)
          </button>
          {filteredPurchases.length === 0 && <div className="text-center py-10 text-slate-400">Tidak ada data supplier</div>}
          {[...filteredPurchases].sort(sortPurchaseNewestFirst).map((p) => {
            const paid = purchasePaidTotal(p);
            const sisa = hutangPurchase(p);
            return (
              <div key={p.id} className="rounded-3xl bg-white p-5 shadow-sm">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-bold text-lg">{p.supplier}</div>
                    <div className="text-sm text-slate-500">{purchaseMaterialsSummary(p)}</div>
                    {p.createdAt && <div className="text-xs text-slate-400">📅 {p.createdAt}</div>}
                    <div className="mt-2 space-y-1">
                      {normalizePurchaseMaterials(p).slice(0, 4).map((it, i) => (
                        <div key={i} className="text-xs text-slate-500">• {it.name}: {it.qty} {it.unit} · {rupiah(purchaseMaterialTotal(it))}</div>
                      ))}
                      {moneyValue(p.shippingCost || p.ongkir || 0) > 0 && (
                        <div className="text-xs text-slate-500">• Ongkir: {rupiah(p.shippingCost || p.ongkir || 0)}</div>
                      )}
                    </div>
                  </div>
                  <div className="text-right"><div className="font-bold">{rupiah(purchaseInvoiceTotal(p))}</div><div className="text-sm text-rose-500">Sisa tagihan {rupiah(sisa)}</div></div>
                </div>
                {purchasePaymentHistory(p).length > 0 && (
                  <div className="mt-3 rounded-2xl bg-slate-50 p-3 space-y-1">
                    <div className="text-xs font-semibold text-slate-500 mb-2">Riwayat Pembayaran</div>
                    {purchasePaymentHistory(p).map((x, i) => (
                      <div key={i} className="flex justify-between text-sm"><span className="text-slate-500">{x.date} · {cleanSupplierPaymentNote(x.note)}</span><span className="font-semibold text-emerald-600">{rupiah(x.amount)}</span></div>
                    ))}
                    <div className="mt-3 flex justify-between border-t border-slate-200 pt-3 text-sm font-bold">
                      <span className="text-slate-700">Total Pembayaran</span>
                      <span className="text-emerald-600">{rupiah(paid)}</span>
                    </div>
                  </div>
                )}
                <div className="mt-4 flex gap-2">
                  <Button className="bg-sky-600 flex-1" onClick={() => setEditData({ type: "purchases", ...p })}>Edit</Button>
                  <Button className="bg-rose-600 flex-1" onClick={() => deleteItem("purchases", p.id)}>Hapus</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── EXPENSES TAB ── */}
      {!loading && tab === "expenses" && (
        <div className="space-y-4 p-4">
          <Button className="w-full bg-slate-700" onClick={() => setModal("expense")}>+ Tambah Pengeluaran</Button>

          <div className="rounded-3xl bg-white p-5 shadow-sm" style={{ border: "1.5px solid #fecaca" }}>
            <div className="flex justify-between items-center">
              <div>
                <div className="font-bold text-slate-800">Total Pengeluaran</div>
                <div className="text-xs text-slate-400">Biaya operasional + transfer keluar supplier</div>
              </div>
              <div className="text-xl font-bold text-rose-600">{rupiah(totalCombinedExpenses)}</div>
            </div>
          </div>

          {combinedExpenseRows.length === 0 && <div className="text-center py-10 text-slate-400">Tidak ada pengeluaran</div>}
          {combinedExpenseRows.map((row) => (
            <div key={`${row.rowType}-${row.id}`} className="rounded-3xl bg-white p-5 shadow-sm">
              <div className="flex justify-between items-start gap-3">
                <div>
                  <div className="font-bold">{row.title}</div>
                  <div className="text-sm text-slate-500">{row.date}</div>
                  {row.subtitle && <div className="text-sm text-slate-400 mt-1">{row.subtitle}</div>}
                  <div className={`inline-flex mt-2 rounded-full px-2 py-1 text-[10px] font-bold ${row.rowType === "supplier_transfer" ? "bg-rose-50 text-rose-600" : "bg-slate-100 text-slate-500"}`}>
                    {row.rowType === "supplier_transfer" ? "Auto · Transfer Supplier" : "Manual · Biaya Operasional"}
                  </div>
                </div>
                <div className="font-bold text-rose-600 whitespace-nowrap">{rupiah(row.amount)}</div>
              </div>
              {row.rowType === "expense" && (
                <div className="mt-4 flex gap-2">
                  <Button className="bg-sky-600 flex-1" onClick={() => setEditData({ type: "expenses", ...row.raw })}>Edit</Button>
                  <Button className="bg-rose-600 flex-1" onClick={() => deleteItem("expenses", row.id)}>Hapus</Button>
                </div>
              )}
              {row.rowType === "supplier_transfer" && (
                <div className="mt-4 space-y-2">
                  <div className="rounded-2xl bg-rose-50 px-3 py-2 text-xs text-rose-500">
                    Transfer supplier ini bisa diedit. Setelah disimpan, realisasi pembayaran supplier akan ikut diperbarui.
                  </div>
                  <Button className="bg-sky-600 w-full" onClick={() => setEditData({ type: "transfersOut", ...row.raw })}>Edit Transfer Keluar</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── PRODUCTS TAB ── */}
      {!loading && tab === "kasbon" && (() => {
        const kasbonAktif = kasbonList.filter((k) => k.status !== "lunas").sort((a, b) => (b.tanggal || "").localeCompare(a.tanggal || ""));
        const kasbonLunas = kasbonList.filter((k) => k.status === "lunas").sort((a, b) => (b.tanggal || "").localeCompare(a.tanggal || ""));
        const totalAktif = kasbonAktif.reduce((s, k) => s + Number(k.sisaKasbon || 0), 0);
        const totalSemua = kasbonList.reduce((s, k) => s + Number(k.jumlah || 0), 0);
        return (
          <div className="space-y-4 p-4">
            <Button className="w-full" onClick={() => setModal("kasbon")} style={{ background: "linear-gradient(135deg,#f59e0b,#d97706)" }}>
              💰 + Kasbon Baru
            </Button>
            <Button className="w-full" onClick={() => setShowKelolaPekerja(true)} style={{ background: "linear-gradient(135deg,#6366f1,#4f46e5)" }}>
              👷 Kelola Daftar Pekerja ({masterPekerja.length} orang)
            </Button>

            {/* Ringkasan */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-white p-4 shadow-sm" style={{ border: "1.5px solid #fde68a" }}>
                <div className="text-xs font-semibold text-amber-600 mb-1">Sisa Kasbon Aktif</div>
                <div className="text-xl font-black text-amber-700">{rupiah(totalAktif)}</div>
                <div className="text-xs text-slate-400 mt-1">{kasbonAktif.length} pegawai</div>
              </div>
              <div className="rounded-2xl bg-white p-4 shadow-sm" style={{ border: "1.5px solid #d1fae5" }}>
                <div className="text-xs font-semibold text-emerald-600 mb-1">Total Kasbon Diberikan</div>
                <div className="text-xl font-black text-emerald-700">{rupiah(totalSemua)}</div>
                <div className="text-xs text-slate-400 mt-1">{kasbonList.length} total catatan</div>
              </div>
            </div>

            {/* Kasbon Aktif */}
            {kasbonAktif.length > 0 && (
              <div>
                <div className="text-sm font-black text-amber-700 mb-2">⏳ Kasbon Belum Lunas ({kasbonAktif.length})</div>
                <div className="space-y-3">
                  {kasbonAktif.map((k) => (
                    <KasbonCard key={k.id} kasbon={k} onCicilan={tambahCicilanKasbon} onHapus={hapusKasbon} onBatalCicilan={batalCicilanRekap} isSaving={isSaving} />
                  ))}
                </div>
              </div>
            )}

            {/* Kasbon Lunas */}
            {kasbonLunas.length > 0 && (
              <div>
                <div className="text-sm font-black text-emerald-700 mb-2">✅ Sudah Lunas ({kasbonLunas.length})</div>
                <div className="space-y-3">
                  {kasbonLunas.map((k) => (
                    <KasbonCard key={k.id} kasbon={k} onCicilan={tambahCicilanKasbon} onHapus={hapusKasbon} onBatalCicilan={batalCicilanRekap} isSaving={isSaving} lunas />
                  ))}
                </div>
              </div>
            )}

            {kasbonList.length === 0 && (
              <div className="rounded-2xl bg-white p-8 text-center text-slate-400 shadow-sm">
                Belum ada data kasbon
              </div>
            )}
          </div>
        );
      })()}

      {/* ── PRODUCTS TAB (original) ── */}
      {!loading && tab === "products" && (
        <div className="space-y-4 p-4">
          <div className="rounded-3xl bg-white p-5 shadow-sm" style={{ border: "1.5px solid #c4b5fd" }}>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div><div className="text-lg font-bold" style={{ color: "#7c3aed" }}>🏷️ Template Produk</div><div className="text-xs text-slate-400">Setup sekali, pesanan harian tinggal pilih produk.</div></div>
              <Button onClick={() => setModal("product")} className="text-xs" style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>+ Produk</Button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs mb-3">
              <div className="rounded-2xl bg-purple-50 p-3"><div className="text-slate-400">Total Produk</div><div className="text-xl font-bold text-purple-600">{productMasters.length}</div></div>
              <div className="rounded-2xl bg-emerald-50 p-3"><div className="text-slate-400">Aktif</div><div className="text-xl font-bold text-emerald-600">{productMasters.filter(p => p.isActive !== false).length}</div></div>
            </div>
            {/* Tombol Scan Data */}
            <button
              type="button"
              onClick={jalankanScan}
              className="w-full rounded-2xl py-3 text-sm font-bold"
              style={{ background: repairScanned ? "#f0fdf4" : "linear-gradient(135deg,#f97316,#ea580c)", color: repairScanned ? "#166534" : "#fff", border: repairScanned ? "1.5px solid #bbf7d0" : "none" }}
            >
              {repairScanned
                ? `✅ Scan selesai — ${Object.keys(repairIssues).length > 0 ? `${Object.values(repairIssues).reduce((s, a) => s + a.length, 0)} data bermasalah di ${Object.keys(repairIssues).length} produk` : "Semua data bersih"} · Scan ulang`
                : "🔍 Scan Data Produk"}
            </button>
          </div>
          {productQuickFilter === "missing-hpp" && (
            <div className="rounded-2xl bg-pink-50 p-3 text-xs font-bold text-pink-700 flex items-center justify-between gap-2" style={{ border: "1px solid #f9a8d4" }}>
              <span>Menampilkan produk aktif yang belum punya HPP saja.</span>
              <button type="button" onClick={() => setProductQuickFilter("semua")} className="rounded-full bg-white px-3 py-1 text-pink-600">Tampilkan semua</button>
            </div>
          )}
          {filteredProductMasters.length === 0 && <div className="text-center py-10 text-slate-400">Belum ada template produk</div>}
          {filteredProductMasters.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")).map((p) => {
            const hpp = calculateProductHpp(p);
            const margin = moneyValue(p.defaultPrice || 0) - hpp;
            const marginPct = moneyValue(p.defaultPrice || 0) > 0 ? Math.round((margin / moneyValue(p.defaultPrice || 0)) * 100) : 0;
            return (
              <div key={p.id} className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: "1.5px solid #f9a8d4" }}>
                <div className="flex gap-3">
                  <div className="h-16 w-16 rounded-2xl bg-pink-50 flex items-center justify-center overflow-hidden shrink-0">
                    {p.imageUrl ? <img src={p.imageUrl} alt={p.name} className="h-full w-full object-cover" /> : <span className="text-2xl">📦</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between gap-2"><div className="font-bold text-slate-800 truncate">{p.name}</div><span className="rounded-full bg-purple-50 px-2 py-1 text-xs font-bold text-purple-600">{p.category || "Lainnya"}</span></div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                      <div><div className="text-slate-400">Jual</div><div className="font-bold text-pink-600">{rupiah(p.defaultPrice)}</div></div>
                      <div><div className="text-slate-400">HPP</div><div className="font-bold text-orange-600">{rupiah(hpp)}</div></div>
                      <div><div className="text-slate-400">Margin</div><div className={margin >= 0 ? "font-bold text-emerald-600" : "font-bold text-rose-600"}>{marginPct}%</div></div>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  {getIssueCountForProduct(p.id) > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setRepairModal({ productId: p.id, productName: p.name });
                        setRepairPriceEdits({});
                      }}
                      className="w-full rounded-2xl py-2 text-xs font-bold"
                      style={{ background: "#fff7ed", border: "1.5px solid #fed7aa", color: "#ea580c" }}
                    >
                      ⚠️ {getIssueCountForProduct(p.id)} data bermasalah — Perbaiki
                    </button>
                  )}
                </div>
                <div className="mt-2 flex gap-2">
                  <Button className="bg-sky-600 flex-1" onClick={() => {
                    const qty = numberValue(p.materialQtyPerPcs || 0);
                    const bahanCost = moneyValue(p.bahanCost || 0);
                    // Pakai bahanPricePerUnit tersimpan, atau hitung balik dari bahanCost ÷ qty
                    const bahanPricePerUnit = moneyValue(p.bahanPricePerUnit || 0) > 0
                      ? moneyValue(p.bahanPricePerUnit || 0)
                      : (qty > 0 && bahanCost > 0 ? Math.round(bahanCost / qty) : 0);
                    setProductForm({ ...emptyProductForm, ...p, bahanPricePerUnit, hppMaterials: normalizeHppMaterials(p).length > 0 ? normalizeHppMaterials(p) : [emptyHppMaterialLine()] });
                    setModal("product");
                  }}>Edit</Button>
                  <Button className="bg-pink-600 flex-1" onClick={() => setOrderForm(f => ({ ...f, items: [...(f.items || []), { ...emptyOrderItem(), productId: p.id, name: p.name, category: p.category, price: p.defaultPrice, bahanCost: hppMaterialsCost(p) || moneyValue(p.bahanCost || 0), hppPerPcs: hpp, mainMaterial: p.mainMaterial || "", materialQtyPerPcs: p.materialQtyPerPcs || 0, unit: p.unit || "yard", hppMaterials: normalizeHppMaterials(p) }] }))}>Pakai</Button>
                  <Button className="bg-rose-600 flex-1" onClick={() => deleteItem("products", p.id)}>Hapus</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── STOCK TAB ── */}
      {!loading && tab === "stock" && (
        <div className="space-y-4 p-4">
          <div className="rounded-3xl bg-white p-5 shadow-sm" style={{ border: "1.5px solid #fed7aa" }}>
            <div className="text-lg font-bold mb-1" style={{ color: "#ea580c" }}>🧵 Stok Bahan</div>
            {filteredMaterialsStock.length === 0 && <div className="text-center py-6 text-slate-400">Belum ada stok bahan</div>}
            <div className="space-y-3">
              {filteredMaterialsStock.map((m) => {
                const stock = Number(m.stock || 0);
                const minStock = Number(m.minStock || 0);
                const low = minStock > 0 && stock <= minStock;
                const stockInfo = safeMaterialStockInfo(m, purchases);
                const safeAvgCost = stockInfo.avgCost;
                const safeTotalValue = stockInfo.totalValue;
                return (
                  <div key={m.id} className="rounded-2xl p-4" style={{ background: low ? "#fff1f2" : "#f8fafc", border: low ? "1px solid #fecdd3" : "1px solid #e2e8f0" }}>
                    <div className="flex justify-between items-start gap-3">
                      <div><div className="font-bold text-slate-800">{m.name}</div><div className="text-xs text-slate-400">{m.category || "Kain"} · min {Number(m.minStock || 0)} {m.unit || "yard"}</div></div>
                      <div className="text-right"><div className={`text-lg font-bold ${low ? "text-rose-600" : "text-emerald-600"}`}>{stock.toLocaleString("id-ID")} {m.unit || "yard"}</div><div className="text-xs text-slate-400">Modal avg {rupiah(safeAvgCost)}/{m.unit || "yard"}</div></div>
                    </div>
                    <div className="mt-2 flex justify-between text-xs">
                      <span className={low ? "font-bold text-rose-600" : "font-semibold text-emerald-600"}>{low ? "⚠️ Stok menipis" : "✅ Stok aman"}</span>
                      <span className="text-slate-400">Nilai stok {rupiah(safeTotalValue)}{stockInfo.abnormal ? " · diperbaiki dari riwayat pembelian" : ""}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="rounded-3xl bg-white p-5 shadow-sm" style={{ border: "1.5px solid #f9a8d4" }}>
            <div className="text-lg font-bold mb-1" style={{ color: "#ec4899" }}>🧾 Master Produk</div>
            {productMasters.length === 0 && <div className="text-center py-6 text-slate-400">Belum ada master produk</div>}
            <div className="space-y-2">
              {productMasters.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")).map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-2xl bg-pink-50 p-3">
                  <div><div className="font-bold text-sm text-slate-800">{p.name}</div><div className="text-xs text-slate-400">{p.category || "Lainnya"}</div></div>
                  <div className="text-sm font-bold text-pink-600">{rupiah(p.defaultPrice || 0)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Audit lama dipindahkan ke Pusat Kendala Kerudung di Dashboard */}

      {/* ── REKAP TAB ── */}
      {!loading && tab === "rekap" && (() => {
        const s = rekapSummary();
        const customerRows = customerRowsInRekapRange();
        const transferInRowsAll = [...autoTransferInRows].filter((t) => inRekapRange(t.date || ""));
        const transferOutRowsAll = [...autoTransferOutRows].filter((t) => inRekapRange(t.date || ""));
        const transferInNameOptionsInRange = ["semua", ...Array.from(new Set(transferInRowsAll.map((t) => capitalizeWords(t.customer || "")).filter(Boolean))).sort((a, b) => a.localeCompare(b))];
        const transferOutNameOptionsInRange = ["semua", ...Array.from(new Set(transferOutRowsAll.map((t) => capitalizeWords(t.supplier || "")).filter(Boolean))).sort((a, b) => a.localeCompare(b))];
        const transferInRows = filterTransferInName === "semua" ? transferInRowsAll : transferInRowsAll.filter((t) => normalizeName(t.customer) === normalizeName(filterTransferInName));
        const transferOutRows = filterTransferOutName === "semua" ? transferOutRowsAll : transferOutRowsAll.filter((t) => normalizeName(t.supplier) === normalizeName(filterTransferOutName));
        const totalTransferInRows = transferInRows.reduce((sum, t) => sum + moneyValue(t.amount || 0), 0);
        const totalTransferOutRows = transferOutRows.reduce((sum, t) => sum + moneyValue(t.amount || 0), 0);
        return (
          <div className="p-4 space-y-4">

            {/* Pilih Periode */}
            <div className="rounded-3xl p-5 bg-white shadow-sm" style={{ border: "1.5px solid #f9a8d4" }}>
              <div className="text-xl font-bold mb-1" style={{ color: "#ec4899" }}>📊 Rekap</div>
              <div className="text-xs text-slate-400 mb-4">Satu periode untuk PDF, WA, invoice customer, log bayar, dan log transfer keluar.</div>
              <div className="grid grid-cols-2 gap-3">
                <DatePicker label="Dari Tanggal" value={rekapStartDate} onChange={setRekapStartDate} />
                <DatePicker label="Sampai Tanggal" value={rekapEndDate} onChange={setRekapEndDate} />
              </div>
              <div className="mt-3 rounded-2xl bg-pink-50 p-3">
                <div className="text-xs font-bold text-slate-500 mb-2">Dasar periode Ringkasan Bisnis</div>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setRekapDateBasis("order")} className={`rounded-2xl px-3 py-2 text-xs font-bold ${rekapDateBasis === "order" ? "bg-pink-600 text-white" : "bg-white text-slate-500"}`}>Tanggal Order</button>
                  <button type="button" onClick={() => setRekapDateBasis("kirim")} className={`rounded-2xl px-3 py-2 text-xs font-bold ${rekapDateBasis === "kirim" ? "bg-pink-600 text-white" : "bg-white text-slate-500"}`}>Tanggal Kirim/Realisasi</button>
                </div>
                <div className="mt-2 text-[11px] text-slate-500">Default: Tanggal Kirim/Realisasi. Penjualan dan HPP dihitung dari barang yang sudah dikirim.</div>
              </div>
              <div className="mt-4">
                <Button onClick={downloadRekapTanggalPdf} className="w-full" style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>📄 Download PDF</Button>
              </div>
            </div>

            {/* Ringkasan */}
            <div className="rounded-3xl p-5 bg-white shadow-sm" style={{ border: "1.5px solid #c4b5fd" }}>
              <div className="text-lg font-bold mb-3" style={{ color: "#7c3aed" }}>Ringkasan Bisnis</div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-2xl bg-pink-50 p-3"><div className="text-xs text-slate-400">Realisasi Penjualan</div><div className="font-bold text-pink-600">{rupiah(s.realisasi)}</div></div>
                <div className="rounded-2xl bg-emerald-50 p-3"><div className="text-xs text-slate-400">{s.laba < 0 ? "Rugi Bersih" : "Laba Bersih"}</div><div className={`font-bold ${s.laba >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{s.laba < 0 ? "-" : ""}{rupiah(Math.abs(s.laba))}</div></div>
                <div className="rounded-2xl bg-sky-50 p-3"><div className="text-xs text-slate-400">Piutang Customer Saat Ini</div><div className="font-bold text-sky-600">{rupiah(s.piutang)}</div></div>
                <div className="rounded-2xl bg-rose-50 p-3"><div className="text-xs text-slate-400">Tagihan Supplier</div><div className="font-bold text-rose-600">{rupiah(s.hutangSupplier)}</div></div>
                <div className="rounded-2xl bg-violet-50 p-3"><div className="text-xs text-slate-400">HPP Terkirim</div><div className="font-bold text-violet-600">{rupiah(s.hpp)}</div></div>
                <div className="rounded-2xl bg-amber-50 p-3"><div className="text-xs text-slate-400">Gaji Produksi</div><div className="font-bold text-amber-600">{rupiah(s.gajiProduksi)}</div></div>
                <div className="rounded-2xl bg-orange-50 p-3"><div className="text-xs text-slate-400">Pengeluaran Lain</div><div className="font-bold text-orange-600">{rupiah(s.pengeluaran)}</div></div>
              </div>
            </div>

            {/* Invoice Customer */}
            <div className="rounded-3xl p-5 bg-white shadow-sm" style={{ border: "1.5px solid #f9a8d4" }}>
              <div className="text-lg font-bold mb-1" style={{ color: "#ec4899" }}>📄 Invoice Customer</div>
              <div className="text-xs text-slate-500 mb-3">Piutang Belum Lunas memakai saldo aktif saat ini agar sama dengan Dashboard. Filter tanggal tetap untuk daftar invoice lunas/semua.</div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <DatePicker label="Dari Tanggal" value={invoiceStartDate} onChange={setInvoiceStartDate} />
                <DatePicker label="Sampai Tanggal" value={invoiceEndDate} onChange={setInvoiceEndDate} />
              </div>
              <div className="grid grid-cols-3 gap-2 mb-3">
                {[
                  { key: "semua", label: "Semua" },
                  { key: "belum", label: "Belum Lunas" },
                  { key: "lunas", label: "Lunas" },
                ].map((opt) => {
                  const active = invoiceStatusFilter === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setInvoiceStatusFilter(opt.key)}
                      className={`rounded-2xl px-2 py-2 text-xs font-bold border transition ${active ? "text-white" : "text-slate-600 bg-white"}`}
                      style={active ? { background: "linear-gradient(135deg,#ec4899,#f472b6)", borderColor: "#ec4899" } : { borderColor: "#fbcfe8" }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <div className="space-y-2">
                {(() => {
                  const paidForOrder = (o) => orderPaymentHistory(o).reduce((a, p) => a + Number(moneyValue(p.amount || 0) || 0), 0);
                  const invoiceRows = (() => {
                    // Khusus filter Belum Lunas, tampilkan piutang aktif saat ini dari satu sumber
                    // yang sama dengan Dashboard dan Ringkasan Rekap. Tanggal periode tidak dipakai
                    // untuk piutang aktif agar tidak muncul dua nominal berbeda.
                    if (invoiceStatusFilter === "belum") {
                      return [...(uniqueCustomers || [])]
                        .map((c) => customerReceivableTotals(c.name))
                        .filter((row) => Number(row.sisa || 0) > 0)
                        .sort((a, b) => a.name.localeCompare(b.name));
                    }

                    const map = {};
                    const allOrders = orders || [];
                    const orderById = new Map(allOrders.map((o) => [String(o.id || "").trim(), o]));
                    const orderByInvoice = new Map(allOrders.map((o) => [String(o.invoice || "").trim(), o]));
                    const officialCoveredKeys = new Set();

                    const ensureRow = (rawName) => {
                      const name = capitalizeWords(rawName || "");
                      const key = normalizeName(name);
                      if (!key) return null;
                      if (!map[key]) {
                        map[key] = {
                          name,
                          ordersMap: new Map(),
                          paymentOrderKeys: new Set(),
                          totalTagihan: 0,
                          totalBayar: 0,
                          sisa: 0,
                          batchCount: 0,
                        };
                      }
                      return map[key];
                    };

                    const addOrderToRow = (row, order) => {
                      if (!row || !order) return;
                      const key = String(order.id || order.invoice || "").trim();
                      if (key) row.ordersMap.set(key, order);
                      if (key && !row.paymentOrderKeys.has(key)) {
                        row.paymentOrderKeys.add(key);
                        row.totalBayar += paidForOrder(order);
                      }
                    };

                    const findOrdersForBatch = (batch) => {
                      const ids = [
                        ...(Array.isArray(batch.orderIds) ? batch.orderIds : []),
                        ...(Array.isArray(batch.pesananIds) ? batch.pesananIds : []),
                        ...(Array.isArray(batch.invoices) ? batch.invoices : []),
                      ].map((x) => String(x || "").trim()).filter(Boolean);

                      const fromBatchRows = (Array.isArray(batch.orders) ? batch.orders : []).flatMap((row) => {
                        const rowOrderId = String(row.orderId || row.pesananId || "").trim();
                        const rowInvoice = String(row.invoice || "").trim();
                        const found = orderById.get(rowOrderId) || orderByInvoice.get(rowInvoice);
                        return found ? [found] : [];
                      });

                      const fromIds = ids.flatMap((id) => {
                        const found = orderById.get(id) || orderByInvoice.get(id);
                        return found ? [found] : [];
                      });

                      return Array.from(new Map([...fromBatchRows, ...fromIds].map((o) => [o.id || o.invoice, o])).values());
                    };

                    const officialBatchTotal = (batch) => {
                      const batchItems = Array.isArray(batch.items) ? batch.items : [];
                      const rows = Array.isArray(batch.orders) && batch.orders.length > 0 ? batch.orders : [];

                      const totalForItems = (items = [], order = {}) => (items || []).reduce((sum, it, idx) => {
                        const qty = Number(it.shippedQty ?? it.qtyKirim ?? it.qty ?? it.kirim ?? 0);
                        if (qty <= 0) return sum;
                        const base = order?.id || order?.invoice ? (orderItemForDeliveryItem(order, it, idx) || {}) : {};
                        const price = resolveSalePrice(it, base, order || {}, productMasters);
                        return sum + qty * price;
                      }, 0);

                      const calculated = rows.length > 0
                        ? rows.reduce((sum, row, rowIdx) => {
                            const rowOrderId = String(row.orderId || row.pesananId || "").trim();
                            const rowInvoice = String(row.invoice || "").trim();
                            const order = orderById.get(rowOrderId) || orderByInvoice.get(rowInvoice) || {};
                            const rowItems = Array.isArray(row.items) && row.items.length > 0
                              ? row.items
                              : batchItems.filter((it) => {
                                  const itOrderId = String(it.orderId || it.pesananId || "").trim();
                                  const itInvoice = String(it.invoice || "").trim();
                                  return (rowOrderId && itOrderId === rowOrderId) || (rowInvoice && itInvoice === rowInvoice);
                                });
                            return sum + totalForItems(rowItems, order);
                          }, 0)
                        : totalForItems(batchItems, findOrdersForBatch(batch)[0] || {});

                      const ongkir = moneyValue(batch.ongkir ?? batch.shippingCost ?? 0);
                      if (calculated > 0) return calculated + ongkir;
                      return moneyValue(batch.totalTagihanBatch ?? batch.totalTagihan ?? batch.totalBatch ?? batch.total ?? 0) + ongkir;
                    };

                    // Prioritas utama: nota gabungan resmi dari App Produksi.
                    // Tanpa bagian ini, halaman Invoice Customer bisa kosong pada periode yang
                    // sebenarnya punya shipment_batches, karena daftar customer sebelumnya hanya
                    // membaca orders.deliveries.
                    (shipmentBatches || []).forEach((batch) => {
                      const dateKey = invoiceDateKeyFromValue(batch.tanggalKirim || batch.date || batch.createdAt || batch.shippedAt || batch.deliveredAt || "");
                      if (!isDateKeyInRange(dateKey, invoiceStartDate, invoiceEndDate)) return;

                      const relatedOrders = findOrdersForBatch(batch);
                      const batchCustomer = capitalizeWords(batch.customerName || batch.customer || batch.receiver || batch.penerima || relatedOrders[0]?.customer || "");
                      const row = ensureRow(batchCustomer);
                      if (!row) return;

                      const total = officialBatchTotal(batch);
                      if (total <= 0) return;

                      row.totalTagihan += total;
                      row.batchCount += Math.max(1, relatedOrders.length);
                      relatedOrders.forEach((order) => addOrderToRow(row, order));

                      const groupKey = batch.groupId || batch.noteNumber || batch.id || "";
                      relatedOrders.forEach((order) => {
                        const orderKey = order.id || order.invoice || "";
                        if (orderKey && groupKey) officialCoveredKeys.add(`${orderKey}|${groupKey}|${dateKey || ""}`);
                      });
                    });

                    // Fallback data lama: deliveries yang tersimpan di masing-masing order.
                    allOrders.forEach((o) => {
                      const name = capitalizeWords(o.customer || "");
                      const row = ensureRow(name);
                      if (!row) return;

                      const batches = getOrderInvoiceBatches(o)
                        .filter((batch) => isDateKeyInRange(batch.dateKey, invoiceStartDate, invoiceEndDate))
                        .filter((batch) => {
                          const groupKey = batch.delivery?.groupId || batch.delivery?.noteNumber || "";
                          const orderKey = o.id || o.invoice || batch.id;
                          const dateKey = batch.dateKey || "";
                          if (!groupKey) {
                            // Delivery tanpa groupId: cek apakah official batch sudah cover
                            const coveredByOfficial = Array.from(officialCoveredKeys).some(
                              (k) => k.startsWith(`${orderKey}|`) && k.endsWith(`|${dateKey}`)
                            );
                            return !coveredByOfficial;
                          }
                          return !officialCoveredKeys.has(`${orderKey}|${groupKey}|${dateKey}`);
                        });

                      const invoiceTotal = batches.reduce((sum, batch) => sum + Number(batch.total || 0), 0);
                      if (invoiceTotal <= 0) return;

                      row.totalTagihan += invoiceTotal;
                      row.batchCount += 1;
                      addOrderToRow(row, o);
                    });

                    return Object.values(map)
                      .map((row) => {
                        const ordersList = Array.from(row.ordersMap.values());
                        const current = customerReceivableTotals(row.name);
                        return {
                          ...row,
                          orders: current.orders.length > 0 ? current.orders : ordersList,
                          orderCount: current.orderCount || Math.max(ordersList.length, row.batchCount || 0),
                          totalTagihan: current.totalTagihan,
                          totalBayar: current.totalBayar,
                          sisa: current.sisa,
                        };
                      })
                      .filter((row) => {
                        if (Number(row.totalTagihan || 0) <= 0) return false;
                        if (invoiceStatusFilter === "belum") return row.sisa > 0;
                        if (invoiceStatusFilter === "lunas") return row.sisa <= 0 && Number(row.totalTagihan || 0) > 0;
                        return true;
                      })
                      .sort((a, b) => a.name.localeCompare(b.name));
                  })();
                  const emptyText = invoiceStatusFilter === "belum"
                    ? "Tidak ada customer belum lunas pada periode ini"
                    : invoiceStatusFilter === "lunas"
                      ? "Tidak ada customer lunas pada periode ini"
                      : "Tidak ada customer pada periode ini";
                  return invoiceRows.length === 0
                    ? <div className="text-center py-4 text-slate-400">{emptyText}</div>
                    : invoiceRows.map((c) => {
                      const isLunas = c.sisa <= 0;
                      return (
                        <div key={c.name} className="flex items-center justify-between rounded-2xl p-3" style={{ background: isLunas ? "#f0fdf4" : "#fdf2f8", border: `1px solid ${isLunas ? "#bbf7d0" : "#fce7f3"}` }}>
                          <div className="pr-3">
                            <div className="font-bold text-sm text-slate-800">{c.name}</div>
                            <div className="text-xs text-slate-500">{c.orderCount || c.orders.length} pesanan</div>
                            <div className="mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-black" style={{ background: isLunas ? "#dcfce7" : "#fee2e2", color: isLunas ? "#047857" : "#be123c" }}>
                              {isLunas ? "LUNAS" : "BELUM LUNAS"}
                            </div>
                          </div>
                          <button
                            onClick={() => { setInvoiceCustomer(c.name); setInvoiceCustomerSisa(c.sisa); }}
                            className="rounded-xl px-3 py-2 text-xs font-bold text-white shrink-0"
                            style={{ background: isLunas ? "linear-gradient(135deg,#64748b,#475569)" : "linear-gradient(135deg,#25d366,#128c7e)" }}
                          >
                            {isLunas ? "Lihat" : "WA"}
                          </button>
                        </div>
                      );
                    });
                })()}
              </div>
            </div>

            {/* Log Pembayaran Customer */}
            <div className="rounded-3xl p-5 bg-white shadow-sm" style={{ border: "1.5px solid #a5f3fc" }}>
              <div className="text-lg font-bold mb-1" style={{ color: "#0891b2" }}>💙 Log Pembayaran Customer</div>
              <div className="text-xs text-slate-400 mb-3">Mengikuti periode tanggal di atas.</div>
              <div className="mb-3 grid grid-cols-1 gap-2">
                <Select label="Filter Customer" value={filterTransferInName} onChange={setFilterTransferInName}>
                  {transferInNameOptionsInRange.map((name) => <option key={name} value={name}>{name === "semua" ? "Semua Customer" : name}</option>)}
                </Select>
                <div className="rounded-2xl bg-cyan-50 p-3 text-sm font-bold text-cyan-700">Total tampil: {rupiah(totalTransferInRows)}</div>
              </div>
              <div className="space-y-2 max-h-80 overflow-auto">
                {transferInRows.length === 0 && <div className="text-center py-4 text-slate-400">Tidak ada pembayaran customer</div>}
                {transferInRows.sort(sortOldestBottom).map((t) => (
                  <div key={t.id} className="rounded-2xl p-3 flex justify-between items-center" style={{ background: "#ecfeff", border: "1px solid #a5f3fc" }}>
                    <div>
                      <div className="font-bold text-sm text-slate-800">{t.customer}</div>
                      <div className="text-xs text-slate-500">📅 {t.date} · {t.bank}</div>
                      {t.note && <div className="text-xs text-slate-400">{t.note}</div>}
                    </div>
                    <div className="font-bold text-cyan-600">{rupiah(t.amount)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Log Transfer Keluar */}
            <div className="rounded-3xl p-5 bg-white shadow-sm" style={{ border: "1.5px solid #fecaca" }}>
              <div className="text-lg font-bold mb-1" style={{ color: "#dc2626" }}>🔴 Log Transfer Keluar</div>
              <div className="text-xs text-slate-400 mb-3">Tetap sesuai input manual transfer keluar, mengikuti periode tanggal.</div>
              <div className="mb-3 grid grid-cols-1 gap-2">
                <Select label="Filter Supplier" value={filterTransferOutName} onChange={setFilterTransferOutName}>
                  {transferOutNameOptionsInRange.map((name) => <option key={name} value={name}>{name === "semua" ? "Semua Supplier" : name}</option>)}
                </Select>
                <div className="rounded-2xl bg-rose-50 p-3 text-sm font-bold text-rose-700">Total tampil: {rupiah(totalTransferOutRows)}</div>
              </div>
              <div className="space-y-2 max-h-80 overflow-auto">
                {transferOutRows.length === 0 && <div className="text-center py-4 text-slate-400">Tidak ada transfer keluar</div>}
                {transferOutRows.sort(sortOldestBottom).map((t) => (
                  <div key={t.id} className="rounded-2xl p-3 flex justify-between items-center" style={{ background: "#fff1f2", border: "1px solid #fecaca" }}>
                    <div>
                      <div className="font-bold text-sm text-slate-800">{t.supplier}</div>
                      <div className="text-xs text-slate-500">📅 {t.date} · {t.bank}</div>
                      {t.note && <div className="text-xs text-slate-400">{t.note}</div>}
                    </div>
                    <div className="font-bold text-rose-600">{rupiah(t.amount)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Backup tetap ada, tapi tidak memenuhi layar */}
            <div className="rounded-3xl p-5 bg-white shadow-sm" style={{ border: "1.5px solid #e2e8f0" }}>
              <div className="text-lg font-bold mb-3 text-slate-700">🛡️ Backup Data</div>
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={exportBackupJson} className="w-full text-xs" style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>Backup JSON</Button>
                <Button onClick={exportBackupTsv} className="w-full text-xs" style={{ background: "linear-gradient(135deg,#059669,#10b981)" }}>Backup Excel</Button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ════ MODALS ════ */}

      {dashboardDetail && <DashboardDetailModal />}
      {issueCenterOpen && <IssueCenterModal />}

      {/* Modal Transfer Keluar */}
      {modal === "transferOut" && (
        <SimpleModal title="Catat Transfer Keluar" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div className="rounded-2xl bg-rose-50 p-3 text-xs text-rose-700">
              🔴 Catatan transfer keluar bebas — tidak otomatis dikurangi dari tagihan supplier. Hanya sebagai bukti kas keluar real per tanggal.
            </div>
            <DatePicker label="Tanggal Transfer" value={transferOutForm.date} onChange={(v) => setTransferOutForm(f => ({ ...f, date: v }))} />
            <div className="space-y-1">
              <label className="text-xs font-bold" style={{ color: "#dc2626" }}>Nama Supplier / Penerima</label>
              <input list="supplier-list-transfer-out" value={transferOutForm.supplier}
                onChange={(e) => setTransferOutForm(f => ({ ...f, supplier: e.target.value }))}
                placeholder="Ketik nama penerima..."
                className="w-full px-4 py-3 outline-none text-sm"
                style={{ borderRadius: 14, border: "1.5px solid #fecaca", background: "#fff1f2", color: "#7f1d1d" }} />
              <datalist id="supplier-list-transfer-out">
                {uniqueSuppliers.map(s => <option key={s.name} value={s.name} />)}
              </datalist>
            </div>
            <Input label="Bank / Metode Transfer" value={transferOutForm.bank} onChange={(v) => setTransferOutForm(f => ({ ...f, bank: v }))} placeholder="Contoh: BRI, BCA, DANA, GoPay, Tunai" />
            <Input label="Keterangan (opsional)" value={transferOutForm.note} onChange={(v) => setTransferOutForm(f => ({ ...f, note: v }))} placeholder="Contoh: Bayar kain ceruty" />
            <Input label="Nominal Transfer" type="money" value={transferOutForm.amount} onChange={(v) => setTransferOutForm(f => ({ ...f, amount: v }))} />
            <Button onClick={addTransferOut} className="w-full" style={{ background: "linear-gradient(135deg,#dc2626,#ef4444)" }}>🔴 Simpan Transfer Keluar</Button>
          </div>
        </SimpleModal>
      )}

      {/* Modal Transfer Masuk */}
      {modal === "transfer" && (
        <SimpleModal title="Catat Transfer Masuk" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div className="rounded-2xl bg-cyan-50 p-3 text-xs text-cyan-700">
              💙 Catatan transfer bebas — dicatat sebagai bukti kas masuk real per tanggal.
            </div>
            <DatePicker label="Tanggal Transfer" value={transferForm.date} onChange={(v) => setTransferForm(f => ({ ...f, date: v }))} />
            <div className="space-y-1">
              <label className="text-xs font-bold" style={{ color: "#0891b2" }}>Nama Customer / Pengirim</label>
              <input list="customer-list-transfer" value={transferForm.customer}
                onChange={(e) => setTransferForm(f => ({ ...f, customer: e.target.value }))}
                placeholder="Ketik nama pengirim..."
                className="w-full px-4 py-3 outline-none text-sm"
                style={{ borderRadius: 14, border: "1.5px solid #a5f3fc", background: "#ecfeff", color: "#164e63" }} />
              <datalist id="customer-list-transfer">
                {uniqueCustomers.map(c => <option key={c.name} value={c.name} />)}
              </datalist>
            </div>
            <Input label="Bank / Metode Transfer" value={transferForm.bank} onChange={(v) => setTransferForm(f => ({ ...f, bank: v }))} placeholder="Contoh: BRI, BCA, DANA, GoPay, Tunai" />
            <Input label="Keterangan (opsional)" value={transferForm.note} onChange={(v) => setTransferForm(f => ({ ...f, note: v }))} placeholder="Contoh: Pelunasan pesanan mukena" />
            <Input label="Nominal Transfer" type="money" value={transferForm.amount} onChange={(v) => setTransferForm(f => ({ ...f, amount: v }))} />
            <Button onClick={addTransfer} className="w-full" style={{ background: "linear-gradient(135deg,#0891b2,#06b6d4)" }}>💙 Simpan Transfer</Button>
          </div>
        </SimpleModal>
      )}

      {modal === "product" && (
        <SimpleModal title="Template Produk" onClose={() => { setModal(null); setProductForm(emptyProductForm); }}>
          <div className="space-y-3">
            <div className="space-y-2">
              <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Foto Produk (opsional)</label>
              <div className="rounded-2xl p-3" style={{ background: "#fdf2f8", border: "1.5px solid #f9a8d4" }}>
                <div className="flex items-center gap-3">
                  <div className="h-20 w-20 rounded-2xl bg-white overflow-hidden flex items-center justify-center border border-pink-100 shrink-0">
                    {productForm.imageUrl ? <img src={productForm.imageUrl} alt="preview" className="h-full w-full object-cover" /> : <span className="text-3xl">📷</span>}
                  </div>
                  <div className="flex-1 space-y-2">
                    <label className="block w-full cursor-pointer rounded-2xl px-4 py-3 text-center text-sm font-bold text-white" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
                      Upload Foto
                      <input type="file" accept="image/*" className="hidden" onChange={(e) => handleProductImageUpload(e.target.files?.[0])} />
                    </label>
                    {productForm.imageUrl && (<button type="button" onClick={() => setProductForm(f => ({ ...f, imageUrl: "" }))} className="w-full rounded-2xl bg-white px-4 py-2 text-xs font-bold text-rose-500 border border-rose-100">Hapus Foto</button>)}
                  </div>
                </div>
              </div>
            </div>
            <Input label="Nama Produk *" value={productForm.name} onChange={(v) => setProductForm(f => ({ ...f, name: v }))} placeholder="Contoh: Mukena Rayon Premium" />
            <div className="space-y-1">
              <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Kategori *</label>
              <input list="product-category-list-modal" value={productForm.category} onChange={(e) => setProductForm(f => ({ ...f, category: e.target.value }))} placeholder="Kerudung / Mukena / Baju Anak" className="w-full px-4 py-3 outline-none text-sm" style={{ borderRadius: 14, border: "1.5px solid #f9a8d4", background: "#fdf2f8", color: "#2d1b69" }} />
              <datalist id="product-category-list-modal">{productCategoryOptions.map(name => <option key={name} value={name} />)}</datalist>
            </div>
            <Input label="Harga Jual *" type="money" value={productForm.defaultPrice} onChange={(v) => setProductForm(f => ({ ...f, defaultPrice: v }))} />
            <div className="rounded-2xl p-3 space-y-2" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="font-bold text-slate-700">HPP Produk (opsional)</div>
                  <div className="text-[11px] text-slate-500">Bisa lebih dari 1 bahan, misalnya setelan: baju bahan A dan celana bahan B.</div>
                </div>
                <button type="button" onClick={() => setProductForm(f => ({ ...f, hppMaterials: [...(Array.isArray(f.hppMaterials) ? f.hppMaterials : []), emptyHppMaterialLine()] }))} className="rounded-xl bg-purple-100 px-3 py-2 text-xs font-bold text-purple-700">+ Bahan</button>
              </div>
              {(Array.isArray(productForm.hppMaterials) && productForm.hppMaterials.length > 0 ? productForm.hppMaterials : [emptyHppMaterialLine()]).map((mat, idx) => {
                const unit = mat.unit || "yard";
                const usage = numberValue(mat.usagePerPcs || 0);
                const pricePerUnit = moneyValue(mat.pricePerUnit || 0);
                const subtotal = usage > 0 && pricePerUnit > 0 ? Math.round(usage * pricePerUnit) : moneyValue(mat.total || 0);
                const updateMaterial = (patch) => setProductForm(f => {
                  const rows = Array.isArray(f.hppMaterials) && f.hppMaterials.length > 0 ? [...f.hppMaterials] : [emptyHppMaterialLine()];
                  rows[idx] = { ...rows[idx], ...patch };
                  return { ...f, hppMaterials: rows };
                });
                return (
                  <div key={idx} className="rounded-2xl bg-white p-3 space-y-2 border border-slate-200">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-bold text-slate-600">Bahan #{idx + 1}</div>
                      {idx > 0 && <button type="button" onClick={() => setProductForm(f => ({ ...f, hppMaterials: (f.hppMaterials || []).filter((_, i) => i !== idx) }))} className="text-xs font-bold text-rose-500">Hapus</button>}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="Bagian" value={mat.part || ""} onChange={(v) => updateMaterial({ part: v })} placeholder="Baju / Celana" />
                      <Input label="Nama Bahan" value={mat.name || ""} onChange={(v) => updateMaterial({ name: v })} placeholder="Bahan A" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="Kebutuhan / pcs" type="number" value={mat.usagePerPcs || ""} onChange={(v) => updateMaterial({ usagePerPcs: v, total: Math.round(numberValue(v || 0) * pricePerUnit) })} />
                      <Select label="Satuan" value={unit} onChange={(v) => updateMaterial({ unit: v })}><option value="yard">yard</option><option value="kg">kg</option></Select>
                    </div>
                    <Input label={`Harga Bahan / ${unit}`} type="money" value={mat.pricePerUnit || 0} onChange={(v) => updateMaterial({ pricePerUnit: v, total: Math.round(usage * moneyValue(v || 0)) })} placeholder={`Harga per ${unit}`} />
                    {(usage > 0 || pricePerUnit > 0) && (
                      <div className="flex justify-between rounded-xl px-3 py-2 text-xs" style={{ background: "#f5f3ff" }}>
                        <span className="text-slate-500">Subtotal bahan / pcs</span>
                        <span className="font-bold text-purple-600">{rupiah(pricePerUnit)} × {usage} {unit} = <strong>{rupiah(subtotal)}</strong></span>
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="flex justify-between rounded-xl px-3 py-2 text-xs" style={{ background: "#ecfeff" }}>
                <span className="text-slate-500">Total semua bahan / pcs</span>
                <span className="font-bold text-cyan-700">{rupiah(hppMaterialsCost(productForm))}</span>
              </div>
              <Input label="Produksi" type="money" value={productForm.productionCost} onChange={(v) => setProductForm(f => ({ ...f, productionCost: v }))} />
              <Input label="Distribusi" type="money" value={productForm.distributionCost} onChange={(v) => setProductForm(f => ({ ...f, distributionCost: v }))} />
              <Input label="Lain-lain" type="money" value={productForm.otherCost} onChange={(v) => setProductForm(f => ({ ...f, otherCost: v }))} />
            </div>
            <div className="rounded-2xl bg-emerald-50 p-4 flex justify-between items-center">
              <div><div className="text-xs text-slate-500">HPP otomatis</div><div className="text-xl font-bold text-emerald-600">{rupiah(calculateProductHpp(productForm))}</div></div>
              <div className="text-right"><div className="text-xs text-slate-500">Estimasi margin</div><div className="text-lg font-bold text-pink-600">{rupiah(moneyValue(productForm.defaultPrice || 0) - calculateProductHpp(productForm))}</div></div>
            </div>
            <Button onClick={saveProductTemplate} className="w-full" style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>Simpan Template Produk</Button>
          </div>
        </SimpleModal>
      )}

      {modal === "order" && (
        <SimpleModal title="Tambah Pesanan" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <DatePicker label="Tanggal Pesanan" value={orderForm.date} onChange={(v) => setOrderForm(f => ({ ...f, date: v }))} />
            <div className="space-y-1">
              <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Nama Customer</label>
              <input list="customer-list" value={orderForm.customer} onChange={(e) => setOrderForm(f => ({ ...f, customer: e.target.value }))} placeholder="Ketik atau pilih nama customer..." className="w-full px-4 py-3 outline-none text-sm" style={{ borderRadius: 14, border: "1.5px solid #f9a8d4", background: "#fdf2f8", color: "#2d1b69" }} />
              <datalist id="customer-list">{uniqueCustomers.map(c => <option key={c.name} value={c.name} />)}</datalist>
            </div>
            <Input label="No HP Customer (opsional)" type="number" value={orderForm.phone} onChange={(v) => setOrderForm(f => ({ ...f, phone: v }))} placeholder="08xxxxxxxxxx" />
            {topCustomers.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-bold" style={{ color: "#a855f7" }}>Customer favorit</div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {topCustomers.map((c) => (<button key={c.name} type="button" onClick={() => setOrderForm(f => ({ ...f, customer: c.name }))} className="shrink-0 rounded-full bg-white px-3 py-2 text-xs font-bold shadow-sm" style={{ color: "#7c3aed", border: "1px solid #ddd6fe" }}>{c.name}</button>))}
                </div>
              </div>
            )}
            <div className="flex gap-2"><button type="button" onClick={resetOrderDraft} className="w-full rounded-2xl bg-slate-100 py-2 text-xs font-bold text-slate-500">Reset draft</button></div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Produk Pesanan</label>
                <button type="button" onClick={() => setOrderForm(f => ({ ...f, items: [...(f.items || []), emptyOrderItem()] }))} className="rounded-xl px-3 py-2 text-xs font-bold text-white" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>+ Tambah Produk</button>
              </div>
              {(orderForm.items || []).map((it, idx) => (
                <div key={idx} className="rounded-2xl p-3 space-y-2" style={{ background: "#fdf2f8", border: "1.5px solid #f9a8d4" }}>
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold" style={{ color: "#ec4899" }}>Produk #{idx + 1}</div>
                    {(orderForm.items || []).length > 1 && (<button type="button" onClick={() => setOrderForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }))} className="rounded-xl px-3 py-1 text-xs font-bold text-rose-600 bg-rose-50">Hapus</button>)}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Nama Produk</label>
                    <input list="product-master-list" value={it.name}
                      onChange={(e) => { const v = e.target.value; const master = findProductMaster(v); setOrderForm(f => ({ ...f, items: f.items.map((x, i) => i === idx ? { ...x, name: v, productId: master?.id || x.productId || "", category: master?.category || x.category || "", price: master?.defaultPrice !== undefined ? moneyValue(master.defaultPrice || 0) : x.price, bahanCost: master ? (hppMaterialsCost(master) || moneyValue(master.bahanCost || 0)) : moneyValue(x.bahanCost || 0), hppPerPcs: master ? calculateProductHpp(master) : moneyValue(x.hppPerPcs || 0), mainMaterial: master?.mainMaterial || x.mainMaterial || "", materialQtyPerPcs: master?.materialQtyPerPcs || x.materialQtyPerPcs || 0, unit: master?.unit || x.unit || "yard", hppMaterials: master ? normalizeHppMaterials(master) : normalizeHppMaterials(x) } : x) })); }}
                      placeholder="Contoh: Mukena Rayon Anak" className="w-full px-4 py-3 outline-none text-sm" style={{ borderRadius: 14, border: "1.5px solid #f9a8d4", background: "#fdf2f8", color: "#2d1b69" }} />
                    <datalist id="product-master-list">{productMasters.map(p => <option key={p.id} value={p.name} />)}</datalist>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Kategori</label>
                    <input list="product-category-list" value={it.category || ""} onChange={(e) => setOrderForm(f => ({ ...f, items: f.items.map((x, i) => i === idx ? { ...x, category: e.target.value } : x) }))} placeholder="Kerudung / Mukena / Baju Anak" className="w-full px-4 py-3 outline-none text-sm" style={{ borderRadius: 14, border: "1.5px solid #f9a8d4", background: "#fdf2f8", color: "#2d1b69" }} />
                    <datalist id="product-category-list">{productCategoryOptions.map(name => <option key={name} value={name} />)}</datalist>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Input label="Jumlah pcs" type="number" value={it.qty} onChange={(v) => setOrderForm(f => ({ ...f, items: f.items.map((x, i) => i === idx ? { ...x, qty: v } : x) }))} />
                    <Input label="Harga/pcs" type="money" value={it.price} onChange={(v) => setOrderForm(f => ({ ...f, items: f.items.map((x, i) => i === idx ? { ...x, price: v } : x) }))} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex justify-between rounded-xl bg-white px-3 py-2 text-sm"><span className="text-slate-500">Subtotal</span><span className="font-bold" style={{ color: "#be185d" }}>{rupiah(Number(it.qty || 0) * moneyValue(it.price || 0))}</span></div>
                    <div className="flex justify-between rounded-xl bg-white px-3 py-2 text-sm"><span className="text-slate-500">Est. Laba</span><span className="font-bold text-emerald-600">{rupiah((moneyValue(it.price || 0) - moneyValue(it.hppPerPcs || 0)) * Number(it.qty || 0))}</span></div>
                  </div>
                </div>
              ))}
            </div>
            <Input label="Ongkir (opsional)" type="money" value={orderForm.shippingCost} onChange={(v) => setOrderForm(f => ({ ...f, shippingCost: v }))} />
            <div className="w-full px-4 py-3 text-sm font-bold rounded-2xl space-y-1" style={{ border: "1.5px solid #f9a8d4", background: "#fce7f3", color: "#be185d" }}>
              <div className="flex justify-between"><span>Subtotal</span><span>{rupiah(orderItemsTotal(orderForm.items))}</span></div>
              <div className="flex justify-between"><span>Ongkir</span><span>{rupiah(orderForm.shippingCost)}</span></div>
              <div className="flex justify-between border-t border-pink-200 pt-1"><span>Total</span><span>{rupiah(orderGrandTotal(orderForm.items, orderForm.shippingCost))}</span></div>
            </div>
            <Input label="DP Awal (opsional)" type="money" value={orderForm.dp} onChange={(v) => setOrderForm(f => ({ ...f, dp: v }))} />
            <Button onClick={addOrder} className="w-full bg-pink-600">Simpan Pesanan</Button>
          </div>
        </SimpleModal>
      )}

      {modal === "purchase" && (
        <SimpleModal title="Tambah Supplier" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <DatePicker label="Tanggal Belanja" value={purchaseForm.date} onChange={(v) => setPurchaseForm(f => ({ ...f, date: v }))} />
            <Input label="Nama Supplier" value={purchaseForm.supplier} onChange={(v) => setPurchaseForm(f => ({ ...f, supplier: v }))} />
            <div className="rounded-2xl p-3 space-y-3" style={{ background: "#fff7ed", border: "1.5px solid #fed7aa" }}>
              <div className="flex items-center justify-between">
                <div className="font-bold text-sm" style={{ color: "#ea580c" }}>🧵 Item Bahan</div>
                <button type="button" onClick={() => setPurchaseForm(f => ({ ...f, materials: [...(f.materials || []), emptyPurchaseMaterial()] }))} className="rounded-xl px-3 py-2 text-xs font-bold text-white" style={{ background: "linear-gradient(135deg,#f97316,#fb923c)" }}>+ Tambah Bahan</button>
              </div>
              {(purchaseForm.materials || []).map((it, idx) => (
                <div key={idx} className="rounded-2xl bg-white p-3 space-y-2" style={{ border: "1px solid #fed7aa" }}>
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-bold text-orange-600">Bahan #{idx + 1}</div>
                    {(purchaseForm.materials || []).length > 1 && (<button type="button" onClick={() => setPurchaseForm(f => ({ ...f, materials: f.materials.filter((_, i) => i !== idx) }))} className="text-xs font-bold text-rose-500">Hapus</button>)}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Nama Bahan</label>
                    <input list="material-master-list" value={it.name} onChange={(e) => setPurchaseForm(f => ({ ...f, materials: f.materials.map((x, i) => i === idx ? { ...x, name: e.target.value } : x) }))} placeholder="Contoh: Ceruty Babydoll" className="w-full px-4 py-3 outline-none text-sm" style={{ borderRadius: 14, border: "1.5px solid #f9a8d4", background: "#fdf2f8", color: "#2d1b69" }} />
                    <datalist id="material-master-list">{materialsStock.map(m => <option key={m.id} value={m.name} />)}</datalist>
                  </div>
                  <Input label="Kategori" value={it.category} onChange={(v) => setPurchaseForm(f => ({ ...f, materials: f.materials.map((x, i) => i === idx ? { ...x, category: v } : x) }))} placeholder="Kain, Karet, Aksesoris" />
                  <div className="grid grid-cols-2 gap-2">
                    <Input label="Qty" type="number" value={it.qty} onChange={(v) => setPurchaseForm(f => ({ ...f, materials: f.materials.map((x, i) => i === idx ? { ...x, qty: v } : x) }))} />
                    <Select label="Satuan" value={it.unit || "yard"} onChange={(v) => setPurchaseForm(f => ({ ...f, materials: f.materials.map((x, i) => i === idx ? { ...x, unit: v } : x) }))}><option value="yard">yard</option><option value="kg">kg</option></Select>
                  </div>
                  <Input label={`Harga per ${it.unit || "yard"}`} type="money" value={it.pricePerUnit || 0} onChange={(v) => setPurchaseForm(f => ({ ...f, materials: f.materials.map((x, i) => i === idx ? { ...x, pricePerUnit: v, total: numberValue(x.qty || 0) * moneyValue(v || 0) } : x) }))} />
                  <div className="flex justify-between rounded-xl bg-orange-50 px-3 py-2 text-sm"><span className="text-slate-500">Total Harga Bahan</span><span className="font-bold text-orange-600">{rupiah(numberValue(it.qty || 0) * moneyValue(it.pricePerUnit || 0))}</span></div>
                </div>
              ))}
            </div>
            <div className="w-full px-4 py-3 text-sm font-bold rounded-2xl" style={{ border: "1.5px solid #fed7aa", background: "#fff7ed", color: "#ea580c" }}>Subtotal Bahan: {rupiah(purchaseMaterialsTotal(purchaseForm.materials))}</div>
            <Input label="Ongkir Supplier (opsional)" type="money" value={purchaseForm.shippingCost || 0} onChange={(v) => setPurchaseForm(f => ({ ...f, shippingCost: v }))} />
            <div className="w-full px-4 py-3 text-sm font-bold rounded-2xl" style={{ border: "1.5px solid #fed7aa", background: "#fff7ed", color: "#ea580c" }}>Total Tagihan Supplier: {rupiah(purchaseMaterialsTotal(purchaseForm.materials) + moneyValue(purchaseForm.shippingCost || 0))}</div>
            <Input label="DP Supplier (opsional)" type="money" value={purchaseForm.dp} onChange={(v) => setPurchaseForm(f => ({ ...f, dp: v }))} />
            <Button onClick={addPurchase} className="w-full bg-yellow-500">Simpan Supplier & Update Stok</Button>
          </div>
        </SimpleModal>
      )}

      {modal === "expense" && (
        <SimpleModal title="Tambah Pengeluaran" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <DatePicker label="Tanggal" value={expenseForm.date} onChange={(v) => setExpenseForm(f => ({ ...f, date: v }))} />
            <Input label="Kategori" value={expenseForm.category} onChange={(v) => setExpenseForm(f => ({ ...f, category: v }))} placeholder="Contoh: Ongkir, Listrik" />
            <Input label="Keterangan" value={expenseForm.note} onChange={(v) => setExpenseForm(f => ({ ...f, note: v }))} />
            <Input label="Nominal" type="money" value={expenseForm.amount} onChange={(v) => setExpenseForm(f => ({ ...f, amount: v }))} />
            <Button onClick={addExpense} className="w-full bg-slate-700">Simpan Pengeluaran</Button>
          </div>
        </SimpleModal>
      )}

      {modal === "kasbon" && (
        <SimpleModal title="💰 Kasbon Pegawai" onClose={() => { setKasbonForm({ employeeName: "", tanggal: "", jumlah: "", keterangan: "" }); setModal(null); }}>
          <div className="space-y-3">
            <div className="rounded-2xl p-3 text-xs font-semibold" style={{ background: "#fefce8", border: "1px solid #fde68a", color: "#92400e" }}>
              💡 Kasbon otomatis tercatat sebagai pengeluaran Gallery Kerudung dan bisa dipotong dari gaji di Gallery Produksi.
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold" style={{ color: "#d97706" }}>Nama Pegawai</label>
              <input
                list="kasbon-worker-list"
                value={kasbonForm.employeeName}
                onChange={(e) => setKasbonForm(f => ({ ...f, employeeName: e.target.value }))}
                placeholder="Ketik nama pekerja borongan"
                className="w-full px-4 py-3 outline-none text-sm rounded-2xl"
                style={{ border: "1.5px solid #fde68a", background: "#fffbeb", color: "#2d1b69" }}
              />
              <datalist id="kasbon-worker-list">
                {[...new Set([
                  ...masterPekerja.map(p => p.nama).filter(Boolean),
                  ...payrollExpenses.filter(p => p.employeeName).map(p => p.employeeName),
                ])].sort().map(n => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </div>
            <DatePicker label="Tanggal Kasbon" value={kasbonForm.tanggal || todayStr()} onChange={(v) => setKasbonForm(f => ({ ...f, tanggal: v }))} />
            <Input label="Jumlah Kasbon" type="money" value={kasbonForm.jumlah} onChange={(v) => setKasbonForm(f => ({ ...f, jumlah: v }))} />
            <Input label="Keterangan (opsional)" value={kasbonForm.keterangan} onChange={(v) => setKasbonForm(f => ({ ...f, keterangan: v }))} placeholder="Contoh: Keperluan lebaran" />
            {moneyValue(kasbonForm.jumlah || 0) > 0 && (
              <div className="rounded-2xl px-4 py-3 text-sm font-bold" style={{ background: "#fef3c7", color: "#92400e" }}>
                Akan dicatat sebagai pengeluaran: <span style={{ color: "#d97706" }}>{rupiah(moneyValue(kasbonForm.jumlah || 0))}</span>
              </div>
            )}
            <Button onClick={addKasbon} className="w-full" style={{ background: "linear-gradient(135deg,#f59e0b,#d97706)" }}>
              Simpan Kasbon
            </Button>
          </div>
        </SimpleModal>
      )}

      {modal === "pay" && (
        <SimpleModal title="Catat Bayar Customer" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div className="rounded-2xl bg-cyan-50 p-3 text-xs text-cyan-700">
              💙 Transfer masuk dicatat sebagai realisasi pembayaran customer per tanggal.
            </div>
            <DatePicker label="Tanggal Bayar" value={orderPayForm.date} onChange={(v) => setOrderPayForm(f => ({ ...f, date: v }))} />
            <div className="space-y-1">
              <label className="text-xs font-bold" style={{ color: "#0891b2" }}>Nama Customer / Pengirim</label>
              <input list="customer-list-pay" value={orderPayForm.customer}
                onChange={(e) => setOrderPayForm(f => ({ ...f, customer: e.target.value }))}
                placeholder="Ketik nama customer/pengirim..."
                className="w-full px-4 py-3 outline-none text-sm"
                style={{ borderRadius: 14, border: "1.5px solid #a5f3fc", background: "#ecfeff", color: "#164e63" }} />
              <datalist id="customer-list-pay">
                {uniqueCustomers.map(c => <option key={c.name} value={c.name} />)}
              </datalist>
            </div>
            <Input label="Bank / Metode Transfer" value={orderPayForm.bank} onChange={(v) => setOrderPayForm(f => ({ ...f, bank: v }))} placeholder="Contoh: BRI, BCA, DANA, GoPay, Tunai" />
            <Input label="Keterangan (opsional)" value={orderPayForm.note} onChange={(v) => setOrderPayForm(f => ({ ...f, note: v }))} placeholder="Contoh: DP, pelunasan, catatan transfer" />
            <Input label="Nominal Pembayaran" type="money" value={orderPayForm.amount} onChange={(v) => setOrderPayForm(f => ({ ...f, amount: v }))} />
            <Button onClick={addOrderPayment} className="w-full" style={{ background: "linear-gradient(135deg,#10b981,#34d399)" }}>💚 Simpan Transfer Masuk</Button>
          </div>
        </SimpleModal>
      )}

      {modal === "supplierPay" && (
        <SimpleModal title="Bayar Supplier" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <Select label="Pilih Supplier" value={supplierPayForm.supplier} onChange={(v) => setSupplierPayForm(f => ({ ...f, supplier: v }))}>
              <option value="">-- Pilih Supplier --</option>
              {uniqueSuppliers.filter(s => s.belanjaAktif > 0).map((s) => (<option key={s.name} value={s.name}>{s.name} — {s.belanjaAktif} belanja, sisa {rupiah(s.totalSisa)}</option>))}
            </Select>
            {supplierPayForm.supplier && (() => {
              const list = purchases.filter(p => normalizeName(p.supplier) === normalizeName(supplierPayForm.supplier) && sisaPurchase(p) > 0).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
              return list.length > 0 ? (
                <div className="rounded-2xl p-3 space-y-1" style={{ background: "#fff7ed", border: "1px solid #fed7aa" }}>
                  <div className="text-xs font-bold mb-2" style={{ color: "#f97316" }}>📋 Ringkasan tagihan supplier aktif:</div>
                  {list.map((p, i) => (<div key={p.id} className="flex justify-between gap-2 text-xs"><span style={{ color: "#64748b" }}>{i + 1}. {p.createdAt || "-"} · {purchaseMaterialsSummary(p)}</span><span className="font-semibold" style={{ color: "#e11d48" }}>sisa {rupiah(sisaPurchase(p))}</span></div>))}
                </div>
              ) : null;
            })()}
            <DatePicker label="Tanggal Bayar" value={supplierPayForm.date} onChange={(v) => setSupplierPayForm(f => ({ ...f, date: v }))} />
            <Input label="Keterangan" value={supplierPayForm.note} onChange={(v) => setSupplierPayForm(f => ({ ...f, note: v }))} placeholder="Contoh: Transfer supplier" />
            <Input label="Nominal Pembayaran" type="money" value={supplierPayForm.amount} onChange={(v) => setSupplierPayForm(f => ({ ...f, amount: v }))} />
            <Button onClick={addSupplierPayment} className="w-full" style={{ background: "linear-gradient(135deg,#f97316,#fb923c)" }}>🧡 Simpan Pembayaran Supplier</Button>
          </div>
        </SimpleModal>
      )}

      {/* Invoice per Customer Modal */}
      {invoiceCustomer && <InvoiceModal
        key={`${invoiceCustomer}-${invoiceStartDate}-${invoiceEndDate}-${invoiceStatusFilter}`}
        customerName={invoiceCustomer}
        orders={orders}
        shipmentBatches={shipmentBatches}
        transfers={transfers}
        getOrderPayments={orderPaymentHistory}
        getOrderTagihan={orderPaymentTarget}
        startDate={invoiceStartDate}
        endDate={invoiceEndDate}
        statusFilter={invoiceStatusFilter}
        periodLabel={invoiceStartDate || invoiceEndDate ? `${invoiceStartDate || "awal"} s/d ${invoiceEndDate || "akhir"}` : (invoiceStatusFilter === "belum" ? "Belum Lunas" : invoiceStatusFilter === "lunas" ? "Lunas" : "Semua")}
        onClose={() => { setInvoiceCustomer(null); setInvoiceCustomerSisa(null); }}
        productMasters={productMasters}
        overrideTotalTagihan={customerReceivableTotals(invoiceCustomer).totalTagihan}
        overrideTotalBayar={customerReceivableTotals(invoiceCustomer).totalBayar}
        overrideTotalSisa={customerReceivableTotals(invoiceCustomer).sisa}
      />}

      {/* Modal Edit */}
      {editData && (
        <SimpleModal title="Edit Data" onClose={() => setEditData(null)}>
          <div className="space-y-3">
            {editData.type === "orders" && <>
              <DatePicker label="Tanggal Pesanan" value={editData.createdAt || ""} onChange={(v) => setEditData(d => ({ ...d, createdAt: v }))} />
              <Input label="Nama Customer" value={editData.customer || ""} onChange={(v) => setEditData(d => ({ ...d, customer: v }))} />
              <Input label="No HP Customer" type="number" value={editData.phone || ""} onChange={(v) => setEditData(d => ({ ...d, phone: v }))} />
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Produk Pesanan</label>
                <button type="button" onClick={() => setEditData(d => ({ ...d, items: [...normalizeOrderItems(d), emptyOrderItem()] }))} className="rounded-xl px-3 py-2 text-xs font-bold text-white" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>+ Tambah</button>
              </div>
              {normalizeOrderItems(editData).map((it, idx) => (
                <div key={idx} className="rounded-2xl p-3 space-y-2" style={{ background: "#fdf2f8", border: "1.5px solid #f9a8d4" }}>
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold" style={{ color: "#ec4899" }}>Produk #{idx + 1}</div>
                    {normalizeOrderItems(editData).length > 1 && (<button type="button" onClick={() => setEditData(d => ({ ...d, items: normalizeOrderItems(d).filter((_, i) => i !== idx) }))} className="rounded-xl px-3 py-1 text-xs font-bold text-rose-600 bg-rose-50">Hapus</button>)}
                  </div>
                  <Input label="Nama Produk" value={it.name} onChange={(v) => setEditData(d => ({ ...d, items: normalizeOrderItems(d).map((x, i) => i === idx ? { ...x, name: v } : x) }))} />
                  <div className="grid grid-cols-2 gap-2">
                    <Input label="Jumlah pcs" type="number" value={it.qty} onChange={(v) => setEditData(d => ({ ...d, items: normalizeOrderItems(d).map((x, i) => i === idx ? { ...x, qty: v } : x) }))} />
                    <Input label="Harga/pcs" type="money" value={it.price} onChange={(v) => setEditData(d => ({ ...d, items: normalizeOrderItems(d).map((x, i) => i === idx ? { ...x, price: v } : x) }))} />
                  </div>
                </div>
              ))}
              <Input label="Ongkir" type="money" value={editData.shippingCost || editData.ongkir || 0} onChange={(v) => setEditData(d => ({ ...d, shippingCost: v, ongkir: v }))} />
              <div className="flex gap-2">
                {["Proses", "Selesai", "Lunas"].map((s) => (<button key={s} onClick={() => setEditData(d => ({ ...d, status: s }))} className={`rounded-full px-4 py-2 text-sm font-semibold border transition-all ${editData.status === s ? "bg-pink-600 text-white border-pink-600" : "bg-white text-slate-500 border-slate-200"}`}>{s}</button>))}
              </div>
            </>}
            {editData.type === "purchases" && <>
              <DatePicker label="Tanggal Belanja" value={editData.createdAt || ""} onChange={(v) => setEditData(d => ({ ...d, createdAt: v }))} />
              <Input label="Nama Supplier" value={editData.supplier || ""} onChange={(v) => setEditData(d => ({ ...d, supplier: v }))} />
              <div className="rounded-2xl bg-amber-50 p-3 text-xs text-amber-700">
                Kalau data lama sudah terhapus, klik Pulihkan Histori Pembayaran untuk menempelkan transfer keluar lama ke data supplier baru tanpa membuat kas keluar dobel.
              </div>
              {normalizePurchaseMaterials(editData).map((it, idx) => (
                <div key={idx} className="rounded-2xl p-3 space-y-2" style={{ background: "#fff7ed", border: "1.5px solid #fed7aa" }}>
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold text-orange-600">Bahan #{idx + 1}</div>
                    {normalizePurchaseMaterials(editData).length > 1 && (
                      <button type="button" onClick={() => setEditData(d => ({ ...d, materials: normalizePurchaseMaterials(d).filter((_, i) => i !== idx) }))} className="rounded-xl bg-rose-100 px-3 py-1 text-xs font-bold text-rose-600">Hapus</button>
                    )}
                  </div>
                  <Input label="Bahan" value={it.name || ""} onChange={(v) => setEditData(d => ({ ...d, materials: normalizePurchaseMaterials(d).map((x, i) => i === idx ? { ...x, name: v } : x) }))} />
                  <div className="grid grid-cols-2 gap-2">
                    <Input label="Qty" type="number" value={it.qty || ""} onChange={(v) => setEditData(d => ({ ...d, materials: normalizePurchaseMaterials(d).map((x, i) => i === idx ? { ...x, qty: v, total: numberValue(v || 0) * moneyValue(x.pricePerUnit || 0) } : x) }))} />
                    <Select label="Satuan" value={it.unit || "yard"} onChange={(v) => setEditData(d => ({ ...d, materials: normalizePurchaseMaterials(d).map((x, i) => i === idx ? { ...x, unit: v } : x) }))}><option value="yard">yard</option><option value="kg">kg</option></Select>
                  </div>
                  <Input label={`Harga per ${it.unit || "yard"}`} type="money" value={it.pricePerUnit || 0} onChange={(v) => setEditData(d => ({ ...d, materials: normalizePurchaseMaterials(d).map((x, i) => i === idx ? { ...x, pricePerUnit: v, total: numberValue(x.qty || 0) * moneyValue(v || 0) } : x) }))} />
                  <div className="flex justify-between rounded-xl bg-orange-50 px-3 py-2 text-sm"><span className="text-slate-500">Total Harga Bahan</span><span className="font-bold text-orange-600">{rupiah(numberValue(it.qty || 0) * moneyValue(it.pricePerUnit || 0))}</span></div>
                </div>
              ))}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Button type="button" onClick={() => setEditData(d => ({ ...d, materials: [...normalizePurchaseMaterials(d), emptyPurchaseMaterial()] }))} className="w-full" style={{ background: "linear-gradient(135deg,#f97316,#fb923c)" }}>+ Tambah Bahan</Button>
                <Button type="button" onClick={() => pulihkanHistoriPembayaranSupplier(editData.id)} className="w-full" style={{ background: "linear-gradient(135deg,#10b981,#059669)" }}>Pulihkan Histori Pembayaran</Button>
              </div>
            </>}
            {editData.type === "expenses" && <>
              <DatePicker label="Tanggal" value={editData.date || ""} onChange={(v) => setEditData(d => ({ ...d, date: v }))} />
              <Input label="Kategori" value={editData.category || ""} onChange={(v) => setEditData(d => ({ ...d, category: v }))} />
              <Input label="Keterangan" value={editData.note || ""} onChange={(v) => setEditData(d => ({ ...d, note: v }))} />
              <Input label="Nominal" type="money" value={editData.amount || 0} onChange={(v) => setEditData(d => ({ ...d, amount: v }))} />
            </>}
            {editData.type === "transfers" && <>
              <div className="rounded-2xl bg-cyan-50 p-3 text-xs text-cyan-700">
                Jika nominal/nama customer diubah, realisasi pembayaran customer akan ikut diperbarui.
              </div>
              <DatePicker label="Tanggal Transfer" value={editData.date || ""} onChange={(v) => setEditData(d => ({ ...d, date: v }))} />
              <Input label="Nama Customer / Pengirim" value={editData.customer || ""} onChange={(v) => setEditData(d => ({ ...d, customer: v }))} />
              <Input label="Bank / Metode" value={editData.bank || ""} onChange={(v) => setEditData(d => ({ ...d, bank: v }))} />
              <Input label="Keterangan" value={editData.note || ""} onChange={(v) => setEditData(d => ({ ...d, note: v }))} />
              <Input label="Nominal" type="money" value={editData.amount || 0} onChange={(v) => setEditData(d => ({ ...d, amount: v }))} />
            </>}
            {editData.type === "transfersOut" && <>
              <div className="rounded-2xl bg-rose-50 p-3 text-xs text-rose-700">
                Jika nominal/nama supplier diubah, realisasi pembayaran supplier akan ikut diperbarui.
              </div>
              <DatePicker label="Tanggal Transfer" value={editData.date || ""} onChange={(v) => setEditData(d => ({ ...d, date: v }))} />
              <Input label="Nama Supplier / Penerima" value={editData.supplier || ""} onChange={(v) => setEditData(d => ({ ...d, supplier: v }))} />
              <Input label="Bank / Metode" value={editData.bank || ""} onChange={(v) => setEditData(d => ({ ...d, bank: v }))} />
              <Input label="Keterangan" value={editData.note || ""} onChange={(v) => setEditData(d => ({ ...d, note: v }))} />
              <Input label="Nominal" type="money" value={editData.amount || 0} onChange={(v) => setEditData(d => ({ ...d, amount: v }))} />
            </>}
            <Button onClick={saveEdit} className="w-full bg-sky-600">Simpan Perubahan</Button>
          </div>
        </SimpleModal>
      )}

      {/* Modal Tandai Dikirim */}
      {kirimModal && (() => {
        const order = orders.find((o) => o.id === kirimModal);
        const totalPesanan = order ? moneyValue(order.total || 0) : 0;
        const totalSebelumKirim = order ? orderPaymentTarget(order) : 0;
        const totalKirimHariIni = deliveryItemsTotal(kirimItems.map((it) => ({ qty: it.shippedQty, price: it.price })));
        const totalSetelahKirim = totalSebelumKirim + totalKirimHariIni;
        const selisihNominal = totalSetelahKirim - totalPesanan;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <div className="w-full max-w-md max-h-[92vh] overflow-auto rounded-3xl bg-white p-6 shadow-xl">
              <div className="text-xl font-bold text-slate-800 mb-1">✏️ Koreksi Pengiriman</div>
              <div className="text-slate-500 text-sm mb-4">Gunakan ini hanya untuk mengoreksi kesalahan input dari Gallery Produksi.</div>
              <DatePicker label="Tanggal Kirim" value={tanggalKirim} onChange={(v) => setTanggalKirim(v)} />
              <div className="mt-4 space-y-3">
                {kirimItems.map((it, idx) => {
                  const totalAkanTerkirim = Number(it.alreadyShipped || 0) + Number(it.shippedQty || 0);
                  const selisih = totalAkanTerkirim - Number(it.orderedQty || 0);
                  const subtotal = Number(it.shippedQty || 0) * moneyValue(it.price || 0);
                  return (
                    <div key={idx} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                      <div className="font-bold text-sm text-slate-800">{it.name}</div>
                      <div className="text-xs text-slate-400 mb-2">Pesanan {it.orderedQty} pcs · Sudah terkirim {it.alreadyShipped || 0} pcs · Sisa {it.remainingQty || 0} pcs</div>
                      <Input label="Qty Dikirim Hari Ini" type="number" value={it.shippedQty} onChange={(v) => setKirimItems(items => items.map((x, i) => i === idx ? { ...x, shippedQty: v, note: shipmentAutoNote(x.orderedQty, v) } : x))} />
                      <div className="mt-2 flex justify-between text-xs">
                        <span className={selisih < 0 ? "font-bold text-rose-600" : selisih > 0 ? "font-semibold text-emerald-600" : "font-semibold text-slate-500"}>{selisih < 0 ? `Kurang kirim ${Math.abs(selisih)} pcs` : selisih > 0 ? `Lebih kirim ${selisih} pcs` : "Sesuai"}</span>
                        <span className="font-bold text-purple-600">Subtotal {rupiah(subtotal)}</span>
                      </div>
                      <div className={`mt-2 rounded-xl px-3 py-2 text-xs font-semibold ${selisih < 0 ? "bg-rose-50 text-rose-600" : selisih > 0 ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}>
                        📝 {shipmentAutoNote(it.orderedQty, totalAkanTerkirim)}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 rounded-2xl bg-pink-50 p-4 space-y-2">
                <div className="flex justify-between text-sm"><span className="text-slate-500">Nilai kirim hari ini</span><span className="font-semibold text-sky-600">{rupiah(totalKirimHariIni)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-500">Tagihan setelah kirim</span><span className="font-bold text-pink-600">{rupiah(totalSetelahKirim)}</span></div>
                <div className="flex justify-between text-sm border-t pt-2"><span className="font-semibold">Status nilai kirim</span><span className={selisihNominal < 0 ? "font-bold text-rose-600" : selisihNominal > 0 ? "font-bold text-emerald-600" : "font-bold text-slate-500"}>{selisihNominal === 0 ? "Sesuai" : rupiah(selisihNominal)}</span></div>
              </div>
              <div className="flex gap-3 mt-5">
                <button onClick={() => { setKirimModal(null); setKirimItems([]); }} className="flex-1 rounded-2xl border border-slate-200 py-3 font-semibold text-slate-600">Batal</button>
                <button onClick={tandaiDikirim} className="flex-1 rounded-2xl bg-sky-600 py-3 font-semibold text-white">Simpan</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Konfirmasi Reset Supplier - Step 1 */}
      {confirmResetSupplier && !confirmResetSupplier2 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl">
            <div className="text-xl font-bold text-rose-700 mb-2">⚠️ Reset Data Supplier?</div>
            <div className="text-slate-600 mb-3 text-sm leading-relaxed">
              Ini akan menghapus <strong>semua nota purchase</strong> dan <strong>semua riwayat pembayaran supplier</strong> (transfersOut) secara permanen.
            </div>
            <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 mb-5 text-sm text-amber-800">
              ✅ Stok bahan <strong>tidak akan diubah</strong>.<br />
              ❌ Data yang dihapus <strong>tidak bisa dikembalikan</strong>.
            </div>
            <div className="flex gap-3">
              <button onClick={() => setConfirmResetSupplier(false)} className="flex-1 rounded-2xl border border-slate-200 py-3 font-semibold text-slate-600">Batal</button>
              <button onClick={() => { setConfirmResetSupplier(false); setConfirmResetSupplier2(true); }} className="flex-1 rounded-2xl bg-rose-600 py-3 font-semibold text-white">Lanjut →</button>
            </div>
          </div>
        </div>
      )}

      {/* Konfirmasi Reset Supplier - Step 2 (Double Confirm) */}
      {confirmResetSupplier2 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl">
            <div className="text-xl font-bold text-rose-700 mb-2">🔴 Konfirmasi Terakhir</div>
            <div className="text-slate-600 mb-2 text-sm">
              Kamu yakin ingin menghapus <strong>{purchases.length} nota</strong> dan <strong>{transfersOut.length} pembayaran</strong>?
            </div>
            <div className="text-slate-500 mb-5 text-xs">Aksi ini tidak bisa dibatalkan.</div>
            <div className="flex gap-3">
              <button onClick={() => setConfirmResetSupplier2(false)} className="flex-1 rounded-2xl border border-slate-200 py-3 font-semibold text-slate-600">Batal</button>
              <button onClick={resetSemuaSupplier} className="flex-1 rounded-2xl bg-rose-700 py-3 font-semibold text-white">Ya, Hapus Semua</button>
            </div>
          </div>
        </div>
      )}

      {/* Konfirmasi Hapus */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl">
            <div className="text-xl font-bold text-slate-800 mb-2">Hapus Data?</div>
            <div className="text-slate-500 mb-6">Data yang dihapus tidak bisa dikembalikan.</div>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(null)} className="flex-1 rounded-2xl border border-slate-200 py-3 font-semibold text-slate-600">Batal</button>
              <button onClick={confirmDeleteAction} className="flex-1 rounded-2xl bg-rose-600 py-3 font-semibold text-white">Hapus</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Kelola Daftar Pekerja */}
      {showKelolaPekerja && (
        <SimpleModal title="👷 Daftar Pekerja Konveksi" onClose={() => { setShowKelolaPekerja(false); setNamaPekerjaInput(""); }}>
          <div className="space-y-3">
            <div className="rounded-2xl p-3 text-xs font-semibold" style={{ background: "#eef2ff", border: "1px solid #c7d2fe", color: "#3730a3" }}>
              💡 Nama pekerja di sini akan muncul sebagai pilihan saat input kasbon. Bisa langsung ketik nama baru di field kasbon jika tidak ada di daftar.
            </div>
            {/* Form tambah pekerja baru */}
            <div className="flex gap-2">
              <input
                value={namaPekerjaInput}
                onChange={(e) => setNamaPekerjaInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && tambahMasterPekerja(namaPekerjaInput)}
                placeholder="Nama pekerja baru..."
                className="flex-1 px-4 py-3 outline-none text-sm rounded-2xl"
                style={{ border: "1.5px solid #c7d2fe", background: "#eef2ff", color: "#2d1b69" }}
              />
              <button
                onClick={() => tambahMasterPekerja(namaPekerjaInput)}
                disabled={isSaving}
                className="px-4 py-3 rounded-2xl font-bold text-white text-sm"
                style={{ background: "linear-gradient(135deg,#6366f1,#4f46e5)" }}
              >+ Tambah</button>
            </div>
            {/* Daftar pekerja */}
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {masterPekerja.length === 0 && (
                <div className="text-center text-slate-400 py-6 text-sm">Belum ada pekerja. Tambahkan di atas.</div>
              )}
              {[...masterPekerja].sort((a, b) => (a.nama || "").localeCompare(b.nama || "")).map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-2xl px-4 py-3"
                  style={{ background: "#f8fafc", border: "1.5px solid #e2e8f0" }}>
                  <span className="font-semibold text-slate-700 text-sm">👤 {p.nama}</span>
                  <button
                    onClick={() => hapusMasterPekerja(p.id, p.nama)}
                    className="text-rose-500 font-bold text-xs px-3 py-1 rounded-xl"
                    style={{ background: "#fff1f2", border: "1px solid #fecdd3" }}
                  >Hapus</button>
                </div>
              ))}
            </div>
          </div>
        </SimpleModal>
      )}

      {/* Modal Repair Data Produk */}
      {repairModal && (() => {
        const issues = repairIssues[repairModal.productId] || [];
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <div className="w-full max-w-lg max-h-[92vh] overflow-auto rounded-3xl bg-white p-6 shadow-xl">
              <div className="text-xl font-bold text-orange-700 mb-1">🔧 Repair Data: {repairModal.productName}</div>
              <div className="text-slate-500 text-xs mb-4">
                Nama dikoreksi otomatis ke master. Harga delivery disamakan dengan harga saat pesanan dibuat.
              </div>

              {issues.length === 0 && (
                <div className="text-center py-8 text-emerald-600 font-bold">✅ Tidak ada data bermasalah.</div>
              )}

              <div className="space-y-3">
                {issues.map((issue, idx) => (
                  <div key={idx} className="rounded-2xl p-3 space-y-2" style={{ background: "#fff7ed", border: "1.5px solid #fed7aa" }}>
                    <div className="flex justify-between text-xs text-slate-500">
                      <span className="font-bold text-slate-700">{issue.customer}</span>
                      <span>{issue.date}</span>
                    </div>
                    <div className="text-xs space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-rose-500 line-through">{issue.oldName}</span>
                        <span className="text-slate-400">→</span>
                        <span className="text-emerald-600 font-bold">{issue.newName}</span>
                      </div>
                      {issue.source === "delivery" && issue.orderItemPrice > 0 && issue.orderItemPrice !== issue.oldPrice ? (
                        <div className="flex items-center gap-2">
                          <span className="text-slate-400">Harga:</span>
                          <span className="text-rose-500 line-through">{rupiah(issue.oldPrice)}</span>
                          <span className="text-slate-400">→</span>
                          <span className="font-semibold text-emerald-600">{rupiah(issue.orderItemPrice)}</span>
                          <span className="text-slate-400 text-[10px]">(dari pesanan)</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="text-slate-400">Harga tetap:</span>
                          <span className="font-semibold text-slate-700">{rupiah(issue.oldPrice)}</span>
                        </div>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">
                      Qty: {issue.shippedQty} pcs · Sumber: {issue.source === "delivery" ? "data pengiriman" : "data pesanan"}
                    </div>
                  </div>
                ))}
              </div>

              {issues.length > 0 && (
                <div className="mt-4 rounded-2xl bg-orange-50 p-3 text-xs text-orange-700 space-y-1">
                  <div className="font-bold">⚠️ Perhatian:</div>
                  <div>• Nama dikoreksi otomatis ke master</div>
                  <div>• Harga delivery disamakan dengan harga pesanan awal</div>
                  <div>• Aksi ini tidak bisa dibatalkan</div>
                </div>
              )}

              <div className="flex gap-3 mt-5">
                <button
                  onClick={() => { setRepairModal(null); setRepairPriceEdits({}); }}
                  className="flex-1 rounded-2xl border border-slate-200 py-3 font-semibold text-slate-600"
                >Batal</button>
                {issues.length > 0 && (
                  <button
                    onClick={() => runRepairForProduct(repairModal.productId)}
                    className="flex-1 rounded-2xl py-3 font-semibold text-white"
                    style={{ background: "linear-gradient(135deg,#ea580c,#f97316)" }}
                  >🔧 Perbaiki {issues.length} Data</button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal Repair Qty Pengiriman */}
      {repairQtyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-lg max-h-[92vh] overflow-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="text-xl font-bold text-indigo-700 mb-1">🔧 Repair Qty Pengiriman</div>
            <div className="text-slate-500 text-xs mb-4">
              Ditemukan {repairQtyIssues.length} pengiriman dengan qty tidak sesuai data Gallery Produksi. Klik Perbaiki untuk mengoreksi otomatis.
            </div>

            {repairQtyIssues.length === 0 && (
              <div className="text-center py-8 text-emerald-600 font-bold">✅ Semua qty pengiriman sudah benar.</div>
            )}

            <div className="space-y-3">
              {repairQtyIssues.map((issue, idx) => (
                <div key={idx} className="rounded-2xl p-3 space-y-2" style={{ background: "#eef2ff", border: "1.5px solid #c7d2fe" }}>
                  <div className="flex justify-between text-xs">
                    <span className="font-bold text-slate-800">{issue.customer}</span>
                    <span className="text-slate-500">{issue.date}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="font-bold text-rose-600 mb-1">Data lama (salah)</div>
                      {issue.currentItems.map((it, i) => (
                        <div key={i} className="text-slate-600">{it.name}: <span className="font-bold text-rose-500">{it.qty} pcs</span></div>
                      ))}
                    </div>
                    <div>
                      <div className="font-bold text-emerald-600 mb-1">Koreksi (dari GP)</div>
                      {issue.correctItems.map((it, i) => (
                        <div key={i} className="text-slate-600">{it.name}: <span className="font-bold text-emerald-600">{it.qty} pcs</span></div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {repairQtyIssues.length > 0 && (
              <div className="mt-4 rounded-2xl bg-indigo-50 p-3 text-xs text-indigo-700">
                <div className="font-bold mb-1">⚠️ Perhatian:</div>
                <div>• Qty delivery akan dikoreksi sesuai data Gallery Produksi</div>
                <div>• Aksi ini tidak bisa dibatalkan</div>
              </div>
            )}

            <div className="flex gap-3 mt-5">
              <button
                onClick={() => { setRepairQtyModal(false); setRepairQtyIssues([]); }}
                className="flex-1 rounded-2xl border border-slate-200 py-3 font-semibold text-slate-600"
              >Batal</button>
              {repairQtyIssues.length > 0 && (
                <button
                  onClick={runRepairQtyPengiriman}
                  className="flex-1 rounded-2xl py-3 font-semibold text-white"
                  style={{ background: "linear-gradient(135deg,#6366f1,#4f46e5)" }}
                >🔧 Perbaiki {repairQtyIssues.length} Delivery</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal Edit Qty Pengiriman */}
      {editDeliveryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md max-h-[92vh] overflow-auto rounded-3xl bg-white p-6 shadow-xl">
            <div className="text-xl font-bold text-blue-700 mb-1">✏️ Koreksi Qty Pengiriman</div>
            <div className="text-slate-500 text-xs mb-4">
              {editDeliveryModal.order?.customer} · {(editDeliveryModal.order?.raw?.deliveries || editDeliveryModal.order?.deliveries || [])[editDeliveryModal.deliveryIdx]?.date || "-"}
            </div>
            <div className="space-y-3">
              {editDeliveryItems.map((it, idx) => (
                <div key={idx} className="rounded-2xl p-3 space-y-2" style={{ background: "#eff6ff", border: "1.5px solid #bfdbfe" }}>
                  <div className="text-sm font-bold text-slate-800">{it.name || "Produk"}</div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-blue-700">Qty (pcs)</label>
                    <input
                      type="number"
                      inputMode="numeric"
                      value={it.qty || ""}
                      onChange={(e) => {
                        const val = Math.max(0, Number(e.target.value) || 0);
                        setEditDeliveryItems(prev => prev.map((x, i) => i === idx ? { ...x, qty: val } : x));
                      }}
                      className="w-full px-3 py-2 rounded-xl text-sm outline-none"
                      style={{ border: "1.5px solid #bfdbfe", background: "#fff" }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-2xl bg-blue-50 p-3 text-xs text-blue-700">
              ⚠️ Perubahan ini akan langsung tersimpan ke Firestore dan mempengaruhi invoice customer.
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => { setEditDeliveryModal(null); setEditDeliveryItems([]); }}
                className="flex-1 rounded-2xl border border-slate-200 py-3 font-semibold text-slate-600"
              >Batal</button>
              <button
                onClick={saveEditDelivery}
                className="flex-1 rounded-2xl py-3 font-semibold text-white"
                style={{ background: "linear-gradient(135deg,#1d4ed8,#3b82f6)" }}
              >✅ Simpan Koreksi</button>
            </div>
          </div>
        </div>
      )}

      {/* Loading overlay */}
      {isSaving && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="rounded-2xl bg-white px-8 py-5 shadow-xl flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-pink-600 border-t-transparent rounded-full animate-spin" />
            <span className="font-semibold text-slate-700">Menyimpan...</span>
          </div>
        </div>
      )}
    </div>
  );
}
