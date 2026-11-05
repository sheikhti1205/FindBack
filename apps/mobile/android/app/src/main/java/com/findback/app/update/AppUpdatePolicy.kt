package com.findback.app.update

import java.io.File
import java.net.URI

/** Public artifact facts only. Never accepts a caller-supplied local path. */
data class UpdateSpec(val releaseId: String, val url: String, val bytes: Long, val sha256: String,
    val packageName: String, val channel: String, val signerSha256: String, val abis: Set<String>,
    val minSdk: Int, val targetSdk: Int, val versionCode: Long, val versionName: String)
data class InstalledApp(val packageName: String, val versionCode: Long, val channel: String,
    val abi: String, val sdk: Int, val signers: Set<String>)
data class VerifiedApk(val packageName: String, val versionCode: Long, val versionName: String,
    val minSdk: Int, val targetSdk: Int, val abis: Set<String>, val signers: Set<String>,
    val lineage: List<String>, val signatureVerified: Boolean)
class UpdateRejected(val code: String) : Exception(code)

object AppUpdatePolicy {
    const val MAX_BYTES = 512L * 1024 * 1024
    const val HEADROOM = 32L * 1024 * 1024
    const val EXPIRES_MS = 7L * 24 * 60 * 60 * 1000
    private val id = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
    private val uuid = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
    private val digest = Regex("[a-f0-9]{64}")
    private val supportedAbis = setOf("arm64-v8a", "armeabi-v7a", "x86_64")
    fun releaseId(value: String): Boolean = id.matches(value) && !value.contains("..")
    fun installDecision(kind: String, foreground: Boolean, permission: Boolean): String {
        if (!foreground) throw UpdateRejected("unavailable")
        if (kind !in setOf("ready","needs-permission","needs-confirmation")) throw UpdateRejected("state")
        return if(permission) "install" else "needs-permission"
    }
    fun downloadUrl(value: String, redirect: Boolean): URI {
        val uri = try { URI(value) } catch (_: Exception) { throw UpdateRejected("origin") }
        val path = uri.rawPath ?: ""
        if (uri.scheme != "https" || uri.userInfo != null || uri.port !in setOf(-1,443) || uri.fragment != null ||
            path.contains("..") || path.contains('%') || path.contains('\\')) throw UpdateRejected("origin")
        val allowed = when (uri.host) {
            "github.com" -> path.startsWith("/sheikhti1205/Norfold/releases/download/") && path.endsWith(".apk")
            "release-assets.githubusercontent.com" -> redirect && path.startsWith("/github-production-release-asset/")
            "objects.githubusercontent.com" -> redirect && path.startsWith("/github-production-release-asset-")
            else -> false
        }
        if (!allowed || value.length > 8192) throw UpdateRejected("origin")
        return uri
    }
    fun validate(spec: UpdateSpec, installed: InstalledApp) {
        downloadUrl(spec.url,false)
        if (!releaseId(spec.releaseId) || spec.bytes !in 1..MAX_BYTES || !digest.matches(spec.sha256) ||
            !digest.matches(spec.signerSha256) || spec.versionName.isBlank() || spec.versionName.length > 80)
            throw UpdateRejected("metadata")
        if (spec.packageName != installed.packageName || spec.packageName != "com.findback.app" ||
            spec.channel != installed.channel || installed.signers.isEmpty() || !installed.signers.all { digest.matches(it) })
            throw UpdateRejected("identity")
        if (spec.versionCode <= installed.versionCode || spec.versionCode > 2_100_000_000) throw UpdateRejected("version")
        if (spec.abis.isEmpty() || !supportedAbis.containsAll(spec.abis) || installed.abi !in spec.abis ||
            spec.minSdk < 24 || spec.minSdk > installed.sdk || spec.targetSdk < spec.minSdk || spec.targetSdk > 100)
            throw UpdateRejected("compatibility")
    }
    fun verify(spec: UpdateSpec, installed: InstalledApp, apk: VerifiedApk, bytes: Long, sha256: String) {
        validate(spec,installed)
        if (bytes != spec.bytes || sha256 != spec.sha256) throw UpdateRejected("integrity")
        if (!apk.signatureVerified || apk.signers.isEmpty() || spec.signerSha256 !in apk.signers) throw UpdateRejected("signature")
        if (apk.packageName != spec.packageName || apk.versionCode != spec.versionCode || apk.versionName != spec.versionName ||
            apk.minSdk != spec.minSdk || apk.targetSdk != spec.targetSdk || apk.abis != spec.abis) throw UpdateRejected("identity")
        val authority = if (installed.signers.size > 1 || apk.signers.size > 1) apk.signers == installed.signers
            else apk.signers == installed.signers ||
                (installed.sdk >= 28 && apk.lineage.lastOrNull() == apk.signers.single() &&
                    apk.lineage.distinct().size == apk.lineage.size && installed.signers.single() in apk.lineage.dropLast(1))
        if (!authority) throw UpdateRejected("signature")
    }
    /** Check canonical ownership on every access; do not follow symbolic links. */
    fun jobDirectory(root: File, jobId: String): File {
        if (!uuid.matches(jobId) || root.absoluteFile != root.canonicalFile) throw UpdateRejected("storage")
        val dir = File(root,jobId).absoluteFile
        if (dir.canonicalFile != dir || dir.parentFile != root.absoluteFile) throw UpdateRejected("storage")
        return dir
    }
    fun ownedFile(root: File, jobId: String, name: String): File {
        if (name !in setOf("update.apk","receipt.properties","receipt.next")) throw UpdateRejected("storage")
        val dir=jobDirectory(root,jobId); val file=File(dir,name)
        if (file.canonicalFile != file.absoluteFile) throw UpdateRejected("storage")
        return file
    }
}
