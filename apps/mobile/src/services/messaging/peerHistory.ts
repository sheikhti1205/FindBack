import type { HistorySnapshot, MessageType, SnapshotMessage, StaticLocation, StoredHumanMessage } from "./history";
import { uuid } from "./validation";

export interface PeerHistoryScope { accountId: string; peerAccountId: string; conversationId: string; epoch: string }
export interface HistoryCandidate { messageId: string; payloadIdentity: string }
interface Payload { body: string; messageType: MessageType; contextReportId: string | null; location: StaticLocation | null }
interface WireMessage extends Payload { messageId: string }
type Authority = (candidates: HistoryCandidate[]) => Promise<unknown>;
const MAX_BYTES = 1_048_576;
const unavailable = () => new Error("History could not sync");
const exact = (v: unknown, keys: string[]): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length
    || keys.some(k => !Object.hasOwn(v,k))) throw unavailable();
  return v as Record<string, unknown>;
};
function payload(input: unknown): Payload {
  const v = input as Payload;
  if (typeof v.body !== "string" || v.body.length > 100_000 || !["TEXT","MEDIA","LOCATION"].includes(v.messageType)) throw unavailable();
  const report = v.contextReportId === null ? null : uuid(v.contextReportId);
  if (report && v.messageType !== "TEXT") throw unavailable();
  let location: StaticLocation | null = null;
  if (v.messageType === "LOCATION") {
    const p=exact(v.location,["lat","lng","accuracy"]);
    if (typeof p.lat!=="number" || !Number.isFinite(p.lat) || Math.abs(p.lat)>90
      || typeof p.lng!=="number" || !Number.isFinite(p.lng) || Math.abs(p.lng)>180
      || !(p.accuracy===null || typeof p.accuracy==="number" && Number.isFinite(p.accuracy) && p.accuracy>=0)) throw unavailable();
    location={lat:p.lat,lng:p.lng,accuracy:p.accuracy as number|null};
  } else if (v.location !== null) throw unavailable();
  return {body:v.body,messageType:v.messageType,contextReportId:report,location};
}
function float(value: number | null | undefined): string {
  if (value===null || value===undefined) return "-";
  const bytes=new Uint8Array(8);new DataView(bytes.buffer).setFloat64(0,value,false);
  return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
}
/** Exactly findback_chat_payload_identity v2 (UTF8 octets + network-order float8).
 * Body-only moderation hashes and global sequence watermarks are NOT identity. */
export async function historyPayloadIdentity(input: Payload): Promise<string> {
  const p=payload(input), encode=new TextEncoder();
  const report=p.contextReportId??"";
  const frame=`v2|${encode.encode(p.body).byteLength}:${p.body}|t:${p.messageType}|r:${encode.encode(report).byteLength}:${report}`
    +`|loc:${float(p.location?.lat)},${float(p.location?.lng)},${float(p.location?.accuracy)}`;
  const hash=await crypto.subtle.digest("SHA-256",encode.encode(frame));
  return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("");
}
function live(signal: AbortSignal) { signal.throwIfAborted(); }
async function validate(scope: PeerHistoryScope, messages: WireMessage[], authority: Authority, signal: AbortSignal): Promise<SnapshotMessage[]> {
  live(signal);
  const candidates=await Promise.all(messages.map(async m=>({messageId:m.messageId,payloadIdentity:await historyPayloadIdentity(m)})));
  live(signal);
  const result=await authority(candidates);live(signal);
  if (!Array.isArray(result) || result.length>messages.length) throw unavailable();
  const requested=new Map(candidates.map((c,n)=>[c.messageId,{hash:c.payloadIdentity,message:messages[n]!}]));
  const seen=new Set<string>();
  return result.map(entry=>{
    const r=exact(entry,["messageId","conversationId","authorId","recipientId","sequence","messageType","sentAt","payloadIdentity"]);
    const id=uuid(r.messageId as string), offered=requested.get(id);
    const authorId=uuid(r.authorId as string),recipientId=uuid(r.recipientId as string);
    if (!offered || seen.has(id) || r.conversationId!==scope.conversationId || r.payloadIdentity!==offered.hash
      || r.messageType!==offered.message.messageType || authorId===recipientId
      || ![authorId,recipientId].includes(scope.accountId)
      || (scope.peerAccountId!==scope.accountId && ![authorId,recipientId].includes(scope.peerAccountId))
      || typeof r.sequence!=="number" || !Number.isSafeInteger(r.sequence) || r.sequence<1
      || typeof r.sentAt!=="number" || !Number.isSafeInteger(r.sentAt) || r.sentAt<0) throw unavailable();
    seen.add(id);
    const {messageId:_id,...p}=offered.message;
    return {id,conversationId:scope.conversationId,authorId,recipientId,...p,
      serverEventId:id,serverSequence:r.sequence,unsentAt:null,createdAt:r.sentAt};
  });
}
function encodePage(scope: PeerHistoryScope,messages: WireMessage[]): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify({version:1,conversationId:scope.conversationId,epoch:scope.epoch,messages})).buffer;
}
/** Scan the offerer's entire visible accepted inventory, never the receiver's
 * maximum sequence. Every bounded page is target-authorized before any BEGIN.
 * Replays are idempotent; no peer checkpoint/receipt/private state is exported. */
export async function exportPeerHistory(scope: PeerHistoryScope, ports: { signal: AbortSignal;
  messages(): Promise<StoredHumanMessage[]>; authority: Authority; send(bytes: ArrayBuffer): Promise<void> }): Promise<void> {
  live(ports.signal);
  const rows=await ports.messages();live(ports.signal);
  let batch: WireMessage[]=[];
  async function send() {
    if (!batch.length) return;
    const validated=await validate(scope,batch,ports.authority,ports.signal);
    const visible=new Set(validated.map(m=>m.id));
    const bytes=encodePage(scope,batch.filter(m=>visible.has(m.messageId)));
    batch=[];
    if (!visible.size) return;
    live(ports.signal);await ports.send(bytes);live(ports.signal);
  }
  for (const row of rows) {
    live(ports.signal);
    if (!row.server || row.server.eventId!==row.id || row.unsentAt!==undefined || row.conversationId!==scope.conversationId
      || !row.messageType || ![row.authorId,row.recipientId].includes(scope.accountId)) continue;
    const p=payload({body:row.body,messageType:row.messageType,contextReportId:row.contextReportId??null,location:row.location??null});
    const entry={messageId:uuid(row.id),...p};
    if (batch.length===64 || encodePage(scope,[...batch,entry]).byteLength>MAX_BYTES) await send();
    batch.push(entry);
    if (encodePage(scope,batch).byteLength>MAX_BYTES) throw unavailable();
  }
  await send();
}
/** The receiver independently validates exact payload identity and gets all
 * immutable authorship/order/time from the server. Local erasure wins inside
 * the canonical durable import; no mailbox ACK, send work or read facts. */
export async function importPeerHistory(scope: PeerHistoryScope, bytes: ArrayBuffer, ports: {signal: AbortSignal;
  authority: Authority; importSnapshot(snapshot: HistorySnapshot): Promise<unknown> }): Promise<number> {
  live(ports.signal);
  if (bytes.byteLength>MAX_BYTES) throw unavailable();
  const v=exact(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)),["version","conversationId","epoch","messages"]);
  if (v.version!==1 || v.conversationId!==scope.conversationId || v.epoch!==scope.epoch || !Array.isArray(v.messages)
    || v.messages.length>64) throw unavailable();
  const seen=new Set<string>();
  const messages=v.messages.map(m=>{
    const e=exact(m,["messageId","body","messageType","contextReportId","location"]);
    const messageId=uuid(e.messageId as string);
    if(seen.has(messageId))throw unavailable();seen.add(messageId);
    return {messageId,...payload(e)};
  });
  const accepted=await validate(scope,messages,ports.authority,ports.signal);
  if (!accepted.length) return 0;
  live(ports.signal);
  await ports.importSnapshot({conversations:[{id:scope.conversationId,lastSequence:Math.max(...accepted.map(m=>m.serverSequence)),
    createdAt:Math.min(...accepted.map(m=>m.createdAt!)),updatedAt:Math.max(...accepted.map(m=>m.createdAt!))}],
    messages:accepted,tombstones:[],deletedForMe:[],clears:[]});
  live(ports.signal);return accepted.length;
}
