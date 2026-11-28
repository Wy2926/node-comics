import {validModelId,type ShinobuConfig} from '../config';
import type {InspectResponse,ServiceResponse} from '../../../contracts';
import {llmJson} from './llm-http';
import {TextError} from './protocol';

export async function listModels(config:Pick<ShinobuConfig,'baseUrl'|'protocol'>,token:string,signal:AbortSignal,inspect?:InspectResponse){
  const ids=new Set<string>(),cursors=new Set<string>();
  let path='/models',last:ServiceResponse|undefined;
  const capture=inspect?(reply:ServiceResponse)=>{last=reply;}:undefined;
  try{
    for(;;){
      // 后一页断网时不能把前一页的 HTTP 200 当作失败请求的响应。
      last=undefined;
      const page=await llmJson(config,path,token,signal,undefined,fetch,capture) as {data?:{id?:unknown}[];has_more?:boolean;last_id?:unknown}|null;
      if(!Array.isArray(page?.data))throw new TextError('TEXT_MODELS_INVALID');
      for(const model of page.data){
        if(!validModelId(model?.id))throw new TextError('TEXT_MODELS_INVALID');
        ids.add(model.id.trim());
        if(ids.size>4096)throw new TextError('TEXT_OUTPUT_LIMIT');
      }
      if(!page.has_more)return [...ids];
      // Anthropic 返回游标而非下一页地址；始终向原网关请求，限制页数并拒绝循环游标。
      if(config.protocol!=='anthropic'||!validModelId(page.last_id)||cursors.has(page.last_id)||cursors.size>=19)throw new TextError('TEXT_MODELS_INVALID');
      cursors.add(page.last_id);path='/models?after_id='+encodeURIComponent(page.last_id);
    }
  }finally{if(last)inspect?.(last);}
}
