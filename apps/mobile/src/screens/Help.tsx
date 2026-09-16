import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, SendHorizonal, User } from "lucide-react";
import { useAuth } from "../auth";
import { BackButton } from "../components/BackButton";
import { askAiHelp } from "../services/auth";

interface Message {
  role: "user" | "assistant";
  text: string;
  demo?: boolean;
}

const SUGGESTIONS = [
  "How do I report a lost item?",
  "How do I mark an item recovered?",
  "What details should I include?",
  "How do I search and filter?",
];

export function Help() {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      text: `Hi ${user?.username ?? "there"}! I am the FindBack Help Assistant. Ask me anything about using the app — reporting, recovering, searching, verifying, ratings and more.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text: question }]);
    setBusy(true);
    try {
      const res = await askAiHelp(question);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: res.text, demo: res.source === "fallback" },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: e instanceof Error ? e.message : "Sorry, I could not answer right now.",
          demo: true,
        },
      ]);
    } finally {
      setBusy(false);
    }
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
        <div>
          <h1 className="text-base font-semibold leading-tight">Help Assistant</h1>
          <p className="text-xs text-on-surface-variant">Generative AI · demo fallback active</p>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-m3-md px-3.5 py-2.5 text-sm leading-relaxed ${
                m.role === "user"
                  ? "bg-on-surface text-surface"
                  : "border border-outline-variant bg-surface-container-low"
              }`}
            >
              {m.role === "assistant" && m.demo && (
                <p className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-on-surface-variant">
                  <User size={11} aria-hidden /> demo answer (no API key configured)
                </p>
              )}
              <p className="whitespace-pre-wrap">{m.text}</p>
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-on-surface-variant">
            <span aria-hidden className="h-3 w-3 animate-spin rounded-full border border-outline border-t-on-surface" />
            Thinking…
          </div>
        )}
        <div ref={bottomRef} aria-hidden />
      </div>

      {messages.length < 4 && (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void send(s)}
              className="rounded-full border border-outline-variant px-3 py-1.5 text-xs text-on-surface-variant hover:bg-surface-container"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-outline-variant p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about reporting, recovering, searching…"
          aria-label="Ask the Help Assistant"
          className="w-full rounded-full border border-outline-variant bg-surface px-4 py-2.5 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!input.trim() || busy}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-on-surface text-surface disabled:opacity-40"
        >
          <SendHorizonal size={18} aria-hidden />
        </button>
      </form>
    </div>
  );
}
