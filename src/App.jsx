import SimpleModal from "./components/SimpleModal";
import StatusBadge from "./components/StatusBadge";
import Card from "./components/Card";
import Input from "./components/Input";
import Button from "./components/Button";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { db } from "./firebase";
import {
  collection, addDoc, onSnapshot, updateDoc, deleteDoc, doc,
} from "firebase/firestore";
import "./App.css";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "firebase/auth";

const auth = getAuth();
const provider = new GoogleAuthProvider();
const ALLOWED_EMAILS = ["angx89@gmail.com", "astriapriani.aa@gmail.com"];

// Update inventory/master data dari diskusi:
// 1) Produk yang diketik saat input pesanan otomatis menjadi Master Produk.
// 1a) Kategori produk bisa dipilih/ditik baru dan otomatis menjadi Master Kategori Produk.
// 2) Belanja supplier bisa berisi banyak bahan dalam 1 transaksi.
// 3) Satuan bahan dibatasi yard dan kg supaya stok tidak tercampur.
// 4) Setiap bahan belanja supplier otomatis masuk/update Master Bahan.
// 5) Stok bahan bertambah otomatis dan harga modal rata-rata dihitung otomatis.

// ─── Helpers ────────────────────────────────────────────────────────────────

function rupiah(num) {
  return `Rp ${Number(num || 0).toLocaleString("id-ID")}`;
}

function parseMoney(value) {
  return Number(String(value).replace(/\D/g, "")) || 0;
}

function moneyValue(value) {
  return parseMoney(value);
}

function numberValue(value) {
  return Number(String(value ?? "").replace(/,/g, ".")) || 0;
}

function todayStr() {
  // Pakai tanggal lokal browser (bukan UTC) supaya tidak mundur/maju hari di Indonesia.
  return new Date().toLocaleDateString("sv-SE");
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
  return (name || "").trim().toLowerCase();
}

function capitalizeWords(name) {
  return (name || "").trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function generateInvoice() {
  const ts = Date.now().toString().slice(-5);
  const rand = Math.floor(Math.random() * 100).toString().padStart(2, "0");
  return `ORD-${ts}${rand}`;
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
  };
}


function emptyPurchaseMaterial() {
  return { name: "", category: "Kain", qty: "", unit: "yard", total: 0 };
}

function normalizePurchaseMaterials(purchase) {
  const raw = Array.isArray(purchase?.materials) && purchase.materials.length > 0
    ? purchase.materials
    : [{
        name: purchase?.material || "Bahan Baku",
        category: purchase?.category || "Kain",
        qty: Number(String(purchase?.qty || "0").replace(/[^0-9.]/g, "")) || 0,
        unit: String(purchase?.qty || "").toLowerCase().includes("kg") ? "kg" : "yard",
        total: moneyValue(purchase?.total || 0),
      }];

  return raw.map((it) => {
    const qty = Number(it.qty || 0);
    const total = moneyValue(it.total || 0);
    return {
      name: it.name || it.material || "Bahan Baku",
      category: it.category || "Kain",
      qty,
      unit: it.unit === "kg" ? "kg" : "yard",
      total,
      pricePerUnit: qty > 0 ? total / qty : moneyValue(it.pricePerUnit || 0),
    };
  });
}

function purchaseMaterialsTotal(items) {
  return (items || []).reduce((sum, it) => sum + moneyValue(it.total || 0), 0);
}

function calculateProductHpp(product) {
  const bahan = moneyValue(product?.bahanCost || product?.materialCost || 0);
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
    const unit = it.unit === "kg" ? "kg" : "yard";
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
  return aggregateMaterialLines((items || [])
    .filter((it) => it.mainMaterial && Number(it.materialQtyPerPcs || 0) > 0 && Number(it.qty || 0) > 0)
    .map((it) => ({
      name: it.mainMaterial,
      category: "Produksi",
      unit: it.unit === "kg" ? "kg" : "yard",
      qty: Number(it.qty || 0) * Number(it.materialQtyPerPcs || 0),
      // Nilai stok bahan keluar hanya sebesar biaya bahan, bukan full HPP.
      // HPP berisi bahan + produksi + distribusi + lain-lain.
      total: moneyValue(it.bahanCost || 0) * Number(it.qty || 0),
      source: it.name || "Produksi",
    })));
}

function normalizeOrderItems(order) {
  const rawItems = Array.isArray(order?.items) && order.items.length > 0
    ? order.items
    : [{ name: order?.item || "Pesanan Kerudung", qty: order?.qty || 0, price: order?.hargaPcs || 0 }];

  return rawItems.map((it) => {
    const qty = Number(it.qty || 0);
    let price = moneyValue(it.price || it.hargaPcs || 0);

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
      unit: it.unit === "kg" ? "kg" : "yard",
    };
  });
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
  return Array.isArray(order?.deliveries) ? order.deliveries : [];
}

function totalDeliveredQtyForItem(order, itemIndex, itemName) {
  return getDeliveryHistory(order).reduce((sum, delivery) => {
    const found = (delivery.items || []).find((it) =>
      Number(it.itemIndex ?? -1) === itemIndex || normalizeName(it.name) === normalizeName(itemName)
    );
    return sum + Number(found?.qty || 0);
  }, 0);
}

function normalizeShipmentItems(order) {
  const orderItems = normalizeOrderItems(order);
  const deliveries = getDeliveryHistory(order);

  // Format baru: akumulasi pengiriman bertahap.
  if (deliveries.length > 0) {
    return orderItems.map((it, idx) => {
      const shippedQty = totalDeliveredQtyForItem(order, idx, it.name);
      return {
        name: it.name,
        orderedQty: Number(it.qty || 0),
        shippedQty,
        price: moneyValue(it.price || 0),
        bahanCost: moneyValue(it.bahanCost || 0),
        hppPerPcs: moneyValue(it.hppPerPcs || 0),
        mainMaterial: it.mainMaterial || "",
        materialQtyPerPcs: Number(it.materialQtyPerPcs || 0),
        unit: it.unit || "yard",
        note: shipmentAutoNote(Number(it.qty || 0), shippedQty),
      };
    });
  }

  // Kompatibel dengan format lama: shippedItems hasil realisasi sekali kirim.
  const shipped = Array.isArray(order?.shippedItems) && order.shippedItems.length > 0
    ? order.shippedItems
    : null;

  if (!shipped) {
    return orderItems.map((it) => ({
      name: it.name,
      orderedQty: Number(it.qty || 0),
      shippedQty: 0,
      price: moneyValue(it.price || 0),
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
      orderedQty,
      shippedQty,
      price: moneyValue(it.price ?? base.price ?? 0),
      bahanCost: moneyValue(it.bahanCost ?? base.bahanCost ?? 0),
      hppPerPcs: moneyValue(it.hppPerPcs ?? base.hppPerPcs ?? 0),
      mainMaterial: it.mainMaterial || base.mainMaterial || "",
      materialQtyPerPcs: Number(it.materialQtyPerPcs ?? base.materialQtyPerPcs ?? 0),
      unit: it.unit || base.unit || "yard",
      note: it.note || it.keterangan || shipmentAutoNote(orderedQty, shippedQty),
    };
  });
}

function shipmentItemsTotal(items) {
  return (items || []).reduce((sum, it) => sum + Number(it.shippedQty || 0) * moneyValue(it.price || 0), 0);
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

function deliveryItemsTotal(items) {
  return (items || []).reduce((sum, it) => sum + Number(it.qty || 0) * moneyValue(it.price || 0), 0);
}

function billableOrderTotal(order) {
  const deliveries = getDeliveryHistory(order);

  if (deliveries.length > 0) {
    return shipmentItemsTotal(normalizeShipmentItems(order));
  }

  if (Array.isArray(order?.shippedItems) && order.shippedItems.length > 0) {
    return shipmentItemsTotal(normalizeShipmentItems(order));
  }

  if (order?.deliveredTotal !== undefined && order?.deliveredTotal !== null) {
    return Number(order.deliveredTotal || 0);
  }

  // Belum ada realisasi kirim: jangan diakui sebagai nilai tagihan/realisasi.
  // Total pesanan awal tetap tersedia di order.total.
  return 0;
}

function orderDeliveryStatus(order) {
  const items = normalizeShipmentItems(order);
  const totalOrdered = items.reduce((sum, it) => sum + Number(it.orderedQty || 0), 0);
  const totalShipped = items.reduce((sum, it) => sum + Number(it.shippedQty || 0), 0);
  if (totalShipped <= 0) return "Proses";
  if (totalShipped < totalOrdered) return "Dikirim Sebagian";
  return "Selesai";
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

function TabBar({ tab, setTab, badgeCount = 0 }) {
  const tabs = [
    { id: "dashboard", label: "Dashboard", icon: "🏠" },
    { id: "orders", label: "Pesanan", icon: "🧾" },
    { id: "products", label: "Produk", icon: "🏷️" },
    { id: "purchases", label: "Supplier", icon: "🛍️" },
    { id: "expenses", label: "Pengeluaran", icon: "💸" },
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

const STATUS_STYLES = {
  Proses:  { background: "linear-gradient(135deg,#fde68a,#fbbf24)", color: "#92400e" },
  "Dikirim Sebagian": { background: "linear-gradient(135deg,#fed7aa,#fb923c)", color: "#9a3412" },
  Selesai: { background: "linear-gradient(135deg,#bfdbfe,#60a5fa)", color: "#1e3a8a" },
  Lunas:   { background: "linear-gradient(135deg,#bbf7d0,#34d399)", color: "#064e3b" },
};
const STATUS_ICON = { Proses: "⏳", "Dikirim Sebagian": "📦", Selesai: "🚚", Lunas: "✅" };

// ─── Invoice Modal (per customer: semua pesanan, rincian lengkap) ─────────────
function InvoiceModal({ customerName, orders, onClose }) {
  const canvasRef = React.useRef(null);
  const [imgUrl, setImgUrl] = React.useState(null);
  const [invoiceAction, setInvoiceAction] = React.useState(null);

  const today = new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });

  const customerOrders = orders
    .filter(o => normalizeName(o.customer) === normalizeName(customerName))
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

  const totalTagihan = customerOrders.reduce((s, o) => s + billableOrderTotal(o), 0);
  const totalBayar = customerOrders.reduce((s, o) =>
    s + (o.payments || []).reduce((a, p) => a + moneyValue(p.amount || 0), 0), 0);
  const totalSisa = totalTagihan - totalBayar;


  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = 340;

    // Calculate height dynamically
    // Dibuat lebih longgar supaya bagian RINGKASAN dan footer tidak terpotong
    // saat invoice berisi banyak order, banyak produk, atau riwayat pembayaran panjang.
    let estimatedH = 260; // header + customer info
    customerOrders.forEach(o => {
      const productRows = Math.max(normalizeShipmentItems(o).length, 1);
      const payments = o.payments || [];

      estimatedH += 74; // order header + judul rincian produk
      estimatedH += productRows * 86; // produk + qty kirim + selisih/keterangan + subtotal
      estimatedH += payments.length > 0 ? 42 + payments.length * 30 : 30; // pembayaran
      estimatedH += 54; // status + sisa per order + divider
    });
    estimatedH += 190; // ringkasan + footer + extra padding anti kepotong

    canvas.width = W;
    canvas.height = estimatedH;

    // Background
    ctx.fillStyle = "#fff9fc";
    ctx.fillRect(0, 0, W, estimatedH);
    ctx.fillStyle = "#fce7f3";
    ctx.fillRect(0, 0, 6, estimatedH);
    ctx.fillRect(W - 6, 0, 6, estimatedH);

    // Header gradient
    const grad = ctx.createLinearGradient(0, 0, W, 110);
    grad.addColorStop(0, "#ec4899");
    grad.addColorStop(1, "#a855f7");
    ctx.fillStyle = grad;
    ctx.fillRect(6, 0, W - 12, 110);

    ctx.fillStyle = "#fff";
    ctx.font = "bold 20px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Gallery Kerudung", W / 2, 36);
    ctx.font = "12px Arial";
    ctx.fillText("✨ made by order ✨", W / 2, 56);
    ctx.fillText("📱 087822864625", W / 2, 76);
    ctx.font = "11px Arial";
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillText("💕 Gallery Kerudung 💕", W / 2, 98);

    // Scallop edge
    ctx.fillStyle = "#fff9fc";
    for (let x = 6; x < W - 6; x += 14) {
      ctx.beginPath();
      ctx.arc(x + 7, 110, 7, 0, Math.PI);
      ctx.fill();
    }

    // Invoice title
    ctx.fillStyle = "#ec4899";
    ctx.font = "bold 15px Arial";
    ctx.textAlign = "center";
    ctx.fillText("─── RINCIAN PESANAN ───", W / 2, 142);

    // Customer info
    ctx.fillStyle = "#a855f7";
    ctx.font = "bold 13px Arial";
    ctx.textAlign = "left";
    ctx.fillText("Customer:", 20, 168);
    ctx.fillStyle = "#1e293b";
    ctx.font = "bold 15px Arial";
    ctx.fillText(customerName, 20, 186);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px Arial";
    ctx.textAlign = "right";
    ctx.fillText(`Dicetak: ${today}`, W - 20, 168);
    ctx.fillText(`${customerOrders.length} pesanan`, W - 20, 186);

    let curY = 210;

    const drawLine = (dashed = false) => {
      ctx.strokeStyle = "#fce7f3";
      ctx.lineWidth = 1;
      if (dashed) ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(20, curY);
      ctx.lineTo(W - 20, curY);
      ctx.stroke();
      ctx.setLineDash([]);
      curY += 12;
    };

    const drawRow = (label, val, labelColor = "#9d4edd", valColor = "#1e293b", bold = false, fontSize = 11) => {
      ctx.fillStyle = labelColor;
      ctx.font = `${bold ? "bold " : ""}${fontSize}px Arial`;
      ctx.textAlign = "left";
      ctx.fillText(label, 20, curY);
      ctx.fillStyle = valColor;
      ctx.font = `${bold ? "bold " : ""}${fontSize}px Arial`;
      ctx.textAlign = "right";
      ctx.fillText(val, W - 20, curY);
      curY += 22;
    };

    // Each order
    customerOrders.forEach((o, idx) => {
      // Order header box
      const boxY = curY - 4;
      ctx.fillStyle = idx % 2 === 0 ? "#fdf2f8" : "#f5f3ff";
      ctx.fillRect(14, boxY, W - 28, 24);

      ctx.fillStyle = "#ec4899";
      ctx.font = "bold 11px Arial";
      ctx.textAlign = "left";
      ctx.fillText(`#${idx + 1} ${o.invoice || "-"}`, 20, curY + 12);
      ctx.fillStyle = "#a855f7";
      ctx.textAlign = "right";
      ctx.fillText(o.createdAt || "-", W - 20, curY + 12);
      curY += 28;

      const invoiceItems = normalizeShipmentItems(o);
      ctx.fillStyle = "#a855f7";
      ctx.font = "bold 10px Arial";
      ctx.textAlign = "left";
      ctx.fillText("Rincian Produk:", 20, curY);
      curY += 16;
      invoiceItems.forEach((it) => {
        const subtotal = Number(it.shippedQty || 0) * moneyValue(it.price || 0);
        const selisih = Number(it.shippedQty || 0) - Number(it.orderedQty || 0);
        ctx.fillStyle = "#1e293b";
        ctx.font = "bold 10px Arial";
        ctx.textAlign = "left";
        ctx.fillText(it.name || "Produk", 24, curY);
        ctx.fillStyle = "#64748b";
        ctx.font = "10px Arial";
        ctx.textAlign = "right";
        ctx.fillText(`Kirim ${it.shippedQty || 0}/${it.orderedQty || 0} pcs`, W - 20, curY);
        curY += 16;
        ctx.fillStyle = selisih < 0 ? "#e11d48" : "#64748b";
        ctx.font = "10px Arial";
        ctx.textAlign = "left";
        ctx.fillText(`Selisih ${selisih} pcs`, 24, curY);
        ctx.fillStyle = "#ec4899";
        ctx.font = "bold 10px Arial";
        ctx.textAlign = "right";
        ctx.fillText(`Subtotal Rp ${subtotal.toLocaleString("id-ID")}`, W - 20, curY);
        curY += 14;
        ctx.fillStyle = selisih < 0 ? "#e11d48" : selisih > 0 ? "#059669" : "#64748b";
        ctx.font = "9px Arial";
        ctx.textAlign = "left";
        ctx.fillText(it.note || shipmentAutoNote(it.orderedQty, it.shippedQty), 24, curY);
        curY += 18;
      });
      drawRow("Total Pesanan", `Rp ${moneyValue(o.total || 0).toLocaleString("id-ID")}`, "#64748b", "#64748b", false);
      drawRow("Total Realisasi", `Rp ${billableOrderTotal(o).toLocaleString("id-ID")}`, "#64748b", "#1e293b", true);

      // Status badge inline
      const statusColors = { Proses: "#f59e0b", Selesai: "#3b82f6", Lunas: "#10b981" };
      const sc = statusColors[o.status] || "#94a3b8";
      ctx.fillStyle = sc;
      ctx.font = "bold 10px Arial";
      ctx.textAlign = "left";
      ctx.fillText(`● ${o.status || "Proses"}`, 20, curY);
      curY += 18;

      // Payments
      const payments = o.payments || [];
      if (payments.length > 0) {
        ctx.fillStyle = "#a855f7";
        ctx.font = "bold 10px Arial";
        ctx.textAlign = "left";
        ctx.fillText("Riwayat Pembayaran:", 20, curY);
        curY += 18;
        payments.forEach(p => {
          ctx.fillStyle = "#94a3b8";
          ctx.font = "10px Arial";
          ctx.textAlign = "left";
          ctx.fillText(`  ${p.date}  ${p.note || ""}`, 20, curY);
          ctx.fillStyle = "#059669";
          ctx.font = "bold 10px Arial";
          ctx.textAlign = "right";
          ctx.fillText(`+ Rp ${moneyValue(p.amount || 0).toLocaleString("id-ID")}`, W - 20, curY);
          curY += 20;
        });
      } else {
        ctx.fillStyle = "#fca5a5";
        ctx.font = "10px Arial";
        ctx.textAlign = "left";
        ctx.fillText("Belum ada pembayaran", 20, curY);
        curY += 18;
      }

      // Sisa per order
      const paid = payments.reduce((s, p) => s + moneyValue(p.amount || 0), 0);
      const sisa = billableOrderTotal(o) - paid;
      ctx.fillStyle = sisa > 0 ? "#fee2e2" : "#dcfce7";
      ctx.fillRect(14, curY, W - 28, 22);
      ctx.fillStyle = sisa > 0 ? "#e11d48" : "#059669";
      ctx.font = "bold 10px Arial";
      ctx.textAlign = "left";
      ctx.fillText("Sisa:", 20, curY + 15);
      ctx.textAlign = "right";
      ctx.fillText(`Rp ${sisa.toLocaleString("id-ID")}`, W - 20, curY + 15);
      curY += 30;

      drawLine(true);
    });

    // Summary box
    curY += 6;
    ctx.fillStyle = "#ede9fe";
    ctx.fillRect(14, curY, W - 28, 90);

    ctx.fillStyle = "#7c3aed";
    ctx.font = "bold 12px Arial";
    ctx.textAlign = "center";
    ctx.fillText("RINGKASAN", W / 2, curY + 18);

    ctx.fillStyle = "#6d28d9";
    ctx.font = "11px Arial";
    ctx.textAlign = "left";
    ctx.fillText("Total Tagihan", 24, curY + 38);
    ctx.textAlign = "right";
    ctx.fillText(`Rp ${totalTagihan.toLocaleString("id-ID")}`, W - 24, curY + 38);

    ctx.fillStyle = "#059669";
    ctx.font = "11px Arial";
    ctx.textAlign = "left";
    ctx.fillText("Total Dibayar", 24, curY + 56);
    ctx.textAlign = "right";
    ctx.fillText(`Rp ${totalBayar.toLocaleString("id-ID")}`, W - 24, curY + 56);

    ctx.fillStyle = totalSisa > 0 ? "#e11d48" : "#059669";
    ctx.font = "bold 13px Arial";
    ctx.textAlign = "left";
    ctx.fillText("Sisa Tagihan", 24, curY + 78);
    ctx.textAlign = "right";
    ctx.fillText(`Rp ${totalSisa.toLocaleString("id-ID")}`, W - 24, curY + 78);

    curY += 100;

    // Footer scallop + gradient
    ctx.fillStyle = "#fce7f3";
    for (let x = 6; x < W - 6; x += 14) {
      ctx.beginPath();
      ctx.arc(x + 7, curY, 7, Math.PI, 0);
      ctx.fill();
    }
    const footGrad = ctx.createLinearGradient(0, curY, W, curY + 46);
    footGrad.addColorStop(0, "#ec4899");
    footGrad.addColorStop(1, "#a855f7");
    ctx.fillStyle = footGrad;
    ctx.fillRect(6, curY + 4, W - 12, 46);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 12px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Terima kasih sudah berbelanja! 💕", W / 2, curY + 30);

    setImgUrl(canvas.toDataURL("image/png"));
  }, [customerName]);

  function downloadGambar() {
    if (!imgUrl) return;
    const safeName = customerName.replace(/\s+/g, "-").toLowerCase();
    const link = document.createElement("a");
    link.download = `invoice-${safeName}.png`;
    link.href = imgUrl;
    link.click();
  }

  async function shareGambar() {
    if (!imgUrl) return;
    try {
      const res = await fetch(imgUrl);
      const blob = await res.blob();
      const safeName = customerName.replace(/\s+/g, "-").toLowerCase();
      const file = new File([blob], `invoice-${safeName}.png`, { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: `Invoice ${customerName} - Gallery Kerudung`,
          text: `Rincian pesanan ${customerName} dari Gallery Kerudung 💕`,
        });
      } else {
        const link = document.createElement("a");
        link.download = `invoice-${safeName}.png`;
        link.href = imgUrl;
        link.click();
        setTimeout(() => alert("Gambar tersimpan. Silakan bagikan ke WhatsApp dari galeri."), 500);
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        const link = document.createElement("a");
        link.download = `invoice-${customerName}.png`;
        link.href = imgUrl;
        link.click();
      }
    }
  }


  return (
    <SimpleModal title={`Invoice — ${customerName}`} onClose={onClose}>
      <canvas ref={canvasRef} className="hidden" />
      {!imgUrl && (
        <div className="flex items-center justify-center py-10 gap-3">
          <div className="w-5 h-5 border-2 border-pink-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-slate-500">Membuat invoice...</span>
        </div>
      )}
      {imgUrl && (
        <div className="space-y-3">
          <img src={imgUrl} alt="invoice" className="w-full rounded-2xl border border-slate-100" />
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => setInvoiceAction("download")} className="w-full"
              style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>
              ⬇️ Download
            </Button>
            <Button onClick={() => setInvoiceAction("share")} className="w-full"
              style={{ background: "linear-gradient(135deg,#10b981,#25d366)" }}>
              📤 Kirim WA
            </Button>
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
                onClick={() => {
                  const action = invoiceAction;
                  setInvoiceAction(null);
                  if (action === "download") downloadGambar();
                  else shareGambar();
                }}
                className="flex-1 rounded-2xl py-3 font-semibold text-white"
                style={{ background: invoiceAction === "download" ? "linear-gradient(135deg,#7c3aed,#a855f7)" : "linear-gradient(135deg,#10b981,#25d366)" }}
              >
                Ya, lanjut
              </button>
            </div>
          </div>
        </div>
      )}
    </SimpleModal>
  );
}

// ─── Grafik Kas ──────────────────────────────────────────────────────────────
function GrafikKas({ orders, purchases, expenses }) {
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
    orders.forEach((o) => {
      (o.payments || []).forEach((p) => {
        const k = getKey(p.date);
        if (!map[k]) map[k] = { bulan: k, masuk: 0, keluar: 0 };
        map[k].masuk += moneyValue(p.amount || 0);
      });
    });
    purchases.forEach((p) => {
      (p.payments || []).forEach((x) => {
        const k = getKey(x.date);
        if (!map[k]) map[k] = { bulan: k, masuk: 0, keluar: 0 };
        map[k].keluar += moneyValue(x.amount || 0);
      });
    });
    expenses.forEach((e) => {
      const k = getKey(e.date);
      if (!map[k]) map[k] = { bulan: k, masuk: 0, keluar: 0 };
      map[k].keluar += moneyValue(e.amount || 0);
    });
    return Object.values(map).sort((a, b) => a.bulan.localeCompare(b.bulan)).slice(-6);
  }, [orders, purchases, expenses]);

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
export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
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
    try { setAuthError(""); await signInWithPopup(auth, provider); }
    catch (e) { setAuthError("Login gagal: " + e.message); }
  }

  async function handleLogout() { await signOut(auth); }

  const [tab, setTab] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [orders, setOrders] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [materialsStock, setMaterialsStock] = useState([]);
  const [productMasters, setProductMasters] = useState([]);
  const [productCategories, setProductCategories] = useState([]);
  const [editData, setEditData] = useState(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [filterOrder, setFilterOrder] = useState("semua");
  const [sortOrder, setSortOrder] = useState("terbaru");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [rekapConfirm, setRekapConfirm] = useState(null);
  const [kirimModal, setKirimModal] = useState(null);
  const [tanggalKirim, setTanggalKirim] = useState(todayStr());
  const [kirimItems, setKirimItems] = useState([]);
  // Invoice per customer
  const [invoiceCustomer, setInvoiceCustomer] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);

  const [orderForm, setOrderForm] = useState({
    date: todayStr(),
    customer: "",
    phone: "",
    items: [emptyOrderItem()],
    dp: 0,
  });
  const [orderDraftLoaded, setOrderDraftLoaded] = useState(false);
  const [purchaseForm, setPurchaseForm] = useState({
    date: todayStr(),
    supplier: "",
    materials: [emptyPurchaseMaterial()],
    dp: 0,
  });
  const emptyProductForm = {
    imageUrl: "",
    name: "",
    category: "",
    defaultPrice: 0,
    mainMaterial: "",
    materialQtyPerPcs: "",
    unit: "yard",
    bahanCost: 0,
    productionCost: 0,
    distributionCost: 0,
    otherCost: 0,
    isActive: true,
  };
  const [productForm, setProductForm] = useState(emptyProductForm);
  async function handleProductImageUpload(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return alert("File harus berupa gambar.");
    if (file.size > 8 * 1024 * 1024) return alert("Ukuran foto maksimal 8 MB.");

    try {
      const dataUrl = await resizeImageToDataUrl(file, 520, 0.72);
      setProductForm((f) => ({ ...f, imageUrl: dataUrl }));
    } catch (e) {
      alert("Gagal membaca foto: " + e.message);
    }
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
          canvas.width = width;
          canvas.height = height;
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

  const [expenseForm, setExpenseForm] = useState({ date: todayStr(), category: "", note: "", amount: 0 });
  const [orderPayForm, setOrderPayForm] = useState({ customer: "", date: todayStr(), note: "", amount: 0 });
  const [supplierPayForm, setSupplierPayForm] = useState({ supplier: "", date: todayStr(), note: "", amount: 0 });

  const loadedRef = useRef({ orders: false, purchases: false, expenses: false, materials: false, products: false, productCategories: false });

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("gk_audit_logs") || "[]");
      setAuditLogs(Array.isArray(saved) ? saved.slice(0, 50) : []);
    } catch (e) {
      setAuditLogs([]);
    }
  }, []);

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
          dp: Number(saved.dp || 0),
        });
      }
    } catch (e) {
      // draft rusak diabaikan agar app tetap jalan
    } finally {
      setOrderDraftLoaded(true);
    }
  }, [user, orderDraftLoaded]);

  useEffect(() => {
    if (!user || !orderDraftLoaded) return;
    const hasDraft = Boolean(orderForm.customer || orderForm.phone || moneyValue(orderForm.dp || 0) > 0 || (orderForm.items || []).some((it) => it.name || Number(it.qty || 0) > 0 || moneyValue(it.price || 0) > 0));
    try {
      if (hasDraft) localStorage.setItem("gk_order_draft", JSON.stringify(orderForm));
      else localStorage.removeItem("gk_order_draft");
    } catch (e) {
      // autosave tidak boleh mengganggu input
    }
  }, [user, orderDraftLoaded, orderForm]);

  useEffect(() => {
    if (!user) {
      setOrders([]); setPurchases([]); setExpenses([]); setMaterialsStock([]); setProductMasters([]); setProductCategories([]);
      setFirestoreError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    setFirestoreError("");
    loadedRef.current = { orders: false, purchases: false, expenses: false, materials: false, products: false, productCategories: false };

    const checkAllLoaded = () => {
      const r = loadedRef.current;
      if (r.orders && r.purchases && r.expenses && r.materials && r.products && r.productCategories) setLoading(false);
    };

    const handleSnapshotError = (key, label, err) => {
      console.error(`${label}:`, err);
      loadedRef.current[key] = true;
      setFirestoreError((prev) => {
        const msg = `${label}: ${err?.message || "Gagal memuat data"}`;
        return prev ? `${prev}
${msg}` : msg;
      });
      checkAllLoaded();
    };

    const unsubOrders = onSnapshot(collection(db, "orders"), (snap) => {
      setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      if (!loadedRef.current.orders) { loadedRef.current.orders = true; checkAllLoaded(); }
    }, err => handleSnapshotError("orders", "orders", err));

    const unsubPurchases = onSnapshot(collection(db, "purchases"), (snap) => {
      setPurchases(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      if (!loadedRef.current.purchases) { loadedRef.current.purchases = true; checkAllLoaded(); }
    }, err => handleSnapshotError("purchases", "purchases", err));

    const unsubExpenses = onSnapshot(collection(db, "expenses"), (snap) => {
      setExpenses(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      if (!loadedRef.current.expenses) { loadedRef.current.expenses = true; checkAllLoaded(); }
    }, err => handleSnapshotError("expenses", "expenses", err));

    const unsubMaterials = onSnapshot(collection(db, "materials"), (snap) => {
      setMaterialsStock(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      if (!loadedRef.current.materials) { loadedRef.current.materials = true; checkAllLoaded(); }
    }, err => handleSnapshotError("materials", "materials", err));

    const unsubProducts = onSnapshot(collection(db, "products"), (snap) => {
      setProductMasters(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      if (!loadedRef.current.products) { loadedRef.current.products = true; checkAllLoaded(); }
    }, err => handleSnapshotError("products", "products", err));

    const unsubProductCategories = onSnapshot(collection(db, "productCategories"), (snap) => {
      setProductCategories(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      if (!loadedRef.current.productCategories) { loadedRef.current.productCategories = true; checkAllLoaded(); }
    }, err => handleSnapshotError("productCategories", "productCategories", err));

    return () => { unsubOrders(); unsubPurchases(); unsubExpenses(); unsubMaterials(); unsubProducts(); unsubProductCategories(); };
  }, [user]);

  // ── Helper functions ──
  function orderPaidTotal(order) {
    return (order.payments || []).reduce((s, p) => s + moneyValue(p.amount || 0), 0);
  }

  // Saldo invoice berdasarkan realisasi kirim. Bisa negatif kalau customer sudah DP/deposit dulu.
  function sisaOrder(order) {
    return billableOrderTotal(order) - orderPaidTotal(order);
  }

  // Batas alokasi pembayaran customer mengikuti total pesanan awal, agar pembayaran sebelum kirim tetap bisa dicatat.
  function sisaOrderUntukAlokasi(order) {
    const target = Math.max(moneyValue(order.total || 0), billableOrderTotal(order));
    return target - orderPaidTotal(order);
  }

  function isDeliveryComplete(order) {
    return orderDeliveryStatus(order) === "Selesai";
  }

  function purchasePaidTotal(purchase) {
    return (purchase.payments || []).reduce((s, p) => s + moneyValue(p.amount || 0), 0);
  }

  function sisaPurchase(purchase) {
    const paid = purchasePaidTotal(purchase);
    return moneyValue(purchase.total || 0) - paid;
  }

  function hutangPurchase(purchase) {
    return Math.max(0, sisaPurchase(purchase));
  }

  function depositSupplier(purchase) {
    return Math.max(0, -sisaPurchase(purchase));
  }

  // ── Stats ──
  const stats = useMemo(() => {
    const totalOrderValue = orders.reduce((s, o) => s + billableOrderTotal(o), 0);
    const customerPaid = orders.reduce((s, o) => s + (o.payments || []).reduce((a, p) => a + moneyValue(p.amount || 0), 0), 0);
    const receivable = orders.reduce((s, o) => s + Math.max(0, billableOrderTotal(o) - orderPaidTotal(o)), 0);
    const supplierTotal = purchases.reduce((s, p) => s + moneyValue(p.total || 0), 0);
    const supplierPaid = purchases.reduce((s, p) => s + (p.payments || []).reduce((a, x) => a + moneyValue(x.amount || 0), 0), 0);
    const supplierDebt = purchases.reduce((s, p) => s + hutangPurchase(p), 0);
    const otherExpense = expenses.reduce((s, e) => s + moneyValue(e.amount || 0), 0);
    const cashOut = supplierPaid + otherExpense;
    const netCash = customerPaid - cashOut;
    return { customerPaid, cashOut, receivable, supplierDebt, netCash };
  }, [orders, purchases, expenses]);

  const pesananTelat = useMemo(() => {
    const now = new Date();
    return orders.filter((o) => {
      if (o.status === "Lunas") return false;
      const sisa = sisaOrder(o);
      if (sisa <= 0) return false;
      const lastPayStr = (o.payments || []).length > 0
        ? o.payments[o.payments.length - 1].date
        : (o.createdAt || null);
      if (!lastPayStr) return true;
      const lastPayDate = new Date(lastPayStr + "T00:00:00");
      if (isNaN(lastPayDate.getTime())) return true;
      const diffDays = Math.floor((now - lastPayDate) / (1000 * 60 * 60 * 24));
      return diffDays >= 7;
    });
  }, [orders]);

  const uniqueCustomers = useMemo(() => {
    const map = {};
    orders.forEach(o => {
      const name = capitalizeWords(o.customer || "");
      const key = normalizeName(name);
      if (!key) return;
      if (!map[key]) {
        map[key] = {
          name,
          totalSisa: 0,
          totalPesanan: 0,
          pesananAktif: 0,
          totalRealisasiSisa: 0,
        };
      }
      map[key].totalPesanan += 1;

      // Untuk fitur Catat Bayar Masuk, customer harus tetap muncul walaupun barang
      // belum dikirim. Karena aplikasi memang mengizinkan DP/pembayaran sebelum
      // realisasi kirim. Jadi sisa aktif dihitung dari nilai terbesar antara
      // total pesanan awal dan total realisasi kirim.
      const sisaAlokasi = Math.max(0, sisaOrderUntukAlokasi(o));
      const sisaRealisasi = Math.max(0, sisaOrder(o));
      if (sisaAlokasi > 0) {
        map[key].totalSisa += sisaAlokasi;
        map[key].totalRealisasiSisa += sisaRealisasi;
        map[key].pesananAktif += 1;
      }
    });
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  }, [orders]);

  const uniqueSuppliers = useMemo(() => {
    const map = {};
    purchases.forEach(p => {
      const name = capitalizeWords(p.supplier || "");
      const key = normalizeName(name);
      if (!key) return;
      if (!map[key]) map[key] = { name, totalSisa: 0, totalBelanja: 0, belanjaAktif: 0 };
      map[key].totalBelanja += 1;
      const paid = (p.payments || []).reduce((s, x) => s + moneyValue(x.amount || 0), 0);
      const sisa = moneyValue(p.total || 0) - paid;
      if (sisa > 0) { map[key].totalSisa += sisa; map[key].belanjaAktif += 1; }
    });
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  }, [purchases]);

  // ── Search filter ──
  const q = search.toLowerCase();
  const filteredOrders = useMemo(() => orders.filter((o) => {
    const itemText = normalizeOrderItems(o).map((it) => it.name).join(" ").toLowerCase();
    return !q || o.customer?.toLowerCase().includes(q) || o.invoice?.toLowerCase().includes(q) || itemText.includes(q);
  }), [orders, q]);

  const filteredPurchases = useMemo(() => purchases.filter((p) => {
    const bahanText = normalizePurchaseMaterials(p).map((it) => it.name).join(" ").toLowerCase();
    return !q || p.supplier?.toLowerCase().includes(q) || p.material?.toLowerCase().includes(q) || bahanText.includes(q);
  }), [purchases, q]);

  const filteredMaterialsStock = useMemo(() => (materialsStock || []).filter((m) => {
    const nameText = String(m?.name || "").toLowerCase();
    const categoryText = String(m?.category || "").toLowerCase();
    return !q || nameText.includes(q) || categoryText.includes(q);
  }), [materialsStock, q]);

  const filteredProductMasters = useMemo(() => (productMasters || []).filter((p) => {
    const nameText = String(p?.name || "").toLowerCase();
    const categoryText = String(p?.category || "").toLowerCase();
    const materialText = String(p?.mainMaterial || "").toLowerCase();
    return !q || nameText.includes(q) || categoryText.includes(q) || materialText.includes(q);
  }), [productMasters, q]);

  const filteredExpenses = useMemo(() => (expenses || []).filter((e) => {
    const categoryText = String(e?.category || "").toLowerCase();
    const noteText = String(e?.note || "").toLowerCase();
    return !q || categoryText.includes(q) || noteText.includes(q);
  }), [expenses, q]);

  const productCategoryOptions = useMemo(() => {
    const map = {};
    productCategories.forEach((c) => {
      const name = capitalizeWords(c.name || "");
      if (name) map[normalizeName(name)] = name;
    });
    productMasters.forEach((p) => {
      const name = capitalizeWords(p.category || "");
      if (name) map[normalizeName(name)] = name;
    });
    ["Kerudung", "Mukena", "Baju Anak", "Gamis", "Lainnya"].forEach((name) => {
      if (!map[normalizeName(name)]) map[normalizeName(name)] = name;
    });
    return Object.values(map).sort((a, b) => a.localeCompare(b));
  }, [productCategories, productMasters]);

  function findProductMaster(name) {
    return productMasters.find((p) => normalizeName(p.name) === normalizeName(name));
  }

  function applyProductTemplateToOrderItem(idx, product) {
    if (!product) return;
    const hpp = calculateProductHpp(product);
    setOrderForm(f => ({
      ...f,
      items: (f.items || []).map((x, i) => i === idx ? {
        ...x,
        productId: product.id || "",
        name: product.name || x.name,
        category: product.category || x.category || "Lainnya",
        price: moneyValue(product.defaultPrice || x.price || 0),
        bahanCost: moneyValue(product.bahanCost || 0),
        hppPerPcs: hpp,
        mainMaterial: product.mainMaterial || "",
        materialQtyPerPcs: Number(product.materialQtyPerPcs || 0),
        unit: product.unit || "yard",
      } : x),
    }));
  }

  // ── CRUD ──
  async function upsertProductCategory(categoryName) {
    const name = capitalizeWords(categoryName || "Lainnya");
    if (!name) return;
    const existing = productCategories.find((c) => normalizeName(c.name) === normalizeName(name));
    if (!existing?.id) {
      await addDoc(collection(db, "productCategories"), {
        name,
        createdAt: todayStr(),
        updatedAt: todayStr(),
        source: "auto_dari_pesanan",
      });
    }
  }

  async function upsertProductMastersFromOrder(items) {
    for (const it of items) {
      const name = capitalizeWords(it.name || "");
      if (!name) continue;
      const category = capitalizeWords(it.category || "Lainnya");
      await upsertProductCategory(category);
      const existing = productMasters.find((p) => normalizeName(p.name) === normalizeName(name));
      // Produk yang sudah dibuat sebagai template manual tidak ditimpa oleh order harian.
      // Ini menjaga harga/HPP historis agar owner tidak bingung saat order memakai harga khusus.
      if (existing?.id && existing?.source === "manual_template") continue;
      const payload = {
        name,
        category,
        defaultPrice: moneyValue(it.price || 0),
        bahanCost: moneyValue(it.bahanCost || existing?.bahanCost || 0),
        hppPerPcs: moneyValue(it.hppPerPcs || existing?.hppPerPcs || 0),
        mainMaterial: it.mainMaterial || existing?.mainMaterial || "",
        materialQtyPerPcs: Number(it.materialQtyPerPcs || existing?.materialQtyPerPcs || 0),
        unit: it.unit || existing?.unit || "yard",
        updatedAt: todayStr(),
        source: "auto_dari_pesanan",
      };
      if (existing?.id) {
        await updateDoc(doc(db, "products", existing.id), payload);
      } else {
        await addDoc(collection(db, "products"), {
          ...payload,
          createdAt: todayStr(),
        });
      }
    }
  }

  async function recordMaterialMutation(line) {
    try {
      await addDoc(collection(db, "materialMutations"), {
        date: line.date || todayStr(),
        type: line.type || "adjustment",
        materialName: capitalizeWords(line.name || line.materialName || ""),
        category: line.category || "Bahan",
        unit: line.unit === "kg" ? "kg" : "yard",
        qty: Number(line.qty || 0),
        total: moneyValue(line.total || 0),
        refType: line.refType || "manual",
        refId: line.refId || "",
        refLabel: line.refLabel || "",
        note: line.note || "",
        createdAt: new Date().toISOString(),
        user: user?.email || "-",
      });
    } catch (e) {
      // Mutasi adalah audit pendukung; jangan sampai menggagalkan transaksi utama.
      console.warn("Gagal mencatat mutasi bahan:", e);
    }
  }

  async function applyMaterialMovements(items, options = {}) {
    // options.direction: +1 stok masuk, -1 stok keluar/rollback.
    // Fungsi ini menggabungkan bahan yang sama dulu supaya stok tidak dobel saat 1 transaksi punya 2 baris bahan sama.
    const direction = Number(options.direction || 1) >= 0 ? 1 : -1;
    const refType = options.refType || "manual";
    const refId = options.refId || "";
    const refLabel = options.refLabel || "";
    const date = options.date || todayStr();
    const allowMinus = options.allowMinus === true;
    const aggregated = aggregateMaterialLines(items);
    if (aggregated.length === 0) return;

    // Cache lokal agar update beruntun dalam 1 proses tidak memakai state lama.
    const localMap = {};
    (materialsStock || []).forEach((m) => {
      const unit = m.unit === "kg" ? "kg" : "yard";
      localMap[materialLineKey(m.name, unit)] = { ...m, unit };
    });

    for (const it of aggregated) {
      const name = capitalizeWords(it.name || "");
      const unit = it.unit === "kg" ? "kg" : "yard";
      const key = materialLineKey(name, unit);
      const qty = Number(it.qty || 0);
      const qtyDelta = qty * direction;
      let existing = localMap[key];
      let mutationTotalDelta = 0;

      if (!existing?.id && direction < 0) {
        throw new Error(`Stok bahan ${name} belum ada, tidak bisa dikurangi.`);
      }

      if (existing?.id && existing.unit && existing.unit !== unit) {
        throw new Error(`Satuan bahan ${name} sudah tercatat sebagai ${existing.unit}. Tidak bisa digabung dengan ${unit}.`);
      }

      if (!existing?.id) {
        const stock = Math.max(0, Number(it.qty || 0));
        const totalValue = Math.max(0, moneyValue(it.total || 0));
        mutationTotalDelta = moneyValue(it.total || 0);
        const payload = {
          name,
          category: it.category || "Bahan",
          unit,
          stock,
          minStock: unit === "kg" ? 5 : 20,
          avgCost: stock > 0 ? totalValue / stock : 0,
          totalValue,
          createdAt: todayStr(),
          updatedAt: todayStr(),
          source: refType === "purchase" ? "auto_dari_belanja_supplier" : "auto_dari_mutasi",
        };
        const created = await addDoc(collection(db, "materials"), payload);
        existing = { id: created.id, ...payload };
        localMap[key] = existing;
      } else {
        const oldStock = Number(existing.stock || 0);
        const oldValue = moneyValue(existing.totalValue || (oldStock * Number(existing.avgCost || 0)));
        const movementValue = direction < 0
          ? (moneyValue(it.total || 0) > 0 ? moneyValue(it.total || 0) : qty * Number(existing.avgCost || 0))
          : moneyValue(it.total || 0);
        const totalDelta = movementValue * direction;
        mutationTotalDelta = totalDelta;
        const nextStockRaw = oldStock + qtyDelta;
        if (!allowMinus && nextStockRaw < -0.000001) {
          throw new Error(`Stok ${name} tidak cukup. Sisa ${oldStock.toLocaleString("id-ID")} ${unit}, butuh ${Math.abs(qtyDelta).toLocaleString("id-ID")} ${unit}.`);
        }
        const newStock = allowMinus ? nextStockRaw : Math.max(0, nextStockRaw);
        const newValue = Math.max(0, oldValue + totalDelta);
        const payload = {
          name,
          category: it.category || existing.category || "Bahan",
          unit,
          stock: newStock,
          avgCost: newStock > 0 ? newValue / newStock : Number(existing.avgCost || 0),
          totalValue: newValue,
          updatedAt: todayStr(),
        };
        await updateDoc(doc(db, "materials", existing.id), payload);
        existing = { ...existing, ...payload };
        localMap[key] = existing;
      }

      await recordMaterialMutation({
        date,
        type: direction > 0 ? "masuk" : "keluar",
        name,
        category: it.category || existing.category || "Bahan",
        unit,
        qty: qtyDelta,
        total: mutationTotalDelta,
        refType,
        refId,
        refLabel,
        note: options.note || (direction > 0 ? "Stok masuk" : "Stok keluar"),
      });
    }
  }

  async function upsertMaterialsFromPurchase(items, meta = {}) {
    await applyMaterialMovements(items, {
      direction: 1,
      refType: "purchase",
      refId: meta.refId || "",
      refLabel: meta.refLabel || "Belanja supplier",
      date: meta.date || todayStr(),
      note: "Belanja supplier",
    });
  }

  async function rollbackPurchaseStock(purchase) {
    await applyMaterialMovements(normalizePurchaseMaterials(purchase), {
      direction: -1,
      refType: "purchase_rollback",
      refId: purchase?.id || "",
      refLabel: purchase?.supplier || "Rollback supplier",
      date: todayStr(),
      note: "Rollback edit/hapus belanja supplier",
      allowMinus: false,
    });
  }

  async function applyPurchaseStock(purchase) {
    await applyMaterialMovements(normalizePurchaseMaterials(purchase), {
      direction: 1,
      refType: "purchase",
      refId: purchase?.id || "",
      refLabel: purchase?.supplier || "Belanja supplier",
      date: purchase?.createdAt || todayStr(),
      note: "Belanja supplier",
    });
  }

  async function saveProductTemplate() {
    if (!productForm.name.trim()) return alert("Nama produk wajib diisi");
    if (!productForm.category.trim()) return alert("Kategori wajib diisi");
    if (!moneyValue(productForm.defaultPrice || 0)) return alert("Harga jual wajib diisi");

    setIsSaving(true);
    try {
      const name = capitalizeWords(productForm.name);
      const category = capitalizeWords(productForm.category || "Lainnya");
      await upsertProductCategory(category);
      const existing = productMasters.find((p) => normalizeName(p.name) === normalizeName(name));
      const payload = {
        imageUrl: productForm.imageUrl || "",
        name,
        category,
        defaultPrice: moneyValue(productForm.defaultPrice || 0),
        mainMaterial: capitalizeWords(productForm.mainMaterial || ""),
        materialQtyPerPcs: Number(productForm.materialQtyPerPcs || 0),
        unit: productForm.unit === "kg" ? "kg" : "yard",
        bahanCost: moneyValue(productForm.bahanCost || 0),
        productionCost: moneyValue(productForm.productionCost || 0),
        distributionCost: moneyValue(productForm.distributionCost || 0),
        otherCost: moneyValue(productForm.otherCost || 0),
        hppPerPcs: calculateProductHpp(productForm),
        isActive: productForm.isActive !== false,
        updatedAt: todayStr(),
        source: "manual_template",
      };
      if (existing?.id) {
        await updateDoc(doc(db, "products", existing.id), payload);
      } else {
        await addDoc(collection(db, "products"), { ...payload, createdAt: todayStr() });
      }
      addAuditLog("Simpan Template Produk", `${name} - HPP ${rupiah(payload.hppPerPcs)}`);
      setProductForm(emptyProductForm);
      setModal(null);
    } catch (e) { alert("Gagal menyimpan produk: " + e.message); }
    finally { setIsSaving(false); }
  }

  async function addOrder() {
    if (!orderForm.customer.trim()) return alert("Nama customer wajib diisi");

    const cleanItems = (orderForm.items || [])
      .map((it) => ({
        name: (it.name || "").trim(),
        category: capitalizeWords(it.category || "Lainnya"),
        qty: Number(it.qty || 0),
        price: moneyValue(it.price || 0),
        bahanCost: moneyValue(it.bahanCost || 0),
        hppPerPcs: moneyValue(it.hppPerPcs || 0),
        productId: it.productId || "",
        mainMaterial: it.mainMaterial || "",
        materialQtyPerPcs: Number(it.materialQtyPerPcs || 0),
        unit: it.unit === "kg" ? "kg" : "yard",
        note: shipmentAutoNote(Number(it.orderedQty || 0), Number(it.shippedQty || 0)),
      }))
      .filter((it) => it.name && it.qty > 0 && it.price >= 0);

    if (cleanItems.length === 0) return alert("Minimal isi 1 produk dengan nama dan jumlah pcs.");
    if (cleanItems.some((it) => it.qty < 0)) return alert("Jumlah pcs tidak boleh negatif");

    const total = orderItemsTotal(cleanItems);
    if (!total) return alert("Total pesanan wajib diisi");

    setIsSaving(true);
    try {
      const dp = moneyValue(orderForm.dp || 0);
      const firstItem = cleanItems[0] || {};
      await upsertProductMastersFromOrder(cleanItems);

      const newOrder = {
        invoice: generateInvoice(),
        customer: capitalizeWords(orderForm.customer),
        phone: orderForm.phone || "",
        items: cleanItems,
        // field lama tetap disimpan supaya data lama / kode lama tetap aman
        item: firstItem.name || "Produk",
        qty: cleanItems.reduce((s, it) => s + Number(it.qty || 0), 0),
        hargaPcs: moneyValue(firstItem.price || 0),
        total,
        status: "Proses",
        createdAt: orderForm.date || todayStr(),
        payments: dp > 0 ? [{ date: todayStr(), note: "DP Awal", amount: dp }] : [],
      };
      await addDoc(collection(db, "orders"), newOrder);
      addAuditLog("Tambah Pesanan", `${newOrder.customer} - ${newOrder.invoice} - ${rupiah(newOrder.total)}`);
      resetOrderDraft();
      setModal(null);
    } catch (e) { alert("Gagal menyimpan: " + e.message); }
    finally { setIsSaving(false); }
  }

  async function addPurchase() {
    if (!purchaseForm.supplier.trim()) return alert("Nama supplier wajib diisi");

    const cleanMaterials = (purchaseForm.materials || [])
      .map((it) => ({
        name: capitalizeWords(it.name || ""),
        category: it.category || "Kain",
        qty: Number(it.qty || 0),
        unit: it.unit === "kg" ? "kg" : "yard",
        total: moneyValue(it.total || 0),
        pricePerUnit: Number(it.qty || 0) > 0 ? moneyValue(it.total || 0) / Number(it.qty || 0) : 0,
      }))
      .filter((it) => it.name && it.qty > 0 && it.total > 0);

    if (cleanMaterials.length === 0) return alert("Minimal isi 1 bahan, qty, dan total harga.");
    if (cleanMaterials.some((it) => it.qty < 0)) return alert("Qty bahan tidak boleh negatif");

    const total = purchaseMaterialsTotal(cleanMaterials);
    if (!total) return alert("Total belanja wajib diisi");

    setIsSaving(true);
    let purchaseRef = null;
    let stockApplied = false;
    try {
      const dp = moneyValue(purchaseForm.dp || 0);
      const firstMaterial = cleanMaterials[0] || {};

      const newPurchasePayload = {
        supplier: purchaseForm.supplier.trim(),
        materials: cleanMaterials,
        material: cleanMaterials.map((it) => it.name).join(", ") || "Bahan Baku",
        qty: cleanMaterials.map((it) => `${it.qty} ${it.unit}`).join(", "),
        category: firstMaterial.category || "Kain",
        total,
        createdAt: purchaseForm.date || todayStr(),
        payments: dp > 0 ? [{ date: todayStr(), note: "DP Supplier", amount: dp }] : [],
      };

      // Purchase dibuat dulu agar mutasi punya refId. Jika stok gagal, purchase langsung dihapus lagi.
      purchaseRef = await addDoc(collection(db, "purchases"), newPurchasePayload);
      await applyPurchaseStock({ id: purchaseRef.id, ...newPurchasePayload });
      stockApplied = true;

      addAuditLog("Tambah Supplier", `${newPurchasePayload.supplier} - ${rupiah(newPurchasePayload.total)}`);
      setPurchaseForm({ date: todayStr(), supplier: "", materials: [emptyPurchaseMaterial()], dp: 0 });
      setModal(null);
    } catch (e) {
      // Kompensasi supaya tidak ada purchase tanpa stok, atau stok tanpa purchase.
      try {
        if (stockApplied && purchaseRef?.id) {
          const createdPurchase = purchases.find((p) => p.id === purchaseRef.id);
          if (createdPurchase) await rollbackPurchaseStock(createdPurchase);
        }
        if (purchaseRef?.id) await deleteDoc(doc(db, "purchases", purchaseRef.id));
      } catch (cleanupErr) {
        console.warn("Cleanup tambah supplier gagal:", cleanupErr);
      }
      alert("Gagal menyimpan: " + e.message);
    }
    finally { setIsSaving(false); }
  }

  async function addExpense() {
    if (!expenseForm.category.trim()) return alert("Kategori wajib diisi");
    if (!expenseForm.amount) return alert("Nominal wajib diisi");
    setIsSaving(true);
    try {
      const newExpensePayload = {
        date: expenseForm.date || todayStr(),
        category: expenseForm.category.trim(),
        note: expenseForm.note || "",
        amount: moneyValue(expenseForm.amount || 0),
      };
      await addDoc(collection(db, "expenses"), newExpensePayload);
      addAuditLog("Tambah Pengeluaran", `${newExpensePayload.category} - ${rupiah(newExpensePayload.amount)}`);
      setExpenseForm({ date: todayStr(), category: "", note: "", amount: 0 });
      setModal(null);
    } catch (e) { alert("Gagal menyimpan: " + e.message); }
    finally { setIsSaving(false); }
  }

  async function addOrderPayment() {
    if (!orderPayForm.customer) return alert("Pilih nama customer terlebih dahulu");
    const paymentAmount = parseMoney(orderPayForm.amount);
    if (paymentAmount <= 0) return alert("Nominal pembayaran wajib diisi");

    const normQ = normalizeName(orderPayForm.customer);
    const customerOrders = orders
      .filter((o) => normalizeName(o.customer) === normQ && sisaOrderUntukAlokasi(o) > 0)
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

    if (customerOrders.length === 0) return alert("Tidak ada pesanan aktif untuk customer ini.");

    setIsSaving(true);
    try {
      let sisa = paymentAmount;
      const date = orderPayForm.date || todayStr();
      const note = orderPayForm.note || "Pembayaran";
      const alokasi = [];

      for (const order of customerOrders) {
        if (sisa <= 0) break;
        const sisaOrder_ = sisaOrderUntukAlokasi(order);
        const bayar = Math.min(sisa, sisaOrder_);
        sisa -= bayar;

        const newPayment = { date, note, amount: bayar };
        const updatedPayments = [...(order.payments || []), newPayment];
        await updateDoc(doc(db, "orders", order.id), { payments: updatedPayments });
        await cekDanUpdateLunas(order.id, billableOrderTotal(order), updatedPayments, order);
        alokasi.push({ invoice: order.invoice, bayar });
      }

      const info = alokasi.map(a => `${a.invoice}: ${rupiah(a.bayar)}`).join("\n");
      const sisaMsg = sisa > 0 ? `\n\nSisa ${rupiah(sisa)} tidak dialokasikan (semua pesanan sudah lunas).` : "";
      addAuditLog("Pembayaran Customer", `${orderPayForm.customer} - ${rupiah(paymentAmount)}`);
      alert(`✅ Pembayaran dialokasikan:\n${info}${sisaMsg}`);

      setOrderPayForm({ customer: "", date: todayStr(), note: "", amount: 0 });
      setModal(null);
    } catch (e) { alert("Gagal menyimpan: " + e.message); }
    finally { setIsSaving(false); }
  }

  async function addSupplierPayment() {
    if (!supplierPayForm.supplier) return alert("Pilih nama supplier terlebih dahulu");
    const supplierPaymentAmount = parseMoney(supplierPayForm.amount);
    if (supplierPaymentAmount <= 0) return alert("Nominal pembayaran wajib diisi");

    const normQ = normalizeName(supplierPayForm.supplier);
    const supplierPurchases = purchases
      .filter((p) => normalizeName(p.supplier) === normQ && sisaPurchase(p) > 0)
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

    if (supplierPurchases.length === 0) return alert("Tidak ada hutang aktif untuk supplier ini.");

    setIsSaving(true);
    try {
      let sisa = supplierPaymentAmount;
      const date = supplierPayForm.date || todayStr();
      const note = supplierPayForm.note || "Pembayaran Supplier";
      const alokasi = [];

      for (const purchase of supplierPurchases) {
        if (sisa <= 0) break;
        const sisaHutang = sisaPurchase(purchase);
        const bayar = Math.min(sisa, sisaHutang);
        sisa -= bayar;

        const newPayment = { date, note, amount: bayar };
        const updatedPayments = [...(purchase.payments || []), newPayment];
        await updateDoc(doc(db, "purchases", purchase.id), { payments: updatedPayments });
        alokasi.push({
          tanggal: purchase.createdAt || "-",
          material: purchaseMaterialsSummary(purchase),
          bayar,
        });
      }

      const info = alokasi.map(a => `${a.tanggal} - ${a.material}: ${rupiah(a.bayar)}`).join("\n");
      const sisaMsg = sisa > 0 ? `\n\nSisa ${rupiah(sisa)} tidak dialokasikan (semua hutang supplier sudah lunas).` : "";
      addAuditLog("Pembayaran Supplier", `${supplierPayForm.supplier} - ${rupiah(supplierPaymentAmount)}`);
      alert(`✅ Pembayaran supplier dialokasikan:\n${info}${sisaMsg}`);

      setSupplierPayForm({ supplier: "", date: todayStr(), note: "", amount: 0 });
      setModal(null);
    } catch (e) { alert("Gagal menyimpan: " + e.message); }
    finally { setIsSaving(false); }
  }

  function deleteItem(type, id) { setConfirmDelete({ type, id }); }

  async function confirmDeleteAction() {
    if (!confirmDelete) return;
    const { type, id } = confirmDelete;
    setConfirmDelete(null);
    let oldPurchase = null;
    let stockRolledBack = false;
    try {
      if (type === "purchases") {
        oldPurchase = purchases.find((p) => p.id === id) || null;
        if (oldPurchase) {
          await rollbackPurchaseStock(oldPurchase);
          stockRolledBack = true;
        }
      }

      await deleteDoc(doc(db, type, id));
      addAuditLog("Hapus Data", `${type} - ${id}`);
    }
    catch (e) {
      // Jika delete purchase gagal setelah stok di-rollback, kembalikan stok agar data tetap sinkron.
      try {
        if (type === "purchases" && oldPurchase && stockRolledBack) {
          await applyPurchaseStock(oldPurchase);
        }
      } catch (restoreErr) {
        console.warn("Restore stok setelah gagal hapus purchase gagal:", restoreErr);
      }
      alert("Gagal menghapus: " + e.message);
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
        price: moneyValue(it.price || 0),
        bahanCost: moneyValue(it.bahanCost || 0),
        hppPerPcs: moneyValue(it.hppPerPcs || 0),
        mainMaterial: it.mainMaterial || "",
        materialQtyPerPcs: Number(it.materialQtyPerPcs || 0),
        unit: it.unit === "kg" ? "kg" : "yard",
      }))
      .filter((it) => it.name && it.qty > 0);

    if (cleanDeliveryItems.length === 0) return alert("Isi minimal 1 qty pengiriman hari ini.");

    const newDelivery = {
      date: tanggalKirim || todayStr(),
      items: cleanDeliveryItems,
      total: deliveryItemsTotal(cleanDeliveryItems),
    };

    const nextDeliveries = [...getDeliveryHistory(order), newDelivery];
    const tempOrder = { ...order, deliveries: nextDeliveries };
    const deliveredTotal = billableOrderTotal(tempOrder);
    const paid = (order.payments || []).reduce((sum, p) => sum + moneyValue(p.amount || 0), 0);
    const deliveryStatus = orderDeliveryStatus(tempOrder);
    const newStatus = paid >= deliveredTotal && deliveredTotal > 0 && deliveryStatus === "Selesai" ? "Lunas" : deliveryStatus;

    setIsSaving(true);
    const usage = buildMaterialUsageFromDeliveryItems(cleanDeliveryItems);
    let stockDeducted = false;
    try {
      if (usage.length > 0) {
        await applyMaterialMovements(usage, {
          direction: -1,
          refType: "delivery",
          refId: kirimModal,
          refLabel: order.invoice || order.customer || "Pengiriman",
          date: tanggalKirim || todayStr(),
          note: "Pemakaian bahan saat pengiriman produk",
        });
        stockDeducted = true;
      }

      await updateDoc(doc(db, "orders", kirimModal), {
        status: newStatus,
        tanggalKirim: tanggalKirim || todayStr(),
        deliveries: nextDeliveries,
        deliveredTotal,
        deliveredHppTotal: billableOrderHppTotal(tempOrder),
      });
      addAuditLog("Input Pengiriman", `${order.customer} - ${rupiah(deliveredTotal)}`);
      setKirimModal(null);
      setTanggalKirim(todayStr());
      setKirimItems([]);
    } catch (e) {
      // Jika stok sudah turun tapi order gagal update, kembalikan stok supaya tidak ada stok keluar tanpa delivery.
      try {
        if (stockDeducted && usage.length > 0) {
          await applyMaterialMovements(usage, {
            direction: 1,
            refType: "delivery_rollback",
            refId: kirimModal,
            refLabel: order.invoice || order.customer || "Rollback pengiriman",
            date: tanggalKirim || todayStr(),
            note: "Rollback stok karena simpan pengiriman gagal",
          });
        }
      } catch (rollbackErr) {
        console.warn("Rollback stok pengiriman gagal:", rollbackErr);
      }
      alert("Gagal menyimpan: " + e.message);
    }
    finally { setIsSaving(false); }
  }

  function openKirimModal(order) {
    const deliveryItems = normalizeShipmentItems(order).map((it, idx) => {
      const remaining = Math.max(Number(it.orderedQty || 0) - Number(it.shippedQty || 0), 0);
      return {
        itemIndex: idx,
        name: it.name,
        orderedQty: Number(it.orderedQty || 0),
        alreadyShipped: Number(it.shippedQty || 0),
        remainingQty: remaining,
        shippedQty: remaining,
        price: moneyValue(it.price || 0),
        bahanCost: moneyValue(it.bahanCost || 0),
        hppPerPcs: moneyValue(it.hppPerPcs || 0),
        mainMaterial: it.mainMaterial || "",
        materialQtyPerPcs: Number(it.materialQtyPerPcs || 0),
        unit: it.unit || "yard",
        note: it.note || shipmentAutoNote(Number(it.orderedQty || 0), Number(it.shippedQty || 0)),
      };
    });
    setKirimModal(order.id);
    setTanggalKirim(todayStr());
    setKirimItems(deliveryItems);
  }

  async function cekDanUpdateLunas(orderId, total, updatedPayments, orderRef = null) {
    const paid = updatedPayments.reduce((s, p) => s + moneyValue(p.amount || 0), 0);
    const complete = orderRef ? isDeliveryComplete(orderRef) : true;
    if (complete && paid >= moneyValue(total || 0) && moneyValue(total || 0) > 0) {
      try { await updateDoc(doc(db, "orders", orderId), { status: "Lunas" }); }
      catch (e) { /* silent */ }
    }
  }

  async function saveEdit() {
    if (!editData) return;
    setIsSaving(true);
    try {
      const { type, id } = editData;
      let payload = {};

      if (type === "orders") {
        const cleanItems = normalizeOrderItems(editData)
          .map((it) => ({
            productId: it.productId || "",
            name: (it.name || "").trim(),
            category: capitalizeWords(it.category || "Lainnya"),
            qty: Number(it.qty || 0),
            price: moneyValue(it.price || 0),
            bahanCost: moneyValue(it.bahanCost || 0),
            hppPerPcs: moneyValue(it.hppPerPcs || 0),
            mainMaterial: it.mainMaterial || "",
            materialQtyPerPcs: Number(it.materialQtyPerPcs || 0),
            unit: it.unit === "kg" ? "kg" : "yard",
          }))
          .filter((it) => it.name && it.qty > 0);
        const total = orderItemsTotal(cleanItems);
        const firstItem = cleanItems[0] || {};
        payload = {
          customer: capitalizeWords(editData.customer || ""),
          phone: editData.phone || "",
          items: cleanItems,
          item: firstItem.name || "",
          qty: cleanItems.reduce((s, it) => s + Number(it.qty || 0), 0),
          hargaPcs: moneyValue(firstItem.price || 0),
          total,
          status: editData.status || "Proses",
          createdAt: editData.createdAt || todayStr(),
        };
      } else if (type === "purchases") {
        const cleanMaterials = normalizePurchaseMaterials(editData)
          .map((it) => ({
            name: capitalizeWords(it.name || ""),
            category: it.category || "Kain",
            qty: Number(it.qty || 0),
            unit: it.unit === "kg" ? "kg" : "yard",
            total: moneyValue(it.total || 0),
            pricePerUnit: Number(it.qty || 0) > 0 ? moneyValue(it.total || 0) / Number(it.qty || 0) : 0,
          }))
          .filter((it) => it.name && it.qty > 0 && it.total > 0);

        const total = cleanMaterials.length > 0
          ? purchaseMaterialsTotal(cleanMaterials)
          : moneyValue(editData.total || 0);

        const firstMaterial = cleanMaterials[0] || {};

        payload = {
          supplier: editData.supplier || "",
          materials: cleanMaterials,
          material: cleanMaterials.map((it) => it.name).join(", ") || editData.material || "Bahan Baku",
          qty: cleanMaterials.map((it) => `${it.qty} ${it.unit}`).join(", ") || editData.qty || "",
          category: firstMaterial.category || editData.category || "Kain",
          total,
          createdAt: editData.createdAt || todayStr(),
        };
      } else if (type === "expenses") {
        payload = {
          category: editData.category || "",
          note: editData.note || "",
          amount: moneyValue(editData.amount || 0),
          date: editData.date || todayStr(),
        };
      }

      if (type !== "purchases") {
        await updateDoc(doc(db, type, id), payload);
        addAuditLog("Edit Data", `${type} - ${id}`);
        setEditData(null);
        return;
      }

      const oldPurchase = purchases.find((p) => p.id === id) || null;
      let oldStockRolledBack = false;
      let newStockApplied = false;
      try {
        if (oldPurchase) {
          await rollbackPurchaseStock(oldPurchase);
          oldStockRolledBack = true;
        }

        await updateDoc(doc(db, type, id), payload);

        await applyPurchaseStock({ ...editData, ...payload, id });
        newStockApplied = true;
      } catch (purchaseErr) {
        // Kompensasi agar stok dan purchase tidak beda arah jika salah satu langkah gagal.
        try {
          if (newStockApplied) await rollbackPurchaseStock({ ...editData, ...payload, id });
          if (oldPurchase) {
            await updateDoc(doc(db, type, id), {
              supplier: oldPurchase.supplier || "",
              materials: normalizePurchaseMaterials(oldPurchase),
              material: oldPurchase.material || normalizePurchaseMaterials(oldPurchase).map((it) => it.name).join(", "),
              qty: oldPurchase.qty || normalizePurchaseMaterials(oldPurchase).map((it) => `${it.qty} ${it.unit}`).join(", "),
              category: oldPurchase.category || "Kain",
              total: moneyValue(oldPurchase.total || 0),
              createdAt: oldPurchase.createdAt || todayStr(),
              payments: oldPurchase.payments || [],
            });
            if (oldStockRolledBack) await applyPurchaseStock(oldPurchase);
          }
        } catch (restoreErr) {
          console.warn("Restore edit supplier gagal:", restoreErr);
        }
        throw purchaseErr;
      }

      addAuditLog("Edit Data", `${type} - ${id}`);
      setEditData(null);
    } catch (e) { alert("Gagal menyimpan: " + e.message); }
    finally { setIsSaving(false); }
  }

  // ── Rekap (Bulanan / Tahunan / Semua) ──
  function buildRows(period) {
    const rows = [];
    orders.forEach((order) => {
      (order.payments || []).forEach((pay) => {
        if (period === "all" || samePeriod(pay.date, period))
          rows.push({ tanggal: pay.date, jenis: "Kas Masuk", nama: order.customer, keterangan: order.invoice, masuk: pay.amount, keluar: 0 });
      });
    });
    purchases.forEach((purchase) => {
      (purchase.payments || []).forEach((pay) => {
        if (period === "all" || samePeriod(pay.date, period))
          rows.push({ tanggal: pay.date, jenis: "Bayar Supplier", nama: purchase.supplier, keterangan: purchaseMaterialsSummary(purchase), masuk: 0, keluar: pay.amount });
      });
    });
    expenses.forEach((expense) => {
      if (period === "all" || samePeriod(expense.date, period))
        rows.push({ tanggal: expense.date, jenis: "Biaya", nama: expense.category, keterangan: expense.note, masuk: 0, keluar: expense.amount });
    });
    return rows.sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal));
  }

  function buildSupplierRows(period) {
    const rows = [];

    purchases
      .filter((purchase) => period === "all" || samePeriod(purchase.createdAt, period))
      .forEach((purchase) => {
        const sudahDibayar = purchasePaidTotal(purchase);
        const totalPurchase = moneyValue(purchase.total || 0);
        const sisaUtang = Math.max(0, totalPurchase - sudahDibayar);
        const bahanList = normalizePurchaseMaterials(purchase);

        let akumulasiDibayar = 0;
        let akumulasiSisa = 0;

        bahanList.forEach((bahan, idx) => {
          const proporsi = totalPurchase > 0 ? moneyValue(bahan.total || 0) / totalPurchase : 0;
          const isLast = idx === bahanList.length - 1;
          const dibayarBaris = isLast ? Math.max(0, sudahDibayar - akumulasiDibayar) : Math.round(sudahDibayar * proporsi);
          const sisaBaris = isLast ? Math.max(0, sisaUtang - akumulasiSisa) : Math.round(sisaUtang * proporsi);
          akumulasiDibayar += dibayarBaris;
          akumulasiSisa += sisaBaris;

          rows.push({
            tanggalBelanja: purchase.createdAt || "",
            supplier: purchase.supplier || "",
            jenisBahan: bahan.name || "Bahan Baku",
            kategori: bahan.category || "Kain",
            banyak: `${Number(bahan.qty || 0).toLocaleString("id-ID")} ${bahan.unit || "yard"}`,
            hargaSatuan: moneyValue(bahan.pricePerUnit || 0),
            totalBelanja: moneyValue(bahan.total || 0),
            sudahDibayar: dibayarBaris,
            sisaUtang: sisaBaris,
          });
        });
      });

    return rows.sort((a, b) => new Date(a.tanggalBelanja || 0) - new Date(b.tanggalBelanja || 0));
  }

  function downloadSupplierRekap(period) {
    const label = { month: "bulanan", year: "tahunan", all: "semua" }[period];
    const rows = buildSupplierRows(period);
    if (rows.length === 0) return alert("Tidak ada data supplier untuk periode ini.");
    const SEP = "\t";
    const totalBelanja = rows.reduce((s, r) => s + moneyValue(r.totalBelanja || 0), 0);
    const totalDibayar = rows.reduce((s, r) => s + moneyValue(r.sudahDibayar || 0), 0);
    const totalSisa = rows.reduce((s, r) => s + moneyValue(r.sisaUtang || 0), 0);
    const lines_out = [
      `Gallery Kerudung - Rekap Pembayaran Supplier ${label}`,
      "",
      ["Tanggal Belanja", "Supplier", "Jenis Bahan", "Banyak", "Total Belanja", "Sudah Dibayar", "Sisa Utang"].join(SEP),
      ...rows.map(r => [r.tanggalBelanja, r.supplier, r.jenisBahan, r.banyak, r.totalBelanja, r.sudahDibayar, r.sisaUtang].join(SEP)),
      "",
      ["", "", "", "TOTAL", totalBelanja, totalDibayar, totalSisa].join(SEP),
    ];
    const blob = new Blob(["\uFEFF" + lines_out.join("\n")], { type: "text/tab-separated-values;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `rekap-pembayaran-supplier-${label}.tsv`;
    link.click();
  }


  function buildCustomerRows(period) {
    const map = {};
    orders
      .filter((order) => period === "all" || samePeriod(order.createdAt, period))
      .forEach((order) => {
        const key = normalizeName(order.customer || "Tanpa Nama");
        const name = capitalizeWords(order.customer || "Tanpa Nama");
        const total = billableOrderTotal(order);
        const paid = (order.payments || []).reduce((s, p) => s + moneyValue(p.amount || 0), 0);
        const sisa = total - paid;

        if (!map[key]) {
          map[key] = {
            customer: name,
            jumlahPesanan: 0,
            totalTagihan: 0,
            sudahDibayar: 0,
            sisaTagihan: 0,
            invoices: [],
          };
        }

        map[key].jumlahPesanan += 1;
        map[key].totalTagihan += total;
        map[key].sudahDibayar += paid;
        map[key].sisaTagihan += sisa;
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
    pdf.setFontSize(16);
    pdf.setFont("helvetica", "bold");
    pdf.text("Gallery Kerudung", 14, 12);
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.text("made by order", 14, 19);
    pdf.setTextColor(30, 41, 59);
    pdf.setFontSize(14);
    pdf.setFont("helvetica", "bold");
    pdf.text(title, 14, 40);
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.text(`Periode: ${pdfPeriodLabel(period)}`, 14, 47);
    pdf.text(`Dicetak: ${new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}`, 14, 53);
  }

  function downloadSupplierRekapPdf(period) {
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
      head: [["Tanggal", "Supplier", "Jenis Bahan", "Banyak", "Total", "Dibayar", "Sisa Utang"]],
      body: rows.map((r) => [
        r.tanggalBelanja || "-",
        r.supplier || "-",
        r.jenisBahan || "-",
        r.banyak || "-",
        rupiah(r.totalBelanja),
        rupiah(r.sudahDibayar),
        rupiah(r.sisaUtang),
      ]),
      foot: [["", "", "", "TOTAL", rupiah(totalBelanja), rupiah(totalDibayar), rupiah(totalSisa)]],
      theme: "grid",
      headStyles: { fillColor: [168, 85, 247], textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [253, 242, 248], textColor: [190, 24, 93], fontStyle: "bold" },
      styles: { fontSize: 8, cellPadding: 2 },
      columnStyles: {
        4: { halign: "right" },
        5: { halign: "right" },
        6: { halign: "right" },
      },
    });

    pdf.save(`rekap-supplier-${label}.pdf`);
  }

  function downloadCustomerRekapPdf(period) {
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
      body: rows.map((r) => [
        r.customer || "-",
        r.jumlahPesanan,
        r.invoices.slice(0, 4).join(", ") + (r.invoices.length > 4 ? "..." : ""),
        rupiah(r.totalTagihan),
        rupiah(r.sudahDibayar),
        rupiah(r.sisaTagihan),
      ]),
      foot: [["TOTAL", rows.reduce((s, r) => s + Number(r.jumlahPesanan || 0), 0), "", rupiah(totalTagihan), rupiah(totalDibayar), rupiah(totalSisa)]],
      theme: "grid",
      headStyles: { fillColor: [236, 72, 153], textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [253, 242, 248], textColor: [190, 24, 93], fontStyle: "bold" },
      styles: { fontSize: 8, cellPadding: 2 },
      columnStyles: {
        3: { halign: "right" },
        4: { halign: "right" },
        5: { halign: "right" },
      },
    });

    pdf.save(`rekap-customer-${label}.pdf`);
  }

  function downloadFinancialRekapPdf(period) {
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
      body: rows.map((r) => [
        r.tanggal || "-",
        r.jenis || "-",
        r.nama || "-",
        r.keterangan || "-",
        Number(r.masuk || 0) > 0 ? rupiah(r.masuk) : "-",
        Number(r.keluar || 0) > 0 ? rupiah(r.keluar) : "-",
      ]),
      foot: [["", "", "", "TOTAL", rupiah(totalMasuk), rupiah(totalKeluar)]],
      theme: "grid",
      headStyles: { fillColor: [236, 72, 153], textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [253, 242, 248], textColor: [190, 24, 93], fontStyle: "bold" },
      styles: { fontSize: 8, cellPadding: 2 },
      columnStyles: {
        4: { halign: "right" },
        5: { halign: "right" },
      },
    });

    const finalY = pdf.lastAutoTable?.finalY || 70;
    pdf.setFontSize(11);
    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(saldo >= 0 ? 5 : 225, saldo >= 0 ? 150 : 29, saldo >= 0 ? 105 : 72);
    pdf.text(`Saldo Bersih: ${rupiah(saldo)}`, 14, Math.min(finalY + 12, 285));

    pdf.save(`rekap-keuangan-${label}.pdf`);
  }

  function downloadExcel(filename, rows, period) {
    const label = { month: "Bulanan", year: "Tahunan", all: "Semua Data" }[period] || "";
    const today = new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
    const totalMasuk = rows.reduce((s, r) => s + Number(r.masuk || 0), 0);
    const totalKeluar = rows.reduce((s, r) => s + Number(r.keluar || 0), 0);
    const saldo = totalMasuk - totalKeluar;
    const SEP = "\t";
    const lines_out = [
      `Gallery Kerudung - Rekap ${label}`,
      `Dicetak: ${today}\tTotal: ${rows.length} transaksi`,
      "",
      ["Tanggal","Jenis","Nama","Keterangan","Kas Masuk","Kas Keluar"].join(SEP),
      ...rows.map(r => [r.tanggal||"", r.jenis||"", r.nama||"", r.keterangan||"", r.masuk > 0 ? r.masuk : "", r.keluar > 0 ? r.keluar : ""].join(SEP)),
      "",
      ["","","","TOTAL", totalMasuk, totalKeluar].join(SEP),
      ["","","","SALDO BERSIH", saldo, ""].join(SEP),
    ];
    const blob = new Blob(["\uFEFF" + lines_out.join("\n")], { type: "text/tab-separated-values;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename.replace(".xls","").replace(".csv","") + ".tsv";
    link.click();
  }

  function downloadRekap(period) {
    downloadFinancialRekapPdf(period);
  }

  function doDownloadRekap() {
    if (!rekapConfirm) return;
    downloadFinancialRekapPdf(rekapConfirm);
    setRekapConfirm(null);
  }

  function addAuditLog(action, detail = "") {
    try {
      const next = [{
        time: new Date().toLocaleString("id-ID"),
        action,
        detail,
        user: user?.email || "-",
      }, ...auditLogs].slice(0, 50);
      setAuditLogs(next);
      localStorage.setItem("gk_audit_logs", JSON.stringify(next));
    } catch (e) {
      // audit log tidak boleh mengganggu transaksi utama
    }
  }

  function openOrderModal(prefill = null) {
    if (prefill) setOrderForm(prefill);
    setModal("order");
  }

  function resetOrderDraft() {
    const blank = { date: todayStr(), customer: "", phone: "", items: [emptyOrderItem()], dp: 0 };
    setOrderForm(blank);
    try { localStorage.removeItem("gk_order_draft"); } catch (e) {}
  }

  function duplicateOrder(order) {
    const items = normalizeOrderItems(order).map((it) => ({
      name: it.name || "",
      category: it.category || "Lainnya",
      qty: it.qty || "",
      price: moneyValue(it.price || 0),
      bahanCost: moneyValue(it.bahanCost || 0),
      hppPerPcs: moneyValue(it.hppPerPcs || 0),
      mainMaterial: it.mainMaterial || "",
      materialQtyPerPcs: it.materialQtyPerPcs || 0,
      unit: it.unit || "yard",
    }));
    openOrderModal({
      date: todayStr(),
      customer: order.customer || "",
      phone: order.phone || "",
      items: items.length > 0 ? items : [emptyOrderItem()],
      dp: 0,
    });
  }

  function shareOrderWhatsApp(order) {
    const phone = String(order.phone || "").replace(/\D/g, "").replace(/^0/, "62");
    const paid = orderPaidTotal(order);
    const total = billableOrderTotal(order);
    const sisa = total - paid;
    const items = normalizeShipmentItems(order)
      .map((it) => `- ${it.name}: kirim ${Number(it.shippedQty || 0)}/${Number(it.orderedQty || 0)} pcs x ${rupiah(it.price)}`)
      .join("\n");
    const text = [
      `Halo Kak ${order.customer || ""},`,
      `Invoice: ${order.invoice || "-"}`,
      items,
      `Total tagihan: ${rupiah(total)}`,
      `Sudah dibayar: ${rupiah(paid)}`,
      sisa > 0 ? `Sisa: ${rupiah(sisa)}` : `Status: Lunas`,
      `Terima kasih 🙏`,
    ].filter(Boolean).join("\n");
    const encodedText = encodeURIComponent(text);
    const url = phone ? `https://wa.me/${phone}?text=${encodedText}` : `https://wa.me/?text=${encodedText}`;
    window.open(url, "_blank");
  }

  const businessSummary = useMemo(() => {
    const totalPesananAwal = orders.reduce((s, o) => s + moneyValue(o.total || 0), 0);
    const totalRealisasi = orders.reduce((s, o) => s + billableOrderTotal(o), 0);
    const totalPembayaranCustomer = orders.reduce((s, o) => s + (o.payments || []).reduce((a, p) => a + moneyValue(p.amount || 0), 0), 0);
    const totalBelanjaSupplier = purchases.reduce((s, p) => s + moneyValue(p.total || 0), 0);
    const totalBayarSupplier = purchases.reduce((s, p) => s + (p.payments || []).reduce((a, x) => a + moneyValue(x.amount || 0), 0), 0);
    const totalPengeluaran = expenses.reduce((s, e) => s + moneyValue(e.amount || 0), 0);
    const nilaiStok = materialsStock.reduce((s, m) => s + moneyValue(m.totalValue || 0), 0);
    const hppDariProduk = orders.reduce((s, o) => s + billableOrderHppTotal(o), 0);
    const hppBelumLengkap = orders.some((o) => normalizeShipmentItems(o).some((it) => Number(it.shippedQty || 0) > 0 && moneyValue(it.hppPerPcs || 0) <= 0));
    // Kalau produk belum punya HPP, fallback ke estimasi: belanja supplier - nilai stok.
    const estimasiHppBahanTerpakai = hppDariProduk > 0 ? hppDariProduk : Math.max(0, totalBelanjaSupplier - nilaiStok);
    const labaKotor = totalRealisasi - estimasiHppBahanTerpakai;
    const labaBersih = totalRealisasi - estimasiHppBahanTerpakai - totalPengeluaran;
    const cashflowBersih = totalPembayaranCustomer - totalBayarSupplier - totalPengeluaran;
    const piutang = orders.reduce((s, o) => s + Math.max(0, billableOrderTotal(o) - orderPaidTotal(o)), 0);
    const hutangSupplier = purchases.reduce((s, p) => s + Math.max(0, sisaPurchase(p)), 0);
    const stokKritis = materialsStock.filter((m) => Number(m.minStock || 0) > 0 && Number(m.stock || 0) <= Number(m.minStock || 0));
    const customerBelumLunas = uniqueCustomers.filter((c) => Number(c.totalSisa || 0) > 0);
    const supplierBelumLunas = uniqueSuppliers.filter((s) => Number(s.totalSisa || 0) > 0);

    return {
      totalPesananAwal, totalRealisasi, totalPembayaranCustomer, totalBelanjaSupplier,
      totalBayarSupplier, totalPengeluaran, nilaiStok, estimasiHppBahanTerpakai, hppBelumLengkap, labaKotor, labaBersih, cashflowBersih,
      piutang, hutangSupplier, stokKritis, customerBelumLunas, supplierBelumLunas,
    };
  }, [orders, purchases, expenses, materialsStock, uniqueCustomers, uniqueSuppliers]);

  const topCustomers = useMemo(() => {
    const map = {};
    orders.forEach((o) => {
      const key = normalizeName(o.customer || "");
      if (!key) return;
      if (!map[key]) map[key] = { name: capitalizeWords(o.customer || ""), count: 0, total: 0 };
      map[key].count += 1;
      map[key].total += moneyValue(o.total || 0);
    });
    return Object.values(map).sort((a, b) => b.count - a.count || b.total - a.total).slice(0, 6);
  }, [orders]);

  const topProducts = useMemo(() => {
    const map = {};
    orders.forEach((o) => normalizeOrderItems(o).forEach((it) => {
      const key = normalizeName(it.name || "");
      if (!key) return;
      if (!map[key]) map[key] = { name: it.name, qty: 0, total: 0 };
      map[key].qty += Number(it.qty || 0);
      map[key].total += Number(it.qty || 0) * moneyValue(it.price || 0);
    }));
    return Object.values(map).sort((a, b) => b.qty - a.qty || b.total - a.total).slice(0, 6);
  }, [orders]);

  const productProfitSummary = useMemo(() => {
    const map = {};
    orders.forEach((o) => normalizeShipmentItems(o).forEach((it) => {
      const qty = Number(it.shippedQty || 0);
      if (qty <= 0) return;
      const key = normalizeName(it.name || "Produk");
      const revenue = qty * moneyValue(it.price || 0);
      const hppPerPcs = moneyValue(it.hppPerPcs || 0);
      const hpp = qty * hppPerPcs;
      if (!map[key]) map[key] = { name: it.name || "Produk", qty: 0, revenue: 0, hpp: 0, laba: 0, missingHpp: 0 };
      map[key].qty += qty;
      map[key].revenue += revenue;
      map[key].hpp += hpp;
      map[key].laba += revenue - hpp;
      if (hppPerPcs <= 0) map[key].missingHpp += qty;
    }));
    return Object.values(map).sort((a, b) => b.laba - a.laba).slice(0, 5);
  }, [orders]);

  function exportBackupJson() {
    const payload = {
      app: "Gallery Kerudung",
      exportedAt: new Date().toISOString(),
      exportedBy: user?.email || "-",
      version: "backup-manual-v1",
      orders, purchases, expenses, materialsStock, productMasters, productCategories, auditLogs,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `backup-gallery-kerudung-${todayStr()}.json`;
    link.click();
    addAuditLog("Backup JSON", "Export semua data bisnis");
  }

  function exportBackupTsv() {
    const SEP = "\t";
    const lines = [
      "Gallery Kerudung - Backup Ringkas",
      `Tanggal Export${SEP}${new Date().toLocaleString("id-ID")}`,
      `User${SEP}${user?.email || "-"}`,
      "",
      "RINGKASAN",
      ["Total Realisasi", businessSummary.totalRealisasi].join(SEP),
      ["Pembayaran Customer", businessSummary.totalPembayaranCustomer].join(SEP),
      ["Belanja Supplier", businessSummary.totalBelanjaSupplier].join(SEP),
      ["Bayar Supplier", businessSummary.totalBayarSupplier].join(SEP),
      ["Pengeluaran", businessSummary.totalPengeluaran].join(SEP),
      ["Estimasi HPP Bahan Terpakai", businessSummary.estimasiHppBahanTerpakai].join(SEP),
      ["Laba Bersih", businessSummary.labaBersih].join(SEP),
      ["Cashflow Bersih", businessSummary.cashflowBersih].join(SEP),
      ["Piutang", businessSummary.piutang].join(SEP),
      ["Hutang Supplier", businessSummary.hutangSupplier].join(SEP),
      "",
      "PESANAN",
      ["Tanggal", "Invoice", "Customer", "Total Pesanan", "Total Realisasi", "Dibayar", "Sisa", "Status"].join(SEP),
      ...orders.map((o) => [o.createdAt || "", o.invoice || "", o.customer || "", moneyValue(o.total || 0), billableOrderTotal(o), orderPaidTotal(o), sisaOrder(o), o.status || ""].join(SEP)),
      "",
      "SUPPLIER",
      ["Tanggal", "Supplier", "Bahan", "Total", "Dibayar", "Sisa"].join(SEP),
      ...purchases.map((p) => [p.createdAt || "", p.supplier || "", purchaseMaterialsSummary(p), moneyValue(p.total || 0), (p.payments || []).reduce((s, x) => s + moneyValue(x.amount || 0), 0), sisaPurchase(p)].join(SEP)),
      "",
      "PENGELUARAN",
      ["Tanggal", "Kategori", "Catatan", "Nominal"].join(SEP),
      ...expenses.map((e) => [e.date || "", e.category || "", e.note || "", moneyValue(e.amount || 0)].join(SEP)),
    ];
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/tab-separated-values;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `backup-ringkas-gallery-kerudung-${todayStr()}.tsv`;
    link.click();
    addAuditLog("Backup Excel/TSV", "Export ringkasan, pesanan, supplier, pengeluaran");
  }

  function downloadLabaRugiPdf() {
    const pdf = new jsPDF("p", "mm", "a4");
    addPdfHeader(pdf, "Laporan Laba Rugi & Cashflow", "all");
    const rows = [
      ["Total Pesanan Awal", rupiah(businessSummary.totalPesananAwal)],
      ["Total Realisasi Kirim", rupiah(businessSummary.totalRealisasi)],
      ["Total Belanja Supplier", rupiah(businessSummary.totalBelanjaSupplier)],
      ["Nilai Stok Bahan", rupiah(businessSummary.nilaiStok)],
      ["Estimasi HPP Bahan Terpakai", rupiah(businessSummary.estimasiHppBahanTerpakai)],
      ["Total Pengeluaran Operasional", rupiah(businessSummary.totalPengeluaran)],
      ["Laba Kotor", rupiah(businessSummary.labaKotor)],
      ["Laba Bersih", rupiah(businessSummary.labaBersih)],
      ["Pembayaran Customer Masuk", rupiah(businessSummary.totalPembayaranCustomer)],
      ["Pembayaran Supplier Keluar", rupiah(businessSummary.totalBayarSupplier)],
      ["Cashflow Bersih", rupiah(businessSummary.cashflowBersih)],
      ["Piutang Customer", rupiah(businessSummary.piutang)],
      ["Hutang Supplier", rupiah(businessSummary.hutangSupplier)],
    ];
    autoTable(pdf, {
      startY: 62,
      head: [["Keterangan", "Nominal"]],
      body: rows,
      theme: "grid",
      headStyles: { fillColor: [236, 72, 153], textColor: 255, fontStyle: "bold" },
      styles: { fontSize: 10, cellPadding: 3 },
      columnStyles: { 1: { halign: "right" } },
    });
    pdf.save(`laporan-laba-rugi-cashflow-${todayStr()}.pdf`);
    addAuditLog("Download Laba Rugi PDF", "Export laporan bisnis lengkap");
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
      <div className="absolute top-10 left-6 text-3xl opacity-40">✨</div>
      <div className="absolute top-20 right-8 text-2xl opacity-30">💕</div>
      <div className="absolute bottom-20 left-10 text-2xl opacity-30">🌸</div>
      <div className="absolute bottom-10 right-6 text-3xl opacity-40">⭐</div>
      <div className="w-full max-w-sm rounded-3xl bg-white/80 backdrop-blur p-8 shadow-xl text-center"
        style={{ border: "1.5px solid #f9a8d4" }}>
        <div className="mb-2 text-4xl">🧕✨</div>
        <div className="mb-1 text-3xl font-bold"
          style={{ background: "linear-gradient(135deg, #ec4899, #a855f7)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          Gallery Kerudung
        </div>
        <div className="mb-6 text-sm font-medium" style={{ color: "#c084fc" }}>💕 made by order 💕</div>
        {authError && <div className="mb-4 rounded-2xl bg-rose-50 p-3 text-sm text-rose-500 border border-rose-100">{authError}</div>}
        <button onClick={handleLogin}
          className="flex w-full items-center justify-center gap-3 rounded-2xl px-6 py-4 font-bold text-white shadow-lg transition-all active:scale-95"
          style={{ background: "linear-gradient(135deg, #ec4899, #a855f7)" }}>
          <svg width="20" height="20" viewBox="0 0 48 48">
            <path fill="#FFC107" d="M43.6 20H24v8h11.3C33.6 32.8 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1L37 9.9C33.5 6.7 29 4.8 24 4.8 12.9 4.8 4 13.7 4 24.8s8.9 20 20 20c11 0 19.5-7.7 19.5-20 0-1.3-.1-2.6-.3-3.8z"/>
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.4 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1L37 9.9C33.5 6.7 29 4.8 24 4.8c-7.5 0-14 4.2-17.7 9.9z"/>
            <path fill="#4CAF50" d="M24 44c4.9 0 9.3-1.8 12.7-4.6l-5.9-4.9C29 36.3 26.6 37 24 37c-5.3 0-9.6-3.2-11.3-7.8L6 34.2C9.7 39.8 16.3 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20H24v8h11.3c-.9 2.4-2.5 4.4-4.6 5.8l5.9 4.9C40.2 35.2 44 30.4 44 24c0-1.3-.1-2.6-.4-4z"/>
          </svg>
          Masuk dengan Google
        </button>
        <p className="mt-4 text-xs" style={{ color: "#c084fc" }}>✨ Hanya akun yang diizinkan ✨</p>
      </div>
    </div>
  );

  return (
    <div className="mx-auto min-h-screen max-w-md" style={{ background: "#fdf2f8" }}>
      {/* Header */}
      <div className="p-5 text-white relative overflow-hidden"
        style={{ background: "linear-gradient(135deg, #ec4899 0%, #a855f7 100%)" }}>
        <div className="absolute top-2 right-24 text-2xl opacity-20">✨</div>
        <div className="absolute bottom-8 left-4 text-xl opacity-20">💕</div>
        <div className="flex items-center justify-between relative z-10">
          <div>
            <div className="text-3xl font-bold tracking-tight">Gallery Kerudung</div>
            <div className="mt-1 text-sm font-medium opacity-80">💕 made by order ✨</div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <img src="/logo-gk.png" className="h-16 w-16 rounded-2xl shadow-lg" alt="logo"
              style={{ border: "2px solid rgba(255,255,255,0.4)" }} />
            <button onClick={handleLogout} className="rounded-full px-3 py-1 text-xs font-semibold text-white"
              style={{ background: "rgba(255,255,255,0.25)" }}>Keluar</button>
          </div>
        </div>
        <div className="mt-4 rounded-2xl px-4 py-3 flex items-center gap-3 relative z-10"
          style={{ background: "rgba(255,255,255,0.2)" }}>
          <span>🔍</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari pesanan, supplier, biaya..."
            className="bg-transparent outline-none flex-1 text-white placeholder-pink-100 text-sm" />
          {search && <button onClick={() => setSearch("")} className="text-pink-200 font-bold">✕</button>}
        </div>
      </div>

      <TabBar tab={tab} setTab={setTab} badgeCount={pesananTelat.length} />

      {loading && <div className="flex justify-center py-10 text-slate-400">Memuat data...</div>}

      {firestoreError && (
        <div className="mx-4 mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 whitespace-pre-line">
          <div className="font-bold mb-1">Data gagal dimuat dari Firebase</div>
          <div>{firestoreError}</div>
          <div className="mt-2 text-xs text-rose-500">Cek Firestore Rules, koneksi internet, dan konfigurasi firebase.js.</div>
        </div>
      )}

      {/* ── DASHBOARD ── */}
      {!loading && tab === "dashboard" && (
        <>
          <div className="grid grid-cols-4 gap-2 p-4 pb-0">
            <button onClick={() => openOrderModal()} className="rounded-2xl bg-white p-3 text-xs font-bold shadow-sm" style={{ color: "#ec4899", border: "1.5px solid #f9a8d4" }}>+ Pesanan</button>
            <button onClick={() => setModal("purchase")} className="rounded-2xl bg-white p-3 text-xs font-bold shadow-sm" style={{ color: "#7c3aed", border: "1.5px solid #c4b5fd" }}>+ Belanja</button>
            <button onClick={() => setModal("pay")} className="rounded-2xl bg-white p-3 text-xs font-bold shadow-sm" style={{ color: "#059669", border: "1.5px solid #bbf7d0" }}>+ Bayar</button>
            <button onClick={() => setTab("orders")} className="rounded-2xl bg-white p-3 text-xs font-bold shadow-sm" style={{ color: "#0284c7", border: "1.5px solid #bae6fd" }}>🚚 Kirim</button>
          </div>
          {pesananTelat.length > 0 && (
            <div className="mx-4 mt-4 rounded-2xl bg-rose-50 border border-rose-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">🔔</span>
                <span className="font-bold text-rose-700">{pesananTelat.length} Pesanan Belum Bayar 7+ Hari</span>
              </div>
              <div className="space-y-2">
                {pesananTelat.map((o) => (
                  <div key={o.id} className="flex justify-between items-center bg-white rounded-xl px-3 py-2">
                    <div>
                      <div className="font-semibold text-sm text-slate-800">{o.customer}</div>
                      <div className="text-xs text-slate-400">{o.invoice}</div>
                    </div>
                    <div className="text-sm font-bold text-rose-600">{rupiah(sisaOrder(o))}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 p-4">
            <Card title="Kas Masuk" value={stats.customerPaid} note="Cicilan pelanggan" bg="bg-emerald-50" icon="💚" />
            <Card title="Kas Keluar" value={stats.cashOut} note="Supplier + biaya" bg="bg-pink-50" icon="🌸" />
            <Card title="Piutang" value={stats.receivable} note="Tagihan pelanggan" bg="bg-purple-50" icon="💜" />
            <Card title="Hutang Supplier" value={stats.supplierDebt} note="Bahan baku" bg="bg-yellow-50" icon="⭐" />
          </div>

          <div className="px-4 pb-4">
            <div className="rounded-3xl p-5 shadow-sm relative overflow-hidden"
              style={{ background: "linear-gradient(135deg, #fdf2f8, #ede9fe)", border: "1.5px solid #f9a8d4" }}>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold" style={{ color: "#a855f7" }}>✨ Saldo Cashflow</div>
                <span className="text-xs font-bold px-2 py-1 rounded-full"
                  style={{ background: stats.netCash >= 0 ? "#dcfce7" : "#fee2e2", color: stats.netCash >= 0 ? "#059669" : "#e11d48" }}>
                  {stats.netCash >= 0 ? "✅ POSITIF" : "⚠️ MINUS"}
                </span>
              </div>
              <div className="mt-3 text-5xl font-bold"
                style={{ color: stats.netCash >= 0 ? "#059669" : "#e11d48" }}>
                {stats.netCash < 0 ? "-" : ""}{rupiah(Math.abs(stats.netCash))}
              </div>
              {stats.netCash < 0 && (
                <div className="mt-2 rounded-xl p-2 text-xs font-semibold"
                  style={{ background: "#fee2e2", color: "#e11d48" }}>
                  ⚠️ Kas keluar lebih besar {rupiah(Math.abs(stats.netCash))}
                </div>
              )}
              <div className="mt-2 text-xs" style={{ color: "#c084fc" }}>💕 Kas masuk dikurangi pembayaran supplier dan biaya lain</div>
            </div>
          </div>

          <GrafikKas orders={orders} purchases={purchases} expenses={expenses} />
          <GrafikPesanan orders={orders} />

          <div className="mx-4 mb-4 rounded-3xl bg-white p-5 shadow-sm" style={{ border: "1.5px solid #f9a8d4" }}>
            <div className="text-lg font-bold mb-1" style={{ color: "#ec4899" }}>📌 Ringkasan Bisnis</div>
            <div className="text-xs text-slate-400 mb-4">Laba rugi, stok kritis, dan reminder hutang/piutang</div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-2xl bg-emerald-50 p-3">
                <div className="text-xs text-slate-400">Laba Bersih</div>
                <div className={`text-lg font-bold ${businessSummary.labaBersih >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{rupiah(businessSummary.labaBersih)}</div>
              </div>
              <div className="rounded-2xl bg-purple-50 p-3">
                <div className="text-xs text-slate-400">Nilai Stok</div>
                <div className="text-lg font-bold text-purple-600">{rupiah(businessSummary.nilaiStok)}</div>
              </div>
              <div className="rounded-2xl bg-rose-50 p-3">
                <div className="text-xs text-slate-400">Customer Belum Lunas</div>
                <div className="text-lg font-bold text-rose-600">{businessSummary.customerBelumLunas.length}</div>
              </div>
              <div className="rounded-2xl bg-orange-50 p-3">
                <div className="text-xs text-slate-400">Supplier Belum Lunas</div>
                <div className="text-lg font-bold text-orange-600">{businessSummary.supplierBelumLunas.length}</div>
              </div>
            </div>
            {businessSummary.stokKritis.length > 0 && (
              <div className="mt-4 rounded-2xl bg-rose-50 p-3 border border-rose-100">
                <div className="font-bold text-rose-600 text-sm mb-2">⚠️ Stok bahan kritis</div>
                {businessSummary.stokKritis.slice(0, 5).map((m) => (
                  <div key={m.id} className="flex justify-between text-xs text-slate-600">
                    <span>{m.name}</span>
                    <span className="font-bold text-rose-600">{Number(m.stock || 0).toLocaleString("id-ID")} {m.unit || "yard"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {productProfitSummary.length > 0 && (
            <div className="mx-4 mb-4 rounded-3xl bg-white p-5 shadow-sm" style={{ border: "1.5px solid #bbf7d0" }}>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-lg font-bold text-emerald-700">🏆 Laba per Produk</div>
                  <div className="text-xs text-slate-400">Berdasarkan produk yang sudah dikirim</div>
                </div>
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">Top {productProfitSummary.length}</span>
              </div>
              <div className="space-y-2">
                {productProfitSummary.map((p) => {
                  const margin = p.revenue > 0 ? Math.round((p.laba / p.revenue) * 100) : 0;
                  return (
                    <div key={p.name} className="rounded-2xl bg-slate-50 p-3">
                      <div className="flex justify-between gap-3">
                        <div>
                          <div className="font-bold text-slate-800 text-sm">{p.name}</div>
                          <div className="text-xs text-slate-400">Terjual {p.qty} pcs · margin {margin}%</div>
                          {p.missingHpp > 0 && <div className="mt-1 text-xs font-semibold text-amber-600">⚠️ {p.missingHpp} pcs belum punya HPP</div>}
                        </div>
                        <div className={`font-bold ${p.laba >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{rupiah(p.laba)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
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
            <select className="flex-1 rounded-2xl border px-3 py-2 text-sm bg-white outline-none"
              style={{ borderColor: "#f9a8d4", minWidth: 100 }}
              value={filterOrder} onChange={(e) => setFilterOrder(e.target.value)}>
              <option value="semua">Semua</option>
              <option value="belum-kirim">Belum Kirim</option>
              <option value="sebagian">Sebagian</option>
              <option value="belum-lunas">Belum Lunas</option>
              <option value="selesai">Selesai</option>
              <option value="lunas">Lunas</option>
            </select>
            <select className="flex-1 rounded-2xl border px-3 py-2 text-sm bg-white outline-none"
              style={{ borderColor: "#f9a8d4", minWidth: 100 }}
              value={sortOrder} onChange={(e) => setSortOrder(e.target.value)}>
              <option value="terbaru">Terbaru</option>
              <option value="terlama">Terlama</option>
              <option value="customer">Per Customer</option>
            </select>
          </div>

          {/* Ringkasan per customer */}
          {sortOrder === "customer" && uniqueCustomers
            .filter(c => filteredOrders.some(o => normalizeName(o.customer) === normalizeName(c.name)))
            .filter(c => filterOrder === "belum-lunas" ? c.pesananAktif > 0 : true)
            .map(c => (
              <div key={c.name} className="rounded-2xl p-3 mb-1"
                style={{ background: "linear-gradient(135deg,#fdf2f8,#ede9fe)", border: "1.5px solid #f9a8d4" }}>
                <div className="flex justify-between items-center">
                  <div className="font-bold text-sm" style={{ color: "#ec4899" }}>👤 {c.name}</div>
                  <div className="text-xs font-semibold" style={{ color: "#a855f7" }}>{c.totalPesanan} pesanan</div>
                </div>
                {c.pesananAktif > 0 && (
                  <div className="flex justify-between mt-1">
                    <span className="text-xs" style={{ color: "#64748b" }}>{c.pesananAktif} belum lunas</span>
                    <span className="text-xs font-bold" style={{ color: "#e11d48" }}>sisa {rupiah(c.totalSisa)}</span>
                  </div>
                )}
              </div>
            ))}

          {(() => {
            let list = [...filteredOrders];
            if (filterOrder === "belum-kirim") list = list.filter(o => orderDeliveryStatus(o) === "Proses");
            if (filterOrder === "sebagian") list = list.filter(o => orderDeliveryStatus(o) === "Dikirim Sebagian");
            if (filterOrder === "belum-lunas") list = list.filter(o => sisaOrder(o) > 0);
            if (filterOrder === "selesai") list = list.filter(o => orderDeliveryStatus(o) === "Selesai");
            if (filterOrder === "lunas") list = list.filter(o => sisaOrder(o) <= 0);
            if (sortOrder === "terbaru") list.sort((a, b) => (b.createdAt||"").localeCompare(a.createdAt||""));
            if (sortOrder === "terlama") list.sort((a, b) => (a.createdAt||"").localeCompare(b.createdAt||""));
            if (sortOrder === "customer") list.sort((a, b) => (a.customer||"").localeCompare(b.customer||"") || (a.createdAt||"").localeCompare(b.createdAt||""));

            if (list.length === 0) return <div className="text-center py-10 text-slate-400">Tidak ada pesanan ditemukan</div>;

            return list.map((o) => {
              const paid = orderPaidTotal(o);
              const sisa = billableOrderTotal(o) - paid;
              return (
                <div key={o.id} className="rounded-3xl bg-white p-5 shadow-sm">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-bold text-lg">{o.customer}</div>
                      {o.phone && (
                        <a href={`https://wa.me/62${o.phone.replace(/^0/, "")}`} target="_blank" rel="noreferrer"
                          className="text-xs text-emerald-600 font-semibold">📱 WA {o.phone}</a>
                      )}
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
                              <div className="flex justify-between gap-2">
                                <span className="font-bold text-slate-700">{it.name}</span>
                                <span className="font-semibold text-purple-600">{rupiah(subtotal)}</span>
                              </div>
                              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-slate-500">
                                <span>Pesan {orderedQty} pcs</span>
                                <span>· Terkirim {shippedQty} pcs</span>
                                <span>· Sisa kirim {sisaKirim} pcs</span>
                                {selisih !== 0 && (
                                  <span className={selisih < 0 ? "font-bold text-rose-600" : "font-bold text-emerald-600"}>· Selisih {selisih} pcs</span>
                                )}
                              </div>
                              <div className={selisih < 0 ? "mt-1 text-rose-500" : selisih > 0 ? "mt-1 text-emerald-600" : "mt-1 text-slate-400"}>
                                {it.note || shipmentAutoNote(orderedQty, shippedQty)}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {o.createdAt && <div className="text-xs text-slate-400">📅 {o.createdAt}</div>}
                      <div className="mt-1"><StatusBadge status={o.status} /></div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold">{rupiah(billableOrderTotal(o))}</div>
                      {billableOrderTotal(o) !== moneyValue(o.total || 0) && <div className="text-xs text-slate-400">Pesanan {rupiah(o.total)}</div>}
                      {sisa >= 0 ? (
                        <div className="text-sm text-rose-500">Sisa {rupiah(sisa)}</div>
                      ) : (
                        <div className="text-sm text-emerald-600">Deposit {rupiah(Math.abs(sisa))}</div>
                      )}
                    </div>
                  </div>

                  {(o.payments || []).length > 0 && (
                    <div className="mt-3 rounded-2xl bg-slate-50 p-3 space-y-1">
                      <div className="text-xs font-semibold text-slate-500 mb-2">Riwayat Pembayaran</div>
                      {(o.payments || []).map((p, i) => (
                        <div key={i} className="flex justify-between text-sm">
                          <span className="text-slate-500">{p.date} · {p.note}</span>
                          <span className="font-semibold text-emerald-600">{rupiah(p.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 space-y-2">
                    {orderDeliveryStatus(o) !== "Selesai" && (
                      <button onClick={() => openKirimModal(o)}
                        className="w-full rounded-2xl bg-sky-600 py-2 text-sm font-semibold text-white">
                        🚚 Input Pengiriman
                      </button>
                    )}
                    {o.tanggalKirim && <div className="text-xs text-slate-400">🚚 Dikirim: {o.tanggalKirim}</div>}
                    {o.status === "Lunas" && <div className="text-xs text-emerald-600 font-semibold">✅ Lunas otomatis</div>}
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <Button className="bg-sky-600" onClick={() => setEditData({ type: "orders", ...o })}>Edit</Button>
                    <Button className="bg-violet-600" onClick={() => duplicateOrder(o)}>Duplikat</Button>
                    <Button className="bg-emerald-600" onClick={() => shareOrderWhatsApp(o)}>WA Invoice</Button>
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

          {filteredPurchases.length === 0 && <div className="text-center py-10 text-slate-400">Tidak ada data supplier</div>}

          {filteredPurchases.map((p) => {
            const paid = (p.payments || []).reduce((s, x) => s + moneyValue(x.amount || 0), 0);
            const sisa = moneyValue(p.total || 0) - paid;
            return (
              <div key={p.id} className="rounded-3xl bg-white p-5 shadow-sm">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-bold text-lg">{p.supplier}</div>
                    <div className="text-sm text-slate-500">{purchaseMaterialsSummary(p)}</div>
                    {p.createdAt && <div className="text-xs text-slate-400">📅 {p.createdAt}</div>}
                    <div className="mt-2 space-y-1">
                      {normalizePurchaseMaterials(p).slice(0, 4).map((it, i) => (
                        <div key={i} className="text-xs text-slate-500">• {it.name}: {it.qty} {it.unit} · {rupiah(it.total)}</div>
                      ))}
                      {normalizePurchaseMaterials(p).length > 4 && <div className="text-xs text-slate-400">+ {normalizePurchaseMaterials(p).length - 4} bahan lagi</div>}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold">{rupiah(p.total)}</div>
                    <div className="text-sm text-rose-500">Sisa hutang {rupiah(sisa)}</div>
                  </div>
                </div>
                {(p.payments || []).length > 0 && (
                  <div className="mt-3 rounded-2xl bg-slate-50 p-3 space-y-1">
                    <div className="text-xs font-semibold text-slate-500 mb-2">Riwayat Pembayaran</div>
                    {(p.payments || []).map((x, i) => (
                      <div key={i} className="flex justify-between text-sm">
                        <span className="text-slate-500">{x.date} · {x.note}</span>
                        <span className="font-semibold text-emerald-600">{rupiah(x.amount)}</span>
                      </div>
                    ))}
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
          {(!Array.isArray(filteredExpenses) || filteredExpenses.length === 0) && <div className="text-center py-10 text-slate-400">Tidak ada pengeluaran</div>}
          {(Array.isArray(filteredExpenses) ? filteredExpenses : []).map((e) => (
            <div key={e.id} className="rounded-3xl bg-white p-5 shadow-sm">
              <div className="flex justify-between items-start">
                <div>
                  <div className="font-bold">{e.category}</div>
                  <div className="text-sm text-slate-500">{e.date}</div>
                  {e.note && <div className="text-sm text-slate-400 mt-1">{e.note}</div>}
                </div>
                <div className="font-bold text-rose-600">{rupiah(e.amount)}</div>
              </div>
              <div className="mt-4 flex gap-2">
                <Button className="bg-sky-600 flex-1" onClick={() => setEditData({ type: "expenses", ...e })}>Edit</Button>
                <Button className="bg-rose-600 flex-1" onClick={() => deleteItem("expenses", e.id)}>Hapus</Button>
              </div>
            </div>
          ))}
        </div>
      )}


      {/* ── PRODUCTS TAB ── */}
      {!loading && tab === "products" && (
        <div className="space-y-4 p-4">
          <div className="rounded-3xl bg-white p-5 shadow-sm" style={{ border: "1.5px solid #c4b5fd" }}>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="text-lg font-bold" style={{ color: "#7c3aed" }}>🏷️ Template Produk</div>
                <div className="text-xs text-slate-400">Setup sekali, pesanan harian tinggal pilih produk.</div>
              </div>
              <Button onClick={() => setModal("product")} className="text-xs" style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>+ Produk</Button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-2xl bg-purple-50 p-3">
                <div className="text-slate-400">Total Produk</div>
                <div className="text-xl font-bold text-purple-600">{productMasters.length}</div>
              </div>
              <div className="rounded-2xl bg-emerald-50 p-3">
                <div className="text-slate-400">Aktif</div>
                <div className="text-xl font-bold text-emerald-600">{productMasters.filter(p => p.isActive !== false).length}</div>
              </div>
            </div>
          </div>

          {filteredProductMasters.length === 0 && <div className="text-center py-10 text-slate-400">Belum ada template produk</div>}

          {filteredProductMasters
            .slice()
            .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
            .map((p) => {
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
                      <div className="flex justify-between gap-2">
                        <div className="font-bold text-slate-800 truncate">{p.name}</div>
                        <span className="rounded-full bg-purple-50 px-2 py-1 text-xs font-bold text-purple-600">{p.category || "Lainnya"}</span>
                      </div>
                      <div className="mt-1 text-xs text-slate-400">{p.mainMaterial ? `${p.mainMaterial} · ${p.materialQtyPerPcs || 0} ${p.unit || "yard"}/pcs` : "Bahan utama belum diisi"}</div>
                      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                        <div><div className="text-slate-400">Jual</div><div className="font-bold text-pink-600">{rupiah(p.defaultPrice)}</div></div>
                        <div><div className="text-slate-400">HPP</div><div className="font-bold text-orange-600">{rupiah(hpp)}</div></div>
                        <div><div className="text-slate-400">Margin</div><div className={margin >= 0 ? "font-bold text-emerald-600" : "font-bold text-rose-600"}>{marginPct}%</div></div>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-2xl bg-slate-50 p-2"><span className="text-slate-400">Produksi</span><div className="font-bold">{rupiah(p.productionCost || 0)}</div></div>
                    <div className="rounded-2xl bg-slate-50 p-2"><span className="text-slate-400">Distribusi</span><div className="font-bold">{rupiah(p.distributionCost || 0)}</div></div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button className="bg-sky-600 flex-1" onClick={() => { setProductForm({ ...emptyProductForm, ...p }); setModal("product"); }}>Edit</Button>
                    <Button className="bg-pink-600 flex-1" onClick={() => setOrderForm(f => ({ ...f, items: [...(f.items || []), { ...emptyOrderItem(), productId: p.id, name: p.name, category: p.category, price: p.defaultPrice, bahanCost: moneyValue(p.bahanCost || 0), hppPerPcs: hpp, mainMaterial: p.mainMaterial || "", materialQtyPerPcs: p.materialQtyPerPcs || 0, unit: p.unit || "yard" }] }))}>Pakai</Button>
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
            <div className="text-xs text-slate-400 mb-4">
              Bahan dari belanja supplier otomatis menjadi master bahan. Satuan yang dipakai: yard dan kg.
            </div>
            {filteredMaterialsStock.length === 0 && <div className="text-center py-6 text-slate-400">Belum ada stok bahan</div>}
            <div className="space-y-3">
              {filteredMaterialsStock.map((m) => {
                const stock = Number(m.stock || 0);
                const minStock = Number(m.minStock || 0);
                const low = minStock > 0 && stock <= minStock;
                return (
                  <div key={m.id} className="rounded-2xl p-4" style={{ background: low ? "#fff1f2" : "#f8fafc", border: low ? "1px solid #fecdd3" : "1px solid #e2e8f0" }}>
                    <div className="flex justify-between items-start gap-3">
                      <div>
                        <div className="font-bold text-slate-800">{m.name}</div>
                        <div className="text-xs text-slate-400">{m.category || "Kain"} · min {Number(m.minStock || 0)} {m.unit || "yard"}</div>
                      </div>
                      <div className="text-right">
                        <div className={`text-lg font-bold ${low ? "text-rose-600" : "text-emerald-600"}`}>{stock.toLocaleString("id-ID")} {m.unit || "yard"}</div>
                        <div className="text-xs text-slate-400">Modal avg {rupiah(m.avgCost || 0)}/{m.unit || "yard"}</div>
                      </div>
                    </div>
                    <div className="mt-2 flex justify-between text-xs">
                      <span className={low ? "font-bold text-rose-600" : "font-semibold text-emerald-600"}>{low ? "⚠️ Stok menipis" : "✅ Stok aman"}</span>
                      <span className="text-slate-400">Nilai stok {rupiah(m.totalValue || 0)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-3xl bg-white p-5 shadow-sm" style={{ border: "1.5px solid #c4b5fd" }}>
            <div className="text-lg font-bold mb-1" style={{ color: "#7c3aed" }}>🏷️ Master Kategori Produk</div>
            <div className="text-xs text-slate-400 mb-4">Kategori bisa diketik saat input pesanan. Setelah tersimpan, kategori muncul otomatis sebagai pilihan.</div>
            <div className="flex flex-wrap gap-2">
              {productCategoryOptions.map((name) => (
                <span key={name} className="rounded-full px-3 py-2 text-xs font-bold" style={{ background: "#f5f3ff", color: "#7c3aed" }}>
                  {name}
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-3xl bg-white p-5 shadow-sm" style={{ border: "1.5px solid #f9a8d4" }}>
            <div className="text-lg font-bold mb-1" style={{ color: "#ec4899" }}>🧾 Master Produk Otomatis</div>
            <div className="text-xs text-slate-400 mb-4">Produk dan kategori yang diketik di pesanan otomatis masuk master data. Berikutnya tinggal pilih dari daftar.</div>
            {productMasters.length === 0 && <div className="text-center py-6 text-slate-400">Belum ada master produk</div>}
            <div className="space-y-2">
              {productMasters
                .slice()
                .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
                .map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-2xl bg-pink-50 p-3">
                    <div>
                      <div className="font-bold text-sm text-slate-800">{p.name}</div>
                      <div className="text-xs text-slate-400">{p.category || "Lainnya"}</div>
                    </div>
                    <div className="text-sm font-bold text-pink-600">{rupiah(p.defaultPrice || 0)}</div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* ── REKAP TAB ── */}
      {!loading && tab === "rekap" && (
        <div className="p-4 space-y-4">
          <div className="rounded-3xl p-5 bg-white shadow-sm" style={{ border: "1.5px solid #c4b5fd" }}>
            <div className="text-lg font-bold mb-1" style={{ color: "#7c3aed" }}>🛡️ Backup & Laporan Bisnis</div>
            <div className="text-xs text-slate-400 mb-4">Download backup data sebelum edit besar. JSON untuk restore manual, TSV bisa dibuka di Excel.</div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <Button onClick={exportBackupJson} className="w-full text-xs" style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>Backup JSON</Button>
              <Button onClick={exportBackupTsv} className="w-full text-xs" style={{ background: "linear-gradient(135deg,#059669,#10b981)" }}>Backup Excel</Button>
            </div>
            <Button onClick={downloadLabaRugiPdf} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#f472b6)" }}>📄 PDF Laba Rugi + Cashflow</Button>
            <div className="grid grid-cols-2 gap-2 mt-4">
              <div className="rounded-2xl bg-emerald-50 p-3">
                <div className="text-xs text-slate-400">Laba Bersih</div>
                <div className={`font-bold ${businessSummary.labaBersih >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{rupiah(businessSummary.labaBersih)}</div>
              </div>
              <div className="rounded-2xl bg-sky-50 p-3">
                <div className="text-xs text-slate-400">Cashflow Bersih</div>
                <div className={`font-bold ${businessSummary.cashflowBersih >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{rupiah(businessSummary.cashflowBersih)}</div>
              </div>
            </div>
          </div>

          <div className="rounded-3xl p-5 bg-white shadow-sm" style={{ border: "1.5px solid #f9a8d4" }}>
            <div className="text-lg font-bold mb-1" style={{ color: "#ec4899" }}>📊 Export PDF Rekap Keuangan</div>
            <div className="text-xs text-slate-400 mb-5">Semua download di tab Rekap sekarang format PDF.</div>

            <div className="space-y-3">
              {/* Bulanan */}
              {(() => {
                const rows = buildRows("month");
                const masuk = rows.reduce((s, r) => s + Number(r.masuk || 0), 0);
                const keluar = rows.reduce((s, r) => s + Number(r.keluar || 0), 0);
                const now = new Date();
                return (
                  <div className="rounded-2xl p-4" style={{ background: "linear-gradient(135deg,#fdf2f8,#fce7f3)", border: "1px solid #f9a8d4" }}>
                    <div className="flex justify-between items-center mb-3">
                      <div>
                        <div className="font-bold" style={{ color: "#ec4899" }}>📅 Rekap Bulanan</div>
                        <div className="text-xs text-slate-400">{BULAN_FULL[now.getMonth()]} {now.getFullYear()}</div>
                      </div>
                      <span className="text-xs font-semibold px-2 py-1 rounded-full bg-pink-100 text-pink-700">{rows.length} transaksi</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div className="text-center">
                        <div className="text-xs text-slate-400">Masuk</div>
                        <div className="text-sm font-bold text-emerald-600">{masuk >= 1000000 ? (masuk/1000000).toFixed(1)+"jt" : rupiah(masuk)}</div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-slate-400">Keluar</div>
                        <div className="text-sm font-bold text-rose-500">{keluar >= 1000000 ? (keluar/1000000).toFixed(1)+"jt" : rupiah(keluar)}</div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-slate-400">Saldo</div>
                        <div className={`text-sm font-bold ${masuk-keluar >= 0 ? "text-emerald-600" : "text-rose-500"}`}>
                          {(masuk-keluar) >= 1000000 ? ((masuk-keluar)/1000000).toFixed(1)+"jt" : rupiah(masuk-keluar)}
                        </div>
                      </div>
                    </div>
                    <Button onClick={() => downloadRekap("month")} className="w-full"
                      style={{ background: "linear-gradient(135deg,#ec4899,#f472b6)" }}>
                      📄 PDF Bulanan
                    </Button>
                  </div>
                );
              })()}

              {/* Tahunan */}
              {(() => {
                const rows = buildRows("year");
                const masuk = rows.reduce((s, r) => s + Number(r.masuk || 0), 0);
                const keluar = rows.reduce((s, r) => s + Number(r.keluar || 0), 0);
                return (
                  <div className="rounded-2xl p-4" style={{ background: "linear-gradient(135deg,#f5f3ff,#ede9fe)", border: "1px solid #c4b5fd" }}>
                    <div className="flex justify-between items-center mb-3">
                      <div>
                        <div className="font-bold" style={{ color: "#7c3aed" }}>📅 Rekap Tahunan</div>
                        <div className="text-xs text-slate-400">Tahun {new Date().getFullYear()}</div>
                      </div>
                      <span className="text-xs font-semibold px-2 py-1 rounded-full bg-purple-100 text-purple-700">{rows.length} transaksi</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div className="text-center">
                        <div className="text-xs text-slate-400">Masuk</div>
                        <div className="text-sm font-bold text-emerald-600">{masuk >= 1000000 ? (masuk/1000000).toFixed(1)+"jt" : rupiah(masuk)}</div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-slate-400">Keluar</div>
                        <div className="text-sm font-bold text-rose-500">{keluar >= 1000000 ? (keluar/1000000).toFixed(1)+"jt" : rupiah(keluar)}</div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-slate-400">Saldo</div>
                        <div className={`text-sm font-bold ${masuk-keluar >= 0 ? "text-emerald-600" : "text-rose-500"}`}>
                          {(masuk-keluar) >= 1000000 ? ((masuk-keluar)/1000000).toFixed(1)+"jt" : rupiah(masuk-keluar)}
                        </div>
                      </div>
                    </div>
                    <Button onClick={() => downloadRekap("year")} className="w-full"
                      style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}>
                      📄 PDF Tahunan
                    </Button>
                  </div>
                );
              })()}

              {/* Semua Data */}
              {(() => {
                const rows = buildRows("all");
                const masuk = rows.reduce((s, r) => s + Number(r.masuk || 0), 0);
                const keluar = rows.reduce((s, r) => s + Number(r.keluar || 0), 0);
                return (
                  <div className="rounded-2xl p-4" style={{ background: "linear-gradient(135deg,#ecfdf5,#d1fae5)", border: "1px solid #6ee7b7" }}>
                    <div className="flex justify-between items-center mb-3">
                      <div>
                        <div className="font-bold" style={{ color: "#059669" }}>💕 Semua Data</div>
                        <div className="text-xs text-slate-400">Seluruh riwayat transaksi</div>
                      </div>
                      <span className="text-xs font-semibold px-2 py-1 rounded-full bg-emerald-100 text-emerald-700">{rows.length} transaksi</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div className="text-center">
                        <div className="text-xs text-slate-400">Masuk</div>
                        <div className="text-sm font-bold text-emerald-600">{masuk >= 1000000 ? (masuk/1000000).toFixed(1)+"jt" : rupiah(masuk)}</div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-slate-400">Keluar</div>
                        <div className="text-sm font-bold text-rose-500">{keluar >= 1000000 ? (keluar/1000000).toFixed(1)+"jt" : rupiah(keluar)}</div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-slate-400">Saldo</div>
                        <div className={`text-sm font-bold ${masuk-keluar >= 0 ? "text-emerald-600" : "text-rose-500"}`}>
                          {(masuk-keluar) >= 1000000 ? ((masuk-keluar)/1000000).toFixed(1)+"jt" : rupiah(masuk-keluar)}
                        </div>
                      </div>
                    </div>
                    <Button onClick={() => downloadRekap("all")} className="w-full"
                      style={{ background: "linear-gradient(135deg,#059669,#10b981)" }}>
                      📄 PDF Semua Data
                    </Button>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Rekap pembayaran supplier */}
          <div className="rounded-3xl p-5 bg-white shadow-sm" style={{ border: "1.5px solid #f9a8d4" }}>
            <div className="text-lg font-bold mb-1" style={{ color: "#a855f7" }}>🛍️ Rekap Pembayaran Supplier</div>
            <div className="text-xs text-slate-400 mb-4">Tanggal belanja, jenis bahan, jumlah, sudah dibayar, dan sisa utang</div>

            {(() => {
              const rows = buildSupplierRows("all");
              const totalBelanja = rows.reduce((s, r) => s + moneyValue(r.totalBelanja || 0), 0);
              const totalDibayar = rows.reduce((s, r) => s + moneyValue(r.sudahDibayar || 0), 0);
              const totalSisa = rows.reduce((s, r) => s + moneyValue(r.sisaUtang || 0), 0);
              return (
                <>
                  <div className="grid grid-cols-3 gap-2 mb-4">
                    <div className="text-center rounded-2xl p-3 bg-purple-50">
                      <div className="text-xs text-slate-400">Belanja</div>
                      <div className="text-sm font-bold text-purple-600">{rupiah(totalBelanja)}</div>
                    </div>
                    <div className="text-center rounded-2xl p-3 bg-emerald-50">
                      <div className="text-xs text-slate-400">Dibayar</div>
                      <div className="text-sm font-bold text-emerald-600">{rupiah(totalDibayar)}</div>
                    </div>
                    <div className="text-center rounded-2xl p-3 bg-rose-50">
                      <div className="text-xs text-slate-400">Sisa</div>
                      <div className="text-sm font-bold text-rose-500">{rupiah(totalSisa)}</div>
                    </div>
                  </div>

                  <div className="space-y-2 mb-4 max-h-72 overflow-auto">
                    {rows.length === 0 && <div className="text-center py-4 text-slate-400">Belum ada data supplier</div>}
                    {rows.map((r, i) => (
                      <div key={i} className="rounded-2xl p-3" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                        <div className="flex justify-between gap-2">
                          <div>
                            <div className="font-bold text-sm text-slate-800">{r.supplier || "Supplier"}</div>
                            <div className="text-xs text-slate-500">📅 {r.tanggalBelanja || "-"} · {r.jenisBahan || "Bahan"}</div>
                            <div className="text-xs text-slate-400">Banyak: {r.banyak || "-"}</div>
                          </div>
                          <div className="text-right text-xs">
                            <div className="font-semibold text-slate-700">{rupiah(r.totalBelanja)}</div>
                            <div className="text-emerald-600">Dibayar {rupiah(r.sudahDibayar)}</div>
                            <div className="font-bold text-rose-500">Sisa {rupiah(r.sisaUtang)}</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="text-xs font-bold text-slate-500 mb-2">Export PDF Supplier</div>
                  <div className="grid grid-cols-3 gap-2">
                    <Button onClick={() => downloadSupplierRekapPdf("month")} className="w-full text-xs" style={{ background: "linear-gradient(135deg,#be185d,#ec4899)" }}>PDF Bulanan</Button>
                    <Button onClick={() => downloadSupplierRekapPdf("year")} className="w-full text-xs" style={{ background: "linear-gradient(135deg,#6d28d9,#8b5cf6)" }}>PDF Tahunan</Button>
                    <Button onClick={() => downloadSupplierRekapPdf("all")} className="w-full text-xs" style={{ background: "linear-gradient(135deg,#047857,#10b981)" }}>PDF Semua</Button>
                  </div>
                </>
              );
            })()}
          </div>

          {/* Invoice per customer */}
          <div className="rounded-3xl p-5 bg-white shadow-sm" style={{ border: "1.5px solid #f9a8d4" }}>
            <div className="text-lg font-bold mb-1" style={{ color: "#ec4899" }}>📄 Invoice per Customer</div>
            <div className="text-xs text-slate-400 mb-4">Kirim rincian pesanan langsung ke WhatsApp atau export rekap PDF customer</div>
            <div className="text-xs font-bold text-slate-500 mb-2">Export PDF Customer</div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <Button onClick={() => downloadCustomerRekapPdf("month")} className="w-full text-xs" style={{ background: "linear-gradient(135deg,#be185d,#ec4899)" }}>PDF Bulanan</Button>
              <Button onClick={() => downloadCustomerRekapPdf("year")} className="w-full text-xs" style={{ background: "linear-gradient(135deg,#6d28d9,#8b5cf6)" }}>PDF Tahunan</Button>
              <Button onClick={() => downloadCustomerRekapPdf("all")} className="w-full text-xs" style={{ background: "linear-gradient(135deg,#047857,#10b981)" }}>PDF Semua</Button>
            </div>
            <div className="space-y-2">
              {uniqueCustomers.length === 0 && <div className="text-center py-4 text-slate-400">Belum ada customer</div>}
              {uniqueCustomers.map(c => {
                const cOrders = orders.filter(o => normalizeName(o.customer) === normalizeName(c.name));
                const totalNilai = cOrders.reduce((s, o) => s + billableOrderTotal(o), 0);
                const totalBayar = cOrders.reduce((s, o) => s + (o.payments || []).reduce((a, p) => a + moneyValue(p.amount || 0), 0), 0);
                const sisa = totalNilai - totalBayar;
                return (
                  <div key={c.name} className="flex items-center justify-between rounded-2xl p-3"
                    style={{ background: "#fdf2f8", border: "1px solid #fce7f3" }}>
                    <div>
                      <div className="font-bold text-sm" style={{ color: "#1e293b" }}>{c.name}</div>
                      <div className="text-xs text-slate-400">{c.totalPesanan} pesanan · sisa {rupiah(sisa)}</div>
                    </div>
                    <button onClick={() => setInvoiceCustomer(c.name)}
                      className="rounded-xl px-3 py-2 text-xs font-bold text-white"
                      style={{ background: "linear-gradient(135deg,#25d366,#128c7e)" }}>
                      📤 Kirim WA
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {!loading && tab === "rekap" && (
        <div className="px-4 pb-4">
          <div className="rounded-3xl bg-white p-5 shadow-sm" style={{ border: "1.5px solid #e2e8f0" }}>
            <div className="text-lg font-bold mb-1 text-slate-700">🧾 Audit Log Sederhana</div>
            <div className="text-xs text-slate-400 mb-3">Riwayat aktivitas tersimpan di browser perangkat ini.</div>
            {auditLogs.length === 0 && <div className="text-center py-4 text-slate-400">Belum ada aktivitas tercatat</div>}
            <div className="space-y-2 max-h-64 overflow-auto">
              {auditLogs.slice(0, 20).map((log, idx) => (
                <div key={idx} className="rounded-2xl bg-slate-50 p-3 text-xs">
                  <div className="flex justify-between gap-2">
                    <span className="font-bold text-slate-700">{log.action}</span>
                    <span className="text-slate-400">{log.time}</span>
                  </div>
                  {log.detail && <div className="mt-1 text-slate-500">{log.detail}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ════ MODALS ════ */}

      {modal === "product" && (
        <SimpleModal title="Template Produk" onClose={() => { setModal(null); setProductForm(emptyProductForm); }}>
          <div className="space-y-3">
            <div className="rounded-2xl bg-purple-50 p-3 text-xs text-purple-700">
              Yang wajib cukup Nama Produk, Kategori, dan Harga Jual. HPP bisa dilengkapi bertahap.
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Foto Produk (opsional)</label>
              <div className="rounded-2xl p-3" style={{ background: "#fdf2f8", border: "1.5px solid #f9a8d4" }}>
                <div className="flex items-center gap-3">
                  <div className="h-20 w-20 rounded-2xl bg-white overflow-hidden flex items-center justify-center border border-pink-100 shrink-0">
                    {productForm.imageUrl ? <img src={productForm.imageUrl} alt="preview" className="h-full w-full object-cover" /> : <span className="text-3xl">📷</span>}
                  </div>
                  <div className="flex-1 space-y-2">
                    <label className="block w-full cursor-pointer rounded-2xl px-4 py-3 text-center text-sm font-bold text-white"
                      style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
                      Upload Foto
                      <input type="file" accept="image/*" className="hidden" onChange={(e) => handleProductImageUpload(e.target.files?.[0])} />
                    </label>
                    {productForm.imageUrl && (
                      <button type="button" onClick={() => setProductForm(f => ({ ...f, imageUrl: "" }))}
                        className="w-full rounded-2xl bg-white px-4 py-2 text-xs font-bold text-rose-500 border border-rose-100">
                        Hapus Foto
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-slate-400">Boleh kosong. Foto otomatis diperkecil supaya aplikasi tetap ringan.</div>
              </div>
              <Input label="Atau Tempel URL Gambar" value={productForm.imageUrl && !String(productForm.imageUrl).startsWith("data:") ? productForm.imageUrl : ""}
                onChange={(v) => setProductForm(f => ({ ...f, imageUrl: v }))} placeholder="https://... (opsional)" />
            </div>
            <Input label="Nama Produk *" value={productForm.name} onChange={(v) => setProductForm(f => ({ ...f, name: v }))} placeholder="Contoh: Mukena Rayon Premium" />
            <div className="space-y-1">
              <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Kategori *</label>
              <input list="product-category-list-modal" value={productForm.category}
                onChange={(e) => setProductForm(f => ({ ...f, category: e.target.value }))}
                placeholder="Kerudung / Mukena / Baju Anak"
                className="w-full px-4 py-3 outline-none text-sm"
                style={{ borderRadius: 14, border: "1.5px solid #f9a8d4", background: "#fdf2f8", color: "#2d1b69" }} />
              <datalist id="product-category-list-modal">
                {productCategoryOptions.map(name => <option key={name} value={name} />)}
              </datalist>
            </div>
            <Input label="Harga Jual *" type="money" value={productForm.defaultPrice} onChange={(v) => setProductForm(f => ({ ...f, defaultPrice: v }))} />

            <div className="rounded-2xl p-3 space-y-2" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
              <div className="font-bold text-slate-700">HPP Produk (opsional)</div>
              <div className="text-xs text-slate-400">Bahan: kain, label, plastik. Produksi: jahit, potong, packing. Distribusi: ambil bahan & konveksi.</div>
              <Input label="Bahan Utama" value={productForm.mainMaterial} onChange={(v) => setProductForm(f => ({ ...f, mainMaterial: v }))} placeholder="Contoh: Rayon Twill" />
              <div className="grid grid-cols-2 gap-2">
                <Input label="Kebutuhan / pcs" type="number" value={productForm.materialQtyPerPcs} onChange={(v) => setProductForm(f => ({ ...f, materialQtyPerPcs: v }))} />
                <Select label="Satuan" value={productForm.unit} onChange={(v) => setProductForm(f => ({ ...f, unit: v }))}>
                  <option value="yard">yard</option>
                  <option value="kg">kg</option>
                </Select>
              </div>
              <Input label="Bahan" type="money" value={productForm.bahanCost} onChange={(v) => setProductForm(f => ({ ...f, bahanCost: v }))} />
              <Input label="Produksi" type="money" value={productForm.productionCost} onChange={(v) => setProductForm(f => ({ ...f, productionCost: v }))} />
              <Input label="Distribusi" type="money" value={productForm.distributionCost} onChange={(v) => setProductForm(f => ({ ...f, distributionCost: v }))} />
              <Input label="Lain-lain" type="money" value={productForm.otherCost} onChange={(v) => setProductForm(f => ({ ...f, otherCost: v }))} />
            </div>

            <div className="rounded-2xl bg-emerald-50 p-4 flex justify-between items-center">
              <div>
                <div className="text-xs text-slate-500">HPP otomatis</div>
                <div className="text-xl font-bold text-emerald-600">{rupiah(calculateProductHpp(productForm))}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500">Estimasi margin</div>
                <div className="text-lg font-bold text-pink-600">{rupiah(moneyValue(productForm.defaultPrice || 0) - calculateProductHpp(productForm))}</div>
              </div>
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
              <input list="customer-list" value={orderForm.customer}
                onChange={(e) => setOrderForm(f => ({ ...f, customer: e.target.value }))}
                placeholder="Ketik atau pilih nama customer..."
                className="w-full px-4 py-3 outline-none text-sm"
                style={{ borderRadius: 14, border: "1.5px solid #f9a8d4", background: "#fdf2f8", color: "#2d1b69" }} />
              <datalist id="customer-list">
                {uniqueCustomers.map(c => <option key={c.name} value={c.name} />)}
              </datalist>
            </div>
            <Input label="No HP Customer (opsional)" type="number" value={orderForm.phone} onChange={(v) => setOrderForm(f => ({ ...f, phone: v }))} placeholder="08xxxxxxxxxx" />

            {topCustomers.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-bold" style={{ color: "#a855f7" }}>Customer favorit</div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {topCustomers.map((c) => (
                    <button key={c.name} type="button" onClick={() => setOrderForm(f => ({ ...f, customer: c.name }))}
                      className="shrink-0 rounded-full bg-white px-3 py-2 text-xs font-bold shadow-sm" style={{ color: "#7c3aed", border: "1px solid #ddd6fe" }}>
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {topProducts.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-bold" style={{ color: "#a855f7" }}>Produk favorit</div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {topProducts.map((p) => (
                    <button key={p.name} type="button" onClick={() => {
                      const master = findProductMaster(p.name);
                      const nextItem = {
                        productId: master?.id || "",
                        name: p.name,
                        category: master?.category || "",
                        qty: "",
                        price: master?.defaultPrice !== undefined ? moneyValue(master.defaultPrice || 0) : 0,
                        bahanCost: master ? moneyValue(master.bahanCost || 0) : 0,
                        hppPerPcs: master ? calculateProductHpp(master) : 0,
                        mainMaterial: master?.mainMaterial || "",
                        materialQtyPerPcs: master?.materialQtyPerPcs || 0,
                        unit: master?.unit || "yard",
                      };
                      setOrderForm(f => ({ ...f, items: [nextItem] }));
                    }}
                      className="shrink-0 rounded-full bg-white px-3 py-2 text-xs font-bold shadow-sm" style={{ color: "#be185d", border: "1px solid #fbcfe8" }}>
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button type="button" onClick={resetOrderDraft} className="w-full rounded-2xl bg-slate-100 py-2 text-xs font-bold text-slate-500">Reset draft</button>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Produk Pesanan</label>
                <button
                  type="button"
                  onClick={() => setOrderForm(f => ({ ...f, items: [...(f.items || []), emptyOrderItem()] }))}
                  className="rounded-xl px-3 py-2 text-xs font-bold text-white"
                  style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}
                >
                  + Tambah Produk
                </button>
              </div>

              {(orderForm.items || []).map((it, idx) => (
                <div key={idx} className="rounded-2xl p-3 space-y-2" style={{ background: "#fdf2f8", border: "1.5px solid #f9a8d4" }}>
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold" style={{ color: "#ec4899" }}>Produk #{idx + 1}</div>
                    {(orderForm.items || []).length > 1 && (
                      <button
                        type="button"
                        onClick={() => setOrderForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }))}
                        className="rounded-xl px-3 py-1 text-xs font-bold text-rose-600 bg-rose-50"
                      >
                        Hapus
                      </button>
                    )}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Nama Produk</label>
                    <input
                      list="product-master-list"
                      value={it.name}
                      onChange={(e) => {
                        const v = e.target.value;
                        const master = findProductMaster(v);
                        setOrderForm(f => ({
                          ...f,
                          items: f.items.map((x, i) => i === idx ? {
                            ...x,
                            name: v,
                            productId: master?.id || x.productId || "",
                            category: master?.category || x.category || "",
                            price: master?.defaultPrice !== undefined ? moneyValue(master.defaultPrice || 0) : x.price,
                            bahanCost: master ? moneyValue(master.bahanCost || 0) : moneyValue(x.bahanCost || 0),
                            hppPerPcs: master ? calculateProductHpp(master) : moneyValue(x.hppPerPcs || 0),
                            mainMaterial: master?.mainMaterial || x.mainMaterial || "",
                            materialQtyPerPcs: master?.materialQtyPerPcs || x.materialQtyPerPcs || 0,
                            unit: master?.unit || x.unit || "yard",
                          } : x),
                        }));
                      }}
                      placeholder="Contoh: Mukena Rayon Anak"
                      className="w-full px-4 py-3 outline-none text-sm"
                      style={{ borderRadius: 14, border: "1.5px solid #f9a8d4", background: "#fdf2f8", color: "#2d1b69" }}
                    />
                    <datalist id="product-master-list">
                      {productMasters.map(p => <option key={p.id} value={p.name} />)}
                    </datalist>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Kategori Produk</label>
                    <input
                      list="product-category-list"
                      value={it.category || ""}
                      onChange={(e) => setOrderForm(f => ({
                        ...f,
                        items: f.items.map((x, i) => i === idx ? { ...x, category: e.target.value } : x),
                      }))}
                      placeholder="Kerudung / Mukena / Baju Anak / kategori baru"
                      className="w-full px-4 py-3 outline-none text-sm"
                      style={{ borderRadius: 14, border: "1.5px solid #f9a8d4", background: "#fdf2f8", color: "#2d1b69" }}
                    />
                    <datalist id="product-category-list">
                      {productCategoryOptions.map(name => <option key={name} value={name} />)}
                    </datalist>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      label="Jumlah pcs"
                      type="number"
                      value={it.qty}
                      onChange={(v) => setOrderForm(f => ({
                        ...f,
                        items: f.items.map((x, i) => i === idx ? { ...x, qty: v } : x),
                      }))}
                    />
                    <Input
                      label="Harga/pcs"
                      type="money"
                      value={it.price}
                      onChange={(v) => setOrderForm(f => ({
                        ...f,
                        items: f.items.map((x, i) => i === idx ? { ...x, price: v } : x),
                      }))}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex justify-between rounded-xl bg-white px-3 py-2 text-sm">
                      <span className="text-slate-500">Subtotal</span>
                      <span className="font-bold" style={{ color: "#be185d" }}>{rupiah(Number(it.qty || 0) * moneyValue(it.price || 0))}</span>
                    </div>
                    <div className="flex justify-between rounded-xl bg-white px-3 py-2 text-sm">
                      <span className="text-slate-500">Est. Laba</span>
                      <span className="font-bold text-emerald-600">{rupiah((moneyValue(it.price || 0) - moneyValue(it.hppPerPcs || 0)) * Number(it.qty || 0))}</span>
                    </div>
                  </div>
                  {moneyValue(it.hppPerPcs || 0) > 0 && (
                    <div className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                      HPP {rupiah(it.hppPerPcs)}/pcs · {it.mainMaterial ? `Bahan ${it.mainMaterial} ${it.materialQtyPerPcs || 0} ${it.unit || "yard"}/pcs` : "template produk"}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Total Pesanan (otomatis)</label>
              <div className="w-full px-4 py-3 text-sm font-bold rounded-2xl"
                style={{ border: "1.5px solid #f9a8d4", background: "#fce7f3", color: "#be185d" }}>
                {rupiah(orderItemsTotal(orderForm.items))}
              </div>
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
                <button
                  type="button"
                  onClick={() => setPurchaseForm(f => ({ ...f, materials: [...(f.materials || []), emptyPurchaseMaterial()] }))}
                  className="rounded-xl px-3 py-2 text-xs font-bold text-white"
                  style={{ background: "linear-gradient(135deg,#f97316,#fb923c)" }}
                >
                  + Tambah Bahan
                </button>
              </div>

              {(purchaseForm.materials || []).map((it, idx) => (
                <div key={idx} className="rounded-2xl bg-white p-3 space-y-2" style={{ border: "1px solid #fed7aa" }}>
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-bold text-orange-600">Bahan #{idx + 1}</div>
                    {(purchaseForm.materials || []).length > 1 && (
                      <button
                        type="button"
                        onClick={() => setPurchaseForm(f => ({ ...f, materials: f.materials.filter((_, i) => i !== idx) }))}
                        className="text-xs font-bold text-rose-500"
                      >
                        Hapus
                      </button>
                    )}
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Nama Bahan</label>
                    <input
                      list="material-master-list"
                      value={it.name}
                      onChange={(e) => setPurchaseForm(f => ({
                        ...f,
                        materials: f.materials.map((x, i) => i === idx ? { ...x, name: e.target.value } : x),
                      }))}
                      placeholder="Contoh: Ceruty Babydoll"
                      className="w-full px-4 py-3 outline-none text-sm"
                      style={{ borderRadius: 14, border: "1.5px solid #f9a8d4", background: "#fdf2f8", color: "#2d1b69" }}
                    />
                    <datalist id="material-master-list">
                      {materialsStock.map(m => <option key={m.id} value={m.name} />)}
                    </datalist>
                  </div>

                  <Input
                    label="Kategori"
                    value={it.category}
                    onChange={(v) => setPurchaseForm(f => ({
                      ...f,
                      materials: f.materials.map((x, i) => i === idx ? { ...x, category: v } : x),
                    }))}
                    placeholder="Contoh: Kain, Karet, Aksesoris"
                  />

                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      label="Qty"
                      type="number"
                      value={it.qty}
                      onChange={(v) => setPurchaseForm(f => ({
                        ...f,
                        materials: f.materials.map((x, i) => i === idx ? { ...x, qty: v } : x),
                      }))}
                    />
                    <Select
                      label="Satuan"
                      value={it.unit || "yard"}
                      onChange={(v) => setPurchaseForm(f => ({
                        ...f,
                        materials: f.materials.map((x, i) => i === idx ? { ...x, unit: v } : x),
                      }))}
                    >
                      <option value="yard">yard</option>
                      <option value="kg">kg</option>
                    </Select>
                  </div>

                  <Input
                    label="Total Harga Bahan"
                    type="money"
                    value={it.total}
                    onChange={(v) => setPurchaseForm(f => ({
                      ...f,
                      materials: f.materials.map((x, i) => i === idx ? { ...x, total: v } : x),
                    }))}
                  />

                  <div className="flex justify-between rounded-xl bg-orange-50 px-3 py-2 text-sm">
                    <span className="text-slate-500">Harga/{it.unit || "yard"}</span>
                    <span className="font-bold text-orange-600">
                      {rupiah(Number(it.qty || 0) > 0 ? moneyValue(it.total || 0) / Number(it.qty || 0) : 0)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Total Belanja Supplier</label>
              <div className="w-full px-4 py-3 text-sm font-bold rounded-2xl"
                style={{ border: "1.5px solid #fed7aa", background: "#fff7ed", color: "#ea580c" }}>
                {rupiah(purchaseMaterialsTotal(purchaseForm.materials))}
              </div>
              <div className="text-xs text-slate-400">Otomatis masuk Master Bahan dan stok bertambah.</div>
            </div>

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

      {modal === "pay" && (
        <SimpleModal title="Catat Bayar Masuk" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <Select label="Nama Customer" value={orderPayForm.customer}
              onChange={(v) => setOrderPayForm(f => ({ ...f, customer: v }))}>
              <option value="">-- Pilih Customer --</option>
              {uniqueCustomers.filter(c => c.pesananAktif > 0).map(c => (
                <option key={c.name} value={c.name}>
                  {c.name} — {c.pesananAktif} pesanan, sisa {rupiah(c.totalSisa)}
                </option>
              ))}
            </Select>

            {uniqueCustomers.filter(c => c.pesananAktif > 0).length === 0 && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                Belum ada customer dengan pesanan aktif. Pastikan data pesanan sudah masuk dan Firebase berhasil dimuat.
              </div>
            )}

            {orderPayForm.customer && (() => {
              const list = orders
                .filter(o => normalizeName(o.customer) === normalizeName(orderPayForm.customer) && sisaOrderUntukAlokasi(o) > 0)
                .sort((a, b) => (a.createdAt||"").localeCompare(b.createdAt||""));
              return list.length > 0 ? (
                <div className="rounded-2xl p-3 space-y-1" style={{ background: "#fdf2f8", border: "1px solid #fce7f3" }}>
                  <div className="text-xs font-bold mb-2" style={{ color: "#a855f7" }}>📋 Akan dialokasikan (urutan terlama):</div>
                  {list.map((o, i) => (
                    <div key={o.id} className="flex justify-between text-xs">
                      <span style={{ color: "#64748b" }}>{i+1}. {o.invoice}</span>
                      <span className="font-semibold" style={{ color: "#e11d48" }}>sisa {rupiah(sisaOrderUntukAlokasi(o))}</span>
                    </div>
                  ))}
                </div>
              ) : null;
            })()}

            <DatePicker label="Tanggal Bayar" value={orderPayForm.date} onChange={(v) => setOrderPayForm(f => ({ ...f, date: v }))} />
            <Input label="Keterangan" value={orderPayForm.note} onChange={(v) => setOrderPayForm(f => ({ ...f, note: v }))} placeholder="Contoh: Transfer BCA" />
            <Input label="Nominal Pembayaran" type="money" value={orderPayForm.amount} onChange={(v) => setOrderPayForm(f => ({ ...f, amount: v }))} />
            <Button onClick={addOrderPayment} className="w-full" style={{ background: "linear-gradient(135deg,#10b981,#34d399)" }}>
              💚 Simpan & Alokasi Otomatis
            </Button>
          </div>
        </SimpleModal>
      )}

      {modal === "supplierPay" && (
        <SimpleModal title="Bayar Supplier" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <Select label="Pilih Supplier" value={supplierPayForm.supplier}
              onChange={(v) => setSupplierPayForm(f => ({ ...f, supplier: v }))}>
              <option value="">-- Pilih Supplier --</option>
              {uniqueSuppliers.filter(s => s.belanjaAktif > 0).map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} — {s.belanjaAktif} belanja, sisa {rupiah(s.totalSisa)}
                </option>
              ))}
            </Select>

            {supplierPayForm.supplier && (() => {
              const list = purchases
                .filter(p => normalizeName(p.supplier) === normalizeName(supplierPayForm.supplier) && sisaPurchase(p) > 0)
                .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
              return list.length > 0 ? (
                <div className="rounded-2xl p-3 space-y-1" style={{ background: "#fff7ed", border: "1px solid #fed7aa" }}>
                  <div className="text-xs font-bold mb-2" style={{ color: "#f97316" }}>📋 Akan dialokasikan ke hutang terlama:</div>
                  {list.map((p, i) => (
                    <div key={p.id} className="flex justify-between gap-2 text-xs">
                      <span style={{ color: "#64748b" }}>{i + 1}. {p.createdAt || "-"} · {purchaseMaterialsSummary(p)}</span>
                      <span className="font-semibold" style={{ color: "#e11d48" }}>sisa {rupiah(sisaPurchase(p))}</span>
                    </div>
                  ))}
                </div>
              ) : null;
            })()}

            <DatePicker label="Tanggal Bayar" value={supplierPayForm.date} onChange={(v) => setSupplierPayForm(f => ({ ...f, date: v }))} />
            <Input label="Keterangan" value={supplierPayForm.note} onChange={(v) => setSupplierPayForm(f => ({ ...f, note: v }))} placeholder="Contoh: Transfer supplier" />
            <Input label="Nominal Pembayaran" type="money" value={supplierPayForm.amount} onChange={(v) => setSupplierPayForm(f => ({ ...f, amount: v }))} />
            <Button onClick={addSupplierPayment} className="w-full" style={{ background: "linear-gradient(135deg,#f97316,#fb923c)" }}>
              🧡 Simpan & Alokasi Otomatis
            </Button>
          </div>
        </SimpleModal>
      )}

      {/* Invoice per Customer Modal */}
      {invoiceCustomer && (
        <InvoiceModal
          key={invoiceCustomer}
          customerName={invoiceCustomer}
          orders={orders}
          onClose={() => setInvoiceCustomer(null)}
        />
      )}

      {/* Modal Edit */}
      {editData && (
        <SimpleModal title="Edit Data" onClose={() => setEditData(null)}>
          <div className="space-y-3">
            {editData.type === "orders" && <>
              <DatePicker label="Tanggal Pesanan" value={editData.createdAt || ""} onChange={(v) => setEditData(d => ({ ...d, createdAt: v }))} />
              <Input label="Nama Customer" value={editData.customer || ""} onChange={(v) => setEditData(d => ({ ...d, customer: v }))} />
              <Input label="No HP Customer" type="number" value={editData.phone || ""} onChange={(v) => setEditData(d => ({ ...d, phone: v }))} placeholder="08xxxxxxxxxx" />
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Produk Pesanan</label>
                  <button
                    type="button"
                    onClick={() => setEditData(d => ({ ...d, items: [...normalizeOrderItems(d), emptyOrderItem()] }))}
                    className="rounded-xl px-3 py-2 text-xs font-bold text-white"
                    style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}
                  >
                    + Tambah Produk
                  </button>
                </div>
                {normalizeOrderItems(editData).map((it, idx) => (
                  <div key={idx} className="rounded-2xl p-3 space-y-2" style={{ background: "#fdf2f8", border: "1.5px solid #f9a8d4" }}>
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-bold" style={{ color: "#ec4899" }}>Produk #{idx + 1}</div>
                      {normalizeOrderItems(editData).length > 1 && (
                        <button
                          type="button"
                          onClick={() => setEditData(d => ({ ...d, items: normalizeOrderItems(d).filter((_, i) => i !== idx) }))}
                          className="rounded-xl px-3 py-1 text-xs font-bold text-rose-600 bg-rose-50"
                        >
                          Hapus
                        </button>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Nama Produk</label>
                      <input
                        list="product-master-list-edit"
                        value={it.name}
                        onChange={(e) => {
                          const v = e.target.value;
                          const master = findProductMaster(v);
                          setEditData(d => ({
                            ...d,
                            items: normalizeOrderItems(d).map((x, i) => i === idx ? {
                              ...x,
                              name: v,
                              category: master?.category || x.category || "",
                              price: master?.defaultPrice !== undefined ? moneyValue(master.defaultPrice || 0) : x.price,
                            } : x),
                          }));
                        }}
                        className="w-full px-4 py-3 outline-none text-sm"
                        style={{ borderRadius: 14, border: "1.5px solid #f9a8d4", background: "#fdf2f8", color: "#2d1b69" }}
                      />
                      <datalist id="product-master-list-edit">
                        {productMasters.map(p => <option key={p.id} value={p.name} />)}
                      </datalist>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Kategori Produk</label>
                      <input
                        list="product-category-list-edit"
                        value={it.category || ""}
                        onChange={(e) => setEditData(d => ({ ...d, items: normalizeOrderItems(d).map((x, i) => i === idx ? { ...x, category: e.target.value } : x) }))}
                        placeholder="Kerudung / Mukena / Baju Anak / kategori baru"
                        className="w-full px-4 py-3 outline-none text-sm"
                        style={{ borderRadius: 14, border: "1.5px solid #f9a8d4", background: "#fdf2f8", color: "#2d1b69" }}
                      />
                      <datalist id="product-category-list-edit">
                        {productCategoryOptions.map(name => <option key={name} value={name} />)}
                      </datalist>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        label="Jumlah pcs"
                        type="number"
                        value={it.qty}
                        onChange={(v) => setEditData(d => ({ ...d, items: normalizeOrderItems(d).map((x, i) => i === idx ? { ...x, qty: v } : x) }))}
                      />
                      <Input
                        label="Harga/pcs"
                        type="money"
                        value={it.price}
                        onChange={(v) => setEditData(d => ({ ...d, items: normalizeOrderItems(d).map((x, i) => i === idx ? { ...x, price: v } : x) }))}
                      />
                    </div>
                    <div className="flex justify-between rounded-xl bg-white px-3 py-2 text-sm">
                      <span className="text-slate-500">Subtotal</span>
                      <span className="font-bold" style={{ color: "#be185d" }}>{rupiah(Number(it.qty || 0) * moneyValue(it.price || 0))}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold" style={{ color: "#a855f7" }}>Total Pesanan</label>
                <div className="w-full px-4 py-3 text-sm font-bold rounded-2xl" style={{ border: "1.5px solid #f9a8d4", background: "#fce7f3", color: "#be185d" }}>
                  {rupiah(orderItemsTotal(normalizeOrderItems(editData)))}
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Status</label>
                <div className="flex gap-2">
                  {["Proses", "Selesai", "Lunas"].map((s) => (
                    <button key={s} onClick={() => setEditData(d => ({ ...d, status: s }))}
                      className={`rounded-full px-4 py-2 text-sm font-semibold border transition-all ${editData.status === s ? "bg-pink-600 text-white border-pink-600" : "bg-white text-slate-500 border-slate-200"}`}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </>}
            {editData.type === "purchases" && <>
              <DatePicker label="Tanggal Belanja" value={editData.createdAt || ""} onChange={(v) => setEditData(d => ({ ...d, createdAt: v }))} />
              <Input label="Nama Supplier" value={editData.supplier || ""} onChange={(v) => setEditData(d => ({ ...d, supplier: v }))} />
              <Input label="Bahan" value={editData.material || ""} onChange={(v) => setEditData(d => ({ ...d, material: v }))} />
              <Input label="Banyak / Jumlah Bahan" value={editData.qty || ""} onChange={(v) => setEditData(d => ({ ...d, qty: v }))} placeholder="Contoh: 12 meter / 5 roll" />
              <Input label="Total" type="money" value={editData.total || 0} onChange={(v) => setEditData(d => ({ ...d, total: v }))} />
            </>}
            {editData.type === "expenses" && <>
              <DatePicker label="Tanggal" value={editData.date || ""} onChange={(v) => setEditData(d => ({ ...d, date: v }))} />
              <Input label="Kategori" value={editData.category || ""} onChange={(v) => setEditData(d => ({ ...d, category: v }))} />
              <Input label="Keterangan" value={editData.note || ""} onChange={(v) => setEditData(d => ({ ...d, note: v }))} />
              <Input label="Nominal" type="money" value={editData.amount || 0} onChange={(v) => setEditData(d => ({ ...d, amount: v }))} />
            </>}
            <Button onClick={saveEdit} className="w-full bg-sky-600">Simpan Perubahan</Button>
          </div>
        </SimpleModal>
      )}

      {/* Konfirmasi Rekap */}
      {rekapConfirm && (() => {
        const labelMap = { month: "Bulanan", year: "Tahunan", all: "Semua Data" };
        const rows = buildRows(rekapConfirm);
        const totalMasuk = rows.reduce((s, r) => s + Number(r.masuk || 0), 0);
        const totalKeluar = rows.reduce((s, r) => s + Number(r.keluar || 0), 0);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6">
            <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl">
              <div className="text-xl font-bold text-slate-800 mb-1">Download Rekap {labelMap[rekapConfirm]}</div>
              <div className="text-slate-500 text-sm mb-4">Format: PDF</div>
              <div className="rounded-2xl bg-slate-50 p-4 space-y-2 mb-5">
                <div className="flex justify-between text-sm"><span className="text-slate-500">Total transaksi</span><span className="font-semibold">{rows.length} data</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-500">Kas masuk</span><span className="font-semibold text-emerald-600">{rupiah(totalMasuk)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-500">Kas keluar</span><span className="font-semibold text-rose-500">{rupiah(totalKeluar)}</span></div>
                <div className="flex justify-between text-sm border-t pt-2">
                  <span className="font-semibold text-slate-700">Saldo bersih</span>
                  <span className={`font-bold ${totalMasuk - totalKeluar >= 0 ? "text-emerald-600" : "text-rose-500"}`}>{rupiah(totalMasuk - totalKeluar)}</span>
                </div>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setRekapConfirm(null)} className="flex-1 rounded-2xl border border-slate-200 py-3 font-semibold text-slate-600">Batal</button>
                <button onClick={doDownloadRekap} className="flex-1 rounded-2xl bg-indigo-600 py-3 font-semibold text-white">Download PDF</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal Tandai Dikirim */}
      {kirimModal && (() => {
        const order = orders.find((o) => o.id === kirimModal);
        const totalPesanan = order ? moneyValue(order.total || 0) : 0;
        const totalSebelumKirim = order ? billableOrderTotal(order) : 0;
        const totalKirimHariIni = deliveryItemsTotal(kirimItems.map((it) => ({ qty: it.shippedQty, price: it.price })));
        const totalSetelahKirim = totalSebelumKirim + totalKirimHariIni;
        const selisihNominal = totalSetelahKirim - totalPesanan;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <div className="w-full max-w-md max-h-[92vh] overflow-auto rounded-3xl bg-white p-6 shadow-xl">
              <div className="text-xl font-bold text-slate-800 mb-1">🚚 Input Pengiriman Bertahap</div>
              <div className="text-slate-500 text-sm mb-4">Isi qty yang dikirim hari ini. Sistem akan menjumlahkan semua riwayat pengiriman dan tagihan mengikuti total barang yang sudah terkirim.</div>
              <DatePicker label="Tanggal Kirim" value={tanggalKirim} onChange={(v) => setTanggalKirim(v)} />

              <div className="mt-4 space-y-3">
                {kirimItems.map((it, idx) => {
                  const totalAkanTerkirim = Number(it.alreadyShipped || 0) + Number(it.shippedQty || 0);
                  const selisih = totalAkanTerkirim - Number(it.orderedQty || 0);
                  const subtotal = Number(it.shippedQty || 0) * moneyValue(it.price || 0);
                  return (
                    <div key={idx} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                      <div className="font-bold text-sm text-slate-800">{it.name}</div>
                      <div className="text-xs text-slate-400 mb-2">Pesanan {it.orderedQty} pcs · Sudah terkirim {it.alreadyShipped || 0} pcs · Sisa {it.remainingQty || 0} pcs · Harga {rupiah(it.price)}/pcs</div>
                      <Input
                        label="Qty Dikirim Hari Ini"
                        type="number"
                        value={it.shippedQty}
                        onChange={(v) => setKirimItems(items => items.map((x, i) => i === idx ? { ...x, shippedQty: v, note: shipmentAutoNote(x.orderedQty, v) } : x))}
                      />
                      <div className="mt-2 flex justify-between text-xs">
                        <span className={selisih < 0 ? "font-bold text-rose-600" : "font-semibold text-emerald-600"}>Selisih {selisih} pcs</span>
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
                <div className="flex justify-between text-sm"><span className="text-slate-500">Total pesanan awal</span><span className="font-semibold">{rupiah(totalPesanan)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-500">Tagihan sebelum kirim ini</span><span className="font-semibold">{rupiah(totalSebelumKirim)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-500">Nilai kirim hari ini</span><span className="font-semibold text-sky-600">{rupiah(totalKirimHariIni)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-500">Tagihan setelah kirim ini</span><span className="font-bold text-pink-600">{rupiah(totalSetelahKirim)}</span></div>
                <div className="flex justify-between text-sm border-t pt-2"><span className="font-semibold">Selisih nominal vs pesanan</span><span className={selisihNominal < 0 ? "font-bold text-rose-600" : "font-bold text-emerald-600"}>{rupiah(selisihNominal)}</span></div>
              </div>

              <div className="flex gap-3 mt-5">
                <button onClick={() => { setKirimModal(null); setKirimItems([]); }} className="flex-1 rounded-2xl border border-slate-200 py-3 font-semibold text-slate-600">Batal</button>
                <button onClick={tandaiDikirim} className="flex-1 rounded-2xl bg-sky-600 py-3 font-semibold text-white">Simpan</button>
              </div>
            </div>
          </div>
        );
      })()}

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
