import manifest from './font-resources.json';
import {TRANSLATION_FONTS} from '../../../../backend/shared/translation-fonts';
import type {LocalAsset} from '../storage/local-assets/store';
export const localFonts=TRANSLATION_FONTS.filter(font=>manifest.some(asset=>asset.id===font.id));
export function fullFont(id:string):LocalAsset&{weight:number}{
  const item=manifest.find(font=>font.id===id);if(!item)throw Error('FONT_UNAVAILABLE');
  return {id:'font:'+item.id,label:TRANSLATION_FONTS.find(font=>font.id===id)!.name,bytes:item.bytes,sha256:item.sha256,url:item.url,license:item.license,source:item.notice_url,weight:item.weight};
}
