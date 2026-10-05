// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { AccountSettings } from "./AccountSettings";
import { aiCredentials } from "../services/aiCredentials";

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
  const utils = render(
    <MemoryRouter>
      <AccountSettings />
    </MemoryRouter>,
  );
  return utils;
}

const F08_SESSION_KEY = "F08-SESSION-ONLY-u1-KEY";
const F08_SAVED_KEY = "F08-REMEMBERED-u1-KEY";
const F08_PHRASE = "f08 unlock phrase";

afterEach(async () => {
  cleanup();
  await aiCredentials.removeAccountCredentials("u1");
  aiCredentials.clearSession();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.value = { ...verifiedUser };
  mockLogout.mockResolvedValue(undefined);
});

describe("AccountSettings", () => {
  it("renders one account heading with a back target of /settings", () => {
    renderAccount();
    expect(screen.getByRole("heading", { level: 1, name: "Account" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const back = screen.getByRole("button", { name: "Back to Settings" });
    expect(back).toBeTruthy();
  });

  it("renders username and email as information, never as inputs", () => {
    const { container } = renderAccount();
    expect(screen.getByText("@tester")).toBeTruthy();
    expect(screen.getByText("tester@example.com")).toBeTruthy();
    // No editable fields on this screen: information rows, not disabled inputs.
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows a verified status for a verified email and no verify action", () => {
    renderAccount();
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /verify/i })).toBeNull();
  });

  it("offers the real verify-email action only while the email is unverified", () => {
    mockUser.value = { ...verifiedUser, emailVerified: false };
    renderAccount();
    expect(screen.queryByText("Verified")).toBeNull();
    const action = screen.getByRole("link", { name: /verify email/i });
    expect(action.getAttribute("href")).toBe("/verify");
  });

  it("never shows phone verification or unavailable-in-this-build copy", () => {
    mockUser.value = { ...verifiedUser, emailVerified: false };
    renderAccount();
    expect(screen.queryByText(/phone verification/i)).toBeNull();
    expect(screen.queryByText(/unavailable in this build/i)).toBeNull();
    expect(screen.queryByText(/isn't available/i)).toBeNull();
  });

  it("links the mobile row to the profile editor with the current number", () => {
    renderAccount();
    const row = screen.getByRole("link", { name: /mobile number/i });
    expect(row.getAttribute("href")).toBe("/profile/edit");
    expect(row.textContent).toContain("+8801812345678");
  });

  it("falls back to initials when there is no profile photo", () => {
    renderAccount();
    expect(screen.queryByRole("img")).toBeNull();
    // Decorative initials tile; the username row carries the meaning.
    expect(screen.getByText("T", { selector: '[aria-hidden="true"]' })).toBeTruthy();
  });

  it("shows the profile photo when one exists", () => {
    mockUser.value = { ...verifiedUser, avatarUrl: "https://example.com/a.png" };
    const { container } = renderAccount();
    // Decorative photo (the username row carries the meaning): presentational img.
    const img = container.querySelector("img.fb-account-avatar") as HTMLImageElement;
    expect(img?.src).toBe("https://example.com/a.png");
  });

  it("signs out with the same semantics as the profile screen", async () => {
    renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));
    await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
  });

  it("logs out immediately with no removal notice when no credentials are stored", async () => {
    renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));
    await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: /remove keys and log out/i })).toBeNull();
  });

  it("shows the key-removal notice and requires confirm when a session key is stored", async () => {
    await aiCredentials.connect("u1", F08_SESSION_KEY, { remember: false, provider: "openai" });
    renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toMatch(/remove.*stored AI provider keys/i);
    expect(mockLogout).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(F08_SESSION_KEY);
    fireEvent.click(screen.getByRole("button", { name: /remove keys and log out/i }));
    await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).not.toContain(F08_SESSION_KEY);
  });

  it("shows the key-removal notice for a remembered (persisted) key after a session wipe", async () => {
    await aiCredentials.connect("u1", F08_SAVED_KEY, {
      remember: true,
      passphrase: F08_PHRASE,
      provider: "openai",
    });
    aiCredentials.clearSession();
    renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toMatch(/remove.*stored AI provider keys/i);
    expect(mockLogout).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(F08_SAVED_KEY);
    fireEvent.click(screen.getByRole("button", { name: /remove keys and log out/i }));
    await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
  });

  it("cancelling the removal notice aborts the sign-out", async () => {
    await aiCredentials.connect("u1", F08_SESSION_KEY, { remember: false, provider: "openai" });
    renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));
    await screen.findByRole("status");
    expect(mockLogout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it("renders nothing when there is no signed-in user", () => {
    mockUser.value = null;
    const { container } = renderAccount();
    expect(container.textContent).toBe("");
  });
});
