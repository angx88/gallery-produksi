import React from "react";

export default function RekapTab(props) {
  const {
    tab,
    setTab,

    rekapDari,
    rekapSampai,
    handleRekapDariChange,
    handleRekapSampaiChange,
    resetRekapToCurrentWeek,

    productionEntries,
    payrollExpenses,
    gajianHistory,
    kasbonPegawai,
    orders,
    materials,

    setorHistoryInRange,
    setorTotalsFromHistory,
    getEntrySetorTotals,
    setorTotals,
    dateBefore,
    dateKey,
    localDateStr,
    currentSundayToSaturdayPeriod,

    workerNameOptions,
    modelNameOptions,
    canonicalByExisting,
    normalizeWorkerNameKey,
    displayWorkerName,
    displayModelName,
    displayProductTypeName,
    displayProcessName,

    fmtQty,
    formatNumber,
    money,

    showFormGajianLama,
    setShowFormGajianLama,
    formGajianLama,
    setFormGajianLama,
    saveGajianLama,
    deleteGajianHistory,

    setRekapDetailModal,
    setSlipPreview,
    slipRef,

    Card,
    Button,
    Badge,
    Empty,
    Input,
    Select,
    UiInput,
    UiSelect,
    UiButton,
  } = props;

  return (
    <>
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
          const allTotals = getEntrySetorTotals(e);
          const rangeTotals = setorTotalsFromHistory(setorHistoryInRange(e, rekapDari, rekapSampai));
          const inputInRange = inRange(e.tanggal);
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
        Object.keys(byProses).forEach((p) => {
          const aktivitasSetorPeriode = Number(byProses[p].qtySetor || 0) + Number(byProses[p].qtyReject || 0);
          byProses[p].qtyDiberikan = Math.max(Number(byProses[p].qty || 0), aktivitasSetorPeriode);
        });
        const rekapMap = {};
        filtered.forEach((e) => {
          const namaKey = normalizeWorkerNameKey(e.employeeName);
          const nama = canonicalByExisting(e.employeeName, workerNameOptions, "worker");
          const inputInRange = inRange(e.tanggal);
          const rangeHistory = setorHistoryInRange(e, rekapDari, rekapSampai);
          const rangeTotals = setorTotalsFromHistory(rangeHistory);
          const allTotals = getEntrySetorTotals(e);
          if (!rekapMap[nama]) rekapMap[nama] = { pcsAwal: 0, pcsSetor: 0, pcsReject: 0, gaji: 0, belumSetor: 0, detail: [] };
          const aktivitasSetorPeriode = Number(rangeTotals.qtySetor || 0) + Number(rangeTotals.qtyReject || 0);
          const qtyBasisPeriode = inputInRange
            ? Math.max(Number(e.qty || 0), aktivitasSetorPeriode)
            : aktivitasSetorPeriode;
          rekapMap[nama].pcsAwal += Math.max(0, qtyBasisPeriode);
          rekapMap[nama].pcsSetor += Number(rangeTotals.qtySetor || 0);
          rekapMap[nama].pcsReject += Number(rangeTotals.qtyReject || 0);
          rekapMap[nama].gaji += Number(rangeTotals.totalWageSetor || 0);
          if (inputInRange) rekapMap[nama].belumSetor += Number(allTotals.sisaSetor || 0);
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
            const totals = getEntrySetorTotals(e);
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
            <div className="rounded-2xl bg-white p-4" style={{ border: "1px solid #e9d5ff" }}>
              <div className="text-xs font-bold mb-3" style={{ color: "#7c3aed" }}> Filter Periode</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs mb-1" style={{ color: "#94a3b8" }}>Dari</div>
                  <UiInput type="date" value={rekapDari} onChange={(e) => handleRekapDariChange(e.target.value)}
                    className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#e9d5ff" }} />
                </div>
                <div>
                  <div className="text-xs mb-1" style={{ color: "#94a3b8" }}>Sampai</div>
                  <UiInput type="date" value={rekapSampai} onChange={(e) => handleRekapSampaiChange(e.target.value)}
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
                 Pilih tanggal <strong>Dari</strong> dan <strong>Sampai</strong> dulu untuk menampilkan rekap gaji.
              </div>
            )}
            <div className="rounded-2xl bg-white p-4 space-y-3" style={{ border: "1px solid #a7f3d0" }}>
              <button
                type="button"
                onClick={() => setShowFormGajianLama((v) => !v)}
                className="w-full flex items-center justify-between"
              >
                <div className="text-xs font-bold" style={{ color: "#065f46" }}> Input Riwayat Gajian Lama</div>
                <span className="text-xs font-bold" style={{ color: "#64748b" }}>{showFormGajianLama ? " Tutup" : " Buka"}</span>
              </button>
              {showFormGajianLama && (
                <div className="space-y-2 pt-1">
                  <div>
                    <div className="text-[11px] mb-1" style={{ color: "#64748b" }}>Nama Pekerja</div>
                    <UiSelect
                      value={formGajianLama.employeeName}
                      onChange={(e) => setFormGajianLama((f) => ({ ...f, employeeName: e.target.value }))}
                      className="w-full rounded-xl border px-3 py-2 text-sm"
                      style={{ borderColor: "#a7f3d0" }}
                    >
                      <option value="">-- Pilih Pekerja --</option>
                      {workerNameOptions.map((w) => (
                        <option key={w} value={w}>{displayWorkerName(w)}</option>
                      ))}
                    </UiSelect>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: "#64748b" }}>Tanggal Digaji</div>
                      <UiInput type="date" value={formGajianLama.tanggalGaji}
                        onChange={(e) => setFormGajianLama((f) => ({ ...f, tanggalGaji: e.target.value }))}
                        className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#a7f3d0" }} />
                    </div>
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: "#64748b" }}>Jumlah Dibayar</div>
                      <UiInput type="number" placeholder="0" value={formGajianLama.jumlah}
                        onChange={(e) => setFormGajianLama((f) => ({ ...f, jumlah: e.target.value }))}
                        className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#a7f3d0" }} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: "#64748b" }}>Periode Dari</div>
                      <UiInput type="date" value={formGajianLama.periodeGajiDari}
                        onChange={(e) => setFormGajianLama((f) => ({ ...f, periodeGajiDari: e.target.value }))}
                        className="w-full rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "#a7f3d0" }} />
                    </div>
                    <div>
                      <div className="text-[11px] mb-1" style={{ color: "#64748b" }}>Periode Sampai</div>
                      <UiInput type="date" value={formGajianLama.periodeGajiSampai}
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
                    {isSaving ? "Menyimpan..." : " Simpan Riwayat Gajian"}
                  </button>
                </div>
              )}
            </div>
            {gajianHistory.length > 0 && (
              <div className="rounded-2xl bg-white p-4" style={{ border: "1px solid #a7f3d0" }}>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-black" style={{ color: "#065f46" }}> Semua Riwayat Gajian ({gajianHistory.length})</div>
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
                            Digaji: {g.tanggalGaji}  Periode: {g.periodeGajiDari} s/d {g.periodeGajiSampai}
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
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-2xl bg-white p-3 text-center" style={{ border: "1px solid #fce7f3" }}>
                <div className="text-xl font-bold" style={{ color: "#ec4899" }}>{totalQty.toLocaleString()}</div>
                <div className="text-xs font-bold" style={{ color: "#64748b" }}>pcs diberikan</div>
              </div>
              <div className="rounded-2xl bg-white p-3 text-center" style={{ border: "1px solid #bbf7d0" }}>
                <div className="text-xl font-bold" style={{ color: "#16a34a" }}>{totalSetor.toLocaleString()}</div>
                <div className="text-xs font-bold" style={{ color: "#64748b" }}>pcs disetor</div>
              </div>
              <div className="rounded-2xl bg-white p-3 text-center" style={{ border: "1px solid #fde68a" }}>
                <div className="text-xl font-bold" style={{ color: "#d97706" }}>{totalReject.toLocaleString()}</div>
                <div className="text-xs font-bold" style={{ color: "#64748b" }}>pcs reject</div>
              </div>
              <div className="rounded-2xl bg-white p-3 text-center" style={{ border: "1px solid #e9d5ff" }}>
                <div className="text-base font-bold" style={{ color: "#7c3aed" }}>{money(totalGaji)}</div>
                <div className="text-xs font-bold" style={{ color: "#64748b" }}>total gaji</div>
              </div>
            </div>
            {rekapPerkerja.length > 0 && (
              <div className="rounded-2xl bg-white p-4 space-y-3" style={{ border: "1px solid #e9d5ff" }}>
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold" style={{ color: "#7c3aed" }}> Rekap Gajian Keseluruhan</div>
                  <div className="text-xs font-bold" style={{ color: "#64748b" }}>{rekapPeriodReady ? `${rekapDari} s/d ${rekapSampai}` : "Periode belum dipilih"}</div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setRekapDetailModal("sudah")} className="rounded-xl p-3 text-left active:scale-[0.99] transition-transform" style={{ background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
                    <div className="text-xs font-bold" style={{ color: "#16a34a" }}>Sudah Gajian</div>
                    <div className="text-lg font-black" style={{ color: "#16a34a" }}>{money(rekapGajianKeseluruhan.totalSudahDibayar)}</div>
                    <div className="text-xs flex items-center justify-between" style={{ color: "#64748b" }}><span>{rekapGajianKeseluruhan.sudahGajian} pekerja</span><span>Rincian </span></div>
                  </button>
                  <button type="button" onClick={() => setRekapDetailModal("belum")} className="rounded-xl p-3 text-left active:scale-[0.99] transition-transform" style={{ background: "#fef3c7", border: "1px solid #fde68a" }}>
                    <div className="text-xs font-bold" style={{ color: "#b45309" }}>Belum Gajian</div>
                    <div className="text-lg font-black" style={{ color: "#b45309" }}>{money(rekapGajianKeseluruhan.totalBelumDibayar)}</div>
                    <div className="text-xs flex items-center justify-between" style={{ color: "#64748b" }}><span>{rekapGajianKeseluruhan.belumGajian} pekerja</span><span>Rincian </span></div>
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
                getEntrySetorTotals(e).sisaSetor > 0 &&
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
                          <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>{isAllTimeDetail ? "Semua waktu" : (rekapPeriodReady ? `${rekapDari} s/d ${rekapSampai}` : "Periode belum dipilih")}  {filteredRows.length} pekerja</div>
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
                              <div className="font-bold text-sm" style={{ color: "#2d1b69" }}> {nama}</div>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {isAllTimeDetail ? (
                                  <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: "#ecfdf5", color: "#047857" }}>
                                     Semua waktu  {Number(r.transaksi || 0).toLocaleString()} transaksi
                                  </span>
                                ) : (
                                  <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: sudah ? "#dcfce7" : "#fef3c7", color: sudah ? "#16a34a" : "#b45309" }}>
                                    {sudah ? " Sudah gajian" : " Belum gajian"}
                                  </span>
                                )}
                                {Number(r.belumSetor || 0) > 0 && <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: "#fffbeb", color: "#b45309" }}> {r.belumSetor} blm setor</span>}
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
                               Lihat Slip
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
                    <div className="text-xs font-bold" style={{ color: "#c2410c" }}> Borongan Belum Masuk Rekap Gaji</div>
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
                          <div className="font-bold text-sm" style={{ color: "#2d1b69" }}> {e.employeeName || "Tidak diketahui"}</div>
                          <div className="text-xs mt-0.5" style={{ color: "#64748b" }}>
                            {e.process || "-"}  {e.model || "-"}  {e.customer || "-"}{e.invoice ? `  ${e.invoice}` : ""}
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
                        <span> Diberikan: {e.tanggal || "-"}</span>
                        <span>{e.tanggalSetorTerakhir ? `Setor terakhir: ${e.tanggalSetorTerakhir}` : "Belum ada setor"}</span>
                      </div>
                      {Number(e.sisaSetor || 0) > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            const rawEntry = productionEntries.find((pe) => pe.id === e.id) || e;
                            const t = setorTotals(rawEntry);
                            setSetorModal(rawEntry);
                            setSetorForm({ qtySetor: String(t.sisaSetor || ""), qtyReject: "", tanggalSetor: todayStr(), catatan: "" });
                          }}
                          className="mt-3 w-full rounded-xl py-2 text-xs font-bold text-white"
                          style={{ background: "linear-gradient(135deg,#f97316,#ec4899)" }}
                        >
                           Setor Hasil / Masukkan ke Rekap
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {prosesKeys.length > 0 ? (
              <div className="rounded-2xl bg-white p-4 space-y-3" style={{ border: "1px solid #e9d5ff" }}>
                <div className="text-xs font-bold" style={{ color: "#7c3aed" }}> Per Proses</div>
                {prosesKeys.map((p) => {
                  const r = byProses[p];
                  const icon = p === "Potong" ? "" : p === "Jahit" ? "" : sameProcess(p, "Pengemasan QC") ? "" : "";
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
            {rekapPerkerja.length > 0 && (
              <div className="rounded-2xl bg-white p-4 space-y-3" style={{ border: "1px solid #e9d5ff" }}>
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold" style={{ color: "#7c3aed" }}> Rekap Gaji per Pekerja</div>
                  <div className="text-xs font-bold" style={{ color: "#64748b" }}>{rekapPerkerja.length} pekerja</div>
                </div>
                {rekapPerkerja.map(([nama, r]) => {
                  const sudahGajianPerkerja = sudahGajian(nama, rekapDari, rekapSampai);
                  const carryOver = productionEntries.filter((e) =>
                    normalizeWorkerNameKey(e.employeeName) === normalizeWorkerNameKey(nama) &&
                    Number(getEntrySetorTotals(e).sisaSetor || 0) > 0 &&
                    dateBefore(e.tanggal, rekapDari)
                  );
                  const totalCarryOverPcs = carryOver.reduce((s, e) => s + Number(getEntrySetorTotals(e).sisaSetor || 0), 0);
                  return (
                  <div key={nama} className="rounded-xl overflow-hidden" style={{ border: "1px solid #e9d5ff" }}>
                    <div className="px-3 py-2" style={{ background: "linear-gradient(135deg,#ede9fe,#fce7f3)" }}>
                      <div className="flex justify-between items-start">
                        <div className="font-bold text-sm" style={{ color: "#2d1b69" }}> {nama}</div>
                        <div className="text-sm font-bold" style={{ color: "#16a34a" }}>{money(r.gaji)}</div>
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {sudahGajianPerkerja
                          ? <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "#dcfce7", color: "#16a34a" }}> Sudah gajian</span>
                          : <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "#fef3c7", color: "#b45309" }}> Belum gajian</span>}
                        {totalCarryOverPcs > 0 && (
                          <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "#fff1f2", color: "#e11d48" }}>
                             {totalCarryOverPcs} pcs tanggungan minggu lalu
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-3 px-3 py-1.5 text-xs border-b" style={{ color: "#64748b", borderColor: "#f3e8ff" }}>
                      <span> Diberi: <strong>{r.pcsAwal}</strong></span>
                      <span> Setor: <strong style={{ color: "#16a34a" }}>{r.pcsSetor}</strong></span>
                      {r.pcsReject > 0 && <span> Reject: <strong style={{ color: "#ef4444" }}>{r.pcsReject}</strong></span>}
                      {r.belumSetor > 0 && <span style={{ color: "#b45309" }}> <strong>{r.belumSetor}</strong> blm setor</span>}
                    </div>
                    <div className="px-3 py-2 space-y-1.5">
                      {r.detail.map((d, i) => (
                        <div key={i} className="flex justify-between items-start text-xs rounded-lg px-2 py-1.5"
                          style={{ background: d.sudahSetor ? "#f0fdf4" : "#fefce8" }}>
                          <div>
                            <div className="font-semibold" style={{ color: "#2d1b69" }}>
                               {d.model}  {d.process}
                            </div>
                            <div style={{ color: "#94a3b8" }}>
                              {d.customer}{d.invoice ? `  ${d.invoice}` : ""}
                            </div>
                          </div>
                          <div className="text-right ml-2">
                            <div className="font-bold" style={{ color: d.sudahSetor ? "#16a34a" : "#b45309" }}>
                              {d.sudahSetor ? d.qtySetor : d.qty} pcs
                            </div>
                            {d.sudahSetor && d.gaji > 0 && (
                              <div style={{ color: "#a855f7" }}>{money(d.gaji)}</div>
                            )}
                            {!d.sudahSetor && <div style={{ color: "#b45309" }}> blm setor</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="px-3 pb-3">
                      <button
                        onClick={() => setSlipPreview({ nama, r, dari: rekapDari, sampai: rekapSampai, carryOver })}
                        className="w-full rounded-xl py-2.5 text-xs font-bold text-white flex items-center justify-center gap-2"
                        style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}
                      >
                         Lihat Slip Gaji  {rekapPeriodReady ? `${rekapDari} s/d ${rekapSampai}` : "Periode belum dipilih"}
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
      <KainTab
        tab={tab}
        setTab={setTab}
        filteredMaterials={filteredMaterials}
        fmtQty={fmtQty}
        InfoBox={InfoBox}
        Empty={Empty}
        MiniStat={MiniStat}
      />      <KirimTab
        tab={tab}
        setTab={setTab}
        setModal={setModal}
        filteredShipments={filteredShipments}
        ordersForShipment={ordersForShipment}
        kirimOnlyBelumLengkap={kirimOnlyBelumLengkap}
        setKirimOnlyBelumLengkap={setKirimOnlyBelumLengkap}
        dashboardTotalOrderedQty={dashboardTotalOrderedQty}
        dashboardTotalShippedQty={dashboardTotalShippedQty}
        isShortShipmentClosed={isShortShipmentClosed}
        hasDeliveryDetail={hasDeliveryDetail}
        isLegacyDoneOrSentOrder={isLegacyDoneOrSentOrder}
        fmtQty={fmtQty}
        dateKey={dateKey}
        Empty={Empty}
        Card={Card}
        Button={Button}
        Badge={Badge}
        UiButton={UiButton}
      />      <TarifTab
        tab={tab}
        setTab={setTab}
        setModal={setModal}
        workRates={workRates}
        rateForm={rateForm}
        setRateForm={setRateForm}
        deleteRate={deleteRate}
        displayProductTypeName={displayProductTypeName}
        displayModelName={displayModelName}
        displayProcessName={displayProcessName}
        money={money}
        Card={Card}
        Button={Button}
        Empty={Empty}
        UiButton={UiButton}
      />
    </>
  );
}
