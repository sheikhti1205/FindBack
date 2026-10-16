import type {
  Attachment,
  PostItem,
  PostStatus,
  PublicProfile,
} from "@findback/shared";

/**
 * L-FIXTURE deterministic factories. Every field is a fixed literal — no
 * dates from `Date.now()`, no randomness — so screenshots taken through the
 * `/__fixture` route are comparable across runs and devices.
 */

const BASE_CREATED = "2026-09-24T12:00:00.000Z";

function attachment(postId: string, index: number): Attachment {
  return {
    id: `${postId}-photo-${index}`,
    postId,
    // Intentionally non-resolving: the feed reserves the frame and shows the
    // loading/error placeholder, which is exactly the deterministic state a
    // screenshot preflight wants (no network flakiness in CI or on device).
    fileUrl: `fixture://${postId}/photo-${index}.jpg`,
    mimeType: "image/jpeg",
    fileName: `photo-${index}.jpg`,
    fileSize: 184_320,
    createdAt: BASE_CREATED,
  };
}

function author(overrides: Partial<PublicProfile> = {}): PublicProfile {
  return {
    id: "fixture-user-1",
    username: "samira",
    emailVerified: true,
    phoneVerified: false,
    avatarUrl: null,
    createdAt: BASE_CREATED,
    displayName: "Samira",
    ...overrides,
  };
}

export function makePost(
  id: string,
  overrides: Partial<PostItem> = {},
): PostItem {
  return {
    id,
    userId: "fixture-user-1",
    author: author(),
    type: "LOST",
    title: "Black canvas backpack",
    description: "Lost near the central library steps on Tuesday afternoon.",
    category: "Bags & Wallets",
    status: "OPEN",
    eventDate: "2026-09-23",
    latitude: null,
    longitude: null,
    locationLabel: "Central Library",
    youtubeUrl: null,
    attachments: [],
    likeCount: 3,
    dislikeCount: 0,
    ratingAvg: null,
    ratingCount: 0,
    commentCount: 2,
    createdAt: BASE_CREATED,
    updatedAt: BASE_CREATED,
    ...overrides,
  };
}

function withPhotos(id: string, count: number, overrides: Partial<PostItem> = {}): PostItem {
  const base = makePost(id, overrides);
  return {
    ...base,
    attachments: Array.from({ length: count }, (_, i) => attachment(id, i + 1)),
  };
}

/**
 * One attachment with a known intrinsic size — the CF-060 M1 pair
 * (`public.attachments.width/height`, migration 20261015154642). The masonry
 * grid derives its true ratio from exactly this pair, so the fixture has to
 * carry real numbers rather than a shape hint.
 */
function sizedAttachment(id: string, index: number, width: number, height: number): Attachment {
  return { ...attachment(id, index), width, height };
}

/**
 * CF-010 masonry matrix: the ratios the true-ratio grid must honor, plus the
 * two states it must degrade gracefully for — an attachment with no stored
 * dimensions (published before the migration) and a report with no photo at
 * all. Fixed literals only, like the rest of this module.
 */
export const masonryRatioPosts: PostItem[] = [
  makePost("fx-masonry-portrait", {
    title: "Portrait photo (3:4)",
    attachments: [sizedAttachment("fx-masonry-portrait", 1, 900, 1200)],
  }),
  makePost("fx-masonry-landscape", {
    title: "Landscape photo (4:3)",
    attachments: [sizedAttachment("fx-masonry-landscape", 1, 1200, 900)],
  }),
  makePost("fx-masonry-square", {
    title: "Square photo (1:1)",
    attachments: [sizedAttachment("fx-masonry-square", 1, 1000, 1000)],
  }),
  makePost("fx-masonry-tall", {
    title: "Tall phone photo (9:16)",
    attachments: [sizedAttachment("fx-masonry-tall", 1, 1080, 1920)],
  }),
  makePost("fx-masonry-wide", {
    title: "Wide photo (16:9)",
    attachments: [sizedAttachment("fx-masonry-wide", 1, 1920, 1080)],
  }),
  makePost("fx-masonry-unknown", {
    title: "Photo with no stored size",
    description: "Published before dimensions were recorded, so the fallback ratio shows.",
    attachments: [attachment("fx-masonry-unknown", 1)],
  }),
  makePost("fx-masonry-text", {
    title: "Report with no photo",
    description: "Text-first card: it must not reserve an empty media box.",
  }),
  makePost("fx-masonry-multi", {
    title: "First of three photos",
    attachments: [sizedAttachment("fx-masonry-multi", 1, 900, 1200), attachment("fx-masonry-multi", 2)],
  }),
];

export const LONG_TITLE =
  "Very long report title that keeps going well past two lines on a narrow phone so truncation, wrapping, and card growth stay honest — black leather weekender bag with brass zips and a torn side pocket";

export const LONG_LOCATION =
  "An unusually long location label: North Wing, Level 3, Reading Room B, near the periodicals shelf by the east-facing windows, Central City Public Library";

export const LONG_USERNAME = "alexandria_constantine_reporter_1994";

export const LONG_DESCRIPTION = [
  "This is a deliberately long description with **markdown**, a mention of @samira, and several paragraphs.",
  "",
  "Second paragraph: the bag is black canvas with brown leather straps, brass zips, a torn left side pocket, and a faded luggage tag reading “S.K.”. Last seen Tuesday just after lunch.",
  "",
  "Third paragraph: if found, please leave it at the front desk or reply here — any detail helps, even a partial sighting. Reward offered, no questions asked. Thank you for reading this far.",
].join("\n");

const ALL_STATUSES: PostStatus[] = ["OPEN", "MATCHED", "RECOVERED", "CLOSED"];

/** Home matrix core: 0 / 1 / 5 photos. */
export const homePhotoVariants: PostItem[] = [
  makePost("fx-home-0-photo"),
  withPhotos("fx-home-1-photo", 1, {
    title: "Keys with a red fob",
    description: "Single-photo report.",
  }),
  withPhotos("fx-home-5-photos", 5, {
    title: "Camera bag with lenses",
    description: "Five-photo report exercises the pager + indicator.",
    status: "MATCHED",
  }),
];

/** Home matrix: every status. */
export const homeStatusVariants: PostItem[] = ALL_STATUSES.map(
  (status, i) =>
    withPhotos(`fx-home-status-${status.toLowerCase()}`, 1, {
      status,
      title: `${status.charAt(0)}${status.slice(1).toLowerCase()} report example`,
      type: i % 2 === 0 ? "LOST" : "FOUND",
    }),
);

/** Home matrix: long title, long location, high counts, long username, no avatar. */
export const homeEdgeVariants: PostItem[] = [
  makePost("fx-home-long-title", {
    title: LONG_TITLE,
    attachments: [attachment("fx-home-long-title", 1)],
  }),
  makePost("fx-home-long-location", {
    locationLabel: LONG_LOCATION,
    title: "Umbrella left in reading room",
  }),
  makePost("fx-home-high-counts", {
    title: "High reaction count report",
    likeCount: 1284,
    dislikeCount: 96,
    commentCount: 342,
    reactionSummary: {
      counts: { LOVE: 842, HELPFUL: 301, SUPPORT: 118, WOW: 23 },
      myReaction: "LOVE",
      total: 1284,
    },
    attachments: [attachment("fx-home-high-counts", 1)],
  }),
  makePost("fx-home-long-username", {
    author: author({ username: LONG_USERNAME, displayName: LONG_USERNAME }),
    title: "Report from a very long display name",
  }),
  makePost("fx-home-no-avatar", {
    author: author({ username: "", displayName: null, avatarUrl: null }),
    title: "Report with no avatar and no name",
  }),
];

export const allHomeMatrixPosts: PostItem[] = [
  ...homePhotoVariants,
  ...homeStatusVariants,
  ...homeEdgeVariants,
];

export const detailPost: PostItem = withPhotos("fx-detail", 3, {
  title: "Lost camera bag — detail preflight",
  description: LONG_DESCRIPTION,
  locationLabel: LONG_LOCATION,
  latitude: 40.7128,
  longitude: -74.006,
  status: "OPEN",
  commentCount: 3,
  reactionSummary: {
    counts: { LOVE: 12, HELPFUL: 7 },
    myReaction: null,
    total: 19,
  },
});

export interface FixtureComment {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
}

export const fixtureComments: FixtureComment[] = [
  {
    id: "fx-c1",
    username: "samira",
    displayName: "Samira",
    avatarUrl: null,
    body: "I think I saw this near the front desk — check with staff?",
    createdAt: "2h ago",
  },
  {
    id: "fx-c2",
    username: LONG_USERNAME,
    displayName: LONG_USERNAME,
    avatarUrl: null,
    body: "Long-username commenter with a longer reply that wraps across several lines on a 320dp viewport to prove wrapping stays honest.",
    createdAt: "1h ago",
  },
  {
    id: "fx-c3",
    username: "",
    displayName: null,
    avatarUrl: null,
    body: "Anonymous-looking comment with no avatar at all.",
    createdAt: "12m ago",
  },
];

export interface FixtureTranscriptTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  source?: "llm" | "fallback" | "model";
}

export const assistantTranscript: FixtureTranscriptTurn[] = [
  { id: "fx-t1", role: "user", text: "How do I report a lost bag?" },
  {
    id: "fx-t2",
    role: "assistant",
    text: "Open the Report tab, add photos, then describe the item and where you lost it.",
    source: "llm",
  },
  { id: "fx-t3", role: "user", text: "Can I edit it later?" },
  {
    id: "fx-t4",
    role: "assistant",
    text: "Yes — open My Reports and choose the report to update its status or details.",
    source: "fallback",
  },
];

export const STRINGS = {
  loadingError: "Could not load (fixture preflight — no network is used).",
  emptyTitle: "Nothing here yet",
  emptySubtitle: "Fixture empty state: no reports match.",
  mapUnavailableTitle: "Map unavailable",
  mapUnavailableSubtitle:
    "No map key is configured in this build, so the location preview stays a neutral placeholder. Coordinates are never fabricated.",
} as const;
