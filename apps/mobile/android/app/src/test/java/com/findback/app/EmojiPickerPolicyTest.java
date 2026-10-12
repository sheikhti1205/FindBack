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
}
