package com.findback.app;

import android.content.Intent;
import android.provider.Settings;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens the OS-level FindBack notification settings so a user who denied the
 * Android 13+ permission can re-enable it. The in-app inbox never depends on
 * this; it is purely a recovery path from the notification settings UI.
 */
@CapacitorPlugin(name = "FindbackNotifications")
public class FindbackNotificationsPlugin extends Plugin {
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        getContext().startActivity(intent);
        call.resolve();
    }
}
