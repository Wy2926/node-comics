import type {ShinobuConfig} from '../config';
import {thinkingParameters} from '../providers';
import {boundedJson,parseTranslation,translationMessages,translationSchema,TextError,type RegionTexts} from './protocol';

export function anthropicRequest(config:ShinobuConfig,input:RegionTexts,language:string){
  if(config.maxTokens===undefined||config.responseFormat==='json_object')throw new TextError('TEXT_CONFIG_INVALID');
  const [system,user]=translationMessages(input,language),thinking=thinkingParameters(config,config.maxTokens);
  return {model:config.model,system:system.content,messages:[user],stream:false,max_tokens:config.maxTokens,...thinking,
    ...(config.thinking==='off'&&config.temperature!==undefined?{temperature:config.temperature}:{}),
    ...(config.responseFormat==='json_schema'?{output_config:{...(thinking.output_config as Record<string,unknown>|undefined),format:{type:'json_schema',schema:translationSchema(input)}}}:{}),
  };
}
export async function anthropicTranslate(config:ShinobuConfig,input:RegionTexts,language:string,token:string,signal:AbortSignal,fetcher:typeof fetch=fetch){
  const response=await fetcher(config.baseUrl+'/messages',{method:'POST',headers:{'Content-Type':'application/json','anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true',...(token?{'x-api-key':token}:{})},body:JSON.stringify(anthropicRequest(config,input,language)),signal,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'});
  const data=await boundedJson(response) as {type?:string;stop_reason?:string;content?:{type?:string;text?:unknown}[]};
  if(data?.type!=='message'||data.stop_reason!=='end_turn'||!Array.isArray(data.content)||data.content.some(block=>!block||!['text','thinking','redacted_thinking'].includes(block.type??'')||block.type==='text'&&typeof block.text!=='string'))throw new TextError('TEXT_OUTPUT_INVALID');
  return parseTranslation(data.content.filter(block=>block.type==='text').map(block=>block.text).join(''),input);
}
