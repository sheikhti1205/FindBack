package com.findback.app;

import static org.junit.Assert.*;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import org.junit.Test;

/**
 * H1-vault: the native vault must namespace each of the ten BYOK providers
 * per account (openrouter/openai/anthropic/google/deepseek/mistral/groq/xai/
 * cohere/generic, matching browserAiCredentials.ts SUPPORTED_AI_PROVIDERS)
 * while keeping the legacy OpenRouter slot byte-identical, so keys saved
 * before namespacing keep decrypting and no slot can be read through another
 * account or another provider.
 *
 * AiCredentialSlots is pure slot rules (no Android deps), so save/get/remove
 * and logout semantics are proven here against an in-memory vault keyed by
 * slotInput — the same isolation contract OpenRouterKeyPlugin enforces via
 * its SHA-256 slot digests + AAD.
 */
public class AiCredentialSlotsTest {

    private static final String[] ALL_TEN = {
        "openrouter", "openai", "anthropic", "google", "deepseek",
        "mistral", "groq", "xai", "cohere", "generic"
    };

    private static final String[] LEGACY_FIVE = {
        "openrouter", "openai", "anthropic", "google", "deepseek"
    };

    private static final String[] NEW_FIVE = {
        "mistral", "groq", "xai", "cohere", "generic"
    };

    /** Minimal in-memory vault: slot key -> fake key material (test fakes only). */
    private static final class FakeVault {
        private final Map<String, String> store = new HashMap<>();

        void save(String userId, String provider, String key) {
            String slot = AiCredentialSlots.normalizeProvider(provider);
            assertNotNull("unknown provider must not reach the vault: " + provider, slot);
            store.put(AiCredentialSlots.slotInput(userId, slot), key);
        }

        String get(String userId, String provider) {
            String slot = AiCredentialSlots.normalizeProvider(provider);
            if (userId == null || slot == null) return null;
            return store.get(AiCredentialSlots.slotInput(userId, slot));
        }

        void remove(String userId, String provider) {
            String slot = AiCredentialSlots.normalizeProvider(provider);
            assertNotNull(slot);
            store.remove(AiCredentialSlots.slotInput(userId, slot));
        }

        /** Logout: clear every provider slot for one account only. */
        void removeAccount(String userId) {
            for (String provider : ALL_TEN) {
                store.remove(AiCredentialSlots.slotInput(userId, provider));
            }
        }
    }

    @Test
    public void defaultsMissingProviderToOpenRouter() {
        assertEquals("openrouter", AiCredentialSlots.normalizeProvider(null));
        assertEquals("openrouter", AiCredentialSlots.normalizeProvider(""));
    }

    @Test
    public void acceptsAllTenProviders() {
        for (String provider : ALL_TEN) {
            assertEquals(provider, AiCredentialSlots.normalizeProvider(provider));
        }
    }

    @Test
    public void acceptsEveryNewProvider() {
        for (String provider : NEW_FIVE) {
            assertEquals(provider, AiCredentialSlots.normalizeProvider(provider));
        }
    }

    @Test
    public void rejectsUnknownProviders() {
        assertNull(AiCredentialSlots.normalizeProvider("bogus"));
        assertNull(AiCredentialSlots.normalizeProvider("OpenAI"));
        assertNull(AiCredentialSlots.normalizeProvider(" openai"));
        assertNull(AiCredentialSlots.normalizeProvider("MISTRAL"));
        assertNull(AiCredentialSlots.normalizeProvider("offline"));
        assertNull(AiCredentialSlots.normalizeProvider("openrouter "));
    }

    @Test
    public void validatesUserIdsLikeThePlugin() {
        assertTrue(AiCredentialSlots.isValidUserId("alice"));
        assertFalse(AiCredentialSlots.isValidUserId(null));
        assertFalse(AiCredentialSlots.isValidUserId(""));
        assertFalse(AiCredentialSlots.isValidUserId(new String(new char[129]).replace("\0", "x")));
        assertTrue(AiCredentialSlots.isValidUserId(new String(new char[128]).replace("\0", "x")));
    }

    @Test
    public void keepsLegacyOpenRouterSlotInput() {
        assertEquals("alice", AiCredentialSlots.slotInput("alice", "openrouter"));
    }

    @Test
    public void namespacesEveryOtherProviderAndAccount() {
        Set<String> slots = new HashSet<>();
        for (String provider : ALL_TEN) {
            slots.add(AiCredentialSlots.slotInput("alice", provider));
        }
        // All ten slots pairwise distinct, OpenRouter keeps the legacy plain form.
        assertEquals(ALL_TEN.length, slots.size());
        assertTrue(slots.contains("alice"));
        for (String provider : ALL_TEN) {
            if ("openrouter".equals(provider)) continue;
            String slot = AiCredentialSlots.slotInput("alice", provider);
            assertNotEquals("alice", slot);
            assertTrue(slot.contains("alice"));
            assertTrue(slot.contains(provider));
        }
        // Same provider, different accounts never share a slot.
        for (String provider : ALL_TEN) {
            assertNotEquals(AiCredentialSlots.slotInput("alice", provider),
                AiCredentialSlots.slotInput("bob", provider));
        }
    }

    @Test
    public void accountIsolation() {
        FakeVault vault = new FakeVault();
        vault.save("alice", "openai", "fake-key-alice");
        assertNull(vault.get("bob", "openai"));
        assertEquals("fake-key-alice", vault.get("alice", "openai"));
    }

    @Test
    public void providerIsolation() {
        FakeVault vault = new FakeVault();
        vault.save("alice", "openai", "fake-key-openai");
        for (String provider : ALL_TEN) {
            if ("openai".equals(provider)) continue;
            assertNull("slot leak into " + provider, vault.get("alice", provider));
        }
        assertEquals("fake-key-openai", vault.get("alice", "openai"));
    }

    @Test
    public void saveGetRemoveRoundTripForLegacyProvider() {
        FakeVault vault = new FakeVault();
        for (String provider : LEGACY_FIVE) {
            if ("openrouter".equals(provider)) continue;
            String key = "fake-key-" + provider;
            assertNull(vault.get("alice", provider));
            vault.save("alice", provider, key);
            assertEquals(key, vault.get("alice", provider));
            vault.remove("alice", provider);
            assertNull(vault.get("alice", provider));
        }
        // Legacy OpenRouter default slot round-trips through the null provider.
        assertNull(vault.get("alice", null));
        vault.save("alice", null, "fake-key-openrouter");
        assertEquals("fake-key-openrouter", vault.get("alice", null));
        assertEquals("fake-key-openrouter", vault.get("alice", "openrouter"));
        vault.remove("alice", "openrouter");
        assertNull(vault.get("alice", "openrouter"));
    }

    @Test
    public void saveGetRemoveRoundTripForEveryNewProvider() {
        FakeVault vault = new FakeVault();
        for (String provider : NEW_FIVE) {
            String key = "fake-key-" + provider;
            assertNull("slot should start empty: " + provider, vault.get("alice", provider));
            vault.save("alice", provider, key);
            assertEquals(key, vault.get("alice", provider));
            vault.remove("alice", provider);
            assertNull("slot should be empty after remove: " + provider, vault.get("alice", provider));
        }
    }

    @Test
    public void perProviderRemovalLeaksNothingAcrossProviders() {
        FakeVault vault = new FakeVault();
        for (String provider : ALL_TEN) {
            vault.save("alice", provider, "fake-key-" + provider);
        }
        vault.remove("alice", "mistral");
        assertNull(vault.get("alice", "mistral"));
        for (String provider : ALL_TEN) {
            if ("mistral".equals(provider)) continue;
            assertEquals("fake-key-" + provider, vault.get("alice", provider));
        }
    }

    @Test
    public void logoutRemovalLeaksNothingAcrossProvidersOrAccounts() {
        FakeVault vault = new FakeVault();
        for (String provider : ALL_TEN) {
            vault.save("alice", provider, "fake-key-alice-" + provider);
            vault.save("bob", provider, "fake-key-bob-" + provider);
        }
        vault.removeAccount("alice");
        for (String provider : ALL_TEN) {
            assertNull("alice slot should be gone: " + provider, vault.get("alice", provider));
            assertEquals("fake-key-bob-" + provider, vault.get("bob", provider));
        }
    }
}
