import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readChannelCredentials,readChannelSettings,writeChannelSecrets,writeChannelSettings} from '../../configuration';
import type {ChannelProfile} from '../../contracts';
import {fontPreferenceKey,serviceToken,readServices,saveCommonSettings,serviceScope,serviceSelection,localSettings,profileConfig} from './services';
import {definition} from './definition';
import {translateText} from './text/execute';
import type {LocalOperation} from './operations';
import {providerPreset} from './providers';

let metadata:Record<string,unknown>;
beforeEach(()=>{
  metadata={};vi.stubGlobal('navigator',{});
  vi.stubGlobal('chrome',{runtime:{id:'test-extension'},permissions:{contains:async()=>true},storage:{local:{get:async(key:string)=>({[key]:structuredClone(metadata[key])}),set:async(value:Record<string,unknown>)=>{Object.assign(metadata,structuredClone(value));}}}});
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
async function fixture(values:Record<string,string>={},secrets:Record<string,string>={}){
  const profile:ChannelProfile={id:crypto.randomUUID(),adapterId:'shinobu',name:'Local',revision:1,settings:localSettings(values)};
  const scope=serviceScope(profile);
  await writeChannelSettings({activeId:profile.id,profiles:[profile],fontPreferences:{[fontPreferenceKey(profile)]:{'zh-Hans':'lxgw-wenkai'}}});
  await writeChannelSecrets(profile.id,secrets,profile);
  const current=async()=>{const saved=await readChannelCredentials(profile.id);return {...saved,profile:saved.profile!,selection:serviceSelection(saved.profile!,saved.secrets,()=>true)};};
  return {profile,scope,current};
}
const provider=(name:string,url:string,token='')=>({name,baseUrl:url,model:'fixture-model',token});
describe('browser local text providers',()=>{
  it('lists models without a model or name and tests a manual ID without saving or switching',async()=>{
    const f=await fixture(),{selection}=await f.current(),signal=new AbortController().signal;
    const before=structuredClone(metadata),draft={...providerPreset('custom'),baseUrl:'http://model.home/v1',token:'draft-key'};
    const fetcher=vi.fn<typeof fetch>();vi.stubGlobal('fetch',fetcher);
    fetcher.mockResolvedValueOnce(Response.json({data:[{id:'listed'},{id:'listed'}]}));
    expect(await selection.listModels(draft,undefined,signal)).toEqual(['listed']);
    expect(fetcher).toHaveBeenLastCalledWith(draft.baseUrl+'/models',expect.objectContaining({method:'GET',headers:expect.objectContaining({Authorization:'Bearer draft-key'}),redirect:'error'}));
    const envelope={id:'reply-42',usage:{total_tokens:18},choices:[{finish_reason:'stop',message:{content:'{"sample":"Hello!"}'}}]};
    fetcher.mockResolvedValueOnce(Response.json(envelope));
    const manual={...draft,model:'unlisted',customPrompt:'Use short sentences.'};
    const inspect=vi.fn();
    expect(await selection.test(manual,undefined,'en',signal,inspect)).toBe('Hello!');
    expect(inspect).toHaveBeenCalledExactlyOnceWith({status:200,body:JSON.stringify(envelope),truncated:false});
    const [url,init]=fetcher.mock.calls[1],body=JSON.parse(String(init?.body));
    expect(url).toBe(draft.baseUrl+'/chat/completions');expect(body.model).toBe('unlisted');
    expect(body.messages[0].content).toContain('English');expect(body.messages[0].content).toContain(manual.customPrompt);
    expect(JSON.parse(body.messages[1].content)).toEqual({sample:'こんにちは！'});
    expect(metadata).toEqual(before);expect((await f.current()).secrets).toEqual({});
    await selection.save(manual);
    const saved=await f.current();expect(saved.selection.items.at(-1)?.label).toBe('unlisted');expect(profileConfig(saved.profile).model).toBe('unlisted');
  });
  it('binds both draft requests to the edited provider and never follows a remote pagination URL',async()=>{
    const f=await fixture(),signal=new AbortController().signal,baseUrl='http://gateway.home/a';
    const draft={...providerPreset('claude'),model:'messages-fixture',baseUrl,token:'key-a'};
    await (await f.current()).selection.save(draft);
    const a=await f.current(),id=a.selection.selectedId;
    await a.selection.save(provider('B','http://gateway.home/b','key-b'));
    const {selection}=await f.current(),before=structuredClone(metadata),edit=selection.items.find(item=>item.id===id)!.values!;
    const fetcher=vi.fn<typeof fetch>();vi.stubGlobal('fetch',fetcher);
    fetcher.mockResolvedValueOnce(Response.json({data:[{id:'one'}],has_more:true,last_id:'one',next:'https://other.invalid'}))
      .mockResolvedValueOnce(Response.json({data:[{id:'two'}],has_more:false}));
    expect(await selection.listModels({...edit,model:''},id,signal)).toEqual(['one','two']);
    expect(fetcher.mock.calls.map(([url])=>url)).toEqual([baseUrl+'/models',baseUrl+'/models?after_id=one']);
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({'x-api-key':'key-a','anthropic-version':'2023-06-01'});
    for(const [endpoint,token,key] of [[baseUrl,'','key-a'],[baseUrl,'fresh','fresh'],[baseUrl+'/other','','']] as const){
      fetcher.mockResolvedValueOnce(Response.json({type:'message',stop_reason:'end_turn',content:[{type:'text',text:'{"sample":"你好！"}'}]}));
      expect(await selection.test({...edit,baseUrl:endpoint,token},id,'zh-Hans',signal)).toBe('你好！');
      const [url,init]=fetcher.mock.calls.at(-1)!;
      expect(url).toBe(endpoint+'/messages');expect(new Headers(init?.headers).get('x-api-key')).toBe(key||null);
    }
    fetcher.mockResolvedValueOnce(Response.json({data:[]}));
    expect(await selection.listModels({...edit,baseUrl:baseUrl+'/other'},id,signal)).toEqual([]);
    expect(fetcher.mock.calls.at(-1)![1]?.headers).not.toHaveProperty('x-api-key');
    expect(metadata).toEqual(before);
  });
  it('shows safe response bodies for HTTP and protocol failures, but no invented reply on network failure',async()=>{
    const f=await fixture(),draft={...providerPreset('claude'),model:'messages-fixture',token:'bound-secret'},signal=new AbortController().signal;
    await (await f.current()).selection.save(draft);
    const {selection}=await f.current(),id=selection.selectedId,edit=selection.items.find(i=>i.id===id)!.values!,before=structuredClone(metadata);
    const inspect=vi.fn(),fetcher=vi.fn<typeof fetch>();vi.stubGlobal('fetch',fetcher);
    const body=JSON.stringify({error:{message:'Denied bound-secret',token:'other-secret'},url:'https://home.test/?sig=signed-secret'});
    fetcher.mockResolvedValueOnce(new Response(body,{status:403}));
    await expect(selection.test(edit,id,'en',signal,inspect)).rejects.toThrow('HTTP 403');
    expect(inspect).toHaveBeenLastCalledWith({status:403,body:JSON.stringify({error:{message:'Denied [redacted]',token:'[redacted]'},url:'https://home.test/?sig=[redacted]'}),truncated:false});
    fetcher.mockResolvedValueOnce(new Response('<b>upstream reset</b>'));
    await expect(selection.test(edit,id,'en',signal,inspect)).rejects.toThrow('译文 JSON');
    expect(inspect).toHaveBeenLastCalledWith({status:200,body:'<b>upstream reset</b>',truncated:false});
    fetcher.mockResolvedValueOnce(new Response(null,{status:204}));
    await expect(selection.listModels(edit,id,signal,inspect)).rejects.toThrow('模型列表格式无效');
    expect(inspect).toHaveBeenLastCalledWith({status:204,body:'',truncated:false});
    fetcher.mockResolvedValueOnce(new Response('a'.repeat(32*1024),{status:502}));
    await expect(selection.listModels(edit,id,signal,inspect)).rejects.toThrow('HTTP 502');
    expect(inspect).toHaveBeenLastCalledWith({status:502,body:'a'.repeat(16*1024),truncated:true});
    inspect.mockClear();fetcher.mockRejectedValueOnce(Error('private network detail'));
    await expect(selection.test(edit,id,'en',signal,inspect)).rejects.toThrow('无法连接服务');
    fetcher.mockResolvedValueOnce(Response.json({data:[{id:'one'}],has_more:true,last_id:'one'})).mockRejectedValueOnce(Error('second page unavailable'));
    await expect(selection.listModels(edit,id,signal,inspect)).rejects.toThrow('无法连接服务');
    expect(inspect).not.toHaveBeenCalled();expect(metadata).toEqual(before);
  });
  it('distinguishes list, auth, quota, model and output errors without disclosing the response body',async()=>{
    const {selection}=await (await fixture()).current(),draft={...selection.initialValues,model:'user-model'},signal=new AbortController().signal;
    const fetcher=vi.fn<typeof fetch>();vi.stubGlobal('fetch',fetcher);
    for(const [action,status,providerCode,reason,field] of [
      ['list',404,'','未找到模型列表接口',undefined],['list',401,'invalid_api_key','鉴权失败','token'],
      ['test',403,'','服务拒绝访问',undefined],['test',404,'','未找到接口或模型',undefined],['test',404,'model_not_found','找不到此模型','model'],
      ['test',429,'insufficient_quota','额度不足',undefined],['test',429,'','限流',undefined],['test',503,'','服务处理失败',undefined],['test',400,'unsupported_parameter','不支持某个请求参数',undefined],
    ] as const){
      fetcher.mockResolvedValueOnce(Response.json({error:{code:providerCode,message:'private-key and private text'}},{status}));
      const result=action==='list'?selection.listModels(draft,undefined,signal):selection.test(draft,undefined,'en',signal);
      await expect(result).rejects.toMatchObject({message:expect.stringContaining(reason),field});
      await expect(result).rejects.toThrow(`HTTP ${status}`);await expect(result).rejects.not.toThrow('private');
    }
    fetcher.mockResolvedValueOnce(Response.json({data:'private'}));
    await expect(selection.listModels(draft,undefined,signal)).rejects.toThrow('模型列表格式无效');
    fetcher.mockResolvedValueOnce(Response.json({choices:[{finish_reason:'stop',message:{content:'not-json'}}]}));
    await expect(selection.test(draft,undefined,'en',signal)).rejects.toThrow('译文 JSON');
    fetcher.mockRejectedValueOnce(new TypeError('private exception'));
    await expect(selection.test(draft,undefined,'en',signal)).rejects.toThrow('无法连接服务');
  });
  it('blocks invalid destinations, missing host access and stale or cancelled probes before sending',async()=>{
    const f=await fixture(),{selection,profile}=await f.current(),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const draft=selection.initialValues,signal=new AbortController().signal;
    await expect(selection.listModels({...draft,baseUrl:'https://x.home/v1?key=private'},undefined,signal)).rejects.toMatchObject({field:'baseUrl'});
    await expect(selection.test({...draft,model:''},undefined,'en',signal)).rejects.toMatchObject({field:'model'});
    await expect(selection.listModels(draft,undefined,AbortSignal.abort())).rejects.toMatchObject({name:'AbortError'});
    await expect(serviceSelection(profile,{},()=>false).listModels(draft,undefined,signal)).rejects.toThrow();
    vi.stubGlobal('chrome',{...chrome,permissions:{contains:async()=>false}});
    await expect(selection.listModels(draft,undefined,signal)).rejects.toThrow('网站访问权限');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('times out a stalled draft request and preserves caller cancellation without replaying',async()=>{
    const {selection}=await (await fixture()).current();
    for(const cancel of [false,true]){
      const started=Promise.withResolvers<void>(),caller=new AbortController(),deadline=new AbortController();
      const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(deadline.signal);
      const fetcher=vi.fn<typeof fetch>(async(_url,init)=>new Response(new ReadableStream({
        start(controller){init!.signal!.addEventListener('abort',()=>controller.error(init!.signal!.reason));},
        pull(){started.resolve();},
      })));vi.stubGlobal('fetch',fetcher);
      const result=selection.listModels(selection.initialValues,undefined,caller.signal);
      await started.promise;(cancel?caller:deadline).abort();
      if(cancel)await expect(result).rejects.toMatchObject({name:'AbortError'});else await expect(result).rejects.toThrow('请求超时');
      expect(fetcher).toHaveBeenCalledOnce();timeout.mockRestore();
    }
  });
  it('round-trips a manual model and reports the upstream decision when disabling reasoning',async()=>{
    const f=await fixture(),{selection}=await f.current(),signal=new AbortController().signal;
    const values={...providerPreset('openai'),model:'o3',thinking:'off'};
    await selection.save(values);
    const saved=await f.current(),id=saved.selection.selectedId,edit=saved.selection.items.find(item=>item.id===id)!.values!;
    expect(edit).toMatchObject({model:'o3',thinking:'off'});
    const reply={error:{code:'unsupported_value',message:'This deployment does not accept none.'}};
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(reply,{status:400})),inspect=vi.fn();
    vi.stubGlobal('fetch',fetcher);
    await expect(saved.selection.test(edit,id,'en',signal,inspect)).rejects.toThrow('HTTP 400');
    expect(fetcher).toHaveBeenCalledOnce();expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({model:'o3',reasoning_effort:'none'});
    expect(inspect).toHaveBeenCalledExactlyOnceWith({status:400,body:JSON.stringify(reply),truncated:false});
  });
  it('can add and select more than twenty providers',async()=>{
    const f=await fixture();
    for(let i=0;i<21;i++)await (await f.current()).selection.save(provider('Provider '+i,'http://model.home/v1'));
    const saved=await f.current(),items=readServices(saved.profile).items;
    expect(items).toHaveLength(21);await saved.selection.select(items[0].id);
    expect((await f.current()).selection.selectedId).toBe(items[0].id);
  });

  it('sends each provider only its own token and restores stable scopes when switching back',async()=>{
    const f=await fixture();
    await (await f.current()).selection.save(provider('A','http://127.0.0.1:1234/v1','secret-a'));
    const a=await f.current(),scopeA=serviceScope(a.profile),idA=a.selection.selectedId;
    await a.selection.save(provider('B','http://127.0.0.1:5678/v1','secret-b'));
    const b=await f.current(),scopeB=serviceScope(b.profile),idB=b.selection.selectedId;
    expect(scopeA).not.toBe(scopeB);
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"r0":"译文"}'}}]})));vi.stubGlobal('fetch',fetcher);
    for(const [id,url,token,scope] of [[idA,'http://127.0.0.1:1234/v1','secret-a',scopeA],[idB,'http://127.0.0.1:5678/v1','secret-b',scopeB],[idA,'http://127.0.0.1:1234/v1','secret-a',scopeA]]){
      await (await f.current()).selection.select(id);const saved=await f.current();expect(serviceScope(saved.profile)).toBe(scope);
      const operation:LocalOperation={id:crypto.randomUUID(),entryId:crypto.randomUUID(),pageId:'page',scope,fingerprint:crypto.randomUUID(),fontId:'lxgw-wenkai',config:profileConfig(saved.profile),cacheToken:{epoch:0,ownerGeneration:0},job:{id:crypto.randomUUID(),mode:'classic',target_language:'zh-Hans',status:'running',phase:'translating',created_at:new Date().toISOString(),version:1,quota_pages:0,cache_hit:false}};
      const taskToken=serviceToken(saved.profile,saved.secrets);
      // A task already accepted under A keeps A's endpoint/token after switching or editing providers.
      await saved.selection.select(id===idA?idB:idA);
      await (await f.current()).selection.save(provider('Extra','http://192.168.1.8:1234/v1','other-token'));
      await translateText(operation,[{id:'r0',sourceText:'test'}],new AbortController().signal,taskToken);
      expect(fetcher).toHaveBeenLastCalledWith(url+'/chat/completions',expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer '+token})}));
    }
    expect(JSON.stringify(metadata)).not.toMatch(/secret-a|secret-b/);
    expect(JSON.stringify((await f.current()).selection.items)).not.toMatch(/secret-a|secret-b/);
  });
  it('clears retained credentials on destination changes and preserves them for model or name edits',async()=>{
    const f=await fixture();await (await f.current()).selection.save(provider('A','http://127.0.0.1:1234/v1','secret-a'));
    const a=await f.current(),id=a.selection.selectedId,scope=serviceScope(a.profile);
    await a.selection.save({...provider('Renamed','http://127.0.0.1:1234/v1'),model:'other-model',thinking:'high'},id);
    let current=await f.current();expect(serviceToken(current.profile,current.secrets)).toBe('secret-a');expect(serviceScope(current.profile)).toBe(scope);expect(profileConfig(current.profile).thinking).toBe('high');
    await current.selection.save({...provider('Messages','http://127.0.0.1:1234/v1'),llmProvider:'claude',model:'messages-fixture',thinking:'low',maxTokens:'16384'},id);
    current=await f.current();expect(profileConfig(current.profile)).toMatchObject({protocol:'anthropic',thinking:'low',maxTokens:16384});expect(serviceScope(current.profile)).not.toBe(scope);expect(serviceToken(current.profile,current.secrets)).toBe('secret-a');
    await current.selection.save(provider('Moved','http://127.0.0.1:5678/v1'),id);
    current=await f.current();expect(serviceToken(current.profile,current.secrets)).toBe('');expect(serviceScope(current.profile)).not.toBe(scope);
  });
  it('saves and clears a prompt per provider without losing existing results',async()=>{
    const f=await fixture(),values=provider('A','http://model.home/v1'),customPrompt='Call her Sora.\nKeep the tone casual.';
    await (await f.current()).selection.save({...values,customPrompt:`  ${customPrompt}\n`});
    const a=await f.current(),id=a.selection.selectedId,scope=serviceScope(a.profile);
    const connection=await definition.open(a.profile,a.secrets,()=>true);
    expect(connection.key).not.toContain('Call her Sora');connection.dispose();
    await a.selection.select('google');
    const google=await f.current();expect(profileConfig(google.profile).customPrompt).toBeUndefined();
    await google.selection.save(provider('B','http://other.home/v1'));
    const b=await f.current();expect(profileConfig(b.profile).customPrompt).toBeUndefined();
    await b.selection.select(id);
    const restored=await f.current();
    expect(profileConfig(restored.profile).customPrompt).toBe(customPrompt);
    expect(restored.selection.items.find(item=>item.id===id)?.values?.customPrompt).toBe(customPrompt);
    const field=restored.selection.fields(values).find(field=>field.key==='customPrompt')!;
    await expect(restored.selection.save({...values,customPrompt:'x'.repeat(field.maxLength!+1)},id)).rejects.toThrow();
    expect(profileConfig((await f.current()).profile).customPrompt).toBe(customPrompt);
    await restored.selection.save({...values,customPrompt:' \n '},id);
    const cleared=await f.current();expect(profileConfig(cleared.profile).customPrompt).toBeUndefined();
    expect(serviceScope(cleared.profile)).toBe(scope);
  });
  it('removes only the chosen provider and falls back to Google with no active token',async()=>{
    const f=await fixture();await (await f.current()).selection.save(provider('A','http://127.0.0.1:1234/v1','secret-a'));
    const idA=(await f.current()).selection.selectedId;
    await (await f.current()).selection.save(provider('B','http://127.0.0.1:5678/v1','secret-b'));
    let current=await f.current();await current.selection.remove(current.selection.selectedId);
    current=await f.current();expect(current.selection.selectedId).toBe('google');expect(serviceToken(current.profile,current.secrets)).toBe('');expect(Object.values(current.secrets)).not.toContain('secret-b');
    expect(readServices(current.profile).items.map(item=>item.id)).toEqual([idA]);expect(serviceScope(current.profile)).toBe(f.scope);
  });
  it('keeps provider configuration through common settings changes and rejects stale editors',async()=>{
    const f=await fixture();await (await f.current()).selection.save(provider('A','http://127.0.0.1:1234/v1','secret-a'));
    const old=await f.current(),scope=serviceScope(old.profile);
    await saveCommonSettings(old.profile,{backend:'cpu',ocrFilter:'off'},()=>true);
    const current=await f.current();expect(profileConfig(current.profile)).toMatchObject({backend:'cpu',ocrFilter:'off',model:'fixture-model'});expect(serviceToken(current.profile,current.secrets)).toBe('secret-a');expect(serviceScope(current.profile)).toBe(scope);
    await expect(old.selection.save(provider('Stale','http://127.0.0.1:3333/v1'),old.selection.selectedId)).rejects.toThrow();
    expect(profileConfig((await f.current()).profile).baseUrl).toBe('http://127.0.0.1:1234/v1');
    expect((await readChannelSettings()).fontPreferences?.[fontPreferenceKey(f.profile)]?.['zh-Hans']).toBe('lxgw-wenkai');
  });
});
