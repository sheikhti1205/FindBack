package com.findback.app.update

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.StatFs
import android.provider.Settings
import androidx.core.content.IntentSanitizer
import com.android.apksig.ApkVerifier
import com.findback.app.BuildConfig
import com.getcapacitor.JSObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipFile

/** Process-owned updater; no model paths, credentials, or retained Activity. */
class AppUpdateEngine private constructor(private val context: Context) {
    private val jobs=AppUpdateJobs(File(context.noBackupFilesDir.canonicalFile,"app-updates"))
    private val executor=Executors.newSingleThreadExecutor { Thread(it,"norfold-app-update") }
    private val listeners=CopyOnWriteArraySet<(JSObject)->Unit>()
    @Volatile private var cancellation: AtomicBoolean?=null
    @Volatile private var connection: HttpURLConnection?=null
    private var confirmation: Pair<String,Intent>?=null
    private val installer get()=context.packageManager.packageInstaller

    fun observe(listener: (JSObject)->Unit): ()->Unit {listeners.add(listener);return {listeners.remove(listener)}}
    private fun emit() {val value=state();listeners.forEach {runCatching {it(value)}}}
    fun state(): JSObject {
        val job=jobs.current() ?: return JSObject().put("kind","idle").put("revision",0)
        return JSObject().put("kind",job.kind).put("releaseId",job.spec.releaseId).put("revision",job.revision)
            .put("received",job.received).put("total",job.spec.bytes).put("code",job.code)
            .put("retryable",job.code in setOf("network","storage","interrupted","expired","installer","unavailable"))
    }
    @Suppress("DEPRECATION")
    fun identity(): InstalledApp {
        val flags=if(Build.VERSION.SDK_INT>=28)PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val info=context.packageManager.getPackageInfo(context.packageName,flags)
        val signatures=if(Build.VERSION.SDK_INT>=28)info.signingInfo?.apkContentsSigners else info.signatures
        return InstalledApp(info.packageName,if(Build.VERSION.SDK_INT>=28)info.longVersionCode else info.versionCode.toLong(),
            BuildConfig.UPDATE_CHANNEL,Build.SUPPORTED_ABIS.firstOrNull() ?: "",Build.VERSION.SDK_INT,
            signatures?.map{hex(it.toByteArray())}?.toSet() ?: emptySet())
    }
    fun refresh(done: (JSObject)->Unit, failed: (String)->Unit) = executor.execute {
        val observed=jobs.current()
        try {
            if(cancellation==null) {
                jobs.current()?.takeIf{it.sessionId>=0}?.let {job ->
                    // Death during staging is not a running installation. Drop
                    // only our recorded unsealed session, then reverify bytes.
                    if(installer.getSessionInfo(job.sessionId)?.isSealed==false)installer.abandonSession(job.sessionId)
                }
                jobs.reconcile(identity().versionCode,System.currentTimeMillis()){installer.getSessionInfo(it)!=null}
                jobs.current()?.takeIf{it.kind in setOf("ready","needs-permission")}?.let{verify(it)}
                emit()
            }
            done(state())
        } catch(error:Exception) {
            if(observed!=null && jobs.current()?.id==observed.id && cancellation==null) {
                runCatching{jobs.settle(observed.id,"failed",code(error))};emit();failed(code(error))
            } else done(state())
        }
    }
    @Synchronized fun start(spec: UpdateSpec,activity: Activity): JSObject {
        requireForeground(activity)
        if(cancellation!=null)throw UpdateRejected("busy")
        AppUpdatePolicy.validate(spec,identity())
        val job=jobs.begin(spec,System.currentTimeMillis())
        val cancel=AtomicBoolean(false);cancellation=cancel;emit()
        executor.execute {
            try {
                val hash=download(job,cancel)
                if(cancel.get())throw UpdateRejected("cancelled")
                jobs.transition(job.id,"verifying");emit();verify(job,hash)
                if(cancel.get())throw UpdateRejected("cancelled")
                jobs.transition(job.id,"ready")
            } catch(error:Exception) {settleFailure(job,cancel,error)}
            finally {connection?.disconnect();connection=null;cancellation=null;emit()}
        }
        return state()
    }
    private fun download(job: UpdateJob,cancel: AtomicBoolean): String {
        var uri=AppUpdatePolicy.downloadUrl(job.spec.url,false)
        val deadline=System.nanoTime()+20L*60*1_000_000_000
        repeat(6) {hop ->
            if(cancel.get())throw UpdateRejected("cancelled")
            if(System.nanoTime()>deadline)throw UpdateRejected("network")
            val conn=URL(uri.toString()).openConnection() as HttpURLConnection
            connection=conn;conn.instanceFollowRedirects=false;conn.connectTimeout=15000;conn.readTimeout=20000
            conn.setRequestProperty("Accept-Encoding","identity")
            try {
                val status=conn.responseCode
                if(status in setOf(301,302,303,307,308)) {
                    if(hop==5)throw UpdateRejected("origin")
                    uri=AppUpdatePolicy.downloadUrl(uri.resolve(conn.getHeaderField("Location") ?: throw UpdateRejected("origin")).toString(),true)
                } else {
                    if(status!=200)throw UpdateRejected("network")
                    if(conn.contentLengthLong>=0 && conn.contentLengthLong!=job.spec.bytes)throw UpdateRejected("integrity")
                    if(conn.getHeaderField("Content-Encoding")?.let{it!="identity"}==true)throw UpdateRejected("integrity")
                    var last=0L
                    return conn.inputStream.use {input -> AppUpdateTransfer.copy(job.spec,input,jobs.apk(job),
                        {StatFs(context.noBackupFilesDir.absolutePath).availableBytes},
                        {if(System.nanoTime()>deadline)throw UpdateRejected("network");cancel.get()},
                        {received -> val at=System.nanoTime();if(at-last>250_000_000 || received==job.spec.bytes) {
                            jobs.transition(job.id,"downloading",received);emit();last=at
                        }})}
                }
            } finally {conn.disconnect();connection=null}
        }
        throw UpdateRejected("origin")
    }
    @Suppress("DEPRECATION")
    private fun verify(job: UpdateJob,knownHash: String?=null) {
        val file=jobs.apk(job)
        if(!file.isFile || file.length()!=job.spec.bytes)throw UpdateRejected("integrity")
        val hash=knownHash ?: file.inputStream().use {stream ->
            val digest=MessageDigest.getInstance("SHA-256");val buffer=ByteArray(64*1024)
            while(true){val n=stream.read(buffer);if(n<0)break;digest.update(buffer,0,n)}
            digest.digest().joinToString(""){"%02x".format(it)}
        }
        val installed=identity()
        val result=ApkVerifier.Builder(file).setMinCheckedPlatformVersion(installed.sdk).setMaxCheckedPlatformVersion(installed.sdk).build().verify()
        if(!result.isVerified)throw UpdateRejected("signature")
        val flags=if(Build.VERSION.SDK_INT>=28)PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val info=context.packageManager.getPackageArchiveInfo(file.absolutePath,flags) ?: throw UpdateRejected("integrity")
        if(info.splitNames?.isNotEmpty()==true)throw UpdateRejected("compatibility")
        val app=info.applicationInfo ?: throw UpdateRejected("integrity")
        val abis=mutableSetOf<String>()
        ZipFile(file).use {zip ->
            val entries=zip.entries();var count=0
            while(entries.hasMoreElements()) {
                if(++count>100000)throw UpdateRejected("integrity")
                val name=entries.nextElement().name
                if(name.startsWith("lib/") && name.endsWith(".so")) {
                    val parts=name.split('/');if(parts.size!=3)throw UpdateRejected("integrity");abis.add(parts[1])
                }
            }
        }
        val signers=result.signerCertificates.map{hex(it.encoded)}.toSet()
        val parsed=(if(Build.VERSION.SDK_INT>=28)info.signingInfo?.apkContentsSigners else info.signatures)?.map{hex(it.toByteArray())}?.toSet()
        if(signers!=parsed)throw UpdateRejected("signature")
        val verifiedLineage=result.signingCertificateLineage
        val lineage=verifiedLineage?.certificatesInLineage?.filter {
            hex(it.encoded) in signers || verifiedLineage.getSignerCapabilities(it).hasInstalledData()
        }?.map{hex(it.encoded)} ?: signers.toList()
        AppUpdatePolicy.verify(job.spec,installed,VerifiedApk(info.packageName,
            if(Build.VERSION.SDK_INT>=28)info.longVersionCode else info.versionCode.toLong(),info.versionName ?: "",
            app.minSdkVersion,app.targetSdkVersion,abis,signers,lineage,true),file.length(),hash)
    }
    @Synchronized fun install(releaseId: String,activity: Activity,done: (JSObject)->Unit,failed: (String)->Unit) {
        requireForeground(activity)
        if(cancellation!=null)throw UpdateRejected("busy")
        val job=requireRelease(releaseId)
        if(job.kind !in setOf("ready","needs-permission","needs-confirmation"))throw UpdateRejected("state")
        val pending=confirmation?.takeIf{it.first==job.id}?.second
        if(job.kind=="needs-confirmation" && pending!=null) {
            activity.startActivity(safeConfirmation(pending,job.sessionId));done(state());return
        }
        val cancel=AtomicBoolean(false);cancellation=cancel
        executor.execute {
            var sessionId=-1
            try {
                verify(job)
                if(cancel.get())throw UpdateRejected("cancelled")
                if(AppUpdatePolicy.installDecision(job.kind,true,Build.VERSION.SDK_INT<26 || context.packageManager.canRequestPackageInstalls())=="needs-permission") {
                    if(job.kind=="needs-confirmation")jobs.transition(job.id,"ready")
                    if(jobs.current()?.kind!="needs-permission")jobs.transition(job.id,"needs-permission")
                    cancellation=null;emit();done(state());return@execute
                }
                if(job.sessionId>=0)installer.abandonSession(job.sessionId)
                val params=PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                    setAppPackageName(context.packageName);setSize(job.spec.bytes)
                    if(Build.VERSION.SDK_INT>=31)setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
                }
                sessionId=installer.createSession(params)
                val nonce=UUID.randomUUID().toString()
                // Persist ownership before copying/commit, so process death
                // cannot leave a staging session with no durable cancel path.
                jobs.bindSession(job.id,sessionId,nonce,System.currentTimeMillis())
                installer.openSession(sessionId).use {session ->
                    jobs.apk(job).inputStream().use {input -> session.openWrite("base.apk",0,job.spec.bytes).use {output ->
                        val buffer=ByteArray(64*1024)
                        while(true) {if(cancel.get())throw UpdateRejected("cancelled");val n=input.read(buffer);if(n<0)break;output.write(buffer,0,n)}
                        session.fsync(output)
                    }}
                }
                val ownedSession=sessionId
                activity.runOnUiThread {
                    try {
                        requireForeground(activity);if(cancel.get())throw UpdateRejected("cancelled")
                        val callback=Intent(context,AppUpdateReceiver::class.java).apply {action=CALLBACK_ACTION;data=callbackUri(job.id,nonce)}
                        val flags=PendingIntent.FLAG_UPDATE_CURRENT or (if(Build.VERSION.SDK_INT>=31)PendingIntent.FLAG_MUTABLE else 0)
                        val sender=PendingIntent.getBroadcast(context,ownedSession,callback,flags)
                        installer.openSession(ownedSession).use {it.commit(sender.intentSender)}
                        done(state())
                    } catch(error:Exception) {runCatching{installer.abandonSession(ownedSession)};settleFailure(job,cancel,error);failed(code(error))}
                    finally {cancellation=null;emit()}
                }
            } catch(error:Exception) {
                if(sessionId>=0)runCatching{installer.abandonSession(sessionId)}
                settleFailure(job,cancel,error);cancellation=null;emit();failed(code(error))
            }
        }
    }
    fun permission(releaseId: String,activity: Activity): JSObject {
        requireForeground(activity)
        if(requireRelease(releaseId).kind!="needs-permission" || Build.VERSION.SDK_INT<26)throw UpdateRejected("state")
        activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:${context.packageName}")))
        return state()
    }
    @Synchronized fun cancel(releaseId: String): JSObject {
        val job=requireRelease(releaseId)
        if(job.kind !in AppUpdateJobs.active)return state()
        if(cancellation!=null){cancellation?.set(true);connection?.disconnect();return state()}
        if(job.sessionId>=0)installer.abandonSession(job.sessionId)
        confirmation=null;jobs.settle(job.id,"cancelled");emit();return state()
    }
    /** Explicit private callback only. Never starts UI or trusts callback success as installed. */
    @Synchronized fun callback(intent: Intent) {
        val job=jobs.current() ?: return
        if(intent.action!=CALLBACK_ACTION || intent.data!=callbackUri(job.id,job.nonce) || job.nonce.isEmpty())return
        val session=intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID,-1)
        if(session!=job.sessionId)return
        when(intent.getIntExtra(PackageInstaller.EXTRA_STATUS,Int.MIN_VALUE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION") val raw=if(Build.VERSION.SDK_INT>=33)intent.getParcelableExtra(Intent.EXTRA_INTENT,Intent::class.java) else intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if(raw==null)return
                val safe=runCatching{safeConfirmation(raw,session)}.getOrNull() ?: return
                if(jobs.callback(job.id,session,job.nonce,"needs-confirmation"))confirmation=job.id to safe
            }
            PackageInstaller.STATUS_SUCCESS -> {
                if(!jobs.callback(job.id,session,job.nonce,"installing"))return
                jobs.reconcile(identity().versionCode,System.currentTimeMillis()){installer.getSessionInfo(it)!=null}
            }
            in PackageInstaller.STATUS_FAILURE..PackageInstaller.STATUS_FAILURE_TIMEOUT -> jobs.callback(job.id,session,job.nonce,"failed")
            else -> return
        }
        emit()
    }
    private fun safeConfirmation(raw: Intent,session: Int): Intent {
        val component=raw.resolveActivity(context.packageManager) ?: throw UpdateRejected("installer")
        val info=context.packageManager.getActivityInfo(component,0)
        if(!info.exported || (info.applicationInfo.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP))==0 ||
            raw.action!="android.content.pm.action.CONFIRM_INSTALL" || raw.getIntExtra(PackageInstaller.EXTRA_SESSION_ID,-1)!=session ||
            raw.selector!=null || raw.clipData!=null || raw.data!=null)throw UpdateRejected("installer")
        return IntentSanitizer.Builder().allowComponent(component).allowAction("android.content.pm.action.CONFIRM_INSTALL")
            .allowExtra(PackageInstaller.EXTRA_SESSION_ID,Int::class.javaObjectType).build()
            .sanitizeByFiltering(Intent(raw).setComponent(component))
    }
    private fun requireForeground(activity: Activity) {
        if(activity.isFinishing || activity.isDestroyed || !activity.hasWindowFocus())throw UpdateRejected("unavailable")
    }
    private fun requireRelease(id: String): UpdateJob=jobs.current()?.takeIf{it.spec.releaseId==id} ?: throw UpdateRejected("stale")
    private fun settleFailure(job: UpdateJob,cancel: AtomicBoolean,error: Exception) {
        if(cancel.get() || (error is UpdateRejected && error.code=="cancelled"))jobs.settle(job.id,"cancelled")
        else jobs.settle(job.id,"failed",code(error))
    }
    private fun code(error: Exception)=if(error is UpdateRejected)error.code else if(error is java.io.IOException)"network" else "unavailable"
    companion object {
        private var instance: AppUpdateEngine?=null
        @Synchronized fun get(context: Context): AppUpdateEngine=instance ?: AppUpdateEngine(context.applicationContext).also{instance=it}
        const val CALLBACK_ACTION="com.findback.app.UPDATE_INSTALL_RESULT"
        private fun callbackUri(id: String,nonce: String)=Uri.parse("norfold-update://session/$id/$nonce")
        private fun hex(bytes: ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
    }
}
