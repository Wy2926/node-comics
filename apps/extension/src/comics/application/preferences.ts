import { validUiLanguage } from '../../i18n/locales';
import { mirrorReader } from '../../inline/settings';
import { defaults, languageLabels, type Settings } from '../../types';

function known(value: Partial<Settings>): Settings {
  return Object.fromEntries(Object.entries(defaults).map(([key,fallback])=>[key,value?.[key as keyof Settings]??fallback])) as unknown as Settings;
}
export function settings(): Settings {
  try {
    const value=JSON.parse(localStorage.getItem('nc-settings')??'{}'); const merged=known(value);
    const enums={appearance:['system','light','dark'],accentTheme:['sky','rose','mint','iris','amber','slate'],readerBackground:['gray','paper','night'],translationMode:['classic','redraw'],direction:['ltr','rtl'],layout:['continuous','single'],fit:['width','window']} as const;
    for(const key of Object.keys(enums) as (keyof typeof enums)[]) if(!(enums[key] as readonly string[]).includes(merged[key]))Object.assign(merged,{[key]:defaults[key]});
    return {...merged,uiLanguage:validUiLanguage(merged.uiLanguage)?merged.uiLanguage:'auto',autoTranslateTabs:merged.autoTranslateTabs===true,cacheLimitMb:[0,128,512,1024,10240,-1].includes(merged.cacheLimitMb)?merged.cacheLimitMb:defaults.cacheLimitMb,textScale:[1,1.125,1.25].includes(value.textScale)?value.textScale:1};
  } catch { return {...defaults}; }
}
export async function saveSettings(value: Settings) {
  localStorage.setItem('nc-settings',JSON.stringify(known(value)));
  await mirrorReader({settings:known(value)});
  if(typeof chrome!=='undefined'&&chrome.storage?.local)await chrome.storage.local.set({preferences:{language:value.language,direction:value.direction,layout:value.layout,fit:value.fit}});
}

/** Search preference does not change image translation or persisted reading choices. */
export function readSearchLanguage(fallback:string):string {
  const defaultLanguage=Object.hasOwn(languageLabels,fallback)?fallback:defaults.language;
  try{const saved=localStorage.getItem('nc-search-language');return saved&&Object.hasOwn(languageLabels,saved)?saved:defaultLanguage;}catch{return defaultLanguage;}
}
export function saveSearchLanguage(language:string) {
  if(!Object.hasOwn(languageLabels,language))return;
  try{localStorage.setItem('nc-search-language',language);}catch{/* Preference storage is optional. */}
}

export function readSearchSiteSelection():Record<string,boolean> {
  try{
    const saved:unknown=JSON.parse(localStorage.getItem('nc-search-sites')??'{}');
    if(!saved||typeof saved!=='object'||Array.isArray(saved))return {};
    return Object.fromEntries(Object.entries(saved).filter((entry):entry is [string,boolean]=>typeof entry[1]==='boolean'));
  }catch{return {};}
}
export function saveSearchSiteSelection(key:string,selected:boolean) {
  try{localStorage.setItem('nc-search-sites',JSON.stringify({...readSearchSiteSelection(),[key]:selected}));}catch{/* Preference storage is optional. */}
}
