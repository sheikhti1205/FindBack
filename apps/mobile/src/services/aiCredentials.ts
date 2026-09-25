import { Capacitor, registerPlugin } from "@capacitor/core";
import { createBrowserAiCredentials } from "./browserAiCredentials";
import { storage } from "./storage";
import { getSupabase } from "./supabaseClient";

interface NativeKeyBridge {
  set(options: { userId: string; key: string }): Promise<void>;
  get(options: { userId: string }): Promise<{ key: string | null }>;
  remove(options: { userId: string }): Promise<void>;
}

const browser = createBrowserAiCredentials(storage);
const session = new Map<string, string>();
let bridge: NativeKeyBridge | null = null;

function native(): NativeKeyBridge | null {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return null;
  bridge ??= registerPlugin<NativeKeyBridge>("OpenRouterKey");
  return bridge;
}

/** Never store credentials in plaintext in browser persistence or app configuration. */
export const aiCredentials = {
  async connect(userId: string, key: string, options: { remember: boolean; passphrase?: string }): Promise<void> {
    const android = native();
    if (!android) {
      await browser.connect(userId, key, options);
      return;
    }
    if (!userId || !key.trim()) throw new Error("A user and API key are required.");
    if (options.remember) await android.set({ userId, key: key.trim() });
    else await android.remove({ userId });
    session.set(userId, key.trim());
  },
  async get(userId: string): Promise<string | null> {
    if (!userId) return null;
    if (!native()) return browser.get(userId);
    if (session.has(userId)) return session.get(userId)!;
    return (await native()!.get({ userId })).key;
  },
  async hasSaved(userId: string): Promise<boolean> {
    if (!userId) return false;
    const android = native();
    return android ? !!(await android.get({ userId })).key : browser.hasSaved(userId);
  },
  async unlock(userId: string, passphrase: string): Promise<void> {
    if (native()) return;
    await browser.unlock(userId, passphrase);
  },
  async remove(userId: string): Promise<void> {
    session.delete(userId);
    const android = native();
    if (android) await android.remove({ userId });
    else await browser.remove(userId);
  },
  clearSession(): void {
    session.clear();
    browser.clearSession();
  },
};

/** The Supabase Auth session determines which user's credential can be read. */
export async function getConnectedOpenRouterKey(): Promise<string | null> {
  const { data } = await getSupabase().auth.getSession();
  return data.session?.user.id ? aiCredentials.get(data.session.user.id) : null;
}
