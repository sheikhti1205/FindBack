package com.findback.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/**
 * FBX-016 — the emoji bridge contract: one visible pick (including
 * multi-codepoint sequences) passes, and anything that could smuggle
 * arbitrary text into the draft is rejected. Mirrors the web sanitizer
 * ({@code emojiPicker.test.ts}) so both sides of the bridge agree.
 */
public class EmojiPickerPolicyTest {

    @Test
    public void exposesTheStableBridgeContract() {
        assertEquals("FindbackEmoji", EmojiPickerPolicy.PLUGIN_NAME);
        assertEquals("pickEmoji", EmojiPickerPolicy.METHOD_PICK_EMOJI);
        assertEquals("emoji", EmojiPickerPolicy.KEY_EMOJI);
        assertEquals("cancelled", EmojiPickerPolicy.KEY_CANCELLED);
    }

    @Test
    public void acceptsASinglePickIncludingMultiCodepointSequences() {
        assertEquals("\uD83D\uDD25", EmojiPickerPolicy.sanitizePickedEmoji("\uD83D\uDD25"));
        // Flag (regional indicators), skin tone, ZWJ family.
        assertEquals("\uD83C\uDDFA\uD83C\uDDF8",
            EmojiPickerPolicy.sanitizePickedEmoji("  \uD83C\uDDFA\uD83C\uDDF8  "));
        assertEquals("\uD83D\uDC4D\uD83C\uDFFD",
            EmojiPickerPolicy.sanitizePickedEmoji("\uD83D\uDC4D\uD83C\uDFFD"));
        assertEquals("\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67",
            EmojiPickerPolicy.sanitizePickedEmoji("\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67"));
    }

    @Test
    public void rejectsBlanksRunsUrlsAndDataPayloads() {
        assertNull(EmojiPickerPolicy.sanitizePickedEmoji(null));
        assertNull(EmojiPickerPolicy.sanitizePickedEmoji(""));
        assertNull(EmojiPickerPolicy.sanitizePickedEmoji("   "));
        assertNull(EmojiPickerPolicy.sanitizePickedEmoji("\uD83D\uDE00 \uD83D\uDE00"));
        assertNull(EmojiPickerPolicy.sanitizePickedEmoji("https://evil.example/x.png"));
        assertNull(EmojiPickerPolicy.sanitizePickedEmoji("data:image/png;base64,AAA"));
        StringBuilder longPick = new StringBuilder();
        for (int i = 0; i < EmojiPickerPolicy.MAX_PICK_LENGTH + 1; i++) longPick.append('x');
        assertNull(EmojiPickerPolicy.sanitizePickedEmoji(longPick.toString()));
    }

    @Test
    public void exposesFiveFitzpatrickToneModifiers() {
        assertEquals(5, EmojiPickerPolicy.TONE_MODIFIERS.length);
        for (String tone : EmojiPickerPolicy.TONE_MODIFIERS) {
            assertEquals(true, EmojiPickerPolicy.isToneModifier(tone));
        }
        assertEquals(false, EmojiPickerPolicy.isToneModifier(""));
        assertEquals(false, EmojiPickerPolicy.isToneModifier(null));
        assertEquals(false, EmojiPickerPolicy.isToneModifier("\uD83D\uDE00"));
    }

    @Test
    public void appliesToneOnlyToToneableBases() {
        String medium = "\uD83C\uDFFD";
        // Toneable gesture bases gain the modifier.
        assertEquals("\uD83D\uDC4D\uD83C\uDFFD",
            EmojiPickerPolicy.applyTone("\uD83D\uDC4D", medium));
        assertEquals("\uD83D\uDE4F\uD83C\uDFFD",
            EmojiPickerPolicy.applyTone("\uD83D\uDE4F", medium));
        // Everything else passes through: symbols, ZWJ families, flags,
        // precomposed variants, and the handshake (no modifier support).
        assertEquals("\uD83D\uDE00",
            EmojiPickerPolicy.applyTone("\uD83D\uDE00", medium));
        assertEquals("\uD83E\uDD1D",
            EmojiPickerPolicy.applyTone("\uD83E\uDD1D", medium));
        assertEquals("\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67",
            EmojiPickerPolicy.applyTone("\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67", medium));
        assertEquals("\uD83C\uDDFA\uD83C\uDDF8",
            EmojiPickerPolicy.applyTone("\uD83C\uDDFA\uD83C\uDDF8", medium));
        // No tone selected (or a bogus one) leaves the base untouched.
        assertEquals("\uD83D\uDC4D", EmojiPickerPolicy.applyTone("\uD83D\uDC4D", ""));
        assertEquals("\uD83D\uDC4D", EmojiPickerPolicy.applyTone("\uD83D\uDC4D", null));
        assertEquals("\uD83D\uDC4D", EmojiPickerPolicy.applyTone("\uD83D\uDC4D", "x"));
        assertNull(EmojiPickerPolicy.applyTone(null, medium));
    }
}
