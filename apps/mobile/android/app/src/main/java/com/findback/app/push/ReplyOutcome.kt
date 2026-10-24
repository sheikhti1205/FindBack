package com.findback.app.push

import org.json.JSONObject

/**
 * What the reply endpoint answered.
 *
 * The direct-reply action used to treat every non-2xx as "FindBack is broken",
 * so the two refusals the interaction-limit guard can now produce — the 30 s
 * public-interaction clock and the day's ceiling — were invisible and invited a
 * retry that could not succeed. Both are answers, and they are different answers:
 * one is a wait, the other is a day that is done.
 */
sealed interface ReplyOutcome {
    /** The reply was accepted by the server. */
    data object Sent : ReplyOutcome

    /** Spaced by the same 30 s public-interaction clock the app already knows. */
    data class TooFast(val retryAfterSeconds: Int) : ReplyOutcome

    /** The account's public interactions are done for today. */
    data object DailyLimit : ReplyOutcome

    /**
     * The account cannot write right now as a matter of standing (a zero
     * self-derived limit: RESTRICTED, suspension), not because a quota ran out.
     * These shared one word — `POST_LIMIT_REACHED` — until R3 F-1, which made the
     * "that's all your replies for today" copy false for a restricted account.
     */
    data object Restricted : ReplyOutcome

    /** Anything else: transport, 5xx, or an unclassified refusal. */
    data object Failed : ReplyOutcome
}

/** The server's `reason` from a refusal body, or null when there is none. */
fun replyReasonFrom(body: String?): String? {
    if (body.isNullOrBlank()) return null
    return runCatching { JSONObject(body).optString("reason").ifBlank { null } }.getOrNull()
}

/** The `retry-after` header in whole seconds, or null when it is absent or unusable. */
fun retryAfterSecondsFrom(header: String?): Int? =
    header?.trim()?.toIntOrNull()?.takeIf { it > 0 }

/**
 * Classify one reply response.
 *
 * `retryAfter` is the `retry-after` header in seconds; the server sends 30 for
 * the clock refusal and nothing for the day's ceiling, so a missing header falls
 * back to the clock's own interval rather than inventing a number.
 */
fun replyOutcomeFor(status: Int, reason: String?, retryAfter: Int?): ReplyOutcome = when {
    status in 200..299 -> ReplyOutcome.Sent
    // 403 + account_restricted is the standing refusal the guard raises for a zero
    // limit. It is checked before the 429 pair because it is neither a wait nor a
    // quota, and it must never be shown as either (R3 F-1).
    reason == "account_restricted" -> ReplyOutcome.Restricted
    status == 429 && reason == "daily_limit" -> ReplyOutcome.DailyLimit
    status == 429 -> ReplyOutcome.TooFast(retryAfter ?: 30)
    else -> ReplyOutcome.Failed
}
