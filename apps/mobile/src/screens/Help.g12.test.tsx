// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Help, refuseHelpSend } from "./Help";
import { assistantModeKey } from "./AiModels";
import { resetBackInterceptors } from "../components/backNavigation";
import type { ModelRecord, ProviderAdapter, StreamEvent } from "../services/ai/providerContract";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: "u-g12", username: "tester" } }),
}));

vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));

beforeAll(() => {
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  window.localStorage.clear();
  document.body.style.overflow = "";
});

const FREE_ROW: ModelRecord = {
  provider: "openrouter",
  id: "openrouter/free",
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

const GROQ_FREE_ROW: ModelRecord = {
  ...FREE_ROW,
  provider: "groq",
  id: "groq/free-row",
};

const RELAY_ROW: ModelRecord = {
  provider: "openai",
  id: "openai",
  input: ["text"],
  output: ["text"],
  prices: [],
  priceClass: "unknown",
  retrievedAt: "2026-09-26T00:00:00.000Z",
  entitlement: "untested",
};

const PAID_ROW: ModelRecord = {
  ...FREE_ROW,
  provider: "groq",
  id: "groq/paid-row",
  prices: [
    { amountDecimal: "0.5", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
  ],
  priceClass: "paid",
};

function cannedAdapter(answer: string): ProviderAdapter {
  return {
    id: "openrouter",
    capabilities: () => ({
      vision: { state: "known", value: true },
      maxImagesPerCall: { state: "known", value: 10 },
      contextTokens: { state: "unknown" },
      maxOutputTokens: { state: "unknown" },
      streaming: { state: "known", value: true },
    }),
    complete: async function* (): AsyncIterable<StreamEvent> {
      yield { kind: "text", attempt: 1, delta: answer };
      yield { kind: "done", attempt: 1, stopReason: "complete" };
    },
  };
}

function renderHelp(deps: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter initialEntries={["/help"]}>
      <Routes>
        <Route path="/help" element={<Help deps={deps} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function send(text: string) {
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
}

async function pickRow(index: number) {
  fireEvent.click(screen.getByRole("button", { name: /choose model/i }));
  // The picker opens on the pinned seed and expands to the authorized
  // catalogue: wait for the full row count, never the seed alone.
  await waitFor(async () => {
    const selects = await screen.findAllByRole("button", { name: /^select$/i });
    expect(selects.length).toBeGreaterThan(index);
  });
  const selects = await screen.findAllByRole("button", { name: /^select$/i });
  fireEvent.click(selects.at(index) as HTMLElement);
}

describe("refuseHelpSend gate (G12)", () => {
  it("lets a free row through in auto mode", () => {
    expect(
      refuseHelpSend({ provider: "openrouter", record: FREE_ROW, mode: "auto", hasImages: false }),
    ).toBeNull();
  });

  it("fails closed for cloud rows in offline-only mode", () => {
    const copy = refuseHelpSend({
      provider: "openrouter",
      record: FREE_ROW,
      mode: "offline-only",
      hasImages: false,
    });
    expect(copy).toMatch(/offline-only mode/i);
    expect(copy).toMatch(/not contacted/i);
  });

  it("refuses the on-device row in cloud-only mode and the unwired offline row everywhere", () => {
    expect(
      refuseHelpSend({ provider: "offline", record: null, mode: "cloud-only", hasImages: false }),
    ).toMatch(/cloud-only mode/i);
    expect(
      refuseHelpSend({ provider: "offline", record: null, mode: "auto", hasImages: false }),
    ).toMatch(/not available/i);
  });

  it("never sends paid or unknown-price rows silently (relay rows exempt from price gates)", () => {
    expect(
      refuseHelpSend({ provider: "groq", record: PAID_ROW, mode: "auto", hasImages: false }),
    ).toMatch(/consent/i);
    expect(
      refuseHelpSend({
        provider: "groq",
        record: { ...PAID_ROW, priceClass: "unknown", prices: [] },
        mode: "auto",
        hasImages: false,
      }),
    ).toMatch(/unknown is never treated as free/i);
    expect(
      refuseHelpSend({ provider: "openai", record: RELAY_ROW, mode: "auto", hasImages: false }),
    ).toBeNull();
  });

  it("keeps photos off the text-only relay", () => {
    expect(
      refuseHelpSend({ provider: "openai", record: RELAY_ROW, mode: "auto", hasImages: true }),
    ).toMatch(/text-only/i);
  });
});

describe("Help G12 per-send binding", () => {
  it("sends a non-openrouter row with that row's provider and model (never the stale openrouter hardwire)", async () => {
    const seen: unknown[] = [];
    const spy: ProviderAdapter = {
      ...cannedAdapter("Groq says hi."),
      complete: async function* (request): AsyncIterable<StreamEvent> {
        seen.push(request);
        yield { kind: "text", attempt: 1, delta: "Groq says hi." };
        yield { kind: "done", attempt: 1, stopReason: "complete" };
      },
    };
    renderHelp({
      createAdapter: () => spy,
      getKey: async () => "test-key",
      listCatalog: async () => [FREE_ROW, GROQ_FREE_ROW],
    });
    await pickRow(1);
    expect(screen.getByRole("button", { name: /choose model/i }).textContent).toMatch(/groq\/free-row/);
    send("Hello groq?");
    await screen.findByText("Groq says hi.");
    expect(seen.length).toBe(1);
    expect(JSON.stringify(seen.at(0) ?? {})).toContain("groq/free-row");
    expect(JSON.stringify(seen.at(0) ?? {})).toContain('"provider":"groq"');
  });

  it("routes relay rows through the keyless relay with conversation context", async () => {
    const relayChat = vi.fn(async () => ({ text: "Relay says hi." }));
    renderHelp({
      getKey: async () => "should-never-be-read-for-relay",
      listCatalog: async () => [FREE_ROW, RELAY_ROW],
      relayChat,
    });
    await pickRow(1);
    send("Hello relay?");
    await screen.findByText("Relay says hi.");
    expect(relayChat).toHaveBeenCalledTimes(1);
    const input = relayChat.mock.calls.at(0)?.at(0) as unknown as {
      provider: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(input.provider).toBe("openai");
    expect(input.messages.at(-1)).toMatchObject({ role: "user", content: "Hello relay?" });
  });

  it("offline-only mode fails closed with no network for cloud rows", async () => {
    window.localStorage.setItem(assistantModeKey("u-g12"), "offline-only");
    const relayChat = vi.fn(async () => ({ text: "must never send" }));
    renderHelp({
      createAdapter: () => cannedAdapter("must never send"),
      getKey: async () => "test-key",
      listCatalog: async () => [FREE_ROW],
      relayChat,
    });
    send("Hello?");
    await screen.findByText(/offline-only mode is on/i);
    expect(relayChat).not.toHaveBeenCalled();
    expect(screen.queryByText("must never send")).toBeNull();
    // The draft is kept for Retry.
    expect(screen.getByLabelText("Ask the Help & FAQ")).toHaveProperty("value", "Hello?");
  });
});
