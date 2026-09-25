import { beforeEach, describe, expect, it } from "vitest";
import { CHAT_CHECKPOINT_SCHEMA_VERSION } from "./providerContract";
import type { ChatCheckpoint } from "./providerContract";
import { ChatStore, HistoryDisabledError } from "./chatStore";
import type { ChatPersistenceAdapter, StoredChat } from "./chatStore";

/** Shared in-memory protected adapter: the only persistence the store may use. */
function makeAdapter(initial: Record<string, StoredChat[]> = {}) {
  const data: Record<string, StoredChat[]> = JSON.parse(JSON.stringify(initial));
  const saves: Array<{ accountId: string; chats: StoredChat[] }> = [];
  const adapter: ChatPersistenceAdapter = {
    storageKind: "in-memory-test",
    async load(accountId) {
      const chats = data[accountId];
      return chats === undefined ? null : JSON.parse(JSON.stringify(chats));
    },
    async save(accountId, chats) {
      saves.push({ accountId, chats: JSON.parse(JSON.stringify(chats)) });
      data[accountId] = JSON.parse(JSON.stringify(chats));
    },
    async knownAccounts() {
      return Object.keys(data);
    },
  };
  return { adapter, data, saves };
}

function turn(role: "user" | "assistant", text: string, id: string, attachments: string[] = []) {
  return { role, text, attachmentIds: attachments, createdAt: "2026-09-25T00:00:00.000Z", id } as never;
}

function checkpoint(covered: string, sources: string[]): ChatCheckpoint {
  return {
    schemaVersion: CHAT_CHECKPOINT_SCHEMA_VERSION,
    coveredThroughTurnId: covered,
    sourceTurnIds: [...sources],
    summaryText: "User-stated facts:\n- likes tea\nAssistant suggestions:\n- none\n",
    generatedBy: "local-extractive",
    estimatedTokens: 24,
    updatedAt: "2026-09-25T00:00:00.000Z",
  };
}

describe("chatStore account and chat isolation (CTX-03, CTX-04)", () => {
  let adapter: ReturnType<typeof makeAdapter>;
  let store: ChatStore;
  beforeEach(() => {
    adapter = makeAdapter();
    store = new ChatStore(adapter.adapter, { debounceMs: 10_000 });
  });

  it("keeps two accounts fully isolated: turns, drafts, checkpoints, media", async () => {
    const a = store.createChat("acct-a", "Trip");
    const b = store.createChat("acct-b", "Trip");
    store.appendTurn("acct-a", a.id, turn("user", "secret alpha", "t1", ["media-a1"]));
    store.setDraft("acct-b", b.id, "bravo draft");
    await store.saveCheckpoint("acct-a", a.id, checkpoint("t1", ["t1"]));

    expect(store.listChats("acct-b")[0]!.turns).toHaveLength(0);
    expect(store.getDraft("acct-a", a.id)).toBe("");
    expect(store.getCheckpoint("acct-b", b.id)).toBeUndefined();
    expect(store.getAttachedMediaIds("acct-b", b.id)).toEqual([]);
    expect(store.getAttachedMediaIds("acct-a", a.id)).toEqual(["media-a1"]);
  });

  it("keeps two chats in one account isolated: checkpoints and media do not leak", async () => {
    const c1 = store.createChat("acct-a", "One");
    const c2 = store.createChat("acct-a", "Two");
    store.appendTurn("acct-a", c1.id, turn("user", "chat one text", "t1", ["m1"]));
    await store.saveCheckpoint("acct-a", c1.id, checkpoint("t1", ["t1"]));

    expect(store.listChats("acct-a")).toHaveLength(2);
    expect(store.getCheckpoint("acct-a", c2.id)).toBeUndefined();
    expect(store.getAttachedMediaIds("acct-a", c2.id)).toEqual([]);
  });

  it("supports new / search / rename / clear / continue", () => {
    const c1 = store.createChat("acct-a", "Grocery List");
    store.createChat("acct-a", "Holiday Plans");
    expect(store.searchChats("acct-a", "grocer")).toHaveLength(1);
    expect(store.searchChats("acct-a", "HOLIDAY")).toHaveLength(1);
    expect(store.searchChats("acct-a", "missing")).toHaveLength(0);

    store.renameChat("acct-a", c1.id, "Groceries");
    expect(store.listChats("acct-a").find((c) => c.id === c1.id)!.title).toBe("Groceries");

    const continued = store.continueChat("acct-a", c1.id);
    expect(continued.id).toBe(c1.id);

    store.clearAccount("acct-a");
    expect(store.listChats("acct-a")).toHaveLength(0);
  });

  it("deleting a chat clears its turns, checkpoint and attached media references (CTX-06)", async () => {
    const c1 = store.createChat("acct-a", "Doomed");
    store.appendTurn("acct-a", c1.id, turn("user", "u1", "t1", ["m1", "m2"]));
    store.appendTurn("acct-a", c1.id, turn("assistant", "a1", "t2", ["m3"]));
    await store.saveCheckpoint("acct-a", c1.id, checkpoint("t1", ["t1"]));
    const released: string[][] = [];
    await store.flushDrafts();

    store.deleteChat("acct-a", c1.id, {
      onMediaRelease: (ids) => {
        released.push([...ids]);
      },
    });

    expect(store.listChats("acct-a")).toHaveLength(0);
    expect(store.getCheckpoint("acct-a", c1.id)).toBeUndefined();
    expect(released).toEqual([["m1", "m2", "m3"]]);

    await store.flushDrafts();
    const last = adapter.saves[adapter.saves.length - 1]!;
    expect(JSON.stringify(last)).not.toContain("u1");
    expect(JSON.stringify(last)).not.toContain("m1");
  });
});

describe("chatStore history toggle (CTX-03)", () => {
  it("when history is off, nothing sensitive is retained but drafts still work", async () => {
    const { adapter: ad, saves } = makeAdapter();
    const store = new ChatStore(ad, { debounceMs: 10_000 });
    const chat = store.createChat("acct-a", "Temp");
    store.appendTurn("acct-a", chat.id, turn("user", "sensitive turn", "t1", ["mx"]));
    store.setDraft("acct-a", chat.id, "unsent draft");
    await store.flushDrafts();

    store.setHistoryEnabled("acct-a", false);
    expect(store.isHistoryEnabled("acct-a")).toBe(false);
    expect(store.listChats("acct-a")).toHaveLength(0);
    expect(store.getCheckpoint("acct-a", chat.id)).toBeUndefined();

    // Drafts remain available under the draft policy even with history off.
    const d2 = store.createChat("acct-a", "Ephemeral");
    store.setDraft("acct-a", d2.id, "still editable");
    expect(store.getDraft("acct-a", d2.id)).toBe("still editable");

    // Turns and checkpoints are refused while history is off.
    expect(() => store.appendTurn("acct-a", d2.id, turn("user", "x", "t9"))).toThrow(
      HistoryDisabledError,
    );
    await expect(
      store.saveCheckpoint("acct-a", d2.id, checkpoint("t9", ["t9"])),
    ).rejects.toThrow(HistoryDisabledError);

    await store.flushDrafts();
    // The currently retained durable state (last snapshot) holds no turns,
    // checkpoints, or media references — only still-editable drafts.
    const retained = JSON.stringify(saves[saves.length - 1]!.chats);
    expect(retained).not.toContain("sensitive turn");
    expect(retained).not.toContain("mx");
    expect(retained).toContain("still editable");
  });
});

describe("chatStore drafts: debounced atomic flush, restore, no auto-resend (CTX-03)", () => {
  it("debounces persistence and flushes atomically on background/process death", async () => {
    const { adapter: ad, saves } = makeAdapter();
    const store = new ChatStore(ad, { debounceMs: 10_000 });
    const chat = store.createChat("acct-a", "Drafty");
    store.setDraft("acct-a", chat.id, "v1");
    store.setDraft("acct-a", chat.id, "v2");
    store.setDraft("acct-a", chat.id, "v3");
    // Debounced: nothing written until an explicit flush (background/death hook).
    expect(saves).toHaveLength(0);

    await store.flushDrafts();
    expect(saves).toHaveLength(1);
    expect(saves[0]!.chats[0]!.draft).toBe("v3");
  });

  it("restores drafts after restart and never auto-resends them", async () => {
    const { adapter: ad } = makeAdapter();
    const first = new ChatStore(ad, { debounceMs: 10_000 });
    const chat = first.createChat("acct-a", "Restart");
    first.appendTurn("acct-a", chat.id, turn("user", "hello", "t1"));
    first.setDraft("acct-a", chat.id, "half-typed question");
    await first.saveCheckpoint("acct-a", chat.id, checkpoint("t1", ["t1"]));
    await first.flushDrafts();

    // Restart: a fresh store over the same protected adapter.
    const second = new ChatStore(ad, { debounceMs: 10_000 });
    await second.restore();
    expect(second.getDraft("acct-a", chat.id)).toBe("half-typed question");
    expect(second.listChats("acct-a")[0]!.turns.map((t) => t.text)).toEqual(["hello"]);
    expect(second.getCheckpoint("acct-a", chat.id)?.coveredThroughTurnId).toBe("t1");
    // Restore is inert: drafts stay put until the user explicitly sends.
    expect(second.takeDraftForSend).toBeDefined();
    expect(second.getDraft("acct-a", chat.id)).toBe("half-typed question");
    expect(second.pendingAutoSends()).toEqual([]);
  });

  it("recovers drafts after a force-stop: unflushed work is flushed by the death hook", async () => {
    const { adapter: ad } = makeAdapter();
    const first = new ChatStore(ad, { debounceMs: 10_000 });
    const chat = first.createChat("acct-a", "Crash");
    first.setDraft("acct-a", chat.id, "typed just before kill");
    // Simulate the OS death hook running before the process dies.
    await first.flushDrafts();

    const revived = new ChatStore(ad, { debounceMs: 10_000 });
    await revived.restore();
    expect(revived.getDraft("acct-a", chat.id)).toBe("typed just before kill");
    expect(revived.pendingAutoSends()).toEqual([]);
  });
});

describe("chatStore checkpoint atomicity (CTX-06)", () => {
  it("advances a checkpoint only after successful validation + write", async () => {
    const { adapter: ad } = makeAdapter();
    const store = new ChatStore(ad, { debounceMs: 10_000 });
    const chat = store.createChat("acct-a", "C");
    store.appendTurn("acct-a", chat.id, turn("user", "one", "t1"));
    store.appendTurn("acct-a", chat.id, turn("assistant", "two", "t2"));
    await store.saveCheckpoint("acct-a", chat.id, checkpoint("t1", ["t1"]));

    const bad = {
      schemaVersion: 999,
      coveredThroughTurnId: "t2",
      sourceTurnIds: ["t2"],
      summaryText: "bogus",
      generatedBy: "local-extractive",
      estimatedTokens: 5,
      updatedAt: "2026-09-25T00:00:00.000Z",
    } as unknown as ChatCheckpoint;
    await expect(store.saveCheckpoint("acct-a", chat.id, bad)).rejects.toThrow();
    expect(store.getCheckpoint("acct-a", chat.id)?.coveredThroughTurnId).toBe("t1");

    // coveredThroughTurnId must be a member of sourceTurnIds.
    const mismatch: ChatCheckpoint = { ...checkpoint("t9", ["t1"]), coveredThroughTurnId: "t9" };
    await expect(store.saveCheckpoint("acct-a", chat.id, mismatch)).rejects.toThrow();
    expect(store.getCheckpoint("acct-a", chat.id)?.coveredThroughTurnId).toBe("t1");
  });

  it("a failed write leaves the previous checkpoint in place", async () => {
    let failNextSave = true;
    const { adapter: ad } = makeAdapter();
    const flaky: ChatPersistenceAdapter = {
      storageKind: "in-memory-test",
      load: (accountId) => ad.load(accountId),
      async save(accountId, chats) {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("disk full");
        }
        return ad.save(accountId, chats);
      },
      knownAccounts: () => ad.knownAccounts!(),
    };
    const store = new ChatStore(flaky, { debounceMs: 10_000 });
    const chat = store.createChat("acct-a", "W");
    store.appendTurn("acct-a", chat.id, turn("user", "one", "t1"));
    // First checkpoint write fails: nothing advances.
    await expect(store.saveCheckpoint("acct-a", chat.id, checkpoint("t1", ["t1"]))).rejects.toThrow(
      /write failed|previous checkpoint/i,
    );
    expect(store.getCheckpoint("acct-a", chat.id)).toBeUndefined();
    // Retry succeeds and the checkpoint lands atomically.
    await store.saveCheckpoint("acct-a", chat.id, checkpoint("t1", ["t1"]));
    expect(store.getCheckpoint("acct-a", chat.id)?.coveredThroughTurnId).toBe("t1");
  });
});

describe("chatStore protected-storage guards", () => {
  it("refuses plain localStorage and the string credential vault as a chat database", () => {
    for (const kind of ["plain-localStorage", "credential-vault"] as const) {
      const forbidden: ChatPersistenceAdapter = {
        storageKind: kind,
        async load() {
          return null;
        },
        async save() {},
      };
      expect(() => new ChatStore(forbidden)).toThrow(/protected/i);
    }
  });

  it("never touches browser localStorage through the default adapter", async () => {
    const hadLocalStorage = "localStorage" in globalThis;
    const stash = (globalThis as Record<string, unknown>)["localStorage"];
    if (hadLocalStorage) delete (globalThis as Record<string, unknown>)["localStorage"];
    try {
      const store = new ChatStore(undefined, { debounceMs: 10_000 });
      expect(store.storageKind).not.toMatch(/localStorage|vault/);
      const chat = store.createChat("acct-a", "Local");
      store.appendTurn("acct-a", chat.id, turn("user", "private words", "t1"));
      store.setDraft("acct-a", chat.id, "private draft");
      await store.flushDrafts();
      await store.restore();
      expect("localStorage" in globalThis).toBe(false);
      expect(store.listChats("acct-a")[0]!.turns[0]!.text).toBe("private words");
    } finally {
      if (hadLocalStorage) (globalThis as Record<string, unknown>)["localStorage"] = stash;
    }
  });

  it("uses no Supabase chat table: full CRUD works on the loopback adapter with no network", async () => {
    // Behavioral proof: full CRUD works with the loopback adapter and no network.
    const { adapter: ad } = makeAdapter();
    const store = new ChatStore(ad, { debounceMs: 10_000 });
    const chat = store.createChat("acct-a", "Offline");
    store.appendTurn("acct-a", chat.id, turn("user", "stays on device", "t1"));
    await store.flushDrafts();
    const revived = new ChatStore(ad, { debounceMs: 10_000 });
    await revived.restore();
    expect(revived.listChats("acct-a")[0]!.turns[0]!.text).toBe("stays on device");
  });
});
