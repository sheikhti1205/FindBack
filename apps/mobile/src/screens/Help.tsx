import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Bot, History } from "lucide-react";
import { useAuth } from "../auth";
import { BackButton } from "../components/BackButton";
import { ChatComposer } from "../components/ChatComposer";
import { ChatTranscript, type TranscriptMessage, type TranscriptSource } from "../components/ChatTranscript";
import { HistorySheet, type HistoryChatSummary } from "../components/HistorySheet";
import { announce } from "../components/LiveRegion";
import { ChatController, ControllerError } from "../services/ai/chatController";
import { ChatStore } from "../services/ai/chatStore";
import { defaultSelection } from "../services/ai/modelPolicy";
import { getCurrentKnowledge, getSystemPolicy } from "../services/ai/appKnowledge";
import type { ChatTurn, ProviderAdapter } from "../services/ai/providerContract";
import { getConnectedOpenRouterKey } from "../services/aiCredentials";
import { createOpenRouterAdapter } from "../services/ai/providers/openrouter";
import { builtInHelp } from "../services/helpFaq";
import {
  addChatSelection,
  buildChatSendPlan,
  createChatTray,
  frameDisclosureFor,
  MAX_CHAT_SELECTIONS,
  removeChatSelection,
  toApprovedImageIds,
  type ChatTray,
} from "../services/media/prepareImages";
import { importImage, type ImportDeps, type TranscodeRequest } from "../services/media/importImage";
import {
  GUIDED_FLOWS,
  LOCATION_CHOICES,
  PHOTO_CHOICES,
  chooseLocation,
  choosePhoto,
  nextMissingQuestion,
  retryAfterRecovery,
  startFlow,
  type GuidedFlow,
  type GuidedSnapshot,
  type LocationChoice,
  type PhotoChoice,
} from "../services/assistant/guidedAssistantController";
import { executeCloudAssistantMessage, type CloudGenerate } from "../services/assistant/cloudAssistant";
import { RECOVERY_COPY, type RecoveryAction } from "../services/ai/errors";
import type { AiErrorClass } from "../services/ai/types";
import {
  buildAssistantReportHandoff,
  type AssistantReportHandoff,
} from "../services/assistant/assistantHandoff";
import {
  assistantReportNavigationTarget,
  stageAssistantReportHandoff,
} from "../services/assistant/assistantReportNavigation";
import { mapAssistantSearchFilters } from "../services/assistant/searchFilterMapping";

interface ActionChip {
  id: string;
  label: string;
}

const SUGGESTIONS = [
  "How do I report a lost item?",
  "How do I mark an item recovered?",
  "What details should I include?",
  "How do I search and filter?",
];

/** Routes the Help Assistant may deep-link to. Anything else is ignored. */
const ACTION_ROUTES: Record<string, string> = {
  OPEN_HOME: "/",
  OPEN_SEARCH: "/search",
  OPEN_REPORT: "/report",
  OPEN_PROFILE: "/profile",
  OPEN_AI_CONNECTION: "/ai-connection",
  // Legacy id from before the OpenRouter pivot; the connection route now redirects.
  OPEN_OFFLINE_AI: "/ai-connection",
  OPEN_VERIFY: "/verify",
};

/**
 * Optional structured cloud response: a fenced json block carrying markdown
 * plus action chips. Unknown action ids are dropped; arbitrary routes/URLs
 * from the model are never trusted.
 */
export function parseHelpResponse(raw: string): { markdown: string; actions: ActionChip[] } {
  const match = raw.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return { markdown: raw, actions: [] };
  try {
    const parsed = JSON.parse(match[1]!) as { markdown?: unknown; actions?: unknown };
    if (typeof parsed.markdown !== "string" || !Array.isArray(parsed.actions)) {
      return { markdown: raw, actions: [] };
    }
    const actions = (parsed.actions as unknown[]).flatMap((a): ActionChip[] => {
      if (
        typeof a !== "object" ||
        a === null ||
        typeof (a as ActionChip).id !== "string" ||
        typeof (a as ActionChip).label !== "string" ||
        !((a as ActionChip).id in ACTION_ROUTES)
      ) {
        return [];
      }
      return [{ id: (a as ActionChip).id, label: (a as ActionChip).label }];
    });
    return { markdown: parsed.markdown, actions };
  } catch {
    return { markdown: raw, actions: [] };
  }
}

export interface HelpAssistantDeps {
  createStore?: () => ChatStore;
  createAdapter?: () => ProviderAdapter;
  getKey?: () => Promise<string | null>;
  /** Test seam for the guided cloud path (mirrors the old sheet's generate prop). */
  guidedGenerate?: CloudGenerate;
  /** Intake deps for photo selection; production uses a canvas transcode. */
  importDeps?: ImportDeps;
}

interface IncomingAssistantState {
  assistantPrompt?: unknown;
  assistantSource?: unknown;
}

/**
 * Canvas transcode for photo intake: decodes the picked bytes, draws them at
 * the requested size and re-encodes. Browser-only; throws an honest error
 * elsewhere instead of inventing bytes.
 */
async function canvasTranscode(request: TranscodeRequest): Promise<Uint8Array> {
  if (typeof createImageBitmap === "undefined" || typeof document === "undefined") {
    throw new Error("Photo intake needs this device's image tools; your text still sends.");
  }
  const bitmap = await createImageBitmap(new Blob([request.bytes as BlobPart]));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = request.targetWidth;
    canvas.height = request.targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Photo intake needs this device's image tools; your text still sends.");
    ctx.drawImage(bitmap, 0, 0, request.targetWidth, request.targetHeight);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, request.mimeType, request.quality ?? undefined),
    );
    if (!blob) throw new Error("The photo could not be encoded; your text still sends.");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function webpSupported(): boolean {
  try {
    if (typeof document === "undefined") return false;
    return document.createElement("canvas").toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    return false;
  }
}

function canPreview(): boolean {
  return typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}

const SHORTCUT_LABELS: Record<GuidedFlow, string> = {
  lost: "Report a lost item",
  found: "Report a found item",
  search: "Search listings",
  ask: "Ask a question",
};

const PHOTO_LABELS: Record<PhotoChoice, string> = {
  take: "Take a photo",
  choose: "Choose a photo",
  none: "No photo",
};

const LOCATION_LABELS: Record<LocationChoice, string> = {
  map: "Pick on a map",
  current: "Use current location",
  typed: "Type a place name",
  skip: "Skip location",
};

interface GuidedEntry {
  role: "user" | "assistant";
  text: string;
  source?: "model" | "grounded";
}

export function Help({ deps }: { deps?: HelpAssistantDeps }) {
  const { user } = useAuth();
  const { state } = useLocation();
  const navigate = useNavigate();
  const accountId = user?.id ?? "local";

  const store = useMemo(() => deps?.createStore?.() ?? new ChatStore(), [deps]);
  const controller = useMemo(
    () =>
      new ChatController({
        store,
        selection: defaultSelection(accountId),
        adapter:
          deps?.createAdapter?.() ?? createOpenRouterAdapter({ getApiKey: getConnectedOpenRouterKey }),
        systemPolicy: getSystemPolicy(),
        knowledge: getCurrentKnowledge(),
        budget: {},
      }),
    [store, accountId, deps],
  );

  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [ephemeral, setEphemeral] = useState<TranscriptMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [failedSend, setFailedSend] = useState<{ text: string } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tray, setTray] = useState<ChatTray>(() => createChatTray());
  const [previewUrls, setPreviewUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [trayNotice, setTrayNotice] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyTick, setHistoryTick] = useState(0);
  const [guided, setGuided] = useState<GuidedSnapshot | null>(null);
  const [guidedTranscript, setGuidedTranscript] = useState<readonly GuidedEntry[]>([]);
  const [guidedBusy, setGuidedBusy] = useState(false);

  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const inflightRef = useRef("");
  const sourceByTurn = useRef(new Map<string, TranscriptSource>());
  const prefillConsumed = useRef(false);

  function refreshTurns(chatId: string | null) {
    if (chatId === null || !store.isHistoryEnabled(accountId)) {
      setTurns([]);
      return;
    }
    try {
      setTurns([...store.continueChat(accountId, chatId).turns]);
    } catch {
      setTurns([]);
    }
  }

  function refreshHistory() {
    setHistoryTick((t) => t + 1);
  }

  // Mount + account switch: restore persisted chats, open the newest one.
  useEffect(() => {
    let alive = true;
    setEphemeral([]);
    setFailedSend(null);
    setSendError(null);
    setCancelled(false);
    setNotice(null);
    setGuided(null);
    setGuidedTranscript([]);
    void store.restore(accountId).then(() => {
      if (!alive) return;
      const chats = store.listChats(accountId);
      const newest = chats[chats.length - 1] ?? null;
      setActiveChatId(newest?.id ?? null);
      refreshTurns(newest?.id ?? null);
      refreshHistory();
    });
    return () => {
      alive = false;
    };
    // store/identity only; controller follows the same identity.
  }, [store, accountId]);

  // Report/Search deep-link: prefill the composer once, never auto-send.
  useEffect(() => {
    if (prefillConsumed.current) return;
    prefillConsumed.current = true;
    const incoming = (state ?? null) as IncomingAssistantState | null;
    if (incoming === null || typeof incoming.assistantPrompt !== "string") return;
    const prompt = incoming.assistantPrompt.trim();
    if (prompt === "") return;
    setInput(prompt.slice(0, 500));
    const source =
      incoming.assistantSource === "report"
        ? "Report"
        : incoming.assistantSource === "search"
          ? "Search"
          : null;
    announce(
      source === null
        ? "Assistant opened with your message ready."
        : `Assistant opened from ${source} with your message ready.`,
    );
  }, []);

  // Revoke preview object URLs when they leave the tray.
  useEffect(
    () => () => {
      for (const url of previewUrls.values()) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // Non-browser runtimes stub this; nothing to release.
        }
      }
    },
    [previewUrls],
  );

  function trackPreview(id: string, bytes: Uint8Array, mimeType: string) {
    if (!canPreview()) return;
    setPreviewUrls((prev) => {
      if (prev.has(id)) return prev;
      const next = new Map(prev);
      next.set(id, URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType })));
      return next;
    });
  }

  function dropPreview(id: string) {
    setPreviewUrls((prev) => {
      const url = prev.get(id);
      if (url !== undefined) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // Ignore cleanup failures; the tray entry is already gone.
        }
      }
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  function clearTray() {
    for (const item of tray.items) dropPreview(item.id);
    setTray(createChatTray());
    setTrayNotice(null);
  }

  async function addFiles(files: File[]) {
    if (busy || guidedBusy) return;
    const intake: ImportDeps = deps?.importDeps ?? {
      transcode: canvasTranscode,
      webpEncodeSupported: webpSupported(),
    };
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const item = await importImage(
          { bytes, fileName: file.name, declaredMimeType: file.type },
          intake,
        );
        let added = true;
        setTray((prev) => {
          try {
            return addChatSelection(prev, item);
          } catch (e) {
            added = false;
            setTrayNotice(e instanceof Error ? e.message : "That photo was not added.");
            return prev;
          }
        });
        if (added) {
          trackPreview(item.id, item.derivative.bytes, item.derivative.mimeType);
          setTrayNotice(null);
        }
      } catch (e) {
        setTrayNotice(e instanceof Error ? e.message : "That photo was not added.");
      }
    }
  }

  function removeSelection(id: string) {
    setTray((prev) => {
      try {
        return removeChatSelection(prev, id);
      } catch {
        return prev;
      }
    });
    dropPreview(id);
    setTrayNotice(null);
  }

  function lastAssistantId(chatId: string | null): string {
    if (chatId === null) return "";
    try {
      const chat = store.continueChat(accountId, chatId);
      for (let i = chat.turns.length - 1; i >= 0; i -= 1) {
        const turn = chat.turns[i];
        if (turn !== undefined && turn.role === "assistant") return turn.id;
      }
    } catch {
      // Store unavailable; source tracking degrades to unlabeled.
    }
    return "";
  }

  function persistFallback(
    chatId: string | null,
    historyOn: boolean,
    question: string,
  ): "stored" | "ephemeral" {
    const reply = builtInHelp(question);
    if (historyOn && chatId !== null) {
      try {
        store.appendTurn(accountId, chatId, { role: "user", text: question });
        const saved = store.appendTurn(accountId, chatId, { role: "assistant", text: reply });
        sourceByTurn.current.set(saved.id, "fallback");
        return "stored";
      } catch {
        return "ephemeral";
      }
    }
    return "ephemeral";
  }

  async function sendFreeChat(text: string) {
    const question = text.trim();
    if (question === "" || busy) return;
    const gen = ++generation.current;
    abortRef.current?.abort();
    const controllerAbort = new AbortController();
    abortRef.current = controllerAbort;
    inflightRef.current = question;
    setInput("");
    setFailedSend(null);
    setSendError(null);
    setCancelled(false);
    setBusy(true);
    const historyOn = store.isHistoryEnabled(accountId);
    let chatId = activeChatId;
    let wasEmpty = false;
    if (historyOn) {
      let valid = false;
      if (chatId !== null) {
        try {
          const existing = store.continueChat(accountId, chatId);
          valid = true;
          wasEmpty = existing.turns.length === 0;
        } catch {
          valid = false;
        }
      }
      if (!valid) {
        const created = store.createChat(accountId);
        chatId = created.id;
        setActiveChatId(chatId);
        refreshHistory();
        wasEmpty = true;
      }
    }
    const plan = buildChatSendPlan(tray);
    if (plan.capacityNotice !== null) setNotice(plan.capacityNotice);
    const titleFreshChat = () => {
      // Fresh chats take their title from the first user message so history
      // stays scannable. Best effort: a rename failure never blocks the chat.
      if (historyOn && wasEmpty && chatId !== null) {
        try {
          store.renameChat(accountId, chatId, question.slice(0, 40));
        } catch {
          // Keep the default title.
        }
      }
    };
    const finishFallback = (mode: "stored" | "ephemeral", reply: string) => {
      if (generation.current !== gen) return;
      if (mode === "stored" && chatId !== null) {
        titleFreshChat();
        refreshTurns(chatId);
        refreshHistory();
      } else {
        setEphemeral((prev) => [
          ...prev,
          { id: `e-user-${gen}`, role: "user", text: question },
          { id: `e-assistant-${gen}`, role: "assistant", text: reply, source: "fallback" },
        ]);
      }
      clearTray();
    };
    try {
      const key = await (deps?.getKey?.() ?? getConnectedOpenRouterKey());
      if (generation.current !== gen) return;
      if (key === null) {
        // No connected key: honest built-in answer, kept like any turn.
        finishFallback(persistFallback(chatId, historyOn, question), builtInHelp(question));
        return;
      }
      const result = await controller.send(chatId ?? `transient-${gen}`, question, {
        approvedImageIds: toApprovedImageIds(tray.items),
        signal: controllerAbort.signal,
      });
      if (generation.current !== gen) return;
      if (result.answer.trim() === "") {
        throw new Error("The assistant returned an empty response.");
      }
      if (result.notice.summarized || result.notice.fallbackRecentOnly) {
        setNotice(result.notice.message);
      }
      if (historyOn && chatId !== null) {
        sourceByTurn.current.set(lastAssistantId(chatId), "llm");
        titleFreshChat();
        refreshTurns(chatId);
        refreshHistory();
      } else {
        setEphemeral((prev) => [
          ...prev,
          { id: `e-user-${gen}`, role: "user", text: question },
          { id: `e-assistant-${gen}`, role: "assistant", text: result.answer, source: "llm" },
        ]);
      }
      clearTray();
      inflightRef.current = "";
      announce("Response received.");
    } catch (e) {
      if (generation.current !== gen) return;
      if (controllerAbort.signal.aborted || (e instanceof Error && e.name === "AbortError")) return;
      if (e instanceof ControllerError && e.code === "cancelled") return;
      // Provider failure: fall back to a built-in answer AND keep an honest
      // error banner with Retry. The transcript is never left with a hole.
      finishFallback(persistFallback(chatId, historyOn, question), builtInHelp(question));
      setFailedSend({ text: question });
      setSendError(e instanceof Error ? e.message : "Sorry, I could not answer right now.");
      announce("Send failed. A built-in answer was added and you can retry.");
    } finally {
      if (generation.current === gen) setBusy(false);
    }
  }

  function stopFreeChat() {
    abortRef.current?.abort();
    abortRef.current = null;
    generation.current += 1;
    setBusy(false);
    setCancelled(true);
    // Nothing was persisted, nothing was lost: the draft goes back.
    setInput(inflightRef.current);
    inflightRef.current = "";
    announce("Send stopped. Your message was kept.");
  }

  function retryLast() {
    const pending = failedSend;
    if (pending === null || busy) return;
    setFailedSend(null);
    setSendError(null);
    setEphemeral((prev) => {
      // Drop the failed transient pair (user + fallback) so retry resends
      // instead of duplicating. Persisted turns are untouched.
      const next = [...prev];
      if (next.at(-1)?.role === "assistant") next.pop();
      const nowLast = next.at(-1);
      if (nowLast?.role === "user" && nowLast.text === pending.text) next.pop();
      return next;
    });
    void sendFreeChat(pending.text);
  }

  function clearChat() {
    abortRef.current?.abort();
    abortRef.current = null;
    generation.current += 1;
    inflightRef.current = "";
    setBusy(false);
    setInput("");
    setFailedSend(null);
    setSendError(null);
    setCancelled(false);
    setEphemeral([]);
    announce("Chat view cleared.");
  }

  // ---- Guided help (Report/Search flows with handoffs) ----

  function beginGuided(flow: GuidedFlow) {
    if (flow === "ask") {
      document.getElementById("help-composer-input")?.focus();
      return;
    }
    generation.current += 1;
    setGuided(startFlow(flow));
    setGuidedTranscript([]);
    announce(`${SHORTCUT_LABELS[flow]}. Answer the questions to continue.`);
  }

  function endGuided() {
    generation.current += 1;
    setGuided(null);
    setGuidedTranscript([]);
    setGuidedBusy(false);
  }

  async function submitGuided(text: string) {
    const trimmed = text.trim();
    if (trimmed === "" || guidedBusy) return;
    if (guided !== null && guided.state === "recovering") return;
    const gen = ++generation.current;
    setGuidedTranscript((prev) => [...prev, { role: "user", text: trimmed }]);
    setGuidedBusy(true);
    try {
      const result = await executeCloudAssistantMessage(guided, trimmed, deps?.guidedGenerate);
      if (generation.current !== gen) return; // closed/superseded: drop the stale reply
      setGuided(result.snapshot);
      setGuidedTranscript((prev) => [
        ...prev,
        { role: "assistant", text: result.reply, source: result.replySource },
      ]);
      if (
        result.snapshot.flow === "search" &&
        result.snapshot.state === "ready" &&
        result.snapshot.searchFilters !== undefined
      ) {
        const target = mapAssistantSearchFilters(result.snapshot.searchFilters).path;
        endGuided();
        navigate(target);
      }
    } finally {
      if (generation.current === gen) setGuidedBusy(false);
    }
  }

  function pickGuidedPhoto(choice: PhotoChoice) {
    if (guided === null) return;
    setGuided(choosePhoto(guided, choice));
  }

  function pickGuidedLocation(choice: LocationChoice) {
    if (guided === null || guided.state === "recovering") return;
    if (choice === "typed") return;
    setGuided(chooseLocation(guided, choice));
  }

  function recoverGuided(action: RecoveryAction) {
    if (guided !== null && action === "Retry") {
      setGuided(retryAfterRecovery(guided));
    }
  }

  function reviewGuidedReport() {
    if (guided === null) return;
    const handoff: AssistantReportHandoff | null = buildAssistantReportHandoff(guided);
    if (handoff === null) return;
    const target = assistantReportNavigationTarget(handoff);
    if (target === null) return;
    stageAssistantReportHandoff(handoff);
    announce("Report ready for review.");
    endGuided();
    navigate(target);
  }

  function handleSend() {
    if (guided !== null) {
      const text = input;
      setInput("");
      void submitGuided(text);
    } else {
      void sendFreeChat(input);
    }
  }

  // ---- History popup wiring (chatStore contract) ----

  const visibleChats: HistoryChatSummary[] = (() => {
    const list =
      historyQuery.trim() === ""
        ? store.listChats(accountId)
        : store.searchChats(accountId, historyQuery);
    void historyTick;
    return [...list]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((c) => {
        const firstUser = c.turns.find((t) => t.role === "user");
        const preview =
          firstUser?.text.slice(0, 80) ?? (c.turns.length > 0 ? `${c.turns.length} messages` : "Empty chat");
        return { id: c.id, title: c.title, updatedAt: c.updatedAt, preview };
      });
  })();

  function newChat() {
    const created = store.createChat(accountId);
    setActiveChatId(created.id);
    setTurns([]);
    setEphemeral([]);
    setFailedSend(null);
    setSendError(null);
    setCancelled(false);
    setNotice(null);
    setHistoryQuery("");
    setHistoryOpen(false);
    refreshHistory();
    announce("New chat started.");
  }

  function continueChat(chatId: string) {
    try {
      store.continueChat(accountId, chatId);
    } catch {
      return;
    }
    setActiveChatId(chatId);
    setEphemeral([]);
    setFailedSend(null);
    setSendError(null);
    setCancelled(false);
    refreshTurns(chatId);
    setHistoryOpen(false);
    announce("Chat opened.");
  }

  function renameChat(chatId: string, title: string) {
    try {
      store.renameChat(accountId, chatId, title);
      refreshHistory();
      announce("Chat renamed.");
    } catch {
      // Unknown chat or empty title: leave the list as-is.
    }
  }

  function deleteChat(chatId: string) {
    try {
      store.deleteChat(accountId, chatId);
    } catch {
      return;
    }
    if (chatId === activeChatId) {
      setActiveChatId(null);
      setTurns([]);
      setEphemeral([]);
    }
    refreshHistory();
    announce("Chat deleted.");
  }

  function clearAllChats() {
    store.clearAccount(accountId);
    setActiveChatId(null);
    setTurns([]);
    setEphemeral([]);
    setFailedSend(null);
    setSendError(null);
    refreshHistory();
    announce("All chats deleted.");
  }

  function toggleHistory(enabled: boolean) {
    store.setHistoryEnabled(accountId, enabled);
    if (!enabled) {
      setTurns([]);
      setEphemeral([]);
      setActiveChatId(null);
    } else {
      const chats = store.listChats(accountId);
      const newest = chats[chats.length - 1] ?? null;
      setActiveChatId(newest?.id ?? null);
      refreshTurns(newest?.id ?? null);
    }
    refreshHistory();
    announce(
      enabled ? "Chat history on." : "Chat history off. New messages stay on this screen only.",
    );
  }

  // ---- Transcript assembly ----

  const freeMessages: TranscriptMessage[] = (() => {
    const stored: TranscriptMessage[] = turns.map((t) => {
      const parsed = t.role === "assistant" ? parseHelpResponse(t.text) : null;
      return {
        id: t.id,
        role: t.role,
        text: parsed?.markdown ?? t.text,
        source: t.role === "assistant" ? sourceByTurn.current.get(t.id) : undefined,
        actions: parsed?.actions,
        attachments: t.attachmentIds.length > 0 ? t.attachmentIds.length : undefined,
      };
    });
    if (failedSend !== null) {
      // The failed user turn is usually already visible (persisted alongside
      // the fallback answer, or held ephemerally): only render a pending copy
      // when the text is absent, never twice.
      const visible = [...stored, ...ephemeral];
      const alreadyShown = visible.some(
        (m) => m.role === "user" && m.text === failedSend.text,
      );
      if (!alreadyShown) {
        stored.push({ id: "pending-user", role: "user", text: failedSend.text, failed: true });
      }
    }
    if (stored.length === 0 && ephemeral.length === 0) {
      return [
        {
          id: "greeting",
          role: "assistant",
          text: `Hi ${user?.username ?? "there"}! I am the FindBack Help & FAQ. Ask me anything about using the app — reporting, recovering, searching, verifying, ratings and more.`,
          source: "fallback",
        },
      ];
    }
    return [...stored, ...ephemeral];
  })();

  const guidedQuestion = guided === null ? null : nextMissingQuestion(guided);
  const guidedHandoff = guided === null ? null : buildAssistantReportHandoff(guided);
  const composerBusy = busy || guidedBusy;

  function stopComposer() {
    if (guidedBusy) {
      generation.current += 1;
      setGuidedBusy(false);
      announce("Guided answer stopped.");
      return;
    }
    stopFreeChat();
  }

  return (
    <div className="flex min-h-full flex-col bg-surface text-on-surface">
      <a
        href="#help-composer-input"
        className="sr-only focus:not-sr-only focus:block focus:bg-surface-container focus:px-4 focus:py-2 focus:text-sm focus:text-on-surface"
      >
        Skip to composer
      </a>
      <header className="flex items-center gap-2 border-b border-outline-variant bg-surface px-4 py-3">
        <BackButton fallbackTo="/profile" label="Back to profile" />
        <Bot size={20} aria-hidden />
        <div className="flex-1">
          <h1 className="text-base font-semibold leading-tight">Help &amp; FAQ</h1>
          <p className="text-xs text-on-surface-variant">
            AI answers use your OpenRouter key when connected · built-in answers otherwise
          </p>
        </div>
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          aria-label="Open chat history"
          className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-m3-xs text-on-surface hover:bg-surface-container"
        >
          <History size={20} aria-hidden />
        </button>
        <button
          type="button"
          onClick={clearChat}
          className="min-h-[48px] rounded-m3-xs px-3 text-xs font-medium text-on-surface-variant hover:bg-surface-container"
        >
          Clear chat
        </button>
      </header>

      <main aria-label="Help conversation" className="flex min-h-0 flex-1 flex-col">
        <ChatTranscript
          messages={freeMessages}
          busy={busy}
          busyLabel="Thinking…"
          notice={notice}
          error={sendError}
          onRetry={failedSend === null ? undefined : retryLast}
          onAction={(id) => {
            const target = ACTION_ROUTES[id];
            if (target !== undefined) navigate(target);
          }}
        />

        {guided !== null && (
          <section
            data-testid="guided-panel"
            aria-label="Guided help"
            className="flex flex-col gap-3 border-t border-outline-variant bg-surface-container-low px-4 py-4"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-on-surface">{SHORTCUT_LABELS[guided.flow]}</p>
              <button
                type="button"
                onClick={endGuided}
                className="min-h-[48px] rounded-m3-xs px-3 text-xs font-medium text-on-surface-variant underline"
              >
                End guided help
              </button>
            </div>
            {guidedTranscript.length > 0 && (
              <div
                role="log"
                aria-live="polite"
                aria-label="Guided help conversation"
                className="flex max-h-64 flex-col gap-2 overflow-y-auto"
              >
                {guidedTranscript.map((entry, index) => (
                  <div
                    key={`${entry.role}-${index}`}
                    className="flex flex-col gap-0.5 rounded-m3-sm border border-outline-variant bg-surface px-3 py-2"
                  >
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">
                      {entry.role === "user"
                        ? "You"
                        : entry.source === "model"
                          ? "AI-generated"
                          : "Built-in guidance"}
                    </span>
                    <p className="text-sm text-on-surface">{entry.text}</p>
                  </div>
                ))}
                {guidedBusy && <p className="text-xs text-on-surface-variant">Thinking…</p>}
              </div>
            )}
            {guided.state !== "recovering" && guidedQuestion !== null && (
              <p data-testid="guided-question" className="text-sm font-medium text-on-surface">
                {guidedQuestion.question}
              </p>
            )}
            {guided.state === "awaitingPhoto" && guided.photoRequest !== undefined && (
              <div data-testid="guided-photo-step" className="flex flex-col gap-2">
                <p className="text-sm text-on-surface">Would you like to add a photo?</p>
                <div className="flex flex-wrap gap-2">
                  {PHOTO_CHOICES.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      data-testid={`guided-photo-${choice}`}
                      onClick={() => pickGuidedPhoto(choice)}
                      className="min-h-[48px] rounded-full border border-outline-variant bg-surface px-3 text-xs font-medium text-on-surface-variant hover:bg-surface-container"
                    >
                      {PHOTO_LABELS[choice]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {guided.state === "awaitingLocation" && guided.locationRequest !== undefined && (
              <div data-testid="guided-location-step" className="flex flex-col gap-2">
                <p className="text-sm text-on-surface">How should the location be added?</p>
                <div className="flex flex-wrap gap-2">
                  {LOCATION_CHOICES.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      data-testid={`guided-location-${choice}`}
                      onClick={() => pickGuidedLocation(choice)}
                      className="min-h-[48px] rounded-full border border-outline-variant bg-surface px-3 text-xs font-medium text-on-surface-variant hover:bg-surface-container"
                    >
                      {LOCATION_LABELS[choice]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {guided.state === "recovering" && guided.recovery !== undefined && (
              <GuidedRecovery errorClass={guided.recovery.errorClass} onAction={recoverGuided} />
            )}
            {guidedHandoff !== null && (
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  data-testid="guided-review-report"
                  onClick={reviewGuidedReport}
                  aria-label="Review report"
                  className="min-h-[48px] rounded-full bg-on-surface px-3 text-xs font-medium text-surface"
                >
                  Review report
                </button>
                <p className="text-xs text-on-surface-variant">
                  Continue to the report form to review these details before publishing. Nothing is
                  published automatically.
                </p>
              </div>
            )}
          </section>
        )}

        {guided === null && freeMessages.length < 4 && (
          <div className="flex flex-wrap gap-2 bg-surface px-4 pb-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void sendFreeChat(s)}
                className="min-h-[48px] rounded-full border border-outline-variant px-3 text-xs text-on-surface-variant hover:bg-surface-container"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {guided === null && (
          <div className="flex flex-wrap gap-2 bg-surface px-4 pb-2">
            {(GUIDED_FLOWS.filter((f) => f !== "ask") as GuidedFlow[]).map((flow) => (
              <button
                key={flow}
                type="button"
                data-testid={`guided-shortcut-${flow}`}
                onClick={() => beginGuided(flow)}
                className="min-h-[48px] rounded-full border border-outline px-3 text-xs font-medium text-on-surface hover:bg-surface-container"
              >
                {SHORTCUT_LABELS[flow]}
              </button>
            ))}
          </div>
        )}

        <p className="bg-surface px-4 pb-1 text-[11px] text-on-surface-variant">
          With your own OpenRouter key connected (Profile → AI Connection), answers are generated with
          free models and need an internet connection; your question text is sent to OpenRouter and
          answers may vary. Photos are never attached automatically. Without a connected key — or when
          AI is unavailable — you get a built-in answer instead.
        </p>

        {cancelled && (
          <p
            data-testid="chat-cancelled"
            role="status"
            className="bg-surface px-4 pb-1 text-[11px] text-on-surface-variant"
          >
            Send stopped. Your message was kept in the composer.
          </p>
        )}

        <ChatComposer
          value={input}
          onChange={setInput}
          onSend={handleSend}
          busy={composerBusy}
          onStop={stopComposer}
          inputId="help-composer-input"
          selections={tray.items.map((item) => ({
            id: item.id,
            name: item.fileName,
            previewUrl: previewUrls.get(item.id) ?? "",
            disclosure: frameDisclosureFor(item),
          }))}
          onRemoveSelection={removeSelection}
          onAddFiles={(files) => void addFiles(files)}
          capacityNotice={trayNotice}
          maxSelections={MAX_CHAT_SELECTIONS}
        />
      </main>

      <HistorySheet
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        chats={visibleChats}
        activeChatId={activeChatId}
        searchQuery={historyQuery}
        onSearchQueryChange={setHistoryQuery}
        onNew={newChat}
        onContinue={continueChat}
        onRename={renameChat}
        onDelete={deleteChat}
        onClear={clearAllChats}
        historyEnabled={store.isHistoryEnabled(accountId)}
        onToggleHistory={toggleHistory}
      />
    </div>
  );
}

function GuidedRecovery({
  errorClass,
  onAction,
}: {
  errorClass: AiErrorClass;
  onAction?: (action: RecoveryAction) => void;
}) {
  const plan = RECOVERY_COPY[errorClass];
  return (
    <div data-testid="guided-recovery" className="flex flex-col gap-2">
      <p data-testid="guided-recovery-message" className="text-sm text-on-surface">
        {plan.message}
      </p>
      <div className="flex flex-wrap gap-2">
        {plan.actions.map((action) => (
          <button
            key={action}
            type="button"
            data-testid={`guided-recovery-action-${action}`}
            onClick={() => onAction?.(action)}
            className="min-h-[48px] rounded-full border border-outline-variant bg-surface px-3 text-xs font-medium text-on-surface-variant hover:bg-surface-container"
          >
            {action}
          </button>
        ))}
      </div>
    </div>
  );
}
