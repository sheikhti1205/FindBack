import { createContext, useContext, useRef, type ReactNode } from "react";
import type { PostItem } from "@findback/shared";
import { fetchPost } from "../services/posts";
import { friendlyError } from "../utils/friendlyErrors";

/**
 * One shared owner for comment report-reference resolution (M2 D5).
 *
 * A hook living inside each card could not dedupe five comments that point at
 * the same report, so this provider owns the per-render `Map<postId, entry>`
 * and every card reads through it. The map is in memory only — nothing is
 * persisted — and `resetKey` drops it:
 *
 * - a comment-list refetch passes a new key, so the map is rebuilt; and
 * - an account switch passes a different key, so a late payload for the
 *   previous account can neither render nor suppress the new account's read.
 *
 * The in-flight promise is recorded synchronously, before the first `await`,
 * so a second render that starts while a read is still unsettled reuses that
 * entry instead of issuing a duplicate call.
 */

export type ReportPreviewEntry =
  | { status: "loading" }
  | { status: "ready"; post: PostItem }
  | { status: "unavailable" }
  | { status: "error" };

export interface ReportPreviewStore {
  read(postId: string): ReportPreviewEntry;
  ensure(postId: string): void;
  retry(postId: string): void;
  subscribe(listener: () => void): () => void;
}

function createReportPreviewStore(): ReportPreviewStore {
  const entries = new Map<string, ReportPreviewEntry>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  function start(postId: string) {
    entries.set(postId, { status: "loading" });
    emit();
    void (async () => {
      try {
        const post = await fetchPost(postId);
        entries.set(postId, { status: "ready", post });
      } catch (err) {
        // 404 is the same read path whether the target is absent or not
        // readable, so both collapse to the one unavailable state (M2 D5).
        entries.set(
          postId,
          friendlyError(err).code === "NOT_FOUND" ? { status: "unavailable" } : { status: "error" },
        );
      } finally {
        emit();
      }
    })();
  }

  return {
    read(postId) {
      return entries.get(postId) ?? { status: "loading" };
    },
    ensure(postId) {
      if (entries.has(postId)) return;
      start(postId);
    },
    retry(postId) {
      if (entries.get(postId)?.status !== "error") return;
      entries.delete(postId);
      start(postId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const ReportPreviewContext = createContext<ReportPreviewStore | null>(null);

export function useReportPreviewStore(): ReportPreviewStore {
  const store = useContext(ReportPreviewContext);
  if (!store) throw new Error("useReportPreview must be used within a ReportPreviewProvider");
  return store;
}

export function ReportPreviewProvider({
  children,
  resetKey,
}: {
  children: ReactNode;
  /** Change to drop every resolved/in-flight entry (list refetch, account switch). */
  resetKey: string;
}) {
  // A new key means a new store: pending reads settle into the discarded
  // store, so they cannot deliver a stale payload to the new render. The ref
  // makes the store lifetime explicit — React does not guarantee `useMemo`
  // retention, and a silently discarded cache would re-read every card.
  const storeRef = useRef<{ key: string; store: ReportPreviewStore } | null>(null);
  if (!storeRef.current || storeRef.current.key !== resetKey) {
    storeRef.current = { key: resetKey, store: createReportPreviewStore() };
  }
  return (
    <ReportPreviewContext.Provider value={storeRef.current.store}>
      {children}
    </ReportPreviewContext.Provider>
  );
}
