import type {ShinobuConfig} from '../config';
import {boundedJson,llmRequest,parseTranslation,TextError,type TextBatch} from './protocol';
export async function llmTranslate(config:ShinobuConfig,batch:TextBatch,language:string,token:string,signal:AbortSignal,fetcher:typeof fetch=fetch){
  const response=await fetcher(config.baseUrl+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(llmRequest(config,batch,language)),signal,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'});
  const data=await boundedJson(response) as {choices?:{finish_reason?:string;message?:{content?:unknown;refusal?:unknown;tool_calls?:unknown;function_call?:unknown}}[]};
  const choice=data?.choices?.[0],message=choice?.message;
  if(choice?.finish_reason!=='stop'||!message||message.refusal||message.tool_calls||message.function_call||typeof message.content!=='string')throw new TextError('TEXT_OUTPUT_INVALID');
  return parseTranslation(message.content,batch);
}
