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
    // M2 G23: the header is the Assistant with history + overflow; model
    // selection lives with the composer.
    expect(screen.getByRole("heading", { name: "Assistant" })).toBeTruthy();
    expect(screen.getByTestId("composer-model-chip")).toBeTruthy();
    expect(screen.getByLabelText("Ask the Help & FAQ")).toBeTruthy();
    // U2: a conversation-first landing replaces the old card stack; the hero
    // is "What can I help with?", never the removed "Help Assistant" name.
    expect(screen.getByTestId("assistant-landing")).toBeTruthy();
    expect(screen.getByText(/report, search, or understand something you found/i)).toBeTruthy();
    expect(screen.queryByText(/Help Assistant/)).toBeNull();
    expect(screen.queryByText(/I am the FindBack Help & FAQ/)).toBeNull();
    // U2: no permanent privacy wall in the conversation — the full consent
    // copy lives one tap away in the overflow menu (Privacy & AI sheet).
    expect(screen.queryByText(/Photos are never attached automatically/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /more options/i }));
    fireEvent.click(screen.getByRole("button", { name: /^privacy & ai$/i }));
    await waitFor(() => expect(screen.getByTestId("privacy-full-copy")).toBeTruthy());
    expect(screen.getByText(/Photos are never attached automatically/)).toBeTruthy();
    // F02: the privacy explainer is truth-complete across transports.
    expect(screen.getByText(/built-in answer instead/)).toBeTruthy();
    expect(screen.getByText(/local-first/)).toBeTruthy();
    expect(screen.getByText(/on-device-only/)).toBeTruthy();
    expect(screen.getByText(/cloud-only/)).toBeTruthy();
    expect(screen.getByText(/fall back/)).toBeTruthy();
    expect(screen.queryByText(/answered by (our|FindBack's) server/)).toBeNull();
  });
});
