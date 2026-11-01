// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ChatLocation, ChatReportContext } from "./Messaging";
import { signalSafetyChanged } from "../services/safetySignals";

const fetchPost = vi.fn();
vi.mock("../services/posts", () => ({ fetchPost: (id: string) => fetchPost(id) }));
const realtime = vi.hoisted(() => new Map<string, Set<(payload: Record<string, unknown>) => void>>());
vi.mock("../services/realtime", () => ({
  onRealtime: (event: string, handler: (payload: Record<string, unknown>) => void) => {
    if (!realtime.has(event)) realtime.set(event, new Set());
    realtime.get(event)!.add(handler);
    return () => realtime.get(event)?.delete(handler);
  },
}));

afterEach(() => { cleanup(); fetchPost.mockReset(); realtime.clear(); });

const REPORT = "00000000-0000-4000-8000-00000000000b";

it("renders the live report subject as a link to that report", async () => {
  fetchPost.mockResolvedValue({ id: REPORT, title: "Blue wallet", type: "FOUND" });
  render(<MemoryRouter><ChatReportContext reportId={REPORT} /></MemoryRouter>);
  const link = await screen.findByRole("link", { name: /Blue wallet/ });
  expect(link.getAttribute("href")).toBe(`/posts/${REPORT}`);
  expect(screen.getByText("Found report")).toBeTruthy();
  expect(fetchPost).toHaveBeenCalledWith(REPORT);
});

it("degrades to plain text when the reader can no longer see the report", async () => {
  fetchPost.mockRejectedValue(new Error("Post not found"));
  render(<MemoryRouter><ChatReportContext reportId={REPORT} /></MemoryRouter>);
  expect(await screen.findByText("Report unavailable")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});

it("shows the current first image, approximate place, event date and report status", async () => {
  fetchPost.mockResolvedValue({ id: REPORT, title: "Blue wallet", type: "FOUND", status: "RECOVERED",
    locationLabel: "Near the station", eventDate: "2026-10-20", attachments: [{ fileUrl: "/wallet.jpg", mimeType: "image/jpeg" }, { fileUrl: "/other.jpg", mimeType: "image/jpeg" }] });
  render(<MemoryRouter><ChatReportContext reportId={REPORT} /></MemoryRouter>);
  await screen.findByRole("link", { name: /Blue wallet/ });
  expect(screen.getByRole("img", { name: /Blue wallet/ }).getAttribute("src")).toBe("/wallet.jpg");
  expect(screen.getAllByRole("img")).toHaveLength(1);
  expect(screen.getByText("Near the station")).toBeTruthy();
  expect(screen.getByText("Recovered")).toBeTruthy();
  expect(document.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-20");
});

it("removes a previous subject immediately on a different report id and on revalidation", async () => {
  fetchPost.mockResolvedValueOnce({ id: REPORT, title: "Private wallet", type: "FOUND" });
  const view = render(<MemoryRouter><ChatReportContext reportId={REPORT} /></MemoryRouter>);
  await screen.findByText("Private wallet");
  fetchPost.mockReturnValue(new Promise(() => {}));
  view.rerender(<MemoryRouter><ChatReportContext reportId="other-report" /></MemoryRouter>);
  expect(screen.queryByText("Private wallet")).toBeNull();
});

it("rechecks visibility on return and discards an inaccessible subject", async () => {
  fetchPost.mockResolvedValueOnce({ id: REPORT, title: "Private wallet", type: "FOUND", attachments: [{ fileUrl: "/wallet.jpg", mimeType: "image/jpeg" }] });
  render(<MemoryRouter><ChatReportContext reportId={REPORT} /></MemoryRouter>);
  await screen.findByText("Private wallet"); fetchPost.mockRejectedValue(new Error("Post not found"));
  fireEvent.focus(window);
  await screen.findByText("Report unavailable");
  expect(screen.queryByText("Private wallet")).toBeNull(); expect(screen.queryByRole("img")).toBeNull();
  await waitFor(() => expect(fetchPost).toHaveBeenCalledTimes(2));
});

it("conceals a report the reader has blocked instead of previewing it", async () => {
  // fetchPost is not an exclusion-only reader: it can return a public row with
  // blockedAuthor set and leave concealment to presentation. A chat preview has
  // no shield, so a blocked report must read as unavailable — title, photo and
  // place included.
  fetchPost.mockResolvedValue({ id: REPORT, title: "Blocked wallet", type: "FOUND", blockedAuthor: true,
    locationLabel: "Near the station", attachments: [{ fileUrl: "/wallet.jpg", mimeType: "image/jpeg" }] });
  render(<MemoryRouter><ChatReportContext reportId={REPORT} /></MemoryRouter>);
  expect(await screen.findByText("Report unavailable")).toBeTruthy();
  expect(screen.queryByText("Blocked wallet")).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});

it("revokes a loaded subject when a block happens elsewhere in this tab", async () => {
  // The subject may be a third person's report, so the conversation peer's own
  // block bit never changes. A block made in this tab must still revoke what is
  // already on screen.
  fetchPost.mockResolvedValue({ id: REPORT, title: "Third party wallet", type: "FOUND" });
  render(<MemoryRouter><ChatReportContext reportId={REPORT} /></MemoryRouter>);
  await screen.findByText("Third party wallet");
  fetchPost.mockResolvedValue({ id: REPORT, title: "Third party wallet", type: "FOUND", blockedAuthor: true });
  await act(async () => { signalSafetyChanged(); });
  expect(await screen.findByText("Report unavailable")).toBeTruthy();
  expect(screen.queryByText("Third party wallet")).toBeNull();
});

it("drops a loaded subject when the reader blocks in this tab", async () => {
  fetchPost.mockResolvedValue({ id: REPORT, title: "Private wallet", type: "FOUND" });
  const view = render(<MemoryRouter><ChatReportContext reportId={REPORT} safetyKey="clear" /></MemoryRouter>);
  await screen.findByText("Private wallet");
  fetchPost.mockResolvedValue({ id: REPORT, title: "Private wallet", type: "FOUND", blockedAuthor: true });
  view.rerender(<MemoryRouter><ChatReportContext reportId={REPORT} safetyKey="blocked" /></MemoryRouter>);
  expect(await screen.findByText("Report unavailable")).toBeTruthy();
  expect(screen.queryByText("Private wallet")).toBeNull();
});

it.each(["UPDATE", "DELETE"])("revokes a loaded subject on a feed %s without focus loss", async (op) => {
  fetchPost.mockResolvedValueOnce({ id: REPORT, title: "Revoked wallet", type: "FOUND",
    attachments: [{ fileUrl: "/wallet.jpg", mimeType: "image/jpeg" }] });
  const view = render(<MemoryRouter><ChatReportContext reportId={REPORT} /></MemoryRouter>);
  await screen.findByText("Revoked wallet");
  let rejectRead!: (error: Error) => void;
  fetchPost.mockReturnValue(new Promise((_resolve, reject) => { rejectRead = reject; }));
  act(() => { realtime.get("feed:changed")?.forEach(handler => handler({ postId: REPORT, op })); });
  // Hide old title/photo/link immediately, not only after the refetch settles.
  expect(screen.queryByText("Revoked wallet")).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  await act(async () => { rejectRead(new Error("Post unavailable")); });
  expect(await screen.findByText("Report unavailable")).toBeTruthy();
  view.unmount();
  expect(realtime.get("feed:changed")?.size).toBe(0);
});

it("ignores unrelated feed changes and cannot restore a stale read after revocation", async () => {
  let resolveOld!: (post: unknown) => void;
  fetchPost.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
  render(<MemoryRouter><ChatReportContext reportId={REPORT} /></MemoryRouter>);
  act(() => { realtime.get("feed:changed")?.forEach(handler => handler({ postId: "other", op: "UPDATE" })); });
  expect(fetchPost).toHaveBeenCalledTimes(1);
  fetchPost.mockRejectedValue(new Error("Hidden"));
  await act(async () => { realtime.get("feed:changed")?.forEach(handler => handler({ postId: REPORT, op: "UPDATE" })); });
  expect(await screen.findByText("Report unavailable")).toBeTruthy();
  await act(async () => { resolveOld({ id: REPORT, title: "Stale private wallet", type: "FOUND" }); });
  expect(screen.queryByText("Stale private wallet")).toBeNull();
});

it("shows one static coordinate set with its accuracy and an explicit map link", () => {
  render(<ChatLocation location={{ lat: 23.8103, lng: 90.4125, accuracy: 25 }} />);
  expect(screen.getByText("Location shared")).toBeTruthy();
  expect(screen.getByText(/23\.81030, 90\.41250 · device estimate 25 m/)).toBeTruthy();
  const map = screen.getByRole("link", { name: "Open map" });
  expect(map.getAttribute("href")).toContain("mlat=23.81030");
  expect(map.getAttribute("rel")).toContain("noopener");
});

it("shows a manual static pin without inventing an accuracy estimate", () => {
  render(<ChatLocation location={{ lat: 23.81, lng: 90.41, accuracy: null }} />);
  expect(screen.getByText("23.81000, 90.41000")).toBeTruthy();
  expect(screen.queryByText(/estimate|within/)).toBeNull();
});
