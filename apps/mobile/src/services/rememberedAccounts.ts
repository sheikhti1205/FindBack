import type { PublicUser } from "@norfold/shared";

/** Presentation only. Never authorizes an account or copies an SDK session. */
export interface RememberedAccount {
  id: string;
  username: string;
  displayName: string;
  maskedEmail: string;
  /** Retained only by the explicit logout choice, for normal auth prefill. */
  loginEmail: string;
  lastUsedAt: number;
}

const KEY = "findback.rememberedAccounts";
const EVENT = "findback:remembered-accounts";
const LIMIT = 6;
const cleanText = (value: unknown, max: number): value is string => typeof value === "string"
  && value.length > 0 && value.length <= max
  && ![...value].some(char => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f);

function project(value: unknown): RememberedAccount | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Partial<RememberedAccount>;
  if (!cleanText(a.id, 128) || !cleanText(a.username, 100) || !cleanText(a.displayName, 160)
    || !cleanText(a.loginEmail, 254) || !/^[^\s@]+@[^\s@]+$/.test(a.loginEmail)
    || typeof a.lastUsedAt !== "number" || !Number.isSafeInteger(a.lastUsedAt)
    || a.lastUsedAt < 0 || a.lastUsedAt > Date.now() + 60_000) return null;
  const [local, domain] = a.loginEmail.split("@");
  return { id: a.id, username: a.username, displayName: a.displayName,
    loginEmail: a.loginEmail, maskedEmail: `${local![0]}…@${domain}`, lastUsedAt: a.lastUsedAt };
}

function decodeAccounts(raw: string | null): RememberedAccount[] {
  try {
    if (!raw || raw.length > 64_000) return [];
    const data = JSON.parse(raw) as { version?: unknown; accounts?: unknown };
    if (data?.version !== 1 || !Array.isArray(data.accounts)) return [];
    const unique = new Set<string>();
    return data.accounts.slice(0, 50).map(project).filter((a): a is RememberedAccount => {
      if (!a || unique.has(a.id)) return false;
      unique.add(a.id); return true;
    }).sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, LIMIT);
  } catch { return []; }
}

export function readRememberedAccounts(): RememberedAccount[] {
  try { return decodeAccounts(localStorage.getItem(KEY)); }
  catch { return []; }
}

function write(accounts: RememberedAccount[]): boolean {
  try {
    if (accounts.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ version: 1, accounts: accounts.slice(0, LIMIT) }));
    window.dispatchEvent(new Event(EVENT));
    return true;
  } catch { return false; }
}

export function rememberAccount(user: PublicUser): boolean {
  const account = project({ id: user.id, username: user.username,
    displayName: user.displayName?.trim() || user.username, loginEmail: user.email, lastUsedAt: Date.now() });
  if (!account) return false;
  // A failed read is not an empty list: never overwrite retained siblings.
  try { return write([account, ...decodeAccounts(localStorage.getItem(KEY)).filter(a => a.id !== account.id)]); }
  catch { return false; }
}

/** Login/refresh may update a retained identity, never opt a new account in. */
export function refreshRememberedAccount(user: PublicUser): void {
  if (readRememberedAccounts().some(a => a.id === user.id)) rememberAccount(user);
}

export function removeRememberedAccount(id: string): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return true;
    // Rewrite even when an ID is absent: discard malformed entries/unknown
    // fields instead of certifying private metadata in an unreadable blob.
    return write(decodeAccounts(raw).filter(a => a.id !== id));
  } catch { return false; }
}

export function subscribeRememberedAccounts(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) listener(); };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener("storage", onStorage); };
}
