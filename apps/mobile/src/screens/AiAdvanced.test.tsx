// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const adapterMocks = vi.hoisted(() => ({
  listModels: vi.fn(async () => [
    { id: "acme/one", provider: "openrouter" },
    { id: "acme/two", provider: "openrouter" },
  ]),
}));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("../services/aiCredentials", () => ({
  aiCredentials: {
    get: async () => "test-key",
    hasCredential: async () => true,
    credentialHandle: (accountId: string, provider: string) => ({ accountId, provider }),
  },
  SUPPORTED_AI_PROVIDERS: ["openrouter", "openai"],
}));
vi.mock("../services/ai/providerRegistry", () => ({
  createProviderAdapter: () => ({ listModels: adapterMocks.listModels }),
}));
vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));

import { PROBE_VERSION } from "../services/ai/deviceProbe";
import type { ProbeContext, ProbeRecord } from "../services/ai/deviceProbe";
import { AiAdvanced } from "./AiAdvanced";

const CONTEXT: ProbeContext = {
  modelRev: "rev-a",
  probeVersion: PROBE_VERSION,
  corpusVersion: "ws7-v1",
};

function cpuProbe(): ProbeRecord {
  return {
    socModel: "Test SoC",
    gpuInfo: "Test GPU",
    ramMb: 8192,
    osVersion: "Android 15",
    backend: "cpu",
    ttftMs: 200,
    tokensPerSec: 20,
    corpusVersion: CONTEXT.corpusVersion,
    probeVersion: CONTEXT.probeVersion,
    modelRev: CONTEXT.modelRev,
    correctnessPass: true,
  };
}

function gpuProbe(): ProbeRecord {
  return { ...cpuProbe(), backend: "gpu", tokensPerSec: 42, ttftMs: 120 };
}

describe("AiAdvanced diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });
  afterEach(cleanup);

  it("advanced provider checks also require default-off experimental opt-in", () => {
    render(<MemoryRouter><AiAdvanced /></MemoryRouter>);
    expect(screen.getByRole("button", { name: /test openrouter/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /test openai/i })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Experimental providers" }));
    expect(screen.getByRole("button", { name: /test openai/i })).toBeTruthy();
    expect(screen.getByText(/not live-send verified/i)).toBeTruthy();
  });

  it("renders one h1 and links back to the AI root", () => {
    render(
      <MemoryRouter>
        <AiAdvanced />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/advanced/i);
    expect(screen.getByRole("button", { name: /back to ai/i })).toBeTruthy();
  });

  it("hides measurement gates without evidence", () => {
    render(
      <MemoryRouter>
        <AiAdvanced />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("ai-gate-auto").textContent).toMatch(/hidden/i);
    expect(screen.getByTestId("ai-gate-gpu").textContent).toMatch(/hidden/i);
    expect(screen.getByTestId("ai-gate-needle").textContent).toMatch(/hidden/i);
    expect(screen.getByTestId("ai-gate-offline").textContent).toMatch(/hidden/i);
  });

  it("shows measured copy with fresh evidence", () => {
    render(
      <MemoryRouter>
        <AiAdvanced
          probeRecords={[cpuProbe(), gpuProbe()]}
          probeContext={CONTEXT}
          needleEvidence={{ measured: true, correctnessPass: true, fresh: true }}
          offlineStatus={{
            modelId: "test-model",
            download: "installed",
            residency: "unloaded",
            downloadedBytes: 1000,
            checksumVerified: true,
            updatedAt: new Date().toISOString(),
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("ai-gate-auto").textContent).toMatch(/measured/i);
    expect(screen.getByTestId("ai-gate-gpu").textContent).toMatch(/measured/i);
    expect(screen.getByTestId("ai-gate-needle").textContent).toMatch(/measurement/i);
    expect(screen.getByTestId("ai-gate-offline").textContent).toMatch(/verified/i);
  });

  it("derives offline-model evidence from the live service when no override is passed", async () => {
    const { ApplicationAiService, DOWNLOAD_MODELS } = await import("../services/ai/applicationAi");
    const service = new ApplicationAiService({ android: false });
    await service.ready;
    // Installed + checksum-verified in the manager, no offlineStatus prop.
    const modelId = DOWNLOAD_MODELS[0]!.modelId;
    const pin = service.registry.requireDescriptor(modelId).sha256;
    service.manager.dispatch(modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    service.manager.dispatch(modelId, { type: "START" });
    service.manager.dispatch(modelId, { type: "VERIFY_START" });
    service.manager.dispatch(modelId, { type: "VERIFY_OK", actualSha256: pin });
    render(
      <MemoryRouter>
        <AiAdvanced service={service} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("ai-gate-offline").textContent).toMatch(/verified/i);
  });

  it("keeps exact technical values reachable here", () => {
    const view = render(
      <MemoryRouter>
        <AiAdvanced />
      </MemoryRouter>,
    );
    const text = view.container.textContent ?? "";
    // Exact model identity and integrity material live on this screen only.
    expect(text).toMatch(/needle3-cact-l20/);
    expect(text).toMatch(/smolvlm2-500M-vision/);
    expect(text).toMatch(/[0-9a-f]{16,}/);
  });

  it("runs provider tests through the existing adapter seam", async () => {
    render(
      <MemoryRouter>
        <AiAdvanced accountId="user-1" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /test openrouter/i }));
    const notice = await screen.findByText(/answered and listed 2 models/i);
    expect(notice).toBeTruthy();
    expect(adapterMocks.listModels).toHaveBeenCalled();
  });

  it("exports redacted diagnostics on demand", () => {
    const exportDiagnostics = vi.fn(() => JSON.stringify([{ v: 1 }]));
    render(
      <MemoryRouter>
        <AiAdvanced exportDiagnostics={exportDiagnostics} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /export diagnostics/i }));
    expect(exportDiagnostics).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ai-diag-export-status").textContent).toMatch(/1 event/i);
  });

  it("keeps device measurement honest without native support", async () => {
    const { ApplicationAiService } = await import("../services/ai/applicationAi");
    const webService = new ApplicationAiService({ android: false });
    await webService.ready;
    render(
      <MemoryRouter>
        <AiAdvanced service={webService} />
      </MemoryRouter>,
    );
    const measure = screen.getByRole("button", { name: /measure cpu/i });
    expect((measure as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/require the android app/i)).toBeTruthy();
  });
});
