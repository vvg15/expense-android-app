// Recurring payment rules → dated expenses.
//
// Each rule remembers `lastGenerated` (the last date it produced an expense).
// Generated expenses get a deterministic id `rec:<ruleId>:<date>`, so running the
// generator twice, or importing a backup on top of existing data, never creates
// duplicates. Deleting a generated expense is respected: it isn't re-created,
// because only dates after `lastGenerated` are produced.

import { parseIso, isoDate, addDays, daysIn, pad, todayIso } from './util.js';

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
