package com.findback.app;

import android.app.Activity;
import android.net.Uri;
import android.os.CancellationSignal;
import android.util.Log;

import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialCustomException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.GetCredentialInterruptedException;
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException;
import androidx.credentials.exceptions.GetCredentialUnsupportedException;
import androidx.credentials.exceptions.NoCredentialException;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.concurrent.Executor;

/**
 * W0-A (S1) — Google ID-token bridge (Android Credential Manager).
 *
 * <p>Flow: Credential Manager bottom sheet → Google ID token → resolved to the
 * JS layer, which exchanges it via Supabase {@code signInWithIdToken}. The web
 * (server) OAuth client ID that forms the token audience comes ONLY from the
 * {@code GOOGLE_WEB_CLIENT_ID} BuildConfig seam (see app/build.gradle); it is
 * a public identifier, never a secret, and no client secret exists anywhere in
 * this path.
 *
 * <p>Replay protection (W0-D): every {@code signIn} mints a fresh single-use
 * raw nonce (SecureRandom, 32 bytes, lowercase-hex string). The SHA-256 hex
 * digest goes to Google as the ID-option nonce; the RAW nonce is returned
 * alongside the ID token so the JS layer can pass it as {@code nonce} to
 * Supabase {@code signInWithIdToken}, which verifies SHA-256(raw) against
 * the token's nonce claim server-side (skip-nonce-check stays OFF). The
 * hashed encoding is lowercase hex of SHA-256 over the UTF-8 bytes of the
 * raw string, exactly per Supabase's current native-Google (Credential
 * Manager) guide: raw random string to Supabase, {@code "%02x"} hex digest
 * to Google. Neither the token nor any nonce form is ever logged.
 *
 * <p>Fail-closed model (mirrors the S1 facade contract):
 * <ul>
 *   <li>empty client ID (owner has not configured consoles yet) →
 *       {@code isAvailable} reports {@code available:false} and {@code signIn}
 *       rejects {@code misconfigured}; success is never faked;
 *   <li>{@code signin} uses {@code filterByAuthorizedAccounts=true} with no
 *       phone request; {@code signup} uses {@code false} plus
 *       {@code requestVerifiedPhoneNumber=true}; the combination of both is
 *       rejected here as well as never sent by the facade;
 *   <li>rejections carry only the S1 kind taxonomy
 *       ({@code cancelled}/{@code unavailable}/{@code misconfigured}/
 *       {@code network}/{@code unknown}) — never raw platform text;
 *   <li>the ID token is NEVER logged.
 * </ul>
 *
 * <p>Threading: plugin methods arrive on Capacitor's background thread;
 * Credential Manager runs its UI against the host activity via the main
 * executor. A single in-flight {@code signIn} is enforced — concurrent calls
 * are rejected.
 */
@CapacitorPlugin(name = "GoogleAuth")
public final class GoogleAuthPlugin extends Plugin {

    /**
     * Logcat tag for the fail-closed diagnostic below. Capture with:
     * {@code adb logcat | grep GoogleAuth}.
     */
    private static final String TAG = "GoogleAuth";

    /** Guarded by the plugin instance lock: the call awaiting credentials. */
    private PluginCall pendingCall;

    /** Single SecureRandom shared across requests (thread-safe); 32 fresh bytes per nonce. */
    private static final SecureRandom NONCE_RANDOM = new SecureRandom();

    private static final char[] HEX_DIGITS = "0123456789abcdef".toCharArray();

    private static String toHex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(HEX_DIGITS[(b >> 4) & 0x0f]);
            out.append(HEX_DIGITS[b & 0x0f]);
        }
        return out.toString();
    }

    /** Fresh single-use raw nonce: 32 SecureRandom bytes, lowercase-hex string. */
    private static String newRawNonce() {
        byte[] bytes = new byte[32];
        NONCE_RANDOM.nextBytes(bytes);
        return toHex(bytes);
    }

    /**
     * Hashed nonce for the Google ID option: lowercase hex of SHA-256 over
     * the UTF-8 bytes of the raw nonce (Supabase native-Google encoding).
     */
    private static String hashNonce(String rawNonce) throws NoSuchAlgorithmException {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        return toHex(md.digest(rawNonce.getBytes(StandardCharsets.UTF_8)));
    }

    private static String serverClientId() {
        String id = BuildConfig.GOOGLE_WEB_CLIENT_ID;
        return id == null ? "" : id.trim();
    }

    private void rejectKind(PluginCall call, String kind, String message) {
        JSObject error = new JSObject();
        error.put("code", kind);
        // Message is informational only; the JS facade replaces it with its
        // own stable copy, so no credential material can leak this way.
        error.put("message", message);
        // `kind` MUST travel in the top-level `code` slot. Capacitor's two-arg
        // reject(String, JSObject) overload delegates to
        // reject(msg, null, null, data), so it sends
        // `{message, data: {code, message}}` — note there is NO top-level `code`
        // KEY at all, because `JSONObject.put(name, null)` removes the key
        // rather than storing a null. The JS facade reads `code`, would find
        // nothing, and would collapse every native rejection raised inside
        // `signIn` onto "unknown": a dismissed prompt rendered an error banner,
        // and "no Google account on this device" rendered an unactionable retry
        // copy instead of the "Add a Google account and try again" guidance.
        // Use the three-arg overload, which keeps `code` top-level and still
        // carries the detail object in `data`.
        //
        // Scope note: failures raised by the availability probe do NOT pass
        // through here — `isAvailable` resolves {available:false,
        // reason:"misconfigured"} and the JS facade classifies that separately,
        // so that path was always correct.
        call.reject(message, kind, error);
    }

    private void resolvePending(PluginCall call, JSObject result) {
        synchronized (this) {
            if (pendingCall != call) return;
            pendingCall = null;
        }
        call.resolve(result);
    }

    private void rejectPending(PluginCall call, String kind, String message) {
        synchronized (this) {
            if (pendingCall != call) return;
            pendingCall = null;
        }
        rejectKind(call, kind, message);
    }

    /** Reports whether a real Google sign-in can be attempted right now. */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        if (serverClientId().isEmpty()) {
            result.put("available", false);
            result.put("reason", "misconfigured");
        } else {
            result.put("available", true);
        }
        call.resolve(result);
    }

    /**
     * Starts one Google sign-in.
     *
     * <p>Options from the S1 facade: {@code filterByAuthorizedAccounts}
     * (boolean) and {@code requestVerifiedPhoneNumber} (boolean, signup only).
     */
    @PluginMethod
    public void signIn(PluginCall call) {
        boolean filterByAuthorizedAccounts =
            Boolean.TRUE.equals(call.getBoolean("filterByAuthorizedAccounts"));
        boolean requestVerifiedPhoneNumber =
            Boolean.TRUE.equals(call.getBoolean("requestVerifiedPhoneNumber"));

        if (filterByAuthorizedAccounts && requestVerifiedPhoneNumber) {
            // Guard: phone request must never ride on authorized-accounts-only.
            rejectKind(call, "unknown", "Invalid Google sign-in request.");
            return;
        }

        String clientId = serverClientId();
        if (clientId.isEmpty()) {
            rejectKind(call, "misconfigured", "Google sign-in is not configured.");
            return;
        }

        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            rejectKind(call, "unavailable", "Google sign-in is not available.");
            return;
        }

        synchronized (this) {
            if (pendingCall != null) {
                rejectKind(call, "unknown", "A Google sign-in is already in progress.");
                return;
            }
            pendingCall = call;
        }

        GetGoogleIdOption googleIdOption;
        final String rawNonce = newRawNonce();
        final String hashedNonce;
        try {
            hashedNonce = hashNonce(rawNonce);
        } catch (NoSuchAlgorithmException digestError) {
            rejectPending(call, "unknown", "Google sign-in could not start.");
            return;
        }
        try {
            googleIdOption = new GetGoogleIdOption.Builder()
                .setFilterByAuthorizedAccounts(filterByAuthorizedAccounts)
                .setServerClientId(clientId)
                .setAutoSelectEnabled(filterByAuthorizedAccounts)
                .setRequestVerifiedPhoneNumber(requestVerifiedPhoneNumber)
                .setNonce(hashedNonce)
                .build();
        } catch (Exception builderError) {
            rejectPending(call, "unknown", "Google sign-in could not start.");
            return;
        }

        GetCredentialRequest request;
        try {
            request = new GetCredentialRequest.Builder()
                .addCredentialOption(googleIdOption)
                .build();
        } catch (Exception builderError) {
            rejectPending(call, "unknown", "Google sign-in could not start.");
            return;
        }

        CredentialManager credentialManager;
        try {
            credentialManager = CredentialManager.create(activity);
        } catch (Exception managerError) {
            rejectPending(call, "unavailable", "Google sign-in is not available.");
            return;
        }

        Executor mainExecutor = activity.getMainExecutor();
        CancellationSignal cancellation = new CancellationSignal();
        try {
            credentialManager.getCredentialAsync(
                activity,
                request,
                cancellation,
                mainExecutor,
                new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override
                    public void onResult(GetCredentialResponse response) {
                        handleCredential(response, call, rawNonce);
                    }

                    @Override
                    public void onError(GetCredentialException error) {
                        String kind = kindFor(error);
                        logFailureClass(error, kind);
                        rejectPending(call, kind, messageFor(error));
                    }
                });
        } catch (Exception dispatchError) {
            rejectPending(call, "unavailable", "Google sign-in is not available.");
        }
    }

    private void handleCredential(GetCredentialResponse response, PluginCall call, String rawNonce) {
        Credential credential = response != null ? response.getCredential() : null;
        if (!(credential instanceof CustomCredential)
            || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
            rejectPending(call, "unknown", "Google sign-in failed.");
            return;
        }
        GoogleIdTokenCredential googleCredential;
        try {
            googleCredential = GoogleIdTokenCredential.createFrom(credential.getData());
        } catch (Exception parseError) {
            rejectPending(call, "unknown", "Google sign-in failed.");
            return;
        }
        String idToken = googleCredential.getIdToken();
        if (idToken == null || idToken.isEmpty()) {
            rejectPending(call, "unknown", "Google sign-in failed.");
            return;
        }
        JSObject result = new JSObject();
        result.put("idToken", idToken);
        // Raw single-use nonce for the Supabase server-side nonce check.
        // Never logged; the JS facade forwards it and never prints it.
        result.put("nonce", rawNonce);
        String email = null;
        try {
            email = googleCredential.getEmail();
        } catch (Exception ignored) {
            // Optional seed: fall back to the credential ID below.
        }
        if (email == null || email.isEmpty()) {
            try {
                email = googleCredential.getId();
            } catch (Exception ignored) {
                email = null;
            }
        }
        if (email != null && !email.isEmpty()) result.put("email", email);
        try {
            String displayName = googleCredential.getDisplayName();
            if (displayName != null && !displayName.isEmpty()) result.put("name", displayName);
        } catch (Exception ignored) {
            // Optional seed: absent when the provider does not return it.
        }
        try {
            Uri picture = googleCredential.getProfilePictureUri();
            if (picture != null) result.put("avatarUrl", picture.toString());
        } catch (Exception ignored) {
            // Optional seed: absent when the provider does not return it.
        }
        try {
            String phone = googleCredential.getPhoneNumber();
            if (phone != null && !phone.isEmpty()) result.put("phone", phone);
        } catch (Exception ignored) {
            // Optional seed: only legitimately present on sign-up flows.
        }
        resolvePending(call, result);
    }

    /** Maps Credential Manager failures onto the S1 kind taxonomy.
     *
     * <p>W-E failure-class table (consumer categories live in
     * {@code services/auth/googleFailureClasses.ts}; the S1 kinds below are
     * the frozen bridge contract and are NOT widened here):
     * <ul>
     *   <li>{@code GetCredentialProviderConfigurationException} →
     *       {@code misconfigured} (console/SHA/client setup — never device
     *       state);
     *   <li>{@code NoCredentialException} → {@code unavailable} (in practice
     *       no authorized Google account; the exact class is in logcat);
     *   <li>{@code GetCredentialUnsupportedException} → {@code unavailable}
     *       (no Credential Manager / Play Services; exact class in logcat);
     *   <li>cancellation/interruption → {@code cancelled} (silent on UI);
     *   <li>{@code IOException} in the cause chain → {@code network};
     *   <li>token minted but Supabase rejects → S2 {@code provider_rejected}.
     * </ul>
     */
    private static String kindFor(GetCredentialException error) {        if (error instanceof GetCredentialCancellationException
            || error instanceof GetCredentialInterruptedException) {
            return "cancelled";
        }
        if (error instanceof NoCredentialException
            || error instanceof GetCredentialUnsupportedException) {
            return "unavailable";
        }
        if (error instanceof GetCredentialProviderConfigurationException) {
            // Provider configuration failures are console-side, not device
            // state: missing/disabled Google ID services, an unregistered
            // Android OAuth client, or a SHA-1 mismatch. Surfaced as
            // `misconfigured` so the user sees setup copy (never a
            // device-blaming message) instead of `unavailable`.
            return "misconfigured";
        }
        if (error instanceof GetCredentialCustomException) {
            Throwable cause = error.getCause();
            while (cause != null) {
                if (cause instanceof IOException) return "network";
                cause = cause.getCause();
            }
            return "unknown";
        }
        return "unknown";
    }

    /**
     * Fail-closed diagnostic for the owner run: logs ONLY the exception class
     * plus the mapped kind and a configuration-class hint. NEVER the ID
     * token, the nonce (raw or hashed), the exception message (which can echo
     * account/package details), or any credential material. One logcat line
     * per failure: {@code adb logcat | grep GoogleAuth}.
     */
    private static void logFailureClass(GetCredentialException error, String kind) {
        String exceptionClass = error == null ? "null" : error.getClass().getSimpleName();
        String configHint;
        if (error instanceof GetCredentialProviderConfigurationException) {
            configHint = "check-google-cloud-android-client-and-release-sha";
        } else if (error instanceof NoCredentialException) {
            configHint = "check-device-google-account";
        } else if (error instanceof GetCredentialUnsupportedException) {
            configHint = "check-play-services-and-credential-manager";
        } else if (error instanceof GetCredentialCancellationException
            || error instanceof GetCredentialInterruptedException) {
            configHint = "user-cancelled";
        } else {
            configHint = "retry-or-check-network";
        }
        Log.w(TAG, "Google sign-in failed: exceptionClass=" + exceptionClass
            + " kind=" + kind + " configHint=" + configHint);
    }

    private static String messageFor(GetCredentialException error) {
        switch (kindFor(error)) {
            case "cancelled":
                return "Google sign-in was cancelled.";
            case "unavailable":
                return "Google sign-in is not available.";
            case "misconfigured":
                return "Google sign-in is not configured.";
            case "network":
                return "Could not reach Google sign-in.";
            default:
                return "Google sign-in failed.";
        }
    }
}
