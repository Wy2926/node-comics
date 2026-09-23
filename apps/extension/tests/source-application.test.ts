import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {catalog} from '../src/comics/repositories';
import {importSourceFiles,reindexEntry} from '../src/comics/application/import-service';
import {removeComic,removeComics} from '../src/comics/application/library-service';
import {disconnectSource,initializeSources,invalidateSourceAccess,reconnectSource} from '../src/comics/application/source-lifecycle';
import {chooseSourceFiles,connectionCapabilities,listSourceAccounts,subscribeSourceAccounts,sourceImportOptions} from '../src/comics/application/source-service';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {openFileSource} from '../src/comics/sources/runtime';
import type {OpenFileSourceContext,SelectedSourceFile,SourceAccessChange,SourceAccount,SourceSelection} from '../src/comics/sources/contracts';
import {sourcePageCache} from '../src/storage/source-pages';
const format=vi.hoisted(()=>({index:vi.fn(),close:vi.fn()}));
vi.mock('../src/comics/formats',()=>({openDocument:async()=>({index:format.index,close:format.close})}));
const select=vi.fn(),disconnect=vi.fn(),close=vi.fn();let open=vi.fn(),disposers:(()=>void)[]=[],changed:((change:SourceAccessChange)=>Promise<void>)|undefined;
const file=(id:string=crypto.randomUUID(),version='one'):SelectedSourceFile=>({id,name:id+'.cbz',format:'cbz',locator:{opaqueResource:id},snapshot:{opaqueResource:id,version,size:16}});
const selection=():SourceSelection=>({connection:{id:'opaque-'+crypto.randomUUID(),provider:'fixture-cloud',accountId:crypto.randomUUID(),displayName:'Private account'},files:[file()]});
const importIds=async(value:SourceSelection)=>{const result=await importSourceFiles(value);expect(result.failures).toEqual([]);return result.results.map(item=>item.id);};
async function record(id:string){const entry=(await catalog.get('entries',id))!,comic=(await catalog.get('comics',entry.comicId))!;return {entry,comic,source:comic.source,connection:(await catalog.get('connections',comic.source.connectionId))!,entryId:id,contentId:entry.contentId,sourceSnapshot:entry.sourceSnapshot,format:entry.format};}
beforeEach(()=>{
 format.index.mockReset().mockResolvedValue([{ordinal:0,name:'page.png',locator:{entry:0}}]);format.close.mockReset().mockResolvedValue(undefined);close.mockReset().mockResolvedValue(undefined);select.mockReset();disconnect.mockReset().mockResolvedValue(undefined);
 open=vi.fn(async(context:OpenFileSourceContext)=>({snapshot:{identity:context.source.providerItemId,version:String(context.sourceSnapshot?.version),size:16,local:false},readAt:async(_o:number,length:number)=>new Uint8Array(length),validate:async()=>'unchanged' as const,close}));
 disposers=[registerSourceDriver({id:'fixture-cloud',label:'Fixture cloud',cachePages:true,cacheRanges:false,open,select,disconnect,subscribe(listener){changed=listener;return()=>{changed=undefined;};}})];
});
afterEach(()=>{for(const dispose of disposers)dispose();vi.restoreAllMocks();});
describe('single-source files and access lifecycle',()=>{
 it('offers registered selectable providers and rejects unconfigured or mismatched selection',async()=>{
  disposers.push(registerSourceDriver({id:'disabled',label:'Disabled',cachePages:false,cacheRanges:false,open,select,isConfigured:()=>false}));expect(sourceImportOptions()).toContainEqual({id:'fixture-cloud',label:'Fixture cloud',configured:true});await expect(chooseSourceFiles('disabled')).rejects.toThrow('尚未配置');
  const selected=selection();select.mockResolvedValue(selected);expect(await chooseSourceFiles('fixture-cloud')).toEqual(selected);select.mockResolvedValue({...selected,connection:{...selected.connection,provider:'wrong'}});await expect(chooseSourceFiles('fixture-cloud')).rejects.toThrow('身份');
 });
 it('imports opaque metadata without leaking account labels and keeps a single current source',async()=>{
  const selected=selection(),[id]=await importIds(selected),saved=await record(id);expect(saved.source.providerItemId).toBe(selected.files[0].id);expect(saved.sourceSnapshot).toEqual(selected.files[0].snapshot);expect(saved.comic.sourceName).toBe('Fixture cloud');expect(saved.entry.indexState).toBe('ready');expect(saved.entry).not.toHaveProperty('sourceBindingId');expect(await importIds(selected)).toEqual([id]);
 });
 it('leaves no comic on a failed index and retries independently of successful files',async()=>{
  const selected=selection();selected.files.push(file());format.index.mockRejectedValueOnce(Error('temporary failure'));const result=await importSourceFiles(selected);expect(result.results).toHaveLength(1);expect(result.failures).toEqual([{name:selected.files[0].name,error:'temporary failure'}]);expect(await importIds(selected)).toHaveLength(2);
 });
 it('updates the same cloud resource in place and discards its old page identities and position',async()=>{
  const selected=selection(),[id]=await importIds(selected),old=await record(id),[page]=await catalog.listPages(old.contentId);await catalog.savePosition({id,entryId:id,comicId:old.comic.id,contentId:old.contentId,pageId:page.pageId,relativeOffset:.5,updatedAt:1});
  const [newId]=await importIds({...selected,files:[file(selected.files[0].id,'two')]}),current=await record(newId);expect(newId).toBe(id);expect(current.contentId).not.toBe(old.contentId);expect(await catalog.listPages(old.contentId)).toEqual([]);expect(await catalog.listEntries(old.comic.id)).toHaveLength(1);expect(await catalog.get('positions',id)).toMatchObject({contentId:current.contentId,relativeOffset:0});
 });
 it('never merges identically named resources or the same file ID in different accounts',async()=>{
  const selected=selection(),other=selection();other.files=selected.files;const [a]=await importIds(selected),[b]=await importIds(other);expect((await record(a)).comic.id).not.toBe((await record(b)).comic.id);
 });
 it('serializes duplicate imports from concurrent callers',async()=>{const selected=selection(),[a,b]=await Promise.all([importIds(selected),importIds(selected)]);expect(a).toEqual(b);});
 it.each(['disconnected','revoked'] as const)('restores a %s source only within its connection and keeps other revoked files blocked',async status=>{
  const selected=selection();selected.files.push(file());const ids=await importIds(selected),token=await sourcePageCache.token(ids[0]);await invalidateSourceAccess({connectionId:selected.connection.id,itemId:selected.files[1].id});
  if(status==='disconnected')await disconnectSource(selected.connection.id);else await invalidateSourceAccess({connectionId:selected.connection.id,itemId:selected.files[0].id});await expect(reindexEntry(ids[0])).rejects.toThrow('已断开');
  expect(await importIds({...selected,files:[selected.files[0]]})).toEqual([ids[0]]);expect((await record(ids[0])).source.status).toBe('active');expect((await record(ids[1])).source.status).toBe('revoked');
  expect(await sourcePageCache.put('late:'+ids[0],new Blob(['late']),{owner:ids[0],token})).toBe(false);expect(await sourcePageCache.put('current:'+ids[0],new Blob(['current']),{owner:ids[0],token:await sourcePageCache.token(ids[0])})).toBe(true);
 });
 it('reconnects through the same verified account and keeps revoked files unavailable without selection',async()=>{
  const selected=selection(),[id]=await importIds(selected);await invalidateSourceAccess({connectionId:selected.connection.id,itemId:selected.files[0].id});await disconnectSource(selected.connection.id);select.mockResolvedValue({...selected,files:[]});await reconnectSource(selected.connection.id);expect((await record(id)).source.status).toBe('revoked');select.mockResolvedValue(selected);await reconnectSource(selected.connection.id);expect((await record(id)).source.status).toBe('active');select.mockResolvedValue({...selected,connection:{...selected.connection,id:'different'}});await expect(reconnectSource(selected.connection.id)).rejects.toThrow('原连接');
 });
 it('closes in-flight leases and blocks stale cache writers on provider revocation',async()=>{
  const selected=selection(),[id]=await importIds(selected),saved=await record(id);await initializeSources();const source=await openFileSource(saved),token=await sourcePageCache.token(id);await sourcePageCache.put(id,new Blob(['cached']),{owner:id,token});await changed!({connectionId:saved.connection.id,itemId:saved.source.providerItemId});expect(await sourcePageCache.get(id)).toBeUndefined();await expect(source.readAt(0,1)).rejects.toThrow('来源已关闭');const generation=(await record(id)).entry.generation;await changed!({connectionId:saved.connection.id,itemId:saved.source.providerItemId});expect((await record(id)).entry.generation).toBe(generation);await source.close();
 });
 it('does not resurrect a comic after deletion during reindexing',async()=>{
  const [id]=await importIds(selection()),saved=await record(id),started=Promise.withResolvers<void>(),pending=Promise.withResolvers<[]>();format.index.mockImplementationOnce(()=>{started.resolve();return pending.promise;});const running=reindexEntry(id);const rejected=expect(running).rejects.toThrow();await started.promise;await removeComic(saved.comic.id);pending.resolve([]);await rejected;expect(await catalog.get('entries',id)).toBeUndefined();
 });
 it('rejects images and unregistered sources before publishing a comic',async()=>{
  const selected=selection();const bad={...selected,files:[{...selected.files[0],format:'image'}]} as unknown as SourceSelection;await expect(importSourceFiles(bad)).rejects.toThrow('不支持图片');const result=await importSourceFiles({...selected,connection:{...selected.connection,provider:'unregistered'}});expect(result.results).toEqual([]);expect(result.failures[0].error).toContain('来源未启用');expect(open).not.toHaveBeenCalled();
 });
 it('reports source capabilities from its driver registry',async()=>{const selected=selection();await importIds(selected);expect((await listSourceAccounts()).accounts.find(c=>c.id===selected.connection.id)).toMatchObject({providerLabel:'Fixture cloud',canReconnect:true,canDisconnect:true});});
 it('shows a new provider account through registration and refreshes metadata without changing source generations',async()=>{
  const describeAccount=vi.fn((connection:SourceAccount)=>[{id:'workspace',label:'Workspace',value:connection.accountMetadata?.workspace??'Unavailable'}]);
  disposers.push(registerSourceDriver({id:'another-cloud',label:'Another cloud',cachePages:false,cacheRanges:false,open,describeAccount}));
  const selected={...selection(),files:[],connection:{...selection().connection,provider:'another-cloud',accountMetadata:{workspace:'Team One'}}};
  await importSourceFiles(selected);const first=(await catalog.get('connections',selected.connection.id))!;
  expect((await listSourceAccounts()).accounts.find(c=>c.id===first.id)).toMatchObject({providerLabel:'Another cloud',accountDetails:[{id:'workspace',label:'Workspace',value:'Team One'}],canReconnect:false,canDisconnect:false});
  await importSourceFiles({...selected,connection:{...selected.connection,displayName:'Updated account',accountMetadata:{workspace:'Team Two'}}});
  const updated=(await catalog.get('connections',first.id))!;
  expect(updated).toMatchObject({displayName:'Updated account',accountMetadata:{workspace:'Team Two'},generation:first.generation});
  expect(connectionCapabilities(updated).accountDetails[0].value).toBe('Team Two');
  expect(connectionCapabilities({...updated,provider:'unavailable'})).toMatchObject({providerLabel:'unavailable',accountDetails:[],canReconnect:false,canDisconnect:false});
 });
 it('reads provider accounts before import, isolates failures, and never writes account snapshots into access records',async()=>{
  const account:SourceAccount={...selection().connection,provider:'connected-cloud',status:'connected'};
  const listAccounts=vi.fn(async()=>[account]),accessChanged=vi.fn();let notify:(()=>void)|undefined;
  disposers.push(registerSourceDriver({id:'connected-cloud',label:'Connected cloud',cachePages:false,cacheRanges:false,open,listAccounts,disconnect,select,
    subscribeAccounts(listener){notify=listener;return()=>{notify=undefined;};}}));
  disposers.push(registerSourceDriver({id:'broken-cloud',label:'Broken cloud',cachePages:false,cacheRanges:false,open,listAccounts:async()=>{throw Error('Provider unavailable');}}));
  vi.spyOn(sourcePageCache,'usage').mockRejectedValue(Error('Unrelated cache failure'));
  const stop=subscribeSourceAccounts(accessChanged),result=await listSourceAccounts();
  expect(result.accounts).toContainEqual({...account,providerLabel:'Connected cloud',accountDetails:[],canReconnect:true,canDisconnect:true});
  expect(result.errors).toEqual([{providerLabel:'Broken cloud',error:'Provider unavailable'}]);expect(await catalog.get('connections',account.id)).toBeUndefined();
  notify!();expect(accessChanged).toHaveBeenCalledOnce();stop();notify!();expect(accessChanged).toHaveBeenCalledOnce();
  await disconnectSource(account.id);expect(disconnect).toHaveBeenCalledWith(expect.objectContaining({id:account.id}));
  select.mockResolvedValue({connection:account,files:[]});await reconnectSource(account.id);
  expect(await catalog.get('connections',account.id)).toMatchObject({id:account.id,status:'connected'});expect(await catalog.list('comics',{index:'connectionId',range:account.id})).toEqual([]);
 });
 it('uses fresh registered account metadata but keeps expired and disconnected access unavailable',async()=>{
  const selected=selection();selected.connection.provider='account-cloud';
  const listAccounts=vi.fn(async():Promise<SourceAccount[]>=>[]);
  disposers.push(registerSourceDriver({id:'account-cloud',label:'Account cloud',cachePages:false,cacheRanges:false,open,listAccounts}));
  await importSourceFiles({...selected,files:[]});
  const original=(await catalog.get('connections',selected.connection.id))!;
  expect((await listSourceAccounts()).accounts.find(item=>item.id===original.id)?.status).toBe('reauth-required');
  listAccounts.mockResolvedValue([{...original,displayName:'Fresh account',accountMetadata:{emailAddress:'fresh@example.test'}}]);
  expect((await listSourceAccounts()).accounts.find(item=>item.id===original.id)).toMatchObject({displayName:'Fresh account',accountMetadata:{emailAddress:'fresh@example.test'}});
  expect(await catalog.get('connections',original.id)).toEqual(original);
  await catalog.put('connections',{...original,status:'disconnected'});listAccounts.mockResolvedValue([]);
  expect((await listSourceAccounts()).accounts.find(item=>item.id===original.id)?.status).toBe('disconnected');
 });
 it('deduplicates batch removal, keeps unselected comics, and retries a failure without blocking other removals',async()=>{
  const selected=selection();selected.files.push(file(),file());const ids=await importIds(selected),records=await Promise.all(ids.map(record));
  const [first,second,untouched]=records,token=await sourcePageCache.token(second.entry.id);
  await sourcePageCache.put('batch:'+second.entry.id,new Blob(['cached']),{owner:second.entry.id,token});
  const remove=catalog.deleteComic.bind(catalog),spy=vi.spyOn(catalog,'deleteComic');
  spy.mockImplementationOnce(async()=>{throw Error('Storage temporarily unavailable');}).mockImplementation(remove);
  const result=await removeComics([first.comic.id,second.comic.id,second.comic.id]);
  expect(result).toEqual({removed:[second.comic.id],failures:[{id:first.comic.id,error:'Storage temporarily unavailable'}]});expect(spy).toHaveBeenCalledTimes(2);
  expect(await catalog.get('comics',first.comic.id)).toBeDefined();expect(await catalog.get('comics',untouched.comic.id)).toBeDefined();
  expect(await catalog.get('entries',second.entry.id)).toBeUndefined();expect(await sourcePageCache.get('batch:'+second.entry.id)).toBeUndefined();
  expect(await sourcePageCache.put('late-batch',new Blob(['late']),{owner:second.entry.id,token})).toBe(false);
  expect(await removeComics([first.comic.id,second.comic.id])).toEqual({removed:[first.comic.id,second.comic.id],failures:[]});
  expect(await catalog.get('comics',untouched.comic.id)).toBeDefined();expect(await catalog.get('connections',selected.connection.id)).toBeDefined();
 });
});
