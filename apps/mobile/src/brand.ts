/**
 * Canonical current product identity.
 *
 * The consumer product is **Norfold** (formerly FindBack). The public origin is
 * deliberately still the legacy domain: the site moves only after a Norfold
 * domain is acquired and a controlled migration is ready, so nothing here may
 * invent or hard-code a replacement address.
 *
 * Technical identifiers are NOT branding and stay put: the Android application
 * id, the Supabase project, `findback_*` SQL/RPC names, storage buckets and
 * applied migrations are live contracts.
 */
export const PRODUCT_NAME = "Norfold";
export const LEGACY_PRODUCT_NAME = "FindBack";

/** The live site during the name transition; not a future Norfold domain. */
export const PUBLIC_ORIGIN = "https://findbackapp.social";

/** One quiet sentence for About and the public footer. */
export const WEBSITE_TRANSITION_NOTE =
  "FindBack is now Norfold. The current site remains findbackapp.social until the Norfold address is ready.";
