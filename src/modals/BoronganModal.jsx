import React from "react";
import { Modal as UiModal, Input as UiInput, Select as UiSelect } from "../components/ui";

export default function BoronganModal({
  modal,
  setModal,
  prodForm,
  setProdForm,
  ordersForBoronganLink,
  addBorongan,
  isSaving,
  Button,
}) {
  return (
    <>
      {modal === "borongan" && (
        <UiModal title=" Input Hasil Borongan" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div>
              <UiInput
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
              <div className="mt-2 rounded-xl px-3 py-2 text-[11px] font-semibold" style={{ background: "#f8fafc", color: "#64748b", border: "1px solid #e2e8f0" }}>
                Master data otomatis dari nama yang sudah pernah dipakai. Nama mirip akan dirapikan dan digabung saat disimpan.
              </div>
            </div>
            <UiSelect
              label="Pesanan terkait"
              value={entryForm.orderId}
              onChange={(v) => {
                const o = orders.find((x) => x.id === v);
                setEntryForm((f) => ({ ...f, orderId: v, model: "", qty: "" }));
              }}
            >
              <option value="">Tidak dikaitkan ke pesanan</option>
              {ordersForBoronganLink.map((o) => <option key={o.id} value={o.id}>{o.customer}  {o.invoice || o.item}  {o.qty} pcs</option>)}
            </UiSelect>
            <UiSelect label="Jenis Produk" value={entryForm.productType} onChange={(v) => setEntryForm((f) => ({ ...f, productType: v }))}>
              {PRODUCT_TYPES.map((p) => <option key={p}>{p}</option>)}
            </UiSelect>
            <UiSelect label="Proses" value={entryForm.process} onChange={(v) => setEntryForm((f) => ({ ...f, process: v, model: "" }))}>
              {ALL_PROCESSES.map((p) => <option key={p}>{p}</option>)}
            </UiSelect>
            {(() => {
              const selectedOrder = orders.find((o) => o.id === entryForm.orderId);
              const rateModels = getRateModelOptions(entryForm.productType, entryForm.process, selectedOrder);
              const selectedPreview = getRatePreview(entryForm.productType, entryForm.model, entryForm.process, entryForm.employeeName);
              const { limit, label } = selectedOrder && entryForm.model
                ? getOrderProcessLimit(selectedOrder, entryForm.process, entryForm.model)
                : { limit: 0, label: "pesanan" };
              const alreadyQty = selectedOrder && entryForm.model
                ? processQtyForOrderModel(selectedOrder.id, entryForm.process, entryForm.model)
                : 0;
              const sisaQty = limit > 0 ? Math.max(0, limit - alreadyQty) : 0;
              return (
                <div className="space-y-2">
                  <UiSelect
                    label="Model / Acuan Tarif"
                    value={entryForm.model}
                    onChange={(v) => setEntryForm((f) => ({ ...f, model: v, qty: sisaQty > 0 ? String(sisaQty) : f.qty }))}
                  >
                    <option value="">{isModelSpecificProcess(entryForm.process) ? "-- Pilih model dari pesanan terkait --" : "-- Pilih acuan tarif dari Master Tarif --"}</option>
                    {rateModels.map((name) => <option key={name} value={name}>{name}</option>)}
                  </UiSelect>
                  {entryProcessRequiresOrder(entryForm.process) && !selectedOrder && (
                    <div className="rounded-2xl border p-3 text-xs font-bold" style={{ background: "#fff7ed", borderColor: "#fed7aa", color: "#9a3412" }}>
                       Proses {entryForm.process} wajib dikaitkan ke pesanan agar model pesanan bisa dipilih.
                    </div>
                  )}
                  {entryProcessWarnsWithoutOrder(entryForm.process) && !selectedOrder && (
                    <div className="rounded-2xl border p-3 text-xs font-bold" style={{ background: "#fffbeb", borderColor: "#fde68a", color: "#92400e" }}>
                       {entryForm.process} boleh tanpa pesanan, tapi nanti tidak ikut progress di Tab Produksi sampai dikaitkan lewat tombol  Kaitkan ke Pesanan.
                    </div>
                  )}
                  {rateModels.length === 0 && (!isModelSpecificProcess(entryForm.process) || selectedOrder) && (
                    <div className="rounded-2xl border p-3 text-xs font-bold" style={{ background: "#fff7ed", borderColor: "#fed7aa", color: "#9a3412" }}>
                       {isModelSpecificProcess(entryForm.process)
                        ? `Pesanan terkait belum memiliki item/model untuk proses ${entryForm.process}.`
                        : `Tarif belum ada di Master Tarif untuk ${entryForm.productType}  ${entryForm.process}. Silakan buat tarif baru di menu Master Tarif.`}
                    </div>
                  )}
                  {selectedPreview.status === "found" && (
                    <div className="rounded-2xl border p-3 text-xs" style={{ background: "#ecfdf5", borderColor: "#86efac", color: "#166534" }}>
                      <div className="font-black"> Tarif yang dipakai</div>
                      <div className="mt-1 font-bold">{entryForm.productType}  {entryForm.process}  {entryForm.model}</div>
                      <div className="mt-1 text-base font-black">{money(selectedPreview.effectiveRate)} / pcs</div>
                      {normalizeWorkerNameKey(entryForm.employeeName).includes("konveksi") && (
                        <div className="mt-1 text-[11px] font-semibold">Tarif Master {money(selectedPreview.baseRate)} / pcs  Tarif Konveksi {money(selectedPreview.effectiveRate)} / pcs</div>
                      )}
                    </div>
                  )}
                  {selectedPreview.status === "missing" && (
                    <div className="rounded-2xl border p-3 text-xs font-bold" style={{ background: "#fff1f2", borderColor: "#fecdd3", color: "#be123c" }}>
                       Tarif belum ada di Master Tarif. Silakan buat tarif baru di menu Master Tarif.
                    </div>
                  )}
                  {selectedPreview.status === "invalid" && (
                    <div className="rounded-2xl border p-3 text-xs font-bold" style={{ background: "#fff1f2", borderColor: "#fecdd3", color: "#be123c" }}>
                       Tarif Konveksi tidak valid. Silakan perbaiki tarif di Master Tarif.
                    </div>
                  )}
                  {selectedOrder && entryForm.model && limit > 0 && (
                    <div className="rounded-2xl px-3 py-2 text-xs font-semibold" style={{ background: "#f8fafc", color: "#475569", border: "1px solid #e2e8f0" }}>
                      Batas {label}: {limit} pcs  sudah input {alreadyQty} pcs  sisa {sisaQty} pcs.
                    </div>
                  )}
                </div>
              );
            })()}
            <UiInput label="Jumlah pcs" type="number" value={entryForm.qty} onChange={(v) => setEntryForm((f) => ({ ...f, qty: v }))} placeholder="Contoh: 500" />
            <UiInput label="Tanggal" type="date" value={entryForm.tanggal} onChange={(v) => setEntryForm((f) => ({ ...f, tanggal: v }))} />
            <UiInput label="Catatan" value={entryForm.catatan} onChange={(v) => setEntryForm((f) => ({ ...f, catatan: v }))} placeholder="Opsional" />
            <Button onClick={addProductionEntry} disabled={isSaving} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
              Simpan Hasil Borongan
            </Button>
          </div>
        </UiModal>
      )}
    </>
  );
}

