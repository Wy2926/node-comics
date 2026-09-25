import 'fake-indexeddb/auto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {catalog} from '../src/comics/repositories';
import {importCatalog,importManifest} from '../src/comics/application/import-service';
import {applyCatalogRefresh} from '../src/comics/application/catalog-service';
import {comicDirectory,continueEntry,loadEntry,readerSequence,selectReadingEntry} from '../src/comics/application/library-service';
import {languageMatches,readingPreferencesId} from '../src/comics/application/reading-preferences';
import {validateSourceCatalog,type SourceCatalogSnapshot,type SourceEntry} from '../src/sources';

function snapshot():SourceCatalogSnapshot {
  const slug='languages-'+crypto.randomUUID(),id='mangacopy:'+slug,url='https://mangacopy.com/comic/'+slug;
  const releases=[['en-1-b','en',0],['en-1-a','en',0],['zh-1','zh-HK',0],['zh-simple-1','zh-Hans',0],
    ['fr-2','fr',1],['en-2','en',1],['fr-3','fr',2],['en-3-b','en',2],['en-3-a','en',2],['es-4','es',3],['de-4','de',3]] as const;
  const entries:SourceEntry[]=releases.map(([title,language,order])=>{
    const remoteId=crypto.randomUUID();
    return {id:id+':'+remoteId,catalogId:id,remoteId,url:url+'/chapter/'+remoteId,title,order,groupIds:['volume'],rawTypes:['Group '+title],related:false,
      sequenceId:'chapters',contentLanguage:language,readingSlotId:'chapter-'+(order+1)};
  });
  return {id,sourceId:'mangacopy',url,title:'Multilingual fixture',observedAt:Date.now(),complete:true,note:'',entries,
    groups:[{id:'volume',title:'Volume',complete:true,entryIds:entries.map(entry=>entry.id)}]};
}
async function setup(){const source=snapshot(),comic=await importCatalog(source),entries=await catalog.listEntries(comic.id);return {source,comic,entries,entry:(title:string)=>entries.find(entry=>entry.title===title)!};}
function remove(source:SourceCatalogSnapshot,titles:string[]){
  const next=structuredClone(source);next.observedAt++;next.entries=next.entries.filter(entry=>!titles.includes(entry.title));
  next.groups.forEach(group=>group.entryIds=group.entryIds.filter(id=>next.entries.some(entry=>entry.id===id)));return next;
}
async function pages(source:SourceCatalogSnapshot,title:string,total:number){
  const entry=source.entries.find(entry=>entry.title===title)!;
  await importManifest({id:title,revision:1,title,url:entry.url,adapter:'mangacopy',direction:'rtl',discoveryComplete:true,knownTotal:total,note:'',
    items:Array.from({length:total},(_,order)=>({id:title+'-'+order,url:'https://images.example/'+title+'/'+order+'.png',order,width:800,height:1200}))});
}
afterEach(async()=>{vi.restoreAllMocks();for(const comic of await catalog.list('comics',{limit:10000}))await catalog.deleteComic(comic.id);});

describe('automatic per-chapter language selection',()=>{
  it('accepts cross-language sequences and validates slot order and readable flags',()=>{
    const source=snapshot();source.entries.find(entry=>entry.title==='zh-1')!.contentLanguage='zh-hk';
    expect(validateSourceCatalog(source).entries.find(entry=>entry.title==='zh-1')?.contentLanguage).toBe('zh-HK');
    for(const change of [{contentLanguage:'not_a_language'},{readingSlotId:''},{order:1},{readable:'yes'}]){
      const invalid=structuredClone(source);Object.assign(invalid.entries[0],change);expect(()=>validateSourceCatalog(invalid)).toThrow('INVALID_SOURCE_CATALOG');
    }
    const unsequenced=structuredClone(source);unsequenced.entries.slice(0,2).forEach(entry=>entry.sequenceId=undefined);unsequenced.entries[1].order=1;
    expect(()=>validateSourceCatalog(unsequenced)).toThrow('INVALID_SOURCE_CATALOG');
    expect(languageMatches('zh-HK','zh-Hant')).toBe(true);expect(languageMatches('zh-Hans','zh-Hant')).toBe(false);
    expect(languageMatches('fr','fr-CA')).toBe(true);expect(languageMatches('sr-Latn','sr-Cyrl')).toBe(false);
  });
  it('starts automatically and resolves each chapter by target, English, then stable source order',async()=>{
    const {comic,entry}=await setup();
    expect(await continueEntry(comic.id,'zh-Hant')).toMatchObject({id:entry('zh-1').id});
    expect(await continueEntry(comic.id,'zh-CN')).toMatchObject({id:entry('zh-simple-1').id});
    expect(await continueEntry(comic.id,'fr-CA')).toMatchObject({id:entry('en-1-b').id});
    const sequence=await readerSequence(entry('zh-1').id,undefined,'zh-Hant');
    expect(sequence.copies.map(copy=>copy.id)).toEqual(['zh-1','en-2','en-3-b','es-4'].map(title=>entry(title).id));
    const directory=await comicDirectory(comic.id,undefined,'fr-CA');
    expect(directory.chapters).toHaveLength(4);expect(directory.entries).toHaveLength(11);
    expect(directory.chapters[1]).toMatchObject({title:'fr-2',selectedEntryId:entry('fr-2').id,groupIds:['volume'],readable:true});
    expect(directory.chapters[0].entryIds).toEqual(['en-1-b','en-1-a','zh-1','zh-simple-1'].map(title=>entry(title).id));
  });
  it('uses a default only to locate its chapter, then matches the target within that chapter',async()=>{
    const source=snapshot();source.defaultEntryId=source.entries.find(entry=>entry.title==='en-2')!.id;
    const comic=await importCatalog(source);
    expect(await continueEntry(comic.id,'fr')).toMatchObject({title:'fr-2'});
  });
  it('starts at the first readable chapter if the default chapter has no readable candidate',async()=>{
    const source=snapshot();source.defaultEntryId=source.entries[0].id;
    source.entries.filter(entry=>entry.order===0).forEach(entry=>entry.readable=false);
    const comic=await importCatalog(source);expect(await continueEntry(comic.id,'fr')).toMatchObject({title:'fr-2'});
  });
  it('pins only manual candidates, never automatically opened alternatives, and keeps the current entry fixed',async()=>{
    const {comic,entry}=await setup(),readPages=vi.spyOn(catalog,'listPages');
    await selectReadingEntry(entry('en-3-a').id,false);
    expect(await continueEntry(comic.id,'fr')).toMatchObject({id:entry('en-3-a').id});
    expect((await readerSequence(entry('en-2').id,undefined,'fr')).copies.map(copy=>copy.id)).toEqual(['en-1-b','en-2','fr-3','es-4'].map(title=>entry(title).id));
    expect(readPages.mock.calls.some(([id])=>id===entry('en-3-a').contentId)).toBe(false);
    await selectReadingEntry(entry('en-3-a').id,true);
    expect((await readerSequence(entry('en-2').id,undefined,'fr')).copies[2].id).toBe(entry('en-3-a').id);
    expect((await readerSequence(entry('zh-1').id,undefined,'fr')).copies[0].id).toBe(entry('zh-1').id);
    expect((await catalog.get('metadata',readingPreferencesId(comic.id)))?.selections).toBeDefined();
    expect(await catalog.get('metadata',readingPreferencesId(comic.id))).not.toHaveProperty('contentLanguage');
  });
  it('restores each concrete release position without borrowing pages after a manual switch',async()=>{
    const {source,comic,entry}=await setup();
    for(const [title,total] of [['en-1-b',2],['zh-1',4]] as const){
      await pages(source,title,total);const indexed=await catalog.listPages(entry(title).contentId);
      await catalog.savePosition({id:entry(title).id,comicId:comic.id,entryId:entry(title).id,contentId:entry(title).contentId,
        pageId:indexed[total-1].pageId,relativeOffset:.25,updatedAt:Date.now()});
      await selectReadingEntry(entry(title).id);
    }
    expect(await continueEntry(comic.id,'en')).toMatchObject({id:entry('zh-1').id});
    const english=await loadEntry(entry('en-1-b').id),chinese=await loadEntry(entry('zh-1').id);
    expect(english.pages).toHaveLength(2);expect(chinese.pages).toHaveLength(4);
    expect(english.pageId).toBe(english.pages[1].id);expect(chinese.pageId).toBe(chinese.pages[3].id);
  });
  it('falls back within a removed manual choice chapter while preserving its cached content and position',async()=>{
    const {source,comic,entry}=await setup();await pages(source,'en-3-a',2);
    const retained=entry('en-3-a'),indexed=await catalog.listPages(retained.contentId),position={id:retained.id,comicId:comic.id,entryId:retained.id,
      contentId:retained.contentId,pageId:indexed[1].pageId,relativeOffset:.65,updatedAt:Date.now()};
    await catalog.savePosition(position);await selectReadingEntry(retained.id);
    await applyCatalogRefresh(comic.id,1,remove(source,['en-3-a']));
    expect(await continueEntry(comic.id,'fr')).toMatchObject({id:entry('fr-3').id});
    expect((await readerSequence(entry('en-2').id,undefined,'fr')).copies[2].id).toBe(entry('fr-3').id);
    expect((await readerSequence(retained.id,undefined,'fr')).copies.some(copy=>copy.id===retained.id)).toBe(true);
    expect((await comicDirectory(comic.id,retained.id,'fr')).entries.find(item=>item.id===retained.id)).toMatchObject({current:true,readable:true,sourceRemoved:true});
    expect(await catalog.listPages(retained.contentId)).toEqual(indexed);expect(await catalog.get('positions',retained.id)).toEqual(position);
  });
  it('keeps an entirely unreadable chapter in the sequence and never preloads the chapter after it',async()=>{
    const {source,comic,entry}=await setup(),next=structuredClone(source);next.observedAt++;
    next.entries.filter(item=>item.readingSlotId==='chapter-3').forEach(item=>item.readable=false);
    await applyCatalogRefresh(comic.id,1,next);const readPages=vi.spyOn(catalog,'listPages');
    const sequence=await readerSequence(entry('en-2').id,undefined,'fr');
    expect(sequence.copies.map(copy=>copy.id)).toEqual(['en-1-b','en-2','fr-3'].map(title=>entry(title).id));
    expect(sequence.copies[2].pages).toEqual([]);expect(sequence.directory.chapters[2].readable).toBe(false);
    expect(readPages.mock.calls.some(([id])=>[entry('fr-3').contentId,entry('es-4').contentId].includes(id))).toBe(false);
    expect((await readerSequence(entry('fr-3').id,undefined,'fr')).copies.map(copy=>copy.id)).toEqual([entry('fr-3').id]);
    await selectReadingEntry(entry('fr-3').id,false);
    expect(await continueEntry(comic.id,'en')).toMatchObject({readingSlotId:'chapter-3',readable:false});
  });
  it('retains a completely removed chapter as an unavailable position instead of silently skipping it',async()=>{
    const {source,comic,entry}=await setup(),next=remove(source,['fr-3','en-3-b','en-3-a']);
    // Complete feeds commonly compact source order after removing an entire chapter.
    next.entries.filter(item=>item.readingSlotId==='chapter-4').forEach(item=>item.order=2);
    await applyCatalogRefresh(comic.id,1,next);
    const sequence=await readerSequence(entry('en-2').id,undefined,'fr');
    expect(sequence.copies).toHaveLength(3);expect(sequence.directory.chapters[2]).toMatchObject({readable:false});
    expect(sequence.copies.some(copy=>copy.id===entry('es-4').id)).toBe(false);
  });
  it('synchronizes source preference order and readability metadata without replacing any content',async()=>{
    const {source,comic,entry}=await setup(),next=structuredClone(source);next.observedAt++;
    [next.entries[0],next.entries[1]]=[next.entries[1],next.entries[0]];
    next.entries.find(item=>item.title==='en-1-a')!.title='English chapter one';
    next.entries.find(item=>item.title==='en-2')!.readable=false;
    await applyCatalogRefresh(comic.id,1,next);
    expect(await continueEntry(comic.id,'en')).toMatchObject({id:entry('en-1-a').id,title:'English chapter one',sourceOrder:0});
    expect(await catalog.get('entries',entry('en-2').id)).toMatchObject({readable:false,contentId:entry('en-2').contentId});
    expect((await readerSequence(entry('en-1-a').id,undefined,'en')).copies[1].id).toBe(entry('fr-2').id);
  });
  it('fences stale generation and revoked writes, isolates comic choices, and deletes preferences atomically',async()=>{
    const first=await setup(),second=await setup();await selectReadingEntry(first.entry('zh-1').id);
    expect(await continueEntry(second.comic.id,'en')).toMatchObject({id:second.entry('en-1-b').id});
    const mutate=catalog.mutate.bind(catalog),intercept=vi.spyOn(catalog,'mutate').mockImplementationOnce(async(tables,edit)=>{
      intercept.mockRestore();await catalog.patch('comics',first.comic.id,{source:{...first.comic.source,generation:2}});return mutate(tables,edit);
    });
    await expect(selectReadingEntry(first.entry('en-1-a').id)).rejects.toThrow('来源已断开');
    expect(await continueEntry(first.comic.id,'en')).toMatchObject({id:first.entry('en-1-b').id});
    await catalog.patch('connections',first.comic.source.connectionId,{status:'revoked'});
    await expect(selectReadingEntry(first.entry('en-1-a').id)).rejects.toThrow('来源已断开');
    await catalog.deleteComic(first.comic.id);expect(await catalog.get('metadata',readingPreferencesId(first.comic.id))).toBeUndefined();
  });
});
