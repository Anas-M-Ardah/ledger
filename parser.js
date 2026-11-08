/*
 * Ledger — bank SMS parser.
 * Turns a bank notification text (English or Arabic) into a transaction:
 *   { amount, currency, type: 'expense'|'income', merchant, category, date, raw, id }
 * Returns null for messages that are not transactions (OTP codes, declined, promos).
 * Works in the browser (window.LedgerParser) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  // ---------- currencies ----------
  // Tokens that appear in bank messages, mapped to ISO codes.
  // 'DEFAULT' = ambiguous word (e.g. "riyal", "dinar") → the user's default currency.
  const CURRENCY_TOKENS = [
    ['JOD', ['JOD', 'JD', 'د.أ', 'د.ا', 'دينار أردني', 'دينار اردني']],
    ['USD', ['USD', 'US$', '$', 'دولار']],
    ['SAR', ['SAR', 'SR', 'ر.س', 'ريال سعودي']],
    ['AED', ['AED', 'د.إ', 'درهم']],
    ['EGP', ['EGP', 'LE', 'ج.م', 'جنيه']],
    ['KWD', ['KWD', 'KD', 'د.ك', 'دينار كويتي']],
    ['QAR', ['QAR', 'QR', 'ر.ق', 'ريال قطري']],
    ['BHD', ['BHD', 'BD', 'د.ب', 'دينار بحريني']],
    ['OMR', ['OMR', 'RO', 'ر.ع', 'ريال عماني']],
    ['EUR', ['EUR', '€', 'يورو']],
    ['GBP', ['GBP', '£', 'جنيه استرليني']],
    ['TRY', ['TRY', 'TL', '₺']],
    ['MAD', ['MAD', 'DH', 'درهم مغربي']],
    ['ILS', ['ILS', 'NIS', '₪', 'شيكل']],
    ['INR', ['INR', '₹']],
    ['DEFAULT', ['دينار', 'ريال']],
  ];

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenToCode = {};
  const tokenAlts = [];
  for (const [code, toks] of CURRENCY_TOKENS) {
    for (const t of toks) {
      tokenToCode[t.toUpperCase()] = code;
      const e = escapeRe(t);
      // Latin tokens must stand alone ("JD" not inside "JDX"); symbols/Arabic as-is.
      tokenAlts.push({ len: t.length, re: /^[A-Za-z$]+$/.test(t) ? `(?<![A-Za-z])${e}(?![A-Za-z])` : e });
    }
  }
  tokenAlts.sort((a, b) => b.len - a.len); // longest first: "دينار أردني" before "دينار"
  const CUR = `(${tokenAlts.map((t) => t.re).join('|')})`;
  const NUM = `(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)`;
  const RE_CUR_NUM = new RegExp(`${CUR}\\s?${NUM}`, 'gi');
  const RE_NUM_CUR = new RegExp(`${NUM}\\s?${CUR}`, 'gi');
  const RE_AMOUNT_WORD = new RegExp(`(?:amount|amt|مبلغ|بمبلغ|قيمة|بقيمة)\\s*(?:of|:)?\\s*${NUM}`, 'gi');

  // ---------- keyword lists ----------
  const IGNORE = [
    /\botp\b/i, /one[- ]time/i, /verification code/i, /\bpasscode\b/i, /\bpassword\b/i,
    /do not share/i, /\bdeclined\b/i, /\brejected\b/i, /\bunsuccessful\b/i, /\bfailed\b/i,
    /\bis due\b/i, /\bdue date\b/i, /\bdue on\b/i, /\breminder\b/i, /مستحق/, /تذكير/,
    /رمز التحقق/, /كلمة المرور/, /كلمة السر/, /لا تشارك/, /رمز التفعيل/, /مرفوض/, /رفض/, /لم تتم/, /فشل/,
  ];
  const INCOME = [
    /\bcredited\b/i, /\bdeposit(?:ed)?\b/i, /\breceived\b/i, /\bsalary\b/i, /\bpayroll\b/i, /\brefund(?:ed)?\b/i,
    /\breversal\b/i, /\breversed\b/i, /\bcash ?back\b/i, /\bincoming\b/i, /\bhas been added\b/i, /\btransfer from\b/i,
    /إيداع/, /ايداع/, /أودع/, /اودع/, /راتب/, /استرداد/, /استرجاع/, /واردة/, /وارد/, /دائن/, /إضافة/, /اضافة/, /استلام/, /أضيف/, /اضيف/,
  ];
  const EXPENSE = [
    /\bdebited\b/i, /\bdebit\b/i, /\bpurchase[ds]?\b/i, /\bspent\b/i, /\bwithdrawn?\b/i, /\bwithdrawal\b/i,
    /\bpayment\b/i, /\bpaid\b/i, /\bpos\b/i, /\batm\b/i, /\bcharged\b/i, /\bsent\b/i, /\btransfer(?:red)? to\b/i,
    /\boutgoing\b/i, /\bdeducted\b/i, /\bbill\b/i, /\btransaction at\b/i,
    /خصم/, /شراء/, /مشتريات/, /سحب/, /دفع/, /مدين/, /صادرة/, /صادر/, /تسديد/, /سداد/, /حركة/,
  ];
  const BALANCE_NEAR = /(balance|bal\b|bal\.|avl|avail|available|limit|رصيد|الرصيد|المتاح|متاح|الحد)[^\d]{0,22}$/i;

  // ---------- categories ----------
  const CATEGORIES = {
    expense: [
      ['Groceries', /carrefour|supermarket|hypermarket|grocery|groceries|\bmarket\b|lulu|spinneys|cozmo|safeway|tamimi|panda|danube|سوبر ?ماركت|ماركت|تموين|بقالة/i],
      ['Dining', /restaura|\bres\b|\brest\b|grill|kitchen|bakery|bakeries|sweets|falafel|kunaf|knaf|shawerma|snack|diner|bistro|eatery|\bfood|حلويات|مخبز|فلافل|كنافة|مشاوي|فطائر|cafe|café|coffee|starbucks|costa|mcdonald|kfc|pizza|burger|shawarma|talabat|deliveroo|uber ?eats|hungerstation|jahez|zomato|مطعم|كافيه|قهوة|مقهى|شاورما/i],
      ['Transport', /\buber\b|careem|taxi|\bfuel\b|petrol|gas station|jopetrol|manaseer|adnoc|enoc|aldrees|parking|metro|محروقات|بنزين|وقود|تكسي|مواقف/i],
      ['Shopping', /amazon|\bnoon\b|shein|namshi|\bmall\b|zara|h&m|ikea|aliexpress|temu|\bstore\b|\bshop\b|متجر|مول/i],
      ['Bills', /electric|electricity|water|\borange\b|\bzain\b|umniah|\bstc\b|mobily|etisalat|\bdu\b|vodafone|internet|telecom|\bbill\b|فاتورة|كهرباء|مياه|اتصالات/i],
      ['Health', /pharmacy|hospital|clinic|medical|dental|doctor|صيدلية|مستشفى|عيادة|طبي/i],
      ['Entertainment', /netflix|spotify|shahid|osn|cinema|vox|apple\.com|itunes|google|steam|playstation|xbox|youtube|anghami|سينما/i],
      ['Cash', /\batm\b|cash withdrawal|withdrawal|سحب نقدي|صراف|سحب/i],
      ['Transfers', /transfer|cliq|remittance|wallet|حوالة|تحويل/i],
    ],
    income: [
      ['Salary', /salary|payroll|wage|راتب|رواتب/i],
      ['Refund', /refund|reversal|reversed|cash ?back|استرداد|استرجاع|عكس/i],
      ['Transfers', /transfer|cliq|remittance|حوالة|تحويل/i],
    ],
  };
  const CATEGORY_ICONS = {
    Groceries: '🛒', Dining: '🍽️', Transport: '🚗', Shopping: '🛍️', Bills: '💡', Health: '💊',
    Entertainment: '🎬', Cash: '💵', Transfers: '🔁', Salary: '💼', Refund: '↩️', Other: '•', 'Other income': '＋',
  };

  // ---------- helpers ----------
  function normalize(text) {
    return String(text || '')
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/٫/g, '.') // Arabic decimal separator
      .replace(/٬/g, ',') // Arabic thousands separator
      .replace(/[‎‏‪-‮⁦-⁩]/g, '') // bidi marks
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
  }

  const toNumber = (s) => parseFloat(String(s).replace(/,/g, ''));

  function findAmounts(text, defaultCurrency) {
    const found = [];
    const push = (index, num, tok) => {
      const amount = toNumber(num);
      if (!isFinite(amount) || amount <= 0) return;
      let code = tok ? tokenToCode[tok.toUpperCase()] || 'DEFAULT' : 'DEFAULT';
      const guessed = code === 'DEFAULT';
      if (guessed) code = defaultCurrency;
      const before = text.slice(Math.max(0, index - 30), index);
      found.push({ index, amount, currency: code, guessed, isBalance: BALANCE_NEAR.test(before) });
    };
    let m;
    RE_CUR_NUM.lastIndex = 0;
    while ((m = RE_CUR_NUM.exec(text))) push(m.index, m[2], m[1]);
    RE_NUM_CUR.lastIndex = 0;
    while ((m = RE_NUM_CUR.exec(text))) {
      if (!found.some((f) => Math.abs(f.index - m.index) < 6)) push(m.index, m[1], m[2]);
    }
    if (!found.length) {
      RE_AMOUNT_WORD.lastIndex = 0;
      while ((m = RE_AMOUNT_WORD.exec(text))) push(m.index, m[1], null);
    }
    return found.sort((a, b) => a.index - b.index);
  }

  function firstMatch(text, list) {
    let best = -1, count = 0;
    for (const re of list) {
      const m = re.exec(text);
      if (m) { count++; if (best === -1 || m.index < best) best = m.index; }
    }
    return { count, index: best };
  }

  function detectType(text) {
    const inc = firstMatch(text, INCOME);
    const exp = firstMatch(text, EXPENSE);
    if (!inc.count && !exp.count) return null;
    if (inc.count && !exp.count) return 'income';
    if (exp.count && !inc.count) return 'expense';
    // Both present (e.g. "Transfer received ... payment"): the earliest keyword wins.
    return inc.index < exp.index ? 'income' : 'expense';
  }

  const STOP_EN = '(?=\\s+as\\s+(?:cliq|transfer|payment|salary|refund|reversal)\\b|\\s+[A-Za-z]{3}\\s?\\d|\\s+[$€£]|\\s+(?:amount|amt|value|on|using|via|with|for|from|card|ref|reference|avl|available|bal|balance|date|at|is|has|your|\\d{1,2}[\\/\\-.]\\d)\\b|\\s*[.,;:|\\n(]|\\s+\\d|\\s*$)';
  const STOP_AR = '(?=\\s+(?:بتاريخ|في تاريخ|تاريخ|رصيد|الرصيد|المتاح|بطاقة|البطاقة|رقم|بواسطة|عبر|من خلال|الساعة|يوم)|\\s*[.,؛،:|\\n(]|\\s+\\d|\\s*$)';
  const MERCHANT_PATTERNS = {
    expense: [
      new RegExp(`\\b(?:at|@)\\s+([A-Za-z0-9][^\\n]{1,40}?)${STOP_EN}`, 'i'),
      new RegExp(`\\b(?:to|paid to|sent to|transfer(?:red)? to)\\s+([A-Za-z0-9][^\\n]{1,40}?)${STOP_EN}`, 'i'),
      new RegExp(`\\bfor\\s+([A-Za-z0-9][^\\n]{1,40}?)${STOP_EN}`, 'i'),
      new RegExp(`(?:\\b|(?<=\\d))from\\s+([A-Za-z0-9][^\\n]{1,40}?)${STOP_EN}`, 'i'),
      new RegExp(`(?:لدى|لدي|عند|لصالح|إلى|الى|في)\\s+([^\\n]{2,40}?)${STOP_AR}`),
    ],
    income: [
      new RegExp(`(?:\\b|(?<=\\d))(?:from|by)\\s+([A-Za-z0-9][^\\n]{1,40}?)${STOP_EN}`, 'i'),
      new RegExp(`(?:من|بواسطة)\\s+([^\\n]{2,40}?)${STOP_AR}`),
    ],
  };
  const BAD_MERCHANT = /^(your|you|the|purchase|payment|transaction|a\/c|acc|account|card|ending|xx|\*|a |an |حساب|حسابك|بطاقة|بطاقتك|رقم|تاريخ)/i;

  function detectMerchant(text, type) {
    for (const re of MERCHANT_PATTERNS[type]) {
      const m = re.exec(text);
      if (!m) continue;
      let name = m[1].trim().replace(/\s{2,}/g, ' ').replace(/[\s\-–:]+$/, '');
      if (!name || BAD_MERCHANT.test(name) || /^[\d\s*xX\/.-]+$/.test(name)) continue;
      if (name.length > 32) name = name.slice(0, 32).trim() + '…';
      return name;
    }
    return '';
  }

  function detectCategory(text, merchant, type) {
    const hay = `${merchant} ${text}`;
    for (const [name, re] of CATEGORIES[type]) if (re.test(merchant || '')) return name;
    for (const [name, re] of CATEGORIES[type]) if (re.test(hay)) return name;
    return type === 'income' ? 'Other income' : 'Other';
  }

  // Last 4 digits of the card/account the message is about ("card ending 1234", "a/c XX4521", "حسابك رقم ***8812").
  const RE_ACCOUNT = /(?:card|a\/c|acc(?:oun)?t?|ending|بطاقة|بطاقتك|البطاقة|حساب|حسابك|الحساب)[^\d\n]{0,20}?[*xX•.\s]*((?:\d+[*xX•]+)*\d{3,})(?!\d)/i;
  function detectAccount(text) {
    const m = RE_ACCOUNT.exec(text) || /(?:^|[^\d])(\d{2,}[*•]+\d{3,})(?!\d)/.exec(text);
    return m ? m[1].split(/[*xX•]+/).pop().slice(-4) : '';
  }

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  function detectDate(text, fallback) {
    const fb = new Date(fallback);
    let y, mo, d;
    let m = /\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/.exec(text);
    if (m) { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
    if (y === undefined && (m = /\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})\b/.exec(text))) {
      let a = +m[1], b = +m[2];
      y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
      if (b > 12 && a <= 12) { mo = a - 1; d = b; } else { d = a; mo = b - 1; } // day-first, as most banks outside the US
    }
    if (y === undefined && (m = /\b(\d{1,2})[\s-]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s-,]*(\d{4}|\d{2})?\b/i.exec(text))) {
      d = +m[1]; mo = MONTHS[m[2].toLowerCase()];
      y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : fb.getFullYear();
    }
    if (y === undefined) return fb.toISOString();
    const t = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|ص|م)?/i.exec(text);
    let hh = t ? +t[1] : 12, mm = t ? +t[2] : 0;
    if (t && t[3]) { const pm = /pm|م/i.test(t[3]); if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; }
    const date = new Date(y, mo, d, hh, mm);
    const valid = date.getMonth() === mo && date.getDate() === d;
    const tooNew = date - fb > 2 * 864e5;
    const tooOld = fb - date > 10 * 365 * 864e5;
    return valid && !tooNew && !tooOld ? date.toISOString() : fb.toISOString();
  }

  // ---------- public API ----------
  function parseMessage(rawText, opts = {}) {
    const defaultCurrency = opts.defaultCurrency || 'USD';
    const receivedAt = opts.receivedAt || new Date().toISOString();
    const text = normalize(rawText);
    if (text.length < 8) return null;
    if (IGNORE.some((re) => re.test(text))) return null;

    const amounts = findAmounts(text, defaultCurrency);
    const txnAmount = amounts.find((a) => !a.isBalance);
    if (!txnAmount) return null;

    const type = detectType(text);
    if (!type) return null;

    // Balance after this transaction, if the bank included it (same currency only).
    const bal = amounts.find((a) => a.isBalance && a.index > txnAmount.index && a.currency === txnAmount.currency)
      || amounts.find((a) => a.isBalance && a.currency === txnAmount.currency);
    const merchant = detectMerchant(text, type);
    return {
      id: hash(text),
      amount: Math.round(txnAmount.amount * 1000) / 1000,
      currency: txnAmount.currency,
      currencyGuessed: txnAmount.guessed,
      balance: bal ? Math.round(bal.amount * 1000) / 1000 : null,
      account: detectAccount(text),
      type,
      merchant,
      category: detectCategory(text, merchant, type),
      date: detectDate(text, receivedAt),
      raw: text,
    };
  }

  // Split a big paste into individual messages: blank lines first, then lines if each holds an amount.
  function splitMessages(bulk) {
    const text = String(bulk || '').replace(/\r\n?/g, '\n').trim();
    if (!text) return [];
    // Messages are separated by blank lines or by a line of dashes (the Shortcut inbox file uses "---").
    let parts = text.split(/\n\s*\n+|^[ \t]*-{3,}[ \t]*/m).map((s) => (s || '').trim()).filter(Boolean);
    if (parts.length === 1) {
      const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
      const withAmounts = lines.filter((l) => findAmounts(normalize(l), 'USD').length);
      if (lines.length > 1 && withAmounts.length === lines.length) parts = lines;
    }
    return parts;
  }

  function parseBulk(bulk, opts) {
    return splitMessages(bulk).map((raw) => ({ raw, txn: parseMessage(raw, opts) }));
  }

  // True if the text mentions an amount of money at all (used to tell "not a bank message" from "couldn't read").
  const looksLikeMoney = (text) => findAmounts(normalize(text), 'USD').length > 0;

  const VERSION = 3;
  const api = { VERSION, parseMessage, parseBulk, splitMessages, looksLikeMoney, normalize, CATEGORIES, CATEGORY_ICONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LedgerParser = api;
})(typeof self !== 'undefined' ? self : this);
