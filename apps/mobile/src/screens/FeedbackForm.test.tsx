// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const { mockSubmitFeedback, mockListMyFeedback } = vi.hoisted(() => ({
  mockSubmitFeedback: vi.fn(),
  mockListMyFeedback: vi.fn(),
}));

vi.mock("../services/feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/feedback")>();
  return {
    ...actual,
    submitFeedback: (...args: unknown[]) => mockSubmitFeedback(...args),
    listMyFeedback: (...args: unknown[]) => mockListMyFeedback(...args),
  };
});

import { FeedbackForm } from "./FeedbackForm";
import { ApiError } from "../services/session";
const viewer = vi.hoisted(() => ({ id: "me" }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: viewer.id } }) }));

afterEach(cleanup);

beforeEach(() => {
  viewer.id = "me";
  vi.clearAllMocks();
  mockSubmitFeedback.mockResolvedValue("feedback-1");
  mockListMyFeedback.mockResolvedValue([
    {
      id: "feedback-1",
      category: "BUG",
      status: "NEW",
      createdAt: "2026-10-22T10:00:00.000Z",
      updatedAt: "2026-10-22T10:00:00.000Z",
    },
  ]);
});

function renderScreen() {
  return render(
    <MemoryRouter>
      <FeedbackForm />
    </MemoryRouter>,
  );
}

describe("the one feedback form", () => {
  it.each([
    "#/settings/feedback?email=synthetic-person@example.invalid",
    "#/u/synthetic-member-id?access_token=synthetic-not-a-credential",
    `#/settings/feedback?context=${"synthetic-".repeat(20)}`,
  ])("never adds URL parameters or dynamic identity to opted-in screen context: %s", async (hash) => {
    const previous = window.location.href;
    try {
      window.history.replaceState(null, "", hash);
      renderScreen();
      fireEvent.click(screen.getByRole("switch", { name: /include technical details/i }));
      fireEvent.click(screen.getByRole("radio", { name: /an idea/i }));
      fireEvent.change(screen.getByLabelText(/tell us what happened/i), { target: { value: "A synthetic suggestion" } });
      fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
      await waitFor(() => expect(mockSubmitFeedback).toHaveBeenCalledTimes(1));
      expect(mockSubmitFeedback.mock.calls[0]![0].screen).toBe("feedback");
    } finally { window.history.replaceState(null, "", previous); }
  });

  it("suppresses old-account history reads", async () => {
    let finish!: (rows: unknown[]) => void;
    mockListMyFeedback.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = renderScreen();
    viewer.id = "other";
    mockListMyFeedback.mockResolvedValue([]);
    view.rerender(<MemoryRouter><FeedbackForm /></MemoryRouter>);
    await screen.findByText(/haven’t sent any feedback yet/i);
    await act(async () => { finish([{ id: "old", category: "BUG", status: "RECEIVED", createdAt: "2026-10-22" }]); });
    expect(screen.queryByTestId("feedback-history-row")).toBeNull();
  });

  it("suppresses old-account submit completion, feedback text and announcement", async () => {
    let finish!: () => void;
    mockSubmitFeedback.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const heard = vi.fn(); window.addEventListener("findback:announce", heard);
    try {
      const view = renderScreen();
      fireEvent.click(screen.getByRole("radio", { name: /something is broken/i }));
      fireEvent.change(screen.getByLabelText(/tell us what happened/i), { target: { value: "Private old account text" } });
      fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
      viewer.id = "other";
      view.rerender(<MemoryRouter><FeedbackForm /></MemoryRouter>);
      await act(async () => { finish(); });
      expect(screen.queryByDisplayValue("Private old account text")).toBeNull();
      expect(screen.queryByTestId("feedback-notice")).toBeNull();
      expect(heard).not.toHaveBeenCalled();
    } finally { window.removeEventListener("findback:announce", heard); }
  });
  it.each([new ApiError("missing", 500, "PGRST202"), new Error("network")])("keeps failed history distinct from empty and retries without submitting", async (failure) => {
    mockListMyFeedback.mockRejectedValueOnce(failure);
    renderScreen();
    expect(await screen.findByTestId("feedback-history-error")).toBeTruthy();
    if (failure instanceof ApiError) expect(screen.getByTestId("feedback-history-error").textContent).toMatch(/not available in this build/i);
    expect(screen.queryByText(/haven’t sent any feedback yet/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry feedback history" }));
    expect(await screen.findByText("Received")).toBeTruthy();
    expect(mockSubmitFeedback).not.toHaveBeenCalled();
  });
  it("offers the four kinds the server knows", () => {
    renderScreen();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.getByRole("radio", { name: /something is broken/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /hard to use/i })).toBeTruthy();
  });

  it("sends the kind, the message and no technical value while the switch is off", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("radio", { name: /something is broken/i }));
    fireEvent.change(screen.getByLabelText(/tell us what happened/i), {
      target: { value: "The map does not load." },
    });
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));

    await waitFor(() => expect(mockSubmitFeedback).toHaveBeenCalledTimes(1));
    const draft = mockSubmitFeedback.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(draft.category).toBe("BUG");
    expect(draft.message).toBe("The map does not load.");
    expect(draft.includeTechnicalInfo).toBe(false);
    expect(draft.appVersion).toBeNull();
    expect(draft.platform).toBeNull();
    expect(draft.screen).toBeNull();
    expect(draft.deviceClass).toBeNull();
  });

  it("sends the four named scalars — and nothing else — while the switch is on", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("switch", { name: /include technical details/i }));
    fireEvent.click(screen.getByRole("radio", { name: /an idea/i }));
    fireEvent.change(screen.getByLabelText(/tell us what happened/i), {
      target: { value: "Please add dark mode." },
    });
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));

    await waitFor(() => expect(mockSubmitFeedback).toHaveBeenCalledTimes(1));
    const draft = mockSubmitFeedback.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(draft.includeTechnicalInfo).toBe(true);
    expect(typeof draft.appVersion).toBe("string");
    expect(typeof draft.platform).toBe("string");
    expect(typeof draft.deviceClass).toBe("string");
    // Never a blob.
    expect(Object.keys(draft).sort()).toEqual([
      "appVersion",
      "category",
      "deviceClass",
      "includeTechnicalInfo",
      "message",
      "platform",
      "screen",
    ]);
  });

  it("refuses an empty message without a round trip", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("radio", { name: /something is broken/i }));
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
    expect(await screen.findByTestId("feedback-error")).toBeTruthy();
    expect(mockSubmitFeedback).not.toHaveBeenCalled();
  });

  it("shows the reader their own status, and nothing else", async () => {
    renderScreen();
    expect(await screen.findByText("Something is broken")).toBeTruthy();
    expect(screen.getByText("Received")).toBeTruthy();
    // The server does not grant the message or the moderator's note.
    expect(document.body.textContent).not.toMatch(/admin_note|technical_context/);
  });

  it("says thanks only after the server confirmed it", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("radio", { name: /something is broken/i }));
    fireEvent.change(screen.getByLabelText(/tell us what happened/i), {
      target: { value: "The map does not load." },
    });
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
    expect(await screen.findByTestId("feedback-notice")).toBeTruthy();
  });

  it("shows a refusal as a sentence", async () => {
    mockSubmitFeedback.mockRejectedValue(new Error("boom"));
    renderScreen();
    fireEvent.click(screen.getByRole("radio", { name: /something is broken/i }));
    fireEvent.change(screen.getByLabelText(/tell us what happened/i), {
      target: { value: "The map does not load." },
    });
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));
    await waitFor(() => expect(screen.getByTestId("feedback-error")).toBeTruthy());
    expect(screen.queryByTestId("feedback-notice")).toBeNull();
  });

  it("says plainly that sending is not in this build when the server has no such function", async () => {
    mockSubmitFeedback.mockRejectedValue(new ApiError("Could not find the function", 500, "PGRST202"));
    renderScreen();
    fireEvent.click(screen.getByRole("radio", { name: /something is broken/i }));
    fireEvent.change(screen.getByLabelText(/tell us what happened/i), {
      target: { value: "The map does not load." },
    });
    fireEvent.click(screen.getByRole("button", { name: /send feedback/i }));

    const error = await screen.findByTestId("feedback-error");
    expect(error.textContent).toMatch(/not available in this build/i);
    expect(error.textContent).not.toMatch(/PGRST202|schema/i);
    // No fake success.
    expect(screen.queryByTestId("feedback-notice")).toBeNull();
  });
});
