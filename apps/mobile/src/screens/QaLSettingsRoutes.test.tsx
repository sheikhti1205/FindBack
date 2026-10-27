// @vitest-environment jsdom
/**
 * QA L app-level audit: every settings backTo lands on a mounted route
 * (real <App/> with marker screens), Diagnostics renders no secret-shaped
 * strings with fixture data, and consumer-tier AI screens render no raw
 * technical terms (checksum/SHA/revision/TTFT/model-enum).
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  booting: false,
  bootError: null as string | null,
  retryBoot: vi.fn(),
}));
const aiCreds = vi.hoisted(() => ({
  get: vi.fn(async () => null as string | null),
  hasSaved: vi.fn(async () => false),
}));
vi.mock("../auth", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ ...auth, logout: vi.fn(async () => {}) }),
}));
vi.mock("../theme", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));
vi.mock("../appearance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../appearance")>();
  return {
    ...actual,
    useAppearance: () => ({
      settings: { accent: "emerald", textScale: "standard", reduceMotion: "system", highQualityPhoto: false },
      update: vi.fn(),
    }),
  };
});
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false }, registerPlugin: () => ({}) }));
vi.mock("@capacitor/app", () => ({
  App: { getLaunchUrl: async () => undefined, addListener: () => Promise.resolve({ remove: () => {} }) },
}));
vi.mock("./Onboarding", () => ({ Onboarding: () => <p>Onboarding screen</p>, ONBOARDING_PAGES: [] }));
vi.mock("../services/aiCredentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/aiCredentials")>();
  return { ...actual, aiCredentials: aiCreds };
});
vi.mock("../services/notificationPreferences", () => ({
  fetchNotificationPreferences: async () => ({ pushEnabled: true }),
}));
vi.mock("../services/pushRuntime", () => ({
  pushController: () => ({ permission: async () => "unsupported" as const }),
  // ChatPushLinkHandler mounts on every route and imports these; a partial mock
  // makes them undefined and the component throws on every render.
  CHAT_PUSH_BOUND_EVENT: "findback:chat-push-bound",
  takeChatPushTap: async () => null,
  listenForChatPushTap: async () => () => {},
  acknowledgeChatPushTap: async () => {},
}));

import { App, createAppRouter } from "../App";
let router: ReturnType<typeof createAppRouter> | undefined;

function renderAt(hash: string) {
  window.history.replaceState(null, "", `/#${hash}`);
  router?.dispose();
  router = createAppRouter();
  return render(<App router={router} />);
}

beforeEach(() => {
  auth.user = { id: "u1" };
  auth.booting = false;
  auth.bootError = null;
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  router?.dispose();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

/** Every backTo/fallbackTo used by settings screens, plus every row target. */
const BACK_TO_ROUTES = [
  "/settings",
  "/settings/ai",
  "/settings/account",
  "/profile",
  "/",
  "/settings/appearance",
  "/settings/accessibility",
  "/settings/feed-layout",
  "/settings/media",
  "/settings/notifications",
  "/settings/privacy",
  "/settings/help",
  "/settings/about",
  "/settings/diagnostics",
  "/settings/ai/models",
  "/settings/ai/connections",
  "/settings/local-intelligence",
  "/settings/local-intelligence/downloads",
  "/onboarding?replay=1",
  "/verify",
  "/my",
  "/search",
  "/report",
  "/notifications",
  "/help",
  "/ai-connection",
  "/ai-models",
  "/profile/edit",
  "/settings/terms",
  "/settings/privacy-policy",
  "/settings/community-guidelines",
] as const;

describe("QA L: every settings backTo lands on a mounted route", () => {
  it.each(BACK_TO_ROUTES)("route %s renders content (no splash redirect)", async (route) => {
    renderAt(route);
    await waitFor(() => {
      expect(document.body.textContent!.length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("Loading FindBack…")).toBeNull();
  });
});

describe("QA L: the legal documents are reachable and say what they are", () => {
  it.each([
    ["/settings/terms", "Terms of use"],
    ["/settings/privacy-policy", "Privacy policy"],
    ["/settings/community-guidelines", "Community guidelines"],
  ] as const)("route %s renders its own document", async (route, heading) => {
    renderAt(route);
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: heading })).not.toBeNull();
    });
    // A legal document is not a placeholder: it carries text.
    expect((document.body.textContent ?? "").length).toBeGreaterThan(200);
  });
});

const SECRET_SHAPED =
  /sk-(?:or-v1|proj|live)-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[bap]-[A-Za-z0-9-]{8,}|gh[oprsu]_[A-Za-z0-9]{8,}|sb_secret_[A-Za-z0-9_-]{8,}|api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i;

describe("QA L: Diagnostics renders no secret-shaped strings", () => {
  it("fixture render carries no keys, tokens, or key material", async () => {
    renderAt("/settings/diagnostics");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Diagnostics" })).not.toBeNull();
    });
    expect(document.body.textContent ?? "").not.toMatch(SECRET_SHAPED);
  });
});

const CONSUMER_FORBIDDEN =
  /sha-?256|\bsha\b|checksum|catalogue pin|revision|ttft|tokens\/s|\.gguf|\.onnx|quantiz|unknown model \S+/i;

describe("QA L: consumer-tier AI screens render no raw technical terms", () => {
  it.each([
    "/settings/ai",
    "/settings/ai/models",
    "/settings/ai/connections",
    "/settings/local-intelligence",
    "/settings/local-intelligence/downloads",
  ] as const)(
    "screen %s stays consumer-worded",
    async (route) => {
      renderAt(route);
      await waitFor(() => {
        expect(document.body.textContent!.length).toBeGreaterThan(0);
      });
      expect(document.body.textContent ?? "").not.toMatch(CONSUMER_FORBIDDEN);
    },
  );

  it("no consumer route reaches a benchmark or CPU/GPU screen any more", async () => {
    // Owner direction 2026-10-25: the benchmark/CPU-GPU surface is not a
    // consumer surface at all, so the route must not exist and no consumer
    // screen may link to it.
    renderAt("/settings/ai/advanced");
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Advanced" })).toBeNull();
    });
    for (const route of ["/settings/ai", "/settings/ai/models", "/settings/local-intelligence"]) {
      renderAt(route);
      await waitFor(() => {
        expect(document.body.textContent!.length).toBeGreaterThan(0);
      });
      expect(screen.queryByText(/measure performance|run speed tests/i)).toBeNull();
      expect(screen.queryByRole("link", { name: /advanced/i })).toBeNull();
    }
  });
});
