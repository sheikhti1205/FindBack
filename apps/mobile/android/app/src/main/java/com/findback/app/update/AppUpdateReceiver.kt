package com.findback.app.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** No background activity launch or arbitrary forwarding. */
class AppUpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context,intent: Intent) {runCatching{AppUpdateEngine.get(context).callback(intent)}}
}
