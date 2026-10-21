// @vitest-environment jsdom
// Catalogue/price-consent tests moved to the cloud-only Models contract.
// Provider slot isolation remains here, without the retired Experimental gate.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
const vault = vi.hoisted(() => ({ connect: vi.fn(async () => {}), handles: vi.fn((accountId: string, provider: string) => ({ accountId, provider })), get: vi.fn(async () => null as string | null) }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "provider-user" } }) }));
vi.mock("../services/aiCredentials", () => ({ aiCredentials: { connect: vault.connect, credentialHandle: vault.handles, hasCredential: async () => false, hasSaved: async () => false, get: vault.get } }));
import { AiConnection } from "./AiConnection";
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
it.each(["openrouter", "openai", "anthropic", "google", "deepseek", "mistral", "groq", "xai", "cohere", "generic"] as const)("saves %s only to its account/provider vault slot", async (provider) => {
  render(<MemoryRouter initialEntries={[`/ai-connection?provider=${provider}`]}><AiConnection /></MemoryRouter>);
  const field = screen.getByLabelText(/API key$/);
  fireEvent.change(field, { target: { value: "synthetic-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  await waitFor(() => expect(vault.connect).toHaveBeenCalledWith("provider-user", "synthetic-test-key", { provider, remember: false }));
  expect(document.body.textContent).not.toContain("Experimental");
});
