import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { normalizePhone } from "@findback/shared";
import { useAuth } from "../auth";
import { getSupabase } from "../services/supabaseClient";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";

/**
 * Dedicated view/edit profile page (AI-010).
 *
 * Editable surface is deliberately narrow. The backend `public.users` table
 * grants clients NO INSERT/UPDATE/DELETE (rows are trigger-owned — see
 * migration 20260920000000_users_privacy_convergence), so:
 * - username: read-only (fixed at signup by the provisioning trigger).
 * - email: read-only (comes from the Auth session; changing it needs a
 *   re-verification flow this build does not ship).
 * - phone: editable — `PublicUser.phone` is read from Auth user metadata
 *   (`fetchMe`), which `supabase.auth.updateUser({ data })` can write
 *   client-side. Validated with the same Bangladesh rule the backend
 *   trigger enforces, then `refreshUser()` re-reads the profile.
 */
export function ProfileEdit() {
  const { user, refreshUser } = useAuth();
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!user) return null;

  const unchanged = phone.trim() === user.phone || normalizePhone(phone) === user.phone;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaveError(null);
    setSaved(false);
    const normalized = normalizePhone(phone);
    if (!normalized) {
      setFieldError("Enter a valid Bangladesh mobile number (e.g., 01812345678).");
      return;
    }
    setFieldError(null);
    setSaving(true);
    try {
      const { error } = await getSupabase().auth.updateUser({ data: { phone: normalized } });
      if (error) throw error;
      await refreshUser();
      setPhone(normalized);
      setSaved(true);
    } catch (err) {
      // Supabase failures arrive as AuthError (an Error), but stay defensive:
      // surface any message-like rejection instead of swallowing it.
      const message =
        err instanceof Error
          ? err.message
          : typeof (err as { message?: unknown } | null)?.message === "string"
            ? (err as { message: string }).message
            : null;
      setSaveError(message || "Could not save changes. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 px-4 py-5">
      <header>
        <Link to="/profile" className="text-sm font-medium text-on-surface underline">
          Back to profile
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Edit profile</h1>
      </header>

      <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)} noValidate>
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
            Profile saved.
          </p>
        )}

        <TextField
          label="Username"
          value={user.username}
          readOnly
          autoCapitalize="none"
          autoCorrect="off"
          hint="Usernames can't be changed — they're fixed when your account is created."
        />
        <TextField
          label="Email"
          type="email"
          value={user.email}
          readOnly
          autoCapitalize="none"
          autoCorrect="off"
          hint="Email changes need re-verification, which isn't available in this build."
        />
        <TextField
          label="Mobile (Bangladesh)"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="01812345678"
          inputMode="numeric"
          autoComplete="tel"
          required
          error={fieldError ?? undefined}
        />

        <Button type="submit" size="lg" loading={saving} disabled={unchanged}>
          Save changes
        </Button>
      </form>
    </div>
  );
}
