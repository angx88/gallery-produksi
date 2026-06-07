import React from "react";
import { Modal as UiModal, Input as UiInput, Select as UiSelect } from "../components/ui";

export default function KirimModal({
  modal,
  setModal,
  shipForm,
  setShipForm,
  ordersForShipment,
  saveShipment,
  isSaving,
  Button,
}) {
  return (
    <>
      {modal === "kirim" && (
        <UiModal title=" Catat Pengiriman" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <UiSelect
              label="Pilih Customer"
              value={kirimForm.customerKey || ""}
              onChange={(v) => {
                const customerOrders = ordersForShipment.filter((o) => normalizeKey(o.customer || "") === v);
                const orderIds = customerOrders.map((o) => o.id);
                const nextItems = customerOrders.flatMap((p) => {
                  const existingDeliveries = getDeliveryArray(p);
                  return orderBaseItems(p).map((it, idx) => {
                    const qtyPesan = Number(it.orderedQty || it.qty || 0);
                    const sudahKirim = existingDeliveries.reduce((sum, delivery) => {
                      const found = (delivery.items || []).find((di) =>
                        di.itemIndex !== undefined ? Number(di.itemIndex) === idx
                          : normalizeModelKey(di.name || "") === normalizeModelKey(it.name || "")
                      );
                      return sum + Number(found?.qty ?? found?.shippedQty ?? found?.qtyKirim ?? 0);
                    }, 0);
                    const sisa = Math.max(0, qtyPesan - sudahKirim);
                    return { orderId: p.id, invoice: p.invoice || "", customer: p.customer || "", nama: it.name || p.item || "", qtyPesan, qtyKirim: sisa, itemIndex: idx };
                  }).filter((it) => Number(it.qtyKirim || 0) > 0);
                });
                const first = customerOrders[0];
                setKirimForm((f) => ({
                  ...f,
                  customerKey: v,
                  pesananId: orderIds[0] || "",
                  orderIds,
                  penerima: first?.customer || "",
                  items: nextItems.length > 0 ? nextItems : [{ nama: "", qtyPesan: 0, qtyKirim: 0 }],
                  shortShipmentMode: "temporary",
                  shortShipmentReason: "Stok kain habis",
                  shortShipmentNote: "",
                }));
              }}
            >
              <option value="">-- Pilih Customer --</option>
              {shipmentCustomerOptions.map((c) => <option key={c.key} value={c.key}>{c.name}  {c.count} pesanan siap/sisa kirim</option>)}
            </UiSelect>
            {kirimForm.customerKey && (
              <div className="rounded-2xl border p-3 text-xs space-y-2" style={{ background: "#f8fafc", borderColor: "#e2e8f0", color: "#475569" }}>
                <div className="font-black" style={{ color: "#0f172a" }}>Pesanan dalam nota ini</div>
                {ordersForShipment.filter((o) => normalizeKey(o.customer || "") === kirimForm.customerKey).map((o) => {
                  const checked = (kirimForm.orderIds || []).includes(o.id);
                  return (
                    <label key={o.id} className="flex items-center gap-2 rounded-xl bg-white p-2">
                      <UiInput
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const nextIds = e.target.checked
                            ? Array.from(new Set([...(kirimForm.orderIds || []), o.id]))
                            : (kirimForm.orderIds || []).filter((id) => id !== o.id);
                          const selectedOrders = ordersForShipment.filter((x) => nextIds.includes(x.id));
                          const nextItems = selectedOrders.flatMap((p) => {
                            const existingDeliveries = getDeliveryArray(p);
                            return orderBaseItems(p).map((it, idx) => {
                              const qtyPesan = Number(it.orderedQty || it.qty || 0);
                              const sudahKirim = existingDeliveries.reduce((sum, delivery) => {
                                const found = (delivery.items || []).find((di) =>
                                  di.itemIndex !== undefined ? Number(di.itemIndex) === idx
                                    : normalizeModelKey(di.name || "") === normalizeModelKey(it.name || "")
                                );
                                return sum + Number(found?.qty ?? found?.shippedQty ?? found?.qtyKirim ?? 0);
                              }, 0);
                              const sisa = Math.max(0, qtyPesan - sudahKirim);
                              return { orderId: p.id, invoice: p.invoice || "", customer: p.customer || "", nama: it.name || p.item || "", qtyPesan, qtyKirim: sisa, itemIndex: idx };
                            }).filter((it) => Number(it.qtyKirim || 0) > 0);
                          });
                          setKirimForm((f) => ({ ...f, orderIds: nextIds, pesananId: nextIds[0] || "", items: nextItems.length > 0 ? nextItems : [{ nama: "", qtyPesan: 0, qtyKirim: 0 }] }));
                        }}
                      />
                      <span className="flex-1"><b>{o.invoice || o.item}</b>  {o.item}  {o.qty} pcs</span>
                    </label>
                  );
                })}
              </div>
            )}
            <UiInput label="Tanggal Kirim" type="date" value={kirimForm.tanggalKirim} onChange={(v) => setKirimForm((f) => ({ ...f, tanggalKirim: v }))} />
            <UiInput label="Penerima" value={kirimForm.penerima} onChange={(v) => setKirimForm((f) => ({ ...f, penerima: v }))} />
            <UiInput label="Ekspedisi" value={kirimForm.ekspedisi} onChange={(v) => setKirimForm((f) => ({ ...f, ekspedisi: v }))} placeholder="JNE, J&T, Gojek" />
            {kirimForm.items.map((item, idx) => (
              <div key={idx} className="rounded-2xl p-3" style={{ background: "#fdf2f8" }}>
                {(item.invoice || item.customer) && <div className="mb-2 text-xs font-bold" style={{ color: "#7c3aed" }}>{item.invoice || "Pesanan"}  {item.customer || kirimForm.penerima}</div>}
                <UiInput
                  label="Item"
                  value={item.nama}
                  onChange={(v) => {
                    const items = [...kirimForm.items];
                    items[idx] = { ...items[idx], nama: v };
                    setKirimForm((f) => ({ ...f, items }));
                  }}
                />
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <UiInput label="Qty Pesan" value={item.qtyPesan} readOnly />
                  <UiInput
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
            {(() => {
              const totalPesan = (kirimForm.items || []).reduce((s, it) => s + Number(it.qtyPesan || 0), 0);
              const totalKirim = (kirimForm.items || []).reduce((s, it) => s + Number(it.qtyKirim || 0), 0);
              const sisa = Math.max(0, totalPesan - totalKirim);
              const lebih = Math.max(0, totalKirim - totalPesan);
              if (!kirimForm.pesananId || totalKirim <= 0 || (sisa <= 0 && lebih <= 0)) return null;
              if (lebih > 0) {
                return (
                  <div className="rounded-2xl border p-3 text-xs" style={{ background: "#fff7ed", borderColor: "#fed7aa", color: "#9a3412" }}>
                    <div className="font-bold mb-1"> Kelebihan kirim {formatNumber(lebih)} pcs</div>
                    <div>Qty kirim lebih besar dari pesanan. Kelebihan ini akan ikut menambah tagihan customer di Gallery Kerudung karena invoice mengikuti qty terkirim.</div>
                  </div>
                );
              }
              return (
                <div className="rounded-2xl border p-3 text-xs space-y-3" style={{ background: "#fffbeb", borderColor: "#fde68a", color: "#92400e" }}>
                  <div>
                    <div className="font-bold mb-1"> Pengiriman kurang dari pesanan</div>
                    <div>Pesanan {formatNumber(totalPesan)} pcs  dikirim {formatNumber(totalKirim)} pcs  sisa {formatNumber(sisa)} pcs.</div>
                  </div>
                  <div className="grid gap-2">
                    <label className="flex items-start gap-2 rounded-xl bg-white/70 p-2">
                      <UiInput type="radio" checked={(kirimForm.shortShipmentMode || "temporary") === "temporary"} onChange={() => setKirimForm((f) => ({ ...f, shortShipmentMode: "temporary" }))} />
                      <span><b>Kurang kirim sementara</b><br/>Pilih ini jika sisa barang masih akan diproduksi/dikirim lagi nanti. Status menjadi Dikirim Sebagian dan sisa tetap tampil di Dashboard.</span>
                    </label>
                    <label className="flex items-start gap-2 rounded-xl bg-white/70 p-2">
                      <UiInput type="radio" checked={kirimForm.shortShipmentMode === "final"} onChange={() => setKirimForm((f) => ({ ...f, shortShipmentMode: "final" }))} />
                      <span><b>Kurang kirim final</b><br/>Pilih ini jika sisa tidak akan dikirim lagi. Order ditutup sebagai Kurang Kirim Final, sisa tidak jadi tanggungan aktif, dan tagihan tetap hanya dari qty terkirim.</span>
                    </label>
                  </div>
                  {kirimForm.shortShipmentMode === "final" && (
                    <div className="grid gap-2">
                      <UiSelect label="Alasan kurang kirim final" value={kirimForm.shortShipmentReason || "Stok kain habis"} onChange={(v) => setKirimForm((f) => ({ ...f, shortShipmentReason: v }))}>
                        <option value="Stok kain habis">Stok kain habis</option>
                        <option value="Produksi hanya jadi segitu">Produksi hanya jadi segitu</option>
                        <option value="Customer setuju dikurangi">Customer setuju dikurangi</option>
                        <option value="Lainnya">Lainnya</option>
                      </UiSelect>
                      <UiInput label="Catatan penutupan" value={kirimForm.shortShipmentNote || ""} onChange={(v) => setKirimForm((f) => ({ ...f, shortShipmentNote: v }))} placeholder="Opsional" />
                    </div>
                  )}
                </div>
              );
            })()}
            {(() => {
              const unlinkedCount = (productionEntries || []).filter((e) => !e.orderId && Number(getEntrySetorTotals(e).qtySetor || 0) > 0).length;
              if (unlinkedCount <= 0) return null;
              return (
                <div className="rounded-2xl border p-3 text-xs font-bold" style={{ background: "#fffbeb", borderColor: "#fde68a", color: "#92400e" }}>
                   Ada {unlinkedCount} entry borongan sudah setor tapi masih Tanpa Pesanan. Cek Tab Borongan dan kaitkan dulu kalau entry itu milik pesanan yang akan dikirim.
                </div>
              );
            })()}
            <UiInput label="Catatan" value={kirimForm.catatan} onChange={(v) => setKirimForm((f) => ({ ...f, catatan: v }))} placeholder="Opsional" />
            <Button onClick={addPengiriman} disabled={isSaving} className="w-full" style={{ background: "linear-gradient(135deg,#10b981,#34d399)" }}>
              Simpan Pengiriman
            </Button>
          </div>
        </UiModal>
      )}
    </>
  );
}
