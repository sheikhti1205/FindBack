package com.findback.app.update

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class AppUpdatePolicyTest {
    private val signer = "ab".repeat(32)
    private val nextSigner = "cd".repeat(32)
    private fun installed() = InstalledApp("com.findback.app", 100, "beta", "arm64-v8a", 36, setOf(signer))
    private fun spec() = UpdateSpec("release-101", "https://github.com/sheikhti1205/Norfold/releases/download/v1/app.apk", 20,
        "12".repeat(32), "com.findback.app", "beta", signer, setOf("arm64-v8a"), 24, 36, 101, "1.0.1")
    private fun apk() = VerifiedApk("com.findback.app", 101, "1.0.1", 24, 36, setOf("arm64-v8a"), setOf(signer), listOf(signer), true)
    private fun rejects(block: () -> Unit) { try { block(); fail("accepted unsafe update") } catch (_: UpdateRejected) {} }

    @Test fun acceptsExactHigherPackageAndVerifiedBytes() {
        AppUpdatePolicy.validate(spec(), installed())
        AppUpdatePolicy.verify(spec(), installed(), apk(), 20, "12".repeat(32))
    }
    @Test fun rejectsIdentityDowngradeAndCompatibilityDisagreement() {
        listOf(spec().copy(versionCode=100), spec().copy(packageName="other"), spec().copy(channel="other"),
            spec().copy(abis=setOf("x86_64")), spec().copy(minSdk=37), spec().copy(bytes=0),
            spec().copy(bytes=AppUpdatePolicy.MAX_BYTES+1), spec().copy(releaseId="../elsewhere"),
            spec().copy(sha256="bad")).forEach { bad -> rejects { AppUpdatePolicy.validate(bad, installed()) } }
    }
    @Test fun rejectsArbitraryOriginsCredentialsEncodedTraversalAndDowngradesToHttp() {
        listOf("http://github.com/a.apk", "https://evil.test/app.apk", "https://github.com@evil.test/app.apk",
            "https://github.com:444/app.apk", "https://github.com/other/repo/releases/download/v/app.apk",
            "https://github.com/sheikhti1205/Norfold/releases/download/../app.apk",
            "https://github.com/sheikhti1205/Norfold/releases/download/v/%2e%2e/app.apk").forEach {
            rejects { AppUpdatePolicy.downloadUrl(it, false) }
        }
        rejects { AppUpdatePolicy.downloadUrl("https://release-assets.githubusercontent.com/a.apk", false) }
        AppUpdatePolicy.downloadUrl("https://release-assets.githubusercontent.com/github-production-release-asset/a?sig=public", true)
    }
    @Test fun verifiesEveryParsedFactAndCryptographicResultNotJustMetadataHash() {
        val wrong = listOf(apk().copy(signatureVerified=false), apk().copy(packageName="other"), apk().copy(versionCode=102),
            apk().copy(versionName="1.0.2"), apk().copy(minSdk=25), apk().copy(targetSdk=35),
            apk().copy(abis=setOf("x86_64")), apk().copy(signers=setOf(nextSigner), lineage=listOf(nextSigner)))
        wrong.forEach { facts -> rejects { AppUpdatePolicy.verify(spec(), installed(), facts, 20, spec().sha256) } }
        rejects { AppUpdatePolicy.verify(spec(), installed(), apk(), 19, spec().sha256) }
        rejects { AppUpdatePolicy.verify(spec(), installed(), apk(), 20, "00".repeat(32)) }
    }
    @Test fun rotationMustExtendTheInstalledCurrentSignerAndMultisignerSetsMustMatchCompletely() {
        AppUpdatePolicy.verify(spec().copy(signerSha256=nextSigner), installed(),
            apk().copy(signers=setOf(nextSigner), lineage=listOf(signer,nextSigner)), 20, spec().sha256)
        rejects { AppUpdatePolicy.verify(spec(), installed().copy(signers=setOf(signer,nextSigner)), apk(), 20, spec().sha256) }
        AppUpdatePolicy.verify(spec(), installed().copy(signers=setOf(signer,nextSigner)),
            apk().copy(signers=setOf(signer,nextSigner),lineage=emptyList()),20,spec().sha256)
    }
    @Test fun fileOwnershipCannotEscapeRootOrFollowForeignSymlink() {
        val root=Files.createTempDirectory("update-policy").toFile()
        val foreign=Files.createTempDirectory("update-foreign").toFile()
        try {
            val id="c2760240-c817-4a2d-b85b-03222b20c493"
            assertEquals(File(root,id).canonicalFile,AppUpdatePolicy.jobDirectory(root,id))
            rejects { AppUpdatePolicy.jobDirectory(root,"../other") }
            Files.createSymbolicLink(File(root,id).toPath(),foreign.toPath())
            rejects { AppUpdatePolicy.jobDirectory(root,id) }
        } finally { File(root,"c2760240-c817-4a2d-b85b-03222b20c493").delete(); root.deleteRecursively(); foreign.deleteRecursively() }
    }
    @Test fun permissionAndForegroundAreRequiredBeforeAnyInstallerAction() {
        rejects {AppUpdatePolicy.installDecision("ready",false,true)}
        rejects {AppUpdatePolicy.installDecision("downloading",true,true)}
        assertEquals("needs-permission",AppUpdatePolicy.installDecision("ready",true,false))
        assertEquals("install",AppUpdatePolicy.installDecision("needs-permission",true,true))
    }
}
