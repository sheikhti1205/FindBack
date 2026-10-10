/**
 * Cactus runtime challenger seam (benchmark lane, never production).
 *
 * Same-model-vs-runtime comparison without replacing working runtimes:
 * LiteRT (`litert-lm`), llama.cpp (`llama-cpp`), and Needle (`needle-cact`)
 * stay the production owners. `cactus-lab` is a unified challenger that the
 * benchmark harness wires explicitly per run — it never registers with the
 * orchestrator, router, probe, UI picker, or packer.
 *
 * License + channel gates run before any native call (fail-closed):
 * - LFM-1.0 on bundle/download → blocked (benchmark/eval-only).
 * - pending pins on bundle/download → blocked (no verified bytes).
 * - non-lab channels (bundle/download/production) → LabChannelRequiredError.
 * - absent native bridge → lab-unavailable error (never a stub stand-in).
 */

import type { LabCandidate, LabDistributionChannel } from "./labCatalog";
import { labLicenseDecision } from "./labCatalog";

export const CACTUS_CHALLENGER_RUNTIME = "cactus-lab" as const;

export const CACTUS_LAB_CHANNELS: readonly LabDistributionChannel[] = ["benchmark", "eval"] as const;

export class CactusLicenseBlockedError extends Error {
  readonly modelId: string;
  readonly channel: LabDistributionChannel;

  constructor(modelId: string, channel: LabDistributionChannel, reason: string) {
    super(`cactus challenger blocked: ${modelId} (${channel}): ${reason}`);
    this.name = "CactusLicenseBlockedError";
    this.modelId = modelId;
    this.channel = channel;
  }
}

export class CactusChannelRequiredError extends Error {
  readonly channel: string;

  constructor(channel: string) {
    super(`cactus challenger requires a benchmark/eval channel, got ${channel}`);
    this.name = "CactusChannelRequiredError";
    this.channel = channel;
  }
}

export interface CactusGenerationChunk {
  readonly textDelta: string;
}

export interface CactusSession {
  readonly modelId: string;
  readonly runtime: typeof CACTUS_CHALLENGER_RUNTIME;
  readonly channel: LabDistributionChannel;
  generate(
    prompt: string,
    options: { generationId: string; maxTokens: number; signal: AbortSignal },
  ): AsyncGenerator<CactusGenerationChunk>;
  dispose(): Promise<void>;
}

/** Native Cactus bridge surface (Capacitor plugin). Faked in tests. */
export interface CactusNativeBridge {
  readonly bridgeName: string;
  isCactusAvailable(): Promise<boolean>;
  loadCactusModel(args: { modelId: string; installedPath?: string; maxTokens?: number }): Promise<void>;
  inferCactus(
    args: { generationId: string; prompt: string; maxTokens: number },
    signal: AbortSignal,
  ): AsyncGenerator<CactusGenerationChunk>;
  cancelGeneration(generationId: string): Promise<void>;
  unloadCactusModel(): Promise<void>;
}

/**
 * Benchmark/eval-only Cactus challenger. `load()` enforces the lab
 * distribution decision, then the lab-channel gate, then the injected
 * native bridge. Every other path throws before inference exists.
 */
export class CactusChallenger {
  constructor(private readonly bridge?: CactusNativeBridge) {}

  async load(
    candidate: LabCandidate,
    request: { readonly channel: LabDistributionChannel; readonly installedPath?: string; readonly maxTokens?: number },
  ): Promise<CactusSession> {
    const decision = labLicenseDecision(candidate, request.channel);
    if (!decision.allowed) {
      throw new CactusLicenseBlockedError(candidate.modelId, request.channel, decision.reason);
    }
    if (request.channel !== "benchmark" && request.channel !== "eval") {
      throw new CactusChannelRequiredError(request.channel);
    }
    const bridge = this.bridge;
    if (bridge === undefined) {
      throw new Error(
        `cactus lab session for ${candidate.modelId} is unavailable on this build (no native bridge; lab gate passed for ${request.channel})`,
      );
    }
    await bridge.loadCactusModel({
      modelId: candidate.modelId,
      installedPath: request.installedPath,
      maxTokens: request.maxTokens,
    });
    const channel = request.channel;
    return {
      modelId: candidate.modelId,
      runtime: CACTUS_CHALLENGER_RUNTIME,
      channel,
      generate: async function* (
        prompt: string,
        options: { generationId: string; maxTokens: number; signal: AbortSignal },
      ): AsyncGenerator<CactusGenerationChunk> {
        yield* bridge.inferCactus(
          { generationId: options.generationId, prompt, maxTokens: options.maxTokens },
          options.signal,
        );
      },
      dispose: async (): Promise<void> => {
        await bridge.unloadCactusModel();
      },
    };
  }

  /** License pre-check without attempting any load. */
  checkLicense(candidate: LabCandidate, channel: LabDistributionChannel) {
    return labLicenseDecision(candidate, channel);
  }
}

/** True for the challenger runtime id (exact match). */
export function isCactusChallengerRuntime(runtime: string): boolean {
  return runtime === CACTUS_CHALLENGER_RUNTIME;
}
