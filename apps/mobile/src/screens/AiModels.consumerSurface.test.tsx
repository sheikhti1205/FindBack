// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "tester" } }),
}));

vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));

import { AiModels } from "./AiModels";
import type { ModelRecord } from "../services/ai/providerContract";

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

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function renderModels() {
  localStorage.setItem("findback.ai.experimentalProviders.v1.u1", "true");
  return render(
    <MemoryRouter>
      <AiModels accountId="u1" listCatalog={async () => [FREE_ROW]} />
    </MemoryRouter>,
  );
}

/** Dev strings that must live inside <details> (Advanced), never on the ordinary surface. */
const DEV_PATTERNS: RegExp[] = [
  /Needle/,
  /SmolVLM2/,
  /structured item records/,
  /pricing can be verified/,
  // Endpoint block detail (the "Custom endpoint" provider row title itself
  // stays ordinary as navigation; every detail line lives in Advanced).
  /Endpoint: /,
  /No endpoint/,
  /Endpoint base URL/,
  /Save endpoint/,
  /Update endpoint/,
  /Remove endpoint/,
  /Experimental providers/,
  /free-only/,
  /vision-capable/,
  /Default route/,
  /GPU: /,
  /Automatic: /,
];

describe("AiModels consumer surface", () => {
  it("keeps the Settings sticky chrome present and persistent (parity with SettingsPage)", async () => {
    const { container } = renderModels();
    const sticky = container.querySelector(".fb-settings-sticky");
    expect(sticky).toBeTruthy();
    const h1 = sticky?.querySelector("h1");
    expect(h1?.textContent).toMatch(/AI & Models/);
    // h1 truncation/focus-management parity: single-line ellipsis + tab stop.
    expect(h1?.getAttribute("tabindex")).toBe("-1");
    // Persists across async catalogue/provider hydration.
    await screen.findByTestId("ai-provider-openrouter");
    expect(container.querySelector(".fb-settings-sticky")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: /AI & Models/ })).toBeTruthy();
  });

  it("is list-first: no card chrome on rows or option lists", async () => {
    const { container } = renderModels();
    await screen.findByTestId("ai-provider-openrouter");
    // No settings card containers anywhere on this screen.
    expect(container.querySelectorAll(".fb-settings-group-card").length).toBe(0);
    // Assistant-mode options are separator rows, not cards.
    const options = Array.from(container.querySelectorAll(".fb-ai-mode-option"));
    expect(options.length).toBe(3);
    for (const option of options) {
      expect(option.className).not.toMatch(/rounded-m3-sm/);
      expect(option.className).not.toMatch(/border-outline-variant.*p-3/);
    }
    // Provider rows carry separators (border-t), never card borders.
    const provider = container.querySelector('[data-testid="ai-provider-openrouter"]');
    expect(provider?.className).toMatch(/border-t/);
    expect(provider?.className).not.toMatch(/rounded-m3-sm/);
  });

  it("keeps dev strings behind AdvancedDisclosure (ordinary surface is consumer-only)", async () => {
    const { container } = renderModels();
    await screen.findByTestId("ai-provider-openrouter");
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("details").forEach((d) => d.remove());
    const ordinary = clone.textContent ?? "";
    for (const pattern of DEV_PATTERNS) {
      expect(ordinary, `ordinary surface should not contain ${pattern}`).not.toMatch(pattern);
    }
    // Sanity: the detail is still reachable behind Advanced, not deleted.
    const advanced = Array.from(container.querySelectorAll("details"))
      .map((d) => d.textContent ?? "")
      .join("\n");
    expect(advanced).toMatch(/Needle/);
    expect(advanced).toMatch(/SmolVLM2/);
    expect(advanced).toMatch(/endpoint/i);
  });

  it("supports arrow/Home/End keys on the assistant-mode radiogroup with roving tabindex", async () => {
    renderModels();
    await screen.findByTestId("ai-provider-openrouter");
    const auto = screen.getByRole("radio", { name: /automatic/i });
    const onDevice = screen.getByRole("radio", { name: /on-device only/i });
    const cloud = screen.getByRole("radio", { name: /cloud only/i });
    // Roving tabindex: only the checked option is a tab stop.
    expect(auto.getAttribute("tabindex")).toBe("0");
    expect(onDevice.getAttribute("tabindex")).toBe("-1");
    expect(cloud.getAttribute("tabindex")).toBe("-1");

    auto.focus();
    fireEvent.keyDown(auto, { key: "ArrowDown" });
    expect(onDevice.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(onDevice);
    expect(auto.getAttribute("tabindex")).toBe("-1");
    expect(onDevice.getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(onDevice, { key: "ArrowUp" });
    expect(auto.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(auto);

    fireEvent.keyDown(auto, { key: "End" });
    expect(cloud.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(cloud);

    fireEvent.keyDown(cloud, { key: "Home" });
    expect(auto.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(auto);
  });

  it("exposes a forced-colors rule for the checked assistant-mode option", () => {
    const cssPath = path.resolve(__dirname, "../components/settings/settings.css");
    const css = fs.readFileSync(cssPath, "utf8");
    expect(css).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    const block = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(block).toMatch(/\.fb-ai-mode-option\[data-checked="true"\]/);
    expect(block).toMatch(/Highlight/);
  });

  it("returns focus to the invoker on unmount (SettingsPage focus return)", async () => {
    const { rerender } = render(
      <MemoryRouter>
        <div>
          <button type="button" id="focus-invoker">open settings</button>
        </div>
      </MemoryRouter>,
    );
    const invoker = document.getElementById("focus-invoker") as HTMLButtonElement;
    invoker.focus();
    expect(document.activeElement).toBe(invoker);
    // Entering the page moves focus to its h1; leaving hands it back.
    rerender(
      <MemoryRouter>
        <div>
          <button type="button" id="focus-invoker">open settings</button>
          <AiModels accountId="u1" listCatalog={async () => []} />
        </div>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(document.activeElement?.tagName.toLowerCase()).toBe("h1"),
    );
    rerender(
      <MemoryRouter>
        <div>
          <button type="button" id="focus-invoker">open settings</button>
        </div>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(document.getElementById("focus-invoker")).toBe(document.activeElement),
    );
  });
});
