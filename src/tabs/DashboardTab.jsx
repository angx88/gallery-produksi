import React from "react";

export default function DashboardTab({
  tab,
  setTab,
  dashboardSummary,
  stats,
  dashboardInsights,
  setBoronganOnlyBelumSetor,
  setProduksiOnlyBelumSelesai,
  setKirimOnlyBelumLengkap,
  setTugasDetailModal,
  productionEntries,
  setorHistoryInRange,
  setorTotalsFromHistory,
  displayWorkerName,
  displayModelName,
  fmtQty,
  money,
}) {
  return (
    <>
      {tab === "dashboard" && (
        <div className="space-y-4 p-4">
          <div className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: "1px solid #fce7f3" }}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-lg font-black" style={{ color: "#ec4899" }}> Dashboard Produksi</div>
                <div className="text-xs font-bold" style={{ color: "#64748b" }}>Ringkasan total keseluruhan dan periode berjalan</div>
              </div>
              <button onClick={() => setTab("rekap")} className="rounded-full px-3 py-1.5 text-xs font-bold" style={{ background: "#fdf2f8", color: "#ec4899" }}>Rekap </button>
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
              { label: "Total gaji", value: money(dashboardSummary.gajiKeseluruhan), color: "#7c3aed", icon: "", detail: "allTime" },
              { label: "Produksi aktif", value: dashboardSummary.produksiAktif.toLocaleString(), color: "#a855f7", icon: "", tab: "produksi" },
              { label: "Borongan aktif", value: dashboardSummary.boronganAktif.toLocaleString(), color: "#f59e0b", icon: "", tab: "borongan" },
              { label: "Pesanan belum produksi", value: stats.belum.toLocaleString(), color: "#ef4444", icon: "", tab: "produksi" },
              { label: "Pcs pesanan", value: dashboardSummary.pesananPcs.toLocaleString(), color: "#6366f1", icon: "", tab: "pesanan" },
              { label: "Pcs terkirim", value: dashboardSummary.terkirimPcs.toLocaleString(), color: "#0ea5e9", icon: "", tab: "kirim" },
              { label: "Pcs belum produksi", value: dashboardSummary.pcsBelumProduksi.toLocaleString(), color: dashboardSummary.pcsBelumProduksi > 0 ? "#d97706" : "#94a3b8", icon: "", tab: "pesanan" },
              { label: "Sisa kirim siap", value: dashboardSummary.sisaKirim.toLocaleString(), color: dashboardSummary.sisaKirim > 0 ? "#b45309" : "#94a3b8", icon: "", tab: "kirim" },
              { label: "Kelebihan kirim", value: dashboardSummary.kelebihanKirim.toLocaleString(), color: dashboardSummary.kelebihanKirim > 0 ? "#e11d48" : "#94a3b8", icon: "", tab: "kirim" },
              { label: "Kurang kirim final", value: dashboardSummary.kurangKirimFinal.toLocaleString(), color: dashboardSummary.kurangKirimFinal > 0 ? "#b45309" : "#94a3b8", icon: "", tab: "kirim" },
              { label: "Master data", value: dashboardSummary.bahanTotal.toLocaleString(), color: "#10b981", icon: "", tab: "kain" },
            ].map((card) => (
              <button key={card.label} onClick={() => card.detail ? setRekapDetailModal(card.detail) : setTab(card.tab)} className="rounded-3xl bg-white p-4 text-left shadow-sm active:scale-[0.99] transition-transform" style={{ border: "1px solid #fce7f3" }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xl">{card.icon}</span>
                  <span className="text-[10px] font-bold" style={{ color: "#94a3b8" }}>Rincian </span>
                </div>
                <div className="mt-2 text-xl font-black break-words" style={{ color: card.color }}>{card.value}</div>
                <div className="text-xs font-semibold" style={{ color: "#64748b" }}>{card.label}</div>
              </button>
            ))}
          </div>
          <div className="rounded-3xl bg-white p-4 space-y-3 shadow-sm" style={{ border: "1px solid #fed7aa", background: "linear-gradient(135deg,#fff7ed,#ffffff)" }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-black" style={{ color: "#c2410c" }}> Tugas Hari Ini</div>
                <div className="text-[11px]" style={{ color: "#9a3412" }}>Ringkasan yang perlu dicek admin.</div>
              </div>
              <button onClick={() => setTugasDetailModal(true)} className="rounded-full px-3 py-1 text-[11px] font-bold" style={{ background: "#ffedd5", color: "#c2410c" }}>Lihat kerjaan </button>
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
                     {displayWorkerName(entry.employeeName)} belum setor {fmtQty(totals.sisaSetor)} pcs ({entry.process || "-"} {displayModelName(entry.model || "-")})
                  </button>
                ))}
                {dashboardInsights.tugas.activeProduksi.slice(0, 1).map((item) => (
                  <button
                    key={`prod-${item.id}`}
                    onClick={() => { setProduksiOnlyBelumSelesai(true); setTab("produksi"); }}
                    className="w-full text-left rounded-xl px-2 py-1 active:bg-orange-100 transition-colors"
                  >
                     Produksi {item.customer || item.orderCustomer || item.orderId || "pesanan"} masih {item.status || "proses"}
                  </button>
                ))}
                {dashboardInsights.tugas.kirimBelumLengkap.slice(0, 1).map(({ order, sisa }) => (
                  <button
                    key={`ship-${order.id}`}
                    onClick={() => { setKirimOnlyBelumLengkap(true); setTab("kirim"); }}
                    className="w-full text-left rounded-xl px-2 py-1 active:bg-orange-100 transition-colors"
                  >
                     {order.customer || "Customer"} sisa kirim {fmtQty(sisa)} pcs
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-3xl bg-white p-4 space-y-3 shadow-sm" style={{ border: "1px solid #bbf7d0", background: "linear-gradient(135deg,#f0fdf4,#ffffff)" }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-black" style={{ color: "#15803d" }}> Top Pekerja Bulan Ini</div>
                <div className="text-[11px]" style={{ color: "#64748b" }}>{dashboardInsights.monthLabel}  berdasarkan pcs setor</div>
              </div>
              <button onClick={() => setTab("rekap")} className="rounded-full px-3 py-1 text-[11px] font-bold" style={{ background: "#dcfce7", color: "#15803d" }}>Rekap </button>
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
          <div className="rounded-3xl bg-white p-4 space-y-3 shadow-sm" style={{ border: "1px solid #ddd6fe", background: "linear-gradient(135deg,#faf5ff,#ffffff)" }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-black" style={{ color: "#7c3aed" }}> Grafik Mingguan</div>
                <div className="text-[11px]" style={{ color: "#64748b" }}>Pcs setor, reject, dan gaji per minggu.</div>
              </div>
              <button onClick={() => setTab("rekap")} className="rounded-full px-3 py-1 text-[11px] font-bold" style={{ background: "#f3e8ff", color: "#7c3aed" }}>Detail </button>
            </div>
            <div className="space-y-2">
              {dashboardInsights.weeklyRows.map((row) => {
                const totalPcs = Number(row.pcsSetor || 0) + Number(row.pcsReject || 0);
                const width = Math.max(2, Math.round((totalPcs / dashboardInsights.maxWeeklyPcs) * 100));
                return (
                  <div key={row.key} className="space-y-1">
                    <div className="flex justify-between text-[10px]" style={{ color: "#64748b" }}>
                      <span>{row.dari.slice(5)} s/d {row.sampai.slice(5)}</span>
                      <span>{fmtQty(row.pcsSetor)} setor  {fmtQty(row.pcsReject)} reject  {money(row.gaji)}</span>
                    </div>
                    <div className="h-3 rounded-full overflow-hidden" style={{ background: "#f3e8ff" }}>
                      <div className="h-full rounded-full" style={{ width: `${width}%`, background: "linear-gradient(90deg,#a855f7,#ec4899)" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="rounded-3xl bg-white p-4 space-y-3 shadow-sm" style={{ border: "1px solid #a7f3d0", background: "linear-gradient(135deg,#f0fdf4,#ffffff)" }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-black" style={{ color: "#065f46" }}> Riwayat Gajian</div>
                <div className="text-[11px]" style={{ color: "#64748b" }}>{gajianHistory.length} catatan gajian tersimpan</div>
              </div>
              <button onClick={() => setTab("rekap")} className="rounded-full px-3 py-1 text-[11px] font-bold" style={{ background: "#d1fae5", color: "#065f46" }}>Input </button>
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
                          {g.tanggalGaji}  Periode {g.periodeGajiDari} s/d {g.periodeGajiSampai}
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
          <div className="rounded-3xl bg-white p-4 space-y-3 shadow-sm" style={{ border: "1px solid #bfdbfe", background: "linear-gradient(135deg,#eff6ff,#ffffff)" }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-black" style={{ color: "#1e40af" }}> Riwayat Setor Terbaru</div>
                <div className="text-[11px]" style={{ color: "#64748b" }}>10 transaksi setor terakhir</div>
              </div>
              <button onClick={() => setTab("borongan")} className="rounded-full px-3 py-1 text-[11px] font-bold" style={{ background: "#dbeafe", color: "#1e40af" }}>Borongan </button>
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
                        <div className="text-[10px]" style={{ color: "#64748b" }}>{s.tanggalSetor}  {s.process} {s.model !== "-" ? ` ${s.model}` : ""}</div>
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
    </>
  );
}
