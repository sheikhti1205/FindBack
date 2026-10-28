import { strict as assert } from "node:assert";
import { uploadChatMedia, type GatewayPorts } from "./chatMediaGateway.ts";

const id = "00000000-0000-4000-8000-000000000001";
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137]);
const target = () => ({ id, generation: id, bucket: "findback-chat-media", objectKey: `attachments/${id}`, expiresAt: new Date(Date.now() + 300_000).toISOString() });
function fixture() {
  const calls: string[] = []; let data: Uint8Array = png; let t = target();
  const ports: GatewayPorts = {
    reserve: async () => { calls.push("reserve"); },
    uploadTarget: async () => { calls.push("target"); return t; },
    write: async () => { calls.push("write"); return "written"; },
    readBack: async () => { calls.push("read"); return new ReadableStream({ start(c) { c.enqueue(data); c.close(); } }); },
    commit: async () => { calls.push("commit"); },
  };
  return { calls, ports, setBytes: (v: Uint8Array) => data = v, setTarget: (v: ReturnType<typeof target>) => t = v };
}
const run = (p: GatewayPorts, b = png, mime = "image/png", now?: () => number) => uploadChatMedia(p, { actor: id, messageId: id, attachmentId: id, bytes: b, declaredMime: mime }, { now });
Deno.test("ordered verified upload returns no private target", async () => { const f = fixture(); const r = await run(f.ports); assert.equal(r.status, "attached"); assert.deepEqual(f.calls, ["reserve","target","write","read","commit"]); assert(!JSON.stringify(r).includes("attachments/")); assert(!JSON.stringify(r).includes("generation")); });
Deno.test("invalid bytes and mismatch never access storage", async () => { for (const [b,m] of [[png,"image/jpeg"], [new Uint8Array([1,2,3]),"image/png"], [png.slice(0,20),"image/png"], [new Uint8Array(20971521),"image/png"]] as const) { const f = fixture(); assert.notEqual((await run(f.ports,b,m)).status,"attached"); assert(!f.calls.includes("write")); } });
Deno.test("refuses near expiry before storage", async () => { const f=fixture(); f.setTarget({...target(),expiresAt:new Date(Date.now()+119000).toISOString()}); assert.notEqual((await run(f.ports)).status,"attached"); assert(!f.calls.includes("write")); });
Deno.test("deadline crossing write aborts and never commits", async () => { const f=fixture(); let now=Date.now(); f.setTarget({...target(),expiresAt:new Date(now+121000).toISOString()}); f.ports.write=async (_t,_b,signal)=> { now += 2000; assert(!signal.aborted); return "written"; }; assert.notEqual((await run(f.ports,png,"image/png",()=>now)).status,"attached"); assert(!f.calls.includes("commit")); });
Deno.test("readback mismatch and conflict mismatch never commit", async () => { for (const bytes of [png.slice(1),new Uint8Array(png.length)]) { const f=fixture(); f.setBytes(bytes); f.ports.write=async()=>"exists"; assert.notEqual((await run(f.ports)).status,"attached"); assert(!f.calls.includes("commit")); } });
Deno.test("matching conflict is idempotent", async () => { const f=fixture(); f.ports.write=async()=>"exists"; assert.equal((await run(f.ports)).status,"attached"); assert(f.calls.includes("commit")); });
Deno.test("reservation and commit failures fail closed", async () => { const a=fixture(); a.ports.reserve=async()=>{throw Error("private");}; assert.notEqual((await run(a.ports)).status,"attached"); assert(!a.calls.includes("write")); const b=fixture(); b.ports.commit=async()=>{throw Error("private");}; const r=await run(b.ports); assert.notEqual(r.status,"attached"); assert(!JSON.stringify(r).includes("private")); });
Deno.test("deadline aborts a pending write and prevents readback and commit",async()=>{const f=fixture(); let aborted=false; f.setTarget({...target(),expiresAt:new Date(Date.now()+120030).toISOString()}); f.ports.write=async(_t,_b,s)=>await new Promise((_resolve,reject)=>{s.addEventListener("abort",()=>{aborted=true;reject(Error());},{once:true});}); assert.equal((await run(f.ports)).status,"retry"); assert(aborted); assert(!f.calls.includes("read") && !f.calls.includes("commit"));});
Deno.test("unsupported GIF BMP and SVG are rejected",async()=>{for(const s of ["GIF89a","BM","<svg>"]) {const f=fixture(); assert.equal((await run(f.ports,new TextEncoder().encode(s))).status,"invalid"); assert.equal(f.calls.length,0);}});
Deno.test("JPEG and WebP header dimensions are parsed",async()=>{const jpeg=new Uint8Array([255,216,255,192,0,11,8,0,2,0,3,1,1,17,0,255,217]); const webp=new Uint8Array([82,73,70,70,22,0,0,0,87,69,66,80,86,80,56,88,10,0,0,0,0,0,0,0,2,0,0,1,0,0]); for(const [bytes,mime] of [[jpeg,"image/jpeg"],[webp,"image/webp"]] as const) {const f=fixture(); f.setBytes(bytes); const result=await run(f.ports,bytes,mime); assert.equal(result.status,"attached"); if(result.status==="attached") {assert.equal(result.width,3); assert.equal(result.height,2);} }});
Deno.test("corrupt PNG header rejected",async()=>{const f=fixture(); const corrupt=png.slice(); corrupt[29]^=1; assert.equal((await run(f.ports,corrupt)).status,"invalid"); assert.equal(f.calls.length,0);});
