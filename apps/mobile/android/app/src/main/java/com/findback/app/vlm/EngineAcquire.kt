package com.findback.app.vlm

/**
 * WP1 (audit #1): engine acquisition policy.
 *
 * Returns a genuinely initialized engine, or null when initialization
 * fails. A failed construction is always closed so a half-built engine
 * can never be stored and handed to analyze().
 */
internal fun <E : Any> acquireInitializedEngine(
    create: () -> E,
    initialize: (E) -> Unit,
    close: (E) -> Unit
): E? {
    val engine = create()
    return try {
        initialize(engine)
        engine
    } catch (t: Throwable) {
        try {
            close(engine)
        } catch (_: Exception) {
        }
        null
    }
}
