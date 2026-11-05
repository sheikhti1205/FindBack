import { describe, expect, it } from "vitest";
import { createNativeUpdates, parseUpdateState } from "./native";
import type { NativeUpdatePort } from "./native";
import type { AndroidRelease, Installation } from "./types";

const installed: Installation = { packageName:"com.findback.app",versionCode:100,signingChannel:"beta",abi:"arm64-v8a",sdk:36 };
const release: AndroidRelease = { id:"test-101",platform:"android",versionName:"1.0.1",versionCode:101,gitSha:"a".repeat(40),tag:"v1.0.1",publishedAt:"2026-11-05T00:00:00Z",summary:"Synthetic",accepted:true,
  artifacts:[{url:"https://github.com/sheikhti1205/Norfold/releases/download/v1/app.apk",bytes:20,sha256:"12".repeat(32),signerSha256:"ab".repeat(32),packageName:"com.findback.app",signingChannel:"beta",abis:["arm64-v8a"],minSdk:24,targetSdk:36}] };
function fixture(android=true) {
  const calls: string[]=[];
  let state: unknown={kind:"idle",revision:0};
  let emit: (value: unknown)=>void=()=>{};
  const port: NativeUpdatePort={getIdentity:async()=>installed,getState:async()=>state,
    startDownload:async options=>{calls.push(`download:${options.expectedVersionCode}`);return state;},
    requestInstall:async()=>{calls.push("install");return state;},cancel:async()=>{calls.push("cancel");return state;},
    openPermissionSettings:async()=>{calls.push("permission");return state;},
    addListener:async(_event,listener)=>{emit=listener;return{remove:async()=>{calls.push("removed");}};}};
  const activity: boolean[]=[];
  const updates=createNativeUpdates({android,port,onBusy:busy=>activity.push(busy)});
  return {updates,calls,port,activity,set:(value:unknown)=>{state=value;emit(value);}};
}
describe("native update boundary",()=>{
  it("never invokes the bridge from web and fails closed without identity",async()=>{
    const f=fixture(false);await f.updates.connect();await f.updates.download(release,installed);
    expect(f.calls).toEqual([]);expect(f.updates.getSnapshot().kind).toBe("idle");
    const native=fixture();await native.updates.download(release,null);expect(native.calls).toEqual([]);
  });
  it("binds the selected exact artifact and expected versions without accepting caller paths",async()=>{
    const f=fixture();let payload:unknown;
    f.port.startDownload=async input=>{payload=input;return{kind:"downloading",releaseId:release.id,received:0,total:20,revision:1};};
    await f.updates.download(release,installed);
    expect(payload).toEqual({releaseId:release.id,artifact:release.artifacts[0],expectedVersionCode:101,expectedVersionName:"1.0.1"});
    expect(f.updates.getSnapshot().kind).toBe("downloading");expect(f.activity.at(-1)).toBe(true);
  });
  it("rejects incompatible and unaccepted releases before the native boundary",async()=>{
    const f=fixture();await f.updates.download({...release,accepted:false},installed);
    await f.updates.download({...release,versionCode:100},installed);
    await f.updates.download(release,{...installed,abi:"x86_64"});expect(f.calls).toEqual([]);
  });
  it("installation and permission changes require their explicit actions and ready state",async()=>{
    const f=fixture();await f.updates.connect();await f.updates.install();expect(f.calls).toEqual([]);
    f.set({kind:"ready",releaseId:release.id,revision:1});await f.updates.install();expect(f.calls).toEqual(["install"]);
    f.set({kind:"needs-permission",releaseId:release.id,revision:2});expect(f.calls).toEqual(["install"]);
    await f.updates.openPermission();expect(f.calls).toEqual(["install","permission"]);
  });
  it("does not infer installation from ready, callbacks or stale events and releases busy veto",async()=>{
    const f=fixture();await f.updates.connect();
    f.set({kind:"installing",releaseId:release.id,revision:4});expect(f.updates.getSnapshot().kind).toBe("installing");
    f.set({kind:"ready",releaseId:release.id,revision:3});expect(f.updates.getSnapshot().kind).toBe("installing");
    f.set({kind:"failed",releaseId:release.id,code:"permission",retryable:true,revision:5});
    expect(f.activity.at(-1)).toBe(false);await f.updates.disconnect();expect(f.calls).toEqual(["removed"]);
  });
  it("contains malformed progress, arbitrary failures and bridge exceptions",async()=>{
    expect(parseUpdateState({kind:"downloading",releaseId:"a",received:21,total:20,revision:1})).toBeNull();
    expect(parseUpdateState({kind:"installed",releaseId:"../a",revision:1})).toBeNull();
    const f=fixture();f.port.startDownload=async()=>{throw new Error("private path and native stack");};
    await f.updates.download(release,installed);
    expect(f.updates.getSnapshot()).toMatchObject({kind:"failed",code:"unavailable"});
    expect(JSON.stringify(f.updates.getSnapshot())).not.toContain("private");
  });
  it("allows native truth to recover after an action rejection without inventing a newer native revision",async()=>{
    const f=fixture();await f.updates.connect();
    f.set({kind:"ready",releaseId:release.id,revision:7});
    f.port.requestInstall=async()=>{throw new Error("activity no longer active");};
    await f.updates.install();expect(f.updates.getSnapshot().kind).toBe("failed");
    await f.updates.refresh();expect(f.updates.getSnapshot().kind).toBe("ready");
  });
});
