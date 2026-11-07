/* Ledger — app logic. Data lives in localStorage on this device only. */
(function () {
  'use strict';
  const P = window.LedgerParser;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const KEY = 'ledger.v1';
  const CURRENCIES = ['JOD', 'USD', 'SAR', 'AED', 'EGP', 'KWD', 'QAR', 'BHD', 'OMR', 'EUR', 'GBP', 'TRY', 'MAD', 'ILS', 'INR'];
  const BASE_CATS = { expense: P.CATEGORIES.expense.map((c) => c[0]), income: P.CATEGORIES.income.map((c) => c[0]) };
  // Built-in categories, then your own, then "Other" last.
  const catsFor = (type) => [...BASE_CATS[type], ...((db.settings.customCats || {})[type] || []), type === 'income' ? 'Other income' : 'Other'];

  // ---------- storage ----------
  let memory = null;
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { if (memory) return memory; }
    return memory || { txns: [], settings: { currency: guessCurrency(), rules: {} } };
  }
  function save() {
    memory = db;
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* private mode: keep in memory */ }
  }
  function guessCurrency() {
    try {
      const region = (new Intl.Locale(navigator.language).maximize().region || '').toUpperCase();
      return { JO: 'JOD', SA: 'SAR', AE: 'AED', EG: 'EGP', KW: 'KWD', QA: 'QAR', BH: 'BHD', OM: 'OMR', GB: 'GBP', TR: 'TRY', MA: 'MAD', IN: 'INR', IL: 'ILS', PS: 'ILS' }[region] || 'USD';
    } catch (e) { return 'USD'; }
  }

  let db = load();
  db.settings.rules = db.settings.rules || {};
  db.balances = db.balances || []; // balances you entered: { currency, account, amount, date }
  if ((db.parserVersion || 1) < P.VERSION) {
    for (const t of db.txns) {
      if (!t.raw || t.edited) continue;
      const n = P.parseMessage(t.raw, { defaultCurrency: t.currency, receivedAt: t.date });
      if (!n || n.type !== t.type || n.amount !== t.amount) continue;
      Object.assign(t, { merchant: n.merchant, category: n.category, account: n.account });
      if (n.balance != null) t.balance = n.balance;
      applyRules(t);
    }
    db.parserVersion = P.VERSION;
    save();
  }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

  const today = new Date();
  const state = {
    month: new Date(today.getFullYear(), today.getMonth(), 1),
    currency: db.settings.currency,
    category: null,
    showAll: false,
  };

  // ---------- formatting ----------
  const fmtCache = {};
  function money(n, cur = state.currency, opts = {}) {
    const k = cur + JSON.stringify(opts);
    if (!fmtCache[k]) {
      try { fmtCache[k] = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, ...opts }); }
      catch (e) { fmtCache[k] = { format: (x) => `${cur} ${x.toFixed(2)}` }; }
    }
    return fmtCache[k].format(n);
  }
  const moneyHead = (n, cur) => { const d = Math.abs(n) >= 1000 ? 0 : 2; return money(n, cur, { minimumFractionDigits: d, maximumFractionDigits: d }); };
  const moneyShort = (n, cur) => money(n, cur, { maximumFractionDigits: n >= 100 ? 0 : 2, minimumFractionDigits: 0 });
  const compact = (n) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  const monthName = (d, style = 'long') => d.toLocaleDateString(undefined, { month: style });
  const sameMonth = (iso, m) => { const d = new Date(iso); return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth(); };
  const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
  const icon = (cat) => P.CATEGORY_ICONS[cat] || '🏷️';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const label = (t) => t.merchant || (t.type === 'income' ? 'Money in' : t.category === 'Other' ? 'Card payment' : t.category);

  function dayLabel(d) {
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const b = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diff = Math.round((b - a) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  // ---------- transactions ----------
  function applyRules(t) {
    const r = t.merchant && db.settings.rules[t.merchant.toLowerCase()];
    if (r && r.type === t.type) t.category = r.category;
    return t;
  }
  // Ambiguous currency words ("dinar", "riyal") take the most common explicit currency seen so far.
  function resolveCurrencies(list) {
    const counts = {};
    for (const t of [...db.txns, ...list]) if (!t.currencyGuessed) counts[t.currency] = (counts[t.currency] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (!db.settings.currencyChosen && top) db.settings.currency = top[0];
    const fallback = top ? top[0] : db.settings.currency;
    for (const t of list) if (t.currencyGuessed) t.currency = db.settings.currencyChosen ? db.settings.currency : fallback;
    return list;
  }
  function addTxns(list) {
    resolveCurrencies(list);
    const ids = new Set(db.txns.map((t) => t.id));
    let added = 0;
    for (const t of list) {
      if (ids.has(t.id)) continue;
      ids.add(t.id);
      db.txns.push(applyRules({ ...t }));
      added++;
    }
    db.txns.sort((a, b) => new Date(b.date) - new Date(a.date));
    save();
    return added;
  }
  const parseOpts = () => ({ defaultCurrency: db.settings.currency, receivedAt: new Date().toISOString() });

  // ---------- balance ----------
  // Latest known balance (from an SMS that included it, or one you entered), plus every transaction after it.
  // Kept per account (card/account last digits); messages without digits count toward your main account.
  const round3 = (x) => Math.round(x * 1000) / 1000;
  function balances(cur) {
    const txns = db.txns.filter((t) => t.currency === cur);
    const manual = db.balances.filter((b) => b.currency === cur);
    const counts = {};
    for (const t of txns) if (t.account) counts[t.account] = (counts[t.account] || 0) + 1;
    for (const b of manual) if (b.account && !(b.account in counts)) counts[b.account] = 0;
    const accounts = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const main = accounts[0] || '';
    const groups = {};
    for (const a of accounts.length ? accounts : ['']) groups[a] = { account: a, txns: [], readings: [] };
    const groupOf = (acc) => groups[acc || main] || groups[main];
    for (const t of txns) {
      const g = groupOf(t.account);
      g.txns.push(t);
      if (t.balance != null) g.readings.push({ amount: t.balance, date: t.date, source: 'sms', id: t.id });
    }
    for (const b of manual) groupOf(b.account).readings.push({ amount: b.amount, date: b.date, source: 'manual' });
    return Object.values(groups).map((g) => {
      const r = g.readings.sort((a, b) => new Date(b.date) - new Date(a.date) || (a.source === 'manual' ? -1 : 1))[0];
      if (!r) return { account: g.account, balance: null };
      const after = g.txns.filter((t) => t.id !== r.id && new Date(t.date) > new Date(r.date));
      const delta = after.reduce((sum, t) => sum + (t.type === 'income' ? t.amount : -t.amount), 0);
      return { account: g.account, balance: round3(r.amount + delta), reading: r, since: after.length };
    });
  }
  const acctName = (b, many) => (b.account ? `Account ··${b.account}` : many ? 'Other' : 'Balance');
  function balanceNote(b) {
    if (b.balance === null) return 'Fills in when a bank message includes your balance. Tap to enter it';
    const d = new Date(b.reading.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const src = b.reading.source === 'sms' ? `From bank SMS on ${d}` : `Set by you on ${d}`;
    return b.since ? `${src} · ${b.since} transaction${b.since === 1 ? '' : 's'} since` : src;
  }
  function renderBalance() {
    const list = balances(state.currency);
    const el = $('#balanceCard');
    if (list.length === 1) {
      const b = list[0];
      el.innerHTML = `<div class="k"><span>${b.account ? `Balance · ··${b.account}` : 'Balance'}</span><span class="edit">${b.balance === null ? 'Set' : 'Edit'}</span></div>
        ${b.balance === null ? '<div class="v unknown">Not known yet</div>' : `<div class="v num">${money(b.balance)}</div>`}
        <div class="d">${esc(balanceNote(b))}</div>`;
    } else {
      el.innerHTML = `<div class="k"><span>Balances</span><span class="edit">Edit</span></div>` + list.map((b) => `
        <div class="acct"><span class="n">${esc(acctName(b, true))}</span>
        <span class="a num">${b.balance === null ? '—' : money(b.balance)}</span>
        <span class="d">${esc(balanceNote(b))}</span></div>`).join('');
    }
  }
  function openBalance() {
    const list = balances(state.currency);
    $('#balanceInputs').innerHTML = list.map((b, i) => `
      <label class="f" for="bal${i}">${esc(acctName(b, list.length > 1))} (${state.currency}) right now</label>
      <input id="bal${i}" data-account="${esc(b.account)}" data-was="${b.balance ?? ''}" type="number" inputmode="decimal" step="any"
        value="${b.balance ?? ''}" placeholder="e.g. 1240.500">`).join('');
    open('balance');
  }
  $('#balanceCard').onclick = openBalance;
  $('#balanceForm').addEventListener('submit', (e) => {
    e.preventDefault();
    let n = 0;
    for (const inp of $$('#balanceInputs input')) {
      if (inp.value === '') continue;
      const v = parseFloat(inp.value);
      if (!isFinite(v) || (inp.dataset.was !== '' && Math.abs(v - +inp.dataset.was) < 0.0005)) continue;
      db.balances.push({ currency: state.currency, account: inp.dataset.account, amount: round3(v), date: new Date().toISOString() });
      n++;
    }
    save();
    sheets.balance.close();
    render();
    if (n) toast('Balance saved');
  });

  // ---------- sync from the Shortcut inbox ----------
  // The Shortcut appends each bank SMS to "Ledger inbox.txt" and copies the whole file to the clipboard.
  // Re-importing the whole inbox is safe: messages already in Ledger are skipped.
  function importInbox(text) {
    const txns = P.parseBulk(text, parseOpts()).map((r) => r.txn).filter(Boolean);
    if (!txns.length) return null;
    const n = addTxns(txns);
    if (n) jumpToMonthOf([...txns].sort((a, b) => new Date(b.date) - new Date(a.date))[0]);
    render();
    return n;
  }
  const syncedMsg = (n) => (n ? `Synced ${n} new transaction${n === 1 ? '' : 's'}` : 'Up to date. No new messages');
  $('#syncBtn').onclick = async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (e) { /* denied or unsupported */ }
    const n = text ? importInbox(text) : null;
    if (n === null) { open('sync'); return; }
    toast(syncedMsg(n));
  };
  $('#pickInbox').onclick = () => $('#inboxFile').click();
  $('#inboxFile').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const n = importInbox(await f.text());
    sheets.sync.close();
    toast(n === null ? 'No bank messages found in that file' : syncedMsg(n));
  };

  // ---------- recategorising ----------
  // Put every payment from a place into a category, now and in future.
  function applyToPlace(key, type, category) {
    db.settings.rules[key] = { category, type };
    let n = 0;
    for (const t of db.txns) if (t.merchant && t.merchant.toLowerCase() === key && t.type === type) { t.category = category; n++; }
    save();
    return n;
  }
  function newCategory(type) {
    const name = (prompt('Name your new category (e.g. Kids, Car, Gym)') || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (!name) return null;
    const existing = catsFor(type).find((c) => c.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    db.settings.customCats = db.settings.customCats || { expense: [], income: [] };
    (db.settings.customCats[type] = db.settings.customCats[type] || []).push(name);
    save();
    return name;
  }

  // Picker opened from a transaction ({ id }) or from the places list ({ key, type, name }).
  let pick = null;
  function openPick(target) {
    if (target.id) {
      const t = db.txns.find((x) => x.id === target.id);
      if (!t) return;
      pick = { id: t.id, key: t.merchant ? t.merchant.toLowerCase() : null, type: t.type, name: label(t), current: t.category };
      const d = new Date(t.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      $('#pkSub').textContent = `${t.type === 'income' ? '+' : '−'}${money(t.amount, t.currency)} · ${d}`;
    } else {
      const t = db.txns.find((x) => x.merchant && x.merchant.toLowerCase() === target.key && x.type === target.type);
      pick = { key: target.key, type: target.type, name: target.name, current: t ? t.category : null };
      $('#pkSub').textContent = 'Applies to every payment here';
    }
    $('#pkTitle').textContent = pick.name;
    const others = pick.key ? db.txns.filter((t) => t.merchant && t.merchant.toLowerCase() === pick.key && t.type === pick.type).length : 0;
    $('#pkAllWrap').hidden = !pick.id || !pick.key;
    $('#pkAll').checked = true;
    $('#pkAllText').textContent = others > 1 ? `All ${others} payments from ${pick.name}, and future ones` : `Future payments from ${pick.name} too`;
    $('#pkActions').hidden = !pick.id;
    renderPickGrid();
    open('pick');
  }
  function renderPickGrid() {
    $('#pkGrid').innerHTML = catsFor(pick.type).map((c) =>
      `<button type="button" data-pick="${esc(c)}" aria-pressed="${c === pick.current}"><span class="e" aria-hidden="true">${icon(c)}</span><span>${esc(c)}</span></button>`).join('')
      + '<button type="button" class="new" data-pick-new><span class="e" aria-hidden="true">＋</span><span>New category</span></button>';
  }
  $('#pkGrid').addEventListener('click', (e) => {
    let c = null;
    if (e.target.closest('[data-pick-new]')) { c = newCategory(pick.type); if (!c) return; }
    else { const b = e.target.closest('[data-pick]'); if (!b) return; c = b.dataset.pick; }
    let msg;
    if (pick.key && (!pick.id || $('#pkAll').checked)) {
      const n = applyToPlace(pick.key, pick.type, c);
      msg = `${pick.name} → ${c}${n > 1 ? ` · ${n} payments` : ''}. Future ones too`;
    } else {
      const t = db.txns.find((x) => x.id === pick.id);
      t.category = c; t.edited = true; save();
      msg = `Moved to ${c}`;
    }
    sheets.pick.close();
    render();
    if (sheets.places.open) renderPlaces();
    toast(msg);
  });
  $('#pkEdit').onclick = () => { const id = pick.id; sheets.pick.close(); openEdit(id); };

  // Places: every merchant with its category, guessed or chosen.
  function renderPlaces() {
    const q = $('#placesSearch').value.trim().toLowerCase();
    const map = new Map();
    for (const t of db.txns) {
      if (!t.merchant) continue;
      const key = t.merchant.toLowerCase();
      const id = t.type + '|' + key;
      const g = map.get(id) || { key, name: t.merchant, type: t.type, count: 0, total: 0, currency: t.currency, category: t.category, last: t.date };
      g.count++;
      if (t.currency === g.currency) g.total += t.amount;
      if (t.date > g.last) { g.last = t.date; g.category = t.category; }
      map.set(id, g);
    }
    const list = [...map.values()].filter((g) => !q || g.key.includes(q) || g.category.toLowerCase().includes(q))
      .sort((a, b) => b.count - a.count || b.total - a.total);
    $('#placesList').innerHTML = list.length ? list.map((g) => {
      const chosen = !!db.settings.rules[g.key];
      return `<button class="place" data-key="${esc(g.key)}" data-type="${g.type}" data-name="${esc(g.name)}">
        <span class="t1">${esc(g.name)}</span>
        <span class="pill${chosen ? '' : ' guess'}">${icon(g.category)} ${esc(g.category)}</span>
        <span class="t2">${g.count} ${g.type === 'income' ? 'in' : 'payment'}${g.count === 1 || g.type === 'income' ? '' : 's'} · ${money(g.total, g.currency)}${chosen ? '' : ' · guessed'}</span>
      </button>`;
    }).join('') : `<p class="muted">${q ? 'No places match.' : 'No places yet. Add some bank messages first.'}</p>`;
  }
  function openPlaces() { $('#placesSearch').value = ''; renderPlaces(); open('places'); }
  $('#placesBtn').onclick = openPlaces;
  $('#placesBtn2').onclick = () => { sheets.settings.close(); openPlaces(); };
  $('#placesSearch').addEventListener('input', renderPlaces);
  $('#placesList').addEventListener('click', (e) => {
    const b = e.target.closest('.place');
    if (b) openPick({ key: b.dataset.key, type: b.dataset.type, name: b.dataset.name });
  });

  // ---------- learning categories ----------
  // Merchants Ledger couldn't place. Ask once; the answer becomes a rule for that merchant.
  let sortGroups = [];
  function unsorted(cur) {
    const map = new Map();
    for (const t of db.txns) {
      if (t.currency !== cur || !t.merchant || (t.category !== 'Other' && t.category !== 'Other income')) continue;
      const key = t.merchant.toLowerCase();
      if (db.settings.rules[key]) continue; // you already decided, even if you chose "Other"
      const id = t.type + '|' + key;
      const g = map.get(id) || { key, name: t.merchant, type: t.type, count: 0, total: 0 };
      g.count++; g.total += t.amount;
      map.set(id, g);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }
  function renderLearn() {
    const list = unsorted(state.currency);
    const el = $('#learnCard');
    el.hidden = !list.length;
    if (!list.length) return;
    const n = list.length;
    el.innerHTML = `<span class="ic" aria-hidden="true">🏷️</span>
      <span><span class="t1">${n === 1 ? `Is ${esc(list[0].name)} food, shopping…?` : `${n} places need a category`}</span><br>
      <span class="t2">Tell Ledger once and it remembers</span></span><span class="go">Sort</span>`;
  }
  function renderSort() {
    sortGroups = unsorted(state.currency);
    if (!sortGroups.length) { sheets.sort.close(); return; }
    $('#sortList').innerHTML = sortGroups.map((g, i) => `
      <div class="sort-row"><div class="t1">${esc(g.name)}</div>
        <div class="t2">${g.count} ${g.type === 'income' ? 'payment' : 'purchase'}${g.count === 1 ? '' : 's'} · ${money(g.total)}</div>
        <div class="chips">${catsFor(g.type)
          .map((c) => `<button class="chip" data-sort="${i}" data-c="${esc(c)}">${icon(c)} ${esc(c)}</button>`).join('')}</div>
      </div>`).join('');
  }
  $('#learnCard').onclick = () => { renderSort(); open('sort'); };
  $('#sortList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    e.stopPropagation();
    const g = sortGroups[+b.dataset.sort];
    db.settings.rules[g.key] = { category: b.dataset.c, type: g.type };
    let n = 0;
    for (const t of db.txns) if (t.merchant && t.merchant.toLowerCase() === g.key && t.type === g.type) { t.category = b.dataset.c; n++; }
    save();
    render();
    renderSort();
    toast(`${g.name} → ${b.dataset.c}${n > 1 ? ` (${n} payments)` : ''}. Future ones too`);
  });

  // ---------- render ----------
  function render() {
    const has = db.txns.length > 0;
    $('#dash').hidden = !has;
    $('#empty').hidden = has;
    $('#addBtn').hidden = !has;
    if (!has) return;

    const currencies = [...new Set(db.txns.map((t) => t.currency))];
    if (!currencies.includes(state.currency)) state.currency = currencies.includes(db.settings.currency) ? db.settings.currency : currencies[0];
    $('#currencyChips').innerHTML = currencies.length > 1
      ? currencies.map((c) => `<button class="chip" data-cur="${c}" aria-pressed="${c === state.currency}">${c}</button>`).join('')
      : '';

    const isThisYear = state.month.getFullYear() === today.getFullYear();
    $('#monthLabel').innerHTML = `${monthName(state.month)}${isThisYear ? '' : ` <span>${state.month.getFullYear()}</span>`}`;
    $('#nextMonth').disabled = state.month >= new Date(today.getFullYear(), today.getMonth(), 1);
    $('#nextMonth').style.opacity = $('#nextMonth').disabled ? .3 : 1;

    const inCur = db.txns.filter((t) => t.currency === state.currency);
    const month = inCur.filter((t) => sameMonth(t.date, state.month));
    const prev = inCur.filter((t) => sameMonth(t.date, addMonths(state.month, -1)));
    const sum = (arr, type) => arr.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);
    const inc = sum(month, 'income'), exp = sum(month, 'expense');
    const pInc = sum(prev, 'income'), pExp = sum(prev, 'expense');

    $('#net').textContent = moneyHead(inc - exp);
    $('#netSub').textContent = inc > 0
      ? (exp <= inc ? `You kept ${Math.round(((inc - exp) / inc) * 100)}% of what came in` : `You spent ${moneyShort(exp - inc)} more than came in`)
      : month.length ? 'No income recorded this month yet' : 'Nothing recorded this month';
    $('#inc').textContent = moneyHead(inc);
    $('#exp').textContent = moneyHead(exp);
    const delta = (now, then, word) => {
      if (!then) return `${month.filter((t) => t.type === word).length} transactions`;
      const p = Math.round(((now - then) / then) * 100);
      return `${p === 0 ? 'Same as' : `${p > 0 ? '▲' : '▼'} ${Math.abs(p)}% vs`} ${monthName(addMonths(state.month, -1), 'short')}`;
    };
    $('#incD').textContent = delta(inc, pInc, 'income');
    $('#expD').textContent = delta(exp, pExp, 'expense');

    renderBalance();
    renderLearn();
    renderCategories(month, exp);
    renderTrend(inCur);
    renderList(month);
  }

  function renderCategories(month, total) {
    const by = {};
    for (const t of month) if (t.type === 'expense') by[t.category] = (by[t.category] || 0) + t.amount;
    const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
    if (!rows.length) { $('#cats').innerHTML = '<p class="muted">No spending this month.</p>'; return; }
    const max = rows[0][1];
    $('#cats').innerHTML = rows.map(([cat, v]) => {
      const sel = state.category === cat;
      const dim = state.category && !sel;
      return `<button class="cat${dim ? ' dim' : ''}" data-cat="${esc(cat)}" aria-pressed="${sel}">
        <span class="ic" aria-hidden="true">${icon(cat)}</span>
        <span class="nm">${esc(cat)}</span>
        <span class="am num">${moneyShort(v)} <span class="muted">${Math.round((v / total) * 100)}%</span></span>
        <span class="track"><span class="bar" style="width:${Math.max(1, (v / max) * 100)}%"></span></span>
      </button>`;
    }).join('');
  }

  function renderTrend(inCur) {
    const el = $('#trend');
    const tip = $('#tip');
    const months = Array.from({ length: 6 }, (_, i) => addMonths(state.month, i - 5));
    const data = months.map((m) => {
      const ts = inCur.filter((t) => sameMonth(t.date, m));
      return {
        m,
        inc: ts.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0),
        exp: ts.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0),
      };
    });
    const W = el.clientWidth || 320, H = el.clientHeight || 200;
    const padL = 36, padB = 22, padT = 8;
    const iw = W - padL, ih = H - padB - padT;
    const rawMax = Math.max(1, ...data.map((d) => Math.max(d.inc, d.exp)));
    const step = niceStep(rawMax / 3);
    const max = step * Math.ceil(rawMax / step);
    const y = (v) => padT + ih - (v / max) * ih;
    const col = iw / data.length;
    const bw = Math.min(18, (col - 14) / 2);

    const bar = (x, v, cls) => {
      const h = (v / max) * ih;
      if (h <= 0) return '';
      const r = Math.min(4, h, bw / 2), top = padT + ih - h, base = padT + ih;
      return `<path fill="var(--${cls})" d="M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z"/>`;
    };

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Income and spending, last six months">`;
    for (let v = 0; v <= max + 1e-9; v += step) {
      svg += `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
      svg += `<text class="axis" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
    }
    data.forEach((d, i) => {
      const cx = padL + col * i + col / 2;
      const sel = i === data.length - 1;
      svg += bar(cx - bw - 1, d.inc, 'income') + bar(cx + 1, d.exp, 'expense');
      svg += `<text class="axis${sel ? ' sel' : ''}" x="${cx}" y="${H - 4}" text-anchor="middle">${monthName(d.m, 'short')}</text>`;
      svg += `<rect data-i="${i}" x="${padL + col * i}" y="0" width="${col}" height="${H}" fill="transparent" style="cursor:pointer"/>`;
    });
    svg += '</svg>';
    el.innerHTML = svg;
    el.appendChild(tip);

    const show = (i) => {
      const d = data[i];
      tip.innerHTML = `<b>${monthName(d.m)} ${d.m.getFullYear()}</b>
        <div class="row"><span class="swatch inc"></span>Income&nbsp;<b class="num">${money(d.inc)}</b></div>
        <div class="row"><span class="swatch exp"></span>Spent&nbsp;<b class="num">${money(d.exp)}</b></div>
        <div class="row">Left over&nbsp;<b class="num">${money(d.inc - d.exp)}</b></div>`;
      const cx = padL + col * i + col / 2;
      const half = tip.offsetWidth / 2;
      tip.style.left = Math.min(W - half, Math.max(half, cx)) + 'px';
      tip.style.top = Math.max(0, y(Math.max(d.inc, d.exp)) - tip.offsetHeight - 8) + 'px';
      tip.classList.add('on');
    };
    $$('rect[data-i]', el).forEach((r) => {
      const i = +r.dataset.i;
      r.addEventListener('pointerenter', () => show(i));
      r.addEventListener('pointerdown', () => show(i));
      r.addEventListener('click', () => { if (i !== data.length - 1) { state.month = data[i].m; state.category = null; render(); } });
    });
    el.onpointerleave = () => tip.classList.remove('on');
  }

  function niceStep(x) {
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    const f = x / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function renderList(month) {
    let items = state.category ? month.filter((t) => t.category === state.category) : month;
    $('#txCount').textContent = items.length ? `${items.length}` : '';
    const limit = state.showAll ? Infinity : 25;
    let html = state.category
      ? `<div class="filter-note"><span>${icon(state.category)} ${esc(state.category)} only</span><button id="clearFilter">Show all</button></div>`
      : '';
    if (!items.length) html += '<p class="muted">No transactions this month.</p>';
    let lastDay = '';
    items.slice(0, limit).forEach((t) => {
      const d = new Date(t.date);
      const dl = dayLabel(d);
      if (dl !== lastDay) { html += `<div class="day">${dl}</div>`; lastDay = dl; }
      html += `<button class="tx" data-id="${t.id}">
        <span class="ic" aria-hidden="true">${icon(t.category)}</span>
        <div><div class="t1">${esc(label(t))}</div><div class="t2">${esc(t.category)} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div></div>
        <span class="amt num ${t.type === 'income' ? 'in' : 'out'}">${money(t.amount, t.currency)}</span>
      </button>`;
    });
    if (items.length > limit) html += `<button class="more" id="showMore">Show ${items.length - limit} more</button>`;
    $('#list').innerHTML = html;
  }

  // ---------- sheets ----------
  const sheets = { add: $('#addSheet'), edit: $('#editSheet'), settings: $('#settingsSheet'), balance: $('#balanceSheet'), sort: $('#sortSheet'), pick: $('#pickSheet'), places: $('#placesSheet'), sync: $('#syncSheet') };
  function open(name) {
    if (name === 'add') { $('#addStep1').hidden = false; $('#addStep2').hidden = true; }
    if (name === 'settings') fillSettings();
    sheets[name].showModal();
  }
  Object.values(sheets).forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // tap backdrop
  });
  document.addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]');
    if (o) open(o.dataset.open);
    const c = e.target.closest('[data-close]');
    if (c) c.closest('dialog').close();
  });

  // Add flow
  let pending = [];
  $('#addBtn').onclick = () => open('add');
  $('#pasteClip').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      const box = $('#pasteBox');
      box.value = box.value ? box.value.trimEnd() + '\n\n' + t : t;
    } catch (e) { toast('Long-press the box and choose Paste'); $('#pasteBox').focus(); }
  };
  $('#parseBtn').onclick = () => {
    const results = P.parseBulk($('#pasteBox').value, parseOpts());
    if (!results.length) { toast('Paste at least one message first'); return; }
    const ids = new Set(db.txns.map((t) => t.id));
    const seen = new Set();
    resolveCurrencies(results.map((r) => r.txn).filter(Boolean));
    pending = results.map((r) => {
      const dup = r.txn && (ids.has(r.txn.id) || seen.has(r.txn.id));
      if (r.txn) seen.add(r.txn.id);
      return { ...r, txn: r.txn && applyRules(r.txn), dup, on: !!r.txn && !dup };
    });
    renderPreview();
    $('#addStep1').hidden = true;
    $('#addStep2').hidden = false;
  };
  function renderPreview() {
    const ok = pending.filter((p) => p.txn && !p.dup).length;
    const skipped = pending.length - ok;
    $('#pvSummary').textContent = `Found ${ok} transaction${ok === 1 ? '' : 's'}` + (skipped ? ` · ${skipped} skipped (not a transaction, OTP or already added)` : '');
    $('#preview').innerHTML = pending.map((p, i) => {
      if (!p.txn || p.dup) {
        return `<div class="pv skip"><span></span><div><div class="t1">${p.dup ? 'Already added' : 'Not a transaction'}</div><div class="t2">${esc(p.raw)}</div></div><span></span></div>`;
      }
      const t = p.txn;
      return `<label class="pv"><input type="checkbox" data-i="${i}" ${p.on ? 'checked' : ''}>
        <div><div class="t1">${icon(t.category)} ${esc(label(t))}</div><div class="t2">${esc(t.category)} · ${new Date(t.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</div></div>
        <span class="num" style="font-weight:600">${t.type === 'income' ? '+' : '−'}${money(t.amount, t.currency)}</span></label>`;
    }).join('');
    updateSaveBtn();
  }
  function updateSaveBtn() {
    const n = pending.filter((p) => p.on).length;
    $('#saveParsed').textContent = `Add ${n}`;
    $('#saveParsed').disabled = !n;
  }
  $('#preview').addEventListener('change', (e) => {
    const i = e.target.dataset.i;
    if (i !== undefined) { pending[+i].on = e.target.checked; updateSaveBtn(); }
  });
  $('#backBtn').onclick = () => { $('#addStep1').hidden = false; $('#addStep2').hidden = true; };
  $('#saveParsed').onclick = () => {
    const list = pending.filter((p) => p.on).map((p) => p.txn);
    const n = addTxns(list);
    sheets.add.close();
    $('#pasteBox').value = '';
    if (list.length) jumpToMonthOf(list[0]);
    render();
    toast(`Added ${n} transaction${n === 1 ? '' : 's'}`);
  };
  function jumpToMonthOf(t) {
    const d = new Date(t.date);
    state.currency = t.currency;
    state.month = new Date(d.getFullYear(), d.getMonth(), 1);
    state.category = null;
  }

  // Edit flow
  let editing = null, editType = 'expense';
  function setEditType(type) {
    editType = type;
    $$('#editSheet [data-type]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.type === type));
    const cats = catsFor(type);
    const cur = $('#eCategory').value;
    $('#eCategory').innerHTML = cats.map((c) => `<option value="${esc(c)}">${icon(c)} ${esc(c)}</option>`).join('');
    $('#eCategory').value = cats.includes(cur) ? cur : cats[cats.length - 1];
  }
  $$('#editSheet [data-type]').forEach((b) => (b.onclick = () => setEditType(b.dataset.type)));
  function openEdit(id) {
    editing = db.txns.find((t) => t.id === id);
    if (!editing) return;
    $('#eCategory').innerHTML = '';
    setEditType(editing.type);
    $('#eCategory').value = editing.category;
    $('#eMerchant').value = editing.merchant || '';
    $('#eAmount').value = editing.amount;
    $('#eCurrency').value = editing.currency;
    const d = new Date(editing.date);
    $('#eDate').value = new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
    $('#eRule').checked = true;
    $('#ruleText').textContent = `Always use this category for ${editing.merchant || 'this merchant'}`;
    editing._origCategory = editing.category;
    $('#ruleWrap').hidden = !editing.merchant;
    $('#eRaw').textContent = editing.raw || '';
    $('#eRaw').hidden = !editing.raw;
    open('edit');
  }
  $('#editForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!editing) return;
    const amount = parseFloat($('#eAmount').value);
    if (!(amount > 0)) { toast('Enter an amount above zero'); return; }
    editing.type = editType;
    editing.edited = true;
    editing.category = $('#eCategory').value;
    editing.merchant = $('#eMerchant').value.trim();
    editing.amount = amount;
    editing.currency = ($('#eCurrency').value || state.currency).toUpperCase().slice(0, 3);
    if ($('#eDate').value) editing.date = new Date($('#eDate').value).toISOString();
    let changed = 0;
    const catChanged = editing.category !== editing._origCategory;
    delete editing._origCategory;
    if ($('#eRule').checked && editing.merchant && catChanged) {
      const key = editing.merchant.toLowerCase();
      db.settings.rules[key] = { category: editing.category, type: editing.type };
      for (const t of db.txns) {
        if (t !== editing && t.merchant && t.merchant.toLowerCase() === key && t.type === editing.type && t.category !== editing.category) {
          t.category = editing.category; changed++;
        }
      }
    }
    db.txns.sort((a, b) => new Date(b.date) - new Date(a.date));
    save();
    sheets.edit.close();
    render();
    toast(changed ? `Saved · updated ${changed} more from ${editing.merchant}` : 'Saved');
  });
  $('#deleteTx').onclick = () => {
    if (!editing || !confirm('Delete this transaction?')) return;
    db.txns = db.txns.filter((t) => t !== editing);
    save();
    sheets.edit.close();
    render();
    toast('Deleted');
  };

  // Settings
  const intakeUrl = () => location.origin + location.pathname + '#sms=';
  function fillSettings() {
    $('#historyUrl').textContent = (location.host + location.pathname).replace(/index\.html$/, '') + 'history.html';
    $('#sCurrency').innerHTML = CURRENCIES.map((c) => `<option value="${c}">${c}</option>`).join('');
    $('#sCurrency').value = db.settings.currency;
    $('#intakeUrl').textContent = intakeUrl();
    const n = db.txns.length;
    const sample = db.txns.filter((t) => t.sample).length;
    $('#dataInfo').textContent = `${n} transaction${n === 1 ? '' : 's'} stored on this device` + (sample ? ` (${sample} sample)` : '') + '.';
    $('#sampleBtn').textContent = sample ? 'Remove sample data' : 'Load sample data';
  }
  $('#sCurrency').onchange = (e) => { db.settings.currency = e.target.value; db.settings.currencyChosen = true; state.currency = e.target.value; save(); render(); };
  $('#copyUrl').onclick = async () => {
    try { await navigator.clipboard.writeText(intakeUrl()); toast('Link copied'); } catch (e) { toast('Select the link and copy it'); }
  };
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ledger-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.txns)) throw new Error('bad file');
      const n = addTxns(data.txns.filter((t) => t && t.id && t.amount > 0 && t.date));
      Object.assign(db.settings.rules, (data.settings && data.settings.rules) || {});
      const have = new Set(db.balances.map((b) => b.currency + b.account + b.date));
      for (const b of Array.isArray(data.balances) ? data.balances : []) {
        if (b && b.currency && isFinite(b.amount) && b.date && !have.has(b.currency + b.account + b.date)) db.balances.push(b);
      }
      save(); render(); fillSettings();
      toast(`Imported ${n} new transaction${n === 1 ? '' : 's'}`);
    } catch (err) { toast("That file isn't a Ledger backup"); }
    e.target.value = '';
  };
  $('#clearBtn').onclick = () => {
    if (!confirm('Erase all transactions from this device? Export a backup first if you might need them.')) return;
    db.txns = [];
    db.balances = [];
    db.settings.rules = {};
    save(); render(); fillSettings();
    toast('All data erased');
  };
  $('#sampleBtn').onclick = () => {
    if (db.txns.some((t) => t.sample)) {
      db.txns = db.txns.filter((t) => !t.sample); save();
      toast('Sample data removed');
    } else loadSample();
    render(); fillSettings();
  };
  $('#demoBtn').onclick = loadSample;

  function loadSample() {
    const cur = db.settings.currency;
    const now = new Date();
    const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const rnd = (a, b) => Math.round((a + Math.random() * (b - a)) * 100) / 100;
    const templates = [
      ['Purchase of {c} {a} at CARREFOUR CITY MALL with card ending 4821 on {d}', 35, 95, 5],
      ['Purchase of {c} {a} at STARBUCKS on {d}', 3, 9, 7],
      ['Purchase of {c} {a} at TALABAT on {d}', 8, 24, 5],
      ['Your card was debited {c} {a} at TOTAL FUEL STATION on {d}', 20, 40, 3],
      ['Purchase of {c} {a} at UBER TRIP on {d}', 2, 9, 4],
      ['Purchase of {c} {a} at AMAZON on {d}', 15, 80, 2],
      ['Bill payment of {c} {a} to ORANGE TELECOM on {d}', 18, 30, 1],
      ['Bill payment of {c} {a} to ELECTRICITY CO on {d}', 25, 60, 1],
      ['Purchase of {c} {a} at NETFLIX.COM on {d}', 9.99, 9.99, 1],
      ['ATM cash withdrawal of {c} {a} on {d}', 40, 100, 1],
      ['Purchase of {c} {a} at CITY PHARMACY on {d}', 5, 30, 1],
    ];
    const events = []; // [date, template, amount, isIncome]
    for (let back = 3; back >= 0; back--) {
      const m = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const lastDay = back === 0 ? now.getDate() : new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      const at = (day) => new Date(m.getFullYear(), m.getMonth(), Math.min(day, lastDay), 8 + Math.floor(Math.random() * 13), Math.floor(Math.random() * 60));
      events.push([at(1), 'Your account 4821 has been credited with {c} {a} SALARY from ACME TRADING on {d}', 1450, true]);
      if (Math.random() > .4) events.push([at(1 + Math.floor(Math.random() * 27)), 'Transfer received {c} {a} from SARA K. to account 4821 on {d}', rnd(50, 200), true]);
      for (const [tpl, lo, hi, n] of templates) {
        const count = Math.max(0, Math.round(back === 0 ? (n * lastDay) / 30 : n));
        for (let k = 0; k < count; k++) events.push([at(1 + Math.floor(Math.random() * lastDay)), tpl, rnd(lo, hi), false]);
      }
    }
    events.sort((a, b) => a[0] - b[0]);
    let running = 1180;
    const msgs = events.map(([d, tpl, amt, isIncome]) => {
      running = Math.round((running + (isIncome ? amt : -amt)) * 100) / 100;
      // Like real banks, not every SMS states the balance.
      const bal = Math.random() < .7 ? `. Available balance {c} ${running.toFixed(2)}` : '';
      return (tpl + bal).replace(/\{c\}/g, cur).replace('{a}', amt.toFixed(2)).replace('{d}', fmt(d));
    });
    window.__sampleFinalBalance = running; // for tests
    const list = msgs.map((s) => P.parseMessage(s, parseOpts())).filter(Boolean).map((t) => ({ ...t, sample: true }));
    const n = addTxns(list);
    state.currency = cur;
    state.month = new Date(now.getFullYear(), now.getMonth(), 1);
    render();
    toast(`Loaded ${n} sample transactions`);
  }

  // ---------- events on the dashboard ----------
  $('#prevMonth').onclick = () => { state.month = addMonths(state.month, -1); state.category = null; state.showAll = false; render(); };
  $('#nextMonth').onclick = () => { state.month = addMonths(state.month, 1); state.category = null; state.showAll = false; render(); };
  $('#settingsBtn').onclick = () => open('settings');
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cur]');
    if (chip) { state.currency = chip.dataset.cur; state.category = null; render(); return; }
    const cat = e.target.closest('.cat');
    if (cat) { state.category = state.category === cat.dataset.cat ? null : cat.dataset.cat; render(); return; }
    const tx = e.target.closest('.tx');
    if (tx) { openPick({ id: tx.dataset.id }); return; }
    if (e.target.id === 'clearFilter') { state.category = null; render(); return; }
    if (e.target.id === 'showMore') { state.showAll = true; render(); }
  });

  // Swipe left/right on the dashboard to change month.
  let sx = null, sy = null;
  $('#dash').addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  $('#dash').addEventListener('touchend', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) (dx > 0 ? $('#prevMonth') : $('#nextMonth')).click();
  });

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 120); });

  // ---------- toast ----------
  let tt;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(tt);
    tt = setTimeout(() => el.classList.remove('on'), 2600);
  }

  // ---------- incoming SMS from the iOS Shortcut: …/#sms=<url-encoded text> ----------
  function intake() {
    let text = null;
    const h = location.hash;
    if (h.startsWith('#sms=')) text = h.slice(5);
    const q = new URLSearchParams(location.search).get('sms');
    if (!text && q) text = q;
    if (!text) return;
    try { text = decodeURIComponent(text.replace(/\+/g, ' ')); } catch (e) {}
    history.replaceState(null, '', location.pathname);
    Object.values(sheets).forEach((d) => d.open && d.close()); // show the dashboard for the new message
    const t = P.parseMessage(text, parseOpts());
    if (!t) {
      // The automation also fires for unrelated texts containing its keyword. Skip those quietly;
      // only bring up the paste screen when the message mentions money but couldn't be read.
      if (!P.looksLikeMoney(text)) { if (db.txns.length) toast('Not a bank transaction, nothing added'); return; }
      $('#pasteBox').value = text;
      open('add');
      toast("Couldn't read that one. Check it below");
      return;
    }
    const n = addTxns([t]);
    jumpToMonthOf(t);
    render();
    toast(n ? `${t.type === 'income' ? 'Received' : 'Spent'} ${money(t.amount, t.currency)}${t.merchant ? ' · ' + t.merchant : ''}` : 'Already recorded');
  }
  window.addEventListener('hashchange', intake);

  render();
  intake();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
