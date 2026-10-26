import {beforeEach,describe,expect,it,vi} from 'vitest';
const hooks=vi.hoisted(()=>({cursor:0,effect:0,refs:[] as any[],effects:[] as any[]}));
const access=vi.hoisted(()=>({acquire:vi.fn(),promote:vi.fn()}));
vi.mock('../comics/application/image-access',()=>({acquireImage:access.acquire,promoteImage:access.promote}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),
 useRef:(current:unknown)=>hooks.refs[hooks.cursor++]??= {current},
 useCallback:(callback:unknown)=>(hooks.refs[hooks.cursor++]??= {current:callback}).current,
 useEffect:(effect:()=>void,deps:unknown[])=>{
  const index=hooks.effect++,previous=hooks.effects[index];
  if(!previous||deps.some((value,i)=>!Object.is(value,previous[i]))){hooks.effects[index]=deps;effect();}
 },
}));
import {BlobPicture,type BlobPictureProps} from './Images';
function picture(extra:Partial<BlobPictureProps>={}){
 const refs:any[]=[],effects:any[]=[];
 let props:BlobPictureProps={scope:'page',blobKey:'original',alt:'Page',onImport(){},...extra};
 const render=(changes:Partial<BlobPictureProps>={})=>{
  props={...props,...changes};hooks.refs=refs;hooks.effects=effects;hooks.cursor=hooks.effect=0;
  return BlobPicture(props).props;
 };
 return {render,initial:render()};
}
beforeEach(()=>{vi.clearAllMocks();access.acquire.mockImplementation(async(_key,signal)=>{signal.throwIfAborted();return {blob:new Blob(['image']),release:vi.fn()};});});
describe('mounted image reading priority',()=>{
 it('starts the current middle page before its ten neighbors from the same render',async()=>{
  const controller=new AbortController();
  const pages=Array.from({length:11},(_,index)=>picture({priority:index===5?'current':'prefetch',blobKey:`page-${index}`}));
  const requests=pages.map((page,index)=>page.initial.acquire(`page-${index}`,controller.signal));
  expect(access.acquire.mock.calls.map(call=>call[0])).toEqual(['page-5']);
  await Promise.all(requests);
  expect(access.acquire.mock.calls.map(call=>call[0])).toEqual(['page-5','page-0','page-1','page-2','page-3','page-4','page-6','page-7','page-8','page-9','page-10']);
  expect(access.acquire.mock.calls[0][2]).toBe('current');expect(access.acquire.mock.calls.slice(1).every(call=>call[2]==='prefetch')).toBe(true);
 });
 it('promotes an already mounted original and result without replacing the acquire callback or restarting reads',async()=>{
  const page=picture({priority:'prefetch',originalKey:'original',blobKey:'translated'}),controller=new AbortController();
  await page.initial.acquire('original',controller.signal);access.promote.mockClear();
  const visible=page.render({priority:'current'});
  expect(visible.acquire).toBe(page.initial.acquire);expect(access.acquire).toHaveBeenCalledOnce();
  expect(access.promote.mock.calls).toEqual([['translated'],['original']]);
  page.render({priority:'current'});expect(access.promote).toHaveBeenCalledTimes(2);
  const neighbor=page.render({priority:'prefetch'});expect(neighbor.acquire).toBe(visible.acquire);expect(controller.signal.aborted).toBe(false);
 });
 it('uses the latest priority if navigation overtakes a deferred neighbor read',async()=>{
  const page=picture({priority:'prefetch'}),pending=page.initial.acquire('original',new AbortController().signal);
  page.render({priority:'current'});await pending;
  expect(access.acquire).toHaveBeenCalledExactlyOnceWith('original',expect.any(AbortSignal),'current',undefined);
 });
 it('preserves cancellation before deferred acquisition and does not promote an absent target',async()=>{
  const page=picture({priority:'prefetch',blobKey:undefined}),controller=new AbortController();
  const pending=page.initial.acquire('original',controller.signal);controller.abort();
  await expect(pending).rejects.toMatchObject({name:'AbortError'});
  page.render({priority:'current'});expect(access.promote).not.toHaveBeenCalled();
 });
});
