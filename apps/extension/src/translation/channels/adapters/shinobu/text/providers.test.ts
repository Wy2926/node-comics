import {describe,expect,it,vi} from 'vitest';
import {changeServiceValues,draftConfig,serviceFields} from '../config';
import {llmProviders,providerPreset,type LlmProvider} from '../providers';
import {llmRequest} from './protocol';
import {anthropicRequest,anthropicTranslate} from './anthropic';
const input={a:'こんにちは'};
const config=(provider:LlmProvider,model:string,values:Record<string,string>={})=>draftConfig({...providerPreset(provider),baseUrl:provider==='custom'?'http://model.home/v1':llmProviders[provider].baseUrl,model,...values});

describe('provider request dialects',()=>{
  it('starts every preset without a model or reasoning override and accepts an unlisted ID',()=>{
    for(const provider of [...Object.keys(llmProviders),'custom'] as LlmProvider[]){
      expect(providerPreset(provider).model).toBe('');
      const settings=config(provider,'internal/译者:latest'),request=settings.protocol==='anthropic'?anthropicRequest(settings,input,'zh-Hans'):llmRequest(settings,input,'zh-Hans');
      expect(request.model).toBe('internal/译者:latest');
      for(const key of ['thinking','reasoning_effort','reasoning','enable_thinking','output_config'])expect(request).not.toHaveProperty(key);
    }
  });
  it('keeps explicit settings across aliases and leaves capability checks to the provider',()=>{
    const options=(values:Record<string,string>)=>serviceFields(values).find(field=>field.key==='thinking')!.options!.map(item=>item.value);
    for(const [provider,oldName] of [['openai','o3'],['openrouter','google/gemini-3.8-flash'],['kimi','kimi-k3.1-pro'],['glm','glm-5.3'],['gemini','gemini-2.5-pro'],['claude','claude-opus-5-5']] as const){
      for(const thinking of ['off','minimal','xhigh']){
        const draft={...providerPreset(provider),model:oldName,thinking,temperature:'0.5'};
        const next=changeServiceValues(draft,{...draft,model:'gateway/alias'});expect(next.thinking).toBe(thinking);
        const settings=draftConfig(draft),request=settings.protocol==='anthropic'?anthropicRequest:llmRequest;
        expect(request(settings,input,'en')).toEqual({...request(draftConfig(next),input,'en'),model:oldName});
        expect(request(settings,input,'en').temperature).toBe(0.5);
        expect(options(next)).toEqual(options(draft));expect(options(next)).toContain(thinking);
      }
    }
  });
  it('encodes explicit levels in the chosen wire dialect',()=>{
    expect(llmRequest(config('openai','alias',{thinking:'off'}),input,'en')).toHaveProperty('reasoning_effort','none');
    expect(llmRequest(config('openrouter','alias',{thinking:'high'}),input,'en')).toHaveProperty('reasoning',{enabled:true,effort:'high'});
    expect(llmRequest(config('kimi','alias',{thinking:'on'}),input,'en')).toHaveProperty('thinking',{type:'enabled'});
    expect(llmRequest(config('kimi','alias',{thinking:'minimal'}),input,'en')).toHaveProperty('reasoning_effort','minimal');
  });
  it('supports custom gateways without detecting a provider from the hostname',()=>{
    const settings=config('deepseek','alias',{baseUrl:'http://model.home/deepseek',thinking:'high'});
    expect(settings.baseUrl).toBe('http://model.home/deepseek');expect(llmRequest(settings,input,'zh-Hans')).toMatchObject({thinking:{type:'enabled'},reasoning_effort:'high'});
    expect(llmRequest(config('custom','local-model',{thinkingFormat:'none',thinking:'high'}),input,'zh-Hans')).not.toHaveProperty('reasoning_effort');
    expect(llmRequest(config('custom','local-model',{thinkingFormat:'enable_thinking',thinking:'off'}),input,'zh-Hans')).toHaveProperty('enable_thinking',false);
  });
  it('sends explicit Messages budgets and adaptive effort without inferring either from a name',()=>{
    expect(anthropicRequest(config('claude','alias',{thinking:'on',thinkingBudget:'512',maxTokens:'512'}),input,'en')).toMatchObject({thinking:{type:'enabled',budget_tokens:512},max_tokens:512});
    expect(()=>config('claude','alias',{thinking:'on',thinkingBudget:'-1'})).toThrow('思考预算必须为正整数');
    const request=anthropicRequest(config('claude','alias',{thinking:'medium',responseFormat:'json_schema',temperature:'0.5'}),input,'zh-Hant');
    expect(request).toMatchObject({thinking:{type:'adaptive'},output_config:{effort:'medium',format:{type:'json_schema',schema:{required:['a'],additionalProperties:false}}},temperature:0.5});expect(request.system).toContain('Traditional Chinese');
  });
  it('authenticates native Messages requests and excludes thinking from translated text',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({type:'message',stop_reason:'end_turn',content:[{type:'thinking',thinking:'not translation'},{type:'text',text:'{"a":"你好"}'}]})));
    const settings=config('claude','messages-fixture');
    expect(await anthropicTranslate(settings,input,'zh-Hans','fixture-key',new AbortController().signal,fetcher)).toEqual({a:'你好'});
    expect(fetcher).toHaveBeenCalledWith(settings.baseUrl+'/messages',expect.objectContaining({headers:expect.objectContaining({'x-api-key':'fixture-key','anthropic-version':'2023-06-01'}),redirect:'error',credentials:'omit'}));
    fetcher.mockResolvedValueOnce(Response.json({type:'message',stop_reason:'max_tokens',content:[{type:'text',text:'{"a":"你好"}'}]}));
    await expect(anthropicTranslate(settings,input,'zh-Hans','fixture-key',new AbortController().signal,fetcher)).rejects.toThrow('TEXT_OUTPUT_TRUNCATED');
    for(const response of [{type:'message',stop_reason:'end_turn',content:[{type:'tool_use'}]},null,{type:'message',stop_reason:'end_turn',content:[null]}]){
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify(response)));
      await expect(anthropicTranslate(settings,input,'zh-Hans','fixture-key',new AbortController().signal,fetcher)).rejects.toThrow('TEXT_OUTPUT_INVALID');
    }
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('resets preset-specific values and drafts without copying credentials to a new destination',()=>{
    const previous={...providerPreset('openai'),token:'fixture-secret',thinking:'high',model:'previous-id'};
    const next=changeServiceValues(previous,{...previous,llmProvider:'claude'});
    expect(next).toMatchObject({name:'Claude',baseUrl:'https://api.anthropic.com/v1',token:'',model:'',thinking:'auto',protocol:'anthropic',maxTokens:'16384'});
    expect(changeServiceValues(previous,{...previous,baseUrl:'http://another.home/v1'}).token).toBe('');
    expect(serviceFields(next).map(field=>field.key)).not.toContain('tokenField');
  });
});
