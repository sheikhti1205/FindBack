/* global DOMException */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { handleShare } = require('../apps/share-preview/handler.cjs');
const id = '5b6f7c8d-1234-4abc-8def-123456789012';
const config = { url: 'https://project.supabase.co', key: 'sb_publishable_fixture', origin: 'https://findbackapp.social', css: '' };
const preview = { id, type: 'FOUND', title: 'Black backpack', category: 'Bags & Wallets', event_month: '2026-11', excerpt: 'A found item report. Sign in to compare the details and contact the person who posted it.' };
const request = (query = '') => ({ method: 'GET', url: `${config.origin}/api/share/${id}${query}`, params: { id }, headers: { authorization: 'Bearer visitor-token', cookie: 'session=private' } });
function network(data = [preview]) { const calls = []; return { calls, fetch: async (url, init) => { calls.push({url, init}); return new Response(JSON.stringify(data), { headers: {'Content-Type':'application/json'} }); } }; }
test('HTML and JSON use only the same safe projection; no visitor credentials reach Supabase', async () => {
  const net = network(); const html = await handleShare(request(), config, net.fetch);
  assert.equal(html.status, 200); assert.match(html.headers['Content-Type'], /text\/html/);
  assert.match(html.body, /Black backpack/); assert.match(html.body, /property="og:title" content="Black backpack/);
  assert.match(html.body, /Sign in to contact/); assert.match(html.body, new RegExp(`/r/${id}`));
  assert.match(html.body, /November 2026/);
  assert.match(html.body, /rel="icon"[^>]*findback-birdleaf-v1-32\.png/);
  assert.match(html.body, /property="og:image" content="https:\/\/findbackapp.social\/icons\/findback-birdleaf-v1-512\.png"/);
  assert.doesNotMatch(html.body, /<img[^>]*supabase|og:image[^>]*supabase/);
  const json = await handleShare(request('?format=json'), config, net.fetch);
  assert.deepEqual(JSON.parse(json.body), preview);
  for (const c of net.calls) {
    assert.equal(c.url, `${config.url}/rest/v1/rpc/findback_shared_report_preview`);
    assert.deepEqual(JSON.parse(c.init.body), {p_post_id:id});
    assert.equal(c.init.headers.apikey, config.key);
    assert.equal(c.init.headers.Authorization, undefined); assert.equal(c.init.headers.cookie, undefined);
  }
  for (const res of [html,json]) { assert.match(res.headers['Cache-Control'], /no-store/); assert.equal(res.headers['X-Robots-Tag'],'noindex, nofollow'); }
});
test('unavailable/revoked/deleted/hidden report is neutral HTML or JSON null with no stale details', async () => {
  for (const query of ['', '?format=json']) {
    const res = await handleShare(request(query), config, network([]).fetch);
    assert.equal(res.status,404); assert.doesNotMatch(res.body,/Black backpack|Bags &amp; Wallets/);
    assert.match(res.headers['Cache-Control'],/no-store/);
    if(query)assert.equal(JSON.parse(res.body),null);else assert.match(res.body,/no longer available/);
  }
});
test('a backend outage cannot masquerade as a deleted report or leak upstream error contents', async () => {
  const res = await handleShare(request(),config,async()=>new Response('private upstream diagnostic',{status:503}));
  assert.equal(res.status,503); assert.doesNotMatch(res.body,/private upstream diagnostic|Black backpack/);
});
test('invalid IDs/methods/queries never query the backend or reflect input', async () => {
  for (const r of [{...request(),params:{id:'<script>oops</script>'}}, {...request(),method:'POST'}, request('?next=https://evil.test'), request('?format=json&format=html')]) {
    const net = network(); const res = await handleShare(r,config,net.fetch);
    assert.ok([400,404,405].includes(res.status)); assert.equal(net.calls.length,0); assert.doesNotMatch(res.body,/<script>|evil\.test/);
  }
});
test('schema drift/extra private columns and arbitrary strings fail closed, even from upstream', async () => {
  for(const data of [[{...preview,email:'private@example.invalid'}],[{...preview,title:'Call +15551234567'}],[{...preview,category:'<script>x</script>'}],[{...preview,event_month:'2026-11-01'}],[preview,preview],{data:preview}]){
    const res=await handleShare(request(),config,network(data).fetch);
    assert.equal(res.status,503); assert.doesNotMatch(res.body,/private@example|15551234567|<script>/);
  }
});
test('HTML escaping, canonical URLs and CSP cannot be influenced by request host/query/header', async () => {
  const res=await handleShare({...request(),url:`https://evil.test/api/share/${id}?focus=comments&comment=${id}`},config,network().fetch);
  assert.match(res.body,/Bags &amp; Wallets/);assert.doesNotMatch(res.body,/evil\.test|visitor-token|session=private/);
  assert.match(res.body,new RegExp(`https://findbackapp.social/api/share/${id}`));
  assert.match(res.headers['Content-Security-Policy'],/default-src 'none'/);
});
test('invalid/private server configuration refuses to fetch',async()=>{
  for(const bad of [{...config,key:['sb','secret','never-use'].join('_')},{...config,url:'http://127.0.0.1'},{...config,origin:'https://evil.test/path'},{...config,key:''}]){
    const net=network();const res=await handleShare(request(),bad,net.fetch);assert.equal(res.status,503);assert.equal(net.calls.length,0);
  }
});
test('timeout, oversized and malformed responses fail closed; HEAD carries metadata headers without a body',async()=>{
 for(const http of [async()=>{throw new DOMException('timeout','TimeoutError');},async()=>new Response('x'.repeat(9000)),async()=>new Response('{')]){
  const res=await handleShare(request('?format=json'),config,http);assert.equal(res.status,503);assert.equal(JSON.parse(res.body),null);assert.match(res.headers['Cache-Control'],/no-store/);
 }
 const res=await handleShare({...request(),method:'HEAD'},config,network().fetch);
 assert.equal(res.status,200);assert.equal(res.body,'');assert.match(res.headers['Content-Type'],/text\/html/);
});
