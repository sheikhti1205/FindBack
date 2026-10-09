// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";

const {
  mockLogout,
  mockRefreshUser,
  mockSavePhone,
  mockUpdateProfile,
  mockSetUser,
  mockUser,
} = vi.hoisted(() => ({
  mockLogout: vi.fn(),
  mockRefreshUser: vi.fn(),
  mockSavePhone: vi.fn(),
  mockUpdateProfile: vi.fn(),
  mockSetUser: vi.fn(),
  mockUser: {
    value: null as PublicUser | null,
  },
}));

vi.mock("../auth", () => ({
  useAuth: () => ({
    user: mockUser.value,
    logout: mockLogout,
    refreshUser: mockRefreshUser,
    setUser: mockSetUser,
  }),
}));

vi.mock("../services/auth", () => ({ saveProfilePhone: mockSavePhone }));
vi.mock("../services/profile", () => ({ updateMyProfile: mockUpdateProfile }));

import { ProfileEdit } from "./ProfileEdit";

const baseUser: PublicUser = {
  id: "u1",
  username: "tester",
  email: "tester@example.com",
  phone: "+8801812345678",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  displayName: "Tester",
  bio: null,
  locationLabel: null,
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
  mockSavePhone.mockResolvedValue({ ...baseUser, phone: "+8801912345678", phoneVerified: false });
  mockUpdateProfile.mockResolvedValue({ ...baseUser, displayName: "New Tester", bio: "hi", locationLabel: "Dhaka" });
  mockRefreshUser.mockResolvedValue(undefined);
});

describe("ProfileEdit rework", () => {
  it("renders one heading with a back link to the account screen", () => {
    renderEdit();
    expect(screen.getByRole("heading", { level: 1, name: "Edit profile" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Back to Account" })).toBeTruthy();
  });

  it("keeps username and email read-only information, not editable inputs", () => {
    renderEdit();
    expect(screen.getByText("@tester")).toBeTruthy();
    expect(screen.getByText("tester@example.com")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /username/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /email/i })).toBeNull();
  });

  it("offers editable display name, bio, location and mobile fields", () => {
    renderEdit();
    expect(screen.getByRole("textbox", { name: /display name/i })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /bio/i })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /location/i })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /mobile/i })).toBeTruthy();
  });

  it("shows a live bio character count against the 280 limit", () => {
    renderEdit();
    expect(screen.getByText("0/280")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: /bio/i }), { target: { value: "hello" } });
    expect(screen.getByText("5/280")).toBeTruthy();
  });

  it("carries no unsupported-flow warning copy", () => {
    renderEdit();
    expect(screen.queryByText(/isn't available in this build/i)).toBeNull();
    expect(screen.getByText(/verify.*new.*number/i)).toBeTruthy();
  });

  it("saves identity fields via updateMyProfile and reflects the refreshed user", async () => {
    renderEdit();
    fireEvent.change(screen.getByRole("textbox", { name: /display name/i }), {
      target: { value: "New Tester" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /bio/i }), { target: { value: "hi" } });
    fireEvent.change(screen.getByRole("textbox", { name: /location/i }), {
      target: { value: "Dhaka" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() =>
      expect(mockUpdateProfile).toHaveBeenCalledWith({
        displayName: "New Tester",
        bio: "hi",
        locationLabel: "Dhaka",
      }),
    );
    await waitFor(() =>
      expect(mockSetUser).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: "New Tester", locationLabel: "Dhaka" }),
      ),
    );
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("keeps the identity save disabled until something changes", () => {
    renderEdit();
    const save = screen.getByRole("button", { name: "Save profile" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: /display name/i }), {
      target: { value: "Changed" },
    });
    expect(save.disabled).toBe(false);
  });

  it("refuses a blank display name without calling the backend", async () => {
    renderEdit();
    fireEvent.change(screen.getByRole("textbox", { name: /display name/i }), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText(/enter a display name/i)).toBeTruthy();
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  it("surfaces identity save failures as human copy, never raw errors", async () => {
    mockUpdateProfile.mockRejectedValueOnce(new Error("Network request failed"));
    renderEdit();
    fireEvent.change(screen.getByRole("textbox", { name: /display name/i }), {
      target: { value: "Changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not save/i);
    expect(alert.textContent).not.toContain("Network request failed");
  });

  it("keeps the phone behavior: rejects an invalid number without calling the backend", async () => {
    renderEdit();
    fireEvent.change(screen.getByRole("textbox", { name: /mobile/i }), {
      target: { value: "not-a-number" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/valid Bangladesh mobile number/i)).toBeTruthy();
    expect(mockSavePhone).not.toHaveBeenCalled();
    expect(mockRefreshUser).not.toHaveBeenCalled();
  });

  it("keeps the phone behavior: saves a valid number and announces it live", async () => {
    renderEdit();
    fireEvent.change(screen.getByRole("textbox", { name: /mobile/i }), {
      target: { value: "01912345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mockSavePhone).toHaveBeenCalledWith("u1", "+8801912345678"));
    await waitFor(() =>
      expect(mockSetUser).toHaveBeenCalledWith(
        expect.objectContaining({ phone: "+8801912345678", phoneVerified: false }),
      ),
    );
    expect(await screen.findByText("Mobile number saved.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /verify mobile number/i }).getAttribute("href")).toBe(
      "/verify",
    );
  });

  it("keeps the saved phone announcement after the auth profile updates", async () => {
    mockSetUser.mockImplementation((user: PublicUser) => {
      mockUser.value = user;
    });
    const view = renderEdit();
    fireEvent.change(screen.getByRole("textbox", { name: /mobile/i }), {
      target: { value: "01912345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mockSetUser).toHaveBeenCalled());
    view.rerender(
      <MemoryRouter>
        <ProfileEdit />
      </MemoryRouter>,
    );
    expect(screen.getByText("Mobile number saved.")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: /mobile/i }) as HTMLInputElement).value).toBe(
      "+8801912345678",
    );
  });

  it("surfaces phone save failures as human copy in a live alert", async () => {
    mockSavePhone.mockRejectedValueOnce(new Error("Network request failed"));
    renderEdit();
    fireEvent.change(screen.getByRole("textbox", { name: /mobile/i }), {
      target: { value: "01912345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not save/i);
    expect(alert.textContent).not.toContain("Network request failed");
    expect(mockRefreshUser).not.toHaveBeenCalled();
  });

  it("renders nothing when there is no signed-in user", () => {
    mockUser.value = null;
    const { container } = renderEdit();
    expect(container.textContent).toBe("");
  });
});
