interface NewPostsPillProps {
  count: number;
  onTap: () => void;
}

/**
 * "N new posts" pill shown when the reader is scrolled down and new posts
 * arrived via realtime. Tapping refreshes and scrolls to top.
 */
export function NewPostsPill({ count, onTap }: NewPostsPillProps) {
  if (count <= 0) return null;
  return (
    <div className="sticky top-2 z-10 flex justify-center px-4">
      <button
        type="button"
        onClick={onTap}
        className="rounded-full bg-on-surface px-4 py-2 text-sm font-medium text-surface shadow-lg"
        aria-label={`${count} new post${count === 1 ? "" : "s"} — tap to refresh`}
      >
        {count} new post{count === 1 ? "" : "s"}
      </button>
    </div>
  );
}