import React from "react";
import { Modal as UiModal, Input as UiInput, Select as UiSelect } from "../components/ui";

export default function EditEntryModal({
  editEntryModal,
  setEditEntryModal,
  editEntryForm,
  setEditEntryForm,
  saveEditEntry,
  isSaving,
  ordersForBoronganLink,
  isGeneralRateProcess,
  setorTotals,
  displayWorkerName,
  Button,
}) {
  return (
    <>
      {editEntryModal && (
        <UiModal title=" Edit Entry Borongan" onClose={() => setEditEntryModal(null)}>
          <div className="space-y-3">
            <div className="rounded-2xl p-3" style={{ background: "#fdf2f8", border: "1px solid #fce7f3" }}>
              <div className="font-bold text-sm" style={{ color: "#2d1b69" }}> {displayWorkerName(editEntryModal.employeeName)}</div>
              <div className="text-xs mt-0.5" style={{ color: "#a855f7" }}>
                {editEntryModal.productType}  {editEntryModal.process}
                {editEntryModal.customer ? `  ${editEntryModal.customer}` : ""}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>
                 Nama pekerja & proses tidak bisa diubah di sini
              </div>
            </div>
            {!editEntryModal.orderId && (
              <UiSelect
                label="Kaitkan ke Pesanan"
                value={editEntryForm.orderId}
                onChange={(v) => setEditEntryForm(f => ({ ...f, orderId: v, model: v ? "" : f.model }))}
              >
                <option value="">Belum dikaitkan</option>
                {ordersForBoronganLink.map((o) => <option key={o.id} value={o.id}>{o.customer}  {o.invoice || o.item}  {o.qty} pcs</option>)}
              </UiSelect>
            )}
            {!isGeneralRateProcess(editEntryModal.process) && (
              <UiInput
                label="Model"
                value={editEntryForm.model}
                onChange={(v) => setEditEntryForm(f => ({ ...f, model: v }))}
                placeholder="Contoh: Alya L"
              />
            )}
            <UiInput
              label="Jumlah pcs diberikan"
              type="number"
              value={editEntryForm.qty}
              onChange={(v) => setEditEntryForm(f => ({ ...f, qty: v }))}
              placeholder="Contoh: 62"
            />
            <UiInput
              label="Tanggal"
              type="date"
              value={editEntryForm.tanggal}
              onChange={(v) => setEditEntryForm(f => ({ ...f, tanggal: v }))}
            />
            <UiInput
              label="Catatan"
              value={editEntryForm.catatan}
              onChange={(v) => setEditEntryForm(f => ({ ...f, catatan: v }))}
              placeholder="Opsional"
            />
            {setorTotals(editEntryModal).statusSetor !== "belum_setor" && (
              <div className="rounded-xl px-3 py-2 text-xs font-semibold" style={{ background: "#fef3c7", color: "#b45309" }}>
                 Entry ini sudah pernah disetor. Perubahan qty tidak otomatis mengubah riwayat setor & payroll.
              </div>
            )}
            <Button onClick={saveEditEntry} disabled={isSaving} className="w-full"
              style={{ background: "linear-gradient(135deg,#2563eb,#7c3aed)" }}>
               Simpan Perubahan
            </Button>
          </div>
        </UiModal>
      )}
      {slipPreview && (() => {
        const { nama, r, dari, sampai, carryOver = [] } = slipPreview;
        const fmt = (v) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(v || 0));
        const slipSudahGajian = sudahGajian(nama, dari, sampai);
        return (
          <div className="fixed inset-0 z-50 flex items-end" style={{ background: "rgba(0,0,0,0.4)" }}>
            <div className="w-full max-h-[92vh] overflow-auto bg-white" style={{ borderRadius: "32px 32px 0 0", borderTop: "3px solid #a855f7" }}>
              <div className="px-5 pt-5 pb-3" style={{ background: "linear-gradient(135deg,#a855f7,#ec4899)" }}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-3">
                    <img src="/logo-gk.png" alt="Gallery Kerudung" className="h-12 w-12 rounded-2xl bg-white object-cover" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                    <div className="text-white font-extrabold text-lg"> Slip Pendapatan Borongan</div>
                  </div>
                  <button onClick={() => setSlipPreview(null)}
                    className="rounded-full px-4 py-1.5 text-sm font-bold"
                    style={{ background: "rgba(255,255,255,0.25)", color: "white" }}>
                     Tutup
                  </button>
                </div>
                <div className="text-white text-sm opacity-90">Gallery Kerudung</div>
              </div>
              <div ref={slipRef} className="p-5 space-y-4">
                <div className="rounded-2xl p-4 space-y-2" style={{ background: "#fdf4ff", border: "1px solid #e9d5ff" }}>
                  <div className="flex justify-between text-sm">
                    <span style={{ color: "#94a3b8" }}>Nama Pekerja</span>
                    <strong style={{ color: "#2d1b69" }}> {nama}</strong>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span style={{ color: "#94a3b8" }}>Periode</span>
                    <strong style={{ color: "#2d1b69" }}> {dari} s/d {sampai}</strong>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span style={{ color: "#94a3b8" }}>Tanggal Cetak</span>
                    <strong style={{ color: "#2d1b69" }}>{new Date().toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" })}</strong>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl p-2" style={{ background: "#ede9fe" }}>
                    <div className="font-bold text-base" style={{ color: "#5b21b6" }}>{r.pcsAwal}</div>
                    <div className="text-xs font-bold" style={{ color: "#64748b" }}>Diberikan</div>
                  </div>
                  <div className="rounded-xl p-2" style={{ background: "#dcfce7" }}>
                    <div className="font-bold text-base" style={{ color: "#16a34a" }}>{r.pcsSetor}</div>
                    <div className="text-xs font-bold" style={{ color: "#64748b" }}>Disetor</div>
                  </div>
                  <div className="rounded-xl p-2" style={{ background: r.pcsReject > 0 ? "#fee2e2" : "#f1f5f9" }}>
                    <div className="font-bold text-base" style={{ color: r.pcsReject > 0 ? "#ef4444" : "#94a3b8" }}>{r.pcsReject}</div>
                    <div className="text-xs font-bold" style={{ color: "#64748b" }}>Reject</div>
                  </div>
                </div>
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
                            {d.process}{d.model && d.model !== "-" ? "  " + d.model : ""}
                          </div>
                          <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>
                            {d.customer}{d.invoice ? " / " + d.invoice : ""}
                          </div>
                          <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>
                             {d.tanggalSetor || d.tanggal || "-"}
                          </div>
                          {d.rate > 0 && (
                            <div className="text-xs mt-0.5" style={{ color: "#a855f7" }}>
                              {fmt(d.rate)}/pcs  {d.sudahSetor ? d.qtySetor : d.qty} pcs
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          {d.sudahSetor ? (
                            <>
                              <div className="text-xs font-bold" style={{ color: "#16a34a" }}>{d.qtySetor} pcs</div>
                              {d.qtyReject > 0 && <div className="text-xs" style={{ color: "#ef4444" }}> {d.qtyReject} reject</div>}
                              <div className="text-sm font-bold mt-0.5" style={{ color: "#7c3aed" }}>{fmt(d.gaji)}</div>
                            </>
                          ) : (
                            <>
                              <div className="text-xs font-bold" style={{ color: "#b45309" }}>{d.qty} pcs</div>
                              <div className="text-xs mt-0.5" style={{ color: "#b45309" }}> Blm setor</div>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {r.belumSetor > 0 && (
                  <div className="rounded-xl px-4 py-3 text-xs font-semibold" style={{ background: "#fefce8", border: "1px solid #fde68a", color: "#b45309" }}>
                     Masih ada <strong>{r.belumSetor} pcs</strong> belum disetor, belum termasuk total di bawah.
                  </div>
                )}
                <div className="rounded-2xl p-4" style={{ background: "linear-gradient(135deg,#f0fdf4,#dcfce7)", border: "1.5px solid #bbf7d0" }}>
                  <div className="text-xs mb-1" style={{ color: "#64748b" }}>Total Pendapatan Bersih</div>
                  <div className="text-3xl font-black" style={{ color: "#16a34a" }}>{fmt(r.gaji)}</div>
                </div>
                {(() => {
                  const kasbonAktif = kasbonAktifUntukPekerja(nama);
                  if (kasbonAktif.length === 0) return null;
                  const totalKasbon = kasbonAktif.reduce((s, k) => s + Number(k.sisaKasbon || 0), 0);
                  const potongan = Math.min(totalKasbon, Number(r.gaji || 0));
                  const diterima = Number(r.gaji || 0) - potongan;
                  return (
                    <div className="rounded-2xl p-4 space-y-2" style={{ background: "#fefce8", border: "1.5px solid #fde68a" }}>
                      <div className="text-xs font-black" style={{ color: "#92400e" }}> Kasbon Aktif  akan dipotong saat gajian</div>
                      {kasbonAktif.map((k) => (
                        <div key={k.id} className="flex justify-between text-xs" style={{ color: "#78716c" }}>
                          <span> {k.tanggal}{k.keterangan ? `  ${k.keterangan}` : ""}</span>
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
                <div className="rounded-2xl p-4 space-y-3" style={{ background: slipSudahGajian ? "#f0fdf4" : "#fff7ed", border: `1.5px solid ${slipSudahGajian ? "#bbf7d0" : "#fed7aa"}` }}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-bold" style={{ color: slipSudahGajian ? "#16a34a" : "#b45309" }}>
                        {slipSudahGajian ? " Sudah gajian" : " Belum gajian"}
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
                {carryOver.length > 0 && (
                  <div className="rounded-2xl p-4 space-y-2" style={{ background: "#fff7ed", border: "1.5px solid #fed7aa" }}>
                    <div className="text-xs font-bold" style={{ color: "#b45309" }}>
                       Tanggungan Minggu Lalu (Belum Disetor)
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
                             {e.process}{namaModel !== "-" ? `  ${namaModel}` : ""}
                          </div>
                          {(e.customer || entryOrder?.customer) && (
                            <div style={{ color: "#94a3b8" }}>{e.customer || entryOrder?.customer}{e.invoice ? `  ${e.invoice}` : ""}</div>
                          )}
                          <div className="flex justify-between mt-1">
                            <span style={{ color: "#b45309" }}>
                               {periodeAsli ? `${periodeAsli.dari} s/d ${periodeAsli.sampai}` : e.tanggal}
                            </span>
                            <span className="font-bold" style={{ color: "#b45309" }}>{Number(getEntrySetorTotals(e).sisaSetor || 0)} pcs  belum disetor</span>
                          </div>
                        </div>
                      );
                    })}
                    <div className="text-xs font-semibold text-center" style={{ color: "#b45309" }}>
                      Total tanggungan: {carryOver.reduce((s, e) => s + Number(getEntrySetorTotals(e).sisaSetor || 0), 0)} pcs
                    </div>
                  </div>
                )}
                <button
                  onClick={() => downloadSlipGaji(nama, r, dari, sampai, carryOver)}
                  className="w-full rounded-2xl py-3.5 font-bold text-white flex items-center justify-center gap-2 text-sm"
                  style={{ background: "linear-gradient(135deg,#7c3aed,#a855f7)" }}
                >
                   Download / Cetak Slip PDF
                </button>
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
    </>
  );
}
