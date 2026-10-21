// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { CloudModels, MODEL_LIST_TIMEOUT_MS } from "./CloudModels";
import { loadCloudModelPreferences } from "../services/ai/cloudModelPreferences";
import type { ModelRecord } from "../services/ai/providerContract";
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "models-user" } }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });
const rows: ModelRecord[] = [{ provider: "deepseek", id: "chat-id", displayName: "Chat model", input: ["text"], output: ["text"], prices: [], priceClass: "unknown", retrievedAt: "2026-10-21", entitlement: "untested" }];
const openRouterRows: ModelRecord[] = [{ provider: "openrouter", id: "router/chat", displayName: "Router model", input: ["text"], output: ["text"], prices: [], priceClass: "unknown", retrievedAt: "2026-10-21", entitlement: "untested" }];
/** The legacy preference field stores a bare model id with no provider. */
function seedLegacyModelId(id: string) {
  globalThis.localStorage.setItem(
    "findback.ai.preferences.v1.models-user",
    JSON.stringify({ preferredAssistantModel: id }),
  );
}
it("loads provider models, filters, favorites and saves a default without price gates", async () => {
  render(<MemoryRouter><CloudModels listModels={async () => rows} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "deepseek" } });
  await screen.findByText("Chat model");
  fireEvent.click(screen.getByRole("button", { name: "Favorite Chat model" }));
  fireEvent.click(screen.getByRole("button", { name: "Set Chat model as default" }));
  expect(loadCloudModelPreferences("models-user")).toMatchObject({ defaultModel: { provider: "deepseek", modelId: "chat-id" }, favorites: [{ provider: "deepseek", modelId: "chat-id" }] });
  fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "no match" } });
  expect(screen.queryByText("Chat model")).toBeNull();
});
it("saves a manual model for the selected provider when listing is unavailable", async () => {
  render(<MemoryRouter><CloudModels listModels={async () => { throw new Error("raw unsafe provider error"); }} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "generic" } });
  fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "custom/chat" } });
  fireEvent.click(screen.getByRole("button", { name: "Use model" }));
  expect(loadCloudModelPreferences("models-user").defaultModel).toEqual({ provider: "generic", modelId: "custom/chat" });
  await waitFor(() => expect(screen.getByTestId("cloudmodels-status").textContent).not.toMatch(/Loading/));
  expect(document.body.textContent).not.toContain("raw unsafe");
});
it("gives up on a provider that never answers and leaves Refresh usable", async () => {
  // A hung provider must not strand this screen on "Loading models…".
  vi.useFakeTimers();
  render(<MemoryRouter><CloudModels listModels={() => new Promise(() => {})} /></MemoryRouter>);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(MODEL_LIST_TIMEOUT_MS + 100);
  });
  expect(screen.getByTestId("cloudmodels-status").textContent).toMatch(/didn’t answer in time/i);
  expect(screen.getByTestId("cloudmodels-status").textContent).not.toMatch(/Loading models/i);
  const refresh = screen.getByRole("button", { name: /refresh/i });
  expect(refresh.hasAttribute("disabled")).toBe(false);
});
it("re-issues the model list when Refresh is used", async () => {
  const list = vi.fn(async () => openRouterRows);
  render(<MemoryRouter><CloudModels listModels={list} /></MemoryRouter>);
  await screen.findByText("Router model");
  expect(list).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("Router model")).toBeTruthy();
});
it("moves the provider to a legacy default that the catalogue resolves", async () => {
  // The legacy field holds a bare id; only the catalogue can say which
  // provider owns it. The picker must land on that provider, not hide the
  // default behind another one.
  seedLegacyModelId("chat-id");
  render(<MemoryRouter><CloudModels listModels={async () => rows} /></MemoryRouter>);
  await waitFor(() => expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("deepseek"));
  expect(await screen.findByText("Chat model")).toBeTruthy();
  expect(screen.getByText("Chat model").closest("li")?.textContent).toMatch(/Default/);
});
it("keeps a provider's own choice when the reader picks a provider first", async () => {
  seedLegacyModelId("chat-id");
  render(<MemoryRouter><CloudModels listModels={async () => rows} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "mistral" } });
  await waitFor(() => expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("mistral"));
  expect(screen.queryByText(/couldn’t be matched to a provider/i)).toBeNull();
});
it("tells the reader when a previous model could not be matched to a provider", async () => {
  // No catalogue row carries this id, and no provider may be guessed: the
  // choice must be surfaced, never silently dropped.
  seedLegacyModelId("claude-3-5-sonnet");
  render(<MemoryRouter><CloudModels listModels={async () => rows} /></MemoryRouter>);
  const note = await screen.findByTestId("cloudmodels-pending");
  expect(note.textContent).toMatch(/couldn’t be matched to a provider/i);
  expect(note.textContent).toContain("claude-3-5-sonnet");
});
it("does not claim the catalogue rejected an id when the list never loaded", async () => {
  // A failed load proves nothing about the id: the copy must say so.
  seedLegacyModelId("claude-3-5-sonnet");
  render(<MemoryRouter><CloudModels listModels={async () => { throw new Error("no catalogue"); }} /></MemoryRouter>);
  const note = await screen.findByTestId("cloudmodels-pending");
  await waitFor(() => expect(note.textContent).toMatch(/still saved/i));
  expect(note.textContent).not.toMatch(/couldn’t be matched/i);
});
it("clears the pending note once a default model is saved", async () => {
  seedLegacyModelId("claude-3-5-sonnet");
  render(<MemoryRouter><CloudModels listModels={async () => rows} /></MemoryRouter>);
  await waitFor(() => expect(screen.getByTestId("cloudmodels-pending").textContent).toMatch(/couldn’t be matched/i));
  fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "manual/chat" } });
  fireEvent.click(screen.getByRole("button", { name: "Use model" }));
  await waitFor(() => expect(screen.getByTestId("cloudmodels-pending").textContent).toBe(""));
});
