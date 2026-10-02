// Live integration against the official Komga demo. No OPDS routes or responses are mocked.
// Public demo account documented at https://komga.org/docs/introduction/.
// Uses an isolated unpacked-extension profile; never writes server progress or calls translation.
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd(),out=path.join(root,'artifacts/opds-live');await mkdir(out,{recursive:true});
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const extension=await mkdtemp(path.join(out,'extension-')),profile=await mkdtemp(path.join(out,'profile-'));
await cp(process.env.TEST_EXTENSION_DIR||path.join(root,'apps/extension/.output/chrome-mv3'),extension,{recursive:true});
const src=path.join(root,'apps/extension/src').replaceAll('\\','/'),entry=path.join(extension,'opds-probe-entry.js');
await writeFile(entry,`
import {installFileSources} from '${src}/comics/sources/install.ts';installFileSources();
export * from '${src}/comics/application/remote-library-service.ts';
export * from '${src}/comics/application/source-lifecycle.ts';
export {catalog} from '${src}/comics/repositories/index.ts';
export {loadEntry,saveReaderState} from '${src}/comics/application/library-service.ts';
export {acquirePage} from '${src}/comics/pages/service.ts';
export {pageRenderProfile} from '${src}/comics/pages/identity.ts';
export {queueDownloads,runDownloads,listDownloads} from '${src}/comics/acquisition/index.ts';
export {downloadStore} from '${src}/storage/downloads/index.ts';
export {sourcePageCache} from '${src}/storage/source-pages/index.ts';
export {prepareEntryContent} from '${src}/comics/application/entry-content.ts';
export {requireSourceDriver} from '${src}/comics/sources/registry.ts';
export {queueRemoteFileDownload,runRemoteFileDownloadCycle,listRemoteFileDownloads,prepareRemoteFileDownload,clearRemoteFileDownload} from '${src}/comics/acquisition/files.ts';
`);
await writeFile(path.join(extension,'opds-probe.html'),'<!doctype html><html><head><meta charset="utf-8"><title>Live OPDS integration</title></head><body>Live OPDS integration</body></html>');
const {build}=createRequire(path.join(root,'apps/extension/package.json'))('vite');
await build({configFile:false,root:path.join(root,'apps/extension'),logLevel:'error',build:{outDir:extension,emptyOutDir:false,lib:{entry,formats:['es'],fileName:()=> 'opds-probe.js'}}});
const context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:process.env.TEST_CHROMIUM,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
const origin=process.env.OPDS_TEST_ORIGIN||'https://demo.komga.org';
const credentials={username:process.env.OPDS_TEST_USERNAME||'demo@komga.org',password:process.env.OPDS_TEST_PASSWORD||'komga-demo'};
const report={server:new URL(origin).origin,scope:'Live OPDS 1.2/2.0 in isolated Chromium MV3. No mock responses, progress writes, translation or user profile.',results:[],requests:0,writeRequests:0};
let online=true;
// Abort unrelated product traffic. The OPDS server itself is always a real HTTPS server.
await context.route('https://**/*',route=>{
  if(new URL(route.request().url()).origin!==new URL(origin).origin||!online)return route.abort();
  report.requests++;if(!['GET','HEAD'].includes(route.request().method())){report.writeRequests++;return route.abort();}
  return route.continue();
});
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(new URL('opds-probe.html',worker.url()).href);
  async function probe(operation,args={}){
    return page.evaluate(async({operation,args})=>{
      const api=await import(chrome.runtime.getURL('opds-probe.js'));
      const assert=(condition,label)=>{if(!condition)throw Error(label);};
      if(operation==='initialize'){await api.initializeSources();return true;}
      if(operation==='connect'){
        const started=performance.now(),connection=await api.connectRemoteLibrary('opds',args.values,args.existingId);
        return {id:connection.id,milliseconds:Math.round(performance.now()-started)};
      }
      if(operation==='invalid-auth'){
        try{await api.connectRemoteLibrary('opds',args.values);return {rejected:false};}catch(error){return {rejected:true,sanitized:!String(error.message).includes(args.values.password)&&!String(error.message).includes(args.values.username)};}
      }
      if(operation==='discover'){
        const started=performance.now(),initial=await api.catalog.list('comics',{limit:100}),pending=[undefined],seen=new Set();let feeds=0,publication;
        while(pending.length&&feeds<12&&!publication){
          const location=pending.shift();if(seen.has(location))continue;seen.add(location);
          const result=await api.browseRemoteLibrary(args.connectionId,{location});feeds++;
          const publications=[...result.publications,...(result.groups??[]).flatMap(group=>group.publications)];
          publication=publications.find(item=>item.readable!==false);
          const links=[...result.navigation,...(result.groups??[]).flatMap(group=>group.navigation)].sort((a,b)=>Number(/latest|recent.*book|all books/i.test(b.title))-Number(/latest|recent.*book|all books/i.test(a.title)));
          for(const link of links.slice(0,5))if(!seen.has(link.location))pending.push(link.location);
        }
        assert(publication,'No readable publication found within bounded live catalog traversal');
        assert((await api.catalog.list('comics',{limit:100})).length===initial.length,'Browsing imported the remote library');
        let cover;if(publication.artwork){const blob=await api.readRemoteArtwork(args.connectionId,publication.artwork);const bitmap=await createImageBitmap(blob);cover={bytes:blob.size,width:bitmap.width,height:bitmap.height};bitmap.close();}
        return {publicationId:publication.id,feeds,cover,milliseconds:Math.round(performance.now()-started)};
      }
      if(operation==='open'){
        const started=performance.now(),result=await api.openRemotePublication(args.connectionId,args.publicationId);
        assert(result.kind==='opened','Live sample requires a complete file; select a streamable demo sample');
        const entry=await api.catalog.get('entries',result.entryId),pages=await api.catalog.listPages(entry.contentId,{limit:1500});
        const lease=await api.acquirePage({entryId:entry.id,contentId:entry.contentId,pageId:pages[0].pageId,renderProfileId:api.pageRenderProfile(entry.format),purpose:'reading'});
        const firstPage={bytes:lease.blob.size,width:lease.identity.width,height:lease.identity.height,sha256:lease.identity.imageSha256};lease.release();
        const repeated=await api.openRemotePublication(args.connectionId,args.publicationId);assert(repeated.kind==='opened'&&repeated.entryId===entry.id&&!repeated.created,'Repeat opening duplicated a comic');
        const reading=await api.loadEntry(entry.id);
        if(args.expectedPosition)assert(reading.pageId===args.expectedPosition&&reading.relativeOffset===.25,'Reconnection changed the saved reading position');
        reading.pageId=reading.pages[Math.min(2,reading.pages.length-1)].id;reading.relativeOffset=.25;reading.lastReadAt=Date.now();await api.saveReaderState(reading);
        const resumed=await api.loadEntry(entry.id);assert(resumed.pageId===reading.pageId&&resumed.relativeOffset===.25,'Reading position did not persist');
        return {entryId:entry.id,comicId:entry.comicId,format:entry.format,pages:pages.length,firstPage,position:resumed.pageId,milliseconds:Math.round(performance.now()-started)};
      }
      if(operation==='cache'){
        const started=performance.now(),before=await api.catalog.get('positions',args.entryId);
        await api.queueDownloads([args.entryId]);await api.runDownloads();
        const task=(await api.listDownloads()).find(item=>item.entryId===args.entryId);
        assert(task?.status==='complete','Live page download did not complete: '+task?.error);
        const after=await api.catalog.get('positions',args.entryId);assert(JSON.stringify(after)===JSON.stringify(before),'Downloading changed reading position');
        await api.sourcePageCache.clear();
        return {pages:task.completed,bytes:task.bytes,milliseconds:Math.round(performance.now()-started)};
      }
      if(operation==='read-offline'){
        const entry=await api.catalog.get('entries',args.entryId),pages=await api.catalog.listPages(entry.contentId,{limit:1500});
        const lease=await api.acquirePage({entryId:entry.id,contentId:entry.contentId,pageId:pages.at(-1).pageId,renderProfileId:api.pageRenderProfile(entry.format)});
        const result={bytes:lease.blob.size,width:lease.identity.width,height:lease.identity.height};lease.release();return result;
      }
      if(operation==='disconnect'){await api.disconnectSource(args.connectionId);return true;}
      if(operation==='read-rejected'){
        try{const entry=await api.catalog.get('entries',args.entryId),[page]=await api.catalog.listPages(entry.contentId,{limit:1});const lease=await api.acquirePage({entryId:entry.id,contentId:entry.contentId,pageId:page.pageId,renderProfileId:api.pageRenderProfile(entry.format)});lease.release();return false;}catch{return true;}
      }
      if(operation==='file'){
        // Use a second untouched publication, not an alternate representation of the opened page sequence.
        const catalog=await api.browseRemoteLibrary(args.connectionId),pubs=[...catalog.publications,...(catalog.groups??[]).flatMap(group=>group.publications)];
        const publication=pubs.find(pub=>pub.id!==args.excludeId&&pub.formats?.length);
        assert(publication,'No second downloadable publication available in live catalog');
        const connection=await api.catalog.get('connections',args.connectionId);
        const planResult=await api.requireSourceDriver(connection.provider).catalog.resolve(connection,publication.id,{purpose:'download'});
        const intent=await api.queueRemoteFileDownload(args.connectionId,planResult,{confirmed:true});
        await api.runRemoteFileDownloadCycle(new AbortController().signal,'live-opds-probe');
        const completed=(await api.listRemoteFileDownloads()).find(item=>item.intent.id===intent.id)?.intent;
        assert(completed?.status==='complete','Live complete file failed: '+completed?.error);
        const entry=await api.catalog.get('entries',completed.entryId);assert(!!entry.containerId,'Complete file is not locally retained');
        return {entryId:entry.id,comicId:entry.comicId,bytes:completed.bytes,pages:entry.pageCount,format:entry.format,intentId:intent.id};
      }
      throw Error('Unknown live operation');
    },{operation,args});
  }
  await probe('initialize');
  const invalid=await probe('invalid-auth',{values:{name:'Invalid live authorization',url:origin+'/opds/v2/catalog',auth:'basic',username:credentials.username,password:'invalid-live-probe'}});
  assert(invalid.rejected&&invalid.sanitized);report.results.push({check:'invalid-auth',...invalid});
  for(const version of ['v2','v1.2']){
    const values={name:`Live Komga ${version}`,url:origin+`/opds/${version}/catalog`,auth:'basic',...credentials};
    const connection=await probe('connect',{values});
    const discovered=await probe('discover',{connectionId:connection.id});
    const opened=await probe('open',{connectionId:connection.id,publicationId:discovered.publicationId});
    report.results.push({check:version,connect:connection.milliseconds,discovery:discovered,reading:opened});
    console.log(JSON.stringify({check:version,pages:opened.pages,format:opened.format,firstPage:opened.firstPage,connectMs:connection.milliseconds,discoveryMs:discovered.milliseconds,openMs:opened.milliseconds}));
    if(version==='v2'){
      const cached=await probe('cache',{entryId:opened.entryId});report.results.push({check:'live-whole-comic-cache',...cached});
      online=false;const offline=await probe('read-offline',{entryId:opened.entryId});online=true;report.results.push({check:'offline-after-clearing-ordinary-cache',...offline});
      await probe('disconnect',{connectionId:connection.id});assert(await probe('read-rejected',{entryId:opened.entryId}),'Disconnected original page remained accessible');
      await probe('connect',{values,existingId:connection.id});
      await probe('discover',{connectionId:connection.id});
      const reopened=await probe('open',{connectionId:connection.id,publicationId:discovered.publicationId,expectedPosition:opened.position});assert.equal(reopened.entryId,opened.entryId);report.results.push({check:'reconnect-retains-comic-and-position',entryId:opened.entryId});
      const file=await probe('file',{connectionId:connection.id,excludeId:discovered.publicationId});report.results.push({check:'live-complete-file',...file});
      await page.evaluate(async()=>{const api=await import(chrome.runtime.getURL('opds-probe.js'));await api.sourcePageCache.clear();});
      online=false;const fileOffline=await probe('read-offline',{entryId:file.entryId});online=true;report.results.push({check:'complete-file-offline',...fileOffline});
    }
  }
  assert.equal(report.writeRequests,0,'The integration attempted an OPDS server write');
  report.passed=true;
}catch(error){report.passed=false;report.error=error.message;throw error;}
finally{await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await context.close();}
console.log(JSON.stringify({passed:report.passed,checks:report.results.length,requests:report.requests,writeRequests:report.writeRequests,report:path.join(out,'report.json')}));
