import type {EpubIndex,EpubLocation} from './contracts';

/** Only document-owned locations can be persisted or passed to a renderer. */
export function epubLocation(index:EpubIndex,value:EpubLocation|undefined):EpubLocation|undefined {
  if(!value)return;
  const cfi=typeof value.cfi==='string'&&value.cfi.length<=8192&&/^epubcfi\([^\u0000-\u001f]*\)$/.test(value.cfi)?value.cfi:undefined;
  const href=typeof value.href==='string'&&value.href.length<=4096&&index.chapters.some(chapter=>chapter.href.split('#')[0]===value.href!.split('#')[0])?value.href:undefined;
  const progression=Number.isFinite(value.progression)?Math.max(0,Math.min(1,value.progression!)):undefined;
  const totalProgression=Number.isFinite(value.totalProgression)?Math.max(0,Math.min(1,value.totalProgression!)):undefined;
  return cfi||href?{...(cfi?{cfi}:{}),...(href?{href}:{}),...(progression!==undefined?{progression}:{}),...(totalProgression!==undefined?{totalProgression}:{})}:undefined;
}
