import { useState } from "react";
import { PrimaryNav } from "../../components/Shell";
import { resolveNavLayout } from "../../components/navLayout";
import { useWideViewport } from "../../components/responsive";
import { TabTapProvider } from "../../components/TabTap";
import { loadAppearance, type NavLayout } from "../../appearance";
import { FixtureFrame, FixtureSection, type FixtureVariant } from "../FixtureSection";

/**
 * Adaptive-navigation preflight (owner ruling 4(e)).
 *
 * The production navigation is rendered through `PrimaryNav` — the same owner,
 * the same destination list, the same active treatment and create action the
 * app uses — so a screenshot of this section is evidence about the real
 * component rather than a re-implementation. Only the surrounding two-column
 * frame is fixture scaffolding, and the pane below is labelled as a placeholder.
 *
 * Width comes from the real viewport (`useWideViewport`, the single breakpoint
 * owner), so resizing the browser at 600px flips the stored rail to the bottom
 * bar exactly as the shell does. The `small-width` frame is a 320px box inside
 * whatever viewport the reviewer has, so it explicitly resolves as compact —
 * that frame is the phone case, not the reviewer's window.
 */
/** The only variants this section renders: the nav has no data to vary. */
export const NAV_VARIANTS: FixtureVariant[] = ["normal", "large-text", "dark", "amoled", "small-width"];

/**
 * The navigation has no data, so loading/empty/error/long-content frames were
 * nine copies of one component (review n2). Only the variants that can change
 * its paint are rendered. A rail frame selects Notifications rather than Home
 * so a non-first destination is reviewed; the bottom bar keeps Home selected,
 * because a multi-word label in the bar's selected slot is clipped at 320 px
 * (a pre-existing bar limit this wave does not change).
 */
const railActivePath = "/notifications";

function LiveNavigationDemo({ variant }: { variant: FixtureVariant }) {
  const wideViewport = useWideViewport();
  // Real stored choice, read once: this is a static preflight surface and must
  // not rewrite the reader's preference while it renders.
  const [stored] = useState<NavLayout>(() => loadAppearance().navLayout);
  const layout = resolveNavLayout(
    stored,
    variant === "small-width" ? false : wideViewport,
  );
  const rail = layout === "rail";

  return (
    <div
      data-testid={`fixture-nav-demo-${variant}`}
      data-nav-layout={layout}
      data-nav-stored={stored}
    >
      <TabTapProvider>
        <div className={`flex min-h-[220px] w-full ${rail ? "flex-row" : "flex-col"}`}>
          {rail && <PrimaryNav layout="rail" liveBadge={false} activePath={rail ? railActivePath : "/"} layoutScope={variant} />}
          <p className="min-h-[96px] flex-1 p-4 text-sm text-on-surface-variant">
            Route content (placeholder)
          </p>
          {!rail && <PrimaryNav layout="bottom" liveBadge={false} activePath={rail ? railActivePath : "/"} layoutScope={variant} />}
        </div>
      </TabTapProvider>
    </div>
  );
}

export function NavigationFixtures() {
  return (
    <FixtureSection
      id="navigation"
      title="Navigation"
      description="The production primary navigation as a bottom bar or a side rail. Stored choice comes from Appearance; under 600px the bar always wins. Resize the viewport to review the breakpoint."
    >
      <div className="flex flex-col gap-4">
        {NAV_VARIANTS.map((variant) => (
          <div key={variant} className="-mx-4">
            <FixtureFrame section="navigation" variant={variant} geometry>
              <LiveNavigationDemo variant={variant} />
            </FixtureFrame>
          </div>
        ))}
      </div>
    </FixtureSection>
  );
}
