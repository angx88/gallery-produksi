import React from "react";
import { motion } from "framer-motion";

export default function PesananTab(props) {
  const {
    tab,
    visiblePesananOrders,
    ordersBelumProduksi,
    ordersPerluDicek,
    ordersPerluDicekIds,
    pesananOnlyNeedCheck,
    setPesananOnlyNeedCheck,
    setNeedCheckContextId,
    setSearch,
    setTab,
    setModal,
    setProdForm,
    todayStr,
    orderSmallStatus,
    produksiByOrderId,
    shipmentByOrderId,
    orderHasCompletedProduction,
    isOrderClosedForNewWork,
    isShortShipmentClosed,
    dashboardTotalOrderedQty,
    dashboardTotalShippedQty,
    fmtQty,
    openPengirimanForOrder,
    Card,
    Button,
    StatusBadge,
    ProgressBar,
    Badge,
    UiButton,
  } = props;

  return (
    <>
      {tab === "pesanan" && (
        <div className="space-y-3 p-4">
          <InfoBox title="Sumber: Gallery Kerudung" subtitle="Data realtime dari collection orders" icon="" />
          {pesananOnlyNeedCheck && (
            <div className="rounded-2xl px-4 py-3 flex items-start gap-3" style={{ background: "#fff1f2", border: "1.5px solid #fb7185" }}>
              <span className="text-xl"></span>
              <div className="flex-1">
                <div className="text-sm font-black" style={{ color: "#be123c" }}>Hanya menampilkan pesanan yang perlu dicek</div>
                <div className="text-xs mt-1" style={{ color: "#9f1239" }}>Admin bisa langsung membuka pengiriman dari kartu ini. Pesanan lain disembunyikan sementara agar tidak membingungkan.</div>
              </div>
              <button
                type="button"
                onClick={() => setPesananOnlyNeedCheck(false)}
                className="text-xs font-bold px-3 py-2 rounded-full text-white shrink-0"
                style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}
              >
                Tampilkan Semua
              </button>
            </div>
          )}
          {visiblePesananOrders.length === 0 && <Empty text={pesananOnlyNeedCheck ? "Tidak ada pesanan yang perlu dicek" : "Tidak ada data pesanan"} />}
          {visiblePesananOrders.map((o) => {
            const prod = produksiByOrderId.get(o.id);
            const small = orderSmallStatus(o);
            const canStart = ordersBelumProduksi.some((x) => x.id === o.id);
            const needCheckInfo = ordersPerluDicek.find((x) => x.id === o.id);
            return (
              <div key={o.id} className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: canStart ? "2px solid #fbbf24" : "1px solid #fce7f3" }}>
                <div className="flex justify-between items-start">
                  <div className="flex-1 mr-2">
                    <div className="font-bold text-base" style={{ color: "#2d1b69" }}> {o.customer}</div>
                    <div className="text-xs mt-1" style={{ color: "#a855f7" }}> <b>{o.item}</b></div>
                    {o.invoice && <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}> {o.invoice}</div>}
                    {o.createdAt && <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}> {o.createdAt}</div>}
                    {o.warna && <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}> {o.warna}</div>}
                    <div className="mt-2 text-xs font-bold" style={{ color: small.color }}>{small.label}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold" style={{ color: "#ec4899" }}>{o.qty}</div>
                    <div className="text-xs font-bold" style={{ color: "#64748b" }}>total pcs</div>
                  </div>
                </div>
                {(() => {
                  const its = (o.items || []).filter(it => it.name && it.name !== "-" && Number(it.qty) > 0);
                  if (its.length === 0) return null;
                  const isMulti = its.length > 1;
                  return (
                    <div className="mt-2">
                      {isMulti && (
                        <div className="text-xs font-bold mb-1" style={{ color: "#7c3aed" }}>
                           {its.length} model
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1">
                        {its.map((it, i) => (
                          <span key={i} className="rounded-xl px-3 py-1 text-xs font-semibold"
                            style={{ background: "#ede9fe", color: "#5b21b6", border: "1px solid #c4b5fd" }}>
                            {it.name}: <strong>{it.qty} pcs</strong>
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                {prod && (
                  <div className="mt-3 rounded-2xl px-3 py-2" style={{ background: "#ede9fe" }}>
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-bold" style={{ color: "#5b21b6" }}> Status produksi</span>
                      <StatusBadge status={prod.status} />
                    </div>
                    {(prod.workers || []).length > 0 && (
                      <div className="mt-2 space-y-1">
                        {(prod.workers || []).slice(-3).map((w, idx) => (
                          <div key={idx} className="text-xs" style={{ color: "#7c3aed" }}>
                             {displayWorkerName(w.employeeName)}  {w.process}  {w.qty} pcs
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {needCheckInfo && (
                  <div className="mt-3 rounded-2xl px-3 py-2" style={{ background: "#fff1f2", border: "1px solid #fecdd3" }}>
                    <div className="text-xs font-black" style={{ color: "#be123c" }}> Perlu Dicek</div>
                    <div className="text-xs mt-1" style={{ color: "#9f1239" }}>{needCheckInfo.alasan}</div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <Button
                        type="button"
                        onClick={() => openPengirimanForOrder(o)}
                        className="text-xs"
                        style={{ background: "linear-gradient(135deg,#0ea5e9,#2563eb)" }}
                      >
                         Edit Pengiriman
                      </Button>
                      <Button
                        type="button"
                        onClick={() => setNeedCheckContextId((id) => (id === o.id ? "" : o.id))}
                        className="text-xs"
                        style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}
                      >
                        {needCheckContextId === o.id ? "Tutup Detail" : "Detail Masalah"}
                      </Button>
                    </div>
                    {needCheckContextId === o.id && (() => {
                      const ordered = dashboardTotalOrderedQty(o);
                      let shipped = dashboardTotalShippedQty(o);
                      if (!hasDeliveryDetail(o) && isLegacyDoneOrSentOrder(o) && ordered > 0 && shipped <= 0) shipped = ordered;
                      const sisa = Math.max(0, ordered - shipped);
                      const lebih = Math.max(0, shipped - ordered);
                      const rawStatus = o.status || o.deliveryStatus || o.shippingStatus || "-";
                      return (
                        <div className="mt-2 rounded-2xl bg-white px-3 py-3 text-[11px] space-y-2" style={{ border: "1px solid #fecdd3" }}>
                          <div
                            className="font-black"
                            style={{ color: "#be123c" }}
                          >
                            Detail masalah pengiriman
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="rounded-xl px-2 py-2" style={{ background: "#f8fafc" }}>
                              <div style={{ color: "#64748b" }}>Pesanan</div>
                              <div className="font-black" style={{ color: "#1e1b4b" }}>{fmtQty(ordered)} pcs</div>
                            </div>
                            <div className="rounded-xl px-2 py-2" style={{ background: "#ecfdf5" }}>
                              <div style={{ color: "#64748b" }}>Terkirim</div>
                              <div className="font-black" style={{ color: "#16a34a" }}>{fmtQty(shipped)} pcs</div>
                            </div>
                            <div className="rounded-xl px-2 py-2" style={{ background: "#fff7ed" }}>
                              <div style={{ color: "#64748b" }}>Sisa aktif</div>
                              <div className="font-black" style={{ color: "#ea580c" }}>{fmtQty(sisa)} pcs</div>
                            </div>
                            <div className="rounded-xl px-2 py-2" style={{ background: "#fff1f2" }}>
                              <div style={{ color: "#64748b" }}>Lebih kirim</div>
                              <div className="font-black" style={{ color: "#e11d48" }}>{fmtQty(lebih)} pcs</div>
                            </div>
                          </div>
                          <div><b>Invoice:</b> {o.invoice || "-"}</div>
                          <div><b>Status:</b> {rawStatus}</div>
                          <div><b>Alasan dicek:</b> {needCheckInfo.alasan}</div>
                          {isShortShipmentClosed(o) && (
                            <div><b>Alasan kurang kirim final:</b> {o.shortShipmentReason || "-"}</div>
                          )}
                          <div className="rounded-xl px-3 py-2" style={{ background: "#fef2f2", color: "#9f1239" }}>
                            Gunakan <b>Edit Pengiriman</b> jika qty/status belum benar. Jika sisa tidak akan dikirim lagi, pilih <b>Kurang kirim final</b> dan isi alasannya.
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
                {canStart && (
                  <Button
                    onClick={() => {
                      setProdForm({ orderId: o.id, tanggalMulai: todayStr(), catatan: "" });
                      setModal("produksi");
                    }}
                    className="mt-3 w-full"
                    style={{ background: "linear-gradient(135deg,#ec4899,#a855f7)" }}
                  >
                     Mulai Produksi
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
