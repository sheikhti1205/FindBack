import type { MessageReadFacts, MessagingScope, StoredHumanMessage } from "./history";

/** Sparse true-only union: old snapshots/replays can never retract facts. */
export function mergeReadFacts(...values: (MessageReadFacts | undefined)[]): MessageReadFacts {
  return {
    ...(values.some(v => v?.readByPeer) ? { readByPeer: true } : {}),
    ...(values.some(v => v?.readLocally) ? { readLocally: true } : {}),
    ...(values.some(v => v?.receiptObserved) ? { receiptObserved: true } : {}),
  };
}

export function assertReadFact(scope: MessagingScope, conversationId: string,
  message: StoredHumanMessage | null, fact: "readByPeer" | "receiptObserved"): asserts message is StoredHumanMessage {
  if (!message?.server || message.conversationId !== conversationId || message.unsentAt !== undefined
    || (fact === "readByPeer" ? message.authorId !== scope.accountId : message.recipientId !== scope.accountId)) {
    throw new Error("Invalid message read fact");
  }
}

export function readFactsMask(value: MessageReadFacts): number {
  return (value.readByPeer ? 1 : 0) | (value.readLocally ? 2 : 0) | (value.receiptObserved ? 4 : 0);
}

export function readFactsFromMask(mask: number): MessageReadFacts {
  return { ...(mask & 1 ? { readByPeer: true } : {}), ...(mask & 2 ? { readLocally: true } : {}),
    ...(mask & 4 ? { receiptObserved: true } : {}) };
}
