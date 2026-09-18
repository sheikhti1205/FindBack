import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { ArrowDown, Bot, SendHorizonal } from "lucide-react";
import { useAuth } from "../auth";
import { askAiHelp, type AiHelpMessage } from "../services/auth";
import { APP_VERSION } from "../services/appCapabilities";
import { BackButton } from "../components/BackButton";
import { MarkdownView } from "../components/MarkdownView";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  source?: "llm" | "fallback";
  failed?: boolean;
}

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
  OPEN_OFFLINE_AI: "/offline-ai",
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

export function Help() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: `Hi ${user?.username ?? "there"}! I am the FindBack Help Assistant. Ask me anything about using the app — reporting, recovering, searching, verifying, ratings and more.`,
      source: "fallback",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [showNewResponse, setShowNewResponse] = useState(false);
  const generation = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  function nearBottom(): boolean {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  }

  function scrollToLatest() {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    bottomRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
    setShowNewResponse(false);
  }

  useEffect(() => {
    if (messages.length === 0) return;
    if (nearBottom()) {
      scrollToLatest();
    } else if (messages[messages.length - 1]?.role === "assistant") {
      setShowNewResponse(true);
    }
  }, [messages]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const gen = ++generation.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setInput("");
    setShowNewResponse(false);
    const history: AiHelpMessage[] = [...messages, { role: "user" as const, text: question }]
      .slice(-7, -1)
      .map((m): AiHelpMessage => ({ role: m.role, text: m.text }));
    setMessages((prev) => [...prev, { role: "user", text: question }]);
    setBusy(true);
    try {
      const res = await askAiHelp(question, {
        history,
        context: { route: pathname, appVersion: APP_VERSION, online },
        signal: controller.signal,
      });
      if (generation.current !== gen) return; // cancelled or superseded
      setMessages((prev) => [...prev, { role: "assistant", text: res.text, source: res.source }]);
    } catch (e) {
      if (generation.current !== gen) return;
      if (e instanceof Error && e.name === "AbortError") return;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: e instanceof Error ? e.message : "Sorry, I could not answer right now.",
          source: "fallback",
          failed: true,
        },
      ]);
    } finally {
      if (generation.current === gen) setBusy(false);
    }
  }

  function cancel() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    generation.current++;
    setBusy(false);
  }

  function clearChat() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    generation.current++;
    setBusy(false);
    setInput("");
    setShowNewResponse(false);
    setMessages([
      {
        role: "assistant",
        text: "Chat cleared. What would you like to know about FindBack?",
        source: "fallback",
      },
    ]);
  }

  function retryLast() {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser || busy) return;
    setMessages((prev) => {
      const next = [...prev];
      const lastIdx = next.map((m) => m.role).lastIndexOf("assistant");
      if (lastIdx >= 0 && next[lastIdx]?.failed) next.splice(lastIdx, 1);
      return next;
    });
    void send(lastUser.text);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center gap-2 border-b border-outline-variant px-4 py-3">
        <BackButton fallbackTo="/profile" label="Back to profile" />
        <Bot size={20} aria-hidden />
        <div className="flex-1">
          <h1 className="text-base font-semibold leading-tight">Help Assistant</h1>
          <p className="text-xs text-on-surface-variant">
            App-specific answers · answered by our server
          </p>
        </div>
        <button
          type="button"
          onClick={clearChat}
          className="min-h-[48px] rounded-m3-xs px-3 text-xs font-medium text-on-surface-variant hover:bg-surface-container"
        >
          Clear chat
        </button>
      </header>

      <div ref={scrollRef} className="relative flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {messages.map((m, i) => {
          const parsed = m.role === "assistant" ? parseHelpResponse(m.text) : null;
          return (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-m3-md px-3.5 py-2.5 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-on-surface text-surface"
                    : "border border-outline-variant bg-surface-container-low"
                }`}
              >
                {m.role === "assistant" && (
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-on-surface-variant">
                    {m.source === "llm" ? "Cloud AI" : "Built-in answer"}
                  </p>
                )}
                {m.role === "assistant" ? (
                  <MarkdownView text={parsed?.markdown ?? m.text} />
                ) : (
                  <p className="whitespace-pre-wrap">{m.text}</p>
                )}
                {parsed && parsed.actions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {parsed.actions.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => navigate(ACTION_ROUTES[a.id]!)}
                        className="min-h-[48px] rounded-full border border-outline px-3 text-xs font-medium"
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
                {m.failed && (
                  <button
                    type="button"
                    onClick={retryLast}
                    className="mt-2 min-h-[48px] rounded-m3-xs px-3 text-xs font-semibold underline"
                  >
                    Retry
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-on-surface-variant">
            <span aria-hidden className="h-3 w-3 animate-spin rounded-full border border-outline border-t-on-surface" />
            Thinking…
            <button
              type="button"
              onClick={cancel}
              className="min-h-[48px] rounded-m3-xs px-3 text-xs font-semibold underline"
            >
              Cancel
            </button>
          </div>
        )}
        <div ref={bottomRef} aria-hidden />
      </div>

      {showNewResponse && (
        <div className="flex justify-center px-4 pb-2">
          <button
            type="button"
            onClick={scrollToLatest}
            className="flex min-h-[48px] items-center gap-1 rounded-full border border-outline bg-surface px-4 text-xs font-semibold shadow"
          >
            <ArrowDown size={14} aria-hidden /> New response
          </button>
        </div>
      )}

      {messages.length < 4 && (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void send(s)}
              className="min-h-[48px] rounded-full border border-outline-variant px-3 text-xs text-on-surface-variant hover:bg-surface-container"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <p className="px-4 pb-1 text-[11px] text-on-surface-variant">
        Your question is answered by FindBack&apos;s server and needs an internet connection;
        photos are never attached automatically. Without a configured AI provider you get a
        built-in answer — still via the server, not offline.
      </p>

      <form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-outline-variant p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about reporting, recovering, searching…"
          aria-label="Ask the Help Assistant"
          maxLength={500}
          className="w-full rounded-full border border-outline-variant bg-surface px-4 py-2.5 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!input.trim() || busy}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-on-surface text-surface disabled:opacity-40"
        >
          <SendHorizonal size={18} aria-hidden />
        </button>
      </form>
    </div>
  );
}
