// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it } from "vitest";
import { openWebMessagingHistory } from "./indexedDbHistory";
import { createMessagingSession, type MessagingRpc } from "./session";
import { copyConversationProjection } from "./conversationIndex";
import type { MessagingHistory } from "./history";
const id=(n:number)=>`00000000-0000-4000-9700-${String(n).padStart(12,"0")}`;
const scope={accountId:id(1),deviceId:id(11)},peer=id(2),conversation=id(20);
const projection={conversationId:conversation,peerId:peer,mode:"CONNECTED" as const,request:"NONE" as const,requestEpoch:null,ownBlocked:false,ownHidden:false,ownDeclined:false,revision:1};
const handles:MessagingHistory[]=[];
afterEach(()=>{for(const handle of handles.splice(0))handle.close();});
async function setup(rpc:MessagingRpc){const history=await openWebMessagingHistory(scope,{indexedDB:new IDBFactory()});handles.push(history);return {history,session:createMessagingSession(scope,history,rpc)};}
it("retains an optional own mute projection through validation and durable cache without accepting a string",async()=>{
 const copy=copyConversationProjection({...projection,ownMuted:true});expect(copy.ownMuted).toBe(true);
 expect(copyConversationProjection(projection)).toEqual(projection);
 expect(()=>copyConversationProjection({...projection,ownMuted:"false"} as never)).toThrow();
 const f=await setup(async()=>null);await f.history.cacheConversation(copy);
 expect((await f.history.listConversations())[0]?.cachedProjection?.ownMuted).toBe(true);
});
it("sets explicit per-user mute through the captured session without sending or rewriting queued messages",async()=>{
 const calls:Array<{action:string;args:unknown}>=[];
 const f=await setup(async input=>{expect(input.accountId).toBe(scope.accountId);expect(input.deviceId).toBe(scope.deviceId);calls.push({action:input.action,args:input.args});return input.args.muted;});
 await f.history.enqueueOutgoing({id:id(30),conversationId:conversation,authorId:scope.accountId,recipientId:peer,body:"Keep my draft message"});
 await f.session.setMuted(conversation,true);await f.session.setMuted(conversation,false);
 expect(calls).toEqual([{action:"MUTE",args:{conversationId:conversation,muted:true}},{action:"MUTE",args:{conversationId:conversation,muted:false}}]);
 expect((await f.history.listOutbox())[0]?.status).toBe("QUEUED");expect((await f.history.getMessage(id(30)))?.body).toBe("Keep my draft message");
});
it("refuses malformed mute input and mismatched acknowledgement",async()=>{
 const calls:string[]=[];const f=await setup(async input=>{calls.push(input.action);return false;});
 await expect(f.session.setMuted(conversation,"true" as never)).rejects.toThrow();expect(calls).toEqual([]);
 await expect(f.session.setMuted(conversation,true)).rejects.toThrow(/response/i);
});
it("aborts mute and refuses late completion after the captured account session closes",async()=>{
 let finish:(value:unknown)=>void=()=>{};let signal:AbortSignal|undefined;let entered!:()=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const f=await setup(input=>{signal=input.signal;entered();return new Promise(resolve=>{finish=resolve;});});
 const work=f.session.setMuted(conversation,true);
 // The canonical session awaits admission before the RPC, so wait for the
 // request to actually start rather than assuming a synchronous call.
 await started;
 f.session.close();expect(signal?.aborted).toBe(true);finish(true);
 await expect(work).rejects.toThrow(/closed/i);await expect(f.session.setMuted(conversation,false)).rejects.toThrow(/closed/i);
});
