package com.findback.app.update

import java.io.File
import java.io.FileOutputStream
import java.util.Properties
import java.util.UUID

data class UpdateJob(val id: String, val spec: UpdateSpec, val createdAt: Long, val kind: String,
    val received: Long = 0, val sessionId: Int = -1, val nonce: String = "", val code: String = "", val revision: Long = 0)

/** One durable receipt, no sweeping of arbitrary app files. All writes are atomic. */
class AppUpdateJobs(private val root: File) {
    private var job: UpdateJob? = null
    private var revision = 0L
    private var unreadable = false
    init {
        if (root.canonicalFile != root.absoluteFile) throw UpdateRejected("storage")
        root.mkdirs()
        val receipts = root.listFiles()?.filter { runCatching { AppUpdatePolicy.jobDirectory(root,it.name) == it && it.isDirectory }.getOrDefault(false) }
            ?.mapNotNull { directory -> runCatching { read(directory.name) }.onFailure {unreadable=true}.getOrNull() } ?: emptyList()
        // A directory is never trusted merely because it exists. Corrupt receipts
        // remain untouched rather than granting a guessed session/path authority.
        job = receipts.maxByOrNull { it.revision }
        revision = job?.revision ?: 0
    }
    @Synchronized fun current(): UpdateJob? = job
    @Synchronized fun begin(spec: UpdateSpec, now: Long): UpdateJob {
        if (unreadable) throw UpdateRejected("storage")
        if (job?.kind in active) throw UpdateRejected("busy")
        val next=UpdateJob(UUID.randomUUID().toString(),spec,now,"downloading")
        AppUpdatePolicy.jobDirectory(root,next.id).mkdirs()
        return save(next)
    }
    @Synchronized fun transition(id: String, kind: String, received: Long = 0): UpdateJob {
        val old = requireJob(id)
        if (kind !in (transitions[old.kind] ?: emptySet())) throw UpdateRejected("state")
        if (received < 0 || received > old.spec.bytes) throw UpdateRejected("integrity")
        return save(old.copy(kind=kind,received=received))
    }
    @Synchronized fun bindSession(id: String, sessionId: Int, nonce: String, now: Long): UpdateJob {
        val old=requireJob(id)
        if (old.kind !in setOf("ready","needs-permission","needs-confirmation") || sessionId < 0 || nonce.isBlank() || now < old.createdAt)
            throw UpdateRejected("state")
        return save(old.copy(kind="installing",sessionId=sessionId,nonce=nonce))
    }
    @Synchronized fun callback(id: String, sessionId: Int, nonce: String, kind: String): Boolean {
        val old=job ?: return false
        if (old.id != id || old.sessionId != sessionId || old.nonce != nonce || nonce.isEmpty() ||
            old.kind !in setOf("installing","needs-confirmation") || kind !in setOf("needs-confirmation","installing","failed")) return false
        if (kind == "failed") settle(id,"failed","installer") else save(old.copy(kind=kind))
        return true
    }
    @Synchronized fun settle(id: String, kind: String, code: String = ""): UpdateJob {
        if (kind !in setOf("installed","failed","cancelled")) throw UpdateRejected("state")
        val old=requireJob(id)
        // Persist terminal truth before deleting bytes; an interrupted cleanup is
        // retried on reconciliation. Never recursively traverse this directory.
        val next=save(old.copy(kind=kind,code=code,nonce=""))
        apk(next).delete()
        return next
    }
    @Synchronized fun reconcile(installedVersion: Long, now: Long, sessionExists: (Int)->Boolean): UpdateJob? {
        val old=job ?: return null
        if (old.kind in setOf("installed","failed","cancelled")) { apk(old).delete(); return old }
        if (installedVersion >= old.spec.versionCode) return settle(old.id,"installed")
        if (old.kind in setOf("downloading","verifying")) return settle(old.id,"failed","interrupted")
        if (old.sessionId >= 0 && sessionExists(old.sessionId)) return old
        if (now-old.createdAt > AppUpdatePolicy.EXPIRES_MS) return settle(old.id,"failed","expired")
        if (old.kind in setOf("installing","needs-confirmation")) return save(old.copy(kind="ready",sessionId=-1,nonce=""))
        return old
    }
    fun apk(job: UpdateJob): File = AppUpdatePolicy.ownedFile(root,job.id,"update.apk")
    @Synchronized private fun requireJob(id: String): UpdateJob = job?.takeIf { it.id == id } ?: throw UpdateRejected("stale")
    private fun save(next: UpdateJob): UpdateJob {
        val value=next.copy(revision=maxOf(revision+1,System.currentTimeMillis()))
        val p=Properties().apply {
            setProperty("id",value.id); setProperty("createdAt",value.createdAt.toString()); setProperty("kind",value.kind)
            setProperty("received",value.received.toString()); setProperty("session",value.sessionId.toString());setProperty("nonce",value.nonce)
            setProperty("code",value.code);setProperty("revision",value.revision.toString())
            val s=value.spec
            setProperty("releaseId",s.releaseId);setProperty("url",s.url);setProperty("bytes",s.bytes.toString());setProperty("sha256",s.sha256)
            setProperty("package",s.packageName);setProperty("channel",s.channel);setProperty("signer",s.signerSha256);setProperty("abis",s.abis.sorted().joinToString(","))
            setProperty("minSdk",s.minSdk.toString());setProperty("targetSdk",s.targetSdk.toString());setProperty("versionCode",s.versionCode.toString());setProperty("versionName",s.versionName)
        }
        val staging=AppUpdatePolicy.ownedFile(root,value.id,"receipt.next")
        FileOutputStream(staging).use { p.store(it,null);it.fd.sync() }
        if (!staging.renameTo(AppUpdatePolicy.ownedFile(root,value.id,"receipt.properties"))) throw UpdateRejected("storage")
        revision=value.revision;job=value;return value
    }
    private fun read(id: String): UpdateJob {
        val receipt=AppUpdatePolicy.ownedFile(root,id,"receipt.properties")
        if (receipt.length() !in 1..16384) throw UpdateRejected("storage")
        val p=Properties().apply { receipt.inputStream().use { load(it) } }
        fun s(key: String)=p.getProperty(key) ?: throw UpdateRejected("storage")
        if(s("id") != id || s("kind") !in active+setOf("failed","cancelled","installed")) throw UpdateRejected("storage")
        val spec=UpdateSpec(s("releaseId"),s("url"),s("bytes").toLong(),s("sha256"),s("package"),s("channel"),s("signer"),s("abis").split(',').toSet(),s("minSdk").toInt(),s("targetSdk").toInt(),s("versionCode").toLong(),s("versionName"))
        return UpdateJob(id,spec,s("createdAt").toLong(),s("kind"),s("received").toLong(),s("session").toInt(),s("nonce"),s("code"),s("revision").toLong())
    }
    companion object {
        val active=setOf("downloading","verifying","ready","installing","needs-permission","needs-confirmation")
        private val transitions=mapOf("downloading" to setOf("downloading","verifying"),"verifying" to setOf("ready"),
            "ready" to setOf("needs-permission","verifying"),"needs-permission" to setOf("ready","verifying"),
            "needs-confirmation" to setOf("ready","verifying"))
    }
}
