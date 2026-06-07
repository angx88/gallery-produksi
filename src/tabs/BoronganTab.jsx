import React from "react";
import { motion } from "framer-motion";

export default function BoronganTab(props) {
  const {
    tab,
    setTab,
    setModal,
    setSearch,

    filteredEntries,
    productionEntries,
    ordersForBoronganLink,
    orders,
    produksiByOrderId,
    shipmentByOrderId,

    boronganOnlyBelumSetor,
    setBoronganOnlyBelumSetor,
    boronganOnlyOverSetor,
    setBoronganOnlyOverSetor,

    getEntrySetorTotals,
    displayWorkerName,
    displayModelName,
    displayProductTypeName,
    normalizeWorkerNameKey,
    normalizeModelKey,
    normalizeProcessKey,
    normalizeProductTypeKey,
    sameProcess,
    fmtQty,
    formatNumber,
    money,
    todayStr,

    setSetorModal,
    setSetorForm,
    openEditEntry,
    requestDeleteEntry,

    Card,
    Button,
    Badge,
    Empty,
    UiButton,
  } = props;

  return (
    <>
      {tab === "borongan" && (
        <div className="space-y-3 p-4">
          <Button onClick={() => setModal("borongan")} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
             + Input Hasil Borongan
          </Button>
          {boronganOnlyBelumSetor && (
            <div className="rounded-2xl px-4 py-3 flex items-start gap-3" style={{ background: "#fefce8", border: "1.5px solid #fbbf24" }}>
              <span className="text-xl"></span>
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
              <span className="text-xl"></span>
              <div className="flex-1">
                <div className="text-sm font-black" style={{ color: "#be123c" }}>Hanya menampilkan yang setor melebihi diberi</div>
                <div className="text-xs mt-1" style={{ color: "#9f1239" }}>Data ini perlu dicek  total setor + reject melebihi qty yang diberikan.</div>
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
            <div className="text-xs font-bold" style={{ color: "#64748b" }}>Upah tersimpan untuk pengeluaran Gallery Kerudung</div>
          </div>
          {(boronganOnlyBelumSetor
            ? filteredEntries.filter((e) => getEntrySetorTotals(e).statusSetor !== "sudah_setor")
            : boronganOnlyOverSetor
              ? filteredEntries.filter((e) => {
                  const totals = getEntrySetorTotals(e);
                  return (Number(totals.qtySetor || 0) + Number(totals.qtyReject || 0)) > Number(e.qty || 0);
                })
              : filteredEntries
          ).map((e) => {
            const totals = getEntrySetorTotals(e);
            const sudahSetor = totals.statusSetor === "sudah_setor";
            const setorSebagian = totals.statusSetor === "setor_sebagian";
            const qtyReject = Number(totals.qtyReject || 0);
            const qtySetor = Number(totals.qtySetor || 0);
            const selisih = Number(totals.sisaSetor || 0);
            const statusSetorPanel = (sudahSetor || setorSebagian) ? (
              <div className="mt-3 rounded-2xl p-3 space-y-2" style={{ background: sudahSetor ? "#f0fdf4" : "#fff7ed", border: `1px solid ${sudahSetor ? "#bbf7d0" : "#fed7aa"}` }}>
                <div className="text-xs font-bold" style={{ color: sudahSetor ? "#16a34a" : "#b45309" }}>
                  {sudahSetor ? " Sudah Setor" : " Setor Sebagian"}  terakhir {totals.tanggalSetor || "-"}
                </div>
                <div className="flex flex-wrap gap-3 text-sm">
                  <span> Setor: <strong>{qtySetor} pcs</strong></span>
                  {qtyReject > 0 && <span> Reject: <strong style={{ color: "#ef4444" }}>{qtyReject} pcs</strong></span>}
                  {selisih > 0 && <span> Sisa: <strong style={{ color: "#f59e0b" }}>{selisih} pcs</strong></span>}
                </div>
                {totals.totalWageSetor > 0 && (
                  <div className="text-sm font-bold" style={{ color: "#a855f7" }}> Total gaji setor: {money(totals.totalWageSetor)}</div>
                )}
                {totals.history.length > 0 && (
                  <div className="space-y-1">
                    {totals.history.slice(-3).map((h, idx) => (
                      <div key={h.id || idx} className="rounded-xl px-3 py-2 text-xs" style={{ background: "rgba(255,255,255,.75)", color: "#64748b", border: "1px solid #f3e8ff" }}>
                         {h.tanggalSetor}  Setor {Number(h.qtySetor || 0)} pcs{Number(h.qtyReject || 0) > 0 ? `  Reject ${Number(h.qtyReject || 0)} pcs` : ""}  {money(h.totalWageSetor || 0)}
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
                <span className="text-xs font-bold" style={{ color: "#b45309" }}> Belum Setor</span>
                <button
                  onClick={() => { const t = getEntrySetorTotals(e); setSetorModal(e); setSetorForm({ qtySetor: String(t.sisaSetor || e.qty || ""), qtyReject: "", tanggalSetor: todayStr(), catatan: "" }); }}
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
                  <div className="font-bold" style={{ color: "#2d1b69" }}> {displayWorkerName(e.employeeName)}</div>
                  <div className="text-xs mt-1" style={{ color: "#a855f7" }}>{e.productType}  {e.process}{e.model ? `  ${e.model}` : ""}</div>
                  {e.invoice && <div className="text-xs font-bold" style={{ color: "#64748b" }}> {e.invoice}</div>}
                  {!e.orderId && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <span className="rounded-full px-2 py-0.5 text-[11px] font-black" style={{ background: "#fff7ed", color: "#c2410c", border: "1px solid #fed7aa" }}> Tanpa Pesanan</span>
                    </div>
                  )}
                  <div className="text-xs font-bold" style={{ color: "#64748b" }}> {e.tanggal}</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold" style={{ color: "#10b981" }}>{e.qty}</div>
                  <div className="text-xs font-bold" style={{ color: "#64748b" }}>pcs diberikan</div>
                </div>
              </div>
              {statusSetorPanel}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => openEditEntry(e)}
                  className="flex-1 rounded-2xl py-2 text-xs font-bold"
                  style={{ background: "#eff6ff", color: "#2563eb", border: "1px solid #bfdbfe" }}
                >
                   Edit
                </button>
                {!e.orderId && (
                  <button
                    onClick={() => openEditEntry(e)}
                    className="flex-1 rounded-2xl py-2 text-xs font-bold"
                    style={{ background: "#fff7ed", color: "#c2410c", border: "1px solid #fed7aa" }}
                  >
                     Kaitkan ke Pesanan
                  </button>
                )}
                <button
                  onClick={() => requestDeleteEntry(e)}
                  className="flex-1 rounded-2xl py-2 text-xs font-bold"
                  style={{ background: "#fff1f2", color: "#e11d48", border: "1px solid #fecaca" }}
                >
                   Hapus
                </button>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </>
  );
}
