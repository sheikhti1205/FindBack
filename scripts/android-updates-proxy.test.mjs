import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { handleUpdates } = createRequire(import.meta.url)('../apps/share-preview/android-updates/index.cjs');
const API='https://api.github.com/repos/sheikhti1205/Norfold/releases?per_page=20';
const TAG='v0.14.0-beta.1';
const URL=`https://github.com/sheikhti1205/Norfold/releases/download/${TAG}/catalogue.v1.json`;
const body=JSON.stringify({schemaVersion:1,releases:[{tag:TAG,versionName:'0.14.0-beta.1'}]});
const listing=()=>new Response(JSON.stringify([{tag_name:TAG,draft:false,assets:[{name:'catalogue.v1.json'}]}]));
const upstream=response=>async url=>url===API?listing():response();
test('proxies only fixed public metadata with no-store, never a caller URL', async () => {
  const result = await handleUpdates({ method:'GET', query:{url:'https://untrusted.test'} }, async url => {
    if(url===API)return listing();
    assert.equal(url,URL);
    return new Response(body);
  });
  assert.equal(result.status,200);
  assert.equal(result.headers['Cache-Control'],'no-store');
});
test('a missing/bad/unavailable release is a failure, not an empty catalogue', async () => {
  for(const response of [new Response('',{status:404}),new Response('not json'),new Response('{"releases":[]}'),new Response('x'.repeat(128*1024+1))]) {
    const result = await handleUpdates({method:'GET'},upstream(()=>response));
    assert.equal(result.status,503);
  }
});
test('HEAD carries no metadata body',async()=>{
  const result=await handleUpdates({method:'HEAD'},upstream(()=>new Response(body)));
  assert.equal(result.status,200);assert.equal(result.body,'');
});
test('public metadata is readable from the Android WebView origin, including failure responses',async()=>{
  for (const status of [200,503]) {
    const result=await handleUpdates({method:'GET',headers:{origin:'https://localhost'}},upstream(()=>new Response(body,{status})));
    assert.equal(result.status,status);
    assert.equal(result.headers['Access-Control-Allow-Origin'],'*');
    assert.equal(result.headers['Access-Control-Allow-Credentials'],undefined);
  }
});
test('discovers numbered prereleases, ignores rolling/draft releases and never follows an asset-supplied URL',async()=>{
  const result=await handleUpdates({method:'GET'},async url=>{
    if(url===API)return new Response(JSON.stringify([
      {tag_name:'android-latest',assets:[{name:'catalogue.v1.json'}]},
      {tag_name:'v0.15.0-beta.1',draft:true,assets:[{name:'catalogue.v1.json'}]},
      {tag_name:'v0.13.0-beta.9',draft:false,assets:[{name:'catalogue.v1.json'}]},
      {tag_name:TAG,draft:false,assets:[{name:'catalogue.v1.json',browser_download_url:'https://untrusted.test'}]},
    ]));
    assert.equal(url,URL);return new Response(body);
  });
  assert.equal(result.status,200);
});
test('refuses metadata whose declared version does not match its numbered release',async()=>{
  const result=await handleUpdates({method:'GET'},upstream(()=>new Response(JSON.stringify({schemaVersion:1,releases:[{tag:TAG,versionName:'0.1.0'}]}))));
  assert.equal(result.status,503);
});
test('release discovery accommodates the real GitHub listing while keeping a separate bounded limit',async()=>{
  const releases=JSON.stringify([{tag_name:TAG,draft:false,assets:[{name:'catalogue.v1.json'}],body:'x'.repeat(220*1024)}]);
  const result=await handleUpdates({method:'GET'},async url=>new Response(url===API?releases:body));
  assert.equal(result.status,200);
  const oversized=await handleUpdates({method:'GET'},async()=>new Response('x'.repeat(1024*1024+1)));
  assert.equal(oversized.status,503);
});
