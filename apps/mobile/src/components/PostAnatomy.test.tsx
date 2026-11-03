// @vitest-environment jsdom
import type { PostItem } from "@norfold/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router";
import { PostList } from "./PostList";
import { SavedReportsProvider } from "../hooks/useSavedReports";
import { readSavedReports } from "../services/savedReports";
import { UserIdentityProvider, type PublicIdentity } from "./UserIdentityTrigger";

const { rpc, auth } = vi.hoisted(() => ({ rpc: vi.fn(), auth: { id: "reader" as string | null } }));
vi.mock("../services/supabaseClient", () => ({ getSupabase: () => ({ rpc }) }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: auth.id ? { id: auth.id, username: "reader" } : null }) }));
beforeEach(() => {
  localStorage.clear(); auth.id = "reader";
  rpc.mockReset().mockResolvedValue({ data: { items: [], complete: true }, error: null });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
const post: PostItem = {
  id: "p1", userId: "owner", author: { id: "owner", username: "sam", displayName: "Sam Reed", avatarUrl: null, emailVerified: true, phoneVerified: false, createdAt: "2026-01-01T00:00:00.000Z" },
  type: "LOST", status: "OPEN", title: "Brown wallet", description: "Left near the station", category: "Bags & Wallets",
  eventDate: "2026-10-30", latitude: null, longitude: null, locationLabel: "Central station", youtubeUrl: null,
  createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z", likeCount: 4, dislikeCount: 0,
  ratingAvg: null, ratingCount: 0, commentCount: 2,
  attachments: [{ id: "photo", postId: "p1", fileUrl: "https://example.test/wallet.jpg", mimeType: "image/jpeg", fileName: "wallet.jpg", fileSize: 12000, createdAt: "2026-10-30T00:00:00.000Z", width: 1200, height: 900 }],
};
function RouteProbe() { return <output data-testid="route">{useLocation().pathname}</output>; }
function mount(density?: "home-feed" | "editorial" | "compact" | "masonry") {
  return render(<MemoryRouter><SavedReportsProvider><PostList items={[post]} density={density} loading={false} loadingMore={false} error={null} hasMore={false} onLoadMore={async () => {}} /><RouteProbe /></SavedReportsProvider></MemoryRouter>);
}

// Removing the shared identity, wrapping controls in a link, or sending a feed
// photo anywhere but the report it belongs to must fail independently in every
// layout. A feed photo is a report destination; the fullscreen viewer belongs
// to report detail (and to chat attachments), never to the list.
it.each([undefined, "home-feed", "editorial", "compact", "masonry"] as const)("keeps identity, navigation and photo destination separate in %s", async (density) => {
  const { container } = mount(density);
  const identity = screen.getByRole("button", { name: "About Sam Reed" });
  const title = screen.getByRole("heading", { name: "Brown wallet" });
  expect(identity.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(container.querySelector("a button, a a, button button")).toBeNull();
  fireEvent.click(identity);
  const card = await screen.findByRole("dialog", { name: "About Sam Reed" });
  expect(within(card).getByRole("link", { name: "View profile" }).getAttribute("href")).toBe("/u/sam");
  fireEvent.keyDown(card, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "About Sam Reed" })).toBeNull());
  const photo = screen.getByRole("button", { name: "Photo for Brown wallet" });
  fireEvent.click(photo);
  await waitFor(() => expect(screen.getByTestId("route").textContent).toBe("/posts/p1"));
  expect(screen.queryByRole("dialog", { name: "Photo viewer" })).toBeNull();
});

it("keeps Save in overflow while the primary actions remain Like, Comments and Share", async () => {
  mount("home-feed");
  const primary = screen.getByRole("group", { name: "Report actions" });
  expect(within(primary).queryByRole("button", { name: "Save report" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More report actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Save report" }));
  await waitFor(() => expect(readSavedReports("reader").map(row => row.postId)).toEqual(["p1"]));
  fireEvent.click(screen.getByRole("button", { name: "More report actions" }));
  expect(await screen.findByRole("menuitem", { name: "Remove from saved reports" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Report post" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Block account" })).toBeTruthy();
});

it("supplies the originating report to the canonical identity contact owner in the feed", async () => {
  function Contact({ person }: { person: PublicIdentity }) { return <span>Message about {person.contextReportId ?? "no report"}</span>; }
  render(<MemoryRouter><SavedReportsProvider><UserIdentityProvider actions={Contact}>
    <PostList items={[post]} density="home-feed" loading={false} loadingMore={false} error={null} hasMore={false} onLoadMore={async () => {}} />
  </UserIdentityProvider></SavedReportsProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "About Sam Reed" }));
  expect(await screen.findByText("Message about p1")).toBeTruthy();
});

it("lets the owner save without offering self-report or self-block", async () => {
  auth.id = "owner";
  mount("compact");
  fireEvent.click(screen.getByRole("button", { name: "More report actions" }));
  expect(await screen.findByRole("menuitem", { name: "Save report" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Report post" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Block account" })).toBeNull();
});

it("removes the account-owned overflow on sign-out without removing public identity", async () => {
  const view = mount("compact");
  fireEvent.click(screen.getByRole("button", { name: "More report actions" }));
  await screen.findByRole("menuitem", { name: "Save report" });
  auth.id = null;
  view.rerender(<MemoryRouter><SavedReportsProvider><PostList items={[post]} density="compact" loading={false} loadingMore={false} error={null} hasMore={false} onLoadMore={async () => {}} /></SavedReportsProvider></MemoryRouter>);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.queryByRole("button", { name: "More report actions" })).toBeNull();
  expect(screen.getByRole("button", { name: "About Sam Reed" })).toBeTruthy();
});
