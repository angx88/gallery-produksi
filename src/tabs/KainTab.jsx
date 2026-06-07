import React from "react";

export default function KainTab(props) {
  const {
    tab,
    setTab,
    filteredMaterials,
    fmtQty,
    InfoBox,
    Empty,
    MiniStat,
  } = props;

  return (
    <>
      {tab === "kain" && (
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-2 rounded-2xl bg-white p-2 shadow-sm" style={{ border: "1px solid #fce7f3" }}>
            <button
              type="button"
              onClick={() => setTab("kain")}
              className="rounded-xl px-3 py-2 text-sm font-black transition-transform active:scale-[0.99]"
              style={{ background: tab === "kain" ? "#fdf2f8" : "#f8fafc", color: tab === "kain" ? "#ec4899" : "#64748b", border: tab === "kain" ? "1.5px solid #f9a8d4" : "1px solid #e2e8f0" }}
            >
               Kain
            </button>
            <button
              type="button"
              onClick={() => setTab("tarif")}
              className="rounded-xl px-3 py-2 text-sm font-black transition-transform active:scale-[0.99]"
              style={{ background: tab === "tarif" ? "#fdf2f8" : "#f8fafc", color: tab === "tarif" ? "#ec4899" : "#64748b", border: tab === "tarif" ? "1.5px solid #f9a8d4" : "1px solid #e2e8f0" }}
            >
               Tarif
            </button>
          </div>
          <InfoBox title="Data kain dari Gallery Kerudung" subtitle="Sumber data: collection materials. Gallery Produksi hanya melihat stok kain." icon="" />
          {filteredMaterials.length === 0 && <Empty text="Tidak ada data kain/materials" />}
          {filteredMaterials.map((k) => (
            <div key={k.id} className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: "1px solid #fce7f3" }}>
              <div className="font-bold text-lg" style={{ color: "#2d1b69" }}> {k.namaKain}</div>
              <div className="text-xs" style={{ color: "#a855f7" }}>Satuan: {k.satuan || "-"}</div>
              <div className="mt-3 space-y-2">
                {(k.warnas || []).map((w, idx) => (
                  <div key={idx} className="rounded-2xl p-3" style={{ background: "#fdf2f8", border: "1px solid #fce7f3" }}>
                    <div className="font-bold text-sm" style={{ color: "#2d1b69" }}>{w.warna || "-"}</div>
                    <div className="grid grid-cols-3 gap-2 mt-2 text-center">
                      <MiniStat label="Stok" value={fmtQty(w.stok)} bg="#ede9fe" color="#5b21b6" />
                      <MiniStat label="Dipotong" value={fmtQty(w.dipotong)} bg="#fce7f3" color="#be185d" />
                      <MiniStat label="Sisa" value={fmtQty(w.sisa)} bg="#d1fae5" color="#059669" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
