import type { KeyValueStore } from "./storage";

export class AuthAccountChangedError extends Error {
  constructor() { super("Your account changed. The current account was not signed out."); }
}

/** SDK persistence boundary: a delayed A sign-out cannot read or remove B. */
export function createAccountScopedAuthStorage(store: KeyValueStore, sessionKey: string) {
  let cleanupAccount: string | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  function owner(): string | null {
    const serialized = store.getItem(sessionKey);
    if (serialized === null) return null;
    const value = JSON.parse(serialized) as { user?: { id?: unknown } };
    if (typeof value.user?.id !== "string") throw new Error("Stored sign-in could not be checked. Retry cleanup.");
    return value.user.id;
  }
  function assertOwner() {
    const liveOwner = owner();
    if (cleanupAccount !== null && liveOwner !== null && liveOwner !== cleanupAccount) throw new AuthAccountChangedError();
  }
  const storage: KeyValueStore = {
    getItem(key) {
      if (cleanupAccount !== null && key === sessionKey) assertOwner();
      return store.getItem(key);
    },
    setItem: (key, value) => store.setItem(key, value),
    removeItem(key) {
      if (cleanupAccount !== null) assertOwner();
      store.removeItem(key);
      if (store.getItem(key) !== null) throw new Error("Stored sign-in could not be removed. Retry cleanup.");
    },
  };
  async function cleanAccount(accountId: string, operation: () => Promise<unknown>): Promise<void> {
    const task = tail.catch(() => undefined).then(async () => {
      cleanupAccount = accountId;
      try {
        assertOwner();
        await operation();
        assertOwner();
        if (owner() !== null) throw new Error("Stored sign-in could not be removed. Retry cleanup.");
      } finally { cleanupAccount = null; }
    });
    tail = task;
    await task;
  }
  return { storage, cleanAccount };
}
