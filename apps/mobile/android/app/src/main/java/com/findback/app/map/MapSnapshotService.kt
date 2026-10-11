package com.findback.app.map

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.os.Handler
import android.os.Looper
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.snapshotter.MapSnapshotter

/**
 * Post-detail map previews via MapLibre [MapSnapshotter] — never a live
 * MapView embedded in the WebView (no compositing contract, no leaked views).
 *
 * Flow: validate → clamp → bounded cache lookup (`cacheDir` only, LRU-by-mtime
 * eviction) → snapshot with the same style URL as the picker → FindBack pin
 * drawn over the bitmap center → PNG in app cache → file URI for
 * `Capacitor.convertFileSrc()`. Stale requests cancel cleanly; failures carry
 * kinds the bridge maps to consumer copy (no stack traces, no paths).
 */
object MapSnapshotService {

    const val SNAPSHOT_TIMEOUT_MS = 20_000L
    const val CACHE_SUBDIR = "findback-map-snapshots"
    const val MIN_PIXEL_RATIO = 1.0f
    const val MAX_PIXEL_RATIO = 2.0f

    data class SnapshotResult(
        val file: File,
        val widthPx: Int,
        val heightPx: Int,
        val cacheKey: String,
    )

    class SnapshotFailedException(message: String) : Exception(message)

    fun interface SnapshotHandle {
        fun cancel()
    }

    fun cacheDir(context: Context): File =
        File(context.cacheDir, CACHE_SUBDIR).also { if (!it.isDirectory) it.mkdirs() }

    /** Filesystem location for a cache key (hex — always safe). */
    fun snapshotFile(dir: File, cacheKey: String): File = File(dir, "$cacheKey.png")

    /**
     * Delete oldest entries (by mtime) until the directory is under [maxBytes].
     * Pure file logic — JVM-tested. Never touches anything outside [dir].
     */
    fun evictOldest(dir: File, maxBytes: Long) {
        val files = dir.listFiles()?.filter { it.isFile } ?: return
        var total = files.sumOf { it.length() }
        if (total <= maxBytes) return
        for (file in files.sortedBy { it.lastModified() }) {
            if (total <= maxBytes) break
            val size = file.length()
            if (file.delete()) total -= size
        }
    }

    fun clampPixelRatio(ratio: Float?): Float {
        if (ratio == null || !ratio.isFinite()) return MIN_PIXEL_RATIO
        return ratio.coerceIn(MIN_PIXEL_RATIO, MAX_PIXEL_RATIO)
    }

    /**
     * Render a preview. The snapshotter must be driven from the main thread;
     * bitmap work + IO run on a worker thread. Exactly one callback fires.
     */
    fun render(
        context: Context,
        latitude: Double,
        longitude: Double,
        zoom: Double?,
        widthPx: Int,
        heightPx: Int,
        pixelRatio: Float?,
        theme: String?,
        styleUrl: String,
        callback: (Result<SnapshotResult>) -> Unit,
    ): SnapshotHandle {
        if (!MapValidation.isValidCenter(latitude, longitude)) {
            throw IllegalArgumentException("Snapshot needs valid coordinates.")
        }
        val width = MapValidation.clampSnapshotEdge(widthPx)
        val height = MapValidation.clampSnapshotEdge(heightPx)
        val ratio = clampPixelRatio(pixelRatio)
        val normalizedTheme = when (theme?.trim()?.lowercase()) {
            "dark", "amoled" -> theme.trim().lowercase()
            else -> "light"
        }
        val effectiveStyle = MapValidation.validateStyleUrl(styleUrl)
        val key = MapValidation.snapshotCacheKey(latitude, longitude, zoom ?: MapValidation.DEFAULT_ZOOM, width, height, normalizedTheme, effectiveStyle)
        val appContext = context.applicationContext
        val dir = cacheDir(appContext)
        val file = snapshotFile(dir, key)

        val settled = AtomicBoolean(false)
        fun settle(result: Result<SnapshotResult>) {
            if (settled.compareAndSet(false, true)) callback(result)
        }

        val cached = if (file.isFile && file.length() > 0) {
            file.setLastModified(System.currentTimeMillis())
            SnapshotResult(file, width, height, key)
        } else null
        if (cached != null) {
            settle(Result.success(cached))
            return SnapshotHandle { }
        }

        val main = Handler(Looper.getMainLooper())
        var snapshotter: MapSnapshotter? = null
        val timeout = Runnable {
            snapshotter?.cancel()
            settle(Result.failure(SnapshotFailedException("The map preview timed out.")))
        }

        fun start() {
            // The stall budget starts WITH the snapshotter, never before it:
            // both post to the same main queue in order, so a congested main
            // thread cannot burn the timeout before start() runs.
            main.postDelayed(timeout, SNAPSHOT_TIMEOUT_MS)
            val options = MapSnapshotter.Options(width, height)
                .withStyle(effectiveStyle)
                .withCameraPosition(
                    CameraPosition.Builder()
                        .target(LatLng(latitude, longitude))
                        .zoom(MapValidation.clampZoom(zoom))
                        .build(),
                )
                .withPixelRatio(ratio)
            val current = MapSnapshotter(appContext, options)
            snapshotter = current
            current.start(
                { snapshot ->
                    Thread {
                        try {
                            val bitmap = snapshot.bitmap
                            drawPin(bitmap)
                            FileOutputStream(file).use { out ->
                                if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                                    throw SnapshotFailedException("The map preview could not be saved.")
                                }
                            }
                            evictOldest(dir, MapValidation.MAX_SNAPSHOT_CACHE_BYTES)
                            val done = SnapshotResult(file, width, height, key)
                            main.post {
                                main.removeCallbacks(timeout)
                                settle(Result.success(done))
                            }
                        } catch (e: Exception) {
                            file.delete()
                            main.post {
                                main.removeCallbacks(timeout)
                                settle(Result.failure(SnapshotFailedException("The map preview failed.")))
                            }
                        }
                    }.start()
                },
                {
                    main.post {
                        main.removeCallbacks(timeout)
                        settle(Result.failure(SnapshotFailedException("The map preview failed.")))
                    }
                },
            )
        }

        if (Looper.myLooper() == Looper.getMainLooper()) {
            start()
        } else {
            main.post { start() }
        }

        return SnapshotHandle {
            main.post {
                main.removeCallbacks(timeout)
                try {
                    snapshotter?.cancel()
                } catch (ignored: Exception) {
                }
                settle(Result.failure(SnapshotFailedException("The map preview was cancelled.")))
            }
        }
    }

    /**
     * FindBack pin over the bitmap center: white disc, dark ring, dark hub.
     * Drawn in bitmap space (no drawable/resources needed off-Activity).
     */
    fun drawPin(bitmap: Bitmap) {
        val canvas = Canvas(bitmap)
        val cx = bitmap.width / 2f
        val cy = bitmap.height / 2f
        val radius = (minOf(bitmap.width, bitmap.height) / 28f).coerceAtLeast(14f)
        val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt() }
        val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = 0xFF1F2937.toInt()
            style = Paint.Style.STROKE
            strokeWidth = (radius / 8f).coerceAtLeast(3f)
        }
        val hub = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF1F2937.toInt() }
        canvas.drawCircle(cx, cy, radius, fill)
        canvas.drawCircle(cx, cy, radius, ring)
        canvas.drawCircle(cx, cy, radius / 3f, hub)
    }
}
