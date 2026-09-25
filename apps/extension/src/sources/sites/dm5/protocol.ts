import {assignment, literal, positive, stringLiteral, text} from './parsing';
import {dm5ImageUrl} from './image-url';

export class EmptyImageListError extends Error {
  constructor() { super('DM5 暂未返回图片列表，请重新载入章节。'); }
}

/** Decode the observed base-N string table. The downloaded function body is never run. */
export function unpackImages(response: string): string {
  if (response.length > 256_000) throw Error('DM5 图片响应超过限制。');
  const packed = new RegExp('^\\s*eval\\(function\\(p,a,c,k,e,d\\)\\{[\\s\\S]*?\\}\\(('+literal+'),(\\d+),(\\d+),('+literal+')\\.split\\(\x27\\|\x27\\),0,\\{\\}\\)\\)\\s*;?\\s*$').exec(response);
  if (!packed) throw Error('DM5 图片协议已变化或需要在源站验证。');
  const radix = positive(Number(packed[2]), 62), count = positive(Number(packed[3]), 4096);
  if (radix < 2) throw Error('DM5 图片编码无效。');
  const words = stringLiteral(packed[4]).split('|'), digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (words.length !== count) throw Error('DM5 图片字典不完整。');
  return stringLiteral(packed[1]).replace(/\b\w+\b/g, word => {
    let n = 0;
    for (const char of word) {const digit = digits.indexOf(char); if (digit < 0 || digit >= radix) return word; n = n * radix + digit; if (n >= count) return word;}
    return words[n] || word;
  });
}
export function imageUrls(response: string, chapterId: string): string[] {
  if (!response.trim()) throw new EmptyImageListError();
  const program = unpackImages(response);
  if (String(assignment(program, 'cid')) !== chapterId) throw Error('DM5 图片章节归属不符。');
  const key = text(assignment(program, 'key')), prefix = text(assignment(program, 'pix'));
  if (!/^[a-f\d]{16,128}$/i.test(key)) throw Error('DM5 图片访问参数无效。');
  const values = /\bvar\s+pvalue\s*=\s*(\[(?:\s*"(?:\\.|[^"\\])*"\s*,?)*\])\s*;/.exec(program);
  if (!values || program.match(/\bvar\s+pvalue\b/g)?.length !== 1) throw Error('DM5 图片列表格式已变化。');
  const items: unknown = JSON.parse(values[1]);
  if (!Array.isArray(items) || items.length > 1500) throw Error('DM5 图片列表数量无效。');
  // Accept only the observed concatenation contract, not arbitrary expressions from source code.
  const suffix = new RegExp('pvalue\\[i\\]=pix\\+pvalue\\[i\\]\\+('+literal+')').exec(program);
  if (!suffix || stringLiteral(suffix[1]) !== `?cid=${chapterId}&key=${key}`) throw Error('DM5 图片拼接协议已变化。');
  if (!items.length) throw new EmptyImageListError();
  return items.map(item => {
    const path = text(item), absolute = /^(https?:)?\/\//i.test(path);
    const {url} = dm5ImageUrl(new URL(absolute ? path : prefix + path + stringLiteral(suffix[1]), 'https://www.dm5.com').href);
    // The response cid and signed URL bind the image to the verified chapter HTML.
    // DM5 reuses old storage directories across catalog IDs; those are not identity proof.
    if (url.searchParams.get('cid') !== chapterId || url.searchParams.getAll('key').length !== 1 || url.searchParams.get('key') !== key)
      throw Error('DM5 图片地址或归属无效。');
    return url.href;
  });
}
