package com.findback.app

import android.app.Activity
import android.app.Application
import android.os.Bundle
import com.findback.app.push.PushChannels
import org.maplibre.android.MapLibre

/**
 * Tracks whether any FindBack activity is currently started.
 *
 * The FCM service must distinguish a foreground app (where the JS layer shows
 * the event) from a warm app sitting in the background (where no activity is
 * started and a system notification is required). Capacitor's static plugin
 * instance reflects bridge/WebView existence, not foreground state, so this
 * lifecycle signal is the authoritative one.
 */
class FindbackApp : Application() {

    override fun onCreate() {
        super.onCreate()
        MapLibre.getInstance(this)
        mapLibreInitialized = true
        // Create the category channels up front so Android Settings shows them
        // before the first push arrives.
        PushChannels.ensureCreated(this)
        registerActivityLifecycleCallbacks(
            object : ActivityLifecycleCallbacks {
                var startedActivities = 0

                override fun onActivityStarted(activity: Activity) {                    startedActivities += 1
                    foreground = true
                }

                override fun onActivityStopped(activity: Activity) {
                    startedActivities = (startedActivities - 1).coerceAtLeast(0)
                    if (startedActivities == 0) foreground = false
                }

                override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
                override fun onActivityResumed(activity: Activity) {}
                override fun onActivityPaused(activity: Activity) {}
                override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
                override fun onActivityDestroyed(activity: Activity) {}
            },
        )
    }

    companion object {
        /** True while at least one activity is started; false when backgrounded. */
        @Volatile
        var foreground: Boolean = false
            private set

        @Volatile
        var mapLibreInitialized: Boolean = false
            private set
    }
}
