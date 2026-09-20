import {msg} from '../i18n/runtime';
import {isMangaCopyUrl} from './mangacopy';
import {comicImageRect,MAX_COMIC_IMAGES} from './comic-images';
export interface SourceItem { id: string; url: string; width: number; height: number; order: number; }
export interface PageManifest { id: string; sourceTabId: number; navigationId: string; revision: number; title: string; url: string; adapter: string; direction: 'ltr'|'rtl'; discoveryComplete: boolean; knownTotal?: number; note: string; items: SourceItem[]; selectionConfirmed?:boolean; }
export function safeImageUrl(input: string, base: string): string|null { try {if(!input.trim())return null; const u = new URL(input,base); return ['https:','http:'].includes(u.protocol)&& !u.username && !u.password ? u.href : null; } catch{return null;} }
export function discoverDocument(doc: Document, pageUrl: string): Omit<PageManifest,'id'|'sourceTabId'|'navigationId'|'revision'> {
  const host = new URL(pageUrl).hostname;
  const isXkcd=host==='xkcd.com'||host==='www.xkcd.com';
  const isGunner=host==='www.gunnerkrigg.com'||host==='gunnerkrigg.com';
  if(isMangaCopyUrl(pageUrl)){
    const images=[...doc.querySelectorAll<HTMLImageElement>('.comicContent-list img')];
    const count=Number(doc.querySelector('.comicCount')?.textContent?.trim());
    const knownTotal=Number.isInteger(count)&&count>0&&count<=10000?count:undefined;
    const items:SourceItem[]=[];
    for(const [order,img] of images.entries()){
      const url=safeImageUrl(img.getAttribute('data-src')??'',pageUrl);
      // Keep a stable prefix until a missing slot is resolved. Compacting gaps
      // would attach already saved page identities to a different image later.
      if(!url)break;
      const loaded=img.getAttribute('src')===img.getAttribute('data-src');
      items.push({id:`slot-${order}`,url,width:loaded?img.naturalWidth||800:800,height:loaded?img.naturalHeight||1200:1200,order});
    }
    const discoveryComplete=!!knownTotal&&items.length===knownTotal&&images.length===knownTotal;
    return {title:doc.title.split(' - ')[0],url:pageUrl,adapter:'mangacopy',direction:'rtl',knownTotal,discoveryComplete,note:discoveryComplete?msg("漫画容器原图清单与总页数一致。"):msg("已发现 {0} / {1} 页，清单尚未完整。", {"0": items.length, "1": knownTotal??msg("未知")}),items};
  }
  const selector=isXkcd?'#comic img':isGunner?'img.comic_image, #comic img':'img';
  const generic=!isXkcd&&!isGunner;
  const seen=new Set<string>(); const items:SourceItem[]=[];
  for(const img of doc.querySelectorAll<HTMLImageElement>(selector)) {
    if(generic&&!comicImageRect(img))continue;
    const url=(generic?[img.currentSrc||img.src]:[img.dataset.src,img.dataset.original,img.currentSrc,img.src]).map(src=>safeImageUrl(src??'',pageUrl)).find(Boolean);
    if(!url||seen.has(url))continue;
    const loaded=safeImageUrl(img.currentSrc||img.src||'',pageUrl)===url;
    const width=loaded?img.naturalWidth||Number(img.width)||0:0,height=loaded?img.naturalHeight||Number(img.height)||0:0;
    seen.add(url);items.push({id:`page-${hash(url)}`,url,width,height,order:items.length});if(items.length>=MAX_COMIC_IMAGES)break;
  }
  return {title:doc.title.slice(0,160)||msg("未命名漫画"),url:pageUrl,adapter:isXkcd?'xkcd':isGunner?'gunnerkrigg':'generic',direction:isXkcd||isGunner?'ltr':'rtl',discoveryComplete:(isXkcd||isGunner)&&items.length===1,knownTotal:(isXkcd||isGunner)&&items.length===1?1:undefined,note:isXkcd||isGunner?msg("仅当前一期／当前漫画页，不包括前后章节。"):msg("按标签页翻译规则发现已加载的网页大图；滚动原网页后可刷新补充，仅支持 HTTP(S) 原图导入。{0}", {"0": items.length>=MAX_COMIC_IMAGES?msg("已达到单次 1500 张上限。"):''}),items};
}
function hash(text:string){let n=0;for(let i=0;i<text.length;i++)n=Math.imul(31,n)+text.charCodeAt(i)|0;return(n>>>0).toString(36);}
