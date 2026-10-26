import {beforeEach,describe,expect,it,vi} from 'vitest';
import {pageReference,RENDER_PROFILE} from '../pages/identity';
const mocks=vi.hoisted(()=>({acquire:vi.fn(),promote:vi.fn(),readResult:vi.fn(),memory:vi.fn(),cache:vi.fn(),source:vi.fn()}));
vi.mock('../pages/service',()=>({acquirePage:mocks.acquire,promotePage:mocks.promote}));
vi.mock('../../storage/translations/results',()=>({resultInMemory:mocks.memory,readMaterializedResult:mocks.readResult}));
vi.mock('../../storage/translations',()=>({translationCache:{get:mocks.cache}}));
vi.mock('../../storage/source-pages',()=>({sourcePageCache:{get:mocks.source}}));
import {acquireImage,promoteImage} from './image-access';

const reference={entryId:'entry',contentId:'content',pageId:'page',renderProfileId:RENDER_PROFILE};
beforeEach(()=>{vi.clearAllMocks();mocks.acquire.mockResolvedValue({blob:new Blob(['pixels']),release:vi.fn()});});
describe('image acquisition priority',()=>{
 it('promotes only page references without opening another image or result',()=>{
  promoteImage(pageReference(reference));promoteImage('result:translated');promoteImage('inline-original:sample');promoteImage('page:[]');promoteImage('page:broken');
  expect(mocks.promote).toHaveBeenCalledExactlyOnceWith(reference);
  expect(mocks.acquire).not.toHaveBeenCalled();expect(mocks.readResult).not.toHaveBeenCalled();expect(mocks.source).not.toHaveBeenCalled();
 });
 it('defaults existing callers to current priority and preserves the returned lease',async()=>{
  const lease=await acquireImage(pageReference(reference));
  expect(mocks.acquire).toHaveBeenCalledExactlyOnceWith({...reference,signal:undefined,priority:'current',purpose:'reading'});
  expect(lease).toBe(await mocks.acquire.mock.results[0].value);
 });
 it.each(['current','prefetch','background'] as const)('forwards %s priority and the consumer signal to page acquisition',async priority=>{
  const controller=new AbortController();await acquireImage(pageReference(reference),controller.signal,priority);
  expect(mocks.acquire).toHaveBeenCalledExactlyOnceWith({...reference,signal:controller.signal,priority,purpose:'reading'});
 });
 it('keeps translated-result acquisition on the existing lazy result path',async()=>{
  const blob=new Blob(['translated']),controller=new AbortController();mocks.readResult.mockResolvedValueOnce(blob);
  const lease=await acquireImage('result:translated',controller.signal,'prefetch');
  expect(lease.blob).toBe(blob);expect(mocks.readResult).toHaveBeenCalledExactlyOnceWith('result:translated',controller.signal);expect(mocks.acquire).not.toHaveBeenCalled();lease.release();
 });
 it('does not access a cached result when the speculative consumer was already canceled',async()=>{
  const controller=new AbortController();controller.abort();
  await expect(acquireImage('result:translated',controller.signal,'prefetch')).rejects.toMatchObject({name:'AbortError'});
  expect(mocks.readResult).not.toHaveBeenCalled();expect(mocks.acquire).not.toHaveBeenCalled();
 });
});
