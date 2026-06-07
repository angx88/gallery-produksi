import React from "react";
import { Modal as UiModal, Input as UiInput } from "../components/ui";

export default function SetorModal({
  setorModal,
  setSetorModal,
  setorForm,
  setSetorForm,
  saveSetor,
  isSaving,
  getEntrySetorTotals,
  setorTotals,
  fmtQty,
  money,
  displayWorkerName,
  displayModelName,
  displayProductTypeName,
  Button,
}) {
  return (
    <>
      {setorModal && (() => {
        const modalTotals = setorTotals(setorModal);
        const sisa = Number(modalTotals.sisaSetor || 0);
        const inputSetor = Number(setorForm.qtySetor || 0);
        const inputReject = Number(setorForm.qtyReject || 0);
        const sisaSetelahInput = Math.max(0, sisa - inputSetor - inputReject);
        return (
        <UiModal title=" Setor Hasil Borongan" onClose={() => setSetorModal(null)}>
          <div className="space-y-3">
            <div className="rounded-2xl p-3" style={{ background: "#fdf2f8", border: "1px solid #fce7f3" }}>
              <div className="font-bold text-sm" style={{ color: "#2d1b69" }}> {displayWorkerName(setorModal.employeeName)}</div>
              <div className="text-xs" style={{ color: "#a855f7" }}>{setorModal.productType}  {setorModal.process}{setorModal.model ? `  ${setorModal.model}` : ""}</div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-xl py-2" style={{ background: "#ede9fe", color: "#5b21b6" }}><strong>{setorModal.qty}</strong><br/>diberi</div>
                <div className="rounded-xl py-2" style={{ background: "#dcfce7", color: "#16a34a" }}><strong>{modalTotals.qtySetor}</strong><br/>sudah setor</div>
                <div className="rounded-xl py-2" style={{ background: sisa > 0 ? "#fef3c7" : "#f1f5f9", color: sisa > 0 ? "#b45309" : "#64748b" }}><strong>{sisa}</strong><br/>sisa</div>
              </div>
            </div>
            {modalTotals.history.length > 0 && (
              <div className="rounded-2xl p-3 text-xs space-y-1" style={{ background: "#fff7ed", border: "1px solid #fed7aa", color: "#92400e" }}>
                <div className="font-bold">Riwayat setor sebelumnya</div>
                {modalTotals.history.map((h, idx) => (
                  <div key={h.id || idx}> {h.tanggalSetor}: setor {Number(h.qtySetor || 0)} pcs{Number(h.qtyReject || 0) > 0 ? `, reject ${Number(h.qtyReject || 0)} pcs` : ""}  {money(h.totalWageSetor || 0)}</div>
                ))}
              </div>
            )}
            <UiInput
              label="Qty Disetor (pcs)"
              type="number"
              value={setorForm.qtySetor}
              onChange={(v) => setSetorForm((f) => ({ ...f, qtySetor: v }))}
              placeholder={`Maks ${sisa} pcs`}
            />
            <UiInput
              label="Qty Reject (pcs)  opsional"
              type="number"
              value={setorForm.qtyReject}
              onChange={(v) => setSetorForm((f) => ({ ...f, qtyReject: v }))}
              placeholder="0 jika tidak ada reject"
            />
            {inputSetor + inputReject > sisa && (
              <div className="rounded-xl px-3 py-2 text-xs font-bold" style={{ background: "#fee2e2", color: "#b91c1c" }}>
                 Total input melebihi sisa {sisa} pcs.
              </div>
            )}
            {inputSetor + inputReject > 0 && inputSetor + inputReject <= sisa && sisaSetelahInput > 0 && (
              <div className="rounded-xl px-3 py-2 text-xs font-bold" style={{ background: "#fef3c7", color: "#b45309" }}>
                 Setelah setor ini masih tersisa {sisaSetelahInput} pcs.
              </div>
            )}
            {inputSetor > 0 && Number(setorModal.rate) > 0 && (
              <div className="rounded-xl px-3 py-2 text-sm font-bold" style={{ background: "#f3e8ff", color: "#7c3aed" }}>
                 Gaji transaksi ini: {money(inputSetor * Number(setorModal.rate))}
                <span className="font-normal text-xs ml-1">({setorForm.qtySetor} pcs  {money(setorModal.rate)})</span>
              </div>
            )}
            <UiInput
              label="Tanggal Setor"
              type="date"
              value={setorForm.tanggalSetor}
              onChange={(v) => setSetorForm((f) => ({ ...f, tanggalSetor: v }))}
            />
            <UiInput
              label="Catatan"
              value={setorForm.catatan}
              onChange={(v) => setSetorForm((f) => ({ ...f, catatan: v }))}
              placeholder="Opsional"
            />
            <Button onClick={simpanSetor} disabled={isSaving || sisa <= 0 || inputSetor + inputReject > sisa} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
              {sisaSetelahInput > 0 ? "Simpan Setor Sebagian" : "Simpan Setor Selesai"}
            </Button>
          </div>
        </UiModal>
        );
      })()}
    </>
  );
}
