import {describe,it,expect,vi} from 'vitest';
import {llmRequest,parseTranslation} from './protocol';
import {parseConfig,needsInternet} from '../config';
import {llmTranslate} from './openai-compatible';
import {googleTranslate} from './google';
const config=parseConfig({provider:'llm',baseUrl:'http://127.0.0.1:1234/v1',model:'organization/a-long-model-name:Q4_K_M'});
describe('Shinobu text boundary',()=>{
  it('supports basic Chat Completions with reasoning off and optional fields omitted',()=>{
    const request=llmRequest(config,{a:'こんにちは'},'zh-Hans');
    expect(request).toMatchObject({model:config.model,stream:false});
    expect(request).toHaveProperty('reasoning_effort','none');
    expect(request).not.toHaveProperty('max_tokens');expect(request).not.toHaveProperty('response_format');expect(request).not.toHaveProperty('temperature');expect(request).not.toHaveProperty('max_completion_tokens');
    expect(needsInternet(config)).toBe(false);expect(needsInternet(parseConfig({}))).toBe(true);
  });
  it('only sends an explicitly selected token limit and structured-output capability',()=>{
    const request=llmRequest({...config,maxTokens:32768,tokenField:'max_completion_tokens',responseFormat:'json_schema'},{a:'はい'},'zh-Hant');
    expect(request).toHaveProperty('max_completion_tokens',32768);expect(request).not.toHaveProperty('max_tokens');
    expect(request.response_format).toMatchObject({type:'json_schema',json_schema:{schema:{required:['a'],additionalProperties:false}}});
  });
  it('accepts HTTP services while rejecting credential URLs and full method URLs',()=>{
    for(const baseUrl of ['https://key:secret@example.com/v1','https://example.com/v1?token=x','https://example.com/v1/chat/completions'])expect(()=>parseConfig({provider:'llm',baseUrl,model:'test'})).toThrow();
  });
  it('accepts LAN addresses and leaves reachability to the request',()=>{
    for(const baseUrl of ['http://192.168.1.8:1234/v1','http://model.home/v1','http://[fd00::1]:1234/v1']){
      const local=parseConfig({provider:'llm',baseUrl,model:'fixture',maxTokens:'1'});
      expect(local.baseUrl).toBe(baseUrl);expect(local.maxTokens).toBe(1);expect(needsInternet(local)).toBe(false);
    }
  });
  it('requires exactly one unambiguous string value per input ID',()=>{
    expect(parseTranslation('```json\n{"a":"你好\\n世界"}\n```',{a:'hello'})).toEqual({a:'你好\n世界'});
    for(const value of ['{"a":"x","a":"y"}','{"a":42}','{"b":"x"}','{"a":"x",}','{"a":""}','{"a":"x"} trailing','{"a":"x","b":"y"}'])expect(()=>parseTranslation(value,{a:'hello'})).toThrow('TEXT_OUTPUT_INVALID');
  });
  it('keeps secrets and text out of URLs and refuses partial LLM responses',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"a":"你好"}'}}]})));
    expect(await llmTranslate(config,{a:'hello'},'zh-Hans','test-gateway-token',new AbortController().signal,fetcher)).toEqual({a:'你好'});
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(fetcher.mock.calls[0][1]).toMatchObject({method:'POST',redirect:'error',credentials:'omit',headers:{Authorization:'Bearer test-gateway-token'}});
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"a":"你好"}'}}]})));
    await expect(llmTranslate(config,{a:'hello'},'zh-Hans','',new AbortController().signal,fetcher)).rejects.toThrow('TEXT_OUTPUT_INVALID');expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('uses Google POST bodies and preserves each region boundary',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify([[['你好','hello']]])));
    expect(await googleTranslate({a:'hello'},'zh-Hant',new AbortController().signal,fetcher)).toEqual({a:'你好'});
    expect(fetcher.mock.calls[0][0]).not.toContain('hello');expect(fetcher.mock.calls[0][1].body.get('q')).toBe('hello');expect(fetcher.mock.calls[0][1].body.get('tl')).toBe('zh-TW');
  });
  it('reports Google network or access restrictions without replaying or asking for an LLM token',async()=>{
    for(const outcome of [()=>Promise.reject(new TypeError('Failed to fetch')),()=>Promise.resolve(new Response(null,{status:403}))]){
      const fetcher=vi.fn(outcome);
      await expect(googleTranslate({a:'hello'},'zh-Hans',new AbortController().signal,fetcher)).rejects.toThrow('TEXT_GOOGLE_UNAVAILABLE');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
