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
import { aiPreferencesKey, loadAiPreferences, updateAiPreferences } from "../services/ai/aiPreferences";
import type { ModelRecord } from "../services/ai/providerContract";

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

describe("AiConnection persistent Assistant default (Lane A)", () => {
  const freeRow: ModelRecord = {
    provider: "openrouter",
    id: "openrouter/free-a",
    input: ["text"],
    output: ["text"],
    prices: [
      { amountDecimal: "0", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
      { amountDecimal: "0", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
    ],
    priceClass: "free",
    retrievedAt: "2026-09-26T00:00:00.000Z",
    entitlement: "untested",
  };
  const retrievedAt = "2026-09-26T00:00:00.000Z";
  beforeEach(() => { vi.clearAllMocks(); mocks.currentUserId = "user-1"; window.localStorage.clear(); });
  afterEach(() => { cleanup(); window.localStorage.clear(); });

  it("persists a permitted free-model choice to exactly that account's Assistant default", () => {
    render(<MemoryRouter><AiConnection models={[freeRow]} modelsRetrievedAt={retrievedAt} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(loadAiPreferences("user-1").preferredAssistantModel).toBe("openrouter/free-a");
    // Never crosses accounts: the storage key is per account.
    expect(window.localStorage.getItem(aiPreferencesKey("user-2"))).toBeNull();
    expect(loadAiPreferences("user-2").preferredAssistantModel).toBeNull();
  });

  it("reads back the persisted default as the selected row and isolates accounts", () => {
    updateAiPreferences("user-1", { preferredAssistantModel: "openrouter/free-a" });
    const view = render(<MemoryRouter><AiConnection models={[freeRow]} modelsRetrievedAt={retrievedAt} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "Selected" }).getAttribute("aria-pressed")).toBe("true");
    mocks.currentUserId = "user-2";
    view.rerender(<MemoryRouter><AiConnection models={[freeRow]} modelsRetrievedAt={retrievedAt} /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "Selected" })).toBeNull();
  });

  it("an explicit onSelectModel owns the choice: it is called and nothing is persisted here", () => {
    const onSelectModel = vi.fn();
    render(
      <MemoryRouter>
        <AiConnection models={[freeRow]} modelsRetrievedAt={retrievedAt} onSelectModel={onSelectModel} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(onSelectModel).toHaveBeenCalledWith("openrouter/free-a");
    expect(loadAiPreferences("user-1").preferredAssistantModel).toBeNull();
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
