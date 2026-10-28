import type {SourceNetworkContext} from '../../contracts/network';
import {encodeRequest, decodeResponse} from './protocol';
import {getProtocol} from './protocol-loader';
import {protocolChanged} from './protocol-source';

class ComixVerificationRequired extends Error {
  readonly kind = 'verification-required';
  readonly details = {status: 403};
  constructor() { super('Comix 要求额外的人机验证（captcha_required）；请在来源章节页完成验证后重试。'); }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Comix 返回的数据格式已变化。');
  return value as Record<string, unknown>;
}
export async function api(path: string, context: SourceNetworkContext, params: Record<string, string> = {}, sourceUrl = 'https://comix.to/browse') {
  context.signal?.throwIfAborted();
  const pairs = Object.keys(params).sort().map(key => key + '=' + params[key]).join('&');
  let protocol = await getProtocol(context, sourceUrl);
  for (let attempt = 0; attempt < 2; attempt++) {
    context.signal?.throwIfAborted();
    const query = new URLSearchParams(params);
    query.set('_', encodeRequest(path + (pairs ? '?' + pairs : ''), protocol));
    const response = await context.request('https://comix.to/api/v1' + path + '?' + query, {acceptStatuses: [403]});
    context.signal?.throwIfAborted();
    let raw: Record<string, unknown>;
    try {raw = object(JSON.parse(response));} catch {throw protocolChanged();}
    if (raw.error === 'captcha_required') throw new ComixVerificationRequired();
    if (raw.code === 'key_retired') {
      if (attempt) throw protocolChanged();
      protocol = await getProtocol(context, sourceUrl, protocol);
      continue;
    }
    let body: Record<string, unknown>;
    try {body = typeof raw.e === 'string' ? object(JSON.parse(decodeResponse(raw.e, protocol))) : raw;}
    catch {throw protocolChanged();}
    if (body.status !== 'ok') throw protocolChanged();
    return object(body.result);
  }
  throw protocolChanged();
}
