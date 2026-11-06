import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { handleUpdates } = createRequire(import.meta.url)('../apps/share-preview/android-updates/index.cjs');
test('proxies only fixed public metadata with no-store, never a caller URL', async () => {
  const result = await handleUpdates({ method:'GET', query:{url:'https://untrusted.test'} }, async url => {
    assert.equal(url,'https://github.com/sheikhti1205/Norfold/releases/download/android-latest/catalogue.v1.json');
    return new Response(JSON.stringify({schemaVersion:1,releases:[]}));
  });
  assert.equal(result.status,200);
  assert.equal(result.headers['Cache-Control'],'no-store');
});
test('a missing/bad/unavailable release is a failure, not an empty catalogue', async () => {
  for(const response of [new Response('',{status:404}),new Response('not json'),new Response('{"releases":[]}'),new Response('x'.repeat(128*1024+1))]) {
    const result = await handleUpdates({method:'GET'},async()=>response);
    assert.equal(result.status,503);
  }
});
test('HEAD carries no metadata body',async()=>{
  const result=await handleUpdates({method:'HEAD'},async()=>new Response('{"schemaVersion":1,"releases":[]}'));
  assert.equal(result.status,200);assert.equal(result.body,'');
});
test('public metadata is readable from the Android WebView origin, including failure responses',async()=>{
  for (const status of [200,503]) {
    const result=await handleUpdates({method:'GET',headers:{origin:'https://localhost'}},async()=>new Response('{"schemaVersion":1,"releases":[]}',{status}));
    assert.equal(result.status,status);
    assert.equal(result.headers['Access-Control-Allow-Origin'],'*');
    assert.equal(result.headers['Access-Control-Allow-Credentials'],undefined);
  }
});
