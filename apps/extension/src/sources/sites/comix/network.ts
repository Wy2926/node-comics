import type {SourceNetwork,SourceNetworkContext} from '../../contracts/network';
import type {SourceCatalogSnapshot,SourceEntry,SourceSnapshot} from '../../contracts/source';
import {safeImageUrl} from '../../shared/urls';
import {sourceCover} from '../../shared/cover';
import {comixLocation} from './definition';
import {encodeRequest,decodeResponse} from './protocol';

type RecordValue=Record<string,unknown>;
function object(value:unknown):RecordValue {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Comix 返回的数据格式已变化。');
  return value as RecordValue;
}
function text(value:unknown){if(typeof value!=='string'||!value.trim()||value.length>2048)throw Error('Comix 文本字段无效。');return value;}
function integer(value:unknown){if(!Number.isSafeInteger(value)||Number(value)<0)throw Error('Comix 数量字段无效。');return Number(value);}
function location(url:string){const value=comixLocation(new URL(url));if(!value)throw Error('Comix 来源地址无效。');return value;}
async function api(path:string,context:SourceNetworkContext,params:Record<string,string>={}){
  const pairs=Object.keys(params).sort().map(key=>key+'='+params[key]).join('&');
  const query=new URLSearchParams(params);query.set('_',encodeRequest(path+(pairs?'?'+pairs:'')));
  const raw=object(JSON.parse(await context.request('https://comix.to/api/v1'+path+'?'+query)));
  const body=typeof raw.e==='string'?object(JSON.parse(decodeResponse(raw.e))):raw;
  if(body.status!=='ok')throw Error('Comix 接口未返回有效内容。');
  return object(body.result);
}
interface Chapter {id:number;number:number;url:string;official:boolean;group:string;name:string;}
function chapter(value:unknown,hid:string,mangaId:number):Chapter{
  const row=object(value),url=new URL(text(row.url),'https://comix.to').href,loc=location(url);
  const id=integer(row.id),number=Number(row.number);
  if(row.mangaId!==mangaId||loc.hid!==hid||Number(loc.chapterId)!==id||!Number.isFinite(number)||number<0||Number(loc.number)!==number||row.language!=='en')throw Error('Comix 章节归属或语言无效。');
  return {id,number,url,official:row.isOfficial===true,group:row.group?text(object(row.group).name):'未标注来源',name:typeof row.name==='string'?row.name:''};
}
export const network={
  async catalog(url,context){
    const loc=location(url);if(loc.chapterId)throw Error('请使用 Comix 漫画详情页链接。');
    const html=await context.request(url),match=/<script\b[^>]*\bid=["']initial-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if(!match)throw Error('Comix 页面未返回漫画数据，可能需要完成源站验证。');
    const initial=object(JSON.parse(match[1])),queries=object(initial.queries);
    const detail=object(queries[JSON.stringify(['manga','detail',loc.hid])]);
    if(detail.hid!==loc.hid)throw Error('Comix 漫画归属已变化。');
    const mangaId=integer(detail.id),canonical=new URL(text(detail.url),'https://comix.to').href;
    if(location(canonical).hid!==loc.hid||location(canonical).chapterId)throw Error('Comix 目录地址无效。');
    const rows:Chapter[]=[],ids=new Set<number>();let total:number|undefined,lastPage:number|undefined;
    for(let page=1;page<=100;page++){
      context.signal?.throwIfAborted();
      const result=await api('/manga/'+loc.hid+'/chapters',context,{limit:'100','order[number]':'asc',page:String(page)}),meta=object(result.meta);
      const count=integer(meta.total),last=integer(meta.lastPage);
      if(count>10000||last<1||last>100||integer(meta.page)!==page||total!==undefined&&total!==count||lastPage!==undefined&&lastPage!==last||!Array.isArray(result.items))throw Error('Comix 目录分页已变化，请重试。');
      total=count;lastPage=last;
      if(meta.hasNext!==(page<last))throw Error('Comix 目录分页不完整。');
      for(const value of result.items){const row=chapter(value,loc.hid,mangaId);if(ids.has(row.id))throw Error('Comix 目录分页重复，请重试。');ids.add(row.id);rows.push(row);}
      if(page===last)break;
      if(!result.items.length)throw Error('Comix 目录缺页。');
    }
    if(rows.length!==total)throw Error('Comix 目录未完整获取。');
    const id='comix:'+loc.hid,previous=context.previous?.id===id?context.previous:undefined;
    const chosen=new Map<number,Chapter>();
    for(const row of rows){
      const old=chosen.get(row.number),pinned=previous?.entries.find(e=>e.id===id+':chapter:'+row.number)?.remoteId;
      if(!old||String(row.id)===pinned||String(old.id)!==pinned&&(Number(row.official)>Number(old.official)||row.official===old.official&&row.id<old.id))chosen.set(row.number,row);
    }
    const entries:SourceEntry[]=[...chosen.values()].sort((a,b)=>a.number-b.number).map((row,order)=>({
      id:id+':chapter:'+row.number,catalogId:id,remoteId:String(row.id),url:row.url,
      title:'Chapter '+row.number+(row.name?' · '+row.name:''),groupIds:['chapters'],rawTypes:[row.official?'官方':row.group],order,related:false,sequenceId:id,
    }));
    const poster=detail.poster as {large?:unknown;medium?:unknown}|undefined;
    const snapshot:SourceCatalogSnapshot={id,sourceId:'comix',url:canonical,title:text(detail.title),observedAt:Date.now(),complete:true,
      cover:sourceCover(poster?.large,canonical)??sourceCover(poster?.medium,canonical),
      note:`已读取 ${rows.length} 条上传记录，每话保留一条。`,groups:[{id:'chapters',title:'全部章节',entryIds:entries.map(e=>e.id),complete:true}],entries,defaultEntryId:entries[0]?.id};
    return snapshot;
  },
  async pages(url,context){
    const loc=location(url);if(!loc.chapterId)throw Error('Comix 章节地址无效。');
    const result=await api('/chapters/'+loc.chapterId,context);
    const returned=location(new URL(text(result.url),'https://comix.to').href);
    if(integer(result.id)!==Number(loc.chapterId)||returned.hid!==loc.hid||returned.chapterId!==loc.chapterId||Number(result.number)!==Number(loc.number)||Number(returned.number)!==Number(loc.number))throw Error('Comix 章节归属已变化。');
    const pages=object(result.pages),base=typeof pages.baseUrl==='string'?pages.baseUrl:'';
    if(!Array.isArray(pages.items)||!pages.items.length||pages.items.length>1500)throw Error('Comix 图片清单为空或无效。');
    const items=pages.items.map((value,order)=>{
      const item=object(value),imageUrl=safeImageUrl(base+text(item.url),url);
      if(!imageUrl||!imageUrl.startsWith('https://')||item.s!==undefined&&item.s!==0&&item.s!==1)throw Error('Comix 图片地址或格式无效。');
      const width=integer(item.width),height=integer(item.height);if(!width||!height||width*height>60_000_000)throw Error('Comix 图片尺寸无效。');
       return {id:'page-'+order,order,width,height,resource:{kind:'http' as const,url:imageUrl,...(item.s===1?{processing:'tiles-v1'}:{})}};
    });
    return {url,adapter:'comix',title:'Chapter '+loc.number,direction:'ltr',note:'',discoveryComplete:true,knownTotal:items.length,items} satisfies SourceSnapshot;
  },
} satisfies SourceNetwork;
