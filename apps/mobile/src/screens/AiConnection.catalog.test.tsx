// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, waitForElementToBeRemoved, within } from "@testing-library/react";
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

function record(
  id: string,
  priceClass: ModelRecord["priceClass"],
  entitlement: ModelRecord["entitlement"] = "untested",
): ModelRecord {
  const prices =
    priceClass === "free"
      ? [
          { amountDecimal: "0", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
          { amountDecimal: "0", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
        ]
      : priceClass === "paid"
        ? [
            { amountDecimal: "0.000003", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
            { amountDecimal: "0.000015", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
          ]
        : [];
  return {
    provider: "openrouter",
    id,
    input: ["text"],
    output: ["text"],
    contextTokens: 128_000,
    prices,
    priceClass,
    retrievedAt: "2026-09-26T00:00:00.000Z",
    entitlement,
  } as ModelRecord;
}

const freeA = record("openrouter/free-a", "free");
const freeB = record("openrouter/free-b", "free");
const paidC = record("openrouter/paid-c", "paid");
const mysteryD = record("openrouter/mystery-d", "unknown");
const blockedE = record("openrouter/blocked-e", "free", "blocked");

describe("AiConnection catalogue (M2)", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.currentUserId = "user-1"; });
  afterEach(cleanup);

  it("fetches the catalogue at runtime and wires onSelect/selectedId live", async () => {
    const listModels = vi.fn(async () => [freeA, freeB]);
    const onSelectModel = vi.fn();
    render(
      <MemoryRouter>
        <AiConnection listModels={listModels} selectedId="openrouter/free-a" onSelectModel={onSelectModel} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("openrouter/free-a")).toBeTruthy();
    expect(await screen.findByText("openrouter/free-b")).toBeTruthy();
    // selectedId flows into the sheet as pressed state.
    const selected = await screen.findByRole("button", { name: "Selected" });
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    // Free model select forwards immediately.
    const rows = await screen.findAllByRole("button", { name: "Select" });
    fireEvent.click(rows[0]!);
    expect(onSelectModel).toHaveBeenCalledWith("openrouter/free-b");
  });

  it("search narrows the visible catalogue", async () => {
    render(
      <MemoryRouter>
        <AiConnection models={[freeA, freeB]} modelsRetrievedAt="2026-09-26T00:00:00.000Z" onSelectModel={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText("openrouter/free-a")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "free-b" } });
    // The filtered-out row leaves through its exit animation (Motion), so the
    // absence is awaited rather than asserted synchronously.
    await waitForElementToBeRemoved(() => screen.queryByText("openrouter/free-a"));
    expect(screen.getByText("openrouter/free-b")).toBeTruthy();
  });

  it("free-only guard: paid select opens consent, never selects silently", async () => {
    const onSelectModel = vi.fn();
    const onPaidConsent = vi.fn();
    render(
      <MemoryRouter>
        <AiConnection
          models={[freeA, paidC]}
          modelsRetrievedAt="2026-09-26T00:00:00.000Z"
          onSelectModel={onSelectModel}
          onPaidConsent={onPaidConsent}
        />
      </MemoryRouter>,
    );
    const paidRow = screen.getByText("openrouter/paid-c").closest("li")!;
    fireEvent.click(within(paidRow).getByRole("button", { name: "Select" }));
    // No silent selection…
    expect(onSelectModel).not.toHaveBeenCalled();
    // …explicit scoped consent panel instead.
    expect(screen.getByLabelText("Paid model consent")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("I accept these exact charges for general chat"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and select" }));
    expect(onPaidConsent).toHaveBeenCalledTimes(1);
    const consent = onPaidConsent.mock.calls[0]![0];
    expect(consent.modelId).toBe("openrouter/paid-c");
    expect(consent.taskScopes).toEqual(["general"]);
    expect(onSelectModel).toHaveBeenCalledWith("openrouter/paid-c");
  });

  it("unknown-price models are never selectable", async () => {
    const onSelectModel = vi.fn();
    render(
      <MemoryRouter>
        <AiConnection
          models={[freeA, mysteryD]}
          modelsRetrievedAt="2026-09-26T00:00:00.000Z"
          onSelectModel={onSelectModel}
        />
      </MemoryRouter>,
    );
    const row = screen.getByText("openrouter/mystery-d").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Select" }));
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/unknown/i);
  });

  it("blocked-entitlement models are never selectable", async () => {
    const onSelectModel = vi.fn();
    render(
      <MemoryRouter>
        <AiConnection
          models={[freeA, blockedE]}
          modelsRetrievedAt="2026-09-26T00:00:00.000Z"
          onSelectModel={onSelectModel}
        />
      </MemoryRouter>,
    );
    const row = screen.getByText("openrouter/blocked-e").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Select" }));
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(within(row).getByText(/Not usable on this account/)).toBeTruthy();
  });

  it("states BYOK provider availability honestly", async () => {
    render(
      <MemoryRouter>
        <AiConnection models={[freeA]} modelsRetrievedAt="2026-09-26T00:00:00.000Z" onSelectModel={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Not yet tested on this account/i)).toBeTruthy();
    expect(screen.queryByText(/bring-your-own-key is supported/i)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Experimental providers" }));
    // Unproven adapters are only advertised after explicit opt-in.
    expect(screen.getAllByText(/bring-your-own-key is supported/i)).toHaveLength(4);
  });

  it("changed prices invalidate consent instead of reusing it", async () => {
    const onSelectModel = vi.fn();
    const view = render(
      <MemoryRouter>
        <AiConnection
          models={[paidC]}
          modelsRetrievedAt="2026-09-26T00:00:00.000Z"
          onSelectModel={onSelectModel}
          onPaidConsent={() => {}}
        />
      </MemoryRouter>,
    );
    const row = screen.getByText("openrouter/paid-c").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByLabelText("I accept these exact charges for general chat"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and select" }));
    expect(onSelectModel).toHaveBeenCalledWith("openrouter/paid-c");
    onSelectModel.mockClear();

    // Same model id, higher fee: consent must not carry over.
    const pricier: ModelRecord = {
      ...paidC,
      prices: [
        { amountDecimal: "0.000009", currency: "USD", unit: "token", dimension: "input", sourceField: "pricing.prompt" },
        { amountDecimal: "0.000015", currency: "USD", unit: "token", dimension: "output", sourceField: "pricing.completion" },
      ],
    };
    view.rerender(
      <MemoryRouter>
        <AiConnection
          models={[pricier]}
          modelsRetrievedAt="2026-09-26T01:00:00.000Z"
          onSelectModel={onSelectModel}
          onPaidConsent={() => {}}
        />
      </MemoryRouter>,
    );
    const row2 = screen.getByText("openrouter/paid-c").closest("li")!;
    fireEvent.click(within(row2).getByRole("button", { name: "Select" }));
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/price changed/i);
  });

  it("refresh refetches the catalogue (TTL path)", async () => {
    const listModels = vi.fn(async () => [freeA]);
    render(
      <MemoryRouter>
        <AiConnection listModels={listModels} onSelectModel={() => {}} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh catalogue" }));
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
  });
});

describe("AiConnection catalogue motion (Wave E)", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.currentUserId = "user-1"; });
  afterEach(cleanup);

  it("dismisses the paid-consent panel through its exit animation", async () => {
    render(
      <MemoryRouter>
        <AiConnection models={[paidC]} modelsRetrievedAt="2026-09-26T00:00:00.000Z" onSelectModel={() => {}} onPaidConsent={() => {}} />
      </MemoryRouter>,
    );
    const row = screen.getByText("openrouter/paid-c").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Select" }));
    expect(screen.getByLabelText("Paid model consent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitForElementToBeRemoved(() => screen.queryByLabelText("Paid model consent"));
    // The catalogue row behind it never moved on its own.
    expect(screen.getByText("openrouter/paid-c")).toBeTruthy();
  });
});
