import React from "react";

export default function ProduksiTab(props) {
  const {
    tab,
    orders,
    filteredProduksi,
    produksiOnlyBelumSelesai,
    setProduksiOnlyBelumSelesai,
    setModal,
    processQtyForOrder,
    processQtyForOrderModel,
    productionEntries,
    getEntrySetorTotals,
    updateProduksiStatus,
    displayModelName,
    normalizeModelKey,
    sameProcess,
    fmtQty,
    formatNumber,
    Empty,
    Button,
    Card,
    StatusBadge,
    ProgressBar,
    PROD_STATUS,
  } = props;

  return (
    <>
      {tab === "produksi" && (
        <div className="space-y-3 p-4">
          <Button onClick={() => setModal("produksi")} className="w-full" style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}>
             + Tambah ke Produksi
          </Button>
          {produksiOnlyBelumSelesai && (
            <div className="rounded-2xl px-4 py-3 flex items-start gap-3" style={{ background: "#ede9fe", border: "1.5px solid #c4b5fd" }}>
              <span className="text-xl"></span>
              <div className="flex-1">
                <div className="text-sm font-black" style={{ color: "#5b21b6" }}>Hanya menampilkan produksi belum selesai</div>
                <div className="text-xs mt-1" style={{ color: "#7c3aed" }}>Update status produksi di bawah ini.</div>
              </div>
              <button
                type="button"
                onClick={() => setProduksiOnlyBelumSelesai(false)}
                className="text-xs font-bold px-3 py-2 rounded-full text-white shrink-0"
                style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}
              >
                Tampilkan Semua
              </button>
            </div>
          )}
          {(() => {
            const displayedProduksi = produksiOnlyBelumSelesai
              ? filteredProduksi.filter((p) => p.status !== "Selesai")
              : filteredProduksi;
            return (
              <>
                {displayedProduksi.length === 0 && <Empty text={produksiOnlyBelumSelesai ? "Semua produksi sudah selesai" : "Tidak ada data produksi"} />}
                {displayedProduksi.map((p) => {
            const qtyPesanan = Number(p.qty || 0);
            const rekapProses = [
              { label: " Potong", qty: processQtyForOrder(p.orderId, "Potong") },
              { label: " Jahit", qty: processQtyForOrder(p.orderId, "Jahit") },
              { label: " Pengemasan QC", qty: processQtyForOrder(p.orderId, "Pengemasan QC") },
            ].filter((r) => r.qty > 0);
            return (
            <div key={p.id} className="rounded-2xl bg-white shadow-sm overflow-hidden" style={{ border: "1px solid #fce7f3" }}>
              <div className="flex items-center justify-between px-4 pt-3 pb-2">
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm truncate" style={{ color: "#2d1b69" }}>{p.customer}</div>
                  <div className="text-xs truncate" style={{ color: "#94a3b8" }}>{p.invoice}</div>
                </div>
                <div className="flex items-center gap-2 ml-2">
                  <div className="text-right">
                    <div className="text-lg font-bold" style={{ color: "#ec4899" }}>{p.qty}</div>
                    <div className="text-xs font-bold" style={{ color: "#64748b" }}>pcs</div>
                  </div>
                  <StatusBadge status={p.status} />
                </div>
              </div>
              {(() => {
                const order = orders.find(o => o.id === p.orderId);
                const orderItems = (order?.items || []).filter(it => it.name && it.name !== "-" && Number(it.qty) > 0);
                const prodItems = (p.items || []).filter(it => it.name && it.name !== "-" && Number(it.qty) > 0);
                const isStaleData = prodItems.length === 1 && orderItems.length > 1 &&
                  Number(prodItems[0]?.qty) === Number(p.qty);
                const displayItems = (isStaleData || prodItems.length === 0) ? orderItems : prodItems;
                if (displayItems.length === 0) return null;
                return (
                  <div className="px-4 pb-2">
                    <div className="text-xs font-bold mb-1.5" style={{ color: "#7c3aed" }}>
                       Rincian Model ({displayItems.length} model  {p.qty} pcs total):
                    </div>
                    <div className="space-y-1.5">
                      {displayItems.map((it, i) => {
                        const modelName = it.name || it.item || "-";
                        const modelQty = Number(it.qty || 0);
                        const potongQty = productionEntries
                          .filter(e => e.orderId === p.orderId && sameProcess(e.process, "Potong") && normalizeModelKey(e.model || "") === normalizeModelKey(modelName))
                          .reduce((s, e) => s + Number(e.qty || 0), 0);
                        const jahitQty = productionEntries
                          .filter(e => e.orderId === p.orderId && sameProcess(e.process, "Jahit") && normalizeModelKey(e.model || "") === normalizeModelKey(modelName))
                          .reduce((s, e) => s + Number(e.qty || 0), 0);
                        const qcQty = productionEntries
                          .filter(e => e.orderId === p.orderId && sameProcess(e.process, "Pengemasan QC"))
                          .reduce((s, e) => s + Number(e.qty || 0), 0);
                        const jahitDone = jahitQty >= modelQty;
                        return (
                          <div key={i} className="rounded-xl p-2.5" style={{ background: jahitDone ? "#dcfce7" : "#ede9fe", border: `1px solid ${jahitDone ? "#bbf7d0" : "#c4b5fd"}` }}>
                            <div className="flex justify-between items-center mb-1">
                              <div className="font-bold text-xs" style={{ color: jahitDone ? "#16a34a" : "#5b21b6" }}>
                                {modelName} {jahitDone ? "" : ""}
                              </div>
                              <div className="text-xs font-bold" style={{ color: "#2d1b69" }}>{modelQty} pcs</div>
                            </div>
                            <div className="flex gap-2 text-xs">
                              {potongQty > 0 && (
                                <span className="rounded-full px-2 py-0.5" style={{ background: "#dbeafe", color: "#1e40af" }}>
                                   {potongQty}/{modelQty}
                                </span>
                              )}
                              <span className="rounded-full px-2 py-0.5" style={{ background: jahitDone ? "#bbf7d0" : "#fce7f3", color: jahitDone ? "#16a34a" : "#be185d" }}>
                                 {jahitQty}/{modelQty}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
              <ProgressBar status={p.status} />
              {rekapProses.length > 0 && (
                <div className="px-4 py-2 grid grid-cols-3 gap-1">
                  {rekapProses.map((r) => {
                    const sesuai = r.qty >= qtyPesanan;
                    return (
                      <div key={r.label} className="rounded-xl p-2 text-center" style={{ background: sesuai ? "#dcfce7" : "#fef3c7" }}>
                        <div className="text-xs font-bold" style={{ color: sesuai ? "#16a34a" : "#b45309" }}>{r.qty}</div>
                        <div className="text-xs font-bold" style={{ color: "#64748b" }}>{r.label}</div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="px-4 pb-3">
                <div className="flex gap-1 flex-wrap">
                  {PROD_STATUS.map((s) => (
                    <button key={s} onClick={() => updateProduksiStatus(p.id, s)}
                      className="rounded-full px-2 py-1 text-xs font-semibold"
                      style={{
                        background: p.status === s ? "linear-gradient(135deg,#ec4899,#a855f7)" : "#fdf2f8",
                        color: p.status === s ? "white" : "#a855f7",
                        border: "1px solid #f9a8d4",
                      }}>
                      {PROD_COLORS[s]?.icon} {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            );
          })}
              </>
            );
          })()}
        </div>
      )}
    </>
  );
}
