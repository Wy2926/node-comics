import { validUiLanguage } from '../../i18n/locales';
import { mirrorReader } from '../../inline/settings';
import { defaults, type Settings } from '../../types';

function known(value: Partial<Settings>): Settings {
  return Object.fromEntries(Object.entries(defaults).map(([key,fallback])=>[key,value?.[key as keyof Settings]??fallback])) as unknown as Settings;
}
export function settings(): Settings {
  try {
    const value=JSON.parse(localStorage.getItem('nc-settings')??'{}'); const merged=known(value);
    const enums={appearance:['system','light','dark'],accentTheme:['sky','rose','mint','iris'],libraryLayout:['grid','list'],readerBackground:['gray','paper','night'],translationMode:['classic','redraw'],direction:['ltr','rtl'],layout:['continuous','single'],fit:['width','window']} as const;
    for(const key of Object.keys(enums) as (keyof typeof enums)[]) if(!(enums[key] as readonly string[]).includes(merged[key]))Object.assign(merged,{[key]:defaults[key]});
    return {...merged,uiLanguage:validUiLanguage(merged.uiLanguage)?merged.uiLanguage:'auto',autoTranslateTabs:merged.autoTranslateTabs===true,cacheLimitMb:[0,128,512,1024,10240,-1].includes(merged.cacheLimitMb)?merged.cacheLimitMb:defaults.cacheLimitMb,textScale:[1,1.125,1.25].includes(value.textScale)?value.textScale:1};
  } catch { return {...defaults}; }
}
export async function saveSettings(value: Settings) {
  localStorage.setItem('nc-settings',JSON.stringify(known(value)));
  await mirrorReader({settings:known(value)});
  if(typeof chrome!=='undefined'&&chrome.storage?.local)await chrome.storage.local.set({preferences:{language:value.language,direction:value.direction,layout:value.layout,fit:value.fit}});
}
