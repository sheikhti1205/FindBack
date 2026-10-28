import { withSupabase, type SupabaseEnv } from "npm:@supabase/server@1.6.0";
import { MAX_BYTES, uploadChatMedia, type GatewayPorts } from "../_shared/chatMediaGateway.ts";
import { downloadChatMedia } from "../_shared/chatMediaDownload.ts";

type Database = { public: { Tables: Record<string, never>; Views: Record<string, never>; Functions: {
  findback_reserve_chat_media: { Args: { p_account_id: string; p_message_id: string; p_attachment_id: string }; Returns: string };
  findback_chat_media_upload_target: { Args: { p_actor: string; p_attachment_id: string }; Returns: unknown };
  findback_read_chat_media: { Args: { p_actor: string; p_attachment_id: string }; Returns: unknown };
  findback_commit_chat_media: { Args: { p_actor: string; p_attachment_id: string; p_generation: string; p_object_key: string; p_sha: string; p_mime: string; p_bytes: number; p_width: number; p_height: number }; Returns: undefined };
}; Enums: Record<string, never>; CompositeTypes: Record<string, never> } };
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const respond=(body: object,status: number) => Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
async function bodyBytes(request: Request, signal: AbortSignal): Promise<Uint8Array> {
  if (!request.body) throw Error(); const reader=request.body.getReader(); const chunks: Uint8Array[]=[]; let total=0;
  let onAbort=()=>{};
  const aborted=new Promise<never>((_,reject)=>{ onAbort=()=>reject(Error()); signal.addEventListener("abort",onAbort,{once:true}); });
  try {
    for (;;) { signal.throwIfAborted(); const part=await Promise.race([reader.read(),aborted]); if (part.done) break; total+=part.value.length; if (total>MAX_BYTES) throw Error(); chunks.push(part.value); }
    const result=new Uint8Array(total); let pos=0; for (const chunk of chunks) { result.set(chunk,pos); pos+=chunk.length; } return result;
  } finally { signal.removeEventListener("abort",onAbort); void reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
export function createChatMediaEndpoint(env?: Partial<SupabaseEnv>, transport: typeof fetch = fetch) {
  let active=false;
  return async (request: Request): Promise<Response> => {
    if (request.method!=="POST" && request.method!=="GET") return respond({error:"Method not allowed"},405);
    const messageId=request.headers.get("x-message-id"), attachmentId=request.headers.get("x-attachment-id"), mime=request.headers.get("content-type")?.trim().toLowerCase();
    if (!attachmentId || !UUID.test(attachmentId) || (request.method==="POST" && (!messageId || !UUID.test(messageId)))) return respond({error:"Invalid request"},400);
    if (request.method==="POST" && (!mime || !["image/jpeg","image/png","image/webp"].includes(mime))) return respond({error:"Invalid request"},415);
    const length=request.headers.get("content-length"); if (request.method==="POST" && length!==null && (!/^\d+$/.test(length) || Number(length)>MAX_BYTES)) return respond({error:"Invalid request"},413);
    const controller=new AbortController(); const signal=AbortSignal.any([controller.signal,request.signal]); const timer=setTimeout(()=>controller.abort(),90_000); let activeSignal=signal;
    const boundedFetch: typeof fetch=(input,init)=>transport(input,{...init,signal:AbortSignal.any([signal,activeSignal,...(init?.signal?[init.signal]:[]),...(input instanceof Request?[input.signal]:[])])});
    const handler=withSupabase<Database>({auth:"user",cors:false,env,errors:{detailed:false},supabaseOptions:{global:{fetch:boundedFetch}}},async (req,ctx)=>{
      if(req.method==="GET") {
        const actor=ctx.userClaims?.id; if(!actor)return respond({error:"Unauthorized"},401);
        const admin=ctx.supabaseAdmin;
        const result=await downloadChatMedia({now:Date.now,async readTarget(_actor,id,s){activeSignal=s;const {data,error}=await admin.rpc("findback_read_chat_media",{p_actor:actor,p_attachment_id:id}).abortSignal(s);if(error)throw Error();return data;},async download(t,s){activeSignal=s;const {data,error}=await admin.storage.from(t.bucket).download(t.objectKey,{}, {signal:s,cache:"no-store"}).asStream();if(error || !data)throw Error();return data;}},{actor,attachmentId},{signal});
        if(result.status!=="served")return respond({error:result.status==="retry"?"Unavailable":"Not found"},result.status==="retry"?503:404);
        return new Response(result.bytes,{status:200,headers:{"Content-Type":result.mime,"Content-Length":String(result.bytes.length),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Disposition":"inline"}});
      }
      if (active) return respond({error:"Unavailable"},503); active=true;
      try {
        const actor=ctx.userClaims?.id; if (!actor) return respond({error:"Unauthorized"},401);
        let bytes: Uint8Array; try { bytes=await bodyBytes(req,signal); } catch { return respond({error:"Invalid request"},400); }
        const user=ctx.supabase, admin=ctx.supabaseAdmin;
        const io: GatewayPorts={
          async reserve(_actor, msg, id, s) { activeSignal=s; const {error}=await user.rpc("findback_reserve_chat_media",{p_account_id:actor,p_message_id:msg,p_attachment_id:id}).abortSignal(s); if (error) throw Error(); },
          async uploadTarget(_actor,id,s) { activeSignal=s; const {data,error}=await admin.rpc("findback_chat_media_upload_target",{p_actor:actor,p_attachment_id:id}).abortSignal(s); if (error) throw Error(); return data; },
          async write(t,b,s) { activeSignal=s; const {error}=await admin.storage.from(t.bucket).upload(t.objectKey,b.slice(),{upsert:false,contentType:mime,cacheControl:"0"}); if (error) { if (error.status===409) return "exists"; throw Error(); } return "written"; },
          async readBack(t,s) { activeSignal=s; const {data,error}=await admin.storage.from(t.bucket).download(t.objectKey,{}, {signal:s,cache:"no-store"}).asStream(); if (error || !data) throw Error(); return data; },
          async commit(t,a,s) { activeSignal=s; const {error}=await admin.rpc("findback_commit_chat_media",{p_actor:actor,p_attachment_id:t.id,p_generation:t.generation,p_object_key:t.objectKey,p_sha:a.sha256,p_mime:a.mime,p_bytes:a.bytes,p_width:a.width,p_height:a.height}).abortSignal(s); if (error) throw Error(); },
        };
        const result=await uploadChatMedia(io,{actor,messageId:messageId!,attachmentId,bytes,declaredMime:mime!},{signal});
        if (result.status!=="attached") return respond({error:result.status==="invalid"?"Invalid request":"Unavailable"},result.status==="invalid"?400:503);
        const {status: _status,...body}=result; return respond(body,200);
      } finally { active=false; }
    });
    let onAbort=()=>{}; const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(Error()); signal.addEventListener("abort",onAbort,{once:true});});
    try { signal.throwIfAborted(); const response=await Promise.race([handler(request),aborted]); if (!response.ok) return respond({error:response.status===401?"Unauthorized":"Unavailable"},response.status); return response; }
    catch { return respond({error:"Unavailable"},503); }
    finally { signal.removeEventListener("abort",onAbort); clearTimeout(timer); controller.abort(); }
  };
}
