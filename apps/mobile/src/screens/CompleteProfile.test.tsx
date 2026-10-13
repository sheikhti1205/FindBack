// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { servicesMock, pendingMock, authMock, supabaseMock } = vi.hoisted(() => ({
  servicesMock: { checkUsername: vi.fn() },
  pendingMock: { getPendingReportRoute: vi.fn((): string | null => null) },
  authMock: {
    setUser: vi.fn(),
    clearNeedsProfile: vi.fn(),
    needsProfile: null as {
      email: string;
      name: string | null;
      avatarUrl: string | null;
      phone: string;
      suggestedUsername: string;
    } | null,
  },
  supabaseMock: { getSupabase: vi.fn() },
}));

vi.mock("../services/auth", () => servicesMock);
vi.mock("../services/supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/supabaseClient")>();
  return { ...actual, getSupabase: supabaseMock.getSupabase };
});
vi.mock("../utils/pendingReportLink", () => pendingMock);
vi.mock("../auth", () => ({ useAuth: () => authMock }));

import { checkUsername } from "../services/auth";
import { SupabaseConfigError } from "../services/supabaseClient";
import type { PublicUser } from "@findback/shared";
import {
  __resetCompleteSocialProfile,
  __setCompleteSocialProfile,
  buildUsernameSuggestion,
  CompleteProfile,
  CompleteProfileRoute,
} from "./CompleteProfile";

const FAKE_USER: PublicUser = {
  id: "u1",
  username: "google_user",
  email: "google.user@example.com",
  phone: "+8801812345678",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00Z",
};

const mockCheckUsername = vi.mocked(checkUsername);

const SEED = {
  email: "google.user@example.com",
  name: "Google User",
  avatarUrl: "https://lh3.googleusercontent.com/a/avatar",
  phone: "",
  suggestedUsername: "google_user",
};

function renderProfile(
  seed: typeof SEED = SEED,
  pendingRoute: string | null = null,
  onCompleted?: (user: unknown) => void,
) {
  pendingMock.getPendingReportRoute.mockReturnValue(pendingRoute);
  return render(
    <MemoryRouter initialEntries={["/complete-profile"]}>
      <Routes>
        <Route
          path="/complete-profile"
          element={
            <CompleteProfile
              seed={seed}
              onCompleted={onCompleted as never}
            />
          }
        />
        <Route path="/posts/:id" element={<p>Shared report destination</p>} />
        <Route path="/" element={<p>Home destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockCheckUsername.mockReset();
  mockCheckUsername.mockResolvedValue({ available: true, normalized: "google_user" });
  pendingMock.getPendingReportRoute.mockReset();
  pendingMock.getPendingReportRoute.mockReturnValue(null);
  authMock.setUser.mockReset();
  authMock.clearNeedsProfile.mockReset();
  authMock.needsProfile = null;
  __resetCompleteSocialProfile();
  vi.restoreAllMocks();
  // Hermetic client boundary (FB-AUD-06): the wired default calls the REAL
  // completeSocialProfile, whose getSupabase() succeeds whenever ambient
  // SUPABASE_* env is present and then performs a live network RPC — so this
  // suite must never reach the real client. Fail closed like scrubbed env.
  supabaseMock.getSupabase.mockReset();
  supabaseMock.getSupabase.mockImplementation(() => {
    throw new SupabaseConfigError("Supabase URL is not configured");
  });
});

afterEach(cleanup);

describe("CompleteProfile seeds (W0.5)", () => {
  it("prefills name, username suggestion, email (read-only) and blank phone — all editable", async () => {
    const complete = vi.fn(async () => FAKE_USER);
    __setCompleteSocialProfile(complete);
    renderProfile();

    const name = screen.getByLabelText("Name") as HTMLInputElement;
    const username = screen.getByLabelText("Username") as HTMLInputElement;
    const email = screen.getByLabelText("Email") as HTMLInputElement;
    const phone = screen.getByLabelText("Mobile (Bangladesh)") as HTMLInputElement;

    expect(name.value).toBe("Google User");
    expect(username.value).toBe("google_user");
    expect(email.value).toBe("google.user@example.com");
    expect(email.readOnly).toBe(true);
    expect(phone.value).toBe("");

    // Every seed is editable: change all three and the submitted payload follows.
    fireEvent.change(name, { target: { value: "Chosen Name" } });
    fireEvent.change(username, { target: { value: "chosen_name" } });
    mockCheckUsername.mockResolvedValue({ available: true, normalized: "chosen_name" });
    fireEvent.change(username, { target: { value: "chosen_name2" } });
    mockCheckUsername.mockResolvedValue({ available: true, normalized: "chosen_name2" });
    fireEvent.change(phone, { target: { value: "01812345678" } });

    await waitFor(() => expect(screen.queryByText(/checking/i)).toBeNull());
    await waitFor(() => expect(screen.getByText(/username available/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(complete).toHaveBeenCalledWith({
      username: "chosen_name2",
      displayName: "Chosen Name",
      phone: "+8801812345678",
      avatarUrl: "https://lh3.googleusercontent.com/a/avatar",
    });
  });

  it("prefills a legitimately returned phone but keeps it editable", async () => {
    const complete = vi.fn(async () => FAKE_USER);
    __setCompleteSocialProfile(complete);
    renderProfile({ ...SEED, phone: "01712345678" });
    const phone = screen.getByLabelText("Mobile (Bangladesh)") as HTMLInputElement;
    expect(phone.value).toBe("01712345678");
    fireEvent.change(phone, { target: { value: "01912345678" } });
    await waitFor(() => expect(screen.getByText(/username available/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect((complete.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      phone: "+8801912345678",
    });
  });

  it("prompts for a missing phone: blank cannot finalize", async () => {
    const complete = vi.fn(async () => FAKE_USER);
    __setCompleteSocialProfile(complete);
    renderProfile();
    await waitFor(() => expect(screen.getByText(/username available/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByText(/valid Bangladesh mobile number/i)).toBeTruthy(),
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("offers the Google avatar with a preview but never forces it (remove → null)", async () => {
    const complete = vi.fn(async () => FAKE_USER);
    __setCompleteSocialProfile(complete);
    renderProfile();
    expect(screen.getByAltText("Suggested profile photo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    expect(screen.queryByAltText("Suggested profile photo")).toBeNull();
    fireEvent.change(screen.getByLabelText("Mobile (Bangladesh)"), {
      target: { value: "01812345678" },
    });
    await waitFor(() => expect(screen.getByText(/username available/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect((complete.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      avatarUrl: null,
    });
  });

  it("blocks Continue while the username is still being checked", async () => {
    const complete = vi.fn(async () => FAKE_USER);
    __setCompleteSocialProfile(complete);
    let release!: (value: { available: boolean; normalized: string }) => void;
    mockCheckUsername.mockImplementation(
      () => new Promise<{ available: boolean; normalized: string }>((resolve) => {
        release = resolve;
      }),
    );
    renderProfile();
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "checking_name" } });
    // Let the debounced oracle fire (promise stays pending) before submitting.
    await waitFor(() => expect(mockCheckUsername).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Mobile (Bangladesh)"), {
      target: { value: "01812345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByText(/still checking username availability/i)).toBeTruthy(),
    );
    expect(complete).not.toHaveBeenCalled();
    release({ available: true, normalized: "checking_name" });
    await waitFor(() => expect(screen.getByText(/username available/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  });

  it("an unavailable username cannot finalize", async () => {
    const complete = vi.fn(async () => FAKE_USER);
    __setCompleteSocialProfile(complete);
    mockCheckUsername.mockResolvedValue({ available: false, normalized: "taken_name" });
    renderProfile({ ...SEED, suggestedUsername: "taken_name" });
    // Field error + live status line both report the taken name (framer-motion
    // may also keep an exiting clone — assert presence, not singularity).
    await waitFor(() =>
      expect(screen.getAllByText(/already (taken|exists)/i).length).toBeGreaterThan(0),
    );
    fireEvent.change(screen.getByLabelText("Mobile (Bangladesh)"), {
      target: { value: "01812345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByText(/choose another username/i)).toBeTruthy(),
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("Continue preserves the pending report destination", async () => {
    const complete = vi.fn(async () => FAKE_USER);
    __setCompleteSocialProfile(complete);
    renderProfile(SEED, "/posts/abc123");
    fireEvent.change(screen.getByLabelText("Mobile (Bangladesh)"), {
      target: { value: "01812345678" },
    });
    await waitFor(() => expect(screen.getByText(/username available/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("Shared report destination")).toBeTruthy());
  });

  it("Continue falls back to home when no pending destination exists", async () => {
    const complete = vi.fn(async () => FAKE_USER);
    __setCompleteSocialProfile(complete);
    renderProfile(SEED, null);
    fireEvent.change(screen.getByLabelText("Mobile (Bangladesh)"), {
      target: { value: "01812345678" },
    });
    await waitFor(() => expect(screen.getByText(/username available/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("Home destination")).toBeTruthy());
  });

  it("shows a human error (role=alert) when saving fails and keeps the form", async () => {
    __setCompleteSocialProfile(async () => {
      throw new Error("23505 duplicate key");
    });
    renderProfile();
    fireEvent.change(screen.getByLabelText("Mobile (Bangladesh)"), {
      target: { value: "01812345678" },
    });
    await waitFor(() => expect(screen.getByText(/username available/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't save|try again/i);
    expect(alert.textContent).not.toContain("23505");
    // Form state is preserved for retry.
    expect((screen.getByLabelText("Mobile (Bangladesh)") as HTMLInputElement).value).toBe(
      "01812345678",
    );
  });

  it("surfaces a human error when the wired service cannot save (unconfigured backend)", async () => {
    __resetCompleteSocialProfile();
    renderProfile();
    fireEvent.change(screen.getByLabelText("Mobile (Bangladesh)"), {
      target: { value: "01812345678" },
    });
    await waitFor(() => expect(screen.getByText(/username available/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toBeTruthy();
    // Pinned to the unconfigured-backend copy: proves the stubbed client
    // boundary (not a coincidental network failure) produced this error.
    expect(alert.textContent).toMatch(/couldn't save your profile right now/i);
  });

  it("keyboard path: labelled fields in focus order and form submit completes", async () => {
    const complete = vi.fn(async () => FAKE_USER);
    __setCompleteSocialProfile(complete);
    const { container } = renderProfile();
    const form = container.querySelector("form");
    expect(form).toBeTruthy();
    for (const label of ["Name", "Username", "Mobile (Bangladesh)"]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    fireEvent.change(screen.getByLabelText("Mobile (Bangladesh)"), {
      target: { value: "01812345678" },
    });
    await waitFor(() => expect(screen.getByText(/username available/i)).toBeTruthy());
    fireEvent.submit(form!);
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  });
});

describe("buildUsernameSuggestion (W0.6 local stopgap)", () => {
  it("derives from the Google name when usable", () => {
    expect(buildUsernameSuggestion("Sheikh Aftab", "x@example.com")).toBe("sheikh_aftab");
  });

  it("falls back to the email local-part", () => {
    expect(buildUsernameSuggestion(null, "New.User+tag@example.com")).toBe("new_user_tag");
  });

  it("always yields a submittable shape", () => {
    for (const value of [
      buildUsernameSuggestion("A", "b@example.com"),
      buildUsernameSuggestion("***", "c@example.com"),
      buildUsernameSuggestion(null, "d@example.com"),
    ]) {
      expect(value).toMatch(/^[A-Za-z0-9_]{3,20}$/);
    }
  });
});

describe("CompleteProfileRoute (W0-QA defect 2)", () => {
  function renderRoute(entry: unknown = "/complete-profile") {
    return render(
      <MemoryRouter initialEntries={[entry as string]}>
        <Routes>
          <Route path="/complete-profile" element={<CompleteProfileRoute />} />
          <Route path="/auth" element={<p>Auth screen</p>} />
          <Route path="/" element={<p>Home destination</p>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("reads the seed from auth-context needsProfile (restart path, no router state)", async () => {
    __setCompleteSocialProfile(async () => FAKE_USER);
    authMock.needsProfile = { ...SEED, avatarUrl: null };
    renderRoute();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Google User");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
      "google.user@example.com",
    );
  });

  it("success sets the user AND clears needsProfile, then lands home", async () => {
    __setCompleteSocialProfile(async () => FAKE_USER);
    authMock.needsProfile = { ...SEED, avatarUrl: null };
    renderRoute();
    fireEvent.change(screen.getByLabelText("Mobile (Bangladesh)"), {
      target: { value: "01812345678" },
    });
    await waitFor(() => expect(screen.getByText(/username available/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(authMock.setUser).toHaveBeenCalledWith(FAKE_USER));
    expect(authMock.clearNeedsProfile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("Home destination")).toBeTruthy());
  });

  it("without any seed it returns to /auth (never a blank form)", () => {
    authMock.needsProfile = null;
    renderRoute();
    expect(screen.getByText("Auth screen")).toBeTruthy();
  });
});
