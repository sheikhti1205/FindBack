package com.findback.app.download

import java.io.File
import java.io.IOException

/** Missing files are already removed; all other failures must reach the caller. */
internal fun deleteModelFile(file: File) {
    if (!file.exists()) return
    if (file.isDirectory) file.deleteRecursively() else file.delete()
    if (file.exists()) throw IOException("delete_failed")
}
