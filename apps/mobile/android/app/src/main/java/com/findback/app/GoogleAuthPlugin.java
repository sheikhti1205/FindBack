package com.findback.app;

import android.app.Activity;
import android.net.Uri;
import android.os.CancellationSignal;

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

    /** Guarded by the plugin instance lock: the call awaiting credentials. */
    private PluginCall pendingCall;

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
        call.reject(message, error);
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
        try {
            googleIdOption = new GetGoogleIdOption.Builder()
                .setFilterByAuthorizedAccounts(filterByAuthorizedAccounts)
                .setServerClientId(clientId)
                .setAutoSelectEnabled(filterByAuthorizedAccounts)
                .setRequestVerifiedPhoneNumber(requestVerifiedPhoneNumber)
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
                        handleCredential(response, call);
                    }

                    @Override
                    public void onError(GetCredentialException error) {
                        rejectPending(call, kindFor(error), messageFor(error));
                    }
                });
        } catch (Exception dispatchError) {
            rejectPending(call, "unavailable", "Google sign-in is not available.");
        }
    }

    private void handleCredential(GetCredentialResponse response, PluginCall call) {
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

    /** Maps Credential Manager failures onto the S1 kind taxonomy. */
    private static String kindFor(GetCredentialException error) {
        if (error instanceof GetCredentialCancellationException
            || error instanceof GetCredentialInterruptedException) {
            return "cancelled";
        }
        if (error instanceof NoCredentialException
            || error instanceof GetCredentialUnsupportedException
            || error instanceof GetCredentialProviderConfigurationException) {
            return "unavailable";
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

    private static String messageFor(GetCredentialException error) {
        switch (kindFor(error)) {
            case "cancelled":
                return "Google sign-in was cancelled.";
            case "unavailable":
                return "Google sign-in is not available.";
            case "network":
                return "Could not reach Google sign-in.";
            default:
                return "Google sign-in failed.";
        }
    }
}
