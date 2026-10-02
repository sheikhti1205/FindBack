-- FindBack — device-scoped direct-reply tokens.
--
-- When push-dispatch sends a COMMENT notification it mints one short-lived,
-- single-use token per notification, stores only its SHA-256 hash here, and
-- embeds the raw token in the FCM data payload. The Android RemoteInput reply
-- action posts the typed text plus that token to the `reply-comment` Edge
-- Function, which uses the service role to insert the reply as the token's
-- owner. Tokens are scoped to one (user, report, parent comment) and expire.
--
-- RLS is enabled with NO policies: only the service role ever touches rows.

create table if not exists public.push_reply_tokens (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  post_id text not null references public.item_posts(id) on delete cascade,
  parent_comment_id text not null references public.comments(id) on delete cascade,
  token_hash text not null unique,
  created_at text not null,
  expires_at text not null,
  used_at text
);

create index if not exists idx_push_reply_tokens_hash
  on public.push_reply_tokens (token_hash);

alter table public.push_reply_tokens enable row level security;

comment on table public.push_reply_tokens
  is 'FindBack single-use, expiring reply tokens minted by push-dispatch; service role only.';
