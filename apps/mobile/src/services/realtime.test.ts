import { beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, channels } = vi.hoisted(() => {
  const channels: Array<{
    topic: string;
    opts: { config?: { private?: boolean } };
    handlers: Array<{ event: string; cb: (message: unknown) => void }>;
    on: (type: string, filter: { event: string }, cb: (message: unknown) => void) => unknown;
    subscribe: (cb?: (status: string) => void) => unknown;
  }> = [];
  function makeChannel(topic: string, opts: { config?: { private?: boolean } }) {
    const channel = {
      topic,
      opts,
      handlers: [] as Array<{ event: string; cb: (message: unknown) => void }>,
      on(_type: string, filter: { event: string }, cb: (message: unknown) => void) {
        channel.handlers.push({ event: filter.event, cb });
        return channel;
      },
      subscribe(cb?: (status: string) => void) {
        cb?.("SUBSCRIBED");
        return channel;
      },
    };
    channels.push(channel);
    return channel;
  }
  const clientMock = {
    auth: { getSession: vi.fn() },
    realtime: { setAuth: vi.fn() },
    channel: vi.fn((topic: string, opts: { config?: { private?: boolean } }) => makeChannel(topic, opts)),
    removeChannel: vi.fn(() => Promise.resolve("ok")),
  };
  return { clientMock, channels };
});

vi.mock("./supabaseClient", () => ({ getSupabase: () => clientMock }));
vi.mock("../hooks/feedCache", () => ({ invalidateFeedCaches: vi.fn() }));

async function load() {
  vi.resetModules();
  return await import("./realtime");
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function emit(channel: (typeof channels)[number], event: string, payload: unknown) {
  const handler = channel.handlers.find((h) => h.event === event);
  handler?.cb({ event, payload });
}

function find(topic: string) {
  return channels.find((c) => c.topic === topic)!;
}

beforeEach(() => {
  channels.length = 0;
  clientMock.channel.mockClear();
  clientMock.removeChannel.mockClear();
  clientMock.realtime.setAuth.mockClear();
  clientMock.auth.getSession.mockReset();
  clientMock.auth.getSession.mockResolvedValue({ data: { session: { access_token: "tok-123" } } });
  vi.clearAllMocks();
});

describe("connectRealtime", () => {
  it("pushes the session token and subscribes to the private feed channel", async () => {
    const mod = await load();
    mod.connectRealtime();
    await flush();

    expect(clientMock.realtime.setAuth).toHaveBeenCalledWith("tok-123");
    const feed = find("feed");
    expect(feed.opts.config?.private).toBe(true);
  });

  it("translates post:changed into feed:changed", async () => {
    const mod = await load();
    const seen: unknown[] = [];
    mod.onRealtime("feed:changed", (p) => seen.push(p));
    mod.connectRealtime();
    await flush();

    emit(find("feed"), "post:changed", { postId: "p1" });

    expect(seen).toEqual([{ postId: "p1" }]);
  });

  it("invalidates feed caches on INSERT, UPDATE, and DELETE (WP7 #8)", async () => {
    const { invalidateFeedCaches } = await import("../hooks/feedCache");
    const mod = await load();
    mod.connectRealtime();
    await flush();

    const feed = find("feed");

    // INSERT
    emit(feed, "post:changed", { change: "INSERT", postId: "p1" });
    expect(invalidateFeedCaches).toHaveBeenCalledTimes(1);

    // UPDATE
    emit(feed, "post:changed", { change: "UPDATE", postId: "p2" });
    expect(invalidateFeedCaches).toHaveBeenCalledTimes(2);

    // DELETE
    emit(feed, "post:changed", { change: "DELETE", postId: "p3" });
    expect(invalidateFeedCaches).toHaveBeenCalledTimes(3);

    // COMMENT_CHANGE should NOT invalidate
    emit(feed, "post:changed", { change: "COMMENT_CHANGE", postId: "p4" });
    expect(invalidateFeedCaches).toHaveBeenCalledTimes(3);

    // REACTION_CHANGE should NOT invalidate
    emit(feed, "post:changed", { change: "REACTION_CHANGE", postId: "p5" });
    expect(invalidateFeedCaches).toHaveBeenCalledTimes(3);

    // RATING_CHANGE should NOT invalidate
    emit(feed, "post:changed", { change: "RATING_CHANGE", postId: "p6" });
    expect(invalidateFeedCaches).toHaveBeenCalledTimes(3);
  });

  it("falls back to op field when change is absent (backward compat)", async () => {
    const { invalidateFeedCaches } = await import("../hooks/feedCache");
    const mod = await load();
    mod.connectRealtime();
    await flush();

    const feed = find("feed");

    emit(feed, "post:changed", { op: "INSERT", postId: "p1" });
    expect(invalidateFeedCaches).toHaveBeenCalledTimes(1);

    emit(feed, "post:changed", { op: "UPDATE", postId: "p2" });
    expect(invalidateFeedCaches).toHaveBeenCalledTimes(2);

    emit(feed, "post:changed", { op: "DELETE", postId: "p3" });
    expect(invalidateFeedCaches).toHaveBeenCalledTimes(3);
  });

  it("does not create a second feed channel when called again", async () => {
    const mod = await load();
    mod.connectRealtime();
    mod.connectRealtime();
    await flush();
    expect(clientMock.channel).toHaveBeenCalledTimes(1);
  });
});

describe("joinPostRoom", () => {
  it("subscribes to the private post topic and maps every event name", async () => {
    const mod = await load();
    const seen = new Map<string, unknown>();
    for (const event of [
      "post:updated",
      "post:deleted",
      "comment:added",
      "comment:deleted",
      "reaction:changed",
      "rating:changed",
    ] as const) {
      mod.onRealtime(event, (p) => seen.set(event, p));
    }
    mod.connectRealtime();
    mod.joinPostRoom("p1");
    await flush();

    const channel = find("post:p1");
    expect(channel.opts.config?.private).toBe(true);
    emit(channel, "reaction:changed", { likeCount: 2 });
    emit(channel, "comment:added", { comment: { id: "c1" } });

    expect(seen.get("reaction:changed")).toEqual({ likeCount: 2 });
    expect(seen.get("comment:added")).toEqual({ comment: { id: "c1" } });
  });

  it("is idempotent per post", async () => {
    const mod = await load();
    mod.connectRealtime();
    mod.joinPostRoom("p1");
    mod.joinPostRoom("p1");
    await flush();
    expect(channels.filter((c) => c.topic === "post:p1")).toHaveLength(1);
  });
});

describe("onRealtime", () => {
  it("stops delivering after unsubscribe", async () => {
    const mod = await load();
    const seen: unknown[] = [];
    const off = mod.onRealtime("feed:changed", (p) => seen.push(p));
    mod.connectRealtime();
    await flush();
    const feed = find("feed");

    emit(feed, "post:changed", { postId: "a" });
    off();
    emit(feed, "post:changed", { postId: "b" });

    expect(seen).toEqual([{ postId: "a" }]);
  });
});

describe("teardown", () => {
  it("removes the feed and post channels on leave/disconnect", async () => {
    const mod = await load();
    mod.connectRealtime();
    mod.joinPostRoom("p1");
    await flush();

    mod.leavePostRoom("p1");
    expect(clientMock.removeChannel).toHaveBeenCalledTimes(1);

    mod.disconnectRealtime();
    expect(clientMock.removeChannel).toHaveBeenCalledTimes(2);
  });
});
