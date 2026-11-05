import { useEffect, useSyncExternalStore } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { beginAppActivity } from "../appActivity";
import { createNativeUpdates } from "./native";
import type { NativeUpdatePort } from "./native";

let bridge: NativeUpdatePort | null=null;
export function nativeUpdateBridge(): NativeUpdatePort {
  return bridge ??= registerPlugin<NativeUpdatePort>("NorfoldAppUpdate");
}
// Lazy calls keep old builds/web inert; importing a screen never starts work.
const port: NativeUpdatePort={
  getIdentity:()=>nativeUpdateBridge().getIdentity(),getState:()=>nativeUpdateBridge().getState(),
  startDownload:options=>nativeUpdateBridge().startDownload(options),requestInstall:options=>nativeUpdateBridge().requestInstall(options),
  openPermissionSettings:options=>nativeUpdateBridge().openPermissionSettings(options),cancel:options=>nativeUpdateBridge().cancel(options),
  addListener:(event,listener)=>nativeUpdateBridge().addListener(event,listener),
};
let releaseBusy: (()=>void) | null=null;
export const nativeUpdates=createNativeUpdates({android:Capacitor.isNativePlatform(),port,onBusy:busy=>{
  if(busy) releaseBusy ??= beginAppActivity();
  else {releaseBusy?.();releaseBusy=null;}
}});
export function useNativeUpdateState() {
  return useSyncExternalStore(nativeUpdates.subscribe,nativeUpdates.getSnapshot);
}
let mounts=0;
/** Process work outlives screens; only observe/reconcile, never download/install here. */
export function NativeUpdateLifecycle() {
  useEffect(()=>{
    mounts++;
    void nativeUpdates.connect();
    const resume=()=>{if(document.visibilityState==="visible")void nativeUpdates.refresh();};
    document.addEventListener("visibilitychange",resume);
    window.addEventListener("focus",resume);
    return ()=>{
      document.removeEventListener("visibilitychange",resume);window.removeEventListener("focus",resume);
      mounts--;
      queueMicrotask(()=>{if(mounts===0)void nativeUpdates.disconnect();});
    };
  },[]);
  return null;
}
