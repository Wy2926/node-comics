import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {catalog} from '../src/comics/repositories';
import {importWebsiteCatalog,importWebsiteLink} from '../src/comics/application/website-import';
import {continueEntry,selectReadingEntry} from '../src/comics/application/library-service';
import {readWebsiteCatalog} from '../src/comics/application/website-catalog';
import type {SourceCatalogSnapshot} from '../src/sources';
vi.mock('../src/comics/application/website-catalog',()=>({readWebsiteCatalog:vi.fn()}));

function source():SourceCatalogSnapshot {
  const slug='link-'+crypto.randomUUID(),id='mangacopy:'+slug,url='https://mangacopy.com/comic/'+slug;
  const entries=['en','zh-HK'].flatMap(language=>[0,1].map(order=>{
    const remoteId=crypto.randomUUID();
    return {id:id+':'+remoteId,catalogId:id,remoteId,url:url+'/chapter/'+remoteId,title:language+'-'+order,order,groupIds:[],rawTypes:[],related:false,
      sequenceId:'chapters',contentLanguage:language,readingSlotId:'chapter-'+order};
  }));
  return {id,sourceId:'mangacopy',url,title:'Link fixture',observedAt:Date.now(),complete:true,note:'',groups:[],entries,defaultEntryId:entries[0].id};
}
afterEach(async()=>{
  vi.unstubAllGlobals();vi.clearAllMocks();
  for(const comic of await catalog.list('comics',{limit:10000}))await catalog.deleteComic(comic.id);
});
describe('explicit chapter import language and entry intent',()=>{
  it('uses a pasted chapter over saved language but preserves saved progress for a work URL',async()=>{
    const snapshot=source();
    vi.mocked(readWebsiteCatalog).mockResolvedValue(snapshot);
    const permissions=vi.fn(async()=>true);
    vi.stubGlobal('chrome',{runtime:{id:'test'},permissions:{contains:permissions}});
    const comic=await importWebsiteLink(snapshot.url),entries=await catalog.listEntries(comic.id);
    const chinese=entries.find(entry=>entry.title==='zh-HK-1')!;
    await selectReadingEntry(chinese.id);
    await importWebsiteLink(snapshot.url);
    expect(await continueEntry(comic.id)).toMatchObject({id:chinese.id});
    const english=snapshot.entries.find(entry=>entry.title==='en-1')!;
    expect((await importWebsiteLink(english.url)).id).toBe(comic.id);
    expect(await continueEntry(comic.id)).toMatchObject({sourceEntryId:english.id,contentLanguage:'en'});
    expect(permissions).toHaveBeenCalledTimes(3);
  });
  it('honors a background pending chapter ID and never mistakes a catalog default for explicit intent',async()=>{
    const snapshot=source(),comic=await importWebsiteCatalog(snapshot),entries=await catalog.listEntries(comic.id);
    const chinese=entries.find(entry=>entry.title==='zh-HK-1')!;
    await selectReadingEntry(chinese.id);
    await importWebsiteCatalog({...snapshot,defaultEntryId:snapshot.entries[0].id});
    expect(await continueEntry(comic.id)).toMatchObject({id:chinese.id});
    await importWebsiteCatalog(snapshot,snapshot.entries[1].id);
    expect(await continueEntry(comic.id)).toMatchObject({sourceEntryId:snapshot.entries[1].id});
  });
  it('rejects a foreign pending chapter before creating any library records',async()=>{
    await expect(importWebsiteCatalog(source(),'foreign-entry')).rejects.toThrow('不在已确认');
    expect(await catalog.count('comics')).toBe(0);
  });
  it('rejects a missing chapter even when its URL already identifies the work',async()=>{
    const snapshot=source();vi.mocked(readWebsiteCatalog).mockResolvedValue(snapshot);
    vi.stubGlobal('chrome',{runtime:{id:'test'},permissions:{contains:vi.fn(async()=>true)}});
    await expect(importWebsiteLink(snapshot.url+'/chapter/'+crypto.randomUUID())).rejects.toThrow('源站目录未包含指定章节');
    expect(await catalog.count('comics')).toBe(0);
  });
  it('rejects an explicitly requested unreadable release without importing or changing a saved choice',async()=>{
    const snapshot=source();snapshot.entries[1].readable=false;
    await expect(importWebsiteCatalog(snapshot,snapshot.entries[1].id)).rejects.toThrow('所选发布条目暂不可读');
    expect(await catalog.count('comics')).toBe(0);
    const comic=await importWebsiteCatalog(snapshot),entries=await catalog.listEntries(comic.id),selected=entries.find(entry=>entry.title==='zh-HK-1')!;
    await selectReadingEntry(selected.id);
    await expect(importWebsiteCatalog(snapshot,snapshot.entries[1].id)).rejects.toThrow('所选发布条目暂不可读');
    expect(await continueEntry(comic.id,'en')).toMatchObject({id:selected.id});
  });
  it('rejects an older pending selection after a newer catalog marked that release unreadable',async()=>{
    const older=source(),comic=await importWebsiteCatalog(older),entries=await catalog.listEntries(comic.id),selected=entries.find(entry=>entry.title==='zh-HK-1')!;
    await selectReadingEntry(selected.id);
    const current=structuredClone(older);current.observedAt++;current.entries[1].readable=false;
    await importWebsiteCatalog(current);
    await expect(importWebsiteCatalog(older,older.entries[1].id)).rejects.toThrow('所选发布条目暂不可读');
    expect(await continueEntry(comic.id,'en')).toMatchObject({id:selected.id});
  });
});
