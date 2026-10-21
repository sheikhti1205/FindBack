import type { PostItem } from "@findback/shared";
import { BlockedByViewerShield } from "../../components/BlockedByViewerShield";
import { PostList } from "../../components/PostList";
import { SettingsGroup, SettingsRow } from "../../components/settings";
import { FixtureFrame, FixtureSection } from "../FixtureSection";
import { makePost } from "../posts";

/**
 * CF-060 R10 — the O5 shield, rendered from production mounts.
 *
 * What these frames are, honestly:
 * - **Feed frame** mounts the production `PostList` (the real card factory), so
 *   the shield's position relative to the card's wrapping link is the shipped
 *   structure, not a lookalike.
 * - **Profile frame** mounts the production `SettingsRow` inside the shield —
 *   the exact construction `PublicProfile` uses.
 * - **Comment frame** reproduces the comment-content region that `PostDetail`
 *   wraps (avatar + username row, body, actions) inside the shield; the reply
 *   below is deliberately outside it, which is the invariant under review. The
 *   production mount itself is proven by `PostDetail.test.tsx`, not by this
 *   frame — a frame cannot prove which component rendered it.
 * - **Detail frame** shows the shielded report region with a comment block left
 *   operable beneath it, the boundary the accepted design requires.
 *
 * Reveal is per row, so a revealed frame and a concealed frame are the same
 * DOM with one state change — both are shown so the reviewer can compare the
 * layout before and after without a jump.
 */

const flagged: PostItem = makePost("r10-blocked", {
  blockedAuthor: true,
  title: "Black canvas backpack",
  description: "Lost near the central library steps on Tuesday afternoon.",
  category: "Bags & Wallets",
  locationLabel: "Central Library",
});

const ordinary: PostItem = makePost("r10-ordinary", {
  title: "Blue water bottle",
  description: "Left on the second-floor desk by the window.",
  category: "Other",
  locationLabel: "Main Library",
});

const explicitlyUnblocked: PostItem = makePost("r10-unblocked", {
  blockedAuthor: false,
  title: "Grey umbrella",
  description: "Found leaning against the bike rack.",
  category: "Other",
  locationLabel: "North Gate",
});

/**
 * One post id may appear in only one mounted frame at a time. `PostList` gives
 * every card a shared-layout title (`fb-post-title-<id>`), and framer-motion
 * treats equal layoutIds on one page as the SAME element: the first mount
 * becomes the lead and the duplicates are translated away at opacity 0. Measured
 * before this helper existed: "Blue water bottle" rendered at
 * `transform: translate3d(260px, 2343.34px, 0) scale(3.26087, 1); opacity: 0` in
 * the @840 frame and never settled, i.e. the frame silently lost the title it is
 * supposed to show. A review surface that hides content is worse than no review
 * surface, so each frame clones the post under its own id.
 */
const copyFor = (post: PostItem, frame: string): PostItem => ({ ...post, id: `${post.id}--${frame}` });

const listBase = {
  loading: false,
  loadingMore: false,
  error: null,
  hasMore: false,
  onLoadMore: async () => {},
  onRetry: async () => {},
};

/** The comment-content region `PostDetail` wraps, kept structurally faithful. */
function CommentContent() {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block h-7 w-7 shrink-0 rounded-full bg-surface-container-high"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">@owner</span>
        <span className="text-xs text-on-surface-variant">2h</span>
      </div>
      <p className="mt-2 text-sm">Is the backpack still available? I think it is mine.</p>
    </div>
  );
}

/** Actions stay outside the shield in `PostDetail.renderComment`. */
function CommentActions() {
  return (
    <div className="mt-2 flex items-center gap-1">
      <button type="button" className="fb-report-action min-h-[44px] gap-1 text-on-surface-variant">
        Like
      </button>
      <button type="button" className="fb-report-action min-h-[44px] gap-1 text-on-surface-variant">
        Reply
      </button>
    </div>
  );
}

function ReportRegion() {
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Report summary" className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">Black canvas backpack</h3>
        <p className="text-sm">Lost near the central library steps on Tuesday afternoon.</p>
      </section>
      <section aria-label="Report details" className="flex flex-col gap-1 text-sm">
        <p className="text-on-surface-variant">Bags &amp; Wallets · Central Library · 23 Sep 2026</p>
      </section>
    </div>
  );
}

function Frame({
  variant,
  width,
  caption,
  children,
}: {
  variant: "normal" | "large-text" | "dark" | "amoled" | "small-width";
  width: number;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-on-surface-variant">{caption}</p>
      <FixtureFrame section="blocked-shield" variant={variant} width={width}>
        {children}
      </FixtureFrame>
    </div>
  );
}

export function BlockedShieldFixtures() {
  return (
    <FixtureSection
      id="blocked-shield"
      title="O5 blocked-by-viewer shield (CF-060 R10)"
      description="Concealed and revealed states of the four mounts. Blur, warning and reveal are the production component; the feed and profile frames mount production rows, the comment and detail frames reproduce the wrapped region."
    >
      <Frame variant="normal" width={320} caption="Feed card mount @320 — flagged card shielded, ordinary cards untouched">
        <PostList
          items={[
            copyFor(flagged, "feed"),
            copyFor(ordinary, "feed"),
            copyFor(explicitlyUnblocked, "feed"),
          ]}
          {...listBase}
          density="home-feed"
        />
      </Frame>

      <Frame variant="large-text" width={320} caption="Feed card mount @320, Extra-large text — no overflow, warning stays inside the card">
        <PostList items={[copyFor(flagged, "large-text")]} {...listBase} density="home-feed" />
      </Frame>

      <Frame variant="dark" width={320} caption="Feed card mount @320, dark">
        <PostList items={[copyFor(flagged, "dark")]} {...listBase} density="home-feed" />
      </Frame>

      <Frame variant="amoled" width={320} caption="Feed card mount @320, AMOLED true-black">
        <PostList items={[copyFor(flagged, "amoled")]} {...listBase} density="home-feed" />
      </Frame>

      <Frame variant="normal" width={840} caption="Feed card mount @840 (wide) — shield spans the card, not the viewport">
        <PostList items={[copyFor(flagged, "wide"), copyFor(ordinary, "wide")]} {...listBase} density="home-feed" />
      </Frame>

      <Frame variant="normal" width={320} caption="Profile reports row @320 — shield outside the SettingsRow link">
        <SettingsGroup>
          <BlockedByViewerShield rowId="r10-profile" blocked mode="row">
            <SettingsRow title="Black canvas backpack" description="Lost" route="/posts/r10-blocked" />
          </BlockedByViewerShield>
          <SettingsRow title="Blue water bottle" description="Found" route="/posts/r10-ordinary" />
        </SettingsGroup>
      </Frame>

      <Frame variant="normal" width={320} caption="Comment mount @320 — blocked comment shielded, its reply stays operable below">
        <div className="flex flex-col gap-3 p-4">
          <BlockedByViewerShield rowId="r10-comment" blocked mode="row" contentClassName="flex flex-col">
            <CommentContent />
          </BlockedByViewerShield>
          <CommentActions />
          <div className="ml-6 border-l border-outline-variant pl-3">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-6 w-6 shrink-0 rounded-full bg-surface-container-high"
              />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">@finder</span>
            </div>
            <p className="mt-2 text-sm">Yes — it is at the front desk. Ask for the blue tag.</p>
          </div>
        </div>
      </Frame>

      <Frame variant="normal" width={320} caption="Detail mount @320 — report region shielded, comment block beneath stays operable">
        <div className="flex flex-col gap-4 px-4 py-2">
          <BlockedByViewerShield rowId="r10-detail" blocked contentClassName="flex flex-col gap-4">
            <ReportRegion />
          </BlockedByViewerShield>
          <div className="flex flex-col gap-2 border-t border-outline-variant pt-3">
            <p className="text-sm font-semibold">Comments</p>
            <p className="text-sm">Is the backpack still available?</p>
            <button type="button" className="min-h-[44px] self-start text-sm font-semibold">
              Add a comment
            </button>
          </div>
        </div>
      </Frame>
    </FixtureSection>
  );
}
