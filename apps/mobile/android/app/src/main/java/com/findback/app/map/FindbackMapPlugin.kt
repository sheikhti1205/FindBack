package com.findback.app.map

import android.app.Activity
import android.content.Intent
import android.util.Log
import androidx.activity.result.ActivityResult
import com.findback.app.BuildConfig
import com.findback.app.FindbackApp
import com.findback.app.map.FindbackMapActivity.Companion.EXTRA_ALLOW_CURRENT_LOCATION
import com.findback.app.map.FindbackMapActivity.Companion.EXTRA_LABEL
import com.findback.app.map.FindbackMapActivity.Companion.EXTRA_LATITUDE
import com.findback.app.map.FindbackMapActivity.Companion.EXTRA_LONGITUDE
import com.findback.app.map.FindbackMapActivity.Companion.EXTRA_MODE
import com.findback.app.map.FindbackMapActivity.Companion.EXTRA_ZOOM
import com.findback.app.map.FindbackMapActivity.Companion.MODE_PICKER
import com.findback.app.map.FindbackMapActivity.Companion.MODE_VIEWER
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Keyless MapLibre map bridge (MAP pivot): picker + viewer over the native
 * [FindbackMapActivity], snapshots via [MapSnapshotService] (added with the
 * post-preview commit). Renderer-agnostic on the JS side — the web layer
 * never names MapLibre, OpenFreeMap, or Nominatim.
 *
 * Result contract (mirrors the established FindbackMedia ActivityResult
 * pattern): one picker call in flight per plugin instance; a concurrent call
 * rejects with MAP_PICKER_BUSY. Cancel NEVER mutates the report draft — the
 * web layer only writes on `{cancelled:false}` with valid coordinates.
 * Nothing secret ever crosses this bridge (there is no map secret).
 */
@CapacitorPlugin(name = "FindbackMap")
class FindbackMapPlugin : Plugin() {

    companion object {
        private const val TAG = "FindbackMapPlugin"

        /** Must match `mapLibreVersion` in variables.gradle (release-gated). */
        const val RENDERER_VERSION = "13.6.1"
    }

    @Volatile
    private var pickerInFlight = false

    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        // Renderer-neutral provider tag: "openfreemap" only for the default
        // style, "custom" otherwise — never a URL or secret in diagnostics.
        val effectiveStyle = try {
            MapValidation.validateStyleUrl(BuildConfig.MAP_STYLE_URL)
        } catch (e: Exception) {
            MapValidation.DEFAULT_STYLE_URL
        }
        val result = JSObject()
        result.put("native", true)
        result.put("renderer", "maplibre-native")
        result.put("rendererVersion", RENDERER_VERSION)
        result.put("styleProvider", MapValidation.styleProvider(effectiveStyle))
        result.put("snapshot", true)
        result.put("picker", true)
        call.resolve(result)
    }

    @PluginMethod
    fun openPicker(call: PluginCall) {
        synchronized(this) {
            if (pickerInFlight) {
                call.reject("Another location picker is already open.", "MAP_PICKER_BUSY")
                return
            }
            pickerInFlight = true
        }
        // Invalid initial coordinates seed a neutral display-only camera —
        // extras are passed ONLY when valid, so native can never mistake a
        // fallback for a committed pin.
        val intent = Intent(context, FindbackMapActivity::class.java)
            .putExtra(EXTRA_MODE, MODE_PICKER)
            .putExtra(EXTRA_LABEL, call.getString(EXTRA_LABEL, ""))
            .putExtra(EXTRA_ZOOM, MapValidation.clampZoom(call.getDouble(EXTRA_ZOOM)))
            .putExtra(EXTRA_ALLOW_CURRENT_LOCATION, call.getBoolean(EXTRA_ALLOW_CURRENT_LOCATION, true)!!)
        val lat = call.getDouble(EXTRA_LATITUDE)
        val lng = call.getDouble(EXTRA_LONGITUDE)
        if (MapValidation.isValidCenter(lat, lng)) {
            intent.putExtra(EXTRA_LATITUDE, lat!!).putExtra(EXTRA_LONGITUDE, lng!!)
        }
        activity.runOnUiThread {
            try {
                startActivityForResult(call, intent, "mapPicked")
            } catch (e: Exception) {
                synchronized(this) { pickerInFlight = false }
                call.reject("The location picker could not open.", "MAP_UNAVAILABLE")
            }
        }
    }

    @ActivityCallback
    private fun mapPicked(call: PluginCall?, result: ActivityResult) {
        synchronized(this) { pickerInFlight = false }
        if (call == null) return
        if (result.resultCode != Activity.RESULT_OK) {
            val cancelled = JSObject()
            cancelled.put("cancelled", true)
            call.resolve(cancelled)
            return
        }
        val data = result.data
        val lat = data?.getDoubleExtra(EXTRA_LATITUDE, Double.NaN)?.takeIf { it.isFinite() }
        val lng = data?.getDoubleExtra(EXTRA_LONGITUDE, Double.NaN)?.takeIf { it.isFinite() }
        if (!MapValidation.isValidCenter(lat, lng)) {
            // A confirmed picker must always carry a real coordinate —
            // malformed results are rejected, never committed.
            call.reject("The picker returned an invalid location.", "MAP_INVALID_COORDINATES")
            return
        }
        val resolved = JSObject()
        resolved.put("cancelled", false)
        resolved.put(EXTRA_LATITUDE, lat!!)
        resolved.put(EXTRA_LONGITUDE, lng!!)
        resolved.put(EXTRA_ZOOM, MapValidation.clampZoom(data.getDoubleExtra(EXTRA_ZOOM, MapValidation.DEFAULT_ZOOM).takeIf { it.isFinite() }))
        call.resolve(resolved)
    }

    @PluginMethod
    fun openViewer(call: PluginCall) {
        val lat = call.getDouble(EXTRA_LATITUDE)
        val lng = call.getDouble(EXTRA_LONGITUDE)
        if (!MapValidation.isValidCenter(lat, lng)) {
            call.reject("A map preview needs valid coordinates.", "MAP_INVALID_COORDINATES")
            return
        }
        val intent = Intent(context, FindbackMapActivity::class.java)
            .putExtra(EXTRA_MODE, MODE_VIEWER)
            .putExtra(EXTRA_LATITUDE, lat!!)
            .putExtra(EXTRA_LONGITUDE, lng!!)
            .putExtra(EXTRA_ZOOM, MapValidation.clampZoom(call.getDouble(EXTRA_ZOOM)))
            .putExtra(EXTRA_LABEL, call.getString(EXTRA_LABEL, ""))
        activity.runOnUiThread {
            try {
                startActivityForResult(call, intent, "mapViewed")
            } catch (e: Exception) {
                call.reject("The map viewer could not open.", "MAP_UNAVAILABLE")
            }
        }
    }

    @ActivityCallback
    private fun mapViewed(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val closed = JSObject()
        closed.put("closed", true)
        call.resolve(closed)
    }

    @PluginMethod
    fun renderSnapshot(call: PluginCall) {
        val lat = call.getDouble(EXTRA_LATITUDE)
        val lng = call.getDouble(EXTRA_LONGITUDE)
        if (!MapValidation.isValidCenter(lat, lng)) {
            call.reject("A map preview needs valid coordinates.", "MAP_INVALID_COORDINATES")
            return
        }
        val zoom = MapValidation.clampZoom(call.getDouble(EXTRA_ZOOM))
        val width = MapValidation.clampSnapshotEdge(call.getInt("width") ?: 640)
        val height = MapValidation.clampSnapshotEdge(call.getInt("height") ?: 360)
        val density = call.getDouble("density")?.takeIf { it.isFinite() }?.toFloat()
        val theme = call.getString("theme", "light")
        val styleUrl = MapValidation.validateStyleUrl(BuildConfig.MAP_STYLE_URL)
        val context = context
        if (!FindbackApp.mapLibreInitialized) {
            Log.w(TAG, "MapLibre was not initialized at application startup before renderSnapshot.")
        }
        try {
            MapSnapshotService.render(
                context,
                lat!!,
                lng!!,
                zoom,
                width,
                height,
                density,
                theme,
                styleUrl,
            ) { outcome ->
                outcome.fold(
                    onSuccess = { snapshot ->
                        val result = JSObject()
                        result.put("uri", snapshot.file.toURI().toString())
                        result.put("width", snapshot.widthPx)
                        result.put("height", snapshot.heightPx)
                        result.put("cacheKey", snapshot.cacheKey)
                        call.resolve(result)
                    },
                    onFailure = {
                        call.reject("The map preview failed.", "MAP_SNAPSHOT_FAILED")
                    },
                )
            }
        } catch (e: IllegalArgumentException) {
            call.reject("A map preview needs valid coordinates.", "MAP_INVALID_COORDINATES")
        } catch (e: Exception) {
            call.reject("The map preview failed.", "MAP_SNAPSHOT_FAILED")
        }
    }
}
