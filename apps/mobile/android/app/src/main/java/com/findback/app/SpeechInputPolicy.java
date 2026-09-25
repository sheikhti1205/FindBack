package com.findback.app;

/**
 * V1 — pure decision logic for the Android dictation bridge.
 *
 * Deliberately free of any {@code android.*} import so it can be unit tested
 * on the JVM. The error integers below mirror
 * {@code android.speech.SpeechRecognizer.ERROR_*}; the values were read back
 * from the installed SDK on 2026-09-25 with
 * {@code javap -constants -classpath $SDK/platforms/android-36/android.jar android.speech.SpeechRecognizer}.
 *
 * <pre>
 * ERROR_NETWORK_TIMEOUT=1  ERROR_NETWORK=2            ERROR_AUDIO=3
 * ERROR_SERVER=4           ERROR_CLIENT=5             ERROR_SPEECH_TIMEOUT=6
 * ERROR_NO_MATCH=7         ERROR_RECOGNIZER_BUSY=8    ERROR_INSUFFICIENT_PERMISSIONS=9
 * ERROR_TOO_MANY_REQUESTS=10 ERROR_SERVER_DISCONNECTED=11 ERROR_LANGUAGE_NOT_SUPPORTED=12
 * ERROR_LANGUAGE_UNAVAILABLE=13 ERROR_CANNOT_CHECK_SUPPORT=14
 * ERROR_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS=15
 * </pre>
 */
public final class SpeechInputPolicy {

    /** The platform confirmed an on-device recognizer (API 31+ probe). */
    public static final String ON_DEVICE_AVAILABLE = "available";
    /** The platform explicitly reported no on-device recognizer. */
    public static final String ON_DEVICE_UNAVAILABLE = "unavailable";
    /** Nothing can be proven before use — treated as "may be network backed". */
    public static final String ON_DEVICE_UNKNOWN = "unknown";

    public static final String ROUTE_ON_DEVICE = "on_device";
    public static final String ROUTE_NETWORK = "network";

    /** Result of the routing decision; see {@link #decideRoute}. */
    public enum RouteDecision {
        /** Audio stays on the device: the platform owns an on-device recognizer. */
        ON_DEVICE,
        /** Audio may leave the device: the caller already opted in. */
        NETWORK,
        /** A network recognizer would be used and the caller has not opted in. */
        NETWORK_OPT_IN_REQUIRED
    }

    private SpeechInputPolicy() {}

    /**
     * Normalises a platform on-device flag. Exact matches only: anything
     * unproven (null, blank, wrong case, surprising shape) becomes
     * {@link #ON_DEVICE_UNKNOWN} so callers fail closed.
     */
    public static String normalizeOnDevice(String raw) {
        if (ON_DEVICE_AVAILABLE.equals(raw)) return ON_DEVICE_AVAILABLE;
        if (ON_DEVICE_UNAVAILABLE.equals(raw)) return ON_DEVICE_UNAVAILABLE;
        return ON_DEVICE_UNKNOWN;
    }

    /** True unless the platform proved on-device recognition is available. */
    public static boolean networkOptInRequired(String onDevice) {
        return !ON_DEVICE_AVAILABLE.equals(normalizeOnDevice(onDevice));
    }

    /**
     * Chooses the recognizer route. A network route is only ever returned after
     * an explicit {@code allowNetworkAudio} opt-in, so audio can never be sent
     * off-device silently. A confirmed on-device recognizer wins whenever the
     * caller prefers it, regardless of the opt-in flag.
     */
    public static RouteDecision decideRoute(String onDevice, boolean preferOnDevice, boolean allowNetworkAudio) {
        if (preferOnDevice && ON_DEVICE_AVAILABLE.equals(normalizeOnDevice(onDevice))) {
            return RouteDecision.ON_DEVICE;
        }
        if (allowNetworkAudio) {
            return RouteDecision.NETWORK;
        }
        return RouteDecision.NETWORK_OPT_IN_REQUIRED;
    }

    /** Wire value for a decision. */
    public static String routeFor(RouteDecision decision) {
        return decision == RouteDecision.ON_DEVICE ? ROUTE_ON_DEVICE : ROUTE_NETWORK;
    }

    /** Whether the caller must be told that audio may leave the device. */
    public static boolean needsDisclosure(RouteDecision decision) {
        return decision != RouteDecision.ON_DEVICE;
    }

    /** Maps a {@code SpeechRecognizer} error integer onto the shared error taxonomy. */
    public static String mapError(int errorCode) {
        switch (errorCode) {
            case 1:  // ERROR_NETWORK_TIMEOUT
            case 6:  // ERROR_SPEECH_TIMEOUT
                return "timeout";
            case 2:  // ERROR_NETWORK
                return "network_required";
            case 3:  // ERROR_AUDIO
                return "audio";
            case 4:  // ERROR_SERVER
            case 11: // ERROR_SERVER_DISCONNECTED
                return "server";
            case 5:  // ERROR_CLIENT
            case 14: // ERROR_CANNOT_CHECK_SUPPORT
            case 15: // ERROR_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS
                return "client";
            case 7:  // ERROR_NO_MATCH
                return "no_match";
            case 8:  // ERROR_RECOGNIZER_BUSY
            case 10: // ERROR_TOO_MANY_REQUESTS
                return "busy";
            case 9:  // ERROR_INSUFFICIENT_PERMISSIONS
                return "permission_denied";
            case 12: // ERROR_LANGUAGE_NOT_SUPPORTED
            case 13: // ERROR_LANGUAGE_UNAVAILABLE
                return "language";
            default:
                return "unknown";
        }
    }

    /**
     * Stable, user-facing message for a taxonomy code. Never contains audio or
     * transcript, and never raw platform text: unknown codes fall back to the
     * generic failure message.
     */
    public static String messageFor(String code) {
        if (code != null) {
            switch (code) {
                case "permission_denied":
                    return "Microphone permission is required for dictation.";
                case "no_recognizer":
                    return "No speech recognizer is available on this device.";
                case "busy":
                    return "A dictation session is already running.";
                case "network_required":
                case "network_opt_in_required":
                    return "This device would send audio over the network. Allow network audio to continue.";
                case "timeout":
                    return "Speech recognition timed out.";
                case "no_match":
                    return "No speech was recognized.";
                case "audio":
                    return "The microphone audio could not be used.";
                case "server":
                    return "The speech service is unavailable.";
                case "client":
                    return "The speech recognizer could not start.";
                case "language":
                    return "The requested language is not supported.";
                case "cancelled":
                    return "Dictation was cancelled.";
                case "unsupported_platform":
                    return "Dictation is only available in the Android app.";
                default:
                    break;
            }
        }
        return "Speech recognition failed.";
    }

    /**
     * Accepts a BCP-47-ish language tag and returns it trimmed, or {@code null}
     * when it is blank, too long or contains anything that is not a tag.
     */
    public static String normalizeLanguage(String language) {
        if (language == null) return null;
        String trimmed = language.trim();
        if (trimmed.isEmpty() || trimmed.length() > 35) return null;
        if (!trimmed.matches("[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*")) return null;
        return trimmed;
    }
}
