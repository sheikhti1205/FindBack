-- Hosted projects can retain table-wide grants installed outside the migration
-- chain. A column REVOKE cannot override them. Preserve effective permissions
-- on every existing ordinary column, but keep the sharing control RPC-only.
begin;
do $$
declare
 v_privilege text;
 v_columns text;
begin
 foreach v_privilege in array array['SELECT','INSERT','UPDATE'] loop
  select string_agg(quote_ident(a.attname),',' order by a.attnum) into v_columns
  from pg_catalog.pg_attribute a
  where a.attrelid='public.item_posts'::regclass and a.attnum>0 and not a.attisdropped
   and a.attname<>'public_share_enabled'
   and has_column_privilege('authenticated','public.item_posts',a.attname,v_privilege);
  execute format('revoke %s on public.item_posts from authenticated',v_privilege);
  execute format('revoke %s(public_share_enabled) on public.item_posts from authenticated',v_privilege);
  if v_columns is not null then
   execute format('grant %s (%s) on public.item_posts to authenticated',v_privilege,v_columns);
  end if;
 end loop;
end;
$$;
commit;
