import React from "react";

export default function TarifTab(props) {
  const {
    tab,
    setTab,
    setModal,
    workRates,
    rateForm,
    setRateForm,
    deleteRate,
    displayProductTypeName,
    displayModelName,
    displayProcessName,
    money,
    Card,
    Button,
    Empty,
    UiButton,
  } = props;

  return (
    <>
      {tab === "tarif" && (
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
          <Button onClick={() => setModal("tarif")} className="w-full" style={{ background: "linear-gradient(135deg,#a855f7,#ec4899)" }}>
             + Tambah Tarif Borongan
          </Button>
          {workRates.map((r) => (
            <div key={r.id} className="rounded-3xl bg-white p-4 shadow-sm" style={{ border: "1px solid #fce7f3" }}>
              <div className="flex justify-between items-start gap-3">
                <div>
                  <div className="font-bold" style={{ color: "#2d1b69" }}>{r.productType}{r.model ? `  ${r.model}` : ""}</div>
                  <div className="text-xs" style={{ color: "#a855f7" }}>{r.process}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold" style={{ color: "#ec4899" }}>{money(r.rate)} / pcs</div>
                  <button onClick={() => deleteRate(r.id)} className="mt-1 text-xs font-bold text-rose-500">Hapus</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
