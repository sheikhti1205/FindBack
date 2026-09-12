-- Prepare public.users for the Supabase Auth cutover.
--
-- Supabase Auth will own password storage, so a production profile row must be
-- insertable before/without a password. The column itself is intentionally kept
-- for now: the local/SQLite auth provider still uses it, and dropping it is
-- deferred until the Supabase Auth implementation is complete.
alter table public.users
  alter column password_hash drop not null;
