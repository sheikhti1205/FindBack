// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { openWebMessagingHistory } from "./indexedDbHistory";
import type { HumanMessage, MailboxEnvelope, MessagingHistory } from "./history";
import { createMessagingSession, type MessagingRpc } from "./session";

const A="00000000-0000-4000-8000-000000000001";
const B="00000000-0000-4000-8000-000000000002";
const DEVICE="00000000-0000-4000-8000-000000000003";
const ID="00000000-0000-4000-8000-000000000004";
const CONV="00000000-0000-4000-8000-000000000005";
const MAIL="00000000-0000-4000-8000-000000000006";
const scope={accountId:A,deviceId:DEVICE};
const message:HumanMessage={id:ID,conversationId:CONV,authorId:A,recipientId:B,body:"I found your bag."};
const handles:MessagingHistory[]=[];
afterEach(()=>{ for(const h of handles.splice(0)) h.close(); });
async function setup() {
 const factory=new IDBFactory();
 const history=await openWebMessagingHistory(scope,{indexedDB:factory}); handles.push(history);
 let envelope:MailboxEnvelope|null=null;
 let online=true; let currentAccount=A; let acknowledged=false;
 const rpc:MessagingRpc=async(input)=>{
  if(input.accountId!==currentAccount) throw new Error("Session changed");
  if(!online) throw new Error("Offline");
  if(input.action==="SEND") {
   envelope={...scope,mailboxId:MAIL,event:{kind:"TEXT",eventId:ID,sequence:1,message}};
   return ID;
  }
  if(input.action==="SYNC") return envelope?[envelope]:[];
  if(input.action==="ACK") {
   // A fake server is allowed to discard only after real local storage is readable.
   expect((await history.getMessage(ID))?.server?.eventId).toBe(ID);
   acknowledged=true; envelope=null; return null;
  }
  if(input.action==="CREATE") return CONV;
  return null;
 };
 return {history,factory,rpc,session:createMessagingSession(scope,history,rpc),
  setOnline:(v:boolean)=>{online=v;}, switchAccount:()=>{currentAccount=B;},
  acked:()=>acknowledged, replaceEnvelope:(value:MailboxEnvelope)=>{envelope=value;}};
}

describe("human messaging session delivery",()=>{
 it("queues durably, sends, persists its authoritative echo, then ACKs",async()=>{
  const f=await setup(); await f.session.start("web");
  expect(await f.session.request(B)).toBe(CONV);
  await f.session.send(message);
  expect(await f.history.listOutbox()).toHaveLength(1);
  await f.session.flush();
  expect(f.acked()).toBe(true);
  expect(await f.history.listOutbox()).toEqual([]);
  expect((await f.history.getMessage(ID))?.body).toBe(message.body);
 });
 it("retains failed sends across reopen and retries the same message identity",async()=>{
  const f=await setup(); await f.session.send(message); f.setOnline(false);
  await expect(f.session.flush()).rejects.toThrow("Offline");
  expect((await f.history.listOutbox())[0]?.status).toBe("FAILED");
  f.session.close();
  const reopened=await openWebMessagingHistory(scope,{indexedDB:f.factory}); handles.push(reopened);
  expect((await reopened.listOutbox())[0]?.messageId).toBe(ID);
 });
 it("never ACKs a storage failure",async()=>{
  const f=await setup();
  let writable=false;
  const broken:MessagingHistory={...f.history,persistInboundAndAck:async(...args)=>{
   if(!writable) throw new Error("disk full");
   return f.history.persistInboundAndAck(...args);
  }};
  const session=createMessagingSession(scope,broken,f.rpc);
  await session.send(message);
  await expect(session.flush()).rejects.toThrow("disk full");
  expect(f.acked()).toBe(false);
  writable=true;
  // Retry must fetch the committed server echo despite the still-active lease.
  await session.flush();
  expect(f.acked()).toBe(true); expect(await f.history.listOutbox()).toEqual([]);
 });
 it("rejects a foreign-account envelope before persisting or ACKing",async()=>{
  const f=await setup();
  f.replaceEnvelope({...scope,accountId:B,mailboxId:MAIL,event:{kind:"TEXT",eventId:ID,sequence:1,message}});
  await expect(f.session.sync()).rejects.toThrow();
  expect(await f.history.getMessage(ID)).toBeNull(); expect(f.acked()).toBe(false);
 });
 it("rejects outgoing content attributed to another account",async()=>{
  const f=await setup();
  await expect(f.session.send({...message,authorId:B,recipientId:A})).rejects.toThrow();
  expect(await f.history.listOutbox()).toEqual([]);
 });
 it("the captured server account guard refuses a switched SDK session",async()=>{
  const f=await setup(); await f.session.send(message); f.switchAccount();
  await expect(f.session.flush()).rejects.toThrow("Session changed");
  expect((await f.history.listOutbox())[0]?.status).toBe("FAILED"); expect(f.acked()).toBe(false);
 });
 it("closed sessions cannot dispatch or ACK",async()=>{
  const f=await setup(); f.session.close();
  await expect(f.session.sync()).rejects.toThrow(/closed/i);
  await expect(f.session.request(B)).rejects.toThrow(/closed/i);
  expect(f.acked()).toBe(false);
 });
});
