# Visual fixture route (L-FIXTURE, static preflight)

Deterministic, network-free rendering of ACTUAL production components for
screenshot review. Static only — this is FBX-040 preflight, NOT device
acceptance.

## Reviewer URL

Web dev server (HashRouter, so the route is a hash path):

- `http://localhost:5173/#/__fixture`

On a device build, open the same hash route in the WebView
(`…/#/​__fixture`). The route needs no login and makes no network calls;
fixture photo URLs are intentionally non-resolving (`fixture://…`) so media
frames show their deterministic loading/error placeholder.

## Sections and variants

Sections (anchor links at the top of the page jump to each):

| Section id       | Production components under test                              |
| ---------------- | ------------------------------------------------------------- |
| `home`           | `PostList` + `PostCard(Content)` (home-feed density)          |
| `detail`         | `PostCardContent`, `MarkdownView`, `UserAvatar`, `CommentComposer` |
| `create`         | `Segmented`, `TextField`, `CategoryField`, `MapEmbed`, `Button` |
| `comments`       | `CommentComposer` + avatar thread rows                        |
| `notifications`  | `UserAvatar` notification rows                                |
| `search`         | `PostList` at compact density                                 |
| `my-reports`     | `PostList` at owner-feed density + owner card                 |
| `profile`        | `ProfileHero`, `UserAvatar`                                   |
| `settings`       | `Segmented` theme picker, `Button` states                     |
| `assistant`      | `ChatTranscript`, `ChatComposer`                              |
| `map-unavailable`| `MapEmbed` with null coordinates (honest no-key placeholder)  |

Every section renders all nine variants, each framed with
`data-testid="fixture-<section>-<variant>"`:

`normal`, `loading`, `empty`, `error`, `long-content`, `large-text`
(125%), `dark`, `amoled` (true black), `small-width` (320dp max-width).

## Home matrix (directive Q)

The `home` normal frame renders all of these (stable post ids):

- 0 / 1 / 5 photos (`fx-home-0-photo`, `fx-home-1-photo`, `fx-home-5-photos`)
- All statuses (`fx-home-status-open/matched/recovered/closed`)
- Long title (`fx-home-long-title`), long location (`fx-home-long-location`)
- High reaction counts (`fx-home-high-counts`, 1284 total, reacted LOVE)
- Long username/display name (`fx-home-long-username`), no avatar and no
  name (`fx-home-no-avatar`)

## Tests

`fixture.test.tsx` (colocated) asserts every section renders every variant
without crashing, the home matrix ids are all present, the assistant frame
carries transcript turns + a labelled composer, and the map-unavailable
frame renders its placeholder. Any missing required state turns a test red.

## Product gaps found while building (in-grant, not fixed)

None — every section below renders with unmodified production components.
Two deliberate fixture-level compromises (not product bugs):

1. Fixture photo URLs are `fixture://…` (non-resolving) so media frames are
   deterministic. Real photos still load through the normal pipeline.
2. Data-bound screens (`Home`, `PostDetail`, `CreateReport`,
   `Notifications`, `SearchScreen`, `MyPosts`, `Help`, `Settings`,
   `Profile`) are NOT mounted here — they require auth + live queries and
   cannot render deterministically. The fixture renders the production
   building blocks those screens compose, which is the honest static
   preflight for FBX-040.
