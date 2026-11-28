import type {ChannelField} from '../../contracts';
import {msg} from '../../../../i18n/runtime';
import {serviceError} from './errors';
import {llmProviders,providerPreset,thinkingWire,thinkingValues,type LlmProvider,type LlmProtocol,type Thinking,type ThinkingFormat} from './providers';
export const ENGINE_REVISION='shinobu-c4239a2-node3';
const MAX_CUSTOM_PROMPT_LENGTH=4096;
export interface ShinobuConfig {provider:'google'|'llm';llmProvider:LlmProvider;protocol:LlmProtocol;thinking:Thinking;thinkingFormat:ThinkingFormat;thinkingBudget?:number;baseUrl:string;model:string;customPrompt?:string;maxTokens?:number;tokenField:'max_tokens'|'max_completion_tokens';responseFormat:'text'|'json_object'|'json_schema';temperature?:number;backend:'auto'|'cpu';ocrFilter:'balanced'|'off';}
export function serviceEndpoint(values:Record<string,string>){
  const llmProvider=(values.llmProvider||'custom') as LlmProvider;
  if(llmProvider!=='custom'&&!Object.hasOwn(llmProviders,llmProvider))throw Error('TEXT_CONFIG_INVALID');
  const protocol=llmProvider==='claude'?'anthropic':llmProvider==='custom'?values.protocol||'openai':'openai';
  if(protocol!=='openai'&&protocol!=='anthropic')throw Error('TEXT_CONFIG_INVALID');
  let url:URL;try{url=new URL((values.baseUrl??providerPreset(llmProvider).baseUrl).trim());}catch{throw Error('TEXT_URL_INVALID');}
  if(!['https:','http:'].includes(url.protocol))throw Error('TEXT_URL_INVALID');
  if(url.username||url.password||url.href.includes('?')||url.href.includes('#'))throw Error('TEXT_URL_PRIVATE');
  if(/\/(?:chat\/completions|responses|messages)\/*$/.test(url.pathname))throw Error('TEXT_URL_METHOD');
  return {llmProvider,protocol:protocol as LlmProtocol,baseUrl:url.href.replace(/\/+$/,'')};
}
export const validModelId=(id:unknown):id is string=>typeof id==='string'&&!!id.trim()&&id.length<=256&&!/[\x00-\x1f\x7f]/.test(id);
export function parseConfig(values:Record<string,string>):ShinobuConfig{
  const provider=values.provider||'google';
  if(provider!=='google'&&provider!=='llm')throw Error('TEXT_CONFIG_INVALID');
  const {llmProvider,protocol,baseUrl}=provider==='llm'?serviceEndpoint(values):{llmProvider:'custom' as const,protocol:'openai' as const,baseUrl:''};
  const thinking=values.thinking||'auto',thinkingFormat=values.thinkingFormat||'openai';
  if(!thinkingValues.includes(thinking as Thinking)||!['openai','openrouter','thinking','enable_thinking','none'].includes(thinkingFormat))throw Error('TEXT_CONFIG_INVALID');
  const model=(values.model??'').trim();
  const customPrompt=provider==='llm'?values.customPrompt:undefined;
  if(customPrompt!==undefined&&(typeof customPrompt!=='string'||customPrompt.length>MAX_CUSTOM_PROMPT_LENGTH))throw Error('TEXT_CONFIG_INVALID');
  if(provider==='llm'&&!validModelId(model))throw Error('TEXT_MODEL_INVALID');
  const maxTokens=values.maxTokens?.trim()?Number(values.maxTokens):undefined,temperature=values.temperature?Number(values.temperature):undefined;
  const thinkingBudget=protocol==='anthropic'&&thinking==='on'&&values.thinkingBudget?.trim()?Number(values.thinkingBudget):undefined;
  if(thinkingBudget!==undefined&&(!Number.isSafeInteger(thinkingBudget)||thinkingBudget<=0))throw Error('TEXT_BUDGET_INVALID');
  const tokenField=values.tokenField||providerPreset(llmProvider).tokenField,responseFormat=values.responseFormat||'text',backend=values.backend||'auto',ocrFilter=values.ocrFilter||'balanced';
  if(maxTokens!==undefined&&(!Number.isSafeInteger(maxTokens)||maxTokens<=0))throw Error('TEXT_MAX_TOKENS');
  if(temperature!==undefined&&(!Number.isFinite(temperature)||temperature<0||temperature>2))throw Error('TEXT_TEMPERATURE');
  if(!['max_tokens','max_completion_tokens'].includes(tokenField)||!['text','json_object','json_schema'].includes(responseFormat)||!['auto','cpu'].includes(backend)||!['balanced','off'].includes(ocrFilter))throw Error('TEXT_CONFIG_INVALID');
  return {provider,llmProvider,protocol,thinking:thinking as Thinking,thinkingFormat:thinkingFormat as ThinkingFormat,thinkingBudget,baseUrl,model,customPrompt:customPrompt?.trim()||undefined,maxTokens,temperature,tokenField:tokenField as ShinobuConfig['tokenField'],responseFormat:responseFormat as ShinobuConfig['responseFormat'],backend:backend as ShinobuConfig['backend'],ocrFilter:ocrFilter as ShinobuConfig['ocrFilter']};
}
/** 保存和试译使用同一套完整校验；列模型仅需校验目标地址与协议。 */
export function draftConfig(values:Record<string,string>){
  try{
    const config=parseConfig({...values,provider:'llm'});
    if(config.protocol==='anthropic'&&config.maxTokens===undefined)throw Error('TEXT_MAX_TOKENS');
    if(config.protocol==='anthropic'&&config.responseFormat==='json_object')throw Error('TEXT_CONFIG_INVALID');
    return config;
  }catch(error){throw serviceError(error);}
}
export function configValues(config:ShinobuConfig):Record<string,string>{return Object.fromEntries(Object.entries(config).map(([key,value])=>[key,value===undefined?'':String(value)]));}
export const needsInternet=(config:ShinobuConfig)=>config.provider==='google';
export function configFields():ChannelField[]{
  return [
    {key:'backend',label:msg('运行方式'),type:'select',defaultValue:'auto',options:[{value:'auto',label:msg('自动')},{value:'cpu',label:msg('兼容模式（CPU）')}]},
    {key:'ocrFilter',label:msg('文字识别过滤'),type:'select',defaultValue:'balanced',options:[{value:'balanced',label:msg('平衡')},{value:'off',label:msg('不启用')}]},
  ];
}
export function changeServiceValues(previous:Record<string,string>,next:Record<string,string>):Record<string,string>{
  if(next.llmProvider!==previous.llmProvider)return providerPreset(next.llmProvider as LlmProvider);
  // 手动改网关和切换预设一样，不能把刚输入的旧 Key 带往新地址。
  if(next.baseUrl!==previous.baseUrl)return {...next,token:''};
  if(next.protocol!==previous.protocol)return {...next,thinking:'auto',thinkingBudget:'',responseFormat:'text',temperature:'',maxTokens:next.protocol==='anthropic'?'16384':'',tokenField:'max_tokens'};
  if(next.thinkingFormat!==previous.thinkingFormat)return {...next,thinking:'auto'};
  return next;
}
export function serviceFields(values:Record<string,string>):ChannelField[]{
  const llmProvider=(values.llmProvider||'custom') as LlmProvider,protocol=llmProvider==='claude'?'anthropic':llmProvider==='custom'?(values.protocol||'openai') as LlmProtocol:'openai';
  const thinking=values.thinking||'auto',thinkingFormat=(values.thinkingFormat||'openai') as ThinkingFormat,wire=thinkingWire({llmProvider,protocol,thinkingFormat});
  // 只按参数的表示方式组织选项：布尔字段没有档位，服务端决定实际支持范围。
  const choices=wire==='thinking'||wire==='enable_thinking'?['auto','off','on'] as const
    :wire==='openai'?thinkingValues.filter(value=>value!=='on'):thinkingValues;
  const levels:Record<Thinking,string>={auto:msg('不发送思考参数'),off:msg('不启用'),on:msg('开启'),minimal:msg('极低'),low:msg('低'),medium:msg('中'),high:msg('高'),xhigh:msg('极高'),max:msg('最高')};
  return [
    {key:'llmProvider',label:msg('供应商类型'),type:'select',defaultValue:'custom',options:[...Object.entries(llmProviders).map(([value,item])=>({value,label:item.label})),{value:'custom',label:msg('自定义供应商')}]},
    {key:'name',label:msg('供应商名称'),type:'text',maxLength:80,placeholder:values.model?.slice(0,80)||msg('例如：家里的本地模型')},
    ...(llmProvider==='custom'?[{key:'protocol',label:msg('接口协议'),type:'select' as const,defaultValue:'openai',options:[{value:'openai',label:'OpenAI Chat Completions'},{value:'anthropic',label:'Anthropic Messages'}]}]:[]),
    {key:'baseUrl',label:msg('服务地址'),type:'url',advanced:llmProvider!=='custom',required:true,placeholder:'http://127.0.0.1:1234/v1',help:msg('可使用官方地址或自定义网关，填写接口前缀，不含具体请求方法。')},
    {key:'token',label:msg('访问令牌'),type:'password',help:msg('填写所选服务的 API Key 或网关访问令牌；无需鉴权可留空。')},
    {key:'model',label:msg('模型名称'),type:'text',required:true,maxLength:256,placeholder:msg('填写服务中可用的模型名称')},
    {key:'customPrompt',label:msg('自定义提示词'),advanced:true,type:'textarea',maxLength:MAX_CUSTOM_PROMPT_LENGTH,help:msg('可补充译名或语气要求（最多 {max} 个字符）。留空使用默认提示词。',{max:MAX_CUSTOM_PROMPT_LENGTH})},
    ...(llmProvider==='custom'&&protocol==='openai'?[{key:'thinkingFormat',label:msg('思考参数'),advanced:true,type:'select' as const,defaultValue:'openai',options:[{value:'openai',label:'OpenAI · reasoning_effort'},{value:'openrouter',label:'OpenRouter · reasoning'},{value:'thinking',label:'thinking.type'},{value:'enable_thinking',label:'enable_thinking'},{value:'none',label:msg('不发送思考参数')}]}]:[]),
    ...(wire==='none'?[]:[{key:'thinking',label:msg('思考程度'),advanced:true,type:'select' as const,defaultValue:'auto',options:choices.map(value=>({value,label:levels[value]}))}]),
    ...(wire==='messages'&&thinking==='on'?[{key:'thinkingBudget',label:'budget_tokens',advanced:true,type:'number' as const,help:msg('留空使用服务默认值。')}]:[]),
    {key:'maxTokens',label:msg('最大输出 Token'),type:'number',advanced:true,required:protocol==='anthropic',help:protocol==='anthropic'?msg('Messages 接口要求填写输出上限，包含思考与正文 Token。'):msg('留空使用服务默认值。')},
    ...(protocol==='openai'?[{key:'tokenField',label:msg('输出上限参数'),type:'select' as const,defaultValue:'max_tokens',advanced:true,options:['max_tokens','max_completion_tokens'].map(value=>({value,label:value}))}]:[]),
    {key:'responseFormat',label:msg('响应格式'),type:'select',defaultValue:'text',advanced:true,options:[{value:'text',label:msg('基础聊天接口')},...(protocol==='openai'?[{value:'json_object',label:msg('JSON 对象')}]:[]),{value:'json_schema',label:'JSON Schema'}]},
    {key:'temperature',label:msg('随机程度'),type:'number',advanced:true,help:msg('留空使用服务默认值。')},
  ];
}
