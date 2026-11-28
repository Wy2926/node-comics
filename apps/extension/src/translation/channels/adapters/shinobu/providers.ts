import {msg} from '../../../../i18n/runtime';
/** 预设只描述接入方式，不提供模型目录，也不根据模型名推断能力。 */
export const llmProviders = {
  deepseek:{label:'DeepSeek',baseUrl:'https://api.deepseek.com/v1',wire:'toggle-effort'},
  openrouter:{label:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1',wire:'openrouter'},
  openai:{label:'OpenAI',baseUrl:'https://api.openai.com/v1',wire:'openai'},
  claude:{label:'Claude',baseUrl:'https://api.anthropic.com/v1',wire:'messages'},
  gemini:{label:'Gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai',wire:'openai'},
  glm:{get label(){return msg('GLM / 智谱');},baseUrl:'https://open.bigmodel.cn/api/paas/v4',wire:'toggle-effort'},
  xiaomi:{label:'Xiaomi MiMo',baseUrl:'https://api.xiaomimimo.com/v1',wire:'toggle-effort'},
  kimi:{label:'Kimi',baseUrl:'https://api.moonshot.cn/v1',wire:'toggle-or-effort'},
} as const;
export type LlmProvider=keyof typeof llmProviders|'custom';
export type LlmProtocol='openai'|'anthropic';
export type ThinkingFormat='openai'|'openrouter'|'thinking'|'enable_thinking'|'none';
export const thinkingValues=['auto','off','on','minimal','low','medium','high','xhigh','max'] as const;
export type Thinking=typeof thinkingValues[number];
export interface ThinkingSettings {llmProvider:LlmProvider;protocol:LlmProtocol;thinkingFormat:ThinkingFormat;thinking:Thinking;thinkingBudget?:number;}
export function providerPreset(provider:LlmProvider):Record<string,string>{
  const preset=provider==='custom'?undefined:llmProviders[provider];
  return {llmProvider:provider,name:preset?.label??'',baseUrl:preset?.baseUrl??'',model:'',token:'',protocol:provider==='claude'?'anthropic':'openai',thinking:'auto',thinkingFormat:'openai',tokenField:provider==='openai'||provider==='xiaomi'?'max_completion_tokens':'max_tokens',responseFormat:'text',temperature:'',maxTokens:provider==='claude'?'16384':''};
}

export function thinkingWire({protocol,llmProvider,thinkingFormat}:Pick<ThinkingSettings,'protocol'|'llmProvider'|'thinkingFormat'>){
  return protocol==='anthropic'?'messages':llmProvider==='custom'?thinkingFormat:llmProviders[llmProvider].wire;
}
export function thinkingParameters(config:ThinkingSettings):Record<string,unknown>{
  // 未指定时完全省略；明确关闭和使用服务默认值是两种不同的请求。
  const {thinking,thinkingBudget}=config;
  if(thinking==='auto')return {};
  const off=thinking==='off',effort=off||thinking==='on'?undefined:thinking,toggle={type:off?'disabled':'enabled'};
  switch(thinkingWire(config)){
    case 'none':return {};
    case 'openai':return {reasoning_effort:off?'none':thinking};
    case 'openrouter':return {reasoning:{enabled:!off,...(effort?{effort}:{})}};
    case 'thinking':return {thinking:toggle};
    case 'enable_thinking':return {enable_thinking:!off};
    case 'toggle-effort':return {thinking:toggle,...(effort?{reasoning_effort:effort}:{})};
    case 'toggle-or-effort':return effort?{reasoning_effort:effort}:{thinking:toggle};
    case 'messages':
      if(off)return {thinking:toggle};
      if(thinking==='on'&&thinkingBudget!==undefined)return {thinking:{type:'enabled',budget_tokens:thinkingBudget}};
      return {thinking:{type:'adaptive'},...(effort?{output_config:{effort}}:{})};
  }
}
