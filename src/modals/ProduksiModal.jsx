import React from "react";
import { Modal as UiModal, Input as UiInput, Select as UiSelect } from "../components/ui";

export default function ProduksiModal({
  modal,
  setModal,
  prodForm,
  setProdForm,
  ordersBelumProduksi,
  addProduksi,
  isSaving,
  Button,
}) {
  return (
    <>
      {modal === "produksi" && (
        <UiModal title=" Tambah ke Produksi" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <UiSelect label="Pilih Pesanan" value={prodForm.orderId} onChange={(v) => setProdForm((f) => ({ ...f, orderId: v }))}>
              <option value="">-- Pilih Pesanan --</option>
              {ordersBelumProduksi.map((o) => <option key={o.id} value={o.id}>{o.customer}  {o.item}  {o.qty} pcs</option>)}
            </UiSelect>
            <UiInput label="Tanggal Mulai" type="date" value={prodForm.tanggalMulai} onChange={(v) => setProdForm((f) => ({ ...f, tanggalMulai: v }))} />
            <UiInput label="Catatan" value={prodForm.catatan} onChange={(v) => setProdForm((f) => ({ ...f, catatan: v }))} placeholder="Catatan produksi" />
            <Button onClick={addProduksi} disabled={isSaving} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
              Simpan Produksi
            </Button>
          </div>
        </UiModal>
      )}
    </>
  );
}
