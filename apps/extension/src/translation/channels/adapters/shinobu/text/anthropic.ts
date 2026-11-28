import type {ShinobuConfig} from '../config';
import type {InspectResponse} from '../../../contracts';
import {thinkingParameters} from '../providers';
import {parseTranslation,translationMessages,translationSchema,TextError,type RegionTexts} from './protocol';
import {llmJson} from './llm-http';

export function anthropicRequest(config:ShinobuConfig,input:RegionTexts,language:string){
  if(config.maxTokens===undefined||config.responseFormat==='json_object')throw new TextError('TEXT_CONFIG_INVALID');
  const [system,user]=translationMessages(input,language,config.customPrompt),thinking=thinkingParameters(config);
  return {model:config.model,system:system.content,messages:[user],stream:false,max_tokens:config.maxTokens,...thinking,
    ...(config.temperature===undefined?{}:{temperature:config.temperature}),
    ...(config.responseFormat==='json_schema'?{output_config:{...(thinking.output_config as Record<string,unknown>|undefined),format:{type:'json_schema',schema:translationSchema(input)}}}:{}),
  };
}
export async function anthropicTranslate(config:ShinobuConfig,input:RegionTexts,language:string,token:string,signal:AbortSignal,fetcher:typeof fetch=fetch,inspect?:InspectResponse){
  const data=await llmJson(config,'/messages',token,signal,anthropicRequest(config,input,language),fetcher,inspect) as {type?:string;stop_reason?:string;content?:{type?:string;text?:unknown}[]};
  if(data?.stop_reason==='max_tokens')throw new TextError('TEXT_OUTPUT_TRUNCATED');
  if(data?.type!=='message'||data.stop_reason!=='end_turn'||!Array.isArray(data.content)||data.content.some(block=>!block||!['text','thinking','redacted_thinking'].includes(block.type??'')||block.type==='text'&&typeof block.text!=='string'))throw new TextError('TEXT_OUTPUT_INVALID');
  return parseTranslation(data.content.filter(block=>block.type==='text').map(block=>block.text).join(''),input);
}
