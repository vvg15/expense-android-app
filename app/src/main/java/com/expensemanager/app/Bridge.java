package com.expensemanager.app;

import android.webkit.JavascriptInterface;

/**
 * The small set of native functions the page can call as window.AndroidBridge.*.
 * Keep method names stable: newer app versions may add methods, but the page checks
 * for a method before calling it, so old and new versions stay compatible.
 *
 * Methods run on a background thread; anything touching the UI hops to the main thread.
 */
final class Bridge {
    private final MainActivity a;

    Bridge(MainActivity activity) {
        this.a = activity;
    }

    /** Version of the bridge API (not the app). Bump when adding methods. */
    @JavascriptInterface
    public int bridgeVersion() {
        return 1;
    }

    @JavascriptInterface
    public String appVersion() {
        return BuildConfig.VERSION_NAME;
    }

    @JavascriptInterface
    public String smsPermissionState() {
        return a.smsPermissionState();
    }

    @JavascriptInterface
    public void requestSmsPermission() {
        a.runOnUiThread(a::requestSmsPermission);
    }

    /** fromMs/toMs are strings to avoid number precision issues across the bridge. */
    @JavascriptInterface
    public String readSms(String fromMs, String toMs, boolean skipPersonal) {
        try {
            return a.readSms(Long.parseLong(fromMs), Long.parseLong(toMs), skipPersonal);
        } catch (NumberFormatException e) {
            return "[]";
        }
    }

    @JavascriptInterface
    public void saveFile(String name, String mime, String content) {
        a.runOnUiThread(() -> a.saveFile(name, mime, content));
    }

    @JavascriptInterface
    public boolean shareFile(String name, String mime, String content) {
        return a.shareFile(name, mime, content);
    }

    @JavascriptInterface
    public void openAppSettings() {
        a.runOnUiThread(a::openAppSettings);
    }

    @JavascriptInterface
    public void checkForUpdate() {
        a.runOnUiThread(() -> a.updater.check(true));
    }

    @JavascriptInterface
    public void completeUpdate() {
        a.runOnUiThread(() -> a.updater.complete());
    }
}
