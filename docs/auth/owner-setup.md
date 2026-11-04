# Email codes and password recovery: owner setup

The app prefers six-digit email codes for signup confirmation and forgotten
passwords. Email/password sign-in, Google sign-in and recovery-link callbacks
remain available. Source support does **not** establish email/SMS delivery.

## Configure Supabase separately

Use the existing Norfold project and `https://findbackapp.social`. These steps
are an owner checklist, not an automatic configuration/deployment script.

1. In Authentication → Email provider, keep email/password enabled and enable
   **Confirm Email** for signup confirmation. Set **Email OTP length to 6** to
   match this UI. Review expiry and rate limits; do not disable throttling.
2. Set up custom SMTP using a sender you control. Verify sender ownership and
   SPF/DKIM (and DMARC as appropriate) with your email provider. Keep credentials
   only in the provider/Supabase dashboard, never in the app, repository or chat.
   The built-in SMTP service is testing-only and restricts delivery to authorized
   team addresses; it is not public-production delivery.
3. In Email Templates → **Confirm signup**, use the
   [signup sample](confirm-signup-otp.html). The visible code is `{{ .Token }}`.
4. In **Reset password**, use the [recovery sample](reset-password-otp.html).
   Keep `{{ .Token }}` visible and preserve `{{ .ConfirmationURL }}` as the
   optional reset-link alternative. Disable provider link tracking/rewriting
   where it would damage the auth URL.
5. Keep the Site URL at `https://findbackapp.social`. Check the redirect allowlist
   includes `https://findbackapp.social/recovery` and the existing Google callback
   `https://findbackapp.social/auth/callback`. Do not introduce a new domain or
   alter native compatibility identities as part of this setup.
6. Review delivery logs and provider errors without recording codes or credentials.

## Optional SMS

Phone verification is not operational until a supported SMS provider is configured
and delivery is proven. Configure it separately in Authentication → Phone, review
country support/cost/sender/expiry and keep credentials server-side. The existing
phone-change flow remains separate from email signup and password recovery.

## Receipt checks after configuration and explicit test consent

- A new approved test address receives a signup code and verifies successfully.
- An existing approved address receives a recovery code, verifies, sets a new
  password and signs in normally; the old password is rejected.
- Wrong, expired and reused codes are rejected. Repeated requests are throttled.
- Unknown addresses get the same recovery-request wording, with no account lookup.
- Recovering account B while account A is signed in never updates A's password
  or adopts B's OTP session into A's app session. OTP completion invites sign-in;
  it does not claim the recovered account is already signed in.
- Test the reset-link alternative and existing Google callback independently.
- If SMS is enabled, use only a specifically approved test number and confirm
  receipt and identity preservation.

Track source/tests, CI, hosted configuration, real delivery and native/device
acceptance separately. Synthetic tests do not prove hosted delivery. A timed-out
password request may have reached the server: try normal sign-in before assuming
the write was rolled back. Cancellation is not a server rollback guarantee.

## References

- [Email templates](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Verify OTP](https://supabase.com/docs/reference/javascript/auth-verifyotp)
- [Password reset request](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail)
- [Phone authentication](https://supabase.com/docs/guides/auth/phone-login)
