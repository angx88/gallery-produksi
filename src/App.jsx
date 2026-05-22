import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { db, auth } from "./firebase";
import {
  collection,
  addDoc,
  onSnapshot,
  updateDoc,
  deleteDoc,
  doc,
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
  return {
    id: d.id,
    customer: d.customer || d.customerName || d.nama || d.name || "-",
    item: d.item || d.productName || d.produk || d.product || "-",
    qty: Number(d.qty || d.quantity || d.jumlah || d.totalQty || 0),
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
  const [toast, setToast] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [setorModal, setSetorModal] = useState(null); // entry object yang akan disetor
  const [setorForm, setSetorForm] = useState({ qtySetor: "", qtyReject: "", tanggalSetor: todayStr(), catatan: "" });

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
    const needsMigration = produksi.filter((p) => !Array.isArray(p.items) || p.items.length === 0);
    if (needsMigration.length === 0) return;

    needsMigration.forEach(async (p) => {
      const order = orders.find((o) => o.id === p.orderId);
      if (!order) return;
      const orderItems = Array.isArray(order.items) && order.items.length > 0
        ? order.items.map((it) => ({ name: it.name || "", qty: Number(it.qty || 0) }))
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

    // Ambil items per model dari pesanan (bukan total)
    const orderItems = Array.isArray(order.items) && order.items.length > 0
      ? order.items.map((it) => ({ name: it.name || "", qty: Number(it.qty || 0), price: it.price || 0 }))
      : [{ name: order.item || "Pesanan", qty: Number(order.qty || 0), price: order.hargaPcs || 0 }];

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

  async function deleteRate(id) {
    setConfirmDelete({ type: "rate", id });
  }

  async function confirmDeleteAction() {
    if (!confirmDelete) return;
    const { type, id } = confirmDelete;
    setConfirmDelete(null);
    try {
      if (type === "rate") await deleteDoc(doc(db, C.WORK_RATES, id));
    } catch (e) {
      alert("Gagal hapus: " + e.message);
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
                    <div className="text-xs" style={{ color: "#94a3b8" }}>pcs</div>
                  </div>
                </div>
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
          {filteredProduksi.map((p) => (
            <div key={p.id} className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: "1px solid #fce7f3" }}>
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <div className="font-bold" style={{ color: "#2d1b69" }}>{p.customer}</div>
                  <div className="text-xs" style={{ color: "#94a3b8" }}>{p.invoice} · {p.qty} pcs total</div>
                  {/* Breakdown per model */}
                  {Array.isArray(p.items) && p.items.length > 1 ? (
                    <div className="mt-1 space-y-0.5">
                      {p.items.map((it, i) => (
                        <div key={i} className="text-xs" style={{ color: "#7c3aed" }}>• {it.name}: <strong>{it.qty} pcs</strong></div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs" style={{ color: "#94a3b8" }}>{p.item}</div>
                  )}
                  {p.tanggalMulai && <div className="text-xs" style={{ color: "#94a3b8" }}>📅 Mulai: {p.tanggalMulai}</div>}

                  {/* Rekap proses: Potong, Jahit, QC Packing vs qty pesanan */}
                  {(() => {
                    const qtyPesanan = Number(p.qty || 0);
                    const rekap = [
                      { label: "✂️ Potong", qty: processQtyForOrder(p.orderId, "Potong") },
                      { label: "🧵 Jahit", qty: processQtyForOrder(p.orderId, "Jahit") },
                      { label: "📦 QC Packing", qty: processQtyForOrder(p.orderId, "QC Packing") },
                    ].filter((r) => r.qty > 0);
                    if (rekap.length === 0) return null;
                    return (
                      <div className="mt-2 rounded-xl p-2 space-y-1" style={{ background: "#fdf4ff", border: "1px solid #e9d5ff" }}>
                        <div className="text-xs font-bold mb-1" style={{ color: "#7c3aed" }}>Rekap Proses</div>
                        {rekap.map((r) => {
                          const sesuai = r.qty >= qtyPesanan;
                          const pct = Math.min(Math.round((r.qty / qtyPesanan) * 100), 100);
                          return (
                            <div key={r.label}>
                              <div className="flex justify-between text-xs">
                                <span style={{ color: "#64748b" }}>{r.label}</span>
                                <span style={{ color: sesuai ? "#16a34a" : "#f59e0b", fontWeight: "bold" }}>
                                  {r.qty}/{qtyPesanan} pcs {sesuai ? "✅" : `(${pct}%)`}
                                </span>
                              </div>
                              <div className="mt-0.5 h-1.5 rounded-full w-full" style={{ background: "#e9d5ff" }}>
                                <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: sesuai ? "#16a34a" : "#a855f7" }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
                <StatusBadge status={p.status} />
              </div>
              <ProgressBar status={p.status} />
              {(p.workers || []).length > 0 && (
                <div className="mt-3 rounded-2xl p-3" style={{ background: "#fdf2f8" }}>
                  <div className="text-xs font-bold mb-2" style={{ color: "#a855f7" }}>👥 Pembagian pekerja</div>
                  {(p.workers || []).map((w, idx) => (
                    <div key={idx} className="flex justify-between text-xs py-1" style={{ borderTop: idx > 0 ? "1px solid #fce7f3" : "none" }}>
                      <span style={{ color: "#2d1b69" }}>{w.employeeName}</span>
                      <span style={{ color: "#7c3aed", fontWeight: 700 }}>
                        {w.process}{w.model ? ` · ${w.model}` : ""} · {w.qty} pcs
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3">
                <div className="text-xs font-bold mb-2" style={{ color: "#a855f7" }}>Ubah status:</div>
                <div className="flex flex-wrap gap-1">
                  {PROD_STATUS.map((s) => (
                    <button
                      key={s}
                      onClick={() => updateProduksiStatus(p.id, s)}
                      className="rounded-full px-2 py-1 text-xs font-semibold"
                      style={{
                        background: p.status === s ? "linear-gradient(135deg,#ec4899,#a855f7)" : "white",
                        color: p.status === s ? "white" : "#a855f7",
                        border: "1px solid #f9a8d4",
                      }}
                    >
                      {PROD_COLORS[s]?.icon} {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
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

          {/* Rekap per nama pekerja */}
          {(() => {
            const rekapMap = {};
            filteredEntries.forEach((e) => {
              const nama = e.employeeName || "Tidak diketahui";
              if (!rekapMap[nama]) rekapMap[nama] = { pcsAwal: 0, pcsSetor: 0, pcsReject: 0, gaji: 0, belumSetor: 0 };
              rekapMap[nama].pcsAwal += Number(e.qty || 0);
              if (e.statusSetor === "sudah_setor") {
                rekapMap[nama].pcsSetor += Number(e.qtySetor || 0);
                rekapMap[nama].pcsReject += Number(e.qtyReject || 0);
                rekapMap[nama].gaji += Number(e.totalWageSetor || 0);
              } else {
                rekapMap[nama].belumSetor += Number(e.qty || 0);
              }
            });
            const rekap = Object.entries(rekapMap).sort((a, b) => b[1].gaji - a[1].gaji);
            if (rekap.length === 0) return null;
            return (
              <div className="rounded-2xl bg-white p-4 space-y-2" style={{ border: "1px solid #e9d5ff" }}>
                <div className="text-xs font-bold mb-2" style={{ color: "#7c3aed" }}>📊 Rekap Gaji per Pekerja</div>
                {rekap.map(([nama, r]) => (
                  <div key={nama} className="rounded-xl p-3" style={{ background: "#fdf4ff", border: "1px solid #f3e8ff" }}>
                    <div className="flex justify-between items-start">
                      <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>👤 {nama}</div>
                      <div className="text-sm font-bold" style={{ color: "#16a34a" }}>{money(r.gaji)}</div>
                    </div>
                    <div className="flex gap-3 mt-1 text-xs" style={{ color: "#64748b" }}>
                      <span>Diberikan: <strong>{r.pcsAwal}</strong></span>
                      <span>Setor: <strong style={{ color: "#16a34a" }}>{r.pcsSetor}</strong></span>
                      {r.pcsReject > 0 && <span>Reject: <strong style={{ color: "#ef4444" }}>{r.pcsReject}</strong></span>}
                      {r.belumSetor > 0 && <span style={{ color: "#b45309" }}>⏳ Belum setor: <strong>{r.belumSetor}</strong></span>}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
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
            </div>
            );
          })}
        </div>
      )}

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
                setEntryForm((f) => ({ ...f, orderId: v, model: f.process === "QC Packing" ? "" : (o?.item || f.model) }));
              }}
            >
              <option value="">Tidak dikaitkan ke pesanan</option>
              {orders.map((o) => <option key={o.id} value={o.id}>{o.customer} · {o.item} · {o.qty} pcs</option>)}
            </Select>
            <Select label="Jenis Produk" value={entryForm.productType} onChange={(v) => setEntryForm((f) => ({ ...f, productType: v }))}>
              {PRODUCT_TYPES.map((p) => <option key={p}>{p}</option>)}
            </Select>
            <Select label="Proses" value={entryForm.process} onChange={(v) => setEntryForm((f) => ({ ...f, process: v, model: v === "QC Packing" ? "" : f.model }))}>
              {ALL_PROCESSES.map((p) => <option key={p}>{p}</option>)}
            </Select>
            {entryForm.process !== "QC Packing" && (
              <Input label="Model" value={entryForm.model} onChange={(v) => setEntryForm((f) => ({ ...f, model: v }))} placeholder="Harus sama dengan tarif" />
            )}
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

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6">
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl">
            <div className="text-xl font-bold mb-2" style={{ color: "#1e293b" }}>Hapus Data?</div>
            <div className="text-sm mb-6" style={{ color: "#64748b" }}>Data yang dihapus tidak bisa dikembalikan.</div>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 rounded-2xl border py-3 font-semibold"
                style={{ borderColor: "#e2e8f0", color: "#64748b" }}
              >
                Batal
              </button>
              <button
                onClick={confirmDeleteAction}
                className="flex-1 rounded-2xl py-3 font-semibold text-white"
                style={{ background: "#e11d48" }}
              >
                Hapus
              </button>
            </div>
          </div>
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