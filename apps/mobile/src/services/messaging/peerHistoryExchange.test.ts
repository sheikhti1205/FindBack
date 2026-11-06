// @vitest-environment node
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openWebMessagingHistory } from "./indexedDbHistory";
import { exchangePeerHistory } from "./peerHistoryExchange";
import { historyPayloadIdentity } from "./peerHistory";
import { queuePeerChannel } from "./peerChannelQueue";
import type { PeerTransferChannel } from "./peerTransfer";
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,"0")}`;
const accountId=id(1),peerId=id(2),conversationId=id(3),epoch="a".repeat(64);
class Channel extends EventTarget implements PeerTransferChannel {
 readyState="open";ordered=true;maxRetransmits=null;maxPacketLifeTime=null;protocol="norfold-sync-v1";
 binaryType:"arraybuffer"|"blob"="arraybuffer";bufferedAmount=0;bufferedAmountLowThreshold=0;peer!:Channel;
 send(data:string|ArrayBuffer){queueMicrotask(()=>{if(this.peer.readyState==="open")this.peer.dispatchEvent(new MessageEvent("message",{data}));});}
 close(){if(this.readyState==="closed")return;this.readyState="closed";this.dispatchEvent(new Event("close"));this.peer.close();}
}
describe("real durable body recovery through the bounded peer lane",()=>{
 it("fills older holes despite a persisted newer sequence, bidirectionally and without read/state leakage",async()=>{
  const a=await openWebMessagingHistory({accountId,deviceId:id(4)},{indexedDB:new IDBFactory()});
  const b=await openWebMessagingHistory({accountId:peerId,deviceId:id(5)},{indexedDB:new IDBFactory()});
  const rows=Array.from({length:130},(_,n)=>({id:id(100+n),conversationId,authorId:accountId,recipientId:peerId,
   body:`Older message ${n}`,messageType:"TEXT" as const,serverEventId:id(100+n),serverSequence:n+1,
   unsentAt:null,createdAt:1000+n,readByPeer:true}));
  const conversations=[{id:conversationId,lastSequence:130,createdAt:1000,updatedAt:1129}];
  await a.importSnapshot({conversations,messages:rows.slice(0,129),tombstones:[],deletedForMe:[],clears:[]});
  await b.importSnapshot({conversations,messages:rows.slice(129).map(r=>({...r,readByPeer:false,readLocally:true,receiptObserved:true})),tombstones:[],deletedForMe:[],clears:[]});
  const hashes=await Promise.all(rows.map(r=>historyPayloadIdentity({...r,contextReportId:null,location:null})));
  const authority=async(c:Array<{messageId:string;payloadIdentity:string}>)=>c.flatMap(candidate=>{
   const n=rows.findIndex(r=>r.id===candidate.messageId);if(n<0 || hashes[n]!==candidate.payloadIdentity)return [];
   const r=rows[n]!;return [{...candidate,conversationId,authorId:r.authorId,recipientId:r.recipientId,sequence:r.serverSequence,messageType:r.messageType,sentAt:r.createdAt}];
  });
  const first=new Channel(),second=new Channel();first.peer=second;second.peer=first;
  const controller=new AbortController();
  const ca=queuePeerChannel(first,controller.signal),cb=queuePeerChannel(second,controller.signal);
  const ports={signal:controller.signal,check:async()=>true,authority,beforeImport:async()=>{},onImport:()=>{}};
  try {
   const sender=exchangePeerHistory({accountId,peerAccountId:peerId,conversationId,epoch},ca,{...ports,history:a});
   // Early BEGIN is buffered while this peer's content lane is not attached yet.
   await Promise.resolve();await Promise.resolve();
   const receiver=exchangePeerHistory({accountId:peerId,peerAccountId:accountId,conversationId,epoch},cb,{...ports,history:b});
   await Promise.all([sender,receiver]);
   const recovered=await b.listMessages(conversationId);
   expect(recovered).toHaveLength(130);expect((await a.listMessages(conversationId))).toHaveLength(130);
   expect(recovered[0]!.id).toBe(rows[0]!.id);expect(recovered[0]!.readLocally).not.toBe(true);
   expect(await b.listOutbox()).toEqual([]);expect(await b.getConversationCheckpoint(conversationId)).toBeNull();
  } finally {controller.abort();await a.close();await b.close();}
 });
});
