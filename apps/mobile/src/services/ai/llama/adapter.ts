/**
 * llama.cpp lab challenger adapter (pinned v0.5.0 source, CPU-only).
 *
 * Benchmark/eval-only challenger for GGUF arms. `load()` enforces, in
 * order: the LFM license gate BEFORE any native call, then the lab-channel
 * gate (only `benchmark` and `eval` may proceed — production channels can
 * never reach the runtime), then the injected native bridge. Without an
 * injected bridge the license/channel checks still run and the load stops
 * with a lab-unavailable error, so the adapter can never silently stand
 * in for a working backend.
 *
 * Invariants:
 * - License check runs before any native load attempt (fail-closed).
 * - A blocked license throws LfmLicenseBlockedError; the native runtime is
 *   never referenced on that path.
 * - Non-lab channels throw LabChannelRequiredError before native contact.
 * - Does not register with the orchestrator, router, Needle, probe, UI,
 *   bench, or packer — challenger harness wires it explicitly for benchmarks.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { ModelProfile } from "../modelProfiles";
import { enforce, type DistributionChannel } from "./licenseGate";

/** Runtime id this challenger targets. GGUF profiles only. */
export const LLAMA_CPP_RUNTIME = "llama-cpp" as const;

/** Channels allowed to touch the lab runtime. Production never qualifies. */
export const LLAMA_LAB_CHANNELS: readonly DistributionChannel[] = ["benchmark", "eval"] as const;

/** Thrown when the license gate blocks a load before any native call. */
export class LfmLicenseBlockedError extends Error {
  readonly profileId: string;
  readonly channel: DistributionChannel;

  constructor(profileId: string, channel: DistributionChannel, reason: string) {
    super(`license gate blocked load: ${profileId} (${channel}): ${reason}`);
    this.name = "LfmLicenseBlockedError";
    this.profileId = profileId;
    this.channel = channel;
  }
}

export interface LlamaLoadRequest {
  readonly channel: DistributionChannel;
  /** Verified GGUF absolute path (manager-resolved, app-private). */
  readonly ggufPath?: string;
  readonly nCtx?: number;
  readonly nThreads?: number;
}

export interface LlamaGenerationChunk {
  readonly textDelta: string;
}

export interface LlamaSession {
  readonly profileId: string;
  readonly runtime: typeof LLAMA_CPP_RUNTIME;
  readonly channel: DistributionChannel;
  /** Chunked lab inference; honours `signal` (cancelGeneration). */
  generate(
    prompt: string,
    options: { generationId: string; maxTokens: number; signal: AbortSignal },
  ): AsyncGenerator<LlamaGenerationChunk>;
  /** Release the lab session (idempotent). */
  dispose(): Promise<void>;
}

/** Thrown when a non-lab channel reaches the lab runtime. */
export class LabChannelRequiredError extends Error {
  readonly channel: DistributionChannel;

  constructor(channel: DistributionChannel) {
    super(`llama.cpp lab runtime requires a benchmark/eval channel, got ${channel}`);
    this.name = "LabChannelRequiredError";
    this.channel = channel;
  }
}

/**
 * Native lab bridge surface (`FindbackLlama` Capacitor plugin). Faked in
 * tests; absent on web and non-arm64 builds (fail closed, never stubbed).
 */
export interface LlamaNativeBridge {
  readonly bridgeName: string;
  isLlamaAvailable(): Promise<boolean>;
  loadLlamaModel(args: {
    modelId: string;
    ggufPath?: string;
    projectorPath?: string;
    nCtx?: number;
    nThreads?: number;
  }): Promise<void>;
  inferLlama(
    args: { generationId: string; prompt: string; maxTokens: number; imageBase64?: string },
    signal: AbortSignal,
  ): AsyncGenerator<LlamaGenerationChunk>;
  cancelGeneration(generationId: string): Promise<void>;
  unloadLlamaModel(): Promise<void>;
}

interface FindbackLlamaPlugin {
  isLlamaAvailable(): Promise<{ available: boolean }>;
  loadLlamaModel(args: {
    modelId: string;
    ggufPath?: string;
    projectorPath?: string;
    nCtx?: number;
    nThreads?: number;
  }): Promise<{ ready: boolean }>;
  inferLlama(args: {
    generationId: string;
    prompt: string;
    maxTokens: number;
    imageBase64?: string;
  }): Promise<unknown>;
  cancelGeneration(args: { generationId: string }): Promise<unknown>;
  unloadLlamaModel(): Promise<unknown>;
  addListener(
    eventName: "llamaChunk",
    listener: (event: {
      generationId: string;
      textDelta?: string;
      done?: boolean;
      cancelled?: boolean;
      error?: string;
    }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/** Production bridge over the `FindbackLlama` native plugin. */
export class CapacitorLlamaBridge implements LlamaNativeBridge {
  readonly bridgeName = "llama-cpp-lab";

  private plugin(): FindbackLlamaPlugin {
    if (Capacitor.isNativePlatform() !== true) {
      throw new Error("llama.cpp lab bridge is absent on web");
    }
    return registerPlugin<FindbackLlamaPlugin>("FindbackLlama");
  }

  async isLlamaAvailable(): Promise<boolean> {
    try {
      const result = await this.plugin().isLlamaAvailable();
      return result.available === true;
    } catch {
      return false;
    }
  }

  async loadLlamaModel(args: {
    modelId: string;
    ggufPath?: string;
    projectorPath?: string;
    nCtx?: number;
    nThreads?: number;
  }): Promise<void> {
    const result = await this.plugin().loadLlamaModel(args);
    if (result.ready !== true) throw new Error("llama.cpp lab session failed to load");
  }

  async *inferLlama(
    args: { generationId: string; prompt: string; maxTokens: number; imageBase64?: string },
    signal: AbortSignal,
  ): AsyncGenerator<LlamaGenerationChunk> {
    const plugin = this.plugin();
    const queue: LlamaGenerationChunk[] = [];
    let done = false;
    let failure: string | null = null;
    const handle = await plugin.addListener("llamaChunk", (event) => {
      if (done || signal.aborted) return;
      if (event.generationId !== args.generationId) return;
      if (event.error !== undefined) {
        failure = event.error;
        done = true;
        return;
      }
      if (event.cancelled === true || event.done === true) {
        done = true;
        return;
      }
      if (event.textDelta !== undefined && event.textDelta !== "") {
        queue.push({ textDelta: event.textDelta });
      }
    });
    let cancelWork: Promise<unknown> | undefined;
    const cancel = () => { cancelWork ??= plugin.cancelGeneration({ generationId: args.generationId }).catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    let settled: Promise<unknown> | undefined;
    try {
      if (signal.aborted) return;
      settled = plugin.inferLlama(args).then(() => { done = true; }, () => { failure = "Evaluation generation failed"; done = true; });
      for (;;) {
        if (signal.aborted) {
          cancel();
          return;
        }
        if (failure !== null) throw new Error(failure);
        const chunk = queue.shift();
        if (chunk !== undefined) {
          yield chunk;
          continue;
        }
        if (done) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      if (!done || signal.aborted) cancel();
      await cancelWork;
      await settled;
      await handle.remove().catch(() => undefined);
    }
  }

  async cancelGeneration(generationId: string): Promise<void> {
    try {
      await this.plugin().cancelGeneration({ generationId });
    } catch {
      // Cancel is best-effort; the generation loop already exited.
    }
  }

  async unloadLlamaModel(): Promise<void> {
    await this.plugin().unloadLlamaModel();
  }
}

/** @deprecated Use LlamaSession; kept for existing harness references. */
export type LlamaSessionStub = LlamaSession;

/**
 * Benchmark/eval-only llama.cpp challenger.
 *
 * `load()` runs the license gate, then the lab-channel gate, then the
 * injected native bridge. Only an allowed license on a lab channel with a
 * present bridge proceeds to a real session; every other path throws
 * before any inference exists.
 */
export class LlamaCppChallenger {
  constructor(private readonly bridge?: LlamaNativeBridge) {}

  async load(profile: ModelProfile, request: LlamaLoadRequest): Promise<LlamaSession> {
    const decision = enforce(profile, request.channel);
    if (!decision.allowed) {
      throw new LfmLicenseBlockedError(profile.id, request.channel, decision.reason);
    }
    if (profile.runtime !== LLAMA_CPP_RUNTIME) {
      throw new Error(
        `llama.cpp challenger cannot load ${profile.id}: runtime is ${profile.runtime}, expected ${LLAMA_CPP_RUNTIME}`,
      );
    }
    if (
      request.channel !== "benchmark" &&
      (request.channel as string) !== "eval"
    ) {
      throw new LabChannelRequiredError(request.channel);
    }
    const bridge = this.bridge;
    if (bridge === undefined) {
      throw new Error(
        `llama.cpp lab session for ${profile.id} is unavailable on this build (no native bridge; license gate passed for ${request.channel})`,
      );
    }
    await bridge.loadLlamaModel({
      modelId: profile.id,
      ggufPath: request.ggufPath,
      nCtx: request.nCtx,
      nThreads: request.nThreads,
    });
    const sessionChannel = request.channel;
    return {
      profileId: profile.id,
      runtime: LLAMA_CPP_RUNTIME,
      channel: sessionChannel,
      generate: async function* (
        prompt: string,
        options: { generationId: string; maxTokens: number; signal: AbortSignal },
      ): AsyncGenerator<LlamaGenerationChunk> {
        yield* bridge.inferLlama(
          { generationId: options.generationId, prompt, maxTokens: options.maxTokens },
          options.signal,
        );
      },
      dispose: async (): Promise<void> => {
        await bridge.unloadLlamaModel();
      },
    };
  }

  /** License pre-check without attempting any load. */
  checkLicense(profile: ModelProfile, channel: DistributionChannel) {
    return enforce(profile, channel);
  }
}
