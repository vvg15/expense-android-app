package com.expensemanager.app;

import android.Manifest;
import android.app.Activity;
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

    private static final int MAX_SMS = 20000;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingSaveContent;
    private SharedPreferences prefs;
    private boolean smsDeclared;
    Updater updater;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("app", MODE_PRIVATE);
        smsDeclared = isPermissionDeclared(Manifest.permission.READ_SMS);

        int bg = isDarkMode() ? Color.parseColor("#121412") : Color.parseColor("#F5F4EF");
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(bg);
        web = new WebView(this);
        web.setBackgroundColor(bg);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        setUpSystemBars(root);
        setUpWebView();
        setUpBackHandling();

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

    private boolean isDarkMode() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
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
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        if (updater != null) updater.onResume();
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
        }
    }
}
