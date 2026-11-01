import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSharePreview } from './prepare-share-preview.mjs';
test('existing SWA deploy includes the renderer, supported runtime and no API-to-SPA fallback',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/web.yml',import.meta.url),'utf8');
 assert.match(workflow,/api_location: apps\/share-preview-dist/);assert.match(workflow,/skip_api_build: true/);
 assert.match(workflow,/node scripts\/prepare-share-preview\.mjs apps\/share-preview-dist/);
 const config=JSON.parse(await readFile(new URL('../apps/mobile/public/staticwebapp.config.json',import.meta.url),'utf8'));
 assert.equal(config.platform.apiRuntime,'node:22');assert.ok(config.navigationFallback.exclude.includes('/api/*'));
});
test('packages the dependency-free HTTP entry with only public config and canonical color roles', async () => {
 const out=await mkdtemp(join(tmpdir(),'share-package-'));
 try {
  await prepareSharePreview(out,{VITE_SUPABASE_URL:'https://project.supabase.co',VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',VITE_PUBLIC_SHARE_ORIGIN:'https://findbackapp.social'});
  const c=JSON.parse(await readFile(join(out,'public-config.json'),'utf8'));
  assert.deepEqual(Object.keys(c).sort(),['css','key','origin','url']);assert.equal(c.key,'sb_publishable_fixture');
  assert.match(c.css,/--fb-surface:.*--fb-primary:/s);assert.match(c.css,/@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.equal(JSON.parse(await readFile(join(out,'host.json'),'utf8')).version,'2.0');
  const bindings=JSON.parse(await readFile(join(out,'share/function.json'),'utf8')).bindings;
  assert.equal(bindings[0].route,'share/{id}');assert.deepEqual(bindings[0].methods,['get','head']);
  assert.match(await readFile(join(out,'share/index.cjs'),'utf8'),/handleShare/);
 } finally {await rm(out,{recursive:true,force:true});}
});
test('refuses absent/privileged/noncanonical config before writing an artifact',async()=>{
 const out=await mkdtemp(join(tmpdir(),'share-invalid-'));
 try {
  for(const env of [{},{VITE_SUPABASE_URL:'https://project.supabase.co',VITE_SUPABASE_PUBLISHABLE_KEY:['sb','secret','invalid'].join('_'),VITE_PUBLIC_SHARE_ORIGIN:'https://findbackapp.social'}])await assert.rejects(prepareSharePreview(out,env),/public configuration/);
 }finally{await rm(out,{recursive:true,force:true});}
});
