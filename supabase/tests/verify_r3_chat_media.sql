-- DISPOSABLE LOCAL PostgreSQL ONLY, after the full migration chain.
-- This is a preliminary Storage RLS regression, not a Storage API/JWT test.
-- The bucket contract used here is proposed, not yet implemented.
begin;

do $$
begin
 if not exists (select 1 from storage.buckets where id='findback-chat-media' and public=false) then
  raise exception 'private chat media bucket missing or public';
 end if;
end $$;

-- A pre-existing unrelated policy must not permit access to this bucket either.
-- Insert a sentinel as the database owner; the transaction is rolled back.
insert into storage.objects(bucket_id,name)
values ('findback-chat-media','test-only/00000000-0000-4000-8000-000000000001');

set local role anon;
do $$
declare n integer;
begin
 begin
  select count(*) into n from storage.objects
   where bucket_id='findback-chat-media'
     and name='test-only/00000000-0000-4000-8000-000000000001';
  if n <> 0 then raise exception 'anonymous chat media object visible'; end if;
 exception when insufficient_privilege then
  null; -- Absence of table SELECT is also a denial.
 end;
end $$;
reset role;
rollback;
select true as private_bucket_anonymous_read_checked;
