# Ledger

Income and spending from your bank's SMS alerts. Nothing to type by hand. Private and offline: data stays in your browser.

- Reads English and Arabic bank messages (amount, currency, income or spending, merchant, date)
- Skips OTP codes, declined transactions and balance amounts, and ignores duplicates
- Sorts each transaction into a category automatically. Fix one and tick "always" to remember it for that merchant
- Balance: read from the SMS that include it ("Available balance …"), kept up to date between messages from the transactions in between, per account/card. If your bank never sends it, enter it once and Ledger takes it from there
- Dashboard: balance, what's left over, income and spending vs last month, where the money went, a 6-month trend, transactions

## Use it on iPhone
1. Host this folder on any HTTPS static host (e.g. GitHub Pages) and open it in Safari.
2. **Old messages:** in Messages, copy bank SMS → **Add messages** → paste (many at once, blank line between).
3. **New messages, automatically:** Settings in the app shows step-by-step instructions for a Shortcuts
   *Message* automation that opens `…/#sms=<message>` for every SMS from your bank.

Back up regularly from Settings → Export backup (data lives only in this browser).

## Develop
```
python3 -m http.server 8000   # open http://localhost:8000
node --test                   # parser tests
```
To support a new bank's wording, add an example to `parser.test.js` and adjust the keyword lists in `parser.js`.
