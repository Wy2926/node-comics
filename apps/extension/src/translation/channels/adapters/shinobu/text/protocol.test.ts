import {describe,it,expect,vi} from 'vitest';
import {batches,llmRequest,parseTranslation} from './protocol';
import {parseConfig,needsInternet} from '../config';
import {llmTranslate} from './openai-compatible';
import {googleTranslate} from './google';
const config=parseConfig({provider:'llm',baseUrl:'http://127.0.0.1:1234/v1',model:'organization/a-long-model-name:Q4_K_M'});
describe('Shinobu text boundary',()=>{
  it('supports minimal Chat Completions without optional schema or reasoning fields',()=>{
    const request=llmRequest(config,{a:'こんにちは'},'zh-Hans');
    expect(request).toMatchObject({model:config.model,stream:false,max_tokens:4096});
    expect(request).not.toHaveProperty('response_format');expect(request).not.toHaveProperty('temperature');expect(request).not.toHaveProperty('max_completion_tokens');
    expect(needsInternet(config)).toBe(false);expect(needsInternet(parseConfig({}))).toBe(true);
  });
  it('only sends an explicitly selected token limit and structured-output capability',()=>{
    const request=llmRequest({...config,tokenField:'max_completion_tokens',responseFormat:'json_schema'},{a:'はい'},'zh-Hant');
    expect(request).toHaveProperty('max_completion_tokens',4096);expect(request).not.toHaveProperty('max_tokens');
    expect(request.response_format).toMatchObject({type:'json_schema',json_schema:{schema:{required:['a'],additionalProperties:false}}});
  });
  it('rejects credential URLs, insecure remote hosts and full method URLs',()=>{
    for(const baseUrl of ['http://remote.example/v1','https://key:secret@example.com/v1','https://example.com/v1?token=x','https://example.com/v1/chat/completions'])expect(()=>parseConfig({provider:'llm',baseUrl,model:'test'})).toThrow();
  });
  it('requires exactly one unambiguous string value per input ID',()=>{
    expect(parseTranslation('```json\n{"a":"你好\\n世界"}\n```',{a:'hello'})).toEqual({a:'你好\n世界'});
    for(const value of ['{"a":"x","a":"y"}','{"a":42}','{"b":"x"}','{"a":"x",}','{"a":""}','{"a":"x"} trailing','{"a":"x","b":"y"}'])expect(()=>parseTranslation(value,{a:'hello'})).toThrow('TEXT_OUTPUT_INVALID');
  });
  it('plans bounded batches before any requests',()=>{
    const input=Array.from({length:33},(_,i)=>({id:'r'+i,sourceText:'text',translatedText:''}));expect(batches(input).map(batch=>Object.keys(batch).length)).toEqual([32,1]);
    expect(()=>batches([{id:'a',sourceText:'x'.repeat(8001),translatedText:''}])).toThrow('TEXT_INPUT_LIMIT');
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
