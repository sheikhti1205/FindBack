import { useState } from "react";
import { Share2 } from "lucide-react";
import { shareReport } from "../utils/shareReport";
import { announce } from "./LiveRegion";

export function ReportShareButton({ postId, title }: { postId: string; title: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-label="Share report"
        aria-busy={busy}
        disabled={busy}
        className="fb-report-action w-full"
        onClick={async () => {
          setBusy(true);
          setError(false);
          try {
            announce(await shareReport(postId, title));
          } catch {
            setError(true);
            announce("Couldn't share this report. Please try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Share2 size={18} aria-hidden /><span>Share</span>
      </button>
      {error && <p role="alert" className="mt-1 text-xs text-error">Couldn't share — try again</p>}
    </div>
  );
}
