import {afterEach,describe,expect,it,vi} from 'vitest';
import {ApiError} from '../src/api';
import {ComicSearchSession} from '../src/comics/application/search/session';
import type {ComicSearchDependencies} from '../src/comics/application/search/types';
import type {SourceSearchResult,SourceSearchResults,SourceSearchSite} from '../src/sources/contracts/search';

const flush=async()=>{for(let index=0;index<12;index++)await Promise.resolve();};
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(reason?:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
const site=(id:string,primaryLanguages=['en']):SourceSearchSite=>({id,name:id,url:`https://${id}.example/`,icon:'',primaryLanguages,adapterId:id,key:id+':'+id,search:{requestOrigins:[`https://${id}.example/*`]}});
const hit=(id:string,name=id):SourceSearchResult=>({sourceId:id,siteId:id,key:JSON.stringify([id,name]),catalogId:name,catalogUrl:`https://${id}.example/comic/${name}`,title:name});
const page=(id:string,name=id):SourceSearchResults=>({items:[hit(id,name)]});
function setup(options:Partial<ComicSearchDependencies>={},sites=[site('a'),site('b')]){
  const deps={translateTitle:vi.fn().mockResolvedValue({name:'中文名',target_language:'zh-Hans'}),listSites:vi.fn().mockReturnValue(sites),search:vi.fn().mockImplementation(async(id:string)=>page(id)),release:vi.fn(),...options};
  const session=new ComicSearchSession({title:'日本語名'},deps,'zh');sessions.push(session);return {session,deps};
}
const sessions:ComicSearchSession[]=[];
afterEach(()=>{sessions.splice(0).forEach(session=>session.dispose());vi.useRealTimers();});

describe('comic search session',()=>{
  it('opening does not query names or sites, and all searchable sites are selected initially',async()=>{
    const {session,deps}=setup({},[site('a'),site('unknown',[])]);
    expect(deps.translateTitle).not.toHaveBeenCalled();expect(deps.search).not.toHaveBeenCalled();
    expect(session.getSnapshot().sites.map(state=>state.selected)).toEqual([true,true]);
    expect(deps.listSites).toHaveBeenCalledWith();
    session.setSelected('a:a',false);session.setSelected('unknown:unknown',false);await session.searchWithTranslatedTitle();
    expect(deps.translateTitle).not.toHaveBeenCalled();expect(session.getSnapshot().titleError?.kind).toBe('invalid');
  });
  it('keeps every site selectable regardless of its display languages and preserves choices when name language changes',()=>{
    const {session,deps}=setup({},[site('japanese',['ja']),site('english',['en']),site('unknown',[])]);
    session.setSelected('english:english',false);session.setTargetLanguage('zh-Hant');
    expect(session.getSnapshot().sites.map(state=>state.selected)).toEqual([true,false,true]);
    session.setSelected('english:english',true);expect(session.getSnapshot().sites.every(state=>state.selected)).toBe(true);
    expect(deps.listSites).toHaveBeenCalledTimes(1);
  });
  it('streams arrival order with no more than three concurrent sites and preserves same-name cross-site candidates',async()=>{
    const pending=new Map<string,ReturnType<typeof deferred<SourceSearchResults>>>();let running=0,max=0;
    const {session}=setup({search:vi.fn((id)=>{running++;max=Math.max(max,running);const request=deferred<SourceSearchResults>();pending.set(id,request);return request.promise.finally(()=>running--);})},['a','b','c','d','e'].map(id=>site(id)));
    session.searchManual('共同名称');await flush();expect([...pending.keys()]).toEqual(['a','b','c']);
    pending.get('b')!.resolve(page('b','same'));await flush();
    expect(session.getSnapshot().results.map(result=>result.sourceId)).toEqual(['b']);expect(pending.has('d')).toBe(true);
    pending.get('a')!.resolve(page('a','same'));await flush();expect(pending.has('e')).toBe(true);
    pending.get('e')!.resolve(page('e'));pending.get('d')!.resolve(page('d'));pending.get('c')!.resolve(page('c'));await flush();
    expect(max).toBe(3);expect(session.getSnapshot().results.map(result=>result.sourceId)).toEqual(['b','a','e','d','c']);expect(session.getSnapshot().phase).toBe('settled');
  });
  it('sends the selected language only to name translation and searches with the returned name, caching name resolution',async()=>{
    const search=vi.fn<ComicSearchDependencies['search']>(async id=>page(id));const {session,deps}=setup({translateTitle:vi.fn().mockResolvedValue({name:'English Name',target_language:'en'}),search});
    await session.searchWithTranslatedTitle();await flush();
    expect(session.getSnapshot()).toMatchObject({requestedTitleLanguage:'zh',resolvedTitleLanguage:'en',query:'English Name'});
    expect(deps.translateTitle).toHaveBeenCalledWith('日本語名','zh-Hans',expect.any(AbortSignal));
    expect(search.mock.calls.map(call=>call[1])).toEqual([{siteId:'a',query:'English Name'},{siteId:'b',query:'English Name'}]);
    await session.searchWithTranslatedTitle();await flush();expect(deps.translateTitle).toHaveBeenCalledTimes(1);
  });
  it('keeps all returned content languages as optional display data without filtering or inferring missing languages',async()=>{
    const {session,deps}=setup({search:vi.fn(async id=>({items:[{...hit(id,'japanese'),contentLanguages:['ja']},{...hit(id,'english'),contentLanguages:['en']},hit(id,'unknown')]}))},[site('a',['zh'])]);
    session.searchManual('同じ名前');await flush();
    expect(deps.translateTitle).not.toHaveBeenCalled();
    expect(session.getSnapshot().results.map(result=>({id:result.catalogId,languages:result.contentLanguages}))).toEqual([
      {id:'japanese',languages:['ja']},{id:'english',languages:['en']},{id:'unknown',languages:undefined},
    ]);
  });
  it('waits for explicit manual input when title resolution returns null and supports manual search after 401',async()=>{
    const {session,deps}=setup({translateTitle:vi.fn().mockResolvedValueOnce({name:null,target_language:null}).mockRejectedValueOnce(new ApiError('Login','AUTH_REQUIRED',401))});
    await session.searchWithTranslatedTitle();expect(session.getSnapshot()).toMatchObject({phase:'needs-query',titleState:'missing',query:''});expect(deps.search).not.toHaveBeenCalled();
    session.setSourceTitle('別作品');await session.searchWithTranslatedTitle();expect(session.getSnapshot().titleError?.kind).toBe('login');
    session.searchManual('手动名称');await flush();expect(session.getSnapshot().results).toHaveLength(2);expect(deps.translateTitle).toHaveBeenCalledTimes(2);
  });
  it('keeps oversized resolved names editable instead of applying the API input length budget or searching an oversized query',async()=>{
    const resolve=vi.fn().mockResolvedValueOnce({name:'名'.repeat(80),target_language:'zh-Hans'}).mockResolvedValueOnce({name:'名'.repeat(180),target_language:'zh-Hans'});
    const {session,deps}=setup({translateTitle:resolve});await session.searchWithTranslatedTitle();await flush();expect(deps.search).toHaveBeenCalledTimes(2);
    session.setSourceTitle('另一作品');await session.searchWithTranslatedTitle();expect(session.getSnapshot().query).toHaveLength(180);expect(session.getSnapshot().phase).toBe('needs-query');expect(deps.search).toHaveBeenCalledTimes(2);
  });
  it('keeps rate-limit countdowns across manual queries and condition changes',async()=>{
    vi.useFakeTimers();vi.setSystemTime(1_000);
    const translate=vi.fn().mockRejectedValue(new ApiError('Rate limited','RATE_LIMITED',429,undefined,30));
    const search=vi.fn().mockRejectedValue({code:'SOURCE_SEARCH_RATE_LIMITED',retryAfter:20});
    const {session}=setup({translateTitle:translate,search});await session.searchWithTranslatedTitle();
    session.searchManual('手填');await flush();session.setSourceTitle('另一个名字');await session.searchWithTranslatedTitle();expect(translate).toHaveBeenCalledTimes(1);
    session.searchManual('另一个关键词');await flush();expect(search).toHaveBeenCalledTimes(2);expect(session.getSnapshot().sites.every(state=>state.error?.kind==='rate-limit')).toBe(true);
    await vi.advanceTimersByTimeAsync(30_001);await session.searchWithTranslatedTitle();expect(translate).toHaveBeenCalledTimes(2);
  });
  it('retries only a failed site and appends cursor pages without resolving names again',async()=>{
    const slow=deferred<SourceSearchResults>();let a=0;
    const search=vi.fn((id:string,request:{cursor?:string})=>id==='b'?slow.promise:++a===1?Promise.reject(new Error('temporary')):Promise.resolve(request.cursor?{items:[{...hit('a'),authors:['Updated']},hit('a','second')]}:{...page('a'),nextCursor:'bound-cursor'}));
    const {session,deps}=setup({search});await session.searchWithTranslatedTitle();await flush();
    expect(session.getSnapshot().sites[0].status).toBe('error');session.retrySite('a:a');await flush();
    expect(session.getSnapshot().sites[1].status).toBe('running');expect(search.mock.calls.filter(call=>call[0]==='b')).toHaveLength(1);
    session.loadMore('a:a');await flush();expect(session.getSnapshot().results.map(result=>result.catalogId)).toEqual(['a','second']);expect(session.getSnapshot().results[0].authors).toEqual(['Updated']);
    expect(search.mock.calls.at(-1)?.[1].cursor).toBe('bound-cursor');expect(deps.translateTitle).toHaveBeenCalledTimes(1);
    slow.resolve(page('b'));await flush();expect(session.getSnapshot().results.map(result=>result.sourceId)).toEqual(['a','a','b']);
  });
  it('retains the first mirror destination and tracks each site hit independently while enriching optional fields',async()=>{
    const mirror={...site('mirror'),adapterId:'a'},slow=deferred<SourceSearchResults>();
    const {session}=setup({search:vi.fn((_id,request)=>request.siteId==='mirror'?slow.promise:Promise.resolve(page('a')))},[site('a'),mirror]);
    session.searchManual('same');await flush();const first=session.getSnapshot().results[0];
    slow.resolve({items:[{...hit('a'),siteId:'mirror',catalogUrl:'https://mirror.example/comic/a',authors:['Known author'],cover:{url:'https://mirror.example/cover.jpg'},contentLanguages:['ja']}]});await flush();
    expect(session.getSnapshot().results).toHaveLength(1);expect(session.getSnapshot().results[0]).toMatchObject({siteId:'a',catalogUrl:first.catalogUrl,authors:['Known author'],contentLanguages:['ja']});
    expect(session.getSnapshot().sites.map(state=>({count:state.resultCount,keys:state.resultKeys}))).toEqual([{count:1,keys:[first.key]},{count:1,keys:[first.key]}]);
  });
  it('maps runtime timeouts and retries a failed later page using its cursor without application preflights',async()=>{
    let calls=0;
    const search=vi.fn((_id:string,request:{cursor?:string})=>++calls===1?Promise.reject({code:'SOURCE_SEARCH_TIMEOUT'}):calls===2?Promise.resolve({...page('a'),nextCursor:'next'}):calls===3?Promise.reject(new Error('page error')):Promise.resolve({items:[hit('a',request.cursor??'wrong')]}));
    const {session}=setup({search},[site('a')]);session.searchManual('x');await flush();expect(session.getSnapshot().sites[0].error?.kind).toBe('timeout');
    session.retrySite('a:a');await flush();expect(session.getSnapshot().results.map(result=>result.catalogId)).toEqual(['a']);
    session.loadMore('a:a');await flush();expect(session.getSnapshot().sites[0].status).toBe('error');session.retrySite('a:a');await flush();expect(search.mock.calls.at(-1)?.[1].cursor).toBe('next');expect(session.getSnapshot().results.map(result=>result.catalogId)).toEqual(['a','next']);
  });
  it('restarts only the affected site from its first page after its cursor expires',async()=>{
    const search=vi.fn<ComicSearchDependencies['search']>(async(id,request)=>{
      if(request.cursor)throw {code:'SOURCE_SEARCH_CURSOR_EXPIRED'};
      return {...page(id),nextCursor:id==='a'?'expired':undefined};
    });
    const {session}=setup({search});session.searchManual('name');await flush();session.loadMore('a:a');await flush();
    expect(session.getSnapshot().sites[0]).toMatchObject({status:'error',nextCursor:undefined,requestCursor:undefined});
    expect(session.getSnapshot().results).toHaveLength(2);
    session.loadMore('a:a');expect(search).toHaveBeenCalledTimes(3);
    session.retrySite('a:a');await flush();
    expect(search.mock.calls.filter(call=>call[0]==='a').map(call=>call[1].cursor)).toEqual([undefined,'expired',undefined]);
    expect(search.mock.calls.filter(call=>call[0]==='b')).toHaveLength(1);
    expect(session.getSnapshot().sites[0].status).toBe('ready');
    expect(session.getSnapshot().results).toHaveLength(2);
  });
  it('cancels late name/site responses, preserves arrived results on stop, and clears old results on language change',async()=>{
    const slow=deferred<SourceSearchResults>();let b=0;
    const {session}=setup({search:vi.fn(id=>id==='b'&&++b===1?slow.promise:Promise.resolve(page(id)))});
    session.searchManual('one');await flush();session.stop();expect(session.getSnapshot().results.map(result=>result.sourceId)).toEqual(['a']);
    slow.resolve(page('b','late'));await flush();expect(session.getSnapshot().results).toHaveLength(1);
    session.setTargetLanguage('en');expect(session.getSnapshot().results).toHaveLength(0);expect(session.getSnapshot().query).toBe('');
    const name=deferred<{name:string;target_language:string}>();const other=setup({translateTitle:()=>name.promise}).session;
    const request=other.searchWithTranslatedTitle();other.setSourceTitle('new');name.resolve({name:'stale',target_language:'en'});await request;expect(other.getSnapshot().query).toBe('');expect(other.getSnapshot().sourceTitle).toBe('new');
  });
  it('surfaces browser-revoked access as an error without authorization work and retries only the failed site',async()=>{
    let allowed=false;const search=vi.fn<ComicSearchDependencies['search']>(async id=>{if(id==='b'&&!allowed)throw {code:'SOURCE_SEARCH_PERMISSION_REQUIRED'};return page(id);});
    const {session}=setup({search});session.searchManual('one');await flush();
    expect(session.getSnapshot().sites[1]).toMatchObject({status:'error',error:{kind:'permission'}});
    expect(session.getSnapshot().results.map(result=>result.sourceId)).toEqual(['a']);
    session.stop();allowed=true;await flush();expect(search).toHaveBeenCalledTimes(2);
    session.retrySite('b:b');await flush();expect(session.getSnapshot().results).toHaveLength(2);
    expect(search.mock.calls.map(call=>call[0])).toEqual(['a','b','b']);
  });
});
