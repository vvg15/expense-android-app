// Recurring payment rules → dated expenses.
//
// Each rule remembers `lastGenerated` (the last date it produced an expense).
// Generated expenses get a deterministic id `rec:<ruleId>:<date>`, so running the
// generator twice, or importing a backup on top of existing data, never creates
// duplicates. Deleting a generated expense is respected: it isn't re-created,
// because only dates after `lastGenerated` are produced.

import { parseIso, isoDate, addDays, daysIn, pad, todayIso } from './util.js';
import { merchantKey } from './sms.js';

const MAX_OCCURRENCES = 3000; // safety cap (~8 years of daily payments)

function nth(rule, k) {
  const step = k * rule.interval;
  switch (rule.frequency) {
    case 'daily': return addDays(rule.startDate, step);
    case 'weekly': return addDays(rule.startDate, step * 7);
    case 'yearly': {
      const s = parseIso(rule.startDate);
      const y = s.getFullYear() + step, m = s.getMonth() + 1;
      const d = Math.min(s.getDate(), daysIn(`${y}-${pad(m)}`));
      return `${y}-${pad(m)}-${pad(d)}`;
    }
    case 'monthly':
    default: {
      const s = parseIso(rule.startDate);
      const first = new Date(s.getFullYear(), s.getMonth() + step, 1);
      const ym = `${first.getFullYear()}-${pad(first.getMonth() + 1)}`;
      return `${ym}-${pad(Math.min(s.getDate(), daysIn(ym)))}`;
    }
  }
}

/** Occurrence dates within [from, until] (inclusive), honouring endDate. */
export function occurrences(rule, until, from = null) {
  const out = [];
  for (let k = 0; k < MAX_OCCURRENCES; k++) {
    const d = nth(rule, k);
    if (d > until) break;
    if (rule.endDate && d > rule.endDate) break;
    if (!from || d >= from) out.push(d);
  }
  return out;
}

/** Next date this rule will add an expense, or null if finished/paused. */
export function nextDue(rule) {
  if (!rule.active) return null;
  for (let k = 0; k < MAX_OCCURRENCES; k++) {
    const d = nth(rule, k);
    if (rule.endDate && d > rule.endDate) return null;
    if (!rule.lastGenerated || d > rule.lastGenerated) return d;
  }
  return null;
}

export const expenseIdFor = (ruleId, date) => `rec:${ruleId}:${date}`;

/**
 * Produce expenses for every due occurrence up to today.
 * Returns { expenses: [...new], rules: [...rules whose lastGenerated moved] }.
 */
export function generateDue(rules, today = todayIso()) {
  const expenses = [], changed = [];
  const now = Date.now();
  for (const rule of rules) {
    if (!rule.active) continue;
    const dates = occurrences(rule, today).filter((d) => !rule.lastGenerated || d > rule.lastGenerated);
    if (!dates.length) continue;
    dates.forEach((date) => expenses.push({
      id: expenseIdFor(rule.id, date),
      amount: rule.amount, date, category: rule.category, method: rule.method, note: rule.note,
      recurringId: rule.id, createdAt: now, updatedAt: now,
    }));
    changed.push({ ...rule, lastGenerated: dates[dates.length - 1], updatedAt: now });
  }
  return { expenses, rules: changed };
}

const ORD = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

export function describe(rule) {
  const s = parseIso(rule.startDate);
  const n = rule.interval;
  const every = (unit) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);
  switch (rule.frequency) {
    case 'daily': return n === 1 ? 'Every day' : every('day');
    case 'weekly': return `${every('week')} on ${s.toLocaleDateString('en-IN', { weekday: 'long' })}`;
    case 'yearly': return `${every('year')} on ${s.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}`;
    default: return `${every('month')} on the ${ORD(s.getDate())}`;
  }
}

/** Approximate cost per month, for the summary line. */
export function monthlyEquivalent(rule) {
  const per = { daily: 30.44, weekly: 4.345, monthly: 1, yearly: 1 / 12 }[rule.frequency] || 1;
  return (rule.amount * per) / rule.interval;
}

export { isoDate };


// ─── Matching bank SMS to recurring payments (2.3.0) ─────────────────────────
const dayGap = (a, b) => Math.round((parseIso(a) - parseIso(b)) / 86400000);

/**
 * The entry of `rule` that an SMS paid on `date` most likely belongs to: the nearest
 * occurrence within ±maxDays that isn't already confirmed by another SMS.
 * Returns { ruleId, occ, expenseId, expected } or null. `expenseId` is null when that
 * occurrence hasn't been added yet (the bank took the money before the due date).
 */
export function nearestOccurrence(rule, date, expenses, maxDays = 45, taken = new Set()) {
  const byId = new Map(expenses.map((e) => [e.id, e]));
  let best = null;
  for (const occ of occurrences(rule, addDays(date, maxDays), addDays(date, -maxDays))) {
    const id = expenseIdFor(rule.id, occ);
    const e = byId.get(id);
    const generated = rule.lastGenerated && occ <= rule.lastGenerated;
    if (generated && !e) continue;            // the user deleted that entry
    if (e && e.smsKey) continue;              // already confirmed by an SMS
    if (taken.has(id)) continue;              // another SMS in this review claims it
    const gap = Math.abs(dayGap(occ, date));
    if (!best || gap < best.gap) best = { ruleId: rule.id, occ, expenseId: e ? id : null, expected: e ? Number(e.amount) : rule.amount, gap };
  }
  return best;
}

/**
 * Best recurring payment for an SMS payment, or null.
 * item: { date, amount, merchant, body }. A match needs either
 *  - the same amount within ±3 days, or
 *  - the same shop / person name and an amount within 25% (bills that change) within ±5 days.
 */
export function matchRecurring(item, rules, expenses, taken = new Set()) {
  const body = (item.body || '').toLowerCase();
  const mk = merchantKey(item.merchant || '');
  let best = null;
  for (const rule of rules) {
    if (!rule.active && !rule.lastGenerated) continue;
    const occ = nearestOccurrence(rule, item.date, expenses, 5, taken);
    if (!occ) continue;
    const rk = merchantKey(rule.note || '');
    const first = rk.split(' ')[0] || '';
    const nameHit = rk.length >= 3 && ((mk && (mk.includes(rk) || rk.includes(mk))) || body.includes(rk) || (first.length >= 4 && body.includes(first)));
    const exact = Math.abs(occ.expected - item.amount) < 0.01;
    const close = occ.expected > 0 && Math.abs(occ.expected - item.amount) / occ.expected <= 0.25;
    let score;
    if (exact && occ.gap <= 3) score = 6 + (nameHit ? 4 : 0);
    else if (nameHit && close && occ.gap <= 5) score = 5 + (exact ? 2 : 0);
    else continue;
    score -= occ.gap / 3;
    if (!best || score > best.score) best = { ...occ, score, exact, nameHit };
  }
  return best;
}
