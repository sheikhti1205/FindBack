package com.findback.app.update

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class AppUpdateJobsTest {
    private fun spec()=UpdateSpec("release-101","https://github.com/sheikhti1205/Norfold/releases/download/v1/app.apk",20,
        "12".repeat(32),"com.findback.app","beta","ab".repeat(32),setOf("arm64-v8a"),24,36,101,"1.0.1")
    @Test fun durableJobIsBoundToArtifactAndSessionCallbackNotCallerPaths() {
        val root=Files.createTempDirectory("update-jobs").toFile()
        try {
            val jobs=AppUpdateJobs(root)
            val job=jobs.begin(spec(),1000)
            jobs.transition(job.id,"verifying")
            jobs.transition(job.id,"ready")
            jobs.bindSession(job.id,42,"nonce",2000)
            assertFalse(jobs.callback(job.id,43,"nonce","failed"))
            assertFalse(jobs.callback(job.id,42,"forged","failed"))
            assertTrue(jobs.callback(job.id,42,"nonce","needs-confirmation"))
            val read=AppUpdateJobs(root).current()!!
            assertEquals(spec(),read.spec)
            assertEquals("needs-confirmation",read.kind)
            assertEquals(42,read.sessionId)
            assertFalse(jobs.callback("stale",42,"nonce","failed"))
        } finally { root.deleteRecursively() }
    }
    @Test fun cancellationAndCleanupOnlyDeleteTheOwnedJobAndNeverForeignFiles() {
        val root=Files.createTempDirectory("update-jobs").toFile()
        val foreign=java.io.File(root,"history.db").apply { writeText("keep") }
        try {
            val jobs=AppUpdateJobs(root)
            val job=jobs.begin(spec(),1000)
            jobs.apk(job).writeText("partial apk")
            jobs.settle(job.id,"cancelled")
            assertFalse(jobs.apk(job).exists())
            assertEquals("keep",foreign.readText())
            assertEquals("cancelled",AppUpdateJobs(root).current()!!.kind)
        } finally { root.deleteRecursively() }
    }
    @Test fun interruptedDownloadIsNotReadyAndSuccessNeedsActualInstalledVersion() {
        val root=Files.createTempDirectory("update-jobs").toFile()
        try {
            val jobs=AppUpdateJobs(root); val job=jobs.begin(spec(),1000)
            jobs.reconcile(100,2000) { false }
            assertEquals("failed",jobs.current()!!.kind)
            assertEquals("interrupted",jobs.current()!!.code)
            val next=jobs.begin(spec(),3000)
            jobs.transition(next.id,"verifying"); jobs.transition(next.id,"ready")
            jobs.bindSession(next.id,8,"nonce",4000)
            assertTrue(jobs.callback(next.id,8,"nonce","installing"))
            jobs.reconcile(100,5000) { true }
            assertNotEquals("installed",jobs.current()!!.kind)
            jobs.reconcile(101,6000) { false }
            assertEquals("installed",jobs.current()!!.kind)
        } finally { root.deleteRecursively() }
    }
    @Test fun duplicateStartAndUnsafeStateJumpAreRejected() {
        val root=Files.createTempDirectory("update-jobs").toFile()
        try {
            val jobs=AppUpdateJobs(root); val job=jobs.begin(spec(),1000)
            try { jobs.begin(spec(),1001); fail("duplicate active job") } catch (_: UpdateRejected) {}
            try { jobs.transition(job.id,"ready"); fail("verification skipped") } catch (_: UpdateRejected) {}
        } finally { root.deleteRecursively() }
    }
    @Test fun expiryDoesNotDeleteAnActiveInstallerAndCorruptReceiptsDoNotBecomeReady() {
        val root=Files.createTempDirectory("update-jobs").toFile()
        try {
            val jobs=AppUpdateJobs(root);val job=jobs.begin(spec(),1000)
            jobs.transition(job.id,"verifying");jobs.transition(job.id,"ready");jobs.bindSession(job.id,42,"nonce",2000)
            jobs.apk(job).writeText("keep until session settles")
            jobs.reconcile(100,AppUpdatePolicy.EXPIRES_MS+10000){true}
            assertTrue(jobs.apk(job).exists());assertEquals("installing",jobs.current()!!.kind)
            jobs.reconcile(100,AppUpdatePolicy.EXPIRES_MS+10000){false}
            assertFalse(jobs.apk(job).exists());assertEquals("expired",jobs.current()!!.code)
            java.io.File(java.io.File(root,job.id),"receipt.properties").writeText("corrupt")
            val unreadable=AppUpdateJobs(root)
            assertNull(unreadable.current())
            try {unreadable.begin(spec(),AppUpdatePolicy.EXPIRES_MS+20000);fail("unknown old job must fail closed")} catch (_: UpdateRejected) {}
        } finally {root.deleteRecursively()}
    }
}
