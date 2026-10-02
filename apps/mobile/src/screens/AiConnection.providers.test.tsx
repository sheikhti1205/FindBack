// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const mocks = vi.hoisted(() => ({
  validateKey: vi.fn(async () => ({ remaining: 3 })),
  connect: vi.fn(async () => {}),
  get: vi.fn(async () => null as string | null),
  hasSaved: vi.fn(async () => false),
  unlock: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  credentialHandle: vi.fn((accountId: string, provider: string) => ({
    accountId,
    provider,
    handle: `vault-v1:${provider}`,
  })),
  hasCredential: vi.fn(async () => false),
  currentUserId: "user-1" as string | null,
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: mocks.currentUserId ? { id: mocks.currentUserId } : null }) }));
vi.mock("../services/aiCredentials", () => ({
  aiCredentials: mocks,
  SUPPORTED_AI_PROVIDERS: [
    "openrouter",
    "openai",
    "anthropic",
    "google",
    "deepseek",
    "mistral",
    "groq",
    "xai",
    "cohere",
    "generic",
  ],
}));
vi.mock("../services/openRouter", () => ({
  createOpenRouterClient: () => ({ validateKey: mocks.validateKey }),
}));
vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));

import { AiConnection } from "./AiConnection";
import { AiModels } from "./AiModels";

const BYOK_CASES = [
  { provider: "openrouter", label: "OpenRouter" },
  { provider: "openai", label: "OpenAI" },
  { provider: "anthropic", label: "Anthropic" },
  { provider: "google", label: "Google" },
  { provider: "deepseek", label: "DeepSeek" },
  { provider: "mistral", label: "Mistral" },
  { provider: "groq", label: "Groq" },
  { provider: "xai", label: "xAI" },
  { provider: "cohere", label: "Cohere" },
  { provider: "generic", label: "Custom endpoint" },
] as const;

function renderConnection(initialProvider: string) {
  return render(
    <MemoryRouter initialEntries={[`/ai-connection?provider=${initialProvider}`]}>
      <AiConnection />
    </MemoryRouter>,
  );
}

/** Settle the mount-time slot read before interacting, as a real user would. */
async function renderSettledConnection(initialProvider: string) {
  const view = renderConnection(initialProvider);
  await waitFor(() => expect(mocks.get).toHaveBeenCalled());
  return view;
}

describe("AiConnection per-provider BYOK slots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUserId = "user-1";
    mocks.get.mockResolvedValue(null);
    mocks.hasSaved.mockResolvedValue(false);
  });
  afterEach(cleanup);

  for (const { provider, label } of BYOK_CASES) {
    it(`saves ${provider} through its exact slot (Manage landing works)`, async () => {
      await renderSettledConnection(provider);
      // The routed slot is selected and its own key field is shown.
      expect((screen.getByLabelText("AI provider") as HTMLSelectElement).value).toBe(provider);
      const raw = `h1-prov-key-for-${provider}-abcdef`;
      fireEvent.change(screen.getByLabelText(`${label} API key`), { target: { value: raw } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      if (provider === "openrouter") {
        await waitFor(() =>
          expect(mocks.connect).toHaveBeenCalledWith("user-1", raw, { remember: false }),
        );
        expect(mocks.validateKey).toHaveBeenCalledWith(raw);
      } else {
        await waitFor(() =>
          expect(mocks.connect).toHaveBeenCalledWith("user-1", raw, {
            remember: false,
            provider,
          }),
        );
        // Non-OpenRouter slots save without a live key test on this screen.
        expect(mocks.validateKey).not.toHaveBeenCalled();
      }
      expect(screen.getByRole("status").textContent).toContain("Connected");
      expect(screen.getByRole("status").textContent).toContain(label);
      // Plaintext is cleared from the form after save.
      expect(document.body.textContent).not.toContain(raw);
    });
  }

  it("shows a masked tail only for the routed anthropic slot", async () => {
    mocks.get.mockImplementation((async (userId: string, slot?: string) =>
      slot === "anthropic" ? "sk-ant-test-key-tail-7890" : null) as never);
    await renderSettledConnection("anthropic");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("••••7890"),
    );
    expect(screen.getByRole("status").textContent).toContain("Anthropic");
    expect(document.body.textContent).not.toContain("sk-ant-test-key-tail-7890");
  });

  it("removes the exact groq slot", async () => {
    mocks.get.mockImplementation((async (_userId: string, slot?: string) =>
      slot === "groq" ? "gsk-live-groq-key" : null) as never);
    await renderSettledConnection("groq");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Connected"));
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("user-1", "groq"));
    expect(screen.getByRole("status").textContent).toContain("Disconnected");
  });

  it("unlocks the exact cohere slot with its passphrase", async () => {
    mocks.get.mockResolvedValue(null);
    mocks.hasSaved.mockImplementation((async (_userId: string, slot?: string) =>
      slot === "cohere") as never);
    await renderSettledConnection("cohere");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Unlock saved key" })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Unlock phrase"), {
      target: { value: "cohere unlock phrase long" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock saved key" }));
    await waitFor(() =>
      expect(mocks.unlock).toHaveBeenCalledWith(
        "user-1",
        "cohere unlock phrase long",
        "cohere",
      ),
    );
  });

  it("keeps session-only vs remembered explicit on the xai slot", async () => {
    await renderSettledConnection("xai");
    expect(screen.getByLabelText("Remember on this device")).toBeTruthy();
    expect(screen.queryByLabelText("Unlock phrase")).toBeNull();
    fireEvent.click(screen.getByLabelText("Remember on this device"));
    expect(screen.getByLabelText("Unlock phrase")).toBeTruthy();
    expect(screen.getByText(/session-only keys/i)).toBeTruthy();
  });

  it("honors the provider prop for the mistral slot", async () => {
    render(
      <MemoryRouter>
        <AiConnection provider="mistral" />
      </MemoryRouter>,
    );
    expect((screen.getByLabelText("AI provider") as HTMLSelectElement).value).toBe("mistral");
    expect(screen.getByLabelText("Mistral API key")).toBeTruthy();
  });

  it("resets the key form when the account switches on the google slot", async () => {
    mocks.get.mockImplementation((async (userId: string) =>
      userId === "user-1" ? "google-key-user-1" : null) as never);
    const view = renderConnection("google");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Connected"));
    mocks.currentUserId = "user-2";
    view.rerender(
      <MemoryRouter initialEntries={["/ai-connection?provider=google"]}>
        <AiConnection />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Disconnected"));
    expect(mocks.get).toHaveBeenCalledWith("user-2", "google");
  });
});

describe("AiModels Manage actions deep-link to the provider's slot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUserId = "user-1";
    mocks.get.mockResolvedValue(null);
    mocks.hasSaved.mockResolvedValue(false);
  });
  afterEach(cleanup);

  it("links every BYOK provider to its own connection form", async () => {
    render(
      <MemoryRouter>
        <AiModels accountId="u1" listCatalog={async () => []} />
      </MemoryRouter>,
    );
    for (const { provider, label } of BYOK_CASES) {
      const card = await screen.findByTestId(`ai-provider-${provider}`);
      const manage = within(card).getByRole("link", {
        name: new RegExp(`manage ${label} key`, "i"),
      });
      expect(manage.getAttribute("href")).toBe(`/ai-connection?provider=${provider}`);
    }
  });
});
