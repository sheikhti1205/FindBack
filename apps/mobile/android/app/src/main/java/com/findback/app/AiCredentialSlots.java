package com.findback.app;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Pure per-account/per-provider slot rules for the AI credential vault.
 *
 * Free of Android dependencies so it is unit-testable on the JVM. The
 * OpenRouter shape is the legacy slot (plain user id), so keys saved before
 * provider namespacing keep decrypting; every other provider gets a disjoint
 * slot input, and a saved record can never be read through another account
 * or another provider slot.
 */
public final class AiCredentialSlots {
    public static final String DEFAULT_PROVIDER = "openrouter";

    private static final Set<String> PROVIDERS = new HashSet<>(Arrays.asList(
        "openrouter",
        "openai",
        "anthropic",
        "google",
        "deepseek",
        "mistral",
        "groq",
        "xai",
        "cohere",
        "generic"
    ));

    private AiCredentialSlots() {
    }

    /** Missing/empty means the legacy default; unknown names yield null. */
    public static String normalizeProvider(String provider) {
        if (provider == null || provider.isEmpty()) return DEFAULT_PROVIDER;
        return PROVIDERS.contains(provider) ? provider : null;
    }

    public static boolean isValidUserId(String userId) {
        return userId != null && userId.length() > 0 && userId.length() <= 128;
    }

    /**
     * Slot + AAD input. `openrouter` keeps the legacy plain-user form;
     * all other providers bind account and provider together.
     */
    public static String slotInput(String userId, String provider) {
        if (DEFAULT_PROVIDER.equals(provider)) return userId;
        return userId + "\0" + provider;
    }
}
