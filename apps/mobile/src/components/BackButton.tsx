import { useNavigate } from "react-router";
import { ArrowLeft } from "lucide-react";

interface BackButtonProps {
  /** Fallback destination when there is no history to go back to. */
  fallbackTo: string;
  /** Accessible label, e.g. "Back to feed". */
  label: string;
}

/**
 * History-aware back: navigates back when history exists, otherwise falls
 * back to a safe destination. Visible arrow button for secondary screens.
 */
export function BackButton({ fallbackTo, label }: BackButtonProps) {
  const navigate = useNavigate();

  function goBack() {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(fallbackTo, { replace: true });
    }
  }

  return (
    <button
      type="button"
      onClick={goBack}
      aria-label={label}
      className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-m3-xs text-on-surface hover:bg-surface-container"
    >
      <ArrowLeft size={20} aria-hidden />
    </button>
  );
}