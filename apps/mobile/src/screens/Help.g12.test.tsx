// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Help, refuseHelpSend } from "./Help";
import { updateAiPreferences } from "../services/ai/aiPreferences";
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
  displayName: "Free test chat",
  qualifiedRoles: ["chat"],
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
  displayName: "Groq test chat",
};

const OPENAI_UNKNOWN_ROW: ModelRecord = {
  provider: "openai",
  id: "openai",
  displayName: "OpenAI test chat",
  qualifiedRoles: ["chat"],
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
  displayName: "Groq paid test chat",
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

async function pickRow(row: ModelRecord) {
  fireEvent.click(screen.getByRole("button", { name: /choose model/i }));
  // Await this qualified fixture, not an index in the cold seed or a
  // duplicate Chat/Vision listing of another model.
  const title = await screen.findByText(row.displayName!);
  fireEvent.click(within(title.closest("li")!).getByRole("button", { name: /^select$/i }));
}

describe("refuseHelpSend gate (G12)", () => {
  it("lets a free row through in auto mode", () => {
    expect(
      refuseHelpSend({ provider: "openrouter", record: FREE_ROW, mode: "auto", hasImages: false }),
    ).toBeNull();
  });

  it("does not infer chat qualification from text input/output and a free price", () => {
    expect(refuseHelpSend({
      provider: "openrouter", record: { ...FREE_ROW, qualifiedRoles: undefined },
      mode: "auto", hasImages: false,
    })).toMatch(/not qualified.*draft is kept/i);
  });

  it("refuses an image for a chat-only cloud row without inventing vision qualification", () => {
    expect(refuseHelpSend({
      provider: "openrouter", record: FREE_ROW, mode: "auto", hasImages: true,
    })).toMatch(/not qualified.*draft is kept/i);
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
    ).toMatch(/requires the android app/i);
  });

  it("never sends paid or unknown-price rows silently", () => {
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
    // OpenAI is an ordinary BYOK provider: its unknown-price row is gated too.
    expect(
      refuseHelpSend({ provider: "openai", record: OPENAI_UNKNOWN_ROW, mode: "auto", hasImages: false }),
    ).toMatch(/unknown is never treated as free/i);
  });
});

describe("Help G12 per-send binding", () => {
  it("revoking experimental opt-in disables an already-picked remote model before any key read", async () => {
    localStorage.setItem("findback.ai.experimentalProviders.v1.u-g12", "true");
    const getKey = vi.fn(async () => "forbidden");
    renderHelp({ getKey, listCatalog: async () => [FREE_ROW, GROQ_FREE_ROW], createAdapter: () => cannedAdapter("must not send") });
    await pickRow(GROQ_FREE_ROW);
    localStorage.setItem("findback.ai.experimentalProviders.v1.u-g12", "false");
    send("Private text");
    await screen.findByText(/experimental provider is disabled/i);
    expect(getKey).not.toHaveBeenCalled();
  });

  it("Help hides unproven remote picker rows when experimental providers are off", async () => {
    renderHelp({ listCatalog: async () => [FREE_ROW, GROQ_FREE_ROW] });
    fireEvent.click(screen.getByRole("button", { name: /choose model/i }));
    await screen.findByText(FREE_ROW.displayName!);
    expect(screen.queryByText("groq/free-row")).toBeNull();
    expect(screen.queryByText(GROQ_FREE_ROW.displayName!)).toBeNull();
    expect(screen.getByText("openrouter/free")).toBeTruthy();
  });
  it("a persisted paid model cannot bypass catalogue/price checks when the picker never opened", async () => {
    localStorage.setItem("findback.ai.experimentalProviders.v1.u-g12", "true");
    updateAiPreferences("u-g12", { assistantMode: "cloud-only", preferredAssistantModel: PAID_ROW.id });
    const getKey = vi.fn(async () => "must not read");
    renderHelp({ getKey, createAdapter: () => cannedAdapter("must never send"), listCatalog: async () => [FREE_ROW, PAID_ROW] });
    send("Hello?");
    await screen.findByText(/needs explicit per-model/i);
    expect(getKey).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Ask the Help & FAQ")).toHaveProperty("value", "Hello?");
  });
  it("sends a non-openrouter row with that row's provider and model (never the stale openrouter hardwire)", async () => {
    localStorage.setItem("findback.ai.experimentalProviders.v1.u-g12", "true");
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
    await pickRow(GROQ_FREE_ROW);
    expect(screen.getByRole("button", { name: /choose model/i }).textContent).toContain(GROQ_FREE_ROW.displayName!);
    send("Hello groq?");
    await screen.findByText("Groq says hi.");
    expect(seen.length).toBe(1);
    expect(JSON.stringify(seen.at(0) ?? {})).toContain("groq/free-row");
    expect(JSON.stringify(seen.at(0) ?? {})).toContain('"provider":"groq"');
  });

  it("offline-only mode fails closed with no network for cloud rows", async () => {
    // Automatic may give supported built-in app help; this test explicitly
    // pins the cloud row so the privacy gate, not built-in routing, owns it.
    updateAiPreferences("u-g12", { assistantMode: "on-device-only", preferredAssistantModel: FREE_ROW.id });
    const getKey = vi.fn(async () => "test-key");
    const adapter = cannedAdapter("must never send");
    const complete = vi.spyOn(adapter, "complete");
    renderHelp({
      createAdapter: () => adapter,
      getKey,
      listCatalog: async () => [FREE_ROW],
    });
    send("Hello?");
    await screen.findByText(/offline-only mode is on/i);
    expect(screen.queryByText("must never send")).toBeNull();
    expect(getKey).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    // The draft is kept for Retry.
    expect(screen.getByLabelText("Ask the Help & FAQ")).toHaveProperty("value", "Hello?");
  });
});
