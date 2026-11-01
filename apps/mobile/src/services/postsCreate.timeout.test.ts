import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    auth: { getUser: vi.fn(), getSession: vi.fn() },
    rpc: vi.fn(),
  },
}));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

import { CREATE_POST_RPC_TIMEOUT_MS, createPost, createPostMulti } from "./postsCreate";
import { PublishOutcomeUncertainError } from "./publishOutcome";

const input = {
  type: "LOST" as const,
  title: "Lost phone",
  description: "a black phone lost on campus",
  category: "Electronics" as const,
  eventDate: "2026-09-10",
};

beforeEach(() => {
  clientMock.rpc.mockReset();
  clientMock.auth.getSession.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPost RPC timeout (W8-STATIC)", () => {
  it("surfaces a hung create RPC as uncertain instead of hanging forever", async () => {
    clientMock.rpc.mockReturnValue(new Promise(() => {}));

    const pending = createPost(input);
    // Attach the assertion before advancing: the rejection fires on the
    // timer tick and must already be observed (no unhandled rejection).
    const assertion = expect(pending).rejects.toBeInstanceOf(PublishOutcomeUncertainError);
    await vi.advanceTimersByTimeAsync(CREATE_POST_RPC_TIMEOUT_MS);

    // A timeout can never prove the server rejected: the caller keeps staged
    // uploads and blocks republish through the existing uncertain path.
    await assertion;
  });

  it("still resolves a fast RPC without waiting for the budget", async () => {
    clientMock.rpc.mockResolvedValue({ data: "p1", error: null });

    await expect(createPost(input)).resolves.toBe("p1");
  });
});

describe("createPost account-bound owner (F5)", () => {
  it("refuses to publish under a session that is no longer the captured account", async () => {
    clientMock.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u2" } } }, error: null });

    await expect(createPost({ ...input, expectedAccountId: "u1" })).rejects.toMatchObject({ status: 401 });
    // Nothing irreversible was issued under the wrong identity.
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("publishes when the session still belongs to the captured account", async () => {
    clientMock.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null });
    clientMock.rpc.mockResolvedValue({ data: "p1", error: null });

    await expect(createPost({ ...input, expectedAccountId: "u1" })).resolves.toBe("p1");
  });

  it("keeps the legacy call shape working when no account is captured", async () => {
    clientMock.rpc.mockResolvedValue({ data: "p2", error: null });

    await expect(createPost(input)).resolves.toBe("p2");
    expect(clientMock.auth.getSession).not.toHaveBeenCalled();
  });
});

describe("createPost account-bound RPC (F5)", () => {
  it.each([createPost, createPostMulti])("does not dispatch after the caller leaves during the account read (%#)", async (create) => {
    let finishRead!: (value: unknown) => void;
    clientMock.auth.getSession.mockReturnValue(new Promise(resolve => { finishRead = resolve; }));
    clientMock.rpc.mockResolvedValue({ data: "should-not-exist", error: null });
    let current = true;
    const pending = create({ ...input, expectedAccountId: "u1" }, undefined, () => current);
    const assertion = expect(pending).rejects.toMatchObject({ name: "UploadCancelledError" });
    current = false;
    finishRead({ data: { session: { user: { id: "u1" } } }, error: null });
    await assertion;
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("issues the bound create RPC with the captured account when one is supplied", async () => {
    clientMock.auth.getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null });
    clientMock.rpc.mockResolvedValue({ data: "p1", error: null });

    await expect(createPost({ ...input, expectedAccountId: "u1" })).resolves.toBe("p1");
    expect(clientMock.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = clientMock.rpc.mock.calls[0]!;
    // The wrapper compares the captured account with the session inside the
    // creating statement, so no client-side check-then-use window remains.
    expect(name).toBe("findback_create_post_client_bound");
    expect(args).toMatchObject({ p_expected_account: "u1" });
  });
});
