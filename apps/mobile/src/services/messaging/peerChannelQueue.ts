import type { PeerTransferChannel } from "./peerTransfer";

/** Keeps one bounded receive owner across handshake/listener replacement.
 * Drain is deferred until addEventListener returns, so consumer initialization
 * cannot be reentered. Overflow/abort closes, never drops a frame silently. */
export function queuePeerChannel(source: PeerTransferChannel, signal: AbortSignal): PeerTransferChannel {
  source.binaryType="arraybuffer";
  const target=new EventTarget(), listeners=new Set<EventListenerOrEventListenerObject>();
  const queue:unknown[]=[];
  let bytes=0,closed=false,scheduled=false;
  const close=()=>{
    if(closed)return;closed=true;queue.length=0;bytes=0;
    source.removeEventListener("message",receive);signal.removeEventListener("abort",close);
    source.removeEventListener("close",close);source.removeEventListener("error",close);
    source.removeEventListener("bufferedamountlow",low);
    source.close();target.dispatchEvent(new Event("close"));
  };
  const drain=()=>{
    if(scheduled || closed || !listeners.size)return;scheduled=true;
    queueMicrotask(()=>{
      scheduled=false;
      while(!closed && listeners.size && queue.length){
        const data=queue.shift();
        bytes-=typeof data==="string" ? new TextEncoder().encode(data).byteLength : (data as ArrayBuffer).byteLength;
        target.dispatchEvent(new MessageEvent("message",{data}));
      }
    });
  };
  function receive(e: Event){
    if(closed)return;
    const data=(e as MessageEvent).data as unknown;
    if(typeof data!=="string" && !(data instanceof ArrayBuffer)){close();return;}
    const size=typeof data==="string" ? new TextEncoder().encode(data).byteLength:data.byteLength;
    if(queue.length>=128 || bytes+size>1_200_000){close();return;}
    queue.push(data);bytes+=size;drain();
  }
  const low=()=>target.dispatchEvent(new Event("bufferedamountlow"));
  source.addEventListener("message",receive);source.addEventListener("close",close);source.addEventListener("error",close);
  source.addEventListener("bufferedamountlow",low);signal.addEventListener("abort",close,{once:true});
  if(signal.aborted)close();
  return {
    get readyState(){return closed?"closed":source.readyState;}, get ordered(){return source.ordered;},
    get maxRetransmits(){return source.maxRetransmits;},get maxPacketLifeTime(){return source.maxPacketLifeTime;},
    get protocol(){return source.protocol;},get binaryType(){return source.binaryType;},set binaryType(v){source.binaryType=v;},
    get bufferedAmount(){return source.bufferedAmount;},get bufferedAmountLowThreshold(){return source.bufferedAmountLowThreshold;},
    set bufferedAmountLowThreshold(v){source.bufferedAmountLowThreshold=v;},
    send(data){if(closed)throw new Error("Peer channel closed");source.send(data);},close,
    addEventListener(type,listener,options){
      if(type==="message" && listener)listeners.add(listener);
      target.addEventListener(type,listener,options);drain();
    },
    removeEventListener(type,listener,options){
      if(type==="message" && listener)listeners.delete(listener);
      target.removeEventListener(type,listener,options);
    },
    dispatchEvent(event){return target.dispatchEvent(event);},
  };
}
