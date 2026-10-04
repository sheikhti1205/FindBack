// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicUser } from "@findback/shared";
import { AccountSummaryCard } from "./AccountSummaryCard";

const user: PublicUser = {
  id: "u1",
  username: "tester",
  email: "tester@example.com",
  phone: "+10000000000",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

afterEach(cleanup);

describe("AccountSummaryCard", () => {
  it("links the whole card to the account screen with a manage affordance", () => {
    render(
      <MemoryRouter>
        <AccountSummaryCard user={user} />
      </MemoryRouter>,
    );
    const card = screen.getByRole("link", { name: /manage account/i });
    expect(card.getAttribute("href")).toBe("/settings/account");
    expect(card.textContent).toContain("tester");
    expect(card.textContent).toContain("tester@example.com");
    // No nested interactive controls inside the link.
    expect(card.querySelectorAll("button,a,input").length).toBe(0);
  });
});
