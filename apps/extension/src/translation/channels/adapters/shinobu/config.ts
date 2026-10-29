import type {ChannelField} from '../../contracts';
import {msg} from '../../../../i18n/runtime';
import {llmProviders,providerPreset,thinkingCapability,thinkingValues,type LlmProvider,type LlmProtocol,type Thinking,type ThinkingFormat} from './providers';
export const ENGINE_REVISION='shinobu-c4239a2-node2';
export interface ShinobuConfig {provider:'google'|'llm';llmProvider:LlmProvider;protocol:LlmProtocol;thinking:Thinking;thinkingFormat:ThinkingFormat;baseUrl:string;model:string;maxTokens?:number;tokenField:'max_tokens'|'max_completion_tokens';responseFormat:'text'|'json_object'|'json_schema';temperature?:number;backend:'auto'|'cpu';ocrFilter:'balanced'|'off';}
export function parseConfig(values:Record<string,string>):ShinobuConfig{
  const provider=values.provider||'google';
  if(!['google','llm'].includes(provider))throw Error('TEXT_CONFIG_INVALID');
  const llmProvider=values.llmProvider||'custom';
  if(llmProvider!=='custom'&&!Object.hasOwn(llmProviders,llmProvider))throw Error('TEXT_CONFIG_INVALID');
  const protocol=llmProvider==='claude'?'anthropic':llmProvider==='custom'?values.protocol||'openai':'openai';
  const thinking=values.thinking||'off',thinkingFormat=values.thinkingFormat||'openai';
  if(!['openai','anthropic'].includes(protocol)||!thinkingValues.includes(thinking as Thinking)||!['openai','openrouter','thinking','enable_thinking','none'].includes(thinkingFormat))throw Error('TEXT_CONFIG_INVALID');
  let baseUrl=(values.baseUrl??providerPreset(llmProvider as LlmProvider).baseUrl).trim().replace(/\/+$/,'');
  const model=(values.model??'').trim();
  if(provider==='llm'){
    let url:URL;try{url=new URL(baseUrl);}catch{throw Error('TEXT_CONFIG_INVALID');}
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||/\/(chat\/completions|responses|messages)$/.test(url.pathname))throw Error('TEXT_CONFIG_INVALID');
    baseUrl=url.href.replace(/\/+$/,'');
    if(!model||model.length>256||/[\x00-\x1f\x7f]/.test(model))throw Error('TEXT_CONFIG_INVALID');
  }
  const maxTokens=values.maxTokens?.trim()?Number(values.maxTokens):undefined,temperature=values.temperature?Number(values.temperature):undefined;
  const tokenField=values.tokenField||providerPreset(llmProvider as LlmProvider).tokenField,responseFormat=values.responseFormat||'text',backend=values.backend||'auto',ocrFilter=values.ocrFilter||'balanced';
  if(maxTokens!==undefined&&(!Number.isSafeInteger(maxTokens)||maxTokens<=0)||temperature!==undefined&&(!Number.isFinite(temperature)||temperature<0||temperature>2)||!['max_tokens','max_completion_tokens'].includes(tokenField)||!['text','json_object','json_schema'].includes(responseFormat)||!['auto','cpu'].includes(backend)||!['balanced','off'].includes(ocrFilter))throw Error('TEXT_CONFIG_INVALID');
  return {provider:provider as ShinobuConfig['provider'],llmProvider:llmProvider as LlmProvider,protocol:protocol as LlmProtocol,thinking:thinking as Thinking,thinkingFormat:thinkingFormat as ThinkingFormat,baseUrl,model,maxTokens,temperature,tokenField:tokenField as ShinobuConfig['tokenField'],responseFormat:responseFormat as ShinobuConfig['responseFormat'],backend:backend as ShinobuConfig['backend'],ocrFilter:ocrFilter as ShinobuConfig['ocrFilter']};
}
export function configValues(config:ShinobuConfig):Record<string,string>{return Object.fromEntries(Object.entries(config).map(([key,value])=>[key,value===undefined?'':String(value)]));}
export const needsInternet=(config:ShinobuConfig)=>config.provider==='google';
export function configFields():ChannelField[]{
  return [
    {key:'backend',label:msg('运行方式'),type:'select',defaultValue:'auto',options:[{value:'auto',label:msg('自动')},{value:'cpu',label:msg('兼容模式（CPU）')}]},
    {key:'ocrFilter',label:msg('文字识别过滤'),type:'select',defaultValue:'balanced',options:[{value:'balanced',label:msg('平衡')},{value:'off',label:msg('关闭')}]},
  ];
}
export function changeServiceValues(previous:Record<string,string>,next:Record<string,string>):Record<string,string>{
  if(next.llmProvider!==previous.llmProvider)return {...providerPreset(next.llmProvider as LlmProvider)};
  if(next.protocol!==previous.protocol)return {...next,thinking:'off',responseFormat:'text',temperature:'',maxTokens:next.protocol==='anthropic'?'16384':'',tokenField:'max_tokens'};
  if(next.thinkingFormat!==previous.thinkingFormat)return {...next,thinking:'off'};
  if(next.model!==previous.model){
    const draft={llmProvider:(next.llmProvider||'custom') as LlmProvider,protocol:(next.llmProvider==='claude'?'anthropic':next.protocol||'openai') as LlmProtocol,thinkingFormat:(next.thinkingFormat||'openai') as ThinkingFormat,model:next.model??''};
    if(next.thinking!=='off'&&!thinkingCapability(draft).levels.includes(next.thinking as Thinking))return {...next,thinking:'off'};
  }
  return next;
}
export function serviceFields(values:Record<string,string>):ChannelField[]{
  const llmProvider=(values.llmProvider||'custom') as LlmProvider,protocol=llmProvider==='claude'?'anthropic':llmProvider==='custom'?(values.protocol||'openai') as LlmProtocol:'openai';
  const thinking=(values.thinking||'off') as Thinking,thinkingFormat=(values.thinkingFormat||'openai') as ThinkingFormat;
  const capability=thinkingCapability({llmProvider,protocol,thinkingFormat,model:values.model??''});
  const levels:Record<Thinking,string>={off:msg('关闭'),on:msg('开启'),minimal:msg('极低'),low:msg('低'),medium:msg('中'),high:msg('高'),xhigh:msg('极高'),max:msg('最高')};
  return [
    {key:'llmProvider',label:msg('供应商类型'),type:'select',defaultValue:'custom',options:[...Object.entries(llmProviders).map(([value,item])=>({value,label:item.label})),{value:'custom',label:msg('自定义供应商')}]},
    {key:'name',label:msg('供应商名称'),type:'text',required:true,placeholder:msg('例如：家里的本地模型')},
    ...(llmProvider==='custom'?[{key:'protocol',label:msg('接口协议'),type:'select' as const,defaultValue:'openai',options:[{value:'openai',label:'OpenAI Chat Completions'},{value:'anthropic',label:'Anthropic Messages'}]}]:[]),
    {key:'baseUrl',label:msg('服务地址'),type:'url',required:true,placeholder:'http://127.0.0.1:1234/v1',help:msg('可使用官方地址或自定义网关，填写接口前缀，不含具体请求方法。')},
    {key:'model',label:msg('模型名称'),type:'text',required:true,placeholder:msg('填写服务中可用的模型名称')},
    {key:'token',label:msg('访问令牌'),type:'password',help:msg('填写所选服务的 API Key 或网关访问令牌；无需鉴权可留空。')},
    ...(llmProvider==='custom'&&protocol==='openai'?[{key:'thinkingFormat',label:msg('思考参数'),type:'select' as const,defaultValue:'openai',options:[{value:'openai',label:'OpenAI · reasoning_effort'},{value:'openrouter',label:'OpenRouter · reasoning'},{value:'thinking',label:'thinking.type'},{value:'enable_thinking',label:'enable_thinking'},{value:'none',label:msg('不发送思考参数')}]}]:[]),
    {key:'thinking',label:msg('思考程度'),type:'select',defaultValue:'off',options:['off' as const,...capability.levels].map(value=>({value,label:levels[value]})),help:!capability.canDisable?msg('此模型强制思考，请选择思考程度或更换模型。'):capability.style==='none'?msg('此模式不发送思考参数，仅用于不需要思考控制的模型。'):capability.style==='budget'?msg('低、中、高分别使用 1024、4096、8192 个思考 Token；输出上限需大于思考预算。'):undefined},
    {key:'maxTokens',label:msg('最大输出 Token'),type:'number',advanced:true,required:protocol==='anthropic',help:protocol==='anthropic'?msg('Messages 接口要求填写输出上限，包含思考与正文 Token。'):msg('留空使用服务默认值。')},
    ...(protocol==='openai'?[{key:'tokenField',label:msg('输出上限参数'),type:'select' as const,defaultValue:'max_tokens',advanced:true,options:['max_tokens','max_completion_tokens'].map(value=>({value,label:value}))}]:[]),
    {key:'responseFormat',label:msg('响应格式'),type:'select',defaultValue:'text',advanced:true,options:[{value:'text',label:msg('基础聊天接口')},...(protocol==='openai'?[{value:'json_object',label:'JSON Object'}]:[]),{value:'json_schema',label:'JSON Schema'}]},
    ...(thinking==='off'&&llmProvider!=='kimi'?[{key:'temperature',label:msg('随机程度'),type:'number' as const,advanced:true,help:msg('留空使用服务默认值。')}]:[]),
  ];
}
