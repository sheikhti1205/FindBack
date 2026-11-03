import type { ConversationHead } from "./conversationHead";

/** Empty publication stream for tests whose subject is another transport seam.
 * Actual nonempty/erasure/race behavior lives in reconciliation and SQL probes. */
export function emptyConversationHead(accountId: string, conversationId: string): ConversationHead {
  return { accountId, conversationId, streamId: "fixture-stream", epoch: "fixture-epoch", revision: 1,
    position: 0, messageHead: 0, stateHead: 0, serverTime: 1_000 };
}
export function emptyConversationRange(head: unknown) {
  return { head, afterPosition: 0, throughPosition: 0, entries: [] };
}
