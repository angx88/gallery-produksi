export function normText(value) {
  return String(value || "").trim().toLowerCase();
}

export function sameProcess(a, b) {
  return normText(a) === normText(b);
}

export function isPotongProcess(process) {
  return sameProcess(process, "Potong");
}

export function isJahitProcess(process) {
  return sameProcess(process, "Jahit");
}

export function isQcProcess(process) {
  return sameProcess(process, "Pengemasan QC");
}

export function entryProcessRequiresOrder(process) {
  return isJahitProcess(process);
}

export function entryProcessWarnsWithoutOrder(process) {
  return isPotongProcess(process) || isQcProcess(process);
}