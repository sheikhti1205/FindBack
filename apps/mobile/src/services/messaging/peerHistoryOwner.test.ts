// @vitest-environment node
import { describe,expect,it } from "vitest";
import { createPeerHistoryOwner } from "./peerHistoryOwner";
import { IDBFactory } from "fake-indexeddb";
import { openWebMessagingHistory } from "./indexedDbHistory";
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,"0")}`;
describe("one foreground peer discovery owner",()=>{
 it("coalesces incoming polls and cancels account-switch work before discovery",async()=>{
  const history=await openWebMessagingHistory({accountId:id(1),deviceId:id(2)},{indexedDB:new IDBFactory()});
  const controller=new AbortController();let pendingResolve!:(v:unknown)=>void;const calls:string[]=[];
  const owner=createPeerHistoryOwner({accountId:id(1),deviceId:id(2)},history,{signal:controller.signal,backendUrl:"https://peer.example.test",
   active:()=>true,rpc:async(action)=>{calls.push(action);return new Promise(resolve=>{pendingResolve=resolve;});},
   authority:async()=>[],signPeer:async()=>{throw new Error("must not sign");},beforeImport:async()=>{},onImport:()=>{}});
  try{
   const first=owner.poll(),second=owner.poll();expect(calls).toEqual(["PENDING"]);
   controller.abort();pendingResolve([]);await Promise.all([first,second]);expect(calls).toEqual(["PENDING"]);
   await owner.poll();expect(calls).toHaveLength(1);
  }finally{owner.close();await history.close();}
 });
});
