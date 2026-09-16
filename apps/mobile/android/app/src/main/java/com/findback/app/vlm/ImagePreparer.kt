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
     * Handles `file://` and `content://` URIs.
     * For `content://` URIs, copies to a temporary file in cache dir and applies EXIF orientation.
     * For `file://` URIs, applies EXIF orientation in place if needed (returns temporary copy if rotated).
     */
    fun prepare(context: Context, uri: String): PreparedImage {
        return when {
            uri.startsWith("file://") -> {
                val path = absolutePathFor(uri)
                val exifOrientation = readExifOrientation(path)
                if (exifOrientation == 1 || exifOrientation == 0) {
                    // No rotation needed
                    PreparedImage(path, temporary = false)
                } else {
                    // Rotate and save to temp file
                    val rotatedPath = rotateAndSaveToTemp(context, path, exifOrientation)
                    PreparedImage(rotatedPath, temporary = true)
                }
            }
            uri.startsWith("content://") -> {
                val tempFile = copyContentUriToTemp(context, uri)
                val exifOrientation = readExifOrientation(tempFile.absolutePath)
                if (exifOrientation == 1 || exifOrientation == 0) {
                    PreparedImage(tempFile.absolutePath, temporary = true)
                } else {
                    val rotatedPath = rotateAndSaveToTemp(context, tempFile.absolutePath, exifOrientation)
                    // Delete the original temp file since we created a rotated one
                    tempFile.delete()
                    PreparedImage(rotatedPath, temporary = true)
                }
            }
            else -> {
                // Bare path - treat as file path
                val exifOrientation = readExifOrientation(uri)
                if (exifOrientation == 1 || exifOrientation == 0) {
                    PreparedImage(uri, temporary = false)
                } else {
                    val rotatedPath = rotateAndSaveToTemp(context, uri, exifOrientation)
                    PreparedImage(rotatedPath, temporary = true)
                }
            }
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
        contentResolver.openInputStream(uri)?.use { input ->
            tempFile.outputStream().use { output ->
                input.copyTo(output)
            }
        }
        return tempFile
    }

    private fun rotateAndSaveToTemp(context: Context, sourcePath: String, exifOrientation: Int): String {
        val degrees = ImageOrientation.degreesFor(exifOrientation)
        val bitmap = BitmapFactory.decodeFile(sourcePath)
        if (bitmap == null) {
            throw IllegalArgumentException("Failed to decode image file: $sourcePath")
        }
        val rotatedBitmap = if (degrees != 0) {
            val matrix = Matrix()
            matrix.postRotate(degrees.toFloat())
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        } else {
            bitmap
        }
        val tempFile = File.createTempFile("vlm-input", ".jpg", context.cacheDir)
        FileOutputStream(tempFile).use { output ->
            rotatedBitmap.compress(Bitmap.CompressFormat.JPEG, 95, output)
        }
        if (rotatedBitmap != bitmap) {
            rotatedBitmap.recycle()
        }
        bitmap.recycle()
        return tempFile.absolutePath
    }
}

/**
 * EXIF orientation to degrees mapping.
 * EXIF orientation values:
 * 1 = Normal (0°)
 * 3 = Rotate 180°
 * 6 = Rotate 90° CW
 * 8 = Rotate 270° CW (or 90° CCW)
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
}