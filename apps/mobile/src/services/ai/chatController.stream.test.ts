import { describe, expect, it } from "vitest";
import type {
  AiSelection,
  ChatTurn,
  ModelRecord,
  NormalizedRequest,
  ProviderAdapter,
  StreamEvent,
} from "./providerContract";
import { priceFingerprint } from "./modelCatalog";
import { ChatStore } from "./chatStore";
import type { ChatPersistenceAdapter, StoredChat } from "./chatStore";
import { ChatController, ControllerError } from "./chatController";
import type { VersionedText } from "./requestAssembler";

function makeAdapter() {
  const data: Record<string, StoredChat[]> = {};
  const adapter: ChatPersistenceAdapter = {
    storageKind: "in-memory-test",
    async load(accountId) {
      const chats = data[accountId];
      return chats === undefined ? null : JSON.parse(JSON.stringify(chats));
    },
    async save(accountId, chats) {
      data[accountId] = JSON.parse(JSON.stringify(chats));
    },
    async knownAccounts() {
      return Object.keys(data);
    },
  };
  return adapter;
}

function turn(id: string, role: "user" | "assistant", text: string): ChatTurn {
  return { id, role, text, attachmentIds: [], createdAt: "2026-09-25T00:00:00.000Z" };
}

const selection: AiSelection = {
  accountId: "acct-a",
  provider: "openrouter",
  modelId: "openrouter/free",
  mode: "free-only",
};

const policy: VersionedText = { version: "policy-v3", text: "POLICY v3: be helpful." };
const knowledge: VersionedText = { version: "manual-v7", text: "MANUAL v7: Report tab publishes." };

function budgetTerms() {
  return {
    verifiedContextWindow: 200_000,
    reservedOutput: 4_096,
    imageAllowance: 0,
    protocolOverhead: 1_000,
    safetyMargin: 2_000,
  };
}

function record(
  id: string,
  priceClass: ModelRecord["priceClass"],
  entitlement: ModelRecord["entitlement"] = "verified",
): ModelRecord {
  const prices =
    priceClass === "free"
      ? [
          { amountDecimal: "0", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
          { amountDecimal: "0", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
        ]
      : priceClass === "paid"
        ? [
            { amountDecimal: "0.000003", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
            { amountDecimal: "0.000015", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
          ]
        : [];
  return {
    provider: "openrouter",
    id,
    input: ["text"],
    output: ["text"],
    contextTokens: 200_000,
    prices,
    priceClass,
    retrievedAt: "2026-09-26T00:00:00.000Z",
    entitlement,
  } as ModelRecord;
}

const freeCatalog = [record("openrouter/free", "free"), record("other/free-model", "free")];
const paidRecord = record("paid/model", "paid");
const unknownRecord = record("mystery/model", "unknown");
const blockedRecord = record("blocked/model", "free", "blocked");

function caps() {
  return {
    vision: { state: "unknown" as const },
    maxImagesPerCall: { state: "unknown" as const },
    contextTokens: { state: "known" as const, value: 200_000 },
    maxOutputTokens: { state: "known" as const, value: 4_096 },
    streaming: { state: "known" as const, value: true },
  };
}

async function seedStore(): Promise<{ store: ChatStore; chatId: string }> {
  const store = new ChatStore(makeAdapter(), { debounceMs: 60_000 });
  const chat = store.createChat("acct-a", "Help");
  store.appendTurn("acct-a", chat.id, turn("t1", "user", "I lost my umbrella."));
  await store.flushDrafts();
  return { store, chatId: chat.id };
}

/** Manually-pumped adapter: the test decides exactly when each chunk lands. */
function pausedAdapter() {
  const requests: NormalizedRequest[] = [];
  let push!: (event: StreamEvent) => void;
  let done!: () => void;
  const gate = new Promise<void>((resolve) => {
    done = resolve;
  });
  const queue: StreamEvent[] = [];
  const adapter: ProviderAdapter & {
    requests: NormalizedRequest[];
    emit: (event: StreamEvent) => void;
    finish: () => void;
    gate: Promise<void>;
  } = {
    requests,
    gate,
    emit: (event) => {
      queue.push(event);
      push({ kind: "text", attempt: 1, delta: "" });
    },
    finish: () => done(),
    id: "openrouter",
    capabilities: caps,
    async *complete(request: NormalizedRequest): AsyncIterable<StreamEvent> {
      requests.push(request);
      for (;;) {
        if (queue.length > 0) {
          const next = queue.shift()!;
          if (next.kind === "text" && next.delta === "") continue;
          yield next;
          if (next.kind === "done") return;
          continue;
        }
        await new Promise<void>((resolve) => {
          push = () => resolve();
        });
      }
    },
  };
  return adapter;
}

describe("chatController streaming state (M2)", () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("accumulates deltas into partialText via subscribe while streaming", async () => {
    const { store, chatId } = await seedStore();
    const adapter = pausedAdapter();
    const controller = new ChatController({
      store,
      selection,
      adapter,
      systemPolicy: policy,
      knowledge,
      budget: budgetTerms(),
      catalog: freeCatalog,
    });
    const partials: string[] = [];
    const phases: string[] = [];
    const unsub = controller.subscribe((state) => {
      partials.push(state.partialText);
      phases.push(state.phase);
    });
    const initial = controller.getState();
    expect(initial.partialText).toBe("");
    const pending = controller.send(chatId, "hello?");
    await tick();
    adapter.emit({ kind: "text", attempt: 1, delta: "hel" });
    await tick();
    adapter.emit({ kind: "text", attempt: 1, delta: "lo" });
    await tick();
    const mid = controller.getState();
    expect(mid.phase).toBe("streaming");
    expect(mid.partialText).toBe("hello");
    expect(mid.attempt).toBe(1);
    expect(mid.provider).toBe("openrouter");
    expect(mid.modelId).toBe("openrouter/free");
    adapter.emit({ kind: "done", attempt: 1, stopReason: "complete" });
    const result = await pending;
    unsub();
    expect(result.answer).toBe("hello");
    expect(partials).toContain("hello");
    expect(phases).toContain("streaming");
    expect(controller.getState().phase).toBe("complete");
  });

  it("cancel() ignores late chunks and persists no partial turn", async () => {
    const { store, chatId } = await seedStore();
    const adapter = pausedAdapter();
    const controller = new ChatController({
      store,
      selection,
      adapter,
      systemPolicy: policy,
      knowledge,
      budget: budgetTerms(),
      catalog: freeCatalog,
    });
    const before = store.listChats("acct-a")[0]!.turns.length;
    const pending = controller.send(chatId, "will cancel");
    await tick();
    adapter.emit({ kind: "text", attempt: 1, delta: "partial-" });
    await tick();
    expect(controller.getState().partialText).toBe("partial-");
    controller.cancel();
    // Late chunk after cancel must be ignored, never persisted.
    adapter.emit({ kind: "text", attempt: 1, delta: "late-should-not-land" });
    adapter.emit({ kind: "done", attempt: 1, stopReason: "complete" });
    await expect(pending).rejects.toThrow(ControllerError);
    expect(controller.getState().phase).toBe("cancelled");
    const texts = store.listChats("acct-a")[0]!.turns.map((t) => t.text);
    expect(store.listChats("acct-a")[0]!.turns.length).toBe(before);
    expect(texts.join("\n")).not.toContain("late-should-not-land");
    expect(texts.join("\n")).not.toContain("partial-");
  });

  it("send() with a per-request free selection reaches the request (model change mid-chat)", async () => {
    const { store, chatId } = await seedStore();
    const requests: NormalizedRequest[] = [];
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete(request: NormalizedRequest): AsyncIterable<StreamEvent> {
        requests.push(request);
        yield { kind: "text", attempt: 1, delta: "ok" };
        yield { kind: "done", attempt: 1, stopReason: "complete" };
      },
    };
    const controller = new ChatController({
      store,
      selection,
      adapter,
      systemPolicy: policy,
      knowledge,
      budget: budgetTerms(),
      catalog: freeCatalog,
    });
    const override: AiSelection = {
      accountId: "acct-a",
      provider: "openrouter",
      modelId: "other/free-model",
      mode: "free-only",
    };
    await controller.send(chatId, "via override", { selection: override });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.selection.modelId).toBe("other/free-model");
    expect(controller.getState().modelId).toBe("other/free-model");
  });

  it("paid selection without consent fails closed with no send", async () => {
    const { store, chatId } = await seedStore();
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete(request: NormalizedRequest): AsyncIterable<StreamEvent> {
        calls += 1;
        void request;
        yield { kind: "done", attempt: 1, stopReason: "complete" };
      },
    };
    const controller = new ChatController({
      store,
      selection,
      adapter,
      systemPolicy: policy,
      knowledge,
      budget: budgetTerms(),
      catalog: [...freeCatalog, paidRecord],
    });
    const attempt = controller.send(chatId, "use paid", {
      selection: { accountId: "acct-a", provider: "openrouter", modelId: "paid/model", mode: "free-only" },
    });
    await expect(attempt).rejects.toThrow(ControllerError);
    expect(calls).toBe(0);
    expect(controller.getState().phase).toBe("failed");
    expect(controller.getState().lastError ?? "").not.toContain("use paid");
  });

  it("unknown-price selection is never consentable, even with paid-explicit mode", async () => {
    const { store, chatId } = await seedStore();
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { kind: "done", attempt: 1, stopReason: "complete" };
      },
    };
    const controller = new ChatController({
      store,
      selection,
      adapter,
      systemPolicy: policy,
      knowledge,
      budget: budgetTerms(),
      catalog: [...freeCatalog, unknownRecord],
    });
    const attempt = controller.send(chatId, "use mystery", {
      selection: {
        accountId: "acct-a",
        provider: "openrouter",
        modelId: "mystery/model",
        mode: "paid-explicit",
        paidConsent: {
          provider: "openrouter",
          modelId: "mystery/model",
          fingerprint: priceFingerprint(unknownRecord),
          taskScopes: ["general"],
          acceptedAt: "2026-09-26T00:00:00.000Z",
        },
      },
    });
    await expect(attempt).rejects.toThrow(ControllerError);
    expect(calls).toBe(0);
    expect(controller.getState().phase).toBe("failed");
  });

  it("blocked-model selection fails closed with no send and a sanitized error", async () => {
    const { store, chatId } = await seedStore();
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { kind: "done", attempt: 1, stopReason: "complete" };
      },
    };
    const controller = new ChatController({
      store,
      selection,
      adapter,
      systemPolicy: policy,
      knowledge,
      budget: budgetTerms(),
      catalog: [...freeCatalog, blockedRecord],
    });
    const attempt = controller.send(chatId, "use blocked", {
      selection: { accountId: "acct-a", provider: "openrouter", modelId: "blocked/model", mode: "free-only" },
    });
    await expect(attempt).rejects.toThrow(ControllerError);
    expect(calls).toBe(0);
    expect(controller.getState().phase).toBe("failed");
    expect(controller.getState().lastError ?? "").not.toContain("use blocked");
  });

  it("provider failure emits failed with a sanitized lastError (no key/prompt leak)", async () => {
    const { store, chatId } = await seedStore();
    const adapter: ProviderAdapter = {
      id: "openrouter",
      capabilities: caps,
      async *complete(): AsyncIterable<StreamEvent> {
        yield {
          kind: "error",
          attempt: 1,
          code: "auth-missing",
          message: "bad key sk-or-v1-SECRET123 with Bearer abcdef and prompt: my secret question",
          retryable: false,
        };
        yield { kind: "done", attempt: 1, stopReason: "error" };
      },
    };
    const controller = new ChatController({
      store,
      selection,
      adapter,
      systemPolicy: policy,
      knowledge,
      budget: budgetTerms(),
      catalog: freeCatalog,
    });
    await expect(controller.send(chatId, "my secret question")).rejects.toThrow(ControllerError);
    const state = controller.getState();
    expect(state.phase).toBe("failed");
    expect(state.lastError ?? "").not.toContain("SECRET123");
    expect(state.lastError ?? "").not.toContain("my secret question");
    expect(state.lastError ?? "").not.toContain("abcdef");
  });
});
