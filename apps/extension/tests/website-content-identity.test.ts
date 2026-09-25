import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {catalog} from '../src/comics/repositories';
import {importManifest, publishWebsiteManifest} from '../src/comics/application/import-service';
import {validatePages} from '../src/sources/core/pages';
import {sourceFor, type PageManifest, type SourceSnapshot} from '../src/sources';

function manifest():PageManifest {
  return {id:crypto.randomUUID(), revision:1, title:'Transport identity fixture',
    url:`https://mangacopy.com/comic/fixture-${crypto.randomUUID()}/chapter/${crypto.randomUUID()}`,
    adapter:'mangacopy', direction:'rtl', discoveryComplete:true, knownTotal:2, note:'',
    items:[0,1].map(order=>({id:'page-'+order, contentKey:`source-hash/file-${order}.png`,
      url:`https://first.example/file-${order}.png`, width:800, height:1200, order}))};
}

describe('source content identity independent of transport URLs',()=>{
  it('refreshes temporary locators without changing pages, materializations, or reading position',async()=>{
    const input=manifest(), imported=await importManifest(input), entry=(await catalog.get('entries',imported.id))!;
    const pages=await catalog.listPages(entry.contentId);
    await catalog.savePosition({id:entry.id, entryId:entry.id, comicId:entry.comicId, contentId:entry.contentId,
      pageId:pages[1].pageId, relativeOffset:.35, updatedAt:1});
    const position=await catalog.get('positions',entry.id);
    await catalog.put('materializations',{id:'identity:'+entry.id, contentId:entry.contentId, pageId:pages[1].pageId,
      renderProfileId:'fixture', imageSha256:'actual-image-digest', width:800,height:1200,byteSize:10,mime:'image/png',updatedAt:1});
    const refreshed={...input,id:crypto.randomUUID(),items:input.items.map(item=>({...item,url:item.url.replace('first.example','second.example')}))};
    await publishWebsiteManifest(entry,refreshed);
    const after=(await catalog.get('entries',entry.id))!, current=await catalog.listPages(after.contentId);
    expect(after.contentId).toBe(entry.contentId);expect(after.generation).toBe(entry.generation);
    expect(current.map(page=>page.pageId)).toEqual(pages.map(page=>page.pageId));
    expect(current.map(page=>page.locator.url)).toEqual(refreshed.items.map(item=>item.url));
    expect(current.every(page=>page.locator.manifestId===refreshed.id)).toBe(true);
    expect(await catalog.get('positions',entry.id)).toEqual(position);
    expect(await catalog.get('materializations','identity:'+entry.id)).toBeDefined();
  });

  it('rejects changed content keys at the same URL and requires explicit replacement',async()=>{
    const input=manifest(), {id}=await importManifest(input), entry=(await catalog.get('entries',id))!;
    const changed={...input,items:input.items.map(item=>({...item,contentKey:'new-'+item.contentKey}))};
    await expect(publishWebsiteManifest(entry,changed)).rejects.toThrow('已变化');
    expect((await catalog.get('entries',id))?.contentId).toBe(entry.contentId);
    await publishWebsiteManifest(entry,changed,true);
    expect((await catalog.get('entries',id))?.contentId).not.toBe(entry.contentId);
  });

  it('does not infer equivalence when a content key disappears or stable page slots change',async()=>{
    const input=manifest(), {id}=await importManifest(input), entry=(await catalog.get('entries',id))!;
    await expect(publishWebsiteManifest(entry,{...input,items:input.items.map(item=>({...item,contentKey:undefined}))})).rejects.toThrow('已变化');
    await expect(publishWebsiteManifest(entry,{...input,items:input.items.map(item=>({...item,id:'other-'+item.id}))})).rejects.toThrow('已变化');
  });

  it('rejects invalid and page-bound content keys at both manifest entry points',async()=>{
    const input=manifest(),location=sourceFor(input.url).location;
    const snapshot:SourceSnapshot={...input,items:input.items.map(({url,...item})=>({...item,resource:{kind:'http',url}}))};
    for(const key of ['', 'x'.repeat(2049), 5]) {
      await expect(importManifest({...input,items:[{...input.items[0],contentKey:key as string}]})).rejects.toThrow('无效');
      expect(()=>validatePages({...snapshot,items:[{...snapshot.items[0],contentKey:key as string}]},location)).toThrow('INVALID_SOURCE_PAGES');
    }
    expect(()=>validatePages({...snapshot,items:[{...snapshot.items[0],resource:{kind:'page',resourceKey:'page-resource'}}]},location)).toThrow('INVALID_SOURCE_PAGES');
  });
});
