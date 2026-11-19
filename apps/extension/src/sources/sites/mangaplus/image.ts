import type {SourceImageAdapter} from '../../contracts/image';
import {decodeXorImage} from '../../shared/xor-image';

type Asset = {url:string; processing?:string};
// A saved manifest contains only stable locators. A missing session uses normal chapter refresh.
const sessions = new Map<string,{assets:Map<string,Asset>; token:string}>();
export function rememberPages(chapter:string, assets:Map<string,Asset>, token:string) {
  sessions.delete(chapter);
  if (sessions.size >= 6) sessions.delete(sessions.keys().next().value!);
  sessions.set(chapter, {assets, token});
}
export const image = {
  resolvePage(locator) {
    const chapter = /\/chapter\/(\d+)\//.exec(locator)?.[1], session = chapter && sessions.get(chapter);
    const asset = session && session.assets.get(locator);
    if (!session || !asset) throw Error('MANGA Plus 阅读会话已过期，请刷新章节。');
    return {...asset, headers:{'Plus-Vw-Token':session.token}};
  },
  async decode(blob, _headers, key, signal) {
    signal?.throwIfAborted();
    return key === undefined ? blob : decodeXorImage(blob, key, signal);
  },
} satisfies SourceImageAdapter;
