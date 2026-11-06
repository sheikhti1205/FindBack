import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertDeviceListPlan,assertDeviceListSnapshot} from './device-list-deployment.mjs';
test('only the authorized pending migration or a known up-to-date plan passes',()=>{
  assert.deepEqual(assertDeviceListPlan('Would push:\n • 20261106010000_norfold_device_list.sql'),['20261106010000_norfold_device_list.sql']);
  assert.deepEqual(assertDeviceListPlan('Remote database is up to date.'),[]);
  for(const plan of ['', 'unknown output','20261104020000_norfold_backup_authority.sql', '20261106010000_norfold_device_list.sql\n20261107010000_other.sql'])assert.throws(()=>assertDeviceListPlan(plan));
});
test('live receipt requires exact body, tracked migration and unchanged execute fences',()=>{
  const source=readFileSync(new URL('../supabase/migrations/20261106010000_norfold_device_list.sql',import.meta.url),'utf8');
  const row={body:source.match(/\$\$([\s\S]*?)\$\$/)[1],migrated:true,security_definer:true,authenticated_execute:true,anon_execute:false,service_execute:false,config:['search_path=public, pg_temp']};
  assert.doesNotThrow(()=>assertDeviceListSnapshot(row,source));
  for(const extra of [{body:'old function'},{migrated:false},{security_definer:false},{authenticated_execute:false},{anon_execute:true},{service_execute:true},{config:[]}])assert.throws(()=>assertDeviceListSnapshot({...row,...extra},source));
});
