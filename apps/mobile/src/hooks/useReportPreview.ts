import { useEffect, useReducer } from "react";
import type { PostItem } from "@findback/shared";
import { useReportPreviewStore } from "../components/CommentReportPreviews";

/**
 * Consumer of the shared report-preview map (see `CommentReportPreviews`).
 *
 * `postId` is `string | null` because that is exactly what a descriptor's
 * `reportPostId` is: `null` is the tombstone (deleted target), and it renders
 * the unavailable state immediately with no network call.
 */
export type ReportPreviewState =
  | { status: "loading" }
  | { status: "ready"; post: PostItem }
  | { status: "unavailable" }
  | { status: "error"; retry: () => void };

const UNAVAILABLE: ReportPreviewState = { status: "unavailable" };

export function useReportPreview(postId: string | null): ReportPreviewState {
  const store = useReportPreviewStore();
  const [, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (postId === null) return;
    const unsubscribe = store.subscribe(bump);
    store.ensure(postId);
    return unsubscribe;
  }, [store, postId]);

  if (postId === null) return UNAVAILABLE;
  const entry = store.read(postId);
  return entry.status === "error" ? { status: "error", retry: () => store.retry(postId) } : entry;
}
