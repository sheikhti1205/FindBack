package com.findback.app.push

import android.content.Context
import android.content.Intent
import android.app.NotificationManager
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Cached native admission, NOT a second authentication owner. Every JS route
 * still waits for the canonical authenticated session. One process-wide monitor
 * orders bind/clear, service presentation and tap capture/consume. No tokens,
 * message bodies or sender identities are stored here. */
object ChatPushState {
    const val ACTION_TAP = "com.findback.app.CHAT_TAP"
    private const val PREFS = "findback.chat.push.v1"
    private const val TTL = 24 * 60 * 60 * 1000L
    private const val LIMIT = 512
    private var storageReady = true

    private fun load(context: Context): JSONObject = JSONObject(
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("state", "{}") ?: "{}")

    private fun save(context: Context, state: JSONObject) {
        check(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("state", state.toString()).commit()) { "Chat notification state unavailable" }
    }

    private fun entries(state: JSONObject): JSONArray {
        val now = System.currentTimeMillis()
        val result = JSONArray()
        val old = state.optJSONArray("seen") ?: JSONArray()
        for (i in 0 until old.length()) {
            val item = old.getJSONObject(i)
            val at = item.getLong("at")
            // A backwards clock change fails closed (never immediately forget a
            // previously presented wake), without allowing an unbounded list.
            if (now - at < TTL) result.put(item)
        }
        check(result.length() <= LIMIT)
        state.put("seen", result)
        return result
    }

    @JvmStatic @Synchronized fun bind(context: Context, accountId: String?) {
        storageReady = false
        val state = load(context)
        val seen = entries(state)
        if (state.optString("account") != (accountId ?: "")) {
            // Include notifications older than our bounded dedupe cache.
            context.getSystemService(NotificationManager::class.java)?.activeNotifications?.forEach {
                if (it.tag?.startsWith("chat:") == true) NotificationManagerCompat.from(context).cancel(it.tag, it.id)
            }
            state.remove("pending")
            for (i in 0 until seen.length()) {
                val item = seen.getJSONObject(i)
                item.remove("tap")
                NotificationManagerCompat.from(context).cancel("chat:" + item.getString("wake"), 0)
            }
        }
        state.put("account", accountId ?: "")
        save(context, state)
        storageReady = true
    }

    /** Called before Capacitor sees chat data. Reserve dedupe before notify:
     * a crash may lose one nudge, but cannot replay it after dismissal. At the
     * bound, suppress new nudges rather than evict live dedupe entries. */
    @Synchronized fun deliver(context: Context, push: ChatPushData, foreground: Boolean, forward: () -> Unit) {
        if (!storageReady) return
        val state = load(context)
        if (state.optString("account") != push.recipientId) return
        if (push.type == "CHAT_CONNECTED") {
            if (foreground) forward()
            return
        }
        val seen = entries(state)
        val duplicate = (0 until seen.length()).any { seen.getJSONObject(it).getString("wake") == push.notificationId }
        if (duplicate) { if (foreground) forward(); return }
        if (seen.length() >= LIMIT) { if (foreground) forward(); return }
        val tap = UUID.randomUUID().toString()
        seen.put(JSONObject().put("wake", push.notificationId).put("account", push.recipientId)
            .put("conversation", push.conversationId).put("at", System.currentTimeMillis()).put("tap", tap))
        save(context, state)
        if (foreground) forward()
        else NotificationPresenter(context).showChatRequest(push, tap)
    }

    /** The exported launcher is not an authority. A tap must match a private,
     * unconsumed capability created by our immutable notification PendingIntent.
     * Arbitrary extras/recipient/conversation supplied by other apps are ignored. */
    @JvmStatic @Synchronized fun capture(context: Context, intent: Intent?): Boolean {
        if (!storageReady) return false
        if (intent?.action != ACTION_TAP) return false
        val uri = intent.data ?: return false
        if (uri.scheme != "findback-chat" || uri.host != "tap" || uri.query != null || uri.fragment != null) return false
        val token = uri.path?.removePrefix("/") ?: return false
        val state = load(context)
        val seen = entries(state)
        for (i in 0 until seen.length()) {
            val item = seen.getJSONObject(i)
            if (item.optString("tap") != token || token.isEmpty()) continue
            if (item.getString("account") != state.optString("account")) return false
            item.remove("tap") // same PendingIntent cannot be replayed
            state.put("pending", JSONObject(item.toString()))
            save(context, state)
            return true
        }
        return false
    }

    @JvmStatic @Synchronized fun take(context: Context, accountId: String): ChatPushData? {
        if (!storageReady) return null
        val state = load(context)
        if (state.optString("account") != accountId) return null
        val pending = state.optJSONObject("pending") ?: return null
        if (pending.optString("account") != accountId || System.currentTimeMillis() - pending.getLong("at") >= TTL) return null
        return ChatPushData.fromData(mapOf("type" to "CHAT_REQUEST", "recipientId" to accountId,
            "conversationId" to pending.getString("conversation"), "notificationId" to pending.getString("wake")))
    }

    /** Acknowledge only after authenticated routing; a cancelled JS effect or
     * WebView reload must not consume the cold tap before it is used. */
    @JvmStatic @Synchronized fun acknowledge(context: Context, accountId: String, wakeId: String) {
        val state = load(context)
        val pending = state.optJSONObject("pending") ?: return
        if (state.optString("account") != accountId || pending.optString("account") != accountId || pending.optString("wake") != wakeId) return
        state.remove("pending")
        save(context, state)
    }
}
