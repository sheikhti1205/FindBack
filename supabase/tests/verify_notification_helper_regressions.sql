-- Disposable full-chain regression for the D2 helper replacement. Never hosted.
-- Exercise the real reaction trigger, not a copied implementation or mock.
begin;
insert into public.users (id, username, email, phone, password_hash, email_verified, phone_verified, created_at, updated_at)
values
 ('00000000-0000-4000-8000-00000000d201', 'dedupe_owner', 'dedupe_owner@example.invalid', '+8801700090201', null, 1, 0, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'),
 ('00000000-0000-4000-8000-00000000d202', 'dedupe_actor', 'dedupe_actor@example.invalid', '+8801700090202', null, 1, 0, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z');
insert into public.item_posts (id, user_id, type, title, description, category, status, event_date, created_at, updated_at)
select 'dedupe-' || label, '00000000-0000-4000-8000-00000000d201', 'LOST', 'Notification regression', 'Scratch only', 'OTHER', 'OPEN', '2026-10-22', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'
from unnest(array['read', 'unread', 'legacy', 'self', 'system']) as fixture(label);

insert into public.reactions (id, post_id, user_id, type, created_at)
values ('dedupe-reaction', 'dedupe-read', '00000000-0000-4000-8000-00000000d202', 'LOVE', '2026-10-22T00:00:00.000Z');
update public.notifications set read = 1 where post_id = 'dedupe-read';
delete from public.reactions where id = 'dedupe-reaction';
insert into public.reactions (id, post_id, user_id, type, created_at)
values ('dedupe-reaction', 'dedupe-read', '00000000-0000-4000-8000-00000000d202', 'WOW', '2026-10-22T00:00:00.000Z');
select 'different kind after read notifies, preserving old history' as probe
where (select count(*) from public.notifications where post_id = 'dedupe-read') = 2
  and (select count(*) from public.notifications where post_id = 'dedupe-read' and reaction_kind = 'WOW' and read = 0) = 1
  and (select count(*) from public.notifications where post_id = 'dedupe-read' and reaction_kind = 'LOVE' and read = 1) = 1;

update public.notifications set read = 1 where post_id = 'dedupe-read';
delete from public.reactions where id = 'dedupe-reaction';
insert into public.reactions (id, post_id, user_id, type, created_at)
values ('dedupe-reaction', 'dedupe-read', '00000000-0000-4000-8000-00000000d202', 'WOW', '2026-10-22T00:00:00.000Z');
select 'same kind after read remains suppressed' as probe
where (select count(*) from public.notifications where post_id = 'dedupe-read') = 2;

insert into public.reactions (id, post_id, user_id, type, created_at)
values ('dedupe-unread', 'dedupe-unread', '00000000-0000-4000-8000-00000000d202', 'LOVE', '2026-10-22T00:00:00.000Z');
delete from public.reactions where id = 'dedupe-unread';
insert into public.reactions (id, post_id, user_id, type, created_at)
values ('dedupe-unread', 'dedupe-unread', '00000000-0000-4000-8000-00000000d202', 'SUPPORT', '2026-10-22T00:00:00.000Z');
select 'unread switches collapse to one current kind' as probe
where (select count(*) from public.notifications where post_id = 'dedupe-unread') = 1
  and (select reaction_kind from public.notifications where post_id = 'dedupe-unread') = 'SUPPORT';

insert into public.reactions (id, post_id, user_id, type, created_at)
values ('dedupe-legacy', 'dedupe-legacy', '00000000-0000-4000-8000-00000000d202', 'LIKE', '2026-10-22T00:00:00.000Z');
update public.notifications set read = 1 where post_id = 'dedupe-legacy';
delete from public.reactions where id = 'dedupe-legacy';
insert into public.reactions (id, post_id, user_id, type, created_at)
values ('dedupe-legacy', 'dedupe-legacy', '00000000-0000-4000-8000-00000000d202', 'DISLIKE', '2026-10-22T00:00:00.000Z');
select 'legacy kind switch after read still notifies' as probe
where (select count(*) from public.notifications where post_id = 'dedupe-legacy' and type in ('LIKE', 'DISLIKE') and reaction_kind is null) = 2;

insert into public.reactions (id, post_id, user_id, type, created_at)
values ('dedupe-self', 'dedupe-self', '00000000-0000-4000-8000-00000000d201', 'LOVE', '2026-10-22T00:00:00.000Z');
select 'self reactions never notify' as probe
where not exists (select 1 from public.notifications where post_id = 'dedupe-self');

-- Six-argument legacy callers still work. Only STATUS and MODERATION permit
-- NULL actors; moderation receipts must not identify the moderator. M3 outcomes
-- are separate events, not one lifetime row per null-actor target. Producers
-- own retry idempotency (e.g. appeal_notifications' unique outcome key).
do $$
begin
  perform public.findback_insert_notification('00000000-0000-4000-8000-00000000d201', null, 'MODERATION', 'dedupe-system', null, 'Outcome');
  perform public.findback_insert_notification('00000000-0000-4000-8000-00000000d201', null, 'MODERATION', 'dedupe-system', null, 'Later outcome');
  perform public.findback_insert_notification('00000000-0000-4000-8000-00000000d201', null, 'STATUS', 'dedupe-system', null, 'Status');
  perform public.findback_insert_notification('00000000-0000-4000-8000-00000000d201', null, 'LIKE', 'dedupe-system', null, 'Forbidden actor');
end;
$$;
select 'system events retain NULL actors without collapsing later outcomes' as probe
where (select count(*) from public.notifications where post_id = 'dedupe-system') = 3
  and (select count(*) from public.notifications where post_id = 'dedupe-system' and type = 'MODERATION' and actor_id is null) = 2
  and (select count(distinct preview) from public.notifications where post_id = 'dedupe-system' and type = 'MODERATION') = 2
  and (select count(*) from public.notifications where post_id = 'dedupe-system' and type = 'STATUS' and actor_id is null) = 1;
rollback;
