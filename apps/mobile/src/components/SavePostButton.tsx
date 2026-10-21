import { Bookmark } from "lucide-react";
import { announce } from "./LiveRegion";
import { useSavedReports } from "../hooks/useSavedReports";

/**
 * The Save (bookmark) control for a report.
 *
 * Sits in the post action row next to Like / Comments / Share and follows the
 * house action-button language (`.fb-report-action`): one compact target, an
 * icon, and a word.
 *
 * The saved state is NOT colour-only: the bookmark FILLS and the accessible
 * name changes ("Save report" → "Remove from saved reports"), with
 * `aria-pressed` telling assistive tech which state the control is in. In the
 * flat action row the WORD is hidden by the row's own CSS, so the filled icon
 * and `aria-pressed` are the indicators that actually reach the reader there;
 * the word is still there for every other layout.
 *
 * The control is deliberately quiet about WHERE the save lives. The device
 * list is written first and always; whether the ACCOUNT confirmed it is shown
 * on the Saved reports screen, which is where the reader asks that question.
 *
 * The button is NOT disabled while the account catches up: the device write
 * already happened, so a second tap is a real undo and must not be swallowed.
 * `aria-busy` tells assistive tech that the account is still catching up.
 *
 * Without an account there is nothing to save FOR, so the control is
 * disabled: a tap would be a no-op, and a no-op must never be announced as a
 * save. The announcement follows the outcome of the operation, not the state
 * the control happened to be in.
 */
export function SavePostButton({
  postId,
  size = 20,
  className = "",
  title,
}: {
  postId: string;
  size?: number;
  className?: string;
  /** Optional title snapshot for the saved list; the live title wins on the screen. */
  title?: string;
}) {
  const { isSaved, toggle, pending, hasAccount } = useSavedReports();
  const saved = isSaved(postId);

  return (
    <button
      type="button"
      data-testid="save-report-button"
      data-saved={saved ? "true" : "false"}
      aria-pressed={saved}
      aria-label={saved ? "Remove from saved reports" : "Save report"}
      aria-busy={pending}
      disabled={!hasAccount}
      onClick={async () => {
        // The device write happens inside the toggle, before its first await,
        // so the announcement follows a save that already happened — it never
        // waits for the account round trip to tell the reader it worked. The
        // answer decides whether anything happened at all.
        const written = await toggle(postId, title);
        announce(
          written
            ? saved
              ? "Removed from saved reports"
              : "Report saved"
            : "Couldn't save this report",
        );
      }}
      className={`fb-report-action min-h-[44px] min-w-[44px] gap-1 ${
        saved ? "bg-surface-container text-on-surface" : "text-on-surface-variant"
      } ${className}`}
    >
      <Bookmark size={size} aria-hidden fill={saved ? "currentColor" : "none"} />
      <span aria-hidden>{saved ? "Saved" : "Save"}</span>
    </button>
  );
}
