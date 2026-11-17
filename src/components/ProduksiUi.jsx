import React from "react";
import { motion } from "framer-motion";
import {
  PROD_STATUS, PROD_COLORS, nonNegativeMoney,
} from "../lib/produksiHelpers";

export function Button({ children, onClick, className = "", style = {}, disabled }) {
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

export function Input({ label, value, onChange, placeholder, type = "text", readOnly = false, disabled = false }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-bold" style={{ color: "#9333ea" }}>{label}</label>
      <input
        value={value}
        type={type}
        readOnly={readOnly}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-full px-4 py-3 outline-none text-base"
        style={{
          borderRadius: 14,
          border: "1.5px solid #f9a8d4",
          background: readOnly || disabled ? "#f1f5f9" : "#fdf2f8",
          color: readOnly || disabled ? "#64748b" : "#2d1b69",
          opacity: disabled ? 0.6 : 1,
        }}
      />
    </div>
  );
}

export function Select({ label, value, onChange, children }) {
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

export function Modal({ title, children, onClose }) {
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


export function Card({ children, className = "", style = {}, onClick }) {
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

export function GlobalReadableStyle() {
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

export function StatusBadge({ status }) {
  const s = PROD_COLORS[status] || { bg: "#f1f5f9", text: "#64748b", icon: "❓" };
  return (
    <span className="rounded-full px-3 py-1 text-xs font-bold inline-flex items-center gap-1" style={{ background: s.bg, color: s.text }}>
      {s.icon} {status || "Antri"}
    </span>
  );
}

export function ProgressBar({ status }) {
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


export function isOfficialGajiPayroll(row) {
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

export function officialGajiPayrollTotal(rows = []) {
  return (rows || [])
    .filter(isOfficialGajiPayroll)
    .reduce((sum, row) => sum + nonNegativeMoney(row.totalAmount || 0), 0);
}


export function InfoBox({ title, subtitle, icon }) {
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

export function Empty({ text }) {
  return <div className="text-center py-10" style={{ color: "#c084fc" }}>{text}</div>;
}

export function MiniStat({ label, value, bg, color }) {
  return (
    <div className="rounded-xl p-2" style={{ background: bg }}>
      <div className="text-xs" style={{ color }}>{label}</div>
      <div className="font-bold text-sm" style={{ color }}>{value}</div>
    </div>
  );
}
