import {describe,expect,it} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {DATA_EPOCH,DATA_EPOCH_KEY,resetLocalDataEpoch,type DataEpochEnvironment} from './dataEpoch';

class MemoryStorage implements Storage {
  values=new Map<string,string>();
  get length(){return this.values.size;}
  clear(){this.values.clear();}
  key(i:number){return [...this.values.keys()][i]??null;}
  getItem(key:string){return this.values.get(key)??null;}
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
  local.setItem('findback:reportDraft:v1:synthetic','saved draft');
  local.setItem('sb-synthetic-auth-token','synthetic auth fixture');
  local.setItem('findback.appearance.v1','dark');
  local.setItem('findback.ai.openrouter.v1.synthetic','synthetic provider fixture');
  session.setItem('findback.authReturnTo','/saved');
  return {env,local,session,idb,cacheNames,registrations:()=>registrations};
}
async function seedDatabase(idb:IDBFactory,name:string){
  await new Promise<void>((resolve,reject)=>{
    const r=idb.open(name,1);
    r.onupgradeneeded=()=>r.result.createObjectStore('rows');
    r.onerror=()=>reject(r.error);
    r.onsuccess=()=>{
      const db=r.result,tx=db.transaction('rows','readwrite');
      tx.objectStore('rows').put('synthetic accepted history','history');
      tx.oncomplete=()=>{db.close();resolve();};
      tx.onerror=()=>{db.close();reject(tx.error);};
    };
  });
}
async function readHistory(idb:IDBFactory,name:string){
  return new Promise<unknown>((resolve,reject)=>{
    const r=idb.open(name);
    r.onerror=()=>reject(r.error);
    r.onsuccess=()=>{
      const db=r.result;
      if(!db.objectStoreNames.contains('rows')){db.close();resolve(null);return;}
      const tx=db.transaction('rows'),get=tx.objectStore('rows').get('history');
      get.onsuccess=()=>resolve(get.result);get.onerror=()=>reject(get.error);
      tx.oncomplete=()=>db.close();
    };
  });
}
function assertPreferencesPreserved(f:ReturnType<typeof fixture>){
  expect(f.local.getItem('findback:reportDraft:v1:synthetic')).toBe('saved draft');
  expect(f.local.getItem('sb-synthetic-auth-token')).toBe('synthetic auth fixture');
  expect(f.local.getItem('findback.appearance.v1')).toBe('dark');
  expect(f.local.getItem('findback.ai.openrouter.v1.synthetic')).toBe('synthetic provider fixture');
  expect(f.session.getItem('findback.authReturnTo')).toBe('/saved');
  expect([...f.cacheNames]).toEqual(['findback-products','legacy-app-shell']);
  expect(f.registrations()).toBe(2);
}

describe('non-destructive launch preparation',()=>{
  it.each([null,'old',DATA_EPOCH])('preserves account data with marker %s',async(marker)=>{
    const f=fixture();
    if(marker!==null)f.local.setItem(DATA_EPOCH_KEY,marker);
    await seedDatabase(f.idb,'findback-human-history-v1:synthetic');
    await seedDatabase(f.idb,'findback-verified-models');
    await resetLocalDataEpoch(f.env);
    assertPreferencesPreserved(f);
    expect(await readHistory(f.idb,'findback-human-history-v1:synthetic')).toBe('synthetic accepted history');
    expect(await readHistory(f.idb,'findback-verified-models')).toBe('synthetic accepted history');
    expect(f.local.getItem(DATA_EPOCH_KEY)).toBe(DATA_EPOCH);
  });
  it('does not require database enumeration or touch unavailable cache/worker APIs',async()=>{
    const f=fixture();Object.defineProperty(f.idb,'databases',{value:undefined});
    f.env.caches={keys:async()=>{throw new Error('cache unavailable');},delete:async()=>{throw new Error('must not delete');}};
    f.env.workers={getRegistrations:async()=>{throw new Error('workers unavailable');}};
    await expect(resetLocalDataEpoch(f.env)).resolves.toBe(true);
    assertPreferencesPreserved(f);
  });
  it('preserves an open history database rather than requesting deletion',async()=>{
    const f=fixture();await seedDatabase(f.idb,'findback-open-history');
    const db=await new Promise<IDBDatabase>(resolve=>{const r=f.idb.open('findback-open-history');r.onsuccess=()=>resolve(r.result);});
    try{await resetLocalDataEpoch(f.env);expect(await readHistory(f.idb,'findback-open-history')).toBe('synthetic accepted history');}
    finally{db.close();}
  });
  it('a second tab does not clear its pending protected destination',async()=>{
    const f=fixture();f.local.setItem(DATA_EPOCH_KEY,DATA_EPOCH);
    f.session.setItem('findback.draft','second tab draft');
    await expect(resetLocalDataEpoch(f.env)).resolves.toBe(false);
    expect(f.session.getItem('findback.draft')).toBe('second tab draft');
    assertPreferencesPreserved(f);
  });
  it('marker read denial fails without modifying user stores',async()=>{
    const f=fixture(),get=f.local.getItem.bind(f.local);
    f.local.getItem=key=>{if(key===DATA_EPOCH_KEY)throw new Error('storage denied');return get(key);};
    await expect(resetLocalDataEpoch(f.env)).rejects.toThrow();
    assertPreferencesPreserved(f);
  });
  it('marker write failure preserves data and can retry safely',async()=>{
    const f=fixture();f.local.setItem(DATA_EPOCH_KEY,'old');
    await seedDatabase(f.idb,'findback-history');
    const set=f.local.setItem.bind(f.local);
    f.local.setItem=(key,value)=>{if(key===DATA_EPOCH_KEY)throw new Error('quota');set(key,value);};
    await expect(resetLocalDataEpoch(f.env)).rejects.toThrow();
    assertPreferencesPreserved(f);
    expect(f.local.getItem(DATA_EPOCH_KEY)).toBe('old');
    expect(await readHistory(f.idb,'findback-history')).toBe('synthetic accepted history');
    f.local.setItem=set;await resetLocalDataEpoch(f.env);assertPreferencesPreserved(f);
  });
  it('does not publish the web marker before native preparation settles',async()=>{
    const f=fixture();let finish!:(v:{epoch:string;changed:boolean})=>void;
    f.env.nativeReset=()=>new Promise(resolve=>{finish=resolve;});
    const pending=resetLocalDataEpoch(f.env);await Promise.resolve();
    expect(f.local.getItem(DATA_EPOCH_KEY)).toBeNull();assertPreferencesPreserved(f);
    finish({epoch:DATA_EPOCH,changed:true});await pending;assertPreferencesPreserved(f);
  });
  it('native marker changes do not authorize deleting web data',async()=>{
    const f=fixture();f.local.setItem(DATA_EPOCH_KEY,DATA_EPOCH);
    f.env.nativeReset=async()=>({epoch:DATA_EPOCH,changed:true});
    await resetLocalDataEpoch(f.env);assertPreferencesPreserved(f);
  });
  it('native failure or invalid receipt denies boot without clearing stores',async()=>{
    const f=fixture();
    for(const nativeReset of [async()=>{throw new Error('native unavailable');},async()=>({epoch:'wrong',changed:false})]){
      f.env.nativeReset=nativeReset;
      await expect(resetLocalDataEpoch(f.env)).rejects.toThrow();
      assertPreferencesPreserved(f);expect(f.local.getItem(DATA_EPOCH_KEY)).toBeNull();
    }
  });
});
