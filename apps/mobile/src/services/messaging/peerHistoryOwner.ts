import type { MessagingHistory, MessagingScope } from "./history";
import { browserPeerConnection, openPeerSession, type PeerSessionPorts, type PeerSession } from "./peerSession";
import { exchangePeerHistory } from "./peerHistoryExchange";
import type { HistoryCandidate, PeerHistoryScope } from "./peerHistory";
import { uuid } from "./validation";

interface Target {peerAccountId:string;targetDeviceId:string;conversationId:string;epoch:string;sessionId?:string}
function targets(input:unknown,incoming=false):Target[]{
  if(!Array.isArray(input) || input.length>(incoming?16:40))throw new Error("Peer discovery unavailable");
  return input.map(v=>{
    if(!v || typeof v!=="object" || Array.isArray(v) || Object.keys(v).length!==(incoming?5:4)
      || typeof v.epoch!=="string" || !/^[0-9a-f]{64}$/.test(v.epoch))throw new Error("Peer discovery unavailable");
    return {peerAccountId:uuid(v.peerAccountId),targetDeviceId:uuid(v.targetDeviceId),conversationId:uuid(v.conversationId),epoch:v.epoch,
      ...(incoming?{sessionId:uuid(v.sessionId)}:{})};
  });
}
/** Canonical runtime owns one foreground discovery scheduler, at most two
 * admitted conversation channels. Every job uses the same Auth/session signer
 * and durable history. No detached writer, stored grant or body-bearing signal.
 * Silent fallback preserves ordinary mailbox/Drive behavior when no peer exists. */
export function createPeerHistoryOwner(scope: MessagingScope, history: MessagingHistory, ports: {
  signal:AbortSignal;backendUrl:string;active():boolean;
  rpc(action:string,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>;
  authority(sessionId:string,candidates:HistoryCandidate[],signal:AbortSignal):Promise<unknown>;
  signPeer:PeerSessionPorts["signPeer"];
  beforeImport():Promise<void>;onImport():void|Promise<void>;
  connection?:PeerSessionPorts["connection"];
}){
  const lifetime=new AbortController();
  const jobs=new Map<string,AbortController>(),retryAfter=new Map<string,number>();
  let timer:ReturnType<typeof setTimeout>|null=null,closed=false,started=false,pending:Promise<void>|null=null;
  let discoveryAt=0,conversationOffset=0;
  const key=(t:Target)=>`${t.peerAccountId}:${t.targetDeviceId}:${t.conversationId}`;
  const close=()=>{
    if(closed)return;closed=true;lifetime.abort();if(timer)clearTimeout(timer);timer=null;
    for(const job of jobs.values())job.abort();jobs.clear();ports.signal.removeEventListener("abort",close);
  };
  ports.signal.addEventListener("abort",close,{once:true});if(ports.signal.aborted)close();
  function launch(target:Target){
    const id=key(target);
    if(closed || jobs.size>=2 || jobs.has(id) || (retryAfter.get(id)??0)>Date.now())return;
    const job=new AbortController();jobs.set(id,job);
    const abort=()=>job.abort();lifetime.signal.addEventListener("abort",abort,{once:true});
    const deadline=setTimeout(abort,125_000);
    void(async()=>{
      let peer:PeerSession|undefined;
      try{
        const live=()=>job.signal.throwIfAborted();
        const rpc=(action:string,args:Record<string,unknown>)=>ports.rpc(action,args,job.signal);
        peer=await openPeerSession({...scope,...target},{signal:job.signal,backendUrl:ports.backendUrl,
          devices:async()=>[],connection:ports.connection??browserPeerConnection,signPeer:ports.signPeer,
          signaling:{open:()=>rpc("OPEN",{conversationId:target.conversationId,epoch:target.epoch,peerAccountId:target.peerAccountId,targetDeviceId:target.targetDeviceId}),
            read:(sessionId,after)=>rpc("READ",{sessionId,after}),write:(sessionId,type,data)=>rpc("WRITE",{sessionId,type,data}),
            close:async(sessionId)=>{await ports.rpc("CLOSE",{sessionId},new AbortController().signal);}},
          // A content-free scoped handshake, not an account-wide manifest/head.
          manifest:async()=>({version:1,...scope,generatedAt:Date.now(),conversations:[],stateSequence:0,media:[]}),
          known:()=>({conversations:[target.conversationId],media:[]})});
        live();const sessionId=peer.sessionId;
        const historyScope:PeerHistoryScope={accountId:scope.accountId,...target};
        await exchangePeerHistory(historyScope,peer.channel,{signal:job.signal,history,
          check:async()=>{const r=await rpc("CHECK",{sessionId}) as Record<string,unknown>;live();
            return r.accountId===scope.accountId && r.peerAccountId===target.peerAccountId && r.conversationId===target.conversationId
              && r.epoch===target.epoch && r.sessionId===sessionId;},
          authority:candidates=>ports.authority(sessionId,candidates,job.signal),beforeImport:ports.beforeImport,onImport:ports.onImport});
        retryAfter.set(id,Date.now()+300_000);
        // Both sides awaited durable DONE for every outgoing page. Give the
        // final content-free completion control time to drain before RTC close.
        await new Promise<void>(resolve=>{
          const done=()=>{clearTimeout(grace);job.signal.removeEventListener("abort",done);resolve();};
          const grace=setTimeout(done,1_000);job.signal.addEventListener("abort",done,{once:true});if(job.signal.aborted)done();
        });
      }catch{retryAfter.set(id,Date.now()+20_000);}
      finally{
        peer?.close();job.abort();clearTimeout(deadline);lifetime.signal.removeEventListener("abort",abort);jobs.delete(id);
      }
    })();
  }
  function poll():Promise<void>{
    if(closed || !ports.active())return Promise.resolve();
    if(pending)return pending;
    const work=async()=>{
      try{
        const incoming=targets(await ports.rpc("PENDING",{},lifetime.signal),true);
        lifetime.signal.throwIfAborted();for(const target of incoming)launch(target);
        if(Date.now()<discoveryAt || jobs.size>=2)return;
        discoveryAt=Date.now()+15_000;
        const rows=await history.listConversations();lifetime.signal.throwIfAborted();
        // Walk all conversations over successive polls; never let a failed old
        // device permanently starve other shared conversations.
        for(let n=0;n<Math.min(4,rows.length) && jobs.size<2;n++){
          const conversationId=rows[conversationOffset++%rows.length]!.conversationId;
          const discovered=targets(await ports.rpc("DISCOVER",{conversationId},lifetime.signal));
          lifetime.signal.throwIfAborted();
          for(const target of discovered){
            // Deterministic initiator avoids duplicate opposite OPENs. Both
            // production devices still listen/adopt continuously while active.
            if(`${scope.accountId}:${scope.deviceId}`<`${target.peerAccountId}:${target.targetDeviceId}`)launch(target);
          }
        }
      }catch{/* Optional transport unavailable: no reset, no false ready claim. */}
    };
    pending=work().finally(()=>{pending=null;});return pending;
  }
  function schedule(){
    if(closed || !started || timer)return;
    timer=setTimeout(()=>{timer=null;void poll().finally(schedule);},4_000);
  }
  return {poll,start(){if(closed)return;started=true;void poll().finally(schedule);},
    resume(){discoveryAt=0;if(started)void poll();},close};
}
