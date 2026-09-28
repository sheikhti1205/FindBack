import { useState } from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { motion } from "framer-motion";
import { BottomSheet } from "./BottomSheet";
import { motionSprings } from "./uiMotion";

export interface HistoryChatSummary {
  id: string;
  title: string;
  updatedAt: string;
  preview?: string;
}

export interface HistorySheetProps {
  open: boolean;
  onClose: () => void;
  chats: readonly HistoryChatSummary[];
  activeChatId: string | null;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onNew: () => void;
  onContinue: (chatId: string) => void;
  onRename: (chatId: string, title: string) => void;
  onDelete: (chatId: string) => void;
  onClear: () => void;
  historyEnabled?: boolean;
  onToggleHistory?: (enabled: boolean) => void;
}

/**
 * Chat-history popup (a sheet, never a sidebar). New / search / continue /
 * rename / delete / clear map 1:1 onto the chatStore contract; the store
 * behind it stays account-scoped so switching accounts never leaks chats.
 */
export function HistorySheet({
  open,
  onClose,
  chats,
  activeChatId,
  searchQuery,
  onSearchQueryChange,
  onNew,
  onContinue,
  onRename,
  onDelete,
  onClear,
  historyEnabled = true,
  onToggleHistory,
}: HistorySheetProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  function beginRename(chat: HistoryChatSummary) {
    setRenamingId(chat.id);
    setDraftTitle(chat.title);
    setConfirmDeleteId(null);
  }

  function saveRename() {
    if (renamingId !== null && draftTitle.trim() !== "") {
      onRename(renamingId, draftTitle.trim());
    }
    setRenamingId(null);
    setDraftTitle("");
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Chat history"
      description="Your saved conversations on this device."
    >
      <div data-testid="history-sheet" className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={16}
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
            />
            <input
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              maxLength={120}
              className="w-full rounded-full border border-outline-variant bg-surface py-2.5 pl-9 pr-4 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={onNew}
            className="flex min-h-[48px] items-center gap-1.5 rounded-full bg-on-surface px-4 text-sm font-semibold text-surface"
          >
            <Plus size={16} aria-hidden /> New chat
          </button>
        </div>
        {onToggleHistory !== undefined && (
          <button
            type="button"
            role="switch"
            aria-checked={historyEnabled}
            aria-label="Chat history"
            onClick={() => onToggleHistory(!historyEnabled)}
            className="flex min-h-[48px] items-center justify-between rounded-m3-sm border border-outline-variant px-3 text-sm text-on-surface"
          >
            <span>Save chat history on this device</span>
            <span
              aria-hidden
              className={`relative h-6 w-11 rounded-full transition-colors ${
                historyEnabled ? "bg-on-surface" : "bg-surface-container-high"
              }`}
            >
              {/* Motion owns the travel (x only) — no CSS left/transition-all race. */}
              <motion.span
                data-history-thumb
                className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-surface shadow"
                initial={false}
                animate={{ x: historyEnabled ? 20 : 0 }}
                transition={motionSprings.snappy}
              />
            </span>
          </button>
        )}
        {chats.length === 0 ? (
          <p data-testid="history-empty" className="py-6 text-center text-sm text-on-surface-variant">
            {searchQuery.trim() === ""
              ? "No chats yet. Start a new chat to keep it here."
              : "No chats match this search."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Saved chats">
            {chats.map((chat) => (
              <li
                key={chat.id}
                data-testid="history-item"
                className={`flex flex-col gap-1 rounded-m3-sm border px-3 py-2 ${
                  chat.id === activeChatId
                    ? "border-on-surface bg-surface-container-low"
                    : "border-outline-variant"
                }`}
              >
                {renamingId === chat.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      aria-label="Chat title"
                      maxLength={80}
                      className="w-full rounded-m3-xs border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface focus:border-on-surface focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={saveRename}
                      className="min-h-[48px] shrink-0 rounded-m3-xs bg-on-surface px-3 text-xs font-semibold text-surface"
                    >
                      Save title
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onContinue(chat.id)}
                      aria-label={`Continue ${chat.title}`}
                      className="min-h-[48px] flex-1 text-left"
                    >
                      <span className="block truncate text-sm font-medium text-on-surface">
                        {chat.title}
                        {chat.id === activeChatId && (
                          <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">
                            Current
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-on-surface-variant">
                        {chat.preview ?? new Date(chat.updatedAt).toLocaleString()}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => beginRename(chat)}
                      aria-label={`Rename ${chat.title}`}
                      className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-m3-xs text-on-surface-variant hover:bg-surface-container"
                    >
                      <Pencil size={16} aria-hidden />
                    </button>
                    {confirmDeleteId === chat.id ? (
                      <button
                        type="button"
                        onClick={() => {
                          onDelete(chat.id);
                          setConfirmDeleteId(null);
                        }}
                        aria-label="Confirm delete"
                        className="min-h-[48px] rounded-m3-xs bg-on-surface px-3 text-xs font-semibold text-surface"
                      >
                        Confirm delete
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(chat.id)}
                        aria-label={`Delete ${chat.title}`}
                        className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-m3-xs text-on-surface-variant hover:bg-surface-container"
                      >
                        <Trash2 size={16} aria-hidden />
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {chats.length > 0 &&
          (confirmClear ? (
            <div className="flex items-center gap-2">
              <p className="flex-1 text-xs text-on-surface-variant">
                Delete every saved chat on this device? This cannot be undone.
              </p>
              <button
                type="button"
                onClick={() => {
                  onClear();
                  setConfirmClear(false);
                }}
                className="min-h-[48px] rounded-full bg-on-surface px-4 text-xs font-semibold text-surface"
              >
                Confirm clear all
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="min-h-[48px] rounded-m3-xs px-3 text-xs font-semibold text-on-surface-variant underline"
            >
              Clear all chats
            </button>
          ))}
      </div>
    </BottomSheet>
  );
}
