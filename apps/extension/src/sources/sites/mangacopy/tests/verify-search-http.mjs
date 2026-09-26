// Run from the repository root. Public source HTTP only; no product API, account or model.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root=process.cwd(), output=path.join(root,'artifacts/mangacopy/search-http');
await mkdir(output,{recursive:true});
const temporary=await mkdtemp(path.join(output,'probe-'));
const {build}=createRequire(path.join(root,'apps/extension/package.json'))('vite');
await build({configFile:false,root:path.join(root,'apps/extension'),logLevel:'error',build:{
  outDir:temporary,emptyOutDir:false,lib:{entry:path.join(root,'apps/extension/src/sources/sites/mangacopy/network.ts'),formats:['es'],fileName:()=> 'network.mjs'},
}});
const {network}=await import(pathToFileURL(path.join(temporary,'network.mjs')).href);
const requests=[];
const context={request:async target=>{
  const url=new URL(target);
  requests.push({origin:url.origin,path:url.pathname});
  const response=await fetch(target,{signal:AbortSignal.timeout(15000)});
  assert(response.ok,'Public source HTTP '+response.status);
  return response.text();
}};
const cases=[{siteId:'mangacopy',query:'海贼王'}, {siteId:'copy4000',query:'海贼王'}, {siteId:'mangacopy',query:'zzzznodelanesearchzzzz',empty:true}], results=[];
for(const {empty,...query} of cases){
  const first=await network.search(query,context);
  assert(first.items.length<=50);
  assert(empty?first.items.length===0:first.items.length>0);
  assert(first.items.every(item=>item.catalogId&&item.title&&item.catalogUrl));
  const second=first.nextCursor?await network.search({...query,cursor:first.nextCursor},context):undefined;
  if(second)assert(second.items.length>0&&second.items.some(item=>!first.items.some(previous=>previous.catalogId===item.catalogId)));
  results.push({site:query.siteId,query:query.query,firstCount:first.items.length,secondCount:second?.items.length??0,
    firstIdentity:first.items[0]?.catalogId,languages:first.items[0]?.contentLanguages,empty:!!empty});
}
const report={results,requests,boundary:'Live public HTTP search and parser only. No browser host-permission prompts, source login, image transfer, import flow, or title-model evaluation.'};
await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
