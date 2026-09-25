/**
 * V1 — Android dictation facade.
 *
 * Editable transcript only: recognition text is handed to the caller so the
 * composer can insert it; this module has no send/submit path at all.
 *
 * Fail-closed rules pinned by `speechInput.test.ts`:
 *   - outside the Android app every call rejects with `unsupported_platform`
 *     before the Capacitor bridge is registered,
 *   - an on-device route is only reported when the platform proves it;
 *     anything unverifiable becomes `networkOptInRequired: true`,
 *   - errors surface as `SpeechInputError` with our own stable message —
 *     never raw platform text — and audio/transcript is never logged.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

export type SpeechErrorCode =
  | "permission_denied"
  | "no_recognizer"
  | "busy"
  | "network_required"
  | "timeout"
  | "no_match"
  | "audio"
  | "server"
  | "client"
  | "language"
  | "cancelled"
  | "unsupported_platform"
  | "unknown";

export class SpeechInputError extends Error {
  readonly code: SpeechErrorCode;
  readonly cause?: unknown;

  constructor(code: SpeechErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "SpeechInputError";
    this.code = code;
    this.cause = cause;
  }
}

export type SpeechRoute = "on_device" | "network";

export interface SpeechAvailability {
  available: boolean;
  onDevice: "available" | "unavailable" | "unknown";
  networkOptInRequired: boolean;
  apiLevel: number | null;
}

export type SpeechPermissionState = "granted" | "prompt" | "denied" | "blocked";

export interface SpeechPermission {
  state: SpeechPermissionState;
}

export interface SpeechStartOptions {
  preferOnDevice?: boolean;
  allowNetworkAudio?: boolean;
  language?: string;
}

export interface SpeechStart {
  started: true;
  route: SpeechRoute;
  networkAudioDisclosed: boolean;
}

export interface SpeechResultEvent {
  text: string;
  isFinal: boolean;
  route: SpeechRoute;
}

export interface SpeechStateEvent {
  state: string;
}

export interface SpeechErrorEvent {
  code: SpeechErrorCode;
  message: string;
}

export interface SpeechEventMap {
  speechResult: SpeechResultEvent;
  speechState: SpeechStateEvent;
  speechError: SpeechErrorEvent;
}

export interface SpeechListenerHandle {
  remove(): Promise<void>;
}

/**
 * Stable user-facing messages. These strings are a product contract: the
 * native side (`SpeechInputPolicy.messageFor`) carries the exact same set so
 * an error reads the same however it was produced.
 */
const MESSAGES: Record<SpeechErrorCode, string> = {
  permission_denied: "Microphone permission is required for dictation.",
  no_recognizer: "No speech recognizer is available on this device.",
  busy: "A dictation session is already running.",
  network_required:
    "This device would send audio over the network. Allow network audio to continue.",
  timeout: "Speech recognition timed out.",
  no_match: "No speech was recognized.",
  audio: "The microphone audio could not be used.",
  server: "The speech service is unavailable.",
  client: "The speech recognizer could not start.",
  language: "The requested language is not supported.",
  cancelled: "Dictation was cancelled.",
  unsupported_platform: "Dictation is only available in the Android app.",
  unknown: "Speech recognition failed.",
};

/** States the native bridge is allowed to emit; anything else is dropped. */
const STATE_VALUES = [
  "listening",
  "speech_started",
  "speech_ended",
  "stopped",
  "cancelled",
  "finished",
  "error",
] as const;

interface NativeListenerHandle {
  remove(): Promise<void>;
}

interface NativeSpeechBridge {
  isAvailable(): Promise<unknown>;
  checkPermission(): Promise<unknown>;
  requestPermission(): Promise<unknown>;
  start(options: Record<string, unknown>): Promise<unknown>;
  stop(): Promise<unknown>;
  cancel(): Promise<unknown>;
  addListener(
    event: string,
    listener: (payload: unknown) => void,
  ): Promise<NativeListenerHandle>;
}

let bridge: NativeSpeechBridge | null = null;

/**
 * Platform guard runs *before* `registerPlugin` so a browser page can never
 * reach the Android bridge (and never receives a raw platform exception).
 */
function native(): NativeSpeechBridge {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") {
    throw new SpeechInputError("unsupported_platform", MESSAGES.unsupported_platform);
  }
  bridge ??= registerPlugin<NativeSpeechBridge>("SpeechInput");
  return bridge;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function isErrorCode(value: unknown): value is SpeechErrorCode {
  return typeof value === "string" && value in MESSAGES;
}

/**
 * Maps any rejected reason onto the shared taxonomy. Unknown or missing codes
 * collapse to `unknown`; `network_opt_in_required` (the native reject code)
 * becomes `network_required`.
 */
function extractCode(reason: unknown): SpeechErrorCode {
  const raw = asRecord(reason)["code"];
  if (raw === "network_opt_in_required") return "network_required";
  if (isErrorCode(raw)) return raw;
  return "unknown";
}

/** Never surfaces raw platform text: the message always comes from ours. */
function toError(reason: unknown): SpeechInputError {
  if (reason instanceof SpeechInputError) return reason;
  const code = extractCode(reason);
  return new SpeechInputError(code, MESSAGES[code], reason);
}

function normalizeOnDevice(raw: unknown): SpeechAvailability["onDevice"] {
  if (raw === "available" || raw === "unavailable" || raw === "unknown") {
    return raw;
  }
  return "unknown";
}

function normalizePermissionState(raw: unknown): SpeechPermissionState {
  const state = asRecord(raw)["state"];
  switch (state) {
    case "granted":
      return "granted";
    case "prompt":
      return "prompt";
    case "denied":
      return "denied";
    case "blocked":
      return "blocked";
    default:
      // prompt-with-rationale, unexpected shapes and missing payloads all
      // collapse to denied: a permission never granted is never assumed.
      return "denied";
  }
}

type SpeechEventPayload = SpeechResultEvent | SpeechErrorEvent | SpeechStateEvent;

/**
 * Normalises one native event payload, or returns `null` to drop it. Dropped
 * events never reach the caller, so a malformed platform payload cannot
 * inject state or leak into the transcript.
 */
function normalizeEvent(
  event: keyof SpeechEventMap,
  payload: unknown,
): SpeechEventPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  if (event === "speechResult") {
    if (typeof record["text"] !== "string") return null;
    return {
      text: record["text"],
      isFinal: record["isFinal"] === true,
      route: record["route"] === "on_device" ? "on_device" : "network",
    };
  }

  if (event === "speechError") {
    const code = extractCode(record);
    return { code, message: MESSAGES[code] };
  }

  const state = record["state"];
  if (
    typeof state === "string" &&
    (STATE_VALUES as readonly string[]).includes(state)
  ) {
    return { state };
  }
  return null;
}

async function isAvailable(): Promise<SpeechAvailability> {
  const android = native();
  let raw: unknown;
  try {
    raw = await android.isAvailable();
  } catch (reason) {
    throw toError(reason);
  }
  const record = asRecord(raw);
  const onDevice = normalizeOnDevice(record["onDevice"]);
  const apiLevel = record["apiLevel"];
  return {
    available: record["available"] === true,
    onDevice,
    // recomputed, never trusted from the platform payload
    networkOptInRequired: onDevice !== "available",
    apiLevel: typeof apiLevel === "number" && Number.isFinite(apiLevel)
      ? apiLevel
      : null,
  };
}

async function checkPermission(): Promise<SpeechPermission> {
  const android = native();
  let raw: unknown;
  try {
    raw = await android.checkPermission();
  } catch (reason) {
    throw toError(reason);
  }
  return { state: normalizePermissionState(raw) };
}

async function requestPermission(): Promise<SpeechPermission> {
  const android = native();
  let raw: unknown;
  try {
    raw = await android.requestPermission();
  } catch (reason) {
    // a failed permission request is a permission failure, whatever the
    // platform decided to call it
    throw new SpeechInputError("permission_denied", MESSAGES.permission_denied, reason);
  }
  return { state: normalizePermissionState(raw) };
}

async function start(options: SpeechStartOptions = {}): Promise<SpeechStart> {
  const android = native();

  const payload: Record<string, unknown> = {
    preferOnDevice: options.preferOnDevice ?? true,
    allowNetworkAudio: options.allowNetworkAudio ?? false,
  };
  if (options.language !== undefined) payload["language"] = options.language;

  let raw: unknown;
  try {
    raw = await android.start(payload);
  } catch (reason) {
    throw toError(reason);
  }

  const record = asRecord(raw);
  if (record["started"] !== true) {
    throw new SpeechInputError("unknown", MESSAGES.unknown, raw);
  }

  // an unverifiable route is treated as network so disclosure is never skipped
  const route: SpeechRoute = record["route"] === "on_device" ? "on_device" : "network";
  return {
    started: true,
    route,
    networkAudioDisclosed: route === "network" || record["networkAudioDisclosed"] === true,
  };
}

async function stop(): Promise<void> {
  const android = native();
  try {
    await android.stop();
  } catch (reason) {
    throw toError(reason);
  }
}

async function cancel(): Promise<void> {
  const android = native();
  try {
    await android.cancel();
  } catch (reason) {
    throw toError(reason);
  }
}

async function addListener<E extends keyof SpeechEventMap>(
  event: E,
  listener: (payload: SpeechEventMap[E]) => void,
): Promise<SpeechListenerHandle> {
  const android = native();
  const handle = await android.addListener(event, (payload: unknown) => {
    const normalized = normalizeEvent(event, payload);
    if (normalized) listener(normalized as unknown as SpeechEventMap[E]);
  });
  let removed = false;
  return {
    remove: async () => {
      if (removed) return;
      removed = true;
      await handle.remove();
    },
  };
}

/**
 * The entire dictation surface. Seven methods, no `send`/`submit`: text is
 * only ever *returned* to the caller for manual editing.
 */
export const speechInput = {
  isAvailable,
  checkPermission,
  requestPermission,
  start,
  stop,
  cancel,
  addListener,
};
