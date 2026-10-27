// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { MailboxEnvelope } from "./history";
import { openSqliteMessagingHistory, type SqliteDriver } from "./sqliteHistory";

const A="00000000-0000-4000-8000-000000000001";
const B="00000000-0000-4000-8000-000000000002";
const D="00000000-0000-4000-8000-000000000003";
const M="00000000-0000-4000-8000-000000000004";
const C="00000000-0000-4000-8000-000000000005";
const envelope:MailboxEnvelope={accountId:A,deviceId:D,mailboxId:M,event:{kind:"TEXT",eventId:M,sequence:1,
 message:{id:M,conversationId:C,authorId:B,recipientId:A,body:"Your bag is safe."}}};
let dir:string;
let db:DatabaseSync;
let beforeCommit:(()=>Promise<void>)|null=null;
beforeEach(()=>{
 dir=mkdtempSync(join(tmpdir(),"findback-sqlite-async-"));
 db=new DatabaseSync(join(dir,"history.db")); beforeCommit=null;
});
afterEach(()=>{try{db.close();}catch{/* adapter may close first */} rmSync(dir,{recursive:true,force:true});});
function asyncDriver():SqliteDriver {
 // Every bridge command yields like a Capacitor round-trip, using a REAL DB.
 return {
  exec:async(sql:string)=>{await Promise.resolve(); if(sql==="commit") await beforeCommit?.(); db.exec(sql);},
  all:async(sql:string,params:readonly (string|number|null)[]=[])=>{
   await Promise.resolve(); return db.prepare(sql).all(...params);
  },
  run:async(sql:string,params:readonly (string|number|null)[]=[])=>{
   await Promise.resolve(); return Number(db.prepare(sql).run(...params).changes);
  },
  close:async()=>{await Promise.resolve();db.close();},
 } as unknown as SqliteDriver;
}

it("awaits durable asynchronous SQLite commit before issuing an ACK",async()=>{
 const history=await openSqliteMessagingHistory(asyncDriver(),{accountId:A,deviceId:D});
 let acked=false;
 await history.persistInboundAndAck(envelope,async()=>{
  const reader=new DatabaseSync(join(dir,"history.db"));
  try{expect(reader.prepare("select body from messages").get()).toEqual({body:envelope.event.message.body});}
  finally{reader.close();} acked=true;
 });
 expect(acked).toBe(true); await history.close();
});
it("serializes concurrent asynchronous transactions and preserves idempotency",async()=>{
 const history=await openSqliteMessagingHistory(asyncDriver(),{accountId:A,deviceId:D});
 const message={...envelope.event.message,authorId:A,recipientId:B};
 await Promise.all([history.enqueueOutgoing(message),history.enqueueOutgoing({...message}),history.listOutbox()]);
 expect(await history.listOutbox()).toHaveLength(1);
 const claims=await Promise.all([history.claimNextOutgoing(),history.claimNextOutgoing()]);
 expect(claims.filter(Boolean)).toHaveLength(1);
 await history.close();
});
it("close during a dispatched asynchronous commit never ACKs",async()=>{
 const history=await openSqliteMessagingHistory(asyncDriver(),{accountId:A,deviceId:D});
 let release!:()=>void; let entered!:()=>void;
 const waiting=new Promise<void>(resolve=>{entered=resolve;});
 beforeCommit=async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});};
 let acked=false;
 const pending=history.persistInboundAndAck(envelope,async()=>{acked=true;});
 // Attach rejection immediately so close cannot cause an unhandled rejection.
 const rejected=expect(pending).rejects.toThrow(/closed/i);
 await waiting; const closed=history.close(); release();
 await rejected; await closed;
 expect(acked).toBe(false);
 const reader=new DatabaseSync(join(dir,"history.db"));
 // A native commit already dispatched may complete. Retain it for this account,
 // but do not acknowledge after sign-out; a later scoped replay can ACK safely.
 try{expect(reader.prepare("select count(*) as n from messages").get()).toEqual({n:1});}finally{reader.close();}
});
