import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginAccountSwitch } from "./session";
import { cancelMatch, confirmMatch, handoverMatch, listMyMatches, proposeMatch } from "./matches";

// SDK is the external boundary. The fake records the actual request identity,
// args and cancellation; all validation/projection/lifecycle mapping stays real.
const fake = vi.hoisted(() => ({
  getSession: vi.fn(), rpc: vi.fn(), onAuthStateChange: vi.fn(),
}));
vi.mock("./supabaseClient", () => ({ getSupabase: () => ({ auth: fake, rpc: fake.rpc }) }));

type Session = { user: { id: string }; access_token: string };
type Reply = { data: unknown; error: { code: string; message: string; details?: string } | null };
let authListeners: Set<(event: string, session: Session | null) => void>;
let current: Session | null;
let calls: { name: string; args: unknown; headers: Record<string, string>; signal?: AbortSignal }[];
let response: () => Promise<Reply>;
const row = {
  match_id: "match-1", state: "PENDING", cancel_reason: null, proposed_at: "2026-10-29T00:00:00Z",
  my_report_id: "mine", my_report_type: "LOST", my_title: "My wallet",
  peer_report_id: "peer", peer_report_type: "FOUND", peer_title: "Blue wallet", peer_available: true,
  proposed_by_me: false, my_confirmed: false, my_handover: false, return_id: null,
};
function change(account: string | null, event = "SIGNED_IN") {
  current = account ? { user: { id: account }, access_token: `test-only-${account}` } : null;
  for (const listener of authListeners) listener(event, current);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  authListeners = new Set();
  current = { user: { id: "A" }, access_token: "test-only-A" };
  response = async () => ({ data: null, error: null });
  fake.getSession.mockImplementation(async () => ({ data: { session: current }, error: null }));
  fake.onAuthStateChange.mockImplementation((listener) => {
    authListeners.add(listener);
    return { data: { subscription: { unsubscribe: () => authListeners.delete(listener) } } };
  });
  fake.rpc.mockImplementation((name, args) => {
    const call: (typeof calls)[number] = { name, args, headers: {} };
    calls.push(call);
    const builder = {
      setHeader(key: string, value: string) { call.headers[key] = value; return builder; },
      abortSignal(signal: AbortSignal) { call.signal = signal; return builder; },
      then(resolve: (reply: Reply) => unknown, reject: (reason: unknown) => unknown) {
        return response().then(resolve, reject);
      },
    };
    return builder;
  });
});

describe("matching client boundary", () => {
  it("maps participant history and forwards only the own-report/cursor filter", async () => {
    response = async () => ({ data: [row], error: null });
    await expect(listMyMatches("A", { postId: " mine ", before: { at: row.proposed_at, id: "previous" } })).resolves.toEqual([{
      matchId: "match-1", state: "PENDING", cancelReason: null, proposedAt: row.proposed_at,
      myReportId: "mine", myReportType: "LOST", myTitle: "My wallet",
      peerReportId: "peer", peerReportType: "FOUND", peerTitle: "Blue wallet", peerAvailable: true,
      proposedByMe: false, myConfirmed: false, myHandover: false, returnId: null,
    }]);
    expect(calls[0]).toMatchObject({ name: "findback_my_matches", args: {
      p_post_id: "mine", p_before_at: row.proposed_at, p_before_id: "previous", p_limit: 20,
    } });
    expect(authListeners.size).toBe(0);
  });

  it("neutralizes unavailable peers even if an unexpected payload contains their content", async () => {
    response = async () => ({ data: [{ ...row, peer_available: false, private_original_id: "never-copy" }], error: null });
    const [match] = await listMyMatches("A");
    expect(match).toMatchObject({ peerAvailable: false, peerReportId: null, peerReportType: null, peerTitle: null });
    expect(JSON.stringify(match)).not.toMatch(/never-copy|Blue wallet/);
  });

  it("uses real mutation RPCs, deriving no owner, consent or orientation client-side", async () => {
    response = async () => ({ data: "match-9", error: null });
    await expect(proposeMatch("A", " mine ", " peer ")).resolves.toBe("match-9");
    response = async () => ({ data: "PARTIAL", error: null });
    await expect(confirmMatch("A", " match-9 ")).resolves.toBe("PARTIAL");
    response = async () => ({ data: "MATCHED", error: null });
    await expect(confirmMatch("A", "match-9")).resolves.toBe("MATCHED");
    response = async () => ({ data: "RECOVERED", error: null });
    await expect(handoverMatch("A", "match-9")).resolves.toBe("RECOVERED");
    response = async () => ({ data: null, error: null });
    await expect(cancelMatch("A", "match-9")).resolves.toBeUndefined();
    expect(calls.map(({ name, args }) => ({ name, args }))).toEqual([
      { name: "findback_propose_match", args: { p_lost_id: "mine", p_found_id: "peer" } },
      { name: "findback_confirm_match", args: { p_match_id: "match-9" } },
      { name: "findback_confirm_match", args: { p_match_id: "match-9" } },
      { name: "findback_handover_match", args: { p_match_id: "match-9" } },
      { name: "findback_cancel_match", args: { p_match_id: "match-9" } },
    ]);
    expect(calls.every((call) => call.headers.Authorization === "Bearer test-only-A")).toBe(true);
  });

  it("rejects invalid pairs without sending a request", async () => {
    await expect(proposeMatch("A", "mine", "mine")).rejects.toMatchObject({ status: 400 });
    await expect(confirmMatch("A", "  ")).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["P0002", "Match unavailable", "MATCH_UNAVAILABLE"],
    ["P0001", "MATCH_STATUS_CONFLICT", "MATCH_CONFLICT"],
    ["P0001", "A completed recovery cannot be undone here", "MATCH_COMPLETED"],
    ["PGRST202", "SQL schema details", "MATCH_NOT_READY"],
    ["42501", "Only report owners can hand over matches", "MATCH_UNAVAILABLE"],
    ["40001", "deadlock protocol diagnostics", "MATCH_CONFLICT"],
    ["XX999", "secret internal SQL diagnostics", "MATCH_FAILED"],
  ])("maps %s errors without exposing backend prose", async (code, message, expected) => {
    response = async () => ({ data: null, error: { code, message, details: "private database details" } });
    const error = await confirmMatch("A", "match").catch((error: Error) => error);
    expect(error).toMatchObject({ code: expected });
    expect((error as Error).message).not.toMatch(/SQL|schema|protocol|diagnostics|owners|private database|MATCH_STATUS/);
    expect(authListeners.size).toBe(0);
  });

  it("does not translate a network failure into an empty inbox or a successful mutation", async () => {
    response = async () => { throw new Error("raw network stack"); };
    await expect(listMyMatches("A")).rejects.toMatchObject({ code: "MATCH_FAILED" });
    await expect(cancelMatch("A", "match")).rejects.toMatchObject({ code: "MATCH_FAILED" });
  });

  it("refuses malformed states instead of inventing successful consent", async () => {
    response = async () => ({ data: "RECOVERED", error: null });
    await expect(confirmMatch("A", "match")).rejects.toMatchObject({ code: "MATCH_FAILED" });
    response = async () => ({ data: [{ ...row, state: "UNKNOWN" }], error: null });
    await expect(listMyMatches("A")).rejects.toMatchObject({ code: "MATCH_FAILED" });
  });
});

describe("matching account fencing", () => {
  it("refuses a stale screen before sending a mutation for the newly signed-in account", async () => {
    change("B");
    await expect(confirmMatch("A", "match")).rejects.toMatchObject({ code: "MATCH_ACCOUNT_CHANGED" });
    expect(calls).toHaveLength(0);
  });

  it("drops an A → B → A result and cancels the in-flight request", async () => {
    const started = deferred<void>();
    const reply = deferred<Reply>();
    response = () => { started.resolve(); return reply.promise; };
    const pending = listMyMatches("A");
    const rejected = expect(pending).rejects.toMatchObject({ code: "MATCH_ACCOUNT_CHANGED" });
    await started.promise;
    change("B"); change("A");
    expect(calls[0]?.signal?.aborted).toBe(true);
    reply.resolve({ data: [row], error: null });
    await rejected;
    expect(authListeners.size).toBe(0);
  });

  it("catches an intervening account switch while getSession is pending", async () => {
    const snapshot = deferred<Awaited<ReturnType<typeof fake.getSession>>>();
    fake.getSession.mockReturnValue(snapshot.promise);
    const pending = proposeMatch("A", "mine", "peer");
    const rejected = expect(pending).rejects.toMatchObject({ code: "MATCH_ACCOUNT_CHANGED" });
    change("B"); change("A");
    snapshot.resolve({ data: { session: current }, error: null });
    await rejected;
    expect(calls).toHaveLength(0);
  });

  it("honors beginAccountSwitch before an SDK sign-out event arrives", async () => {
    const started = deferred<void>();
    const reply = deferred<Reply>();
    response = () => { started.resolve(); return reply.promise; };
    const pending = confirmMatch("A", "match");
    const rejected = expect(pending).rejects.toMatchObject({ code: "MATCH_ACCOUNT_CHANGED" });
    await started.promise;
    beginAccountSwitch();
    reply.resolve({ data: "MATCHED", error: null });
    await rejected;
  });

  it("does not discard a same-account token refresh", async () => {
    const started = deferred<void>();
    const reply = deferred<Reply>();
    response = () => { started.resolve(); return reply.promise; };
    const pending = handoverMatch("A", "match");
    await started.promise;
    change("A", "TOKEN_REFRESHED");
    reply.resolve({ data: "PARTIAL", error: null });
    await expect(pending).resolves.toBe("PARTIAL");
    expect(calls[0]?.signal?.aborted).toBe(false);
  });
});
