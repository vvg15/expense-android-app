# Publishing Expense Manager on Google Play

Checklist plus ready-to-use answers. Policies change, so re-check Play Console's current wording when you submit.

## Before the first upload
- [x] **App id is `in.vvg.expenses`** (set in `app/build.gradle`, permanent). The GitHub APK and the Play version use the same id. For a phone that already has the GitHub version to update straight from Play (keeping its data), Play must sign with **the same key** — see *Play App Signing* below.
- [ ] Create a Google Play developer account (one-time fee).
- [ ] Publish the privacy policy at a public URL. For example, put `docs/privacy-policy.md` in a public GitHub repository and use its link, or add it as a page to your GitHub Pages site. Fill in your contact email first.
- [ ] Bump the version (`python3 bump_version.py X.Y.Z`), push, and download the **`.aab`** artifact from the Actions run.

## Create the app in Play Console
- **App or game:** App · **Free** · Category: **Finance**
- **Play App Signing:** when setting it up, choose to **use your own key** (Play Console: "Use a different key" → "Export and upload a key from Java keystore") and upload `expense-manager-upload.jks` with the passwords in `GITHUB-SECRETS.txt`. Play then signs with the same key as your GitHub APKs, so phones can switch between them without reinstalling.
  If you just accept Google's generated key instead, that's fine too, but phones with the GitHub APK must export a backup, uninstall, install from Play and import.
- **Store listing:** use `store/play-icon-512.png` and `store/feature-graphic-1024x500.png`, plus at least 2 phone screenshots (take them on your phone).

### Suggested listing text
**Short description (≤80):** Private expense tracker. Adds payments from bank SMS, offline, no internet access.

**Full description:**
> Track your spending in seconds, privately. Expense Manager works completely offline and has no internet access, so your financial data never leaves your phone.
>
> • **Add expenses from bank SMS (optional):** the app finds payment messages from your bank, cards and UPI apps, suggests the amount, merchant and category, and asks you before adding anything. Messages are analysed on your phone only and are never uploaded or shared.
> • Monthly budget, spending by category and day, search and filters
> • Recurring payments (rent, EMIs, SIPs, subscriptions) added automatically
> • Smart categories that learn from your corrections
> • Backup and restore, plus spreadsheet export for Excel or Google Sheets
> • No account, no ads, no tracking

The SMS feature must be clearly described in the listing (Play requirement), as above.

## Permissions Declaration Form (SMS)
Play Console → *App content → Sensitive permissions / Permissions declaration* (wording may differ):

- **Permission:** `READ_SMS`
- **Core functionality / use case:** *SMS-based money management* (apps that track and manage budget).
- **Description of the feature** (adapt as needed):
  > Expense Manager is a personal budget and expense tracker. Its core feature reads bank, card and UPI transaction SMS on the user's device to identify payments and suggest them as expenses, which the user reviews and confirms before they are saved. All processing happens on-device; the app has no INTERNET permission and does not transmit or share SMS data. Messages from personal phone numbers, OTPs and non-financial messages are ignored, and no message text is stored. The permission is optional and requested only after an in-app disclosure; users can disable the feature in Settings.
- **Why no alternative:** bank transaction alerts arrive only as SMS from many different senders. The SMS Retriever / User Consent APIs handle one-time codes from a single known message, not reading past transaction alerts across a date range.
- **Video:** Play usually asks for a short screen recording showing the in-app disclosure (Home → *Set up*, or Settings → *Turn on SMS reading…*), the permission prompt, and the review screen.

**Important:** approval is at Google's discretion and can be refused. If it's refused, you can still publish *without* `READ_SMS`: remove that line from `AndroidManifest.xml`. The app then hides direct SMS reading automatically and keeps the "SMS backup file" import.

## Other permissions
- `USE_BIOMETRIC` (app lock): a normal permission with no declaration needed. Android shows its own fingerprint/screen-lock prompt.
- No storage permission is used: backups go through Android's file/folder picker.

## Data safety form
Based on how the app works (verify against the current form):
- **Does your app collect or share any of the required user data types?** No data is *collected* (nothing is transmitted off the device) and none is *shared*. Google defines "collect" as transmitting data off the device. On-device-only processing is not collection.
- **Is all user data encrypted in transit?** Not applicable (no transmission).
- **Can users request that data be deleted?** Yes: in-app *Delete all data*, or uninstall.
- Mention in the privacy policy that SMS is processed on-device only (already done).

## Other Play Console sections
- **Target audience:** 18+ (financial app).
- **Ads:** No ads.
- **Content rating:** complete the questionnaire (no objectionable content).
- **Financial features declaration:** the app is a personal budgeting tool. It doesn't offer loans, banking, payments or investments.
- **Government app:** No.
- **Testing:** new personal developer accounts must run a **closed test** with a minimum number of testers for a set period before production access. Check Play Console for the current numbers.

## Updates on Play
1. `python3 bump_version.py X.Y.Z` (higher version) → push → download the `.aab` from Actions.
2. Play Console → *Production* (or a testing track) → *Create new release* → upload → roll out.
3. Users get it through Play. The app also shows **"A new version is ready — Update now"** (in-app updates).
