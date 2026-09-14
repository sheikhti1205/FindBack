import crypto from "node:crypto";
import { getStore } from "../db/index.js";
import { config } from "../config.js";
import { AppError, newId, nowIso } from "./helpers.js";
import type { Row } from "../db/index.js";

export type Channel = "EMAIL" | "PHONE";

export interface VerificationProvider {
  send(channel: Channel, destination: string, code: string): Promise<void>;
}

/**
 * Development verification adapter.
 *
 * Honest scope: in dev mode the code is printed to the server log AND returned
 * in the API response so the demo/OTP UI can be exercised end-to-end without a
 * real SMS provider. It does NOT prove ownership of the email/phone. Used only by
 * `LocalAuthProvider` (tests + local demo); production email uses real Supabase
 * Auth OTP and production phone still awaits an SMS provider.
 */
export const devVerificationProvider: VerificationProvider = {
  async send(channel, destination, code) {
    console.log(`[dev-verification] ${channel} -> ${destination} code=${code}`);
  },
};

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds

function codeHash(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export function channelDestination(user: Row, channel: Channel): string {
  return channel === "EMAIL" ? String(user.email) : String(user.phone);
}

export async function sendChallenge(
  userId: string,
  channel: Channel,
  provider: VerificationProvider,
): Promise<{ devCode?: string; expiresInSeconds: number; resendAfterSeconds: number }> {
  const user = await getStore().findUserById(userId);
  if (!user) throw new AppError(404, "User not found");

  const pending = await getStore().findLatestPendingChallenge(userId, channel);
  if (pending) {
    const elapsed = Date.now() - Date.parse(String(pending.created_at));
    if (elapsed < RESEND_COOLDOWN_MS) {
      const remaining = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
      throw new AppError(429, `Please wait ${remaining}s before resending`);
    }
  }

  const code = crypto.randomInt(100000, 1000000).toString();
  const id = newId();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await getStore().insertChallenge({
    id,
    user_id: userId,
    channel,
    code_hash: codeHash(code),
    expires_at: expiresAt,
    created_at: now,
  });
  await provider.send(channel, channelDestination(user, channel), code);

  return {
    // In dev only: hand the code back so the flow can be demonstrated without
    // a real provider. Never echo real codes in production.
    devCode: config.devMode ? code : undefined,
    expiresInSeconds: CODE_TTL_MS / 1000,
    resendAfterSeconds: RESEND_COOLDOWN_MS / 1000,
  };
}

export async function verifyChallenge(
  userId: string,
  channel: Channel,
  code: string,
): Promise<{ emailVerified: boolean; phoneVerified: boolean }> {
  const challenge = await getStore().findLatestPendingChallenge(userId, channel);
  if (!challenge) throw new AppError(400, `No pending ${channel} verification`);
  if (Date.now() > Date.parse(String(challenge.expires_at))) {
    throw new AppError(400, "Verification code expired. Request a new one");
  }
  if (codeHash(code) !== String(challenge.code_hash)) {
    throw new AppError(400, "Incorrect verification code");
  }

  await getStore().markChallengeVerified(String(challenge.id), nowIso());
  const field = channel === "EMAIL" ? "email_verified" : "phone_verified";
  await getStore().setUserVerified(userId, field);
  const user = await getStore().findUserById(userId);
  return {
    emailVerified: Boolean(user!.email_verified),
    phoneVerified: Boolean(user!.phone_verified),
  };
}
