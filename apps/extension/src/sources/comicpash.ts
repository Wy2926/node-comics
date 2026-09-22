import {msg} from '../i18n/runtime';
import {MAX_COMIC_IMAGES} from './comic-images';
import {canvasImage} from './page-images';
import type {PageImage,SourceAdapter} from './model';

const ids=new WeakMap<HTMLCanvasElement,string>();
const pageSelector='#comici-viewer #xCVPages > .-cv-page:not(.mode-empty)';
const pageElements=(doc:Document)=>[...doc.querySelectorAll<HTMLElement>(pageSelector)].filter(page=>page.querySelector('.-cv-page-canvas'));
function images(doc:Document):PageImage[]{
 const viewer=doc.querySelector('#comici-viewer'),episode=viewer?.getAttribute('data-comici-viewer-id');
 if(!episode)return [];
 return pageElements(doc).slice(0,MAX_COMIC_IMAGES).flatMap((page,order)=>{
  const canvas=page.querySelector<HTMLCanvasElement>('.-cv-page-canvas > canvas');
  if(!page.classList.contains('mode-rendered')||!canvas||canvas.width<80||canvas.height<80)return [];
  let id=ids.get(canvas);if(!id){id=crypto.randomUUID();ids.set(canvas,id);}
  return [{element:canvas,key:`${episode}:${order}:${canvas.width}:${canvas.height}`,url:'page-image:'+id,read:()=>canvasImage(canvas)}];
 });
}
export const comicPashAdapter:SourceAdapter={
 id:'comicpash',name:'Comic PASH!',direction:'rtl',
 matches:url=>['comicpash.jp','www.comicpash.jp'].includes(url.hostname)&&/^\/episodes\/[a-zA-Z0-9]+\/?$/.test(url.pathname),
 images,
 discover(doc,url){
  const pages=pageElements(doc),rendered=images(doc);
  const items=rendered.map(image=>({id:image.key,url:image.url,kind:'page' as const,width:image.element.width,height:image.element.height,order:pages.findIndex(page=>page.contains(image.element))}));
  const knownTotal=pages.length||undefined,discoveryComplete=!!knownTotal&&items.length===knownTotal;
  return {title:doc.title.slice(0,160),url,adapter:'comicpash',direction:'rtl',items,knownTotal,discoveryComplete,note:msg('已识别阅读器加载的 {0} / {1} 页；翻页后可刷新发现。导入前请保持来源页打开，图片清晰度以网站当前渲染为准。',{'0':items.length,'1':knownTotal??msg('未知')})};
 },
};
