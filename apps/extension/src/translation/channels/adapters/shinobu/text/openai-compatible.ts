import type {ShinobuConfig} from '../config';
import type {InspectResponse} from '../../../contracts';
import {llmRequest,parseTranslation,TextError,type RegionTexts} from './protocol';
import {llmJson} from './llm-http';
export async function llmTranslate(config:ShinobuConfig,input:RegionTexts,language:string,token:string,signal:AbortSignal,fetcher:typeof fetch=fetch,inspect?:InspectResponse){
  const data=await llmJson(config,'/chat/completions',token,signal,llmRequest(config,input,language),fetcher,inspect) as {choices?:{finish_reason?:string;message?:{content?:unknown;refusal?:unknown;tool_calls?:unknown;function_call?:unknown}}[]};
  const choice=data?.choices?.[0],message=choice?.message;
  if(choice?.finish_reason==='length')throw new TextError('TEXT_OUTPUT_TRUNCATED');
  if(choice?.finish_reason!=='stop'||!message||message.refusal||message.tool_calls||message.function_call||typeof message.content!=='string')throw new TextError('TEXT_OUTPUT_INVALID');
  return parseTranslation(message.content,input);
}
