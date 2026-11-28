import type {ShinobuConfig} from '../config';
import type {InspectResponse} from '../../../contracts';
import {boundedJson,TextError} from './protocol';

export function redactProbeText(text:string,token:string){
  // 网关可能把认证头或带签名的链接写回错误消息；保留普通字段（如 usage.total_tokens）。
  if(token)for(const key of new Set([token,JSON.stringify(token).slice(1,-1)]))text=text.replaceAll(key,'[redacted]');
  return text.replace(/("(?:authorization|proxy-authorization|x-api-key|api[_-]?key|(?:access_|refresh_)?token|secret|password|cookie|set-cookie)"\s*:\s*)"(?:\\[\s\S]|[^"\\])*(?:"|$)/gi,'$1"[redacted]"')
    .replace(/(\b(?:Bearer|Basic)[ \t]+)[^\s"'\\,;<>]+/gi,'$1[redacted]')
    .replace(/([?&](?:api[_-]?key|key|token|access_token|sig|signature|x-amz-(?:credential|signature|security-token)|x-goog-signature)=)[^&#\s"'\\<>]+/gi,'$1[redacted]');
}

/** 模型目录和试译必须使用与正式翻译相同的鉴权，且不得跟随重定向发送 Key。 */
export async function llmJson(config:Pick<ShinobuConfig,'baseUrl'|'protocol'>,path:string,token:string,signal:AbortSignal,body?:unknown,fetcher:typeof fetch=fetch,inspect?:InspectResponse){
  const headers:Record<string,string>={Accept:'application/json'};
  if(config.protocol==='anthropic'){
    headers['anthropic-version']='2023-06-01';headers['anthropic-dangerous-direct-browser-access']='true';
    if(token)headers['x-api-key']=token;
  }else if(token)headers.Authorization='Bearer '+token;
  if(body!==undefined)headers['Content-Type']='application/json';
  try{
    const response=await fetcher(config.baseUrl+path,{method:body===undefined?'GET':'POST',headers,body:JSON.stringify(body),signal,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store'});
    return await boundedJson(response,body===undefined?4*1024*1024:undefined,inspect?(text,truncated)=>{
      inspect({status:response.status,body:redactProbeText(text,token),truncated});
    }:undefined);
  }catch(error){
    if(signal.aborted)throw error instanceof TextError?signal.reason:error;
    if(error instanceof TextError)throw error;
    // 正式译文 POST 断线时无法断言未计费；目录 GET 则没有这种不确定性。
    throw new TextError(body===undefined?'TEXT_NETWORK':'TEXT_OUTCOME_UNKNOWN');
  }
}
