import { strict as assert } from "node:assert";
import { createChatWakeEndpoint } from "./handler.ts";

// Synthetic environment only: no deployed credentials, no FCM sender, no accounts.
const env = {
  url: "https://project.example.invalid",
  secretKeys: { default: ["sb", "secret", "placeholder"].join("_") },
  publishableKeys: { default: "sb_publishable_placeholder" },
  jwks: { keys: [] },
};

function assertCors(response: Response) {
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  const methods = (response.headers.get("access-control-allow-methods") ?? "").split(",").map((x) => x.trim());
  assert.deepEqual(methods.sort(), ["GET", "OPTIONS", "POST"]);
  const allowed = (response.headers.get("access-control-allow-headers") ?? "").split(",").map((x) => x.trim().toLowerCase());
  for (const header of ["authorization", "apikey", "content-type", "x-client-info"]) {
    assert(allowed.includes(header), `Missing CORS request header ${header}`);
  }
}

Deno.test("browser preflight is answered instead of 405", async () => {
  const endpoint = createChatWakeEndpoint(env);
  for (const origin of ["https://findbackapp.social", "https://localhost:5173"]) {
    const response = await endpoint(new Request("https://example.invalid", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    }));
    assert.equal(response.status, 204);
    assertCors(response);
    assert.equal(await response.text(), "");
    assert.ok(Number(response.headers.get("access-control-max-age")) > 0);
  }
});

Deno.test("a non-POST method still fails closed but carries CORS", async () => {
  const endpoint = createChatWakeEndpoint(env);
  const response = await endpoint(new Request("https://example.invalid", { method: "GET" }));
  assert.equal(response.status, 405);
  assertCors(response);
  assert.deepEqual(await response.json(), { error: "Method not allowed" });
});

Deno.test("preflight never touches the wake queue or FCM configuration", async () => {
  let calls = 0;
  const endpoint = createChatWakeEndpoint(env);
  const original = globalThis.fetch;
  // Any outbound call during a preflight would mean the handler did real work.
  globalThis.fetch = (() => { calls++; return Promise.reject(Error("unexpected transport")); }) as typeof fetch;
  try {
    await endpoint(new Request("https://example.invalid", { method: "OPTIONS" }));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});

Deno.test("revoked wake caller is denied through USER device admission before the service claim",async()=>{
  const id="00000000-0000-4000-8000-000000000001";
  const key=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
  const publicKey=await crypto.subtle.exportKey("jwk",key.publicKey); Object.assign(publicKey,{kid:"synthetic",alg:"ES256",use:"sig"});
  const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
  const text=(value:object)=>b64(new TextEncoder().encode(JSON.stringify(value)));
  const signing=`${text({alg:"ES256",kid:"synthetic"})}.${text({sub:id,session_id:id,role:"authenticated",exp:Math.floor(Date.now()/1000)+3600})}`;
  const token=`${signing}.${b64(new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},key.privateKey,new TextEncoder().encode(signing))))}`;
  const originalFetch=globalThis.fetch, originalEnv=Deno.env.get; let admissions=0,claims=0;
  Deno.env.get=(name)=>name==="FCM_PROJECT_ID"?"synthetic-project":name==="FIREBASE_SERVICE_ACCOUNT_JSON"?"{}":undefined;
  globalThis.fetch=(input,init)=>{
    const req=new Request(input,init),path=new URL(req.url).pathname;
    if(path.endsWith("findback_device_admission")) { admissions++; assert.equal(req.headers.get("authorization"),`Bearer ${token}`);
      return Promise.resolve(Response.json({code:"42501",message:"Device unavailable"},{status:403})); }
    if(path.endsWith("findback_claim_chat_external_wakes_for_message")) { claims++; return Promise.resolve(Response.json([])); }
    throw Error("Unexpected synthetic route");
  };
  try {
    const response=await createChatWakeEndpoint({...env,jwks:{keys:[publicKey]}})(new Request("https://example.invalid",{
      method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({message_id:id})}));
    assert.equal(response.status,503); assert.equal(admissions,1); assert.equal(claims,0); assertCors(response);
  } finally {globalThis.fetch=originalFetch;Deno.env.get=originalEnv;}
});
