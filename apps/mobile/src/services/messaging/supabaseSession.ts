import { getSupabase } from "../supabaseClient";
import type { MessagingHistory, MessagingScope } from "./history";
import { createMessagingSession } from "./session";

/** Uses the canonical auth SDK; server checks the captured account on every RPC. */
export function createSupabaseMessagingSession(scope: MessagingScope, history: MessagingHistory) {
  return createMessagingSession(scope, history, async ({ accountId, deviceId, action, args, signal }) => {
    const { data, error } = await getSupabase().rpc("findback_chat_exchange", {
      p_account_id: accountId, p_device_id: deviceId, p_action: action, p_args: args,
    }).abortSignal(signal);
    if (error) throw new Error("Chat could not sync. Try again.");
    return data;
  });
}
