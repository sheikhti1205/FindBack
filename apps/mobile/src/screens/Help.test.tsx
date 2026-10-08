// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "tester" } }),
}));

import { Help } from "./Help";
import { AiPrivacy } from "./AiPrivacy";

beforeAll(() => {
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

afterEach(cleanup);

describe("Help product naming", () => {
  it("uses Help & FAQ naming and honest provider/built-in copy", async () => {
    render(
      <MemoryRouter initialEntries={["/help"]}>
        <Routes>
          <Route path="/help" element={<Help />} />
          <Route path="/settings/ai/privacy" element={<AiPrivacy />} />
        </Routes>
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
    // U2/P2: no permanent privacy wall in the conversation — a concise sheet
    // with a "Full details" destination replaces the inline dump.
    expect(screen.queryByText(/Photos are never attached automatically/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /more options/i }));
    fireEvent.click(screen.getByRole("button", { name: /^privacy & ai$/i }));
    const fullDetails = await screen.findByRole("button", { name: /full details/i });
    // The truth-complete disclosure is NOT dumped inline in the sheet.
    expect(screen.queryByText(/local-first/)).toBeNull();
    fireEvent.click(fullDetails);
    // F02: the full disclosure is truth-complete across transports.
    await waitFor(() => expect(screen.getByText(/Photos are never attached automatically/)).toBeTruthy());
    expect(screen.getByText(/built-in FindBack guidance/)).toBeTruthy();
    expect(screen.getByText(/local generation/)).toBeTruthy();
    expect(screen.getByText(/On-device only/)).toBeTruthy();
    expect(screen.getByText(/Cloud-only skips local generation/)).toBeTruthy();
    expect(screen.queryByText(/answered by (our|FindBack's) server/)).toBeNull();
  });
});
