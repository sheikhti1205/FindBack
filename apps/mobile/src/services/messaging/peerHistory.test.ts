// @vitest-environment node
import { describe, expect, it } from "vitest";
import { historyPayloadIdentity, exportPeerHistory, importPeerHistory } from "./peerHistory";
import type { StoredHumanMessage } from "./history";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const accountId=id(1), peerId=id(2), conversationId=id(3), epoch="a".repeat(64);
const message = (n: number): StoredHumanMessage => ({ id:id(100+n),conversationId,authorId:peerId,recipientId:accountId,
 body:`Older ${n}`,messageType:"TEXT",server:{eventId:id(100+n),sequence:n+1},readLocally:true,readByPeer:true,receiptObserved:true });
const scope={accountId,peerAccountId:peerId,conversationId,epoch};
function authority() {
 return async (candidates: Array<{messageId:string;payloadIdentity:string}>) => candidates.map((c,n) => ({
  ...c,conversationId,authorId:peerId,recipientId:accountId,sequence:Number(c.messageId.slice(-12))-99,
  messageType:"TEXT",sentAt:1000+n }));
}
describe("server-authorized peer history bodies", () => {
 it("matches PostgreSQL v2 framing with UTF-8 and exact IEEE754 coordinates", async () => {
  expect(await historyPayloadIdentity({body:"Original é",messageType:"TEXT",contextReportId:null,location:null})).toBe(
   "ab5491462857aef5c3428614cfbf416521b90644acc517b42e40ef1eb00e9882");
  const first=await historyPayloadIdentity({body:"",messageType:"LOCATION",contextReportId:null,location:{lat:23.81030001,lng:90.4125,accuracy:null}});
  const second=await historyPayloadIdentity({body:"",messageType:"LOCATION",contextReportId:null,location:{lat:23.81030002,lng:90.4125,accuracy:null}});
  expect(first).not.toBe(second);
 });
 it("scans every accepted older body, not a receiver maximum sequence; strips private facts/drafts", async () => {
  const rows=Array.from({length:130},(_,n)=>message(n));
  const pending={...message(131),server:undefined};
  const pages:ArrayBuffer[]=[];
  await exportPeerHistory(scope,{signal:new AbortController().signal,messages:async()=>[...rows,pending],authority:authority(),send:async b=>{pages.push(b);}});
  expect(pages).toHaveLength(3);
  const decoded=pages.map(b=>JSON.parse(new TextDecoder().decode(b)));
  expect(decoded.flatMap(p=>p.messages)).toHaveLength(130);
  expect(decoded[0].messages[0].messageId).toBe(rows[0]!.id);
  expect(JSON.stringify(decoded)).not.toMatch(/readLocally|readByPeer|receiptObserved|deletedForMe|clears|serverSequence/);
 });
 it("imports canonical metadata only after body authority; rejects private/forged envelopes", async () => {
  const snapshots:unknown[]=[];
  const port={signal:new AbortController().signal,authority:authority(),importSnapshot:async(s:unknown)=>{snapshots.push(s);}};
  const pages:ArrayBuffer[]=[];
  await exportPeerHistory(scope,{...port,messages:async()=>[message(0)],send:async b=>{pages.push(b);}});
  await importPeerHistory(scope,pages[0]!,port);
  expect(snapshots).toEqual([expect.objectContaining({messages:[expect.objectContaining({id:message(0).id,authorId:peerId,
   recipientId:accountId,serverSequence:1,createdAt:1000,unsentAt:null})],deletedForMe:[],clears:[],tombstones:[]})]);
  const bad=JSON.parse(new TextDecoder().decode(pages[0]!));bad.messages[0].readLocally=true;
  await expect(importPeerHistory(scope,new TextEncoder().encode(JSON.stringify(bad)).buffer,port)).rejects.toThrow();
  expect(snapshots).toHaveLength(1);
  await importPeerHistory(scope,pages[0]!,{...port,authority:async()=>[]});
  expect(snapshots).toHaveLength(1);
 });
 it("cancellation fences a late authority response before durable import", async () => {
  const controller=new AbortController();let imported=false;
  const pages:ArrayBuffer[]=[];
  await exportPeerHistory(scope,{signal:controller.signal,messages:async()=>[message(0)],authority:authority(),send:async b=>{pages.push(b);}});
  await expect(importPeerHistory(scope,pages[0]!,{signal:controller.signal,authority:async c=>{controller.abort();return authority()(c);},
   importSnapshot:async()=>{imported=true;}})).rejects.toThrow();
  expect(imported).toBe(false);
 });
});
