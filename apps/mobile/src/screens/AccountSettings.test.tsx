// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";

const { mockLogout, mockUser, mockRequestDeletion, mockFetchEligibility } = vi.hoisted(() => ({
  mockLogout: vi.fn(),
  mockRequestDeletion: vi.fn(),
  mockFetchEligibility: vi.fn(),
  mockUser: {
    value: null as PublicUser | null,
  },
}));

vi.mock("../auth", () => ({
  useAuth: () => ({
    user: mockUser.value,
    logout: mockLogout,
    finishAccountDeletion: () => mockLogout(),
    retryDeletionCleanup: () => mockLogout(),
    refreshUser: vi.fn(),
  }),
}));

vi.mock("../services/auth", () => ({
  requestAccountDeletion: (...args: unknown[]) => mockRequestDeletion(...args),
}));

vi.mock("../services/profile", () => ({
  fetchPhoneChangeEligibility: (...args: unknown[]) => mockFetchEligibility(...args),
  formatPhoneChangeEligibleAt: (eligibleAt: string | null | undefined) => {
    if (!eligibleAt) return "";
    const date = new Date(eligibleAt);
    if (Number.isNaN(date.getTime())) return "";
    return `on ${date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`;
  },
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
  mockFetchEligibility.mockResolvedValue({ eligible: true, eligibleAt: null, phoneVerified: false });
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

  it("falls back to canonical initials when there is no profile photo", () => {
    renderAccount();
    expect(screen.queryByRole("img")).toBeNull();
    // Decorative canonical avatar; the username row carries the meaning.
    expect(screen.getByTestId("user-avatar").textContent).toBe("TE");
  });

  it("shows the profile photo when one exists", () => {
    mockUser.value = { ...verifiedUser, avatarUrl: "https://example.com/a.png" };
    const { container } = renderAccount();
    // Decorative photo inside the canonical avatar (the username row carries the meaning).
    const img = container.querySelector('[data-testid="user-avatar"] img') as HTMLImageElement;
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

  it("shows the delete section unarmed with no confirm input", () => {
    renderAccount();
    expect(screen.getByRole("button", { name: /delete account/i })).toBeTruthy();
    expect(screen.queryByLabelText(/type your email address/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /permanently delete/i })).toBeNull();
  });

  it("requires the exact account email before the permanent delete button enables", () => {
    renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    const input = screen.getByLabelText(/type your email address/i) as HTMLInputElement;
    const confirm = screen.getByRole("button", { name: /permanently delete/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "someone-else@example.com" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "TESTER@example.com" } });
    expect(confirm.disabled).toBe(false);
  });

  it("deletes on the server, shows the success panel, then runs the logout wipe", async () => {
    mockRequestDeletion.mockResolvedValue({ storageRemoved: 2 });
    renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    fireEvent.change(screen.getByLabelText(/type your email address/i), {
      target: { value: "tester@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /permanently delete/i }));
    await waitFor(() => expect(mockRequestDeletion).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status").textContent).toMatch(/permanently deleted/i);
  });

  it("does not claim local cleanup succeeded when logout fails", async () => {
    mockRequestDeletion.mockResolvedValue({ storageRemoved: 2 });
    mockLogout.mockRejectedValue(new Error("Local cleanup failed"));
    renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    fireEvent.change(screen.getByLabelText(/type your email address/i), { target: { value: "tester@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /permanently delete/i }));
    await screen.findByRole("alert");
    expect(document.body.textContent).not.toContain("stored keys removed");
    expect(mockRequestDeletion).toHaveBeenCalledWith("u1");
    expect(screen.queryByRole("button", { name: /permanently delete/i })).toBeNull();
  });

  it("does not log a newly switched account out after an old deletion settles", async () => {
    let finish!: (result: { storageRemoved: number }) => void;
    mockRequestDeletion.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    fireEvent.change(screen.getByLabelText(/type your email address/i), { target: { value: "tester@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /permanently delete/i }));
    mockUser.value = { ...verifiedUser, id: "u2", email: "other@example.com" };
    view.rerender(<MemoryRouter><AccountSettings /></MemoryRouter>);
    finish({ storageRemoved: 2 });
    await waitFor(() => expect(screen.getByText("other@example.com")).toBeTruthy());
    expect(mockLogout).not.toHaveBeenCalled();
    expect(screen.queryByText(/permanently deleted/i)).toBeNull();
    expect(screen.queryByLabelText(/type your email address/i)).toBeNull();
  });

  it("keeps the account and shows an alert when the server purge fails", async () => {
    mockRequestDeletion.mockRejectedValue(new Error("Account deletion failed: storage list failed: boom"));
    renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    fireEvent.change(screen.getByLabelText(/type your email address/i), {
      target: { value: "tester@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /permanently delete/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/storage list failed/i));
    expect(mockLogout).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("cancelling the delete confirm disarms without calling the server", () => {
    renderAccount();
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    expect(screen.getByLabelText(/type your email address/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByLabelText(/type your email address/i)).toBeNull();
    expect(mockRequestDeletion).not.toHaveBeenCalled();
    expect(mockLogout).not.toHaveBeenCalled();
  });

  // W5-IDENTITY appended cases: six-month replacement availability (spec 25).
  it("keeps the default mobile copy while the gate is eligible", async () => {
    mockFetchEligibility.mockResolvedValue({ eligible: true, eligibleAt: null, phoneVerified: true });
    renderAccount();
    const row = await screen.findByRole("link", { name: /mobile number/i });
    expect(row.textContent).toContain("Bangladesh mobile number.");
    expect(row.textContent).not.toMatch(/change available/i);
  });

  it("names the eligible date on the mobile row while the gate holds", async () => {
    mockFetchEligibility.mockResolvedValue({
      eligible: false,
      eligibleAt: "2027-04-12T00:00:00.000Z",
      phoneVerified: true,
    });
    renderAccount();
    const row = await screen.findByRole("link", { name: /mobile number/i });
    expect(row.textContent).toMatch(/number change available on .*2027/i);
    expect(row.getAttribute("href")).toBe("/profile/edit");
  });

  it("names the block (not the default copy) when the gate holds without a date", async () => {
    mockFetchEligibility.mockResolvedValue({ eligible: false, eligibleAt: null, phoneVerified: true });
    renderAccount();
    const row = await screen.findByRole("link", { name: /mobile number/i });
    expect(row.textContent).toMatch(/not available yet/i);
    expect(row.textContent).not.toContain("Bangladesh mobile number.");
    expect(row.getAttribute("href")).toBe("/profile/edit");
  });

  it("keeps the default mobile copy when the availability read fails", async () => {
    mockFetchEligibility.mockRejectedValue(new Error("offline"));
    renderAccount();
    const row = await screen.findByRole("link", { name: /mobile number/i });
    expect(row.textContent).toContain("Bangladesh mobile number.");
    expect(row.textContent).not.toMatch(/change available/i);
  });
});
