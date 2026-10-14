import type { CSSProperties } from "react";
import type { CanonicalReactionKind } from "@findback/shared";
import { CANONICAL_REACTION_KINDS } from "@findback/shared";
import { REACTION_ART_MARK, ReactionArt } from "./ReactionArt";

/**
 * System-emoji reaction fixture: all 4 canonical reaction emoji × every
 * production size × light / dark / true-black — no device needed.
 *
 * Sizes: 15 (comment tiny), 16 (feed-summary stack), 18 (feed action idle),
 * 20 (detail action selected), 30 (tray pill large + notification/inbox).
 *
 * Review: render `<ReactionArtFixture />` on any host page. 320dp note below
 * is part of the fixture — the row + tray must fit 320px without clipping
 * (the tray itself portals + flips/shifts; see `ReactionTray`).
 */

const SIZES = [15, 16, 18, 20, 30] as const;

const THEMES: Array<{ id: string; label: string; style: CSSProperties }> = [
  { id: "light", label: "Light", style: { backgroundColor: "#ffffff", color: "#1a1a1a" } },
  { id: "dark", label: "Dark", style: { backgroundColor: "#1a1c1e", color: "#e8eaed" } },
  { id: "true-black", label: "True black (AMOLED)", style: { backgroundColor: "#000000", color: "#e8eaed" } },
];

const KIND_BLURB: Record<CanonicalReactionKind, string> = {
  LOVE: "Red heart system emoji — affectionate.",
  HELPFUL: "Light-bulb system emoji — useful idea.",
  SUPPORT: "Handshake system emoji — care/solidarity.",
  WOW: "Surprised-face system emoji — instant surprise read.",
};

export function ReactionArtFixture() {
  return (
    <div data-testid="reaction-art-fixture" style={{ fontFamily: "system-ui, sans-serif" }}>
      <p data-testid="reaction-fixture-note">
        FindBack system-emoji reactions (family system-emoji) — 4 kinds × 5 sizes × 3 themes.
        320dp check: the widest row below is capped at 320px; the tray portals out of clipping ancestors
        and flips/shifts inside the viewport, so nothing may clip or scroll sideways at 320dp.
      </p>
      {THEMES.map((theme) => (
        <section
          key={theme.id}
          data-testid={`reaction-fixture-theme-${theme.id}`}
          style={{ ...theme.style, padding: 12, borderRadius: 8, marginBottom: 12 }}
        >
          <h3 style={{ margin: "0 0 8px" }}>{theme.label}</h3>
          <div style={{ display: "grid", gap: 10 }}>
            {CANONICAL_REACTION_KINDS.map((kind) => (
              <div
                key={kind}
                data-testid={`reaction-fixture-row-${theme.id}-${kind}`}
                title={KIND_BLURB[kind]}
                style={{ display: "flex", alignItems: "center", gap: 12 }}
              >
                <span style={{ minWidth: 120, fontSize: 12 }}>
                  {kind} ({REACTION_ART_MARK[kind]})
                </span>
                {SIZES.map((size) => (
                  <span
                    key={size}
                    data-testid={`reaction-fixture-cell-${theme.id}-${kind}-${size}`}
                    title={`${kind} @ ${size}px`}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    <ReactionArt kind={kind} size={size} />
                    <span style={{ fontSize: 10, opacity: 0.7 }}>{size}</span>
                  </span>
                ))}
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <ReactionArt kind={kind} size={18} filled={false} />
                  <span style={{ fontSize: 10, opacity: 0.7 }}>muted</span>
                </span>
              </div>
            ))}
          </div>
          <div
            data-testid={`reaction-fixture-320-${theme.id}`}
            style={{ maxWidth: 320, overflowX: "clip", marginTop: 10, borderTop: "1px dashed currentColor" }}
          >
            <p style={{ fontSize: 12 }}>320dp row: all four arts at tray size must sit side-by-side.</p>
            <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
              {CANONICAL_REACTION_KINDS.map((kind) => (
                <span
                  key={kind}
                  style={{
                    display: "inline-flex",
                    minWidth: 44,
                    minHeight: 44,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <ReactionArt kind={kind} size={30} />
                </span>
              ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
