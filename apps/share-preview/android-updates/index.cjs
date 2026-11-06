// Same-origin, read-only metadata bridge. Browser fetches cannot read GitHub
// release downloads directly (CORS); native APK downloads remain direct.
const URL = 'https://github.com/sheikhti1205/Norfold/releases/download/android-latest/catalogue.v1.json';
const MAX_BYTES = 128 * 1024;
const { Buffer } = require('node:buffer');
async function handleUpdates(req, fetchImpl = globalThis.fetch) {
  // Public, credential-free metadata is also read by the bundled Android
  // WebView at https://localhost, not only by the same-origin hosted site.
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  try {
    const response = await fetchImpl(URL, { signal: globalThis.AbortSignal.timeout(10000), redirect: 'follow' });
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) throw Error();
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw Error();
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    const body = Buffer.concat(chunks).toString('utf8');
    const data = JSON.parse(body);
    if (data.schemaVersion !== 1 || !Array.isArray(data.releases)) throw Error();
    return { status: 200, headers, body: req.method === 'HEAD' ? '' : body };
  } catch {
    // Never fabricate an empty/up-to-date catalogue when publication fails.
    return { status: 503, headers, body: JSON.stringify({ error: 'Updates are temporarily unavailable.' }) };
  }
}
module.exports = async (context, req) => { context.res = await handleUpdates(req); };
module.exports.handleUpdates = handleUpdates;
