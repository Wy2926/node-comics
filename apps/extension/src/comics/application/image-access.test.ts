import {beforeEach,describe,expect,it,vi} from 'vitest';
import {pageReference,PDF_RENDER_PROFILE,RENDER_PROFILE} from '../pages/identity';
const mocks=vi.hoisted(()=>({acquire:vi.fn(),display:vi.fn(),embedded:vi.fn(),access:vi.fn(),validateResult:vi.fn(),promote:vi.fn(),readResult:vi.fn(),memory:vi.fn(),cache:vi.fn(),source:vi.fn()}));
vi.mock('../pages/service',()=>({acquirePage:mocks.acquire,acquireDisplayPage:mocks.display,acquireOriginalPdfImage:mocks.embedded,pageAccess:mocks.access,promotePage:mocks.promote}));
vi.mock('../../storage/translations/results',()=>({resultInMemory:mocks.memory,readMaterializedResult:mocks.readResult,validateMaterializedResult:mocks.validateResult}));
vi.mock('../../storage/translations',()=>({translationCache:{get:mocks.cache}}));
vi.mock('../../storage/source-pages',()=>({sourcePageCache:{get:mocks.source}}));
import {acquireImage,promoteImage,processingInput} from './image-access';

const reference={entryId:'entry',contentId:'content',pageId:'page',renderProfileId:RENDER_PROFILE};
beforeEach(()=>{vi.clearAllMocks();mocks.acquire.mockResolvedValue({blob:new Blob(['pixels']),release:vi.fn()});});
describe('image acquisition priority',()=>{
 it('promotes only page references without opening another image or result',()=>{
  promoteImage(pageReference(reference));promoteImage('result:translated');promoteImage('inline-original:sample');promoteImage('page:[]');promoteImage('page:broken');
  expect(mocks.promote).toHaveBeenCalledExactlyOnceWith(reference,undefined);
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
  const lease=await acquireImage('result:translated',controller.signal,'prefetch',undefined,2400);
  expect(lease.blob).toBe(blob);expect(mocks.readResult).toHaveBeenCalledExactlyOnceWith('result:translated',controller.signal);expect(mocks.acquire).not.toHaveBeenCalled();lease.release();
  expect(mocks.display).not.toHaveBeenCalled();
 });
 it('uses transient display pixels only when a reader supplies a target width',async()=>{
  const key=pageReference(reference),controller=new AbortController();
  await acquireImage(key,controller.signal,'current',undefined,2400);
  expect(mocks.display).toHaveBeenCalledExactlyOnceWith({...reference,signal:controller.signal,priority:'current',purpose:'reading'},2400);
  expect(mocks.acquire).not.toHaveBeenCalled();
  await acquireImage(key,controller.signal);
  expect(mocks.acquire).toHaveBeenCalledOnce();
 });
 it('does not access a cached result when the speculative consumer was already canceled',async()=>{
  const controller=new AbortController();controller.abort();
  await expect(acquireImage('result:translated',controller.signal,'prefetch')).rejects.toMatchObject({name:'AbortError'});
  expect(mocks.readResult).not.toHaveBeenCalled();expect(mocks.acquire).not.toHaveBeenCalled();
 });
 it('loads PDF embedded bytes lazily with an identity separate from rendered enhancement inputs',async()=>{
  const pdf={...reference,renderProfileId:PDF_RENDER_PROFILE},key=pageReference(pdf),input=processingInput(key,'owner');
  expect(input.key).toBe(JSON.stringify([key,'pdf-embedded-jpeg-v1']));
  expect(mocks.embedded).not.toHaveBeenCalled();
  const validate=vi.fn(async()=>{});mocks.access.mockResolvedValue(validate);await input.validate();await input.validate();
  expect(mocks.access).toHaveBeenCalledExactlyOnceWith(pdf);expect(validate).toHaveBeenCalledTimes(2);
  const signal=new AbortController().signal,lease={blob:new Blob(['original JPEG']),release:vi.fn()};
  mocks.embedded.mockResolvedValueOnce(lease).mockResolvedValueOnce(undefined);
  expect(await input.load(signal)).toBe(lease);expect(await input.load(signal)).toBeUndefined();
  expect(mocks.embedded).toHaveBeenCalledWith({...pdf,signal,priority:'background'});
  expect(mocks.acquire).not.toHaveBeenCalled();expect(mocks.display).not.toHaveBeenCalled();
 });
 it('keeps complete translated pixels and ordinary originals unchanged for enhancement',async()=>{
  const source=pageReference({...reference,renderProfileId:PDF_RENDER_PROFILE}),input=processingInput('result:translated','owner',source);
  const blob=new Blob(['complete translation']);mocks.readResult.mockResolvedValue(blob);
  expect(input.key).toBe('result:translated');expect((await input.load(new AbortController().signal))!.blob).toBe(blob);
  const key=pageReference(reference),original=processingInput(key,'owner');
  expect(original.key).toBe(key);await original.load(new AbortController().signal);
  expect(mocks.acquire).toHaveBeenCalledOnce();expect(mocks.display).not.toHaveBeenCalled();
 });
});
