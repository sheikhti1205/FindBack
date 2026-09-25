package com.findback.app;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * V1 — Android dictation bridge.
 *
 * <p>Privacy model: audio never leaves the process unless the route decision
 * says so (see {@link SpeechInputPolicy}): on-device results are requested
 * with {@link RecognizerIntent#EXTRA_PREFER_OFFLINE}, network routes require
 * an explicit {@code allowNetworkAudio} opt-in, {@code onBufferReceived} is
 * deliberately empty so microphone bytes are never retained, and neither
 * transcripts nor audio are ever logged.
 *
 * <p>Transcript handling: recognition text is emitted as editable
 * {@code speechResult} events only — there is no send/submit path here or in
 * the facade. Per-session epoch counters make callbacks from a released
 * session inert, so a cancelled recognizer can never emit into a newer one.
 *
 * <p>Threading: every {@code SpeechRecognizer} interaction runs on the main
 * looper (the recognizer is not safe off the UI thread); plugin methods are
 * dispatched from Capacitor's background thread, so {@code start}, {@code stop}
 * and {@code cancel} post their recognizer work to {@link #mainHandler}.
 */
@CapacitorPlugin(
    name = "SpeechInput",
    permissions = @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
)
public final class SpeechInputPlugin extends Plugin {

    private static final String MICROPHONE = "microphone";
    private static final String EVENT_RESULT = "speechResult";
    private static final String EVENT_STATE = "speechState";
    private static final String EVENT_ERROR = "speechError";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /** Main-looper only: the active recognizer, if any. */
    private SpeechRecognizer recognizer;
    /** Main-looper only: a session exists (listening or awaiting final results). */
    private boolean sessionActive;
    /** Main-looper only: the recognizer is actively listening (session is busy). */
    private boolean listening;
    /** Main-looper only: bumped on every session change; stale callbacks compare against it. */
    private int sessionEpoch;

    /**
     * Reports what this device can actually prove: a recognizer, whether an
     * on-device one is available (API 31+ probe, "unknown" below that), and
     * therefore whether starting requires a network opt-in.
     */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        boolean available = SpeechRecognizer.isRecognitionAvailable(getContext());
        String onDevice = probeOnDevice(available);
        JSObject out = new JSObject();
        out.put("available", available);
        out.put("onDevice", onDevice);
        out.put("networkOptInRequired", SpeechInputPolicy.networkOptInRequired(onDevice));
        out.put("apiLevel", Build.VERSION.SDK_INT);
        call.resolve(out);
    }

    /**
     * Current microphone state. Capacitor's {@code DENIED} means denied
     * permanently (no rationale will be shown again), which the app treats as
     * {@code blocked}; everything unexpected fails closed to {@code denied}.
     */
    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject out = new JSObject();
        out.put("state", microphoneState());
        call.resolve(out);
    }

    /**
     * Asks for the microphone. Already granted resolves immediately; otherwise
     * the request runs through Capacitor's permission launcher and resolves
     * from {@link #onMicrophonePermission}.
     */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        PermissionState state = getPermissionState(MICROPHONE);
        if (state == PermissionState.GRANTED) {
            JSObject out = new JSObject();
            out.put("state", "granted");
            call.resolve(out);
            return;
        }
        if (state == null) {
            // The alias was not declared on this plugin: fail closed.
            JSObject out = new JSObject();
            out.put("state", "denied");
            call.resolve(out);
            return;
        }
        requestPermissionForAlias(MICROPHONE, call, "onMicrophonePermission");
    }

    @PermissionCallback
    private void onMicrophonePermission(PluginCall call) {
        if (call == null) return;
        JSObject out = new JSObject();
        out.put("state", microphoneState());
        call.resolve(out);
    }

    /**
     * Starts a dictation session. Rejects — in order — while a session is
     * already listening, on a device without a recogniser, when a network
     * route was chosen without {@code allowNetworkAudio}, and on an invalid
     * language tag. Resolves once listening has begun; results then arrive as
     * events.
     */
    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState(MICROPHONE) != PermissionState.GRANTED) {
            call.reject(SpeechInputPolicy.messageFor("permission_denied"), "permission_denied");
            return;
        }

        Boolean preferRaw = call.getBoolean("preferOnDevice", Boolean.TRUE);
        boolean preferOnDevice = !Boolean.FALSE.equals(preferRaw);
        Boolean allowRaw = call.getBoolean("allowNetworkAudio", Boolean.FALSE);
        boolean allowNetworkAudio = Boolean.TRUE.equals(allowRaw);
        String rawLanguage = call.getString("language");

        mainHandler.post(() -> startOnMain(call, preferOnDevice, allowNetworkAudio, rawLanguage));
    }

    /**
     * Stops listening but keeps the session alive so final results can still
     * arrive. {@code stopped} is false when nothing was listening.
     */
    @PluginMethod
    public void stop(PluginCall call) {
        mainHandler.post(() -> {
            JSObject out = new JSObject();
            if (sessionActive && listening && recognizer != null) {
                try {
                    recognizer.stopListening();
                } catch (RuntimeException ignored) {
                    // Releasing below remains the correct outcome either way.
                }
                listening = false;
                out.put("stopped", true);
                call.resolve(out);
                emitState("stopped");
            } else {
                out.put("stopped", false);
                call.resolve(out);
            }
        });
    }

    /** Aborts the session immediately and releases the recogniser. */
    @PluginMethod
    public void cancel(PluginCall call) {
        mainHandler.post(() -> {
            JSObject out = new JSObject();
            if (sessionActive) {
                releaseSession();
                out.put("cancelled", true);
                call.resolve(out);
                emitState("cancelled");
            } else {
                out.put("cancelled", false);
                call.resolve(out);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        releaseSession();
        super.handleOnDestroy();
    }

    /** Main looper only. */
    private void startOnMain(PluginCall call, boolean preferOnDevice, boolean allowNetworkAudio, String rawLanguage) {
        if (listening) {
            call.reject(SpeechInputPolicy.messageFor("busy"), "busy");
            return;
        }

        // A session awaiting final results is superseded by this start.
        if (sessionActive) {
            releaseSession();
        }

        boolean available = SpeechRecognizer.isRecognitionAvailable(getContext());
        if (!available) {
            call.reject(SpeechInputPolicy.messageFor("no_recognizer"), "no_recognizer");
            return;
        }

        SpeechInputPolicy.RouteDecision decision =
            SpeechInputPolicy.decideRoute(probeOnDevice(available), preferOnDevice, allowNetworkAudio);
        if (decision == SpeechInputPolicy.RouteDecision.NETWORK_OPT_IN_REQUIRED) {
            call.reject(SpeechInputPolicy.messageFor("network_required"), "network_opt_in_required");
            return;
        }

        String language = null;
        if (rawLanguage != null && !rawLanguage.trim().isEmpty()) {
            language = SpeechInputPolicy.normalizeLanguage(rawLanguage);
            if (language == null) {
                call.reject(SpeechInputPolicy.messageFor("language"), "language");
                return;
            }
        }

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        if (language != null) {
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        }
        boolean onDeviceRoute = decision == SpeechInputPolicy.RouteDecision.ON_DEVICE;
        if (onDeviceRoute) {
            intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        }

        SpeechRecognizer next;
        try {
            next = onDeviceRoute && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext())
                : SpeechRecognizer.createSpeechRecognizer(getContext());
        } catch (RuntimeException error) {
            call.reject(SpeechInputPolicy.messageFor("client"), "client");
            return;
        }

        int epoch = ++sessionEpoch;
        String route = SpeechInputPolicy.routeFor(decision);
        recognizer = next;
        sessionActive = true;
        listening = true;
        recognizer.setRecognitionListener(new SessionListener(epoch, route));
        try {
            recognizer.startListening(intent);
        } catch (RuntimeException error) {
            releaseSession();
            call.reject(SpeechInputPolicy.messageFor("client"), "client");
            return;
        }

        JSObject out = new JSObject();
        out.put("started", true);
        out.put("route", route);
        out.put("networkAudioDisclosed", SpeechInputPolicy.needsDisclosure(decision));
        call.resolve(out);
        emitState("listening");
    }

    /** Main looper only. Tears down the session and invalidates its callbacks. */
    private void releaseSession() {
        sessionEpoch++;
        sessionActive = false;
        listening = false;
        SpeechRecognizer active = recognizer;
        recognizer = null;
        if (active != null) {
            active.setRecognitionListener(null);
            active.destroy();
        }
    }

    private void emitState(String state) {
        JSObject data = new JSObject();
        data.put("state", state);
        notifyListeners(EVENT_STATE, data);
    }

    /** Fail-closed probe: only an API 31+ positive answer proves "available". */
    private String probeOnDevice(boolean recognitionAvailable) {
        if (!recognitionAvailable) {
            return SpeechInputPolicy.ON_DEVICE_UNAVAILABLE;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext())
                ? SpeechInputPolicy.ON_DEVICE_AVAILABLE
                : SpeechInputPolicy.ON_DEVICE_UNAVAILABLE;
        }
        return SpeechInputPolicy.ON_DEVICE_UNKNOWN;
    }

    private String microphoneState() {
        PermissionState state = getPermissionState(MICROPHONE);
        if (state == null) return "denied";
        if (state == PermissionState.GRANTED) return "granted";
        if (state == PermissionState.PROMPT) return "prompt";
        if (state == PermissionState.PROMPT_WITH_RATIONALE) return "prompt-with-rationale";
        if (state == PermissionState.DENIED) return "blocked";
        return "denied";
    }

    /** First recognised utterance, or null when the bundle carries nothing usable. */
    private static String firstText(Bundle results) {
        if (results == null) return null;
        ArrayList<String> texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (texts == null || texts.isEmpty()) return null;
        String text = texts.get(0);
        return text == null || text.isEmpty() ? null : text;
    }

    /** Bound to exactly one session; every callback no-ops once that session ends. */
    private final class SessionListener implements RecognitionListener {

        private final int epoch;
        private final String route;

        private SessionListener(int epoch, String route) {
            this.epoch = epoch;
            this.route = route;
        }

        private boolean stale() {
            return !sessionActive || epoch != sessionEpoch;
        }

        @Override
        public void onReadyForSpeech(Bundle params) {}

        @Override
        public void onBeginningOfSpeech() {
            if (stale()) return;
            emitState("speech_started");
        }

        @Override
        public void onEndOfSpeech() {
            if (stale()) return;
            emitState("speech_ended");
        }

        @Override
        public void onRmsChanged(float rmsdB) {}

        @Override
        public void onBufferReceived(byte[] buffer) {
            // Privacy: microphone bytes are never retained or surfaced.
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            if (stale()) return;
            String text = firstText(partialResults);
            if (text == null) return;
            JSObject data = new JSObject();
            data.put("text", text);
            data.put("isFinal", false);
            data.put("route", route);
            notifyListeners(EVENT_RESULT, data);
        }

        @Override
        public void onResults(Bundle results) {
            if (stale()) return;
            String text = firstText(results);
            if (text != null) {
                JSObject data = new JSObject();
                data.put("text", text);
                data.put("isFinal", true);
                data.put("route", route);
                notifyListeners(EVENT_RESULT, data);
            }
            emitState("finished");
            releaseSession();
        }

        @Override
        public void onError(int error) {
            if (stale()) return;
            String code = SpeechInputPolicy.mapError(error);
            JSObject data = new JSObject();
            data.put("code", code);
            data.put("message", SpeechInputPolicy.messageFor(code));
            notifyListeners(EVENT_ERROR, data);
            emitState("error");
            releaseSession();
        }

        @Override
        public void onEvent(int eventType, Bundle params) {}
    }
}
