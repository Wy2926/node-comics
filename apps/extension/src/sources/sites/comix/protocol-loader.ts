import type {SourceNetworkContext} from '../../contracts/network';
import {tags} from '../../shared/html';
import type {ComixProtocol} from './protocol';
import {parseProtocolSource, protocolChanged} from './protocol-source';

const origin = 'https://comix.to';
let cached: ComixProtocol | undefined;
let pending: {signal?: AbortSignal; promise: Promise<ComixProtocol>} | undefined;

function asset(value: string, base: string): string {
  let url: URL;
  try {url = new URL(value, base);} catch {throw protocolChanged();}
  if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
      !/^\/assets\/(?:build\/[a-z0-9]+\/dist|t3\/dist)\/[\w-]+\.js$/.test(url.pathname)) throw protocolChanged();
  return url.href;
}
function single(values: string[]) {
  const unique = [...new Set(values)];
  if (unique.length !== 1) throw protocolChanged();
  return unique[0];
}
async function load(context: SourceNetworkContext, sourceUrl: string): Promise<ComixProtocol> {
  const url = new URL(sourceUrl);
  if (url.origin !== origin || url.username || url.password) throw protocolChanged();
  const read = async (target: string, limit: number) => {
    context.signal?.throwIfAborted();
    const text = await context.request(target);
    context.signal?.throwIfAborted();
    if (text.length > limit) throw protocolChanged();
    return text;
  };
  const html = await read(url.href, 512 * 1024);
  const scripts = tags(html, 'script').filter(script => script.type === 'module' && script.src).map(script => script.src);
  const direct = scripts.filter(src => /(?:^|\/)apicore-[\w-]+\.js$/.test(src));
  let protocolUrl: string;
  if (direct.length) protocolUrl = single(direct.map(src => asset(src, url.href)));
  else {
    const main = single(scripts.filter(src => /(?:^|\/)main-[\w-]+\.js$/.test(src)).map(src => asset(src, url.href)));
    const bootstrap = await read(main, 1024 * 1024);
    protocolUrl = single([...bootstrap.matchAll(/["']((?:\.\/)?apicore-[\w-]+\.js)["']/g)].map(match => asset(match[1], main)));
  }
  return parseProtocolSource(await read(protocolUrl, 1024 * 1024));
}

function wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One public material record per realm, not a directory/image cache. Only explicit retirement invalidates it. */
export async function getProtocol(context: SourceNetworkContext, sourceUrl: string, retired?: ComixProtocol): Promise<ComixProtocol> {
  context.signal?.throwIfAborted();
  if (retired && cached === retired) cached = undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (cached) return cached;
    if (!pending) {
      const promise: Promise<ComixProtocol> = load(context, sourceUrl).then(protocol => {
        context.signal?.throwIfAborted();
        cached = protocol;
        return protocol;
      }).finally(() => {if (pending?.promise === promise) pending = undefined;});
      pending = {signal: context.signal, promise};
    }
    const record = pending;
    try {return await wait(record.promise, context.signal);}
    catch (error) {
      context.signal?.throwIfAborted();
      // An unrelated cancelled owner must not poison a live waiter or its next request.
      if (!record.signal?.aborted || attempt) throw error;
    }
  }
  throw protocolChanged();
}
