/** HashRouter report URL, without feed filters or a comments anchor. */
export function reportUrl(postId: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `/posts/${encodeURIComponent(postId)}`;
  return url.href;
}

/** Cancellation is not a failure; other share failures try the clipboard. */
export async function shareReport(postId: string, title: string): Promise<string> {
  const url = reportUrl(postId);
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title, url });
      return "Link shared.";
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") return "Share dismissed.";
    }
  }
  if (!navigator.clipboard?.writeText) throw new Error("Sharing is not supported on this device.");
  await navigator.clipboard.writeText(url);
  return "Link copied to clipboard.";
}
