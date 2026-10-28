import {beforeEach, describe, expect, it, vi} from 'vitest';
import {fixtureSource, protocolHtml, protocolAssetPath} from './protocol-fixture';
import type {SourceNetworkContext} from '../../../contracts/network';

const sourceUrl = 'https://comix.to/title/fixture-book';
const success = JSON.stringify({status:'ok', result:{id:1}});
beforeEach(() => vi.resetModules());

function fixture() {
  let version = 'one';
  const request = vi.fn<SourceNetworkContext['request']>(async target => {
    const url = new URL(target);
    if (url.pathname.startsWith('/title/')) return protocolHtml;
    if (url.pathname === protocolAssetPath) return fixtureSource(version);
    return success;
  });
  return {request, rotate: (next:string) => {version=next;}};
}
describe('Comix on-demand protocol lifecycle', () => {
  it('reads material once then reuses it for directories and chapters', async () => {
    const {api} = await import('../api'), context = fixture();
    await expect(api('/manga/fixture', context, {}, sourceUrl)).resolves.toEqual({id:1});
    await api('/chapters/20', context, {}, sourceUrl);
    expect(context.request.mock.calls.map(([url])=>new URL(url).pathname)).toEqual([
      '/title/fixture-book', protocolAssetPath, '/api/v1/manga/fixture', '/api/v1/chapters/20']);
    expect(context.request.mock.calls[2][1]).toEqual({acceptStatuses:[403]});
  });
  it('follows one same-origin module link without evaluating any downloaded program', async () => {
    const {getProtocol} = await import('../protocol-loader');
    const request = vi.fn(async (url:string) => url === sourceUrl
      ? '<script type="module" src="/assets/build/fixture/dist/main-fixture.js"></script>'
      : url.endsWith('/main-fixture.js') ? 'import "./apicore-fixture.js";const unused="apicore-fixture.js";' : fixtureSource());
    expect((await getProtocol({request}, sourceUrl)).version).toBe('qo4');
    expect(request).toHaveBeenCalledTimes(3);
    expect(Reflect.get(globalThis,'__comixRemoteCodeExecuted')).toBeUndefined();
  });
  it.each(['https://evil.test/assets/build/fixture/dist/apicore-x.js', 'https://user@comix.to/assets/build/fixture/dist/apicore-x.js', 'https://[invalid]/assets/build/fixture/dist/apicore-x.js', '/api/apicore-x.js'])('rejects untrusted protocol asset %s before fetching it', async src => {
    const {getProtocol} = await import('../protocol-loader'), request = vi.fn(async()=>`<script type="module" src="${src}"></script>`);
    await expect(getProtocol({request},sourceUrl)).rejects.toMatchObject({kind:'protocol-changed'});
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('refreshes only explicit retired keys and retries the same operation once', async () => {
    const {api} = await import('../api'), context = fixture();
    await api('/manga/fixture', context, {}, sourceUrl);
    context.rotate('two');
    const normal = context.request.getMockImplementation()!;
    context.request.mockImplementation(async (url, options) => {
      const query = new URL(url);
      return query.pathname.startsWith('/api/') && query.searchParams.get('_')?.startsWith('one.')
        ? JSON.stringify({code:'key_retired',message:'Invalid token.'}) : normal(url,options);
    });
    await expect(api('/chapters/20', context, {}, sourceUrl)).resolves.toEqual({id:1});
    const requests = context.request.mock.calls.filter(([url])=>new URL(url).pathname==='/api/v1/chapters/20');
    expect(requests).toHaveLength(2);
    expect(new URL(requests[1][0]).searchParams.get('_')).toMatch(/^two\./);
    expect(context.request.mock.calls.filter(([url])=>url===sourceUrl)).toHaveLength(2);
  });
  it.each(['key_retired','invalid_token'])('bounds %s failures and returns an actionable protocol error', async code => {
    const {api} = await import('../api'), context = fixture(), normal = context.request.getMockImplementation()!;
    context.request.mockImplementation((url,options)=>new URL(url).pathname.startsWith('/api/')
      ? Promise.resolve(JSON.stringify({code,message:'Invalid token.'})) : normal(url,options));
    await expect(api('/manga/fixture',context,{},sourceUrl)).rejects.toMatchObject({kind:'protocol-changed'});
    expect(context.request.mock.calls.filter(([url])=>new URL(url).pathname.startsWith('/api/'))).toHaveLength(code==='key_retired'?2:1);
  });
  it('separates source captcha requests from retired signing keys without refreshing or retrying', async () => {
    const {api}=await import('../api'), context=fixture(), normal=context.request.getMockImplementation()!;
    context.request.mockImplementation((url,options)=>new URL(url).pathname.startsWith('/api/')
      ? Promise.resolve(JSON.stringify({error:'captcha_required',challenge:{private:'do-not-log'}})) : normal(url,options));
    await expect(api('/chapters/20',context,{},sourceUrl)).rejects.toMatchObject({kind:'verification-required',message:expect.stringContaining('captcha_required')});
    expect(context.request).toHaveBeenCalledTimes(3);
  });
  it.each(['verification-required','http'])('does not retry %s transport failures', async kind => {
    const {api} = await import('../api'), context = fixture();
    const failure = Object.assign(Error('transport failure'),{kind});
    context.request.mockRejectedValueOnce(failure);
    await expect(api('/manga/fixture',context,{},sourceUrl)).rejects.toBe(failure);
    expect(context.request).toHaveBeenCalledTimes(1);
  });
  it('keeps API rate-limit errors and cooldown metadata without rediscovering the protocol', async () => {
    const {api}=await import('../api'), context=fixture(), normal=context.request.getMockImplementation()!;
    const failure=Object.assign(Error('rate limited'),{details:{status:429,retryAfter:60}});
    context.request.mockImplementation((url,options)=>new URL(url).pathname.startsWith('/api/')?Promise.reject(failure):normal(url,options));
    await expect(api('/chapters/20',context,{},sourceUrl)).rejects.toBe(failure);
    expect(context.request).toHaveBeenCalledTimes(3);
  });
  it('coalesces concurrent loads and lets a cancelled waiter stop independently', async () => {
    const {getProtocol} = await import('../protocol-loader'), context = fixture();
    const normal = context.request.getMockImplementation()!;
    let release!:()=>void;
    const gate = new Promise<void>(resolve=>{release=resolve;});
    context.request.mockImplementation(async(url,options)=>{await gate;return normal(url,options);});
    const owner = getProtocol(context,sourceUrl), controller = new AbortController();
    const waiter = expect(getProtocol({...context,signal:controller.signal},sourceUrl)).rejects.toMatchObject({name:'AbortError'});
    controller.abort();await waiter;release();
    await expect(owner).resolves.toHaveProperty('version','one');
    expect(context.request).toHaveBeenCalledTimes(2);
  });
  it('does not cache late material after cancellation', async () => {
    const {getProtocol} = await import('../protocol-loader'), context=fixture(), controller=new AbortController();
    const normal=context.request.getMockImplementation()!;
    context.request.mockImplementation(async(url,options)=>{const result=await normal(url,options);if(url.endsWith('.js'))controller.abort();return result;});
    await expect(getProtocol({...context,signal:controller.signal},sourceUrl)).rejects.toMatchObject({name:'AbortError'});
    context.request.mockImplementation(normal);
    await expect(getProtocol(context,sourceUrl)).resolves.toHaveProperty('version','one');
    expect(context.request).toHaveBeenCalledTimes(4);
  });
  it('lets a live waiter reload after the original loader owner is cancelled', async () => {
    const {getProtocol}=await import('../protocol-loader'), context=fixture(), controller=new AbortController();
    const normal=context.request.getMockImplementation()!;
    const gate=Promise.withResolvers<void>();
    context.request.mockImplementationOnce(async(url,options)=>{await gate.promise;return normal(url,options);});
    const owner=expect(getProtocol({...context,signal:controller.signal},sourceUrl)).rejects.toMatchObject({name:'AbortError'});
    const waiter=getProtocol(context,sourceUrl);
    controller.abort();gate.resolve();await owner;
    await expect(waiter).resolves.toHaveProperty('version','one');
    expect(context.request).toHaveBeenCalledTimes(3);
  });
});
