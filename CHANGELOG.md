# Changelog

## 2.1.0 — 19 Nov 2026 · data format v2 (automatic upgrade)
**Home**
- Daily spending now comes first; tap it to open the new **Spending trends** screen.
- Tap the month name to pick any month; "This month" appears only when you're on another month (replaces "Today").
- The backup reminder has an ✕ (hides it for 30 days) and can be switched off in Settings.
- The + button tucks away while scrolling down, so it never covers amounts or filters.

**Spending trends** (new screen)
- Week / month / 3 months / year / custom dates; ‹ › or swipe the summary to move between periods.
- Group by day, week or month. Chart styles: bars, running total vs budget pace, compare with the previous period.
- Filter by category and payment method; include or leave out transfers & investments.
- Tap a bar to list that day's/week's/month's expenses; pinch or +/− to zoom; summary of total, per-day, highest, vs previous, no-spend days.

**Money that isn't spending**
- New **Transfers** and **Investments** categories, not counted in Spent, budget or charts (shown separately as "Not counted as spending").
- Any category can be marked "not counted" (Settings → tap a category).
- SMS detection: SIPs / NACH / brokers / mutual funds → Investments; credit-card bill payments (CRED etc.) and moves between your own accounts → Transfers.

**Payments to people**
- SMS review marks UPI payments to individuals; pick a category once and it's remembered.
- New **Sort "Other"** screen (link under By category): groups "Other" expenses by person or shop, one category choice per name updates all past expenses and teaches future SMS.

**Security & backup (Android)**
- **App lock** with fingerprint, face or the phone's screen lock; lock immediately or after 1/5/30 minutes away. Content is hidden in the recent-apps screen while locked (Android 13+).
- **Automatic backup** to a folder you choose: daily or weekly, keeping the last 5/10/30 copies. Warns on Home if a backup fails.

**SMS history**
- When SMS reading is turned on (and once after this update), the app asks how far back to import: this month, 2, 3 or 6 months.

**Under the hood**
- Data format v2 adds the new categories and keywords to existing data and to old backups automatically (a pre-upgrade copy is kept).
- The Android app clears cached screens after an update. Bridge v2 (lock, backup folder). New permission: USE_BIOMETRIC (no prompt).

## 2.0.0 — 18 Nov 2026 · native Android app (data format v1, no migration needed)
- **Native Android app** (`app/`) wrapping the same screens and logic (`web/`). Targets Android 16, works from Android 7. No internet permission.
- **Reads SMS directly** (optional READ_SMS permission), after an in-app explanation of what's read, why, and that it stays on the phone. Ask again or use Android settings if refused.
- **Checks for new payment SMS each time the app opens** (and after 30+ min in the background): *Review / Later / Ignore*. Unticked items are remembered as ignored; can be switched off in Settings.
- Manual SMS import reads the phone's messages for any dates; SMS backup files still work. Shows previously ignored payments and the card/account's last digits.
- Backups and spreadsheets save through Android's "save as" screen; *Share backup* opens the share sheet (Drive, WhatsApp, email…). File import uses the system file picker.
- Android back button steps back through screens and closes forms.
- Google Play in-app updates (flexible): downloads in the background, then "Update now".
- Version code derived from `web/version.js`; GitHub Actions builds a signed APK (attached to a GitHub Release) and an App Bundle for Play.
- Privacy policy and Google Play submission notes in `docs/`.
- Permanent app id: `in.vvg.expenses`.

## 1.1.1 — 17 Nov 2026 (data format v1)
Improvements from testing with real bank SMS (ICICI, Kotak, SBI, IDFC FASTag, Pluxee):
- Card SMS ("spent using … Card XX… on <date> on MERCHANT") now picks up the merchant; "Avl Limit" cards are recognised as credit cards.
- New debit wordings: SBI "has a debit by NACH", FASTag "txn. of", ICICI "processed payment … Standing Instruction".
- Duplicate check also catches two different messages from the same bank about one payment (e.g. ICICI Standing Instruction + "spent" SMS).
- Transfers between your own accounts are flagged and unticked (a debit with the same amount credited at another bank within 30 minutes).
- Smarter categories: your own rules first, then the most specific keyword; bank-truncated names ("Haritha Vegetab", "Manjilas Medica") still match; ~60 new keywords (fuels, medicals, vegetables, stores, FASTag/toll, Lulu, BookMyShow, Jubilant/Domino's…).
- New payment methods detected: Meal card (Pluxee/Sodexo), FASTag; NACH/standing instructions → Net banking.

## 1.1.0 — 17 Nov 2026 (data format v1, no migration needed)
- **Import from SMS** (Settings): read an SMS Backup & Restore file, pick a date range, review suggested expenses with auto-assigned categories, confirm to add.
- Customisable SMS reading: category rules (built-in list of Indian merchants, add/delete/search/reset), learn-from-changes, skip senders/words/personal numbers, ATM default, fallback category and payment method.
- Duplicate detection across senders and against existing expenses; already-imported messages are never added twice.
- Spreadsheet export now includes recurring payments (Type column) and re-imports them.
- Amounts with paise always show two decimals (₹230.50).
- New optional fields: `settings.sms`; on expenses `source: "sms"` and `smsSender`.

## 1.0.0 — 17 Nov 2026 (data format v1)
- First release: offline installable Android app (PWA), data stored on device (IndexedDB).
- Expenses, categories, payment methods, monthly budget, category and daily charts, search and filters.
- Recurring payments (daily/weekly/monthly/yearly, every N, optional end date, pause/resume).
- Backup/restore (.json, versioned) and spreadsheet export/import (.csv; also reads the earlier claude.ai web version's CSV).
- In-app update prompt; automatic data migration between versions.
