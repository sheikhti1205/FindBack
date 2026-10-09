// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { SettingsProfileHeader } from "./SettingsProfileHeader";

afterEach(cleanup);

const BASE_USER = {
  id: "u1",
  username: "tester",
  email: "tester@example.com",
  phone: "+10000000000",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;

function renderHeader(user: Record<string, unknown> = {}) {
  render(
    <MemoryRouter>
      <SettingsProfileHeader user={{ ...BASE_USER, ...user } as never} />
    </MemoryRouter>,
  );
}

describe("SettingsProfileHeader", () => {
  it("links the whole header to the existing profile edit route", () => {
    renderHeader();
    const link = screen.getByRole("link", { name: /edit profile/i });
    expect(link.getAttribute("href")).toBe("/profile/edit");
  });

  it("shows the display name and @username without clipping labels", () => {
    renderHeader({ displayName: "Test Person" });
    expect(screen.getByText("Test Person")).toBeTruthy();
    expect(screen.getByText("@tester")).toBeTruthy();
  });

  it("falls back to the username when no display name is set", () => {
    renderHeader({ displayName: null });
    expect(screen.getByText("@tester")).toBeTruthy();
    expect(screen.getByRole("link", { name: /tester/ })).toBeTruthy();
  });

  it("reuses the canonical avatar and keeps it decorative", () => {
    renderHeader();
    expect(screen.getByTestId("user-avatar")).toBeTruthy();
    expect(screen.getByTestId("user-avatar").getAttribute("aria-hidden")).toBe("true");
  });

  it("exposes a visible Edit profile affordance and no nested controls", () => {
    renderHeader();
    const link = screen.getByRole("link", { name: /edit profile/i });
    expect(link.textContent).toMatch(/edit profile/i);
    expect(link.querySelectorAll("button,input,a").length).toBe(0);
  });

  it("keeps long names on one truncated line instead of clipping mid-layout", () => {
    const long = "A very long display name that must not break the settings layout";
    renderHeader({ displayName: long });
    const name = screen.getByText(long);
    expect(name.textContent).toBe(long);
    expect(name.closest("[class*=fb-settings-profile-copy]")).toBeTruthy();
  });
});
