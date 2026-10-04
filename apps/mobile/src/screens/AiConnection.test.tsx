// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const mocks = vi.hoisted(() => ({
  validateKey: vi.fn(async () => ({ remaining: 3 })),
  connect: vi.fn(async () => {}),
  get: vi.fn(async () => null as string | null),
  hasSaved: vi.fn(async () => false),
  unlock: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  currentUserId: "user-1" as string | null,
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: mocks.currentUserId ? { id: mocks.currentUserId } : null }) }));
vi.mock("../services/aiCredentials", () => ({ aiCredentials: mocks }));
vi.mock("../services/openRouter", () => ({
  createOpenRouterClient: () => ({ validateKey: mocks.validateKey }),
}));

import { AiConnection } from "./AiConnection";

describe("AI connection", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.currentUserId = "user-1"; });
  afterEach(cleanup);

  it("validates then connects a user key with browser remember opt-in", async () => {
    render(<MemoryRouter><AiConnection /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("OpenRouter API key"), { target: { value: "sample-user-key" } });
    fireEvent.click(screen.getByLabelText("Remember on this device"));
    fireEvent.change(screen.getByLabelText("Unlock phrase"), { target: { value: "strong unlock phrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledWith("user-1", "sample-user-key", {
      remember: true, passphrase: "strong unlock phrase",
    }));
    expect(mocks.validateKey).toHaveBeenCalledWith("sample-user-key");
    expect(screen.getByRole("status").textContent).toContain("Connected");
    expect(screen.queryByText("sample-user-key")).toBeNull();
    expect(screen.queryByLabelText(/model/i)).toBeNull();
  });

  it("removes a saved key without requiring a model selection", async () => {
    mocks.get.mockResolvedValueOnce("a-key");
    render(<MemoryRouter><AiConnection /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Connected"));
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("user-1"));
    expect(screen.getByRole("status").textContent).toContain("Disconnected");
  });

  it("shows only a masked fingerprint and never the raw key", async () => {
    mocks.get.mockResolvedValue("sk-or-v1-abcdefgh1234");
    render(<MemoryRouter><AiConnection /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("••••1234"));
    expect(document.body.textContent).not.toContain("sk-or-v1-abcdefgh1234");
    expect(screen.queryByLabelText(/model/i)).toBeNull();
  });

  it("scopes connection state to the signed-in user and resets on account switch", async () => {
    mocks.get.mockImplementation((async (userId: string) => (userId === "user-1" ? "user-1-key" : null)) as never);
    const view = render(<MemoryRouter><AiConnection /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Connected"));
    mocks.currentUserId = "user-2";
    view.rerender(<MemoryRouter><AiConnection /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Disconnected"));
    expect(mocks.get).toHaveBeenCalledWith("user-2");
  });
});

describe("AiConnection motion (Wave E)", () => {  beforeEach(() => { vi.clearAllMocks(); mocks.currentUserId = "user-1"; });
  afterEach(cleanup);

  it("rises a failure notice in and settles it fully visible", async () => {
    mocks.validateKey.mockRejectedValueOnce(new Error("That key was rejected."));
    render(<MemoryRouter><AiConnection /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("OpenRouter API key"), { target: { value: "bad-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That key was rejected.");
    // Enters hidden, then settles — no instant pop-in over the form.
    await waitFor(() => expect(alert.style.opacity).toBe("1"), { timeout: 2000 });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("clears the notice when the next attempt starts", async () => {
    mocks.validateKey.mockRejectedValueOnce(new Error("That key was rejected."));
    render(<MemoryRouter><AiConnection /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("OpenRouter API key"), { target: { value: "bad-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("alert");
    // Second attempt: the notice leaves with its exit animation, not a snap.
    mocks.validateKey.mockResolvedValueOnce({ remaining: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitForElementToBeRemoved(() => screen.queryByRole("alert"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Connected"));
  });
});

describe("AiConnection normal tier", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.currentUserId = "user-1"; });
  afterEach(cleanup);

  it("keeps engineering copy off the cloud connections screen", async () => {
    const view = render(<MemoryRouter><AiConnection /></MemoryRouter>);
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    await screen.findByText(/cloud connections/i);
    const text = (view.container.textContent ?? "").toLowerCase();
    for (const term of [
      "checksum",
      "runtime",
      "backend",
      "transport",
      "schema",
      "device_required",
      "challenger",
      "fresh passing measurement",
      "device required",
    ]) {
      expect(text).not.toContain(term);
    }
    expect(text).not.toMatch(/[0-9a-f]{16,}/);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});
