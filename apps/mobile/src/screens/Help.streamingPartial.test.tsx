// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Help } from "./Help";
import { resetBackInterceptors } from "../components/backNavigation";
import type { ProviderAdapter, StreamEvent } from "../services/ai/providerContract";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: "u-stream", username: "tester" } }),
}));

beforeAll(() => {
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
  (URL as unknown as Record<string, unknown>).createObjectURL = () => "blob:chat-preview";
  (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
});

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  document.body.style.overflow = "";
});

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

describe("Help streaming partial teardown (U1)", () => {
  it("renders exactly one assistant answer after the throttled partial window settles", async () => {
    render(
      <MemoryRouter initialEntries={["/help"]}>
        <Routes>
          <Route
            path="/help"
            element={
              <Help deps={{ createAdapter: () => cannedAdapter("Exactly one answer."), getKey: async () => "k" }} />
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Ask the Help & FAQ"), { target: { value: "hi" } });
    fireEvent.submit(screen.getByTestId("chat-composer"));
    await screen.findByText("Exactly one answer.");
    // The 120 ms partial throttle must never resurrect a second bubble after
    // completion: wait past the window, then assert a single occurrence and
    // no lingering partial node.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.getAllByText("Exactly one answer.")).toHaveLength(1);
    expect(screen.queryByTestId("chat-partial")).toBeNull();
  });
});
