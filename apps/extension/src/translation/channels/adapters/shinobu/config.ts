import type {ChannelField} from '../../contracts';
import {msg} from '../../../../i18n/runtime';
export const ENGINE_REVISION='shinobu-c4239a2-node2';
export interface ShinobuConfig {provider:'google'|'llm';baseUrl:string;model:string;maxTokens?:number;tokenField:'max_tokens'|'max_completion_tokens';responseFormat:'text'|'json_object'|'json_schema';temperature?:number;backend:'auto'|'cpu';ocrFilter:'balanced'|'off';}
export function parseConfig(values:Record<string,string>):ShinobuConfig{
  const provider=values.provider||'google';
  if(!['google','llm'].includes(provider))throw Error('TEXT_CONFIG_INVALID');
  let baseUrl=(values.baseUrl??'').trim().replace(/\/+$/,'');
  const model=(values.model??'').trim();
  if(provider==='llm'){
    let url:URL;try{url=new URL(baseUrl);}catch{throw Error('TEXT_CONFIG_INVALID');}
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||/\/(chat\/completions|responses)$/.test(url.pathname))throw Error('TEXT_CONFIG_INVALID');
    baseUrl=url.href.replace(/\/+$/,'');
    if(!model||model.length>256||/[\x00-\x1f\x7f]/.test(model))throw Error('TEXT_CONFIG_INVALID');
  }
  const maxTokens=values.maxTokens?.trim()?Number(values.maxTokens):undefined,temperature=values.temperature?Number(values.temperature):undefined;
  const tokenField=values.tokenField||'max_tokens',responseFormat=values.responseFormat||'text',backend=values.backend||'auto',ocrFilter=values.ocrFilter||'balanced';
  if(maxTokens!==undefined&&(!Number.isSafeInteger(maxTokens)||maxTokens<=0)||temperature!==undefined&&(!Number.isFinite(temperature)||temperature<0||temperature>2)||!['max_tokens','max_completion_tokens'].includes(tokenField)||!['text','json_object','json_schema'].includes(responseFormat)||!['auto','cpu'].includes(backend)||!['balanced','off'].includes(ocrFilter))throw Error('TEXT_CONFIG_INVALID');
  return {provider:provider as ShinobuConfig['provider'],baseUrl,model,maxTokens,temperature,tokenField:tokenField as ShinobuConfig['tokenField'],responseFormat:responseFormat as ShinobuConfig['responseFormat'],backend:backend as ShinobuConfig['backend'],ocrFilter:ocrFilter as ShinobuConfig['ocrFilter']};
}
export function configValues(config:ShinobuConfig):Record<string,string>{return Object.fromEntries(Object.entries(config).map(([key,value])=>[key,value===undefined?'':String(value)]));}
export const needsInternet=(config:ShinobuConfig)=>config.provider==='google';
export function configFields():ChannelField[]{
  return [
    {key:'backend',label:msg('运行方式'),type:'select',defaultValue:'auto',options:[{value:'auto',label:msg('自动')},{value:'cpu',label:msg('兼容模式（CPU）')}]},
    {key:'ocrFilter',label:msg('文字识别过滤'),type:'select',defaultValue:'balanced',options:[{value:'balanced',label:msg('平衡')},{value:'off',label:msg('关闭')}]},
  ];
}
export function serviceFields():ChannelField[]{
  return [
    {key:'name',label:msg('供应商名称'),type:'text',required:true,placeholder:msg('例如：家里的本地模型')},
    {key:'baseUrl',label:msg('服务地址'),type:'url',required:true,placeholder:'http://127.0.0.1:1234/v1',help:msg('使用兼容 OpenAI 的聊天接口地址，填写到 /v1，无需填写 /chat/completions。')},
    {key:'model',label:msg('模型名称'),type:'text',required:true,placeholder:msg('填写服务中可用的模型名称')},
    {key:'token',label:msg('访问令牌'),type:'password',help:msg('填写网关访问令牌；无需鉴权的本机服务可留空。')},
    {key:'maxTokens',label:msg('最大输出 Token'),type:'number',advanced:true,help:msg('留空使用服务默认值。')},
    {key:'tokenField',label:msg('输出上限参数'),type:'select',defaultValue:'max_tokens',advanced:true,options:['max_tokens','max_completion_tokens'].map(value=>({value,label:value}))},
    {key:'responseFormat',label:msg('响应格式'),type:'select',defaultValue:'text',advanced:true,options:[{value:'text',label:msg('基础聊天接口')},{value:'json_object',label:'JSON Object'},{value:'json_schema',label:'JSON Schema'}]},
    {key:'temperature',label:msg('随机程度'),type:'number',advanced:true,help:msg('留空使用服务默认值。')},
  ];
}
