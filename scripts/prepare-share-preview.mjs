// Package the tiny read-only HTTP renderer beside the existing SWA deployment.
// Only PUBLIC configuration is accepted. No credential lookup or SDK startup.
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { colorTokensFor } from '../apps/mobile/src/design/colorSystem.ts';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {validConfig}=createRequire(import.meta.url)('../apps/share-preview/handler.cjs');
export async function prepareSharePreview(out,env=process.env){
 const roles=mode=>Object.entries(colorTokensFor(mode)).map(([k,v])=>`${k}:${v}`).join(';');
 const config={url:env.VITE_SUPABASE_URL?.trim(),key:env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim(),origin:env.VITE_PUBLIC_SHARE_ORIGIN?.trim(),
  css:`:root{${roles('light')}}@media (prefers-color-scheme: dark){:root{${roles('dark')}}}`};
 if(!validConfig(config))throw new Error('Share renderer requires valid non-empty public configuration');
  await mkdir(resolve(out,'share'),{recursive:true});
  await mkdir(resolve(out,'android-updates'),{recursive:true});
  for(const file of ['host.json','package.json','handler.cjs','share/function.json','share/index.cjs'])await cp(resolve(root,'apps/share-preview',file),resolve(out,file));
  for(const file of ['function.json','index.cjs'])await cp(resolve(root,'apps/share-preview/android-updates',file),resolve(out,'android-updates',file));
 await writeFile(resolve(out,'public-config.json'),JSON.stringify(config));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(!process.argv[2])throw new Error('Output directory required');await prepareSharePreview(process.argv[2]);console.log('Share renderer packaged: public config and canonical palette only');}
 catch(error){console.error(error.message);process.exitCode=1;}
}
