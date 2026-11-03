import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {test} from 'node:test';
const read=p=>readFileSync(p,'utf8');
test('only shipping workspaces and commands remain; no retired API or container runtime',()=>{
 const pkg=JSON.parse(read('package.json'));
 assert.deepEqual(pkg.workspaces,['apps/mobile','packages/shared']);
 for(const command of Object.values(pkg.scripts))assert.doesNotMatch(command,/services\/api|@findback\/api/);
 for(const p of ['services/api/package.json','Dockerfile','docker-compose.yml','scripts/report-activity.mjs'])assert.equal(existsSync(p),false,p);
 const lock=JSON.parse(read('package-lock.json'));
 assert.equal(lock.packages['services/api'],undefined);assert.equal(lock.packages['node_modules/@norfold/api'],undefined);
 const mobile=JSON.parse(read('apps/mobile/package.json'));
 assert.equal(mobile.devDependencies.vitest,'5.0.5','mobile owns its test runner, not the deleted API');
 assert.equal(lock.packages['apps/mobile'].devDependencies.vitest,'5.0.5');
});
test('CI/release have no retired runtime gate while live Supabase and app verification stay wired',()=>{
 for(const p of ['.github/workflows/ci.yml','.github/workflows/release.yml']){
  const s=read(p);assert.doesNotMatch(s,/@findback\/api|services\/api|docker build|docker run|localhost:4000/);
  const mobileName=JSON.parse(read('apps/mobile/package.json')).name;
  assert.ok(s.includes(`npm test -w ${mobileName}`));assert.match(s,/check-security-baseline/);assert.match(s,/scan:secrets/);
 }
 assert.match(read('.github/workflows/ci.yml'),/sql-behavior\.mjs --apply-chain/);
 assert.match(read('.github/workflows/backend-deploy.yml'),/supabase/);
 assert.match(read('.github/workflows/web.yml'),/api_location: apps\/share-preview-dist/);
});
test('unique live SQL/shared regression specifications survive the dead backend deletion',()=>{
 for(const p of ['migrations.test.ts','multiImageReport.migration.test.ts','unit-validation.test.ts','sharedSchemaCompatibility.test.ts','boundedCollection.test.ts'])assert.equal(existsSync(`apps/mobile/src/contracts/${p}`),true,p);
});
test('mobile and Edge runtime sources cannot import or call the retired backend',()=>{
 const walk=d=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(`${d}/${e.name}`):/\.(?:ts|tsx|js|mjs)$/.test(e.name)&&!e.name.includes('.test.')?[`${d}/${e.name}`]:[]);
 for(const p of [...walk('apps/mobile/src'),...walk('supabase/functions')])assert.doesNotMatch(read(p),/services\/api|@findback\/api|VITE_API_URL|__API_URL__|localhost:4000|socket\.io-client/ ,p);
});
