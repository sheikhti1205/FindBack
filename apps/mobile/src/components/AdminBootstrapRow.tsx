import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useAuth } from "../auth";
import { fetchBootstrapClaimStatus } from "../services/roles";
import { SettingsGroup, SettingsRow } from "./settings";

/**
 * The one-time administrator setup, offered ONLY to the account the server
 * says may claim it.
 *
 * The server owns the answer (`findback_bootstrap_claim_status`): it consults
 * the caller's own address, the caller's own confirmed flag and the allowlist,
 * and it answers "yes" only when the claim would really succeed. The client
 * never guesses, so this row is not a guess either:
 *
 *   * while the answer is unknown, NOTHING is rendered;
 *   * when the answer is "no", NOTHING is rendered;
 *   * when the answer is "yes", the row appears.
 *
 * The consequence is deliberate: for an ordinary account the Settings page
 * shows no administrator wording at all — not a disabled row, not a note, not
 * a hint. The one person who is allowed to claim it is the only person who
 * ever sees it.
 *
 * A failure to read the answer hides the row too. An unreadable answer is
 * not a yes, and the claim itself re-checks everything on the server, so the
 * worst a hidden row can do is hide a button the owner can reach again after
 * the connection returns.
 */
export function AdminBootstrapRow() {
  const { user } = useAuth();
  return user ? <EligibleBootstrapRow key={user.id} /> : null;
}

function EligibleBootstrapRow() {
  const [canClaim, setCanClaim] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchBootstrapClaimStatus()
      .then((status) => {
        if (!cancelled) setCanClaim(status.canClaim === true);
      })
      .catch(() => {
        // An unreadable answer is not a yes. The row stays away and the
        // owner is told nothing, because there is nothing honest to say.
        if (!cancelled) setCanClaim(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!canClaim) return null;

  return (
    <SettingsGroup title="Administrator">
      <SettingsRow
        title="Become the administrator"
        description="Set up this account as the admin of FindBack."
        icon={ShieldCheck}
        iconTone="privacy"
        route="/settings/administrator"
      />
    </SettingsGroup>
  );
}
