// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "tester" } }),
}));

import { Help } from "./Help";

beforeAll(() => {
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

afterEach(cleanup);

describe("Help product naming", () => {
  it("uses Help & FAQ naming and honest provider/built-in copy", async () => {
    render(
      <MemoryRouter>
        <Help />
      </MemoryRouter>,
    );
    // M2 G23: the header is the Assistant with a model-picker affordance.
    expect(screen.getByRole("heading", { name: "Assistant" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /choose model/i })).toBeTruthy();
    expect(screen.getByLabelText("Ask the Help & FAQ")).toBeTruthy();
    // v0.9.0-beta.1: a consumer landing replaces the old synthetic greeting
    // bubble; the eyebrow is "FindBack Assistant", never the removed
    // "Help Assistant" product name.
    expect(screen.getByTestId("assistant-landing")).toBeTruthy();
    expect(screen.getByText(/I can help with reporting, recovering, searching/)).toBeTruthy();
    expect(screen.queryByText(/Help Assistant/)).toBeNull();
    expect(screen.queryByText(/I am the FindBack Help & FAQ/)).toBeNull();
    // P1: the header carries the short honest mode note.
    expect(screen.getByText(/AI provider when connected/)).toBeTruthy();
    // The full consent copy is collapsed on first use but reachable in one tap.
    expect(screen.queryByText(/Photos are never attached automatically/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /privacy & ai details/i }));
    await waitFor(() => expect(screen.getByText(/Photos are never attached automatically/)).toBeTruthy());
    // F02: the privacy explainer is truth-complete across transports.
    expect(screen.getByText(/built-in answer instead/)).toBeTruthy();
    expect(screen.getByText(/local-first/)).toBeTruthy();
    expect(screen.getByText(/on-device-only/)).toBeTruthy();
    expect(screen.getByText(/cloud-only/)).toBeTruthy();
    expect(screen.getByText(/fall back/)).toBeTruthy();
    expect(screen.queryByText(/answered by (our|FindBack's) server/)).toBeNull();
  });
});
