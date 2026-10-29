import { getSupabase } from "./supabaseClient";
import { ApiError, onSignedOut } from "./session";

export type MatchState = "PENDING" | "CONFIRMED" | "CANCELLED" | "RECOVERED";
export interface MyMatch {
  matchId: string;
  state: MatchState;
  cancelReason: string | null;
  proposedAt: string;
  myReportId: string | null;
  myReportType: "LOST" | "FOUND" | null;
  myTitle: string | null;
  peerReportId: string | null;
  peerReportType: "LOST" | "FOUND" | null;
  peerTitle: string | null;
  peerAvailable: boolean;
  proposedByMe: boolean;
  myConfirmed: boolean;
  myHandover: boolean;
  returnId: string | null;
}

function failed(): ApiError {
  // A lost response may have committed. Never imply a failed mutation was
  // rolled back, auto-repeat it, or fabricate a successful local state.
  return new ApiError("Could not check the match. Refresh its status before trying again.", 503, "MATCH_FAILED");
}
function accountChanged(): ApiError {
  return new ApiError("Your account changed. Open the report again to continue.", 409, "MATCH_ACCOUNT_CHANGED");
}
function matchError(error: { code?: string; message?: string }): ApiError {
  if (error.code === "28000" || error.code === "PGRST301") {
    return new ApiError("Sign in again to continue.", 401, "MATCH_SIGN_IN");
  }
  if (error.code === "P0002" || error.code === "42501") {
    return new ApiError("This match is no longer available.", 404, "MATCH_UNAVAILABLE");
  }
  if (error.message === "A completed recovery cannot be undone here") {
    return new ApiError("This recovery is complete and cannot be cancelled.", 409, "MATCH_COMPLETED");
  }
  if (["40001", "40P01", "23505"].includes(error.code ?? "") || error.message === "MATCH_STATUS_CONFLICT") {
    return new ApiError("The report changed. Refresh its status before trying again.", 409, "MATCH_CONFLICT");
  }
  if (error.code === "PGRST202") {
    return new ApiError("Matching is not available right now. Please try again later.", 503, "MATCH_NOT_READY");
  }
  return failed();
}
function id(value: string): string {
  if (!value.trim()) throw new ApiError("Choose a report to continue.", 400, "MATCH_INVALID");
  return value.trim();
}

/** One request, one captured identity. Reuse canonical auth; no parallel session
 * owner or token persistence. Both SDK events and beginAccountSwitch invalidate
 * an operation, including A→B→A. Same-account refresh is NOT an account switch.
 * Pin the captured bearer so the SDK's delayed fetch cannot retarget A's intent
 * to B. Cancellation/result suppression does not promise server rollback. */
async function rpc(accountId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!accountId) throw accountChanged();
  const sdk = getSupabase();
  const controller = new AbortController();
  const invalidate = () => controller.abort();
  const stopSignedOut = onSignedOut(invalidate);
  const { data: { subscription } } = sdk.auth.onAuthStateChange((_event, session) => {
    if (session?.user.id !== accountId) invalidate();
  });
  const assertCurrent = () => { if (controller.signal.aborted) throw accountChanged(); };
  try {
    const { data, error } = await sdk.auth.getSession();
    assertCurrent();
    const session = data.session;
    if (error || !session || session.user.id !== accountId || !session.access_token) throw accountChanged();
    const result = await sdk.rpc(name, args)
      .setHeader("Authorization", `Bearer ${session.access_token}`)
      .abortSignal(controller.signal);
    assertCurrent();
    if (result.error) throw matchError(result.error);
    return result.data;
  } catch (error) {
    assertCurrent();
    throw error instanceof ApiError ? error : failed();
  } finally {
    stopSignedOut();
    subscription.unsubscribe();
  }
}

function stringOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw failed();
  return value;
}
function reportType(value: unknown): "LOST" | "FOUND" | null {
  if (value === null || value === "LOST" || value === "FOUND") return value;
  throw failed();
}
function parseMatch(value: unknown): MyMatch {
  if (!value || typeof value !== "object") throw failed();
  const row = value as Record<string, unknown>;
  if (typeof row.match_id !== "string" || !row.match_id || typeof row.proposed_at !== "string"
      || !Number.isFinite(Date.parse(row.proposed_at))
      || !["PENDING", "CONFIRMED", "CANCELLED", "RECOVERED"].includes(String(row.state))
      || [row.peer_available, row.proposed_by_me, row.my_confirmed, row.my_handover].some((x) => typeof x !== "boolean")) {
    throw failed();
  }
  return {
    matchId: row.match_id, state: row.state as MatchState,
    cancelReason: stringOrNull(row.cancel_reason), proposedAt: row.proposed_at,
    myReportId: stringOrNull(row.my_report_id), myReportType: reportType(row.my_report_type), myTitle: stringOrNull(row.my_title),
    peerAvailable: row.peer_available as boolean,
    peerReportId: row.peer_available ? stringOrNull(row.peer_report_id) : null,
    peerReportType: row.peer_available ? reportType(row.peer_report_type) : null,
    peerTitle: row.peer_available ? stringOrNull(row.peer_title) : null,
    proposedByMe: row.proposed_by_me as boolean, myConfirmed: row.my_confirmed as boolean,
    myHandover: row.my_handover as boolean, returnId: stringOrNull(row.return_id),
  };
}

export async function listMyMatches(accountId: string, options: {
  postId?: string; before?: { at: string; id: string };
} = {}): Promise<MyMatch[]> {
  const data = await rpc(accountId, "findback_my_matches", {
    p_post_id: options.postId === undefined ? null : id(options.postId),
    p_before_at: options.before?.at ?? null, p_before_id: options.before?.id ?? null, p_limit: 20,
  });
  if (!Array.isArray(data)) throw failed();
  return data.map(parseMatch);
}

/** Argument names are historical: the SERVER derives LOST/FOUND orientation. */
export async function proposeMatch(accountId: string, myPostId: string, peerPostId: string): Promise<string> {
  const mine = id(myPostId), peer = id(peerPostId);
  if (mine === peer) throw new ApiError("Choose two different reports.", 400, "MATCH_INVALID");
  const data = await rpc(accountId, "findback_propose_match", { p_lost_id: mine, p_found_id: peer });
  if (typeof data !== "string" || !data) throw failed();
  return data;
}
export async function confirmMatch(accountId: string, matchId: string): Promise<"PARTIAL" | "MATCHED"> {
  const data = await rpc(accountId, "findback_confirm_match", { p_match_id: id(matchId) });
  if (data !== "PARTIAL" && data !== "MATCHED") throw failed();
  return data;
}
export async function cancelMatch(accountId: string, matchId: string): Promise<void> {
  const data = await rpc(accountId, "findback_cancel_match", { p_match_id: id(matchId) });
  if (data !== null) throw failed();
}
export async function handoverMatch(accountId: string, matchId: string): Promise<"PARTIAL" | "RECOVERED"> {
  const data = await rpc(accountId, "findback_handover_match", { p_match_id: id(matchId) });
  if (data !== "PARTIAL" && data !== "RECOVERED") throw failed();
  return data;
}
