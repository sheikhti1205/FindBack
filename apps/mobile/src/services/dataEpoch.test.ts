import {describe,expect,it} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {DATA_EPOCH,DATA_EPOCH_KEY,resetLocalDataEpoch,type DataEpochEnvironment} from './dataEpoch';

class MemoryStorage implements Storage {
  values=new Map<string,string>();
  reads:string[]=[];
  get length(){return this.values.size;}
  clear(){this.values.clear();}
  key(i:number){return [...this.values.keys()][i]??null;}
  getItem(key:string){this.reads.push(key);return this.values.get(key)??null;}
  setItem(key:string,value:string){this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
}
function fixture(){
  const local=new MemoryStorage(),session=new MemoryStorage(),idb=new IDBFactory();
  const cacheNames=new Set(['findback-products','legacy-app-shell']);
  let registrations=2;
  const env:DataEpochEnvironment={local,session,indexedDB:idb,
    caches:{keys:async()=>[...cacheNames],delete:async(name:string)=>cacheNames.delete(name)},
    workers:{getRegistrations:async()=>Array.from({length:registrations},()=>({unregister:async()=>{registrations--;return true;}}))}};
  return {env,local,session,idb,cacheNames,registrations:()=>registrations};
}
async function seedDatabase(idb:IDBFactory,name:string){
  await new Promise<void>((resolve,reject)=>{const r=idb.open(name,1);r.onupgradeneeded=()=>r.result.createObjectStore('rows');r.onerror=()=>reject(r.error);r.onsuccess=()=>{r.result.close();resolve();};});
}

describe('one-time launch epoch',()=>{
  it('erases old account state,all legacy app DB scopes and caches without reading their values',async()=>{
    const f=fixture();
    for(const key of ['findback:reportDraft:v1:old','findback.appearance.v1','findback.ai.openrouter.v1.old','sb-old-auth-token','supabase.auth.token'])f.local.setItem(key,'synthetic old state');
    f.session.setItem('findback.authReturnTo','/old');f.local.setItem('other-app.setting','preserve');
    for(const name of ['findback-human-history-v1:old:device','findback-report-photo-bytes','findback-chat-media-owners-v1','findback-unknown-legacy','unrelated-database'])await seedDatabase(f.idb,name);
    expect(await resetLocalDataEpoch(f.env)).toBe(true);
    expect([...f.local.values]).toEqual([['other-app.setting','preserve'],[DATA_EPOCH_KEY,DATA_EPOCH]]);
    expect([...f.session.values]).toEqual([[DATA_EPOCH_KEY,DATA_EPOCH]]);
    expect(f.local.reads.every(k=>k===DATA_EPOCH_KEY)).toBe(true);
    expect((await f.idb.databases()).map(d=>d.name)).toEqual(['unrelated-database']);
    expect(f.cacheNames.size).toBe(0);expect(f.registrations()).toBe(0);
  });
  it('does not erase any new product state on later launches',async()=>{
    const f=fixture();await resetLocalDataEpoch(f.env);
    f.local.setItem('findback.new-account','keep');await seedDatabase(f.idb,'findback-new-history');f.cacheNames.add('new-cache');
    expect(await resetLocalDataEpoch(f.env)).toBe(false);
    expect(f.local.values.get('findback.new-account')).toBe('keep');
    expect((await f.idb.databases()).map(d=>d.name)).toEqual(['findback-new-history']);expect(f.cacheNames.has('new-cache')).toBe(true);
  });
  it('clears a second tabs stale session without erasing new shared account data',async()=>{
    const f=fixture();await resetLocalDataEpoch(f.env);
    f.local.setItem('findback.new-account','keep');
    const secondSession=new MemoryStorage();secondSession.setItem('findback.old-session-draft','remove');
    f.env.session=secondSession;
    expect(await resetLocalDataEpoch(f.env)).toBe(false);
    expect(secondSession.values.has('findback.old-session-draft')).toBe(false);
    expect(f.local.values.get('findback.new-account')).toBe('keep');
  });
  it('does not set the marker or launch past an unfinished native reset',async()=>{
    const f=fixture();let finish!:(v:{epoch:string;changed:boolean})=>void;
    f.env.nativeReset=()=>new Promise(r=>{finish=r;});
    const pending=resetLocalDataEpoch(f.env);await Promise.resolve();
    expect(f.local.values.has(DATA_EPOCH_KEY)).toBe(false);
    finish({epoch:DATA_EPOCH,changed:true});expect(await pending).toBe(true);
  });
  it('fails closed when native bridge or its completion contract fails',async()=>{
    const f=fixture();f.env.nativeReset=async()=>{throw new Error('native failure');};
    await expect(resetLocalDataEpoch(f.env)).rejects.toThrow();expect(f.local.values.has(DATA_EPOCH_KEY)).toBe(false);
    f.env.nativeReset=async()=>({epoch:'wrong-epoch',changed:false});
    await expect(resetLocalDataEpoch(f.env)).rejects.toThrow();expect(f.local.values.has(DATA_EPOCH_KEY)).toBe(false);
  });
  it('checks native storage even when web marker is current and resets web when native epoch changed',async()=>{
    const f=fixture();f.local.setItem(DATA_EPOCH_KEY,DATA_EPOCH);f.local.setItem('findback.old','remove');
    f.env.nativeReset=async()=>({epoch:DATA_EPOCH,changed:true});
    expect(await resetLocalDataEpoch(f.env)).toBe(true);expect(f.local.values.has('findback.old')).toBe(false);
  });
  it('keeps the old marker on partial failure and safely retries remaining work',async()=>{
    const f=fixture();f.local.setItem(DATA_EPOCH_KEY,'old');await seedDatabase(f.idb,'findback-old');
    const working=f.env.caches!;f.env.caches={keys:working.keys,delete:async()=>{throw new Error('cache failure');}};
    await expect(resetLocalDataEpoch(f.env)).rejects.toThrow();expect(f.local.values.get(DATA_EPOCH_KEY)).toBe('old');
    f.env.caches=working;expect(await resetLocalDataEpoch(f.env)).toBe(true);expect(f.local.values.get(DATA_EPOCH_KEY)).toBe(DATA_EPOCH);
  });
  it('refuses blocked IndexedDB deletion rather than marking stale history cleared',async()=>{
    const f=fixture();await seedDatabase(f.idb,'findback-open-history');
    const connection=await new Promise<IDBDatabase>(r=>{const open=f.idb.open('findback-open-history');open.onsuccess=()=>r(open.result);});
    try{await expect(resetLocalDataEpoch(f.env)).rejects.toThrow();expect(f.local.values.has(DATA_EPOCH_KEY)).toBe(false);}
    finally{connection.close();}
    expect(await resetLocalDataEpoch(f.env)).toBe(true);
  });
  it('refuses an engine that cannot enumerate legacy database names',async()=>{
    const f=fixture();Object.defineProperty(f.idb,'databases',{value:undefined});
    await expect(resetLocalDataEpoch(f.env)).rejects.toThrow();expect(f.local.values.has(DATA_EPOCH_KEY)).toBe(false);
  });
  it('does not silently continue after storage refuses removing an old auth token',async()=>{
    const f=fixture();f.local.setItem('sb-old-auth-token','synthetic');f.local.removeItem=()=>{};
    await expect(resetLocalDataEpoch(f.env)).rejects.toThrow();expect(f.local.values.has(DATA_EPOCH_KEY)).toBe(false);
  });
  it('refuses a worker that cannot be unregistered before cache deletion',async()=>{
    const f=fixture();f.env.workers={getRegistrations:async()=>[{unregister:async()=>false}]};
    await expect(resetLocalDataEpoch(f.env)).rejects.toThrow();expect(f.local.values.has(DATA_EPOCH_KEY)).toBe(false);
  });
});
