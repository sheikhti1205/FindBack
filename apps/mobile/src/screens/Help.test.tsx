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
  it("uses Help & FAQ naming and honest OpenRouter/built-in copy", () => {
    render(
      <MemoryRouter>
        <Help />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Help & FAQ" })).toBeTruthy();
    expect(screen.getByLabelText("Ask the Help & FAQ")).toBeTruthy();
    expect(screen.getByText(/I am the FindBack Help & FAQ/)).toBeTruthy();
    expect(screen.queryByText(/Help Assistant/)).toBeNull();
    expect(screen.getByText(/your OpenRouter key when connected/)).toBeTruthy();
    expect(screen.getByText(/built-in answer instead/)).toBeTruthy();
    expect(screen.queryByText(/answered by (our|FindBack's) server/)).toBeNull();
    expect(screen.queryByText(/offline/i)).toBeNull();
  });
});
