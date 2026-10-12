package com.findback.app;

/**
 * FBX-016 — pure decision logic for the Android emoji-picker bridge.
 *
 * <p>Deliberately free of any {@code android.*} import so it can be unit
 * tested on the JVM (see {@code EmojiPickerPolicyTest}). Mirrors the web
 * bridge sanitizer ({@code emojiPicker.ts#sanitizePickedEmoji}) exactly:
 * one visible pick (multi-codepoint sequences allowed — flags, skin tones,
 * ZWJ families — hence the generous length cap), blanks, whitespace runs,
 * URLs and data payloads rejected so a malformed sheet result can never
 * inject arbitrary text into the draft.
 */
public final class EmojiPickerPolicy {

    /** Capacitor plugin name the web bridge binds to. */
    public static final String PLUGIN_NAME = "FindbackEmoji";
    /** The single exposed method. */
    public static final String METHOD_PICK_EMOJI = "pickEmoji";
    /** Result key carrying the picked emoji. */
    public static final String KEY_EMOJI = "emoji";
    /** Result key marking a user cancel. */
    public static final String KEY_CANCELLED = "cancelled";

    /**
     * Max UTF-16 length of an accepted pick. Emoji outside the BMP cost two
     * units each; 24 covers ZWJ families and flags with room to spare while
     * still refusing pasted sentences.
     */
    public static final int MAX_PICK_LENGTH = 24;

    private EmojiPickerPolicy() {}

    /**
     * Returns the trimmed pick, or {@code null} when it is not exactly one
     * visible emoji-shaped token. Never throws.
     */
    public static String sanitizePickedEmoji(String raw) {
        if (raw == null) return null;
        String trimmed = raw.trim();
        if (trimmed.isEmpty() || trimmed.length() > MAX_PICK_LENGTH) return null;
        for (int i = 0; i < trimmed.length(); i++) {
            if (Character.isWhitespace(trimmed.charAt(i))) return null;
        }
        String lower = trimmed.toLowerCase(java.util.Locale.ROOT);
        if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("data:")) {
            return null;
        }
        return trimmed;
    }
}
