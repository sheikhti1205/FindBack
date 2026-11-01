// Owner-authorized one-time population reset. No credentials or user data are logged.
import {execFileSync} from 'node:child_process';
const PROJECT='nfjhpigbsyyoaaktfaev',OP='product-fit-2026-11-01';
const TABLES=`account_deletion_fences account_sanctions admin_audit_log appeal_notifications appeals attachments bootstrap_admins chat_conversations chat_devices chat_external_wake_devices chat_external_wakes chat_mailbox chat_media_attachments chat_media_cleanup_queue chat_media_delivery_receipts chat_media_report_evidence chat_media_report_sources chat_member_state chat_message_audience chat_messages chat_preferences chat_state_audience chat_state_events comment_attachments comment_media_cleanup_queue comment_reactions comments content_reports device_tokens feedback item_posts match_confirmations match_handovers moderation_case_audits moderation_case_decisions notification_preferences notifications post_saves public_action_admissions push_reply_tokens ratings reactions report_match_occupancy report_matches return_ratings role_invitations successful_returns uploads user_blocks user_role_capabilities user_roles users verification_challenges`.split(' ');
const BUCKETS=['findback-images','findback-comment-media','findback-chat-media','findback-chat-moderation-evidence'];
const PUBLIC=TABLES.map(t=>`public.${t}`).join(',');
const fail=code=>{throw new Error(code);};
const check=(ok,code)=>{if(!ok)fail(code);};
let stage='context';
async function http(url,method,body,management=false){
 const r=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/json',...(management?{Authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`}:{apikey:process.env.SUPABASE_SECRET_KEY})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!r.ok){await r.body?.cancel();fail(`HTTP_${r.status}`);}
 const text=await r.text();return text?JSON.parse(text):null;
}
const sql=query=>http(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`,'POST',{query,read_only:false},true);
const api=(path,method='GET',body)=>http(`https://${PROJECT}.supabase.co${path}`,method,body);
async function snapshot(){
 const rows=await sql(`select (select count(*) from auth.users) as auth_users,(select count(*) from storage.objects) as storage_objects,
 (select count(*) from storage.buckets) as storage_buckets,
 (select count(*) from public.bootstrap_admins) as bootstrap_offers,
 (select count(*) from public.role_invitations) as invitation_offers,
 (${TABLES.filter(t=>!['bootstrap_admins','role_invitations'].includes(t)).map(t=>`(select count(*) from public.${t})`).join('+')}) as product_rows`);
 check(Array.isArray(rows)&&rows.length===1,'COUNT_RESPONSE');
 check(Object.values(rows[0]).every(v=>Number.isSafeInteger(v)&&v>=0),'COUNT_SHAPE');return rows[0];
}
async function listFiles(bucket,prefix=''){
 const out=[];
 for(let offset=0;offset<100000;offset+=1000){
  const rows=await api(`/storage/v1/object/list/${bucket}`,'POST',{prefix,limit:1000,offset,sortBy:{column:'name',order:'asc'}});
  check(Array.isArray(rows),'STORAGE_LIST');
  for(const r of rows){check(typeof r.name==='string'&&r.name.length>0,'STORAGE_NAME');const path=prefix+r.name;if(r.id)out.push(path);else out.push(...await listFiles(bucket,path+'/'));}
  if(rows.length<1000)return out;
 }fail('STORAGE_PAGE_BOUND');
}
async function sweep(){
 let removed=0;
 for(const bucket of BUCKETS){
  const names=await listFiles(bucket);
  for(let i=0;i<names.length;i+=1000){await api(`/storage/v1/object/${bucket}`,'DELETE',{prefixes:names.slice(i,i+1000)});removed+=Math.min(1000,names.length-i);}
  check((await listFiles(bucket)).length===0,'STORAGE_NOT_EMPTY');
 }return removed;
}
try{
 const e=process.env;
 check(e.GITHUB_REPOSITORY==='sheikhti1205/FindBack'&&e.GITHUB_REF==='refs/heads/main'&&e.GITHUB_EVENT_NAME==='workflow_dispatch'&&e.GITHUB_ACTOR==='sheikhti1205'&&e.GITHUB_TRIGGERING_ACTOR==='sheikhti1205','CONTEXT');
 check(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()===e.GITHUB_SHA,'SOURCE');
 check(e.SUPABASE_ACCESS_TOKEN&&/^sb_secret_\S+$/.test(e.SUPABASE_SECRET_KEY??''),'CREDENTIALS');
 stage='identity';
 const identity=await sql("select session_user as login,current_user as effective,current_setting('role') as role");
 check(identity?.[0]?.login==='postgres'&&identity[0].effective==='postgres'&&identity[0].role==='none','MAINTENANCE_IDENTITY');
 const catalogue=await sql("select tablename from pg_catalog.pg_tables where schemaname='public' order by tablename");
 check(JSON.stringify(catalogue.map(r=>r.tablename))===JSON.stringify(TABLES),'TABLE_DRIFT');
 const buckets=await api('/storage/v1/bucket');check(Array.isArray(buckets)&&JSON.stringify(buckets.map(b=>b.id).sort())===JSON.stringify([...BUCKETS].sort()),'BUCKET_DRIFT');
 check((await sql("select count(*) as n from storage.buckets where versioning_status::text is distinct from 'DISABLED'"))[0].n===0,'VERSIONED_BUCKET');
 stage='fence';
 await sql(`begin;set local lock_timeout='10s';
 create schema if not exists findback_reset;
 revoke all on schema findback_reset from public,anon,authenticated,service_role;
 create table if not exists findback_reset.operation(id text primary key,stage text not null,before_counts jsonb,after_counts jsonb);
 create table if not exists findback_reset.offers(kind text not null,authority jsonb not null);
 revoke all on all tables in schema findback_reset from public,anon,authenticated,service_role;
 insert into findback_reset.operation(id,stage) values('${OP}','fenced') on conflict do nothing;
 do $$begin if exists(select 1 from findback_reset.operation where id='${OP}' and stage='complete') then raise exception 'Reset already completed';end if;end$$;
 lock table ${PUBLIC},auth.users,storage.objects in share row exclusive mode;
 create or replace function findback_reset.guard() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
 begin
  if session_user='postgres' and current_setting('role')='none' then
   if tg_op='DELETE' then return old;elsif tg_op='TRUNCATE' then return null;else return new;end if;
  end if;
  raise exception 'Fresh-start maintenance in progress' using errcode='55000';
 end$$;
 revoke all on function findback_reset.guard() from public,anon,authenticated,service_role;
 ${TABLES.map(t=>`drop trigger if exists findback_reset_rows on public.${t};create trigger findback_reset_rows before insert or update or delete on public.${t} for each row execute function findback_reset.guard();drop trigger if exists findback_reset_truncate on public.${t};create trigger findback_reset_truncate before truncate on public.${t} for each statement execute function findback_reset.guard();`).join('\n')}
 drop trigger if exists findback_reset_auth on auth.users;create trigger findback_reset_auth before insert or update on auth.users for each row execute function findback_reset.guard();
 drop trigger if exists findback_reset_storage on storage.objects;create trigger findback_reset_storage before insert or update on storage.objects for each row execute function findback_reset.guard();
 commit;`);
 const before=await snapshot();
 await sql(`update findback_reset.operation set before_counts=coalesce(before_counts,'${JSON.stringify(before)}'::jsonb) where id='${OP}'`);
 console.log(JSON.stringify({stage:'before',counts:before}));
 stage='storage';const removed=await sweep();
 stage='public';
 await sql(`begin;set local lock_timeout='10s';
 lock table ${PUBLIC} in access exclusive mode;
 do $$begin
 if (select stage from findback_reset.operation where id='${OP}')='fenced' then
  insert into findback_reset.offers select 'bootstrap',jsonb_build_object('email',email) from public.bootstrap_admins;
  insert into findback_reset.offers select 'invitation',jsonb_build_object('email',email,'role',role,'capabilities',capabilities) from public.role_invitations where accepted_at is null and revoked_at is null;
 end if;
 end$$;
 truncate table ${PUBLIC} restrict;
 update findback_reset.operation set stage='public_deleted' where id='${OP}';commit;`);
 stage='auth';let deleted=0;
 for(let page=0;page<1000;page++){
  const body=await api('/auth/v1/admin/users?page=1&per_page=1000');check(Array.isArray(body?.users),'AUTH_LIST');
  if(!body.users.length)break;
  for(const user of body.users){check(typeof user.id==='string'&&/^[0-9a-f-]{36}$/i.test(user.id),'AUTH_ID');await api(`/auth/v1/admin/users/${user.id}`,'DELETE',{should_soft_delete:false});deleted++;}
  check(page<999,'AUTH_PAGE_BOUND');
 }
 stage='verify';await sweep();const empty=await snapshot();
 check(empty.auth_users===0&&empty.product_rows===0&&empty.storage_objects===0&&empty.bootstrap_offers===0&&empty.invitation_offers===0&&empty.storage_buckets===4,'RESIDUAL_DATA');
 stage='finish';
 await sql(`begin;set local lock_timeout='10s';lock table ${PUBLIC},auth.users,storage.objects in share row exclusive mode;
 do $$begin if exists(select 1 from auth.users) or exists(select 1 from storage.objects) then raise exception 'Residual data';end if;end$$;
 insert into public.bootstrap_admins(email,created_at) select authority->>'email',now()::text from findback_reset.offers where kind='bootstrap';
 insert into public.role_invitations(email,role,capabilities,invited_by,invited_at)
  select authority->>'email',authority->>'role',array(select jsonb_array_elements_text(authority->'capabilities')),null,now()::text from findback_reset.offers where kind='invitation';
 truncate findback_reset.offers;
 create or replace function findback_reset.live_profile() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
 begin
  perform 1 from auth.users where id::text=new.id for key share;
  if not found then raise exception 'Account no longer exists' using errcode='42501';end if;
  return new;
 end$$;
 create or replace function findback_reset.live_storage() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
 declare owner_id text;
 begin
  if new.bucket_id in ('findback-images','findback-comment-media') then
   owner_id:=case when new.bucket_id='findback-images' and split_part(new.name,'/',1)='avatars' then split_part(new.name,'/',2) else split_part(new.name,'/',1) end;
   perform 1 from auth.users where id::text=owner_id for key share;
  elsif new.bucket_id='findback-chat-media' then
   perform 1 from public.chat_media_attachments where object_key=new.name for key share;
  elsif new.bucket_id='findback-chat-moderation-evidence' then
   perform 1 from public.chat_media_report_evidence where object_key=new.name for key share;
  else return new;
  end if;
  if not found then raise exception 'Media owner no longer exists' using errcode='42501';end if;
  return new;
 end$$;
 revoke all on function findback_reset.live_profile(),findback_reset.live_storage() from public,anon,authenticated,service_role;
 drop trigger if exists findback_live_profile on public.users;create trigger findback_live_profile before insert or update on public.users for each row execute function findback_reset.live_profile();
 drop trigger if exists findback_live_storage on storage.objects;create trigger findback_live_storage before insert or update on storage.objects for each row execute function findback_reset.live_storage();
 ${TABLES.map(t=>`drop trigger findback_reset_rows on public.${t};drop trigger findback_reset_truncate on public.${t};`).join('\n')}
 drop trigger findback_reset_auth on auth.users;drop trigger findback_reset_storage on storage.objects;
 update findback_reset.operation set stage='complete' where id='${OP}';commit;`);
 const after=await snapshot();check(after.auth_users===0&&after.product_rows===0&&after.storage_objects===0,'FINAL_RESIDUAL');
 await sql(`update findback_reset.operation set after_counts='${JSON.stringify(after)}'::jsonb where id='${OP}'`);
 console.log(JSON.stringify({status:'reset_complete',source_sha:e.GITHUB_SHA,before,after,storage_objects_removed:removed,auth_accounts_deleted:deleted,preserved:'pending privileged email offers only'}));
}catch(error){console.log(JSON.stringify({status:'failed',stage,error:/^[A-Z_0-9]+$/.test(error.message??'')?error.message:'REQUEST_OR_SQL_FAILED',maintenance_may_remain:!['context','identity'].includes(stage)}));process.exitCode=1;}
