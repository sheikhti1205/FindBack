// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";

const { mockLogout, mockRefreshUser, mockUpdateUser, mockUser } = vi.hoisted(() => ({
  mockLogout: vi.fn(),
  mockRefreshUser: vi.fn(),
  mockUpdateUser: vi.fn(),
  mockUser: {
    value: null as PublicUser | null,
  },
}));

vi.mock("../auth", () => ({
  useAuth: () => ({
    user: mockUser.value,
    logout: mockLogout,
    refreshUser: mockRefreshUser,
  }),
}));

vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({ auth: { updateUser: mockUpdateUser } }),
}));

import { ProfileEdit } from "./ProfileEdit";

const baseUser: PublicUser = {
  id: "u1",
  username: "tester",
  email: "tester@example.com",
  phone: "+8801812345678",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function renderEdit() {
  return render(
    <MemoryRouter>
      <ProfileEdit />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.value = { ...baseUser };
  mockUpdateUser.mockResolvedValue({ data: { user: null }, error: null });
  mockRefreshUser.mockResolvedValue(undefined);
});

describe("ProfileEdit rework", () => {
  it("renders one heading with a back link to the account screen", () => {
    renderEdit();
    expect(screen.getByRole("heading", { level: 1, name: "Edit profile" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Back to Account" })).toBeTruthy();
  });

  it("renders identity as information: only the mobile field is an input", () => {
    const { container } = renderEdit();
    expect(screen.getByText("@tester")).toBeTruthy();
    expect(screen.getByText("tester@example.com")).toBeTruthy();
    const inputs = container.querySelectorAll("input");
    expect(inputs.length).toBe(1);
    expect(screen.getByRole("textbox", { name: /mobile/i })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /username/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /email/i })).toBeNull();
  });

  it("carries no unsupported-flow warning copy", () => {
    renderEdit();
    expect(screen.queryByText(/isn't available in this build/i)).toBeNull();
    expect(screen.queryByText(/re-verification/i)).toBeNull();
    expect(screen.queryByText(/phone verification/i)).toBeNull();
  });

  it("keeps Save disabled until the number changes, including reverting", () => {
    renderEdit();
    const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: /mobile/i }), {
      target: { value: "01912345678" },
    });
    expect(save.disabled).toBe(false);
    fireEvent.change(screen.getByRole("textbox", { name: /mobile/i }), {
      target: { value: "+8801812345678" },
    });
    expect(save.disabled).toBe(true);
  });

  it("rejects an invalid phone without calling the backend", async () => {
    renderEdit();
    fireEvent.change(screen.getByRole("textbox", { name: /mobile/i }), {
      target: { value: "not-a-number" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/valid Bangladesh mobile number/i)).toBeTruthy();
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockRefreshUser).not.toHaveBeenCalled();
  });

  it("saves a valid phone via the existing update path and announces it live", async () => {
    renderEdit();
    fireEvent.change(screen.getByRole("textbox", { name: /mobile/i }), {
      target: { value: "01912345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(mockUpdateUser).toHaveBeenCalledWith({ data: { phone: "+8801912345678" } }),
    );
    await waitFor(() => expect(mockRefreshUser).toHaveBeenCalled());
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("surfaces save failures as human copy in a live alert, never raw errors", async () => {
    mockUpdateUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "Network request failed" },
    });
    renderEdit();
    fireEvent.change(screen.getByRole("textbox", { name: /mobile/i }), {
      target: { value: "01912345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not save/i);
    expect(alert.textContent).not.toContain("Network request failed");
    expect(screen.queryByRole("status")).toBeNull();
    expect(mockRefreshUser).not.toHaveBeenCalled();
  });

  it("renders nothing when there is no signed-in user", () => {
    mockUser.value = null;
    const { container } = renderEdit();
    expect(container.textContent).toBe("");
  });
});
