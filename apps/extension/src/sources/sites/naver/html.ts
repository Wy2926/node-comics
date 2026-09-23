/** Parse only inert, quoted attributes from Naver's server-rendered reader. Never execute source scripts. */
export function decodeText(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : whole;
    }
    return ({amp: '&', quot: '"', apos: "'", lt: '<', gt: '>'} as Record<string, string>)[code.toLowerCase()];
  });
}
export function attributes(tag: string) {
  const values: Record<string, string> = {};
  for (const match of tag.matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const key = match[1].toLowerCase();
    if (Object.hasOwn(values, key)) throw Error('NAVER 页面属性重复，请稍后重试。');
    values[key] = decodeText(match[2] ?? match[3]);
  }
  return values;
}
export const inertHtml = (html: string) => html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
