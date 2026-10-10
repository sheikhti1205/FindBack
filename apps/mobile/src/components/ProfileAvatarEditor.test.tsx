// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";

const {
  mockSetUser,
  mockUser,
  mockUploadAvatar,
  mockRemoveAvatar,
  mockNormalizeImage,
  mockChooseNativeImage,
  mockIsNativeAvailable,
} = vi.hoisted(() => ({
  mockSetUser: vi.fn(),
  mockUser: { value: null as PublicUser | null },
  mockUploadAvatar: vi.fn(),
  mockRemoveAvatar: vi.fn(),
  mockNormalizeImage: vi.fn(),
  mockChooseNativeImage: vi.fn(),
  mockIsNativeAvailable: vi.fn(),
}));

vi.mock("../auth", () => ({
  useAuth: () => ({ user: mockUser.value, setUser: mockSetUser }),
}));
vi.mock("../services/avatar", () => ({
  uploadAvatar: (...args: unknown[]) => mockUploadAvatar(...args),
  removeAvatar: (...args: unknown[]) => mockRemoveAvatar(...args),
}));
vi.mock("../services/image", () => ({
  normalizeImage: (...args: unknown[]) => mockNormalizeImage(...args),
}));
vi.mock("../services/media/nativeMedia", () => ({
  chooseNativeImage: (...args: unknown[]) => mockChooseNativeImage(...args),
  isNativeMediaIntakeAvailable: () => mockIsNativeAvailable(),
}));

import { ProfileAvatarEditor } from "./ProfileAvatarEditor";

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

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.value = { ...baseUser };
  mockIsNativeAvailable.mockReturnValue(false);
  mockUploadAvatar.mockResolvedValue({ ...baseUser, avatarUrl: "https://cdn.test/new.jpg" });
  mockRemoveAvatar.mockResolvedValue({ ...baseUser, avatarUrl: null });
  mockNormalizeImage.mockResolvedValue({
    blob: new Blob(["web-bytes"], { type: "image/jpeg" }),
    mimeType: "image/jpeg",
    width: 100,
    height: 100,
  });
  mockChooseNativeImage.mockResolvedValue(null);
});

describe("ProfileAvatarEditor", () => {
  it("renders the current avatar with an add affordance when there is no photo", () => {
    render(<ProfileAvatarEditor />);

    expect(screen.getByTestId("user-avatar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add photo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("renders change/remove affordances when a photo exists", () => {
    mockUser.value = { ...baseUser, avatarUrl: "https://cdn.test/old.jpg" };
    render(<ProfileAvatarEditor />);

    const img = screen.getByTestId("user-avatar").querySelector("img") as HTMLImageElement;
    expect(img.src).toBe("https://cdn.test/old.jpg");
    expect(screen.getByRole("button", { name: "Change photo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("uploads a picked web file through the canonical normalizer and refreshes the user", async () => {
    render(<ProfileAvatarEditor />);
    const file = new File(["raw"], "me.png", { type: "image/png" });

    fireEvent.change(screen.getByLabelText("Choose profile photo"), { target: { files: [file] } });

    await waitFor(() => expect(mockNormalizeImage).toHaveBeenCalledWith(file));
    await waitFor(() =>
      expect(mockUploadAvatar).toHaveBeenCalledWith(
        { blob: expect.any(Blob), mimeType: "image/jpeg", fileName: "me.png" },
        null,
      ),
    );
    await waitFor(() =>
      expect(mockSetUser).toHaveBeenCalledWith({ ...baseUser, avatarUrl: "https://cdn.test/new.jpg" }),
    );
    expect((await screen.findByRole("status")).textContent).toMatch(/profile photo updated/i);
  });

  it("uploads the native derivative on Android and passes the previous URL for cleanup", async () => {
    mockIsNativeAvailable.mockReturnValue(true);
    mockUser.value = { ...baseUser, avatarUrl: "https://cdn.test/old.jpg" };
    const derivative = new Uint8Array([1, 2, 3]);
    mockChooseNativeImage.mockResolvedValue({
      id: "img_1",
      fileName: "avatar.jpg",
      derivative: { bytes: derivative, mimeType: "image/jpeg", byteLength: 3, width: 8, height: 8, quality: 0.82 },
    });
    render(<ProfileAvatarEditor />);

    fireEvent.click(screen.getByRole("button", { name: "Change photo" }));

    await waitFor(() => expect(mockChooseNativeImage).toHaveBeenCalledWith({ source: "photos", fileName: "avatar.jpg" }));
    await waitFor(() =>
      expect(mockUploadAvatar).toHaveBeenCalledWith(
        { blob: expect.any(Blob), mimeType: "image/jpeg", fileName: "avatar.jpg" },
        "https://cdn.test/old.jpg",
      ),
    );
    expect(mockNormalizeImage).not.toHaveBeenCalled();
  });

  it("treats native picker cancellation as no change (never an error)", async () => {
    mockIsNativeAvailable.mockReturnValue(true);
    mockChooseNativeImage.mockResolvedValue(null);
    render(<ProfileAvatarEditor />);

    fireEvent.click(screen.getByRole("button", { name: "Add photo" }));

    await waitFor(() => expect(mockChooseNativeImage).toHaveBeenCalledTimes(1));
    // Settles without uploading and without an error.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add photo" }).hasAttribute("disabled")).toBe(false),
    );
    expect(mockUploadAvatar).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("removes the photo and refreshes the user", async () => {
    mockUser.value = { ...baseUser, avatarUrl: "https://cdn.test/old.jpg" };
    render(<ProfileAvatarEditor />);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(mockRemoveAvatar).toHaveBeenCalledWith("https://cdn.test/old.jpg"));
    await waitFor(() => expect(mockSetUser).toHaveBeenCalledWith({ ...baseUser, avatarUrl: null }));
    expect((await screen.findByRole("status")).textContent).toMatch(/profile photo removed/i);
  });

  it("keeps the previous avatar and shows one human message when upload fails", async () => {
    mockUploadAvatar.mockRejectedValue(new Error("Could not upload your photo. Check your connection and try again."));
    render(<ProfileAvatarEditor />);
    const file = new File(["raw"], "me.jpg", { type: "image/jpeg" });

    fireEvent.change(screen.getByLabelText("Choose profile photo"), { target: { files: [file] } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not upload/i);
    expect(mockSetUser).not.toHaveBeenCalled();
  });
});
