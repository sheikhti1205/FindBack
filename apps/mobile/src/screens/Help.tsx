import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { History, MoreVertical } from "lucide-react";
import { useAuth } from "../auth";
import { BackButton } from "../components/BackButton";
import { AssistantLanding } from "../components/assistant/AssistantLanding";
import { BottomSheet } from "../components/BottomSheet";
import { ChatComposer } from "../components/ChatComposer";
import { ChatTranscript, type TranscriptMessage, type TranscriptSource } from "../components/ChatTranscript";
import { HistorySheet, type HistoryChatSummary } from "../components/HistorySheet";
import { ModelCatalogSheet, assistantRowTitle } from "../components/ModelCatalogSheet";
import { AssistantConfigureSheet } from "../components/assistant/AssistantConfigureSheet";
import { announce } from "../components/LiveRegion";
import { ChatController, ControllerError, sanitizeControllerError, type ControllerState } from "../services/ai/chatController";
import { createStreamingPaint } from "../services/ai/streamingPaint";
import { ChatStore } from "../services/ai/chatStore";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER, defaultSelection } from "../services/ai/modelPolicy";
import { getCurrentKnowledge, getSystemPolicy, isGeneralNonAppQuestion } from "../services/ai/appKnowledge";
import type { ChatTurn, ModelRecord, ProviderAdapter, ProviderId } from "../services/ai/providerContract";
import { SUPPORTED_AI_PROVIDERS, aiCredentials } from "../services/aiCredentials";
import { loadGenericEndpoint } from "../services/ai/genericEndpoint";
import { loadAppearance } from "../appearance";
import { loadAuthorizedCatalog } from "../services/ai/modelCatalog";
import { automaticLocalModel, displayNameForCatalogRecord, isAssistantSelectableOfflineRecord, supportsAssistantMessage } from "../services/ai/uiModelRoles";
import { createProviderAdapter } from "../services/ai/providerRegistry";
import { isProviderEnabled } from "../services/ai/providerStatus";
import { getApplicationAi } from "../services/ai/applicationAi";
import { honestOfflineDetail, OFFLINE_NOT_AVAILABLE, type AssistantMode } from "./AiModels";
import { loadEffectiveAssistantMode } from "../services/ai/aiPreferences";
import {
  loadSeededAiPreferences,
  updateAiPreferences,
  type AssistantModePreference,
} from "../services/ai/aiPreferences";
import { createOpenRouterAdapter } from "../services/ai/providers/openrouter";
import { builtInHelp, isAppHelpQuestion } from "../services/helpFaq";
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
import { importImage, MediaError, type ImportDeps, type ImportedImage } from "../services/media/importImage";
import { readSourceForImport } from "../services/photo";
import { chooseNativeImage, isNativeMediaIntakeAvailable } from "../services/media/nativeMedia";
import { transcodeImageForWeb } from "../services/media/webTranscode";
import { getAssistantDefault } from "../services/ai/ops/intentRouter";

/**
 * Photo-only sends still need exactly one current message (the assembler's
 * standing rule: currentText must be present exactly once). This disclosed
 * default is persisted verbatim as the user turn, so the transcript shows
 * exactly what was sent — never a silent substitution.
 */
const PHOTO_ONLY_PROMPT =
  "Please look at the attached photo(s) and tell me anything useful for my FindBack report.";

interface AttemptEntry {
  n: number;
  status: "sending" | "retrying" | "complete" | "failed";
}

const SUGGESTIONS = [
  "How do I report a lost item?",
  "How do I mark an item recovered?",
  "What details should I include?",
];

/**
 * Pinned free-route seed (P4b origin, AI-024b unpinned): the catalogue opens
 * on this single free row and expands to the authorized catalogue (vault
 * keys via the registry) whenever the picker opens. When nothing is authorized the seed stays — an unloaded catalogue
 * never invents rows. The WB-02 client guard bans any other
 * `openrouter/...` route literal in shipped code, so this stays the only one.
 */
const HELP_MODEL_CATALOG: readonly ModelRecord[] = [
  {
    provider: DEFAULT_PROVIDER,
    id: DEFAULT_MODEL_ID,
    displayName: "Free model router",
    qualifiedRoles: ["chat", "vision"],
    input: ["text"],
    output: ["text"],
    prices: [
      {
        amountDecimal: "0",
        currency: "USD",
        unit: "token",
        dimension: "input",
        sourceField: "pricing.prompt",
      },
      {
        amountDecimal: "0",
        currency: "USD",
        unit: "token",
        dimension: "output",
        sourceField: "pricing.completion",
      },
    ],
    priceClass: "free",
    retrievedAt: "2026-09-26T00:00:00.000Z",
    entitlement: "untested",
  },
];

/**
 * Picker catalogue binder (AI-024b, picker-owned): vault presence per
 * provider slot and listed rows through the registry wiring seam. Per-provider
 * failures (no key, no list endpoint, refused) yield no rows — never invented
 * ones. Offline readiness comes from the registry seam itself: the adapter
 * reports verified Android installs; on web its error copy is the honest
 * status line. This binder only fills the picker.
 */
async function loadHelpCatalog(
  accountId: string,
): Promise<{ records: readonly ModelRecord[]; offlineDetail: string | null }> {
  let offlineDetail: string | null = null;
  let offlineRecords: readonly ModelRecord[] = [];
  try {
    const offline = createProviderAdapter("offline", { accountId, resolveKey: async () => null });
    // The Assistant picker offers conversational rows only: background
    // engines (Needle tools/embeddings) never appear as chat selections.
    // Automatic routing to those engines is unchanged (U3 owns routing).
    offlineRecords = (await offline.listModels?.() ?? []).filter(isAssistantSelectableOfflineRecord);
    offlineDetail = null;
  } catch (e) {
    // Web or unavailable Android storage: surface honest availability, never internals.
    offlineDetail = honestOfflineDetail(e);
  }
  if (loadEffectiveAssistantMode(accountId) === "offline-only") return { records: offlineRecords, offlineDetail };
  const records = await loadAuthorizedCatalog({
    accountId,
    providers: SUPPORTED_AI_PROVIDERS.filter((provider) => isProviderEnabled(accountId, provider)),
    hasCredential: async (provider: ProviderId) => {
      try {
        return await aiCredentials.hasCredential(aiCredentials.credentialHandle(accountId, provider));
      } catch {
        return false;
      }
    },
    listModels: async (provider: ProviderId, signal?: AbortSignal) => {
      const adapter = createProviderAdapter(provider, {
        accountId,
        resolveKey: (id, slot) => aiCredentials.get(id, slot),
      });
      const list = adapter.listModels;
      if (list === undefined) return [];
      return list(signal);
    },
    retrievedAt: new Date().toISOString(),
  });
  return { records: [...offlineRecords, ...records], offlineDetail };
}

/**
 * G12 send-time refusal gate (pure): returns the honest user-facing copy when
 * this send must not touch any transport, or null when it may proceed.
 * Refusals never send anything — no key read, no network call, no adapter I/O.
 */
export function refuseHelpSend(input: {
  provider: ProviderId;
  record: ModelRecord | null;
  mode: AssistantMode;
  hasImages: boolean;
}): string | null {
  if (input.mode === "offline-only" && input.provider !== "offline") {
    return (
      "Offline-only mode is on, so this cloud model was not contacted — nothing left this device. " +
      "Switch modes in Settings → AI & models to send it."
    );
  }
  if (input.mode === "cloud-only" && input.provider === "offline") {
    return "Cloud-only mode is on, so the on-device row was not run. Switch modes in Settings → AI & models to use it.";
  }
  if (input.provider === "offline") {
    if (!getApplicationAi().android || input.record === null) return honestOfflineDetail(new Error(OFFLINE_NOT_AVAILABLE));
    if (!getApplicationAi().manager.statusOf(input.record.id)?.checksumVerified) return "Install and verify this on-device model in Settings → AI & models → On-device AI first.";
    if (!isAssistantSelectableOfflineRecord(input.record)) return "That on-device engine runs automatically in the background and can't answer chat directly. Use Automatic or pick a listed chat model — your draft is kept.";
    // Vision-only models (SmolVLM2) never own text-only chat: an explicit pin
    // gets a routing choice, never a fake image demand. Automatic (no pin)
    // never lands here for text-only — send-time routing picks a qualified
    // text model or the configured cloud/built-in fallback instead.
    if (!supportsAssistantMessage(input.record, input.hasImages)) return input.hasImages
      ? "This model cannot read images. Use Automatic or choose a vision model — your draft is kept."
      : "This photo model can't answer text-only chat. Use Automatic for a text answer, or attach a photo for image chat — your draft is kept.";
    if (input.hasImages && !input.record.input.includes("image")) return "This on-device model accepts text only; select SmolVLM2 for an approved image.";
    if (!input.hasImages && input.record.input.includes("image")) return "This photo model can't answer text-only chat. Use Automatic for a text answer, or attach a photo for image chat — your draft is kept.";
  }
  if (input.record !== null && input.provider !== "offline" && !supportsAssistantMessage(input.record, input.hasImages)) {
    return "This model is not qualified for this message. Use Automatic or choose a compatible model — your draft is kept.";
  }
  const priceClass = input.record?.priceClass ?? "free";
  if (priceClass === "paid" || priceClass === "variable") {
    return (
      "That model may cost money and needs explicit per-model, per-price consent, " +
      "which this screen does not collect. Pick a Free row — your draft is kept."
    );
  }
  if (priceClass === "unknown") {
    return (
      "That model's price is unknown, so it cannot be sent — unknown is never treated as free. " +
      "Pick a listed Free row — your draft is kept."
    );
  }
  return null;
}

export interface HelpAssistantDeps {
  createStore?: () => ChatStore;
  createAdapter?: (provider?: ProviderId) => ProviderAdapter;
  getKey?: () => Promise<string | null>;
  /** Test seam for the picker catalogue; production loads via vault + registry below. */
  listCatalog?: () => Promise<readonly ModelRecord[]>;
  /** Intake deps for photo selection; production uses a canvas transcode. */
  importDeps?: ImportDeps;
}

interface IncomingAssistantState {
  assistantPrompt?: unknown;
  assistantSource?: unknown;
}

/**
 * Persisted Assistant default read (aiPreferences owns the store).
 * Fallback-safe: a missing store reads as null and the free default
 * applies — never throws, never blocks.
 */
function readPersistedAssistantDefault(accountId: string): string | null {
  try {
    const value = getAssistantDefault(accountId);
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
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

/**
 * Derivative MIME types the import pipeline can produce and every AI path
 * accepts. Animated GIF passes through (or samples to a disclosed still when
 * over the derivative bound), so it must resolve — never dead-end. Anything
 * else resolves null so the adapter fails loudly (draft kept) instead of
 * sending unexpected content.
 */
const TRAY_IMAGE_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** DOM-free data-URL encoder over one approved derivative (chunked btoa). */
function encodeTrayImageDataUrl(item: ImportedImage): string | null {
  const mimeType = item.derivative.mimeType;
  const bytes = item.derivative.bytes;
  if (!TRAY_IMAGE_MIME_ALLOWLIST.has(mimeType)) return null;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/**
 * G12 photo gap: per-send image resolver bound to THIS send's explicitly
 * approved tray snapshot. Only ids present in the snapshot resolve — to a
 * deliverable `data:` URL encoded from that item's own derivative bytes —
 * anything else resolves null, so the adapter fails loudly (draft and tray
 * kept) instead of sending unknown content or silently dropping a photo.
 * No object URLs are minted here, so there is nothing new to revoke; the
 * chat-tray preview URLs keep their existing remove/unmount revocation.
 * The snapshot is taken at send start and rebuilt from the retained tray on
 * retry, so cancellation (adapter abort checks around resolution) is intact.
 */
export function createChatTrayImageResolver(
  items: readonly ImportedImage[],
): (imageId: string) => Promise<string | null> {
  const approved = new Map<string, ImportedImage>();
  for (const item of items) {
    if (!approved.has(item.id)) approved.set(item.id, item);
  }
  return async (imageId: string): Promise<string | null> => {
    const item = approved.get(imageId);
    if (item === undefined) return null;
    return encodeTrayImageDataUrl(item);
  };
}

interface PendingPhoto {
  key: string;
  source: "camera" | "gallery";
  status: "preparing" | "failed";
  message: string | null;
}

export function Help({ deps }: { deps?: HelpAssistantDeps }) {
  const { user } = useAuth();
  // Keep history in its canonical account-scoped store while giving every
  // authenticated identity a distinct lifetime for drafts, media and sends.
  const store = useMemo(() => deps?.createStore?.() ?? new ChatStore(), [deps]);
  // Route state is a one-shot handoff to this screen, not something a new
  // identity may replay when its account-owned subtree mounts.
  const prefillConsumed = useRef(false);
  return <AccountHelp key={user ? `user:${user.id}` : "anonymous"} accountId={user?.id ?? "local"} store={store} prefillConsumed={prefillConsumed} deps={deps} />;
}

function AccountHelp({ accountId, store, prefillConsumed, deps }: { accountId: string; store: ChatStore; prefillConsumed: { current: boolean }; deps?: HelpAssistantDeps }) {
  const { state } = useLocation();
  const navigate = useNavigate();

  // P4b origin, AI-024b unpinned: the chosen catalogue row drives the
  // send-time selection below (provider follows the row, defaulting to the
  // free route). The controller still takes its selection at construction
  // time, so the binding is rebuilt whenever the choice changes (never a
  // stale controller, never header-only).
  const [selectedModelId, setSelectedModelId] = useState<string | null>(() =>
    readPersistedAssistantDefault(accountId),
  );
  // Authorized picker catalogue: pinned free seed until the picker opens and
  // the vault+registry binder resolves. Never invents rows on failure.
  const [catalog, setCatalog] = useState<readonly ModelRecord[]>(HELP_MODEL_CATALOG);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [offlineDetail, setOfflineDetail] = useState<string | null>(null);
  const selection = useMemo(
    () => {
      const record = catalog.find((row) => row.id === selectedModelId) ?? null;
      return {
        ...defaultSelection(accountId),
        provider: record?.provider ?? ("openrouter" as const),
        modelId: selectedModelId ?? defaultSelection(accountId).modelId,
      };
    },
    [accountId, selectedModelId, catalog],
  );
  const controller = useMemo(
    () =>
      new ChatController({
        store,
        selection,
        // Construction-time default only: every send below resolves its own
        // fresh selection + adapter per the picked row (G12) and passes them
        // as a per-request override, so this binding is never the stale one
        // that decides a send.
        adapter:
          deps?.createAdapter?.(selection.provider) ??
          createOpenRouterAdapter({ getApiKey: () => aiCredentials.get(accountId, "openrouter") }),
        systemPolicy: getSystemPolicy(),
        knowledge: getCurrentKnowledge(),
        budget: {},
      }),
    [store, selection, accountId, deps],
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
  const [pendingPhotos, setPendingPhotos] = useState<readonly PendingPhoto[]>([]);
  const nativeIntake = isNativeMediaIntakeAvailable();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyTick, setHistoryTick] = useState(0);
  // M2 request-state UI: controller phase (subscribe/getState), throttled
  // partial text, and per-question attempt history. No fabricated steps.
  const [controllerPhase, setControllerPhase] = useState<ControllerState["phase"]>("idle");
  const [partial, setPartial] = useState<{ id: string; text: string; label: string } | null>(null);
  const [attempts, setAttempts] = useState<readonly AttemptEntry[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  // AI-024b: expand the picker from the pinned seed to the authorized
  // catalogue whenever it opens (or the account changes). Failures keep the
  // seed — never invented rows, never another account's rows.
  useEffect(() => {
    if (!modelOpen) return;
    let alive = true;
    setCatalogLoading(true);
    const load = async () => {
      try {
        if (deps?.listCatalog !== undefined) {
          const records = await deps.listCatalog();
          if (alive && records.length > 0) setCatalog(records.filter((row) => isProviderEnabled(accountId, row.provider)));
          return;
        }
        const { records, offlineDetail: detail } = await loadHelpCatalog(accountId);
        if (!alive) return;
        setOfflineDetail(detail);
        if (records.length > 0) setCatalog(records);
      } catch {
        // The pinned seed stays: an unloaded catalogue never invents rows.
      } finally {
        if (alive) setCatalogLoading(false);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [modelOpen, accountId, deps]);
  // P1: overflow menu (Clear view lives here, never in the crowded header)
  // and the ongoing-chat privacy disclosure.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuConfirmClear, setMenuConfirmClear] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  // FBX-020: separate Configure sheet (policy + conversational choice +
  // management links). Mirrors the persisted store AiSettings writes.
  const [configureOpen, setConfigureOpen] = useState(false);
  const [prefsMode, setPrefsMode] = useState<AssistantModePreference>(() => {
    try {
      return loadSeededAiPreferences(accountId).assistantMode;
    } catch {
      return "automatic";
    }
  });
  // FBX-020: keyboard collapse — the on-screen keyboard owns the viewport,
  // so the landing compacts (subtitle + suggestions hide) instead of
  // pushing the composer out of reach.
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const onResize = () => {
      setKeyboardOpen(viewport.height < window.innerHeight * 0.75);
    };
    viewport.addEventListener("resize", onResize);
    return () => viewport.removeEventListener("resize", onResize);
  }, []);

  const generation = useRef(0);
  const sendGenRef = useRef<number | null>(null);
  const sendLock = useRef(false);
  const attemptRef = useRef(0);
  const streamPaint = useRef<{ gen: number; label: string; scheduler: ReturnType<typeof createStreamingPaint> } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inflightRef = useRef("");
  const sourceByTurn = useRef(new Map<string, TranscriptSource>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      sendGenRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
      streamPaint.current?.scheduler.cancel();
      streamPaint.current = null;
    };
  }, []);
  useEffect(() => () => controller.cancel(), [controller]);

  // Single owner for streaming-partial teardown (U1): every terminal
  // transition (complete, failed, cancelled, stopped, chat/account switch)
  // clears the pending throttle timer AND the partial, so a late timer can
  // never resurrect a partial bubble after the final answer rendered.
  function clearStreamingPartial() {
    streamPaint.current?.scheduler.cancel();
    streamPaint.current = null;
    setPartial(null);
  }

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
    setSelectedModelId(readPersistedAssistantDefault(accountId));
    setCatalog(HELP_MODEL_CATALOG);
    setOfflineDetail(null);
    setModelOpen(false);
    setSendError(null);
    setCancelled(false);
    setNotice(null);
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
  // G02 fix: the full prompt is passed through — budgeting lives in the
  // controller, never a silent slice(0, 500) here.
  useEffect(() => {
    if (prefillConsumed.current) return;
    prefillConsumed.current = true;
    const incoming = (state ?? null) as IncomingAssistantState | null;
    if (incoming === null || typeof incoming.assistantPrompt !== "string") return;
    const prompt = incoming.assistantPrompt.trim();
    if (prompt === "") return;
    setInput(prompt);
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

  // Controller subscription: once per chat, cleaned up on switch/unmount.
  // getState() paints immediately (subscribe never replays); a stale
  // generation guard drops late snapshots, and real cumulative text is
  // coalesced at adaptive deadlines without restarting them on every chunk.
  // ControllerState carries
  // the delivered C contract (phase/partialText/attempt/provider/modelId).
  useEffect(() => {
    clearStreamingPartial();
    setControllerPhase(controller.getState().phase);
    const unsubscribe = controller.subscribe((snapshot) => {
      const gen = generation.current;
      // Stale-generation guard: snapshots from a superseded or stopped send
      // (sendGenRef pins the live one) never touch partial or phase UI.
      if (sendGenRef.current === null || gen !== sendGenRef.current) return;
      setControllerPhase(snapshot.phase);
      // Terminal / non-streaming phases own the lifecycle: cancel any pending
      // paint AND clear the visible partial. A partial is only ever valid while
      // the controller says it is streaming, so a completed, failed, cancelled
      // or superseded attempt can never leave a stale bubble beside the final.
      if (snapshot.phase !== "streaming") {
        clearStreamingPartial();
        return;
      }
      if (snapshot.partialText === "") return;
      const label = snapshot.provider === "offline" ? "On-device" : "Cloud";
      if (streamPaint.current?.gen !== gen) {
        streamPaint.current?.scheduler.cancel();
        streamPaint.current = { gen, label, scheduler: createStreamingPaint({
          paint: (text) => {
            if (generation.current === gen && sendGenRef.current === gen) setPartial({ id: `partial-${gen}`, text, label });
          },
        }) };
      }
      streamPaint.current.scheduler.push(snapshot.partialText);
    });
    return () => {
      unsubscribe();
      clearStreamingPartial();
    };
  }, [controller, activeChatId]);

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
    if (busy) return;
    const intake: ImportDeps = deps?.importDeps ?? {
      transcode: transcodeImageForWeb,
      webpEncodeSupported: webpSupported(),
    };
    for (const file of files) {
      try {
        // FBX-021: bounded source read — cap and format gates run before any
        // source-sized allocation; a whole-source materialization is forbidden
        // here (see the static guard in Help.photo.test.tsx).
        const bytes = await readSourceForImport(file, file.name);
        if (!mounted.current) return;
        const item = await importImage(
          {
            bytes,
            fileName: file.name,
            declaredMimeType: file.type,
            highQuality: loadAppearance().highQualityPhoto,
          },
          intake,
        );
        if (!mounted.current) return;
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
        if (!mounted.current) return;
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

  function removePending(key: string) {
    setPendingPhotos((prev) => prev.filter((row) => row.key !== key));
  }

  function removeAnySelection(id: string) {
    if (id.startsWith("pending_")) removePending(id);
    else removeSelection(id);
  }

  async function runNativePick(key: string, source: "camera" | "gallery") {
    try {
      const item = await chooseNativeImage({
        source: source === "camera" ? "camera" : "photos",
        highQuality: loadAppearance().highQualityPhoto,
        text: input,
      });
      if (!mounted.current) return;
      if (item === null) {
        removePending(key);
        return;
      }
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
      removePending(key);
    } catch (e) {
      if (!mounted.current) return;
      const message =
        e instanceof MediaError ? e.message : "Couldn't prepare this photo. Try a different photo or re-save it as JPEG.";
      setPendingPhotos((prev) => prev.map((row) => (row.key === key ? { ...row, status: "failed", message } : row)));
    }
  }

  function pickNative(source: "camera" | "gallery") {
    if (busy) return;
    const key = `pending_${crypto.randomUUID().replaceAll("-", "_")}`;
    setPendingPhotos((prev) => [...prev, { key, source, status: "preparing", message: null }]);
    void runNativePick(key, source);
  }

  function retryNativePick(key: string) {
    const row = pendingPhotos.find((p) => p.key === key);
    if (row === undefined) return;
    setPendingPhotos((prev) => prev.map((p) => (p.key === key ? { ...p, status: "preparing", message: null } : p)));
    void runNativePick(key, row.source);
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

  /**
   * Synchronous send mutex. React `busy` state is UI state, not a lock: a fast
   * double tap, key repeat, or duplicated WebView event can call this twice
   * before React rerenders and flips `busy`. A ref flips synchronously, so only
   * the first caller proceeds and a double send can never persist two turns.
   */
  async function sendFreeChat(text: string, opts: { isRetry?: boolean } = {}) {
    if (sendLock.current) return;
    sendLock.current = true;
    try {
      await sendFreeChatInner(text, opts);
    } finally {
      sendLock.current = false;
    }
  }

  async function sendFreeChatInner(text: string, opts: { isRetry?: boolean } = {}) {
    const rawText = text.trim();
    const hasImages = tray.items.length > 0;
    // Photo-only drafts send (G10): text is required only when no photos.
    // Empty text with photos uses the disclosed PHOTO_ONLY_PROMPT (persisted
    // verbatim, never silent) because the assembler requires exactly one
    // current message.
    if ((rawText === "" && !hasImages) || busy) return;
    const question = rawText === "" ? PHOTO_ONLY_PROMPT : rawText;
    // G12: the picked catalogue row drives this send (provider follows the
    // row, defaulting to the free route). Mode and price gates refuse BEFORE
    // any transport: offline-only never contacts cloud rows, cloud-only never
    // runs the on-device row, and paid/unknown-price rows are never sent
    // silently from a screen with no consent UI. Refusals keep the draft and
    // photos for Retry.
    const gen = ++generation.current;
    sendGenRef.current = gen;
    abortRef.current?.abort();
    const controllerAbort = new AbortController();
    abortRef.current = controllerAbort;
    inflightRef.current = question;
    setBusy(true);
    const mode = loadEffectiveAssistantMode(accountId);
    let pickedRecord =
      catalog.find((row) => row.id === (selectedModelId ?? defaultSelection(accountId).modelId)) ??
      null;
    let cloudRecord = pickedRecord?.provider === "offline" ? HELP_MODEL_CATALOG[0]! : pickedRecord;
    const resolvePinnedRecord = async (): Promise<ModelRecord | null> => {
      if (selectedModelId === null || selectedModelId === DEFAULT_MODEL_ID) return HELP_MODEL_CATALOG[0]!;
      const records = deps?.listCatalog ? await deps.listCatalog() : (await loadHelpCatalog(accountId)).records;
      return records.find((row) => row.id === selectedModelId && isProviderEnabled(accountId, row.provider)) ?? null;
    };
    // Discover installed models at send time, not only when the picker opens.
    // Automatic is genuinely local-first; an explicit cloud row is a fallback,
    // never permission to bypass the account's on-device-only transport pin.
    if (mode !== "cloud-only") {
      try {
        const localRows = deps?.listCatalog
          ? await deps.listCatalog()
          : await createProviderAdapter("offline", { accountId, resolveKey: async () => null }).listModels?.() ?? [];
        if (generation.current !== gen || controllerAbort.signal.aborted) return;
        const compatible = localRows.filter((row) => row.provider === "offline" && refuseHelpSend({ provider: "offline", record: row, mode, hasImages }) === null);
        // A stale pin to a background engine (Needle tools/embeddings) can
        // never answer chat: refuse honestly instead of silently routing
        // through it. Automatic (no pin) still uses U3-owned routing.
        const stalePin = selectedModelId === null ? undefined : localRows.find((row) => row.provider === "offline" && row.id === selectedModelId);
        const pinRefusal = stalePin === undefined ? null : refuseHelpSend({ provider: "offline", record: stalePin, mode, hasImages });
        if (pinRefusal !== null) {
          setInput(question);
          setFailedSend({ text: question });
          setSendError(pinRefusal);
          setBusy(false);
          sendGenRef.current = null;
          announce("Send refused. Your message and photos were kept.");
          return;
        }
        if (selectedModelId === null) pickedRecord = automaticLocalModel(compatible, hasImages) ?? pickedRecord;
        else if (stalePin !== undefined) pickedRecord = stalePin;
      } catch (error) {
        if (generation.current !== gen || controllerAbort.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          if (generation.current === gen) setBusy(false);
          return;
        }
        // No usable native runtime: only automatic may proceed to cloud.
      }
    }
    if (pickedRecord === null && mode !== "offline-only") {
      try { pickedRecord = await resolvePinnedRecord(); cloudRecord = pickedRecord; }
      catch { /* Unknown catalogue means no permission to send a pinned model. */ }
      if (generation.current !== gen || controllerAbort.signal.aborted) return;
      if (pickedRecord === null && !hasImages && selectedModelId === null) {
        // A missing default is not permission to invent its price/provider.
        // Match the visible notice by falling back to the known free route.
        pickedRecord = HELP_MODEL_CATALOG[0]!;
        cloudRecord = pickedRecord;
        setNotice("Saved default unavailable — using the free OpenRouter route after checking on-device availability.");
      }
    }
    const builtInOnly = selectedModelId === null && mode === "offline-only" && !hasImages && pickedRecord?.provider !== "offline" && !isGeneralNonAppQuestion(question);
    const sendProvider = pickedRecord?.provider ?? selection.provider;
    const sendModelId = pickedRecord?.id ?? selection.modelId;
    const refusal = pickedRecord === null && selectedModelId !== null && selectedModelId !== DEFAULT_MODEL_ID && mode !== "offline-only"
      ? "That model is not in the enabled catalogue. Choose a listed model; your draft is kept."
      : !isProviderEnabled(accountId, sendProvider)
      ? "This experimental provider is disabled. Enable Experimental providers in Cloud connections first. Your draft is kept."
      : refuseHelpSend({
      provider: sendProvider,
      record: pickedRecord,
      // Single authoritative store: the same aiPreferences.assistantMode
      // value AiSettings writes (one-time legacy migration inside; safe
      // local-first default, cloud only with consent as before).
      mode: loadEffectiveAssistantMode(accountId),
      hasImages,
    });
    if (refusal !== null && !builtInOnly) {
      setInput(question);
      setFailedSend({ text: question });
      setSendError(refusal);
      setBusy(false);
      sendGenRef.current = null;
      announce("Send refused. Your message and photos were kept.");
      return;
    }
    const attemptN = ++attemptRef.current;
    setAttempts((prev) =>
      opts.isRetry ? [...prev, { n: attemptN, status: "retrying" }] : [{ n: attemptN, status: "sending" }],
    );
    clearStreamingPartial();
    setInput("");
    setFailedSend(null);
    setSendError(null);
    setCancelled(false);
    setBusy(true);
    setControllerPhase("sending");
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
      if (historyOn && wasEmpty && chatId !== null && question !== "") {
        try {
          store.renameChat(accountId, chatId, question.slice(0, 40));
        } catch {
          // Keep the default title.
        }
      }
    };
    const finishFallback = (mode: "stored" | "ephemeral", reply: string) => {
      if (generation.current !== gen) return;
      // A failed local/cloud attempt may have painted a partial: terminate it
      // here so the built-in fallback turn can never sit beside stale text.
      clearStreamingPartial();
      sendGenRef.current = null;
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
    const assertCloudKeyAllowed = (id: string, provider: ProviderId) => {
      if (generation.current !== gen || controllerAbort.signal.aborted) throw new ControllerError("cancelled", "Send was cancelled.");
      if (id !== accountId) throw new Error("AI account changed.");
      if (loadEffectiveAssistantMode(accountId) === "offline-only") throw new Error("On-device only: cloud is disabled. Your draft is kept.");
      if (!isProviderEnabled(accountId, provider)) throw new Error("Experimental provider is disabled. Your draft is kept.");
    };
    const readCloudKey = async (id: string, provider: ProviderId) => {
      assertCloudKeyAllowed(id, provider);
      const key = await (deps?.getKey?.() ?? aiCredentials.get(id, provider));
      assertCloudKeyAllowed(id, provider);
      return key;
    };
    try {
      if (builtInOnly) {
        finishFallback(persistFallback(chatId, historyOn, question), builtInHelp(question));
        return;
      }
      // Cloud rows need a vault slot; installed offline rows do not.
      const key = sendProvider === "offline" ? null : await readCloudKey(accountId, sendProvider);
      if (generation.current !== gen) return;
      if (key === null && sendProvider !== "offline") {
        if (hasImages) throw new Error("No compatible on-device photo model or connected cloud model is available. Install a photo model or connect a provider — your message and photos are kept.");
        // No connected key: honest built-in answer, kept like any turn.
        finishFallback(persistFallback(chatId, historyOn, question), builtInHelp(question));
        return;
      }
      // G12 per-send binding: a fresh selection + adapter for THIS send only,
      // resolved through the vault-backed registry. The construction-time
      // controller binding never decides a send, and no controller instance is
      // reused across sends with a stale binding — the override below is
      // validated and applied per request.
      const sendSelection = {
        ...defaultSelection(accountId),
        provider: sendProvider,
        modelId: sendModelId,
      };
      let sendAdapter: ProviderAdapter;
      if (deps?.createAdapter !== undefined) {
        sendAdapter = deps.createAdapter(sendProvider);
      } else {
        sendAdapter = createProviderAdapter(sendProvider, {
          accountId,
          resolveKey: readCloudKey,
          // Generic custom endpoint rides along so a configured generic
          // provider sends with the same URL catalogue/test used.
          resolveGenericEndpoint: (id) => loadGenericEndpoint(id),
          // G12 photo gap: the approved chat-tray snapshot for THIS send rides
          // along, so image-bearing sends resolve instead of refusing. The
          // snapshot is rebuilt from the retained tray on retry.
          resolveImageUrl: createChatTrayImageResolver(tray.items),
        });
      }
      const run = (adapter: ProviderAdapter, selection: typeof sendSelection) => {
        if (generation.current !== gen || controllerAbort.signal.aborted) throw new ControllerError("cancelled", "Send was cancelled.");
        const currentRecord = selection.provider === "offline" ? pickedRecord : cloudRecord;
        const latestRefusal = refuseHelpSend({ provider: selection.provider, record: currentRecord, mode: loadEffectiveAssistantMode(accountId), hasImages });
        if (latestRefusal || !isProviderEnabled(accountId, selection.provider)) throw new Error(latestRefusal ?? "Experimental provider is disabled.");
        return controller.send(chatId ?? `transient-${gen}`, question, {
          selection, adapter, approvedImageIds: toApprovedImageIds(tray.items), signal: controllerAbort.signal,
        });
      };
      let result;
      try {
        result = await run(sendAdapter, sendSelection);
      } catch (error) {
        // Cancellation, account switch and on-device-only ALWAYS fail closed.
        // Image requests never silently cross providers on a local failure.
        if (mode !== "auto" || sendProvider !== "offline" || hasImages || controllerAbort.signal.aborted || generation.current !== gen || (error instanceof Error && /abort|cancel/i.test(`${error.name} ${error.message}`))) throw error;
        if (cloudRecord === null) {
          cloudRecord = await resolvePinnedRecord();
          if (generation.current !== gen || controllerAbort.signal.aborted) return;
          if (cloudRecord === null) cloudRecord = HELP_MODEL_CATALOG[0]!;
          if (cloudRecord.provider === "offline") throw new Error("Choose a listed cloud model for fallback. Your draft is kept.");
        }
        const fallbackProvider = cloudRecord?.provider ?? "openrouter";
        const fallbackRefusal = !isProviderEnabled(accountId, fallbackProvider)
          ? "Experimental provider is disabled."
          : refuseHelpSend({ provider: fallbackProvider, record: cloudRecord, mode: loadEffectiveAssistantMode(accountId), hasImages: false });
        if (fallbackRefusal) throw new Error(fallbackRefusal);
        const fallbackKey = await readCloudKey(accountId, fallbackProvider);
        if (generation.current !== gen || controllerAbort.signal.aborted) return;
        if (fallbackKey === null) {
          finishFallback(persistFallback(chatId, historyOn, question), builtInHelp(question));
          return;
        }
        // Terminate the failed local attempt's partial before the cloud retry
        // owns the stream, so local text can never survive into cloud output.
        clearStreamingPartial();
        setNotice("On-device AI could not answer. Trying the connected cloud model.");
        const fallbackAdapter = deps?.createAdapter?.(fallbackProvider) ?? createProviderAdapter(fallbackProvider, {
          accountId, resolveKey: readCloudKey, resolveGenericEndpoint: (id) => loadGenericEndpoint(id),
        });
        result = await run(fallbackAdapter, { ...defaultSelection(accountId), provider: fallbackProvider, modelId: cloudRecord?.id ?? DEFAULT_MODEL_ID });
      }
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
      clearStreamingPartial();
      setAttempts((prev) =>
        prev.length === 0 ? prev : [...prev.slice(0, -1), { n: attemptN, status: "complete" }],
      );
      announce("Response received.");
    } catch (e) {
      if (generation.current !== gen) return;
      if (controllerAbort.signal.aborted || (e instanceof Error && e.name === "AbortError")) return;
      if (e instanceof ControllerError && e.code === "cancelled") return;
      const message = e instanceof Error ? e.message : "Sorry, I could not answer right now.";
      // Sanitized (C-owned scrubber): provider text may echo input or
      // key-like material, so it is scrubbed against the question and clipped.
      const safeMessage = sanitizeControllerError(message, [question]);
      clearStreamingPartial();
      setAttempts((prev) => [...prev, { n: attemptN, status: "failed" }]);
      if (hasImages || sendProvider === "offline" || loadEffectiveAssistantMode(accountId) === "offline-only" || !isProviderEnabled(accountId, sendProvider) || !isAppHelpQuestion(question)) {
        // Privacy refusals, general questions and any non-app-help failure
        // never get a FAQ substitution — the draft and tray photos are
        // preserved for Retry. Only a question the FAQ actually answers about
        // FindBack earns the labelled built-in answer below.
        setInput(question);
        setFailedSend({ text: question });
        setSendError(safeMessage);
        announce("Send failed. Your message and photos were kept — you can retry.");
        return;
      }
      // App-help intent only: a labelled built-in answer AND an honest error
      // banner with Retry. The fallback stays ephemeral — never persisted —
      // so a later retry replaces this attempt instead of duplicating a
      // saved fallback alongside the provider answer (screenshots 10/12).
      // Tray photos are preserved for the retry; the transcript never holes.
      const appHelpReply = builtInHelp(question);
      setEphemeral((prev) => {
        const next = [...prev];
        const last = next.at(-1);
        const secondLast = next.at(-2);
        if (
          last?.role === "assistant" &&
          secondLast?.role === "user" &&
          secondLast.text === question
        ) {
          next.pop();
          next.pop();
        }
        return [
          ...next,
          { id: `e-user-${gen}`, role: "user", text: question },
          { id: `e-assistant-${gen}`, role: "assistant", text: appHelpReply, source: "fallback" },
        ];
      });
      setFailedSend({ text: question });
      setSendError(safeMessage);
      announce("Send failed. A built-in answer was added and you can retry.");
    } finally {
      if (generation.current === gen) {
        setBusy(false);
        setControllerPhase(controller.getState().phase);
      }
    }
  }

  function stopFreeChat() {
    abortRef.current?.abort();
    abortRef.current = null;
    generation.current += 1;
    // Pin the guard: late controller chunks from the stopped send are dropped.
    sendGenRef.current = null;
    clearStreamingPartial();
    setBusy(false);
    setCancelled(true);
    setControllerPhase("cancelled");
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
    // The tray was preserved on general-chat failures, so attached photos ride
    // along again; app-intent failures cleared it, matching prior behaviour.
    void sendFreeChat(pending.text, { isRetry: true });
  }

  function clearChat() {
    abortRef.current?.abort();
    abortRef.current = null;
    generation.current += 1;
    sendGenRef.current = null;
    inflightRef.current = "";
    setBusy(false);
    setInput("");
    setFailedSend(null);
    setSendError(null);
    setCancelled(false);
    setEphemeral([]);
    clearStreamingPartial();
    setAttempts([]);
    announce("Chat view cleared.");
  }

  function handleSend() {
    void sendFreeChat(input);
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
    setAttempts([]);
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
    setAttempts([]);
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
      return {
        id: t.id,
        role: t.role,
        text: t.text,
        source: t.role === "assistant" ? sourceByTurn.current.get(t.id) : undefined,
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
      // No synthetic greeting: the empty conversation is the Assistant
      // landing's job now, not a fake transcript bubble.
      return [];
    }
    return [...stored, ...ephemeral];
  })();

  // Suggestions only start an empty conversation; actual turns and errors
  // keep the transcript visible. Chat never offers application actions.
  const isEmptyConversation = turns.length === 0 && ephemeral.length === 0;
  const showLanding =
    isEmptyConversation && !busy && partial === null && sendError === null && failedSend === null;
  const composerBusy = busy;
  // P1-2 honest fallback: the persisted default is raw and may name a paid
  // row absent from this catalogue (free seed + authorized load). Never crash
  // and never silently drop it — sends already fall back to the free route.
  const savedDefaultUnavailable =
    selectedModelId !== null && catalog.find((row) => row.id === selectedModelId) === undefined;

  // Real request-state row: controller phase + attempt history only — never
  // fabricated reasoning steps.
  const requestRow: string | null = (() => {
    if (sendError !== null) return sendError;
    if (cancelled) return "Send stopped. Your message was kept in the composer.";
    if (busy) {
      const phaseCopy =
        controllerPhase === "streaming"
          ? (partial === null ? "Waiting for first response" : "Streaming")
          : controllerPhase === "sending"
            ? "Sending"
            : "Preparing";
      const current = attempts.at(-1);
      const earlier = attempts.slice(0, -1);
      const history =
        earlier.length === 0
          ? ""
          : ` · earlier: ${earlier.map((a) => `attempt ${a.n} ${a.status}`).join(", ")}`;
      return `${phaseCopy}${current ? ` (attempt ${current.n}${current.status === "retrying" ? " · retrying" : ""})` : ""}${history}`;
    }
    return notice ?? trayNotice ?? (savedDefaultUnavailable ? "Saved model unavailable — choose a model or use Automatic. Your draft is kept." : null);
  })();
  const selectedRecord = catalog.find((row) => row.id === selectedModelId);
  // FBX-020 chip title (UI text only): the consumer model name. Catalog rows
  // map through the assistant picker titles (on-device rows read their
  // consumer title, never a raw engine id); an unknown persisted pin falls
  // back the same way instead of leaking an engine id.
  const selectedTitle = (() => {
    if (selectedModelId === null) return "Automatic";
    if (selectedRecord !== undefined) return assistantRowTitle(selectedRecord);
    try {
      const descriptor = getApplicationAi().registry.descriptorFor(selectedModelId);
      const title = descriptor?.consumerTitle.trim() ?? "";
      if (title !== "") return title;
      if (descriptor !== undefined) return "On-device model";
    } catch {
      // Registry unavailable: fall through to the cloud-name mapping.
    }
    return displayNameForCatalogRecord(
      { id: selectedModelId, provider: selection.provider },
    );
  })();

  function handleSelectModel(modelId: string) {
    // The choice rebuilds the controller binding above, so new sends carry
    // this model ID — never a header-only label. Paid/unknown-price rows stay
    // gated by policy at send time (never silent).
    setSelectedModelId(modelId);
    setModelOpen(false);
    announce(`${displayNameForCatalogRecord(catalog.find((row) => row.id === modelId) ?? { id: modelId, provider: selection.provider })} selected for new sends.`);
  }

  function handleSelectAutomatic() {
    setSelectedModelId(null);
    setModelOpen(false);
    announce("Automatic model selection for new sends.");
  }

  // FBX-020 per-response Retry: regenerates an assistant answer by re-sending
  // that turn's question through the existing send path (draft/tray rules
  // unchanged). A failed send keeps its own Retry; this never fires while
  // a send is in flight.
  function retryResponse(messageId: string) {
    if (busy) return;
    const index = freeMessages.findIndex((m) => m.id === messageId && m.role === "assistant");
    if (index < 0) return;
    for (let i = index - 1; i >= 0; i -= 1) {
      const prior = freeMessages[i];
      if (prior !== undefined && prior.role === "user" && prior.text.trim() !== "") {
        announce("Trying that answer again.");
        void sendFreeChat(prior.text);
        return;
      }
    }
  }

  // FBX-020 Configure sheet: writes through the canonical preferences store
  // (the same values AiSettings owns) — a conversational policy choice with
  // a real effect, never a display-only control.
  function openConfigure() {
    try {
      setPrefsMode(loadSeededAiPreferences(accountId).assistantMode);
    } catch {
      // Stale in-memory choice stands; the sheet still opens.
    }
    setMenuOpen(false);
    setConfigureOpen(true);
  }

  function selectAssistantMode(next: AssistantModePreference) {
    try {
      updateAiPreferences(accountId, { assistantMode: next });
    } catch {
      // Persistence is best effort; the in-memory choice still applies.
    }
    setPrefsMode(next);
    announce(
      next === "automatic"
        ? "Automatic answering."
        : next === "on-device-only"
          ? "On-device only. Nothing is sent to a cloud AI provider."
          : "Cloud only. Local generation is skipped.",
    );
  }

  function stopComposer() {
    stopFreeChat();
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface text-on-surface">
      <a
        href="#help-composer-input"
        className="sr-only focus:not-sr-only focus:block focus:bg-surface-container focus:px-4 focus:py-2 focus:text-sm focus:text-on-surface"
      >
        Skip to composer
      </a>
      {/* U2: single-row header. Row 1: back + truncating title +
        fixed-size history/overflow. Model selection lives with the composer;
        privacy/help live in the overflow menu. No Clear button here — it
        lives in HistorySheet (saved chats, confirmed) and the overflow menu
        (view-only clear). */}
      <header className="shrink-0 border-b border-outline-variant bg-surface px-3 py-2">
        <div className="flex min-w-0 items-center gap-1">
          <BackButton fallbackTo="/profile" label="Back to profile" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold leading-tight">Assistant</h1>
          </div>
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            aria-label="Open chat history"
            className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-m3-xs text-on-surface hover:bg-surface-container"
          >
            <History size={20} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuConfirmClear(false);
              setMenuOpen(true);
            }}
            aria-label="More options"
            className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-m3-xs text-on-surface hover:bg-surface-container"
          >
            <MoreVertical size={20} aria-hidden />
          </button>
        </div>
      </header>

      <main aria-label="Help conversation" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {showLanding ? (
          <AssistantLanding
            suggestions={SUGGESTIONS}
            onSuggestion={(text) => void sendFreeChat(text)}
            compact={keyboardOpen}
          />
        ) : (
          <ChatTranscript
            messages={freeMessages}
            partialText={busy && controllerPhase === "streaming" ? (partial?.text ?? null) : null}
            partialLabel={busy && controllerPhase === "streaming" ? (partial?.label ?? null) : null}
            onRetryMessage={retryResponse}
          />
        )}

        {/* U2: the permanent privacy block is gone from the conversation.
            The full consent copy lives one tap away in the overflow menu
            (Privacy & AI sheet) — the transcript keeps the viewport. */}

        {requestRow !== null && (
          <div data-testid="assistant-status" className="flex shrink-0 items-center gap-2 bg-surface px-4 pb-1">
            <p data-testid={sendError !== null ? "chat-error" : cancelled ? "chat-cancelled" : savedDefaultUnavailable && !busy && notice === null ? "model-default-unavailable" : "chat-request-state"}
              role={sendError !== null ? "alert" : "status"} className="min-w-0 flex-1 text-xs text-on-surface-variant">{requestRow}</p>
            {sendError !== null && failedSend !== null && (
              <button type="button" data-testid="chat-retry" onClick={retryLast} disabled={composerBusy}
                className="min-h-[48px] shrink-0 rounded-full border border-outline px-3 text-xs font-medium disabled:opacity-60">Retry</button>
            )}
          </div>
        )}

        {/* ChatComposer owns the model chip row (FBX-020: selection lives
            with the composer, not in the header) — wrapped shrink-0 so the
            bounded column never squeezes it. */}
        <div className="shrink-0">
        <ChatComposer
          value={input}
          onChange={setInput}
          onSend={handleSend}
          busy={composerBusy}
          onStop={stopComposer}
          inputId="help-composer-input"
          modelTitle={selectedTitle}
          onOpenModels={() => setModelOpen(true)}
          modelDisabled={composerBusy}
          selections={[
            ...tray.items.map((item) => ({
              id: item.id,
              name: item.fileName,
              previewUrl: previewUrls.get(item.id) ?? "",
              disclosure: frameDisclosureFor(item),
            })),
            ...pendingPhotos.map((row) => ({
              id: row.key,
              name: "photo",
              previewUrl: "",
              disclosure: null,
              status: row.status,
              message: row.message ?? (row.status === "preparing" ? "Preparing photo…" : null),
            })),
          ]}
          onRemoveSelection={removeAnySelection}
          onRetrySelection={retryNativePick}
          onAddFiles={nativeIntake ? undefined : (files) => void addFiles(files)}
          onPickImage={nativeIntake ? pickNative : undefined}
          blockSend={pendingPhotos.length > 0}
          maxSelections={MAX_CHAT_SELECTIONS}
        />
        </div>
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
      {/* U2: overflow menu — New chat, History, Help & guide, Privacy & AI,
        Assistant settings, and the view-only Clear (two-step confirm).
        Saved chats (with confirmed Clear all) stay in HistorySheet. */}
      <BottomSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title="Assistant options"
        description="View options for this screen. Saved chats stay in Chat history."
      >
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => {
              newChat();
              setMenuOpen(false);
            }}
            className="flex min-h-[48px] items-center text-sm text-on-surface hover:bg-surface-container"
          >
            New chat
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setHistoryOpen(true);
            }}
            className="flex min-h-[48px] items-center text-sm text-on-surface hover:bg-surface-container"
          >
            History
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              navigate("/settings/help");
            }}
            className="flex min-h-[48px] items-center text-sm text-on-surface hover:bg-surface-container"
          >
            Help &amp; guide
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setPrivacyOpen(true);
            }}
            className="flex min-h-[48px] items-center text-sm text-on-surface hover:bg-surface-container"
          >
            Privacy &amp; AI
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              navigate("/settings/ai");
            }}
            className="flex min-h-[48px] items-center text-sm text-on-surface hover:bg-surface-container"
          >
            Assistant settings
          </button>
          <button
            type="button"
            onClick={openConfigure}
            className="flex min-h-[48px] items-center text-sm text-on-surface hover:bg-surface-container"
          >
            Configure assistant
          </button>
          {menuConfirmClear ? (
            <div className="flex items-center gap-2">
              <p className="flex-1 text-xs text-on-surface-variant">
                Clear the messages on this screen? Saved chats are kept.
              </p>
              <button
                type="button"
                onClick={() => {
                  clearChat();
                  setMenuConfirmClear(false);
                  setMenuOpen(false);
                }}
                className="min-h-[48px] rounded-full bg-on-surface px-4 text-xs font-semibold text-surface"
              >
                Confirm clear view
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setMenuConfirmClear(true)}
              className="flex min-h-[48px] items-center text-xs font-medium text-on-surface underline"
            >
              Clear chat view
            </button>
          )}
        </div>
      </BottomSheet>
      {/* U2: Privacy & AI sheet — the full consent copy, one tap away from the
        conversation instead of permanently occupying transcript space. */}
      <BottomSheet
        open={privacyOpen}
        onClose={() => setPrivacyOpen(false)}
        title="Privacy & AI"
        description="How this assistant handles your messages and photos."
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-on-surface">Automatic</p>
            <p className="text-xs leading-relaxed text-on-surface-variant">
              FindBack may use an installed on-device model first. Cloud fallback follows your
              current AI setting.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-on-surface">Photos</p>
            <p className="text-xs leading-relaxed text-on-surface-variant">
              A photo is included only when you select it for that message.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-on-surface">On-device only</p>
            <p className="text-xs leading-relaxed text-on-surface-variant">
              Nothing is sent to a cloud AI provider.
            </p>
          </div>
          <button type="button" onClick={() => { setPrivacyOpen(false); navigate("/settings/ai/privacy"); }}
            className="min-h-[48px] text-left text-sm font-medium underline">Full details ›</button>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setPrivacyOpen(false);
                navigate("/settings/ai");
              }}
              className="flex min-h-[48px] items-center rounded-full border border-outline px-4 text-xs font-medium text-on-surface"
            >
              Open AI settings
            </button>
            <button
              type="button"
              onClick={() => {
                setPrivacyOpen(false);
                navigate("/settings/privacy");
              }}
              className="flex min-h-[48px] items-center rounded-full border border-outline px-4 text-xs font-medium text-on-surface"
            >
              Open Privacy settings
            </button>
          </div>
        </div>
      </BottomSheet>
      <BottomSheet
        open={modelOpen}
        onClose={() => setModelOpen(false)}
        title="Choose model"
        description="Pick the model for new sends."
      >
        <div data-testid="model-picker" className="flex flex-col gap-3">
          <ModelCatalogSheet
            variant="assistant"
            models={[...catalog]}
            selectedId={selectedModelId}
            onSelect={handleSelectModel}
            onSelectAutomatic={handleSelectAutomatic}
            retrievedAt={catalog[0]?.retrievedAt ?? null}
            offlineDetail={offlineDetail}
          />
          {catalogLoading ? (
            <p role="status" className="text-[11px] text-on-surface-variant">
              Refreshing the catalogue…
            </p>
          ) : null}
          <p className="text-[11px] text-on-surface-variant">
            Shows models your connected keys unlock. Your choice
            applies to new sends; paid or unknown-price models need explicit consent per task and
            are never used silently.
          </p>
        </div>
      </BottomSheet>
      {/* FBX-020 Configure sheet: answer policy, conversational model choice,
          and management links — separate from Privacy & AI and the picker. */}
      <BottomSheet
        open={configureOpen}
        onClose={() => setConfigureOpen(false)}
        title="Configure assistant"
        description="Answer policy, conversation model, and where to manage AI."
      >
        <AssistantConfigureSheet
          mode={prefsMode}
          onSelectMode={selectAssistantMode}
          modelTitle={selectedTitle}
          onChooseModel={() => {
            setConfigureOpen(false);
            setModelOpen(true);
          }}
        />
      </BottomSheet>
    </div>
  );
}
