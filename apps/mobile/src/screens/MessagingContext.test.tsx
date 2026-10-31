// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ChatLocation, ChatReportContext } from "./Messaging";

const fetchPost = vi.fn();
vi.mock("../services/posts", () => ({ fetchPost: (id: string) => fetchPost(id) }));

afterEach(() => { cleanup(); fetchPost.mockReset(); });

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
