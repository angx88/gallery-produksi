import React from "react";

export default function KirimTab(props) {
  const {
    tab,
    setTab,
    setModal,
    filteredShipments,
    ordersForShipment,
    kirimOnlyBelumLengkap,
    setKirimOnlyBelumLengkap,
    dashboardTotalOrderedQty,
    dashboardTotalShippedQty,
    isShortShipmentClosed,
    hasDeliveryDetail,
    isLegacyDoneOrSentOrder,
    fmtQty,
    dateKey,
    Empty,
    Card,
    Button,
    Badge,
    UiButton,
  } = props;

  return (
    <>
      {tab === "kirim" && (
        <div className="space-y-3 p-4">
          <Button onClick={() => setModal("kirim")} className="w-full" style={{ background: "linear-gradient(135deg,#10b981,#34d399)" }}>
             + Catat Pengiriman
          </Button>
          {kirimOnlyBelumLengkap && (
            <div className="rounded-2xl px-4 py-3 flex items-start gap-3" style={{ background: "#dbeafe", border: "1.5px solid #93c5fd" }}>
              <span className="text-xl"></span>
              <div className="flex-1">
                <div className="text-sm font-black" style={{ color: "#1d4ed8" }}>Hanya menampilkan pengiriman belum lengkap</div>
                <div className="text-xs mt-1" style={{ color: "#2563eb" }}>Catat sisa pengiriman untuk pesanan di bawah ini.</div>
              </div>
              <button
                type="button"
                onClick={() => setKirimOnlyBelumLengkap(false)}
                className="text-xs font-bold px-3 py-2 rounded-full text-white shrink-0"
                style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}
              >
                Tampilkan Semua
              </button>
            </div>
          )}
          {(() => {
            const kirimBelumLengkapIds = new Set(
              dashboardInsights.tugas.kirimBelumLengkap.map(({ order }) => order.id)
            );
            const displayed = kirimOnlyBelumLengkap
              ? filteredShipments.filter((k) => kirimBelumLengkapIds.has(k.orderId) || kirimBelumLengkapIds.has(k.pesananId))
              : filteredShipments;
            if (displayed.length === 0) return <Empty text={kirimOnlyBelumLengkap ? "Semua pengiriman sudah lengkap" : "Tidak ada data pengiriman"} />;
            return displayed.map((k) => (
            <div key={k.id} className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: "1px solid #fce7f3" }}>
              <div className="font-bold" style={{ color: "#2d1b69" }}>{k.customer || orders.find((o) => sameText(o.id, k.pesananId) || sameText(o.invoice, k.invoice))?.customer || "-"}</div>
              <div className="text-xs" style={{ color: "#a855f7" }}> {k.produk || orders.find((o) => sameText(o.id, k.pesananId) || sameText(o.invoice, k.invoice))?.item || "-"}</div>
              <div className="text-xs font-bold" style={{ color: "#64748b" }}> {k.tanggalKirim || "-"}  {k.ekspedisi || "-"}</div>
              <div className="mt-3 rounded-2xl p-3" style={{ background: "#fdf2f8" }}>
                {(k.items || []).map((item, i) => (
                  <div key={i} className="flex justify-between text-xs py-1">
                    <span>{item.nama || "-"}</span>
                    <span className="font-bold">{item.qtyPesan || 0} / {item.qtyKirim || 0} pcs</span>
                  </div>
                ))}
              </div>
            </div>
          ));
          })()}
        </div>
      )}
    </>
  );
}
