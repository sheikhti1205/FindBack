package com.findback.app.ai

/**
 * Qwen thought-envelope stripping (pure, JVM-testable, no Android deps).
 *
 * Qwen3 chat models with the `thought-envelope-then-prose` strategy emit a
 * reasoning envelope ahead of the user-visible answer:
 * `[thought]...reasoning...[/thought]answer`. The envelope must never reach
 * the user: it may contain intermediate reasoning, discarded hypotheses, or
 * verbatim prompt echoes. Stripping happens on the native side before the
 * bridge emits anything, so a TS-layer miss cannot leak reasoning.
 *
 * Markers mirror `modelProfiles.ts` (`thoughtEnvelope.openMarker` /
 * `closeMarker`); the native copy is intentional — the local provider path
 * must not depend on JS-supplied marker strings.
 *
 * Rules:
 * - every complete `[thought]...[/thought]` span is removed (possibly
 *   several per response);
 * - an unclosed `[thought]` truncates the response there (thought-only
 *   output yields an honest empty string, never a reasoning fragment);
 * - a stray `[/thought]` without an opener is removed as markup noise;
 * - surrounding whitespace is trimmed; interior prose is byte-identical.
 */
object ThoughtEnvelope {
    const val OPEN_MARKER = "[thought]"
    const val CLOSE_MARKER = "[/thought]"

    fun strip(raw: String): String {
        var out = raw
        while (true) {
            val open = out.indexOf(OPEN_MARKER)
            if (open < 0) break
            val close = out.indexOf(CLOSE_MARKER, open + OPEN_MARKER.length)
            out = if (close < 0) {
                out.substring(0, open)
            } else {
                out.substring(0, open) + out.substring(close + CLOSE_MARKER.length)
            }
        }
        // Stray closers without an opener are markup noise, not prose.
        while (true) {
            val stray = out.indexOf(CLOSE_MARKER)
            if (stray < 0) break
            out = out.substring(0, stray) + out.substring(stray + CLOSE_MARKER.length)
        }
        return out.trim()
    }

    /** True when no envelope markup survives in [text]. */
    fun isClean(text: String): Boolean =
        !text.contains(OPEN_MARKER) && !text.contains(CLOSE_MARKER)
}
