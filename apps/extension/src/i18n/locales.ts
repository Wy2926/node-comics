export const uiLanguages = [
  {id:'zh-CN',label:'简体中文'}, {id:'zh-TW',label:'繁體中文'},
  {id:'en',label:'English'}, {id:'ja',label:'日本語'}, {id:'ko',label:'한국어'},
  {id:'fr',label:'Français'}, {id:'es',label:'Español'},
  {id:'pt-BR',label:'Português (Brasil)'}, {id:'de',label:'Deutsch'},
  {id:'it',label:'Italiano'}, {id:'ru',label:'Русский'},
  {id:'pl',label:'Polski'}, {id:'uk',label:'Українська'},
  {id:'tr',label:'Türkçe'}, {id:'vi',label:'Tiếng Việt'},
  {id:'id',label:'Bahasa Indonesia'},
] as const;
export type UiLocale = typeof uiLanguages[number]['id'];
export type UiLanguage = UiLocale | 'auto';
export const validUiLanguage = (value:unknown):value is UiLanguage => value==='auto'||uiLanguages.some(l=>l.id===value);
export function matchLocale(value:string):UiLocale|undefined {
  const language=value.toLowerCase().replaceAll('_','-');
  if(language==='zh'||language.startsWith('zh-'))return /(?:hant|tw|hk|mo)(?:-|$)/.test(language)?'zh-TW':'zh-CN';
  if(language==='pt'||language.startsWith('pt-'))return 'pt-BR';
  return uiLanguages.find(l=>l.id===language.split('-')[0])?.id;
}
export function resolveLocale(preference:UiLanguage, languages:readonly string[] = typeof navigator==='undefined'?['en']:navigator.languages):UiLocale {
  if(preference!=='auto'&&validUiLanguage(preference))return preference;
  for(const language of languages){const match=matchLocale(language);if(match)return match;}
  return 'en';
}
