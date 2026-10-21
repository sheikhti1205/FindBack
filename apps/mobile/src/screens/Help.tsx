import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { History, MoreVertical } from "lucide-react";
import { useAuth } from "../auth";
import { BackButton } from "../components/BackButton";
import { AssistantLanding } from "../components/assistant/AssistantLanding";
import { BottomSheet } from "../components/BottomSheet";
import { ChatComposer } from "../components/ChatComposer";
import { ChatTranscript, type TranscriptMessage } from "../components/ChatTranscript";
import { HistorySheet, type HistoryChatSummary } from "../components/HistorySheet";
import { announce } from "../components/LiveRegion";
import { ChatController, ControllerError, consumerSendErrorCopy, type ControllerState } from "../services/ai/chatController";
import { createStreamingPaint } from "../services/ai/streamingPaint";
import { ChatStore } from "../services/ai/chatStore";
import { defaultSelection } from "../services/ai/modelPolicy";
import type { ChatTurn, ModelRecord, ProviderAdapter, ProviderId } from "../services/ai/providerContract";
import { aiCredentials } from "../services/aiCredentials";
import { loadGenericEndpoint } from "../services/ai/genericEndpoint";
import { createProviderAdapter } from "../services/ai/providerRegistry";
import { createOpenRouterAdapter } from "../services/ai/providers/openrouter";
import { CLOUD_DEFAULT_ROUTE, CLOUD_PROVIDER_LABELS, loadCloudModelPreferences, recordCloudModelUsed, type CloudModel, type CloudProvider } from "../services/ai/cloudModelPreferences";
import { CloudModelPicker, CLOUD_COST_COPY } from "./CloudModels";

export interface HelpAssistantDeps {
  createStore?: () => ChatStore;
  createAdapter?: (provider?: ProviderId) => ProviderAdapter;
  getKey?: () => Promise<string | null>;
  listCatalog?: () => Promise<readonly ModelRecord[]>;
}

const CHAT_POLICY = { version: "cloud-chat-2026-10-21", text: "You are a helpful conversational assistant. Answer the user's message. Never request, repeat or reveal API keys or credentials. Do not claim to perform actions inside FindBack." };
const CHAT_KNOWLEDGE = { version: "cloud-chat-2026-10-21", text: "This is optional text chat. You have no access to FindBack accounts, reports, search, or application actions." };

/**
 * Starter prompts for the empty conversation. They are plain consumer
 * questions for the connected cloud model, not built-in answers: the Chat
 * surface never substitutes its own FAQ text for a provider reply.
 */
const SUGGESTIONS = [
  "How do I report a lost item?",
  "What details should I include?",
  "How do I mark an item recovered?",
];

/** Identity keys own all drafts and asynchronous UI. History keeps its existing owner. */
export function Help({ deps }: { deps?: HelpAssistantDeps }) {
  const { user } = useAuth();
  const store = useMemo(() => deps?.createStore?.() ?? new ChatStore(), [deps]);
  return <AccountHelp key={user ? `user:${user.id}` : "anonymous"} accountId={user?.id ?? "local"} store={store} deps={deps} />;
}

function AccountHelp({ accountId, store, deps }: { accountId: string; store: ChatStore; deps?: HelpAssistantDeps }) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<CloudModel>(() => loadCloudModelPreferences(accountId).defaultModel ?? CLOUD_DEFAULT_ROUTE);
  // Consumer-facing label for the chip: a provider name, never a raw model id.
  const [selectedTitle, setSelectedTitle] = useState<string>(() => {
    const saved: CloudModel = loadCloudModelPreferences(accountId).defaultModel ?? CLOUD_DEFAULT_ROUTE;
    return CLOUD_PROVIDER_LABELS[saved.provider];
  });
  const controller = useMemo(() => new ChatController({
    store, selection: defaultSelection(accountId),
    adapter: createOpenRouterAdapter({ getApiKey: () => aiCredentials.get(accountId, "openrouter") }),
    systemPolicy: CHAT_POLICY, knowledge: CHAT_KNOWLEDGE, budget: {},
    // No pricing catalogue: BYOK Chat uses provider billing, not a local
    // free/paid database. The controller still owns context, retries and aborts.
  }), [store, accountId]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [ephemeral, setEphemeral] = useState<TranscriptMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [failedSend, setFailedSend] = useState<{ text: string } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyTick, setHistoryTick] = useState(0);
  const [controllerPhase, setControllerPhase] = useState<ControllerState["phase"]>("idle");
  const [partial, setPartial] = useState<{ text: string } | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuConfirmClear, setMenuConfirmClear] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  // The on-screen keyboard owns the viewport, so the landing compacts
  // (suggestions hide) instead of pushing the composer out of reach.
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const onResize = () => setKeyboardOpen(viewport.height < window.innerHeight * 0.75);
    viewport.addEventListener("resize", onResize);
    return () => viewport.removeEventListener("resize", onResize);
  }, []);
  const generation = useRef(0);
  const sendGenRef = useRef<number | null>(null);
  const sendLock = useRef<number | null>(null);
  const streamPaint = useRef<{ gen: number; scheduler: ReturnType<typeof createStreamingPaint> } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inflightRef = useRef("");

  useEffect(() => () => {
    generation.current += 1;
    sendGenRef.current = null;
    abortRef.current?.abort();
    streamPaint.current?.scheduler.cancel();
    controller.cancel();
  }, [controller]);

  function clearStreamingPartial() {
    streamPaint.current?.scheduler.cancel();
    streamPaint.current = null;
    setPartial(null);
  }
  function refreshTurns(chatId: string | null) {
    if (chatId === null || !store.isHistoryEnabled(accountId)) { setTurns([]); return; }
    try { setTurns([...store.continueChat(accountId, chatId).turns]); }
    catch { setTurns([]); }
  }
  /** Turns of one chat, or an empty list when the chat is not savable. */
  function safeTurns(chatId: string): ChatTurn[] {
    try { return [...store.continueChat(accountId, chatId).turns]; }
    catch { return []; }
  }
  function refreshHistory() { setHistoryTick((value) => value + 1); }

  useEffect(() => {
    let alive = true;
    void store.restore(accountId).then(() => {
      if (!alive) return;
      const chats = store.listChats(accountId);
      const newest = chats[chats.length - 1] ?? null;
      setActiveChatId(newest?.id ?? null);
      refreshTurns(newest?.id ?? null);
      refreshHistory();
    });
    return () => { alive = false; };
  }, [store, accountId]);

  // One owner for partial teardown: terminal states cancel the queued paint,
  // and stale account/chat/send generations cannot resurrect a partial bubble.
  useEffect(() => {
    const unsubscribe = controller.subscribe((snapshot) => {
      const gen = generation.current;
      if (sendGenRef.current === null || gen !== sendGenRef.current) return;
      setControllerPhase(snapshot.phase);
      if (snapshot.phase !== "streaming") { clearStreamingPartial(); return; }
      if (snapshot.partialText === "") return;
      if (streamPaint.current?.gen !== gen) {
        streamPaint.current?.scheduler.cancel();
        streamPaint.current = { gen, scheduler: createStreamingPaint({ paint: (text) => {
          if (generation.current === gen && sendGenRef.current === gen) setPartial({ text });
        } }) };
      }
      streamPaint.current.scheduler.push(snapshot.partialText);
    });
    return () => { unsubscribe(); clearStreamingPartial(); };
  }, [controller]);

  function endRequest() {
    abortRef.current?.abort();
    abortRef.current = null;
    generation.current += 1;
    sendGenRef.current = null;
    sendLock.current = null;
    controller.cancel();
    clearStreamingPartial();
    setBusy(false);
  }
  function resetView() {
    endRequest();
    inflightRef.current = "";
    setInput(""); setFailedSend(null); setSendError(null); setCancelled(false); setNotice(null); setEphemeral([]);
  }
  async function sendChat(text: string) {
    const question = text.trim();
    if (!question || sendLock.current !== null || busy) return;
    const gen = ++generation.current;
    sendLock.current = gen;
    sendGenRef.current = gen;
    const abort = new AbortController();
    abortRef.current = abort;
    inflightRef.current = question;
    setBusy(true); setFailedSend(null); setSendError(null); setCancelled(false); setNotice(null);
    clearStreamingPartial();
    const current = () => generation.current === gen && !abort.signal.aborted;
    let localError: string | null = null;
    try {
      if (navigator.onLine === false) {
        localError = "You’re offline. Connect to the internet to send a message. Your draft is kept.";
        throw new Error("offline");
      }
      if (selected.provider === "generic" && !loadGenericEndpoint(accountId) && !deps?.createAdapter) {
        localError = "This provider needs a base URL. Add one in Chat options → Providers. Your draft is kept.";
        throw new Error("missing endpoint");
      }
      const readKey = async (id: string, provider: ProviderId) => {
        if (!current() || id !== accountId) throw new ControllerError("cancelled", "Send stopped.");
        const value = await (deps?.getKey?.() ?? aiCredentials.get(id, provider));
        if (!current()) throw new ControllerError("cancelled", "Send stopped.");
        return value;
      };
      const key = await readKey(accountId, selected.provider);
      if (!current()) return;
      if (!key?.trim()) {
        localError = "No provider key saved yet. Add one in Chat options → Providers. Your draft is kept.";
        throw new Error("missing key");
      }
      const adapter = deps?.createAdapter?.(selected.provider) ?? createProviderAdapter(selected.provider, {
        accountId, resolveKey: readKey, resolveGenericEndpoint: loadGenericEndpoint,
        assembleSystemText: () => `${CHAT_POLICY.text}\n${CHAT_KNOWLEDGE.text}`,
      });
      const historyOn = store.isHistoryEnabled(accountId);
      let chatId = activeChatId;
      if (historyOn && chatId === null) {
        chatId = store.createChat(accountId).id;
        setActiveChatId(chatId); refreshHistory();
      }
      const wasEmpty = historyOn && chatId !== null && store.continueChat(accountId, chatId).turns.length === 0;
      setInput(""); setControllerPhase("sending");
      const result = await controller.send(chatId ?? `transient-${gen}`, question, {
        // The shared contract still calls this legacy neutral mode free-only;
        // with no catalogue it conveys no price classification or price gate.
        selection: { ...defaultSelection(accountId), provider: selected.provider, modelId: selected.modelId },
        adapter, signal: abort.signal, task: "general", approvedImageIds: [],
      });
      if (!current()) return;
      if (!result.answer.trim()) throw new Error("empty answer");
      if (result.notice.summarized || result.notice.fallbackRecentOnly) setNotice(result.notice.message);
      // The controller persists the turns when the chat is savable. If the
      // chat was not (history off, or the chat vanished mid-send), the answer
      // would otherwise have nowhere to live: show it ephemerally instead of
      // dropping it.
      let persisted = false;
      if (historyOn && chatId !== null) {
        if (wasEmpty) { try { store.renameChat(accountId, chatId, question.slice(0, 40)); } catch { /* Best effort title. */ } }
        const stored = safeTurns(chatId);
        persisted = stored.some((turn) => turn.role === "assistant" && turn.text === result.answer);
        setTurns(stored);
        refreshHistory();
      }
      if (!persisted) {
        setEphemeral((previous) => [...previous,
          { id: `e-user-${gen}`, role: "user", text: question },
          { id: `e-assistant-${gen}`, role: "assistant", text: result.answer, source: "llm" },
        ]);
      }
      try { recordCloudModelUsed(accountId, selected); } catch { /* A saved answer must survive a preference write failure. */ }
      inflightRef.current = "";
      announce("Response received.");
    } catch (error) {
      if (!current()) return;
      setInput(question); setFailedSend({ text: question });
      setSendError(localError ?? consumerSendErrorCopy(error));
      announce("Send failed. Your message was kept — you can retry.");
    } finally {
      if (sendLock.current === gen) sendLock.current = null;
      if (generation.current === gen) {
        clearStreamingPartial(); sendGenRef.current = null; setBusy(false); setControllerPhase(controller.getState().phase);
      }
    }
  }
  function stopChat() {
    endRequest(); setCancelled(true); setControllerPhase("cancelled");
    setInput(inflightRef.current); inflightRef.current = "";
    announce("Send stopped. Your message was kept.");
  }
  function newChat() {
    resetView();
    const created = store.createChat(accountId);
    setActiveChatId(created.id); setTurns([]); setHistoryQuery(""); setHistoryOpen(false); refreshHistory();
    announce("New chat started.");
  }
  function continueChat(chatId: string) {
    try { store.continueChat(accountId, chatId); } catch { return; }
    resetView(); setActiveChatId(chatId); refreshTurns(chatId); setHistoryOpen(false);
    announce("Chat opened.");
  }
  function renameChat(chatId: string, title: string) {
    try { store.renameChat(accountId, chatId, title); refreshHistory(); announce("Chat renamed."); } catch { /* Leave invalid edits unchanged. */ }
  }
  function deleteChat(chatId: string) {
    try { store.deleteChat(accountId, chatId); } catch { return; }
    if (chatId === activeChatId) { resetView(); setActiveChatId(null); setTurns([]); }
    refreshHistory(); announce("Chat deleted.");
  }
  function clearAllChats() {
    resetView(); store.clearAccount(accountId); setActiveChatId(null); setTurns([]); refreshHistory(); announce("All chats deleted.");
  }
  function toggleHistory(enabled: boolean) {
    resetView(); store.setHistoryEnabled(accountId, enabled);
    const chats = enabled ? store.listChats(accountId) : [];
    const newest = chats[chats.length - 1] ?? null;
    setActiveChatId(newest?.id ?? null); refreshTurns(newest?.id ?? null); refreshHistory();
    announce(enabled ? "Chat history on." : "Chat history off. New messages stay on this screen only.");
  }
  const visibleChats: HistoryChatSummary[] = (() => {
    void historyTick;
    const list = historyQuery.trim() ? store.searchChats(accountId, historyQuery) : store.listChats(accountId);
    return [...list].sort((a, b) => a.updatedAt < b.updatedAt ? 1 : -1).map((chat) => ({
      id: chat.id, title: chat.title, updatedAt: chat.updatedAt,
      preview: chat.turns.find((turn) => turn.role === "user")?.text.slice(0, 80) ?? "Empty chat",
    }));
  })();
  const messages: TranscriptMessage[] = [...turns.map((turn): TranscriptMessage => ({ id: turn.id, role: turn.role, text: turn.text, source: turn.role === "assistant" ? "llm" : undefined })), ...ephemeral];
  if (failedSend && !messages.some((message) => message.role === "user" && message.text === failedSend.text)) messages.push({ id: "pending-user", role: "user", text: failedSend.text, failed: true });
  function retryResponse(messageId: string) {
    if (busy) return;
    const index = messages.findIndex((message) => message.id === messageId && message.role === "assistant");
    for (let i = index - 1; i >= 0; i -= 1) if (messages[i]?.role === "user") { void sendChat(messages[i]!.text); return; }
  }
  const status = sendError ?? (cancelled ? "Send stopped. Your message was kept in the composer." : busy ? controllerPhase === "streaming" ? "Receiving response…" : "Sending…" : notice);
  // The picker lists models for the selected provider only. The catalogue seam
  // is a test/harness hook; production listing goes through the provider
  // adapter with the account's own key (see CloudModels).
  const listModels = useMemo(() => deps?.listCatalog
    ? async (provider: CloudProvider) => (await deps.listCatalog!()).filter((row) => row.provider === provider)
    : undefined, [deps]);
  const rowClass = "flex min-h-[48px] items-center text-left text-sm text-on-surface hover:bg-surface-container";
  // The chip names the provider, never a raw model id: the consumer picked a
  // provider, and the model id is a diagnostic that stays in the picker.
  const modelChipTitle = selectedTitle;
  return <div className="flex h-full min-h-0 flex-col bg-surface text-on-surface">
    <a href="#help-composer-input" className="sr-only focus:not-sr-only focus:block focus:bg-surface-container focus:px-4 focus:py-2 focus:text-sm">Skip to composer</a>
    <header className="shrink-0 border-b border-outline-variant bg-surface px-3 py-2">
      <div className="flex min-w-0 items-center gap-1">
        <BackButton fallbackTo="/profile" label="Back to profile" />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">Chat</h1>
        <button type="button" onClick={() => setHistoryOpen(true)} aria-label="Open chat history" className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-m3-xs hover:bg-surface-container"><History size={20} aria-hidden /></button>
        <button type="button" onClick={() => { setMenuConfirmClear(false); setMenuOpen(true); }} aria-label="More options" className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-m3-xs hover:bg-surface-container"><MoreVertical size={20} aria-hidden /></button>
      </div>
    </header>
    <main aria-label="Chat conversation" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {messages.length === 0 && !busy ? <AssistantLanding suggestions={SUGGESTIONS} onSuggestion={(text) => void sendChat(text)} compact={keyboardOpen} /> : <ChatTranscript messages={messages} partialText={busy && controllerPhase === "streaming" ? partial?.text ?? null : null} partialLabel={busy && controllerPhase === "streaming" ? "Cloud" : null} onRetryMessage={retryResponse} />}
      {status !== null && <div data-testid="assistant-status" className="flex shrink-0 items-center gap-2 px-4 pb-1">
        <p data-testid={sendError ? "chat-error" : cancelled ? "chat-cancelled" : "chat-request-state"} role={sendError ? "alert" : "status"} className="min-w-0 flex-1 text-xs text-on-surface-variant">{status}</p>
        {sendError && failedSend && <button type="button" data-testid="chat-retry" disabled={busy} onClick={() => void sendChat(failedSend.text)} className="min-h-[48px] shrink-0 px-3 text-xs font-medium underline">Retry</button>}
      </div>}
      <div className="shrink-0"><ChatComposer value={input} onChange={setInput} onSend={() => void sendChat(input)} busy={busy} onStop={stopChat} inputId="help-composer-input" inputLabel="Message" placeholder="Message…" modelTitle={modelChipTitle} onOpenModels={() => setModelOpen(true)} modelDisabled={busy} /></div>
    </main>
    <HistorySheet open={historyOpen} onClose={() => setHistoryOpen(false)} chats={visibleChats} activeChatId={activeChatId} searchQuery={historyQuery} onSearchQueryChange={setHistoryQuery} onNew={newChat} onContinue={continueChat} onRename={renameChat} onDelete={deleteChat} onClear={clearAllChats} historyEnabled={store.isHistoryEnabled(accountId)} onToggleHistory={toggleHistory} />
    <BottomSheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Chat options" description="Chats you keep stay in Chat history while the app is open.">
      <div className="flex flex-col gap-1">
        <button type="button" className={rowClass} onClick={() => { newChat(); setMenuOpen(false); }}>New chat</button>
        <button type="button" className={rowClass} onClick={() => { setMenuOpen(false); setHistoryOpen(true); }}>History</button>
        <button type="button" className={rowClass} onClick={() => { setMenuOpen(false); navigate("/ai-connection"); }}>Providers</button>
        <button type="button" className={rowClass} onClick={() => { setMenuOpen(false); setPrivacyOpen(true); }}>Privacy &amp; AI</button>
        {menuConfirmClear ? <button type="button" className={rowClass} onClick={() => { resetView(); setActiveChatId(null); setTurns([]); setMenuOpen(false); }}>Confirm clear view</button> : <button type="button" className={rowClass} onClick={() => setMenuConfirmClear(true)}>Clear chat view</button>}
      </div>
    </BottomSheet>
    <BottomSheet open={privacyOpen} onClose={() => setPrivacyOpen(false)} title="Privacy & AI" description="How Chat handles your messages.">
      <div className="flex flex-col gap-3 text-sm">
        <p>Your selected provider receives your messages and conversation context when you send. Chat does not run on this device.</p>
        <p>Saved chat history is held in the app&apos;s memory while the app is open, separate for each account, and it is gone when you close the app. Turn history off to keep new messages only on this screen.</p>
        <p>{CLOUD_COST_COPY}</p>
        <button type="button" className={`${rowClass} underline`} onClick={() => { setPrivacyOpen(false); navigate("/settings/privacy"); }}>Open Privacy settings</button>
      </div>
    </BottomSheet>
    <BottomSheet open={modelOpen} onClose={() => setModelOpen(false)} title="Choose model" description="Choose a provider and model for new messages.">
      <CloudModelPicker accountId={accountId} selected={selected} listModels={listModels} onSelect={(model, title) => { setSelected(model); setSelectedTitle(title); setModelOpen(false); announce(`${title} selected for new messages.`); }} />
    </BottomSheet>
  </div>;
}
