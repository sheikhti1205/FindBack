import { useEffect, useRef, useState } from "react";
import { ImagePlus, SendHorizonal, Smile, Sticker, X } from "lucide-react";
import { UserAvatar } from "./UserAvatar";
import { MentionAutocomplete, type MentionCandidate } from "./MentionAutocomplete";
import {
  COMMENT_ATTACH_MAX,
  createCommentAttachment,
  createKlipyAttachment,
  removeCommentAttachment,
  uploadCommentAttachment,
  validateAttachableFile,
  type CommentAttachment,
} from "../services/commentAttachments";
import {
  appendBodyMedia,
  bodyHasInlineData,
  commentMediaProvenance,
  MAX_COMMENT_BODY,
} from "../services/commentBodyMedia";
import {
  KLIPY_ATTRIBUTION,
  KLIPY_ATTRIBUTION_URL,
  KLIPY_SEARCH_PLACEHOLDER,
  isKlipyEnabled,
  klipyCustomerId,
  searchKlipyGifs,
  searchKlipyStickers,
  trackKlipyShare,
  type KlipyItem,
  type KlipyKind,
} from "../services/klipy";
import { friendlyError } from "../utils/friendlyErrors";

/**
 * C3 compact social comment composer: avatar + expandable input + send icon.
 *
 * - `@` mentions through the shared `MentionAutocomplete` (avatar +
 *   display name + @username, anchored to the composer, keyboard/touch safe).
 * - Emoji through a web picker panel (grid of buttons inserting at the
 *   caret) — never a vendor-keyboard hack.
 * - Local photo/video attach: picked files preview from `blob:` object URLs
 *   and upload to Storage under the caller's own folder (same RLS path as
 *   report photos) with progress / retry / remove. The comment body carries
 *   only `https://` remote URLs — never base64.
 * - GIF/Sticker through the Klipy adapter behind the `VITE_KLIPY_API_KEY`
 *   config flag: stable customer_id, high content filter, "Search KLIPY"
 *   placeholder, provider URLs/data preserved and loaded directly,
 *   share-tracking only after the comment posts, "Powered by KLIPY"
 *   attribution. The control is hidden entirely when the key is absent.
 */

export interface CommentComposerProps {
  postId: string;
  replyToUsername?: string | null;
  currentUser?: { id?: string | null; username?: string | null; avatarUrl?: string | null } | null;
  participants: MentionCandidate[];
  owner?: MentionCandidate | null;
  disabled?: boolean;
  /** Parent writes the comment (addComment + list append). May throw. */
  onSubmit: (body: string) => Promise<void>;
  /** Parent surfaces failures inline (actionError + announce pattern). */
  onError: (message: string) => void;
  /** Parent clears reply affordances after a successful post. */
  onSent?: () => void;
}

/** Compact web emoji set for the picker panel (content, not icon font). */
const EMOJI_SET = [
  "😀", "😁", "😂", "🤣", "😊", "😍", "😘", "🥳",
  "😎", "🤔", "😅", "😭", "😡", "👍", "👎", "🙏",
  "👏", "🎉", "❤️", "💔", "🔥", "⭐", "✅", "❌",
  "👀", "💡", "🎁", "🐶", "🐱", "🌸", "🍀", "🌈",
  "⚽", "🚗", "🏠", "📱", "💻", "📷", "🎵", "📚",
  "☕", "🍕", "🎂", "💰", "🔑", "🧳", "⛺", "🌍",
];

/** Insert `insert` at the caret; returns the next value + caret. Pure (tested via UI). */
export function insertAtCaret(
  value: string,
  start: number | null,
  end: number | null,
  insert: string,
): { next: string; caret: number } {
  const s = start ?? value.length;
  const e = end ?? s;
  const next = `${value.slice(0, s)}${insert}${value.slice(e)}`;
  return { next, caret: s + insert.length };
}

type GifTab = KlipyKind;

export function CommentComposer({
  postId: _postId,
  replyToUsername = null,
  currentUser = null,
  participants,
  owner = null,
  disabled = false,
  onSubmit,
  onError,
  onSent,
}: CommentComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<CommentAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [gifTab, setGifTab] = useState<GifTab>("gifs");
  const [gifQuery, setGifQuery] = useState("");
  const [gifResults, setGifResults] = useState<KlipyItem[]>([]);
  const [gifLoading, setGifLoading] = useState(false);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const filesRef = useRef(new Map<string, File>());
  const gifSeq = useRef(0);
  const gifEnabled = isKlipyEnabled();

  // Auto-grow 1→5 lines from scrollHeight (never animated per keystroke).
  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight <= 0) return;
    const style = window.getComputedStyle(el);
    const line = Number.parseFloat(style.lineHeight) || 24;
    const pad =
      (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const cap = line * 5 + pad;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    el.style.overflowY = el.scrollHeight > cap ? "auto" : "hidden";
  }, [text]);

  // Debounced Klipy search (trending while the query is empty). Latest-wins.
  useEffect(() => {
    if (!gifOpen || !gifEnabled) return;
    const id = ++gifSeq.current;
    setGifLoading(true);
    const timer = window.setTimeout(() => {
      const run = gifTab === "gifs" ? searchKlipyGifs : searchKlipyStickers;
      void run(gifQuery, { customerId: klipyCustomerId(currentUser?.id) }).then((items) => {
        if (gifSeq.current !== id) return;
        setGifResults(items);
        setGifLoading(false);
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [gifOpen, gifEnabled, gifTab, gifQuery, currentUser?.id]);

  function focusAt(caret: number) {
    requestAnimationFrame(() => {
      const el = fieldRef.current;
      if (!el) return;
      el.focus();
      try {
        el.setSelectionRange(caret, caret);
      } catch {
        // setSelectionRange is best-effort (hidden/disabled fields).
      }
    });
  }

  function handleMentionInsert(next: string, caret: number) {
    setText(next);
    focusAt(caret);
  }

  function insertEmoji(emoji: string) {
    const el = fieldRef.current;
    const { next, caret } = insertAtCaret(text, el?.selectionStart ?? null, el?.selectionEnd ?? null, emoji);
    setText(next);
    focusAt(caret);
  }

  function patchAttachment(id: string, patch: Partial<CommentAttachment>) {
    setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  async function startUpload(entry: CommentAttachment, file: File) {
    patchAttachment(entry.id, { status: "uploading", progress: 0, error: undefined });
    try {
      const { remoteUrl, objectKey } = await uploadCommentAttachment(entry, file, {
        onProgress: (p) => {
          const ratio = p.total > 0 ? Math.min(1, p.loaded / p.total) : 0;
          patchAttachment(entry.id, { progress: ratio });
        },
      });
      patchAttachment(entry.id, { status: "uploaded", progress: 1, remoteUrl, objectKey });
    } catch (err) {
      patchAttachment(entry.id, {
        status: "failed",
        error: friendlyError(err).message,
      });
    }
  }

  function addFiles(fileList: FileList | File[]) {
    const picked = [...fileList];
    if (picked.length === 0) return;
    setAttachNotice(null);
    const room = COMMENT_ATTACH_MAX - attachments.length;
    if (room <= 0) {
      setAttachNotice(`Comments hold up to ${COMMENT_ATTACH_MAX} attachments. Remove one first.`);
      return;
    }
    let denied: string | null = null;
    for (const file of picked.slice(0, room)) {
      const problem = validateAttachableFile(file);
      if (problem) {
        denied = problem;
        continue;
      }
      const entry = createCommentAttachment(file);
      filesRef.current.set(entry.id, file);
      setAttachments((prev) => [...prev, entry]);
      void startUpload(entry, file);
    }
    if (picked.length > room) {
      setAttachNotice(`Comments hold up to ${COMMENT_ATTACH_MAX} attachments. Remove one first.`);
    } else if (denied) {
      setAttachNotice(denied);
    }
  }

  function retryAttachment(entry: CommentAttachment) {
    const file = filesRef.current.get(entry.id);
    if (!file) {
      patchAttachment(entry.id, { status: "failed", error: "That file is no longer available." });
      return;
    }
    void startUpload(entry, file);
  }

  async function removeAttachment(entry: CommentAttachment) {
    filesRef.current.delete(entry.id);
    setAttachments((prev) => prev.filter((a) => a.id !== entry.id));
    await removeCommentAttachment(entry);
  }

  function pickGif(item: KlipyItem) {
    if (attachments.length >= COMMENT_ATTACH_MAX) {
      setAttachNotice(`Comments hold up to ${COMMENT_ATTACH_MAX} attachments. Remove one first.`);
      return;
    }
    const entry = createKlipyAttachment({
      slug: item.slug,
      kind: item.kind,
      mediaUrl: item.mediaUrl,
      previewUrl: item.previewUrl,
      title: item.title,
    });
    setAttachments((prev) => [...prev, entry]);
    setGifOpen(false);
    fieldRef.current?.focus();
  }

  const uploading = attachments.some((a) => a.status === "uploading");
  const failed = attachments.filter((a) => a.status === "failed");
  const readyToPost = attachments.filter((a) => a.status === "uploaded" && a.remoteUrl);
  const pendingLocal = attachments.filter((a) => a.status === "ready" || a.status === "uploading");
  const bodyPreview = appendBodyMedia(
    text,
    readyToPost.map((a) => ({ kind: a.kind, remoteUrl: a.remoteUrl as string })),
  );
  const overLimit = bodyPreview.length > MAX_COMMENT_BODY;
  const sendDisabled =
    disabled ||
    sending ||
    uploading ||
    pendingLocal.length > 0 ||
    failed.length > 0 ||
    overLimit ||
    (text.trim() === "" && readyToPost.length === 0);

  async function onSend() {
    if (sendDisabled) return;
    // Free-text paste guard: attachments travel as `https://` remote URLs, so
    // a pasted `data:` URL in the text would inline base64 into the body
    // (payload bloat that never renders as gallery media). Block with copy —
    // never silently strip user content, and never allow it under the length
    // cap (no wont-fix: even small payloads break the https-only invariant).
    if (bodyHasInlineData(text)) {
      onError(
        "That text holds pasted image data. Remove it and attach the photo instead so it uploads cleanly.",
      );
      return;
    }
    const body = appendBodyMedia(
      text,
      readyToPost.map((a) => ({ kind: a.kind, remoteUrl: a.remoteUrl as string })),
    );
    if (body.trim() === "" || body.length > MAX_COMMENT_BODY) return;
    // Snapshot Klipy picks for post-only share-tracking.
    const shares = attachments
      .filter((a) => a.kind === "gif" && a.klipySlug)
      .map((a) => ({ kind: a.klipyKind ?? ("gifs" as const), slug: a.klipySlug as string }));
    setSending(true);
    try {
      await onSubmit(body);
      // Share-tracking only on post: the comment exists server-side now.
      const customerId = klipyCustomerId(currentUser?.id);
      for (const s of shares) {
        void trackKlipyShare(s.kind, s.slug, customerId);
      }
      for (const a of attachments) {
        if (a.previewUrl.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(a.previewUrl);
          } catch {
            // Best-effort.
          }
        }
      }
      filesRef.current.clear();
      setAttachments([]);
      setText("");
      setAttachNotice(null);
      onSent?.();
    } catch (err) {
      onError(friendlyError(err).message);
    } finally {
      setSending(false);
    }
  }

  const placeholder = replyToUsername ? `Reply to @${replyToUsername}…` : "Write a helpful comment…";

  return (
    <div data-testid="comment-composer" className="flex items-start gap-2">
      <UserAvatar avatarUrl={currentUser?.avatarUrl} username={currentUser?.username} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-end gap-1.5">
          <div className="relative min-w-0 flex-1">
            <textarea
              ref={fieldRef}
              data-testid="comment-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={placeholder}
              aria-label={replyToUsername ? `Reply to ${replyToUsername}` : "Comment"}
              disabled={disabled || sending}
              rows={1}
              className="w-full resize-none overflow-y-auto rounded-m3-md border border-outline-variant bg-surface px-3.5 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none disabled:opacity-60"
            />
            <MentionAutocomplete
              inputRef={fieldRef}
              value={text}
              participants={participants}
              owner={owner}
              onInsert={handleMentionInsert}
            />
          </div>
          <button
            type="button"
            data-testid="comment-send"
            onClick={() => void onSend()}
            disabled={sendDisabled}
            aria-label={replyToUsername ? "Send reply" : "Send comment"}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-on-surface text-surface disabled:opacity-40"
          >
            <SendHorizonal size={18} aria-hidden />
          </button>
        </div>

        {/* Accessory row: attach + emoji + GIF live under the input so the
            text field keeps the full usable width at 320dp. */}
        <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            data-testid="comment-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || sending}
            aria-label="Attach a photo or video"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container disabled:opacity-60"
          >
            <ImagePlus size={20} aria-hidden />
          </button>
          <input
            ref={fileInputRef}
            data-testid="comment-file-input"
            type="file"
            accept="image/*,video/mp4,video/webm,video/quicktime"
            multiple
            disabled={disabled || sending}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              addFiles(files);
            }}
            className="sr-only"
            tabIndex={-1}
          />
          <button
            type="button"
            data-testid="comment-emoji"
            onClick={() => {
              setGifOpen(false);
              setEmojiOpen((o) => !o);
            }}
            disabled={disabled || sending}
            aria-label="Add emoji"
            aria-expanded={emojiOpen}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container disabled:opacity-60"
          >
            <Smile size={20} aria-hidden />
          </button>
          {gifEnabled && (
            <button
              type="button"
              data-testid="comment-gif"
              onClick={() => {
                setEmojiOpen(false);
                setGifOpen((o) => !o);
              }}
              disabled={disabled || sending}
              aria-label="Add a GIF or sticker"
              aria-expanded={gifOpen}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container disabled:opacity-60"
            >
              <Sticker size={20} aria-hidden />
            </button>
          )}
          {overLimit && (
            <span data-testid="comment-limit-hint" role="status" className="ml-auto text-[11px] text-error">
              {bodyPreview.length}/{MAX_COMMENT_BODY} — shorten text or remove media
            </span>
          )}
        </div>

        {attachNotice && (
          <p data-testid="comment-attach-notice" role="status" className="mt-1 text-[11px] text-on-surface-variant">
            {attachNotice}
          </p>
        )}
        {failed.length > 0 && (
          <p data-testid="comment-attach-error" role="alert" className="mt-1 text-[11px] text-error">
            {failed[0]?.error ?? "An attachment failed."} Retry or remove it to send.
          </p>
        )}

        {/* Attachment tiling: grid in display_order (tile position =
            display_order 1..4), each tile carrying its kind/provenance chip.
            Same previews, progress, retry, and remove controls as before. */}
        {attachments.length > 0 && (
          <div
            data-testid="comment-attachments"
            role="group"
            aria-label={`Attachments, ${attachments.length} of ${COMMENT_ATTACH_MAX}`}
            className="mt-1 grid grid-cols-4 gap-1.5"
          >
            {attachments.map((a, index) => {
              const source =
                a.kind === "gif" ? ("klipy" as const) : a.remoteUrl ? commentMediaProvenance(a.remoteUrl) : null;
              return (
              <figure
                key={a.id}
                data-testid={`comment-attachment-${a.id}`}
                data-status={a.status}
                className="relative w-full"
              >
                {a.kind === "video" && a.previewUrl !== "" ? (
                  <video
                    src={a.previewUrl}
                    muted
                    playsInline
                    preload="metadata"
                    aria-label={a.fileName}
                    className="h-16 w-full rounded-m3-xs border border-outline-variant object-cover"
                  />
                ) : a.previewUrl !== "" ? (
                  <img
                    src={a.previewUrl}
                    alt={a.fileName}
                    loading="lazy"
                    className="h-16 w-full rounded-m3-xs border border-outline-variant object-cover"
                  />
                ) : (
                  <span
                    role="img"
                    aria-label={a.fileName}
                    className="flex h-16 w-full items-center justify-center rounded-m3-xs border border-outline-variant bg-surface-container-low text-[10px] text-on-surface-variant"
                  >
                    {a.fileName}
                  </span>
                )}
                <span
                  data-testid={`comment-attachment-order-${a.id}`}
                  aria-hidden
                  className="pointer-events-none absolute left-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                >
                  {index + 1}
                </span>
                {source && (
                  <span
                    data-testid={`comment-attachment-source-${a.id}`}
                    data-provenance={source}
                    className="pointer-events-none absolute bottom-1 left-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                  >
                    {source === "klipy" ? "KLIPY" : "Storage"}
                  </span>
                )}
                {a.status === "uploading" && (
                  <span
                    data-testid={`comment-attachment-progress-${a.id}`}
                    role="progressbar"
                    aria-label={`Uploading ${a.fileName}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(a.progress * 100)}
                    className="absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-m3-xs bg-surface-container-high"
                  >
                    <span
                      className="block h-full bg-on-surface transition-[width]"
                      style={{ width: `${Math.max(8, Math.round(a.progress * 100))}%` }}
                    />
                  </span>
                )}
                {a.status === "failed" && (
                  <button
                    type="button"
                    data-testid={`comment-attachment-retry-${a.id}`}
                    onClick={() => retryAttachment(a)}
                    aria-label={`Retry attaching ${a.fileName}`}
                    className="absolute inset-x-0 bottom-0 flex min-h-[44px] items-center justify-center rounded-b-m3-xs bg-error-container text-[10px] font-semibold text-on-error-container"
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  data-testid={`comment-attachment-remove-${a.id}`}
                  onClick={() => void removeAttachment(a)}
                  aria-label={`Remove ${a.fileName}`}
                  className="absolute -right-2 -top-2 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-outline-variant bg-surface text-on-surface shadow"
                >
                  <X size={16} aria-hidden />
                </button>
              </figure>
              );
            })}
          </div>
        )}

        {emojiOpen && (
          <div
            data-testid="comment-emoji-panel"
            role="dialog"
            aria-label="Emoji picker"
            className="mt-1 rounded-m3-md border border-outline-variant bg-surface-container p-2 shadow-lg"
          >
            <div role="grid" aria-label="Emojis" className="grid max-h-48 grid-cols-8 gap-0.5 overflow-y-auto">
              {EMOJI_SET.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="gridcell"
                  data-testid={`comment-emoji-${emoji}`}
                  onClick={() => insertEmoji(emoji)}
                  aria-label={`Insert ${emoji}`}
                  className="flex min-h-[44px] min-w-[40px] items-center justify-center rounded-m3-sm text-xl hover:bg-surface-container-high"
                >
                  <span aria-hidden>{emoji}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {gifEnabled && gifOpen && (
          <div
            data-testid="comment-gif-panel"
            role="dialog"
            aria-label="GIF and sticker picker"
            className="mt-1 rounded-m3-md border border-outline-variant bg-surface-container p-2 shadow-lg"
          >
            <div role="tablist" aria-label="GIF or stickers" className="mb-1 flex gap-1">
              {(["gifs", "stickers"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={gifTab === tab}
                  data-testid={`comment-gif-tab-${tab}`}
                  onClick={() => setGifTab(tab)}
                  className={`min-h-[44px] rounded-full px-3 text-xs font-semibold ${
                    gifTab === tab ? "bg-on-surface text-surface" : "text-on-surface-variant"
                  }`}
                >
                  {tab === "gifs" ? "GIFs" : "Stickers"}
                </button>
              ))}
            </div>
            <input
              data-testid="comment-gif-search"
              value={gifQuery}
              onChange={(e) => setGifQuery(e.target.value)}
              placeholder={KLIPY_SEARCH_PLACEHOLDER}
              aria-label="Search GIFs and stickers"
              className="mb-1 w-full rounded-m3-sm border border-outline-variant bg-surface px-3 py-2 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
            />
            {gifLoading ? (
              <p role="status" className="px-1 py-3 text-xs text-on-surface-variant">
                Searching…
              </p>
            ) : gifResults.length === 0 ? (
              <p role="status" className="px-1 py-3 text-xs text-on-surface-variant">
                No results. Try another search.
              </p>
            ) : (
              <div className="grid max-h-56 grid-cols-3 gap-1 overflow-y-auto">
                {gifResults.map((item) => (
                  <button
                    key={`${item.kind}:${item.slug}`}
                    type="button"
                    data-testid={`comment-gif-result-${item.slug}`}
                    onClick={() => pickGif(item)}
                    aria-label={`Add ${item.title}`}
                    className="min-h-[44px] overflow-hidden rounded-m3-sm border border-outline-variant"
                  >
                    <img src={item.previewUrl} alt="" loading="lazy" className="h-20 w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
            <p className="mt-1 px-1 text-[10px] text-on-surface-variant">
              <a href={KLIPY_ATTRIBUTION_URL} target="_blank" rel="noreferrer" className="underline">
                {KLIPY_ATTRIBUTION}
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
