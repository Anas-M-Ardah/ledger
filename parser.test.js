// Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessage, splitMessages } = require('./parser.js');

const opts = { defaultCurrency: 'JOD', receivedAt: '2026-11-06T10:00:00.000Z' };
const p = (s) => parseMessage(s, opts);

const cases = [
  ['Your card ending 1234 was used for a purchase of JOD 25.500 at CARREFOUR CITY MALL on 03/11/2026 14:22. Available balance JOD 1,240.000',
    { amount: 25.5, currency: 'JOD', type: 'expense', category: 'Groceries', day: '2026-11-03' }],
  ['Dear customer, your account has been credited with JOD 950.00 SALARY from ACME LLC on 01-11-2026. Balance: JOD 2,190.00',
    { amount: 950, currency: 'JOD', type: 'income', category: 'Salary', day: '2026-11-01' }],
  ['Your a/c XX4521 debited by USD 12.99 for NETFLIX.COM on 2026-10-28. Avl Bal USD 410.20',
    { amount: 12.99, currency: 'USD', type: 'expense', category: 'Entertainment', day: '2026-10-28' }],
  ['تم خصم مبلغ 18.750 دينار من بطاقتك لدى مطعم الريم بتاريخ 02/11/2026 الرصيد المتاح 820.000 دينار',
    { amount: 18.75, currency: 'JOD', type: 'expense', category: 'Dining', day: '2026-11-02' }],
  ['تم إيداع ٥٠٠٫٠٠ د.أ في حسابك رقم ***8812 حوالة واردة من أحمد. الرصيد ١٣٢٠٫٠٠ د.أ',
    { amount: 500, currency: 'JOD', type: 'income', category: 'Transfers' }],
  ['ATM cash withdrawal of AED 200.00 from your account on 05 Nov 2026. Available balance AED 3,500.00',
    { amount: 200, currency: 'AED', type: 'expense', category: 'Cash', day: '2026-11-05' }],
  ['Purchase SAR 45.00 at UBER *TRIP card **9988 05/11/26 09:12',
    { amount: 45, currency: 'SAR', type: 'expense', category: 'Transport', merchant: 'UBER *TRIP' }],
  ['Refund of $30.00 from AMAZON has been credited to your card.',
    { amount: 30, currency: 'USD', type: 'income', category: 'Refund' }],
  ['CliQ transfer of JOD 40.000 sent to MOHAMMAD ALI. Ref 99812',
    { amount: 40, currency: 'JOD', type: 'expense', category: 'Transfers', merchant: 'MOHAMMAD ALI' }],
  ['Your ZAIN bill payment of 15.000 JOD was successful.',
    { amount: 15, currency: 'JOD', type: 'expense', category: 'Bills' }],
];

for (const [msg, exp] of cases) {
  test(msg.slice(0, 60), () => {
    const t = p(msg);
    assert.ok(t, 'should parse');
    assert.equal(t.amount, exp.amount);
    assert.equal(t.currency, exp.currency);
    assert.equal(t.type, exp.type);
    assert.equal(t.category, exp.category);
    if (exp.merchant) assert.equal(t.merchant, exp.merchant);
    if (exp.day) {
      const d = new Date(t.date);
      const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      assert.equal(local, exp.day);
    }
  });
}

test('merchant extracted from "at"', () => {
  assert.equal(p(cases[0][0]).merchant, 'CARREFOUR CITY MALL');
});

test('ignores OTP and declined messages', () => {
  assert.equal(p('Your OTP for purchase of JOD 25.000 at AMAZON is 482910. Do not share it.'), null);
  assert.equal(p('Transaction of USD 50.00 at STEAM was declined due to insufficient funds.'), null);
  assert.equal(p('رمز التحقق الخاص بك هو 4821 لعملية شراء بمبلغ 20 دينار'), null);
});

test('ignores non-transaction messages', () => {
  assert.equal(p('Enjoy 20% off at participating restaurants this weekend!'), null);
});

test('balance-only amount is not a transaction', () => {
  assert.equal(p('Your available balance is JOD 1,240.000 as of today.'), null);
});

test('same message gives same id (dedupe)', () => {
  assert.equal(p(cases[0][0]).id, p(cases[0][0] + '  ').id);
});

test('splitMessages: blank lines and one-per-line', () => {
  assert.equal(splitMessages('a JOD 1 debited\n\nb JOD 2 debited\n\n\nc').length, 3);
  assert.equal(splitMessages('Purchase JOD 1 at X\nPurchase JOD 2 at Y').length, 2);
  assert.equal(splitMessages('Purchase JOD 1 at X\ncontinued text').length, 1);
});

test('captures balance after the transaction', () => {
  const t = p(cases[0][0]);
  assert.equal(t.balance, 1240);
  assert.equal(p(cases[1][0]).balance, 2190);
  assert.equal(p(cases[3][0]).balance, 820); // Arabic: الرصيد المتاح
  assert.equal(p(cases[4][0]).balance, 1320); // Arabic-Indic digits
  assert.equal(p(cases[7][0]).balance, null); // no balance in message
});

test('balance in another currency is ignored', () => {
  assert.equal(p('Purchase of USD 10.00 at STEAM. Available balance JOD 500.000').balance, null);
});

test('captures account / card last digits', () => {
  assert.equal(p(cases[0][0]).account, '1234');
  assert.equal(p(cases[2][0]).account, '4521');
  assert.equal(p(cases[4][0]).account, '8812');
  assert.equal(p(cases[6][0]).account, '9988');
  assert.equal(p('Your account 0012345678 was debited JOD 5.000 at KFC').account, '5678');
  assert.equal(p(cases[8][0]).account, ''); // "Ref 99812" is not an account
});

test('looksLikeMoney separates unrelated texts from unreadable bank texts', () => {
  const { looksLikeMoney } = require('./parser.js');
  assert.equal(looksLikeMoney('Meet at 5? Bring the JOD documents'), false);
  assert.equal(looksLikeMoney('Arab Bank: JOD 12.500 hold placed on card 1234'), true);
});

// Real Arab Bank (Jordan) format
const ARAB_BANK = 'JO\nYou have a purchase transaction on account 0196*500 from AL MOALLEM AL AFGHANI RES amount JOD 10.000 on 08/11/2026 15:50 . Balance JOD 1016.126';
test('Arab Bank purchase', () => {
  const t = parseMessage(ARAB_BANK, { defaultCurrency: 'JOD', receivedAt: '2026-11-08T18:00:00Z' });
  assert.equal(t.type, 'expense');
  assert.equal(t.amount, 10);
  assert.equal(t.currency, 'JOD');
  assert.equal(t.merchant, 'AL MOALLEM AL AFGHANI RES');
  assert.equal(t.category, 'Dining');
  assert.equal(t.balance, 1016.126);
  assert.equal(t.account, '500');
});

test('food words in merchant names', () => {
  const cat = (m) => p(`Purchase of JOD 3.000 at ${m} on 03/11/2026`).category;
  for (const m of ['HABIBAH SWEETS', 'ABU JBARA REST', 'AL QUDS FALAFEL', 'BURGERIZZR', 'REEM GRILL HOUSE', 'SEVEN BAKERY'])
    assert.equal(cat(m), 'Dining', m);
  assert.equal(cat('RESTAURANT ALDAR'), 'Dining');
  assert.equal(cat('PRESTIGE AUTO'), 'Other'); // "res" inside a word is not food
});

test('splitMessages: inbox file with --- separators and multi-line messages', () => {
  const inbox = '---\n' + ARAB_BANK + '\n---\nJO\nYou have a purchase transaction on account 0196*500 from ZAIN amount JOD 5.000 on 08/11/2026 16:00 . Balance JOD 1011.126\n---\n';
  const parts = splitMessages(inbox);
  assert.equal(parts.length, 2);
  assert.equal(parseMessage(parts[1], { defaultCurrency: 'JOD' }).amount, 5);
});
