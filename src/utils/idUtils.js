export function safeDocId(value, fallback = "doc") {
  const raw = String(value || "").trim();
  const cleaned = raw
    .replace(/[\/\\#?[\]*]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || `${fallback}-${Date.now()}`;
}

export function safeFileName(value) {
  return String(value || "file")
    .trim()
    .replace(/[\/\\#?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "file";
}
