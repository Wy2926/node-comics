import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SourceCatalogSnapshot,SourceEntry,SourceSearchResult} from '../src/sources';
const fixture=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('../src/comics/application/website-catalog',()=>({readWebsiteCatalog:fixture.read}));
import {catalog} from '../src/comics/repositories';
import {importCatalog} from '../src/comics/application/import-service';
import {importSearchResult} from '../src/comics/application/search-import';
import {readReadingPreferences,setSourceLanguagePreference,selectReadingEntry} from '../src/comics/application/reading-preferences';

function snapshot():SourceCatalogSnapshot {
  const slug='search-import-'+crypto.randomUUID(),id='mangacopy:'+slug,url='https://mangacopy.com/comic/'+slug;
  const entries:SourceEntry[]=[['English one','en',0],['Chinese one','zh-HK',0],['English two','en',1],['Chinese two','zh-Hant',1]].map(([title,language,order])=>{
    const remoteId=crypto.randomUUID();
    return {id:id+':'+remoteId,catalogId:id,remoteId,url:url+'/chapter/'+remoteId,title:String(title),contentLanguage:String(language),order:Number(order),
      groupIds:['main'],rawTypes:[],related:false,sequenceId:'main',readingSlotId:'chapter-'+order};
  });
  return {id,sourceId:'mangacopy',url,title:'Same displayed title',complete:true,observedAt:Date.now(),note:'',entries,
    groups:[{id:'main',title:'Chapters',entryIds:entries.map(entry=>entry.id),complete:true}]};
}
function hit(source:SourceCatalogSnapshot):SourceSearchResult {
  return {sourceId:source.sourceId,siteId:'mangacopy',catalogId:source.id,catalogUrl:source.url,title:source.title,
    key:JSON.stringify([source.sourceId,source.id])};
}
beforeEach(()=>{
  fixture.read.mockReset();
  vi.stubGlobal('chrome',{runtime:{id:'test'},permissions:{request:vi.fn(async()=>true),contains:vi.fn(async()=>true)}});
});
afterEach(async()=>{
  vi.unstubAllGlobals();vi.restoreAllMocks();
  for(const comic of await catalog.list('comics',{limit:10000}))await catalog.deleteComic(comic.id);
});
describe('name-search result import',()=>{
  it('blocks revoked installation access before catalog/network work without requesting per-site permissions',async()=>{
    const source=snapshot();fixture.read.mockResolvedValue(source);
    let decide!:(value:boolean)=>void;
    vi.mocked(chrome.permissions.contains).mockImplementationOnce(()=>new Promise(resolve=>{decide=resolve;}));
    const importing=importSearchResult(hit(source),'zh-Hant');
    expect(chrome.permissions.contains).toHaveBeenCalledWith({origins:['https://*/*','http://*/*']});
    expect(chrome.permissions.request).not.toHaveBeenCalled();expect(fixture.read).not.toHaveBeenCalled();
    decide(false);await expect(importing).rejects.toThrow();
    expect(await catalog.list('comics')).toEqual([]);expect(fixture.read).not.toHaveBeenCalled();
  });
  it('uses ordinary reading settings without saving a preference from the search',async()=>{
    const source=snapshot();fixture.read.mockResolvedValue(source);
    const result=await importSearchResult(hit(source),'zh-Hant');
    expect(result.entry).toMatchObject({title:'Chinese one',contentLanguage:'zh-HK'});
    expect((await readReadingPreferences(result.comic)).sourceLanguagePreference).toBeUndefined();
    expect(result).not.toHaveProperty('directory');
    expect(await catalog.list('comics')).toHaveLength(1);
  });
  it('opens an available release when the first chapter has no matching reading language',async()=>{
    const source=snapshot();source.entries[1].contentLanguage='zh';fixture.read.mockResolvedValue(source);
    const result=await importSearchResult(hit(source),'zh-Hant');
    expect(result.entry).toMatchObject({title:'English one',contentLanguage:'en'});
    expect(result).not.toHaveProperty('directory');
    expect((await readReadingPreferences(result.comic)).sourceLanguagePreference).toBeUndefined();
    expect((await readReadingPreferences(result.comic)).lastEntryId).toBeUndefined();
  });
  it('opens normally when chapter languages are partially or wholly unlabelled',async()=>{
    const source=snapshot();source.entries.filter(entry=>entry.order===0).forEach(entry=>{delete entry.contentLanguage;});
    fixture.read.mockResolvedValue(source);
    const result=await importSearchResult(hit(source),'zh-Hant');
    expect(result.entry).toMatchObject({title:'English one'});
    expect(result).not.toHaveProperty('directory');
    expect((await readReadingPreferences(result.comic)).sourceLanguagePreference).toBeUndefined();
    const unlabelled=snapshot();unlabelled.entries.forEach(entry=>{delete entry.contentLanguage;});
    fixture.read.mockResolvedValue(unlabelled);
    const ordinary=await importSearchResult(hit(unlabelled),'zh-Hans');
    expect(ordinary.entry).toMatchObject({title:'English one'});
    expect(ordinary).not.toHaveProperty('directory');
    expect((await readReadingPreferences(ordinary.comic)).sourceLanguagePreference).toBeUndefined();
  });
  it('keeps an existing book preference and deliberate resume choice without fetching or importing its directory again',async()=>{
    const source=snapshot(),comic=await importCatalog(source),entries=await catalog.listEntries(comic.id);
    await setSourceLanguagePreference(comic.id,'zh-Hant');
    const selected=entries.find(entry=>entry.title==='English two')!;await selectReadingEntry(selected.id);
    const before=await readReadingPreferences(comic);
    fixture.read.mockRejectedValue(Error('Must not refetch existing book'));
    const result=await importSearchResult(hit(source),'fr');
    expect(result.comic.id).toBe(comic.id);expect(result.entry?.id).toBe(selected.id);
    expect(await readReadingPreferences(comic)).toEqual(before);expect(fixture.read).not.toHaveBeenCalled();
    expect(await catalog.list('comics')).toHaveLength(1);
  });
  it('reports an empty directory consistently for existing and newly imported books',async()=>{
    const existing=snapshot();existing.entries=[];existing.groups=[];
    const comic=await importCatalog(existing);
    fixture.read.mockRejectedValue(Error('Must not refetch existing book'));
    await expect(importSearchResult(hit(existing),'en')).rejects.toThrow('无法打开来源。');
    expect(fixture.read).not.toHaveBeenCalled();
    expect(await catalog.get('comics',comic.id)).toBeDefined();
    const fresh=snapshot();fresh.entries=[];fresh.groups=[];fixture.read.mockResolvedValue(fresh);
    await expect(importSearchResult(hit(fresh),'en')).rejects.toThrow('无法打开来源。');
    expect(fixture.read).toHaveBeenCalledOnce();
  });
  it('keeps same-title source identities independent and rejects a forged catalog binding before permission',async()=>{
    const original=snapshot(),comic=await importCatalog(original);await setSourceLanguagePreference(comic.id,'en');
    const another=snapshot();fixture.read.mockResolvedValue(another);
    const result=await importSearchResult(hit(another),'zh-Hant');
    expect(result.comic.id).not.toBe(comic.id);expect(await catalog.list('comics')).toHaveLength(2);
    expect((await readReadingPreferences(comic)).sourceLanguagePreference).toBe('en');
    vi.mocked(chrome.permissions.contains).mockClear();
    await expect(importSearchResult({...hit(another),catalogId:original.id},'zh-Hant')).rejects.toThrow();
    expect(chrome.permissions.contains).not.toHaveBeenCalled();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });
});
