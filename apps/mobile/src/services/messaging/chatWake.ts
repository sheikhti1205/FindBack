import { fetchSupabaseFunction } from "../supabaseClient";

/**
 * Ask the `chat-wake` function to wake the recipient's devices for one message
 * this account just sent.
 *
 * Fire-and-forget by design: the message is already durable and the scheduled
 * `push-dispatch` lane is the backstop, so a wake that cannot be requested now
 * must never surface as a send failure. The response body is cancelled
 * immediately — the caller only needs the side effect.
 */
export function kickChatWake(accountId: string, messageId: string): void {
  try {
    const body = new TextEncoder().encode(JSON.stringify({ message_id: messageId })).buffer;
    void fetchSupabaseFunction("chat-wake", accountId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // Bounded: a stalled wake request must not outlive the send screen.
      signal: AbortSignal.timeout(10_000),
    }).then((response) => {
      void response.body?.cancel().catch(() => undefined);
    }).catch(() => undefined);
  } catch {
    // Missing config / uninitialised client: the scheduled lane still covers it.
  }
}
