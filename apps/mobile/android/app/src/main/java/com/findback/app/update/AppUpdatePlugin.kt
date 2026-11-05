package com.findback.app.update

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name="NorfoldAppUpdate")
class AppUpdatePlugin : Plugin() {
    private val engine get()=AppUpdateEngine.get(context)
    private var unsubscribe: (()->Unit)?=null
    override fun load() {unsubscribe=engine.observe{notifyListeners("updateState",it)}}
    override fun handleOnDestroy() {unsubscribe?.invoke();unsubscribe=null}
    @PluginMethod fun getIdentity(call: PluginCall)=safe(call) {
        val i=engine.identity()
        call.resolve(JSObject().put("packageName",i.packageName).put("versionCode",i.versionCode)
            .put("signingChannel",i.channel).put("abi",i.abi).put("sdk",i.sdk))
    }
    @PluginMethod fun getState(call: PluginCall) {engine.refresh({call.resolve(it)},{call.reject("Update unavailable",it)})}
    @PluginMethod fun startDownload(call: PluginCall)=safe(call) {
        val a=call.getObject("artifact") ?: throw UpdateRejected("metadata")
        fun text(key: String)=a.getString(key) ?: throw UpdateRejected("metadata")
        fun number(key: String)=a.getLong(key) ?: throw UpdateRejected("metadata")
        val abis=a.getJSONArray("abis");val abiSet=(0 until abis.length()).map{abis.getString(it)}.toSet()
        val spec=UpdateSpec(id(call),text("url"),number("bytes"),text("sha256"),text("packageName"),text("signingChannel"),
            text("signerSha256"),abiSet,number("minSdk").toInt(),number("targetSdk").toInt(),
            call.getLong("expectedVersionCode") ?: throw UpdateRejected("metadata"),call.getString("expectedVersionName") ?: throw UpdateRejected("metadata"))
        call.resolve(engine.start(spec,activity))
    }
    @PluginMethod fun requestInstall(call: PluginCall)=safe(call) {engine.install(id(call),activity,{call.resolve(it)},{call.reject("Update unavailable",it)})}
    @PluginMethod fun openPermissionSettings(call: PluginCall)=safe(call) {call.resolve(engine.permission(id(call),activity))}
    @PluginMethod fun cancel(call: PluginCall)=safe(call) {call.resolve(engine.cancel(id(call)))}
    private fun id(call: PluginCall)=call.getString("releaseId")?.takeIf{AppUpdatePolicy.releaseId(it)} ?: throw UpdateRejected("metadata")
    private fun safe(call: PluginCall,block: ()->Unit) {
        try {block()} catch(e:Exception) {call.reject("Update unavailable",if(e is UpdateRejected)e.code else "unavailable")}
    }
}
