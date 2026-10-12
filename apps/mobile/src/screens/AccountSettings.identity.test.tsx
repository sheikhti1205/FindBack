// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";

const { mockLogout, mockUser } = vi.hoisted(() => ({
  mockLogout: vi.fn(),
  mockUser: {
    value: null as PublicUser | null,
  },
}));

vi.mock("../auth", () => ({
  useAuth: () => ({
    user: mockUser.value,
    logout: mockLogout,
    refreshUser: vi.fn(),
  }),
}));

vi.mock("../services/profile", () => ({
  fetchPhoneChangeEligibility: () =>
    Promise.resolve({ eligible: true, eligibleAt: null, phoneVerified: false }),
  formatPhoneChangeEligibleAt: () => "",
}));

import { AccountSettings } from "./AccountSettings";

const verifiedUser: PublicUser = {
  id: "u1",
  username: "tester",
  email: "tester@example.com",
  phone: "+8801812345678",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function renderAccount() {
  return render(
    <MemoryRouter>
      <AccountSettings />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.value = { ...verifiedUser };
  mockLogout.mockResolvedValue(undefined);
});

describe("AccountSettings identity (W7)", () => {
  it("renders the canonical UserAvatar with two-letter initials when there is no photo", () => {
    renderAccount();
    const avatar = screen.getByTestId("user-avatar");
    expect(avatar.textContent).toBe("TE");
    expect(screen.getByText("@tester")).toBeTruthy();
  });

  it("renders the profile photo inside the canonical UserAvatar when one exists", () => {
    mockUser.value = { ...verifiedUser, avatarUrl: "https://example.com/a.png" };
    const { container } = renderAccount();
    const img = container.querySelector('[data-testid="user-avatar"] img') as HTMLImageElement;
    expect(img?.src).toBe("https://example.com/a.png");
    expect(screen.getByText("@tester")).toBeTruthy();
  });
});
