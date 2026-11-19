// Default settings for "Import from SMS". Users can edit all of this in the app;
// these are only the starting values (and what "Reset to defaults" restores).
//
// A rule is { k: keyword, c: category }. Keywords match whole words, case-insensitive,
// first in the merchant name the app found, then anywhere in the message.

const R = (category, words) => words.map((k) => ({ k, c: category }));

// Not spending: kept out of "Spent" totals (categories marked `excluded`).
// Frozen copies of these lists are used by the v1→v2 data upgrade in schema.js.
export const INVESTMENT_WORDS = ['nach', 'mutual fund', 'mutual funds', 'sip', 'zerodha', 'groww', 'upstox', 'kuvera', 'smallcase', 'angel one', 'paytm money', 'et money', 'indian clearing', 'iccl', 'nse clearing', 'bse star', 'mf utilities', 'cams', 'kfintech', 'ppf', 'nps', 'sukanya', 'recurring deposit', 'fixed deposit'];
export const TRANSFER_WORDS = ['self transfer', 'own account', 'cred', 'cred club', 'credit card bill', 'card bill payment', 'cc bill', 'add money', 'wallet top up', 'wallet load'];

export const DEFAULT_SMS_RULES = [
  ...R('Food & dining', ['foods', 'food', 'bhel', 'coffee', 'tea', 'juice', 'snacks', 'biryani', 'jubilant', 'annapoorna', 'canteen', 'mess', 'dhaba', 'bakes', 'swiggy', 'zomato', 'dominos', 'domino', 'mcdonalds', 'mcdonald', 'kfc', 'pizza hut', 'starbucks', 'burger king', 'subway', 'haldiram', 'eatclub', 'box8', 'faasos', 'barbeque nation', 'chaayos', 'third wave', 'cafe', 'restaurant', 'hotel', 'bakery']),
  ...R('Groceries', ['vegetables', 'vegetable', 'fruits', 'fruit', 'store', 'stores', 'mart', 'hypermarket', 'lulu', 'provisions', 'ration', 'bigbasket', 'blinkit', 'zepto', 'instamart', 'dmart', 'avenue supermarts', 'jiomart', 'more retail', 'reliance fresh', 'reliance smart', 'spencers', 'natures basket', 'grofers', 'milkbasket', 'country delight', 'licious', 'freshtohome', 'supermarket', 'kirana']),
  ...R('Transport', ['fuels', 'petroleum', 'filling station', 'service station', 'fastag', 'toll', 'motor', 'motors', 'ktm', 'automobiles', 'uber', 'ola', 'olacabs', 'rapido', 'namma yatri', 'blusmart', 'metro', 'fastag', 'petrol', 'fuel', 'hpcl', 'bpcl', 'iocl', 'indian oil', 'bharat petroleum', 'hindustan petroleum', 'shell', 'parking']),
  ...R('Travel', ['irctc', 'makemytrip', 'goibibo', 'cleartrip', 'redbus', 'ixigo', 'yatra', 'easemytrip', 'indigo', 'interglobe', 'air india', 'akasa', 'spicejet', 'vistara', 'oyo', 'airbnb', 'booking.com', 'agoda', 'treebo', 'fabhotels']),
  ...R('Shopping', ['plywood', 'plywoods', 'paint', 'paints', 'hardware', 'electronics', 'myg', 'textiles', 'footwear', 'jewellers', 'amazon', 'flipkart', 'myntra', 'ajio', 'meesho', 'nykaa', 'tatacliq', 'tata cliq', 'croma', 'reliance digital', 'vijay sales', 'decathlon', 'ikea', 'lenskart', 'firstcry', 'pepperfry', 'urban ladder', 'westside', 'lifestyle', 'shoppers stop', 'pantaloons', 'h&m', 'zara', 'uniqlo']),
  ...R('Bills & utilities', ['treasury', 'electricity', 'bescom', 'tneb', 'tangedco', 'mseb', 'msedcl', 'tata power', 'adani electricity', 'bses', 'kseb', 'cesc', 'airtel', 'jio', 'vodafone', 'bsnl', 'act fibernet', 'hathway', 'broadband', 'indane', 'hp gas', 'bharat gas', 'mahanagar gas', 'igl', 'water bill', 'recharge', 'dth', 'tata play', 'dish tv', 'postpaid', 'prepaid', 'insurance', 'lic']),
  ...R('Subscriptions', ['netflix', 'hotstar', 'disney', 'prime video', 'amazon prime', 'spotify', 'youtube', 'apple.com', 'itunes', 'google play', 'sonyliv', 'zee5', 'jiocinema', 'jiohotstar', 'audible', 'linkedin', 'microsoft', 'adobe', 'chatgpt', 'openai', 'anthropic', 'claude.ai', 'icloud']),
  ...R('Health', ['medicals', 'medicines', 'pharma', 'pharmacy', 'chemist', 'medical', 'apollo', '1mg', 'tata 1mg', 'pharmeasy', 'netmeds', 'medplus', 'hospital', 'clinic', 'diagnostic', 'diagnostics', 'pathology', 'practo', 'cult.fit', 'cultfit', 'healthifyme', 'dental']),
  ...R('Entertainment', ['book my show', 'funtura', 'supercell', 'games', 'bookmyshow', 'pvr', 'inox', 'cinepolis', 'district', 'paytm insider', 'gaming', 'steam', 'playstation']),
  ...R('Education', ['udemy', 'coursera', 'byjus', 'unacademy', 'upgrad', 'school', 'college', 'university', 'tuition', 'academy', 'books', 'kindle']),
  ...R('Personal care', ['salon', 'urban company', 'urbanclap', 'spa', 'naturals', 'lakme', 'barber']),
  ...R('Rent & housing', ['rent', 'nobroker', 'housing.com', 'maintenance', 'society', 'apartment', 'mygate']),
  ...INVESTMENT_WORDS.map((k) => ({ k, c: 'Investments' })),
  ...TRANSFER_WORDS.map((k) => ({ k, c: 'Transfers' })),
];

// Refunds are recognised separately (2.2.0), so they're no longer in this list.
export const DEFAULT_IGNORE_WORDS = ['cashback'];

export function defaultSmsSettings() {
  return {
    rules: DEFAULT_SMS_RULES.map((r) => ({ ...r })),
    ignoreWords: DEFAULT_IGNORE_WORDS.slice(),
    skipSenders: [],
    skipPersonal: true,     // ignore SMS from ordinary phone numbers
    includeAtm: false,      // ATM withdrawals start unticked
    learn: true,            // remember category changes as new rules
    defaultCategory: 'Other',
    defaultMethod: 'UPI',
  };
}

export function normalizeSmsSettings(raw) {
  const d = defaultSmsSettings();
  if (!raw || typeof raw !== 'object') return d;
  const list = (v) => (Array.isArray(v) ? v.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 200) : null);
  const rules = Array.isArray(raw.rules)
    ? raw.rules.filter((r) => r && String(r.k || '').trim() && String(r.c || '').trim()).map((r) => ({ ...r, k: String(r.k).trim().toLowerCase().slice(0, 60), c: String(r.c).trim().slice(0, 40) }))
    : d.rules;
  return {
    ...raw,
    rules,
    ignoreWords: list(raw.ignoreWords) ?? d.ignoreWords,
    skipSenders: list(raw.skipSenders) ?? d.skipSenders,
    skipPersonal: raw.skipPersonal !== false,
    includeAtm: raw.includeAtm === true,
    learn: raw.learn !== false,
    defaultCategory: String(raw.defaultCategory || d.defaultCategory).slice(0, 40),
    defaultMethod: String(raw.defaultMethod || d.defaultMethod).slice(0, 40),
  };
}
