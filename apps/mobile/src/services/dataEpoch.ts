/** Non-destructive cold-launch compatibility boundary. No account owners here. */
import {Capacitor,registerPlugin} from '@capacitor/core';

export const DATA_EPOCH = 'product-fit-2026-11-01';
export const DATA_EPOCH_KEY = 'findback.data-epoch';
interface NativeEpochReceipt {epoch:string;changed:boolean}
interface NativeEpochPlugin {prepare(options:{epoch:string}):Promise<NativeEpochReceipt>}
const nativeEpoch=registerPlugin<NativeEpochPlugin>('FindbackDataEpoch');

export interface DataEpochEnvironment {
  local:Storage;
  session:Storage;
  indexedDB?:IDBFactory;
  caches?:Pick<CacheStorage,'keys'|'delete'>;
  workers?:{getRegistrations():Promise<readonly {unregister():Promise<boolean>}[]>};
  nativeReset?:()=>Promise<NativeEpochReceipt>;
}

function commitMarker(store:Storage){
  store.setItem(DATA_EPOCH_KEY,DATA_EPOCH);
  if(store.getItem(DATA_EPOCH_KEY)!==DATA_EPOCH)throw new Error('App preparation could not be saved');
}

/** Legacy API name retained; missing/old markers never authorize deletion.
 * Each store owns its supported schema upgrade. A true receipt means only that
 * compatibility metadata changed, never that routes/callbacks should be reset.
 */
export async function resetLocalDataEpoch(env:DataEpochEnvironment):Promise<boolean>{
  let nativeChanged=false;
  if(env.nativeReset){
    const receipt=await env.nativeReset();
    if(!receipt||receipt.epoch!==DATA_EPOCH||typeof receipt.changed!=='boolean')throw new Error('Native preparation unconfirmed');
    nativeChanged=receipt.changed;
  }
  const changed=env.local.getItem(DATA_EPOCH_KEY)!==DATA_EPOCH;
  if(env.session.getItem(DATA_EPOCH_KEY)!==DATA_EPOCH)commitMarker(env.session);
  if(changed)commitMarker(env.local);
  return changed||nativeChanged;
}

/** Serializes simultaneous new-version tabs without creating app state first. */
export async function prepareLocalDataEpoch():Promise<boolean>{
  const prepare=()=>resetLocalDataEpoch({
    local:localStorage,session:sessionStorage,
    nativeReset:Capacitor.isNativePlatform()?()=>nativeEpoch.prepare({epoch:DATA_EPOCH}):undefined,
  });
  return navigator.locks?navigator.locks.request('findback-data-epoch',{mode:'exclusive'},prepare):prepare();
}
