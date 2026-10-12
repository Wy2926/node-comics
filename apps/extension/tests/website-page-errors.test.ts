import 'fake-indexeddb/auto';
import {describe,expect,it,vi} from 'vitest';
import type {PageManifest} from '../src/sources/contracts/source';

const reads = vi.hoisted(()=>vi.fn());
const refresh = vi.hoisted(()=>vi.fn());
vi.mock('../src/sources',async original=>({...await original<typeof import('../src/sources')>(),readSourceImage:reads}));
vi.mock('../src/comics/application/website-content',()=>({refreshWebsitePage:refresh}));
import {catalog} from '../src/comics/repositories';
import {importManifest} from '../src/comics/application/import-service';
import {acquirePage} from '../src/comics/pages/service';
import {pageRenderProfile} from '../src/comics/pages/identity';
import {sourceVerificationError} from '../src/sources/runtime/http';

describe('website page verification failures',()=>{
  it.each([200,403,503])('does not rediscover renewable images after an HTTP %s challenge',async status=>{
    const manifest:PageManifest={id:crypto.randomUUID(),revision:1,title:'Verification fixture',
      url:`https://mangacopy.com/comic/verification-${crypto.randomUUID()}/chapter/${crypto.randomUUID()}`,adapter:'mangacopy',
      direction:'rtl',discoveryComplete:true,knownTotal:1,note:'',items:[{id:'page-0',contentKey:'source-content',url:'https://images.example.test/page.png',width:10,height:20,order:0}]};
    const {id}=await importManifest(manifest),entry=(await catalog.get('entries',id))!,[page]=await catalog.listPages(entry.contentId);
    await catalog.savePosition({id,entryId:id,comicId:entry.comicId,contentId:entry.contentId,pageId:page.pageId,relativeOffset:.6,updatedAt:1});
    reads.mockReset().mockRejectedValue(sourceVerificationError(status)); refresh.mockReset();
    const request={entryId:id,contentId:entry.contentId,pageId:page.pageId,renderProfileId:pageRenderProfile('website')};
    await expect(acquirePage(request)).rejects.toMatchObject({kind:'verification-required',details:{status}});
    expect(reads).toHaveBeenCalledOnce(); expect(refresh).not.toHaveBeenCalled();
    expect(await catalog.listPages(entry.contentId)).toEqual([page]);
    expect(await catalog.get('positions',id)).toMatchObject({pageId:page.pageId,relativeOffset:.6});
    await expect(acquirePage(request)).rejects.toMatchObject({kind:'verification-required'});
    expect(reads).toHaveBeenCalledTimes(2); // A user's explicit retry is still allowed.
  });
});
