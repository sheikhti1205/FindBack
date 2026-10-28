import { strict as assert } from "node:assert";
import { createChatMediaEndpoint } from "./handler.ts";
const env = { url:"https://project.example.invalid", secretKeys:{default:"sb_secret_placeholder"}, publishableKeys:{default:"sb_publishable_placeholder"}, jwks:{keys:[]} };
Deno.test("method and invalid headers fail before transport", async () => { let n=0; const transport: typeof fetch = async () => { n++; throw Error("unexpected"); }; const endpoint=createChatMediaEndpoint(env,transport); assert.equal((await endpoint(new Request("https://example.invalid"))).status,405); assert.equal((await endpoint(new Request("https://example.invalid",{method:"POST"}))).status,400); assert.equal(n,0); });
const id="00000000-0000-4000-8000-000000000001";
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137]);
const key=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
const publicKey=await crypto.subtle.exportKey("jwk",key.publicKey); Object.assign(publicKey,{kid:"unit",alg:"ES256",use:"sig"});
const testEnv={...env,jwks:{keys:[publicKey]}};
const b64=(b: Uint8Array)=>btoa(String.fromCharCode(...b)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
const text=(x: object)=>b64(new TextEncoder().encode(JSON.stringify(x)));
const signing=`${text({alg:"ES256",kid:"unit"})}.${text({sub:id,role:"authenticated",exp:Math.floor(Date.now()/1000)+3600})}`;
const token=`${signing}.${b64(new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},key.privateKey,new TextEncoder().encode(signing))))}`;
const headers={"x-message-id":id,"x-attachment-id":id,"content-type":"image/png",authorization:`Bearer ${token}`};
const request=(h: Record<string,string> = headers)=>new Request("https://example.invalid",{method:"POST",headers:h,body:png.slice()});
function fixture() {
  const calls:string[]=[]; let bytes:Uint8Array=png;
  const transport:typeof fetch=async(input,init)=>{ const req=new Request(input,init); const p=new URL(req.url).pathname; calls.push(`${req.method} ${p}`);
    if(p.endsWith("/findback_reserve_chat_media")) return Response.json(id);
    if(p.endsWith("/findback_chat_media_upload_target")) return Response.json({id,generation:id,bucket:"findback-chat-media",objectKey:`attachments/${id}`,expiresAt:new Date(Date.now()+300000).toISOString()});
    if(p.endsWith("/findback_commit_chat_media")) return new Response(null,{status:204});
    if(p.includes("/storage/") && req.method==="POST") { assert.equal(req.headers.get("x-upsert"),"false"); bytes=new Uint8Array(await req.arrayBuffer()); return Response.json({Key:"private"}); }
    if(p.includes("/storage/") && req.method==="GET") return new Response(bytes.slice());
    throw Error("private-path");
  }; return {calls,transport};
}
Deno.test("verified user uploads through SDK and receives only public metadata",async()=>{ const f=fixture(); const res=await createChatMediaEndpoint(testEnv,f.transport)(request()); const body=await res.text(); assert.equal(res.status,200,body); const value=JSON.parse(body); assert.equal(value.attachmentId,id); assert.equal(value.width,1); assert.equal(value.height,1); assert(!body.includes("attachments/") && !body.includes("generation") && !body.includes("findback-chat-media")); assert.deepEqual(f.calls.map(x=>x.split(" ")[0]),["POST","POST","POST","GET","POST"]); });
Deno.test("unauthenticated caller cannot access storage",async()=>{const f=fixture(); const h={...headers}; delete (h as Record<string,string>).authorization; const res=await createChatMediaEndpoint(testEnv,f.transport)(request(h)); assert.equal(res.status,401); assert.equal(f.calls.length,0); assert(!(await res.text()).includes("attachments/"));});
Deno.test("headers and media type are rejected before transport",async()=>{const f=fixture(); const endpoint=createChatMediaEndpoint(testEnv,f.transport); for (const [h,status] of [[{...headers,"x-message-id":"bad"},400],[{...headers,"content-type":"text/plain"},415],[{...headers,"content-length":"20971521"},413]] as const) { const res=await endpoint(request(h)); assert.equal(res.status,status); assert(!(await res.text()).includes("attachments/")); } assert.equal(f.calls.length,0);});
Deno.test("request abort reaches actual upload and does not commit",async()=>{ const f=fixture(); const c=new AbortController(); let aborted=false; const transport:typeof fetch=(input,init)=>{const req=new Request(input,init); if(req.method==="POST" && new URL(req.url).pathname.includes("/storage/")) return new Promise((_resolve,reject)=>{req.signal.addEventListener("abort",()=>{aborted=true;reject(Error("private"));},{once:true});c.abort();}); return f.transport(input,init);}; const res=await createChatMediaEndpoint(testEnv,transport)(new Request(request(),{signal:c.signal})); assert.equal(res.status,503); assert(aborted); assert(!f.calls.some(x=>x.includes("commit"))); assert(!(await res.text()).includes("private")); });
Deno.test("stream above cap is cancelled without storage access",async()=>{const f=fixture(); let cancelled=false; const stream=new ReadableStream<Uint8Array>({pull(c){c.enqueue(new Uint8Array(1048576));},cancel(){cancelled=true;}}); const req=new Request("https://example.invalid",{method:"POST",headers,body:stream,duplex:"half"} as RequestInit); const res=await createChatMediaEndpoint(testEnv,f.transport)(req); assert.equal(res.status,400); assert(cancelled); assert.equal(f.calls.length,0);});
