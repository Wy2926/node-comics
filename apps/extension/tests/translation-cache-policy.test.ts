import 'fake-indexeddb/auto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';

beforeEach(()=>{vi.resetModules();vi.stubGlobal('localStorage',undefined);});
afterEach(()=>vi.unstubAllGlobals());
function extensionPreferences(read:()=>Promise<Record<string,unknown>>){
  const listeners=new Set<(changes:Record<string,{newValue:unknown}>,area:string)=>void>();
  vi.stubGlobal('chrome',{storage:{local:{get:vi.fn(read)},onChanged:{addListener:(fn:(changes:Record<string,{newValue:unknown}>,area:string)=>void)=>listeners.add(fn)}}});
  return (cacheLimitMb:number)=>{for(const notify of listeners)notify({'nc-reader-settings':{newValue:{cacheLimitMb}}},'local');};
}
it('waits for mirrored preferences before a worker can persist result bytes',async()=>{
  const loaded=Promise.withResolvers<Record<string,unknown>>();extensionPreferences(()=>loaded.promise);
  const {translationCache}=await import('../src/storage/translations');
  let finished=false;const write=translationCache.put(crypto.randomUUID(),new Blob(['translation'])).finally(()=>{finished=true;});
  await new Promise(resolve=>setTimeout(resolve,0));expect(finished).toBe(false);
  loaded.resolve({'nc-reader-settings':{cacheLimitMb:0}});
  expect(await write).toBe(false);expect((await translationCache.usage()).budgetBytes).toBe(0);
});
it('applies live budget changes in workers and trims existing persistent bytes',async()=>{
  const change=extensionPreferences(async()=>({'nc-reader-settings':{cacheLimitMb:128}}));
  const {translationCache}=await import('../src/storage/translations');
  const key=crypto.randomUUID();expect(await translationCache.put(key,new Blob(['translation']))).toBe(true);
  change(0);await vi.waitFor(async()=>expect((await translationCache.usage()).bytes).toBe(0));
  expect(await translationCache.has(key)).toBe(false);expect(await translationCache.put(key,new Blob(['late']))).toBe(false);
});
it('does not replace a newer storage event with a stale initial preference read',async()=>{
  const loaded=Promise.withResolvers<Record<string,unknown>>(),change=extensionPreferences(()=>loaded.promise);
  const {translationCache}=await import('../src/storage/translations');
  const write=translationCache.put(crypto.randomUUID(),new Blob(['translation']));
  change(0);loaded.resolve({'nc-reader-settings':{cacheLimitMb:1024}});
  expect(await write).toBe(false);expect((await translationCache.usage()).budgetBytes).toBe(0);
});
