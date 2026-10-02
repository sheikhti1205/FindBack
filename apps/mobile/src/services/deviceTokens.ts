import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";

export type PushPlatform = "android" | "ios" | "web";

function tokenErrorStatus(code: string | undefined): number {
  if (code === "42501") return 403;
  if (code === "28000") return 401;
  if (code === "22023") return 422;
  return 400;
}

/** Register (or refresh) the signed-in user's FCM device token. */
export async function registerDeviceToken(token: string, platform: PushPlatform): Promise<void> {
  const { error } = await getSupabase().rpc("findback_register_device_token_client", {
    p_token: token,
    p_platform: platform,
  });
  if (error) throw new ApiError(error.message, tokenErrorStatus(error.code));
}

/** Remove one of the signed-in user's device tokens. Returns rows deleted. */
export async function unregisterDeviceToken(token: string): Promise<number> {
  const { data, error } = await getSupabase().rpc("findback_unregister_device_token_client", {
    p_token: token,
  });
  if (error) throw new ApiError(error.message, tokenErrorStatus(error.code));
  return Number(data ?? 0);
}
