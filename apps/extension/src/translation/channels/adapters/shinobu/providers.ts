import {msg} from '../../../../i18n/runtime';
/** Provider presets are configuration, not separate image/reader pipelines. */
export const llmProviders = {
  deepseek:{label:'DeepSeek',baseUrl:'https://api.deepseek.com/v1'},
  openrouter:{label:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1'},
  openai:{label:'OpenAI',baseUrl:'https://api.openai.com/v1'},
  claude:{label:'Claude',baseUrl:'https://api.anthropic.com/v1'},
  gemini:{label:'Gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai'},
  glm:{get label(){return msg('GLM / 智谱');},baseUrl:'https://open.bigmodel.cn/api/paas/v4'},
  xiaomi:{label:'Xiaomi MiMo',baseUrl:'https://api.xiaomimimo.com/v1'},
  kimi:{label:'Kimi',baseUrl:'https://api.moonshot.cn/v1'},
} as const;
export type LlmProvider=keyof typeof llmProviders|'custom';
export type LlmProtocol='openai'|'anthropic';
export type ThinkingFormat='openai'|'openrouter'|'thinking'|'enable_thinking'|'none';
export type Thinking='off'|'on'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max';
export interface ThinkingSettings {llmProvider:LlmProvider;protocol:LlmProtocol;thinkingFormat:ThinkingFormat;model:string;thinking:Thinking;}
export const thinkingValues:readonly Thinking[]=['off','on','minimal','low','medium','high','xhigh','max'];
export function providerPreset(provider:LlmProvider):Record<string,string>{
  const preset=provider==='custom'?undefined:llmProviders[provider];
  return {llmProvider:provider,name:preset?.label??'',baseUrl:preset?.baseUrl??'',model:'',token:'',protocol:provider==='claude'?'anthropic':'openai',thinking:'off',thinkingFormat:'openai',tokenField:provider==='openai'||provider==='xiaomi'?'max_completion_tokens':'max_tokens',responseFormat:'text',temperature:'',maxTokens:provider==='claude'?'16384':''};
}

type ThinkingStyle='none'|'effort'|'openrouter'|'toggle'|'toggle-effort'|'enable_thinking'|'adaptive'|'budget';
export function thinkingCapability(config:Pick<ThinkingSettings,'llmProvider'|'protocol'|'thinkingFormat'|'model'>):{style:ThinkingStyle;levels:readonly Thinking[];canDisable:boolean;betweenTools?:boolean}{
  const model=config.model.toLowerCase().replace(/^(claude-(?:sonnet|opus|haiku)-\d+)\.(\d+)/,'$1-$2'),basic={canDisable:true};
  if(config.protocol==='anthropic'){
    if(/^claude-(?:3-(?:haiku|sonnet|opus)|3[.-]5)/.test(model))return {...basic,style:'none',levels:[]};
    const manual=/^claude-(?:3[.-]7|(?:sonnet|opus|haiku)-4(?:[.-]5)?(?:-|$))/.test(model)&&!/^claude-(?:sonnet|opus)-4-[6-9]/.test(model);
    return {style:manual?'budget':'adaptive',levels:['low','medium','high'],canDisable:!/^claude-(?:fable|mythos|opus-5-5)/.test(model),betweenTools:/^claude-sonnet-5-5/.test(model)};
  }
  switch(config.llmProvider){
    case 'openrouter':{
      const [namespace,...rest]=model.split('/'),provider=({openai:'openai',anthropic:'claude',google:'gemini','z-ai':'glm',deepseek:'deepseek',xiaomi:'xiaomi',moonshotai:'kimi'} as Record<string,LlmProvider>)[namespace];
      if(provider&&rest.length){
        const native=thinkingCapability({...config,llmProvider:provider,protocol:provider==='claude'?'anthropic':'openai',model:rest.join('/')});
        return {...native,style:'openrouter'};
      }
      return {...basic,style:'openrouter',levels:['minimal','low','medium','high','xhigh','max']};
    }
    case 'deepseek':return {...basic,style:'toggle-effort',levels:['low','high','max']};
    case 'glm':{
      const version=Number(model.match(/^glm-(\d+(?:\.\d+)?)/)?.[1]??0);
      return {style:version>=5.2?'toggle-effort':'toggle',levels:version>=5.3?['low','high','max']:version>=5.2?['high','max']:['on'],canDisable:!/^glm-5\.3(?:-flash)?$/.test(model)};
    }
    case 'xiaomi':return {...basic,style:'toggle',levels:['on']};
    case 'kimi':return /^kimi-k3/.test(model)?{style:'effort',levels:['low','high','max'],canDisable:false}:{style:'toggle',levels:['on'],canDisable:!/^kimi-k2\.7-code/.test(model)};
    case 'gemini':return /^gemini-(?:1|2\.0)/.test(model)?{...basic,style:'none',levels:[]}:{style:'effort',levels:/^gemini-2\.5/.test(model)?['low','medium','high']:['minimal','low','medium','high'],canDisable:!/^gemini-(?:2\.5-pro|[3-9])/.test(model)};
    case 'openai':{
      if(/^(?:gpt-(?:3\.5|4o?)(?:[.-]|$)|chatgpt-4o)/.test(model))return {...basic,style:'none',levels:[]};
      const original=/^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model),oSeries=/^o\d/.test(model),latest=/^gpt-(?:5\.[2-9]|[6-9])/.test(model);
      return {style:'effort',levels:original?['minimal','low','medium','high']:latest?['low','medium','high','xhigh']:['low','medium','high'],canDisable:!original&&!oSeries&&!/^gpt-6/.test(model)};
    }
    default:{
      const style=({openai:'effort',openrouter:'openrouter',thinking:'toggle',enable_thinking:'enable_thinking',none:'none'} as const)[config.thinkingFormat];
      return {...basic,style,levels:style==='none'?[]:style==='toggle'||style==='enable_thinking'?['on']:['minimal','low','medium','high','xhigh','max']};
    }
  }
}
export function validateThinking(config:ThinkingSettings){
  const capability=thinkingCapability(config);
  if(config.thinking==='off'){if(!capability.canDisable)throw Error('TEXT_THINKING_REQUIRED');}
  else if(!capability.levels.includes(config.thinking))throw Error('TEXT_THINKING_INVALID');
}
export function thinkingParameters(config:ThinkingSettings,maxTokens?:number):Record<string,unknown>{
  validateThinking(config);
  const {style,betweenTools}=thinkingCapability(config),off=config.thinking==='off';
  switch(style){
    case 'none':return {};
    case 'effort':return {reasoning_effort:off?'none':config.thinking};
    case 'openrouter':return {reasoning:off?{enabled:false}:{enabled:true,...(config.thinking==='on'?{}:{effort:config.thinking})}};
    case 'toggle':return {thinking:{type:off?'disabled':'enabled'}};
    case 'toggle-effort':return {thinking:{type:off?'disabled':'enabled'},...(!off?{reasoning_effort:config.thinking}:{})};
    case 'enable_thinking':return {enable_thinking:!off};
    case 'adaptive':return off?{thinking:{type:betweenTools?'between_tools':'disabled'}}:{thinking:{type:'adaptive'},output_config:{effort:config.thinking}};
    case 'budget':{
      if(off)return {thinking:{type:'disabled'}};
      const budget=({low:1024,medium:4096,high:8192} as Record<string,number>)[config.thinking];
      if(maxTokens===undefined||maxTokens<=budget)throw Error('TEXT_THINKING_BUDGET');
      return {thinking:{type:'enabled',budget_tokens:budget}};
    }
  }
}
