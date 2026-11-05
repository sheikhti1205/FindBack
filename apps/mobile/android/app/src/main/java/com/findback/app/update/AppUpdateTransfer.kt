package com.findback.app.update

import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest

object AppUpdateTransfer {
    /** No resume/append: a retry must prove the entire immutable artifact again. */
    fun copy(spec: UpdateSpec, input: InputStream, file: File, available: ()->Long,
             cancelled: ()->Boolean, progress: (Long)->Unit): String {
        if (spec.bytes !in 1..AppUpdatePolicy.MAX_BYTES || available() < spec.bytes+AppUpdatePolicy.HEADROOM) throw UpdateRejected("storage")
        val digest=MessageDigest.getInstance("SHA-256")
        var received=0L
        try {
            FileOutputStream(file,false).use { output ->
                val buffer=ByteArray(64*1024)
                while (true) {
                    if (cancelled()) throw UpdateRejected("cancelled")
                    val read=input.read(buffer)
                    if(read == -1) break
                    if(read == 0) continue
                    if(received+read > spec.bytes) throw UpdateRejected("integrity")
                    if(available() < read+AppUpdatePolicy.HEADROOM) throw UpdateRejected("storage")
                    output.write(buffer,0,read);digest.update(buffer,0,read);received+=read;progress(received)
                }
                output.fd.sync()
            }
            if(cancelled()) throw UpdateRejected("cancelled")
            val hash=digest.digest().joinToString(""){"%02x".format(it)}
            if(received != spec.bytes || hash != spec.sha256) throw UpdateRejected("integrity")
            return hash
        } catch (error: Exception) {file.delete();throw error}
    }
}
