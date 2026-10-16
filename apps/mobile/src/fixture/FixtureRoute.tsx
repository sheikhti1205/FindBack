import { ChromeFixtures } from "./sections/ChromeFixtures";
import { CreateFixtures } from "./sections/CreateFixtures";
import { DetailFixtures } from "./sections/DetailFixtures";
import { FeedLayoutFixtures } from "./sections/FeedLayoutFixtures";
import { HomeFixtures } from "./sections/HomeFixtures";
import { SocialFixtures } from "./sections/SocialFixtures";
import { SystemFixtures } from "./sections/SystemFixtures";

const SECTION_LINKS = [
  { id: "home", label: "Home feed" },
  { id: "feed-layouts", label: "Feed layouts" },
  { id: "home-chrome", label: "Home chrome" },
  { id: "detail", label: "Post detail" },
  { id: "create", label: "Create report" },
  { id: "comments", label: "Comments & composer" },
  { id: "notifications", label: "Notifications" },
  { id: "search", label: "Search" },
  { id: "my-reports", label: "My Reports" },
  { id: "profile", label: "Profile" },
  { id: "settings", label: "Settings" },
  { id: "assistant", label: "Assistant" },
  { id: "map-unavailable", label: "Map unavailable" },
] as const;

/**
 * L-FIXTURE deterministic visual preflight route (static only — NOT device
 * acceptance). Renders ACTUAL production components with fixed fixture data
 * (no network, no auth): Home, Post detail, Create Report, Comments +
 * composer, Notifications, Search, My Reports, Profile, Settings,
 * Assistant, and the Map-unavailable state — each in normal / loading /
 * empty / error / long-content / large-text / dark / AMOLED / small-width
 * (320dp) variants. See the colocated README for reviewer usage.
 */
export function FixtureRoute() {
  return (
    <main
      data-testid="fixture-route"
      className="mx-auto flex w-full max-w-[1400px] flex-col gap-10 px-4 py-6"
    >
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          Visual fixture preflight (static)
        </p>
        <h1 className="text-2xl font-bold">
          Production components, deterministic data
        </h1>
        <p className="text-sm text-on-surface-variant">
          No network, no auth, no randomness. Screenshot any frame below at
          any viewport, text scale, or theme.
        </p>
        <nav aria-label="Fixture sections">
          <ul className="flex flex-wrap gap-2">
            {SECTION_LINKS.map((link) => (
              <li key={link.id}>
                <a
                  href={`#fixture-${link.id}`}
                  className="inline-flex min-h-[44px] items-center rounded-m3-sm border border-outline-variant px-3 text-sm"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <div>
        <HomeFixtures />
      </div>
      <div>
        <FeedLayoutFixtures />
      </div>
      <div>
        <ChromeFixtures />
      </div>
      <div>
        <DetailFixtures />
      </div>
      <div>
        <CreateFixtures />
      </div>
      <div>
        <SocialFixtures />
      </div>
      <div>
        <SystemFixtures />
      </div>
    </main>
  );
}
