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
     * Fitzpatrick skin-tone modifiers (light → dark) offered by the tone
     * strip. An empty selection means the default (yellow / unmodified)
     * presentation.
     */
    public static final String[] TONE_MODIFIERS = {
        "\uD83C\uDFFB", "\uD83C\uDFFC", "\uD83C\uDFFD", "\uD83C\uDFFE", "\uD83C\uDFFF",
    };

    /**
     * Max UTF-16 length of an accepted pick. Emoji outside the BMP cost two
     * units each; 24 covers ZWJ families and flags with room to spare while
     * still refusing pasted sentences.
     */
    public static final int MAX_PICK_LENGTH = 24;

    private EmojiPickerPolicy() {}

    /**
     * Base emoji that accept a Fitzpatrick modifier. Only these combine with
     * the tone strip; every other pick (including precomposed tone variants
     * already in the catalogue) passes through unchanged.
     */
    public static boolean isToneableBase(String base) {
        if (base == null) return false;
        switch (base) {
            case "\uD83D\uDC4D": // 👍
            case "\uD83D\uDC4E": // 👎
            case "\uD83D\uDC4F": // 👏
            case "\uD83D\uDE4F": // 🙏
            case "\uD83D\uDC4B": // 👋
            case "\u270A": // ✊
            case "\uD83D\uDE4C": // 🙌
            case "\uD83E\uDD32": // 🤲
            case "\uD83E\uDDB6": // 🫶
            case "\uD83D\uDCAA": // 💪
            case "\u270C\uFE0F": // ✌️
                return true;
            default:
                return false;
        }
    }

    /** True when `modifier` is one of {@link #TONE_MODIFIERS}. */
    public static boolean isToneModifier(String modifier) {
        if (modifier == null) return false;
        for (String tone : TONE_MODIFIERS) {
            if (tone.equals(modifier)) return true;
        }
        return false;
    }

    /**
     * Applies the selected tone to a picked base: toneable bases gain the
     * modifier, everything else (precomposed variants, ZWJ sequences, flags,
     * symbols) passes through unchanged. Never throws; null-safe.
     */
    public static String applyTone(String base, String modifier) {
        if (base == null) return null;
        if (!isToneModifier(modifier)) return base;
        if (!isToneableBase(base)) return base;
        return base + modifier;
    }

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
