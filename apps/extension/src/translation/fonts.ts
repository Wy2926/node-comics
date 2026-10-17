import {TRANSLATION_FONTS,defaultTranslationFont} from '../../../../backend/shared/translation-fonts';
import type {TranslationFontChoice} from '../types';

/** A shipped preview is not evidence that the connected service can render that font. */
export function availableTranslationFonts(fonts:TranslationFontChoice[]|undefined,language:string){
  return TRANSLATION_FONTS.filter(font=>font.languages.includes(language)&&fonts?.some(choice=>choice.id===font.id&&choice.languages.includes(language)));
}

/** Old/empty preferences use the language default, limited to this service's actual catalog. */
export function effectiveTranslationFont(fonts:TranslationFontChoice[]|undefined,language:string,fontId?:string){
  const choices=availableTranslationFonts(fonts,language),fallback=defaultTranslationFont(language)?.id;
  return (choices.find(font=>font.id===fontId)||choices.find(font=>font.id===fallback)||choices[0])?.id;
}

export function selectedFontAvailable(fonts:TranslationFontChoice[]|undefined,language:string,fontId?:string){
  return !fontId||availableTranslationFonts(fonts,language).some(font=>font.id===fontId);
}
