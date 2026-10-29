-- A durable physical return belongs to the confirmed attempt, not earlier
-- cancelled proposals with the same retained report pair.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9871-00000000000'||n,'m1_history_'||n,
 'm1_history_'||n||'@example.invalid','+880198710000'||n,1,now(),now() from generate_series(1,2) n;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,moderation_visibility,created_at,updated_at)
select 'm1history-'||side,'00000000-0000-4000-9871-00000000000'||case side when 'l' then 1 else 2 end,
 case side when 'l' then 'LOST' else 'FOUND' end,'Wallet','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()
from unnest(array['l','f']) side;
do $$
declare old_attempt text; recovered_attempt text; phase text; errors text[]:='{}';
 a text:='00000000-0000-4000-9871-000000000001'; b text:='00000000-0000-4000-9871-000000000002';
begin
 execute 'set local role authenticated';
 perform set_config('request.jwt.claim.sub',a,true);
 old_attempt:=public.findback_propose_match('m1history-l','m1history-f');
 perform public.findback_cancel_match(old_attempt);
 recovered_attempt:=public.findback_propose_match('m1history-l','m1history-f');
 if old_attempt=recovered_attempt then raise exception 'reproposal reused cancelled identity'; end if;
 perform set_config('request.jwt.claim.sub',b,true);
 if public.findback_confirm_match(recovered_attempt)<>'MATCHED' then raise exception 'fixture confirmation failed'; end if;
 if public.findback_handover_match(recovered_attempt)<>'PARTIAL' then raise exception 'fixture first handover failed'; end if;
 perform set_config('request.jwt.claim.sub',a,true);
 if public.findback_handover_match(recovered_attempt)<>'RECOVERED' then raise exception 'fixture recovery failed'; end if;
 execute 'reset role';
 foreach phase in array array['live','peer-deleted','both-reports-deleted'] loop
  if phase='peer-deleted' then delete from public.item_posts where id='m1history-f';
  elsif phase='both-reports-deleted' then delete from public.item_posts where id='m1history-l'; end if;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub',a,true);
  if (select count(*) from public.findback_my_matches(p_post_id=>'m1history-l'))<>2
   or not exists(select 1 from public.findback_my_matches(p_post_id=>'m1history-l')
     where match_id=old_attempt and state='CANCELLED' and cancel_reason='USER_CANCELLED'
       and return_id is null and not my_handover)
   or not exists(select 1 from public.findback_my_matches(p_post_id=>'m1history-l')
     where match_id=recovered_attempt and state='RECOVERED' and return_id is not null and my_handover) then
   errors:=array_append(errors,phase||': cancelled attempt conflated with later recovered attempt');
  end if;
  execute 'reset role';
 end loop;
 if (select count(*) from public.successful_returns where lost_post_id_original='m1history-l')<>1 then
  errors:=array_append(errors,'physical return not exactly one');
 end if;
 if cardinality(errors)>0 then raise exception E'M1 attempt-history violations:\n%',array_to_string(errors,E'\n'); end if;
end $$;
select 'PASS distinct cancelled/recovered attempts before and after report deletion' as result;
rollback;
