/* global fetch, URL, AbortSignal, TextDecoder */
// Intentionally no SDK, auth session, cookie forwarding or privileged credential.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = ['Electronics','Bags & Wallets','Keys','Documents & IDs','Books & Stationery','Clothing','Accessories & Jewelry','Other','Phones & Tablets','Computers & Accessories','Audio & Wearables','Cameras & Photography','Watches & Eyewear','Footwear','Personal Care','Tools & Equipment','Office Supplies','Umbrellas & Bottles','Household Items','Sports & Fitness','Toys & Games','Travel & Luggage','Vehicle Accessories','Medical & Health Items','Pet Accessories'];
const ITEM_TITLE = /^(?:(?:Black|White|Blue|Red|Green|Brown|Grey|Gray|Pink|Purple|Yellow|Orange|Silver|Gold) )?(?:Backpack|Wallet|Umbrella|Phone|Tablet|Laptop|Camera|Keys|Watch|Glasses|Bottle|Suitcase|Headphones|Earbuds|Book|Jacket|Helmet)$/i;
function validConfig(c) {
  return c && /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(c.url)
    && /^sb_publishable_[A-Za-z0-9_-]+$/.test(c.key)
    && c.origin === 'https://findbackapp.social' && typeof c.css === 'string';
}
function validPreview(p, id) {
  return p && Object.keys(p).sort().join(',') === 'category,event_month,excerpt,id,title,type'
    && p.id === id && ['LOST','FOUND'].includes(p.type) && CATEGORIES.includes(p.category)
    && (p.title === p.category || (typeof p.title === 'string' && ITEM_TITLE.test(p.title)))
    && (p.event_month === null || /^\d{4}-(0[1-9]|1[0-2])$/.test(p.event_month))
    && p.excerpt === `A ${p.type.toLowerCase()} item report. Sign in to compare the details and contact the person who posted it.`;
}
function escape(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function monthLabel(value) {
  if(!value)return '';
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[Number(value.slice(5))-1]} ${value.slice(0,4)}`;
}
const PAGE_CSS = `*{box-sizing:border-box}
body{margin:0;background:var(--fb-surface);color:var(--fb-on-surface);font:1rem/1.6 system-ui,sans-serif}
main{max-width:38rem;margin:auto;padding:min(5vw,2.5rem);overflow-wrap:anywhere}
header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:3rem}
a{color:var(--fb-on-surface)}header a{min-height:44px;display:inline-flex;align-items:center}
.brand{font-size:1.4rem;font-weight:700;text-decoration:none;letter-spacing:-.04em;white-space:nowrap}
h1{font-size:clamp(2rem,7vw,3rem);line-height:1.15;letter-spacing:-.04em;margin:1rem 0}
p{color:var(--fb-on-surface-variant)}.chip{display:inline-block;border-radius:2rem;padding:.25rem .65rem;font-size:.8rem;font-weight:650}
.LOST{color:var(--fb-lost-ink);background:var(--fb-lost-bg)}.FOUND{color:var(--fb-found-ink);background:var(--fb-found-bg)}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin:2rem 0}.actions a{display:inline-flex;min-height:48px;align-items:center;justify-content:center;text-align:center;padding:.7rem 1.1rem;border-radius:2rem;max-width:100%}
.primary{background:var(--fb-primary);color:var(--fb-on-primary);text-decoration:none;font-weight:600}.secondary{border:1px solid var(--fb-outline)}
a:focus-visible{outline:2px solid var(--fb-focus);outline-offset:4px}.note{font-size:.875rem;padding-top:1rem;border-top:1px solid var(--fb-outline-variant)}`;
function html(p, status, config, id) {
  const origin = config?.origin === 'https://findbackapp.social' ? config.origin : 'https://findbackapp.social';
  const title = p?.title ?? (status === 503 ? "Couldn't load this report" : 'This report is no longer available');
  const description = p?.excerpt ?? (status === 503 ? 'Please try again shortly.' : 'The link may have been withdrawn, or the report is no longer shared.');
  const canonical = `${origin}${UUID.test(id) ? `/api/share/${id}` : ''}`;
  const content = p ? `<span class="chip ${p.type}">${p.type}</span><h1>${escape(title)}</h1><p>${escape(p.category)}${p.event_month ? ` · ${escape(monthLabel(p.event_month))}` : ''}</p><p>${escape(description)}</p><div class="actions"><a class="primary" href="/#/shared/${id}?contact=1">Sign in to contact</a><a class="secondary" href="${origin}/r/${id}">Open in Norfold</a></div><p class="note">Sign in for the full description, photos and contact options.</p>`
    : `<h1>${escape(title)}</h1><p>${escape(description)}</p><div class="actions"><a class="primary" href="/">Back to Norfold</a></div>`;
  const brandMeta = '<link rel="icon" type="image/png" sizes="16x16" href="/icons/findback-birdleaf-v1-16.png"><link rel="icon" type="image/png" sizes="32x32" href="/icons/findback-birdleaf-v1-32.png"><meta property="og:image" content="https://findbackapp.social/icons/findback-birdleaf-v1-512.png"><meta property="og:image:alt" content="Norfold"><meta name="twitter:image" content="https://findbackapp.social/icons/findback-birdleaf-v1-512.png">';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escape(title)} · Norfold</title>${brandMeta}<link rel="canonical" href="${canonical}"><meta property="og:type" content="website"><meta property="og:site_name" content="Norfold"><meta property="og:title" content="${escape(title)} · Norfold"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${canonical}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${escape(title)} · Norfold"><meta name="twitter:description" content="${escape(description)}"><style>${config?.css ?? ''}\n${PAGE_CSS}</style></head><body><main><header><a class="brand" href="/">Norfold.</a><a href="/#/signin">Sign in</a></header>${content}</main></body></html>`;
}
async function readBounded(response) {
  if(!response.body)throw new Error('No body');
  const reader=response.body.getReader();let length=0,text='';const decoder=new TextDecoder();
  try { for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>8192)throw new Error('Oversize');text+=decoder.decode(value,{stream:true});}return JSON.parse(text+decoder.decode()); }
  finally { await reader.cancel().catch(()=>{}); }
}
async function handleShare(req, config, http = fetch) {
  let status=200,p=null,json=false;const id=req.params?.id ?? '';
  const headers = { 'Cache-Control':'no-store, max-age=0', 'X-Robots-Tag':'noindex, nofollow', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
  try {
    const url=new URL(req.url);
    json=url.searchParams.get('format')==='json';
    if(!['GET','HEAD'].includes(req.method?.toUpperCase()))status=405;
    else if(!UUID.test(id) || url.pathname!==`/api/share/${id}`)status=404;
    else if([...url.searchParams.keys()].some(k=>!['format','focus','comment'].includes(k)||url.searchParams.getAll(k).length!==1)
      || (url.searchParams.has('format') && !json)
      || (url.searchParams.has('focus') && !['comments','activity','manage'].includes(url.searchParams.get('focus')))
      || (url.searchParams.has('comment') && (!UUID.test(url.searchParams.get('comment'))||url.searchParams.get('focus')!=='comments')))status=400;
    else if(!validConfig(config))status=503;
    else {
      const response=await http(`${config.url}/rest/v1/rpc/findback_shared_report_preview`,{
        method:'POST',headers:{apikey:config.key,'Content-Type':'application/json'},
        body:JSON.stringify({p_post_id:id}),signal:AbortSignal.timeout(6000),redirect:'error',cache:'no-store',
      });
      if(!response.ok)throw new Error('Upstream unavailable');
      const rows=await readBounded(response);
      if(!Array.isArray(rows)||rows.length>1||(rows.length && !validPreview(rows[0],id)))throw new Error('Unsafe projection');
      p=rows[0]??null;if(!p)status=404;
    }
  } catch { status=503;p=null; }
  headers['Content-Type']=json?'application/json; charset=utf-8':'text/html; charset=utf-8';
  if(status===405)headers.Allow='GET, HEAD';
  return {status,headers,body:req.method?.toUpperCase()==='HEAD'?'':json?JSON.stringify(p):html(p,status,config,id)};
}
module.exports={handleShare, validConfig};
