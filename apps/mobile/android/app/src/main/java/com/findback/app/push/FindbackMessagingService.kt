package com.findback.app.push

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Replaces the Capacitor push plugin's MessagingService (removed in the app
 * manifest) so data-only messages can be presented natively with a RemoteInput
 * reply action while still forwarding to the plugin when a bridge is alive.
 *
 * Foreground: the plugin delivers `pushNotificationReceived` to JS and the
 * in-app inbox updates; no system notification is posted. Background: the app
 * owns presentation and posts the notification itself.
 */
class FindbackMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        // Always forward: foreground JS events, and the plugin's lastMessage
        // stash for a cold/background launch.
        PushNotificationsPlugin.sendRemoteMessage(message)

        // A live instance means the WebView bridge exists (app in foreground).
        if (PushNotificationsPlugin.getPushNotificationsInstance() != null) return

        val push = PushData.fromData(message.data) ?: return
        NotificationPresenter(this).show(push)
    }

    override fun onNewToken(token: String) {
        // Registration token for the plugin's `registration` event.
        PushNotificationsPlugin.onNewToken(token)
    }
}
