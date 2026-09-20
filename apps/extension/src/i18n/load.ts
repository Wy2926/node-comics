import {installDictionary,getLocale,getDictionary,englishDictionary,type Dictionary} from './runtime';
import {resolveLocale,validUiLanguage,type UiLanguage,type UiLocale} from './locales';

const cache=new Map<UiLocale,Promise<Dictionary>>();
let generation=0;
export function loadDictionary(locale:UiLocale):Promise<Dictionary>{
  if(locale==='en')return Promise.resolve(englishDictionary);
  let result=cache.get(locale);
  if(!result){
    const path=`i18n/${locale}.json`;
    const url=typeof chrome!=='undefined'&&chrome.runtime?.id?chrome.runtime.getURL(path):new URL('/'+path,location.origin).href;
    result=fetch(url).then(async response=>{if(!response.ok)throw Error('Unable to load bundled locale');return await response.json() as Dictionary;}).catch(error=>{cache.delete(locale);throw error;});cache.set(locale,result);
  }
  return result;
}
export async function setUiLanguage(preference:UiLanguage){
  const stamp=++generation,next=resolveLocale(preference);
  const messages=await loadDictionary(next);
  if(stamp!==generation)return;
  installDictionary(next,messages);
  if(typeof document!=='undefined'){document.documentElement.lang=next;document.title=messages['brand.name'];}
}
export async function initializeUiLanguage(){
  let preference:UiLanguage='auto';
  try{const saved=JSON.parse(localStorage.getItem('nc-settings')??'{}');if(validUiLanguage(saved.uiLanguage))preference=saved.uiLanguage;}catch{/* Browser default for unavailable local storage. */}
  try{await setUiLanguage(preference);}catch{await setUiLanguage('en');}
}
export const localePayload=()=>({locale:getLocale(),dictionary:getDictionary()});
