import { ApiError } from "../session";
import { getSupabase } from "../supabaseClient";
import { backupKeyHex } from "./backupCrypto";

/**
 * The account's Drive backup key, as the canonical server issues it.
 *
 * The key never lives in Drive beside the ciphertext: it is admission-gated by
 * the same installation binding as Chat, so a new device recovers it after
 * enrollment and a removed or rebound installation cannot obtain it at all.
 * `generation` is part of every object's AAD, so rotation makes older ciphertext
 * unreadable by design and the caller must rebuild under the new key.
 */
export interface BackupKeyMaterial {
  accountId: string;
  generation: string;
  keyHex: string;
  createdAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("Backup is unavailable right now. Try again.", 500);
  }
  return value as Record<string, unknown>;
}

function parse(input: unknown): BackupKeyMaterial {
  const value = object(input);
  if (Object.keys(value).length !== 4
    || !["accountId", "generation", "key", "createdAt"].every((field) => Object.hasOwn(value, field))) {
    throw new ApiError("Backup is unavailable right now. Try again.", 500);
  }
  if (typeof value.accountId !== "string" || !UUID.test(value.accountId)
    || typeof value.generation !== "string" || !UUID.test(value.generation)
    || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt < 1) {
    throw new ApiError("Backup is unavailable right now. Try again.", 500);
  }
  let keyHex: string;
  try {
    keyHex = backupKeyHex(value.key);
  } catch {
    throw new ApiError("Backup is unavailable right now. Try again.", 500);
  }
  return { accountId: value.accountId, generation: value.generation, keyHex, createdAt: value.createdAt };
}

function keyError(code: string | undefined): ApiError {
  // 42501 removed/rebound installation, 28000 no signed-in account,
  // 22023 bad request, 54000 temporary refusal.
  if (code === "42501") {
    return new ApiError("This device was removed from your account. Sign in again to use Chat.", 403, code);
  }
  if (code === "28000") return new ApiError("Sign in to use backup.", 401, code);
  if (code === "22023" || code === "54000") {
    return new ApiError("Backup is unavailable right now. Try again.", 429, code);
  }
  return new ApiError("Backup is unavailable right now. Try again.", 500, code);
}

async function call(action: "READ" | "ROTATE"): Promise<BackupKeyMaterial> {
  const { data, error } = await getSupabase().rpc("findback_backup_key", { p_action: action, p_args: {} });
  if (error) throw keyError(error.code);
  return parse(data);
}

/** Read the current key, creating it once for this account if it is absent. */
export function readBackupKey(): Promise<BackupKeyMaterial> {
  return call("READ");
}

/**
 * Replace the account key. Existing Drive objects can no longer be opened, so
 * the caller must rebuild the backup with `repair` before the next restore.
 */
export function rotateBackupKey(): Promise<BackupKeyMaterial> {
  return call("ROTATE");
}
