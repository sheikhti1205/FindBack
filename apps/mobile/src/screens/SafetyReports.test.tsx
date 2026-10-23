// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const { mockListMyReports, viewer } = vi.hoisted(() => ({ mockListMyReports: vi.fn(), viewer: { id: "reporter-a" } }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: viewer.id } }) }));

vi.mock("../services/moderation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/moderation")>();
  return { ...actual, listMyReports: (...args: unknown[]) => mockListMyReports(...args) };
});

import { SafetyReports } from "./SafetyReports";
import { ApiError } from "../services/session";

afterEach(cleanup);

beforeEach(() => {
  mockListMyReports.mockReset();
  viewer.id = "reporter-a";
  mockListMyReports.mockResolvedValue([
    {
      id: "report-1",
      targetType: "POST",
      reason: "HARASSMENT",
      status: "OPEN",
      createdAt: "2026-10-22T10:00:00.000Z",
    },
    {
      id: "report-2",
      targetType: "USER",
      reason: "SPAM_OR_DUPLICATE",
      status: "ACTIONED",
      createdAt: "2026-10-21T10:00:00.000Z",
    },
  ]);
});

function renderScreen() {
  return render(
    <MemoryRouter>
      <SafetyReports />
    </MemoryRouter>,
  );
}

describe("the reports a reader sent", () => {
  it("clears the first account's loaded private receipts on a direct account switch", async () => {
    const { rerender } = renderScreen();
    await screen.findByText("Harassment");
    viewer.id = "reporter-b";
    mockListMyReports.mockReturnValueOnce(new Promise(() => {}));
    rerender(<MemoryRouter><SafetyReports /></MemoryRouter>);
    expect(screen.queryByText("Harassment")).toBeNull();
    expect(screen.queryByText("Spam or a duplicate")).toBeNull();
    expect(screen.getByText("Loading your reports…")).toBeTruthy();
  });

  it.each(["success", "error"])("discards the previous account's late receipt %s", async (outcome) => {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    mockListMyReports.mockReturnValueOnce(new Promise((yes, no) => { resolve = yes; reject = no; }));
    const { rerender } = renderScreen();
    viewer.id = "reporter-b";
    mockListMyReports.mockResolvedValueOnce([]);
    rerender(<MemoryRouter><SafetyReports /></MemoryRouter>);
    await screen.findByText(/haven’t sent any reports yet/i);
    await act(async () => {
      if (outcome === "success") resolve([{ id: "private-a", targetType: "POST", reason: "HARASSMENT", status: "OPEN", createdAt: "2026-10-22" }]);
      else reject(new ApiError("Old session", 401));
    });
    expect(screen.queryByText("Harassment")).toBeNull();
    expect(screen.queryByTestId("safety-reports-error")).toBeNull();
    expect(screen.getByText(/haven’t sent any reports yet/i)).toBeTruthy();
  });

  it("shows each report in words, with its status", async () => {
    renderScreen();
    expect(await screen.findByText("Harassment")).toBeTruthy();
    expect(screen.getByText("Spam or a duplicate")).toBeTruthy();
    expect(screen.getByText("Waiting to be looked at")).toBeTruthy();
    expect(screen.getByText("We took action")).toBeTruthy();
    // No database word and no identifier.
    expect(document.body.textContent).not.toMatch(/HARASSMENT|ACTIONED|report-1/);
  });

  it("says so when nothing has been sent", async () => {
    mockListMyReports.mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText(/haven’t sent any reports yet/i)).toBeTruthy();
  });

  it("shows a refusal as a sentence", async () => {
    mockListMyReports.mockRejectedValue(new ApiError("Not authenticated", 401, "28000"));
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("safety-reports-error")).toBeTruthy());
    expect(screen.getByTestId("safety-reports-error").textContent).toMatch(/session expired/i);
  });

  it("says plainly that the list is not in this build, and never calls it empty", async () => {
    mockListMyReports.mockRejectedValue(new ApiError("Could not find the function", 500, "PGRST202"));
    renderScreen();
    const unavailable = await screen.findByTestId("safety-reports-unavailable");
    expect(unavailable.textContent).toMatch(/not available in this build/i);
    // An unavailable list is not an empty list.
    expect(screen.queryByText(/haven’t sent any reports yet/i)).toBeNull();
    expect(unavailable.textContent).not.toMatch(/PGRST202|schema/i);
  });
});
