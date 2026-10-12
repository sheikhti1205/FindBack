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

import { CREATE_POST_RPC_TIMEOUT_MS, createPost } from "./postsCreate";
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
