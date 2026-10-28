import { fetchSupabaseFunction, getSupabase } from "../supabaseClient";
import type { MessagingHistory, MessagingScope } from "./history";
import { createMessagingSession } from "./session";
import { createMediaTransport } from "./mediaTransport";
import { uuid } from "./validation";

/** Shares the caller's lifetime; does not create another session or scheduler. */
export function createSupabaseMediaTransport(scope: MessagingScope, signal: AbortSignal) {
  const accountId = uuid(scope.accountId);
  return createMediaTransport(scope, signal, {
    request: (input) => fetchSupabaseFunction("chat-media", accountId, input),
    rpc: async ({ name, args, signal: requestSignal }) => {
      const { data, error } = await getSupabase().rpc(name, args).abortSignal(requestSignal);
      if (error) throw new Error("Photo could not sync. Try again.");
      return data;
    },
  });
}

/** Uses the canonical auth SDK; server checks the captured account on every RPC. */
export function createSupabaseMessagingSession(scope: MessagingScope, history: MessagingHistory) {
  return createMessagingSession(scope, history, async ({ accountId, deviceId, action, args, signal }) => {
    const sdk = getSupabase();
    const request = action === "RECEIPT_VIEW"
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
    return data;
  }, createSupabaseMediaTransport);
}
