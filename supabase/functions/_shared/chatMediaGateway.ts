export const MAX_BYTES = 20971520;
const MARGIN_MS = 120_000;
const ATTEMPT_MS = 90_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Mime = "image/jpeg" | "image/png" | "image/webp";
export interface Target { id: string; generation: string; bucket: string; objectKey: string; expiresAt: string }
export interface Assertions { sha256: string; mime: Mime; bytes: number; width: number; height: number }
export interface GatewayPorts {
  reserve(actor: string, messageId: string, attachmentId: string, signal: AbortSignal): Promise<void>;
  uploadTarget(actor: string, attachmentId: string, signal: AbortSignal): Promise<unknown>;
  write(target: Target, bytes: Uint8Array, signal: AbortSignal): Promise<"written" | "exists">;
  readBack(target: Target, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  commit(target: Target, assertions: Assertions, signal: AbortSignal): Promise<void>;
}
function image(b: Uint8Array): { mime: Mime; width: number; height: number } {
  const ascii = (i: number, s: string) => [...s].every((c,j) => b[i+j] === c.charCodeAt(0));
  const be16 = (i: number) => b[i]! * 256 + b[i+1]!;
  const be32 = (i: number) => (b[i]! * 16777216 + b[i+1]! * 65536 + b[i+2]! * 256 + b[i+3]!);
  const le24 = (i: number) => b[i]! + b[i+1]! * 256 + b[i+2]! * 65536;
  let mime: Mime; let width = 0; let height = 0;
  if (b.length >= 33 && b[0] === 137 && ascii(1,"PNG\r\n\x1a\n") && be32(8) === 13 && ascii(12,"IHDR")) {
    mime = "image/png"; width = be32(16); height = be32(20);
    if (![1,2,4,8,16].includes(b[24]!) || ![0,2,3,4,6].includes(b[25]!) || b[26] !== 0 || b[27] !== 0 || b[28]! > 1) throw Error();
    let crc=0xffffffff; for (let i=12;i<29;i++) { crc^=b[i]!; for(let n=0;n<8;n++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); } if (((crc^0xffffffff)>>>0)!==be32(29)) throw Error();
  } else if (b.length >= 12 && b[0] === 255 && b[1] === 216) {
    mime = "image/jpeg"; let i=2;
    while (i+4 <= b.length) {
      if (b[i++] !== 255) throw Error();
      while (b[i] === 255) i++;
      const marker=b[i++]; if (marker === 217 || marker === 218 || marker === undefined) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (i+2>b.length) throw Error(); const len=be16(i); if (len<2 || i+len>b.length) throw Error();
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) { if (len<8) throw Error(); height=be16(i+3); width=be16(i+5); break; }
      i+=len;
    }
  } else if (b.length >= 30 && ascii(0,"RIFF") && ascii(8,"WEBP")) {
    mime = "image/webp"; const size = b[4]! + b[5]!*256 + b[6]!*65536 + b[7]!*16777216;
    const chunkSize=b[16]!+b[17]!*256+b[18]!*65536+b[19]!*16777216;
    if (size+8 !== b.length || 20+chunkSize+(chunkSize%2)>b.length) throw Error();
    if (ascii(12,"VP8X")) { if (b.length<30 || b[16]!==10 || b[17]!==0 || b[18]!==0 || b[19]!==0) throw Error(); width=1+le24(24); height=1+le24(27); }
    else if (ascii(12,"VP8 ")) { if (b.length<30 || b[23]!==157 || b[24]!==1 || b[25]!==42) throw Error(); width=(b[26]!+b[27]!*256)&16383; height=(b[28]!+b[29]!*256)&16383; }
    else if (ascii(12,"VP8L")) { if (b[20]!==47) throw Error(); const bits=(b[21]! | b[22]!<<8 | b[23]!<<16 | b[24]!<<24)>>>0; width=(bits&16383)+1; height=((bits>>>14)&16383)+1; if (bits>>>29) throw Error(); }
    else throw Error();
  } else throw Error();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width<1 || height<1 || width>8192 || height>8192) throw Error();
  return {mime,width,height};
}
async function hash(bytes: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", bytes.slice()); return Array.from(new Uint8Array(digest), x=>x.toString(16).padStart(2,"0")).join(""); }
function targetOf(raw: unknown, id: string): Target {
  if (!raw || typeof raw !== "object") throw Error(); const t=raw as Record<string, unknown>;
  if (t.id!==id || t.bucket!=="findback-chat-media" || typeof t.generation!=="string" || !UUID.test(t.generation) || typeof t.objectKey!=="string" || !t.objectKey.startsWith("attachments/") || !UUID.test(t.objectKey.slice(12)) || typeof t.expiresAt!=="string" || !Number.isFinite(Date.parse(t.expiresAt))) throw Error();
  return {id, bucket:t.bucket, generation:t.generation, objectKey:t.objectKey, expiresAt:t.expiresAt};
}
async function abortable<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  signal.throwIfAborted(); let off=()=>{};
  const aborted=new Promise<never>((_,reject)=>{ const f=()=>reject(Error()); signal.addEventListener("abort",f,{once:true}); off=()=>signal.removeEventListener("abort",f); });
  try { return await Promise.race([fn(),aborted]); } finally { off(); }
}
export async function uploadChatMedia(io: GatewayPorts, input: { actor: string; messageId: string; attachmentId: string; bytes: Uint8Array; declaredMime: string }, options: { signal?: AbortSignal; now?: () => number } = {}): Promise<{ status: "attached"; attachmentId: string } & Assertions | { status: "invalid" | "retry" }> {
  const now=options.now ?? Date.now; const controller=new AbortController(); const signal=AbortSignal.any([controller.signal,...(options.signal?[options.signal]:[])]); let deadline=now()+ATTEMPT_MS; let timer=setTimeout(()=>controller.abort(),ATTEMPT_MS);
  const check=()=>{ signal.throwIfAborted(); if (now()>=deadline) { controller.abort(); throw Error(); } };
  let assertions: Assertions;
  try {
    if (input.bytes.length<1 || input.bytes.length>MAX_BYTES) throw Error();
    const info=image(input.bytes); if (input.declaredMime.toLowerCase().trim()!==info.mime) throw Error();
    assertions={...info, bytes:input.bytes.length, sha256:await abortable(signal,()=>hash(input.bytes))};
  } catch { clearTimeout(timer); controller.abort(); return {status:"invalid"}; }
  try {
    check(); await abortable(signal,()=>io.reserve(input.actor,input.messageId,input.attachmentId,signal)); check();
    const target=targetOf(await abortable(signal,()=>io.uploadTarget(input.actor,input.attachmentId,signal)),input.attachmentId); check();
    const leaseDeadline=Date.parse(target.expiresAt)-MARGIN_MS; if (leaseDeadline<=now()) throw Error(); deadline=Math.min(deadline,leaseDeadline);
    clearTimeout(timer); timer=setTimeout(()=>controller.abort(),Math.max(0,deadline-now())); check();
    await abortable(signal,()=>io.write(target,input.bytes,signal)); check();
    const stream=await abortable(signal,()=>io.readBack(target,signal)); check(); const reader=stream.getReader(); const copy=new Uint8Array(assertions.bytes); let offset=0;
    try { for (;;) { const part=await abortable(signal,()=>reader.read()); check(); if (part.done) break; if (!(part.value instanceof Uint8Array) || offset+part.value.length>copy.length) throw Error(); copy.set(part.value,offset); offset+=part.value.length; } }
    finally { void reader.cancel().catch(()=>{}); reader.releaseLock(); }
    if (offset!==copy.length || await abortable(signal,()=>hash(copy))!==assertions.sha256) throw Error(); check();
    await abortable(signal,()=>io.commit(target,assertions,signal)); return {status:"attached",attachmentId:input.attachmentId,...assertions};
  } catch { return {status:"retry"}; } finally { clearTimeout(timer); controller.abort(); }
}
