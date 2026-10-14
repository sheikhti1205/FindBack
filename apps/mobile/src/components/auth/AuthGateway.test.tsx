// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeBackIntercept, resetBackInterceptors } from "../backNavigation";

const { authMock, pendingMock, servicesMock } = vi.hoisted(() => ({
  authMock: {
    user: null as null,
    booting: false,
    pendingEmail: null as null | string,
    login: vi.fn(),
    register: vi.fn(),
    verifyPendingEmail: vi.fn(),
    resendPendingEmail: vi.fn(),
  },
  pendingMock: { getPendingReportRoute: vi.fn((): string | null => null) },
  servicesMock: { checkUsername: vi.fn() },
}));

vi.mock("../../auth", () => ({ useAuth: () => authMock }));
vi.mock("../../services/auth", () => servicesMock);
vi.mock("../../utils/pendingReportLink", () => pendingMock);

import { checkUsername } from "../../services/auth";
import { AuthGateway } from "../../screens/AuthGateway";
import { SignIn } from "../../screens/SignIn";
import { Register } from "../../screens/Register";

const mockCheckUsername = vi.mocked(checkUsername);

function renderGateway(ui: React.ReactNode = <AuthGateway />, path = "/auth") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/auth" element={ui} />
        <Route path="/signin" element={ui} />
        <Route path="/register" element={ui} />
        <Route path="/posts/:id" element={<p>Shared report destination</p>} />
        <Route path="/" element={<p>Home destination</p>} />
        <Route path="/verify" element={<p>Verify destination</p>} />
        <Route path="/forgot" element={<p>Forgot destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function continueWithEmail(email: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Change" })).toBeTruthy());
}

async function changeEmailBackTo(expectedValue: string) {
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  // The outgoing stage exits before the email form re-enters (AnimatePresence
  // mode="wait"), so the label must be awaited, not queried synchronously.
  await waitFor(() => expect(screen.getByLabelText("Email")).toBeTruthy());
  expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(expectedValue);
}

beforeEach(() => {
  authMock.user = null;
  authMock.pendingEmail = null;
  authMock.login.mockReset();
  authMock.register.mockReset();
  mockCheckUsername.mockReset();
  pendingMock.getPendingReportRoute.mockReset();
  pendingMock.getPendingReportRoute.mockReturnValue(null);
  resetBackInterceptors();
  vi.restoreAllMocks();
});

afterEach(cleanup);

describe("AuthGateway stage A (email)", () => {
  it("shows the canonical Welcome title with a syntax-only Continue", () => {
    renderGateway();
    expect(screen.getByRole("heading", { level: 1, name: "Welcome to FindBack" })).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("rejects malformed email without any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    try {
      renderGateway();
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "not-an-email" } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(screen.getByText("Enter a valid email address.")).toBeTruthy(),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockCheckUsername).not.toHaveBeenCalled();
      // Still on stage A: no password, no signup fields.
      expect(screen.queryByLabelText("Password")).toBeNull();
      expect(screen.queryByLabelText("Username")).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("performs NO existence probe on Continue with an unknown email", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
    try {
      renderGateway();
      fireEvent.change(screen.getByLabelText("Email"), {
        target: { value: "unknown-user-xyz@example.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      // Local stage transition only: sign-in stage appears.
      await waitFor(() => expect(screen.getByRole("button", { name: "Change" })).toBeTruthy());
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockCheckUsername).not.toHaveBeenCalled();
      expect(authMock.login).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("AuthGateway stage B (sign in)", () => {
  it("morphs email into an identity chip with Change restoring the address", async () => {
    renderGateway();
    await continueWithEmail("user@example.com");
    expect(screen.getByText("user@example.com")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();

    await changeEmailBackTo("user@example.com");
    await waitFor(() => expect(screen.queryByLabelText("Password")).toBeNull());
  });

  it("shows the identical generic failure whether or not the email exists", async () => {
    authMock.login.mockRejectedValue(new Error("Invalid credentials"));
    renderGateway();
    await continueWithEmail("ghost@example.com");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(
        screen.getByText("We couldn't sign you in. Check your email and password and try again."),
      ).toBeTruthy(),
    );
    // The message must not leak which half was wrong.
    const alert = screen.getByRole("alert");
    expect(alert.textContent).not.toContain("ghost@example.com");

    // Same wording for a second, also-unknown address.
    authMock.login.mockRejectedValue(new Error("user_not_found"));
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(screen.getByLabelText("Email")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "other@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Change" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(
        screen.getAllByText(
          "We couldn't sign you in. Check your email and password and try again.",
        ).length,
      ).toBeGreaterThan(0),
    );
  });

  it("preserves the email across a transient failure", async () => {
    authMock.login.mockRejectedValueOnce(new Error("Network problem"));
    renderGateway();
    await continueWithEmail("keepme@example.com");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(
        screen.getByText("We couldn't sign you in. Check your email and password and try again."),
      ).toBeTruthy(),
    );
    expect(screen.getByText("keepme@example.com")).toBeTruthy();
  });

  it("routes a successful sign-in to the pending report destination", async () => {
    pendingMock.getPendingReportRoute.mockReturnValue("/posts/abc123");
    authMock.login.mockResolvedValue({ id: "u1" });
    render(
      <MemoryRouter initialEntries={["/signin"]}>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/posts/:id" element={<p>Shared report destination</p>} />
          <Route path="/" element={<p>Home destination</p>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByText("Shared report destination")).toBeTruthy());
  });

  it("routes Forgot password to /forgot carrying the email", async () => {
    renderGateway();
    await continueWithEmail("user@example.com");
    fireEvent.click(screen.getByRole("link", { name: /forgot password/i }));
    await waitFor(() => expect(screen.getByText("Forgot destination")).toBeTruthy());
  });
});

describe("AuthGateway stage C (explicit signup gating)", () => {
  it("keeps signup fields hidden until the user explicitly chooses it", async () => {
    renderGateway();
    await continueWithEmail("new@example.com");
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByLabelText("Mobile (Bangladesh)")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create account with this email" }));
    await waitFor(() => expect(screen.getByLabelText("Username")).toBeTruthy());
    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.value).toBe("new@example.com");
  });

  it("returns from signup to sign-in via the back interceptor", async () => {
    renderGateway();
    await continueWithEmail("new@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Create account with this email" }));
    await waitFor(() => expect(screen.getByLabelText("Username")).toBeTruthy());

    expect(consumeBackIntercept()).toBe(true);
    // The signup tree exits before sign-in re-enters; Username leaving is the
    // signal the new stage has settled.
    await waitFor(() => expect(screen.queryByLabelText("Username")).toBeNull());
    expect(screen.getByLabelText("Password")).toBeTruthy();

    expect(consumeBackIntercept()).toBe(true);
    await waitFor(() => expect(screen.getByLabelText("Email")).toBeTruthy());
    // Email root: nothing left to consume in-gateway.
    expect(consumeBackIntercept()).toBe(false);
  });
});

describe("AuthGateway compat entry points", () => {
  it("/signin renders the sign-in mode standalone (no Continue step)", () => {
    render(
      <MemoryRouter initialEntries={["/signin"]}>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("/register renders the signup mode standalone", () => {
    mockCheckUsername.mockResolvedValue({ available: true, normalized: "taken" });
    render(
      <MemoryRouter initialEntries={["/register"]}>
        <Routes>
          <Route path="/register" element={<Register />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Username")).toBeTruthy();
    expect(screen.getByLabelText("Mobile (Bangladesh)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();
  });
});

// ── W0-C (S3) appended coverage: Google entry point. Everything above stays
// byte-identical; these blocks only ADD behavior pins for the insertion. ──
import { useLocation } from "react-router";
import {
  __resetGoogleSignInSeams,
  __setGoogleSignInSeams,
  type GoogleProfileSeed,
  type GoogleSignInOutcome,
} from "./GoogleSignInButton";

const GOOGLE_SEED: GoogleProfileSeed = {
  email: "google.new@example.com",
  name: "Google New",
  avatarUrl: null,
  phone: "",
  suggestedUsername: "google_new",
  accountId: "google-new",
};

function configureGoogleSeams(outcome: GoogleSignInOutcome) {
  __setGoogleSignInSeams({
    strategy: () => "android-native",
    startGoogleSignIn: async () => ({
      idToken: "fake-google-id-token",
      nonce: "fake-google-nonce",
      email: GOOGLE_SEED.email,
      name: GOOGLE_SEED.name,
      avatarUrl: null,
      phone: null,
    }),
    signInWithGoogleIdToken: async () => outcome,
  });
}

function SeedProbe() {
  const location = useLocation();
  const seed = (location.state as { seed?: GoogleProfileSeed } | null)?.seed;
  return <p>Seed email: {seed?.email ?? "none"}</p>;
}

describe("AuthGateway Google entry (W0-C S3, appended)", () => {
  it("shows Continue with Google above the email form with an or divider", () => {
    configureGoogleSeams({ status: "needsProfile", seed: GOOGLE_SEED });
    try {
      renderGateway();
      const googleButton = screen.getByRole("button", { name: "Continue with Google" });
      const emailField = screen.getByLabelText("Email");
      const separator = screen.getByRole("separator", { name: "or" });
      // Hierarchy: Continue with Google / — or — / Email… Continue.
      expect(
        googleButton.compareDocumentPosition(emailField) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        separator.compareDocumentPosition(emailField) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    } finally {
      __resetGoogleSignInSeams();
    }
  });

  it("email Continue still advances to sign-in with Google configured", async () => {
    configureGoogleSeams({ status: "needsProfile", seed: GOOGLE_SEED });
    try {
      renderGateway();
      await continueWithEmail("user@example.com");
      expect(screen.getByLabelText("Password")).toBeTruthy();
    } finally {
      __resetGoogleSignInSeams();
    }
  });

  it("sign-in/signup stages show no Google button (insertion is email-stage only)", async () => {
    configureGoogleSeams({ status: "needsProfile", seed: GOOGLE_SEED });
    try {
      renderGateway();
      await continueWithEmail("user@example.com");
      expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    } finally {
      __resetGoogleSignInSeams();
    }
  });

  it("fail-closed when unavailable: no button, no divider, email flow intact", async () => {
    __setGoogleSignInSeams({ strategy: () => "unavailable" });
    try {
      renderGateway();
      expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
      expect(screen.queryByRole("separator", { name: "or" })).toBeNull();
      await continueWithEmail("user@example.com");
      expect(screen.getByLabelText("Password")).toBeTruthy();
    } finally {
      __resetGoogleSignInSeams();
    }
  });

  it("routes a new Google account to /complete-profile carrying the seed", async () => {
    configureGoogleSeams({ status: "needsProfile", seed: GOOGLE_SEED });
    try {
      render(
        <MemoryRouter initialEntries={["/auth"]}>
          <Routes>
            <Route path="/auth" element={<AuthGateway />} />
            <Route path="/complete-profile" element={<SeedProbe />} />
            <Route path="/" element={<p>Home destination</p>} />
          </Routes>
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
      await waitFor(() =>
        expect(screen.getByText("Seed email: google.new@example.com")).toBeTruthy(),
      );
    } finally {
      __resetGoogleSignInSeams();
    }
  });

  it("completes an existing Google-linked account into the pending destination", async () => {
    const linkedUser = { id: "u-linked" };
    configureGoogleSeams({ status: "authenticated", user: linkedUser as never });
    const setUser = vi.fn();
    (authMock as unknown as { setUser: unknown }).setUser = setUser;
    pendingMock.getPendingReportRoute.mockReturnValue("/posts/abc123");
    try {
      render(
        <MemoryRouter initialEntries={["/auth"]}>
          <Routes>
            <Route path="/auth" element={<AuthGateway />} />
            <Route path="/posts/:id" element={<p>Shared report destination</p>} />
            <Route path="/" element={<p>Home destination</p>} />
          </Routes>
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
      await waitFor(() => expect(screen.getByText("Shared report destination")).toBeTruthy());
      expect(setUser).toHaveBeenCalledWith(linkedUser);
    } finally {
      __resetGoogleSignInSeams();
      delete (authMock as unknown as { setUser?: unknown }).setUser;
    }
  });
});
