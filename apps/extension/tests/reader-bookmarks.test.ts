import 'fake-indexeddb/auto';
import {describe,expect,it,vi} from 'vitest';
import {IDBIndex,IDBObjectStore} from 'fake-indexeddb';
import {catalog} from '../src/comics/repositories';
import {addBookmark,deleteBookmark,noteBookmark,countBookmarks,findBookmark,listBookmarks,bookmarkLocation,applyBookmark,bookmarkKey} from '../src/comics/application/bookmarks';
import {seedComic} from './comic-fixture';
import type {ReadingEntry} from '../src/types';

async function sample(count=3){
  const {comic,entry,page}=await seedComic();
  await catalog.putPages(entry.id,entry.contentId,Array.from({length:count},(_,n)=>page(n)),1);
  const copy:ReadingEntry={...entry,source:'cbz',sourceKey:comic.sourceKey,pageId:page(0).pageId,relativeOffset:.42,discoveryComplete:true,
    pages:Array.from({length:count},(_,n)=>({id:page(n).pageId,name:String(n),width:800,height:n===0?4000:1200,jobs:[],outputBlobs:{}}))};
  return {comic,entry,copy,location:bookmarkLocation(copy)!};
}
describe('reader bookmarks',()=>{
  it('deduplicates concurrent clicks without changing the saved long-page offset or auto progress',async()=>{
    const {location,entry}=await sample();
    const [a,b]=await Promise.all([addBookmark(location),addBookmark({...location,relativeOffset:.8})]);
    expect(a.id).toBe(b.id);expect(a.relativeOffset).toBe(.42);
    expect(await countBookmarks(location.comicId)).toBe(1);
    expect(await catalog.get('positions',entry.id)).toBeUndefined();
    expect(await findBookmark({...location,relativeOffset:0})).toEqual(a);
  });
  it('keeps notes, restores deletion once, and never resurrects a deleted row through a late note save',async()=>{
    const {location}=await sample();const a=await addBookmark(location);
    await noteBookmark(a.id,'  <script>plain text</script>  ');
    const removed=(await deleteBookmark(a.id))!;
    expect(removed.note).toBe('<script>plain text</script>');
    await noteBookmark(a.id,'late edit');expect(await findBookmark(location)).toBeUndefined();
    const restored=await addBookmark(removed,removed),again=await addBookmark(removed,removed);
    expect(restored.id).not.toBe(a.id);expect(again).toEqual(restored);
    expect(restored).toMatchObject({note:removed.note,createdAt:a.createdAt,relativeOffset:.42});
  });
  it('bounds notes and resolves only exact comic/content/page identities',async()=>{
    const {location,copy}=await sample();const a=await addBookmark(location);
    await noteBookmark(a.id,'x'.repeat(250));expect((await findBookmark(location))?.note.length).toBe(200);
    expect(applyBookmark(copy,location)).toMatchObject({pageId:location.pageId,relativeOffset:.42});
    for(const patch of [{comicId:'other'},{entryId:'other'},{contentId:'changed'},{pageId:'missing'}])expect(applyBookmark(copy,{...location,...patch})).toBeUndefined();
    await catalog.patch('entries',copy.id,{contentId:'changed'});
    await expect(addBookmark(location)).rejects.toThrow('不可用');
    expect(await countBookmarks(location.comicId)).toBe(1);
  });
  it('pages newest-first within one comic using indexes, with no source/image reads',async()=>{
    const {location,copy}=await sample(105);const other=await sample();await addBookmark(other.location);
    for(let n=0;n<105;n++)await addBookmark({...location,pageId:copy.pages[n].id,pageNumber:n+1});
    const get=vi.spyOn(IDBObjectStore.prototype,'get'),getAll=vi.spyOn(IDBObjectStore.prototype,'getAll'),cursors=vi.spyOn(IDBIndex.prototype,'openCursor');
    try{
      const a=await listBookmarks(location.comicId),b=await listBookmarks(location.comicId,a.at(-1)),c=await listBookmarks(location.comicId,b.at(-1));
      expect(a).toHaveLength(50);expect(b).toHaveLength(50);expect(c).toHaveLength(5);
      expect(new Set([...a,...b,...c].map(item=>item.id)).size).toBe(105);
      expect([...a,...b,...c].every(item=>item.comicId===location.comicId)).toBe(true);
      expect(get).not.toHaveBeenCalled();expect(getAll).not.toHaveBeenCalled();expect(cursors).toHaveBeenCalledTimes(3);
      expect(cursors.mock.calls.every(args=>args[1]==='prev')).toBe(true);
    }finally{vi.restoreAllMocks();}
  });
  it('removes bookmarks with the comic and rejects delayed add/undo after removal',async()=>{
    const {location}=await sample(),other=await sample();const item=await addBookmark(location);await addBookmark(other.location);
    await catalog.deleteComic(location.comicId);
    expect(await countBookmarks(location.comicId)).toBe(0);expect(await countBookmarks(other.location.comicId)).toBe(1);
    await expect(addBookmark(item,item)).rejects.toThrow('不可用');
  });
  it('keeps a double-page anchor on its actual page without storing layout or translation settings',async()=>{
    const {copy}=await sample();const target=bookmarkLocation(copy,copy.pages[2].id,0)!;
    expect(target.pageNumber).toBe(3);expect(applyBookmark(copy,target)?.pageId).toBe(copy.pages[2].id);
    expect(Object.keys(target).sort()).toEqual(['comicId','contentId','entryId','pageId','pageNumber','relativeOffset','title']);
  });
  it('stores EPUB text anchors and progression without bitmap descriptors',async()=>{
    const {copy,entry}=await sample();
    const document={chapters:[{href:'chapter.xhtml',title:'Chapter'}],toc:[],resources:[],layout:'reflowable'} as unknown as NonNullable<ReadingEntry['document']>;
    const documentLocation={href:'chapter.xhtml',cfi:'epubcfi(/6/2!/4/2/1:16)',progression:.42,totalProgression:.21};
    await catalog.patch('entries',entry.id,{document});
    const epub={...copy,pages:[],document,documentLocation},location=bookmarkLocation(epub)!;
    expect(location.pageId).toBe('');expect(applyBookmark(epub,location)?.documentLocation).toEqual(documentLocation);
    const saved=await addBookmark(location);expect(await findBookmark(location)).toEqual(saved);
    expect(bookmarkKey({...location,documentLocation:{...documentLocation,progression:.4201}})).toBe(bookmarkKey(location));
    expect(bookmarkKey({...location,documentLocation:{...documentLocation,cfi:'epubcfi(/6/2!/4/2/1:32)'}})).not.toBe(bookmarkKey(location));
  });
});
