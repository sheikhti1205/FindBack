// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ account: "account-a" as string | null, present: false, saved: false,
  connect: vi.fn(async () => {}), remove: vi.fn(async () => {}), unlock: vi.fn(async () => {}), validateKey: vi.fn(), get: vi.fn(),
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: state.account ? { id: state.account } : null }) }));
vi.mock("../services/aiCredentials", () => ({ aiCredentials: {
  hasCredential: async () => state.present, credentialHandle: (accountId: string, provider: string) => ({ accountId, provider }),
  hasSaved: async () => state.saved, connect: state.connect, remove: state.remove, unlock: state.unlock, get: state.get,
} }));
vi.mock("../services/openRouter", () => ({ createOpenRouterClient: () => ({ validateKey: state.validateKey }) }));
import { AiConnection } from "./AiConnection";
import { loadGenericEndpoint } from "../services/ai/genericEndpoint";
import { loadCloudModelPreferences } from "../services/ai/cloudModelPreferences";
beforeEach(() => { state.account = "account-a"; state.present = false; state.saved = false; vi.clearAllMocks(); });
afterEach(() => { cleanup(); localStorage.clear(); });
const tree = () => <MemoryRouter><AiConnection /></MemoryRouter>;
it("saves a key without contacting a provider or reading it back for display", async () => {
  render(tree());
  fireEvent.change(screen.getByLabelText("OpenRouter API key"), { target: { value: "synthetic-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  await waitFor(() => expect(state.connect).toHaveBeenCalledWith("account-a", "synthetic-test-key", { provider: "openrouter", remember: false }));
  expect(screen.getByLabelText("OpenRouter API key")).toHaveProperty("value", "");
  expect(document.body.textContent).not.toContain("synthetic-test-key");
  expect(state.validateKey).not.toHaveBeenCalled();
});
it("shows only a masked tail for a saved key, never the key itself", async () => {
  state.present = true; state.saved = true;
  state.get.mockResolvedValue("sk-or-v1-abcdefgh1234");
  render(tree());
  await screen.findByText("Key saved · ••••1234");
  expect(document.body.textContent).not.toContain("sk-or-v1-abcdefgh1234");
});
it("deletes a saved key and keeps a masked saved state", async () => {
  state.present = true; state.saved = true;
  render(tree());
  await screen.findByText(/Key saved/);
  fireEvent.click(screen.getByRole("button", { name: "Delete key" }));
  await waitFor(() => expect(state.remove).toHaveBeenCalledWith("account-a", "openrouter"));
  await screen.findByText("No key saved");
});
it("does not paint a pending save into the next account", async () => {
  let resolve!: () => void;
  state.connect.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
  const view = render(tree());
  fireEvent.change(screen.getByLabelText("OpenRouter API key"), { target: { value: "synthetic-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  state.account = "account-b"; view.rerender(tree());
  await act(async () => { resolve(); });
  expect(screen.getByLabelText("OpenRouter API key")).toHaveProperty("value", "");
  await screen.findByText("No key saved");
  expect(screen.queryByText(/Key saved/)).toBeNull();
});
it("validates and saves the generic endpoint locally under Advanced", async () => {
  render(tree());
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "generic" } });
  fireEvent.click(screen.getByText("Advanced"));
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://example.test/v1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save base URL" }));
  expect(loadGenericEndpoint("account-a")).toBeNull();
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://example.test/v1/" } });
  fireEvent.click(screen.getByRole("button", { name: "Save base URL" }));
  expect(loadGenericEndpoint("account-a")).toBe("https://example.test/v1");
  expect(loadGenericEndpoint("account-b")).toBeNull();
  expect(state.validateKey).not.toHaveBeenCalled();
});
it("uses concise fixed failure copy instead of rendering an exception that could contain a key", async () => {
  state.connect.mockRejectedValueOnce(new Error("unsafe synthetic-test-key"));
  render(tree());
  fireEvent.change(screen.getByLabelText("OpenRouter API key"), { target: { value: "synthetic-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Couldn’t save the key. Check your storage or unlock phrase and try again.");
  expect(document.body.textContent).not.toContain("unsafe");
});
it("saves a manual model ID for the generic provider as the account default", async () => {
  render(tree());
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "generic" } });
  fireEvent.click(screen.getByText("Advanced"));
  fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "custom/chat" } });
  fireEvent.click(screen.getByRole("button", { name: "Save model ID" }));
  expect(loadCloudModelPreferences("account-a").defaultModel).toEqual({ provider: "generic", modelId: "custom/chat" });
  expect(loadCloudModelPreferences("account-b").defaultModel).toBeNull();
});
