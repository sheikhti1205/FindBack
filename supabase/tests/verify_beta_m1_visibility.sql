-- Relationship eligibility differs from an owner's right to read moderation history.
begin;
insert into public.users(id,username,email,phone,email_verified,created_at,updated_at)
select '00000000-0000-4000-9870-00000000000'||n,'m1_visibility_'||n,
 'm1_visibility_'||n||'@example.invalid','+880198700000'||n,1,now(),now() from generate_series(1,2) n;
insert into public.item_posts(id,user_id,type,title,description,category,status,event_date,moderation_visibility,created_at,updated_at)
select 'm1visibility-'||side,'00000000-0000-4000-9870-00000000000'||case side when 'l' then 1 else 2 end,
 case side when 'l' then 'LOST' else 'FOUND' end,'Wallet','Test','Other','OPEN',current_date,'PUBLISHED',now(),now()
from unnest(array['l','f']) side;
do $$
declare phase text; side text; visibility text; actor text;
 a text:='00000000-0000-4000-9870-000000000001'; b text:='00000000-0000-4000-9870-000000000002';
 m text; errors text[]:='{}'; label text;
begin
 foreach phase in array array['proposal','confirm','handover'] loop
  foreach side in array array['l','f'] loop
   foreach visibility in array array['HIDDEN','REMOVED','PENDING_REVIEW'] loop
    foreach actor in array array[a,b] loop
     label:=phase||'/'||side||'/'||visibility||'/'||case actor when a then 'lost-owner' else 'found-owner' end;
     -- Roll each counterexample back, including an incorrect successful writer,
     -- so every case starts from the same actually published OPEN pair.
     begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub',case actor when a then b else a end,true);
      if phase<>'proposal' then
       m:=public.findback_propose_match('m1visibility-l','m1visibility-f');
       if phase='handover' then
        perform set_config('request.jwt.claim.sub',actor,true);
        if public.findback_confirm_match(m)<>'MATCHED' then raise exception 'fixture confirm failed'; end if;
        perform set_config('request.jwt.claim.sub',case actor when a then b else a end,true);
        if public.findback_handover_match(m)<>'PARTIAL' then raise exception 'fixture partial handover failed'; end if;
       end if;
      end if;
      execute 'reset role';
      update public.item_posts set moderation_visibility=visibility where id='m1visibility-'||side;
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub',actor,true);
      begin
       if phase='proposal' then perform public.findback_propose_match('m1visibility-l','m1visibility-f');
       elsif phase='confirm' then perform public.findback_confirm_match(m);
       else perform public.findback_handover_match(m); end if;
       errors:=array_append(errors,label||': accepted unpublished relationship');
      exception when others then
       if sqlstate<>'P0002' or sqlerrm<>'Match unavailable' then
        errors:=array_append(errors,label||': '||sqlstate||' / '||sqlerrm);
       end if;
      end;
      execute 'reset role';
      -- A refused operation writes no new consent, handover, occupancy or return.
      if phase='proposal' and exists(select 1 from public.report_matches where lost_report_id='m1visibility-l')
       or phase='confirm' and (select count(*) from public.match_confirmations where match_id=m)<>1
       or phase='handover' and (select count(*) from public.match_handovers where match_id=m)<>1
       or exists(select 1 from public.successful_returns where lost_post_id='m1visibility-l') then
       errors:=array_append(errors,label||': leaked write');
      end if;
      raise exception 'CASE_ROLLBACK' using errcode='ZB001';
     exception when sqlstate 'ZB001' then null;
     end;
    end loop;
   end loop;
  end loop;
 end loop;
 if cardinality(errors)>0 then raise exception E'M1 visibility violations:\n%',array_to_string(errors,E'\n'); end if;
end $$;
select 'PASS 36 unpublished pair/caller/phase counterexamples, with no partial writes' as result;
rollback;
