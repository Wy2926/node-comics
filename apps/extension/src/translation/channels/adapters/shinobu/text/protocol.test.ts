import {describe,it,expect,vi} from 'vitest';
import {llmRequest,parseTranslation} from './protocol';
import {parseConfig,needsInternet} from '../config';
import {llmTranslate} from './openai-compatible';
import {googleTranslate} from './google';
import {anthropicRequest} from './anthropic';
import {localFailureCode} from '../failure-code';
import {errorMessage} from '../errors';
import {translationNotice} from '../../../../notice';
const config=parseConfig({provider:'llm',baseUrl:'http://127.0.0.1:1234/v1',model:'organization/a-long-model-name:Q4_K_M'});
describe('Shinobu text boundary',()=>{
  it('supports basic Chat Completions without overriding the service defaults',()=>{
    const request=llmRequest(config,{a:'こんにちは'},'zh-Hans');
    expect(request).toMatchObject({model:config.model,stream:false});
    expect(request).not.toHaveProperty('reasoning_effort');
    expect(request).not.toHaveProperty('max_tokens');expect(request).not.toHaveProperty('response_format');expect(request).not.toHaveProperty('temperature');expect(request).not.toHaveProperty('max_completion_tokens');
    expect(needsInternet(config)).toBe(false);expect(needsInternet(parseConfig({}))).toBe(true);
  });
  it('only sends an explicitly selected token limit and structured-output capability',()=>{
    const request=llmRequest({...config,maxTokens:32768,tokenField:'max_completion_tokens',responseFormat:'json_schema'},{a:'はい'},'zh-Hant');
    expect(request).toHaveProperty('max_completion_tokens',32768);expect(request).not.toHaveProperty('max_tokens');
    expect(request.response_format).toMatchObject({type:'json_schema',json_schema:{schema:{required:['a'],additionalProperties:false}}});
  });
  it('adds multiline preferences to both system prompts while keeping the language, output rules and dialogue intact',()=>{
    const input={a:'「ソラ！」',b:'Wait!'},customPrompt='Keep “Sora” as a name.\nUse informal speech.';
    const defaults=llmRequest(config,input,'es').messages;
    const chat=llmRequest({...config,customPrompt},input,'es').messages;
    const native=anthropicRequest({...config,protocol:'anthropic',maxTokens:1024,customPrompt},input,'es');
    expect(chat[0].role).toBe('system');
    expect(chat[0].content).toContain(defaults[0].content);
    expect(chat[0].content).toContain(customPrompt);
    expect(native.system).toBe(chat[0].content);
    expect(chat.slice(1)).toEqual([{role:'user',content:JSON.stringify(input)}]);
    expect(native.messages).toEqual(chat.slice(1));
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
    await expect(llmTranslate(config,{a:'hello'},'zh-Hans','',new AbortController().signal,fetcher)).rejects.toThrow('TEXT_OUTPUT_TRUNCATED');expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('uses Google POST bodies and preserves each region boundary',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify([[['你好','hello']]])));
    expect(await googleTranslate({a:'hello'},'zh-Hant',new AbortController().signal,fetcher)).toEqual({a:'你好'});
    expect(fetcher.mock.calls[0][0]).not.toContain('hello');expect(fetcher.mock.calls[0][1].body.get('q')).toBe('hello');expect(fetcher.mock.calls[0][1].body.get('tl')).toBe('zh-TW');
  });
  it.each([['ja','Japanese'],['ko','Korean'],['en','English'],['es','Spanish']])('translates to %s consistently across Google and both LLM protocols',async(language,name)=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify([[['translated','original']]])));
    await googleTranslate({a:'你好'},language,new AbortController().signal,fetcher);
    const request=fetcher.mock.calls[0] as unknown as [string,{body:URLSearchParams}];
    expect(request[1].body.get('tl')).toBe(language);expect(request[1].body.get('sl')).toBe('auto');
    expect(llmRequest(config,{a:'你好'},language).messages[0].content).toContain('into '+name);
    expect(anthropicRequest({...config,llmProvider:'claude',protocol:'anthropic',maxTokens:16384},{a:'你好'},language).system).toContain('into '+name);
  });
  it('never sends unsupported targets to a text service or substitutes Chinese',async()=>{
    const fetcher=vi.fn();
    await expect(googleTranslate({a:'hello'},'fr',new AbortController().signal,fetcher)).rejects.toThrow('TEXT_LANGUAGE_UNSUPPORTED');
    await expect(llmTranslate(config,{a:'hello'},'fr','',new AbortController().signal,fetcher)).rejects.toThrow('TEXT_LANGUAGE_UNSUPPORTED');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reports Google network or access restrictions without replaying or asking for an LLM token',async()=>{
    for(const [outcome,code] of [[()=>Promise.reject(new TypeError('Failed to fetch')),'TEXT_GOOGLE_UNAVAILABLE'],[()=>Promise.resolve(new Response(null,{status:403})),'TEXT_GOOGLE_HTTP_403']] as const){
      const fetcher=vi.fn(outcome);
      await expect(googleTranslate({a:'hello'},'zh-Hans',new AbortController().signal,fetcher)).rejects.toThrow(code);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('ends a stalled Google response body without starting the next region or replaying the page',async()=>{
    const deadline=new AbortController(),caller=new AbortController(),reading=Promise.withResolvers<void>();
    const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(deadline.signal);
    const fetcher=vi.fn<typeof fetch>(async(_url,options)=>new Response(new ReadableStream({
      start(stream){const signal=options!.signal!;signal.addEventListener('abort',()=>stream.error(signal.reason),{once:true});},
      pull(){reading.resolve();},
    })));
    try{
      const result=googleTranslate({a:'hello',b:'world'},'zh-Hans',caller.signal,fetcher);
      await reading.promise;
      expect(timeout).toHaveBeenCalledWith(15_000);
      deadline.abort(new DOMException('Timed out','TimeoutError'));
      await expect(result).rejects.toThrow('TEXT_GOOGLE_UNAVAILABLE');
      expect(fetcher).toHaveBeenCalledOnce();expect(caller.signal.aborted).toBe(false);
    }finally{timeout.mockRestore();}
  });
  it('keeps the HTTP status through local error handling without echoing provider text',async()=>{
    const fetcher=vi.fn(async()=>new Response('private OCR and token',{status:404}));
    const code=await llmTranslate(config,{a:'hello'},'zh-Hans','private-token',new AbortController().signal,fetcher).then(()=>'',localFailureCode);
    expect(translationNotice({kind:'error',message:errorMessage(code),code}).detail).toBe('未找到接口或模型，请核对服务地址和模型 ID。 (HTTP 404)');
  });
  it('accepts only owned error codes, never private exception details',()=>{
    const code=localFailureCode(Error('PIPELINE_OCR_TIMEOUT'));
    expect(code).toBe('PIPELINE_OCR_TIMEOUT');expect(errorMessage(code)).toContain('文字识别');
    expect(localFailureCode(Error('PRIVATE_TOKEN'))).toBe('PIPELINE_FAILED');
  });
});
