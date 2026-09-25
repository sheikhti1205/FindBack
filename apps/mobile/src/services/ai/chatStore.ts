/**
 * Account-scoped, per-chat local persistence (packet H1, Context & Memory
 * Contract §2).
 *
 * - Each account owns isolated chats `{id, title, turns, draft, checkpoint}`.
 *   Switching accounts never leaks turns, drafts, checkpoints, or media ids.
 * - New / search / rename / delete / clear / continue, plus a per-account
 *   history on/off toggle. When history is off, no turns, checkpoints, or
 *   media references are retained (drafts remain editable under the draft
 *   policy even with history off). Turn/checkpoint writes while disabled throw
 *   {@link HistoryDisabledError} so callers send transiently instead.
 * - Drafts persist debounced and atomically (one snapshot write per account);
 *   {@link ChatStore.flushDrafts} is the background/process-death hook.
 *   Restoring drafts never resends them: there is no auto-send machinery in
 *   this module (`pendingAutoSends()` is always empty; only an explicit
 *   `takeDraftForSend` consumes a draft).
 * - Deleting a chat clears its turns, its checkpoint, and its attached local
 *   media references (attachment ids), invoking `onMediaRelease` so the
 *   media owner (M1) can drop the bytes.
 * - Protected storage only: the persistence adapter must be `protected` or a
 *   test/volatile memory adapter. Plain `localStorage` transcripts and the
 *   string credential vault are refused at construction. There is no Supabase
 *   chat table and no network in this file.
 * - A `ChatCheckpoint` is swapped into memory only after validation
 *   (`isChatCheckpoint`, poison screen, source-turn provenance) AND a
 *   successful durable write. A failed write leaves the previous checkpoint
 *   in place.
 */
import { isChatCheckpoint } from "./providerContract";
import type { ChatCheckpoint, ChatTurn } from "./providerContract";
import { isSummaryPoisoned } from "./compaction";

export class HistoryDisabledError extends Error {
  constructor(accountId: string) {
    super(`Chat history is disabled for account ${accountId}; send transiently instead.`);
    this.name = "HistoryDisabledError";
  }
}

export class ChatStoreError extends Error {
  constructor(
    readonly code:
      | "missing-chat"
      | "invalid-title"
      | "invalid-turn"
      | "invalid-image-id"
      | "invalid-checkpoint"
      | "poisoned-checkpoint"
      | "unknown-source-turn"
      | "persist-failed",
    message: string,
  ) {
    super(message);
    this.name = "ChatStoreError";
  }
}

export type ChatStorageKind =
  | "protected"
  | "volatile-memory"
  | "in-memory-test"
  | "plain-localStorage"
  | "credential-vault";

export interface ChatPersistenceAdapter {
  readonly storageKind: ChatStorageKind;
  load(accountId: string): Promise<StoredChat[] | null>;
  save(accountId: string, chats: readonly StoredChat[]): Promise<void>;
  /** Account discovery for `restore()` after a restart. Optional. */
  knownAccounts?(): Promise<string[]> | string[];
}

export type StoredChat = {
  id: string;
  accountId: string;
  title: string;
  turns: ChatTurn[];
  draft: string;
  checkpoint?: ChatCheckpoint;
  createdAt: string;
  updatedAt: string;
};

export type NewTurnInput = {
  role: "user" | "assistant";
  text: string;
  attachmentIds?: readonly string[];
  /**
   * Stable caller-provided identity (e.g. shared with compaction coverage).
   * Generated when omitted. Must be unique within the chat.
   */
  id?: string;
};

export type MediaReleaseHandler = (attachmentIds: readonly string[]) => void;

export type ChatStoreOptions = {
  now?: () => string;
  makeId?: (prefix: string) => string;
  /** Debounce for scheduled persistence. `flushDrafts()` always writes now. */
  debounceMs?: number;
};

type AccountState = {
  chats: StoredChat[];
  historyEnabled: boolean;
  dirty: boolean;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isReferenceId(id: unknown): boolean {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("data:")) return false;
  if (lower.includes("base64,")) return false;
  return !/\s/.test(trimmed);
}

function mediaIdsOf(chat: StoredChat): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const turn of chat.turns) {
    for (const id of turn.attachmentIds) {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }
  return ordered;
}

export class ChatStore {
  private readonly adapter: ChatPersistenceAdapter;
  private readonly now: () => string;
  private readonly makeId: (prefix: string) => string;
  private readonly debounceMs: number;
  private readonly accounts = new Map<string, AccountState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastPersistError: unknown = null;

  constructor(adapter?: ChatPersistenceAdapter, options: ChatStoreOptions = {}) {
    if (adapter !== undefined) {
      if (adapter.storageKind === "plain-localStorage" || adapter.storageKind === "credential-vault") {
        throw new ChatStoreError(
          "persist-failed",
          "Chat transcripts require protected local storage: plain localStorage and the " +
            "string credential vault are refused as a chat database.",
        );
      }
      this.adapter = adapter;
    } else {
      // Process-memory loopback: never touches browser localStorage, never
      // the network. A platform protected adapter is provided by H2.
      const data = new Map<string, StoredChat[]>();
      this.adapter = {
        storageKind: "volatile-memory",
        load: async (accountId) => {
          const chats = data.get(accountId);
          return chats === undefined ? null : clone(chats);
        },
        save: async (accountId, chats) => {
          data.set(accountId, clone([...chats]));
        },
        knownAccounts: () => [...data.keys()],
      };
    }
    this.now = options.now ?? (() => new Date().toISOString());
    let counter = 0;
    this.makeId =
      options.makeId ??
      ((prefix) => `${prefix}-${Date.now().toString(36)}-${(counter += 1).toString(36)}`);
    this.debounceMs = options.debounceMs ?? 250;
  }

  /** Last background-persist failure, if any. In-memory state is unaffected. */
  getLastPersistError(): unknown {
    return this.lastPersistError;
  }

  /** The storage kind this store persists through. Never localStorage/vault. */
  get storageKind(): ChatStorageKind {
    return this.adapter.storageKind;
  }

  private stateFor(accountId: string): AccountState {
    let state = this.accounts.get(accountId);
    if (state === undefined) {
      state = { chats: [], historyEnabled: true, dirty: false };
      this.accounts.set(accountId, state);
    }
    return state;
  }

  private findChat(accountId: string, chatId: string): StoredChat {
    const chat = this.stateFor(accountId).chats.find((entry) => entry.id === chatId);
    if (chat === undefined || chat.accountId !== accountId) {
      throw new ChatStoreError("missing-chat", `Unknown chat ${chatId} for this account.`);
    }
    return chat;
  }

  private requireHistory(accountId: string): void {
    if (!this.stateFor(accountId).historyEnabled) {
      throw new HistoryDisabledError(accountId);
    }
  }

  private touch(chat: StoredChat): void {
    chat.updatedAt = this.now();
  }

  private schedulePersist(accountId: string): void {
    this.stateFor(accountId).dirty = true;
    const pending = this.timers.get(accountId);
    if (pending !== undefined) clearTimeout(pending);
    this.timers.set(
      accountId,
      setTimeout(() => {
        this.timers.delete(accountId);
        void this.persistAccount(accountId).catch((error: unknown) => {
          this.lastPersistError = error;
        });
      }, this.debounceMs),
    );
  }

  /** What leaves this device: history-off accounts persist shells only. */
  private snapshot(accountId: string): StoredChat[] {
    const state = this.stateFor(accountId);
    if (state.historyEnabled) return clone(state.chats);
    return state.chats.map((chat) => ({
      ...clone(chat),
      turns: [],
      draft: chat.draft,
      checkpoint: undefined,
    }));
  }

  private async persistAccount(accountId: string): Promise<void> {
    const state = this.stateFor(accountId);
    await this.adapter.save(accountId, this.snapshot(accountId));
    state.dirty = false;
  }

  /**
   * Atomic flush for backgrounding/process death: every dirty account is
   * written as one snapshot. Await this in the death hook.
   */
  async flushDrafts(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const [accountId, state] of this.accounts) {
      if (!state.dirty) continue;
      try {
        await this.persistAccount(accountId);
      } catch (error) {
        this.lastPersistError = error;
        throw new ChatStoreError("persist-failed", "Atomic draft flush failed; memory state kept.");
      }
    }
  }

  /**
   * Reload persisted chats (restart recovery). Inert by design: drafts are
   * restored as editable text and nothing is ever auto-sent — see
   * {@link pendingAutoSends}.
   */
  async restore(...accountIds: string[]): Promise<void> {
    let ids = accountIds;
    if (ids.length === 0 && typeof this.adapter.knownAccounts === "function") {
      ids = await this.adapter.knownAccounts();
    }
    if (ids.length === 0) ids = [...this.accounts.keys()];
    for (const accountId of ids) {
      const loaded = await this.adapter.load(accountId);
      const state = this.stateFor(accountId);
      if (loaded === null) continue;
      state.chats = loaded.filter(
        (chat) =>
          typeof chat?.id === "string" &&
          chat.accountId === accountId &&
          Array.isArray(chat.turns),
      );
      state.dirty = false;
    }
  }

  /** Proof of no auto-resend machinery: restores never queue a send. */
  pendingAutoSends(): readonly string[] {
    return [];
  }

  createChat(accountId: string, title = "New chat"): StoredChat {
    const trimmed = title.trim();
    if (trimmed === "") throw new ChatStoreError("invalid-title", "Chat title must not be empty.");
    const state = this.stateFor(accountId);
    const chat: StoredChat = {
      id: this.makeId("chat"),
      accountId,
      title: trimmed,
      turns: [],
      draft: "",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    state.chats.push(chat);
    this.schedulePersist(accountId);
    return clone(chat);
  }

  listChats(accountId: string): StoredChat[] {
    // History-off accounts expose no shells: turns are purged and drafts are
    // reachable only by id until re-enabled. Nothing sensitive is listed.
    if (!this.stateFor(accountId).historyEnabled) return [];
    return clone(this.stateFor(accountId).chats);
  }

  searchChats(accountId: string, query: string): StoredChat[] {
    if (!this.stateFor(accountId).historyEnabled) return [];
    const needle = query.trim().toLowerCase();
    if (needle === "") return this.listChats(accountId);
    return clone(
      this.stateFor(accountId).chats.filter(
        (chat) =>
          chat.title.toLowerCase().includes(needle) ||
          chat.turns.some((turn) => turn.text.toLowerCase().includes(needle)),
      ),
    );
  }

  renameChat(accountId: string, chatId: string, title: string): StoredChat {
    const trimmed = title.trim();
    if (trimmed === "") throw new ChatStoreError("invalid-title", "Chat title must not be empty.");
    const chat = this.findChat(accountId, chatId);
    chat.title = trimmed;
    this.touch(chat);
    this.schedulePersist(accountId);
    return clone(chat);
  }

  deleteChat(
    accountId: string,
    chatId: string,
    options: { onMediaRelease?: MediaReleaseHandler } = {},
  ): void {
    const state = this.stateFor(accountId);
    const index = state.chats.findIndex((entry) => entry.id === chatId);
    if (index === -1) throw new ChatStoreError("missing-chat", `Unknown chat ${chatId}.`);
    const [removed] = state.chats.splice(index, 1);
    const media = mediaIdsOf(removed!);
    if (media.length > 0) options.onMediaRelease?.(media);
    this.schedulePersist(accountId);
  }

  clearAccount(accountId: string, options: { onMediaRelease?: MediaReleaseHandler } = {}): void {
    const state = this.stateFor(accountId);
    const media = state.chats.flatMap(mediaIdsOf);
    state.chats = [];
    if (media.length > 0) options.onMediaRelease?.([...new Set(media)]);
    this.schedulePersist(accountId);
  }

  continueChat(accountId: string, chatId: string): StoredChat {
    // Hidden while history is off so readers (and the controller) treat the
    // chat as absent and send transiently instead of resurrecting turns.
    if (!this.stateFor(accountId).historyEnabled) {
      throw new ChatStoreError("missing-chat", `Unknown chat ${chatId} for this account.`);
    }
    return clone(this.findChat(accountId, chatId));
  }

  appendTurn(accountId: string, chatId: string, input: NewTurnInput): ChatTurn {
    this.requireHistory(accountId);
    if (input.role !== "user" && input.role !== "assistant") {
      throw new ChatStoreError("invalid-turn", "Turn role must be user or assistant.");
    }
    if (typeof input.text !== "string") {
      throw new ChatStoreError("invalid-turn", "Turn text must be a string.");
    }
    const attachmentIds = [...(input.attachmentIds ?? [])];
    for (const id of attachmentIds) {
      if (!isReferenceId(id)) {
        throw new ChatStoreError(
          "invalid-image-id",
          "Turn attachments must be local reference ids, never inline bytes.",
        );
      }
    }
    const chat = this.findChat(accountId, chatId);
    if (input.id !== undefined) {
      if (input.id.trim() === "") {
        throw new ChatStoreError("invalid-turn", "Turn id must not be empty.");
      }
      if (chat.turns.some((turn) => turn.id === input.id)) {
        throw new ChatStoreError("invalid-turn", `Duplicate turn id ${input.id}.`);
      }
    }
    const turn: ChatTurn = {
      id: input.id ?? this.makeId("turn"),
      role: input.role,
      text: input.text,
      attachmentIds,
      createdAt: this.now(),
    };
    chat.turns.push(turn);
    this.touch(chat);
    this.schedulePersist(accountId);
    return clone(turn);
  }

  setDraft(accountId: string, chatId: string, text: string): void {
    const chat = this.findChat(accountId, chatId);
    chat.draft = text;
    this.touch(chat);
    this.schedulePersist(accountId);
  }

  getDraft(accountId: string, chatId: string): string {
    return this.findChat(accountId, chatId).draft;
  }

  /**
   * Explicitly consume a draft for a user-initiated send. Restore paths never
   * call this — the only way a draft leaves the composer.
   */
  takeDraftForSend(accountId: string, chatId: string): string {
    const chat = this.findChat(accountId, chatId);
    const draft = chat.draft;
    chat.draft = "";
    this.touch(chat);
    this.schedulePersist(accountId);
    return draft;
  }

  isHistoryEnabled(accountId: string): boolean {
    return this.stateFor(accountId).historyEnabled;
  }

  /**
   * Disabling purges turns, checkpoints, and media references from memory
   * immediately and persists shells only. Pending media bytes are reported
   * through `onMediaRelease`.
   */
  setHistoryEnabled(
    accountId: string,
    enabled: boolean,
    options: { onMediaRelease?: MediaReleaseHandler } = {},
  ): void {
    const state = this.stateFor(accountId);
    state.historyEnabled = enabled;
    if (!enabled) {
      const media = state.chats.flatMap(mediaIdsOf);
      for (const chat of state.chats) {
        chat.turns = [];
        chat.checkpoint = undefined;
      }
      if (media.length > 0) options.onMediaRelease?.([...new Set(media)]);
    }
    this.schedulePersist(accountId);
  }

  getCheckpoint(accountId: string, chatId: string): ChatCheckpoint | undefined {
    const chat = this.stateFor(accountId).chats.find((entry) => entry.id === chatId);
    if (chat === undefined || chat.accountId !== accountId) return undefined;
    return chat.checkpoint === undefined ? undefined : clone(chat.checkpoint);
  }

  getAttachedMediaIds(accountId: string, chatId: string): readonly string[] {
    const chat = this.stateFor(accountId).chats.find((entry) => entry.id === chatId);
    if (chat === undefined || chat.accountId !== accountId) return [];
    return mediaIdsOf(chat);
  }

  /**
   * Advance the per-chat checkpoint atomically: validate shape, screen for
   * instruction-override poison, check source-turn provenance against the
   * stored transcript, then durable-write BEFORE swapping memory. Any failure
   * leaves the previous checkpoint untouched.
   */
  async saveCheckpoint(
    accountId: string,
    chatId: string,
    checkpoint: ChatCheckpoint,
  ): Promise<ChatCheckpoint> {
    this.requireHistory(accountId);
    const state = this.stateFor(accountId);
    const index = state.chats.findIndex((entry) => entry.id === chatId);
    if (index === -1) throw new ChatStoreError("missing-chat", `Unknown chat ${chatId}.`);
    if (!isChatCheckpoint(checkpoint)) {
      throw new ChatStoreError("invalid-checkpoint", "Checkpoint failed schema validation.");
    }
    if (isSummaryPoisoned(checkpoint.summaryText)) {
      throw new ChatStoreError(
        "poisoned-checkpoint",
        "Checkpoint summary attempts to override app policy; rejected as untrusted data.",
      );
    }
    const knownTurns = new Set(state.chats[index]!.turns.map((turn) => turn.id));
    for (const source of checkpoint.sourceTurnIds) {
      if (!knownTurns.has(source)) {
        throw new ChatStoreError(
          "unknown-source-turn",
          `Checkpoint source ${source} is not part of this chat transcript.`,
        );
      }
    }
    const next = state.chats.map((chat, position) =>
      position === index
        ? { ...clone(chat), checkpoint: clone(checkpoint), updatedAt: this.now() }
        : clone(chat),
    );
    try {
      await this.adapter.save(accountId, state.historyEnabled ? next : this.snapshot(accountId));
    } catch {
      throw new ChatStoreError(
        "invalid-checkpoint",
        "Checkpoint write failed; previous checkpoint left in place.",
      );
    }
    state.chats = next;
    state.dirty = false;
    return clone(checkpoint);
  }
}
