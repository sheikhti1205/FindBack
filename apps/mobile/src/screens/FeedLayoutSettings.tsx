/**
 * Settings → Feed layout (CF-010, packet `09` §6 and §23).
 *
 * The Home feed can be arranged four ways. `Auto` is the default and decides
 * from the width band, which is what most readers want; the other three are
 * explicit and are honoured on any screen, however narrow — a reader who asks
 * for the photo grid on a phone gets one column of grid cards, not a silently
 * different layout.
 *
 * Applies and persists the moment it is picked (device-local, same policy as
 * text size and theme — no Save step), so the Home feed behind this screen is
 * already the layout the reader just chose.
 */
import { resolveFeedLayout, useViewportWidth, type FeedLayout, type ResolvedFeedLayout } from "../components/responsive";
import { PreferenceRadioRow, SettingsGroup, SettingsPage } from "../components/settings";
import { useFeedLayoutPreference } from "../services/feedLayoutPreference";

interface LayoutOption {
  id: FeedLayout;
  label: string;
  description: string;
}

const LAYOUT_OPTIONS: readonly LayoutOption[] = [
  {
    id: "auto",
    label: "Auto",
    description: "Follows this screen. Phones get one column, wider screens get a photo grid.",
  },
  {
    id: "feed",
    label: "Feed",
    description: "One report at a time, photo first.",
  },
  {
    id: "compact",
    label: "Compact",
    description: "Small thumbnails, more reports on screen.",
  },
  {
    id: "masonry",
    label: "Masonry",
    description: "Photo grid. Each card keeps its own shape.",
  },
];

const RESOLVED_LABELS: Record<ResolvedFeedLayout, string> = {
  feed: "Feed",
  compact: "Compact",
  masonry: "Masonry",
};

const RESOLVED_SENTENCES: Record<ResolvedFeedLayout, string> = {
  feed: "This screen shows one column.",
  compact: "This screen shows compact rows.",
  masonry: "This screen fits a photo grid.",
};

/** Short value for the Settings row: `Auto · Masonry`, or just the choice. */
export function feedLayoutSummary(layout: FeedLayout, resolved: ResolvedFeedLayout): string {
  const label = RESOLVED_LABELS[resolved];
  return layout === "auto" ? `Auto · ${label}` : label;
}

export function FeedLayoutSettings() {
  const { layout, setLayout } = useFeedLayoutPreference();
  const width = useViewportWidth();
  const resolved = resolveFeedLayout(layout, width);

  return (
    <SettingsPage
      title="Feed layout"
      description="How reports are arranged on the Home feed. Applies right away."
      backTo="/settings"
    >
      <SettingsGroup title="Layout" description="Auto decides from the width of this screen.">
        <fieldset className="fb-choice-fieldset">
          <legend className="sr-only">Feed layout</legend>
          <div className="fb-choice-list">
            {LAYOUT_OPTIONS.map((option) => (
              <PreferenceRadioRow
                key={option.id}
                name="feed-layout"
                value={option.id}
                title={option.label}
                description={option.description}
                checked={layout === option.id}
                onChange={() => setLayout(option.id)}
              />
            ))}
          </div>
        </fieldset>
      </SettingsGroup>
      <p
        role="status"
        data-testid="feed-layout-resolved"
        className="fb-settings-page-description"
      >
        {RESOLVED_SENTENCES[resolved]}
      </p>
    </SettingsPage>
  );
}
