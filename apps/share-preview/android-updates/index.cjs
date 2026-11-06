// Same-origin, read-only metadata bridge. Browser fetches cannot read GitHub
// release downloads directly (CORS); native APK downloads remain direct.
const REPO = 'sheikhti1205/Norfold';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
const VERSION_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_BYTES = 128 * 1024;
const { Buffer } = require('node:buffer');
function compareVersions(a,b) {
  const parts=tag=>{const [main,pre]=tag.slice(1).split('-');return {main:main.split('.').map(Number),pre:pre?.split('.')};};
  const x=parts(a),y=parts(b);
  for(let i=0;i<3;i++)if(x.main[i]!==y.main[i])return x.main[i]-y.main[i];
  if(!x.pre||!y.pre)return !x.pre&&!y.pre?0:!x.pre?1:-1;
  for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++) {
    const l=x.pre[i],r=y.pre[i];if(l===r)continue;
    if(l===undefined||r===undefined)return l===undefined?-1:1;
    const ln=/^\d+$/.test(l),rn=/^\d+$/.test(r);
    if(ln&&rn)return Number(l)-Number(r);
    if(ln!==rn)return ln?-1:1;
    return l<r?-1:1;
  }
  return 0;
}
async function handleUpdates(req, fetchImpl = globalThis.fetch) {
  // Public, credential-free metadata is also read by the bundled Android
  // WebView at https://localhost, not only by the same-origin hosted site.
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  try {
    const request = { signal: globalThis.AbortSignal.timeout(10000), redirect: 'follow' };
    const list = await fetchImpl(RELEASES_URL, request);
    if (!list.ok) throw Error();
    // GitHub includes release notes and every asset; the current real listing
    // already exceeds the much smaller update-catalogue limit.
    const releases = JSON.parse(await boundedText(list, 1024 * 1024));
    if (!Array.isArray(releases)) throw Error();
    // Include real prereleases (GitHub's /latest excludes them), never aliases
    // or drafts. Construct the download URL ourselves, not from asset metadata.
    const release = releases.filter(r => !r.draft && VERSION_TAG.test(r.tag_name)
      && r.assets?.some(a => a.name === 'catalogue.v1.json'))
      .sort((a,b)=>compareVersions(b.tag_name,a.tag_name))[0];
    if (!release) throw Error();
    const url = `https://github.com/${REPO}/releases/download/${release.tag_name}/catalogue.v1.json`;
    const response = await fetchImpl(url, request);
    const body = await boundedText(response);
    const data = JSON.parse(body);
    if (data.schemaVersion !== 1 || !Array.isArray(data.releases)
      || !data.releases.some(r => r.tag === release.tag_name && `v${r.versionName}` === release.tag_name)) throw Error();
    return { status: 200, headers, body: req.method === 'HEAD' ? '' : body };
  } catch {
    // Never fabricate an empty/up-to-date catalogue when publication fails.
    return { status: 503, headers, body: JSON.stringify({ error: 'Updates are temporarily unavailable.' }) };
  }
}
async function boundedText(response, limit = MAX_BYTES) {
    if (!response.ok || Number(response.headers.get('content-length')) > limit) throw Error();
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw Error();
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks).toString('utf8');
}
module.exports = async (context, req) => { context.res = await handleUpdates(req); };
module.exports.handleUpdates = handleUpdates;
