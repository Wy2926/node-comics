import {boundedJson,TextError,type RegionTexts} from './protocol';
import {localLanguage} from '../languages';
export async function googleTranslate(input:RegionTexts,language:string,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<RegionTexts>{
  const target=localLanguage(language);
  const result:RegionTexts=Object.create(null);
  // Preserve boundaries without relying on delimiters that the service may translate or remove.
  for(const [id,text] of Object.entries(input)){
    if(!text.trim()){result[id]='';continue;}
    const body=new URLSearchParams({client:'gtx',sl:'auto',tl:target.google,dt:'t',q:text});
    let response:Response;
    try{response=await fetcher('https://translate.googleapis.com/translate_a/single',{method:'POST',body,signal,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'});}
    catch{signal.throwIfAborted();throw new TextError('TEXT_GOOGLE_UNAVAILABLE');}
    if(response.status===401||response.status===403){await response.body?.cancel();throw new TextError('TEXT_GOOGLE_UNAVAILABLE');}
    const json=await boundedJson(response);
    if(!Array.isArray(json)||!Array.isArray(json[0])||!json[0].length)throw new TextError('TEXT_OUTPUT_INVALID');
    result[id]=json[0].map((part:unknown)=>{if(!Array.isArray(part)||typeof part[0]!=='string')throw new TextError('TEXT_OUTPUT_INVALID');return part[0];}).join('');
  }
  return result;
}
