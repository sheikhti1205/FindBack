// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "tester" } }),
}));

vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));

import { AiModels } from "./AiModels";
import { aiCredentials } from "../services/aiCredentials";
import { loadGenericEndpoint } from "../services/ai/genericEndpoint";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  aiCredentials.clearSession();
  vi.unstubAllGlobals();
});

function renderModels(accountId: string) {
  return render(
    <MemoryRouter>
      <AiModels accountId={accountId} listCatalog={async () => []} />
    </MemoryRouter>,
  );
}

describe("AiModels generic endpoint configuration", () => {
  it("shows the missing-endpoint explanation and HTTP policy with no endpoint set", async () => {
    renderModels("uig-missing");
    const card = await screen.findByTestId("ai-provider-generic");
    expect(card.textContent).toMatch(/no endpoint set/i);
    expect(card.textContent).toMatch(/no default endpoint is assumed/i);
    expect(card.textContent).toMatch(/https is required/i);
  });

  it("saves, edits, and removes the endpoint scoped to the account", async () => {
    renderModels("uig-crud");
    const card = await screen.findByTestId("ai-provider-generic");
    const input = within(card).getByLabelText(/endpoint base url/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://one.example.com/v1/" } });
    fireEvent.click(within(card).getByRole("button", { name: /save endpoint/i }));
    await waitFor(() =>
      expect(card.textContent).toMatch(/endpoint saved: https:\/\/one\.example\.com\/v1/i),
    );
    expect(loadGenericEndpoint("uig-crud")).toBe("https://one.example.com/v1");
    expect(loadGenericEndpoint("uig-other")).toBeNull();

    // Editing = update to a new value through the same field.
    fireEvent.change(within(card).getByLabelText(/endpoint base url/i), {
      target: { value: "http://localhost:11434/v1" },
    });
    fireEvent.click(within(card).getByRole("button", { name: /update endpoint/i }));
    await waitFor(() =>
      expect(card.textContent).toMatch(/plain http on a loopback host/i),
    );
    expect(loadGenericEndpoint("uig-crud")).toBe("http://localhost:11434/v1");

    fireEvent.click(within(card).getByRole("button", { name: /remove endpoint/i }));
    await waitFor(() => expect(card.textContent).toMatch(/no endpoint is set/i));
    expect(loadGenericEndpoint("uig-crud")).toBeNull();
  });

  it("rejects a non-loopback http endpoint visibly and persists nothing", async () => {
    renderModels("uig-http");
    const card = await screen.findByTestId("ai-provider-generic");
    fireEvent.change(within(card).getByLabelText(/endpoint base url/i), {
      target: { value: "http://api.example.com/v1" },
    });
    fireEvent.click(within(card).getByRole("button", { name: /save endpoint/i }));
    await waitFor(() =>
      expect(card.textContent).toMatch(/plain http is rejected for non-loopback/i),
    );
    expect(loadGenericEndpoint("uig-http")).toBeNull();
  });

  it("warns visibly when a generic key exists without an endpoint", async () => {
    await aiCredentials.connect("uig-keyonly", "generic-key-material", {
      remember: false,
      provider: "generic",
    });
    renderModels("uig-keyonly");
    const card = await screen.findByTestId("ai-provider-generic");
    await waitFor(() => expect(card.textContent).toMatch(/connected/i));
    const alert = within(card).getByRole("alert");
    expect(alert.textContent).toMatch(/cannot be used: no endpoint is configured/i);
  });

  it("explains the missing endpoint on test instead of sending anything", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    renderModels("uig-test-missing");
    const card = await screen.findByTestId("ai-provider-generic");
    fireEvent.click(within(card).getByRole("button", { name: /^test$/i }));
    await waitFor(() =>
      expect(card.textContent).toMatch(/without an endpoint is unusable/i),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tests against the configured URL", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      (async (url: unknown) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ data: [{ id: "custom-model" }] }), {
          status: 200,
        });
      }) as typeof fetch,
    );
    renderModels("uig-test-ok");
    const card = await screen.findByTestId("ai-provider-generic");
    fireEvent.change(within(card).getByLabelText(/endpoint base url/i), {
      target: { value: "https://custom.example.com/v1" },
    });
    fireEvent.click(within(card).getByRole("button", { name: /save endpoint/i }));
    await waitFor(() => expect(loadGenericEndpoint("uig-test-ok")).not.toBeNull());
    fireEvent.click(within(card).getByRole("button", { name: /^test$/i }));
    await waitFor(() =>
      expect(card.textContent).toMatch(/answered and listed 1 model/i),
    );
    expect(seen).toEqual(["https://custom.example.com/v1/models"]);
  });
});
