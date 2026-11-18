# Expense Manager for Android

A private, offline expense tracker. The app has **no internet access**, and all data stays on the phone.

**Features:** expenses with categories, budget, charts · recurring payments · **finds payments in your bank / card / UPI SMS and asks before adding them** · backup and restore (.json) · spreadsheet export and import (.csv).

```
web/            the app's screens and logic (HTML/CSS/JS), shared with the browser version
app/            the Android shell: WebView + native features (SMS, files, Play updates)
.github/        GitHub Actions: builds the APK / App Bundle on every push
docs/           privacy policy and Google Play submission notes
store/          Play Store icon and feature graphic
bump_version.py set a new version number (do this for every release)
```

---

## 1. Set up GitHub (one time, ~10 minutes)

GitHub builds the app for you, so you don't need Android Studio.

1. On github.com, create a **new repository**, e.g. `expense-manager-android`. **Private** is fine.
2. Unzip this project and upload **everything inside the `expense-manager-android` folder** using *Add file → Upload files*. Include the hidden `.github` folder. On Windows/Mac, turn on "show hidden files" if you can't see it. If drag-and-drop skips it, create the file `.github/workflows/build.yml` in GitHub (*Add file → Create new file*) and paste in its content.
3. Add the signing secrets. Open *Settings → Secrets and variables → Actions → New repository secret* and add the 4 values from **`GITHUB-SECRETS.txt`** (in the separate signing-key zip):
   `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.
4. Open the **Actions** tab and click **Build Android app → Run workflow** (or just push any change).
   The build takes about 5 minutes and ends with a green tick.
5. Open **Releases** (right side of the repository's main page) and you'll see **Expense Manager 2.0.0** with an `.apk` file.

> 🔑 **Keep the signing key safe.** Store `expense-manager-upload.jks` and `GITHUB-SECRETS.txt` somewhere private (Google Drive plus another copy). Every update must be signed with this key, or phones will refuse it. Never upload these files to the repository itself.

## 2. Install on your phone

1. On the phone, open the repository's **Releases** page (sign in to GitHub if the repository is private) and download the `.apk`.
2. Open it. Android asks once to allow installing from your browser or Files app: tap **Settings → Allow**, then **Install**.
3. Open **Expense Manager**.

**Moving from the web (PWA) version:** in the old app, go to *Settings → Export backup*. In the new app, go to *Settings → Import file… → Replace all*. Then remove the old one from your home screen.

## 3. Updating

**Installed from GitHub:** when a new version is built, download the new `.apk` from Releases and install it over the old one. Your data is kept, as long as it was signed with the same key.

**Installed from Google Play:** Play updates the app. The app also checks Play when it opens (at most once a day), downloads updates in the background, and shows **"A new version is ready — Update now"**.

### Releasing a new version (for whoever changes the code)
1. Make the changes (usually in `web/`).
2. Run `python3 bump_version.py X.Y.Z` with a higher number. This sets the version everywhere, and Android's `versionCode` becomes `X*10000 + Y*100 + Z`, which must always go up.
3. Add a line to `CHANGELOG.md` and push. GitHub builds the release.

### Rules that keep updates safe (please keep them)
| What | Rule |
|---|---|
| **App id** `in.vvg.expenses` (`app/build.gradle`) | Permanent. Never change it: Google Play and installed phones identify the app by it, and a different id would be a separate app. (The Java package `com.expensemanager.app` is internal and doesn't matter.) |
| **Page address** `https://appassets.androidplatform.net/` (`MainActivity.java`) | Never change it. The data on the phone is tied to this address. |
| **Signing key** | Never change it (see above). |
| **Data format** (`web/js/schema.js`) | Changed the shape of saved records? Bump `SCHEMA_VERSION` and **add** a migration. Never edit old migrations. Phones upgrade their data automatically on first launch, and old backups import into any newer version. |
| **Native bridge** (`Bridge.java`, `web/js/native.js`) | Only add methods, never rename or remove them. The page checks a method exists before calling it. |
| **New web files** | Nothing to do for Android. Add them to `web/sw.js` only if you also publish the browser version. |

## 4. Reading SMS: how it works

- **Optional.** On first launch the Home screen offers *Add expenses from your bank SMS*. Before Android's permission prompt, the app explains in plain words what it reads, why, and that nothing leaves the phone. You can also turn it on or off later in *Settings → Import from SMS*.
- **Every time the app opens** (and when you come back to it after 30+ minutes) it reads new messages since the last checks (at most 90 days back) and finds bank, card and UPI debits. If there are new ones, it asks: **Review / Later / Ignore**. *Review* opens the same review screen as the manual import, where you can edit, untick and confirm. Anything left unticked is remembered as ignored and not asked about again.
- **Manual import** (*Settings → Find payments in SMS…*) reads the phone's messages for any date range. It also shows previously ignored ones, marked "You ignored this before". An SMS backup file still works too.
- **Everything is analysed on the phone.** Messages from ordinary phone numbers are skipped before analysis (configurable). No message text is stored, only the expenses you confirm.
- The same recognition as before: duplicate detection across banks, transfers to your own accounts, category rules with learning, and so on. New: the card or account's last digits are shown ("••9005").

## 5. Publishing on Google Play (when you're ready)

See **[docs/PLAY_STORE.md](docs/PLAY_STORE.md)**. In short:
- Google Play allows reading SMS for **"SMS-based money management"** (budget tracking) only after Google reviews a **Permissions Declaration**. Approval isn't guaranteed. The app is built to meet the requirements: SMS is the core feature, it's optional, there's an in-app explanation before the permission prompt, the work happens on-device, and nothing is shared.
- You need a privacy policy URL ([docs/privacy-policy.md](docs/privacy-policy.md)), the Data safety answers, and the store graphics in `store/`.
- Upload the **.aab** from the latest Actions run. When setting up **Play App Signing**, choose to use your own key and upload `expense-manager-upload.jks`, so Play builds match your GitHub APKs and phones can switch to Play without reinstalling.

## Technical notes
- Target Android 16 (API 36), minimum Android 7.0 (API 24). Android Gradle Plugin 8.13, Gradle 8.14.3, Java 17.
- Dependencies: `androidx.webkit` (serves the bundled screens from a secure local address), `androidx.core` (FileProvider for sharing), `play:app-update` (in-app updates).
- No `INTERNET` permission. The manifest actively removes it in case a library adds it.
- Back button: moves back through the app's screens and closes open forms; on the Home screen it leaves the app.
- Test in a browser: `cd web && python3 -m http.server 8000`. The Android-only parts stay hidden there.
