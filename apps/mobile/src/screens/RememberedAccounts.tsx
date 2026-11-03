import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ArrowRight, Trash2 } from "lucide-react";
import { AuthShell } from "../components/auth/AuthShell";
import { UserAvatar } from "../components/UserAvatar";
import { readRememberedAccounts, removeRememberedAccount, subscribeRememberedAccounts } from "../services/rememberedAccounts";
import { PublicWelcome } from "./PublicWelcome";

/** Mounted only after session/profile/protected-intent resolution. */
export function SignedOutEntry() {
  const location = useLocation();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState(readRememberedAccounts);
  const [openedChooser, setOpenedChooser] = useState(() => accounts.length > 0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [focusAfterRemoval, setFocusAfterRemoval] = useState(false);
  const controls = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const refresh = () => {
      const next = readRememberedAccounts(); setAccounts(next);
      if (next.length) setOpenedChooser(true);
    };
    const unsubscribe = subscribeRememberedAccounts(refresh);
    refresh(); return unsubscribe;
  }, []);
  useEffect(() => {
    if (!focusAfterRemoval) return;
    controls.current?.querySelector<HTMLButtonElement>("button")?.focus();
    setFocusAfterRemoval(false);
  }, [focusAfterRemoval, accounts]);

  if ((location.state as { showPublic?: unknown } | null)?.showPublic === true || !openedChooser) return <PublicWelcome />;
  return <AuthShell title="Welcome back" supporting="Choose an account to sign in.">
    <div ref={controls} className="flex min-w-0 flex-col gap-3">
      {accounts.length > 0 ? <ul className="divide-y divide-outline-variant">
        {accounts.map(account => <li key={account.id} className="flex min-w-0 items-center gap-[8px] py-2">
          <button type="button" aria-label={`Continue as ${account.displayName}, @${account.username}`}
            className="flex min-h-14 min-w-0 flex-1 items-center gap-[12px] rounded-m3-sm px-[4px] text-left hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary"
            onClick={() => navigate("/signin", { state: { rememberedAccountId: account.id } })}>
            <UserAvatar username={account.displayName} size={36} />
            <span className="min-w-0 flex-1 break-words"><span className="block font-semibold">{account.displayName}</span>
              <span className="block text-sm text-on-surface-variant">@{account.username}</span>
              <span className="block break-all text-xs text-on-surface-variant">{account.maskedEmail}</span></span>
            <ArrowRight size={18} className="hidden shrink-0 sm:block" aria-hidden="true" />
          </button>
          <button type="button" aria-label={`Remove ${account.displayName}, @${account.username} from this device`}
            className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-primary"
            onClick={() => {
              if (!removeRememberedAccount(account.id)) { setError("Couldn't remove this account. Try again."); return; }
              setError(""); setNotice(`Removed ${account.displayName} from this device.`); setFocusAfterRemoval(true);
            }}><Trash2 size={18} aria-hidden="true" /></button>
        </li>)}
      </ul> : <p className="text-sm text-on-surface-variant">No accounts saved on this device.</p>}
      <button type="button" className="min-h-11 rounded-m3-sm px-3 text-primary hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary" onClick={() => navigate("/auth")}>Use another account</button>
      <p role="status" className="sr-only">{notice}</p>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
    </div>
  </AuthShell>;
}
