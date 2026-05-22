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
};

const PROD_STATUS = ["Antri", "Potong", "Jahit", "QC Packing", "Selesai"];
const PROCESSES_WITH_MODEL = ["Potong", "Jahit"];
const PROCESSES_NO_MODEL = ["QC Packing"];
const ALL_PROCESSES = [...PROCESSES_WITH_MODEL, ...PROCESSES_NO_MODEL];
const PRODUCT_TYPES = ["Kerudung", "Mukena", "Baju Anak", "Gamis", "Lainnya"];

const PROD_COLORS = {
  Antri: { bg: "#fef3c7", text: "#92400e", icon: "⏳" },
  Potong: { bg: "#dbeafe", text: "#1e40af", icon: "✂️" },
  Jahit: { bg: "#ede9fe", text: "#5b21b6", icon: "🧵" },
  "QC Packing": { bg: "#fce7f3", text: "#9d174d", icon: "📦" },
  Selesai: { bg: "#d1fae5", text: "#065f46", icon: "✅" },
};

const lower = (v) => String(v || "").toLowerCase();

function isSentStatus(status) {
  const s = lower(status);
  return s.includes("kirim") || s.includes("sent") || s.includes("shipped") || s.includes("terkirim");
}

function isDoneStatus(status) {
  const s = lower(status);
  return s === "selesai" || s === "lunas" || s.includes("done") || s.includes("complete");
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

function money(v) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(Number(v || 0));
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
      name: it.name || it.nama || it.item || it.productName || it.model || "-",
      qty: Number(it.qty || it.quantity || it.jumlah || 0),
      price: Number(it.price || it.harga || it.hargaPcs || 0),
    })).filter((it) => it.qty > 0 || it.name !== "-");
  }

  const totalQty = Number(d.qty || d.quantity || d.jumlah || d.totalQty || 0);

  if (items.length === 0) {
    items = [{ name: d.item || d.productName || d.produk || d.product || "Pesanan", qty: totalQty, price: Number(d.hargaPcs || d.price || 0) }];
  }

  return {
    id: d.id,
    customer: d.customer || d.customerName || d.nama || d.name || "-",
    item: d.item || d.productName || d.produk || d.product || "-",
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
      <label className="text-xs font-bold" style={{ color: "#a855f7" }}>{label}</label>
      <input
        value={value}
        type={type}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-full px-4 py-3 outline-none text-sm"
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
      <label className="text-xs font-bold" style={{ color: "#a855f7" }}>{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-3 outline-none text-sm"
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
            className="rounded-2xl px-4 py-2 text-sm font-semibold"
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

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [tab, setTab] = useState("pesanan");
  const [modal, setModal] = useState(null);
  const [search, setSearch] = useState("");
  const [rekapDari, setRekapDari] = useState(() => {
    const d = new Date(); d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [rekapSampai, setRekapSampai] = useState(() => new Date().toISOString().slice(0, 10));
  const [toast, setToast] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [setorModal, setSetorModal] = useState(null); // entry object yang akan disetor
  const [setorForm, setSetorForm] = useState({ qtySetor: "", qtyReject: "", tanggalSetor: todayStr(), catatan: "" });
  const [editEntryModal, setEditEntryModal] = useState(null); // entry yang sedang diedit
  const [editEntryForm, setEditEntryForm] = useState({ qty: "", tanggal: "", catatan: "", model: "" });
  const [deleteStep, setDeleteStep] = useState(0); // 0=idle, 1=konfirmasi1, 2=konfirmasi2
  const [slipPreview, setSlipPreview] = useState(null); // { nama, r, dari, sampai }

  const [orders, setOrders] = useState([]);
  const [produksi, setProduksi] = useState([]);
  const [workRates, setWorkRates] = useState([]);
  const [productionEntries, setProductionEntries] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [shipments, setShipments] = useState([]);
  const [payrollExpenses, setPayrollExpenses] = useState([]);

  const previousOrderIdsRef = useRef(new Set());
  const firstOrderLoadRef = useRef(true);

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
    tanggalKirim: todayStr(),
    penerima: "",
    ekspedisi: "",
    items: [{ nama: "", qtyPesan: 0, qtyKirim: 0 }],
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

    return () => {
      unsubOrders();
      unsubProduksi();
      unsubRates();
      unsubEntries();
      unsubMaterials();
      unsubShipments();
      unsubPayroll();
    };
  }, [user]);

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
    const map = new Map();
    produksi.forEach((p) => map.set(p.orderId, p));
    return map;
  }, [produksi]);

  const shipmentByOrderId = useMemo(() => {
    const map = new Map();

    shipments.forEach((p) => {
      orders.forEach((o) => {
        const matchById = sameText(p.pesananId, o.id) || sameText(p.orderId, o.id);
        const matchByInvoice = sameText(p.invoice, o.invoice);
        const matchByRaw = sameText(p.raw?.orderCode, o.invoice) || sameText(p.raw?.kode, o.invoice);

        if (matchById || matchByInvoice || matchByRaw) {
          const arr = map.get(o.id) || [];
          arr.push(p);
          map.set(o.id, arr);
        }
      });
    });

    return map;
  }, [shipments, orders]);

  function orderSmallStatus(order) {
    const kirim = shipmentByOrderId.get(order.id);
    const prod = produksiByOrderId.get(order.id);

    if ((kirim && kirim.length > 0) || isSentStatus(order.status)) return { label: "🚚 Sudah dikirim", color: "#2563eb" };
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
      const alreadyShipped = shipmentByOrderId.has(o.id) || lower(o.status) === "dikirim";
      const doneInGK = ["selesai", "lunas"].includes(lower(o.status));
      return !alreadyInProduction && !alreadyShipped && !doneInGK;
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
      const alreadyInProduction = produksiByOrderId.has(o.id);
      const alreadyShipped = shipmentByOrderId.has(o.id) || lower(o.status) === "dikirim";
      const doneInGK = ["selesai", "lunas"].includes(lower(o.status));
      return !alreadyInProduction && !alreadyShipped && !doneInGK;
    });
  }, [orders, produksiByOrderId, shipmentByOrderId]);

  const filteredProduksi = useMemo(() => {
    return produksi.filter((p) => {
      const txt = `${p.customer} ${p.item} ${p.invoice} ${p.status}`.toLowerCase();
      return q === "" || txt.includes(q);
    });
  }, [produksi, q]);

  const filteredEntries = useMemo(() => {
    return [...productionEntries]
      .sort((a, b) => String(b.tanggal || "").localeCompare(String(a.tanggal || "")))
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
        isDoneStatus(order.status) ||
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
    return orders
      .filter((o) => isDoneStatus(o.status) || isSentStatus(o.status))
      .map((o) => ({
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
        items: [
          {
            nama: o.item || "-",
            qtyPesan: Number(o.qty || 0),
            qtyKirim: Number(o.qty || 0),
          },
        ],
        totalKirim: Number(o.qty || 0),
        raw: o.raw,
      }))
      .filter((s) => {
        const txt = `${s.customer} ${s.produk} ${s.invoice} ${s.ekspedisi}`.toLowerCase();
        return q === "" || txt.includes(q);
      });
  }, [orders, q]);

  const stats = useMemo(() => {
    const selesaiOrders = orders.filter((o) => isDoneStatus(o.status) || isSentStatus(o.status));

    return {
      pesanan: orders.length,
      belum: ordersBelumProduksi.length,
      proses: produksi.filter((p) => p.status !== "Selesai").length,
      selesai: selesaiOrders.length,
      kirim: selesaiOrders.length,
      boronganPcs: productionEntries.reduce((s, e) => s + Number(e.qty || 0), 0),
      payroll: payrollExpenses.reduce((s, p) => s + Number(p.totalAmount || 0), 0),
    };
  }, [orders, produksi, productionEntries, payrollExpenses, ordersBelumProduksi]);

  
  const workerNameOptions = useMemo(() => {
    const names = new Set();
    productionEntries.forEach((e) => {
      if (e.employeeName) names.add(e.employeeName);
    });
    produksi.forEach((p) => {
      (p.workers || []).forEach((w) => {
        if (w.employeeName) names.add(w.employeeName);
      });
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [productionEntries, produksi]);

  function processQtyForOrder(orderId, process) {
    return productionEntries
      .filter((e) => e.orderId === orderId && e.process === process)
      .reduce((sum, e) => sum + Number(e.qty || 0), 0);
  }

  function isDuplicateEntry(payload) {
    return productionEntries.some((e) =>
      lower(e.employeeName) === lower(payload.employeeName) &&
      e.orderId === payload.orderId &&
      e.process === payload.process &&
      lower(e.model) === lower(payload.model) &&
      String(e.tanggal || "") === String(payload.tanggal || "")
    );
  }

function findRate(productType, model, process) {
    return workRates.find((r) => {
      const sameType = lower(r.productType) === lower(productType);
      const sameProcess = lower(r.process) === lower(process);
      if (process === "QC Packing") return sameType && sameProcess;
      return sameType && sameProcess && lower(r.model) === lower(model);
    });
  }

  function getRateForEmployee(productType, model, process, employeeName) {
    const rate = findRate(productType, model, process);
    if (!rate) return null;
    const isKonveksi = lower(employeeName || "").includes("konveksi");
    return { ...rate, rate: isKonveksi ? Number(rate.rate) - 500 : Number(rate.rate) };
  }

  async function addProduksi() {
    if (!prodForm.orderId) return alert("Pilih pesanan dulu");

    const order = orders.find((o) => o.id === prodForm.orderId);
    if (!order) return alert("Pesanan tidak ditemukan");
    if (produksiByOrderId.has(order.id)) return alert("Pesanan ini sudah masuk produksi");

    // Ambil items per model dari safeOrder (sudah di-parse dengan benar)
    // order.items sudah berisi breakdown per model yang benar dari Gallery Kerudung
    const orderItems = (order.items || []).length > 0
      ? order.items.map((it) => ({ name: it.name || it.item || "Pesanan", qty: Number(it.qty || 0), price: Number(it.price || 0) }))
      : [{ name: order.item || "Pesanan", qty: Number(order.qty || 0), price: 0 }];

    setIsSaving(true);
    try {
      await addDoc(collection(db, C.PRODUKSI), {
        orderId: order.id,
        invoice: order.invoice,
        customer: order.customer,
        item: order.item,
        qty: order.qty,
        items: orderItems, // per model
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
      setProdForm({ orderId: "", tanggalMulai: todayStr(), catatan: "" });
      setModal(null);
    } catch (e) {
      alert("Gagal menyimpan produksi: " + e.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function updateProduksiStatus(id, newStatus) {
    const item = produksi.find((p) => p.id === id);
    if (!item || item.status === newStatus) return;

    // Mapping status produksi → status pesanan di Gallery Kerudung
    const statusOrderMap = {
      "Antri": "Proses",
      "Jahit": "Proses",
      "QC": "Proses",
      "Packing": "Proses",
      "Selesai": "Selesai Produksi",
    };

    setIsSaving(true);
    try {
      await updateDoc(doc(db, C.PRODUKSI, id), {
        status: newStatus,
        updatedAt: todayStr(),
        history: [...(item.history || []), { tanggal: todayStr(), status: newStatus, catatan: "" }],
      });

      // Sync ke Gallery Kerudung — update status di collection orders
      if (item.orderId) {
        const orderStatusBaru = statusOrderMap[newStatus];
        if (orderStatusBaru) {
          try {
            await updateDoc(doc(db, C.ORDERS, item.orderId), {
              statusProduksi: newStatus,
              ...(newStatus === "Selesai" ? { status: "Selesai Produksi" } : {}),
            });
          } catch (_) {
            // Jika order tidak ditemukan, abaikan (mungkin sudah dihapus)
          }
        }
      }
    } catch (e) {
      alert("Gagal update status: " + e.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function addWorkRate() {
    if (!rateForm.productType) return alert("Jenis produk wajib diisi");
    if (rateForm.process !== "QC Packing" && !rateForm.model.trim()) return alert("Model wajib diisi");
    if (!rateForm.rate || Number(rateForm.rate) <= 0) return alert("Tarif wajib diisi");

    setIsSaving(true);
    try {
      await addDoc(collection(db, C.WORK_RATES), {
        productType: rateForm.productType,
        model: rateForm.process === "QC Packing" ? "" : rateForm.model.trim(),
        process: rateForm.process,
        rate: Number(rateForm.rate),
        source: "gallery-produksi",
        createdAt: todayStr(),
      });
      setRateForm({ productType: "Kerudung", model: "", process: "Jahit", rate: "" });
      setModal(null);
    } catch (e) {
      alert("Gagal simpan tarif: " + e.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function addProductionEntry() {
    if (!entryForm.employeeName.trim()) return alert("Nama pekerja wajib diisi");
    if (!entryForm.qty || Number(entryForm.qty) <= 0) return alert("Qty wajib diisi");
    if (entryForm.process !== "QC Packing" && !entryForm.model.trim()) return alert("Model wajib diisi");

    const rate = getRateForEmployee(entryForm.productType, entryForm.model, entryForm.process, entryForm.employeeName);
    if (!rate) return alert("Tarif belum ada. Tambahkan dulu di menu Tarif.");

    const order = orders.find((o) => o.id === entryForm.orderId);
    const prod = order ? produksiByOrderId.get(order.id) : null;
    const totalWage = Number(entryForm.qty) * Number(rate.rate || 0);

    const draftPayloadForCheck = {
      employeeName: entryForm.employeeName.trim(),
      orderId: entryForm.orderId || "",
      process: entryForm.process,
      model: entryForm.process === "QC Packing" ? "" : entryForm.model.trim(),
      tanggal: entryForm.tanggal,
    };

    if (isDuplicateEntry(draftPayloadForCheck)) {
      return alert("Data borongan ini sudah pernah diinput untuk pekerja, proses, tanggal, dan pesanan yang sama.");
    }

    if (order) {
      const alreadyQty = processQtyForOrder(order.id, entryForm.process);
      const nextQty = alreadyQty + Number(entryForm.qty || 0);
      if (nextQty > Number(order.qty || 0)) {
        return alert(
          `Qty ${entryForm.process} melebihi qty pesanan.\n` +
          `Pesanan: ${order.qty} pcs\n` +
          `Sudah input: ${alreadyQty} pcs\n` +
          `Input baru: ${entryForm.qty} pcs`
        );
      }
    }

    setIsSaving(true);
    try {
      const entryPayload = {
        employeeName: entryForm.employeeName.trim(),
        orderId: entryForm.orderId || "",
        produksiId: prod?.id || "",
        invoice: order?.invoice || "",
        customer: order?.customer || "",
        item: order?.item || "",
        productType: entryForm.productType,
        model: entryForm.process === "QC Packing" ? "" : entryForm.model.trim(),
        process: entryForm.process,
        qty: Number(entryForm.qty),
        rate: Number(rate.rate || 0),
        totalWage,
        tanggal: entryForm.tanggal,
        catatan: entryForm.catatan || "",
        source: "gallery-produksi",
        createdAt: todayStr(),
      };

      await addDoc(collection(db, C.PRODUCTION_ENTRIES), entryPayload);

      if (prod) {
        await updateDoc(doc(db, C.PRODUKSI, prod.id), {
          workers: [
            ...(prod.workers || []),
            {
              employeeName: entryPayload.employeeName,
              process: entryPayload.process,
              productType: entryPayload.productType,
              model: entryPayload.model,
              qty: entryPayload.qty,
              tanggal: entryPayload.tanggal,
            },
          ],
          updatedAt: todayStr(),
        });
      }

      // Payroll TIDAK dibuat di sini — dibuat saat pekerja setor hasil

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
    const qtySetor = Number(setorForm.qtySetor);
    const qtyReject = Number(setorForm.qtyReject || 0);
    if (!qtySetor || qtySetor <= 0) return alert("Qty setor wajib diisi.");
    if (qtySetor + qtyReject > setorModal.qty) {
      return alert(
        `Total setor + reject (${qtySetor + qtyReject} pcs) melebihi qty awal (${setorModal.qty} pcs).`
      );
    }
    const rate = Number(setorModal.rate || 0);
    const totalWageSetor = qtySetor * rate;
    const tanggalSetor = setorForm.tanggalSetor || todayStr();

    setIsSaving(true);
    try {
      // Update entry dengan hasil setor
      await updateDoc(doc(db, C.PRODUCTION_ENTRIES, setorModal.id), {
        qtySetor,
        qtyReject,
        totalWageSetor,
        statusSetor: "sudah_setor",
        tanggalSetor,
        catatanSetor: setorForm.catatan || "",
      });

      // Buat payroll berdasarkan qty yang disetor (bukan qty awal)
      await addDoc(collection(db, C.PAYROLL_EXPENSES), {
        source: "gallery-produksi",
        type: "gaji_borongan",
        employeeName: setorModal.employeeName,
        orderId: setorModal.orderId || "",
        invoice: setorModal.invoice || "",
        productType: setorModal.productType,
        model: setorModal.model || "",
        process: setorModal.process,
        totalPcs: qtySetor,
        totalAmount: totalWageSetor,
        status: "belum_dibayar",
        tanggal: tanggalSetor,
        createdAt: todayStr(),
        entryId: setorModal.id,
        qtyAwal: setorModal.qty,
        qtyReject,
      });

      setSetorModal(null);
      setSetorForm({ qtySetor: "", qtyReject: "", tanggalSetor: todayStr(), catatan: "" });
    } catch (e) {
      alert("Gagal simpan setor: " + e.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function addPengiriman() {
    if (!kirimForm.pesananId) return alert("Pilih pesanan dulu");
    if (!kirimForm.penerima.trim()) return alert("Penerima wajib diisi");

    const order = orders.find((o) => o.id === kirimForm.pesananId);
    if (!order) return alert("Pesanan tidak ditemukan");

    const items = kirimForm.items.map((i) => ({
      nama: i.nama || "",
      qtyPesan: Number(i.qtyPesan || 0),
      qtyKirim: Number(i.qtyKirim || 0),
      selisih: Number(i.qtyKirim || 0) - Number(i.qtyPesan || 0),
    }));

    setIsSaving(true);
    try {
      await addDoc(collection(db, C.SHIPMENTS), {
        pesananId: order.id,
        orderId: order.id,
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
        items,
        qty: items.reduce((s, i) => s + i.qtyKirim, 0),
        totalPesan: items.reduce((s, i) => s + i.qtyPesan, 0),
        totalKirim: items.reduce((s, i) => s + i.qtyKirim, 0),
        catatan: kirimForm.catatan || "",
        note: kirimForm.catatan || "",
        source: "gallery-produksi",
        createdAt: todayStr(),
      });

      const prod = produksiByOrderId.get(order.id);
      if (prod) {
        await updateDoc(doc(db, C.PRODUKSI, prod.id), {
          status: "Selesai",
          updatedAt: todayStr(),
          history: [
            ...(prod.history || []),
            { tanggal: todayStr(), status: "Selesai", catatan: "Otomatis selesai karena sudah dikirim" },
          ],
        });
      }

      try {
        await updateDoc(doc(db, C.ORDERS, order.id), {
          status: "Dikirim",
          shippingStatus: "Dikirim",
          updatedAt: todayStr(),
        });
      } catch (e) {
        console.warn("Order status tidak bisa diupdate:", e);
      }

      setKirimForm({
        pesananId: "",
        tanggalKirim: todayStr(),
        penerima: "",
        ekspedisi: "",
        items: [{ nama: "", qtyPesan: 0, qtyKirim: 0 }],
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
        await deleteDoc(doc(db, C.PRODUCTION_ENTRIES, id));
        // Jika sudah ada payroll terkait, hapus juga
        const payrollSnap = await getDocs(query(collection(db, C.PAYROLL_EXPENSES), where("entryId", "==", id)));
        for (const d of payrollSnap.docs) await deleteDoc(d.ref);
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
    if (!editEntryForm.qty || Number(editEntryForm.qty) <= 0) return alert("Qty wajib diisi");
    setIsSaving(true);
    try {
      const updates = {
        qty: Number(editEntryForm.qty),
        tanggal: editEntryForm.tanggal,
        catatan: editEntryForm.catatan || "",
        updatedAt: todayStr(),
      };
      if (editEntryModal.process !== "QC Packing") {
        updates.model = editEntryForm.model || editEntryModal.model;
      }
      await updateDoc(doc(db, C.PRODUCTION_ENTRIES, editEntryModal.id), updates);
      setEditEntryModal(null);
      setToast("✅ Entry berhasil diupdate");
      setTimeout(() => setToast(""), 3000);
    } catch (e) {
      alert("Gagal update: " + e.message);
    } finally {
      setIsSaving(false);
    }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: "#fdf2f8" }}>
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
          { label: "Belum", value: stats.belum, color: "#f59e0b", icon: "⏳" },
          { label: "Proses", value: stats.proses, color: "#a855f7", icon: "🧵" },
          { label: "Selesai", value: stats.selesai, color: "#10b981", icon: "✅" },
          { label: "Kirim", value: stats.kirim, color: "#0ea5e9", icon: "🚚" },
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

      <div className="sticky top-0 z-40 flex bg-white shadow-sm" style={{ borderBottom: "2px solid #fce7f3" }}>
        {[
          { id: "pesanan", label: "Pesanan", icon: "📋", badge: stats.belum },
          { id: "produksi", label: "Produksi", icon: "🧵" },
          { id: "borongan", label: "Borongan", icon: "💪" },
          { id: "rekap", label: "Rekap", icon: "📊" },
          { id: "kain", label: "Kain", icon: "🎨" },
          { id: "kirim", label: "Kirim", icon: "🚚" },
          { id: "tarif", label: "Tarif", icon: "🏷️" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="flex-1 py-3 text-[10px] font-semibold flex flex-col items-center gap-1 relative"
            style={{
              color: tab === t.id ? "#ec4899" : "#94a3b8",
              borderBottom: tab === t.id ? "3px solid #ec4899" : "3px solid transparent",
              background: tab === t.id ? "#fdf2f8" : "white",
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
        ))}
      </div>

      {tab === "pesanan" && (
        <div className="space-y-3 p-4">
          <InfoBox title="Sumber: Gallery Kerudung" subtitle="Data realtime dari collection orders" icon="🏪" />
          {filteredOrders.length === 0 && <Empty text="Tidak ada data pesanan" />}
          {filteredOrders.map((o) => {
            const prod = produksiByOrderId.get(o.id);
            const small = orderSmallStatus(o);
            const canStart = ordersBelumProduksi.some((x) => x.id === o.id);
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
                            👤 {w.employeeName} · {w.process} · {w.qty} pcs
                          </div>
                        ))}
                      </div>
                    )}
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
          {filteredProduksi.length === 0 && <Empty text="Tidak ada data produksi" />}
          {filteredProduksi.map((p) => {
            const qtyPesanan = Number(p.qty || 0);
            const rekapProses = [
              { label: "✂️ Potong", qty: processQtyForOrder(p.orderId, "Potong") },
              { label: "🧵 Jahit", qty: processQtyForOrder(p.orderId, "Jahit") },
              { label: "📦 QC", qty: processQtyForOrder(p.orderId, "QC Packing") },
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
                          .filter(e => e.orderId === p.orderId && lower(e.process) === "potong" && lower(e.model || "") === lower(modelName))
                          .reduce((s, e) => s + Number(e.qty || 0), 0);
                        const jahitQty = productionEntries
                          .filter(e => e.orderId === p.orderId && lower(e.process) === "jahit" && lower(e.model || "") === lower(modelName))
                          .reduce((s, e) => s + Number(e.qty || 0), 0);
                        const qcQty = productionEntries
                          .filter(e => e.orderId === p.orderId && lower(e.process) === "qc packing")
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
        </div>
      )}

      {tab === "borongan" && (
        <div className="space-y-3 p-4">
          <Button onClick={() => setModal("borongan")} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
            💪 + Input Hasil Borongan
          </Button>
          <div className="rounded-2xl bg-white p-4" style={{ border: "1px solid #fce7f3" }}>
            <div className="text-xs font-bold" style={{ color: "#a855f7" }}>Total hasil borongan</div>
            <div className="text-2xl font-bold" style={{ color: "#ec4899" }}>{stats.boronganPcs} pcs</div>
            <div className="text-xs" style={{ color: "#94a3b8" }}>Upah tersimpan untuk pengeluaran Gallery Kerudung</div>
          </div>


          {filteredEntries.map((e) => {
            const sudahSetor = e.statusSetor === "sudah_setor";
            const qtyReject = Number(e.qtyReject || 0);
            const qtySetor = Number(e.qtySetor || 0);
            const selisih = Number(e.qty) - qtySetor - qtyReject;
            return (
            <div key={e.id} className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: `1.5px solid ${sudahSetor ? "#bbf7d0" : "#fde68a"}` }}>
              <div className="flex justify-between">
                <div>
                  <div className="font-bold" style={{ color: "#2d1b69" }}>👤 {e.employeeName}</div>
                  <div className="text-xs mt-1" style={{ color: "#a855f7" }}>{e.productType} · {e.process}{e.model ? ` · ${e.model}` : ""}</div>
                  {e.invoice && <div className="text-xs" style={{ color: "#94a3b8" }}>🧾 {e.invoice}</div>}
                  <div className="text-xs" style={{ color: "#94a3b8" }}>📅 {e.tanggal}</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold" style={{ color: "#10b981" }}>{e.qty}</div>
                  <div className="text-xs" style={{ color: "#94a3b8" }}>pcs diberikan</div>
                </div>
              </div>

              {/* Status setor */}
              {sudahSetor ? (
                <div className="mt-3 rounded-2xl p-3 space-y-1" style={{ background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
                  <div className="text-xs font-bold" style={{ color: "#16a34a" }}>✅ Sudah Setor — {e.tanggalSetor}</div>
                  <div className="flex gap-4 text-sm">
                    <span>✔️ Setor: <strong>{qtySetor} pcs</strong></span>
                    {qtyReject > 0 && <span>❌ Reject: <strong style={{ color: "#ef4444" }}>{qtyReject} pcs</strong></span>}
                    {selisih > 0 && <span>⚠️ Kurang: <strong style={{ color: "#f59e0b" }}>{selisih} pcs</strong></span>}
                  </div>
                  {e.totalWageSetor > 0 && (
                    <div className="text-sm font-bold" style={{ color: "#a855f7" }}>💰 Gaji: {money(e.totalWageSetor)}</div>
                  )}
                  {e.catatanSetor && <div className="text-xs" style={{ color: "#64748b" }}>📝 {e.catatanSetor}</div>}
                </div>
              ) : (
                <div className="mt-3 flex items-center justify-between rounded-2xl px-3 py-2" style={{ background: "#fefce8", border: "1px solid #fde68a" }}>
                  <span className="text-xs font-bold" style={{ color: "#b45309" }}>🟡 Belum Setor</span>
                  <button
                    onClick={() => { setSetorModal(e); setSetorForm({ qtySetor: String(e.qty), qtyReject: "", tanggalSetor: todayStr(), catatan: "" }); }}
                    className="rounded-xl px-3 py-1 text-xs font-bold text-white"
                    style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}
                  >
                    Setor Hasil
                  </button>
                </div>
              )}

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
        const inRange = (tanggal) => {
          if (!tanggal) return false;
          return tanggal >= rekapDari && tanggal <= rekapSampai;
        };
        const filtered = productionEntries.filter((e) => inRange(e.tanggalSetor || e.tanggal));
        const byProses = {};
        filtered.forEach((e) => {
          const p = e.process || "Lainnya";
          if (!byProses[p]) byProses[p] = { qty: 0, qtySetor: 0, qtyReject: 0, gaji: 0 };
          byProses[p].qty += Number(e.qty || 0);
          byProses[p].qtySetor += Number(e.qtySetor || 0);
          byProses[p].qtyReject += Number(e.qtyReject || 0);
          byProses[p].gaji += Number(e.totalWageSetor || 0);
        });
        const totalQty = filtered.reduce((s, e) => s + Number(e.qty || 0), 0);
        const totalSetor = filtered.reduce((s, e) => s + Number(e.qtySetor || 0), 0);
        const totalReject = filtered.reduce((s, e) => s + Number(e.qtyReject || 0), 0);
        const totalGaji = filtered.reduce((s, e) => s + Number(e.totalWageSetor || 0), 0);
        const prosesOrder = ["Potong", "Jahit", "QC Packing"];
        const prosesKeys = [...prosesOrder.filter((p) => byProses[p]), ...Object.keys(byProses).filter((p) => !prosesOrder.includes(p))];
        // Logika rantai: diberikan ke proses berikutnya = disetor dari proses sebelumnya
        if (byProses["Potong"]) byProses["Potong"].qtyDiberikan = byProses["Potong"].qty;
        if (byProses["Jahit"]) byProses["Jahit"].qtyDiberikan = byProses["Potong"]?.qtySetor ?? byProses["Jahit"].qty;
        if (byProses["QC Packing"]) byProses["QC Packing"].qtyDiberikan = byProses["Jahit"]?.qtySetor ?? byProses["QC Packing"].qty;

        // Rekap per pekerja (dipindah dari tab Borongan)
        const rekapMap = {};
        filtered.forEach((e) => {
          const nama = e.employeeName || "Tidak diketahui";
          if (!rekapMap[nama]) rekapMap[nama] = { pcsAwal: 0, pcsSetor: 0, pcsReject: 0, gaji: 0, belumSetor: 0, detail: [] };
          rekapMap[nama].pcsAwal += Number(e.qty || 0);
          if (e.statusSetor === "sudah_setor") {
            rekapMap[nama].pcsSetor += Number(e.qtySetor || 0);
            rekapMap[nama].pcsReject += Number(e.qtyReject || 0);
            rekapMap[nama].gaji += Number(e.totalWageSetor || 0);
          } else {
            rekapMap[nama].belumSetor += Number(e.qty || 0);
          }
          // Fallback customer dari orders jika entry lama tidak punya field customer
          const entryOrder = orders.find(o => o.id === e.orderId);
          rekapMap[nama].detail.push({
            customer: e.customer || entryOrder?.customer || "-",
            invoice: e.invoice || entryOrder?.invoice || "",
            model: e.model || "-",
            process: e.process || "",
            qty: Number(e.qty || 0),
            qtySetor: Number(e.qtySetor || 0),
            qtyReject: Number(e.qtyReject || 0),
            rate: Number(e.rate || 0),
            sudahSetor: e.statusSetor === "sudah_setor",
            gaji: Number(e.totalWageSetor || 0),
            tanggal: e.tanggal || "",
            tanggalSetor: e.tanggalSetor || "",
          });
        });
        const rekapPerkerja = Object.entries(rekapMap).sort((a, b) => b[1].gaji - a[1].gaji);

        // Fungsi download slip gaji per pekerja
        function downloadSlipGaji(nama, r) {
          const fmt = (v) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(v || 0));
          // Urutkan detail berdasarkan tanggal ascending
          const sortedDetail = [...r.detail].sort((a, b) => {
            const da = a.tanggalSetor || a.tanggal || "";
            const db = b.tanggalSetor || b.tanggal || "";
            return da.localeCompare(db);
          });
          const rows = sortedDetail.map((d, i) => {
            const tgl = d.tanggalSetor || d.tanggal || "-";
            const pesanan = d.customer && d.customer !== "-" ? d.customer + (d.invoice ? "<br><span style=\"font-size:10px;color:#94a3b8;\">" + d.invoice + "</span>" : "") : (d.invoice || "-");
            const prosesModel = d.process + (d.model && d.model !== "-" ? " · " + d.model : "");
            const diberi = d.qty;
            const setor = d.sudahSetor ? d.qtySetor : "-";
            const reject = d.qtyReject > 0 ? d.qtyReject : "-";
            const pendapatan = d.sudahSetor ? `<strong style="color:#16a34a;">${fmt(d.gaji)}</strong>` : `<span style="color:#b45309;">⏳ Blm setor</span>`;
            return `<tr style="border-bottom:1px solid #f3e8ff;">
              <td style="padding:8px 10px;font-size:12px;color:#94a3b8;">${i + 1}</td>
              <td style="padding:8px 10px;font-size:12px;">${tgl}</td>
              <td style="padding:8px 10px;font-size:12px;">${pesanan}</td>
              <td style="padding:8px 10px;font-size:12px;">${prosesModel}</td>
              <td style="padding:8px 10px;text-align:center;font-size:12px;">${diberi} pcs</td>
              <td style="padding:8px 10px;text-align:center;font-size:12px;color:${setor !== "-" ? "#16a34a" : "#94a3b8"};">${setor !== "-" ? setor + " pcs" : "-"}</td>
              <td style="padding:8px 10px;text-align:center;font-size:12px;color:${reject !== "-" ? "#ef4444" : "#94a3b8"};">${reject !== "-" ? reject + " pcs" : "-"}</td>
              <td style="padding:8px 10px;text-align:right;font-size:12px;">${d.rate > 0 ? fmt(d.rate) + "/pcs" : "-"}</td>
              <td style="padding:8px 10px;text-align:right;font-size:12px;">${pendapatan}</td>
            </tr>`;
          }).join("");

          const logoSrc = "data:image/png;base64,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";
          const cetakTgl = new Date().toLocaleDateString("id-ID", { day:"2-digit", month:"long", year:"numeric" });
          const html = `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8">
            <title>Slip Pendapatan - ${nama}</title>
            <style>
              * { box-sizing: border-box; }
              body { font-family: 'Segoe UI', Arial, sans-serif; background: #fdf2f8; margin: 0; padding: 20px; }
              .slip { max-width: 780px; margin: 0 auto; background: white; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 24px rgba(236,72,153,0.15); }
              .header { background: linear-gradient(135deg,#ec4899,#a855f7); color: white; padding: 24px 28px; display:flex; align-items:center; gap:18px; }
              .header img { width:64px; height:64px; border-radius:14px; border:3px solid rgba(255,255,255,0.4); object-fit:cover; background:white; }
              .header-text h1 { margin:0 0 3px; font-size:20px; font-weight:900; }
              .header-text p { margin:0; font-size:12px; opacity:0.85; }
              .header-text small { font-size:11px; opacity:0.7; }
              .body { padding: 22px 28px; }
              .info-box { background:#fdf4ff; border:1px solid #e9d5ff; border-radius:14px; padding:14px 16px; margin-bottom:16px; }
              .info-row { display:flex; justify-content:space-between; font-size:13px; padding:3px 0; }
              .info-row span { color:#94a3b8; }
              .info-row strong { color:#2d1b69; }
              .divider { border:none; border-top:1.5px solid #f3e8ff; margin:16px 0; }
              table { width:100%; border-collapse:collapse; font-size:12px; }
              thead tr { background:linear-gradient(135deg,#ede9fe,#fce7f3); }
              th { padding:9px 10px; font-size:11px; color:#7c3aed; text-align:left; font-weight:700; white-space:nowrap; }
              .total-row { background:linear-gradient(135deg,#ede9fe,#fce7f3); }
              .total-row td { padding:10px; font-size:13px; font-weight:700; }
              .total-box { margin-top:16px; background:linear-gradient(135deg,#f0fdf4,#dcfce7); border-radius:14px; padding:16px 18px; border:1.5px solid #bbf7d0; }
              .ttd-row { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-top:24px; }
              .ttd-box { border:1px solid #e9d5ff; border-radius:14px; padding:14px 16px; text-align:center; }
              .ttd-box .label { font-size:11px; color:#94a3b8; margin-bottom:52px; }
              .ttd-box .name { font-size:12px; font-weight:700; color:#2d1b69; border-top:1.5px solid #c4b5fd; padding-top:6px; margin-top:4px; }
              .footer { text-align:center; font-size:11px; color:#a855f7; padding:14px 28px 18px; border-top:1.5px solid #fce7f3; }
              @media print {
                body { background:white; padding:0; }
                .slip { box-shadow:none; border-radius:0; }
                @page { margin: 1cm; }
              }
            </style>
          </head><body>
            <div class="slip">
              <div class="header">
                <img src="${logoSrc}" alt="Logo Gallery Kerudung" />
                <div class="header-text">
                  <h1>Slip Pendapatan Borongan</h1>
                  <p>Gallery Kerudung</p>
                  <small>Dokumen resmi penggajian borongan</small>
                </div>
              </div>
              <div class="body">
                <div class="info-box">
                  <div class="info-row"><span>Nama Pekerja</span><strong>👤 ${nama}</strong></div>
                  <div class="info-row"><span>Periode</span><strong>📅 ${r.dari || ""} s/d ${r.sampai || ""}</strong></div>
                  <div class="info-row"><span>Tanggal Cetak</span><strong>${cetakTgl}</strong></div>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Tanggal</th>
                      <th>Pesanan</th>
                      <th>Proses / Model</th>
                      <th style="text-align:center;">Diberi</th>
                      <th style="text-align:center;">Setor</th>
                      <th style="text-align:center;">Reject</th>
                      <th style="text-align:right;">Tarif</th>
                      <th style="text-align:right;">Pendapatan</th>
                    </tr>
                  </thead>
                  <tbody>${rows}</tbody>
                  <tfoot>
                    <tr class="total-row">
                      <td colspan="4">TOTAL</td>
                      <td style="text-align:center;">${r.pcsAwal} pcs</td>
                      <td style="text-align:center;color:#16a34a;">${r.pcsSetor} pcs</td>
                      <td style="text-align:center;color:${r.pcsReject > 0 ? "#ef4444" : "#94a3b8"};">${r.pcsReject > 0 ? r.pcsReject + " pcs" : "-"}</td>
                      <td></td>
                      <td style="text-align:right;color:#16a34a;font-size:15px;">${fmt(r.gaji)}</td>
                    </tr>
                  </tfoot>
                </table>
                ${r.belumSetor > 0 ? `<div style="margin-top:12px;background:#fefce8;border-radius:10px;padding:10px 14px;font-size:12px;color:#b45309;border:1px solid #fde68a;">⚠️ Masih ada <strong>${r.belumSetor} pcs</strong> belum disetor, belum termasuk total di atas.</div>` : ""}
                <div class="total-box">
                  <div style="font-size:12px;color:#64748b;margin-bottom:4px;">Total Pendapatan Bersih</div>
                  <div style="font-size:26px;font-weight:900;color:#16a34a;">${fmt(r.gaji)}</div>
                </div>
                <div class="ttd-row">
                  <div class="ttd-box">
                    <div class="label">Hormat saya, pekerja</div>
                    <div class="name">${nama}</div>
                  </div>
                  <div class="ttd-box">
                    <div class="label">Mengetahui, Gallery Kerudung</div>
                    <div class="name">( ________________ )</div>
                  </div>
                </div>
              </div>
              <div class="footer">
                Dicetak otomatis oleh sistem Gallery Kerudung · ${cetakTgl}
              </div>
            </div>
            <div style="text-align:center;padding:20px 0 10px;"><button onclick="window.print()" style="background:linear-gradient(135deg,#ec4899,#a855f7);color:white;border:none;border-radius:14px;padding:12px 32px;font-size:15px;font-weight:700;cursor:pointer;">🖨️ Cetak / Simpan PDF</button></div>
          </body></html>`;

          // Buka di tab baru (lebih kompatibel mobile/PWA)
          const newTab = window.open("", "_blank");
          if (newTab) {
            newTab.document.write(html);
            newTab.document.close();
          } else {
            // Fallback blob jika popup diblokir
            const blob = new Blob([html], { type: "text/html;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `SlipGaji_${nama.replace(/\s+/g, "_")}_${r.dari}_sd_${r.sampai}.html`;
            a.click();
            URL.revokeObjectURL(url);
          }
          return html; // kembalikan untuk keperluan lain
        }

        return (
          <div className="space-y-3 p-4">
            {/* Filter tanggal */}
            <div className="rounded-2xl bg-white p-4 space-y-2" style={{ border: "1px solid #e9d5ff" }}>
              <div className="text-xs font-bold mb-1" style={{ color: "#7c3aed" }}>📅 Filter Periode</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs mb-1" style={{ color: "#94a3b8" }}>Dari</div>
                  <input type="date" value={rekapDari} onChange={(e) => setRekapDari(e.target.value)}
                    className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#e9d5ff" }} />
                </div>
                <div>
                  <div className="text-xs mb-1" style={{ color: "#94a3b8" }}>Sampai</div>
                  <input type="date" value={rekapSampai} onChange={(e) => setRekapSampai(e.target.value)}
                    className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#e9d5ff" }} />
                </div>
              </div>
              <div className="flex gap-2 mt-1">
                {[
                  { label: "Hari ini", dari: todayStr(), sampai: todayStr() },
                  { label: "Minggu ini", dari: (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay()); return d.toISOString().slice(0, 10); })(), sampai: todayStr() },
                  { label: "Bulan ini", dari: (() => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); })(), sampai: todayStr() },
                ].map((s) => (
                  <button key={s.label} onClick={() => { setRekapDari(s.dari); setRekapSampai(s.sampai); }}
                    className="flex-1 rounded-xl py-1.5 text-xs font-bold"
                    style={{ background: "#f3e8ff", color: "#7c3aed" }}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

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

            {/* Rekap per proses */}
            {prosesKeys.length > 0 ? (
              <div className="rounded-2xl bg-white p-4 space-y-3" style={{ border: "1px solid #e9d5ff" }}>
                <div className="text-xs font-bold" style={{ color: "#7c3aed" }}>📋 Per Proses</div>
                {prosesKeys.map((p) => {
                  const r = byProses[p];
                  const icon = p === "Potong" ? "✂️" : p === "Jahit" ? "🧵" : p === "QC Packing" ? "📦" : "🔧";
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
                {rekapPerkerja.map(([nama, r]) => (
                  <div key={nama} className="rounded-xl overflow-hidden" style={{ border: "1px solid #e9d5ff" }}>
                    {/* Header pekerja */}
                    <div className="flex justify-between items-center px-3 py-2" style={{ background: "linear-gradient(135deg,#ede9fe,#fce7f3)" }}>
                      <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>👤 {nama}</div>
                      <div className="text-sm font-bold" style={{ color: "#16a34a" }}>{money(r.gaji)}</div>
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
                        onClick={() => setSlipPreview({ nama, r, dari: rekapDari, sampai: rekapSampai })}
                        className="w-full rounded-xl py-2.5 text-xs font-bold text-white flex items-center justify-center gap-2"
                        style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}
                      >
                        👁️ Lihat Slip Gaji · {rekapDari} s/d {rekapSampai}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {tab === "kain" && (
        <div className="space-y-3 p-4">
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
          {filteredShipments.length === 0 && <Empty text="Tidak ada data pengiriman" />}
          {filteredShipments.map((k) => (
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
          ))}
        </div>
      )}

      {tab === "tarif" && (
        <div className="space-y-3 p-4">
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
              {orders.map((o) => <option key={o.id} value={o.id}>{o.customer} · {o.invoice || o.item} · {o.qty} pcs</option>)}
            </Select>

            <Select label="Jenis Produk" value={entryForm.productType} onChange={(v) => setEntryForm((f) => ({ ...f, productType: v }))}>
              {PRODUCT_TYPES.map((p) => <option key={p}>{p}</option>)}
            </Select>
            <Select label="Proses" value={entryForm.process} onChange={(v) => setEntryForm((f) => ({ ...f, process: v, model: v === "QC Packing" ? "" : f.model }))}>
              {ALL_PROCESSES.map((p) => <option key={p}>{p}</option>)}
            </Select>

            {entryForm.process !== "QC Packing" && (() => {
              // Ambil items dari order.items yang sudah di-parse safeOrder dengan benar
              const selOrder = orders.find(o => o.id === entryForm.orderId);
              // Gunakan order.items langsung (sudah include semua field name/qty dari Gallery Kerudung)
              const orderModels = selOrder
                ? (selOrder.items || []).filter(it => it.name && it.name !== "-" && Number(it.qty) > 0)
                : [];

              if (orderModels.length > 0) {
                return (
                  <div>
                    <div className="text-xs font-bold mb-2" style={{ color: "#7c3aed" }}>
                      Pilih Model ({orderModels.length} model tersedia):
                    </div>
                    <div className="space-y-1.5">
                      {orderModels.map((it, i) => {
                        const nama = it.name || it.item || "-";
                        const qtyModel = Number(it.qty || 0);
                        const sudahInput = productionEntries
                          .filter(e => e.orderId === entryForm.orderId && lower(e.process) === lower(entryForm.process) && lower(e.model || "") === lower(nama))
                          .reduce((s, e) => s + Number(e.qty || 0), 0);
                        const sisaQty = Math.max(0, qtyModel - sudahInput);
                        const selected = entryForm.model === nama;
                        const habis = sisaQty === 0;
                        return (
                          <button
                            key={i}
                            type="button"
                            onClick={() => !habis && setEntryForm(f => ({ ...f, model: nama, qty: String(sisaQty) }))}
                            className="w-full rounded-xl px-3 py-2.5 text-xs font-bold text-left flex justify-between items-center"
                            style={{
                              background: selected ? "linear-gradient(135deg,#ec4899,#a855f7)" : habis ? "#f1f5f9" : "#fdf2f8",
                              color: selected ? "white" : habis ? "#94a3b8" : "#5b21b6",
                              border: selected ? "none" : `1px solid ${habis ? "#e2e8f0" : "#c4b5fd"}`,
                              cursor: habis ? "not-allowed" : "pointer",
                            }}
                          >
                            <div>
                              <div>{nama} {habis ? "✅ Selesai" : ""}</div>
                              <div className="font-normal mt-0.5" style={{ color: selected ? "rgba(255,255,255,0.75)" : "#94a3b8" }}>
                                Total: {qtyModel} pcs · Sudah input: {sudahInput} pcs
                              </div>
                            </div>
                            <div className="text-right ml-3">
                              <div style={{ color: selected ? "white" : habis ? "#94a3b8" : "#ec4899", fontWeight: 900, fontSize: 14 }}>
                                {sisaQty}
                              </div>
                              <div className="font-normal" style={{ color: selected ? "rgba(255,255,255,0.75)" : "#94a3b8" }}>sisa</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {entryForm.model && (
                      <div className="mt-2 rounded-xl px-3 py-2 text-xs font-semibold" style={{ background: "#ede9fe", color: "#7c3aed" }}>
                        ✅ Model dipilih: <strong>{entryForm.model}</strong>
                      </div>
                    )}
                  </div>
                );
              } else {
                // Tidak ada multi-model / pesanan tidak dipilih — input model manual
                return (
                  <Input label="Model" value={entryForm.model} onChange={(v) => setEntryForm((f) => ({ ...f, model: v }))} placeholder="Harus sama dengan tarif" />
                );
              }
            })()}

            {entryForm.process === "QC Packing" && (
              <div className="rounded-2xl p-3 text-xs font-semibold" style={{ background: "#fdf2f8", color: "#a855f7" }}>
                QC Packing tidak memakai model, hanya jenis produk.
              </div>
            )}
            <Input label="Jumlah pcs" type="number" value={entryForm.qty} onChange={(v) => setEntryForm((f) => ({ ...f, qty: v }))} placeholder="Contoh: 500" />
            <Input label="Tanggal" type="date" value={entryForm.tanggal} onChange={(v) => setEntryForm((f) => ({ ...f, tanggal: v }))} />
            <Input label="Catatan" value={entryForm.catatan} onChange={(v) => setEntryForm((f) => ({ ...f, catatan: v }))} placeholder="Opsional" />
            <Button onClick={addProductionEntry} disabled={isSaving} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
              Simpan Hasil Borongan
            </Button>
          </div>
        </Modal>
      )}

      {/* Modal Setor Hasil Borongan */}
      {setorModal && (
        <Modal title="📦 Setor Hasil Borongan" onClose={() => setSetorModal(null)}>
          <div className="space-y-3">
            <div className="rounded-2xl p-3" style={{ background: "#fdf2f8", border: "1px solid #fce7f3" }}>
              <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>👤 {setorModal.employeeName}</div>
              <div className="text-xs" style={{ color: "#a855f7" }}>{setorModal.productType} · {setorModal.process}{setorModal.model ? ` · ${setorModal.model}` : ""}</div>
              <div className="text-xs" style={{ color: "#94a3b8" }}>Qty diberikan: <strong>{setorModal.qty} pcs</strong></div>
            </div>
            <Input
              label="Qty Disetor (pcs)"
              type="number"
              value={setorForm.qtySetor}
              onChange={(v) => setSetorForm((f) => ({ ...f, qtySetor: v }))}
              placeholder={`Maks ${setorModal.qty} pcs`}
            />
            <Input
              label="Qty Reject (pcs) — opsional"
              type="number"
              value={setorForm.qtyReject}
              onChange={(v) => setSetorForm((f) => ({ ...f, qtyReject: v }))}
              placeholder="0 jika tidak ada reject"
            />
            {(Number(setorForm.qtySetor) || 0) + (Number(setorForm.qtyReject) || 0) < setorModal.qty && (Number(setorForm.qtySetor) > 0) && (
              <div className="rounded-xl px-3 py-2 text-xs font-bold" style={{ background: "#fef3c7", color: "#b45309" }}>
                ⚠️ Kurang {setorModal.qty - (Number(setorForm.qtySetor) || 0) - (Number(setorForm.qtyReject) || 0)} pcs dari qty awal
              </div>
            )}
            {Number(setorForm.qtySetor) > 0 && Number(setorModal.rate) > 0 && (
              <div className="rounded-xl px-3 py-2 text-sm font-bold" style={{ background: "#f3e8ff", color: "#7c3aed" }}>
                💰 Gaji: {money(Number(setorForm.qtySetor) * Number(setorModal.rate))}
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
            <Button onClick={simpanSetor} disabled={isSaving} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
              Simpan Setor
            </Button>
          </div>
        </Modal>
      )}

      {modal === "tarif" && (
        <Modal title="🏷️ Tambah Tarif Borongan" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <Select label="Jenis Produk" value={rateForm.productType} onChange={(v) => setRateForm((f) => ({ ...f, productType: v }))}>
              {PRODUCT_TYPES.map((p) => <option key={p}>{p}</option>)}
            </Select>
            <Select label="Proses" value={rateForm.process} onChange={(v) => setRateForm((f) => ({ ...f, process: v, model: v === "QC Packing" ? "" : f.model }))}>
              {ALL_PROCESSES.map((p) => <option key={p}>{p}</option>)}
            </Select>
            {rateForm.process !== "QC Packing" && (
              <Input label="Model" value={rateForm.model} onChange={(v) => setRateForm((f) => ({ ...f, model: v }))} placeholder="Contoh: Alya L" />
            )}
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
              label="Pilih Pesanan"
              value={kirimForm.pesananId}
              onChange={(v) => {
                const p = orders.find((o) => o.id === v);
                setKirimForm((f) => ({
                  ...f,
                  pesananId: v,
                  penerima: p?.customer || "",
                  items: p ? [{ nama: p.item || "", qtyPesan: Number(p.qty || 0), qtyKirim: 0 }] : [{ nama: "", qtyPesan: 0, qtyKirim: 0 }],
                }));
              }}
            >
              <option value="">-- Pilih Pesanan --</option>
              {orders.map((p) => <option key={p.id} value={p.id}>{p.customer} · {p.item} · {p.qty} pcs</option>)}
            </Select>
            <Input label="Tanggal Kirim" type="date" value={kirimForm.tanggalKirim} onChange={(v) => setKirimForm((f) => ({ ...f, tanggalKirim: v }))} />
            <Input label="Penerima" value={kirimForm.penerima} onChange={(v) => setKirimForm((f) => ({ ...f, penerima: v }))} />
            <Input label="Ekspedisi" value={kirimForm.ekspedisi} onChange={(v) => setKirimForm((f) => ({ ...f, ekspedisi: v }))} placeholder="JNE, J&T, Gojek" />
            {kirimForm.items.map((item, idx) => (
              <div key={idx} className="rounded-2xl p-3" style={{ background: "#fdf2f8" }}>
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
                      ? `Entry borongan ${confirmDelete.entry.employeeName} — ${confirmDelete.entry.model || confirmDelete.entry.process} · ${confirmDelete.entry.qty} pcs`
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
              <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>👤 {editEntryModal.employeeName}</div>
              <div className="text-xs mt-0.5" style={{ color: "#a855f7" }}>
                {editEntryModal.productType} · {editEntryModal.process}
                {editEntryModal.customer ? ` · ${editEntryModal.customer}` : ""}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>
                ⚠️ Nama pekerja & proses tidak bisa diubah di sini
              </div>
            </div>

            {/* Model — hanya untuk non-QC */}
            {editEntryModal.process !== "QC Packing" && (
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

            {editEntryModal.statusSetor === "sudah_setor" && (
              <div className="rounded-xl px-3 py-2 text-xs font-semibold" style={{ background: "#fef3c7", color: "#b45309" }}>
                ⚠️ Entry ini sudah disetor. Perubahan qty tidak otomatis mengubah data setor & payroll.
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
        const { nama, r, dari, sampai } = slipPreview;
        const fmt = (v) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(v || 0));
        return (
          <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.4)" }}>
            <div className="w-full max-h-[92vh] overflow-auto bg-white" style={{ borderRadius: "32px 32px 0 0", borderTop: "3px solid #a855f7" }}>
              {/* Header */}
              <div className="px-5 pt-5 pb-3" style={{ background: "linear-gradient(135deg,#a855f7,#ec4899)" }}>
                <div className="flex items-center justify-between mb-1">
                  <div className="text-white font-extrabold text-lg">🧾 Slip Pendapatan Borongan</div>
                  <button onClick={() => setSlipPreview(null)}
                    className="rounded-full px-4 py-1.5 text-sm font-bold"
                    style={{ background: "rgba(255,255,255,0.25)", color: "white" }}>
                    ✕ Tutup
                  </button>
                </div>
                <div className="text-white text-sm opacity-90">Gallery Kerudung</div>
              </div>

              <div className="p-5 space-y-4">
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

                {/* Tombol Share WA */}
                <button
                    onClick={() => {
                      const fmt2 = (v) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(v || 0));
                      const lines = [
                        "🧾 *Slip Pendapatan Borongan*",
                        "📍 Gallery Kerudung",
                        "━━━━━━━━━━━━━━━━━━",
                        `👤 *${nama}*`,
                        `📅 Periode: ${slipPreview.dari} s/d ${slipPreview.sampai}`,
                        "━━━━━━━━━━━━━━━━━━",
                        ...([...r.detail].sort((a,b)=>(a.tanggalSetor||a.tanggal||"").localeCompare(b.tanggalSetor||b.tanggal||"")).map((d,i)=>{
                          const tgl = d.tanggalSetor||d.tanggal||"-";
                          const model = d.model && d.model!=="-" ? ` · ${d.model}` : "";
                          const qty = d.sudahSetor ? d.qtySetor : d.qty;
                          const ket = d.sudahSetor ? fmt2(d.gaji) : "⏳ blm setor";
                          return `${i+1}. ${tgl} | ${d.process}${model} | ${qty} pcs | ${ket}`;
                        })),
                        "━━━━━━━━━━━━━━━━━━",
                        `📦 Diberikan: ${r.pcsAwal} pcs`,
                        `✅ Disetor: ${r.pcsSetor} pcs`,
                        r.pcsReject > 0 ? `❌ Reject: ${r.pcsReject} pcs` : null,
                        r.belumSetor > 0 ? `⏳ Blm setor: ${r.belumSetor} pcs` : null,
                        "━━━━━━━━━━━━━━━━━━",
                        `💰 *Total: ${fmt2(r.gaji)}*`,
                        "",
                        `_Dikirim via Gallery Kerudung · ${new Date().toLocaleDateString("id-ID")}_`
                      ].filter(Boolean).join("\n");
                      const waUrl = `https://wa.me/?text=${encodeURIComponent(lines)}`;
                      window.open(waUrl, "_blank");
                    }}
                    className="rounded-2xl py-3.5 font-bold text-white flex items-center justify-center gap-2 text-sm"
                    style={{ background: "linear-gradient(135deg,#25d366,#128c7e)" }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.116 1.523 5.847L.057 23.882l6.19-1.438A11.945 11.945 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.885 0-3.653-.51-5.173-1.4l-.371-.22-3.674.853.884-3.561-.242-.381A9.956 9.956 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
                    Share ke WA
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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