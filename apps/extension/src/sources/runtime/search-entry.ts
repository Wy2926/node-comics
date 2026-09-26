import type {SourceSearchSeed,SourceWorkReference} from '../contracts/work';
import {resolveSource} from '../core/resolve';
import {definitions} from '../registry/definitions';
import {safeImageUrl} from '../shared/urls';
import {msg} from '../../i18n/runtime';

const prefix='nc-search-seed:',ttl=5*60_000;
function seedRecord(value:unknown):{createdAt:number;seed:unknown}|undefined {
  if(!value||typeof value!=='object')return;
  const record=value as {createdAt?:unknown;seed?:unknown};
  if(typeof record.createdAt!=='number'||!Number.isFinite(record.createdAt))return;
  return {createdAt:record.createdAt,seed:record.seed};
}
const validAge=(createdAt:number,now:number)=>createdAt<=now&&now-createdAt<=ttl;
const trustedPage=(url:string)=>{
  const resolved=resolveSource(url,definitions);
  if(!resolved.definition.capabilities.importable||resolved.location.kind==='other')throw Error(msg('此网站尚未专门适配，不能导入漫画。'));
  return resolved;
};
export function validateSearchSeed(work:unknown,currentUrl:string):SourceSearchSeed {
  const {definition,location}=trustedPage(currentUrl);
  const seed:SourceSearchSeed={title:'',sourceName:definition.name};
  if(location.catalog)seed.origin={sourceId:definition.id,catalogId:location.catalog.key,url:location.catalog.url};
  if(!work||typeof work!=='object')return seed;
  const item=work as SourceWorkReference;
  if(typeof item.title!=='string'||!item.title.trim()||Array.from(item.title).length>2000||/[\u0000-\u001f\u007f]/.test(item.title))return seed;
  const parent=trustedPage(item.catalogUrl);
  if(parent.definition.id!==definition.id||parent.location.kind!=='catalog'||parent.location.catalog?.key!==item.catalogId||
    location.catalog&&location.catalog.key!==item.catalogId)throw Error(msg('来源页面已变化，请重新发现。'));
  const cover=typeof item.cover?.url==='string'?safeImageUrl(item.cover.url,item.catalogUrl):undefined;
  return {title:item.title.trim(),sourceName:definition.name,
    origin:{sourceId:definition.id,catalogId:item.catalogId,url:parent.location.url},...(cover?{cover:{url:cover}}:{})};
}
export async function openSearchFromTab(tabId:number,expectedUrl?:string,senderUrl?:string) {
  if(!Number.isInteger(tabId)||tabId<0)throw Error(msg('当前标签页不可用，请重新打开插件。'));
  const tab=await chrome.tabs.get(tabId),url=tab.url;
  if(!url||expectedUrl&&url!==expectedUrl||senderUrl&&new URL(url).origin!==new URL(senderUrl).origin)
    throw Error(msg('来源页面已变化，请重新发现。'));
  trustedPage(url);
  let work:unknown;
  try{
    await chrome.scripting.executeScript({target:{tabId},files:['content-scripts/content.js']});
    const response=await chrome.tabs.sendMessage(tabId,{type:'NC_DESCRIBE_WORK'},{frameId:0});
    if(response?.url!==url)throw Error('SOURCE_SESSION_EXPIRED');
    work=response.work;
  }catch{
    // The trusted extension form can still ask for the work's name without guessing a page title.
    work=undefined;
  }
  if((await chrome.tabs.get(tabId)).url!==url)throw Error(msg('来源页面已变化，请重新发现。'));
  const seed=validateSearchSeed(work,url),id=crypto.randomUUID(),key=prefix+id;
  await navigator.locks.request('nc-search-seed-budget',async()=>{
    const now=Date.now(),records=await chrome.storage.session.get(null);
    const retained=Object.entries(records).filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,record:seedRecord(value)}))
      .sort((a,b)=>(b.record?.createdAt??0)-(a.record?.createdAt??0));
    const obsolete=retained.filter(({record},index)=>index>=7||!record||!validAge(record.createdAt,now)).map(({key})=>key);
    if(obsolete.length)await chrome.storage.session.remove(obsolete);
    await chrome.storage.session.set({[key]:{createdAt:now,seed}});
  });
  try{await chrome.tabs.create({url:chrome.runtime.getURL('/reader.html?search='+id)});}
  catch(error){await chrome.storage.session.remove(key);throw error;}
}
/** One-use short-lived context; never put the title or source URL into the address bar. */
export async function consumeSearchSeed(id:string):Promise<SourceSearchSeed> {
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))throw Error(msg('查找入口已失效，请从漫画页面重新打开。'));
  const key=prefix+id;
  return navigator.locks.request(key,async()=>{
    const data=await chrome.storage.session.get(key),record=seedRecord(data[key]);
    await chrome.storage.session.remove(key);
    const seed=record?.seed as SourceSearchSeed|undefined;
    if(!record||!validAge(record.createdAt,Date.now())||!seed||typeof seed.title!=='string'||Array.from(seed.title).length>2000||/[\u0000-\u001f\u007f]/.test(seed.title))
      throw Error(msg('查找入口已失效，请从漫画页面重新打开。'));
    if(seed.origin){
      const resolved=trustedPage(seed.origin.url);
      if(resolved.definition.id!==seed.origin.sourceId||resolved.location.kind!=='catalog'||resolved.location.catalog?.key!==seed.origin.catalogId)
        throw Error(msg('来源页面已变化，请重新发现。'));
      return {title:seed.title.trim(),sourceName:resolved.definition.name,
        origin:{sourceId:resolved.definition.id,catalogId:resolved.location.catalog.key,url:resolved.location.url},
        ...(seed.cover&&safeImageUrl(seed.cover.url,seed.origin.url)===seed.cover.url?{cover:{url:seed.cover.url}}:{})};
    }
    return {title:seed.title.trim(),...(typeof seed.sourceName==='string'&&seed.sourceName.length<=200?{sourceName:seed.sourceName}:{})};
  });
}
