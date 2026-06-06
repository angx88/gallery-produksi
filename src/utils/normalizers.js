export function normalizeTextKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function normalizeCompactKey(value) {
  return normalizeTextKey(value).replace(/[^a-z0-9]+/g, "");
}

export function normalizeKey(value) {
  return normalizeTextKey(value);
}

export function normalizeInvoice(value) {
  return String(value || "").trim().toUpperCase();
}
