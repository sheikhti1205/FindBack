import './index.css';
import {prepareLocalDataEpoch} from './services/dataEpoch';
import {captureExternalAuthEntryFromWindow} from './utils/externalAuthEntry';
import {colorTokensFor} from './design/colorSystem';

// Strip credential-bearing callback URLs immediately,without starting Auth.
captureExternalAuthEntryFromWindow();

async function boot(){
  try{
    await prepareLocalDataEpoch();
  }catch{
    const root=document.getElementById('root');
    if(!root)return;
    // No persisted appearance owner is allowed to run yet. Reuse the canonical
    // default palette without starting preference owners or minting another one.
    const mode=globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';
    for(const [key,value] of Object.entries(colorTokensFor(mode)))document.documentElement.style.setProperty(key,value);
    const section=document.createElement('main');
    section.className='mx-auto max-w-lg bg-surface px-5 py-10 text-on-surface';
    const title=document.createElement('h1');
    title.className='text-xl font-semibold';title.textContent='Unable to open Norfold';
    const message=document.createElement('p');
    message.setAttribute('role','alert');message.className='mt-3 text-on-surface-variant';
    message.textContent='Your saved data has not been cleared. Check available storage, then try again.';
    const retry=document.createElement('button');
    retry.type='button';retry.className='fb-button-primary mt-5 min-h-11 rounded-full bg-primary px-5 py-2 text-on-primary';
    retry.textContent='Try again';retry.addEventListener('click',()=>{
      // Keep the captured callback in memory; reload would discard it.
      retry.disabled=true;
      void boot();
    });
    section.append(title,message,retry);root.replaceChildren(section);
    return;
  }
  // A static App import would start account owners before preparation settles.
  await import('./startApp');
}
void boot();
