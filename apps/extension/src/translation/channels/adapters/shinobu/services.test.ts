import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readChannelCredentials,readChannelSettings,writeChannelSecrets,writeChannelSettings} from '../../configuration';
import type {ChannelProfile} from '../../contracts';
import {fontPreferenceKey,serviceToken,readServices,saveCommonSettings,serviceScope,serviceSelection,localSettings,profileConfig} from './services';
import {translateText} from './text/execute';
import type {LocalOperation} from './operations';

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
      await translateText(operation,[{id:'r0',sourceText:'test',translatedText:''}],new AbortController().signal,taskToken);
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
    await current.selection.save({...provider('Messages','http://127.0.0.1:1234/v1'),llmProvider:'claude',model:'claude-sonnet-4-6',thinking:'low',maxTokens:'16384'},id);
    current=await f.current();expect(profileConfig(current.profile)).toMatchObject({protocol:'anthropic',thinking:'low',maxTokens:16384});expect(serviceScope(current.profile)).not.toBe(scope);expect(serviceToken(current.profile,current.secrets)).toBe('secret-a');
    await current.selection.save(provider('Moved','http://127.0.0.1:5678/v1'),id);
    current=await f.current();expect(serviceToken(current.profile,current.secrets)).toBe('');expect(serviceScope(current.profile)).not.toBe(scope);
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
