import english from './dictionaries/en.json';
import {resolveLocale,type UiLocale} from './locales';

export type Dictionary = Record<string,string>;
export type MessageKey = keyof typeof english;
export const englishDictionary:Dictionary=english;
let locale:UiLocale = 'zh-CN';
let dictionary:Dictionary = {};
let sourceByText=new Map(Object.entries(english).map(([key,value])=>[value,key]));
const formattedSources=new Map<string,string>();
const listeners=new Set<()=>void>();
export const getLocale=()=>locale;
export const getDictionary=()=>dictionary;
export const subscribeLocale=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export function installDictionary(next:UiLocale, messages:Dictionary){
  locale=next;dictionary=messages;
  sourceByText=new Map([...Object.entries(english),...Object.entries(messages)].map(([key,value])=>[value,key]));
  for(const listener of listeners)listener();
}
/** Text interpolation only. No HTML, evaluation, or interpretation of user content. */
export function msg(key:MessageKey, values:Record<string,string|number|boolean|null|undefined> = {}):string {
  const template=dictionary[key]??(locale==='zh-CN'?key:english[key])??key;
  const result=template.replace(/\{(\w+)\}/g,(token,name)=>Object.hasOwn(values,name)?String(values[name]??''):token);
  if(Object.keys(values).length){formattedSources.set(result,key);if(formattedSources.size>512)formattedSources.delete(formattedSources.keys().next().value!);}
  return result;
}
/** Preserve existing diagnostic classification across languages; never apply this to comic/user text. */
export const messageSource=(text:string)=>formattedSources.get(text)??sourceByText.get(text)??text;
export const browserLocale=()=>resolveLocale('auto');
export const formatDate=(value:Date|number|string,withTime=false)=>new Intl.DateTimeFormat(locale,withTime?{dateStyle:'medium',timeStyle:'short'}:{dateStyle:'medium'}).format(new Date(value));
