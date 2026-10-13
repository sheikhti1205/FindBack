package com.findback.app.map

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.findback.app.BuildConfig
import com.findback.app.R
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapView

/**
 * Keyless native map surface (MAP pivot): MapLibre Native [MapView] in its own
 * Activity — never embedded under the Capacitor WebView, so there is no
 * transparency/z-order/container-sync contract.
 *
 * Modes:
 * - picker: fixed center pin; the map moves underneath it. Camera-idle after
 *   a user gesture updates the DRAFT only — nothing is written to the report
 *   until Confirm. Cancel/system-Back returns CANCELED with no mutation.
 * - viewer: read-only camera on a committed coordinate (post detail tap).
 *
 * Search is explicit-submit Nominatim (≤1 req/s, ≤5 results, app User-Agent);
 * a result recenters the camera but never commits. Location is one-shot via
 * the fused provider — no tracking, no background permission.
 */
class FindbackMapActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_MODE = "mode"
        const val MODE_PICKER = "picker"
        const val MODE_VIEWER = "viewer"
        const val EXTRA_LATITUDE = "latitude"
        const val EXTRA_LONGITUDE = "longitude"
        const val EXTRA_ZOOM = "zoom"
        const val EXTRA_LABEL = "label"
        const val EXTRA_ALLOW_CURRENT_LOCATION = "allowCurrentLocation"

        private const val STATE_DRAFT_LAT = "draftLat"
        private const val STATE_DRAFT_LNG = "draftLng"
        private const val STATE_ZOOM = "zoom"

        private const val LOCATION_PERMISSION_CODE = 0xFB4A
        private const val LOCATION_TIMEOUT_MS = 15_000L
        private const val SEARCH_CAMERA_ANIMATION_MS = 1200

        /**
         * Display-only neutral camera (central Bangladesh): used when no valid
         * initial coordinate was supplied. The draft stays null, so this can
         * never become a committed pin — Confirm waits for a user gesture.
         */
        private val NEUTRAL_CENTER = LatLng(23.70, 90.35)
        private const val NEUTRAL_ZOOM = 6.0
    }

    private lateinit var mapView: MapView
    private var map: MapLibreMap? = null
    private var idleListener: MapLibreMap.OnCameraIdleListener? = null
    private var moveStartedListener: MapLibreMap.OnCameraMoveStartedListener? = null
    private var destroyed = false
    private var styleLoaded = false
    private var styleFailed = false

    private var isPicker = true
    private var draftLat: Double? = null
    private var draftLng: Double? = null
    private var draftZoom: Double = MapValidation.DEFAULT_ZOOM
    private var lastGestureMove = false
    private var searching = false
    private var locating = false
    private var locationCancel: CancellationTokenSource? = null
    private val locationTimeout = Handler(Looper.getMainLooper())
    // Process-wide ≤1 req/s throttle shared at provider level — never a
    // per-Activity instance (explicit-submit only, no autocomplete).
    private val searchGate: NominatimGate = NominatimClient.sharedGate
    private var searchGeneration = 0
    private var searchResults: List<NominatimResult> = emptyList()

    private lateinit var titleView: TextView
    private lateinit var confirmButton: Button
    private lateinit var searchRow: View
    private lateinit var searchInput: EditText
    private lateinit var searchButton: Button
    private lateinit var resultsList: ListView
    private lateinit var loading: ProgressBar
    private lateinit var readout: TextView
    private lateinit var statusRow: View
    private lateinit var statusText: TextView
    private lateinit var retryButton: Button
    private lateinit var footer: View
    private lateinit var myLocationButton: Button

    // region lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        MapLibre.getInstance(this)
        setContentView(R.layout.activity_findback_map)

        isPicker = intent.getStringExtra(EXTRA_MODE) != MODE_VIEWER
        bindViews()
        restoreDraft(savedInstanceState)

        titleView.text = initialTitle()
        confirmButton.visibility = if (isPicker) View.VISIBLE else View.GONE
        searchRow.visibility = if (isPicker) View.VISIBLE else View.GONE
        footer.visibility =
            if (isPicker && intent.getBooleanExtra(EXTRA_ALLOW_CURRENT_LOCATION, true)) View.VISIBLE else View.GONE

        confirmButton.isEnabled = draftLat != null && draftLng != null
        updateReadout()

        mapView.onCreate(savedInstanceState)
        mapView.getMapAsync { mapLibreMap ->
            // Backed out before the map loaded: touch nothing — the Activity
            // is finishing and the MapView is (being) destroyed.
            if (destroyed || isFinishing || isDestroyed) return@getMapAsync
            map = mapLibreMap
            val ui = mapLibreMap.uiSettings
            ui.isAttributionEnabled = true
            ui.isLogoEnabled = true
            mapLibreMap.moveCamera(CameraUpdateFactory.newLatLngZoom(initialCamera(), draftZoom))
            val moveStarted = MapLibreMap.OnCameraMoveStartedListener { reason ->
                if (reason == MapLibreMap.OnCameraMoveStartedListener.REASON_API_GESTURE) {
                    lastGestureMove = true
                }
            }
            moveStartedListener = moveStarted
            mapLibreMap.addOnCameraMoveStartedListener(moveStarted)
            val idle = MapLibreMap.OnCameraIdleListener {
                val camera = mapLibreMap.cameraPosition
                val target = camera.target ?: return@OnCameraIdleListener
                draftZoom = camera.zoom
                if (isPicker && lastGestureMove) {
                    lastGestureMove = false
                    draftLat = target.latitude
                    draftLng = target.longitude
                    confirmButton.isEnabled = true
                    updateReadout()
                } else if (!isPicker) {
                    updateReadout()
                }
            }
            idleListener = idle
            mapLibreMap.addOnCameraIdleListener(idle)
            val styleUrl = MapValidation.validateStyleUrl(BuildConfig.MAP_STYLE_URL)
            mapLibreMap.setStyle(styleUrl) { onStyleLoaded() }
        }
        mapView.addOnDidFinishLoadingMapListener { hideLoading() }
        mapView.addOnDidFailLoadingMapListener { onStyleFailed() }

        findViewById<ImageButton>(R.id.map_back).setOnClickListener { cancelAndClose() }
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = cancelAndClose()
        })
        confirmButton.setOnClickListener { confirmAndClose() }
        searchButton.setOnClickListener { submitSearch() }
        searchInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                submitSearch()
                true
            } else false
        }
        resultsList.setOnItemClickListener { _, _, position, _ ->
            searchResults.getOrNull(position)?.let { pickSearchResult(it) }
        }
        retryButton.setOnClickListener { retryStyle() }
        myLocationButton.setOnClickListener { useMyLocationOnce() }
    }

    override fun onStart() {
        super.onStart()
        mapView.onStart()
    }

    override fun onResume() {
        super.onResume()
        mapView.onResume()
    }

    override fun onPause() {
        super.onPause()
        mapView.onPause()
    }

    override fun onStop() {
        super.onStop()
        mapView.onStop()
    }

    override fun onLowMemory() {
        super.onLowMemory()
        mapView.onLowMemory()
    }

    override fun onDestroy() {
        destroyed = true
        searchGeneration += 1
        locationTimeout.removeCallbacksAndMessages(null)
        locationCancel?.cancel()
        idleListener?.let { map?.removeOnCameraIdleListener(it) }
        idleListener = null
        moveStartedListener?.let { map?.removeOnCameraMoveStartedListener(it) }
        moveStartedListener = null
        mapView.onDestroy()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        mapView.onSaveInstanceState(outState)
        draftLat?.let { outState.putDouble(STATE_DRAFT_LAT, it) }
        draftLng?.let { outState.putDouble(STATE_DRAFT_LNG, it) }
        outState.putDouble(STATE_ZOOM, draftZoom)
    }

    // endregion

    // region picker state

    private fun bindViews() {
        mapView = findViewById(R.id.map_view)
        titleView = findViewById(R.id.map_title)
        confirmButton = findViewById(R.id.map_confirm)
        searchRow = findViewById(R.id.map_search_row)
        searchInput = findViewById(R.id.map_search_input)
        searchButton = findViewById(R.id.map_search_button)
        resultsList = findViewById(R.id.map_results)
        loading = findViewById(R.id.map_loading)
        readout = findViewById(R.id.map_readout)
        statusRow = findViewById(R.id.map_status_row)
        statusText = findViewById(R.id.map_status)
        retryButton = findViewById(R.id.map_retry)
        footer = findViewById(R.id.map_footer)
        myLocationButton = findViewById(R.id.map_my_location)
    }

    private fun restoreDraft(saved: Bundle?) {
        if (saved != null) {
            val lat = saved.getDouble(STATE_DRAFT_LAT, Double.NaN)
            val lng = saved.getDouble(STATE_DRAFT_LNG, Double.NaN)
            if (MapValidation.isValidCenter(lat.takeIf { it.isFinite() }, lng.takeIf { it.isFinite() })) {
                draftLat = lat
                draftLng = lng
            }
            draftZoom = MapValidation.clampZoom(saved.getDouble(STATE_ZOOM, MapValidation.DEFAULT_ZOOM))
            return
        }
        val lat = intent.getDoubleExtra(EXTRA_LATITUDE, Double.NaN).takeIf { it.isFinite() }
        val lng = intent.getDoubleExtra(EXTRA_LONGITUDE, Double.NaN).takeIf { it.isFinite() }
        // Invalid initial coordinates seed a neutral display-only camera —
        // never a fabricated draft.
        if (MapValidation.isValidCenter(lat, lng)) {
            draftLat = lat
            draftLng = lng
            draftZoom = MapValidation.clampZoom(
                intent.getDoubleExtra(EXTRA_ZOOM, MapValidation.DEFAULT_ZOOM).takeIf { it.isFinite() },
            )
        } else {
            // Neutral display-only camera (central Bangladesh). The draft
            // stays null — Confirm enables only after a user gesture — and
            // the seed zoom is ignored so a world-zoom seed cannot override
            // the neutral framing.
            draftZoom = NEUTRAL_ZOOM
        }
    }

    private fun initialTitle(): String {
        if (!isPicker) {
            val label = intent.getStringExtra(EXTRA_LABEL)?.trim().orEmpty()
            return label.ifEmpty { getString(R.string.findback_map_view) }
        }
        return getString(R.string.findback_map_choose_location)
    }

    private fun initialCamera(): LatLng {
        val lat = draftLat
        val lng = draftLng
        return if (lat != null && lng != null) LatLng(lat, lng) else NEUTRAL_CENTER
    }

    private fun updateReadout() {
        val lat = draftLat
        val lng = draftLng
        readout.text = if (lat != null && lng != null) {
            String.format(java.util.Locale.US, "%.5f, %.5f", lat, lng)
        } else {
            getString(R.string.findback_map_no_pin)
        }
    }

    private fun confirmAndClose() {
        val lat = draftLat
        val lng = draftLng
        if (lat == null || lng == null || !MapValidation.isValidCenter(lat, lng)) return
        val data = Intent()
            .putExtra(EXTRA_LATITUDE, lat)
            .putExtra(EXTRA_LONGITUDE, lng)
            .putExtra(EXTRA_ZOOM, draftZoom)
        setResult(Activity.RESULT_OK, data)
        finish()
    }

    private fun cancelAndClose() {
        setResult(Activity.RESULT_CANCELED)
        finish()
    }

    // endregion

    // region style loading

    private fun onStyleLoaded() {
        styleLoaded = true
        styleFailed = false
        hideLoading()
        hideStatus()
    }

    private fun onStyleFailed() {
        if (styleLoaded) return
        styleFailed = true
        hideLoading()
        // Truthful failure: retry offered, Cancel works, and Confirm stays
        // available when a valid draft exists — never a fake loaded map.
        showStatus(getString(R.string.findback_map_style_failed), showRetry = true)
    }

    private fun hideLoading() {
        loading.visibility = View.GONE
    }

    private fun retryStyle() {
        hideStatus()
        styleFailed = false
        loading.visibility = View.VISIBLE
        val styleUrl = MapValidation.validateStyleUrl(BuildConfig.MAP_STYLE_URL)
        map?.setStyle(styleUrl) { onStyleLoaded() }
    }

    private fun showStatus(message: String, showRetry: Boolean) {
        statusRow.visibility = View.VISIBLE
        statusText.text = message
        retryButton.visibility = if (showRetry) View.VISIBLE else View.GONE
    }

    private fun hideStatus() {
        statusRow.visibility = View.GONE
        retryButton.visibility = View.GONE
    }

    // endregion

    // region explicit-submit search

    private fun submitSearch() {
        if (!isPicker || searching) return
        hideKeyboard()
        val query = searchInput.text?.toString()?.trim().orEmpty()
        if (query.isEmpty()) {
            showStatus(getString(R.string.findback_map_empty_query), showRetry = false)
            return
        }
        val waitMs = searchGate.retryAfterMs(System.currentTimeMillis())
        if (waitMs > 0) {
            showStatus(getString(R.string.findback_map_rate_limited), showRetry = false)
            return
        }
        searching = true
        searchButton.isEnabled = false
        showStatus(getString(R.string.findback_map_searching), showRetry = false)
        val userAgent = userAgent()
        // Canonical search endpoint seam: BuildConfig value validated with the
        // MapValidation default as the fallback (no secret). validateSearchEndpoint
        // never throws (it returns the fallback) — no try/catch by design.
        val endpoint = MapValidation.validateSearchEndpoint(BuildConfig.MAP_SEARCH_URL)
        searchGeneration += 1
        val requestGeneration = searchGeneration
        Thread {
            val outcome: Result<List<NominatimResult>> = try {
                Result.success(
                    NominatimClient.fetchResults(
                        endpoint,
                        query,
                        userAgent,
                    ),
                )
            } catch (e: NominatimException) {
                Result.failure(e)
            } catch (e: Exception) {
                Result.failure(NominatimException(NominatimException.Kind.NETWORK, "Place search could not connect."))
            }
            runOnUiThread { onSearchFinished(query, outcome, requestGeneration) }
        }.start()
    }

    private fun onSearchFinished(query: String, outcome: Result<List<NominatimResult>>, requestGeneration: Int = searchGeneration) {
        // A destroyed/finishing Activity or a stale generation must die
        // silently — never touch UI after the lifecycle ended.
        if (!MapValidation.isSearchDeliveryAlive(requestGeneration, searchGeneration, destroyed, isFinishing || isDestroyed)) return
        searching = false
        searchButton.isEnabled = true
        // A stale response (newer search started) never overwrites the list:
        // the input must still match the submitted query.
        if (searchInput.text?.toString()?.trim() != query) return
        outcome.fold(
            onSuccess = { places ->
                searchResults = places
                if (places.isEmpty()) {
                    resultsList.visibility = View.GONE
                    showStatus(getString(R.string.findback_map_no_results), showRetry = false)
                } else {
                    hideStatus()
                    resultsList.visibility = View.VISIBLE
                    resultsList.adapter = ArrayAdapter(
                        this,
                        android.R.layout.simple_list_item_2,
                        android.R.id.text1,
                        places.map { result ->
                            "${result.displayName}\n" +
                                String.format(java.util.Locale.US, "%.5f, %.5f", result.latitude, result.longitude)
                        },
                    )
                }
            },
            onFailure = { error ->
                resultsList.visibility = View.GONE
                val message = when ((error as? NominatimException)?.kind) {
                    NominatimException.Kind.RATE_LIMITED ->
                        getString(R.string.findback_map_rate_limited)
                    NominatimException.Kind.NETWORK ->
                        getString(R.string.findback_map_search_offline)
                    else -> getString(R.string.findback_map_search_failed)
                }
                showStatus(message, showRetry = false)
            },
        )
    }

    private fun pickSearchResult(result: NominatimResult) {
        val center = LatLng(result.latitude, result.longitude)
        draftLat = result.latitude
        draftLng = result.longitude
        confirmButton.isEnabled = true
        updateReadout()
        resultsList.visibility = View.GONE
        map?.animateCamera(
            CameraUpdateFactory.newCameraPosition(
                CameraPosition.Builder().target(center).zoom(draftZoom).build(),
            ),
            SEARCH_CAMERA_ANIMATION_MS,
        )
    }

    private fun hideKeyboard() {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager ?: return
        imm.hideSoftInputFromWindow(searchInput.windowToken, 0)
    }

    private fun userAgent(): String {
        val version = try {
            BuildConfig.VERSION_NAME
        } catch (e: Exception) {
            "unknown"
        }
        val contact = try {
            BuildConfig.MAP_SEARCH_CONTACT
        } catch (e: Exception) {
            "unknown"
        }
        return NominatimClient.userAgent(version, contact)
    }

    // endregion

    // region one-shot location

    private fun useMyLocationOnce() {
        if (!isPicker || locating) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION),
                LOCATION_PERMISSION_CODE,
            )
            return
        }
        fetchCurrentLocation()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != LOCATION_PERMISSION_CODE) return
        if (grantResults.any { it == PackageManager.PERMISSION_GRANTED }) {
            fetchCurrentLocation()
        } else {
            // Denied: the map stays fully usable — no dead end, no re-prompt loop.
            showStatus(getString(R.string.findback_map_location_denied), showRetry = false)
        }
    }

    private fun fetchCurrentLocation() {
        locating = true
        myLocationButton.isEnabled = false
        showStatus(getString(R.string.findback_map_locating), showRetry = false)
        val source = CancellationTokenSource()
        locationCancel = source
        locationTimeout.postDelayed({
            if (locating) {
                source.cancel()
                onLocationFailed(getString(R.string.findback_map_location_timeout))
            }
        }, LOCATION_TIMEOUT_MS)
        try {
            LocationServices.getFusedLocationProviderClient(this)
                .getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, source.token)
                .addOnSuccessListener { location ->
                    if (!locating) return@addOnSuccessListener
                    if (location == null) {
                        onLocationFailed(getString(R.string.findback_map_location_unavailable))
                        return@addOnSuccessListener
                    }
                    locating = false
                    locationTimeout.removeCallbacksAndMessages(null)
                    myLocationButton.isEnabled = true
                    draftLat = location.latitude
                    draftLng = location.longitude
                    confirmButton.isEnabled = true
                    updateReadout()
                    map?.animateCamera(
                        CameraUpdateFactory.newLatLngZoom(LatLng(location.latitude, location.longitude), draftZoom),
                    )
                    showStatus(getString(R.string.findback_map_location_ready), showRetry = false)
                }
                .addOnFailureListener {
                    if (locating) onLocationFailed(getString(R.string.findback_map_location_unavailable))
                }
        } catch (e: SecurityException) {
            onLocationFailed(getString(R.string.findback_map_location_denied))
        } catch (e: Exception) {
            onLocationFailed(getString(R.string.findback_map_location_unavailable))
        }
    }

    private fun onLocationFailed(message: String) {
        locating = false
        locationTimeout.removeCallbacksAndMessages(null)
        myLocationButton.isEnabled = true
        showStatus(message, showRetry = false)
    }

    // endregion
}
