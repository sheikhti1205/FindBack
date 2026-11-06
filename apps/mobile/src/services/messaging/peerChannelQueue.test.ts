// @vitest-environment node
import { describe, expect, it } from "vitest";
import { queuePeerChannel } from "./peerChannelQueue";
import type { PeerTransferChannel } from "./peerTransfer";
class Channel extends EventTarget implements PeerTransferChannel {
 readyState="open";ordered=true;maxRetransmits=null;maxPacketLifeTime=null;protocol="norfold-sync-v1";
 binaryType:"arraybuffer"|"blob"="arraybuffer";bufferedAmount=0;bufferedAmountLowThreshold=0;
 send(){} close(){this.readyState="closed";this.dispatchEvent(new Event("close"));}
}
describe("handshake-to-transfer listener handoff",()=>{
 it("holds gap frames and delivers asynchronously after the replacement attaches",async()=>{
  const source=new Channel(), controller=new AbortController(), channel=queuePeerChannel(source,controller.signal);
  const received:unknown[]=[];let initialized=false;
  const handshake=()=>{};channel.addEventListener("message",handshake);channel.removeEventListener("message",handshake);
  source.dispatchEvent(new MessageEvent("message",{data:"BEGIN"}));
  source.dispatchEvent(new MessageEvent("message",{data:new ArrayBuffer(16)}));
  channel.addEventListener("message",e=>{expect(initialized).toBe(true);received.push((e as MessageEvent).data);});
  initialized=true;await Promise.resolve();
  expect(received).toEqual(["BEGIN",expect.any(ArrayBuffer)]);
  controller.abort();expect(source.readyState).toBe("closed");
 });
 it("fails closed on bounded queued overflow and drops delivery after cancellation",async()=>{
  const source=new Channel(), controller=new AbortController(), channel=queuePeerChannel(source,controller.signal);
  for(let n=0;n<130;n++)source.dispatchEvent(new MessageEvent("message",{data:"x"}));
  expect(source.readyState).toBe("closed");
  let delivered=0;channel.addEventListener("message",()=>{delivered++;});await Promise.resolve();expect(delivered).toBe(0);
 });
});
