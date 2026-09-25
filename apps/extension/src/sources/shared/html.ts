/** Minimal inert server-markup helpers. Source structure and JSON schemas stay in each adapter. */
export const inertHtml = (html: string) => html.replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
export function decodeText(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : whole;
    }
    return ({amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' '} as Record<string, string>)[code.toLowerCase()];
  });
}
export function attributes(tag: string) {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const key = match[1].toLowerCase();
    if (Object.hasOwn(attrs, key)) throw Error('来源页面属性重复。');
    attrs[key] = decodeText(match[2] ?? match[3]);
  }
  return attrs;
}
export const textContent = (html: string) => decodeText(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
export const hasClass = (attrs: Record<string, string>, name: string) => attrs.class?.split(/\s+/).includes(name);
export const tags = (html: string, tag: string) => [...html.matchAll(new RegExp('<' + tag + '\\b[^>]*>', 'gi'))].map(match => attributes(match[0]));
