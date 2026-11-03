import './index.css';
import {prepareLocalDataEpoch} from './services/dataEpoch';
import {captureExternalAuthEntryFromWindow,takePendingExternalAuthEntry} from './utils/externalAuthEntry';
import {colorTokensFor} from './design/colorSystem';

// Strip credential-bearing callback URLs immediately,without starting Auth.
captureExternalAuthEntryFromWindow();

async function boot(){
  try{
    const changed=await prepareLocalDataEpoch();
    if(changed){
      // Old callbacks/routes belong to the deleted population,not a new session.
      takePendingExternalAuthEntry();
      history.replaceState(null,'','/');
      if(navigator.serviceWorker?.controller){
        // unregister() does not detach an existing controller until navigation.
        // Never import the app under an old cache-serving worker.
        location.reload();
        return;
      }
    }
  }catch{
    const root=document.getElementById('root');
    if(!root)return;
    // No persisted appearance owner is allowed to run yet. Reuse the canonical
    // default palette without reading old preferences or minting a second one.
    const mode=globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';
    for(const [key,value] of Object.entries(colorTokensFor(mode)))document.documentElement.style.setProperty(key,value);
    const section=document.createElement('main');
    section.className='mx-auto max-w-lg bg-surface px-5 py-10 text-on-surface';
    const title=document.createElement('h1');
    title.className='text-xl font-semibold';title.textContent='Preparing your fresh start';
    const message=document.createElement('p');
    message.setAttribute('role','alert');message.className='mt-3 text-on-surface-variant';
    message.textContent="Couldn't finish clearing old app data. Close other Norfold tabs, then try again.";
    const retry=document.createElement('button');
    retry.type='button';retry.className='fb-button-primary mt-5 min-h-11 rounded-full bg-primary px-5 py-2 text-on-primary';
    retry.textContent='Try again';retry.addEventListener('click',()=>location.reload());
    section.append(title,message,retry);root.replaceChildren(section);
    return;
  }
  // Critical: a static App import would rehydrate account owners BEFORE reset.
  await import('./startApp');
}
void boot();
