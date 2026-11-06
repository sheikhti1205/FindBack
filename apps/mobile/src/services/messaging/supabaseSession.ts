import { fetchSupabaseFunction, getSupabase, getSupabaseBackendUrl } from "../supabaseClient";
import type { MessagingHistory, MessagingScope } from "./history";
import { createMessagingSession } from "./session";
import { createMediaTransport } from "./mediaTransport";
import { uuid } from "./validation";
import { kickChatWake } from "./chatWake";
import { createDeviceEnrollment } from "./deviceEnrollment";
import { openWebDeviceIdentity } from "./webDeviceIdentity";
import { openAndroidDeviceIdentity } from "./androidDeviceIdentity";
import type { HistoryCandidate } from "./peerHistory";

/** Shares the caller's lifetime; does not create another session or scheduler. */
export function createSupabaseMediaTransport(scope: MessagingScope, signal: AbortSignal, prepare?: () => Promise<void>) {
  const accountId = uuid(scope.accountId);
  const transport = createMediaTransport(scope, signal, {
    request: async (input) => { await prepare?.(); return fetchSupabaseFunction("chat-media", accountId, input); },
    rpc: async ({ name, args, signal: requestSignal }) => {
      await prepare?.();
      const { data, error } = await getSupabase().rpc(name, args).abortSignal(requestSignal);
      if (error) throw new Error("Photo could not sync. Try again.");
      return data;
    },
  });
  return { ...transport, async upload(...args: Parameters<typeof transport.upload>) {
    await transport.upload(...args);
    // The validated upload response follows the server attachment commit. The
    // earlier parent SEND kick cannot dispatch a wake that did not exist yet.
    if (!signal.aborted) kickChatWake(accountId, args[0].messageId);
  } };
}

/** Uses the canonical auth SDK; server checks the captured account on every RPC. */
export function createSupabaseMessagingSession(identity: MessagingScope, history: MessagingHistory,
  context: { sessionId: string | null | undefined; platform: "web" | "android" }) {
  const scope = Object.freeze({ accountId: uuid(identity.accountId), deviceId: uuid(identity.deviceId) });
  const owner = Object.freeze({ sessionId: context.sessionId, platform: context.platform });
  let enrollment: ReturnType<typeof createDeviceEnrollment> | undefined;
  const admission = async (signal: AbortSignal) => {
    const sessionId = uuid(owner.sessionId as string);
    enrollment ??= createDeviceEnrollment({ ...scope, backendUrl: getSupabaseBackendUrl(), sessionId }, signal, {
      openIdentity: () => {
        const open = owner.platform === "android" ? openAndroidDeviceIdentity : openWebDeviceIdentity;
        return open({ ...scope, backendUrl: getSupabaseBackendUrl() });
      },
      challenge: async publicKey => {
        const { data, error } = await getSupabase().rpc("findback_device_enrollment_challenge", {
          p_device_id: scope.deviceId, p_public_key: publicKey,
          p_name: owner.platform === "web" ? "Browser" : "Android device", p_platform: owner.platform,
        }).abortSignal(signal);
        if (error) throw new Error("Device could not connect"); return data;
      },
      commit: async (challengeId, signature) => {
        const body = new TextEncoder().encode(JSON.stringify({ challengeId, signature })).buffer;
        const response = await fetchSupabaseFunction("device-enroll", scope.accountId, {
          method: "POST", signal, headers: { "content-type": "application/json" }, body,
        });
        if (!response.ok) throw new Error("Device could not connect");
        const result = await response.json() as { device?: unknown };
        return result.device;
      },
    });
    await enrollment.ready();
  };
  const session = createMessagingSession(scope, history, async ({ accountId, deviceId, action, args, signal }) => {
    const sdk = getSupabase();
    const request = action === "MUTE"
      ? sdk.rpc("findback_chat_set_muted", { p_account_id: accountId, p_device_id: deviceId,
          p_conversation_id: args.conversationId, p_muted: args.muted })
      : action === "RECEIPT_VIEW"
      ? sdk.rpc("findback_chat_receipt_view", { p_account_id: accountId, p_device_id: deviceId,
          p_conversation_id: args.conversationId, p_message_ids: args.messageIds })
      : action === "RECEIPT_OBSERVE"
        ? sdk.rpc("findback_chat_receipt_observe", { p_account_id: accountId, p_device_id: deviceId,
            p_conversation_id: args.conversationId, p_context: args.context, p_message_id: args.messageId })
        : sdk.rpc("findback_chat_exchange", {
            p_account_id: accountId, p_device_id: deviceId, p_action: action, p_args: args,
          });
    const { data, error } = await request.abortSignal(signal);
    if (error) throw new Error("Chat could not sync. Try again.");
    // The message is accepted server-side: wake the recipient's devices now
    // instead of waiting for the scheduled dispatch lane. Never awaited and
    // never allowed to fail this send.
    if (action === "SEND" && typeof args.messageId === "string") kickChatWake(accountId, args.messageId);
    return data;
  }, (mediaScope, signal) => createSupabaseMediaTransport(mediaScope, signal, () => session.prepare()), admission);
  const peerRpc = async (action: string, args: Record<string,unknown>, signal: AbortSignal) => {
    await session.prepare();signal.throwIfAborted();session.signal.throwIfAborted();
    const {data,error}=await getSupabase().rpc("findback_history_peer",{p_action:action,p_args:args}).abortSignal(signal);
    signal.throwIfAborted();session.signal.throwIfAborted();
    if(error)throw new Error("Peer could not connect");return data;
  };
  return {...session,peerRpc,
    async peerAuthority(sessionId: string,candidates: HistoryCandidate[],signal: AbortSignal) {
      await session.prepare();signal.throwIfAborted();session.signal.throwIfAborted();
      const {data,error}=await getSupabase().rpc("findback_peer_history_authority",{p_session_id:sessionId,p_candidates:candidates}).abortSignal(signal);
      signal.throwIfAborted();session.signal.throwIfAborted();
      if(error)throw new Error("History could not sync");return data;
    },
    async signPeer(input: Parameters<ReturnType<typeof createDeviceEnrollment>["signPeer"]>[0],signal: AbortSignal) {
      await session.prepare();signal.throwIfAborted();
      const result=await enrollment!.signPeer(input);signal.throwIfAborted();return result;
    },
  };
}
