package com.findback.app;

import android.app.Activity;
import android.content.Intent;
import android.location.LocationManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.api.ResolvableApiException;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.LocationSettingsRequest;
import com.google.android.gms.location.Priority;
import com.google.android.gms.location.SettingsClient;

/**
 * Location-services (not permission) bridge for the Report flow.
 *
 * <p>Android location permission and device Location services are separate
 * systems: the app may hold permission while the device switch is off, in
 * which case a geolocation request just times out. These methods let the web
 * layer distinguish the two and offer the OS enable-location dialog.
 *
 * <p>Privacy/consent model: nothing here obtains a fix or changes a setting
 * silently. {@code isLocationEnabled} is a read-only check;
 * {@code requestEnableLocation} presents Android's own system dialog and the
 * user can dismiss it — denial resolves {@code enabled:false} and the app
 * falls back to typed place / manual map entry. No coordinates are logged.
 *
 * <p>Threading: plugin methods arrive on Capacitor's background thread;
 * starting the resolution intent is posted to the UI thread. A single
 * in-flight resolution is enforced — concurrent calls are rejected.
 */
@CapacitorPlugin(name = "LocationServices", requestCodes = { 0xFB10 })
public final class LocationServicesPlugin extends Plugin {

    private static final int REQUEST_ENABLE_LOCATION = 0xFB10;

    /** Guarded by the plugin instance lock: the call awaiting settings check or dialog. */
    private PluginCall pendingCall;

    private boolean isProviderEnabled() {
        try {
            Object service = getContext().getSystemService(android.content.Context.LOCATION_SERVICE);
            if (!(service instanceof LocationManager)) return false;
            LocationManager manager = (LocationManager) service;
            boolean gps;
            boolean network;
            try {
                gps = manager.isProviderEnabled(LocationManager.GPS_PROVIDER);
            } catch (Exception ignored) {
                gps = false;
            }
            try {
                network = manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
            } catch (Exception ignored) {
                network = false;
            }
            return gps || network;
        } catch (Exception ignored) {
            return false;
        }
    }

    private void resolveEnabled(PluginCall call, boolean enabled) {
        JSObject result = new JSObject();
        result.put("enabled", enabled);
        call.resolve(result);
    }

    private void resolvePending(PluginCall call, boolean enabled) {
        synchronized (this) {
            if (pendingCall != call) return;
            pendingCall = null;
        }
        resolveEnabled(call, enabled);
    }

    @PluginMethod
    public void isLocationEnabled(PluginCall call) {
        resolveEnabled(call, isProviderEnabled());
    }

    @PluginMethod
    public void requestEnableLocation(PluginCall call) {
        synchronized (this) {
            if (pendingCall != null) {
                call.reject("A location-settings request is already in progress.");
                return;
            }
            // Reserve before checkLocationSettings completes asynchronously.
            pendingCall = call;
        }
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            resolvePending(call, isProviderEnabled());
            return;
        }
        // Fast path: already on — no dialog, no Play Services round trip.
        if (isProviderEnabled()) {
            resolvePending(call, true);
            return;
        }
        LocationRequest request =
            new LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 10_000L).build();
        LocationSettingsRequest settings =
            new LocationSettingsRequest.Builder().addLocationRequest(request).build();
        SettingsClient client = LocationServices.getSettingsClient(activity);
        client
            .checkLocationSettings(settings)
            .addOnSuccessListener(ignored -> resolvePending(call, isProviderEnabled()))
            .addOnFailureListener(error -> {
                if (error instanceof ResolvableApiException) {
                    activity.runOnUiThread(() -> {
                        try {
                            ((ResolvableApiException) error).startResolutionForResult(activity, REQUEST_ENABLE_LOCATION);
                        } catch (Exception startError) {
                            resolvePending(call, isProviderEnabled());
                        }
                    });
                } else {
                    // Not resolvable here (e.g. no Play Services): the caller
                    // falls back to the manual enable message.
                    resolvePending(call, false);
                }
            });
    }

    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        super.handleOnActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_ENABLE_LOCATION) return;
        PluginCall call;
        synchronized (this) {
            call = pendingCall;
            pendingCall = null;
        }
        if (call == null) return;
        // Re-read the switch: RESULT_OK alone does not prove the provider is
        // up, and dismissal leaves it off. Report ground truth either way.
        resolveEnabled(call, isProviderEnabled());
    }
}
