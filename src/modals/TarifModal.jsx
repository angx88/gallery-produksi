import React from "react";
import { Modal as UiModal, Input as UiInput, Select as UiSelect } from "../components/ui";

export default function TarifModal({
  modal,
  setModal,
  rateForm,
  setRateForm,
  saveRate,
  isSaving,
  Button,
}) {
  return (
    <>
      {modal === "tarif" && (
        <UiModal title=" Tambah Tarif Borongan" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <UiSelect label="Jenis Produk" value={rateForm.productType} onChange={(v) => setRateForm((f) => ({ ...f, productType: v }))}>
              {PRODUCT_TYPES.map((p) => <option key={p}>{p}</option>)}
            </UiSelect>
            <UiSelect label="Proses" value={rateForm.process} onChange={(v) => setRateForm((f) => ({ ...f, process: v }))}>
              {ALL_PROCESSES.map((p) => <option key={p}>{p}</option>)}
            </UiSelect>
            <div>
              <UiInput label="Model / Acuan Tarif" value={rateForm.model} onChange={(v) => setRateForm((f) => ({ ...f, model: v }))} placeholder="Contoh: Kerudung / Alya L / Gamis" />
              <div className="mt-1 text-[11px] font-semibold" style={{ color: "#64748b" }}>
                Isi sesuai Master Tarif. Untuk Potong/Pengemasan-QC boleh memakai acuan umum seperti Kerudung.
              </div>
              {modelNameOptions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {modelNameOptions.slice(0, 10).map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setRateForm((f) => ({ ...f, model: name }))}
                      className="rounded-full px-3 py-1 text-xs font-bold"
                      style={{ background: "#f5f3ff", color: "#7c3aed", border: "1px solid #ddd6fe" }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <UiInput label="Tarif per pcs" type="number" value={rateForm.rate} onChange={(v) => setRateForm((f) => ({ ...f, rate: v }))} placeholder="Contoh: 2000" />
            <Button onClick={addWorkRate} disabled={isSaving} className="w-full" style={{ background: "linear-gradient(135deg,#a855f7,#ec4899)" }}>
              Simpan Tarif
            </Button>
          </div>
        </UiModal>
      )}
    </>
  );
}
