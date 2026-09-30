// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
  it("uses Help & FAQ naming and honest provider/built-in copy", () => {
    render(
      <MemoryRouter>
        <Help />
      </MemoryRouter>,
    );
    // M2 G23: the header is the Assistant with a model-picker affordance.
    expect(screen.getByRole("heading", { name: "Assistant" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /choose model/i })).toBeTruthy();
    expect(screen.getByLabelText("Ask the Help & FAQ")).toBeTruthy();
    expect(screen.getByText(/I am the FindBack Help & FAQ/)).toBeTruthy();
    expect(screen.queryByText(/Help Assistant/)).toBeNull();
    // P1: the header carries the short honest mode note; the full consent
    // copy below keeps the detailed wording on first use. With multiple
    // providers supported, the note names the connected AI provider.
    expect(screen.getByText(/AI provider when connected/)).toBeTruthy();
    expect(screen.getByText(/built-in answer instead/)).toBeTruthy();
    expect(screen.queryByText(/answered by (our|FindBack's) server/)).toBeNull();
    expect(screen.queryByText(/offline/i)).toBeNull();
  });
});
