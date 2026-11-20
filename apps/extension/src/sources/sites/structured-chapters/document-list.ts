import type {SourceNetworkContext} from '../../contracts/network';
import {safeImageUrl} from '../../shared/urls';
import {count, directory, incomplete, markup} from './catalog';
import type {matchLink} from './definition';

type Link = NonNullable<ReturnType<typeof matchLink>>;
const menu = 'select.navi-change-chapter';

function target(element:Element|null, attribute:string, base:string) {
  return safeImageUrl(element?.getAttribute(attribute) ?? '', base);
}

const canonical = (doc:ParentNode,url:string) => target(doc.querySelector('link[rel="canonical"]'),'href',url)===url;

function sameReader(layout:Link['layout'], doc:ParentNode, url:string, work:string) {
  if (layout==='numbered') return target(doc.querySelector('#k_Pic_backArr'),'href',url)===work;
  if (!canonical(doc,url)) return false;
  return layout==='menu' ? target(doc.querySelector(menu+' option[selected]'),'data-c',url)===url
    : target(doc.querySelector('[data-reader][data-comic-url]'),'data-comic-url',url)===work;
}

export async function documentList(link:Link, ctx:SourceNetworkContext) {
  const {layout,location:work,selector}=link, url=work.url;
  const doc=markup(await ctx.request(url,{redirect:'error'}));
  const numbered=layout==='numbered', counted=layout==='counted';
  if (!numbered && !canonical(doc,url)) incomplete();
  const rows=[...doc.querySelectorAll(selector)], size=count(rows.length);
  const lists=doc.querySelectorAll(counted?'#chapters #chapter-list':numbered?'#list > ul':'#chapterlist > .row-content-chapter');
  const children=lists[0]?.children;
  if (lists.length!==1 || children.length!==size || rows.some((row,i)=>(counted?row:row.parentElement)!==children[i])) incomplete();
  if (counted && (!rows[0].classList.contains('is-latest') ||
      count(doc.querySelector('#chapters h2 small')?.textContent?.match(/^\s*(\d{1,3}(?:,\d{3})+|\d+)\s+chapters?\b/i)?.[1].replaceAll(',',''))!==size)) incomplete();
  const title=doc.querySelector('h1')?.textContent ?? '';
  const result=directory(work,title,size);
  const urls=rows.map((row,i)=>{
    const href=target(row,'href',url) ?? incomplete(), chapter=new URL(href);
    if (chapter.search || chapter.hash) incomplete();
    const name=(row.getAttribute('data-name') ?? row.textContent ?? '').trim();
    if (numbered && Number(/^第\s*(\d+)\s*[話话章]/.exec(name)?.[1])!==size-i) incomplete();
    result.add(href,name);
    return href;
  });
  if (!counted) {
    const first=urls[0], last=urls[size-1];
    if (target(doc.querySelector(numbered?'#Subscribe_bak':'#btn-read-last'),'href',url)!==last ||
        !numbered && target(doc.querySelector('#btn-read-first'),'href',url)!==first) incomplete();
    ctx.signal?.throwIfAborted();
    const reader=markup(await ctx.request(first,{redirect:'error',referer:url}));
    if (!sameReader(layout,reader,first,url)) incomplete();
    if (numbered) {
      const prev=reader.querySelector('#k_Pic_upArr');
      if (reader.querySelector('#k_Pic_nextArr') || (prev ? target(prev,'href',first) : undefined)!==urls[1]) incomplete();
    } else {
      const options=reader.querySelector(menu)?.children;
      if (options?.length!==size || [...options].some((option,i)=>option.localName!=='option'||target(option,'data-c',first)!==urls[i])) incomplete();
    }
  }
  return result.finish();
}

export function validImageList({layout,location}:Link, doc:ParentNode, images:HTMLImageElement[]) {
  if (!sameReader(layout,doc,location.url,location.catalog!.url)) return false;
  if (layout==='counted') return doc.querySelectorAll('[data-reader][data-comic-url] > [data-pages]').length===1
    && images.every((img,i)=>img.getAttribute('data-page')===String(i+1));
  const numbered=layout==='numbered', boxes=doc.querySelectorAll(numbered?'#currentCache .view-imgBox .img-wrap':'.read-manga .read-content > .page-break');
  return boxes.length===images.length && images.every((img,i)=>img.parentElement===boxes[i] &&
    (numbered?img.getAttribute('data-index')===String(i):img.classList.contains('p'+(i+1))));
}
