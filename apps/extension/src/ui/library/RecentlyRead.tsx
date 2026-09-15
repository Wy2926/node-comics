import type {ReadingCopy} from '../../types';
import type {ComicWork} from '../../library/types';
import {Thumbnail} from '../../reader/Images';
import {copyCover,savedPages} from './shared';

const readingTime=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export const formatReadingTime=(at?:number)=>at?readingTime.format(at):'没阅读过';
export function recentCopy(copies:ReadingCopy[]){return copies.filter(c=>c.lastReadAt).sort((a,b)=>b.lastReadAt!-a.lastReadAt!)[0];}

export function RecentlyRead({items,onOpen,onWork}:{items:{work:ComicWork;copy:ReadingCopy}[];onOpen:(id:string)=>void;onWork:(id:string)=>void}){
 if(!items.length)return null;
 return <section className="nc-recent-reading" aria-labelledby="recent-reading-title">
  <div className="nc-section-heading"><h2 id="recent-reading-title">最近阅读</h2><span className="nc-muted">接着上次的故事</span></div>
  <div className="nc-recent-grid">{items.map(({work,copy})=>{
   const page=copy.pages.findIndex(p=>p.id===copy.pageId),available=savedPages(copy)>0;
   return <article className="nc-recent-card" key={work.id}>
    <button className="nc-recent-cover" aria-label={'打开作品 '+work.title} onClick={()=>onWork(work.id)}><Thumbnail blobKey={copyCover(copy)?.blobKey} alt={work.title+'封面'}/></button>
    <div className="nc-recent-body">
     <h3 title={work.title}><button onClick={()=>onWork(work.id)}>{work.title}</button></h3>
     <p title={copy.title}>{copy.title}</p>
     <p className="nc-recent-position">{page>=0?<>上次读到第 <strong>{page+1}</strong> 页</>:'阅读位置待恢复'}</p>
     <div className="nc-recent-footer"><time dateTime={new Date(copy.lastReadAt!).toISOString()} title={'最近阅读：'+formatReadingTime(copy.lastReadAt)}>{formatReadingTime(copy.lastReadAt)}</time><button className="button primary small" onClick={()=>available?onOpen(copy.id):onWork(work.id)}>{available?'继续阅读':'查看内容'}<span aria-hidden="true">→</span></button></div>
    </div>
   </article>;
  })}</div>
 </section>;
}
