// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, it, vi } from "vitest";
import { expect } from "vitest";
import { Help } from "./Help";
import { resetBackInterceptors } from "../components/backNavigation";

vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u-closure", username: "tester" } }) }));
vi.mock("../services/supabaseClient", () => ({ getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }) }));

afterEach(() => { cleanup(); resetBackInterceptors(); localStorage.clear(); document.body.style.overflow = ""; vi.restoreAllMocks(); });

function mount() {
  Element.prototype.scrollIntoView ??= function () {};
  render(<MemoryRouter initialEntries={["/help"]}><Routes>
    <Route path="/help" element={<Help deps={{ getKey: async () => null }} />} />
    <Route path="/settings/privacy" element={<h1>Privacy destination</h1>} />
    <Route path="/settings/ai" element={<h1>AI destination</h1>} />
    <Route path="/settings/ai/privacy" element={<h1>Full privacy details</h1>} />
  </Routes></MemoryRouter>);
}

it("Open Privacy settings navigates to Privacy, with concise sheet and separate full details", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "More options" }));
  fireEvent.click(screen.getByRole("button", { name: "Privacy & AI" }));
  expect(screen.queryByTestId("privacy-full-copy")).toBeNull();
  expect(screen.getByRole("button", { name: /full details/i })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open Privacy settings" }));
  await screen.findByText("Privacy destination");
});

it("Assistant settings opens AI settings rather than the model library", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "More options" }));
  fireEvent.click(screen.getByRole("button", { name: "Assistant settings" }));
  await screen.findByText("AI destination");
});

it("a cancelled send exposes only one global status region", async () => {
  Element.prototype.scrollIntoView ??= function () {};
  const adapter = { id: "openrouter" as const, capabilities: () => ({ vision: { state: "unknown" as const }, maxImagesPerCall: { state: "unknown" as const }, contextTokens: { state: "unknown" as const }, maxOutputTokens: { state: "unknown" as const }, streaming: { state: "known" as const, value: true } }), complete: async function* (request: import("../services/ai/providerContract").NormalizedRequest) {
    await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
    yield { kind: "done" as const, attempt: 1, stopReason: "cancelled" as const };
  } };
  render(<MemoryRouter><Help deps={{ getKey: async () => "test", createAdapter: () => adapter }} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: "How do I report?" } });
  fireEvent.submit(screen.getByTestId("chat-composer"));
  await waitFor(() => expect(screen.getByTestId("chat-stop")).toBeTruthy());
  fireEvent.click(screen.getByTestId("chat-stop"));
  await screen.findByText(/Send stopped/);
  expect(screen.getAllByRole("status")).toHaveLength(1);
});
