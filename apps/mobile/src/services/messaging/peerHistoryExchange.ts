import { createPeerTransfer, type PeerTransferChannel } from "./peerTransfer";
import { exportPeerHistory, importPeerHistory, type HistoryCandidate, type PeerHistoryScope } from "./peerHistory";
import { normaliseSnapshot } from "./backup";
import type { MessagingHistory } from "./history";

/** One already-authenticated conversation channel. Incoming/outgoing transfers
 * have independent slots: both devices can offer older bodies simultaneously.
 * COMPLETE only ends this inventory scan; it never certifies a server prefix. */
export async function exchangePeerHistory(scope: PeerHistoryScope, channel: PeerTransferChannel, ports: {
  signal: AbortSignal; history: MessagingHistory;
  check(): Promise<boolean>;
  authority(candidates: HistoryCandidate[]): Promise<unknown>;
  beforeImport(): Promise<void>;
  onImport(): void | Promise<void>;
}): Promise<void> {
  let resolve!:()=>void,reject!:(e:Error)=>void,complete=false;
  const remoteComplete=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
  void remoteComplete.catch(()=>undefined);
  const failed=()=>reject(new Error("History exchange unavailable"));
  const aborted=()=>failed();
  ports.signal.addEventListener("abort",aborted,{once:true});
  const timeout=setTimeout(failed,120_000);
  const lane=createPeerTransfer(channel,{signal:ports.signal,onFailure:failed,
    authorize:async entry=>entry.kind==="history" && entry.conversationId===scope.conversationId && await ports.check(),
    commit:async(entry,bytes)=>{
      if(entry.kind!=="history" || entry.conversationId!==scope.conversationId)throw new Error("History scope changed");
      await importPeerHistory(scope,bytes,{signal:ports.signal,authority:ports.authority,importSnapshot:async snapshot=>{
        await ports.beforeImport();ports.signal.throwIfAborted();
        if(!await ports.check())throw new Error("History authority changed");
        await ports.history.importSnapshot(normaliseSnapshot(snapshot));ports.signal.throwIfAborted();
        await ports.onImport();
      }});
    },
    onControl:(type,input)=>{
      if(type!=="HISTORY_COMPLETE")return false;
      const value=input as Record<string,unknown>;
      if(complete || Object.keys(value).length!==4 || value.version!==1 || value.conversationId!==scope.conversationId || value.epoch!==scope.epoch)return false;
      complete=true;resolve();return true;
    },
  });
  try{
    await exportPeerHistory(scope,{signal:ports.signal,messages:()=>ports.history.listMessages(scope.conversationId),authority:ports.authority,
      send:async bytes=>{
        const hash=await crypto.subtle.digest("SHA-256",bytes);
        const sha256=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("");
        await lane.send({version:1,transferId:crypto.randomUUID(),conversationId:scope.conversationId,kind:"history",byteSize:bytes.byteLength,sha256},bytes);
      }});
    channel.send(JSON.stringify({version:1,type:"HISTORY_COMPLETE",conversationId:scope.conversationId,epoch:scope.epoch}));
    await remoteComplete;ports.signal.throwIfAborted();
    // Caller owns channel teardown (after both completion controls can drain).
  } catch(error){lane.close();throw error;}
  finally{clearTimeout(timeout);ports.signal.removeEventListener("abort",aborted);}
}
