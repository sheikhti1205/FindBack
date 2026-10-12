import { beforeEach, describe, expect, it, vi } from "vitest";

type AuthListener = (event: string, session: { access_token: string } | null) => void;

const { clientMock, channels, subscribeState } = vi.hoisted(() => {
  const channels: Array<{
    topic: string;
    opts: { config?: { private?: boolean } };
    handlers: Array<{ event: string; cb: (message: unknown) => void }>;
    on: (type: string, filter: { event: string }, cb: (message: unknown) => void) => unknown;
    subscribe: (cb?: (status: string) => void) => unknown;
    statusCb?: (status: string) => void;
  }> = [];
  const subscribeState = { status: "SUBSCRIBED" as string };
  function makeChannel(topic: string, opts: { config?: { private?: boolean } }) {
    const channel = {
      topic,
      opts,
      handlers: [] as Array<{ event: string; cb: (message: unknown) => void }>,
      statusCb: undefined as ((status: string) => void) | undefined,
      on(_type: string, filter: { event: string }, cb: (message: unknown) => void) {
        channel.handlers.push({ event: filter.event, cb });
        return channel;
      },
      subscribe(cb?: (status: string) => void) {
        channel.statusCb = cb;
        cb?.(subscribeState.status);
        return channel;
      },
    };
    channels.push(channel);
    return channel;
  }
  const clientMock = {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn((cb: AuthListener) => {
        void cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
    },
    realtime: { setAuth: vi.fn() },
    channel: vi.fn((topic: string, opts: { config?: { private?: boolean } }) => makeChannel(topic, opts)),
    removeChannel: vi.fn((_channel?: unknown) => Promise.resolve("ok")),
  };
  return { clientMock, channels, subscribeState };
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

function lastOf(topic: string) {
  return channels.filter((c) => c.topic === topic).at(-1)!;
}

function feedCount(topic = "feed") {
  return channels.filter((c) => c.topic === topic).length;
}

/** Mock channels the module has not handed to removeChannel yet. */
function liveFeedCount() {
  const removed = new Set(clientMock.removeChannel.mock.calls.map((call) => call[0]));
  return channels.filter((c) => c.topic === "feed" && !removed.has(c)).length;
}

function captureAuthListener() {
  let listener: AuthListener | undefined;
  clientMock.auth.onAuthStateChange.mockImplementation((cb: AuthListener) => {
    listener = cb;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  return () => listener;
}

beforeEach(() => {
  channels.length = 0;
  subscribeState.status = "SUBSCRIBED";
  clientMock.channel.mockClear();
  clientMock.removeChannel.mockClear();
  clientMock.realtime.setAuth.mockClear();
  clientMock.auth.getSession.mockReset();
  clientMock.auth.getSession.mockResolvedValue({ data: { session: { access_token: "tok-123" } } });
  clientMock.auth.onAuthStateChange.mockReset();
  clientMock.auth.onAuthStateChange.mockImplementation(() => ({
    data: { subscription: { unsubscribe: vi.fn() } },
  }));
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

  it("invalidates feed caches on INSERT, UPDATE, and DELETE", async () => {
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

describe("joinInboxRoom", () => {
  it("subscribes to the private per-user inbox topic and dispatches the signal", async () => {
    const mod = await load();
    const seen: unknown[] = [];
    mod.onRealtime("notification:added", (p) => seen.push(p));
    mod.connectRealtime();
    mod.joinInboxRoom("user-1");
    await flush();

    const channel = find("notification:user-1");
    expect(channel.opts.config?.private).toBe(true);
    emit(channel, "notification:added", { op: "insert" });

    expect(seen).toEqual([{ op: "insert" }]);
  });

  it("is idempotent and can be torn down", async () => {
    const mod = await load();
    mod.connectRealtime();
    mod.joinInboxRoom("u1");
    mod.joinInboxRoom("u1");
    await flush();
    expect(channels.filter((c) => c.topic === "notification:u1")).toHaveLength(1);

    mod.leaveInboxRoom();
    expect(clientMock.removeChannel).toHaveBeenCalledTimes(1);
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

describe("connection resilience", () => {
  it("re-applies the access token on every auth change (token refresh)", async () => {
    const getListener = captureAuthListener();
    const mod = await load();
    mod.connectRealtime();
    await flush();
    clientMock.realtime.setAuth.mockClear();

    getListener()?.("TOKEN_REFRESHED", { access_token: "tok-refreshed" });

    expect(clientMock.realtime.setAuth).toHaveBeenCalledWith("tok-refreshed");
  });

  it("tears down user-scoped channels when the session is signed out", async () => {
    const getListener = captureAuthListener();
    const mod = await load();
    mod.connectRealtime();
    mod.joinInboxRoom("user-1");
    await flush();

    getListener()?.("SIGNED_OUT", null);

    expect(clientMock.removeChannel).toHaveBeenCalledTimes(2);
    // The listener registry survives sign-out so consumers keep their handlers.
    const subscription = clientMock.auth.onAuthStateChange.mock.results.at(-1)?.value
      ?.data?.subscription;
    expect(subscription?.unsubscribe).toHaveBeenCalled();
  });

  it("reconnects a dropped feed channel with backoff and resets after a good subscribe", async () => {
    vi.useFakeTimers();
    try {
      const mod = await load();
      mod.connectRealtime();
      await vi.advanceTimersByTimeAsync(0);
      expect(liveFeedCount()).toBe(1);

      lastOf("feed").statusCb?.("CHANNEL_ERROR");
      expect(clientMock.removeChannel).toHaveBeenCalledTimes(1);
      expect(liveFeedCount()).toBe(0);

      // First retry lands after 1s.
      await vi.advanceTimersByTimeAsync(999);
      expect(liveFeedCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(liveFeedCount()).toBe(1);
      expect(clientMock.channel).toHaveBeenCalledTimes(2);

      // A retried subscribe that fails on arrival is torn down and retried
      // again; two failures in a row double the wait to 2s.
      subscribeState.status = "CHANNEL_ERROR";
      lastOf("feed").statusCb?.("TIMED_OUT");
      await vi.advanceTimersByTimeAsync(999);
      expect(liveFeedCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(clientMock.channel).toHaveBeenCalledTimes(3);
      expect(liveFeedCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(liveFeedCount()).toBe(0);

      subscribeState.status = "SUBSCRIBED";
      await vi.advanceTimersByTimeAsync(1);
      expect(liveFeedCount()).toBe(1);

      // A successful subscribe resets the counter: the next retry is 1s again.
      lastOf("feed").statusCb?.("CHANNEL_ERROR");
      await vi.advanceTimersByTimeAsync(999);
      expect(liveFeedCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(liveFeedCount()).toBe(1);
      expect(clientMock.channel).toHaveBeenCalledTimes(5);
    } finally {
      subscribeState.status = "SUBSCRIBED";
      vi.useRealTimers();
    }
  });

  it("cancels a pending reconnect when realtime is disconnected", async () => {
    vi.useFakeTimers();
    try {
      const mod = await load();
      mod.connectRealtime();
      await vi.advanceTimersByTimeAsync(0);

      lastOf("feed").statusCb?.("CHANNEL_ERROR");
      mod.disconnectRealtime();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(liveFeedCount()).toBe(0);
      expect(clientMock.channel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the previous user's inbox channel on an account switch", async () => {
    const mod = await load();
    const seen: unknown[] = [];
    mod.onRealtime("notification:added", (p) => seen.push(p));
    mod.connectRealtime();
    mod.joinInboxRoom("user-1");
    await flush();
    expect(feedCount("notification:user-1")).toBe(1);

    mod.joinInboxRoom("user-2");
    await flush();

    expect(clientMock.removeChannel).toHaveBeenCalledTimes(1);
    expect(feedCount("notification:user-2")).toBe(1);
    emit(find("notification:user-2"), "notification:added", { op: "insert" });
    expect(seen).toEqual([{ op: "insert" }]);
  });
});
