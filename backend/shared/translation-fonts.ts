import catalog from './translation-fonts.json';

export interface TranslationFontChoice {id:string;name:string;names:Readonly<Partial<Record<string,string>>>;languages:string[]}
export const TRANSLATION_FONTS:readonly TranslationFontChoice[]=catalog.fonts;
const DEFAULT_FONT_IDS:Readonly<Partial<Record<string,string>>>=catalog.defaults;

export function defaultTranslationFont(language:string):TranslationFontChoice|undefined {
  return TRANSLATION_FONTS.find(font=>font.id===DEFAULT_FONT_IDS[language]&&font.languages.includes(language));
}

export function translationFontName(font:TranslationFontChoice,language:string):string {
  return font.names[language]??font.name;
}

export function translationFontPreview(id:string,language:string):{family:string;url:string;sample:string}|undefined {
  const font=TRANSLATION_FONTS.find(item=>item.id===id&&item.languages.includes(language));
  if(!font)return undefined;
  return {family:`Node Comics Preview ${id}`,url:`/fonts/translation/${id}.woff2`,sample:translationFontName(font,language)};
}
