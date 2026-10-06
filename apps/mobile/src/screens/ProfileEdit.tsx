import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { normalizePhone } from "@findback/shared";
import { useAuth } from "../auth";
import { saveProfilePhone } from "../services/auth";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
} from "../components/settings";

/**
 * Profile editor (compat route `/profile/edit` stays valid; back link goes
 * to `/settings/account`).
 *
 * Editable surface is deliberately narrow. The backend `public.users` table
 * grants clients NO INSERT/UPDATE/DELETE (rows are trigger-owned — see
 * migration 20260920000000_users_privacy_convergence), so:
 * - username: read-only (fixed at signup by the provisioning trigger),
 *   rendered as information — never an editable-looking input.
 * - email: read-only (no email-change flow ships in this build), rendered
 *   as information. Unsupported actions/statuses are omitted, not warned
 *   about.
 * - phone: editable — `PublicUser.phone` is read from Auth user metadata
 *   (`fetchMe`), which `supabase.auth.updateUser({ data })` can write
 *   client-side. Validated with the same Bangladesh rule the backend
 *   trigger enforces. Saving does not send SMS; the server clears the badge
 *   unless the desired number matches the confirmed Auth phone. `/verify`
 *   explicitly starts the authenticated phone-change challenge.
 */
export function ProfileEdit() {
  const { user } = useAuth();
  const [savedFor, setSavedFor] = useState<string | null>(null);
  if (!user) return null;
  const identity = `${user.id}:${user.phone}`;
  return <ProfilePhoneEditor key={identity} initialSaved={savedFor === identity}
    onSaved={(phone) => setSavedFor(`${user.id}:${phone}`)} />;
}

function ProfilePhoneEditor({ initialSaved, onSaved }: { initialSaved: boolean; onSaved: (phone: string) => void }) {
  const { user, setUser } = useAuth();
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(initialSaved);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  if (!user) return null;

  const unchanged = phone.trim() === user.phone || normalizePhone(phone) === normalizePhone(user.phone);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    setSaveError(null);
    setSaved(false);
    const normalized = normalizePhone(phone);
    if (!normalized) {
      setFieldError("Enter a valid Bangladesh mobile number (e.g., 01812345678).");
      return;
    }
    setFieldError(null);
    setSaving(true);
    busy.current = true;
    try {
      const profile = await saveProfilePhone(user!.id, normalized);
      if (!alive.current) return;
      onSaved(profile.phone);
      setUser(profile);
      setPhone(normalized);
      setSaved(true);
    } catch {
      if (!alive.current) return;
      // Human error (what happened + what to do): never surface raw
      // provider messages on this screen.
      setSaveError("Could not save your mobile number. Check your connection and try again.");
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
    }
  }

  return (
    <SettingsPage title="Edit profile" backTo="/settings/account" backLabel="Back to Account">
      <SettingsGroup title="Account information">
        <SettingsRow
          title="Username"
          description="Fixed when your account was created."
          value={`@${user.username}`}
        />
        <SettingsRow title="Email" value={user.email} />
      </SettingsGroup>

      <SettingsGroup title="Mobile number">
        <form
          className="flex flex-col gap-4 p-4"
          onSubmit={(e) => void onSubmit(e)}
          noValidate
        >
          <p className="text-sm text-on-surface-variant">Saving does not send SMS. Verify your new mobile number to confirm ownership.</p>
          {saveError && (
            <p
              className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error"
              role="alert"
            >
              {saveError}
            </p>
          )}
          {saved && (
            <p
              className="rounded-m3-sm border border-outline-variant px-3 py-2 text-sm text-on-surface"
              role="status"
            >
              Mobile number saved.
            </p>
          )}

          <TextField
            label="Mobile (Bangladesh)"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="01812345678"
            inputMode="numeric"
            autoComplete="tel"
            required
            disabled={saving}
            error={fieldError ?? undefined}
          />

          <Button type="submit" size="lg" loading={saving} disabled={unchanged}>
            Save changes
          </Button>
          {!user.phoneVerified && <Link to="/verify" className="min-h-[44px] py-3 text-sm underline">Verify mobile number</Link>}
        </form>
      </SettingsGroup>
    </SettingsPage>
  );
}
