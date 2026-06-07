export function normalizeSetorHistory(entry) {
  const raw =
    entry?.setorHistory ||
    entry?.setor_history ||
    entry?.historySetor ||
    entry?.history_setor ||
    [];

  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => ({
      ...item,
      qty: Number(item?.qty || item?.jumlah || item?.qtySetor || 0),
      tanggal: item?.tanggal || item?.date || item?.createdAt || "",
      note: item?.note || item?.catatan || "",
    }))
    .filter((item) => Number(item.qty || 0) > 0);
}
