// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@findback/shared";
import {
  __resetGoogleSignInSeams,
  __setGoogleSignInSeams,
  GoogleSignInButton,
  type GoogleSignInOutcome,
} from "./GoogleSignInButton";

const FAKE_USER: PublicUser = {
  id: "u1",
  username: "test_user",
  email: "test@example.com",
  phone: "+8801812345678",
  emailVerified: true,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00Z",
};

afterEach(() => {
  cleanup();
  __resetGoogleSignInSeams();
  vi.restoreAllMocks();
});

function configureAvailable(seams?: {
  start?: (opts: { mode: "signin" | "signup" }) => Promise<{
    idToken: string;
    email?: string | null;
    name?: string | null;
    avatarUrl?: string | null;
    phone?: string | null;
  }>;
  signIn?: (idToken: string) => Promise<GoogleSignInOutcome>;
}) {
  __setGoogleSignInSeams({
    isGoogleAuthAvailable: () => true,
    startGoogleSignIn:
      seams?.start ??
      (async () => {
        throw new Error("startGoogleSignIn must not be called");
      }),
    signInWithGoogleIdToken:
      seams?.signIn ??
      (async () => {
        throw new Error("signInWithGoogleIdToken must not be called");
      }),
  });
}

describe("GoogleSignInButton (S3)", () => {
  it("renders NOTHING when Google auth is unavailable (fail closed)", () => {
    __resetGoogleSignInSeams();
    const { container } = render(<GoogleSignInButton mode="signin" onDone={() => {}} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
  });

  it("renders an accessible, keyboard-focusable button when configured", () => {
    configureAvailable();
    render(<GoogleSignInButton mode="signup" onDone={() => {}} />);
    const button = screen.getByRole("button", { name: "Continue with Google" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.hasAttribute("disabled")).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it("calls startGoogleSignIn({mode}) then sign-in with the id token and forwards the outcome", async () => {
    const seed = {
      email: "new@example.com",
      name: "New User",
      avatarUrl: null,
      phone: "",
      suggestedUsername: "new_user",
    };
    const start = vi.fn(async (_opts: { mode: "signin" | "signup" }) => ({
      idToken: "tok-abc",
      email: seed.email,
      name: seed.name,
      avatarUrl: null,
      phone: null,
    }));
    const signIn = vi.fn(async (idToken: string) => {
      expect(idToken).toBe("tok-abc");
      return { status: "needsProfile", seed } as const;
    });
    const onDone = vi.fn();
    configureAvailable({ start, signIn });
    render(<GoogleSignInButton mode="signin" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledWith({ mode: "signin" });
    expect(signIn).toHaveBeenCalledWith("tok-abc");
    expect(onDone).toHaveBeenCalledWith({ status: "needsProfile", seed });
  });

  it("disables the button while the exchange is pending (no double submit)", async () => {
    let release!: (value: { idToken: string }) => void;
    const gate = new Promise<{ idToken: string }>((resolve) => {
      release = resolve;
    });
    const onDone = vi.fn();
    configureAvailable({
      start: () => gate,
      signIn: async () => ({ status: "authenticated", user: FAKE_USER }),
    });
    render(<GoogleSignInButton mode="signin" onDone={onDone} />);
    const button = screen.getByRole("button", { name: "Continue with Google" });
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    expect(button.getAttribute("aria-busy")).toBe("true");
    // Second activation while pending must not start a second exchange.
    fireEvent.click(button);
    release({ idToken: "tok-pending" });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("stays silent on provider cancel: no error, no onDone, button usable again", async () => {
    const start = vi.fn(async () => {
      const err = new Error("user closed the prompt") as Error & { kind: string };
      err.kind = "cancelled";
      throw err;
    });
    const onDone = vi.fn();
    configureAvailable({ start });
    render(<GoogleSignInButton mode="signin" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    // Settle the rejection into state.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Continue with Google" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "unavailable", pattern: /isn't available/i },
    { kind: "misconfigured", pattern: /isn't available/i },
    { kind: "network", pattern: /connection/i },
    { kind: "unknown", pattern: /failed.*try again/i },
  ])("maps failure kind '$kind' to a human message", async ({ kind, pattern }) => {
    const start = vi.fn(async () => {
      const err = new Error(`raw-${kind}-detail`) as Error & { kind: string };
      err.kind = kind;
      throw err;
    });
    const onDone = vi.fn();
    configureAvailable({ start });
    render(<GoogleSignInButton mode="signin" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(pattern);
    // Raw internals must never surface.
    expect(alert.textContent).not.toContain(`raw-${kind}-detail`);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("maps a Supabase rejection to a human message without internals", async () => {
    const onDone = vi.fn();
    configureAvailable({
      start: async () => ({ idToken: "tok-supabase-reject" }),
      signIn: async () => {
        throw new Error("PGRST116 unexpected");
      },
    });
    render(<GoogleSignInButton mode="signin" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/try again/i);
    expect(alert.textContent).not.toContain("PGRST116");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("never prints the provider token to diagnostics", async () => {
    const logged: unknown[][] = [];
    for (const method of ["log", "warn", "error", "debug", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const onDone = vi.fn();
    configureAvailable({
      start: async () => ({ idToken: "tok-must-never-appear" }),
      signIn: async () => {
        throw new Error("boom");
      },
    });
    render(<GoogleSignInButton mode="signin" onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await screen.findByRole("alert");
    const dumped = JSON.stringify(logged);
    expect(dumped).not.toContain("tok-must-never-appear");
  });
});
