/**
 * W-A lane: LiteRT-LM general text seam (Qwen3 0.6B production resident).
 *
 * SEAM CONTRACT FOR W-B (native `FindbackQwenText` plugin):
 * - `isTextAvailable()` → plugin presence probe. False on web and on builds
 *   without the native module; the caller fails closed, never throws.
 * - `loadTextModel({ modelId, installedPath, maxTokens })` → evict-then-load
 *   is owned by the service coordinator (single-resident rule); the plugin
 *   mmaps the verified `.litertlm` weights for `modelId`, runs its self-test
 *   with at least QWEN_SESSION_MIN_TOKENS session tokens, and resolves only
 *   on READY. Unknown/unverified ids reject fail-closed.
 * - `generateText({ generationId, prompt, maxOutputTokens }, signal)` →
 *   chunked inference as an async iterator of `{ textDelta }`, mirroring the
 *   SmolVLM2 `describeImage` listener shape: LiteRT-LM `LlmInference` async
 *   partial results forwarded as Capacitor listener events keyed by
 *   `generationId`, with `signal` wired to native `cancelGeneration`. Token
 *   counts stay unreported (unknown, never zero-filled). Streaming must be
 *   honest: emit deltas only as the engine produces them, never fabricated
 *   progress or buffered-then-burst fake streaming.
 * - `unloadTextModel()` → release the resident engine (idempotent).
 * - `cancelGeneration(generationId)` → abort one in-flight generation.
 *
 * The TypeScript side additionally owns thought-envelope stripping (the
 * Qwen profile's `[thought]…[/thought]` markers never reach user output)
 * and the generation epoch guard (the service drops late chunks after a
 * switch/unload). No network code lives behind this seam.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { ThoughtEnvelope } from "../modelProfiles";

/** Native plugin name W-B implements. */
export const QWEN_TEXT_PLUGIN_NAME = "FindbackQwenText" as const;

/** Human-readable bridge name for diagnostics. */
export const QWEN_TEXT_BRIDGE_NAME = "qwen3-litertlm-text" as const;

/**
 * Session token floor: the lab profile measured that LiteRT-LM needs a
 * --max-tokens 1024 session floor for Qwen. Loads below this fail closed.
 */
export const QWEN_SESSION_MIN_TOKENS = 1024 as const;

/** One native text generation chunk: a text delta, nothing else. */
export interface QwenTextChunk {
  readonly textDelta: string;
}

/** One text inference request for the native bridge. */
export interface QwenTextRequest {
  readonly generationId: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
}

/**
 * Native text seam bound by ApplicationAiService; faked in tests. Mirrors
 * the SmolVLM2 vision seam shape so the service arbitrates both residents
 * through the same coordinator discipline.
 */
export interface QwenTextNativeBridge {
  /** Human-readable bridge name for diagnostics. */
  readonly bridgeName: string;
  /** False on web / builds without the native module (fail closed). */
  isTextAvailable(): Promise<boolean>;
  /**
   * Make `modelId` text-resident (resolve only on READY).
   * `installedPath` is the exact verified weights path; `maxTokens` must
   * be >= QWEN_SESSION_MIN_TOKENS.
   */
  loadTextModel(args: {
    readonly evaluation?: boolean;
    readonly modelId: string;
    readonly installedPath?: string;
    readonly maxTokens: number;
  }): Promise<void>;
  /** Release the text resident, if any (idempotent). */
  unloadTextModel(): Promise<void>;
  /** Chunked text inference; must honor `signal` (cancelGeneration). */
  generateText(
    request: QwenTextRequest,
    signal: AbortSignal,
  ): AsyncGenerator<QwenTextChunk>;
  /** Abort an in-flight generation. */
  cancelGeneration(generationId: string): Promise<void>;
}

/**
 * Strip the model's thought/reasoning envelope before user output. Any
 * unclosed envelope fails closed to the empty string: partial reasoning
 * never reaches the user. A missing envelope definition leaves text
 * untouched (models without reasoning markers need no stripping).
 */
export function stripThoughtEnvelope(text: string, envelope: ThoughtEnvelope | undefined): string {
  if (envelope === undefined) return text;
  const { openMarker, closeMarker } = envelope;
  let stripped = text;
  for (;;) {
    const open = stripped.indexOf(openMarker);
    if (open === -1) break;
    const close = stripped.indexOf(closeMarker, open + openMarker.length);
    if (close === -1) return "";
    stripped = stripped.slice(0, open) + stripped.slice(close + closeMarker.length);
  }
  return stripped;
}

/**
 * Honest streaming counterpart of stripThoughtEnvelope: suppresses
 * envelope contents AND partial markers chunk-by-chunk without ever
 * buffering the whole answer (buffered-then-burst emission would be fake
 * streaming). Emits only text proven to sit outside an envelope; holds an
 * incomplete tail until more arrives or flush() runs. flush() drops a
 * trailing unclosed envelope (fail closed, same as stripThoughtEnvelope).
 */
export function createEnvelopeStreamingFilter(
  envelope: ThoughtEnvelope | undefined,
): { push(delta: string): string; flush(): string } {
  if (envelope === undefined) {
    return { push: (delta) => delta, flush: () => "" };
  }
  const { openMarker, closeMarker } = envelope;
  const longestMarker = Math.max(openMarker.length, closeMarker.length);
  let pending = "";
  let inside = false;
  const drain = (final: boolean): string => {
    let out = "";
    for (;;) {
      if (inside) {
        const close = pending.indexOf(closeMarker);
        if (close === -1) {
          // Unclosed at the end: drop reasoning, never leak it.
          if (final) pending = "";
          break;
        }
        pending = pending.slice(close + closeMarker.length);
        inside = false;
        continue;
      }
      const open = pending.indexOf(openMarker);
      if (open === -1) {
        // No envelope ahead — but the tail may hold a partial marker, so
        // hold it back until more arrives (or flush).
        if (!final || pending === "") {
          const hold = final ? 0 : Math.min(pending.length, longestMarker - 1);
          out += pending.slice(0, pending.length - hold);
          pending = pending.slice(pending.length - hold);
          break;
        }
        out += pending;
        pending = "";
        break;
      }
      // Hold a trailing partial open marker the same way.
      const emitUpTo = open;
      out += pending.slice(0, emitUpTo);
      pending = pending.slice(emitUpTo);
      if (!final && pending.length < openMarker.length && openMarker.startsWith(pending)) break;
      if (!pending.startsWith(openMarker)) {
        // False alarm only possible with an empty open marker (excluded by
        // profiles); emit conservatively and continue.
        out += pending;
        pending = "";
        break;
      }
      pending = pending.slice(openMarker.length);
      inside = true;
    }
    return out;
  };
  return {
    push: (delta: string) => {
      if (delta === "") return "";
      pending += delta;
      return drain(false);
    },
    flush: () => drain(true),
  };
}

/** Fail-closed availability probe over an injected bridge (never throws). */
export async function isQwenTextAvailable(
  bridge: Pick<QwenTextNativeBridge, "isTextAvailable"> | undefined,
): Promise<boolean> {
  if (bridge === undefined) return false;
  try {
    return (await bridge.isTextAvailable()) === true;
  } catch {
    return false;
  }
}

interface FindbackQwenTextPlugin {
  isTextAvailable(): Promise<{ available: boolean }>;
  loadTextModel(args: { modelId: string; installedPath?: string; maxTokens: number; evaluation?: boolean }): Promise<{ ready: boolean }>;
  unloadTextModel(): Promise<unknown>;
  generateText(args: QwenTextRequest): Promise<unknown>;
  cancelGeneration(args: { generationId: string }): Promise<unknown>;
  addListener(
    name: "qwenTextChunk",
    callback: (event: { generationId: string; textDelta?: string; done?: boolean; cancelled?: boolean; error?: string }) => void,
  ): Promise<PluginListenerHandle>;
}

/**
 * Production Capacitor bridge over the W-B `FindbackQwenText` plugin.
 * Every method fails closed when the plugin is absent (web builds never
 * construct this — the service only builds it on Android).
 */
export class CapacitorQwenTextBridge implements QwenTextNativeBridge {
  readonly bridgeName = QWEN_TEXT_BRIDGE_NAME;

  private plugin(): FindbackQwenTextPlugin {
    if (Capacitor.getPlatform() !== "android") throw new Error("Qwen text requires Android");
    return registerPlugin<FindbackQwenTextPlugin>(QWEN_TEXT_PLUGIN_NAME);
  }

  async isTextAvailable(): Promise<boolean> {
    try {
      return (await this.plugin().isTextAvailable()).available === true;
    } catch {
      return false;
    }
  }

  async loadTextModel(args: Parameters<QwenTextNativeBridge["loadTextModel"]>[0]): Promise<void> {
    if (args.maxTokens < QWEN_SESSION_MIN_TOKENS) {
      throw new Error("Qwen text session needs at least 1024 tokens");
    }
    if ((await this.plugin().loadTextModel(args)).ready !== true) {
      throw new Error("Qwen text load failed");
    }
  }

  async unloadTextModel(): Promise<void> {
    await this.plugin().unloadTextModel();
  }

  async cancelGeneration(generationId: string): Promise<void> {
    await this.plugin().cancelGeneration({ generationId });
  }

  async *generateText(
    request: QwenTextRequest,
    signal: AbortSignal,
  ): AsyncGenerator<QwenTextChunk> {
    if (signal.aborted) return;
    const plugin = this.plugin();
    const chunks: string[] = [];
    let done = false;
    let failure: Error | undefined;
    let cancellation: Promise<unknown> | undefined;
    let wake = () => {};
    const finish = () => {
      done = true;
      wake();
    };
    const listener = await plugin.addListener("qwenTextChunk", (event) => {
      if (done || signal.aborted || event.generationId !== request.generationId) return;
      if (event.textDelta) chunks.push(event.textDelta);
      if (event.error) failure = new Error(event.error);
      if (event.done || event.cancelled || event.error) done = true;
      wake();
    });
    const cancel = () =>
      (cancellation ??= plugin.cancelGeneration({ generationId: request.generationId }).catch(() => undefined));
    const abort = () => {
      void cancel();
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) return;
      const inference = plugin.generateText(request).then(finish, () => {
        failure = new Error("On-device text generation failed");
        finish();
      });
      while (!done || chunks.length > 0) {
        if (signal.aborted) return;
        if (chunks.length > 0) yield { textDelta: chunks.shift()! };
        else await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      await inference;
      if (failure) throw failure;
    } finally {
      signal.removeEventListener("abort", abort);
      if (!done || signal.aborted) await cancel();
      await listener.remove();
    }
  }
}
