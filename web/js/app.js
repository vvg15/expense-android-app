import { openDB, getAll, getAllMeta, writeBatch, wipeEverything } from './store.js';
import {
  SCHEMA_VERSION, PALETTE, defaultSettings, migrate, normalizeExpense, normalizeRule, normalizeSettings,
  buildBackup, parseImportText, toCSV, netAmount, refundedOf,
} from './schema.js';
import { generateDue, nextDue, describe, monthlyEquivalent, occurrences, matchRecurring, nearestOccurrence, expenseIdFor } from './recurring.js';
import { parseSmsBackup, analyze as analyzeSms, merchantKey, looksLikePerson, matchRefund } from './sms.js';
import { createTrends } from './trends.js';
import { defaultSmsSettings } from './sms-rules.js';
import { isNative, native, onNative } from './native.js';
import { pad, ymOf, isoDate, todayIso, parseIso, daysIn, shiftMonth, monthName, prettyDate, esc, uid, parseAmount, addDays } from './util.js';

const APP_VERSION = self.APP_VERSION || 'dev';
const GREY = '#9a9d94';
const CURRENCIES = [
  ['INR', 'Indian rupee', 'en-IN'], ['USD', 'US dollar', 'en-US'], ['EUR', 'Euro', 'en-IE'], ['GBP', 'British pound', 'en-GB'],
  ['AED', 'UAE dirham', 'en-AE'], ['SGD', 'Singapore dollar', 'en-SG'], ['AUD', 'Australian dollar', 'en-AU'],
  ['CAD', 'Canadian dollar', 'en-CA'], ['JPY', 'Japanese yen', 'ja-JP'], ['SAR', 'Saudi riyal', 'en-SA'],
];

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  settings: defaultSettings(),
  expenses: [],
  rules: [],
  meta: {},
  month: ymOf(new Date()),
  filterCat: 'all',
  search: '',
  view: 'home',
  editingId: null,
  editingRuleId: null,
  selCat: null,
  selRuleCat: null,
  lastDay: todayIso(),
};
let swReg = null;

const $ = (id) => document.getElementById(id);

// ─── Formatting ──────────────────────────────────────────────────────────────
const fmtCache = {};
function locale() { return (CURRENCIES.find((c) => c[0] === state.settings.currency) || CURRENCIES[0])[2]; }
function money(n, compact) {
  const frac = !compact && Math.round(Math.abs(n || 0) * 100) % 100 !== 0;
  const key = state.settings.currency + (compact ? 'c' : frac ? 'f' : '');
  if (!fmtCache[key]) {
    try {
      fmtCache[key] = new Intl.NumberFormat(locale(), compact
        ? { style: 'currency', currency: state.settings.currency, notation: 'compact', maximumFractionDigits: 1 }
        : { style: 'currency', currency: state.settings.currency, minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: frac ? 2 : 0 });
    } catch { fmtCache[key] = { format: (v) => `${state.settings.currency} ${Number(v).toFixed(2)}` }; }
  }
  return fmtCache[key].format(n || 0);
}
function resetFormats() { for (const k in fmtCache) delete fmtCache[k]; }
function symbolFor(code, loc) {
  try { return new Intl.NumberFormat(loc, { style: 'currency', currency: code }).formatToParts(0).find((p) => p.type === 'currency').value; }
  catch { return code; }
}
const currencySymbol = () => symbolFor(state.settings.currency, locale());
const catColor = (name) => (state.settings.categories.find((c) => c.name === name) || {}).color || GREY;
// What an expense really cost (after refunds). Every total uses this.
const amt = (e) => netAmount(e);
const sum = (list) => list.reduce((a, e) => a + amt(e), 0);
// Categories marked "not counted as spending" (Transfers, Investments, …) stay out of totals.
const isExcluded = (name) => !!(state.settings.categories.find((c) => c.name === name) || {}).excluded;
const spendOf = (list) => list.filter((e) => !isExcluded(e.category));
const hasCategory = (name) => state.settings.categories.some((c) => c.name === name);
const ruleById = (id) => state.rules.find((r) => r.id === id);
const ruleName = (r) => r.note || r.category;

/** Short message at the bottom. action = { label, run } adds a button (e.g. Undo). */
function toast(msg, action = null) {
  const t = $('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), action ? 5000 : 2600);
}

// ─── Category icons ──────────────────────────────────────────────────────────
const ICON = {
  food: 'M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 1-3 4-3 7h3v11',
  grocery: 'M3 4h2l2.4 11h10.2L20 7H6.2M9 20h.01M17 20h.01',
  transport: 'M5 16v-5l2-5h10l2 5v5M5 16h14M7 19v-3M17 19v-3M8 13h.01M16 13h.01',
  home: 'M3 11l9-7 9 7M5 10v10h14V10M10 20v-5h4v5',
  bill: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  shop: 'M6 7h12l-1 13H7L6 7zM9 7a3 3 0 0 1 6 0',
  health: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  fun: 'M4 6h16v12H4zM10 9l5 3-5 3z',
  travel: 'M2 16l20-6-4-2-6 2-6-5-2 1 4 6-4 1-2-1-1 1z',
  edu: 'M3 8l9-4 9 4-9 4-9-4zM7 10v5c3 2 7 2 10 0v-5',
  care: 'M6 3v6a6 6 0 0 0 12 0V3M12 15v6M9 21h6',
  subs: 'M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2M20 4v5h-5M4 20v-5h5',
  transfer: 'M4 8h14l-4-4M20 16H6l4 4',
  invest: 'M4 19h16M6 15l4-4 3 3 6-7M15 7h4v4',
  gift: 'M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7c-2-4-6-3-5 0M12 7c2-4 6-3 5 0',
  cash: 'M3 7h18v10H3zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  other: 'M5 12h.01M12 12h.01M19 12h.01',
};
const ICON_WORDS = [
  [/food|dining|restaurant|eat|meal|snack|coffee/i, 'food'], [/grocer|vegetable|kirana|provision/i, 'grocery'],
  [/transport|fuel|petrol|cab|commute|auto|car|bike|vehicle/i, 'transport'], [/rent|hous|home/i, 'home'],
  [/bill|utilit|electric|phone|mobile|internet|recharge/i, 'bill'], [/shop|cloth|fashion/i, 'shop'],
  [/health|medic|doctor|pharm|fitness|gym/i, 'health'], [/entertain|movie|fun|game|leisure/i, 'fun'],
  [/travel|trip|flight|holiday|vacation/i, 'travel'], [/educat|school|course|book|study|tuition/i, 'edu'],
  [/personal|care|salon|beauty|groom/i, 'care'], [/subscri|membership|stream/i, 'subs'], [/transfer/i, 'transfer'],
  [/invest|saving|sip|mutual|stock/i, 'invest'], [/gift|donat|charity/i, 'gift'], [/cash|atm/i, 'cash'], [/^other$/i, 'other'],
];
function iconKey(name) { for (const [rx, k] of ICON_WORDS) if (rx.test(name || '')) return k; return null; }
/** Coloured tile with the category's icon (or its first letter for custom categories). */
function catIcon(name, size = '', extra = '') {
  const k = iconKey(name);
  const inner = k ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[k]}"/></svg>` : esc((name || '?').slice(0, 1).toUpperCase());
  return `<span class="ic ${size}" style="--c:${catColor(name)}" aria-hidden="true">${inner}${extra}</span>`;
}

// ─── Generic dialog ──────────────────────────────────────────────────────────
function dialog({ title, html = '', actions = [{ label: 'OK', value: true, kind: 'primary' }], input = null, onBody = null }) {
  return new Promise((resolve) => {
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML = html + (input ? `<input id="dlgInput" autocomplete="off" placeholder="${esc(input.placeholder || '')}">` : '');
    const box = $('dlgActions');
    box.innerHTML = '<span class="spacer"></span>';
    const done = (value) => {
      const inputValue = input ? $('dlgInput').value : undefined;
      $('dialog').hidden = true;
      document.removeEventListener('keydown', onKey);
      resolve({ value, inputValue });
    };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn ' + (a.kind || 'ghost'); b.textContent = a.label;
      b.onclick = () => done(a.value);
      box.appendChild(b);
    });
    $('dialog').onclick = (e) => { if (e.target === $('dialog')) done(null); };
    $('dialog').hidden = false;
    if (onBody) onBody($('dlgBody'), done);
    if (input) setTimeout(() => $('dlgInput').focus(), 50);
  });
}

// ─── Persistence helpers ─────────────────────────────────────────────────────
async function persist(batch) {
  try { await writeBatch(batch); return true; }
  catch (e) {
    console.error(e);
    const full = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
    await dialog({ title: 'Couldn’t save', html: `<p>${full ? 'Your phone is out of storage space for this app.' : 'Something went wrong while saving.'}</p><p class="muted small">${esc(e && e.message || '')}</p>` });
    return false;
  }
}
async function saveSettings() {
  if (await persist({ meta: { settings: state.settings } })) { resetFormats(); renderAll(); }
}
function upsertLocal(listName, items) {
  const map = new Map(state[listName].map((x) => [x.id, x]));
  items.forEach((x) => map.set(x.id, x));
  state[listName] = [...map.values()];
}

/** Add any due recurring payments. Returns how many were added. */
async function runRecurring() {
  const { expenses, rules } = generateDue(state.rules);
  if (!rules.length) return 0;
  // Don't resurrect expenses the user has already got under the same id.
  const have = new Set(state.expenses.map((e) => e.id));
  const fresh = expenses.filter((e) => !have.has(e.id));
  if (!(await persist({ expenses: fresh, recurring: rules }))) return 0;
  upsertLocal('expenses', fresh);
  upsertLocal('rules', rules);
  addMissingCategories(fresh.map((e) => e.category));
  return fresh.length;
}

function addMissingCategories(names) {
  const have = new Set(state.settings.categories.map((c) => c.name));
  const missing = [...new Set(names)].filter((n) => n && !have.has(n));
  if (!missing.length) return false;
  const used = new Set(state.settings.categories.map((c) => c.color));
  missing.forEach((name, i) => {
    const color = PALETTE.find((p) => !used.has(p)) || PALETTE[(state.settings.categories.length + i) % PALETTE.length];
    used.add(color);
    state.settings.categories.push({ name, color });
  });
  writeBatch({ meta: { settings: state.settings } }).catch(console.error);
  return true;
}

// ─── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    await openDB();
    const [expenses, rules, meta] = await Promise.all([getAll('expenses'), getAll('recurring'), getAllMeta()]);
    state.meta = meta;
    const stored = Number(meta.schemaVersion) || 0;

    if (!stored) {
      // First launch on this device.
      state.settings = normalizeSettings(meta.settings);
      state.expenses = expenses.map(normalizeExpense).filter(Boolean);
      state.rules = rules.map(normalizeRule).filter(Boolean);
      await writeBatch({ meta: { schemaVersion: SCHEMA_VERSION, settings: state.settings, installedAt: Date.now() } });
      state.meta.schemaVersion = SCHEMA_VERSION;
    } else if (stored < SCHEMA_VERSION) {
      // App was updated and the data format changed: upgrade data in place,
      // keeping a safety copy of the old data inside the database.
      const old = { settings: meta.settings, expenses, recurring: rules };
      const up = migrate(old, stored);
      state.settings = normalizeSettings(up.settings);
      state.expenses = (up.expenses || []).map(normalizeExpense).filter(Boolean);
      state.rules = (up.recurring || []).map(normalizeRule).filter(Boolean);
      await writeBatch({
        clear: true, expenses: state.expenses, recurring: state.rules,
        meta: { schemaVersion: SCHEMA_VERSION, settings: state.settings, [`preUpgradeBackup_v${stored}`]: { schemaVersion: stored, savedAt: Date.now(), data: old } },
      });
    } else {
      state.settings = normalizeSettings(meta.settings);
      state.expenses = expenses.map(normalizeExpense).filter(Boolean);
      state.rules = rules.map(normalizeRule).filter(Boolean);
    }

    // 2.2.0: refund SMS are recognised on their own now, so drop the old default
    // "skip messages containing refund / reversal" words (a user's own list is kept).
    const ign = state.settings.sms && state.settings.sms.ignoreWords;
    if (!meta.ignoreFix22) {
      if (ign && ign.join(',') === 'refund,cashback,reversed,reversal') state.settings.sms.ignoreWords = ['cashback'];
      await writeBatch({ meta: { settings: state.settings, ignoreFix22: true } });
      state.meta.ignoreFix22 = true;
    }
    applyTheme(state.settings.theme);

    const added = await runRecurring();
    const quickAdd = location.hash === '#add';
    if (quickAdd) history.replaceState(null, '', '#home');
    route();
    renderAll();
    if (quickAdd) openExpense(null);
    if (added) toast(`Added ${added} recurring payment${added === 1 ? '' : 's'}`);
    setTimeout(() => checkBudgetAlerts(), added ? 2800 : 600);
    if (isNative) setTimeout(() => smsStartupCheck(), 500);
    if (isNative) setTimeout(() => runAutoBackup().catch(console.error), 1500);
  } catch (e) {
    console.error(e);
    document.querySelector('.app').innerHTML = `<div class="panel" style="margin-top:40px"><h2>Couldn’t open your data</h2><p class="small" style="margin-top:8px">${esc(e.message || e)}</p><p class="muted small" style="margin-top:8px">If you’re in a private/incognito window, open the app normally instead.</p></div>`;
    return;
  }

  // Ask the browser not to auto-clear our storage.
  if (!isNative) { try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {} }

  // New day while the app stayed open → add recurring payments, refresh "today".
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (swReg) swReg.update().catch(() => {});
    if (isNative) {
      // Back from the background (or from Android settings): re-check SMS, at most every 30 min
      // unless the permission was just switched on.
      const st = native.smsState();
      if (st === 'granted' && (state.smsLastState !== 'granted' || Date.now() - (state.smsLastCheck || 0) > 30 * 60 * 1000)) setTimeout(() => smsStartupCheck(), 300);
      runAutoBackup().catch(console.error);
      state.smsLastState = st;
      if (state.view === 'settings') renderSettings();
      if (state.view === 'sms') renderSms();
      if (state.view === 'home') { renderSmsIntro(); renderSmsReview(); }
    }
    if (todayIso() !== state.lastDay) {
      const wasCurrent = state.month === ymOf(parseIso(state.lastDay));
      state.lastDay = todayIso();
      if (wasCurrent) state.month = ymOf(new Date());
      const added = await runRecurring();
      renderAll();
      if (added) toast(`Added ${added} recurring payment${added === 1 ? '' : 's'}`);
    }
  });

  registerSW();
}

// ─── Service worker / updates ────────────────────────────────────────────────
function registerSW() {
  if (isNative) return; // the Android app is updated by Google Play
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    swReg = reg;
    reg.update().catch(() => {});
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(); });
    });
  }).catch(console.error);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
}
function showUpdate() { $('updateBar').hidden = false; }
onNative('updateReady', () => showUpdate());
onNative('updateStatus', (st) => {
  const msg = { none: `You’re on the latest version (${APP_VERSION})`, available: 'Downloading the update in the background…', downloading: 'The update is downloading…', unavailable: 'Updates come from Google Play. This copy wasn’t installed from Play.', declined: 'Update skipped', error: 'Couldn’t update right now. Try again later.' }[st];
  if (msg) toast(msg);
});
$('updateBtn').addEventListener('click', () => {
  if (isNative) { native.completeUpdate(); return; }
  if (swReg && swReg.waiting) swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
  else location.reload();
});
$('checkUpdate').addEventListener('click', async () => {
  if (isNative) { toast('Checking Google Play…'); native.checkUpdate(); return; }
  if (!swReg) { toast('Updates work once the app is installed from its web address'); return; }
  try {
    await swReg.update();
    setTimeout(() => { if (swReg.waiting || swReg.installing) showUpdate(); else toast(`You’re on the latest version (${APP_VERSION})`); }, 1500);
  } catch { toast('Couldn’t check for updates — are you offline?'); }
});

// ─── Routing ─────────────────────────────────────────────────────────────────
function route() {
  const [v0, sub] = (location.hash || '#home').slice(1).split('/');
  const v = v0 === 'trends' ? 'insights' : v0;
  const VIEWS = ['home', 'insights', 'recurring', 'settings', 'sms', 'sort', 'search'];
  state.view = VIEWS.includes(v) ? v : 'home';
  state.setSec = state.view === 'settings' ? (sub || '') : '';
  VIEWS.forEach((n) => ($('view-' + n).hidden = n !== state.view));
  const tab = { sms: 'settings', sort: 'home', search: 'home' }[state.view] || state.view;
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (state.view !== 'sort') $('sortBar').hidden = true;
  updateSmsBar();
  closeSwipes();
  $('fab').setAttribute('aria-label', state.view === 'recurring' ? 'Add recurring payment' : 'Add expense');
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => { route(); renderAll(); });

// ─── Rendering ───────────────────────────────────────────────────────────────
function renderAll() {
  document.querySelectorAll('.cur-sym').forEach((el) => (el.textContent = currencySymbol()));
  if (state.view === 'home') renderHome();
  if (state.view === 'recurring') renderRecurring();
  if (state.view === 'settings') renderSettings();
  if (state.view === 'sms') renderSms();
  if (state.view === 'insights') { renderInsights(); trends.render(); }
  if (state.view === 'sort') renderSort();
  if (state.view === 'search') renderSearch();
}

const monthExpenses = (ym) => state.expenses.filter((e) => e.date.startsWith(ym));

function renderHome() {
  $('monthLabel').textContent = monthName(state.month);
  renderSmsIntro(); renderSmsReview();
  renderBackupNudge(); renderHero(); renderCategories(); renderDaily(); renderList();
}

function daysSince(ts) { return ts ? Math.floor((Date.now() - ts) / 86400000) : Infinity; }

function renderBackupNudge() {
  const el = $('backupNudge');
  const ab = state.meta.autoBackup || {};
  const snoozed = (state.meta.backupSnoozeUntil || 0) > Date.now();
  let msg = '';
  if (isNative && ab.on && ab.lastError && !snoozed) {
    msg = 'Automatic backup couldn’t be saved. Choose the backup folder again in Settings.';
  } else if (!snoozed && state.meta.backupReminders !== false && !autoBackupHealthy() && state.expenses.length >= 10) {
    const d = daysSince(state.meta.lastBackupAt);
    if (d > 30) msg = `${d === Infinity ? 'You haven’t backed up yet.' : `Last backup was ${d} days ago.`} Your data lives only on this phone.`;
  }
  el.hidden = !msg;
  if (msg) el.innerHTML = `<span>${esc(msg)}</span><span class="nudge-actions"><a class="linkish" href="#settings/backup">${ab.lastError ? 'Fix' : 'Back up'}</a><button class="icon-btn sm" data-action="snooze-backup" aria-label="Hide for 30 days">×</button></span>`;
}

/** Numbers for one month, shared by the Home card and Insights. */
function monthStats(ym) {
  const cur = ymOf(new Date());
  const all = monthExpenses(ym);
  const list = spendOf(all);
  const total = sum(list);
  const dim = daysIn(ym);
  const elapsed = ym === cur ? new Date().getDate() : ym < cur ? dim : 0;
  return { ym, cur, all, list, total, notCounted: sum(all) - total, dim, elapsed, left: dim - elapsed, refunded: all.reduce((a, e) => a + refundedOf(e), 0) };
}

function renderHero() {
  const m = monthStats(state.month);
  const { ym, cur, total, dim, elapsed } = m;
  const budget = state.settings.budget;
  const prevTotal = sum(spendOf(monthExpenses(shiftMonth(ym, -1))));
  const isCur = ym === cur;
  const label = isCur ? 'Spent this month' : ym < cur ? `Spent in ${monthName(ym, { month: 'long' })}` : `${monthName(ym, { month: 'long' })} hasn’t started`;
  let sub, line = '', ring;
  if (budget > 0) {
    const pct = (total / budget) * 100;
    const leftAmt = budget - total;
    sub = `of ${money(budget)} budget${isCur ? ` · ${m.left + 1} day${m.left === 0 ? '' : 's'} left` : ''}`;
    if (isCur) {
      line = leftAmt >= 0
        ? `<a class="hero-line" href="#insights">Safe to spend <b class="num">${money(Math.floor(leftAmt / (m.left + 1)))}/day</b></a>`
        : `<a class="hero-line bad" href="#insights">Over budget by <b class="num">${money(-leftAmt)}</b></a>`;
    } else if (ym < cur) line = `<span class="hero-line">${leftAmt >= 0 ? `Under budget by <b class="num">${money(leftAmt)}</b>` : `Over budget by <b class="num">${money(-leftAmt)}</b>`}</span>`;
    ring = `<div class="ring ${pct > 100 ? 'over' : ''}" style="--p:${Math.min(100, pct).toFixed(1)}" role="img" aria-label="${Math.round(pct)}% of budget used"><div><b class="num">${Math.round(pct)}%</b><small>used</small></div></div>`;
  } else {
    sub = `${m.list.length} expense${m.list.length === 1 ? '' : 's'}`;
    line = `<a class="hero-line" href="#settings/general">Set a monthly budget ›</a>`;
    let d = '—', dl = 'vs last month';
    if (prevTotal > 0) { const p = ((total - prevTotal) / prevTotal) * 100; d = `${p > 0 ? '▲' : '▼'}${Math.abs(p).toFixed(0)}%`; dl = `vs ${monthName(shiftMonth(ym, -1), { month: 'short' })}`; }
    ring = `<div class="ring" style="--p:0"><div><b class="num">${d}</b><small>${esc(dl)}</small></div></div>`;
  }
  if (m.notCounted > 0) sub += ` · ${money(m.notCounted)} not counted`;
  $('hero').innerHTML = `<div class="hero-main"><div class="hero-label">${esc(label)}</div><div class="hero-value num">${money(total)}</div><div class="hero-sub">${sub}</div>${line}</div>${ring}`;

  // Small numbers under the card
  const avg = elapsed ? Math.round(total / elapsed) : 0;
  let pace;
  if (isCur) {
    const projected = Math.round((elapsed ? total / elapsed : 0) * dim);
    pace = `<div class="mini"><div class="label">On pace for</div><div class="value num ${budget > 0 && projected > budget ? 'up' : ''}">${money(projected)}</div><div class="sub">by month end</div></div>`;
  } else pace = `<div class="mini"><div class="label">Expenses</div><div class="value num">${m.list.length}</div><div class="sub">${m.refunded > 0 ? `${money(m.refunded)} refunded` : `in ${dim} days`}</div></div>`;
  let cmp = '—';
  if (prevTotal > 0) { const p = ((total - prevTotal) / prevTotal) * 100; cmp = `<span class="${p > 0 ? 'up' : 'down'}">${p > 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(0)}%</span>`; }
  $('miniStats').innerHTML = `<div class="mini"><div class="label">Daily avg</div><div class="value num">${money(avg)}</div><div class="sub">${elapsed ? `over ${elapsed} day${elapsed === 1 ? '' : 's'}` : '—'}</div></div>
    ${pace}
    <div class="mini"><div class="label">vs ${esc(monthName(shiftMonth(ym, -1), { month: 'short' }))}</div><div class="value num">${cmp}</div><div class="sub num">${money(prevTotal)}</div></div>`;
}

/** Spent per category in a month (net of refunds). */
function byCategory(list) {
  const by = {};
  list.forEach((e) => (by[e.category] = (by[e.category] || 0) + amt(e)));
  return by;
}
const catBudget = (name) => (state.settings.categories.find((c) => c.name === name) || {}).budget || 0;

function budgetLine(name, spent) {
  const b = catBudget(name);
  if (!(b > 0)) return '';
  const pct = (spent / b) * 100;
  const cls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
  const txt = pct >= 100 ? `${money(spent - b)} over` : `${money(b - spent)} left`;
  return `<span class="cb ${cls}"><span class="progress ${cls}"><span style="width:${Math.min(100, pct)}%"></span></span><span class="num">${txt} of ${money(b, true)}</span></span>`;
}

function renderCategories() {
  const all = monthExpenses(state.month);
  if (!all.length) { $('catBreakdown').innerHTML = '<div class="empty">No expenses this month yet.</div>'; return; }
  const by = byCategory(all);
  // Categories with a budget show up even before anything is spent.
  if (state.month === ymOf(new Date())) state.settings.categories.forEach((c) => { if (c.budget > 0 && !c.excluded && !(c.name in by)) by[c.name] = 0; });
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
  const counted = rows.filter(([n]) => !isExcluded(n)), other = rows.filter(([n]) => isExcluded(n));
  const total = counted.reduce((a, r) => a + r[1], 0);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const row = ([name, a], muted) => `
    <button class="cat-row ${state.filterCat === name ? 'active' : ''} ${muted ? 'muted-row' : ''}" data-cat="${esc(name)}">
      ${catIcon(name, 'sm')}
      <span class="cat-name"><span>${esc(name)}</span></span>
      <span class="cat-amt num">${money(a)}${muted || !total ? '' : `<small>${Math.round((a / total) * 100)}%</small>`}</span>
      ${!muted && catBudget(name) > 0 ? budgetLine(name, a) : `<span class="bar"><span style="width:${(a / max) * 100}%;background:${catColor(name)}"></span></span>`}
    </button>`;
  // Donut
  let acc = 0;
  const stops = counted.filter((r) => r[1] > 0).map(([n, a]) => { const s0 = acc; acc += (a / (total || 1)) * 100; return `${catColor(n)} ${s0.toFixed(2)}% ${acc.toFixed(2)}%`; });
  const top = counted[0];
  const overB = counted.filter(([n, a]) => catBudget(n) > 0 && a > catBudget(n)).length;
  let html = total > 0 ? `<div class="donut-wrap">
      <div class="donut" style="background:conic-gradient(${stops.join(',')})" role="img" aria-label="Spending by category"><div><small>${counted.filter((r) => r[1] > 0).length} categor${counted.filter((r) => r[1] > 0).length === 1 ? 'y' : 'ies'}</small><b class="num">${money(total, true)}</b></div></div>
      <div class="donut-side">${top ? `<span>Most on <b>${esc(top[0])}</b></span><span class="num">${money(top[1])} · ${Math.round((top[1] / total) * 100)}%</span>` : ''}${overB ? `<span class="up">${overB} budget${overB === 1 ? '' : 's'} used up</span>` : ''}<span class="muted">Tap a category to see its expenses</span></div>
    </div>` : '';
  html += counted.map((r) => row(r, false)).join('');
  const otherAmt = by.Other || 0, otherCount = all.filter((e) => e.category === 'Other').length;
  if (total && otherAmt / total >= 0.1 && otherCount >= 3) html += `<button class="linkish sort-link" data-action="sort-other">Sort the ${money(otherAmt)} in “Other” by person or shop →</button>`;
  if (other.length) html += `<div class="cat-divider">Not counted as spending</div>` + other.map((r) => row(r, true)).join('');
  $('catBreakdown').innerHTML = html;
}
function renderDaily() {
  const ym = state.month, dim = daysIn(ym), cur = ymOf(new Date());
  const list = spendOf(monthExpenses(ym));
  const days = new Array(dim).fill(0);
  list.forEach((e) => { const d = Number(e.date.slice(8, 10)); if (d >= 1 && d <= dim) days[d - 1] += amt(e); });
  const budget = state.settings.budget, dailyBudget = budget > 0 ? budget / dim : 0;
  const maxDay = Math.max(...days);
  $('dailyHint').textContent = maxDay > 0 ? `Peak ${money(maxDay)} on ${days.indexOf(maxDay) + 1} ${monthName(ym, { month: 'short' })}` : '';
  if (!list.length) { $('dailyChart').innerHTML = '<div class="empty">Your daily spending will show up here.</div>'; return; }

  const W = 620, H = 200, padL = 50, padR = 8, padT = 12, padB = 24, cw = W - padL - padR, ch = H - padT - padB;
  const top = Math.max(maxDay, dailyBudget), yMax = top * 1.12 || 1;
  const step = cw / dim, bw = Math.max(3, step * 0.66);
  const y = (v) => padT + ch - (v / yMax) * ch;
  const todayIdx = ym === cur ? new Date().getDate() - 1 : -1;
  const mon = monthName(ym, { month: 'short' });
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily spending">`;
  [0, 0.5, 1].forEach((t) => {
    const val = top * t, yy = y(val);
    svg += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/><text class="axis" x="${padL - 8}" y="${yy + 4}" text-anchor="end">${esc(money(val, true))}</text>`;
  });
  days.forEach((v, i) => {
    const x = padL + i * step + (step - bw) / 2;
    const future = ym > cur || (ym === cur && i > todayIdx);
    if (v > 0) {
      const h = Math.max(2, (v / yMax) * ch);
      const cls = 'bar-rect' + (i === todayIdx ? ' today' : '') + (dailyBudget && v > dailyBudget ? ' over' : '');
      svg += `<rect class="${cls}" x="${x}" y="${padT + ch - h}" width="${bw}" height="${h}" rx="2"><title>${i + 1} ${esc(mon)}: ${esc(money(v))}</title></rect>`;
    } else if (!future) svg += `<rect class="zero" x="${x}" y="${padT + ch - 2}" width="${bw}" height="2" rx="1"/>`;
    const d = i + 1;
    if (d === 1 || d % 5 === 0) svg += `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${d}</text>`;
  });
  if (dailyBudget) svg += `<line class="budget-line" x1="${padL}" x2="${W - padR}" y1="${y(dailyBudget)}" y2="${y(dailyBudget)}"/>`;
  svg += '</svg>';
  if (dailyBudget) svg += `<div class="legend"><span><i></i>Daily budget (${esc(money(dailyBudget))})</span></div>`;
  $('dailyChart').innerHTML = svg;
}

function renderList() {
  const all = monthExpenses(state.month);
  if (state.filterCat !== 'all' && !all.some((e) => e.category === state.filterCat)) state.filterCat = 'all';
  const rows = all.filter((e) => state.filterCat === 'all' || e.category === state.filterCat)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  $('catFilterBar').innerHTML = state.filterCat !== 'all' ? `<span class="cat-chip">${catIcon(state.filterCat, 'sm')}${esc(state.filterCat)}<button data-action="clear" aria-label="Show all categories">×</button></span>` : '';
  const box = $('txList');
  if (!all.length) {
    box.innerHTML = `<div class="empty">No expenses in ${esc(monthName(state.month))}.<br><br><button class="btn primary" data-action="add">+ Add an expense</button></div>`;
    return;
  }
  let html = dayGroupsHtml(rows);
  html += `<div class="list-foot"><span>${state.filterCat !== 'all' ? `${rows.length} of ${all.length} <button class="linkish" data-action="clear" style="margin-left:6px">Show all</button>` : `${all.length} expense${all.length === 1 ? '' : 's'}`}</span><b class="num">${money(sum(rows))}</b></div>`;
  box.innerHTML = html;
}

/** Expenses grouped under a heading per day, with the day's total. */
function dayGroupsHtml(rows, { sticky = false, swipe = true } = {}) {
  const groups = [];
  rows.forEach((e) => { const g = groups[groups.length - 1]; if (g && g.date === e.date) g.items.push(e); else groups.push({ date: e.date, items: [e] }); });
  const t = todayIso(), yd = addDays(t, -1), y = t.slice(0, 4);
  const label = (d) => {
    const opts = d.slice(0, 4) === y ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
    return d === t ? 'Today' : d === yd ? 'Yesterday' : prettyDate(d, opts) + (d > t ? ' · upcoming' : '');
  };
  return groups.map((g) => `
    <div class="day-group">
      <div class="day-head ${sticky ? 'sticky' : ''}"><span>${esc(label(g.date))}</span><span class="num">${money(sum(spendOf(g.items)))}</span></div>
      ${g.items.map((e) => txHtml(e, false, swipe)).join('')}
    </div>`).join('');
}

function txHtml(e, showDate = false, swipe = false) {
  const refunded = refundedOf(e);
  const meta = [showDate ? esc(prettyDate(e.date, { day: 'numeric', month: 'short', year: e.date.slice(0, 4) === todayIso().slice(0, 4) ? undefined : 'numeric' })) : '', e.note ? esc(e.category) : '', esc(e.method), e.recurringId ? (e.smsKey ? 'Recurring · from SMS' : 'Recurring') : '', isExcluded(e.category) ? 'not counted' : ''].filter(Boolean).join(' · ');
  const right = refunded > 0
    ? `${money(amt(e))}<span class="refund-tag">${amt(e) === 0 ? 'Refunded' : `${money(refunded)} refunded`}</span>`
    : money(e.amount);
  const row = `<button class="tx" data-id="${esc(e.id)}">
    ${catIcon(e.category, '', e.recurringId ? '<span class="rec">↻</span>' : '')}
    <span class="tx-main"><div class="tx-title">${esc(e.note || e.category)}</div><div class="tx-meta">${meta}</div></span>
    <span class="tx-amt num">${right}</span>
  </button>`;
  if (!swipe) return row;
  return `<div class="swipe" data-sid="${esc(e.id)}"><div class="swipe-actions"><button type="button" data-sw="edit">Edit</button><button type="button" data-sw="del">Delete</button></div>${row}</div>`;
}

function renderRecurring() {
  const rules = state.rules.slice().sort((a, b) => (b.active - a.active) || (nextDue(a) || '9999').localeCompare(nextDue(b) || '9999'));
  const active = rules.filter((r) => r.active && nextDue(r));
  const monthly = active.reduce((a, r) => a + monthlyEquivalent(r), 0);
  const upcoming = active.map((r) => ({ r, d: nextDue(r) })).filter((x) => x.d <= addDays(todayIso(), 30));
  $('ruleSummary').innerHTML = `
    <div class="card"><div class="label">Per month</div><div class="value num">${money(Math.round(monthly))}</div><div class="sub">${active.length} active payment${active.length === 1 ? '' : 's'}</div></div>
    <div class="card"><div class="label">Next 30 days</div><div class="value num">${money(sum(upcoming.map((x) => x.r)))}</div><div class="sub">${upcoming.length} due</div></div>`;

  if (!rules.length) {
    $('ruleList').innerHTML = '<div class="empty">No recurring payments yet.<br><br><button class="btn primary" data-action="add-rule">+ Add recurring payment</button></div>';
    return;
  }
  $('ruleList').innerHTML = rules.map((r) => {
    const nd = nextDue(r);
    const status = !r.active ? '<span class="badge paused">Paused</span>' : !nd ? '<span class="badge">Ended</span>' : '';
    const sub = [describe(r), r.method].join(' · ');
    const right = nd ? `<small>Next ${esc(prettyDate(nd, { day: 'numeric', month: 'short' }))}</small>` : '';
    return `<button class="tx" data-rule="${esc(r.id)}">
      ${catIcon(r.category)}
      <span class="tx-main"><div class="tx-title">${esc(ruleName(r))} ${status}</div><div class="tx-meta">${esc(sub)}</div></span>
      <span class="tx-amt num">${money(r.amount)}${right}</span>
    </button>`;
  }).join('');
}

// Settings is a list of sections; each opens on its own page (#settings/<section>).
const SET_ICON = {
  general: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2', catbudgets: 'M12 3a9 9 0 1 0 9 9h-9z', categories: 'M3 12V4h8l10 10-8 8zM7.5 7.5h.01',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3', sms: 'M4 5h16v11H8l-4 4z', backup: 'M3 7h6l2 2h10v10H3z',
  about: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01', danger: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
};
const SET_TITLE = { general: 'Currency, budget & look', catbudgets: 'Category budgets', categories: 'Categories', lock: 'App lock', sms: 'Read payments from SMS', backup: 'Backup & restore', about: 'About & storage', danger: 'Delete all data' };
const SET_COLOR = { general: '#1f6b52', catbudgets: '#c76a2b', categories: '#b4521f', lock: '#2d6fb8', sms: '#a8701a', backup: '#1f6b52', about: '#6f7168', danger: '#b9382f' };

function settingsValue(sec) {
  const st = state.settings;
  if (sec === 'general') return `${st.currency}${st.budget > 0 ? ' · ' + money(st.budget) : ''}`;
  if (sec === 'catbudgets') { const n = st.categories.filter((c) => c.budget > 0).length; return n ? `${n} set` : 'None'; }
  if (sec === 'categories') return String(st.categories.length);
  if (sec === 'lock') { const ls = isNative ? native.lockState() : null; return ls && !ls.error ? (ls.enabled ? ['On', 'ok'] : 'Off') : ''; }
  if (sec === 'sms') { if (!isNative) return 'From a backup file'; const on = native.smsState() === 'granted'; return on ? (state.meta.smsAuto === false ? 'On · no auto check' : ['On', 'ok']) : 'Off'; }
  if (sec === 'backup') {
    const ab = abState();
    if (isNative && ab.on && ab.lastError) return ['Needs attention', 'bad'];
    const d = daysSince(state.meta.lastBackupAt);
    if (d === Infinity) return ['Never', state.expenses.length >= 10 ? 'bad' : ''];
    const when = d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
    return [`${isNative && ab.on ? 'Auto · ' : ''}${when}`, d > 30 ? 'bad' : ''];
  }
  if (sec === 'about') return 'v' + APP_VERSION;
  return '';
}

function renderSettingsIndex() {
  const groups = [
    ['General', ['general', 'catbudgets', 'categories']],
    ['Privacy & SMS', [isNative ? 'lock' : null, 'sms'].filter(Boolean)],
    ['Your data', ['backup', 'about']],
    ['', ['danger']],
  ];
  $('setIndex').innerHTML = groups.map(([title, secs]) => `${title ? `<div class="set-group-title">${esc(title)}</div>` : '<div style="height:18px"></div>'}
    <div class="set-list">${secs.map((sec) => {
      let v = settingsValue(sec); let cls = '';
      if (Array.isArray(v)) [v, cls] = v;
      return `<a class="set-row" href="#settings/${sec}"><span class="ic" style="--c:${SET_COLOR[sec]}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${SET_ICON[sec]}"/></svg></span><span class="nm">${esc(SET_TITLE[sec])}</span><span class="val ${cls}">${esc(v)}</span><span class="chev" aria-hidden="true">›</span></a>`;
    }).join('')}</div>`).join('');
}

function renderSettings() {
  const sec = SET_TITLE[state.setSec] ? state.setSec : '';
  $('setIndex').hidden = !!sec;
  $('setBack').hidden = !sec;
  $('setTitle').textContent = sec ? SET_TITLE[sec] : 'Settings';
  document.querySelectorAll('#view-settings [data-sec]').forEach((el) => {
    el.hidden = el.dataset.sec !== sec || (el.id === 'lockPanel' && !isNative);
  });
  if (!sec) { renderSettingsIndex(); return; }
  document.querySelectorAll('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === (state.settings.theme || 'system')));
  renderCatBudgets();
  const sel = $('sCurrency');
  if (!sel.options.length) sel.innerHTML = CURRENCIES.map(([c, n, l]) => `<option value="${c}">${esc(symbolFor(c, l))} · ${esc(n)}</option>`).join('');
  sel.value = state.settings.currency;
  if (document.activeElement !== $('sBudget')) $('sBudget').value = state.settings.budget || '';

  $('sCats').innerHTML = state.settings.categories.map((c, i) => `<span class="cat-pill ${c.excluded ? 'excl' : ''}"><button type="button" class="cat-pill-name" data-edit-cat="${i}">${catIcon(c.name, 'sm')}${esc(c.name)}${c.excluded ? ' <small>not counted</small>' : ''}</button><button type="button" data-remove-cat="${i}" aria-label="Remove ${esc(c.name)}">×</button></span>`).join('');
  $('backupRemind').checked = state.meta.backupReminders !== false;
  try { renderAutoBackup(); } catch (e) { console.error(e); $('autoBackupLine').textContent = 'Automatic backup error: ' + e.message; }
  if (sec === 'lock') try { renderLock(); } catch (e) { console.error(e); $('lockPanel').hidden = false; $('lockLine').textContent = 'App lock error: ' + e.message; }

  const d = daysSince(state.meta.lastBackupAt);
  $('backupInfo').textContent = d === Infinity ? 'No backup made from this phone yet.' : `Last backup: ${new Date(state.meta.lastBackupAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}${d > 0 ? ` (${d} day${d === 1 ? '' : 's'} ago)` : ''}.`;
  $('shareJson').hidden = !(isNative || (navigator.canShare && navigator.canShare({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] })));
  renderSmsSettings();

  $('storageInfo').innerHTML = `${state.expenses.length} expenses · ${state.rules.length} recurring payments, stored on this device.<br><span class="muted" id="persistInfo"></span>`;
  if (isNative) { $('persistInfo').textContent = 'Kept privately inside the app. Uninstalling the app deletes it, so export a backup first.'; }
  else
  (async () => {
    try {
      const p = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      const used = est && est.usage ? ` · using ${(est.usage / 1024 / 1024).toFixed(1)} MB` : '';
      $('persistInfo') && ($('persistInfo').textContent = (p ? 'Protected from automatic clean-up' : 'Install the app to protect data from automatic clean-up') + used + '.');
    } catch {}
  })();
  $('aboutInfo').innerHTML = `Expense Manager <b>v${esc(APP_VERSION)}</b>${isNative ? ` for Android (bridge v${native.bridgeVersion()})` : ''} · data format v${SCHEMA_VERSION}<br><span class="muted">${isNative ? 'Works offline and has no internet access. Nothing leaves your phone unless you export it.' : 'Works offline. Nothing leaves your phone unless you export it.'}</span>`;
}

// ─── Expense sheet ───────────────────────────────────────────────────────────
function chipsHtml(selected) {
  const cats = state.settings.categories.slice();
  if (selected && !cats.some((c) => c.name === selected)) cats.push({ name: selected, color: GREY });
  return cats.map((c) => `<button type="button" class="chip ${c.name === selected ? 'selected' : ''}" data-chip="${esc(c.name)}"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</button>`).join('');
}
function methodOptions(selected) {
  const ms = state.settings.methods.slice();
  if (selected && !ms.includes(selected)) ms.push(selected);
  return ms.map((m) => `<option ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('');
}
function lastMethod() { try { return localStorage.getItem('em.method') || state.settings.methods[0]; } catch { return state.settings.methods[0]; } }
function rememberMethod(m) { try { localStorage.setItem('em.method', m); } catch {} }
// Sheets push a history entry so Android's back button closes them instead of the app.
const sheetOpen = () => !$('expenseModal').hidden || !$('ruleModal').hidden;
function hideSheets() { $('expenseModal').hidden = true; $('ruleModal').hidden = true; }
function showSheet(id) {
  $(id).hidden = false;
  if (!(history.state && history.state.sheet)) history.pushState({ sheet: true }, '');
}
function closeSheets() {
  const wasOpen = sheetOpen();
  hideSheets();
  if (wasOpen && history.state && history.state.sheet) history.back();
}

// ── Quick add / edit sheet ──
const coarse = matchMedia('(pointer: coarse)').matches;
function catTilesHtml(selected) {
  const cats = state.settings.categories.slice();
  if (selected && !cats.some((c) => c.name === selected)) cats.push({ name: selected, color: GREY });
  return cats.map((c) => `<button type="button" class="cat-tile ${c.name === selected ? 'on' : ''}" data-chip="${esc(c.name)}" aria-pressed="${c.name === selected}">${catIcon(c.name)}<span class="nm">${esc(c.name)}</span></button>`).join('');
}
function methodChipsHtml(selected) {
  const ms = state.settings.methods.slice();
  if (selected && !ms.includes(selected)) ms.push(selected);
  return ms.map((m) => `<button type="button" class="chip ${m === selected ? 'on' : ''}" data-method="${esc(m)}" aria-pressed="${m === selected}">${esc(m)}</button>`).join('');
}
/** Shops/people paid most often lately, to fill the sheet in one tap. */
function recentPayees() {
  const since = addDays(todayIso(), -90), map = new Map();
  state.expenses.forEach((e) => {
    const n = (e.note || '').trim(); if (!n || e.date < since || e.recurringId) return;
    const k = n.toLowerCase();
    const g = map.get(k) || { note: n, count: 0, last: '', category: e.category, method: e.method };
    g.count++;
    if (e.date >= g.last) Object.assign(g, { last: e.date, category: e.category, method: e.method, note: n });
    map.set(k, g);
  });
  return [...map.values()].sort((a, b) => (b.count + (b.last > addDays(todayIso(), -7) ? 2 : 0)) - (a.count + (a.last > addDays(todayIso(), -7) ? 2 : 0)) || b.last.localeCompare(a.last)).slice(0, 10);
}
function renderRecent() {
  const list = state.editingId ? [] : recentPayees();
  $('fRecentWrap').hidden = !list.length;
  state.recent = list;
  const cur = $('fNote').value.trim().toLowerCase();
  $('fRecent').innerHTML = list.map((r, i) => `<button type="button" class="chip ${cur === r.note.toLowerCase() ? 'on' : ''}" data-recent="${i}">${esc(r.note)}</button>`).join('');
}
function updateSaveLabel() {
  const a = parseAmount($('fAmount').value);
  // Keep the amount snug next to the ₹ sign.
  $('fAmount').style.width = `${Math.max(1.5, ($('fAmount').value || '0').length + 0.6)}ch`;
  $('fSave').textContent = state.editingId ? 'Save changes' : a > 0 ? `Save ${money(a)} · ${state.selCat}` : 'Save';
  const d = $('fDate').value, t = todayIso();
  $('fDateLabel').textContent = d === t ? 'Today' : d === addDays(t, -1) ? 'Yesterday' : d ? prettyDate(d, { day: 'numeric', month: 'short', year: d.slice(0, 4) === t.slice(0, 4) ? undefined : 'numeric' }) : 'Date';
}
function renderSheetRefunds() {
  const e = state.editingId ? state.expenses.find((x) => x.id === state.editingId) : null;
  const box = $('fRefunds');
  if (!e) { box.innerHTML = ''; return; }
  const list = state.editRefunds || [];
  const total = list.reduce((a, r) => a + r.amount, 0);
  const a = parseAmount($('fAmount').value) || e.amount;
  box.innerHTML = (list.length ? `<div class="refund-box">${list.map((r, i) => `<div class="rf"><span>↩ <b class="num">${money(r.amount)}</b> refunded · ${esc(prettyDate(r.date, { day: 'numeric', month: 'short' }))}${r.key ? ' · from SMS' : ''}</span><button type="button" class="x" data-del-refund="${i}" aria-label="Remove this refund">×</button></div>`).join('')}
      <div class="rf"><span>Cost after refunds</span><b class="num">${money(Math.max(0, a - total))}</b></div></div>` : '')
    + `<button type="button" class="linkish add-refund" data-action="add-refund">+ Add a refund</button>`;
}

function openExpense(id) {
  const e = id ? state.expenses.find((x) => x.id === id) : null;
  state.editingId = e ? e.id : null;
  state.editRefunds = e && e.refunds ? e.refunds.map((r) => ({ ...r })) : [];
  $('expTitle').textContent = e ? 'Edit expense' : 'New expense';
  $('fAmount').value = e ? e.amount : '';
  $('fAmount').setAttribute('inputmode', coarse ? 'none' : 'decimal');
  const cur = ymOf(new Date());
  $('fDate').value = e ? e.date : state.month === cur ? todayIso() : state.month < cur ? `${state.month}-${pad(daysIn(state.month))}` : `${state.month}-01`;
  state.selMethod = e ? e.method : lastMethod();
  $('fMethods').innerHTML = methodChipsHtml(state.selMethod);
  $('fNote').value = e ? e.note : '';
  state.selCat = e ? e.category : state.filterCat !== 'all' ? state.filterCat : state.settings.categories[0]?.name || 'Other';
  $('fCats').innerHTML = catTilesHtml(state.selCat);
  $('fRepeat').value = '';
  $('fRepeatWrap').hidden = !!e;
  const r = e && e.recurringId ? ruleById(e.recurringId) : null;
  $('fRecNote').hidden = !(e && e.recurringId);
  if (e && e.recurringId) {
    $('fRecNote').innerHTML = r
      ? `↻ ${e.smsKey ? `“${esc(ruleName(r))}” payment, with the amount and date from your bank SMS${e.dueDate && e.dueDate !== e.date ? ` (due ${esc(prettyDate(e.dueDate, { day: 'numeric', month: 'short' }))})` : ''}` : `Added automatically by “${esc(ruleName(r))}”`}. Changes here affect only this one. <button type="button" class="linkish" data-edit-rule="${esc(r.id)}">Edit the recurring payment</button>`
      : '↻ Added by a recurring payment that has since been deleted.';
  }
  $('fError').textContent = '';
  const del = $('fDelete'); del.hidden = !e; del.classList.remove('armed'); del.textContent = 'Delete';
  renderRecent(); renderSheetRefunds(); updateSaveLabel();
  hideSheets();
  showSheet('expenseModal');
  const sel = $('fCats').querySelector('.on'); if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'center' });
  if (!e && !coarse) setTimeout(() => $('fAmount').focus(), 60);
}

$('fCats').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-chip]'); if (!b) return;
  state.selCat = b.dataset.chip;
  $('fCats').querySelectorAll('.cat-tile').forEach((t) => { const on = t.dataset.chip === state.selCat; t.classList.toggle('on', on); t.setAttribute('aria-pressed', on); });
  updateSaveLabel();
});
$('fMethods').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-method]'); if (!b) return;
  state.selMethod = b.dataset.method; $('fMethods').innerHTML = methodChipsHtml(state.selMethod);
});
$('fRecent').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-recent]'); if (!b) return;
  const r = state.recent[Number(b.dataset.recent)]; if (!r) return;
  $('fNote').value = r.note;
  state.selCat = r.category; $('fCats').innerHTML = catTilesHtml(state.selCat);
  state.selMethod = r.method; $('fMethods').innerHTML = methodChipsHtml(state.selMethod);
  const sel = $('fCats').querySelector('.on'); if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'center' });
  renderRecent(); updateSaveLabel();
});
$('fNote').addEventListener('input', () => { if (!state.editingId) renderRecent(); });
$('fAmount').addEventListener('input', () => { updateSaveLabel(); if (state.editingId) renderSheetRefunds(); });
$('fDate').addEventListener('change', updateSaveLabel);
$('keypad').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  const inp = $('fAmount'); let v = inp.value;
  const k = b.dataset.key || b.textContent;
  if (k === 'back') v = v.slice(0, -1);
  else if (k === '.') { if (!v.includes('.')) v = (v || '0') + '.'; }
  else if (/^\d$/.test(k)) {
    if (/\.\d{2}$/.test(v) || v.replace('.', '').length >= 9) return;
    v = v === '0' ? k : v + k;
  }
  inp.value = v;
  inp.dispatchEvent(new Event('input'));
});
$('fRefunds').addEventListener('click', async (ev) => {
  const d = ev.target.closest('[data-del-refund]');
  if (d) { state.editRefunds.splice(Number(d.dataset.delRefund), 1); renderSheetRefunds(); return; }
  if (!ev.target.closest('[data-action="add-refund"]')) return;
  const a = parseAmount($('fAmount').value);
  const left = Math.max(0, a - state.editRefunds.reduce((x, r) => x + r.amount, 0));
  if (!(left > 0)) { toast('This expense is already fully refunded'); return; }
  const { value, inputValue } = await dialog({
    title: 'Add a refund',
    html: `<p>How much did you get back? The expense will count as what it really cost you.</p><p class="muted small">Up to ${esc(money(left))}.</p>`,
    input: { placeholder: String(left) },
    actions: [{ label: 'Cancel', value: false }, { label: 'Add refund', value: true, kind: 'primary' }],
  });
  if (!value) return;
  const r = parseAmount(inputValue || String(left));
  if (!(r > 0)) { toast('Enter an amount'); return; }
  state.editRefunds.push({ amount: Math.min(r, left), date: todayIso(), note: 'Added by hand' });
  renderSheetRefunds();
});

$('expenseForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const amount = parseAmount($('fAmount').value), date = $('fDate').value;
  if (!(amount > 0)) { $('fError').textContent = 'Enter an amount greater than zero.'; if (!coarse) $('fAmount').focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { $('fError').textContent = 'Pick a date.'; return; }
  const method = state.selMethod || lastMethod(), note = $('fNote').value.trim().slice(0, 120), category = state.selCat || 'Other';
  rememberMethod(method);
  const repeat = $('fRepeat').value;
  const existing = state.editingId ? state.expenses.find((x) => x.id === state.editingId) : null;

  if (!existing && repeat) {
    // A repeating expense is stored as a rule; the generator creates the dated entries.
    const rule = normalizeRule({ id: uid('r'), amount, category, method, note, frequency: repeat, interval: 1, startDate: date, active: true });
    if (!(await persist({ recurring: [rule] }))) return;
    upsertLocal('rules', [rule]);
    closeSheets();
    const added = await runRecurring();
    if (!date.startsWith(state.month)) state.month = date.slice(0, 7);
    renderAll();
    toast(added ? `Saved · repeats ${repeat === 'weekly' ? 'weekly' : repeat === 'yearly' ? 'yearly' : 'monthly'}` : `Recurring payment set · first on ${prettyDate(date)}`);
    checkBudgetAlerts();
    return;
  }

  const now = Date.now();
  const exp = normalizeExpense({ ...(existing || {}), id: existing ? existing.id : uid('e'), amount, date, category, method, note, refunds: existing ? state.editRefunds : undefined, createdAt: existing ? existing.createdAt : now, updatedAt: now });
  if (!(await persist({ expenses: [exp] }))) return;
  upsertLocal('expenses', [exp]);
  closeSheets();
  if (state.view === 'home' && !date.startsWith(state.month)) state.month = date.slice(0, 7);
  renderAll();
  toast(existing ? 'Expense updated' : `Added ${money(amount)} · ${category}`);
  setTimeout(() => checkBudgetAlerts(), 1500);
});

async function deleteExpense(id, undoable = true) {
  const e = state.expenses.find((x) => x.id === id); if (!e) return;
  if (!(await persist({ deleteExpenses: [id] }))) return;
  state.expenses = state.expenses.filter((x) => x.id !== id);
  renderAll();
  toast(`Deleted ${e.note || e.category} · ${money(e.amount)}`, undoable ? { label: 'Undo', run: async () => {
    if (!(await persist({ expenses: [e] }))) return;
    upsertLocal('expenses', [e]); renderAll(); toast('Expense restored');
  } } : null);
}
$('fDelete').addEventListener('click', async () => {
  const del = $('fDelete');
  if (!del.classList.contains('armed')) { del.classList.add('armed'); del.textContent = 'Tap again to delete'; return; }
  const id = state.editingId;
  closeSheets();
  await deleteExpense(id);
});

// ── Swipe a row left for Edit / Delete ──
function closeSwipes(except) { document.querySelectorAll('.swipe.open').forEach((el) => { if (el !== except) { el.classList.remove('open'); el.querySelector('.tx').style.transform = ''; } }); }
let swipe = null, swipeMoved = false;
document.addEventListener('pointerdown', (e) => {
  const tx = e.target.closest('.swipe .tx');
  if (!tx || e.pointerType === 'mouse' && e.button !== 0) { if (!e.target.closest('.swipe-actions')) closeSwipes(); return; }
  const box = tx.parentElement;
  closeSwipes(box);
  swipe = { box, tx, x: e.clientX, y: e.clientY, base: box.classList.contains('open') ? -152 : 0, dx: 0, active: false };
  swipeMoved = false;
}, { passive: true });
document.addEventListener('pointermove', (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
    if (Math.abs(dx) < 10) return;
    swipe.active = true; swipe.box.classList.add('dragging');
  }
  swipe.dx = Math.max(-190, Math.min(0, swipe.base + dx));
  swipe.tx.style.transform = `translateX(${swipe.dx}px)`;
  swipeMoved = true;
}, { passive: true });
const endSwipe = () => {
  if (!swipe) return;
  const { box, tx, active, dx } = swipe;
  swipe = null;
  if (!active) return;
  box.classList.remove('dragging');
  const open = dx < -60;
  box.classList.toggle('open', open);
  tx.style.transform = open ? 'translateX(-152px)' : '';
  setTimeout(() => (swipeMoved = false), 50);
};
document.addEventListener('pointerup', endSwipe);
document.addEventListener('pointercancel', endSwipe);
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sw]'); if (!b) return;
  const id = b.closest('.swipe').dataset.sid;
  closeSwipes();
  if (b.dataset.sw === 'edit') openExpense(id); else deleteExpense(id);
}, true);

// ─── Recurring sheet ─────────────────────────────────────────────────────────
const UNIT = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };

function readRuleForm() {
  return {
    amount: parseAmount($('rAmount').value),
    note: $('rNote').value.trim().slice(0, 120),
    frequency: $('rFreq').value,
    interval: Math.max(1, Math.min(365, parseInt($('rInterval').value, 10) || 1)),
    startDate: $('rStart').value,
    endDate: $('rEnd').value || null,
    method: $('rMethod').value,
    active: $('rActive').value === '1',
    category: state.selRuleCat || 'Other',
  };
}

function updateRulePreview() {
  const f = readRuleForm();
  const n = f.interval;
  $('rUnit').textContent = UNIT[f.frequency] + (n === 1 ? '' : 's');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.startDate)) { $('rPreview').textContent = ''; return; }
  const existing = state.editingRuleId ? ruleById(state.editingRuleId) : null;
  const probe = normalizeRule({ ...f, amount: f.amount > 0 ? f.amount : 1, lastGenerated: existing ? existing.lastGenerated : null });
  if (!probe) { $('rPreview').textContent = ''; return; }
  const parts = [describe(probe)];
  const nd = nextDue(probe);
  if (!existing) {
    const past = occurrences(probe, todayIso()).length;
    if (past) parts.push(`${past} payment${past === 1 ? '' : 's'} up to today will be added`);
    else if (nd) parts.push(`first on ${prettyDate(nd)}`);
  } else if (nd) parts.push(`next on ${prettyDate(nd)}`);
  else if (probe.active) parts.push('no more payments (end date passed)');
  if (f.amount > 0) parts.push(`≈ ${money(Math.round(monthlyEquivalent(probe)))}/month`);
  $('rPreview').textContent = parts.join(' · ');
}

function openRule(id) {
  const r = id ? ruleById(id) : null;
  state.ruleFromSms = null;
  $('rSmsNote').hidden = true;
  state.editingRuleId = r ? r.id : null;
  $('ruleTitle').textContent = r ? 'Edit recurring payment' : 'Add recurring payment';
  $('rAmount').value = r ? r.amount : '';
  $('rNote').value = r ? r.note : '';
  $('rFreq').value = r ? r.frequency : 'monthly';
  $('rInterval').value = r ? r.interval : 1;
  $('rStart').value = r ? r.startDate : todayIso();
  $('rStart').disabled = !!(r && r.lastGenerated);
  $('rEnd').value = r && r.endDate ? r.endDate : '';
  $('rMethod').innerHTML = methodOptions(r ? r.method : lastMethod());
  $('rActive').value = !r || r.active ? '1' : '0';
  state.selRuleCat = r ? r.category : 'Bills & utilities';
  if (!state.settings.categories.some((c) => c.name === state.selRuleCat) && !r) state.selRuleCat = state.settings.categories[0]?.name || 'Other';
  $('rCats').innerHTML = chipsHtml(state.selRuleCat);
  $('rError').textContent = '';
  $('rDelete').hidden = !r;
  updateRulePreview();
  hideSheets();
  showSheet('ruleModal');
  if (!r) setTimeout(() => $('rAmount').focus(), 60);
}

['rAmount', 'rFreq', 'rInterval', 'rStart', 'rEnd', 'rActive'].forEach((id) => $(id).addEventListener('input', updateRulePreview));
$('rCats').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-chip]'); if (!b) return;
  state.selRuleCat = b.dataset.chip; $('rCats').innerHTML = chipsHtml(state.selRuleCat);
});

$('ruleForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = readRuleForm();
  if (!(f.amount > 0)) { $('rError').textContent = 'Enter an amount greater than zero.'; return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.startDate)) { $('rError').textContent = 'Pick the date of the first payment.'; return; }
  if (f.endDate && f.endDate < f.startDate) { $('rError').textContent = 'The end date is before the first payment.'; return; }
  const existing = state.editingRuleId ? ruleById(state.editingRuleId) : null;
  const rule = normalizeRule({ ...(existing || {}), ...f, id: existing ? existing.id : uid('r'), lastGenerated: existing ? existing.lastGenerated : null, createdAt: existing ? existing.createdAt : Date.now(), updatedAt: Date.now() });
  rememberMethod(f.method);
  if (!(await persist({ recurring: [rule] }))) return;
  upsertLocal('rules', [rule]);
  const fromSms = !existing && state.ruleFromSms;
  state.ruleFromSms = null;
  closeSheets();
  const added = await runRecurring();
  if (fromSms) {
    // Link the SMS it was made from (and any other SMS in this review that pay it).
    const occ = nearestOccurrence(rule, fromSms.date, state.expenses, 45, takenLinks(fromSms));
    if (occ) { fromSms.link = { ruleId: rule.id, occ: occ.occ, auto: false }; fromSms.flags = fromSms.flags.filter((x) => x !== 'exists'); fromSms.selected = true; }
    sms.items.forEach((it) => {
      if (it.link || it === fromSms) return;
      const m = matchRecurring(it, [rule], state.expenses, takenLinks(it));
      if (m) { it.link = { ruleId: rule.id, occ: m.occ, auto: true }; it.flags = it.flags.filter((x) => x !== 'exists'); if (!it.flags.includes('ignored') && !it.flags.includes('dup')) it.selected = true; }
    });
  }
  renderAll();
  if (fromSms) { renderSmsResults(); toast(`Recurring payment saved · linked to ${sms.items.filter((x) => x.link && x.link.ruleId === rule.id).length} SMS`); return; }
  toast(existing ? 'Recurring payment updated' : added ? `Saved · added ${added} payment${added === 1 ? '' : 's'} so far` : 'Recurring payment saved');
});

$('rDelete').addEventListener('click', async () => {
  const r = ruleById(state.editingRuleId); if (!r) return;
  const past = state.expenses.filter((e) => e.recurringId === r.id);
  const { value } = await dialog({
    title: `Delete “${ruleName(r)}”?`,
    html: `<p>No more payments will be added.</p>${past.length ? `<p>It has already added <b>${past.length}</b> expense${past.length === 1 ? '' : 's'} (${esc(money(sum(past)))}). Keep them in your history?</p>` : ''}`,
    actions: past.length
      ? [{ label: 'Cancel', value: null }, { label: 'Delete all', value: 'all', kind: 'ghost danger' }, { label: 'Keep history', value: 'keep', kind: 'primary' }]
      : [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'keep', kind: 'danger solid' }],
  });
  if (!value) return;
  const delExp = value === 'all' ? past.map((e) => e.id) : [];
  if (!(await persist({ deleteRecurring: [r.id], deleteExpenses: delExp }))) return;
  state.rules = state.rules.filter((x) => x.id !== r.id);
  if (delExp.length) { const s = new Set(delExp); state.expenses = state.expenses.filter((e) => !s.has(e.id)); }
  closeSheets(); renderAll(); toast('Recurring payment deleted');
});

// ─── Settings actions ────────────────────────────────────────────────────────
$('sCurrency').addEventListener('change', (e) => { state.settings.currency = e.target.value; saveSettings(); });
$('sBudget').addEventListener('change', (e) => {
  const raw = e.target.value.trim(), v = raw ? parseAmount(raw) : 0;
  if (raw && !(v >= 0)) { toast('Enter a valid amount'); return; }
  state.settings.budget = v || 0; saveSettings(); toast(v ? `Budget set to ${money(v)}` : 'Budget removed');
});
$('addCatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('sNewCat').value.trim().slice(0, 30);
  if (!name) return;
  if (state.settings.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) { toast('That category already exists'); return; }
  const used = new Set(state.settings.categories.map((c) => c.color));
  state.settings.categories.push({ name, color: PALETTE.find((p) => !used.has(p)) || PALETTE[state.settings.categories.length % PALETTE.length] });
  $('sNewCat').value = ''; saveSettings();
});
$('sCats').addEventListener('click', async (e) => {
  const ed = e.target.closest('[data-edit-cat]');
  if (ed) {
    const cat = state.settings.categories[Number(ed.dataset.editCat)];
    let counted = !cat.excluded;
    const { value } = await dialog({
      title: cat.name,
      html: `<label class="check"><input type="checkbox" id="dlgCounted" ${counted ? 'checked' : ''}> <span>Count as spending<br><span class="muted small">Turn off for money that isn’t really spent, like transfers between your accounts, investments or savings. It’s still listed, but left out of Spent, budget and charts.</span></span></label>`,
      actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, kind: 'primary' }],
      onBody: (body) => body.querySelector('#dlgCounted').addEventListener('change', (ev) => (counted = ev.target.checked)),
    });
    if (!value || counted === !cat.excluded) return;
    cat.excluded = !counted;
    saveSettings();
    toast(counted ? `${cat.name} now counts as spending` : `${cat.name} no longer counts as spending`);
    return;
  }
  const b = e.target.closest('[data-remove-cat]'); if (!b) return;
  if (state.settings.categories.length <= 1) { toast('Keep at least one category'); return; }
  const cat = state.settings.categories[Number(b.dataset.removeCat)];
  const n = state.expenses.filter((x) => x.category === cat.name).length;
  if (n) {
    const { value } = await dialog({ title: `Remove “${cat.name}”?`, html: `<p>${n} expense${n === 1 ? '' : 's'} use this category. They’ll be kept and shown in grey.</p>`, actions: [{ label: 'Cancel', value: false }, { label: 'Remove', value: true, kind: 'danger solid' }] });
    if (!value) return;
  }
  state.settings.categories = state.settings.categories.filter((c) => c !== cat);
  saveSettings();
});

// ─── Appearance ─────────────────────────────────────────────────────────────
function applyTheme(mode) {
  const m = ['light', 'dark'].includes(mode) ? mode : 'system';
  if (m === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = m;
  try { localStorage.setItem('em.theme', m); } catch {}
  const dark = m === 'dark' || (m === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((el) => { el.content = dark ? '#121412' : '#1f6b52'; el.removeAttribute('media'); });
  if (isNative) native.setTheme(m);
}
$('themeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-set]'); if (!b) return;
  state.settings.theme = b.dataset.themeSet;
  applyTheme(state.settings.theme);
  saveSettings();
});

// ─── Category budgets ─────────────────────────────────────────────────────────
function renderCatBudgets() {
  const ym = ymOf(new Date());
  const by = byCategory(monthExpenses(ym));
  const cats = state.settings.categories.filter((c) => !c.excluded);
  $('cbList').innerHTML = cats.map((c) => `<div class="cb-row">
      ${catIcon(c.name)}
      <div><div class="nm">${esc(c.name)}</div><div class="sp num">This month ${money(by[c.name] || 0)}</div></div>
      <input inputmode="decimal" data-cb="${esc(c.name)}" value="${c.budget > 0 ? c.budget : ''}" placeholder="No limit" aria-label="Monthly budget for ${esc(c.name)}" autocomplete="off">
    </div>`).join('');
  const total = cats.reduce((a, c) => a + (c.budget || 0), 0);
  const overall = state.settings.budget;
  $('cbSummary').innerHTML = total
    ? `Category budgets add up to <b class="num">${money(total)}</b>${overall > 0 ? ` · monthly budget <b class="num">${money(overall)}</b>${total > overall ? ' <span class="up">(more than the monthly budget)</span>' : ''}` : ''}.`
    : `<span class="muted">No category budgets yet.</span>`;
  $('cbAlerts').checked = state.settings.budgetAlerts !== false;
}
$('cbList').addEventListener('change', async (e) => {
  const name = e.target.dataset.cb; if (!name) return;
  const raw = e.target.value.trim(), v = raw ? parseAmount(raw) : 0;
  if (raw && !(v >= 0)) { toast('Enter a valid amount'); return; }
  const c = state.settings.categories.find((x) => x.name === name); if (!c) return;
  if (v > 0) c.budget = v; else delete c.budget;
  await persist({ meta: { settings: state.settings } });
  renderCatBudgets();
  toast(v > 0 ? `${name}: ${money(v)} a month` : `${name}: no limit`);
});
$('cbAlerts').addEventListener('change', (e) => { state.settings.budgetAlerts = e.target.checked; saveSettings(); });

/**
 * Warn once per month when the monthly budget or a category budget reaches 80% / 100%.
 * Remembers what was already shown in meta.budgetAlerts = { ym, sent: { [category or '*']: 80|100 } }.
 */
async function checkBudgetAlerts() {
  if (state.settings.budgetAlerts === false) return;
  const ym = ymOf(new Date());
  const list = spendOf(monthExpenses(ym));
  const by = byCategory(list);
  const prev = state.meta.budgetAlerts && state.meta.budgetAlerts.ym === ym ? state.meta.budgetAlerts.sent : {};
  const sent = { ...prev };
  const hits = [];
  const test = (key, label, spent, budget) => {
    if (!(budget > 0)) return;
    const pct = (spent / budget) * 100;
    const level = pct >= 100 ? 100 : pct >= 80 ? 80 : 0;
    if (level && level > (sent[key] || 0)) { hits.push({ key, label, spent, budget, level }); sent[key] = level; }
  };
  test('*', 'monthly budget', sum(list), state.settings.budget);
  state.settings.categories.forEach((c) => { if (!c.excluded) test(c.name, `${c.name} budget`, by[c.name] || 0, c.budget); });
  if (!hits.length) return;
  await setMeta({ budgetAlerts: { ym, sent } });
  hits.sort((a, b) => b.level - a.level);
  const h = hits[0];
  const msg = h.level === 100
    ? `${h.key === '*' ? 'Monthly budget' : h.label} used up · ${money(h.spent)} of ${money(h.budget)}`
    : `${Math.floor((h.spent / h.budget) * 100)}% of ${h.key === '*' ? 'your monthly budget' : h.label} used · ${money(h.budget - h.spent)} left`;
  toast(hits.length > 1 ? `${msg} (+${hits.length - 1} more)` : msg, state.view !== 'home' || state.month !== ym ? { label: 'View', run: () => { state.month = ym; location.hash = '#home'; } } : null);
}

// ─── Export / import ─────────────────────────────────────────────────────────
function stamp() { const d = new Date(); return `${isoDate(d)}_${pad(d.getHours())}${pad(d.getMinutes())}`; }
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function backupText() {
  return JSON.stringify(buildBackup({ settings: state.settings, expenses: state.expenses, recurring: state.rules }), null, 1);
}
function backupBlob() { return new Blob([backupText()], { type: 'application/json' }); }
/** Save a text file: Android shows a "save as" screen, the browser downloads it. Resolves true if saved. */
async function saveText(name, mime, text) {
  if (isNative) return native.saveFile(name, mime, text);
  downloadBlob(new Blob([text], { type: mime }), name);
  return true;
}
async function markBackedUp() {
  state.meta.lastBackupAt = Date.now();
  await writeBatch({ meta: { lastBackupAt: state.meta.lastBackupAt } }).catch(console.error);
  renderAll();
}
$('exportJson').addEventListener('click', async () => {
  if (!(await saveText(`expenses-backup_${stamp()}.json`, 'application/json', backupText()))) return;
  await markBackedUp();
  toast(isNative ? 'Backup saved' : 'Backup saved to Downloads');
});
$('shareJson').addEventListener('click', async () => {
  if (isNative) {
    if (native.shareFile(`expenses-backup_${stamp()}.json`, 'application/json', backupText())) await markBackedUp();
    else toast('Couldn’t share — use Export instead');
    return;
  }
  const file = new File([backupBlob()], `expenses-backup_${stamp()}.json`, { type: 'application/json' });
  try { await navigator.share({ files: [file], title: 'Expense Manager backup' }); await markBackedUp(); }
  catch (e) { if (e && e.name !== 'AbortError') toast('Sharing isn’t available — use Export instead'); }
});
$('exportCsv').addEventListener('click', async () => {
  if (!state.expenses.length && !state.rules.length) { toast('Nothing to export yet'); return; }
  if (!(await saveText(`expenses_${stamp()}.csv`, 'text/csv', toCSV(state.expenses, state.settings.currency, state.rules)))) return;
  toast(isNative ? 'Spreadsheet saved' : 'Spreadsheet saved to Downloads');
});
$('importBtn').addEventListener('click', () => { $('importFile').value = ''; $('importFile').click(); });
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  let parsed;
  try { parsed = parseImportText(await file.text(), file.name); }
  catch (err) { await dialog({ title: 'Can’t import this file', html: `<p>${esc(err.message)}</p>` }); return; }

  const existingIds = new Set(state.expenses.map((x) => x.id));
  const newOnes = (parsed.source === 'csv' ? dropCsvDuplicates(parsed.expenses) : parsed.expenses).filter((x) => !existingIds.has(x.id)).length;
  const from = parsed.source === 'backup'
    ? `Backup from app v${esc(parsed.appVersion)}${parsed.exportedAt ? `, made ${esc(new Date(parsed.exportedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }))}` : ''}${parsed.fileSchema < SCHEMA_VERSION ? ' — will be upgraded to the current format' : ''}.`
    : 'Spreadsheet (CSV) file.';
  const { value } = await dialog({
    title: `Import ${esc(file.name)}`,
    html: `<p class="muted small">${from}</p>
      <p>Found <b>${parsed.expenses.length}</b> expense${parsed.expenses.length === 1 ? '' : 's'}${parsed.recurring.length ? ` and <b>${parsed.recurring.length}</b> recurring payment${parsed.recurring.length === 1 ? '' : 's'}` : ''}${parsed.skipped ? ` (${parsed.skipped} unreadable row${parsed.skipped === 1 ? '' : 's'} skipped)` : ''}.</p>
      <p><b>Merge</b> adds ${newOnes} new expense${newOnes === 1 ? '' : 's'} and updates matching ones; nothing is removed.<br><b>Replace</b> deletes everything on this phone first${parsed.source === 'backup' ? ' and restores the backup’s settings' : ''}.</p>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Replace all', value: 'replace', kind: 'ghost danger' }, { label: 'Merge', value: 'merge', kind: 'primary' }],
  });
  if (!value) return;
  if (value === 'replace') {
    const ok = await dialog({ title: 'Replace all data?', html: `<p>This permanently removes the ${state.expenses.length} expenses and ${state.rules.length} recurring payments now on this phone.</p>`, actions: [{ label: 'Cancel', value: false }, { label: 'Replace', value: true, kind: 'danger solid' }] });
    if (!ok.value) return;
  }
  await applyImport(parsed, value);
});

// CSV rows carry no ids, so match them to existing expenses by content
// (date + amount + category + note) to avoid duplicates when merging.
function dropCsvDuplicates(incoming) {
  const sig = (e) => [e.date, Number(e.amount).toFixed(2), e.category.toLowerCase(), (e.note || '').toLowerCase()].join('|');
  const have = {};
  state.expenses.forEach((e) => { const k = sig(e); have[k] = (have[k] || 0) + 1; });
  return incoming.filter((e) => { const k = sig(e); if (have[k] > 0) { have[k]--; return false; } return true; });
}

async function applyImport(parsed, mode) {
  if (mode === 'merge' && parsed.source === 'csv') parsed = { ...parsed, expenses: dropCsvDuplicates(parsed.expenses) };
  const newer = (incoming, current) => !current || (incoming.updatedAt || 0) >= (current.updatedAt || 0);
  let expenses, rules, settings;
  if (mode === 'replace') {
    expenses = parsed.expenses; rules = parsed.recurring;
    settings = parsed.settings || state.settings;
  } else {
    const em = new Map(state.expenses.map((x) => [x.id, x]));
    parsed.expenses.forEach((x) => { if (newer(x, em.get(x.id))) em.set(x.id, x); });
    const rm = new Map(state.rules.map((x) => [x.id, x]));
    parsed.recurring.forEach((x) => {
      const cur = rm.get(x.id);
      if (newer(x, cur)) rm.set(x.id, cur && cur.lastGenerated > (x.lastGenerated || '') ? { ...x, lastGenerated: cur.lastGenerated } : x);
    });
    expenses = [...em.values()]; rules = [...rm.values()];
    settings = { ...state.settings };
    if (parsed.settings) {
      const have = new Set(settings.categories.map((c) => c.name));
      settings.categories = settings.categories.concat(parsed.settings.categories.filter((c) => !have.has(c.name)));
      if (!settings.budget && parsed.settings.budget) settings.budget = parsed.settings.budget;
    }
  }
  if (!(await persist({ clear: true, expenses, recurring: rules, meta: { settings } }))) return;
  state.expenses = expenses; state.rules = rules; state.settings = normalizeSettings(settings);
  addMissingCategories(expenses.map((x) => x.category).concat(rules.map((r) => r.category)));
  resetFormats();
  const added = await runRecurring();
  renderAll();
  toast(`Imported ${parsed.expenses.length} new expense${parsed.expenses.length === 1 ? '' : 's'}${added ? ` · ${added} recurring added` : ''}`);
}

$('wipeBtn').addEventListener('click', async () => {
  const { value, inputValue } = await dialog({
    title: 'Delete all data?',
    html: `<p>This permanently deletes ${state.expenses.length} expenses, ${state.rules.length} recurring payments and your settings from this phone. Export a backup first if you might need them.</p><p>Type <b>DELETE</b> to confirm.</p>`,
    input: { placeholder: 'DELETE' },
    actions: [{ label: 'Cancel', value: false }, { label: 'Delete everything', value: true, kind: 'danger solid' }],
  });
  if (!value) return;
  if ((inputValue || '').trim().toUpperCase() !== 'DELETE') { toast('Not deleted — you didn’t type DELETE'); return; }
  try {
    await wipeEverything();
    state.expenses = []; state.rules = []; state.settings = defaultSettings(); state.meta = { schemaVersion: SCHEMA_VERSION };
    await writeBatch({ meta: { schemaVersion: SCHEMA_VERSION, settings: state.settings } });
    resetFormats(); renderAll(); toast('All data deleted');
  } catch (e) { toast('Couldn’t delete: ' + e.message); }
});


// ─── Import from SMS ─────────────────────────────────────────────────────────
const sms = { messages: null, fileName: '', items: [], refunds: [], skipped: null, unread: [], inRange: 0, scanned: false, preset: 'this' };
const smsCfg = () => state.settings.sms || (state.settings.sms = defaultSmsSettings());
const smsAnalyzeCfg = () => ({ ...smsCfg(), transferCategory: hasCategory('Transfers') ? 'Transfers' : null });

function setPreset(p) {
  const t = new Date(), today = todayIso();
  let from = today, to = today;
  if (p === '7d') from = addDays(today, -6);
  else if (p === 'this') from = ymOf(t) + '-01';
  else if (p === 'last') { const lm = shiftMonth(ymOf(t), -1); from = lm + '-01'; to = `${lm}-${pad(daysIn(lm))}`; }
  else if (p === '3m') from = shiftMonth(ymOf(t), -2) + '-01';
  sms.preset = p;
  $('smsFrom').value = from; $('smsTo').value = to;
  document.querySelectorAll('#smsPresets .chip').forEach((c) => c.classList.toggle('selected', c.dataset.preset === p));
}

const useNativeSms = () => isNative && native.smsState() === 'granted' && !sms.useFile;
function renderSms() {
  if (!$('smsFrom').value) setPreset(sms.preset);
  if (isNative) {
    const st = native.smsState();
    const granted = st === 'granted';
    $('smsNativeBlock').hidden = false;
    $('smsNativeLine').innerHTML = granted
      ? (sms.useFile ? 'Using an SMS backup file. <button class="linkish" id="smsUsePhone">Read this phone’s messages instead</button>' : '✓ Reading payment messages directly from this phone. Choose dates below.')
      : st === 'unavailable' ? 'Reading SMS isn’t available on this device or in this version. You can still use an SMS backup file.'
      : 'Allow SMS access to find payments directly from your messages. It’s optional — you can use a backup file instead.';
    $('smsNativeAllow').hidden = granted || st === 'unavailable';
    $('smsFileBlock').hidden = granted && !sms.useFile;
    $('smsFileToggle').hidden = !granted || sms.useFile;
  } else {
    $('smsNativeBlock').hidden = true;
    $('smsFileToggle').hidden = true;
  }
  if (sms.messages) {
    const first = sms.messages[0].ts, last = sms.messages[sms.messages.length - 1].ts;
    $('smsFileInfo').textContent = `✓ ${sms.fileName} · ${sms.messages.length.toLocaleString('en-IN')} messages · ${prettyDate(isoDate(new Date(first)))} – ${prettyDate(isoDate(new Date(last)))}`;
  } else $('smsFileInfo').textContent = '';
  $('smsScan').disabled = !(sms.messages || useNativeSms());
  renderSmsCustom();
}

function catOptions(selected) {
  const names = state.settings.categories.map((c) => c.name);
  if (selected && !names.includes(selected)) names.push(selected);
  return names.map((n) => `<option ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

// ── SMS ↔ recurring payments (2.3.0) ──
/** Link SMS payments to the recurring entry they pay (rent paid 2 days late, a bill that changed…). */
function prepareLinks(items) {
  const taken = new Set();
  const cands = items.map((it) => ({ it, m: matchRecurring(it, state.rules, state.expenses) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score);
  items.forEach((it) => (it.link = null));
  for (const { it } of cands) {
    const m = matchRecurring(it, state.rules, state.expenses, taken);
    if (!m) continue;
    taken.add(expenseIdFor(m.ruleId, m.occ));
    it.link = { ruleId: m.ruleId, occ: m.occ, auto: true };
    // It's the recurring entry itself, so "you may have added this already" no longer applies.
    it.flags = it.flags.filter((f) => f !== 'exists');
    if (!it.flags.includes('ignored') && !it.flags.includes('dup')) it.selected = true;
  }
}
/** Entries already claimed by other items in this review. */
function takenLinks(except) {
  return new Set(sms.items.filter((x) => x !== except && x.link).map((x) => expenseIdFor(x.link.ruleId, x.link.occ)));
}
function linkOptions(it) {
  const rules = state.rules.filter((r) => r.active || it.link && it.link.ruleId === r.id);
  if (!rules.length) return '';
  return `<option value="">Not a recurring payment</option>` + rules.map((r) => `<option value="${esc(r.id)}" ${it.link && it.link.ruleId === r.id ? 'selected' : ''}>↻ ${esc(ruleName(r))} · ${esc(money(r.amount))}</option>`).join('');
}
function linkNote(it) {
  if (!it.link) return '';
  const r = ruleById(it.link.ruleId); if (!r) return '';
  const e = state.expenses.find((x) => x.id === expenseIdFor(r.id, it.link.occ));
  const due = esc(prettyDate(it.link.occ, { day: 'numeric', month: 'short' }));
  const what = e
    ? `Updates the <b>${esc(ruleName(r))}</b> entry due ${due}${Math.abs(Number(e.amount) - it.amount) >= 0.01 ? ` (${esc(money(e.amount))} → <b class="num">${esc(money(it.amount))}</b>)` : ''} with this SMS’s amount, date and payment method — no new expense is added.`
    : `Records the <b>${esc(ruleName(r))}</b> payment due ${due} with this SMS’s details, so it won’t be added again on the due date.`;
  return `<p class="link-note">${what}</p>`;
}

/** Find the expense each refund belongs to (best guess pre-selected). */
function prepareRefunds(refunds, dismissed = {}) {
  return (refunds || []).map((r) => {
    const cands = matchRefund(r, state.expenses, amt, (e) => isExcluded(e.category));
    return { ...r, cands: cands.map((e) => e.id), target: cands[0] ? cands[0].id : '', selected: !!cands[0] && !dismissed[r.key] };
  });
}
function refundOptions(r) {
  const opts = r.cands.map((id) => state.expenses.find((e) => e.id === id)).filter(Boolean);
  return opts.map((e) => `<option value="${esc(e.id)}" ${e.id === r.target ? 'selected' : ''}>${esc(prettyDate(e.date, { day: 'numeric', month: 'short' }))} · ${esc(money(amt(e)))} · ${esc(e.note || e.category)}</option>`).join('')
    + `<option value="" ${!r.target ? 'selected' : ''}>${opts.length ? 'None of these — skip' : 'No matching expense found — skip'}</option>`;
}

function renderSmsResults() {
  $('smsResults').hidden = !sms.scanned;
  if (!sms.scanned) { updateSmsBar(); return; }
  const k = sms.skipped;
  const total = sms.items.length;
  const parts = [];
  if (k.imported) parts.push(`${k.imported} already imported`);
  if (k.income) parts.push(`${k.income} money received`);
  if (k.otp) parts.push(`${k.otp} OTP`);
  if (k.notPayment) parts.push(`${k.notPayment} reminders/failed`);
  if (k.filtered) parts.push(`${k.filtered} skipped by your settings`);
  $('smsStats').innerHTML = `Checked <b>${sms.inRange.toLocaleString('en-IN')}</b> messages from ${esc(prettyDate($('smsFrom').value))} to ${esc(prettyDate($('smsTo').value))}. Found <b>${total}</b> payment${total === 1 ? '' : 's'}.`
    + (parts.length ? `<br><span class="muted">Ignored: ${esc(parts.join(' · '))}.</span>` : '')
    + (total ? `<br><span class="muted">Untick anything you don’t want, and fix details before adding.</span>` : '');

  const nRef = (sms.refunds || []).length;
  if (nRef) $('smsStats').innerHTML += `<br>Also found <b>${nRef}</b> refund${nRef === 1 ? '' : 's'} — see below.`;
  if (!total) {
    $('smsList').innerHTML = nRef ? '' : `<div class="empty">No new payments found in these dates.${k.imported ? ' Everything here has already been imported.' : ''}</div>`;
  } else {
    $('smsList').innerHTML = sms.items.map((it, i) => {
      const badges = [];
      if (it.flags.includes('dup')) badges.push('<span class="badge warn">Looks like a duplicate of another SMS</span>');
      if (it.flags.includes('exists')) badges.push(`<span class="badge warn">You may have added this already${it.twin ? ': “' + esc(it.twin) + '”' : ''}</span>`);
      if (it.flags.includes('ignored')) badges.push('<span class="badge">You ignored this before</span>');
      if (it.flags.includes('person') && !it.link) badges.push('<span class="badge info">Payment to a person — pick a category and it’s remembered</span>');
      if (it.flags.includes('self')) badges.push('<span class="badge warn">Looks like a transfer to your own account</span>');
      if (it.flags.includes('atm')) badges.push('<span class="badge">ATM cash withdrawal</span>');
      if (it.category !== it.suggested && !it.link) badges.push('<span class="badge info">Category changed</span>');
      if (it.link && ruleById(it.link.ruleId)) badges.unshift(`<span class="badge rec">↻ ${it.link.auto ? 'Matches' : 'Linked to'} ${esc(ruleName(ruleById(it.link.ruleId)))}</span>`);
      const lo = linkOptions(it);
      return `<div class="sms-item ${it.selected ? '' : 'off'} ${it.link ? 'linked' : ''}" data-i="${i}">
        <input type="checkbox" data-f="selected" ${it.selected ? 'checked' : ''} aria-label="Include this payment">
        <div class="sms-main">
          <div class="sms-row1">
            <input class="sms-amt num" data-f="amount" inputmode="decimal" value="${it.amount}" aria-label="Amount">
            <select data-f="category" aria-label="Category">${catOptions(it.category)}</select>
          </div>
          <input data-f="merchant" value="${esc(it.merchant)}" placeholder="Note (who you paid)" maxlength="120" aria-label="Note">
          <div class="sms-row3">
            <input type="date" data-f="date" value="${it.date}" aria-label="Date">
            <select data-f="method" aria-label="Paid with">${methodOptions(it.method)}</select>
            <button type="button" class="linkish sms-show" data-show>View SMS</button>
          </div>
          ${lo ? `<label class="sms-link"><span>Recurring</span><select data-f="link" aria-label="Recurring payment this pays">${lo}</select></label>` : ''}
          ${linkNote(it)}
          <div class="sms-meta"><span>From ${esc(it.sender)}${it.acct ? ` · ••${esc(it.acct)}` : ''}</span>${badges.join('')}${it.link ? '' : `<button type="button" class="linkish" data-make-rec>↻ Make this recurring</button>`}</div>
          <pre class="sms-body" hidden>${esc(it.body)}</pre>
        </div>
      </div>`;
    }).join('');
  }
  $('smsRefunds').innerHTML = nRef ? `<div class="refund-head">Refunds</div><p class="muted small" style="margin:4px 6px 0">Money you got back. It’s taken off the expense it belongs to, so your totals show what things really cost.</p>`
    + sms.refunds.map((r, i) => `<div class="refund-item ${r.selected ? '' : 'off'}" data-ri="${i}">
        <input type="checkbox" data-rf="selected" ${r.selected ? 'checked' : ''} ${r.target ? '' : 'disabled'} aria-label="Apply this refund">
        <div class="sms-main">
          <div><b class="num">↩ ${money(r.amount)}</b> refund · ${esc(prettyDate(r.date, { day: 'numeric', month: 'short' }))}${r.merchant ? ` · ${esc(r.merchant)}` : ''}</div>
          <label class="small muted" style="display:flex;flex-direction:column;gap:4px">Take it off<select data-rf="target">${refundOptions(r)}</select></label>
          <div class="sms-meta"><span>From ${esc(r.sender)}</span><button type="button" class="linkish sms-show" data-show>View SMS</button></div>
          <pre class="sms-body" hidden>${esc(r.body)}</pre>
        </div>
      </div>`).join('') : '';
  $('smsUnread').innerHTML = sms.unread.length
    ? `<details class="sms-unread"><summary><span><b>${sms.unread.length}</b> payment message${sms.unread.length === 1 ? '' : 's'} couldn’t be read <span class="muted">(no amount found)</span></span></summary>
        ${sms.unread.slice(0, 50).map((u, i) => `<div style="margin-top:10px"><div class="sms-meta"><span>${esc(prettyDate(u.date))} · ${esc(u.address)}</span><button type="button" class="linkish" data-add-unread="${i}">Add manually</button></div><pre class="sms-body">${esc(u.body)}</pre></div>`).join('')}
      </details>` : '';
  updateSmsBar();
}

function updateSmsBar() {
  const refs = (sms.refunds || []).filter((r) => r.selected && r.target);
  const on = !!(state.view === 'sms' && sms.scanned && (sms.items.length || (sms.refunds || []).length));
  $('smsBar').hidden = !on;
  document.body.classList.toggle('has-smsbar', on);
  if (!on) return;
  const sel = sms.items.filter((x) => x.selected && x.amount > 0);
  const nLinked = sel.filter((x) => x.link).length;
  $('smsSel').innerHTML = `<b>${sel.length}</b> of ${sms.items.length} selected · <b class="num">${money(sum(sel))}</b>${refs.length ? ` · ${refs.length} refund${refs.length === 1 ? '' : 's'}` : ''}`;
  const parts = [];
  if (sel.length - nLinked) parts.push(`${sel.length - nLinked} expense${sel.length - nLinked === 1 ? '' : 's'}`);
  if (nLinked) parts.push(`update ${nLinked} recurring`);
  if (refs.length) parts.push(`${refs.length} refund${refs.length === 1 ? '' : 's'}`);
  $('smsAdd').textContent = parts.length ? `Add ${parts.join(' + ')}` : 'Ignore all';
  $('smsAdd').disabled = false;
  $('smsToggleAll').textContent = sel.length === sms.items.length ? 'Select none' : 'Select all';
}

$('smsPick').addEventListener('click', () => { $('smsFile').value = ''; $('smsFile').click(); });
$('smsFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  $('smsFileInfo').textContent = 'Reading…';
  try {
    sms.messages = parseSmsBackup(await f.text());
    sms.fileName = f.name;
    sms.scanned = false; sms.items = [];
    renderSms(); renderSmsResults();
    toast(`Loaded ${sms.messages.length.toLocaleString('en-IN')} messages`);
  } catch (err) {
    sms.messages = null; renderSms();
    await dialog({ title: 'Can’t read this file', html: `<p>${esc(err.message)}</p>` });
  }
});
$('smsPresets').addEventListener('click', (e) => { const b = e.target.closest('[data-preset]'); if (b) setPreset(b.dataset.preset); });
['smsFrom', 'smsTo'].forEach((id) => $(id).addEventListener('input', () => { sms.preset = 'custom'; document.querySelectorAll('#smsPresets .chip').forEach((c) => c.classList.remove('selected')); }));

$('smsScan').addEventListener('click', () => {
  const from = $('smsFrom').value, to = $('smsTo').value;
  if (!from || !to) { toast('Choose both dates'); return; }
  if (from > to) { toast('“From” is after “To”'); return; }
  const msgs = useNativeSms() ? native.readSms(dayStartMs(from), dayEndMs(to), smsCfg().skipPersonal) : sms.messages;
  const r = analyzeSms(msgs || [], { from, to, cfg: smsAnalyzeCfg(), existing: state.expenses });
  markIgnored(r.items);
  prepareLinks(r.items);
  r.refunds = prepareRefunds(r.refunds, state.meta.smsDismissed || {});
  Object.assign(sms, r, { scanned: true, mode: 'manual' });
  renderSmsResults();
  $('smsResults').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('smsList').addEventListener('input', (e) => {
  const row = e.target.closest('[data-i]'); const f = e.target.dataset.f; if (!row || !f) return;
  const it = sms.items[Number(row.dataset.i)];
  if (f === 'selected') { it.selected = e.target.checked; row.classList.toggle('off', !it.selected); }
  else if (f === 'amount') it.amount = parseAmount(e.target.value);
  else if (f === 'link') {
    const r = e.target.value ? ruleById(e.target.value) : null;
    const occ = r ? nearestOccurrence(r, it.date, state.expenses, 45, takenLinks(it)) : null;
    if (r && !occ) { toast(`No ${ruleName(r)} entry near ${prettyDate(it.date)} to link to`); renderSmsResults(); return; }
    it.link = occ ? { ruleId: r.id, occ: occ.occ, auto: false } : null;
    if (it.link) { it.flags = it.flags.filter((x) => x !== 'exists'); it.selected = true; }
    renderSmsResults(); return;
  }
  else it[f] = e.target.value;
  if (f === 'category') renderSmsResults(); else if (f === 'amount' && it.link) { updateSmsBar(); const n = row.querySelector('.link-note'); if (n) n.outerHTML = linkNote(it); } else updateSmsBar();
});
$('smsList').addEventListener('click', (e) => {
  const mk = e.target.closest('[data-make-rec]');
  if (mk) {
    // Turn this payment into a recurring one; the form starts filled in from the SMS.
    const it = sms.items[Number(mk.closest('[data-i]').dataset.i)];
    openRule(null);
    state.ruleFromSms = it;
    $('rAmount').value = it.amount;
    $('rNote').value = (it.merchant || '').trim();
    $('rFreq').value = 'monthly'; $('rInterval').value = 1;
    $('rStart').value = it.date;
    $('rMethod').innerHTML = methodOptions(it.method);
    state.selRuleCat = it.category; $('rCats').innerHTML = chipsHtml(state.selRuleCat);
    updateRulePreview();
    $('rSmsNote').hidden = false;
    return;
  }
  const b = e.target.closest('[data-show]'); if (!b) return;
  const pre = b.closest('.sms-main').querySelector('.sms-body');
  pre.hidden = !pre.hidden; b.textContent = pre.hidden ? 'View SMS' : 'Hide SMS';
});
$('smsRefunds').addEventListener('change', (e) => {
  const row = e.target.closest('[data-ri]'); const f = e.target.dataset.rf; if (!row || !f) return;
  const r = sms.refunds[Number(row.dataset.ri)];
  if (f === 'selected') r.selected = e.target.checked;
  else { r.target = e.target.value; r.selected = !!r.target; }
  renderSmsResults();
});
$('smsRefunds').addEventListener('click', (e) => {
  const b = e.target.closest('[data-show]'); if (!b) return;
  const pre = b.closest('.sms-main').querySelector('.sms-body');
  pre.hidden = !pre.hidden; b.textContent = pre.hidden ? 'View SMS' : 'Hide SMS';
});
$('smsUnread').addEventListener('click', (e) => {
  const b = e.target.closest('[data-add-unread]'); if (!b) return;
  const u = sms.unread[Number(b.dataset.addUnread)];
  openExpense(null);
  $('fDate').value = u.date;
});
$('smsToggleAll').addEventListener('click', () => {
  const all = sms.items.every((x) => x.selected);
  sms.items.forEach((x) => (x.selected = !all));
  renderSmsResults();
});

$('smsAdd').addEventListener('click', async () => {
  const picked = sms.items.filter((x) => x.selected && x.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(x.date));
  const linked = picked.filter((x) => x.link && ruleById(x.link.ruleId));
  const chosen = picked.filter((x) => !linked.includes(x));
  const refs = (sms.refunds || []).filter((r) => r.selected && r.target);
  const now = Date.now();
  // SMS that pay a recurring payment update that entry (or record it early) instead of adding another.
  const recUpdates = [], ruleUpdates = new Map();
  linked.forEach((x) => {
    const r = ruleUpdates.get(x.link.ruleId) || ruleById(x.link.ruleId);
    const id = expenseIdFor(r.id, x.link.occ);
    const base = state.expenses.find((e) => e.id === id) || { id, category: r.category, note: r.note, recurringId: r.id, createdAt: now };
    recUpdates.push(normalizeExpense({ ...base, amount: x.amount, date: x.date, method: x.method, smsKey: x.key, smsSender: x.sender, source: 'sms', dueDate: x.link.occ, updatedAt: now }));
    if (!r.lastGenerated || x.link.occ > r.lastGenerated) ruleUpdates.set(r.id, normalizeRule({ ...r, lastGenerated: x.link.occ, updatedAt: now }));
  });
  const expenses = chosen.map((x) => normalizeExpense({
    id: x.key, amount: x.amount, date: x.date, category: x.category, method: x.method,
    note: (x.merchant || '').trim(), source: 'sms', smsSender: x.sender, createdAt: now, updatedAt: now,
  })).filter(Boolean);

  // Learn: a changed category becomes a rule for that merchant.
  const cfg = smsCfg();
  let learned = 0;
  if (cfg.learn) {
    chosen.forEach((x) => {
      const k = merchantKey(x.merchant);
      if (!k || k.length < 3 || x.category === x.suggested || x.atm) return;
      cfg.rules = cfg.rules.filter((r) => r.k !== k);
      cfg.rules.unshift({ k, c: x.category, mine: true });
      learned++;
    });
  }
  // Refunds: taken off the expense they belong to.
  const touched = new Map();
  refs.forEach((r) => {
    const base = touched.get(r.target) || state.expenses.find((e) => e.id === r.target) || expenses.find((e) => e.id === r.target);
    if (!base) return;
    const upd = normalizeExpense({ ...base, refunds: [...(base.refunds || []), { amount: r.amount, date: r.date, key: r.key, note: 'Refund from SMS' }], updatedAt: now });
    touched.set(upd.id, upd);
  });
  // Whatever was left unticked is remembered as "ignored", so the app doesn't ask about it again.
  const added = new Set(picked.map((x) => x.key).concat(refs.map((r) => r.key)));
  const leftOver = sms.items.filter((x) => !added.has(x.key)).concat((sms.refunds || []).filter((r) => !added.has(r.key)));
  const dismissed = pruneDismissed({ ...(state.meta.smsDismissed || {}) });
  leftOver.forEach((x) => (dismissed[x.key] = now));
  const all = expenses.concat(recUpdates, [...touched.values()]);
  const rulesChanged = [...ruleUpdates.values()];
  if (!(await persist({ expenses: all, recurring: rulesChanged, meta: { settings: state.settings, smsDismissed: dismissed } }))) return;
  state.meta.smsDismissed = dismissed;
  upsertLocal('expenses', all);
  if (rulesChanged.length) upsertLocal('rules', rulesChanged);
  addMissingCategories(expenses.map((x) => x.category));
  sms.items = []; sms.refunds = [];
  state.smsPending = null;
  sms.skipped.imported += added.size;
  renderSmsResults(); renderSmsCustom();
  const msg = [];
  if (expenses.length) msg.push(`Added ${expenses.length} expense${expenses.length === 1 ? '' : 's'} (${money(sum(expenses))})`);
  if (recUpdates.length) msg.push(`${recUpdates.length} recurring updated`);
  if (touched.size) msg.push(`${refs.length} refund${refs.length === 1 ? '' : 's'} applied`);
  if (leftOver.length) msg.push(`${leftOver.length} ignored`);
  if (learned) msg.push(`learned ${learned} rule${learned === 1 ? '' : 's'}`);
  toast(msg.join(' · ') || 'Done');
  if (sms.mode === 'auto') setTimeout(() => { if (state.view === 'sms') location.hash = '#home'; }, 900);
  setTimeout(() => checkBudgetAlerts(), 2700);
});


// ── Reading SMS on the phone (Android app) ──
const dayStartMs = (iso) => parseIso(iso).getTime();
const dayEndMs = (iso) => parseIso(iso).getTime() + 86400000 - 1;

function pruneDismissed(d) {
  const cutoff = Date.now() - 200 * 86400000;
  for (const k in d) if (d[k] < cutoff) delete d[k];
  return d;
}
function markIgnored(items) {
  const d = state.meta.smsDismissed || {};
  items.forEach((it) => { if (d[it.key] && !it.flags.includes('ignored')) { it.flags.push('ignored'); it.selected = false; } });
}
async function setMeta(obj) {
  Object.assign(state.meta, obj);
  await writeBatch({ meta: obj }).catch(console.error);
}

// Prominent disclosure shown BEFORE Android's permission prompt (Google Play requirement).
const SMS_DISCLOSURE = `
  <p>Expense Manager can read the <b>SMS messages on this phone</b> to find payment messages from your bank, cards and UPI apps — like “Rs 450 debited … to Zomato” — and suggest them as expenses.</p>
  <ul class="dlg-list">
    <li><b>Stays on your phone.</b> Messages are read and analysed only on this device. The app has no internet access, so they’re never uploaded or shared.</li>
    <li><b>Only payments are used.</b> Personal messages and OTPs are skipped, and no message text is saved — only the expenses you confirm.</li>
    <li><b>You decide.</b> Each time you open the app it checks for new payment messages and asks you. Nothing is added until you confirm.</li>
    <li><b>Optional.</b> Everything else works without it, and you can turn it off any time in Settings.</li>
  </ul>`;

/** The whole "turn on SMS reading" flow. Returns true if SMS reading is now on. */
async function smsEnableFlow() {
  if (!isNative) return false;
  let st = native.smsState();
  if (st === 'unavailable') { toast('Reading SMS isn’t available on this device'); return false; }
  if (st !== 'granted') {
    const blocked = st === 'blocked';
    const { value } = await dialog({
      title: 'Add expenses from your SMS?',
      html: SMS_DISCLOSURE + (blocked ? '<p class="muted small">SMS access was turned off earlier, so Android needs you to switch it on in Settings: <b>Permissions → SMS → Allow</b>.</p>' : ''),
      actions: [{ label: 'Not now', value: false }, { label: blocked ? 'Open settings' : 'Continue', value: true, kind: 'primary' }],
    });
    await setMeta({ smsIntroDone: true });
    renderSmsIntro();
    if (!value) return false;
    if (blocked) { native.openSettings(); return false; }
    st = await native.requestSms();
    if (st !== 'granted') {
      toast(st === 'blocked' ? 'SMS access is off. You can switch it on later in Settings.' : 'No problem — you can turn this on later in Settings.');
      renderAll();
      return false;
    }
  }
  await setMeta({ smsAuto: true, smsIntroDone: true });
  state.smsLastState = 'granted';
  renderAll();
  toast('SMS reading is on');
  if (!state.meta.smsHistoryAsked) await askSmsHistory();
  setTimeout(() => smsStartupCheck(true), 400);
  return true;
}

/** Ask once how far back to look for payments in old messages. */
async function askSmsHistory() {
  const opt = (n, label) => ({ label, value: String(n) });
  const { value } = await dialog({
    title: 'Import past payments from SMS?',
    html: '<p>The app can also look for payments in your older messages, so your history and month-to-month comparisons are complete from day one.</p><p class="muted small">You’ll review everything before it’s added. You can also import any dates later from Settings → Find payments in SMS.</p>',
    actions: [opt(0, 'This month only'), opt(1, 'Last 2 months'), opt(2, 'Last 3 months', 'primary'), opt(5, 'Last 6 months')].map((a, i) => ({ ...a, kind: i === 2 ? 'primary' : 'ghost' })),
  });
  const back = value === null ? 0 : Number(value);
  const since = shiftMonth(ymOf(new Date()), -back) + '-01';
  // Never move the start later than an earlier choice.
  await setMeta({ smsHistoryAsked: true, smsSince: state.meta.smsSince && state.meta.smsSince < since && state.meta.smsHistoryAsked ? state.meta.smsSince : since });
}

let smsChecking = false;
/**
 * Runs when the app opens (and when it comes back after a while): reads new SMS,
 * finds payments not yet added or ignored, and asks the user. force = say so if none.
 */
async function smsStartupCheck(force = false) {
  if (!isNative || smsChecking) return;
  if (native.smsState() !== 'granted' || state.meta.smsAuto === false) return;
  // Never interrupt something the user is doing.
  if (!$('dialog').hidden || sheetOpen() || state.view === 'sms') return;
  smsChecking = true;
  state.smsLastCheck = Date.now();
  try {
    if (!state.meta.smsSince) await setMeta({ smsSince: ymOf(new Date()) + '-01' });
    const today = todayIso();
    if (!state.meta.smsHistoryAsked) { smsChecking = false; await askSmsHistory(); smsChecking = true; }
    const from = [state.meta.smsSince, addDays(today, -200)].sort().pop(); // look back at most ~6 months
    const msgs = native.readSms(dayStartMs(from), Date.now(), smsCfg().skipPersonal);
    const r = analyzeSms(msgs, { from, to: today, cfg: smsAnalyzeCfg(), existing: state.expenses });
    const dismissed = state.meta.smsDismissed || {};
    const fresh = r.items.filter((i) => !dismissed[i.key]);
    prepareLinks(fresh);
    const wanted = fresh.filter((i) => i.selected);
    const refunds = prepareRefunds(r.refunds.filter((x) => !dismissed[x.key]));
    const refundsWanted = refunds.filter((x) => x.selected);
    if (!wanted.length && !refundsWanted.length) { state.smsPending = null; renderSmsReview(); if (force) toast('No new payments in your SMS'); return; }
    // Shown as a strip on Home instead of a popup, so it never interrupts.
    state.smsPending = { r: { ...r, items: fresh, refunds }, from, to: today, n: wanted.length, nRef: refundsWanted.length, total: sum(wanted) };
    renderSmsReview();
    if (force && state.view !== 'home') toast(`Found ${wanted.length} new payment${wanted.length === 1 ? '' : 's'} — see Home`);
  } catch (e) { console.error(e); }
  finally { smsChecking = false; }
}

function renderSmsReview() {
  const p = state.smsPending, el = $('smsReview');
  el.hidden = !p;
  if (!p) return;
  const parts = [];
  if (p.n) parts.push(`${p.n} payment${p.n === 1 ? '' : 's'}`);
  if (p.nRef) parts.push(`${p.nRef} refund${p.nRef === 1 ? '' : 's'}`);
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z"/></svg><span class="rs-text">${parts.join(' and ')} from SMS to review${p.n ? ` <span class="muted num">· ${esc(money(p.total))}</span>` : ''}</span><span class="rs-go">Review</span><span class="rs-x" data-rs-close role="button" aria-label="Hide until next time">×</span>`;
  el.setAttribute('aria-label', `${parts.join(' and ')} from SMS to review`);
}
$('smsReview').addEventListener('click', (e) => {
  if (e.target.closest('[data-rs-close]')) { state.smsPending = null; renderSmsReview(); toast('Hidden until you next open the app'); return; }
  const p = state.smsPending; if (!p) return;
  Object.assign(sms, p.r, { scanned: true, mode: 'auto', useFile: false });
  $('smsFrom').value = p.from; $('smsTo').value = p.to; sms.preset = 'custom';
  location.hash = '#sms';
  setTimeout(() => { renderSmsResults(); $('smsResults').scrollIntoView({ block: 'start' }); }, 50);
});

function renderSmsIntro() {
  const show = isNative && !state.meta.smsIntroDone && !['granted', 'unavailable'].includes(native.smsState());
  $('smsIntro').hidden = !show;
}

function renderSmsSettings() {
  if (!isNative) { $('smsSettingsNative').hidden = true; $('smsSettingsWeb').hidden = false; return; }
  $('smsSettingsNative').hidden = false; $('smsSettingsWeb').hidden = true;
  const st = native.smsState(), on = st === 'granted';
  $('smsPermLine').innerHTML = on
    ? '✓ <b>On.</b> The app can read payment messages on this phone. They’re analysed on the phone only.'
    : st === 'unavailable' ? 'Reading SMS isn’t available on this device or in this version. You can still import an SMS backup file.'
    : '<b>Off.</b> Let the app find bank, card and UPI payments in your SMS and suggest them as expenses.';
  $('smsAutoWrap').hidden = !on;
  $('smsAutoToggle').checked = state.meta.smsAuto !== false;
  $('smsTurnOn').hidden = on || st === 'unavailable';
  $('smsTurnOff').hidden = !on;
}

$('smsIntroYes').addEventListener('click', () => smsEnableFlow());
$('smsIntroNo').addEventListener('click', async () => { await setMeta({ smsIntroDone: true }); renderSmsIntro(); toast('You can turn this on any time in Settings'); });
$('smsTurnOn').addEventListener('click', () => smsEnableFlow());
$('smsNativeAllow').addEventListener('click', async () => { if (await smsEnableFlow()) { sms.useFile = false; renderSms(); } });
$('smsAutoToggle').addEventListener('change', async (e) => {
  await setMeta({ smsAuto: e.target.checked });
  toast(e.target.checked ? 'The app will check for new payments when it opens' : 'Automatic checks are off. You can still import from SMS here.');
});
$('smsTurnOff').addEventListener('click', async () => {
  const { value } = await dialog({
    title: 'Turn off SMS reading?',
    html: '<p>The app will stop checking your messages. To remove its access completely, open the app’s Android settings and choose <b>Permissions → SMS → Don’t allow</b>.</p><p class="muted small">Expenses you already added stay as they are.</p>',
    actions: [{ label: 'Cancel', value: null }, { label: 'Stop checking only', value: 'auto' }, { label: 'Open settings', value: 'settings', kind: 'primary' }],
  });
  if (!value) return;
  await setMeta({ smsAuto: false });
  renderSmsSettings();
  if (value === 'settings') native.openSettings();
});
$('smsFileToggle').addEventListener('click', () => { sms.useFile = true; sms.scanned = false; renderSms(); renderSmsResults(); });
document.addEventListener('click', (e) => { if (e.target.id === 'smsUsePhone') { sms.useFile = false; sms.scanned = false; renderSms(); renderSmsResults(); } });

// ── Customisation ──
function renderSmsCustom() {
  const cfg = smsCfg();
  $('ruleCat').innerHTML = catOptions($('ruleCat').value || state.settings.categories[0]?.name);
  $('smsDefCat').innerHTML = catOptions(cfg.defaultCategory);
  $('smsDefMethod').innerHTML = methodOptions(cfg.defaultMethod);
  $('smsLearn').checked = cfg.learn;
  $('smsSkipPersonal').checked = cfg.skipPersonal;
  $('smsAtm').checked = cfg.includeAtm;
  if (document.activeElement !== $('smsIgnore')) $('smsIgnore').value = cfg.ignoreWords.join(', ');
  if (document.activeElement !== $('smsSkipSenders')) $('smsSkipSenders').value = cfg.skipSenders.join(', ');
  const q = $('ruleSearch').value.trim().toLowerCase();
  const groups = new Map();
  cfg.rules.forEach((r, i) => {
    if (q && !r.k.includes(q) && !r.c.toLowerCase().includes(q)) return;
    if (!groups.has(r.c)) groups.set(r.c, []);
    groups.get(r.c).push({ ...r, i });
  });
  $('ruleGroups').innerHTML = groups.size ? [...groups.entries()].map(([c, rs]) => `
    <div class="rule-group"><div class="rule-group-name"><span class="dot" style="background:${catColor(c)}"></span>${esc(c)} <span class="muted small">(${rs.length})</span></div>
    <div class="rule-chips">${rs.map((r) => `<span class="rule-chip ${r.mine ? 'mine' : ''}">${esc(r.k)}<button type="button" data-del-rule="${r.i}" aria-label="Remove ${esc(r.k)}">×</button></span>`).join('')}</div></div>`).join('')
    : `<p class="muted small">${q ? 'No rules match your search.' : 'No rules yet.'}</p>`;
}
async function saveSms() { await persist({ meta: { settings: state.settings } }); renderSmsCustom(); }
const csvList = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);

$('ruleAddForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const k = $('ruleKw').value.trim().toLowerCase().slice(0, 60), c = $('ruleCat').value;
  if (!k) return;
  const cfg = smsCfg();
  cfg.rules = cfg.rules.filter((r) => r.k !== k);
  cfg.rules.unshift({ k, c, mine: true });
  $('ruleKw').value = '';
  saveSms(); toast(`“${k}” → ${c}`);
});
$('ruleSearch').addEventListener('input', renderSmsCustom);
$('ruleGroups').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del-rule]'); if (!b) return;
  smsCfg().rules.splice(Number(b.dataset.delRule), 1); saveSms();
});
$('ruleReset').addEventListener('click', async () => {
  const { value } = await dialog({ title: 'Reset category rules?', html: '<p>Your own and learned rules will be removed and the built-in list restored. Other SMS settings stay as they are.</p>', actions: [{ label: 'Cancel', value: false }, { label: 'Reset', value: true, kind: 'danger solid' }] });
  if (!value) return;
  smsCfg().rules = defaultSmsSettings().rules; saveSms(); toast('Rules reset');
});
$('smsLearn').addEventListener('change', (e) => { smsCfg().learn = e.target.checked; saveSms(); });
$('smsSkipPersonal').addEventListener('change', (e) => { smsCfg().skipPersonal = e.target.checked; saveSms(); });
$('smsAtm').addEventListener('change', (e) => { smsCfg().includeAtm = e.target.checked; saveSms(); });
$('smsDefCat').addEventListener('change', (e) => { smsCfg().defaultCategory = e.target.value; saveSms(); });
$('smsDefMethod').addEventListener('change', (e) => { smsCfg().defaultMethod = e.target.value; saveSms(); });
$('smsIgnore').addEventListener('change', (e) => { smsCfg().ignoreWords = csvList(e.target.value); saveSms(); });
$('smsSkipSenders').addEventListener('change', (e) => { smsCfg().skipSenders = csvList(e.target.value).map((x) => x.toUpperCase()); saveSms(); });

// ─── Trends screen ────────────────────────────────────────────────────────────
const trends = createTrends({ state, money, catColor, isExcluded, sum, amt, catIcon, txHtml: (e) => txHtml(e, true) });

// ─── Insights (top of the Insights tab) ───────────────────────────────────────
function renderInsights() {
  const ym = state.month, cur = ymOf(new Date());
  const m = monthStats(ym);
  const prevYm = shiftMonth(ym, -1);
  const prevAll = spendOf(monthExpenses(prevYm));
  // For the month in progress, compare with the same days of last month (fairer than a whole month).
  const sameDays = ym === cur ? prevAll.filter((e) => Number(e.date.slice(8)) <= m.elapsed) : prevAll;
  const prevTotal = sum(sameDays);
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(ym, i - 5)).map((x) => ({ ym: x, total: sum(spendOf(monthExpenses(x))) }));
  const maxM = Math.max(1, ...months.map((x) => x.total));
  let pill = '';
  if (prevTotal > 0) { const p = ((m.total - prevTotal) / prevTotal) * 100; pill = `<span class="pill ${p > 0 ? 'up' : 'down'}">${p > 0 ? '↑' : '↓'} ${Math.abs(p).toFixed(0)}% vs ${esc(monthName(prevYm, { month: 'short' }))}${ym === cur ? ' (same days)' : ''}</span>`; }
  const card1 = `<div class="ins-card">
    <div class="ins-head"><div><div class="muted small">${esc(monthName(ym))}${ym === cur ? ' so far' : ''}</div><div class="ins-big num">${money(m.total)}</div></div>${pill}</div>
    <div class="mbars" role="group" aria-label="Spending in the last 6 months">${months.map((x) => `<button class="mbar ${x.ym === ym ? 'on' : ''}" data-ym="${x.ym}" aria-label="${esc(monthName(x.ym))}: ${esc(money(x.total))}"><span class="num">${esc(money(x.total, true))}</span><i style="height:${Math.max(3, (x.total / maxM) * 92)}px"></i><span>${esc(monthName(x.ym, { month: 'short' }))}</span></button>`).join('')}</div>
  </div>`;

  // Highlights in plain words
  const hl = [];
  const by = byCategory(m.list), byPrev = byCategory(sameDays);
  state.settings.categories.forEach((c) => {
    if (c.budget > 0 && !c.excluded && (by[c.name] || 0) > c.budget) hl.push({ cls: 'bad', sym: '!', text: `<b>${esc(c.name)}</b> is over its budget by <b class="num">${money(by[c.name] - c.budget)}</b>.` });
  });
  if (state.settings.budget > 0 && m.total > state.settings.budget) hl.push({ cls: 'bad', sym: '!', text: `You’re over the monthly budget by <b class="num">${money(m.total - state.settings.budget)}</b>.` });
  const diffs = Object.keys({ ...by, ...byPrev }).map((c) => ({ c, d: (by[c] || 0) - (byPrev[c] || 0), p: byPrev[c] || 0 }));
  const up = diffs.filter((x) => x.d >= Math.max(300, x.p * 0.2)).sort((a, b) => b.d - a.d)[0];
  const down = diffs.filter((x) => -x.d >= Math.max(300, x.p * 0.2)).sort((a, b) => a.d - b.d)[0];
  const vs = `${monthName(prevYm, { month: 'long' })}${ym === cur ? ' (same days)' : ''}`;
  if (up) hl.push({ cls: 'up', sym: '↑', text: `<b>${esc(up.c)}</b> is up <b class="num">${money(up.d)}</b> compared with ${esc(vs)}.` });
  if (down) hl.push({ cls: 'down', sym: '↓', text: `<b>${esc(down.c)}</b> is down <b class="num">${money(-down.d)}</b>${down.p ? ` (${Math.round((-down.d / down.p) * 100)}%)` : ''} compared with ${esc(vs)}.` });
  if (m.list.length >= 8 && m.total > 0) {
    const we = sum(m.list.filter((e) => [0, 6].includes(parseIso(e.date).getDay())));
    const share = Math.round((we / m.total) * 100);
    if (share >= 35) hl.push({ cls: '', sym: '%', text: `Weekends make up <b>${share}%</b> of your spending this month.` });
  }
  const biggest = m.list.slice().sort((a, b) => amt(b) - amt(a))[0];
  if (biggest) hl.push({ cls: '', sym: '★', text: `Biggest expense: <b class="num">${money(amt(biggest))}</b> · ${esc(biggest.note || biggest.category)} on ${esc(prettyDate(biggest.date, { day: 'numeric', month: 'short' }))}.` });
  if (m.refunded > 0) hl.push({ cls: 'down', sym: '↩', text: `<b class="num">${money(m.refunded)}</b> came back as refunds.` });
  const card2 = hl.length ? `<div class="ins-card"><h2 style="margin-bottom:4px">Highlights</h2>${hl.slice(0, 5).map((h) => `<div class="hl"><span class="sym ${h.cls}" aria-hidden="true">${h.sym}</span><span>${h.text}</span></div>`).join('')}</div>` : '';

  // Top shops and people
  const pay = new Map();
  m.list.forEach((e) => {
    const n = (e.note || '').trim(); if (!n || !amt(e)) return;
    const k = merchantKey(n) || n.toLowerCase();
    const g = pay.get(k) || { name: n, total: 0, count: 0 };
    g.total += amt(e); g.count++; pay.set(k, g);
  });
  const top = [...pay.values()].sort((a, b) => b.total - a.total).slice(0, 5);
  const card3 = top.length ? `<div class="ins-card"><h2 style="margin-bottom:6px">Where you spent most</h2>${top.map((t) => `<div class="tm"><div class="tm-top"><span>${esc(t.name)} <span class="muted">· ${t.count}×</span></span><b class="num">${money(t.total)}</b></div><div class="progress"><span style="width:${(t.total / top[0].total) * 100}%"></span></div></div>`).join('')}</div>` : '';

  $('insTop').innerHTML = m.all.length || months.some((x) => x.total) ? card1 + card2 + card3 : `<div class="ins-card"><div class="empty">Add a few expenses and your insights will show up here.</div></div>`;
}
$('insTop').addEventListener('click', (e) => {
  const b = e.target.closest('.mbar[data-ym]'); if (!b) return;
  state.month = b.dataset.ym; trends.open(state.month); renderInsights(); trends.render();
});

// ─── Search across all months ─────────────────────────────────────────────────
const q = { text: '', period: 'all', cat: '', method: '', sort: 'new', from: '', to: '', limit: 200 };
function searchRange() {
  const t = todayIso(), ym = ymOf(new Date());
  if (q.period === 'month') return [ym + '-01', '9999-12-31'];
  if (q.period === '3m') return [shiftMonth(ym, -2) + '-01', '9999-12-31'];
  if (q.period === 'year') return [t.slice(0, 4) + '-01-01', '9999-12-31'];
  if (q.period === 'custom') return [q.from || '0000-01-01', q.to || '9999-12-31'];
  return ['0000-01-01', '9999-12-31'];
}
function renderSearch() {
  const names = [...new Set(state.settings.categories.map((c) => c.name).concat(state.expenses.map((e) => e.category)))];
  const methods = [...new Set(state.settings.methods.concat(state.expenses.map((e) => e.method)))];
  const catHtml = '<option value="">All categories</option>' + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  const mHtml = '<option value="">Any payment</option>' + methods.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  if ($('qCat')._h !== catHtml) { $('qCat').innerHTML = catHtml; $('qCat')._h = catHtml; }
  if ($('qMethod')._h !== mHtml) { $('qMethod').innerHTML = mHtml; $('qMethod')._h = mHtml; }
  $('qCat').value = q.cat; $('qMethod').value = q.method; $('qPeriod').value = q.period; $('qSort').value = q.sort;
  [['qCat', q.cat], ['qMethod', q.method], ['qPeriod', q.period !== 'all'], ['qSort', q.sort !== 'new']].forEach(([id, on]) => $(id).classList.toggle('on', !!on));
  $('qCustom').hidden = q.period !== 'custom';
  if ($('qInput').value !== q.text && document.activeElement !== $('qInput')) $('qInput').value = q.text;

  const [lo, hi] = searchRange();
  const words = q.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = state.expenses.filter((e) => e.date >= lo && e.date <= hi && (!q.cat || e.category === q.cat) && (!q.method || e.method === q.method)
    && words.every((w) => [e.note, e.category, e.method, String(e.amount), e.smsSender, prettyDate(e.date, { day: 'numeric', month: 'long', year: 'numeric' })].some((f) => String(f || '').toLowerCase().includes(w))));
  rows.sort(q.sort === 'old' ? (a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt
    : q.sort === 'big' ? (a, b) => amt(b) - amt(a) || b.date.localeCompare(a.date)
    : (a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  const filtering = words.length || q.cat || q.method || q.period !== 'all';
  $('qTotal').innerHTML = rows.length ? `<span>${rows.length.toLocaleString('en-IN')} expense${rows.length === 1 ? '' : 's'}${filtering ? '' : ' in total'}</span><b class="num">${money(sum(spendOf(rows)))}</b>` : '';
  if (!state.expenses.length) { $('qList').innerHTML = '<div class="empty">No expenses yet.</div>'; return; }
  if (!rows.length) { $('qList').innerHTML = `<div class="empty">Nothing found${words.length ? ` for “${esc(q.text.trim())}”` : ''}. <button class="linkish" data-action="q-clear">Clear search</button></div>`; return; }
  const shown = rows.slice(0, q.limit);
  $('qList').innerHTML = (q.sort === 'big' ? shown.map((e) => txHtml(e, true, true)).join('') : dayGroupsHtml(shown, { sticky: true }))
    + (rows.length > shown.length ? `<div style="text-align:center;padding:12px"><button class="btn ghost" data-action="q-more">Show ${Math.min(200, rows.length - shown.length)} more</button></div>` : '');
}
$('qInput').addEventListener('input', (e) => { q.text = e.target.value; q.limit = 200; renderSearch(); });
$('qPeriod').addEventListener('change', (e) => {
  q.period = e.target.value;
  if (q.period === 'custom' && !q.from) { q.from = shiftMonth(ymOf(new Date()), -1) + '-01'; q.to = todayIso(); $('qFrom').value = q.from; $('qTo').value = q.to; }
  renderSearch();
});
$('qCat').addEventListener('change', (e) => { q.cat = e.target.value; renderSearch(); });
$('qMethod').addEventListener('change', (e) => { q.method = e.target.value; renderSearch(); });
$('qSort').addEventListener('change', (e) => { q.sort = e.target.value; renderSearch(); });
$('qFrom').addEventListener('change', (e) => { q.from = e.target.value; renderSearch(); });
$('qTo').addEventListener('change', (e) => { q.to = e.target.value; renderSearch(); });

// ─── Automatic backup (Android) ───────────────────────────────────────────────
const AB_DEFAULT = { on: false, freqDays: 7, keep: 10, lastAt: 0, lastError: null, folder: '' };
const abState = () => ({ ...AB_DEFAULT, ...(state.meta.autoBackup || {}) });
function autoBackupHealthy() {
  const ab = abState();
  return isNative && ab.on && !ab.lastError && Date.now() - ab.lastAt < (ab.freqDays * 2 + 1) * 86400000;
}
/** Back up if due (or always when force). Returns true if a backup was written. */
async function runAutoBackup(force = false) {
  if (!isNative || !native.canAutoBackup()) return false;
  const ab = abState();
  if (!ab.on) return false;
  if (!force && Date.now() - ab.lastAt < ab.freqDays * 86400000 - 3600000) return false;
  if (!state.expenses.length && !state.rules.length) return false;
  const res = native.writeBackup(`expenses-autobackup_${isoDate(new Date())}.json`, backupText(), ab.keep);
  const ok = res === 'ok';
  const next = { ...ab, lastError: ok ? null : String(res || 'error'), lastAt: ok ? Date.now() : ab.lastAt };
  await setMeta(ok ? { autoBackup: next, lastBackupAt: Date.now() } : { autoBackup: next });
  if (state.view === 'home') renderBackupNudge();
  if (state.view === 'settings') renderAutoBackup();
  return ok;
}
function renderAutoBackup() {
  const box = $('autoBackupBox');
  box.hidden = !isNative;
  if (!isNative) return;
  if (!native.canAutoBackup()) {
    $('autoBackupLine').textContent = 'Automatic backup isn’t available in this app version.';
    ['autoBackupFreqWrap', 'autoBackupPick', 'autoBackupNow', 'autoBackupOff'].forEach((id) => ($(id).hidden = true));
    return;
  }
  $('autoBackupPick').hidden = false;
  const ab = abState();
  const folder = ab.on ? native.backupFolderName() : '';
  const on = ab.on && !!folder;
  $('autoBackupLine').innerHTML = !on
    ? 'Off. Choose a folder and the app saves a backup there automatically. Pick a folder on your phone (for example <b>Documents</b>), or Google Drive if it appears in the list.'
    : ab.lastError
      ? `<span class="up">Last attempt failed:</span> ${esc(ab.lastError)}. Choose the folder again.`
      : `✓ Saving to <b>${esc(folder)}</b> ${ab.freqDays === 1 ? 'every day' : 'every week'}${ab.lastAt ? ` · last ${esc(new Date(ab.lastAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }))}` : ''}.`;
  $('autoBackupFreqWrap').hidden = !on;
  $('autoBackupFreq').value = String(ab.freqDays);
  $('autoBackupKeep').value = String(ab.keep);
  $('autoBackupPick').textContent = on ? 'Change folder…' : 'Choose folder…';
  $('autoBackupNow').hidden = !on;
  $('autoBackupOff').hidden = !on;
}
$('autoBackupPick').addEventListener('click', async () => {
  const name = await native.chooseBackupFolder();
  if (!name) return;
  await setMeta({ autoBackup: { ...abState(), on: true, folder: name, lastError: null, lastAt: 0 } });
  const ok = await runAutoBackup(true);
  renderAutoBackup();
  toast(ok ? `Backups will be saved to ${name}` : 'Couldn’t save to that folder. Try another one.');
});
$('autoBackupNow').addEventListener('click', async () => toast((await runAutoBackup(true)) ? 'Backup saved' : 'Backup failed — choose the folder again'));
$('autoBackupOff').addEventListener('click', async () => {
  native.clearBackupFolder();
  await setMeta({ autoBackup: { ...abState(), on: false, lastError: null } });
  renderAutoBackup(); toast('Automatic backup is off');
});
$('autoBackupFreq').addEventListener('change', (e) => setMeta({ autoBackup: { ...abState(), freqDays: Number(e.target.value) } }).then(renderAutoBackup));
$('autoBackupKeep').addEventListener('change', (e) => setMeta({ autoBackup: { ...abState(), keep: Number(e.target.value) } }));
$('backupRemind').addEventListener('change', (e) => setMeta({ backupReminders: e.target.checked, backupSnoozeUntil: 0 }));

// ─── App lock (Android) ───────────────────────────────────────────────────────
function renderLock() {
  $('lockPanel').hidden = !isNative;
  if (!isNative) return;
  const ls = native.lockState() || { error: 'no response' };
  if (ls.error) {
    $('lockLine').innerHTML = `App lock couldn’t start (${esc(ls.error)}). Please send a screenshot of this to whoever maintains the app.`;
    $('lockToggle').disabled = true; $('lockDelayWrap').hidden = true;
    return;
  }
  $('lockLine').innerHTML = ls.available
    ? 'Protect your expenses with your fingerprint, face or your phone’s PIN/pattern.'
    : 'Set up a screen lock (PIN, pattern or fingerprint) in your phone’s settings first. Then you can lock this app.';
  $('lockToggle').checked = !!ls.enabled;
  $('lockToggle').disabled = !ls.available && !ls.enabled;
  $('lockDelayWrap').hidden = !ls.enabled;
  $('lockDelay').value = String(ls.delay);
}
$('lockToggle').addEventListener('change', async (e) => {
  const want = e.target.checked;
  const st = await native.setLock(want);
  renderLock();
  if (st && !!st.enabled === want) toast(want ? 'App lock is on' : 'App lock is off');
});
$('lockDelay').addEventListener('change', (e) => { native.setLockDelay(Number(e.target.value)); toast('Saved'); });

// ─── Sort "Other" ─────────────────────────────────────────────────────────────
const sortState = { choices: {} };
function sortGroups() {
  const groups = new Map();
  state.expenses.filter((e) => e.category === 'Other' && (e.note || '').trim()).forEach((e) => {
    const key = merchantKey(e.note) || e.note.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, name: e.note.trim(), items: [], total: 0 });
    const g = groups.get(key); g.items.push(e); g.total += Number(e.amount) || 0;
  });
  return [...groups.values()].sort((a, b) => b.total - a.total);
}
function renderSort() {
  const groups = sortGroups();
  const untitled = state.expenses.filter((e) => e.category === 'Other' && !(e.note || '').trim()).length;
  if (!groups.length) {
    $('sortList').innerHTML = `<div class="empty">Nothing to sort — “Other” has no named payments.${untitled ? `<br>${untitled} expense${untitled === 1 ? '' : 's'} without a note can be edited one by one.` : ''}</div>`;
    $('sortBar').hidden = true; return;
  }
  const opts = (sel) => '<option value="">Leave in Other</option>' + state.settings.categories.filter((c) => c.name !== 'Other').map((c) => `<option ${c.name === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  $('sortList').innerHTML = groups.map((g) => `
    <div class="sort-row">
      <div class="sort-main"><div class="tx-title">${looksLikePerson(g.name) ? '<span class="person" aria-label="Person">👤</span> ' : ''}${esc(g.name)}</div>
        <div class="tx-meta">${g.items.length} payment${g.items.length === 1 ? '' : 's'} · ${money(g.total)} · last ${esc(prettyDate(g.items.map((e) => e.date).sort().pop(), { day: 'numeric', month: 'short' }))}</div></div>
      <select data-key="${esc(g.key)}" aria-label="Category for ${esc(g.name)}">${opts(sortState.choices[g.key])}</select>
    </div>`).join('')
    + (untitled ? `<p class="muted small" style="margin:12px 4px 0">${untitled} expense${untitled === 1 ? '' : 's'} without a note aren’t shown — edit those one by one.</p>` : '');
  updateSortBar(groups);
}
function updateSortBar(groups = sortGroups()) {
  const chosen = groups.filter((g) => sortState.choices[g.key]);
  const n = chosen.reduce((a, g) => a + g.items.length, 0);
  $('sortBar').hidden = state.view !== 'sort' || !chosen.length;
  $('sortSel').innerHTML = `<b>${chosen.length}</b> name${chosen.length === 1 ? '' : 's'} · ${n} expense${n === 1 ? '' : 's'}`;
  document.body.classList.toggle('has-smsbar', state.view === 'sort' && chosen.length > 0);
}
$('sortList').addEventListener('change', (e) => {
  const k = e.target.dataset.key; if (!k) return;
  if (e.target.value) sortState.choices[k] = e.target.value; else delete sortState.choices[k];
  updateSortBar();
});
$('sortApply').addEventListener('click', async () => {
  const groups = sortGroups().filter((g) => sortState.choices[g.key]);
  if (!groups.length) return;
  const now = Date.now(), changed = [];
  const cfg = smsCfg();
  groups.forEach((g) => {
    const c = sortState.choices[g.key];
    g.items.forEach((e) => changed.push({ ...e, category: c, updatedAt: now }));
    if (g.key.length >= 3) { cfg.rules = cfg.rules.filter((r) => r.k !== g.key); cfg.rules.unshift({ k: g.key, c, mine: true }); }
  });
  if (!(await persist({ expenses: changed, meta: { settings: state.settings } }))) return;
  upsertLocal('expenses', changed);
  sortState.choices = {};
  toast(`Moved ${changed.length} expense${changed.length === 1 ? '' : 's'} · ${groups.length} name${groups.length === 1 ? '' : 's'} remembered for future SMS`);
  renderSort();
});

// ─── Global events ───────────────────────────────────────────────────────────
$('prevMonth').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); renderHome(); });
$('nextMonth').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); renderHome(); });
$('monthLabel').addEventListener('click', () => openMonthPicker());
const openTrends = () => { trends.open(state.month); location.hash = '#insights'; setTimeout(() => $('trendsTitle').scrollIntoView({ block: 'start' }), 80); };
$('dailyPanel').addEventListener('click', openTrends);
$('dailyPanel').addEventListener('keydown', (e) => { if (e.key === 'Enter') openTrends(); });

function openMonthPicker() {
  let year = Number(state.month.slice(0, 4));
  const withData = new Set(state.expenses.map((e) => e.date.slice(0, 7)));
  const cur = ymOf(new Date());
  const draw = (body, done) => {
    const months = Array.from({ length: 12 }, (_, i) => `${year}-${pad(i + 1)}`);
    body.innerHTML = `<div class="mp-year"><button class="icon-btn" data-y="-1" aria-label="Previous year">‹</button><b>${year}</b><button class="icon-btn" data-y="1" aria-label="Next year">›</button></div>
      <div class="mp-grid">${months.map((ym) => `<button class="mp-m ${ym === state.month ? 'on' : ''} ${ym === cur ? 'now' : ''}" data-ym="${ym}">${esc(monthName(ym, { month: 'short' }))}${withData.has(ym) ? '<i></i>' : ''}</button>`).join('')}</div>`;
    body.onclick = (e) => {
      const y = e.target.closest('[data-y]');
      if (y) { year += Number(y.dataset.y); draw(body, done); return; }
      const m = e.target.closest('[data-ym]');
      if (m) { state.month = m.dataset.ym; done(true); renderHome(); }
    };
  };
  dialog({ title: 'Choose month', html: '', actions: [{ label: 'Close', value: null }], onBody: draw });
}

$('fab').addEventListener('click', () => (state.view === 'recurring' ? openRule(null) : openExpense(null)));

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('[data-close]')) { closeSheets(); return; }
  if (t.classList && t.classList.contains('overlay') && t.id !== 'dialog') { closeSheets(); return; }
  const er = t.closest('[data-edit-rule]'); if (er) { openRule(er.dataset.editRule); return; }
  const tx = t.closest('.tx[data-id]');
  if (tx) {
    if (swipeMoved) return;
    const box = tx.closest('.swipe');
    if (box && box.classList.contains('open')) { closeSwipes(); return; }
    openExpense(tx.dataset.id); return;
  }
  const rr = t.closest('.tx[data-rule]'); if (rr) { openRule(rr.dataset.rule); return; }
  const cat = t.closest('.cat-row');
  if (cat && !cat.classList.contains('static')) {
    state.filterCat = state.filterCat === cat.dataset.cat ? 'all' : cat.dataset.cat; renderCategories(); renderList();
    if (state.filterCat !== 'all') setTimeout(() => document.querySelector('.tx-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
    return;
  }
  const act = t.closest('[data-action]');
  if (act) {
    const a = act.dataset.action;
    if (a === 'add') openExpense(null);
    else if (a === 'add-rule') openRule(null);
    else if (a === 'sort-other') location.hash = '#sort';
    else if (a === 'snooze-backup') { setMeta({ backupSnoozeUntil: Date.now() + 30 * 86400000 }); renderBackupNudge(); toast('Hidden for 30 days. Turn reminders off in Settings → Backup.'); }
    else if (a === 'clear') { state.filterCat = 'all'; renderCategories(); renderList(); }
    else if (a === 'q-clear') { Object.assign(q, { text: '', cat: '', method: '', period: 'all' }); $('qInput').value = ''; renderSearch(); }
    else if (a === 'q-more') { q.limit += 200; renderSearch(); }
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && $('dialog').hidden) closeSheets();
});

// Back button closes an open sheet instead of leaving the app.
window.addEventListener('popstate', () => { if (sheetOpen()) hideSheets(); });

boot();
