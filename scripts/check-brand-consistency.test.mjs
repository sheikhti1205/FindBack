import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkBrandConsistency} from './check-brand-consistency.mjs';
const manifest='apps/mobile/src/assets/brand/generated-brand-manifest.json';
test('all current source brand surfaces have canonical provenance',()=>{
 assert.ok(checkBrandConsistency().outputs>50);
});
test('rejects changed art, omitted outputs, stale HTML, old native splash and bell',()=>{
 const cases=[
  ['apps/mobile/public/icons/findback-birdleaf-v1-32.png',Buffer.from('wrong art')],
  [manifest,Buffer.from(JSON.stringify({...JSON.parse(readFileSync(manifest)),outputs:{}}))],
  ['apps/mobile/index.html',Buffer.from('<link rel="icon" href="/icons/findback-192.png">')],
  ['apps/mobile/android/app/src/main/res/values/styles.xml',Buffer.from('windowSplashScreenAnimatedIcon @mipmap/ic_launcher')],
  ['apps/mobile/android/app/src/main/res/drawable/ic_stat_findback.xml',Buffer.from('<vector>bell</vector>')],
 ];
 for(const [changed,bytes] of cases){
  assert.throws(()=>checkBrandConsistency({read:path=>path===changed?bytes:readFileSync(path)}),undefined,changed);
 }
});
test('rejects a substitute auth logo even if all generated assets are correct',()=>{
 const path='apps/mobile/src/components/auth/AuthShell.tsx';
 assert.throws(()=>checkBrandConsistency({read:p=>p===path?Buffer.from('import { Radar } from "lucide-react"; <Radar />'):readFileSync(p)}));
});
