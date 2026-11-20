import 'fake-indexeddb/auto';
import {parseHTML} from 'linkedom';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {listSupportedSites,validateSourceCatalog} from '../src/sources';
import {network} from '../src/sources/sites/structured-chapters/network';
import {readNetworkPages} from '../src/sources/runtime/network';
import {openLinkedReader,takeLinkedReader,forgetLinkedReader} from '../src/sources/runtime/link-handoff';
import {importWebsiteLink} from '../src/comics/application/website-import';
import {catalog} from '../src/comics/repositories';
import {continueEntry,saveReaderState} from '../src/comics/application/library-service';
import {openTemporaryChapter,temporaryPage} from '../src/comics/pages/temporary';
import {parsePageReference} from '../src/comics/pages/identity';

vi.mock('../src/sources/runtime/image-headers',()=>({withImageHeaders:(_url:unknown,_headers:unknown,_signal:unknown,read:()=>unknown)=>read()}));
const work='https://one.example.test/comics/7',other=work.replace('one.','two.'),chapter=work+'/chapters/1';
const ids=(page:number)=>Array.from({length:page<3?20:5},(_,i)=>45-(page-1)*20-i);
const rows=(url:string,ids:number[])=>ids.map(id=>`<a data-chapter-id="${id}" href="${url}/chapters/${id}"><span class="truncate">Part ${id}</span></a>`).join('');
const landing=(url:string)=>`<h1>Paper book</h1><section id="chapters" data-chapter-sort-scope data-chapters-url="${url}/chapters" data-chapter-next-page="2" data-chapter-page-size="20"><h2>Parts</h2><span>Total: 45</span>${rows(url,ids(1))}</section>`;
const batch=(url:string,page:number)=>({html:rows(url,ids(page)),current_page:page,total:45,last_page:3,has_more:page<3,next_page:page<3?page+1:null});
const reader=`<h1>Part one</h1><img src="/ad"><section data-reader-shell data-reader-chapter-id="1"><div data-reader-canvas><aside><img data-reader-image src="/ad"></aside>
  <div data-reader-page><img data-reader-image src="/asset?token=fixture-only" width="200" height="300"></div></div></section>`;
const fetcher=vi.fn(async(target:string)=>{
  const url=new URL(target),base=url.origin+'/comics/7';
  if(url.pathname==='/comics/7')return new Response(landing(base));
  if(url.pathname==='/comics/7/chapters')return Response.json(batch(base,Number(url.searchParams.get('page'))));
  if(target===chapter)return new Response(reader);
  if(url.pathname==='/asset')return new Response('synthetic bytes');
  throw Error('Unexpected fixture request');
});
const registered=vi.fn();
beforeEach(()=>{
  fetcher.mockClear();registered.mockClear();
  vi.stubGlobal('document',parseHTML('<html></html>').document);
  vi.stubGlobal('fetch',fetcher);
  vi.stubGlobal('chrome',{runtime:{id:'test'},permissions:{contains:async()=>true},storage:{local:{set:registered}}});
});
afterEach(async()=>{
  for(const comic of await catalog.list('comics'))await catalog.deleteComic(comic.id);
  vi.restoreAllMocks();vi.unstubAllGlobals();
});

it('reads to the last page before publishing any entries and preserves the book and position on reimport',async()=>{
  const a=await importWebsiteLink(work+'/?token=fixture-only#top');
  expect(fetcher.mock.calls.map(([url])=>new URL(url).searchParams.get('page'))).toEqual([null,'2','3']);
  const snapshot=validateSourceCatalog(await catalog.get('catalogs',a.source.providerItemId));
  expect(snapshot).toMatchObject({complete:true,url:work});
  expect(snapshot.entries.map(e=>e.title)).toEqual(Array.from({length:45},(_,n)=>'Part '+(n+1)));
  const {id,comicId,contentId}=(await catalog.listEntries(a.id))[11],pageId='saved-slot';
  await catalog.put('pageDescriptors',{contentId,pageId,ordinal:0,name:'Paper',locator:{sourceId:'page-1'},formatLocator:'page-1'});
  const position={id,entryId:id,comicId,contentId,pageId,relativeOffset:.6,updatedAt:1234};
  await catalog.savePosition(position);
  expect((await importWebsiteLink(work)).id).toBe(a.id);
  const b=await importWebsiteLink(other);expect(b.id).not.toBe(a.id);expect(b.sourceName).not.toBe(a.sourceName);
  expect(await continueEntry(a.id)).toMatchObject({id});
  expect(await catalog.get('positions',id)).toEqual(position);
  expect((await catalog.list('comics')).length).toBe(2);
  expect(()=>validateSourceCatalog({...snapshot,entries:snapshot.entries.map(e=>({...e,url:e.url.replace(work,other)}))})).toThrow();
  expect(listSupportedSites().some(site=>site.adapterId===snapshot.sourceId)).toBe(false);
  expect(JSON.stringify(snapshot)).not.toContain('token=');
});

it.each(['short','duplicate','foreign work','early end','loop','missing total'])('rejects %s pagination without importing a prefix',async(fault)=>{
  const bad=batch(work,2);
  if(fault==='short')bad.html=rows(work,[25]);
  if(fault==='duplicate')bad.html=rows(work,ids(1));
  if(fault==='foreign work')bad.html=rows(other,ids(2));
  if(fault==='early end')bad.has_more=false;
  if(fault==='loop')bad.next_page=2;
  if(fault==='missing total')bad.total=0;
  fetcher.mockResolvedValueOnce(new Response(landing(work))).mockResolvedValueOnce(Response.json(bad));
  await expect(importWebsiteLink(work)).rejects.toThrow();
  expect(await catalog.list('comics')).toEqual([]);
});

it('cancels between catalog pages without publishing, and can retry from the start',async()=>{
  const controller=new AbortController();
  fetcher.mockResolvedValueOnce(new Response(landing(work))).mockImplementationOnce(async()=>{
    controller.abort();return Response.json(batch(work,2));
  });
  await expect(importWebsiteLink(work,{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
  expect(await catalog.list('comics')).toEqual([]);expect(fetcher).toHaveBeenCalledTimes(2);
  const book=await importWebsiteLink(work);expect(await catalog.listEntries(book.id)).toHaveLength(45);
});

it('paginates the observed series protocol, binds every row to its parent and keeps locked chapters in the directory',async()=>{
  const url='https://example.test/series/paper',endpoint='https://api.example.test/chapter/query';
  const html=(slug:string)=>{
    const props={series_id:4,series_type:'Comic',series:{id:4,series_slug:slug,title:'Paper',meta:{chapters_count:'3'}}};
    return `<div role="tabpanel" id="one-content-chapters_list"></div><script>self.__next_f.push(${JSON.stringify([1,'1:'+JSON.stringify(['component',props])+'\n'])})</script>`;
  };
  const readDocument=vi.fn(async()=>JSON.stringify({endpoint,links:[]}));
  const row=(n:number)=>({chapter_slug:`part-${n}`,chapter_name:`Part ${n}`,series:{id:4,series_slug:'paper'},price:n===3?1:0});
  const response=(page:number,data:unknown[])=>JSON.stringify({meta:{current_page:page,per_page:2,last_page:2,total:3},data});
  const request=vi.fn(async(target:string)=>target===url?html('paper'):new URL(target).searchParams.get('page')==='1'?response(1,[row(3),row(2)]):response(2,[row(1)]));
  const snap=validateSourceCatalog(await network.catalog!(url,{readDocument,request}));
  expect(request).toHaveBeenCalledTimes(3);expect(readDocument).toHaveBeenCalledWith(expect.any(Function),{seriesId:4,total:3});
  expect(snap.entries.map(e=>[e.title,e.readable])).toEqual([['Part 1',true],['Part 2',true],['Part 3',false]]);
  expect(snap.defaultEntryId).toBe(snap.entries[0].id);
  await expect(network.catalog!(url,{readDocument,request:async target=>target===url?html('paper'):response(1,[row(3),{...row(2),series:{id:5,series_slug:'other'}}])})).rejects.toThrow();
  await expect(network.catalog!(url,{readDocument,request:async target=>target===url?html('paper'):response(2,[row(1)])})).rejects.toThrow();
  readDocument.mockClear();
  await expect(network.catalog!(url,{readDocument,request:async()=>html('other')})).rejects.toThrow();
  expect(readDocument).not.toHaveBeenCalled();
});

it.each(['menu','numbered','counted'] as const)('verifies the %s directory before importing and reads only indexed images',async layout=>{
  const menu=layout==='menu',numbered=layout==='numbered';
  const book=new URL(menu?'/manga/paper':numbered?'/comic/paper.html':'/read-book/paper',work).href;
  const part=(n:number)=>menu?`${book}/chapter-${n}`:numbered?`${book.slice(0,-5)}/chapter-${70+n}.html`:`${book}-chapter-${n}${n===2?'-the-end':''}-ch${70+n}`;
  const newest=part(2),oldest=part(1),canonical=(url:string)=>`<link rel="canonical" href="${url}">`;
  const catalogHtml=(prefix=false)=>{
    const parts=prefix?[1]:[2,1],top=prefix?oldest:newest;
    const rows=parts.map(n=>menu?`<li><a class="chapter-name" href="${part(n)}">Part ${n}</a></li>`:numbered?
      `<li><a href="${part(n)}">第${n}話</a></li>`:`<a class="${part(n)===top?'is-latest':''}" data-name="Part ${n}" href="${part(n)}">Part ${n}</a>`).join('');
    return canonical(book)+'<h1>Paper</h1><a href="/other">Related</a>'+(menu?
      `<a id="btn-read-first" href="${top}"></a><a id="btn-read-last" href="${oldest}"></a><div id="chapterlist"><ul class="row-content-chapter">${rows}</ul></div>`:numbered?
      `<a id="Subscribe_bak" href="${oldest}"></a><div id="list"><ul id="mh-chapter-list-ol-0">${rows}</ul></div>`:
      `<section id="chapters"><h2><small>2 chapters</small></h2><div id="chapter-list">${rows}</div></section>`);
  };
  const chapterHtml=(url:string,skipFirst=false)=>{
    const pages=(skipFirst?[2]:[1,2]).map(n=>menu?`<div class="page-break"><img class="p${n}" data-src="/asset/${n}"></div>`:numbered?
      `<div class="img-wrap"><img data-index="${n-1}" data-src="/asset/${n}"></div>`:`<img data-page="${n}" src="/asset/${n}">`).join('');
    return canonical(url)+'<h1>Part</h1><img src="/ad">'+(menu?
      `<select class="navi-change-chapter">${[newest,oldest].map(u=>`<option data-c="${u}" ${u===url?'selected':''}></option>`).join('')}</select><div class="read-manga"><div class="read-content">${pages}</div></div>`:numbered?
      `<a id="k_Pic_backArr" href="${book}"></a>${url===newest?`<a id="k_Pic_upArr" href="${oldest}"></a>`:`<a id="k_Pic_nextArr" href="${newest}"></a>`}<div id="currentCache"><div class="view-imgBox">${pages}</div></div>`:
      `<div data-reader data-comic-url="${book}"><div data-pages>${pages}</div></div>`);
  };
  let landing=catalogHtml();
  const request=vi.fn(async(url:string)=>url===book?landing:[newest,oldest].includes(url)?chapterHtml(url):Promise.reject(Error('unexpected request')));
  const snap=validateSourceCatalog(await network.catalog!(book,{request}));
  expect(snap.entries.map(e=>e.url)).toEqual([oldest,newest]);
  expect(snap.defaultEntryId).toBe(snap.entries[0].id);
  expect(request.mock.calls.map(([url])=>url)).toEqual(layout==='counted'?[book]:[book,newest]);
  const pages=await network.pages!(newest,{request});
  expect(pages.items.map(p=>p.resource)).toEqual([1,2].map(n=>({kind:'http',url:new URL('/asset/'+n,work).href})));
  landing=catalogHtml(true);
  await expect(network.catalog!(book,{request})).rejects.toThrow();
  await expect(network.catalog!(book,{request:async()=>catalogHtml().replaceAll(oldest,oldest.replace(new URL(work).origin,new URL(other).origin))})).rejects.toThrow();
  await expect(network.pages!(newest,{request:async()=>chapterHtml(newest,true)})).rejects.toThrow();
});

it('revokes temporary page access and only registers stable locators for shelf reads',async()=>{
  const controller=new AbortController(),copy=await openTemporaryChapter(chapter,controller.signal);
  expect(copy.pages).toHaveLength(1);expect(JSON.stringify(copy)).not.toContain('token=');
  const ref=parsePageReference(copy.pages[0].blobKey!)!,page=temporaryPage(ref);
  expect(()=>temporaryPage({...ref,pageId:'outside-this-chapter'})).toThrow();
  expect(await (await page.read(controller.signal)).text()).toBe('synthetic bytes');
  await saveReaderState({...copy,lastReadAt:300,relativeOffset:.9});
  expect(await catalog.list('positions')).toEqual([]);
  controller.abort();expect(()=>temporaryPage(ref)).toThrow();await expect(page.validate()).rejects.toThrow();
  await expect(page.read(new AbortController().signal)).rejects.toMatchObject({name:'AbortError'});
  expect(registered).not.toHaveBeenCalled();
  const manifest=await readNetworkPages(chapter);
  expect(manifest.items).toMatchObject([{url:chapter+'#page-1',contentKey:'page-1'}]);
  expect(JSON.stringify(registered.mock.calls)).not.toContain('token=');
  fetcher.mockResolvedValueOnce(new Response(reader.replace('data-reader-chapter-id="1"','data-reader-chapter-id="2"')));
  await expect(openTemporaryChapter(chapter,new AbortController().signal)).rejects.toThrow();
  await expect(importWebsiteLink(chapter)).rejects.toThrow();
});

it('scopes a one-shot launch to its reader tab and discards closed or failed launches',async()=>{
  const update=vi.fn(async()=>{}),remove=vi.fn(async()=>{});
  vi.stubGlobal('chrome',{runtime:{getURL:(s:string)=>'chrome-extension://fixture'+s},tabs:{get:async()=>({url:chapter}),create:async()=>({id:10}),update,remove}});
  await openLinkedReader(chapter,1);expect(()=>takeLinkedReader(11)).toThrow();expect(takeLinkedReader(10)).toBe(chapter);expect(()=>takeLinkedReader(10)).toThrow();
  await openLinkedReader(chapter,1);forgetLinkedReader(10);expect(()=>takeLinkedReader(10)).toThrow();
  update.mockRejectedValueOnce(Error('closed'));await expect(openLinkedReader(chapter,1)).rejects.toThrow('closed');expect(()=>takeLinkedReader(10)).toThrow();
  await expect(openLinkedReader(chapter+'/changed',1)).rejects.toThrow();
});
