// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const authMock = vi.hoisted(() => ({ userId: "user-1" as string | null }));
vi.mock("../auth", () => ({
  useAuth: () => ({ user: authMock.userId ? { id: authMock.userId } : null }),
}));
vi.mock("../services/aiCredentials", () => ({
  aiCredentials: {
    get: async () => null,
    hasSaved: async () => false,
    connect: async () => {},
    remove: async () => {},
    unlock: async () => {},
    hasCredential: async () => false,
    credentialHandle: (accountId: string, provider: string) => ({
      accountId,
      provider,
    }),
  },
  SUPPORTED_AI_PROVIDERS: ["openrouter"],
}));
vi.mock("../services/openRouter", () => ({
  createOpenRouterClient: () => ({ validateKey: async () => ({}) }),
}));
vi.mock("../services/supabaseClient", () => ({
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));

import { PROBE_VERSION } from "../services/ai/deviceProbe";
import type { ProbeContext, ProbeRecord } from "../services/ai/deviceProbe";
import { AiAdvanced } from "../screens/AiAdvanced";
import { AiModels } from "../screens/AiModels";

afterEach(cleanup);

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

describe("WS-E AI UI gates (hidden without evidence, measured with evidence)", () => {
  it("AiAdvanced hides Auto/GPU/Needle/offline sections without evidence", () => {
    render(
      <MemoryRouter>
        <AiAdvanced />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("ai-gate-auto").textContent).toMatch(/hidden/i);
    expect(screen.getByTestId("ai-gate-gpu").textContent).toMatch(/hidden/i);
    expect(screen.getByTestId("ai-gate-needle").textContent).toMatch(/hidden/i);
    expect(screen.getByTestId("ai-gate-offline").textContent).toMatch(
      /hidden/i,
    );
  });

  it("AiAdvanced shows measured copy with fresh evidence", () => {
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
    expect(screen.getByTestId("ai-gate-auto").textContent).toMatch(
      /measured/i,
    );
    expect(screen.getByTestId("ai-gate-gpu").textContent).toMatch(/measured/i);
    expect(screen.getByTestId("ai-gate-needle").textContent).toMatch(
      /measurement/i,
    );
    expect(screen.getByTestId("ai-gate-offline").textContent).toMatch(
      /verified/i,
    );
  });

  it("AiModels hides gates without evidence and shows measured copy with evidence", () => {
    const { unmount } = render(
      <MemoryRouter>
        <AiModels accountId="u1" listCatalog={async () => []} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("ai-gate-auto").textContent).toMatch(/hidden/i);
    expect(screen.getByTestId("ai-gate-gpu").textContent).toMatch(/hidden/i);
    unmount();

    render(
      <MemoryRouter>
        <AiModels
          accountId="u1"
          listCatalog={async () => []}
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
    expect(screen.getByTestId("ai-gate-auto").textContent).toMatch(
      /measured/i,
    );
    expect(screen.getByTestId("ai-gate-offline").textContent).toMatch(
      /verified/i,
    );
  });

  it("AiAdvanced diagnostics export button calls the user export", () => {
    const exportDiagnostics = vi.fn(() => JSON.stringify([{ v: 1 }]));
    render(
      <MemoryRouter>
        <AiAdvanced exportDiagnostics={exportDiagnostics} />
      </MemoryRouter>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /export diagnostics/i }),
    );
    expect(exportDiagnostics).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ai-diag-export-status").textContent).toMatch(
      /1 event/i,
    );
  });
});
