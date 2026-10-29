import {describe,expect,it,vi} from 'vitest';
import {changeServiceValues,parseConfig,serviceFields} from '../config';
import {llmProviders,providerPreset,type LlmProvider} from '../providers';
import {llmRequest} from './protocol';
import {anthropicRequest,anthropicTranslate} from './anthropic';
const input={a:'こんにちは'};
const config=(provider:LlmProvider,model:string,values:Record<string,string>={})=>parseConfig({...providerPreset(provider),provider:'llm',baseUrl:provider==='custom'?'http://model.home/v1':llmProviders[provider].baseUrl,model,...values});

describe('provider request dialects',()=>{
  it('defaults each built-in provider to an explicit disabled setting',()=>{
    const cases:[LlmProvider,string,Record<string,unknown>][]=[
      ['deepseek','deepseek-flash',{thinking:{type:'disabled'}}],
      ['openrouter','openai/gpt-5.4-mini',{reasoning:{enabled:false}}],
      ['openai','gpt-5.4-mini',{reasoning_effort:'none'}],
      ['claude','claude-sonnet-4-6',{thinking:{type:'disabled'}}],
      ['gemini','gemini-2.5-flash',{reasoning_effort:'none'}],
      ['glm','glm-5.2',{thinking:{type:'disabled'}}],
      ['xiaomi','mimo-v2.5',{thinking:{type:'disabled'}}],
      ['kimi','kimi-k2.6',{thinking:{type:'disabled'}}],
    ];
    for(const [provider,model,expected] of cases){
      const settings=config(provider,model),request=settings.protocol==='anthropic'?anthropicRequest(settings,input,'zh-Hans'):llmRequest(settings,input,'zh-Hans');
      expect(settings.thinking).toBe('off');expect(request).toMatchObject(expected);
    }
  });
  it('uses provider effort vocabulary and omits incompatible sampling parameters',()=>{
    for(const provider of ['deepseek','glm'] as const){
      const request=llmRequest(config(provider,provider==='glm'?'glm-5.3':'deepseek-flash',{thinking:'max',temperature:'0.5'}),input,'zh-Hans');
      expect(request).toMatchObject({thinking:{type:'enabled'},reasoning_effort:'max'});expect(request).not.toHaveProperty('temperature');
    }
    expect(llmRequest(config('kimi','kimi-k3.1-pro',{thinking:'low',temperature:'0.6'}),input,'zh-Hans')).toMatchObject({reasoning_effort:'low'});
    expect(llmRequest(config('openrouter','example/reasoning',{thinking:'high'}),input,'zh-Hans')).toHaveProperty('reasoning',{enabled:true,effort:'high'});
    for(const model of ['gpt-4.1-mini','gpt-4o','gpt-4o-mini'])expect(llmRequest(config('openai',model),input,'zh-Hans')).not.toHaveProperty('reasoning_effort');
  });
  it('does not silently enable mandatory reasoning or silently downgrade an unsupported level',()=>{
    for(const [provider,model] of [['openai','gpt-6.1-sol'],['gemini','gemini-3.8-flash'],['glm','glm-5.3'],['kimi','kimi-k3.1-pro']] as const){
      expect(()=>llmRequest(config(provider,model),input,'zh-Hans')).toThrow('TEXT_THINKING_REQUIRED');
    }
    expect(()=>llmRequest(config('openrouter','google/gemini-3.8-flash'),input,'zh-Hans')).toThrow('TEXT_THINKING_REQUIRED');
    expect(()=>llmRequest(config('openai','gpt-5-mini-2025-08-07'),input,'zh-Hans')).toThrow('TEXT_THINKING_REQUIRED');
    expect(()=>llmRequest(config('openai','o3',{thinking:'minimal'}),input,'zh-Hans')).toThrow('TEXT_THINKING_INVALID');
    expect(()=>llmRequest(config('xiaomi','mimo-v2.5',{thinking:'low'}),input,'zh-Hans')).toThrow('TEXT_THINKING_INVALID');
  });
  it('supports custom gateways without detecting a provider from the hostname',()=>{
    const settings=config('deepseek','deepseek-flash',{baseUrl:'http://model.home/deepseek',thinking:'high'});
    expect(settings.baseUrl).toBe('http://model.home/deepseek');expect(llmRequest(settings,input,'zh-Hans')).toMatchObject({thinking:{type:'enabled'},reasoning_effort:'high'});
    expect(llmRequest(config('custom','local-model',{thinkingFormat:'none'}),input,'zh-Hans')).not.toHaveProperty('reasoning_effort');
    expect(llmRequest(config('custom','local-model',{thinkingFormat:'enable_thinking'}),input,'zh-Hans')).toHaveProperty('enable_thinking',false);
  });
  it('maps Claude budgets/adaptive effort and keeps JSON schema beside effort',()=>{
    expect(anthropicRequest(config('claude','claude-haiku-4-5',{thinking:'low'}),input,'zh-Hans')).toMatchObject({thinking:{type:'enabled',budget_tokens:1024},max_tokens:16384});
    expect(()=>anthropicRequest(config('claude','claude-haiku-4-5',{thinking:'high',maxTokens:'8192'}),input,'zh-Hans')).toThrow('TEXT_THINKING_BUDGET');
    const request=anthropicRequest(config('claude','claude-sonnet-4-6',{thinking:'medium',responseFormat:'json_schema',temperature:'0.5'}),input,'zh-Hant');
    expect(request).toMatchObject({thinking:{type:'adaptive'},output_config:{effort:'medium',format:{type:'json_schema',schema:{required:['a'],additionalProperties:false}}}});expect(request).not.toHaveProperty('temperature');expect(request.system).toContain('Traditional Chinese');
  });
  it('authenticates native Messages requests and excludes thinking from translated text',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({type:'message',stop_reason:'end_turn',content:[{type:'thinking',thinking:'not translation'},{type:'text',text:'{"a":"你好"}'}]})));
    const settings=config('claude','claude-sonnet-4-6');
    expect(await anthropicTranslate(settings,input,'zh-Hans','fixture-key',new AbortController().signal,fetcher)).toEqual({a:'你好'});
    expect(fetcher).toHaveBeenCalledWith(settings.baseUrl+'/messages',expect.objectContaining({headers:expect.objectContaining({'x-api-key':'fixture-key','anthropic-version':'2023-06-01'}),redirect:'error',credentials:'omit'}));
    for(const response of [{type:'message',stop_reason:'max_tokens',content:[{type:'text',text:'{"a":"你好"}'}]},{type:'message',stop_reason:'end_turn',content:[{type:'tool_use'}]},null,{type:'message',stop_reason:'end_turn',content:[null]}]){
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify(response)));
      await expect(anthropicTranslate(settings,input,'zh-Hans','fixture-key',new AbortController().signal,fetcher)).rejects.toThrow('TEXT_OUTPUT_INVALID');
    }
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('resets preset-specific values and drafts without copying credentials to a new destination',()=>{
    const previous={...providerPreset('openai'),token:'fixture-secret',thinking:'high',model:'gpt-5.4-mini'};
    const next=changeServiceValues(previous,{...previous,llmProvider:'claude'});
    expect(next).toMatchObject({name:'Claude',baseUrl:'https://api.anthropic.com/v1',token:'',model:'',thinking:'off',protocol:'anthropic',maxTokens:'16384'});
    expect(serviceFields({...providerPreset('xiaomi'),model:'mimo-v2.5'}).find(field=>field.key==='thinking')?.options?.map(option=>option.value)).toEqual(['off','on']);
    expect(serviceFields(next).map(field=>field.key)).not.toContain('tokenField');
  });
});
