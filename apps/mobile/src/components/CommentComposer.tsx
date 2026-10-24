import { useEffect, useRef, useState } from "react";
import { FileText, Film, ImageOff, ImagePlus, Search, SendHorizonal, Sticker, X } from "lucide-react";
import { CommentReportPicker } from "./CommentReportPicker";
import { UserAvatar } from "./UserAvatar";
import { MentionAutocomplete, type MentionCandidate } from "./MentionAutocomplete";
import {
  COMMENT_ATTACH_ACCEPT,
  COMMENT_ATTACH_MAX,
  COMMENT_REPORTS_ENABLED,
  createCommentAttachment,
  createKlipyAttachment,
  importCommentPhotoFromNativeUri,
  isNativeCommentPhotoIntakeAvailable,
  removeCommentAttachment,
  uploadCommentAttachment,
  validateAttachableFile,
  type CommentAttachment,
} from "../services/commentAttachments";
import {
  KLIPY_ATTRIBUTION,
  KLIPY_ATTRIBUTION_URL,
  KLIPY_SEARCH_PLACEHOLDER,
  createKlipySearchController,
  isKlipyEnabled,
  klipyCustomerId,
  searchKlipyGifs,
  searchKlipyStickers,
  trackKlipyShare,
  type KlipyItem,
  type KlipyKind,
  type KlipySearchController,
  type KlipySearchState,
} from "../services/klipy";
import {
  appendBodyMedia,
  bodyHasInlineData,
  commentMediaProvenance,
  MAX_COMMENT_BODY,
} from "../services/commentBodyMedia";
import type { CommentAttachmentDescriptor } from "../services/posts";
import { ApiError } from "../services/session";
import { friendlyError } from "../utils/friendlyErrors";
import { interactionRefusalCopy } from "../utils/interactionRefusal";

/**
 * C3 compact social comment composer: avatar + expandable input + send icon.
 *
 * - `@` mentions through the shared `MentionAutocomplete` (ranked
 *   participants > owner > server fallback, keyboard nav, caret insertion),
 *   anchored to the composer, keyboard/touch safe.
 * - No emoji affordance (packet `08` §5): the custom catalogue and its native
 *   bottom-sheet bridge were removed outright rather than reimplemented — the
 *   platform keyboard's own emoji entry in the text field is the remaining
 *   path, and the composer owns no emoji set.
 * - Photo attach only (packet `08` §7): new video intake is stopped at the
 *   picker's accept list and the client gate, while every stored video row
 *   keeps rendering. On Android photos come through the canonical native
 *   intake (`FindbackMedia` multi-pick + per-URI import, FBX-038); every other
 *   runtime uses the deliberate file-input path whose preview is a `blob:`
 *   object-URI and whose upload streams bytes to Storage under the caller's
 *   own folder (same RLS path as report photos) with progress / retry /
 *   remove and the shared `COMMENT_ATTACH_MAX` cap. The comment body carries
 *   only `https://` remote URLs — never base64.
 * - GIF/Sticker through the Klipy adapter behind the `VITE_KLIPY_API_KEY`
 *   config flag: the search controller owns debounce, latest-request-wins,
 *   stale-request cancellation, trending-on-empty, pagination, and
 *   loading/empty/error states; stable customer_id, high content filter,
 *   "Search KLIPY" placeholder, provider URLs/data preserved and loaded
 *   directly, share-tracking only after the comment posts, "Powered by
 *   KLIPY" attribution. The control is hidden entirely when the key is
 *   absent. Only live-key verification stays deferred (FBX-015).
 */

/**
 * Packet `08` §21 failure copy. The consumer sentence is fixed — the raw
 * mapper message is never shown (it can carry provider/transport text). An
 * offline device or an expired session is the one case where a plain "try
 * again" would be a lie, so the sentence gains that single instruction.
 *
 * The interaction-limit guard's refusals are the other case, and they get their
 * own sentence from the shared vocabulary instead of the fixed one: the standing
 * refusal (a zero limit) must not be answered with an invitation to try again,
 * and a spent day is not a transport failure. This is R3-delta's N-4.
 */
function commentSendFailureCopy(err: unknown, hasReport: boolean): string {
  // P0002 also names a missing parent. Never ask a text-only sender to remove
  // a reference they do not have. With a staged reference retain §13.7's copy.
  if (hasReport && err instanceof ApiError && err.code === "P0002") {
    return "Report unavailable — remove the reference to post your comment.";
  }
  const refusal = interactionRefusalCopy(err);
  if (refusal) return refusal;
  switch (friendlyError(err).code) {
    case "OFFLINE":
      return "Couldn't post your comment. Check your connection and try again.";
    case "AUTH":
      return "Couldn't post your comment. Your session expired. Please sign in again.";
    default:
      return "Couldn't post your comment. Try again.";
  }
}

/** Packet `08` §21 upload copy; the strip appends "Retry or remove it to send." */
function commentUploadFailureCopy(err: unknown): string {
  return friendlyError(err).code === "OFFLINE"
    ? "Couldn't upload this photo. Check your connection and try again."
    : "Couldn't upload this photo.";
}

export interface CommentComposerProps {  postId: string;
  replyToUsername?: string | null;
  currentUser?: { id?: string | null; username?: string | null; avatarUrl?: string | null } | null;
  participants: MentionCandidate[];
  owner?: MentionCandidate | null;
  disabled?: boolean;
  /**
   * Parent writes the comment (addComment + list append). May throw.
   * Body carries text + `https://` media lines (legacy readers); the
   * optional ordered descriptors feed the atomic
   * `findback_add_comment_with_attachments` RPC (FB-AUD-02). Body-only
   * callers stay valid — the second arg is optional.
   */
  onSubmit: (body: string, attachments?: CommentAttachmentDescriptor[]) => Promise<void>;
  /** Parent surfaces failures inline (actionError + announce pattern). */
  onError: (message: string) => void;
  /** Parent clears reply affordances after a successful post. */
  onSent?: () => void;
}

/**
 * Map staged composer entries to ordered RPC descriptors in tile order
 * (FB-AUD-02). Only `uploaded` entries with an `https://` remote URL travel
 * — pending/failed entries never reach the RPC (send stays disabled until
 * they resolve). `blob:` previews stay local and are never sent (the RPC
 * requires https). A Klipy sticker pick (local kind `gif` with `klipyKind:
 * "stickers"`) maps to the RPC `sticker` kind.
 *
 * Lives beside the composer (not in services/posts) so screens that mock
 * the posts service keep a working composer: the service only forwards
 * descriptors opaquely, while PostDetail imports just the descriptor type.
 */
type StagedReportAttachment = {
  id: string;
  kind: "report";
  status: "uploaded";
  reportPostId: string;
  title: string;
};
type ComposerAttachment = CommentAttachment | StagedReportAttachment;

function attachmentReady(a: ComposerAttachment): boolean {
  return a.status === "uploaded" && (a.kind === "report"
    ? Boolean(a.reportPostId)
    : typeof a.remoteUrl === "string" && a.remoteUrl.startsWith("https://"));
}

export function toCommentAttachmentDescriptors(
  attachments: readonly ComposerAttachment[],
): CommentAttachmentDescriptor[] {
  return attachments
    .filter(attachmentReady)
    .map((a, index) => {
      // Deliberately construct only these keys; report references have no bytes,
      // URLs or provenance, even if an upstream object accidentally carries them.
      if (a.kind === "report") return {
        kind: "report", display_order: index + 1, report_post_id: a.reportPostId,
      };
      const descriptor: CommentAttachmentDescriptor = {
        kind: a.kind === "gif" && a.klipyKind === "stickers" ? "sticker" : a.kind,
        display_order: index + 1,
        remote_url: a.remoteUrl as string,
      };
      if (a.objectKey) descriptor.storage_key = a.objectKey;
      if (a.klipySlug) descriptor.klipy_slug = a.klipySlug;
      if (a.klipyKind) descriptor.klipy_kind = a.klipyKind;
      if (a.previewUrl.startsWith("https://")) descriptor.preview_url = a.previewUrl;
      if (a.mimeType) descriptor.mime_type = a.mimeType;
      if (a.fileName) descriptor.file_name = a.fileName;
      return descriptor;
    });
}

type GifTab = KlipyKind;

// Waterfall tile heights for the loading skeleton (varied, like real results).
const GIF_SKELETON_HEIGHTS = [112, 84, 96, 72, 104, 88];

/**
 * CSS aspect-ratio for a picker tile, derived from the provider's media
 * dimensions so the collage waterfalls naturally. Clamped so a malformed
 * payload can never create an absurdly tall or wide tile; stickers (often
 * square transparent PNG/WebP) fall back to 1:1.
 */
function klipyTileAspect(item: KlipyItem): string {
  const w = item.width ?? 0;
  const h = item.height ?? 0;
  if (w <= 0 || h <= 0) return "1 / 1";
  const ratio = Math.min(2, Math.max(0.5, w / h));
  return `${ratio} / 1`;
}

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
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [reportOpen, setReportOpen] = useState(false);
  const reportTriggerRef = useRef<HTMLButtonElement>(null);
  const [sending, setSending] = useState(false);
  const [preparingPhotos, setPreparingPhotos] = useState(false);
  const photoIntakeRef = useRef(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [gifTab, setGifTab] = useState<GifTab>("gifs");
  const [gifQuery, setGifQuery] = useState("");
  const [gifState, setGifState] = useState<KlipySearchState>({
    status: "idle",
    tab: "gifs",
    query: "",
    items: [],
    page: 1,
    error: null,
  });
  const gifResults: KlipyItem[] = gifState.items;
  const gifLoading = gifState.status === "loading";
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const filesRef = useRef(new Map<string, File>());
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const submittedRef = useRef(false);
  const klipyCtl = useRef<KlipySearchController | null>(null);
  const gifEnabled = isKlipyEnabled();

  function klipyController(): KlipySearchController {
    if (!klipyCtl.current) {
      klipyCtl.current = createKlipySearchController({
        customerId: () => klipyCustomerId(currentUser?.id),
        // Passed explicitly (not via the adapter default) so the picker's
        // search seam stays mockable in tests and swappable in product.
        searchGifs: (...args) => searchKlipyGifs(...args),
        searchStickers: (...args) => searchKlipyStickers(...args),
        onState: (next) => setGifState(next),
      });
    }
    return klipyCtl.current;
  }

  // The controller outlives the panel: cancel in-flight work on unmount.
  useEffect(() => () => klipyCtl.current?.dispose(), []);

  // Mirror staged entries for the abandon sweep below (an unmount cleanup
  // closure cannot read state at unmount time).
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // FB-AUD-04: pick → upload completes → leave page without submit must not
  // orphan the Storage object (no typed row exists yet, so no server
  // cleanup can find it). Best-effort fire-and-forget sweep on unmount,
  // reusing the same helper explicit Remove uses (`removeCommentAttachment`
  // only deletes local-upload keys and never throws). Row-referenced keys
  // after a successful submit are never swept: success sets the submitted
  // flag and clears the strip, so the sweep sees nothing to delete. No new
  // endpoint surface; submit/success-path semantics unchanged.
  useEffect(
    () => () => {
      if (submittedRef.current) return;
      const staged = attachmentsRef.current.filter(
        (a): a is CommentAttachment => a.kind !== "report" && a.status === "uploaded" && Boolean(a.objectKey && a.remoteUrl),
      );
      for (const entry of staged) {
        // Fire-and-forget: never blocks unmount, never logs at error level
        // (nothing is logged at all); the rejection sink keeps even a
        // future thrower of the helper silent.
        void removeCommentAttachment(entry).then(undefined, () => undefined);
      }
    },
    [],
  );

  // Auto-grow 1→5 lines from scrollHeight (never animated per keystroke).
  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Short guidance fits one row at large text; only real drafts auto-grow.
    if (!text) {
      el.style.overflowY = "hidden";
      return;
    }
    if (el.scrollHeight <= 0) return;
    const style = window.getComputedStyle(el);
    const line = Number.parseFloat(style.lineHeight) || 24;
    const pad =
      (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const cap = line * 5 + pad;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    el.style.overflowY = el.scrollHeight > cap ? "auto" : "hidden";
  }, [text]);

  // Klipy picker search, owned by the adapter controller: debounced,
  // latest-request-wins, stale requests cancelled, trending while the query
  // is empty. Fires on open, tab, and keystrokes; cancels on close.
  useEffect(() => {
    if (!gifOpen || !gifEnabled) {
      klipyCtl.current?.cancel();
      return;
    }
    klipyController().search(gifQuery, gifTab);
    // The controller instance is stable for the component lifetime; the
    // signed-in user id is read through the creation thunk, so it is not a
    // dependency here.
  }, [gifOpen, gifEnabled, gifTab, gifQuery]);

  function retryGifSearch() {
    klipyController().search(gifQuery, gifTab);
  }

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

  function patchAttachment(id: string, patch: Partial<CommentAttachment>) {
    setAttachments((prev) => prev.map((a) => (a.kind !== "report" && a.id === id ? { ...a, ...patch } : a)));
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
        error: commentUploadFailureCopy(err),
      });
    }
  }

  function addFiles(fileList: FileList | File[]) {
    if (photoIntakeRef.current) return;
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

  // FBX-038: photos prefer the canonical native intake on Android
  // (permissionless multi-pick, per-URI preparation so one bad item never
  // discards its siblings, cancel is a silent no-op). Every other runtime
  // uses the deliberate file-input streaming path below. The bridge
  // is dynamically imported so the composer load graph never touches the
  // plugin registry (see commentAttachments).
  async function pickNativePhotos() {
    const room = COMMENT_ATTACH_MAX - attachments.length;
    if (room <= 0) {
      setAttachNotice(`Comments hold up to ${COMMENT_ATTACH_MAX} attachments. Remove one first.`);
      return;
    }
    setAttachNotice(null);
    let uris: string[] | null;
    try {
      const { chooseNativeImages } = await import("../services/media/nativeMedia");
      uris = await chooseNativeImages({ source: "photos", limit: room });
    } catch (err) {
      // Broken bridge must not strand the user: fall back to the file input.
      setAttachNotice(friendlyError(err).message);
      fileInputRef.current?.click();
      return;
    }
    if (!uris || uris.length === 0) return;
    let failed = 0;
    for (const uri of uris.slice(0, room)) {
      try {
        const { entry, file } = await importCommentPhotoFromNativeUri(uri);
        filesRef.current.set(entry.id, file);
        setAttachments((prev) => [...prev, entry]);
        void startUpload(entry, file);
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      setAttachNotice(
        failed >= uris.length
          ? "Those photos couldn't be prepared. Try them again or pick different ones."
          : "Some photos couldn't be prepared. The rest are uploading.",
      );
    }
  }

  async function handleAttachClick() {
    if (disabled || sending || photoIntakeRef.current) return;
    // Reserve the tray during native chooser/preparation, before any awaits.
    // Otherwise a report/GIF can take a slot promised to a pending photo.
    photoIntakeRef.current = true;
    setPreparingPhotos(true);
    setReportOpen(false);
    setGifOpen(false);
    try {
      if (await isNativeCommentPhotoIntakeAvailable()) {
        await pickNativePhotos();
      } else {
        fileInputRef.current?.click();
      }
    } finally {
      photoIntakeRef.current = false;
      setPreparingPhotos(false);
    }
  }

  async function removeAttachment(entry: ComposerAttachment) {
    if (disabled || sending) return;
    filesRef.current.delete(entry.id);
    setAttachments((prev) => prev.filter((a) => a.id !== entry.id));
    if (entry.kind !== "report") await removeCommentAttachment(entry);
    else fieldRef.current?.focus();
  }

  function closeReportPicker() {
    setReportOpen(false);
    reportTriggerRef.current?.focus();
  }

  function pickReport(report: { id: string; title: string }) {
    if (photoIntakeRef.current) return;
    setAttachments((prev) => {
      if (prev.length >= COMMENT_ATTACH_MAX || prev.some((a) => a.kind === "report" && a.reportPostId === report.id)) return prev;
      return [...prev, { id: `report-${report.id}`, kind: "report", status: "uploaded", reportPostId: report.id, title: report.title }];
    });
    closeReportPicker();
    fieldRef.current?.focus();
  }

  function pickGif(item: KlipyItem) {
    if (photoIntakeRef.current) return;
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
  const failed = attachments.filter((a): a is CommentAttachment => a.kind !== "report" && a.status === "failed");
  const readyToPost = attachments.filter(attachmentReady);
  const readyMedia = readyToPost.filter((a): a is CommentAttachment => a.kind !== "report");
  const pendingLocal = attachments.filter((a) => a.status === "ready" || a.status === "uploading");
  const bodyPreview = appendBodyMedia(
    text,
    readyMedia.map((a) => ({ kind: a.kind, remoteUrl: a.remoteUrl as string })),
  );
  const overLimit = bodyPreview.length > MAX_COMMENT_BODY;
  const sendDisabled =
    disabled ||
    sending ||
    preparingPhotos ||
    uploading ||
    pendingLocal.length > 0 ||
    failed.length > 0 ||
    overLimit ||
    attachments.length > COMMENT_ATTACH_MAX ||
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
      readyMedia.map((a) => ({ kind: a.kind, remoteUrl: a.remoteUrl as string })),
    );
    const descriptors = toCommentAttachmentDescriptors(readyToPost);
    if ((body.trim() === "" && descriptors.length === 0) || body.length > MAX_COMMENT_BODY) return;
    // Snapshot Klipy picks for post-only share-tracking.
    const shares = readyMedia
      .filter((a) => a.kind === "gif" && a.klipySlug)
      .map((a) => ({ kind: a.klipyKind ?? ("gifs" as const), slug: a.klipySlug as string }));
    setSending(true);
    setReportOpen(false);
    try {
      // Ordered descriptors for the atomic RPC travel alongside the body
      // (the body keeps its https media lines for legacy readers). A
      // body-only send stays a single-arg call so existing callers observe
      // no change.
      if (descriptors.length > 0) {
        await onSubmit(body, descriptors);
      } else {
        await onSubmit(body);
      }
      // Share-tracking only on post: the comment exists server-side now.
      const customerId = klipyCustomerId(currentUser?.id);
      for (const s of shares) {
        void trackKlipyShare(s.kind, s.slug, customerId);
      }
      // Mark committed BEFORE clearing: the abandon sweep must never touch
      // keys that are now row-referenced server-side.
      submittedRef.current = true;
      for (const a of attachments) {
        if (a.kind !== "report" && a.previewUrl.startsWith("blob:")) {
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
      onError(commentSendFailureCopy(err, descriptors.some((a) => a.kind === "report")));
    } finally {
      setSending(false);
    }
  }

  // The adjacent reply context names the target. Keep the field guidance short
  // enough to remain readable at large text; its accessible name stays full.
  const placeholder = replyToUsername ? "Reply…" : "Write…";

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
            className="flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-full bg-on-surface text-surface disabled:opacity-40"
          >
            <SendHorizonal size={18} aria-hidden />
          </button>
        </div>

        {/* Accessory row: photo, report and GIF live under the input so the
            text field keeps the full usable width at 320dp. */}
        <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            data-testid="comment-attach"
            onClick={() => void handleAttachClick()}
            disabled={disabled || sending || preparingPhotos}
            aria-label="Attach a photo"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container disabled:opacity-60"
          >
            <ImagePlus size={20} aria-hidden />
          </button>
          {COMMENT_REPORTS_ENABLED && (
            <button ref={reportTriggerRef} type="button" aria-label="Attach a report" aria-expanded={reportOpen}
              disabled={disabled || sending || preparingPhotos || attachments.length >= COMMENT_ATTACH_MAX}
              onClick={() => { setReportOpen((open) => !open); setGifOpen(false); }}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-on-surface">
              <FileText size={20} aria-hidden />
            </button>
          )}
          <input
            ref={fileInputRef}
            data-testid="comment-file-input"
            type="file"
            accept={COMMENT_ATTACH_ACCEPT}
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
          {gifEnabled && (
            <button
              type="button"
              data-testid="comment-gif"
              onClick={() => {
                setGifOpen((o) => !o);
                setReportOpen(false);
              }}
              disabled={disabled || sending || preparingPhotos}
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

        {COMMENT_REPORTS_ENABLED && reportOpen && (
          <CommentReportPicker disabled={disabled || sending || attachments.length >= COMMENT_ATTACH_MAX}
            onPick={pickReport} onClose={closeReportPicker} />
        )}

        {preparingPhotos && <p role="status" className="mt-1 text-xs text-on-surface-variant">Preparing photos…</p>}
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
              if (a.kind === "report") return (
                <div key={a.id} className="col-span-4 flex min-w-0 items-center gap-2 border-b border-outline-variant py-1 text-on-surface">
                  <FileText size={16} aria-hidden className="shrink-0" />
                  <span className="min-w-0 flex-1 break-words text-xs">{a.title}</span>
                  <button type="button" aria-label={`Remove report: ${a.title}`} disabled={disabled || sending}
                    onClick={() => void removeAttachment(a)}
                    className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full hover:bg-surface-container disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-on-surface">
                    <X size={16} aria-hidden />
                  </button>
                </div>
              );
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
                  disabled={disabled || sending}
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

        {gifEnabled && gifOpen && (
          <div
            data-testid="comment-gif-panel"
            role="dialog"
            aria-label="GIF and sticker picker"
            className="mt-1 overflow-hidden rounded-m3-lg border border-outline-variant bg-surface shadow-lg"
          >
            {/* Search first, the way messaging GIF pickers open. */}
            <div className="px-2 pt-2">
              <div className="relative">
                <Search
                  size={16}
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
                />
                <input
                  data-testid="comment-gif-search"
                  value={gifQuery}
                  onChange={(e) => setGifQuery(e.target.value)}
                  placeholder={KLIPY_SEARCH_PLACEHOLDER}
                  aria-label="Search GIFs and stickers"
                  enterKeyHint="search"
                  className="min-h-[44px] w-full rounded-full border border-outline-variant bg-surface-container-low py-2 pl-9 pr-11 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
                />
                {gifQuery !== "" && (
                  <button
                    type="button"
                    data-testid="comment-gif-search-clear"
                    onClick={() => setGifQuery("")}
                    aria-label="Clear search"
                    className="absolute right-0.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-high"
                  >
                    <X size={14} aria-hidden />
                  </button>
                )}
              </div>
            </div>

            {/* Compact segmented tabs. */}
            <div role="tablist" aria-label="GIF or stickers" className="flex gap-1 px-2 pt-2">
              {(["gifs", "stickers"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={gifTab === tab}
                  data-testid={`comment-gif-tab-${tab}`}
                  onClick={() => setGifTab(tab)}
                  className={`flex min-h-[44px] items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors ${
                    gifTab === tab
                      ? "bg-on-surface text-surface"
                      : "text-on-surface-variant hover:bg-surface-container"
                  }`}
                >
                  {tab === "gifs" ? <Film size={14} aria-hidden /> : <Sticker size={14} aria-hidden />}
                  {tab === "gifs" ? "GIFs" : "Stickers"}
                </button>
              ))}
            </div>

            <div className="mt-2 max-h-72 overflow-y-auto px-2 pb-2">
              {gifState.status === "error" ? (
                <div role="alert" className="flex flex-col items-center gap-2 px-2 py-6 text-center">
                  <ImageOff size={20} aria-hidden className="text-on-surface-variant" />
                  <p className="text-xs text-error">{gifState.error ?? "Couldn't load GIFs."}</p>
                  <button
                    type="button"
                    data-testid="comment-gif-retry"
                    onClick={retryGifSearch}
                    className="mt-1 min-h-[44px] rounded-full bg-surface-container-high px-4 text-xs font-semibold text-on-surface"
                  >
                    Try again
                  </button>
                </div>
              ) : gifLoading ? (
                <div>
                  <p role="status" className="sr-only">
                    Searching GIFs
                  </p>
                  <div className="columns-2 gap-1.5" aria-hidden>
                    {GIF_SKELETON_HEIGHTS.map((height, i) => (
                      <span
                        key={i}
                        className="mb-1.5 block w-full animate-pulse break-inside-avoid rounded-m3-sm bg-surface-container-high"
                        style={{ height }}
                      />
                    ))}
                  </div>
                </div>
              ) : gifResults.length === 0 ? (
                <div role="status" className="flex flex-col items-center gap-2 px-2 py-8 text-center">
                  <ImageOff size={20} aria-hidden className="text-on-surface-variant" />
                  <p className="text-xs text-on-surface-variant">No results. Try another search.</p>
                </div>
              ) : (
                <div>
                  {gifQuery.trim() === "" && (
                    <p
                      data-testid="comment-gif-trending"
                      className="px-1 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant"
                    >
                      Trending now
                    </p>
                  )}
                  {/* Two-column waterfall: natural aspect ratios, seamless
                      tiles, tap inserts immediately (no confirm step). */}
                  <div className="columns-2 gap-1.5">
                    {gifResults.map((item) => (
                      <button
                        key={`${item.kind}:${item.slug}`}
                        type="button"
                        data-testid={`comment-gif-result-${item.slug}`}
                        onClick={() => pickGif(item)}
                        aria-label={`Add ${item.title}`}
                        className="group relative mb-1.5 block w-full break-inside-avoid overflow-hidden rounded-m3-sm bg-surface-container-low focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-surface"
                        style={{ aspectRatio: klipyTileAspect(item) }}
                      >
                        <img
                          src={item.previewUrl}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03] group-active:scale-[0.98] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                        />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <p className="border-t border-outline-variant px-3 py-1.5 text-[10px] text-on-surface-variant">
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
