import {beforeEach,describe,expect,it,vi} from 'vitest';
const cache=vi.hoisted(()=>({token:vi.fn(),get:vi.fn(),put:vi.fn(),delete:vi.fn()}));
vi.mock('../storage/source-pages',()=>({sourcePageCache:cache}));
import {InlineOriginals} from './originals';
import {SourceDatabaseSchemaError} from '../storage/database';

beforeEach(()=>{vi.resetAllMocks();cache.token.mockResolvedValue({epoch:1});cache.get.mockResolvedValue(undefined);cache.put.mockResolvedValue(false);cache.delete.mockResolvedValue(undefined);});

describe('bounded inline upload originals',()=>{
  it.each(['token','put'] as const)('reports %s schema errors while preserving the accepted original in bounded memory',async operation=>{
    const store=new InlineOriginals('account-a'),restore=vi.fn(async()=>new Blob(['restored']));
    const error=new SourceDatabaseSchemaError('source-pages','缺少 reservations');cache[operation].mockRejectedValueOnce(error);
    await expect(store.remember('a',new Blob(['accepted']),restore)).rejects.toBe(error);
    expect(await(await store.read('a'))!.text()).toBe('accepted');expect(restore).not.toHaveBeenCalled();
  });
  it('reports cache schema errors instead of restoring evicted upload originals from the source',async()=>{
    const store=new InlineOriginals('account-a',0),restore=vi.fn(async()=>new Blob(['restored']));
    await store.remember('a',new Blob(['accepted']),restore);
    const error=new SourceDatabaseSchemaError('source-pages','缺少 objects');cache.get.mockRejectedValueOnce(error);
    await expect(store.read('a')).rejects.toBe(error);expect(restore).not.toHaveBeenCalled();
    expect(await(await store.read('a'))!.text()).toBe('restored');expect(restore).toHaveBeenCalledOnce();
  });
  it('reports a schema error deleting uploaded originals but still tolerates ordinary storage failures',async()=>{
    const store=new InlineOriginals('account-a');
    const error=new SourceDatabaseSchemaError('source-pages','缺少 objects');cache.delete.mockRejectedValueOnce(error);
    await expect(store.uploaded('a')).rejects.toBe(error);
    cache.delete.mockRejectedValueOnce(Error('unavailable'));await expect(store.uploaded('a')).resolves.toBeUndefined();
  });
  it('retains current upload bytes even when persistent storage refuses or fails',async()=>{
    const store=new InlineOriginals('account-a'),restore=vi.fn(async()=>new Blob(['restored']));
    await store.remember('a',new Blob(['a']),restore);
    cache.token.mockRejectedValue(Error('offline'));cache.get.mockRejectedValue(Error('offline'));
    await store.remember('b',new Blob(['b']),restore);
    expect(await(await store.read('a'))!.text()).toBe('a');expect(await(await store.read('b'))!.text()).toBe('b');expect(restore).not.toHaveBeenCalled();
  });
  it('keeps at most four original images and reacquires evicted bytes on demand',async()=>{
    const store=new InlineOriginals('account-a'),restore=vi.fn(async()=>new Blob(['old'])) ;
    for(let i=0;i<5;i++)await store.remember('key-'+i,new Blob([String(i)]),restore);
    expect(await(await store.read('key-4'))!.text()).toBe('4');expect(restore).not.toHaveBeenCalled();
    expect(await(await store.read('key-0'))!.text()).toBe('old');expect(restore).toHaveBeenCalledOnce();
  });
  it('enforces a byte budget and coalesces source restoration',async()=>{
    const store=new InlineOriginals('account-a',3);let finish!:(blob:Blob)=>void;
    const restore=vi.fn(()=>new Promise<Blob>(resolve=>{finish=resolve;}));
    await store.remember('a',new Blob(['1234']),restore);
    const a=store.read('a'),b=store.read('a');await vi.waitFor(()=>expect(restore).toHaveBeenCalledOnce());
    finish(new Blob(['1234']));expect(await(await a)!.text()).toBe('1234');expect(await b).toBe(await a);
  });
  it('drops accepted upload bytes and restores only if a later retry needs them',async()=>{
    const store=new InlineOriginals('account-a'),restore=vi.fn(async()=>new Blob(['restored']));
    await store.remember('a',new Blob(['a']),restore);await store.uploaded('a');
    expect(cache.delete).toHaveBeenCalledWith('a');expect(await(await store.read('a'))!.text()).toBe('restored');
  });
  it('prevents restoration after an activation is cleared and isolates context memory',async()=>{
    const first=new InlineOriginals('account-a'),second=new InlineOriginals('account-b');let finish!:(blob:Blob)=>void;
    const restore=vi.fn(()=>new Promise<Blob>(resolve=>{finish=resolve;}));
    await first.remember('a',new Blob(['a']),restore);expect(await second.read('a')).toBeUndefined();await first.uploaded('a');
    const pending=first.read('a');await vi.waitFor(()=>expect(restore).toHaveBeenCalledOnce());first.clear();finish(new Blob(['late']));
    expect(await pending).toBeUndefined();expect(await first.read('a')).toBeUndefined();
  });
});
