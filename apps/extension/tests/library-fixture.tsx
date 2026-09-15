/** UI-only fixture. Run on a separate Vite origin, never the user's library origin.
 * Real storage and components; synthetic acquisition states, no translation requests.
 */
import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from '../src/App';
import {CatalogImport} from '../src/ui/CatalogImport';
import {attachCopy,makeCopy} from '../src/library/model';
import {emptyPage} from '../src/reader/model';
import * as store from '../src/library/store';
import type {SourceCatalog} from '../src/library/types';
import {seedCardLayout,TranslationCardFixture} from './library-card-fixture';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';

if(location.port!=='5175')throw Error('请在独立的 5175 端口打开验收页，避免改动日常漫画库。');
const previous=await store.readLibrary();
if(!localStorage.getItem('nc-library-fixture')&&previous.works.some(w=>w.evidence.source!=='漫画管理隔离验收'&&w.evidence.source!=='用户管理'))throw Error('验收来源已有其他漫画，停止写入。');
const source:SourceCatalog={id:'fixture-catalog',sourceId:'mangacopy',url:'https://www.mangacopy.com/comic/fixture',title:'星光书店',observedAt:Date.now(),complete:true,note:'隔离样本目录 · 不访问漫画站点',groups:[{id:'main',title:'连载章节',entryIds:Array.from({length:48},(_,n)=>'fixture-entry-'+n),complete:true},{id:'books',title:'单行本',entryIds:['fixture-volume-1','fixture-volume-2'],complete:true}],entries:[...Array.from({length:48},(_,n)=>({id:'fixture-entry-'+n,catalogId:'fixture-catalog',remoteId:'fixture-'+n,url:'https://www.mangacopy.com/comic/fixture/chapter/'+n,title:'第 '+(n+1)+' 话 · '+['雨后的来信','夜间营业','旅行的猫','未寄出的明信片'][n%4],groupIds:['main'],rawTypes:['話'],order:n,related:false})),...[1,2].map(n=>({id:'fixture-volume-'+n,catalogId:'fixture-catalog',remoteId:'fixture-volume-'+n,url:'https://www.mangacopy.com/comic/fixture/chapter/volume-'+n,title:'第 '+n+' 卷',groupIds:['books'],rawTypes:['卷'],order:48+n,related:false}))],excludedEntryIds:[]};
if(!previous.works.length){
 const blob=await(await fetch('/samples/starlight-bookshop.png')).blob();
 const bitmap=await createImageBitmap(blob),width=bitmap.width,height=bitmap.height;bitmap.close();
 await store.putBlob('fixture-cover',blob);
 const pages=(cached=3)=>Array.from({length:3},(_,n)=>({...emptyPage('原创样本第 '+(n+1)+' 页',width,height),blobKey:n<cached?'fixture-cover':undefined,sourceUrl:'https://images.example/fixture-'+n+'.png'}));
 await store.editLibrary((state,copies)=>{
  const evidence={status:'user' as const,source:'漫画管理隔离验收'};
  let workId='';
  for(let n=0;n<12;n++){
   const entry=source.entries[n],copy=makeCopy(entry.title,pages(n===2?1:n===4?0:3),'MangaCopy','fixture-copy-'+n);
   copy.sourceEntryId=entry.id;copy.sourceUrl=entry.url;copy.knownTotal=3;
   copy.createdAt=1700000000000+n*1000;copy.updatedAt=copy.createdAt;
   workId=attachCopy(state,copy,{title:'星光书店',workId:workId||undefined,kind:n===11?'extra':'chapter',number:String(n+1)});copies.push(copy);
   const chapter=state.chapters.at(-1)!;chapter.role=n===11?'extra':'main';if(n<2)chapter.readAt=1700000000000;
   if(n===0){copy.lastReadAt=1700000000000;state.works[0].preferredCopyId=copy.id;}
   if(n===2)state.tasks.push({id:'fixture-failed',copyId:copy.id,status:'failed',phase:'images',completed:1,total:3,error:'需要授权图片域名。点击“授权并继续”后获取原图。',updatedAt:Date.now()});
   if(n===4)state.tasks.push({id:'fixture-paused',copyId:copy.id,status:'paused',phase:'discover',completed:0,total:3,error:'已暂停，点击继续恢复。',updatedAt:Date.now()});
  }
  source.workId=workId;state.catalogs.push(source);
  const variant=makeCopy(source.entries[0].title+' · 中文版',pages(),'本地导入','fixture-variant');
  attachCopy(state,variant,{workId,title:'星光书店',kind:'chapter',targetId:state.chapters[0].id});copies.push(variant);
  state.versions.push({id:'fixture-original',workId,title:'日文原版',language:'ja',evidence},{id:'fixture-zh',workId,title:'中文译本',language:'zh',translator:'验收样本',evidence});
  copies[0].versionId='fixture-original';variant.versionId='fixture-zh';
  for(const n of [1,2]){const copy=makeCopy('第 '+n+' 卷',pages(),'本地导入','fixture-volume-copy-'+n);attachCopy(state,copy,{workId,title:'星光书店',kind:'publication',number:String(n)});copies.push(copy);}
  const material=makeCopy('设定资料集',pages(),'本地导入','fixture-material');attachCopy(state,material,{workId,title:'星光书店',kind:'unclassified'});copies.push(material);
  for(const title of ['海风日记','小镇放映室']){const copy=makeCopy(title,pages(),'原创验收样本','fixture-work-'+title);attachCopy(state,copy,{title,kind:'work'});copies.push(copy);}
  state.works.forEach((w,n)=>{w.evidence=evidence;w.updatedAt=1700000000000+n*1000;w.createdAt=w.updatedAt;});
 });
 store.saveSettings({...store.settings(),apiBase:'http://127.0.0.1:18099',appearance:'light'});
}
localStorage.setItem('nc-library-fixture','v1');
if(new URLSearchParams(location.search).has('cards'))await seedCardLayout();
const fixtureLibrary=await store.readLibrary(),fixtureCopies=await store.readCopies();

function CatalogFixture(){
 const [library,setLibrary]=useState(fixtureLibrary),[copies,setCopies]=useState(fixtureCopies),[notice,setNotice]=useState(''),[closed,setClosed]=useState(false);
 const reload=async()=>{setLibrary(await store.readLibrary());setCopies(await store.readCopies());};
 useEffect(()=>{void reload();},[]);
 if(closed)return <><App/>{notice&&<div className="toast" role="status">{notice}</div>}</>;
 return <div className="nc-app"><main className="nc-main"><CatalogImport catalog={source} library={library} copies={copies} onDone={()=>void reload()} onClose={()=>setClosed(true)} onNotice={setNotice} onRefresh={async()=>{await reload();setNotice('来源目录已刷新');}}/>{notice&&<p role="status">{notice}</p>}</main></div>;
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('translations')?<TranslationCardFixture copies={fixtureCopies}/>:new URLSearchParams(location.search).has('catalog')?<CatalogFixture/>:<App/>);
