import {useState} from 'react';
import {attachCopy,makeCopy} from '../src/library/model';
import {editLibrary} from '../src/library/store';
import {emptyPage} from '../src/reader/model';
import type {Job,ReadingCopy} from '../src/types';
import {TranslationCopies} from '../src/ui/library/TranslationCopies';

const longTitle='星光书店与未寄出的明信片：穿过夏日雨幕之后，我们终于再次遇见了那位远行的朋友';
const longSource='原创漫画布局隔离验收来源 / AVeryLongUnbrokenSourceNameForCardLayout';
/** Synthetic length extremes only; the calling fixture enforces its isolated origin. */
export async function seedCardLayout(){
 await editLibrary((state,copies)=>{
  if(state.relations.some(r=>r.id.startsWith('layout-')))return;
  const work=state.works[0],evidence={status:'user' as const,source:'漫画管理隔离验收'};
  for(const [n,title] of ['短篇',longTitle,'AVeryLongUnbrokenComicTitleWithoutSpacesForLayoutVerification','没有封面的故事'].entries()){
   const page=emptyPage('原创样本',800,1200);page.blobKey=n===3?'layout-missing-cover':'fixture-cover';
   const copy=makeCopy(title,[page],longSource,'layout-work-'+n);
   const id=attachCopy(state,copy,{title,kind:'work'});copies.push(copy);
   state.works.find(w=>w.id===id)!.evidence=evidence;
  }
  state.works.filter(w=>w.id!==work.id).forEach((w,n)=>state.relations.push({id:'layout-relation-'+n,fromId:work.id,toId:w.id,kind:n%2?'sequel':'spinoff',evidence}));
  state.chapters.filter(c=>c.workId===work.id).forEach((c,n)=>{c.title=n%3===0?'短标题':n%3===1?longTitle:'AVeryLongUnbrokenChapterTitleWithoutSpacesForLayoutVerification';});
  state.publications.forEach((p,n)=>{p.title=n%2?longTitle:'第 1 卷';});
  copies.filter(c=>state.coverage.some(x=>x.workId===work.id&&x.copyId===c.id)).forEach((c,n)=>{c.title=n%3===0?'短副本':n%3===1?longTitle:'AVeryLongUnbrokenCopyTitleWithoutSpacesForLayoutVerification';if(n%2)c.source=longSource;});
  state.versions[1].title='简体中文完整修订版 · '+longTitle;
  state.versions[1].translator='原创验收排版工作组与特别协作团队';
 });
}

export function TranslationCardFixture({copies}:{copies:ReadingCopy[]}){
 const [notice,setNotice]=useState('');
 const samples=copies.slice(0,6).map((copy,n)=>({...copy,title:n%2?longTitle:'短译本',source:n%2?longSource:'原创验收',pages:copy.pages.map((page,index)=>{
  const id=`layout-job-${n}-${index}`,status=n%2?(index===0?'running':index===1?'failed':'succeeded'):'succeeded';
  const job:Job={id,input_asset_id:'layout-input',output_asset_id:status==='succeeded'?'layout-output':null,mode:n%3?'classic':'redraw',target_language:n%3?'zh-Hans':'en',status,phase:'done',quota_pages:0,created_at:'2026-09-15T00:00:00Z',version:1,cache_hit:false,result_expired:n%2===1};
  return {...page,ownerId:'layout-user',apiOrigin:'https://layout.example',jobs:[job],outputBlobs:n%2?{}:{[id]:'fixture-cover'}};
 })}));
 return <main className="nc-library" style={{padding:24}}><TranslationCopies copies={samples} userId="layout-user" origin="https://layout.example" onOpen={(_,edition)=>setNotice('已打开 '+edition.mode+' · '+edition.language)}/>{notice&&<p role="status">{notice}</p>}</main>;
}
