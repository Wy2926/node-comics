import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {CatalogChange} from '../src/comics/repositories';
import type {BookDownloadView} from '../src/comics/acquisition/books';
import type {FileDownloadView} from '../src/comics/acquisition/files';

// Exercise the observer's effects and real refresh timer without a browser DOM.
const hooks=vi.hoisted(()=>({stateCursor:0,refCursor:0,effectCursor:0,states:[] as unknown[],refs:[] as {current:unknown}[],
  effects:[] as {deps:unknown[];cleanup?:()=>void}[],pending:[] as (()=>void)[]}));
const source=vi.hoisted(()=>({listener:undefined as ((change:CatalogChange)=>void)|undefined,
  read:vi.fn<()=>Promise<BookDownloadView[]>>(),files:vi.fn<()=>Promise<FileDownloadView[]>>(),host:vi.fn<(signal:AbortSignal)=>Promise<void>>(),unsubscribe:vi.fn()}));
vi.mock('react',()=>({
  useState:<T>(initial?:T|(()=>T))=>{
    const index=hooks.stateCursor++;if(!(index in hooks.states))hooks.states[index]=typeof initial==='function'?(initial as ()=>T)():initial;
    return [hooks.states[index],(next:T|((previous:T)=>T))=>{hooks.states[index]=typeof next==='function'?(next as (previous:T)=>T)(hooks.states[index] as T):next;}];
  },
  useRef:(initial:unknown)=>{const index=hooks.refCursor++;return hooks.refs[index]??= {current:initial};},
  useCallback:(callback:unknown)=>callback,
  useEffect:(callback:()=>void|(()=>void),deps:unknown[])=>{
    const index=hooks.effectCursor++,previous=hooks.effects[index];
    if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))hooks.pending.push(()=>{
      previous?.cleanup?.();hooks.effects[index]={deps,cleanup:callback()||undefined};
    });
  },
}));
vi.mock('../src/comics/application/library-service',()=>({subscribeLibrary:(listener:(change:CatalogChange)=>void)=>{
  source.listener=listener;return()=>{source.listener=undefined;source.unsubscribe();};
}}));
vi.mock('../src/comics/acquisition/books',()=>({listBookDownloads:source.read,hostBookDownloads:source.host,startBookDownload:vi.fn(),readComicOfflineCapability:vi.fn(),
  isBookDownloadActive:(status:string)=>['queued','preparing','running'].includes(status)}));
vi.mock('../src/comics/acquisition/files',()=>({listRemoteFileDownloads:source.files,queueRemoteFileDownload:vi.fn(),prepareRemoteFileDownload:vi.fn()}));
vi.mock('../src/i18n/runtime',()=>({msg:(value:string,params:Record<string,unknown>={})=>value.replace(/\{(\d+)\}/g,(_,key)=>String(params[key]??''))}));
import {useBookDownloads} from '../src/ui/downloads/useBookDownloads';

const notify=vi.fn(),openCenter=vi.fn();
const flush=async()=>{for(let n=0;n<10;n++)await Promise.resolve();};
const cleanup=()=>{for(const effect of hooks.effects)effect.cleanup?.();hooks.effects=[];hooks.pending=[];};
function render(){
  hooks.stateCursor=0;hooks.refCursor=0;hooks.effectCursor=0;
  const controller=useBookDownloads(notify,openCenter);while(hooks.pending.length)hooks.pending.shift()!();return controller;
}
const change=(table:CatalogChange['table'],...ids:IDBValidKey[])=>source.listener?.({table,ids});
const book=(status:BookDownloadView['status'],id='comic'):BookDownloadView=>({
  comic:{id,title:id,sourceKey:id,sourceName:'Fixture',createdAt:0,updatedAt:0,
    source:{connectionId:'fixture',providerItemId:id,locator:{},generation:1,status:'active'}},
  plan:{id:'book-download:'+id,comicId:id,sourceGeneration:1,generation:1,status,languages:null,entryIds:[],createdAt:0,updatedAt:0},
  availableLanguages:[],completed:0,total:0,bytes:0,newChapters:0,hasPendingTasks:false,status,
});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

beforeEach(()=>{
  vi.useFakeTimers();vi.stubGlobal('window',new EventTarget());
  hooks.states=[];hooks.refs=[];notify.mockClear();openCenter.mockClear();source.unsubscribe.mockClear();
  source.read.mockReset().mockResolvedValue([]);
  source.files.mockReset().mockResolvedValue([]);
  source.host.mockReset().mockImplementation(signal=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true})));
});
afterEach(async()=>{cleanup();await flush();vi.useRealTimers();vi.unstubAllGlobals();});

describe('book download observer',()=>{
  it('ignores unrelated credentials and reading preferences, and coalesces relevant changes once per interval',async()=>{
    render();await flush();expect(source.read).toHaveBeenCalledTimes(1);
    change('metadata','original:["https://fixture.test","user","image-sha"]','reading-preferences:comic','download-languages:comic','download-host');
    change('tasks','translation:entry','discovery:entry');change('positions','entry');
    await vi.advanceTimersByTimeAsync(2250);expect(source.read).toHaveBeenCalledTimes(1);
    change('metadata','reading-preferences:comic','book-download:comic');change('tasks','download:entry');
    change('entries','entry');change('comics','comic');change('catalogs','source-catalog');
    await vi.advanceTimersByTimeAsync(749);expect(source.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(source.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);expect(source.read).toHaveBeenCalledTimes(2);
    // Each table independently invalidates the snapshot after the batch drains.
    for(const [table,id] of [['metadata','book-download:comic'],['tasks','download:entry'],['entries','entry'],['comics','comic'],['catalogs','source-catalog']] as const){
      const previous=source.read.mock.calls.length;change(table,id);await vi.advanceTimersByTimeAsync(750);expect(source.read).toHaveBeenCalledTimes(previous+1);
    }
  });
  it('retains changes received during a pending read without starting overlapping reads',async()=>{
    const initial=deferred<BookDownloadView[]>(),next=deferred<BookDownloadView[]>();
    source.read.mockReturnValueOnce(initial.promise).mockReturnValueOnce(next.promise);
    render();change('tasks','download:entry');change('metadata','book-download:comic');
    await vi.advanceTimersByTimeAsync(3000);expect(source.read).toHaveBeenCalledTimes(1);
    initial.resolve([book('running')]);await flush();
    await vi.advanceTimersByTimeAsync(750);expect(source.read).toHaveBeenCalledTimes(2);
    change('entries','entry');await vi.advanceTimersByTimeAsync(2250);expect(source.read).toHaveBeenCalledTimes(2);
    next.resolve([book('complete')]);await flush();
    await vi.advanceTimersByTimeAsync(750);expect(source.read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2250);expect(source.read).toHaveBeenCalledTimes(3);
  });
  it('counts active books and forgets a removed plan before its replacement reaches the same completed state',async()=>{
    source.read.mockResolvedValueOnce((['queued','preparing','running','paused','partial','complete','clearing'] as const).map((status,index)=>book(status,String(index))));
    render();await flush();const controller=render();expect(controller.activeCount).toBe(3);expect(controller).not.toHaveProperty('run');expect(notify).not.toHaveBeenCalled();
    change('metadata','book-download:5');await vi.advanceTimersByTimeAsync(750);expect(render().books).toEqual([]);
    source.read.mockResolvedValueOnce([book('complete','5')]);change('metadata','book-download:5');await vi.advanceTimersByTimeAsync(750);
    expect(notify).toHaveBeenCalledExactlyOnceWith('《5》的缓存已完成');expect(render().activeCount).toBe(0);
  });
  it('unsubscribes and aborts the host on unmount, ignoring a late refresh result',async()=>{
    const pending=deferred<BookDownloadView[]>();source.read.mockReturnValueOnce(pending.promise);
    render();const signal=source.host.mock.calls[0][0];expect(signal.aborted).toBe(false);expect(vi.getTimerCount()).toBe(1);
    cleanup();expect(signal.aborted).toBe(true);expect(source.unsubscribe).toHaveBeenCalledTimes(1);expect(source.listener).toBeUndefined();expect(vi.getTimerCount()).toBe(0);
    pending.resolve([book('complete')]);await flush();await vi.advanceTimersByTimeAsync(3000);
    expect(hooks.states[0]).toEqual([]);expect(source.read).toHaveBeenCalledTimes(1);expect(notify).not.toHaveBeenCalled();
  });
  it('stops the executing host when its page is hidden for navigation',async()=>{
    render();await flush();const signal=source.host.mock.calls[0][0];window.dispatchEvent(new Event('pagehide'));expect(signal.aborted).toBe(true);
  });
  it('observes complete-file intents without reacting to unrelated metadata',async()=>{
    const file=(status:FileDownloadView['intent']['status'])=>({intent:{id:'file-download:remote',title:'Remote comic',status}} as FileDownloadView);
    source.files.mockResolvedValueOnce([file('running')]);render();await flush();expect(render().activeCount).toBe(1);
    source.files.mockResolvedValueOnce([file('complete')]);change('metadata','file-download:remote');await vi.advanceTimersByTimeAsync(750);
    expect(render().activeCount).toBe(0);expect(notify).toHaveBeenCalledExactlyOnceWith('《Remote comic》的缓存已完成');
    change('metadata','opds-private');await vi.advanceTimersByTimeAsync(750);expect(source.files).toHaveBeenCalledTimes(2);
  });
});
