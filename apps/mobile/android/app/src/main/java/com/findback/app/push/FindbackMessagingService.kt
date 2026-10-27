package com.findback.app.push

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin
import com.findback.app.FindbackApp
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Replaces the Capacitor push plugin's MessagingService (removed in the app
 * manifest) so data-only messages can be presented natively with a RemoteInput
 * reply action while still forwarding to the plugin when a bridge is alive.
 *
 * Foreground (an activity is started AND a bridge exists): the plugin delivers
 * `pushNotificationReceived` to JS and the in-app inbox updates; no system
 * notification is posted. Background, including a warm process with no started
 * activity: the app owns presentation and posts the notification itself.
 */
class FindbackMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["type"].orEmpty().startsWith("CHAT_")) {
            val chat = ChatPushData.fromData(message.data) ?: return
            val foreground = FindbackApp.foreground && PushNotificationsPlugin.getPushNotificationsInstance() != null
            try {
                ChatPushState.deliver(this, chat, foreground) { PushNotificationsPlugin.sendRemoteMessage(message) }
            } catch (_: Exception) { /* Cached admission/persistence failed: never forward or present. */ }
            return
        }
        // Always forward: foreground JS events, and the plugin's lastMessage
        // stash for a cold/background launch.
        PushNotificationsPlugin.sendRemoteMessage(message)

        // `FindbackApp.foreground` is the real lifecycle signal. The plugin
        // instance only tells us a bridge/WebView exists, which is also true for
        // a warm app sitting in the background — so it is a secondary guard,
        // never the definition of "foreground".
        val bridgeAlive = PushNotificationsPlugin.getPushNotificationsInstance() != null
        if (FindbackApp.foreground && bridgeAlive) return

        val push = PushData.fromData(message.data) ?: return
        NotificationPresenter(this).show(push)
    }

    override fun onNewToken(token: String) {
        // Registration token for the plugin's `registration` event.
        PushNotificationsPlugin.onNewToken(token)
    }
}
