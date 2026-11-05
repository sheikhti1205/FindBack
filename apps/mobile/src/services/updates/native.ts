/** Narrow, typed boundary. Native revalidates all metadata and owns all paths. */
import { selectArtifact, selectInstallableRelease } from "./catalogue";
import type { AndroidArtifact, AndroidRelease, Installation } from "./types";

export type AppUpdateState = Readonly<(
  | { kind: "idle" }
  | { kind: "downloading"; releaseId: string; received: number; total: number }
  | { kind: "verifying" | "ready" | "installing" | "installed" | "needs-permission" | "needs-confirmation" | "cancelled"; releaseId: string }
  | { kind: "failed"; releaseId: string; code: string; retryable: boolean }
) & { revision: number }>;
export interface NativeUpdatePort {
  getIdentity(): Promise<unknown>;
  getState(): Promise<unknown>;
  startDownload(options: {releaseId: string; artifact: AndroidArtifact; expectedVersionCode: number; expectedVersionName: string}): Promise<unknown>;
  requestInstall(options: {releaseId: string}): Promise<unknown>;
  cancel(options: {releaseId: string}): Promise<unknown>;
  openPermissionSettings(options: {releaseId: string}): Promise<unknown>;
  addListener(event: "updateState", listener: (state: unknown)=>void): Promise<{remove(): Promise<void>}>;
}
const simple = new Set(["verifying","ready","installing","installed","needs-permission","needs-confirmation","cancelled"]);
const codes = new Set(["origin","metadata","identity","version","compatibility","integrity","signature","storage","network","permission","installer","interrupted","expired","unavailable","cancelled"]);
export function parseUpdateState(raw: unknown): AppUpdateState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value=raw as Record<string,unknown>;
  const revision=value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return null;
  if (value.kind === "idle") return {kind:"idle",revision};
  const releaseId=value.releaseId;
  if (typeof releaseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId) || releaseId.includes("..")) return null;
  if (typeof value.kind === "string" && simple.has(value.kind))
    return {kind:value.kind as "ready",releaseId,revision};
  if (value.kind === "failed") return {kind:"failed",releaseId,revision,
    code:typeof value.code === "string" && codes.has(value.code) ? value.code : "unavailable",retryable:value.retryable === true};
  if (value.kind === "downloading") {
    const {received,total}=value;
    if (typeof received !== "number" || typeof total !== "number" || !Number.isSafeInteger(received) || !Number.isSafeInteger(total) ||
        received < 0 || total <= 0 || received > total || total > 512*1024*1024) return null;
    return {kind:"downloading",releaseId,received,total,revision};
  }
  return null;
}
export function createNativeUpdates({android,port,onBusy=()=>{}}: {android: boolean; port: NativeUpdatePort; onBusy?: (busy: boolean)=>void}) {
  let snapshot: AppUpdateState={kind:"idle",revision:0};
  let listener: {remove():Promise<void>} | null=null;
  let connecting: Promise<void> | null=null;
  let command=false;
  let authoritativeBusy=false;
  const subscribers=new Set<()=>void>();
  function receive(raw: unknown, authoritative=true) {
    const next=parseUpdateState(raw);
    if (!next || next.revision < snapshot.revision) return;
    // Equal-revision native truth supersedes a locally synthesized failure:
    // an injected failure at revision N must not pin the UI until the native
    // revision advances, or a legit ready/retry event at N is dropped.
    if (authoritative) {
      snapshot=next;
      authoritativeBusy=["downloading","verifying","installing"].includes(next.kind);
    } else {
      // Local action error: display it, but do not write it into the
      // authoritative revision or busy state.
      snapshot={kind:"failed",releaseId:(next as {releaseId?:string}).releaseId ?? "",code:(next as {code?:string}).code ?? "unavailable",retryable:(next as {retryable?:boolean}).retryable ?? true,revision:next.revision} as AppUpdateState;
    }
    onBusy(command || authoritativeBusy);
    for (const subscriber of subscribers) subscriber();
  }
  async function action(run:()=>Promise<unknown>,releaseId: string) {
    if (!android || command) return;
    command=true;onBusy(true);
    try { receive(await run()); }
    catch { receive({kind:"failed",releaseId,code:"unavailable",retryable:true,revision:snapshot.revision},false); }
    finally { command=false;onBusy(authoritativeBusy); }
  }
  return {
    getSnapshot:()=>snapshot,
    subscribe(fn:()=>void) { subscribers.add(fn);return()=>{subscribers.delete(fn);}; },
    async connect() {
      if (!android || listener) return;
      connecting ??= (async()=>{
        try { listener=await port.addListener("updateState",receive);receive(await port.getState()); }
        catch { /* A missing old-build bridge is unavailable, not installation proof. */ }
        finally { connecting=null; }
      })();
      await connecting;
    },
    async disconnect() { await connecting;await listener?.remove();listener=null;onBusy(false); },
    async refresh() { if (android) {try {receive(await port.getState());} catch {/* retain last known truth */}} },
    async download(release: AndroidRelease, installed: Installation | null) {
      if (!android || !installed || !selectInstallableRelease({releases:[release]},installed)) return;
      const artifact=selectArtifact(release,installed);
      if (!artifact) return;
      await action(()=>port.startDownload({releaseId:release.id,artifact,expectedVersionCode:release.versionCode,expectedVersionName:release.versionName}),release.id);
    },
    async install() {
      if (!("releaseId" in snapshot) || !["ready","needs-permission","needs-confirmation"].includes(snapshot.kind)) return;
      const releaseId=snapshot.releaseId;
      await action(()=>port.requestInstall({releaseId}),releaseId);
    },
    async openPermission() {
      if (snapshot.kind !== "needs-permission") return;
      const releaseId=snapshot.releaseId;
      await action(()=>port.openPermissionSettings({releaseId}),releaseId);
    },
    async cancel() {
      if (!("releaseId" in snapshot) || ["installed","cancelled","failed"].includes(snapshot.kind)) return;
      const releaseId=snapshot.releaseId;
      await action(()=>port.cancel({releaseId}),releaseId);
    },
  };
}
