// Data schema, migrations, and import/export formats.
//
// ─── HOW TO EVOLVE THE DATA SAFELY ────────────────────────────────────────────
// 1. Changing the shape of records (rename a field, split a field, new required
//    field…)? Bump SCHEMA_VERSION by 1 and add MIGRATIONS[old] = (data) => newData.
//    A migration receives { settings, expenses, recurring } in the OLD shape and
//    returns them in the NEW shape.
// 2. NEVER edit or delete an existing migration. Old backups are replayed through
//    every step in order (1→2→3…), which is what lets the latest app import a
//    backup made by any earlier version.
// 3. Just adding an OPTIONAL field? No migration needed: give it a default in the
//    normalize* functions below. Unknown fields are preserved, so data written by
//    a newer version survives a round-trip through an older one where possible.
// 4. Backups from a NEWER schema than the app understands are refused with a
//    clear message (update the app first) rather than imported half-way.
// ──────────────────────────────────────────────────────────────────────────────

import { isIsoDate, round2, hash, uid, todayIso } from './util.js';
import { defaultSmsSettings, normalizeSmsSettings } from './sms-rules.js';

export const SCHEMA_VERSION = 2;
export const BACKUP_FORMAT = 'expense-manager-backup';

export const PALETTE = ['#e07a5f', '#3d85c6', '#2a9d8f', '#e9b44c', '#9b5de5', '#ef476f', '#06a77d', '#f4a261', '#577590', '#c08497', '#8d99ae', '#6a994e', '#bc6c25', '#4361ee'];
export const DEFAULT_METHODS = ['UPI', 'Cash', 'Debit card', 'Credit card', 'Net banking', 'Other'];
// `excluded: true` = not counted as spending (kept out of Spent, budget and charts).
export const EXCLUDED_DEFAULTS = [
  { name: 'Transfers', color: '#7d8597', excluded: true },
  { name: 'Investments', color: '#2d6a4f', excluded: true },
];
export const DEFAULT_CATEGORIES = ['Food & dining', 'Groceries', 'Transport', 'Rent & housing', 'Bills & utilities', 'Shopping', 'Health', 'Entertainment', 'Travel', 'Education', 'Personal care', 'Subscriptions']
  .map((name, i) => ({ name, color: PALETTE[i % PALETTE.length] }))
  .concat(EXCLUDED_DEFAULTS, [{ name: 'Other', color: PALETTE[12] }]);
export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'];

export function defaultSettings() {
  return { currency: 'INR', budget: 0, categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })), methods: DEFAULT_METHODS.slice(), sms: defaultSmsSettings() };
}

// ─── Migrations ──────────────────────────────────────────────────────────────
// MIGRATIONS[n] upgrades data from schema n to n+1.
const MIGRATIONS = {
  // v1 → v2 (app 2.1.0): "not counted as spending" categories + keywords to detect them.
  1: (d) => {
    if (!d.settings || typeof d.settings !== 'object') return d;
    const s = { ...d.settings };
    if (Array.isArray(s.categories) && s.categories.length) {
      const cats = s.categories.slice();
      const add = (c) => { if (!cats.some((x) => x && x.name === c.name)) cats.push(c); };
      add({ name: 'Transfers', color: '#7d8597', excluded: true });
      add({ name: 'Investments', color: '#2d6a4f', excluded: true });
      s.categories = cats;
    }
    if (s.sms && Array.isArray(s.sms.rules)) {
      const have = new Set(s.sms.rules.map((r) => r && r.k));
      const v2 = [
        ...['nach', 'mutual fund', 'mutual funds', 'sip', 'zerodha', 'groww', 'upstox', 'kuvera', 'smallcase', 'angel one', 'paytm money', 'et money', 'indian clearing', 'iccl', 'nse clearing', 'bse star', 'mf utilities', 'cams', 'kfintech', 'ppf', 'nps', 'sukanya', 'recurring deposit', 'fixed deposit'].map((k) => ({ k, c: 'Investments' })),
        ...['self transfer', 'own account', 'cred', 'cred club', 'credit card bill', 'card bill payment', 'cc bill', 'add money', 'wallet top up', 'wallet load'].map((k) => ({ k, c: 'Transfers' })),
      ];
      s.sms = { ...s.sms, rules: s.sms.rules.concat(v2.filter((r) => !have.has(r.k))) };
    }
    return { ...d, settings: s };
  },
  // Next change: 2: (d) => ({ ...d, ... }),
};

export function migrate(data, fromVersion) {
  const from = Number(fromVersion) || 1;
  if (from > SCHEMA_VERSION) {
    throw new Error(`This file was made by a newer version of the app (data v${from}). Update the app, then import again.`);
  }
  let d = data;
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`Missing upgrade step v${v} → v${v + 1}.`);
    d = step(d);
  }
  return d;
}

// ─── Normalizers (tolerant: fill defaults, keep unknown fields) ───────────────
const str = (v, max = 200) => (v == null ? '' : String(v)).trim().slice(0, max);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function normalizeExpense(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const amount = round2(raw.amount);
  if (!(amount > 0) || !isIsoDate(raw.date)) return null;
  const now = Date.now();
  return {
    ...raw,
    id: str(raw.id, 120) || uid('e'),
    amount,
    date: raw.date,
    category: str(raw.category, 40) || 'Other',
    method: str(raw.method, 40) || 'Other',
    note: str(raw.note, 120),
    recurringId: raw.recurringId ? String(raw.recurringId) : null,
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now),
  };
}

export function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const amount = round2(raw.amount);
  if (!(amount > 0) || !isIsoDate(raw.startDate)) return null;
  const now = Date.now();
  return {
    ...raw,
    id: str(raw.id, 120) || uid('r'),
    amount,
    category: str(raw.category, 40) || 'Other',
    method: str(raw.method, 40) || 'Other',
    note: str(raw.note, 120),
    frequency: FREQUENCIES.includes(raw.frequency) ? raw.frequency : 'monthly',
    interval: Math.min(365, Math.max(1, Math.floor(num(raw.interval, 1)))),
    startDate: raw.startDate,
    endDate: isIsoDate(raw.endDate) ? raw.endDate : null,
    active: raw.active !== false,
    lastGenerated: isIsoDate(raw.lastGenerated) ? raw.lastGenerated : null,
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now),
  };
}

export function normalizeSettings(raw) {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const cats = Array.isArray(raw.categories)
    ? raw.categories.filter((c) => c && str(c.name, 40)).map((c, i) => ({ ...c, name: str(c.name, 40), color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : PALETTE[i % PALETTE.length], excluded: c.excluded === true }))
    : [];
  const methods = Array.isArray(raw.methods) ? raw.methods.map((m) => str(m, 40)).filter(Boolean) : [];
  return {
    ...raw,
    currency: /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : d.currency,
    budget: Math.max(0, round2(num(raw.budget, 0))),
    categories: cats.length ? cats : d.categories,
    methods: methods.length ? methods : d.methods,
    sms: normalizeSmsSettings(raw.sms), // optional (added in app 1.1.0) — no migration needed
  };
}

// ─── Backup (JSON) ───────────────────────────────────────────────────────────
export function buildBackup({ settings, expenses, recurring }) {
  return {
    format: BACKUP_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    appVersion: self.APP_VERSION || 'unknown',
    exportedAt: new Date().toISOString(),
    counts: { expenses: expenses.length, recurring: recurring.length },
    data: { settings, expenses, recurring },
  };
}

/**
 * Parse a backup (.json) or spreadsheet (.csv) file into normalized data.
 * Returns { source, fileSchema, appVersion, exportedAt, settings, expenses, recurring, skipped }.
 * Throws Error with a user-friendly message on unusable files.
 */
export function parseImportText(text, filename = '') {
  const clean = String(text || '').replace(/^﻿/, '').trim();
  if (!clean) throw new Error('The file is empty.');
  const looksJson = clean.startsWith('{') || /\.json$/i.test(filename);
  return looksJson ? parseBackup(clean) : parseCsv(clean);
}

function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('This file isn’t a valid backup (couldn’t read JSON).'); }
  if (!obj || obj.format !== BACKUP_FORMAT || !obj.data) throw new Error('This JSON file isn’t an Expense Manager backup.');
  const fileSchema = Number(obj.schemaVersion) || 1;
  const migrated = migrate(obj.data, fileSchema);
  const expRaw = Array.isArray(migrated.expenses) ? migrated.expenses : [];
  const recRaw = Array.isArray(migrated.recurring) ? migrated.recurring : [];
  const expenses = expRaw.map(normalizeExpense).filter(Boolean);
  const recurring = recRaw.map(normalizeRule).filter(Boolean);
  return {
    source: 'backup',
    fileSchema,
    appVersion: obj.appVersion || 'unknown',
    exportedAt: obj.exportedAt || null,
    settings: migrated.settings ? normalizeSettings(migrated.settings) : null,
    expenses,
    recurring,
    skipped: (expRaw.length - expenses.length) + (recRaw.length - recurring.length),
  };
}

// ─── CSV (one spreadsheet: expenses + recurring payments) ─────────────────────
// Columns are matched by name on import, so adding columns later is safe.
const FREQ_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };
const CSV_HEADER = 'Type,Date,Category,Amount,Currency,Paid with,Note,Recurring payment,Repeats,Every,Ends,Status,Last added,Id';

export function toCSV(expenses, currency, rules = []) {
  const name = Object.fromEntries(rules.map((r) => [r.id, r.note || r.category]));
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const exp = expenses.slice().sort((a, b) => a.date.localeCompare(b.date)).map((e) =>
    ['Expense', e.date, q(e.category), e.amount, currency, q(e.method), q(e.note), q(e.recurringId ? (name[e.recurringId] || 'Yes') : ''), '', '', '', '', '', q(e.id)].join(','));
  const rec = rules.map((r) =>
    ['Recurring', r.startDate, q(r.category), r.amount, currency, q(r.method), q(r.note), '', FREQ_LABEL[r.frequency], r.interval, r.endDate || '', r.active ? 'Active' : 'Paused', r.lastGenerated || '', q(r.id)].join(','));
  return '﻿' + [CSV_HEADER, ...exp, ...rec].join('\n');
}

function csvRows(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// Accepts dates as YYYY-MM-DD, DD/MM/YYYY or DD-MM-YYYY (Indian order).
function csvDate(s) {
  s = String(s || '').trim();
  if (isIsoDate(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (isIsoDate(iso)) return iso;
  }
  return null;
}

function parseCsv(text) {
  const rows = csvRows(text);
  if (rows.length < 2) throw new Error('The CSV file has no rows to import.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => header.findIndex((h) => names.includes(h));
  const I = {
    type: col('type'), date: col('date', 'first payment', 'start date'), amt: col('amount'), cat: col('category'),
    method: col('paid with', 'method', 'payment method'), note: col('note', 'notes', 'description', 'name'),
    freq: col('repeats', 'frequency'), every: col('every', 'interval'), end: col('ends', 'end date'),
    status: col('status'), last: col('last added', 'last generated'), id: col('id'),
  };
  if (I.date < 0 || I.amt < 0) throw new Error('The CSV needs at least “Date” and “Amount” columns.');
  const expenses = [], recurring = [], seen = {};
  let skipped = 0;
  rows.slice(1).forEach((r) => {
    const get = (k) => (I[k] >= 0 ? String(r[I[k]] ?? '').trim() : '');
    const amount = round2(get('amt').replace(/[^\d.]/g, ''));
    const date = csvDate(get('date'));
    const category = get('cat') || 'Other', method = get('method') || 'Other', note = get('note');
    if (/recurr/i.test(get('type'))) {
      const freq = get('freq').toLowerCase();
      const rule = normalizeRule({
        id: get('id') || 'csvr-' + hash([note, amount, date, freq].join('|')),
        note, amount, category, method, startDate: date,
        frequency: FREQUENCIES.includes(freq) ? freq : 'monthly', interval: Number(get('every')) || 1,
        endDate: csvDate(get('end')), active: !/paus/i.test(get('status')), lastGenerated: csvDate(get('last')),
      });
      if (rule) recurring.push(rule); else skipped++;
      return;
    }
    if (!date || !(amount > 0)) { skipped++; return; }
    // No Id column (older files / hand-made sheets): derive one from the row so
    // importing the same file twice doesn't create duplicates.
    const key = [date, category, amount, method, note].join('|');
    seen[key] = (seen[key] || 0) + 1;
    const id = get('id') || 'csv-' + hash(key + '#' + seen[key]);
    const e = normalizeExpense({ id, date, amount, category, method, note, recurringId: id.startsWith('rec:') ? id.split(':')[1] : null });
    if (e) expenses.push(e); else skipped++;
  });
  if (!expenses.length && !recurring.length) throw new Error('No valid rows found in the CSV (check the Date and Amount columns).');
  return { source: 'csv', fileSchema: null, appVersion: null, exportedAt: null, settings: null, expenses, recurring, skipped };
}

export { todayIso };
