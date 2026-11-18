package com.expensemanager.app;

import android.content.SharedPreferences;

import com.google.android.play.core.appupdate.AppUpdateInfo;
import com.google.android.play.core.appupdate.AppUpdateManager;
import com.google.android.play.core.appupdate.AppUpdateManagerFactory;
import com.google.android.play.core.appupdate.AppUpdateOptions;
import com.google.android.play.core.install.InstallStateUpdatedListener;
import com.google.android.play.core.install.model.AppUpdateType;
import com.google.android.play.core.install.model.InstallStatus;
import com.google.android.play.core.install.model.UpdateAvailability;

/**
 * Google Play in-app updates ("flexible" flow): when Play has a newer version, it
 * downloads in the background while the app keeps working, then the page shows
 * "A new version is ready — Update now", which restarts into the new version.
 *
 * Only works when the app was installed from Google Play. For APKs installed by hand
 * the checks simply fail quietly.
 */
final class Updater {
    private static final long QUIET_INTERVAL_MS = 24L * 60 * 60 * 1000; // ask at most once a day

    private final MainActivity activity;
    private final AppUpdateManager manager;
    private final SharedPreferences prefs;
    private boolean listening;

    private final InstallStateUpdatedListener listener = state -> {
        if (state.installStatus() == InstallStatus.DOWNLOADED) {
            Updater.this.activity.emit("updateReady", true);
        } else if (state.installStatus() == InstallStatus.FAILED) {
            Updater.this.activity.emit("updateStatus", "error");
        }
    };

    Updater(MainActivity activity) {
        this.activity = activity;
        this.manager = AppUpdateManagerFactory.create(activity);
        this.prefs = activity.getSharedPreferences("app", MainActivity.MODE_PRIVATE);
    }

    /** On app start: offer an available update at most once a day. */
    void checkQuietly() {
        long last = prefs.getLong("lastUpdatePrompt", 0);
        if (System.currentTimeMillis() - last < QUIET_INTERVAL_MS) {
            onResume();
            return;
        }
        check(false);
    }

    /** userAsked = true when the user tapped "Check for updates"; reports the outcome. */
    void check(boolean userAsked) {
        manager.getAppUpdateInfo()
                .addOnSuccessListener(info -> handle(info, userAsked))
                .addOnFailureListener(e -> {
                    if (userAsked) activity.emit("updateStatus", "unavailable");
                });
    }

    private void handle(AppUpdateInfo info, boolean userAsked) {
        if (info.installStatus() == InstallStatus.DOWNLOADED) {
            activity.emit("updateReady", true);
            return;
        }
        boolean available = info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE
                && info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE);
        if (!available) {
            if (userAsked) {
                boolean busy = info.installStatus() == InstallStatus.DOWNLOADING
                        || info.installStatus() == InstallStatus.PENDING;
                activity.emit("updateStatus", busy ? "downloading" : "none");
            }
            return;
        }
        if (!listening) {
            manager.registerListener(listener);
            listening = true;
        }
        try {
            prefs.edit().putLong("lastUpdatePrompt", System.currentTimeMillis()).apply();
            manager.startUpdateFlowForResult(info, activity,
                    AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build(), MainActivity.REQ_UPDATE);
            if (userAsked) activity.emit("updateStatus", "available");
        } catch (Exception e) {
            if (userAsked) activity.emit("updateStatus", "error");
        }
    }

    /** Called from the page's "Update now" button: installs and restarts the app. */
    void complete() {
        manager.completeUpdate();
    }

    /** If an update finished downloading while the app was in the background, say so. */
    void onResume() {
        manager.getAppUpdateInfo().addOnSuccessListener(info -> {
            if (info.installStatus() == InstallStatus.DOWNLOADED) activity.emit("updateReady", true);
        });
    }

    void destroy() {
        if (listening) {
            manager.unregisterListener(listener);
            listening = false;
        }
    }
}
