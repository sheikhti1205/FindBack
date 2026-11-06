package com.findback.app;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationClient;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.ClearTokenRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;

/**
 * Native Google Drive authorization for the optional chat backup.
 *
 * <p>Why this exists: the web build obtains its token from Google Identity
 * Services inside the page, and Google refuses that script inside an Android
 * WebView ({@code disallowed_useragent}). The backup therefore had no Android
 * path at all. This plugin performs the same narrow grant natively and hands
 * the JS layer only a short-lived OAuth access token.
 *
 * <p>Deliberate boundaries:
 * <ul>
 *   <li>Exactly one scope is requested — {@code drive.appdata}. Adding
 *       {@code email}/{@code openid} would widen the consent screen, so the
 *       account label shown to the user comes from the local account picker
 *       instead of from the token.
 *   <li>No account permission is requested. The plugin never enumerates the
 *       device's accounts; it asks the system picker once and remembers the
 *       chosen account name locally, so a later silent renewal reuses it
 *       without a chooser and without {@code GET_ACCOUNTS}.
 *   <li>This is never a Norfold sign-in. The token is returned to the backup
 *       store only and is never forwarded to Supabase; Google sign-in stays in
 *       {@link GoogleAuthPlugin}.
 *   <li>The grant is checked before it is trusted: if the result does not list
 *       the Drive scope the call fails as {@code denied} rather than reporting
 *       a connected account that cannot read the app folder.
 *   <li>No token, code or account email is logged.
 * </ul>
 *
 * <p>Google's authorization result carries no expiry field, so the returned
 * lifetime is a deliberately conservative 50 minutes. The store already asks
 * for a forced renewal on 401, and a silent renewal that would need a consent
 * prompt resolves {@code consent-required} instead of opening UI in the
 * background.
 */
// Both flows use legacy Activity result codes (including Google's PendingIntent).
// Capacitor drops their results unless this routing table declares them.
@CapacitorPlugin(name = "DriveAuth", requestCodes = { 0x4452, 0x4453 })
public final class DriveAuthPlugin extends Plugin {

    private static final String TAG = "DriveAuth";

    /** The only scope the backup is allowed to request. */
    private static final String SCOPE = "https://www.googleapis.com/auth/drive.appdata";

    private static final String REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

    /** The account the reader picked, remembered for later silent renewals. */
    private static final String PREFS = "norfold_drive_auth";
    private static final String KEY_ACCOUNT_NAME = "account_name";
    private static final String KEY_ACCOUNT_TYPE = "account_type";

    private static final int REQUEST_ACCOUNT = 0x4452;
    private static final int REQUEST_RESOLUTION = 0x4453;

    /** Google does not report expiry; 50 minutes is inside the usual 60. */
    private static final long TOKEN_LIFETIME_MS = 50L * 60L * 1000L;

    private static final int TOKEN_MIN = 8;
    private static final int TOKEN_MAX = 4096;

    /** Guarded by {@code this}: the call awaiting an account or a consent. */
    private PluginCall pendingCall;
    private Account pendingAccount;
    private boolean pendingSilent;

    private void rejectKind(PluginCall call, String kind, String message) {
        JSObject error = new JSObject();
        error.put("code", kind);
        error.put("message", message);
        // Top-level `code` matters: Capacitor's two-arg reject() drops the key
        // from the payload, and the JS facade classifies on `code`.
        call.reject(message, kind, error);
    }

    private PluginCall takePending() {
        synchronized (this) {
            PluginCall call = pendingCall;
            pendingCall = null;
            pendingAccount = null;
            pendingSilent = false;
            return call;
        }
    }

    private void resolvePending(JSObject result) {
        PluginCall call = takePending();
        if (call != null) call.resolve(result);
    }

    private void rejectPending(String kind, String message) {
        PluginCall call = takePending();
        if (call != null) rejectKind(call, kind, message);
    }

    private void failKind(String kind) {
        rejectPending(kind, "Google Drive access was not granted.");
    }

    /** Availability is a real probe, never an assumption. */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        int status = GoogleApiAvailability.getInstance()
            .isGooglePlayServicesAvailable(getContext());
        if (status != ConnectionResult.SUCCESS) {
            result.put("available", false);
            result.put("reason", "play-services");
        } else {
            result.put("available", true);
        }
        call.resolve(result);
    }

    /**
     * Obtains a Drive access token for a Google account the user chooses here.
     *
     * <p>Options: {@code silent} (boolean) — a background renewal must never
     * open a consent sheet, so it fails {@code consent-required} instead.
     */
    @PluginMethod
    public void authorize(PluginCall call) {
        boolean silent = Boolean.TRUE.equals(call.getBoolean("silent", Boolean.FALSE));
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            rejectKind(call, "unavailable", "Drive backup is not available right now.");
            return;
        }
        synchronized (this) {
            if (pendingCall != null) {
                rejectKind(call, "unknown", "A Google Drive connection is already in progress.");
                return;
            }
            pendingCall = call;
            pendingSilent = silent;
        }

        Account account = savedAccount();
        if (account != null) {
            authorizeFor(account, call);
            return;
        }
        if (silent) {
            // Nothing to renew against: ask the caller to prompt.
            rejectPending("consent-required", "No Google account is connected.");
            return;
        }

        Intent chooser = chooseAccountIntent();
        if (chooser == null) {
            rejectPending("no-account", "Add a Google account and try again.");
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                activity.startActivityForResult(chooser, REQUEST_ACCOUNT);
            } catch (Exception startError) {
                rejectPending("unavailable", "Drive backup is not available right now.");
            }
        });
    }

    /** Evict a resource-server-rejected credential, without revoking consent or
     * forgetting the selected account. Renewal must await completion. */
    @PluginMethod
    public void clearToken(PluginCall call) {
        String token = call.getString("token");
        if (token == null || token.length() < TOKEN_MIN || token.length() > TOKEN_MAX) {
            rejectKind(call, "unknown", "Google Drive could not be reached.");
            return;
        }
        try {
            Identity.getAuthorizationClient(getContext())
                .clearToken(ClearTokenRequest.builder().setToken(token).build())
                .addOnSuccessListener(ignored -> call.resolve(new JSObject()))
                .addOnFailureListener(ignored ->
                    rejectKind(call, "unknown", "Google Drive could not be reached."));
        } catch (Exception ignored) {
            rejectKind(call, "unknown", "Google Drive could not be reached.");
        }
    }

    /**
     * Best-effort grant revocation for "Disconnect Google Drive".
     *
     * <p>The local token is cleared by the caller regardless of the outcome, so
     * a network failure here never leaves the app claiming to be connected.
     */
    @PluginMethod
    public void revoke(PluginCall call) {
        // Disconnect is a user decision, so the remembered account goes even
        // when Google is unreachable and the grant itself survives.
        forgetAccount();
        String token = call.getString("token");
        if (token == null || token.length() < TOKEN_MIN || token.length() > TOKEN_MAX) {
            JSObject result = new JSObject();
            result.put("revoked", false);
            call.resolve(result);
            return;
        }
        HttpURLConnection connection = null;
        boolean revoked = false;
        try {
            byte[] body = ("token=" + URLEncoder.encode(token, "UTF-8")).getBytes(StandardCharsets.UTF_8);
            connection = (HttpURLConnection) new URL(REVOKE_ENDPOINT).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(15000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body);
            }
            revoked = connection.getResponseCode() == 200;
            if (!revoked) drain(connection);
        } catch (Exception ignored) {
            // Offline or blocked: the caller still drops the local token.
            revoked = false;
        } finally {
            if (connection != null) connection.disconnect();
        }
        JSObject result = new JSObject();
        result.put("revoked", revoked);
        call.resolve(result);
    }

    private static void drain(HttpURLConnection connection) {
        try (InputStream ignored = connection.getErrorStream()) {
            // Reading the stream releases the socket; contents are unused.
            if (ignored != null) {
                byte[] buffer = new byte[1024];
                while (ignored.read(buffer) != -1) {
                    // Discard: Google's error body is not surfaced to the user.
                }
            }
        } catch (Exception ignored) {
            // Nothing actionable: revocation is already reported as failed.
        }
    }

    /** The account chosen last time, or null when the reader must pick one. */
    private Account savedAccount() {
        try {
            android.content.SharedPreferences prefs =
                getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
            String name = prefs.getString(KEY_ACCOUNT_NAME, null);
            String type = prefs.getString(KEY_ACCOUNT_TYPE, null);
            return name == null || type == null || name.isEmpty() ? null : new Account(name, type);
        } catch (Exception unavailable) {
            return null;
        }
    }

    private void rememberAccount(Account account) {
        try {
            getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_ACCOUNT_NAME, account.name)
                .putString(KEY_ACCOUNT_TYPE, account.type)
                .apply();
        } catch (Exception ignored) {
            // Not fatal: the next connect simply asks again.
        }
    }

    private void forgetAccount() {
        try {
            getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
                .edit().clear().apply();
        } catch (Exception ignored) {
            // Nothing to clear.
        }
    }

    private Intent chooseAccountIntent() {
        try {
            return AccountManager.newChooseAccountIntent(
                null, null, new String[] { "com.google" }, true, null, null, null, null);
        } catch (Exception unavailable) {
            return null;
        }
    }

    private void authorizeFor(Account account, PluginCall call) {
        synchronized (this) {
            pendingAccount = account;
        }
        AuthorizationRequest request;
        try {
            request = AuthorizationRequest.builder()
                .setAccount(account)
                .setRequestedScopes(Collections.singletonList(new Scope(SCOPE)))
                .build();
        } catch (Exception builderError) {
            rejectPending("unknown", "Google Drive could not be reached.");
            return;
        }
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            rejectPending("unavailable", "Drive backup is not available right now.");
            return;
        }
        AuthorizationClient client = Identity.getAuthorizationClient(activity);
        client.authorize(request)
            .addOnSuccessListener(result -> handleResult(activity, client, result))
            .addOnFailureListener(error -> failFrom(error));
    }

    private void handleResult(Activity activity, AuthorizationClient client, AuthorizationResult result) {
        if (result == null) {
            failKind("unknown");
            return;
        }
        if (result.hasResolution()) {
            boolean silent;
            synchronized (this) {
                silent = pendingSilent;
            }
            if (silent) {
                rejectPending("consent-required", "Google Drive needs you to reconnect.");
                return;
            }
            PendingIntent resolution = result.getPendingIntent();
            if (resolution == null) {
                failKind("unknown");
                return;
            }
            activity.runOnUiThread(() -> {
                try {
                    activity.startIntentSenderForResult(
                        resolution.getIntentSender(), REQUEST_RESOLUTION, null, 0, 0, 0);
                } catch (Exception startError) {
                    rejectPending("unavailable", "Drive backup is not available right now.");
                }
            });
            return;
        }

        String token = result.getAccessToken();
        if (token == null || token.length() < TOKEN_MIN || token.length() > TOKEN_MAX) {
            failKind("unknown");
            return;
        }
        // Fail closed: a token that did not actually receive the app-folder
        // scope cannot read a backup, so claiming success would be a lie.
        List<String> granted = result.getGrantedScopes();
        if (granted == null || !granted.contains(SCOPE)) {
            failKind("denied");
            return;
        }

        JSObject payload = new JSObject();
        payload.put("accessToken", token);
        payload.put("expiresAt", System.currentTimeMillis() + TOKEN_LIFETIME_MS);
        synchronized (this) {
            if (pendingAccount != null) {
                payload.put("account", pendingAccount.name);
                // Remembered so a background renewal reuses this account
                // without a chooser and without enumerating device accounts.
                rememberAccount(pendingAccount);
            }
        }
        resolvePending(payload);
    }

    private void failFrom(Exception error) {
        if (error instanceof ApiException) {
            int status = ((ApiException) error).getStatusCode();
            if (status == ConnectionResult.DEVELOPER_ERROR) {
                rejectPending("misconfigured", "Drive backup is not configured for this build.");
                return;
            }
            if (status == ConnectionResult.SERVICE_MISSING
                || status == ConnectionResult.SERVICE_DISABLED
                || status == ConnectionResult.SERVICE_VERSION_UPDATE_REQUIRED) {
                rejectPending("unavailable", "Drive backup is not available right now.");
                return;
            }
            if (status == ConnectionResult.NETWORK_ERROR) {
                rejectPending("network", "Google Drive could not be reached.");
                return;
            }
            if (status == ConnectionResult.CANCELED) {
                failKind("denied");
                return;
            }
        }
        failKind("unknown");
    }

    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        super.handleOnActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_ACCOUNT) {
            if (resultCode != Activity.RESULT_OK || data == null) {
                failKind("denied");
                return;
            }
            String name = data.getStringExtra(AccountManager.KEY_ACCOUNT_NAME);
            String type = data.getStringExtra(AccountManager.KEY_ACCOUNT_TYPE);
            if (name == null || type == null || name.isEmpty()) {
                failKind("denied");
                return;
            }
            PluginCall call;
            synchronized (this) {
                call = pendingCall;
            }
            if (call == null) return;
            authorizeFor(new Account(name, type), call);
            return;
        }
        if (requestCode == REQUEST_RESOLUTION) {
            if (resultCode != Activity.RESULT_OK) {
                failKind("denied");
                return;
            }
            Activity activity = getActivity();
            if (activity == null) {
                failKind("unavailable");
                return;
            }
            AuthorizationClient client = Identity.getAuthorizationClient(activity);
            try {
                AuthorizationResult result = client.getAuthorizationResultFromIntent(data);
                handleResult(activity, client, result);
            } catch (ApiException error) {
                failFrom(error);
            } catch (Exception error) {
                failKind("unknown");
            }
        }
    }
}
