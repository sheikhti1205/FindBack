import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    auth: { getUser: vi.fn() },
    rpc: vi.fn(),
  },
}));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

import { COMMENT_POST_TIMEOUT_MS, addComment } from "./posts";

function commentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c1",
    post_id: "p1",
    parent_id: null,
    depth: 0,
    body: "hope you find it",
    created_at: "2026-09-02T00:00:00.000Z",
    updated_at: "2026-09-02T00:00:00.000Z",
    author_id: "u2",
    author_username: "bob",
    author_email_verified: 1,
    author_phone_verified: 0,
    author_avatar_url: null,
    author_created_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  clientMock.rpc.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("addComment RPC timeout (W8-STATIC)", () => {
  it("fails a hung comment RPC visibly instead of sticking sending forever", async () => {
    clientMock.rpc.mockReturnValue(new Promise(() => {}));

    const pending = addComment("p1", "hello");
    // Attach before advancing so the timer-tick rejection is observed.
    const assertion = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(COMMENT_POST_TIMEOUT_MS);

    // The composer keeps the text on failure, so the user verifies the
    // thread before resending — the hang just becomes a normal retry.
    await assertion;
  });

  it("still posts a fast comment without waiting for the budget", async () => {
    clientMock.rpc.mockResolvedValue({ data: [commentRow({ id: "c9" })], error: null });

    const comment = await addComment("p1", "thanks!");

    expect(comment.id).toBe("c9");
  });
});
