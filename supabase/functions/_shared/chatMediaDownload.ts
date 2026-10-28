const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface DownloadTarget { id:string; bucket:string; objectKey:string; sha256:string; mime:"image/jpeg"|"image/png"|"image/webp"; bytes:number; width:number; height:number; expiresAt:string }
export interface DownloadPorts { readTarget(actor:string,id:string,signal:AbortSignal):Promise<unknown>; download(target:DownloadTarget,signal:AbortSignal):Promise<ReadableStream<Uint8Array>>; now():number }
type Result={status:"served"; bytes:Uint8Array<ArrayBuffer>; mime:DownloadTarget["mime"]}|{status:"not_found"|"expired"|"retry"};
function parse(raw:unknown,id:string):DownloadTarget {
  if (!raw || typeof raw!=="object") throw Error(); const t=raw as Record<string,unknown>;
  if(t.id!==id || t.bucket!=="findback-chat-media" || typeof t.objectKey!=="string" || !t.objectKey.startsWith("attachments/") || !UUID.test(t.objectKey.slice(12)) || typeof t.sha256!=="string" || !/^[0-9a-f]{64}$/.test(t.sha256) || typeof t.mime!=="string" || !["image/jpeg","image/png","image/webp"].includes(t.mime) || typeof t.expiresAt!=="string" || !Number.isFinite(Date.parse(t.expiresAt))) throw Error();
  for(const [name,max] of [["bytes",20971520],["width",8192],["height",8192]] as const) if(typeof t[name]!=="number" || !Number.isInteger(t[name]) || (t[name] as number)<1 || (t[name] as number)>max) throw Error();
  return {id,bucket:t.bucket,objectKey:t.objectKey,sha256:t.sha256,mime:t.mime,bytes:t.bytes,width:t.width,height:t.height,expiresAt:t.expiresAt} as DownloadTarget;
}
async function abortable<T>(s:AbortSignal,fn:()=>Promise<T>):Promise<T> { s.throwIfAborted(); let off=()=>{}; const aborted=new Promise<never>((_,reject)=>{const f=()=>reject(Error());s.addEventListener("abort",f,{once:true});off=()=>s.removeEventListener("abort",f);});try{return await Promise.race([fn(),aborted]);}finally{off();} }
export async function downloadChatMedia(io:DownloadPorts,input:{actor:string;attachmentId:string},options:{signal?:AbortSignal}={}):Promise<Result> {
  const controller=new AbortController(), signal=AbortSignal.any([controller.signal,...(options.signal?[options.signal]:[])]); const deadline=io.now()+90000; const timer=setTimeout(()=>controller.abort(),90000);
  const check=()=>{signal.throwIfAborted();if(io.now()>=deadline){controller.abort();throw Error();}};
  try {
    check(); const raw=await abortable(signal,()=>io.readTarget(input.actor,input.attachmentId,signal)); check(); if(raw===null)return {status:"not_found"}; const target=parse(raw,input.attachmentId); if(Date.parse(target.expiresAt)<=io.now())return {status:"expired"};
    const stream=await abortable(signal,()=>io.download(target,signal));check();const reader=stream.getReader(),bytes=new Uint8Array(target.bytes);let offset=0;
    try {for(;;){const part=await abortable(signal,()=>reader.read());check();if(part.done)break;if(!(part.value instanceof Uint8Array)||offset+part.value.length>bytes.length){controller.abort();throw Error();} bytes.set(part.value,offset);offset+=part.value.length;}} finally {void reader.cancel().catch(()=>{});reader.releaseLock();}
    if(offset!==bytes.length)throw Error();const digest=new Uint8Array(await abortable(signal,()=>crypto.subtle.digest("SHA-256",bytes)));check();if(Array.from(digest,x=>x.toString(16).padStart(2,"0")).join("")!==target.sha256)throw Error();if(Date.parse(target.expiresAt)<=io.now())return {status:"expired"};return {status:"served",bytes,mime:target.mime};
  } catch {return {status:"retry"};} finally {clearTimeout(timer);controller.abort();}
}
