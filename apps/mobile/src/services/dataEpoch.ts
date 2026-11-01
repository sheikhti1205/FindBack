/** Cold-launch boundary. Do not import any auth, storage singleton or app owner here. */
import {Capacitor,registerPlugin} from '@capacitor/core';

export const DATA_EPOCH = 'product-fit-2026-11-01';
export const DATA_EPOCH_KEY = 'findback.data-epoch';
interface NativeEpochReceipt {epoch:string;changed:boolean}
interface NativeEpochPlugin {prepare(options:{epoch:string}):Promise<NativeEpochReceipt>}
const nativeEpoch=registerPlugin<NativeEpochPlugin>('FindbackDataEpoch');

export interface DataEpochEnvironment {
  local:Storage;
  session:Storage;
  indexedDB:IDBFactory;
  caches?:Pick<CacheStorage,'keys'|'delete'>;
  workers?:{getRegistrations():Promise<readonly {unregister():Promise<boolean>}[]>};
  nativeReset?:()=>Promise<NativeEpochReceipt>;
}

const appName=(name:string)=>/^findback(?:[.:-]|$)/i.test(name);
const accountKey=(name:string)=>appName(name)||/^sb-|^supabase\./i.test(name);
function storageKeys(store:Storage):string[]{
  const keys:string[]=[];
  for(let i=0;i<store.length;i++){
    const key=store.key(i);
    if(key===null)throw new Error('Storage changed during reset');
    keys.push(key);
  }
  return keys;
}
function clearKeys(store:Storage,preserveMarker=false){
  const stale=(key:string)=>accountKey(key)&&!(preserveMarker&&key===DATA_EPOCH_KEY);
  for(const key of storageKeys(store).filter(stale))store.removeItem(key);
  if(storageKeys(store).some(stale))throw new Error('Storage reset unconfirmed');
}
function commitMarker(store:Storage){
  store.setItem(DATA_EPOCH_KEY,DATA_EPOCH);
  if(store.getItem(DATA_EPOCH_KEY)!==DATA_EPOCH)throw new Error('Reset completion could not be saved');
}
function deleteDatabase(factory:IDBFactory,name:string):Promise<void>{
  return new Promise((resolve,reject)=>{
    const request=factory.deleteDatabase(name);
    request.onsuccess=()=>resolve();
    request.onerror=()=>reject(new Error('Local database reset failed'));
    request.onblocked=()=>reject(new Error('Close other FindBack tabs before retrying'));
  });
}

/** Completion marker is LAST. Partial deletion deliberately retries,never launches. */
export async function resetLocalDataEpoch(env:DataEpochEnvironment):Promise<boolean>{
  let nativeChanged=false;
  if(env.nativeReset){
    const receipt=await env.nativeReset();
    if(!receipt||receipt.epoch!==DATA_EPOCH||typeof receipt.changed!=='boolean')throw new Error('Native reset unconfirmed');
    nativeChanged=receipt.changed;
  }
  if(env.local.getItem(DATA_EPOCH_KEY)===DATA_EPOCH&&!nativeChanged){
    // localStorage/IDB are origin-wide;sessionStorage belongs to each tab.
    // An old second tab must not keep stale per-account state after upgrading,
    // but must not wipe the first tab's new account/history either.
    if(env.session.getItem(DATA_EPOCH_KEY)!==DATA_EPOCH){clearKeys(env.session);commitMarker(env.session);}
    return false;
  }
  if(typeof env.indexedDB?.databases!=='function')throw new Error('Local database enumeration unavailable');

  // A worker must not continue refreshing app caches while they are removed.
  for(const worker of await env.workers?.getRegistrations()??[]){
    if(!await worker.unregister())throw new Error('App cache owner could not be stopped');
  }
  for(const database of await env.indexedDB.databases()){
    if(database.name&&appName(database.name))await deleteDatabase(env.indexedDB,database.name);
  }
  if((await env.indexedDB.databases()).some(d=>d.name&&appName(d.name)))throw new Error('Local database reset unconfirmed');
  if(env.caches){
    for(const name of await env.caches.keys())await env.caches.delete(name);
    if((await env.caches.keys()).length)throw new Error('App cache reset unconfirmed');
  }
  clearKeys(env.session);
  clearKeys(env.local,true);
  commitMarker(env.session);
  commitMarker(env.local);
  return true;
}

/** Serializes simultaneous new-version tabs without creating app state first. */
export async function prepareLocalDataEpoch():Promise<boolean>{
  const reset=()=>resetLocalDataEpoch({
    local:localStorage,session:sessionStorage,indexedDB,
    caches:globalThis.caches,workers:navigator.serviceWorker,
    nativeReset:Capacitor.isNativePlatform()?()=>nativeEpoch.prepare({epoch:DATA_EPOCH}):undefined,
  });
  return navigator.locks?navigator.locks.request('findback-data-epoch',{mode:'exclusive'},reset):reset();
}
