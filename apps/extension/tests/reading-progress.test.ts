import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ReadingEntry} from '../src/types';
import type {EpubLocation} from '../src/comics/formats/contracts';
import {ReadingProgress} from '../src/comics/application/reading-progress';

const mocks=vi.hoisted(()=>({read:vi.fn(),write:vi.fn(),assertCurrent:vi.fn(),enabled:true}));
vi.mock('../src/comics/sources/registry',()=>({getSourceDriver:()=>mocks.enabled?{progress:{read:mocks.read,write:mocks.write}}:{}}));
vi.mock('../src/comics/application/entry-source',()=>({entrySource:async(id:string,contentId:string,signal:AbortSignal)=>({
  entry:{id,contentId},connection:{provider:'test'},context:{entryId:id,contentId,signal},assertCurrent:mocks.assertCurrent,
})}));
const copy=(page=0,time=1):ReadingEntry=>({id:'entry',comicId:'comic',contentId:'content',title:'Book',source:'image-sequence',sourceKey:'entry',generation:1,discoveryComplete:true,createdAt:1,updatedAt:1,lastReadAt:time,pageId:'p'+page,relativeOffset:0,pages:[0,1,2].map(i=>({id:'p'+i,name:''+i,width:100,height:200,blobKey:'',jobs:[],outputBlobs:{}}))});
const epubCopy = (documentLocation: EpubLocation, time = 1): ReadingEntry => ({
  ...copy(0, time),
  source: 'epub',
  pages: [],
  pageId: '',
  document: {
    kind: 'epub',
    title: 'Text',
    chapters: [{id: 'one', href: '/one.xhtml', label: 'One'}],
    toc: [],
  },
  documentLocation,
});
beforeEach(()=>{vi.useFakeTimers();mocks.enabled=true;mocks.read.mockReset().mockResolvedValue(undefined);mocks.write.mockReset().mockResolvedValue(undefined);mocks.assertCurrent.mockReset().mockResolvedValue(undefined);});
afterEach(()=>vi.useRealTimers());

describe('visible reading position coordinator',()=>{
  it('restores the remote page but never writes during read or unchanged render updates',async()=>{
    mocks.read.mockResolvedValue({pageIndex:2,updatedAt:2});const sync=new ReadingProgress();
    const restored=await sync.open(copy());expect(restored.pageId).toBe('p2');
    sync.update({...restored,lastReadAt:restored.lastReadAt!+1});await sync.flush();
    expect(mocks.write).not.toHaveBeenCalled();await sync.close();
  });
  it.each([undefined, 10, 20, NaN, Infinity])(
    'keeps local progress when the directory snapshot timestamp %s is not newer',
    async (updatedAt) => {
      mocks.read.mockResolvedValue({pageIndex: 0, snapshot: true, updatedAt});
      const sync = new ReadingProgress();
      const local = copy(2, 20);
      expect(await sync.open(local)).toBe(local);
      await sync.close();
      expect(mocks.write).not.toHaveBeenCalled();
    },
  );
  it('restores a directory snapshot whose valid timestamp is newer than the local position', async () => {
    mocks.read.mockResolvedValue({pageIndex: 1, snapshot: true, updatedAt: 30});
    const sync = new ReadingProgress();
    const restored = await sync.open(copy(2, 20));
    expect(restored.pageId).toBe('p1');
    expect(restored.relativeOffset).toBe(0);
    await sync.close();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each([undefined, 10])(
    'restores snapshot progress on first open even with a default first page and date %s',
    async (updatedAt) => {
      mocks.read.mockResolvedValue({pageIndex: 2, snapshot: true, updatedAt});
      const sync = new ReadingProgress();
      const restored = await sync.open({...copy(0), lastReadAt: undefined});
      expect(restored.pageId).toBe('p2');
      expect(restored.lastReadAt).toBeDefined();
      await sync.close();
      expect(mocks.write).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, 10, 20, NaN, Infinity])(
    'keeps the newer local page even when the live API responds, with remote timestamp %s',
    async (updatedAt) => {
      mocks.read.mockResolvedValue({pageIndex: 0, updatedAt});
      const sync = new ReadingProgress();
      const restored = await sync.open(copy(2, 20));
      expect(restored.pageId).toBe('p2');
      expect(restored.lastReadAt).toBe(20);
      await sync.close();
      if(updatedAt===10)expect(mocks.write).toHaveBeenCalledWith(expect.anything(),{pageIndex:2,updatedAt:20});
      else expect(mocks.write).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, 10, 20, 30])('uses the same timestamp policy for EPUB (remote %s)',async(updatedAt)=>{
    const local=epubCopy({href:'/one.xhtml',cfi:'epubcfi(/6/2!/4/2:8)',progression:.6},20);
    const documentLocation={href:'/one.xhtml',cfi:'epubcfi(/6/2!/4/2:4)',progression:.3};
    mocks.read.mockResolvedValue({documentLocation,updatedAt});
    const sync=new ReadingProgress();
    const restored=await sync.open(local);
    expect(restored.documentLocation).toEqual(updatedAt===30?documentLocation:local.documentLocation);
    expect(restored.lastReadAt).toBe(updatedAt===30?30:20);
    await sync.close();
    if(updatedAt===10)expect(mocks.write).toHaveBeenCalledWith(expect.anything(),{documentLocation:local.documentLocation,updatedAt:20});
    else expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each([null,{pageIndex:0,snapshot:true}])('does not queue writes to read-only or unsupported progress endpoints (%s)',async(remote)=>{
    mocks.read.mockResolvedValue(remote);
    const error=vi.fn(),status=vi.fn(),sync=new ReadingProgress(error,status);
    await sync.open(copy(1,20));
    sync.update(copy(2,30));await vi.advanceTimersByTimeAsync(500);await sync.close();
    expect(status).toHaveBeenLastCalledWith('local');
    expect(error).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
  });
  it('reports quiet pending status on failure and clears it after the next acknowledged change',async()=>{
    mocks.read.mockRejectedValueOnce(Error('offline'));
    mocks.write.mockRejectedValueOnce(Error('offline'));
    const status=vi.fn(),sync=new ReadingProgress(undefined,status);
    const local=copy(1,20);
    expect(await sync.open(local)).toBe(local);
    expect(status).toHaveBeenLastCalledWith('pending');
    sync.update(copy(2,30));await sync.flush();expect(status).toHaveBeenLastCalledWith('pending');
    sync.update(copy(0,40));await sync.flush();expect(status).toHaveBeenLastCalledWith('synced');
    await sync.close();
  });
  it('coalesces movement into the latest actual visible page',async()=>{
    const sync=new ReadingProgress();await sync.open(copy());sync.update(copy(1,2));sync.update(copy(2,3));
    await vi.advanceTimersByTimeAsync(499);expect(mocks.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.write.mock.calls[0][1]).toEqual({pageIndex:2,updatedAt:3});await sync.close();
  });
  it('cancels an intermediate queued move when returning to the saved page',async()=>{
    const sync=new ReadingProgress();await sync.open(copy());sync.update(copy(1,2));sync.update(copy(0,3));await sync.close();expect(mocks.write).not.toHaveBeenCalled();
  });
  it('serializes writes and retains only the latest move while one is in flight',async()=>{
    let finish!:()=>void;mocks.write.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const sync=new ReadingProgress();await sync.open(copy());sync.update(copy(1,2));const pending=sync.flush();
    await vi.advanceTimersByTimeAsync(0);sync.update(copy(2,3));sync.update(copy(0,4));
    expect(mocks.write).toHaveBeenCalledTimes(1);finish();await pending;
    expect(mocks.write.mock.calls.map(call=>call[1].pageIndex)).toEqual([1,0]);await sync.close();
  });
  it('does not write the same EPUB location again after its in-flight write succeeds', async () => {
    const document = {
      kind: 'epub' as const,
      title: 'Text',
      chapters: [{id: 'one', href: '/one.xhtml', label: 'One'}],
      toc: [],
    };
    const book: ReadingEntry = {
      ...copy(),
      pages: [],
      pageId: '',
      document,
      documentLocation: {href: '/one.xhtml', progression: 0},
    };
    const moved: ReadingEntry = {
      ...book,
      lastReadAt: 2,
      documentLocation: {
        href: '/one.xhtml',
        cfi: 'epubcfi(/6/2!/4/2:0)',
        progression: 0.4,
        totalProgression: 0.2,
      },
    };
    const started = Promise.withResolvers<void>();
    const first = Promise.withResolvers<void>();
    mocks.write.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    const sync = new ReadingProgress();
    await sync.open(book);
    sync.update(moved);
    const sending = sync.flush();
    await started.promise;
    sync.update({...moved, lastReadAt: 3});
    first.resolve();
    await sending;
    await vi.advanceTimersByTimeAsync(500);
    await sync.close();
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.write.mock.calls[0][1]).toEqual({
      documentLocation: moved.documentLocation,
      updatedAt: 2,
    });
  });
  it('does not write a restored CFI just because the server normalized its percentages', async () => {
    const location: EpubLocation = {
      href: '/one.xhtml',
      cfi: 'epubcfi(/6/2!/4/2:0)',
      progression: 0.12346,
      totalProgression: 0.20340733,
    };
    mocks.read.mockResolvedValue({documentLocation: location});
    const sync = new ReadingProgress();
    const restored = await sync.open(epubCopy(location));
    sync.update({
      ...restored,
      lastReadAt: restored.lastReadAt! + 1,
      documentLocation: {...location, progression: 0.123456789, totalProgression: 0.227607935},
    });
    await sync.close();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('writes a changed CFI even when its derived percentages have not changed', async () => {
    const location: EpubLocation = {
      href: '/one.xhtml',
      cfi: 'epubcfi(/6/2!/4/2:0)',
      progression: 0.4,
      totalProgression: 0.2,
    };
    const sync = new ReadingProgress();
    await sync.open(epubCopy(location));
    const moved = {...location, cfi: 'epubcfi(/6/2!/4/2:5)'};
    sync.update(epubCopy(moved, 2));
    await sync.close();
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.write.mock.calls[0][1]).toEqual({documentLocation: moved, updatedAt: 2});
  });
  it('uses resource progression without a CFI but does not write derived total-only changes', async () => {
    const location: EpubLocation = {
      href: '/one.xhtml',
      progression: 0.3,
      totalProgression: 0.2,
    };
    const sync = new ReadingProgress();
    await sync.open(epubCopy(location));
    sync.update(epubCopy({...location, totalProgression: 0.4}, 2));
    await sync.flush();
    expect(mocks.write).not.toHaveBeenCalled();
    const moved = {...location, progression: 0.4, totalProgression: 0.5};
    sync.update(epubCopy(moved, 3));
    await sync.close();
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.write.mock.calls[0][1]).toEqual({documentLocation: moved, updatedAt: 3});
  });
  it('retries a same-location update received while the first write later fails', async () => {
    const started = Promise.withResolvers<void>();
    const first = Promise.withResolvers<void>();
    mocks.write.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    const error = vi.fn();
    const sync = new ReadingProgress(error);
    await sync.open(copy());
    sync.update(copy(1, 2));
    const sending = sync.flush();
    await started.promise;
    sync.update(copy(1, 3));
    first.reject(Error('The source did not acknowledge the write'));
    await sending;
    await sync.close();
    expect(error).toHaveBeenCalledOnce();
    expect(mocks.write.mock.calls.map((call) => call[1])).toEqual([
      {pageIndex: 1, updatedAt: 2},
      {pageIndex: 1, updatedAt: 3},
    ]);
  });
  it('writes a return to the old location after an unacknowledged in-flight move', async () => {
    const started = Promise.withResolvers<void>();
    const first = Promise.withResolvers<void>();
    mocks.write.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    const error = vi.fn();
    const sync = new ReadingProgress(error);
    await sync.open(copy());
    sync.update(copy(1, 2));
    const sending = sync.flush();
    await started.promise;
    sync.update(copy(0, 3));
    first.reject(Error('The source may have applied the move'));
    await sending;
    await sync.close();
    expect(error).toHaveBeenCalledOnce();
    expect(mocks.write.mock.calls.map((call) => call[1].pageIndex)).toEqual([1, 0]);
  });
  it('does not automatically retry a failed write without a new visible-position update', async () => {
    mocks.write.mockRejectedValueOnce(Error('offline'));
    const error = vi.fn();
    const sync = new ReadingProgress(error);
    await sync.open(copy());
    sync.update(copy(1, 2));
    await sync.flush();
    await sync.flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.write).toHaveBeenCalledOnce();
    sync.update(copy(1, 3));
    await sync.close();
    expect(mocks.write.mock.calls.map((call) => call[1].pageIndex)).toEqual([1, 1]);
    expect(error).toHaveBeenCalledOnce();
  });
  it('flushes once on exit and finishes before reopening reads server progress',async()=>{
    const sync=new ReadingProgress();await sync.open(copy());sync.update(copy(2,3));await sync.close();await sync.open(copy());
    expect(mocks.write).toHaveBeenCalledTimes(1);expect(mocks.read).toHaveBeenCalledTimes(2);await sync.close();
  });
  it('does not send background entry updates, stale content, or translation-only updates',async()=>{
    const sync=new ReadingProgress();await sync.open(copy());
    sync.update({...copy(1,2),id:'other'});sync.update({...copy(1,2),contentId:'old'});sync.update(copy(1,1));
    await sync.close();expect(mocks.write).not.toHaveBeenCalled();
  });
  it('keeps local reading available on a failed progress read without overwriting the server',async()=>{
    const error=vi.fn();mocks.read.mockRejectedValue(Error('offline'));const sync=new ReadingProgress(error);
    expect(await sync.open(copy(2))).toEqual(copy(2));expect(error).toHaveBeenCalledTimes(1);await sync.close();expect(mocks.write).not.toHaveBeenCalled();
  });
  it('validates the source again before delayed writes',async()=>{
    const error=vi.fn(),sync=new ReadingProgress(error);await sync.open(copy());
    mocks.assertCurrent.mockRejectedValue(new DOMException('changed','AbortError'));sync.update(copy(2,3));await sync.close();
    expect(mocks.write).not.toHaveBeenCalled();expect(error).toHaveBeenCalledTimes(1);
  });
  it('preserves local state for invalid remote ordinals',async()=>{
    mocks.read.mockResolvedValue({pageIndex:8});const sync=new ReadingProgress();expect(await sync.open(copy(1))).toEqual(copy(1));await sync.close();
  });
  it('uses independent EPUB resource and total progress, with no fake image pages',async()=>{
    const document={kind:'epub' as const,title:'Text',chapters:[{id:'one',href:'/one.xhtml',label:'One'}],toc:[]};
    const book={...copy(),pages:[],pageId:'',document,documentLocation:{href:'/one.xhtml',progression:0}};
    mocks.read.mockResolvedValue({documentLocation:{href:'/one.xhtml',progression:.4,totalProgression:.2},updatedAt:2});
    const sync=new ReadingProgress(),restored=await sync.open(book);
    expect(restored.documentLocation).toEqual({href:'/one.xhtml',progression:.4,totalProgression:.2});
    sync.update({...restored,lastReadAt:restored.lastReadAt!+1,documentLocation:{href:'/one.xhtml',progression:.5,totalProgression:.25}});await sync.close();
    expect(mocks.write.mock.calls[0][1]).toMatchObject({documentLocation:{progression:.5,totalProgression:.25}});
    expect(mocks.write.mock.calls[0][1].pageIndex).toBeUndefined();
  });
  it('does not activate an aborted open',async()=>{
    const controller=new AbortController();mocks.read.mockImplementation(async()=>{controller.abort();return {pageIndex:2};});
    const sync=new ReadingProgress();await expect(sync.open(copy(),controller.signal)).rejects.toMatchObject({name:'AbortError'});
    sync.update(copy(1,2));await sync.close();expect(mocks.write).not.toHaveBeenCalled();
  });
  it('cancels a pending restoration when the reader closes without an external signal', async () => {
    const started = Promise.withResolvers<void>();
    const remote = Promise.withResolvers<{ pageIndex: number }>();
    mocks.read.mockImplementationOnce(() => {
      started.resolve();
      return remote.promise;
    });
    const sync = new ReadingProgress();
    const opening = sync.open(copy());
    await started.promise;
    await sync.close();
    remote.resolve({ pageIndex: 2 });
    try {
      await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
      sync.update(copy(1, 2));
      await sync.flush();
      expect(mocks.write).not.toHaveBeenCalled();
    } finally {
      await sync.close();
    }
  });
  it('lets the latest open of the same entry supersede an older restoration', async () => {
    const started = Promise.withResolvers<void>();
    const remote = Promise.withResolvers<{ pageIndex: number }>();
    mocks.read.mockImplementationOnce(() => {
      started.resolve();
      return remote.promise;
    }).mockResolvedValueOnce({ pageIndex: 1, updatedAt: 2 });
    const sync = new ReadingProgress();
    const previous = sync.open(copy());
    await started.promise;
    const current = await sync.open(copy());
    expect(current.pageId).toBe('p1');
    remote.resolve({ pageIndex: 2 });
    try {
      await expect(previous).rejects.toMatchObject({ name: 'AbortError' });
      sync.update({ ...current, pageId: 'p2', lastReadAt: current.lastReadAt! + 1 });
      await sync.flush();
      expect(mocks.write).toHaveBeenCalledTimes(1);
      expect(mocks.write.mock.calls[0][1].pageIndex).toBe(2);
    } finally {
      await sync.close();
    }
  });
  it('does not treat a revoked source binding as an offline progress-read fallback', async () => {
    const error = vi.fn();
    mocks.read.mockResolvedValue({ pageIndex: 2 });
    mocks.assertCurrent.mockRejectedValue(new DOMException('changed', 'AbortError'));
    const sync = new ReadingProgress(error);
    try {
      await expect(sync.open(copy())).rejects.toMatchObject({ name: 'AbortError' });
      sync.update(copy(1, 2));
      await sync.flush();
      expect(mocks.write).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      await sync.close();
    }
  });
  it('does not contact providers without a progress capability',async()=>{
    mocks.enabled=false;const sync=new ReadingProgress();expect(await sync.open(copy())).toEqual(copy());sync.update(copy(2,3));await sync.close();expect(mocks.read).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
  });
});
