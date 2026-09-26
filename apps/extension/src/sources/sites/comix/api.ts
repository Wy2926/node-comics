import type {SourceNetworkContext} from '../../contracts/network';
import {encodeRequest, decodeResponse} from './protocol';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Comix 返回的数据格式已变化。');
  return value as Record<string, unknown>;
}
export async function api(path: string, context: SourceNetworkContext, params: Record<string, string> = {}) {
  context.signal?.throwIfAborted();
  const pairs = Object.keys(params).sort().map(key => key + '=' + params[key]).join('&');
  const query = new URLSearchParams(params);
  query.set('_', encodeRequest(path + (pairs ? '?' + pairs : '')));
  const response = await context.request('https://comix.to/api/v1' + path + '?' + query);
  context.signal?.throwIfAborted();
  const raw = object(JSON.parse(response));
  const body = typeof raw.e === 'string' ? object(JSON.parse(decodeResponse(raw.e))) : raw;
  if (body.status !== 'ok') throw Error('Comix 接口未返回有效内容。');
  return object(body.result);
}
