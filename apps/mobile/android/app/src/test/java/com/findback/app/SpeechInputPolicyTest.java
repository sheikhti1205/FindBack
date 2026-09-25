package com.findback.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.findback.app.SpeechInputPolicy.RouteDecision;

import org.junit.Test;

/**
 * V1 — the dictation bridge must never choose a network route without an
 * explicit opt-in, must fail closed when on-device support cannot be proven,
 * and must translate every {@code SpeechRecognizer} error into the shared
 * taxonomy with a stable, audio-free message.
 *
 * The integer cases below mirror {@code android.speech.SpeechRecognizer
 * .ERROR_*} as read back from the installed SDK with
 * {@code javap -constants -classpath $SDK/platforms/android-36/android.jar android.speech.SpeechRecognizer}
 * on 2026-09-25.
 */
public class SpeechInputPolicyTest {

    // --- routing -----------------------------------------------------------

    @Test
    public void usesTheOnDeviceRouteOnlyWhenThePlatformConfirmsIt() {
        assertEquals(RouteDecision.ON_DEVICE,
            SpeechInputPolicy.decideRoute("available", true, false));
        // a confirmed on-device recognizer keeps winning even if the caller
        // already consented to a network fallback
        assertEquals(RouteDecision.ON_DEVICE,
            SpeechInputPolicy.decideRoute("available", true, true));

        assertEquals(SpeechInputPolicy.ROUTE_ON_DEVICE,
            SpeechInputPolicy.routeFor(RouteDecision.ON_DEVICE));
        assertFalse(SpeechInputPolicy.needsDisclosure(RouteDecision.ON_DEVICE));
    }

    @Test
    public void demandsAnOptInWheneverOnDeviceSupportIsNotProven() {
        assertEquals(RouteDecision.NETWORK_OPT_IN_REQUIRED,
            SpeechInputPolicy.decideRoute("unknown", true, false));
        assertEquals(RouteDecision.NETWORK_OPT_IN_REQUIRED,
            SpeechInputPolicy.decideRoute("unavailable", true, false));
        assertEquals(RouteDecision.NETWORK_OPT_IN_REQUIRED,
            SpeechInputPolicy.decideRoute(null, true, false));
        assertEquals(RouteDecision.NETWORK_OPT_IN_REQUIRED,
            SpeechInputPolicy.decideRoute("garbage", true, false));
        // dropping the on-device preference still needs consent
        assertEquals(RouteDecision.NETWORK_OPT_IN_REQUIRED,
            SpeechInputPolicy.decideRoute("available", false, false));
        assertEquals(RouteDecision.NETWORK_OPT_IN_REQUIRED,
            SpeechInputPolicy.decideRoute("unknown", false, false));

        assertEquals(SpeechInputPolicy.ROUTE_NETWORK,
            SpeechInputPolicy.routeFor(RouteDecision.NETWORK_OPT_IN_REQUIRED));
        assertTrue(SpeechInputPolicy.needsDisclosure(RouteDecision.NETWORK_OPT_IN_REQUIRED));
    }

    @Test
    public void routesToNetworkOnlyAfterExplicitConsent() {
        assertEquals(RouteDecision.NETWORK,
            SpeechInputPolicy.decideRoute("unknown", true, true));
        assertEquals(RouteDecision.NETWORK,
            SpeechInputPolicy.decideRoute("unavailable", true, true));
        assertEquals(RouteDecision.NETWORK,
            SpeechInputPolicy.decideRoute("available", false, true));

        assertEquals(SpeechInputPolicy.ROUTE_NETWORK,
            SpeechInputPolicy.routeFor(RouteDecision.NETWORK));
        assertTrue(SpeechInputPolicy.needsDisclosure(RouteDecision.NETWORK));
    }

    @Test
    public void networkOptInIsRequiredUntilOnDeviceSupportIsProven() {
        assertFalse(SpeechInputPolicy.networkOptInRequired("available"));
        assertTrue(SpeechInputPolicy.networkOptInRequired("unknown"));
        assertTrue(SpeechInputPolicy.networkOptInRequired("unavailable"));
        assertTrue(SpeechInputPolicy.networkOptInRequired(null));
        assertTrue(SpeechInputPolicy.networkOptInRequired(""));
        // fail closed on shape/case surprises
        assertTrue(SpeechInputPolicy.networkOptInRequired("AVAILABLE"));
    }

    @Test
    public void normalisesOnDeviceProbesFailClosed() {
        assertEquals("available", SpeechInputPolicy.normalizeOnDevice("available"));
        assertEquals("unavailable", SpeechInputPolicy.normalizeOnDevice("unavailable"));
        assertEquals("unknown", SpeechInputPolicy.normalizeOnDevice("unknown"));
        assertEquals("unknown", SpeechInputPolicy.normalizeOnDevice(null));
        assertEquals("unknown", SpeechInputPolicy.normalizeOnDevice(""));
        assertEquals("unknown", SpeechInputPolicy.normalizeOnDevice("AVAILABLE"));
        assertEquals("unknown", SpeechInputPolicy.normalizeOnDevice(" true "));
    }

    // --- error taxonomy ----------------------------------------------------

    @Test
    public void mapsEveryRecogniserErrorOntoTheSharedTaxonomy() {
        assertEquals("timeout", SpeechInputPolicy.mapError(1));            // ERROR_NETWORK_TIMEOUT
        assertEquals("network_required", SpeechInputPolicy.mapError(2));    // ERROR_NETWORK
        assertEquals("audio", SpeechInputPolicy.mapError(3));               // ERROR_AUDIO
        assertEquals("server", SpeechInputPolicy.mapError(4));              // ERROR_SERVER
        assertEquals("client", SpeechInputPolicy.mapError(5));              // ERROR_CLIENT
        assertEquals("timeout", SpeechInputPolicy.mapError(6));             // ERROR_SPEECH_TIMEOUT
        assertEquals("no_match", SpeechInputPolicy.mapError(7));            // ERROR_NO_MATCH
        assertEquals("busy", SpeechInputPolicy.mapError(8));                // ERROR_RECOGNIZER_BUSY
        assertEquals("permission_denied", SpeechInputPolicy.mapError(9));   // ERROR_INSUFFICIENT_PERMISSIONS
        assertEquals("busy", SpeechInputPolicy.mapError(10));               // ERROR_TOO_MANY_REQUESTS
        assertEquals("server", SpeechInputPolicy.mapError(11));             // ERROR_SERVER_DISCONNECTED
        assertEquals("language", SpeechInputPolicy.mapError(12));           // ERROR_LANGUAGE_NOT_SUPPORTED
        assertEquals("language", SpeechInputPolicy.mapError(13));           // ERROR_LANGUAGE_UNAVAILABLE
        assertEquals("client", SpeechInputPolicy.mapError(14));             // ERROR_CANNOT_CHECK_SUPPORT
        assertEquals("client", SpeechInputPolicy.mapError(15));             // ERROR_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS
    }

    @Test
    public void unknownErrorsNeverInventATaxonomyCode() {
        assertEquals("unknown", SpeechInputPolicy.mapError(0));
        assertEquals("unknown", SpeechInputPolicy.mapError(-1));
        assertEquals("unknown", SpeechInputPolicy.mapError(16));
        assertEquals("unknown", SpeechInputPolicy.mapError(999));
    }

    @Test
    public void everyCodeHasAStableUserFacingMessage() {
        String[] codes = {
            "permission_denied", "no_recognizer", "busy", "network_required",
            "timeout", "no_match", "audio", "server", "client", "language",
            "cancelled", "unsupported_platform", "unknown", "brand_new_code"
        };
        for (String code : codes) {
            String message = SpeechInputPolicy.messageFor(code);
            assertNotNull(code, message);
            assertFalse(code, message.trim().isEmpty());
        }

        assertEquals("Microphone permission is required for dictation.",
            SpeechInputPolicy.messageFor("permission_denied"));
        assertEquals("No speech recognizer is available on this device.",
            SpeechInputPolicy.messageFor("no_recognizer"));
        assertEquals("A dictation session is already running.",
            SpeechInputPolicy.messageFor("busy"));
        assertEquals("This device would send audio over the network. Allow network audio to continue.",
            SpeechInputPolicy.messageFor("network_required"));
        assertEquals("Speech recognition failed.", SpeechInputPolicy.messageFor("unknown"));
        assertEquals("Speech recognition failed.", SpeechInputPolicy.messageFor("brand_new_code"));
    }

    // --- language validation ----------------------------------------------

    @Test
    public void acceptsRealLanguageTagsOnly() {
        assertEquals("en-US", SpeechInputPolicy.normalizeLanguage("en-US"));
        assertEquals("en-US", SpeechInputPolicy.normalizeLanguage("  en-US "));
        assertEquals("fr", SpeechInputPolicy.normalizeLanguage("fr"));
        assertEquals("zh-Hans-CN", SpeechInputPolicy.normalizeLanguage("zh-Hans-CN"));

        assertNull(SpeechInputPolicy.normalizeLanguage(null));
        assertNull(SpeechInputPolicy.normalizeLanguage(""));
        assertNull(SpeechInputPolicy.normalizeLanguage("   "));
        assertNull(SpeechInputPolicy.normalizeLanguage("x"));
        assertNull(SpeechInputPolicy.normalizeLanguage("english"));
        assertNull(SpeechInputPolicy.normalizeLanguage("en US"));
        assertNull(SpeechInputPolicy.normalizeLanguage("en_US"));
        assertNull(SpeechInputPolicy.normalizeLanguage("en;DROP"));
        assertNull(SpeechInputPolicy.normalizeLanguage("<script>alert(1)</script>"));
        assertNull(SpeechInputPolicy.normalizeLanguage("en-".repeat(20)));
    }
}
