// Small, dependency-free helpers shared across modules.

export const pad = (n) => String(n).padStart(2, '0');
export const ymOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1);
export const isoDate = (d) => ymOf(d) + '-' + pad(d.getDate());
export const todayIso = () => isoDate(new Date());
export const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parseIso(s));

export function parseIso(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(iso, n) {
  const d = parseIso(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
export function daysIn(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
export function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  return ymOf(new Date(y, m - 1 + delta, 1));
}
export function monthName(ym, opts = { month: 'long', year: 'numeric' }) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', opts);
}
export function prettyDate(iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  return parseIso(iso).toLocaleDateString('en-IN', opts);
}
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function uid(prefix = 'e') {
  const rnd = (crypto.getRandomValues ? crypto.getRandomValues(new Uint32Array(2)) : [Math.random() * 2 ** 32, Math.random() * 2 ** 32]);
  return prefix + '-' + Date.now().toString(36) + '-' + Array.from(rnd, (n) => (n >>> 0).toString(36)).join('');
}
export function round2(n) { return Math.round(Number(n) * 100) / 100; }
export function parseAmount(s) {
  const n = Number(String(s).replace(/[,\s]/g, '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? round2(n) : NaN;
}
// Stable, short string hash (for idempotent ids on CSV import).
export function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
