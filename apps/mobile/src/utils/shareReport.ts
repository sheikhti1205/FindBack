import { Capacitor } from "@capacitor/core";
import { reportLink } from "./reportLinks";

/** Canonical public URL, without feed filters or a comments anchor. */
export function reportUrl(postId: string): string {
  return reportLink(postId);
}

/** How the native system sheet behaved. */
export type NativeShareOutcome = "shared" | "dismissed" | "failed";

/** The native system sheet (the Capacitor plugin by default). */
export type NativeShare = (payload: { title: string; url: string }) => Promise<NativeShareOutcome>;

let nativeShareOverride: NativeShare | null = null;

/** Test seam: replaces the native system sheet. `null` restores the real one. */
export function __setNativeShare(seam: NativeShare | null): void {
  nativeShareOverride = seam;
}

/** Test seam: drops the native system sheet override. */
export function __resetNativeShare(): void {
  nativeShareOverride = null;
}

/**
 * The Android system share sheet through `@capacitor/share`.
 *
 * The plugin rejects with "Share canceled" when the user closes the sheet:
 * that is a cancellation, not a failure, and it must never be reported as
 * one. Any other rejection (a plugin that was never synced into the native
 * project, a denied intent) falls through to the web/clipboard path so the
 * link is never silently dropped.
 */
async function shareThroughNativeSheet(payload: {
  title: string;
  url: string;
}): Promise<NativeShareOutcome> {
  try {
    const { Share } = await import("@capacitor/share");
    await Share.share(payload);
    return "shared";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (message === "Share canceled" || message === "Share cancelled" || (error as DOMException)?.name === "AbortError") return "dismissed";
    return "failed";
  }
}

/**
 * The clipboard, when the platform exposes one. A refusal is NOT a copy:
 * the caller must offer a selectable field instead of claiming success.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The one share path: native system sheet → web share API → clipboard.
 *
 * Cancellation is not a failure; a failed sheet is not a dismissal. The
 * returned sentence is the consumer-facing outcome and is announced as-is.
 */
export async function shareReport(postId: string, title: string): Promise<string> {
  const url = reportUrl(postId);
  const native =
    nativeShareOverride ?? (Capacitor.isNativePlatform() ? shareThroughNativeSheet : null);
  if (native) {
    const outcome = await native({ title, url });
    if (outcome === "shared") return "Link shared.";
    if (outcome === "dismissed") return "Share dismissed.";
    // A failed native sheet is neither a success nor a dismissal: fall
    // through so the link still reaches the user.
  }
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ title, url });
      return "Link shared.";
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") return "Share dismissed.";
    }
  }
  if (await writeToClipboard(url)) return "Link copied to clipboard.";
  throw new Error("Sharing is not supported on this device.");
}

export type CopyLinkResult = { status: "copied" } | { status: "manual"; url: string };

/**
 * The one copy path. The link is the same public URL the share sends.
 *
 * "manual" means the platform exposed no working clipboard (an Android
 * WebView often does not): the caller shows the link in a selectable field
 * rather than claiming a copy that never happened.
 */
export async function copyReportLink(postId: string): Promise<CopyLinkResult> {
  const url = reportUrl(postId);
  if (await writeToClipboard(url)) return { status: "copied" };
  return { status: "manual", url };
}
