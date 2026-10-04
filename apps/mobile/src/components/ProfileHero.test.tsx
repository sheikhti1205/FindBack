// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicUser } from "@findback/shared";
import { ProfileHero, initialsFor } from "./ProfileHero";

const verifiedUser: PublicUser = {
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

function renderHero(user: PublicUser = verifiedUser) {
  return render(
    <MemoryRouter>
      <ProfileHero user={user} />
    </MemoryRouter>,
  );
}

describe("initialsFor", () => {
  it("derives two-letter initials without leaking other identity fields", () => {
    expect(initialsFor("tester")).toBe("TE");
    expect(initialsFor("a")).toBe("A");
    expect(initialsFor("  spaced name ")).toBe("SN");
  });
});

describe("ProfileHero", () => {
  it("shows the username, secondary email, and an edit action", () => {
    renderHero();
    expect(screen.getByText("@tester")).toBeTruthy();
    expect(screen.getByText("tester@example.com")).toBeTruthy();
    const edit = screen.getByRole("link", { name: "Edit profile" });
    expect(edit.getAttribute("href")).toBe("/profile/edit");
  });

  it("shows an email-verified chip when verified", () => {
    renderHero();
    expect(screen.getByText("Email verified")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /verify/i })).toBeNull();
  });

  it("shows a real Verify action when the email is unverified", () => {
    renderHero({ ...verifiedUser, emailVerified: false });
    expect(screen.queryByText("Email verified")).toBeNull();
    const verify = screen.getByRole("link", { name: "Verify email" });
    expect(verify.getAttribute("href")).toBe("/verify");
  });

  it("falls back to initials when no avatar URL is set", () => {
    const { container } = renderHero();
    expect(screen.getByText("TE")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders the avatar image when a URL is set", () => {
    const { container } = renderHero({ ...verifiedUser, avatarUrl: "https://example.com/a.png" });
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.com/a.png");
    expect(screen.queryByText("TE")).toBeNull();
  });

  it("never renders phone content or phone-verification copy", () => {
    renderHero();
    expect(screen.queryByText("+10000000000")).toBeNull();
    expect(screen.queryByText(/phone/i)).toBeNull();
  });
});
