interface NewPostsPillProps {
  count: number;
  hasUpdates?: boolean;
  onTap: () => void;
}

/**
 * "N new posts" pill shown when the reader is scrolled down and new posts
 * arrived via realtime. Updates (edits/reactions) show an Updates label
 * instead of incrementing the new-post count. Tapping refreshes and
 * scrolls to top; scroll is never yanked.
 */
export function NewPostsPill({ count, hasUpdates, onTap }: NewPostsPillProps) {
  if (count <= 0 && !hasUpdates) return null;
  const label = count > 0 ? `${count} new post${count === 1 ? "" : "s"}` : "Updates";
  return (
    <div className="sticky top-2 z-10 flex justify-center px-4">
      <button
        type="button"
        onClick={onTap}
        className="rounded-full bg-on-surface px-4 py-2 text-sm font-medium text-surface shadow-lg"
        aria-label={`${label} — tap to refresh`}
      >
        {label}
      </button>
    </div>
  );
}