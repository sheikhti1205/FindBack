import {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router';
import {useAuth} from '../auth';
import {acceptRoleOffer,capabilityLabel,fetchMyRoleOffer,type RoleOffer} from '../services/roles';
import {Button} from './Button';

/** A profile exists only after normal setup; switching accounts destroys consent. */
export function RoleOfferNotice() {
  const {user}=useAuth();
  return user ? <ScopedRoleOfferNotice key={user.id}/> : null;
}

function ScopedRoleOfferNotice() {
  const [offer,setOffer]=useState<RoleOffer|null>(null);
  const [readError,setReadError]=useState(false);
  const [attempt,setAttempt]=useState(0);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(false);
  const [accepted,setAccepted]=useState(false);
  const [deferred,setDeferred]=useState(false);
  const alive=useRef(true),inFlight=useRef(false);
  const status=useRef<HTMLParagraphElement>(null);
  const review=useRef<HTMLButtonElement>(null);
  const actions=useRef<HTMLDivElement>(null);
  const deferredBefore=useRef(false);
  useEffect(()=>{
    alive.current=true;
    return ()=>{alive.current=false;};
  },[]);
  useEffect(()=>{
    let cancelled=false;
    void fetchMyRoleOffer().then(value=>{if(!cancelled){setOffer(value);setReadError(false);}})
      .catch(()=>{if(!cancelled)setReadError(true);});
    return ()=>{cancelled=true;};
  },[attempt]);
  useEffect(()=>{if(accepted)status.current?.focus();},[accepted]);
  useEffect(()=>{
    if(deferred)review.current?.focus();
    else if(deferredBefore.current)actions.current?.querySelector('button')?.focus();
    deferredBefore.current=deferred;
  },[deferred]);
  async function submit(){
    if(!offer||inFlight.current)return;
    inFlight.current=true;setBusy(true);setError(false);
    try{
      await acceptRoleOffer(offer.token);
      if(alive.current)setAccepted(true);
    }catch{if(alive.current)setError(true);}
    finally{inFlight.current=false;if(alive.current)setBusy(false);}
  }
  const title=offer?.role==='ADMIN'?'Admin':'Moderator';
  const cls='shrink-0 border-b border-outline-variant bg-surface px-[min(1.5rem,5vw)] py-3 text-sm text-on-surface';
  if(readError)return <section aria-label="Team invitations" className={cls}>
    <p role="status">Couldn't check team invitations.</p>
    <Button variant="text" onClick={()=>{setReadError(false);setAttempt(v=>v+1);}}>Try again</Button>
  </section>;
  if(!offer)return null;
  if(accepted)return <section aria-label="Team invitation" className={cls}>
    <p ref={status} role="status" tabIndex={-1}>{title} access accepted.</p>
    <Link to="/settings" className="inline-flex min-h-11 items-center underline">Open Settings</Link>
  </section>;
  if(deferred)return <div className={cls}><button ref={review} type="button" className="min-h-11 underline" onClick={()=>setDeferred(false)}>Review {title} offer</button></div>;
  return <section aria-labelledby="role-offer-title" className={cls}>
    <h2 id="role-offer-title" className="font-semibold">{title} access offered</h2>
    <p className="mt-1 text-on-surface-variant">You'll receive {title} access only after you accept. You can keep using Norfold without it.</p>
    <p className="mt-1 text-on-surface-variant">{offer.role==='ADMIN'?'Admins manage the team and community safety.':offer.capabilities.length?`You can: ${offer.capabilities.map(capabilityLabel).join(', ')}.`:'Your team can assign moderation responsibilities later.'}</p>
    <div ref={actions} className="mt-2 flex flex-wrap gap-2">
      <Button loading={busy} className="max-w-full whitespace-normal" onClick={()=>void submit()}>Accept {title} access</Button>
      <Button variant="text" disabled={busy} onClick={()=>setDeferred(true)}>Not now</Button>
    </div>
    {error&&<p role="alert" className="mt-2 text-error">Couldn't confirm acceptance. Refresh the offer before trying again.</p>}
    {error&&<Button variant="text" onClick={()=>{setError(false);setAttempt(v=>v+1);}}>Refresh offer</Button>}
  </section>;
}
