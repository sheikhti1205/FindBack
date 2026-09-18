package com.findback.app.vlm

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

/**
 * Prepares images for VLM inference by handling URI resolution, EXIF orientation,
 * and temporary file management.
 */
object ImagePreparer {

    /**
     * Result of image preparation.
     * @param absolutePath The absolute filesystem path to the prepared image.
     * @param temporary True if this is a temporary file that should be cleaned up after use.
     */
    data class PreparedImage(
        val absolutePath: String,
        val temporary: Boolean
    )

    /**
     * Converts a URI or bare path to an absolute filesystem path.
     * - For `file://` URIs: strips exactly one `file://` prefix.
     * - For bare paths: returns unchanged.
     * - For `content://` URIs: not handled here; caller must copy to temp file first.
     * Never prepends `file://`.
     */
    fun absolutePathFor(uri: String): String {
        if (uri.startsWith("file://")) {
            return uri.substring("file://".length)
        }
        return uri
    }

    /**
     * Prepares an image from a URI for VLM inference.
     * Handles `file://`, `content://`, and bare paths.
     *
     * Every input is normalized through the bounds-first decode (longest
     * side capped at [MAX_PREPARE_DIMENSION]) into a fresh temp file with
     * EXIF orientation applied — including normal-orientation photos, so a
     * 50 MP camera image never reaches the model at full size (audit #28).
     * The result is always temporary: callers must [cleanup] after use.
     *
     * @throws IllegalArgumentException when the image cannot be opened or decoded.
     */
    fun prepare(context: Context, uri: String): PreparedImage {
        var stagedTemp: File? = null
        try {
            val sourcePath = when {
                uri.startsWith("file://") -> absolutePathFor(uri)
                uri.startsWith("content://") -> {
                    copyContentUriToTemp(context, uri).also { stagedTemp = it }.absolutePath
                }
                else -> uri
            }
            val exifOrientation = readExifOrientation(sourcePath)
            val normalizedPath = normalizeToTemp(context, sourcePath, exifOrientation)
            return PreparedImage(normalizedPath, temporary = true)
        } finally {
            // The staged content:// copy is an intermediate: the normalized
            // output is a separate temp file, so always drop the intermediate.
            // normalizeToTemp throws before returning a path on decode
            // failure, leaving no output to clean — only the staged copy.
            stagedTemp?.let { cleanupTemporary(it) }
        }
    }

    /**
     * Cleans up a temporary file created during image preparation.
     * Only deletes if the file exists.
     */
    fun cleanup(prepared: PreparedImage) {
        if (prepared.temporary) {
            cleanupTemporary(File(prepared.absolutePath))
        }
    }

    /**
     * Deletes a temporary file. Only deletes the exact file passed.
     * Safe to call on non-existent files.
     */
    fun cleanupTemporary(file: File) {
        if (file.exists()) {
            file.delete()
        }
    }

    private fun readExifOrientation(path: String): Int {
        return try {
            val exif = ExifInterface(path)
            exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } catch (e: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
    }

    private fun copyContentUriToTemp(context: Context, uriString: String): File {
        val contentResolver: ContentResolver = context.contentResolver
        val uri = Uri.parse(uriString)
        val tempFile = File.createTempFile("vlm-input", ".jpg", context.cacheDir)
        val stream: InputStream? = try {
            contentResolver.openInputStream(uri)
        } catch (e: Exception) {
            null
        }
        if (stream == null) {
            // Never leave an empty staged file behind, and never let a null
            // stream surface later as a misleading decode error.
            tempFile.delete()
            throw IllegalArgumentException("Cannot open image URI: $uriString")
        }
        stream.use { input ->
            tempFile.outputStream().use { output ->
                input.copyTo(output)
            }
        }
        return tempFile
    }

    /**
     * Minimal power-of-two downsample so the longest side decodes within
     * [maxDimension]. Pure math, unit-tested.
     */
    internal fun sampleSizeFor(maxSide: Int, maxDimension: Int): Int {
        var sampleSize = 1
        while (maxSide / sampleSize > maxDimension) sampleSize *= 2
        return sampleSize
    }

    private fun normalizeToTemp(context: Context, sourcePath: String, exifOrientation: Int): String {
        // Bounds first so a 50 MP camera photo never inflates to full size.
        // Downsample to cap the longer side before applying EXIF.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(sourcePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw IllegalArgumentException("Failed to decode image file: $sourcePath")
        }
        val sampleSize = sampleSizeFor(maxOf(bounds.outWidth, bounds.outHeight), MAX_PREPARE_DIMENSION)
        val decodeOptions = BitmapFactory.Options().apply { inSampleSize = sampleSize }
        val bitmap = BitmapFactory.decodeFile(sourcePath, decodeOptions)
            ?: throw IllegalArgumentException("Failed to decode image file: $sourcePath")
        val matrix = ImageOrientation.matrixFor(exifOrientation)
        val transformed = if (matrix.isIdentity) {
            bitmap
        } else {
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        }
        val tempFile = File.createTempFile("vlm-input", ".jpg", context.cacheDir)
        FileOutputStream(tempFile).use { output ->
            transformed.compress(Bitmap.CompressFormat.JPEG, 92, output)
        }
        if (transformed !== bitmap) {
            transformed.recycle()
        }
        bitmap.recycle()
        return tempFile.absolutePath
    }

    /** Longest side of a prepared image; bounds memory before decode. */
    const val MAX_PREPARE_DIMENSION = 1024
}

/**
 * EXIF orientation handling.
 * EXIF orientation values:
 * 1 = Normal, 2 = flip horizontal, 3 = rotate 180, 4 = flip vertical,
 * 5 = transpose, 6 = rotate 90 CW, 7 = transverse, 8 = rotate 270 CW.
 */
object ImageOrientation {
    fun degreesFor(exifOrientation: Int): Int {
        return when (exifOrientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90   // 6
            ExifInterface.ORIENTATION_ROTATE_180 -> 180 // 3
            ExifInterface.ORIENTATION_ROTATE_270 -> 270 // 8
            else -> 0
        }
    }

    /** Full orientation correction (rotations and mirrors/transposes). */
    fun matrixFor(exifOrientation: Int): Matrix {
        val matrix = Matrix()
        when (exifOrientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.postRotate(90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.postRotate(270f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            else -> { /* identity */ }
        }
        return matrix
    }
}