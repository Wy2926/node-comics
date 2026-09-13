export interface SourceItem { id: string; url: string; width: number; height: number; order: number; }
export interface ChapterManifest { version: 1; id: string; sourceTabId: number; navigationId: string; revision: number; title: string; url: string; adapter: string; direction: 'ltr'|'rtl'; discoveryComplete: boolean; knownTotal?: number; note: string; items: SourceItem[]; }
export function safeImageUrl(input: string, base: string): string|null { try { const u = new URL(input,base); return ['https:','http:'].includes(u.protocol)&& !u.username && !u.password ? u.href : null; } catch{return null;} }
export function discoverDocument(doc: Document, pageUrl: string): Omit<ChapterManifest,'id'|'sourceTabId'|'navigationId'|'revision'> {
  const host = new URL(pageUrl).hostname;
  const isXkcd=host==='xkcd.com'||host==='www.xkcd.com';
  const isGunner=host==='www.gunnerkrigg.com'||host==='gunnerkrigg.com';
  const selector=isXkcd?'#comic img':isGunner?'img.comic_image, #comic img':'img';
  const seen=new Set<string>(); const items:SourceItem[]=[];
  for(const img of doc.querySelectorAll<HTMLImageElement>(selector)) { const src=img.currentSrc||img.src||img.dataset.src||img.dataset.original; const url=safeImageUrl(src??'',pageUrl); const width=img.naturalWidth||Number(img.width)||0;const height=img.naturalHeight||Number(img.height)||0;if(!url||seen.has(url)||(!isXkcd&&!isGunner&&(width<240||height<240)))continue;seen.add(url);items.push({id:`page-${items.length}-${hash(url)}`,url,width:width||800,height:height||1200,order:items.length});if(items.length>=300)break; }
  return {version:1,title:doc.title.slice(0,160)||'未命名漫画',url:pageUrl,adapter:isXkcd?'xkcd':isGunner?'gunnerkrigg':'generic',direction:isXkcd||isGunner?'ltr':'rtl',discoveryComplete:(isXkcd||isGunner)&&items.length===1,knownTotal:(isXkcd||isGunner)&&items.length===1?1:undefined,note:isXkcd||isGunner?'仅当前一期／当前漫画页，不包括前后章节。':'仅包含当前页面已加载的大图；请继续滚动原网页后重新发现。',items};
}
function hash(text:string){let n=0;for(let i=0;i<text.length;i++)n=Math.imul(31,n)+text.charCodeAt(i)|0;return(n>>>0).toString(36);}
