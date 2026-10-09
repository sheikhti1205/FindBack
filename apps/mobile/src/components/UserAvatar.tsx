import { useState } from "react";
import { initialsFor } from "./ProfileHero";

export interface UserAvatarProps {
  avatarUrl?: string | null;
  /** Username seed for initials. Blank/absent falls back to a generic glyph. */
  username?: string | null;
  /** Rendered square size in CSS pixels. */
  size?: number;
  className?: string;
}

/** Neutral person glyph used when there is neither an image nor a username. */
function GenericAvatarGlyph({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={Math.round(size * 0.6)}
      height={Math.round(size * 0.6)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
    </svg>
  );
}

/**
 * Canonical avatar. Resolves in order: remote image -> initials -> generic
 * glyph. A failed image load drops to the next tier, so a broken-image icon is
 * never shown. Decorative by default (`aria-hidden`) because the user's name is
 * rendered adjacent to every call site; pass a `className` to restyle.
 */
export function UserAvatar({ avatarUrl, username, size = 40, className = "" }: UserAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const name = (username ?? "").trim();
  const showImage = Boolean(avatarUrl) && !imageFailed;

  return (
    <span
      aria-hidden="true"
      data-testid="user-avatar"
      className={`flex flex-none items-center justify-center overflow-hidden rounded-full bg-surface-container text-on-surface ${className}`}
      style={{ width: size, height: size }}
    >
      {showImage ? (
        <img
          src={avatarUrl as string}
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : name ? (
        <span
          className="font-semibold leading-none"
          style={{ fontSize: Math.max(10, Math.round(size * 0.4)) }}
        >
          {initialsFor(name)}
        </span>
      ) : (
        <GenericAvatarGlyph size={size} />
      )}
    </span>
  );
}
