package com.expensemanager.app;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.CancellationSignal;
import android.provider.DocumentsContract;
import android.view.Gravity;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.util.TypedValue;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.provider.Telephony;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Hosts the Expense Manager web app (packaged in the APK's assets) in a WebView and
 * gives it a few native abilities through {@link Bridge}: reading SMS (with the user's
 * permission), saving/sharing files, and Google Play in-app updates.
 *
 * The page is served from https://appassets.androidplatform.net/ — this origin must
 * never change, because the browser storage (IndexedDB) holding the user's data is
 * tied to it. Changing it would make existing data invisible after an update.
 */
public class MainActivity extends Activity {

    static final String ORIGIN_HOST = WebViewAssetLoader.DEFAULT_DOMAIN;
    static final String START_URL = "https://" + ORIGIN_HOST + "/index.html";

    static final int REQ_SMS = 101;
    static final int REQ_SAVE = 102;
    static final int REQ_OPEN = 103;
    static final int REQ_UPDATE = 104;
    static final int REQ_FOLDER = 105;
    static final int REQ_UNLOCK = 106;
    static final String AUTO_BACKUP_PREFIX = "expenses-autobackup_";

    private static final int MAX_SMS = 20000;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingSaveContent;
    private SharedPreferences prefs;
    private FrameLayout rootView;
    private boolean smsDeclared;
    Updater updater;

    // App lock
    private View lockOverlay;
    private boolean locked;
    private boolean authInProgress;
    private long backgroundAt;          // when the app was last sent to the background
    private boolean expectingExternal;  // we opened a picker/share sheet ourselves: don't re-lock on return
    private Runnable pendingUnlockSuccess;
    private Runnable pendingUnlockFail;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("app", MODE_PRIVATE);
        smsDeclared = isPermissionDeclared(Manifest.permission.READ_SMS);

        int bg = isDarkMode() ? Color.parseColor("#121412") : Color.parseColor("#F5F4EF");
        FrameLayout root = new FrameLayout(this);
        rootView = root;
        root.setBackgroundColor(bg);
        web = new WebView(this);
        web.setBackgroundColor(bg);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        setUpSystemBars(root);
        setUpWebView();
        setUpBackHandling();

        lockOverlay = buildLockOverlay(bg);
        root.addView(lockOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        if (isLockEnabled()) setLocked(true); else lockOverlay.setVisibility(View.GONE);
        applyRecentsPrivacy();

        // After an app update, drop any cached copies of the old screens (data is not affected).
        if (prefs.getInt("lastVersionCode", -1) != BuildConfig.VERSION_CODE) {
            web.clearCache(true);
            prefs.edit().putInt("lastVersionCode", BuildConfig.VERSION_CODE).apply();
        }

        updater = new Updater(this);
        web.loadUrl(START_URL);
        updater.checkQuietly();
    }

    // ── Layout: draw edge-to-edge but keep content clear of status/nav bars & keyboard ──
    private void setUpSystemBars(View root) {
        if (Build.VERSION.SDK_INT >= 30) {
            Window w = getWindow();
            w.setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            });
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(isDarkMode() ? 0 : light, light);
            }
        }
        // Below Android 11 the theme colours the bars and the window resizes for the keyboard.
    }

    /** Dark if the user chose Dark in the app, or chose System and the phone is in dark mode. */
    private boolean isDarkMode() {
        String t = prefs != null ? prefs.getString("theme", "system") : "system";
        if ("dark".equals(t)) return true;
        if ("light".equals(t)) return false;
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    /** Called by the page (Settings → Appearance): match the system bars to the app's theme. */
    void applyTheme(String mode) {
        String m = "dark".equals(mode) || "light".equals(mode) ? mode : "system";
        prefs.edit().putString("theme", m).apply();
        boolean dark = isDarkMode();
        int bg = dark ? Color.parseColor("#121412") : Color.parseColor("#F5F4EF");
        if (rootView != null) rootView.setBackgroundColor(bg);
        if (web != null) web.setBackgroundColor(bg);
        if (lockOverlay != null) lockOverlay.setBackgroundColor(bg);
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(dark ? 0 : light, light);
            }
        } else {
            w.setStatusBarColor(bg);
            w.setNavigationBarColor(bg);
            View d = w.getDecorView();
            int f = d.getSystemUiVisibility();
            int lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                    | (Build.VERSION.SDK_INT >= 26 ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);
            d.setSystemUiVisibility(dark ? (f & ~lightFlags) : (f | lightFlags));
        }
    }

    private void setUpWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true); // needed to read files the user picks (content://)
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(true);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(ORIGIN_HOST)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (ORIGIN_HOST.equals(u.getHost())) return false;
                // Never navigate the app window elsewhere; hand links to the system instead.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                expectingExternal = true;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(i, REQ_OPEN);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(this), "AndroidBridge");
    }

    // ── Back button: step back through the app's screens, then leave ──
    private void setUpBackHandling() {
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        }
    }

    private void goBack() {
        if (web != null && web.canGoBack()) web.goBack();
        else finish();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() { // Android 12 and older
        goBack();
    }

    @Override
    protected void onStart() {
        super.onStart();
        // Coming back from the background: lock again if it's been long enough.
        if (isLockEnabled() && !expectingExternal && backgroundAt > 0
                && System.currentTimeMillis() - backgroundAt >= lockDelaySec() * 1000L) {
            setLocked(true);
        }
        expectingExternal = false;
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        if (updater != null) updater.onResume();
        if (locked && !authInProgress) unlock();
    }

    @Override
    protected void onStop() {
        backgroundAt = System.currentTimeMillis();
        super.onStop();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (updater != null) updater.destroy();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ── Events back to the page: window.__native(type, value) ──
    void emit(String type, Object value) {
        String data;
        if (value == null) data = "null";
        else if (value instanceof String) data = JSONObject.quote((String) value);
        else data = String.valueOf(value);
        final String js = "window.__native&&window.__native(" + JSONObject.quote(type) + "," + data + ")";
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript(js, null);
        });
    }

    // ── SMS permission ──
    /** "granted", "prompt" (never asked), "denied" (can ask again) or "blocked" (must use Settings). */
    String smsPermissionState() {
        // A build without READ_SMS in the manifest (e.g. a Play version without SMS access)
        // reports "unavailable" so the page hides the feature.
        if (!smsDeclared) return "unavailable";
        if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
                && checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            return "unavailable";
        }
        if (checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED) return "granted";
        if (!prefs.getBoolean("smsAsked", false)) return "prompt";
        return shouldShowRequestPermissionRationale(Manifest.permission.READ_SMS) ? "denied" : "blocked";
    }

    /** Only called after the page has shown its explanation and the user tapped Continue. */
    void requestSmsPermission() {
        expectingExternal = true;
        prefs.edit().putBoolean("smsAsked", true).apply();
        requestPermissions(new String[]{Manifest.permission.READ_SMS}, REQ_SMS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_SMS) emit("smsPermission", smsPermissionState());
    }

    /**
     * Received messages between two times, oldest first, as a JSON array of
     * {address, ts, body}. Messages from ordinary phone numbers can be left out
     * (bank and UPI alerts come from short sender names like "AX-HDFCBK").
     * Nothing is stored or sent anywhere; the page analyses them on the device.
     */
    String readSms(long fromMs, long toMs, boolean skipPersonal) {
        if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) return "[]";
        JSONArray out = new JSONArray();
        String[] projection = {Telephony.Sms.ADDRESS, Telephony.Sms.DATE, Telephony.Sms.BODY};
        String selection = Telephony.Sms.DATE + " >= ? AND " + Telephony.Sms.DATE + " <= ?";
        String[] args = {String.valueOf(fromMs), String.valueOf(toMs)};
        try (Cursor c = getContentResolver().query(Telephony.Sms.Inbox.CONTENT_URI, projection,
                selection, args, Telephony.Sms.DATE + " ASC")) {
            if (c == null) return "[]";
            int count = 0;
            while (c.moveToNext() && count < MAX_SMS) {
                String address = c.getString(0);
                long ts = c.getLong(1);
                String body = c.getString(2);
                if (body == null) continue;
                if (skipPersonal && isPhoneNumber(address)) continue;
                JSONObject o = new JSONObject();
                o.put("address", address == null ? "" : address);
                o.put("ts", ts);
                o.put("body", body);
                out.put(o);
                count++;
            }
        } catch (Exception e) {
            return "[]";
        }
        return out.toString();
    }

    private boolean isPermissionDeclared(String permission) {
        try {
            String[] requested = getPackageManager()
                    .getPackageInfo(getPackageName(), PackageManager.GET_PERMISSIONS).requestedPermissions;
            if (requested != null) for (String r : requested) if (permission.equals(r)) return true;
        } catch (Exception ignored) {
        }
        return false;
    }

    static boolean isPhoneNumber(String address) {
        if (address == null) return false;
        return address.replaceAll("[\\s()-]", "").matches("\\+?\\d{8,}");
    }

    void openAppSettings() {
        expectingExternal = true;
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getPackageName(), null));
        try {
            startActivity(i);
        } catch (ActivityNotFoundException ignored) {
        }
    }

    // ── Files ──
    /** Lets the user choose where to save (Downloads, Drive, …). Result → "fileSaved" true/false. */
    void saveFile(String name, String mime, String content) {
        expectingExternal = true;
        pendingSaveContent = content;
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(mime);
        i.putExtra(Intent.EXTRA_TITLE, name);
        try {
            startActivityForResult(i, REQ_SAVE);
        } catch (ActivityNotFoundException e) {
            pendingSaveContent = null;
            emit("fileSaved", false);
        }
    }

    /** Opens the Android share sheet with the file attached. */
    boolean shareFile(String name, String mime, String content) {
        try {
            File dir = new File(getCacheDir(), "shared");
            if (!dir.exists() && !dir.mkdirs()) return false;
            File f = new File(dir, name.replaceAll("[^A-Za-z0-9._-]", "_"));
            try (FileOutputStream os = new FileOutputStream(f)) {
                os.write(content.getBytes(StandardCharsets.UTF_8));
            }
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".files", f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.putExtra(Intent.EXTRA_SUBJECT, name);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            final Intent chooser = Intent.createChooser(send, getString(R.string.share_backup));
            runOnUiThread(() -> {
                try {
                    expectingExternal = true;
                    startActivity(chooser);
                } catch (ActivityNotFoundException ignored) {
                }
            });
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_OPEN) {
            if (fileCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
        } else if (requestCode == REQ_SAVE) {
            boolean ok = false;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingSaveContent != null) {
                try (OutputStream os = getContentResolver().openOutputStream(data.getData(), "wt")) {
                    if (os != null) {
                        os.write(pendingSaveContent.getBytes(StandardCharsets.UTF_8));
                        ok = true;
                    }
                } catch (Exception ignored) {
                }
            }
            pendingSaveContent = null;
            emit("fileSaved", ok);
        } else if (requestCode == REQ_UPDATE) {
            if (resultCode != RESULT_OK) emit("updateStatus", "declined");
        } else if (requestCode == REQ_FOLDER) {
            String name = "";
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri tree = data.getData();
                try {
                    getContentResolver().takePersistableUriPermission(tree,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    releaseBackupFolder();
                    prefs.edit().putString("backupTree", tree.toString()).apply();
                    name = backupFolderName();
                } catch (Exception ignored) {
                    name = "";
                }
            }
            emit("backupFolder", name);
        } else if (requestCode == REQ_UNLOCK) {
            authInProgress = false;
            Runnable r = resultCode == RESULT_OK ? pendingUnlockSuccess : pendingUnlockFail;
            pendingUnlockSuccess = null;
            pendingUnlockFail = null;
            if (r != null) r.run();
        }
    }

    // ── App lock ────────────────────────────────────────────────────────────
    boolean isLockEnabled() { return prefs.getBoolean("lockEnabled", false); }
    int lockDelaySec() { return prefs.getInt("lockDelay", 60); }

    boolean deviceSecure() {
        KeyguardManager km = getSystemService(KeyguardManager.class);
        return km != null && km.isDeviceSecure();
    }

    String lockStateJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("available", deviceSecure());
            o.put("enabled", isLockEnabled());
            o.put("delay", lockDelaySec());
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    /** Turning the lock on or off always asks for the fingerprint/screen lock first. */
    void setLockEnabled(boolean enable) {
        if (enable && !deviceSecure()) {
            emit("lockChanged", lockStateJsonRaw());
            return;
        }
        authenticate(() -> {
            prefs.edit().putBoolean("lockEnabled", enable).apply();
            applyRecentsPrivacy();
            emit("lockChanged", lockStateJsonRaw());
        }, () -> emit("lockChanged", lockStateJsonRaw()));
    }

    void setLockDelay(int sec) {
        prefs.edit().putInt("lockDelay", Math.max(0, sec)).apply();
    }

    /** emit() quotes strings; pass the JSON as an object literal instead. */
    private Object lockStateJsonRaw() {
        return new Object() {
            @Override
            public String toString() { return lockStateJson(); }
        };
    }

    private void applyRecentsPrivacy() {
        // Hide the app's content in the recent-apps screen when the lock is on.
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(!isLockEnabled());
    }

    private void setLocked(boolean value) {
        locked = value;
        if (lockOverlay != null) lockOverlay.setVisibility(value ? View.VISIBLE : View.GONE);
    }

    private void unlock() {
        authenticate(() -> setLocked(false), () -> { /* stay locked; the Unlock button retries */ });
    }

    @SuppressWarnings("deprecation")
    private void authenticate(Runnable onSuccess, Runnable onFail) {
        if (authInProgress) return;
        if (!deviceSecure()) { // screen lock was removed: nothing to check against
            onSuccess.run();
            return;
        }
        authInProgress = true;
        String title = getString(R.string.unlock_title);
        String subtitle = getString(R.string.unlock_subtitle);
        if (Build.VERSION.SDK_INT >= 28) {
            BiometricPrompt.Builder b = new BiometricPrompt.Builder(this).setTitle(title).setSubtitle(subtitle);
            if (Build.VERSION.SDK_INT >= 30) {
                b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK
                        | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            } else {
                b.setDeviceCredentialAllowed(true);
            }
            b.build().authenticate(new CancellationSignal(), getMainExecutor(),
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                            authInProgress = false;
                            onSuccess.run();
                        }

                        @Override
                        public void onAuthenticationError(int errorCode, CharSequence errString) {
                            authInProgress = false;
                            onFail.run();
                        }
                    });
        } else {
            KeyguardManager km = getSystemService(KeyguardManager.class);
            Intent i = km == null ? null : km.createConfirmDeviceCredentialIntent(title, subtitle);
            if (i == null) {
                authInProgress = false;
                onSuccess.run();
                return;
            }
            pendingUnlockSuccess = onSuccess;
            pendingUnlockFail = onFail;
            expectingExternal = true;
            startActivityForResult(i, REQ_UNLOCK);
        }
    }

    private View buildLockOverlay(int bg) {
        boolean dark = isDarkMode();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(bg);
        box.setClickable(true); // block touches to the page underneath
        int pad = dp(32);
        box.setPadding(pad, pad, pad, pad);

        ImageView icon = new ImageView(this);
        icon.setImageResource(R.mipmap.ic_launcher);
        box.addView(icon, new LinearLayout.LayoutParams(dp(72), dp(72)));

        TextView title = new TextView(this);
        title.setText(R.string.locked_title);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTextColor(dark ? Color.parseColor("#ECEEE8") : Color.parseColor("#1C1D1A"));
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, dp(20), 0, dp(20));
        box.addView(title);

        Button unlock = new Button(this);
        unlock.setText(R.string.unlock_button);
        unlock.setOnClickListener(v -> unlock());
        box.addView(unlock);
        return box;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // ── Automatic backup folder ─────────────────────────────────────────────
    void chooseBackupFolder() {
        expectingExternal = true;
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {
            startActivityForResult(i, REQ_FOLDER);
        } catch (ActivityNotFoundException e) {
            emit("backupFolder", "");
        }
    }

    private Uri backupTree() {
        String t = prefs.getString("backupTree", null);
        if (t == null) return null;
        Uri tree = Uri.parse(t);
        // Still allowed to write there? (The user can revoke it, or the folder can disappear.)
        for (android.content.UriPermission p : getContentResolver().getPersistedUriPermissions()) {
            if (p.getUri().equals(tree) && p.isWritePermission()) return tree;
        }
        return null;
    }

    String backupFolderName() {
        Uri tree = backupTree();
        if (tree == null) return "";
        try {
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            try (Cursor c = getContentResolver().query(doc,
                    new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToNext() && c.getString(0) != null) return c.getString(0);
            }
        } catch (Exception ignored) {
        }
        return "Backup folder";
    }

    void releaseBackupFolder() {
        String t = prefs.getString("backupTree", null);
        if (t != null) {
            try {
                getContentResolver().releasePersistableUriPermission(Uri.parse(t),
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) {
            }
            prefs.edit().remove("backupTree").apply();
        }
    }

    /** Writes name into the chosen folder (replacing a same-named file), then keeps only the newest `keep` auto-backups. */
    String writeBackup(String name, String content, int keep) {
        Uri tree = backupTree();
        if (tree == null) return "backup folder not available";
        try {
            String treeId = DocumentsContract.getTreeDocumentId(tree);
            Uri parent = DocumentsContract.buildDocumentUriUsingTree(tree, treeId);
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, treeId);
            List<String[]> autos = new ArrayList<>(); // {displayName, documentId}
            try (Cursor c = getContentResolver().query(children, new String[]{
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_DOCUMENT_ID},
                    null, null, null)) {
                while (c != null && c.moveToNext()) {
                    String n = c.getString(0);
                    if (n != null && n.startsWith(AUTO_BACKUP_PREFIX) && n.endsWith(".json")) autos.add(new String[]{n, c.getString(1)});
                }
            }
            for (String[] a : autos) {
                if (a[0].equals(name)) DocumentsContract.deleteDocument(getContentResolver(),
                        DocumentsContract.buildDocumentUriUsingTree(tree, a[1]));
            }
            autos.removeIf(a -> a[0].equals(name));
            Uri doc = DocumentsContract.createDocument(getContentResolver(), parent, "application/json", name);
            if (doc == null) return "couldn't create the file";
            try (OutputStream os = getContentResolver().openOutputStream(doc, "wt")) {
                if (os == null) return "couldn't write the file";
                os.write(content.getBytes(StandardCharsets.UTF_8));
            }
            // Prune: names sort by date (expenses-autobackup_YYYY-MM-DD.json), oldest first.
            Collections.sort(autos, (x, y) -> x[0].compareTo(y[0]));
            int excess = autos.size() + 1 - Math.max(1, keep);
            for (int i = 0; i < excess && i < autos.size(); i++) {
                try {
                    DocumentsContract.deleteDocument(getContentResolver(),
                            DocumentsContract.buildDocumentUriUsingTree(tree, autos.get(i)[1]));
                } catch (Exception ignored) {
                }
            }
            return "ok";
        } catch (Exception e) {
            String m = e.getMessage();
            return m == null ? "couldn't save the backup" : m;
        }
    }
}
