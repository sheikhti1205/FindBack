// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogout, mockRefreshUser, mockUpdateUser } = vi.hoisted(() => ({
  mockLogout: vi.fn(),
  mockRefreshUser: vi.fn(),
  mockUpdateUser: vi.fn(),
}));

vi.mock("../auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "tester",
      email: "tester@example.com",
      phone: "+10000000000",
      emailVerified: true,
      phoneVerified: false,
      avatarUrl: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    logout: mockLogout,
    refreshUser: mockRefreshUser,
  }),
}));

vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({ auth: { updateUser: mockUpdateUser } }),
}));

import { Profile } from "./Profile";
import { ProfileEdit } from "./ProfileEdit";
import { ThemeProvider } from "../theme";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateUser.mockResolvedValue({ data: { user: null }, error: null });
  mockRefreshUser.mockResolvedValue(undefined);
});

describe("Profile help destination", () => {
  it("labels the help destination Help & FAQ and keeps the /help route", () => {
    render(
      <MemoryRouter>
        <ThemeProvider>
          <Profile />
        </ThemeProvider>
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Help & FAQ" });
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("/help");
    expect(screen.queryByText(/Help Assistant/)).toBeNull();
  });
});

describe("Profile motion", () => {
  function renderProfile() {
    render(
      <MemoryRouter>
        <ThemeProvider>
          <Profile />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  it("keeps every row's destination and name (press-state wrap regression guard)", () => {
    renderProfile();
    const nav = screen.getByRole("navigation", { name: "Profile links" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Edit profile", "/profile/edit"],
      ["My reports", "/my"],
      ["Help & FAQ", "/help"],
      ["AI Connection", "/ai-connection"],
      ["About", "/about"],
    ]);
    // Still real anchors — the motion wrapper must not swallow navigation.
    for (const link of links) expect(link.tagName).toBe("A");
  });

  it("slides the reused theme selector indicator to the chosen theme", () => {
    renderProfile();
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    const dark = within(group).getByRole("radio", { name: "Dark" });
    fireEvent.click(dark);
    expect(dark.getAttribute("aria-checked")).toBe("true");
    for (const name of ["System", "Light"]) {
      expect(within(group).getByRole("radio", { name }).getAttribute("aria-checked")).toBe("false");
    }
    // The shared sliding pill (Segmented-owned, reused — not edited).
    expect(dark.querySelector('[data-testid="segmented-selection"]')).toBeTruthy();
  });
});

describe("ProfileEdit", () => {
  function renderEdit() {
    render(
      <MemoryRouter>
        <ThemeProvider>
          <ProfileEdit />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  it("renders read-only identity fields and an editable phone prefilled from the profile", () => {
    renderEdit();
    const username = screen.getByLabelText("Username") as HTMLInputElement;
    const email = screen.getByLabelText("Email") as HTMLInputElement;
    const phone = screen.getByLabelText("Mobile (Bangladesh)") as HTMLInputElement;
    expect(username.value).toBe("tester");
    expect(username.readOnly).toBe(true);
    expect(email.value).toBe("tester@example.com");
    expect(email.readOnly).toBe(true);
    expect(phone.value).toBe("+10000000000");
    expect(phone.readOnly).toBe(false);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to profile" }).getAttribute("href")).toBe(
      "/profile",
    );
  });

  it("guards non-editable fields: username and email cannot be edited and explain why", () => {
    renderEdit();
    expect(screen.getByText(/usernames can't be changed/i)).toBeTruthy();
    expect(screen.getByText(/re-verification/i)).toBeTruthy();
    // No textbox exists for a username/email edit — both inputs are read-only.
    for (const label of ["Username", "Email"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).readOnly).toBe(true);
    }
  });

  it("rejects an invalid phone without calling the backend", async () => {
    renderEdit();
    fireEvent.change(screen.getByLabelText("Mobile (Bangladesh)"), {
      target: { value: "not-a-number" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/valid Bangladesh mobile number/i)).toBeTruthy();
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockRefreshUser).not.toHaveBeenCalled();
  });

  it("saves a valid phone via the auth layer and refreshes the profile", async () => {
    renderEdit();
    fireEvent.change(screen.getByLabelText("Mobile (Bangladesh)"), {
      target: { value: "01912345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(mockUpdateUser).toHaveBeenCalledWith({ data: { phone: "+8801912345678" } }),
    );
    await waitFor(() => expect(mockRefreshUser).toHaveBeenCalled());
    expect(await screen.findByText("Profile saved.")).toBeTruthy();
  });

  it("surfaces save failures without a success message", async () => {
    mockUpdateUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "Network request failed" },
    });
    renderEdit();
    fireEvent.change(screen.getByLabelText("Mobile (Bangladesh)"), {
      target: { value: "01912345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Network request failed")).toBeTruthy();
    expect(screen.queryByText("Profile saved.")).toBeNull();
    expect(mockRefreshUser).not.toHaveBeenCalled();
  });
});
