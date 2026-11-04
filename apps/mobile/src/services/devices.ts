import { getSupabase } from "./supabaseClient";
import { ApiError } from "./session";

/**
 * The account's signed-in installations.
 *
 * The server lists only live, key-enrolled devices; it never returns private
 * keys, auth-session ids, push tokens, generations or sync cursors. Names are
 * the user's own labels and are bounded by the server at 1–64 printable chars.
 */
export interface SignedInDevice {
  deviceId: string;
  name: string;
  platform: string | null;
  lastSeenAt: number;
  current: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_DEVICES = 64;

const unavailable = () => new ApiError("Devices could not load. Try again.", 500);

function deviceError(message: string, code?: string): ApiError {
  // 42501 revoked/absent enrollment, 22023 bad input, 54000 limit,
  // 28000 no signed-in account; anything else is server trouble.
  if (code === "42501") return new ApiError(message, 403, code);
  if (code === "22023") return new ApiError(message, 400, code);
  if (code === "54000") return new ApiError(message, 429, code);
  if (code === "28000") return new ApiError(message, 401, code);
  return new ApiError(message, 500, code);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const entry = object(value);
  if (Object.keys(entry).length !== fields.length || fields.some(field => !Object.hasOwn(entry, field))) throw unavailable();
  return entry;
}
function unsafe(text: string): boolean {
  // Control characters would let a label break a row or an announcement.
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
function name(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 64 || unsafe(trimmed)) {
    throw new ApiError("Choose a name between 1 and 64 characters.", 400);
  }
  return trimmed;
}

/** One server-shaped row; unusable rows are dropped, never half-rendered. */
function parseDevice(input: unknown): SignedInDevice | null {
  try {
    const value = exact(input, ["deviceId", "name", "platform", "lastSeenAt", "current"]);
    if (typeof value.deviceId !== "string" || !UUID.test(value.deviceId)
      || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 64
      || unsafe(value.name)
      || !(value.platform === null || typeof value.platform === "string" && value.platform.length <= 32)
      || typeof value.lastSeenAt !== "number" || !Number.isSafeInteger(value.lastSeenAt) || value.lastSeenAt < 0
      || typeof value.current !== "boolean") return null;
    return { deviceId: value.deviceId, name: value.name, platform: value.platform,
      lastSeenAt: value.lastSeenAt, current: value.current };
  } catch { return null; }
}

export async function listDevices(): Promise<SignedInDevice[]> {
  const { data, error } = await getSupabase().rpc("findback_devices", { p_action: "LIST", p_args: {} });
  if (error) {
    // 42501 here is not "retry": this installation's Chat session is gone
    // (removed from the account, or its sign-in ended), so it must be told the
    // reason instead of being offered a retry that can never succeed.
    throw deviceError(error.code === "42501"
      ? "This device was removed from your account. Sign in again to use Chat."
      : "Devices could not load. Try again.", error.code);
  }
  if (!Array.isArray(data) || data.length > MAX_DEVICES) throw unavailable();
  const devices = data.map(parseDevice).filter((row): row is SignedInDevice => row !== null);
  // An empty list is a real state: this installation has not enrolled for Chat
  // yet. More than one "current" row, or a dropped/duplicated row, is not.
  if (devices.filter(row => row.current).length > 1
    || devices.length !== data.length
    || new Set(devices.map(row => row.deviceId)).size !== devices.length) throw unavailable();
  return devices;
}

export async function renameDevice(deviceId: string, value: string): Promise<void> {
  if (!UUID.test(deviceId)) throw new ApiError("Device unavailable.", 400);
  const { error } = await getSupabase().rpc("findback_devices", {
    p_action: "RENAME", p_args: { deviceId, name: name(value) },
  });
  if (error) throw deviceError("That device could not be renamed. Try again.", error.code);
}

/** Removes an installation's authority and signs it out of chat. The caller's
 * own installation must use the Account sign-out flow instead. */
export async function removeDevice(deviceId: string): Promise<void> {
  if (!UUID.test(deviceId)) throw new ApiError("Device unavailable.", 400);
  const { error } = await getSupabase().rpc("findback_devices", {
    p_action: "REVOKE", p_args: { deviceId },
  });
  if (error) throw deviceError("That device could not be removed. Try again.", error.code);
}

/** Plain product language; never an exact timestamp or implementation term. */
export function describeDevicePlatform(platform: string | null): string {
  if (platform === "android") return "Android";
  if (platform === "ios") return "iPhone or iPad";
  if (platform === "web") return "Web browser";
  return "Norfold app";
}

export function describeDeviceActivity(lastSeenAt: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - lastSeenAt);
  if (elapsed < 2 * 60_000) return "Active now";
  if (elapsed < 60 * 60_000) return `Active ${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 24 * 60 * 60_000) {
    const hours = Math.floor(elapsed / (60 * 60_000));
    return `Active ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(elapsed / (24 * 60 * 60_000));
  return `Last active ${days} day${days === 1 ? "" : "s"} ago`;
}
