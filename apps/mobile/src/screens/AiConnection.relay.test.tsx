// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ModelRecord } from "../services/ai/providerContract";

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

function freeRecord(id: string): ModelRecord {
  return {
    provider: "openrouter",
    id,
    input: ["text"],
    output: ["text"],
    contextTokens: 128_000,
    prices: [
      { amountDecimal: "0", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
      { amountDecimal: "0", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
    ],
    priceClass: "free",
    retrievedAt: "2026-09-26T00:00:00.000Z",
    entitlement: "untested",
  } as ModelRecord;
}

function renderWithCatalog(relayTest?: (input: {
  provider: "openai" | "deepseek";
  text: string;
  signal?: AbortSignal;
}) => Promise<{ text: string }>) {
  return render(
    <MemoryRouter>
      <AiConnection
        models={[freeRecord("openrouter/free-a")]}
        modelsRetrievedAt="2026-09-26T00:00:00.000Z"
        onSelectModel={() => {}}
        relayTest={relayTest}
      />
    </MemoryRouter>,
  );
}

describe("AiConnection server relay (AI-021)", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.currentUserId = "user-1"; });
  afterEach(cleanup);

  it("keeps the on-device blocked notice and offers the relay route beside it", () => {
    renderWithCatalog(async () => ({ text: "ok" }));
    expect(screen.getByText(/Direct OpenAI and DeepSeek connections are blocked/i)).toBeTruthy();
    expect(screen.getByText("OpenAI and DeepSeek through the server relay")).toBeTruthy();
    expect(screen.getByLabelText("Relay provider")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test relay" })).toBeTruthy();
  });

  it("tests the relay with provider + text only, then removes the result", async () => {
    const seen: Array<{ provider: string; text: string }> = [];
    renderWithCatalog(async (input) => {
      seen.push({ provider: input.provider, text: input.text });
      return { text: "ok" };
    });
    fireEvent.click(screen.getByRole("button", { name: "Test relay" }));
    await waitFor(() => expect(screen.getByText(/Relay ready for OpenAI/i)).toBeTruthy());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.provider).toBe("openai");
    expect(seen[0]?.text).toContain("ok");
    // No key material may travel with the probe the UI sends.
    expect(JSON.stringify(seen[0]).toLowerCase()).not.toContain("key");
    fireEvent.click(screen.getByRole("button", { name: "Remove relay" }));
    await waitFor(() => expect(screen.queryByText(/Relay ready for OpenAI/i)).toBeNull());
  });

  it("routes the probe to the selected relay provider", async () => {
    const seen: string[] = [];
    renderWithCatalog(async (input) => {
      seen.push(input.provider);
      return { text: "ok" };
    });
    fireEvent.change(screen.getByLabelText("Relay provider"), { target: { value: "deepseek" } });
    fireEvent.click(screen.getByRole("button", { name: "Test relay" }));
    await waitFor(() => expect(screen.getByText(/Relay ready for DeepSeek/i)).toBeTruthy());
    expect(seen).toEqual(["deepseek"]);
  });

  it("shows relay failures without touching the OpenRouter connection state", async () => {
    renderWithCatalog(async () => {
      throw new Error("The relay is unavailable right now. Try again later.");
    });
    fireEvent.click(screen.getByRole("button", { name: "Test relay" }));
    await waitFor(() => expect(screen.getByText(/relay is unavailable/i)).toBeTruthy());
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Disconnected");
  });
});
