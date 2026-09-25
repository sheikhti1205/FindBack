package com.findback.app;

import static org.junit.Assert.*;

import org.junit.Test;

/**
 * K1: the native vault must namespace each of the five providers per
 * account while keeping the legacy OpenRouter slot byte-identical, so
 * keys saved before namespacing keep decrypting and no slot can be read
 * through another account or another provider.
 */
public class AiCredentialSlotsTest {

    @Test
    public void defaultsMissingProviderToOpenRouter() {
        assertEquals("openrouter", AiCredentialSlots.normalizeProvider(null));
        assertEquals("openrouter", AiCredentialSlots.normalizeProvider(""));
    }

    @Test
    public void acceptsAllFiveProviders() {
        assertEquals("openai", AiCredentialSlots.normalizeProvider("openai"));
        assertEquals("anthropic", AiCredentialSlots.normalizeProvider("anthropic"));
        assertEquals("google", AiCredentialSlots.normalizeProvider("google"));
        assertEquals("deepseek", AiCredentialSlots.normalizeProvider("deepseek"));
        assertEquals("openrouter", AiCredentialSlots.normalizeProvider("openrouter"));
    }

    @Test
    public void rejectsUnknownProviders() {
        assertNull(AiCredentialSlots.normalizeProvider("bogus"));
        assertNull(AiCredentialSlots.normalizeProvider("OpenAI"));
        assertNull(AiCredentialSlots.normalizeProvider(" openai"));
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
        String openai = AiCredentialSlots.slotInput("alice", "openai");
        String anthropic = AiCredentialSlots.slotInput("alice", "anthropic");
        String google = AiCredentialSlots.slotInput("alice", "google");
        String deepseek = AiCredentialSlots.slotInput("alice", "deepseek");
        assertNotEquals("alice", openai);
        assertNotEquals(openai, anthropic);
        assertNotEquals(anthropic, google);
        assertNotEquals(google, deepseek);
        assertNotEquals(openai, AiCredentialSlots.slotInput("bob", "openai"));
        assertTrue(openai.contains("alice"));
        assertTrue(openai.contains("openai"));
    }
}
