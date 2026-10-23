import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { SettingsGroup, SettingsPage } from "../components/settings";
import { announce } from "../components/LiveRegion";
import {
  bootstrapAdmin,
  bootstrapRefusalMessage,
  fetchBootstrapClaimStatus,
  type BootstrapClaimStatus,
} from "../services/roles";
import { friendlyError } from "../utils/friendlyErrors";
import "../components/AdminConsole.css";

/**
 * The one-time administrator setup (integrator: mount at
 * `/settings/administrator`).
 *
 * The claim itself lives on the server and can only happen once. This screen
 * is the surface the owner was missing: it asks the server whether THIS
 * account may claim, explains in plain words what claiming means, asks for an
 * explicit confirmation before the irreversible step, and then says what
 * happened.
 *
 * TWO RULES THIS SCREEN KEEPS.
 *
 *   1. THE SERVER'S SENTENCE IS THE ANSWER. When the claim is refused, the
 *      refusal the screen shows is the sentence the server raised — "An admin
 *      already exists", "This account is not in the admin bootstrap list",
 *      "Confirm your email address before claiming the admin role" — not a
 *      generic "you do not have permission". A refusal is an answer about
 *      this account, and the screen stays usable afterwards.
 *
 *   2. NO HALF-TRUTHS. While the server has not answered, the screen says it
 *      is checking. When the server says the claim is closed, the screen says
 *      so in the server's own words. Nothing here decides who may be an
 *      administrator; the server does, and it re-checks at the moment of the
 *      claim.
 */
export function AdminBootstrap() {
  const { user } = useAuth();
  return user ? <AdminBootstrapAccount key={user.id} /> : null;
}

function AdminBootstrapAccount() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<BootstrapClaimStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const readVersion = useRef(0);
  const inFlight = useRef(false);
  const confirmation = useRef<HTMLParagraphElement>(null);
  const start = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (confirming) confirmation.current?.focus();
  }, [confirming]);

  const read = useCallback(() => {
    const version = ++readVersion.current;
    setConfirming(false);
    setLoading(true);
    setReadError(null);
    setRefusal(null);
    void fetchBootstrapClaimStatus()
      .then((answer) => {
        if (version !== readVersion.current) return;
        setStatus(answer);
      })
      .catch((err: unknown) => {
        if (version !== readVersion.current) return;
        setStatus(null);
        setReadError(bootstrapRefusalMessage(err) ?? friendlyError(err).message);
      })
      .finally(() => {
        if (version !== readVersion.current) return;
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    read();
    return () => { ++readVersion.current; };
  }, [read]);

  async function claim() {
    if (inFlight.current || !confirming || !status?.canClaim) return;
    const version = readVersion.current;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    try {
      await bootstrapAdmin();
      if (version !== readVersion.current) return;
      setClaimed(true);
      setConfirming(false);
      announce("The administrator role is now active on this account.");
    } catch (err: unknown) {
      if (version !== readVersion.current) return;
      // The server's own sentence, kept whole. Only a failure that is NOT the
      // server's answer falls back to the house's generic wording.
      const sentence = bootstrapRefusalMessage(err) ?? friendlyError(err).message;
      setRefusal(sentence);
      announce(sentence);
    } finally {
      inFlight.current = false;
      if (version === readVersion.current) setBusy(false);
    }
  }

  const mayClaim = status?.canClaim === true;

  return (
    <SettingsPage
      title="Administrator"
      description="Set up this account as the administrator of FindBack."
      backTo="/settings"
    >
      <SettingsGroup title="Administrator setup">
        {loading && (
          <p role="status" className="fb-admin-note">
            Checking whether this account can be set up as the administrator…
          </p>
        )}

        {readError && !loading && (
          <>
            <p role="alert" className="fb-admin-error">
              {readError}
            </p>
            <div className="fb-admin-actions">
              <Button variant="outline" onClick={read}>
                Try again
              </Button>
            </div>
          </>
        )}

        {claimed && (
          <>
            <p className="fb-admin-note" data-testid="admin-bootstrap-claimed">
              The administrator role is now active on this account. You can
              manage moderators, review reports and change app settings.
            </p>
            <div className="fb-admin-actions">
              <Button onClick={() => navigate("/settings/team")}>Manage the team</Button>
            </div>
          </>
        )}

        {!claimed && !loading && !readError && refusal && (
          <>
            <p role="alert" className="fb-admin-error" data-testid="admin-bootstrap-refusal">
              {refusal}
            </p>
            <div className="fb-admin-actions">
              <Button variant="outline" onClick={read}>
                Check again
              </Button>
            </div>
          </>
        )}

        {!claimed && !loading && !readError && !refusal && status && !mayClaim && (
          <>
            <p role="alert" className="fb-admin-error" data-testid="admin-bootstrap-closed">
              {status.reason ?? "This account cannot be set up as the administrator."}
            </p>
            <div className="fb-admin-actions">
              <Button variant="outline" onClick={read}>
                Check again
              </Button>
            </div>
          </>
        )}

        {!claimed && !loading && !readError && !refusal && mayClaim && !confirming && (
          <>
            <p className="fb-admin-note">
              Claiming makes this account the administrator of FindBack: the
              person who manages moderators, reviews reports and changes app
              settings.
            </p>
            <p className="fb-admin-note">
              This is a one-time setup. Keep access to this account: losing
              it does not let you claim again.
            </p>
            <div ref={start} className="fb-admin-actions">
              <Button onClick={() => setConfirming(true)}>Set up administrator access</Button>
            </div>
          </>
        )}

        {!claimed && !loading && !readError && !refusal && mayClaim && confirming && (
          <div className="fb-admin-confirm">
            <p ref={confirmation} tabIndex={-1} className="fb-admin-note">
              Set up this account as the administrator of FindBack now? This
              cannot be undone.
            </p>
            <div className="fb-admin-actions">
              <Button loading={busy} onClick={() => void claim()}>
                Yes, set it up
              </Button>
              <Button variant="text" disabled={busy} onClick={() => {
                setConfirming(false);
                requestAnimationFrame(() => start.current?.querySelector("button")?.focus());
              }}>
                Not now
              </Button>
            </div>
          </div>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
