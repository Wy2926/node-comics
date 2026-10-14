/** Generated pages, real indexing/materialization/export, no remote services. */
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {catalog} from '../src/comics/repositories';
import type {Comic,Entry,SourceConnection} from '../src/comics/domain';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {DocumentExport} from '../src/ui/DocumentExport';
import {Scrollbars} from '../src/ui/Scrollbars';
import {defaults} from '../src/types';
import {installDictionary} from '../src/i18n/runtime';
import type {UiLocale} from '../src/i18n/locales';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

if(location.hostname!=='127.0.0.1'||location.port!=='5181')throw Error('Use the isolated 127.0.0.1:5181 fixture origin.');
const query=new URLSearchParams(location.search),locale=query.get('locale') as UiLocale|null;
if(locale)installDictionary(locale,await fetch(`/i18n/${locale}.json`).then(response=>response.json()));
document.documentElement.dataset.appearance=query.get('theme')??'light';
document.documentElement.style.setProperty('--text-scale',query.get('scale')??'1');
const connection:SourceConnection={id:'directory-fixture',provider:'directory-fixture',displayName:'Synthetic',status:'connected',generation:1,createdAt:1,updatedAt:1};
const comic:Comic={id:'directory-book',title:'星海漫游 · 完整章节目录',sourceName:'Synthetic',sourceKey:'directory-fixture',source:{connectionId:connection.id,providerItemId:'book',locator:{},status:'active',generation:1},createdAt:1,updatedAt:1,lastEntryId:'chapter-2',lastReadAt:123,lastPage:2,lastPageCount:2};
const entries:Entry[]=Array.from({length:3},(_,order)=>({id:`chapter-${order+1}`,contentId:`content-${order+1}`,comicId:comic.id,title:`第 ${order+1} 话 · 星海漫游`,order,sequenceId:'main',readingSlotId:String(order),contentLanguage:'zh-Hans',format:'image-sequence',generation:1,indexState:'pending',createdAt:1,updatedAt:1}));
entries.push({...entries[1],id:'alternate',contentId:'alternate',title:'Chapter 2 · English',contentLanguage:'en',sourceOrder:10});
await catalog.put('connections',connection);await catalog.put('comics',comic);
for(const entry of entries)await catalog.put('entries',entry);
await catalog.put('positions',{id:entries[1].id,entryId:entries[1].id,comicId:comic.id,contentId:entries[1].contentId,pageId:'page-1',relativeOffset:.42,updatedAt:123});
const pages:Blob[]=[],stats={indexes:[] as string[],reads:[] as string[],active:0,maximum:0};
for(let i=0;i<6;i++){
  const canvas=new OffscreenCanvas(320,480),ctx=canvas.getContext('2d')!;
  ctx.fillStyle=['#1769b3','#287d73','#8c4d9e'][Math.floor(i/2)];ctx.fillRect(0,0,320,480);ctx.fillStyle='#fff';ctx.font='32px sans-serif';ctx.fillText(`Chapter ${Math.floor(i/2)+1}`,32,100);ctx.fillText(`Page ${i%2+1}`,32,160);
  pages.push(await canvas.convertToBlob({type:'image/png'}));
}
let fail=query.has('fail');
const pause=async(signal?:AbortSignal)=>{
  if(query.has('slow'))await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},350);
    const cancel=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  });
  signal?.throwIfAborted();
};
registerSourceDriver({id:connection.provider,label:'Synthetic',cachePages:false,cacheRanges:false,pages:{
  async index(context){stats.indexes.push(context.entryId);await pause(context.signal);return {complete:true,total:2,pages:[0,1].map(ordinal=>({ordinal,name:`${ordinal+1}.png`,locator:{ordinal}}))};},
  async read(context,page){stats.reads.push(context.entryId);stats.active++;stats.maximum=Math.max(stats.maximum,stats.active);
    try{await pause(context.signal);if(fail&&context.entryId===entries[1].id){fail=false;throw Error('模拟章节图片读取失败，请重试');}return pages[entries.find(entry=>entry.id===context.entryId)!.order*2+page.ordinal];}finally{stats.active--;}
  },
}});
Object.assign(window,{directoryFixture:{stats,async reading(){const saved=(await catalog.get('comics',comic.id))!;return {lastEntryId:saved.lastEntryId,lastReadAt:saved.lastReadAt,lastPage:saved.lastPage,lastPageCount:saved.lastPageCount,position:await catalog.get('positions',entries[1].id)};}}});
function Fixture(){const [open,setOpen]=useState(false);return <div className="nc-app" style={{minHeight:1800,padding:24}}><Scrollbars/><h1>整目录导出隔离夹具</h1><button id="open-export" className="button primary" onClick={()=>setOpen(true)}>打开导出</button>{open&&<DocumentExport document={entries[0]} settings={defaults} onClose={()=>setOpen(false)}/>}</div>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
