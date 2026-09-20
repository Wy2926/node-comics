import {comicSize} from '../inline/protocol';

export const MAX_COMIC_IMAGES=1500;

/** Shared by webpage discovery and inline translation; geometry uses CSS pixels. */
export function comicImageRect(image:HTMLImageElement):DOMRect|undefined{
 const rect=image.getBoundingClientRect();
 if(!comicSize(rect.width,rect.height)||!image.complete||image.naturalWidth<80||image.naturalHeight<80)return;
 const css=getComputedStyle(image);
 if(css.visibility!=='visible'||Number(css.opacity)===0||!image.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return;
 return rect;
}
