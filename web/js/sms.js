// Read bank / UPI / card SMS from an "SMS Backup & Restore" export (.xml) and turn
// debit messages into suggested expenses. Everything runs on the phone; nothing is
// stored except the expenses the user confirms.

import { isoDate, hash } from './util.js';

// ─── Reading the backup file ─────────────────────────────────────────────────
function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>';
    if (l === 'quot') return '"'; if (l === 'apos') return "'";
    const cp = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    try { return String.fromCodePoint(cp); } catch { return ''; }
  });
}

/** Returns received messages [{ address, ts, body }] sorted oldest → newest. */
export function parseSmsBackup(text) {
  if (!/<sms\b/i.test(text)) throw new Error('This doesn’t look like an SMS backup. Choose the .xml file made by “SMS Backup & Restore”.');
  const out = [];
  const tag = /<sms\b((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;
  let m;
  while ((m = tag.exec(text))) {
    const a = {};
    const attr = /([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let x;
    while ((x = attr.exec(m[1]))) a[x[1]] = x[2] !== undefined ? x[2] : x[3];
    if (a.type && a.type !== '1') continue; // 1 = received; skip sent/drafts
    const ts = Number(a.date);
    if (!ts || !a.body) continue;
    out.push({ address: decodeXml(a.address || ''), ts, body: decodeXml(a.body) });
  }
  if (!out.length) throw new Error('No received messages were found in this file.');
  out.sort((p, q) => p.ts - q.ts);
  return out;
}

// ─── Recognising transactions ────────────────────────────────────────────────
const RX = {
  otp: /\b(otp|one[\s-]?time[\s-]?pass(word|code)|verification code|auth(entication)? code|security code)\b/i,
  notPayment: /(will be debited|to be debited|would be debited|request(ed)?\s+(money|rs|inr|₹|for|of)|collect request|has requested|is due|due (on|by|date)|min(imum)?\.? (amt|amount)|total (amt|amount) due|payment reminder|bill (is )?generated|statement (for|is|of)|mandate (is )?(created|registered|set)|e-?mandate|\b(failed|declined|unsuccessful)\b|could not be|insufficient)/i,
  debit: /\b(debited|debit (of|by|for)|has a debit|spent|paid|sent|withdrawn|withdrawal|purchase|txn\.? of|transaction of|charged|deducted|dr\.?|used (for|at)|payment of|transferred|auto-?debit|processed payment)\b/i,
  strongDebit: /\b(debited|debit (of|by|for)|has a debit|spent|sent|withdrawn|withdrawal|purchase|txn\.? of|charged|deducted|dr\.?|used (for|at)|transferred|auto-?debit|processed payment)\b/i,
  credit: /\b(credited to (your|a\/c|ac|acct|account)|has been credited|is credited|received|deposited)\b/i,
  account: /(a\/c|acct|account|\bcard\b|\bupi\b|\bvpa\b|wallet|xx\d|x\d{3,}|\*\d{3,}|\bpos\b|\batm\b|neft|imps|rtgs|bank)/i,
};

function toNumber(s) { const n = Number(String(s).replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }

export function findAmount(body) {
  const re = /(?:rs\.?|inr|₹)\s*\.?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;
  let m;
  while ((m = re.exec(body))) {
    const before = body.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    if (/(bal|balance|limit|lmt|avl|available|outstanding|o\/s)[^a-z0-9]{0,4}(is|of|:)?[^a-z0-9]{0,4}$/.test(before)) continue;
    const v = toNumber(m[1]);
    if (v > 0) return v;
  }
  const f = body.match(/(?:debited|deducted|charged|spent|paid)\s+(?:by|for|with|of)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\b/i);
  return f ? toNumber(f[1]) : null;
}

export function findRef(body) {
  const m = body.match(/(?:ref(?:erence)?\.?\s*(?:no|num|number|id)?\.?|refno|utr(?:\s*no)?|rrn|txn\s*(?:id|no)|upi\s*(?:ref)?\s*(?:no)?)\s*[:.#-]?\s*([A-Z0-9]{6,})/i);
  return m && /\d{5,}/.test(m[1]) ? m[1].toUpperCase() : null;
}

const STOP = /^(rs\b|inr\b|a\/?c\b|ac\b|acct|account|your\b|the\b|you\b|upi\b|vpa\b|on\b|dispute|block|call|sms\b|bank\b|card\b|xx|self\b|mobile|beneficiary)/i;
const END = String.raw`(?=\s+on\b|\s+for\b|\s+via\b|\s+ref|\s+upi|\s+from\b|\s+avl|\s+dt\b|\.\s|\.$|,|;|\n|\(|$)`;
const MERCHANT_PATTERNS = [
  /\bon\s+\d[\w\/-]*\s+on\s+([A-Za-z0-9*][^.;\n]{1,40}?)(?=\.\s|\.$|;|\n|\s+avl|$)/i,
  /\bpayment of .{0,30}?\bto\s+(?:merchant\s+)?([A-Za-z][\w &.'*\-]{1,40}?)(?=,|\s+as per|\s+on\b|\.\s|$)/i,
  new RegExp(String.raw`(?:to|at|for)\s+vpa\s+([a-z0-9.\-_]+@[a-z0-9.]+)`, 'i'),
  /\b([a-z0-9.\-_]{3,}@[a-z]{2,}[a-z0-9.]*)/i,
  /;\s*([A-Za-z][\w &.'\-]{1,40}?)\s+credited/i,
  new RegExp(String.raw`\b(?:done )?at\s+([A-Za-z0-9][\w &.'*\-]{1,40}?)${END}`, 'i'),
  new RegExp(String.raw`\b(?:trf to|paid to|transfer(?:red)? to|sent to|to)\s+([A-Za-z][\w &.'\-]{1,40}?)${END}`, 'i'),
  new RegExp(String.raw`\btowards\s+([A-Za-z][\w &.'\-]{1,40}?)${END}`, 'i'),
  /\binfo[:\s-]+([A-Za-z0-9][^.;\n]{1,40})/i,
  /UPI\/(?:P2[AM]\/)?\d+\/([^\/\n]{2,30})/i,
  new RegExp(String.raw`\bfor\s+([A-Za-z][\w &.'*\-]{1,40}?)${END}`, 'i'),
];

function tidyName(s) {
  let n = s.replace(/^merchant\s+/i, '').replace(/\s+/g, ' ').replace(/[\s.,;:*\-]+$/, '').trim();
  if (n.includes('@')) return n.toLowerCase();
  if (n === n.toUpperCase() && /[A-Z]{3}/.test(n)) n = n.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
  return n.slice(0, 60);
}

export function findMerchant(body) {
  for (const re of MERCHANT_PATTERNS) {
    const m = body.match(re);
    if (m && m[1] && !STOP.test(m[1].trim()) && /[a-z]/i.test(m[1])) return tidyName(m[1]);
  }
  return '';
}

// Words that mean a business, not a person.
const BUSINESS = /\b(store|stores|mart|shop|foods?|bakery|hotel|restaurant|cafe|medicals?|pharma|enterprises?|traders?|trading|agency|agencies|services?|solutions|pvt|private|ltd|limited|llp|india|bank|company|co|corporation|industries|center|centre|motors?|fuels?|petroleum|textiles|electronics|hospital|clinic|school|college|academy|travels?|tours|systems|technologies|tech|retail|digital|payments?|wallet|recharge|bill|insurance|finance|fintech|kirana|provisions|vegetables?|fruits?|bhel|chicken|mutton|juice|tea|coffee|paint|plywoods?|hardware|works|associates|brothers|bros|sons|&)\b/i;

// Beginnings of business words, for names the bank cut short ("Haritha Vegetab").
const BUSINESS_STEM = /\b(vegeta|medica|enterpr|provisi|restaura|technolo|solutio|corporat|industr|electron|textil|hardwa|plywoo|petrol|pharma|supermar|hypermar|departm|foodwo|kitche|bakes|sweets|caterer)/i;

/** True if a payee name looks like an individual ("Bharath Pai", "M S Rajan", "9876543210@ybl"). */
export function looksLikePerson(merchant) {
  if (!merchant) return false;
  const m = merchant.trim();
  if (/\.(com|in|net|org|co)\b/i.test(m) || BUSINESS_STEM.test(m)) return false;
  if (m.includes('@')) return /^\+?\d{10,}@/.test(m) || /^[a-z]+[._]?[a-z]*\d{0,4}@(ok|ybl|ibl|axl|apl|paytm|upi)/i.test(m) && !BUSINESS.test(m.split('@')[0]);
  if (BUSINESS.test(m) || /\d/.test(m)) return false;
  const words = m.split(/\s+/);
  return words.length >= 1 && words.length <= 4 && words.every((w) => /^[A-Za-z][A-Za-z.']*$/.test(w)) && m.length <= 32;
}

/** Short key used when learning a rule from the user's correction. */
export function merchantKey(merchant) {
  if (!merchant) return '';
  let k = merchant.toLowerCase();
  if (k.includes('@')) {
    const handle = k.split('@')[0];
    if (/^[a-z][a-z.\-_]{2,}$/.test(handle) && !/\d/.test(handle)) k = handle.replace(/[._-]+/g, ' ').trim();
  }
  return k.replace(/\s+(pvt|private|ltd|limited|india|technologies|tech|retail|services|internet)\b.*$/, '').trim().slice(0, 60);
}

function findMethod(body, fallback) {
  if (/\batm\b|cash withdrawal|withdrawn/i.test(body)) return 'Cash';
  if (/meal (card|wallet)|pluxee|sodexo|zeta\b/i.test(body)) return 'Meal card';
  if (/fastag/i.test(body)) return 'FASTag';
  if (/credit\s*card|\bcc\b|creditcard|avl\.?\s*(limit|lmt)|available (credit )?limit/i.test(body)) return 'Credit card';
  if (/\bnach\b|e-?mandate|standing instruction|auto-?debit/i.test(body)) return 'Net banking';
  if (/\bupi\b|\bvpa\b|@[a-z]{2,}/i.test(body)) return 'UPI';
  if (/debit\s*card|\bdc\b|\bcard\b|\bpos\b/i.test(body)) return 'Debit card';
  if (/\b(neft|imps|rtgs|net\s*banking|netbanking)\b/i.test(body)) return 'Net banking';
  return fallback;
}

/** Last 3-4 digits of the account or card, for display ("ICICI ••9005"). */
export function findAccount(body) {
  const m = body.match(/(?:a\/c|acct|account|card|\bac)\s*(?:no\.?|number|ending(?: with)?)?\s*[x*•.#-]*\s*(\d{3,4})\b/i);
  return m ? m[1] : '';
}

export function senderCode(address) {
  const a = String(address || '').trim().toUpperCase();
  if (/^\+?\d[\d\s-]{5,}$/.test(a)) return a.replace(/\D/g, '');
  return a.replace(/^[A-Z0-9]{2}-/, '').replace(/-[A-Z]$/, '');
}
const isPersonalNumber = (address) => /^\+?\d[\d\s-]{9,}$/.test(String(address || '').trim());

// ─── Categorising ────────────────────────────────────────────────────────────
const ruleCache = new Map();
function ruleRegex(k) {
  if (!ruleCache.has(k)) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
    ruleCache.set(k, new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, 'i'));
  }
  return ruleCache.get(k);
}
// Some keywords decide the category whatever the merchant is called.
const STRONG = [[/fastag|toll plaza/i, 'Transport']];

function bestMatch(text, rules, test = (r) => ruleRegex(r.k).test(text)) {
  let best = null;
  for (const r of rules) {
    if (!test(r)) continue;
    if (r.mine) return r.c;                       // the user's own rules win, in order
    if (!best || r.k.length > best.k.length) best = r; // otherwise the most specific keyword
  }
  return best ? best.c : null;
}
// "vegetab" ↔ "vegetables", "supercellst" ↔ "supercell": only for 5+ letters.
const prefixTest = (word) => (r) => r.k.split(' ').some((w) => w.length >= 5 && (w.startsWith(word) || word.startsWith(w)));

export function categorize(merchant, body, rules, fallback) {
  for (const [rx, c] of STRONG) if (rx.test(body)) return c;
  if (merchant) {
    // Banks often cut names to 15 letters ("Haritha Vegetab"): let the last word match as a prefix.
    const m = bestMatch(merchant, rules);
    if (m) return m;
    const last = merchant.length >= 14 ? (merchant.toLowerCase().match(/([a-z]{5,})$/) || [])[1] : null;
    const p = last && bestMatch(merchant, rules, prefixTest(last));
    if (p) return p;
  }
  return bestMatch(body, rules) || fallback;
}

const template = (body) => body.toLowerCase().replace(/[0-9.,]+/g, '#').replace(/\s+/g, ' ').slice(0, 40);

// ─── Analysis ────────────────────────────────────────────────────────────────
export const smsKey = (msg) => 'sms:' + hash(msg.address + '|' + msg.ts + '|' + msg.body);

/**
 * messages: from parseSmsBackup. from/to: 'YYYY-MM-DD' inclusive.
 * existing: current expenses (to skip already-imported and flag likely duplicates).
 * Returns { items, skipped: { otp, income, notPayment, filtered, noAmount, other, imported }, unread: [msgs], inRange }.
 */
export function analyze(messages, { from, to, cfg, existing = [] }) {
  const skipped = { otp: 0, income: 0, notPayment: 0, filtered: 0, other: 0, imported: 0 };
  const unread = [];
  const items = [];
  const importedIds = new Set(existing.map((e) => e.id));
  const byDateAmt = new Map();
  existing.forEach((e) => { if (!String(e.id).startsWith('sms:')) byDateAmt.set(e.date + '|' + Number(e.amount).toFixed(2), e); });
  const skipSenders = cfg.skipSenders.map((s) => s.toUpperCase());
  const ignoreRx = cfg.ignoreWords.length ? new RegExp(cfg.ignoreWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null;
  let inRange = 0;

  // Money coming in, used to spot transfers between the user's own accounts.
  const credits = [];
  for (const msg of messages) {
    if (RX.credit.test(msg.body) && !RX.strongDebit.test(msg.body)) {
      const a = findAmount(msg.body);
      if (a > 0) credits.push({ ts: msg.ts, amount: a, sender: senderCode(msg.address) });
    }
  }

  for (const msg of messages) {
    const date = isoDate(new Date(msg.ts));
    if (date < from || date > to) continue;
    inRange++;
    const body = msg.body;
    const code = senderCode(msg.address);
    if ((cfg.skipPersonal && isPersonalNumber(msg.address)) || skipSenders.some((s) => s && (code.includes(s) || msg.address.toUpperCase().includes(s)))) { skipped.filtered++; continue; }
    if (RX.otp.test(body)) { skipped.otp++; continue; }
    if (!RX.debit.test(body) || !RX.account.test(body)) {
      if (RX.credit.test(body)) skipped.income++; else skipped.other++;
      continue;
    }
    if (RX.credit.test(body) && !RX.strongDebit.test(body)) { skipped.income++; continue; }
    if (RX.notPayment.test(body)) { skipped.notPayment++; continue; }
    if (ignoreRx && ignoreRx.test(body)) { skipped.filtered++; continue; }
    const key = smsKey(msg);
    if (importedIds.has(key)) { skipped.imported++; continue; }
    const amount = findAmount(body);
    if (!(amount > 0)) { unread.push({ ...msg, date }); continue; }

    let merchant = findMerchant(body);
    if (!merchant && /\bnach\b/i.test(body)) merchant = 'NACH auto-debit';
    const method = findMethod(body, cfg.defaultMethod);
    const atm = method === 'Cash';
    const category = atm ? cfg.defaultCategory : categorize(merchant, body, cfg.rules, cfg.defaultCategory);
    const item = {
      key, ts: msg.ts, date, sender: code || msg.address, body, amount,
      merchant: atm ? 'ATM withdrawal' : merchant, method, category, suggested: category,
      ref: findRef(body), acct: findAccount(body), atm, flags: [], selected: true,
    };
    if (atm) { item.flags.push('atm'); item.selected = cfg.includeAtm; }
    // Same amount arriving in a *different* bank within 30 min → moved between own accounts.
    if (credits.some((c) => c.amount === amount && c.sender !== code && Math.abs(c.ts - msg.ts) <= 30 * 60 * 1000)) {
      item.flags.push('self'); item.selected = false;
      if (cfg.transferCategory) item.category = item.suggested = cfg.transferCategory;
    } else if (!atm && item.category === cfg.defaultCategory && looksLikePerson(merchant)) {
      item.flags.push('person'); // payment to an individual; the user picks a category once
    }
    const twin = byDateAmt.get(date + '|' + amount.toFixed(2));
    if (twin) { item.flags.push('exists'); item.twin = twin.note || twin.category; item.selected = false; }
    items.push(item);
  }

  // The same payment often arrives twice (bank + UPI app / card network).
  const seenRef = new Map();
  items.forEach((it, i) => {
    let dup = null;
    if (it.ref && seenRef.has(it.ref)) dup = seenRef.get(it.ref);
    if (!dup) {
      for (let j = i - 1; j >= 0; j--) {
        const p = items[j];
        if (it.ts - p.ts > 15 * 60 * 1000) break;
        // Same amount within 15 min: a duplicate if it came from another sender, or from the
        // same bank in a different wording (e.g. ICICI's "Standing Instruction" + "spent" pair).
        // Two messages in the *same* wording are treated as two real payments.
        if (p.amount === it.amount && !p.flags.includes('dup') && (p.sender !== it.sender || template(p.body) !== template(it.body))) { dup = p; break; }
      }
    }
    if (dup) {
      it.flags.push('dup'); it.selected = false;
      if (!dup.merchant && it.merchant) { dup.merchant = it.merchant; }
    }
    if (it.ref && !seenRef.has(it.ref)) seenRef.set(it.ref, it);
  });

  items.sort((a, b) => b.ts - a.ts);
  return { items, skipped, unread: unread.reverse(), inRange };
}
