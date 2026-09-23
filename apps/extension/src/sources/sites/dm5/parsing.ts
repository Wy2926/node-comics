export const literal = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')`;
const failure = () => Error('DM5 数据格式已变化，请稍后重试。');

/** Decode string literals as data. Never evaluate source scripts. */
export function stringLiteral(value: string): string {
  if (!new RegExp('^' + literal + '$').test(value)) throw failure();
  return value.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|[^])/g, (_, escape: string) => {
    if (/^[ux]/.test(escape)) return String.fromCharCode(parseInt(escape.slice(1), 16));
    const escapes: Record<string, string> = {n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', "'": "'", '"': '"', '/': '/'};
    if (!(escape in escapes)) throw failure();
    return escapes[escape];
  });
}
export function assignment(script: string, name: string): string | number {
  const matches = [...script.matchAll(new RegExp('\\bvar\\s+' + name + '\\s*=\\s*(' + literal + '|\\d+)\\s*;', 'g'))];
  if (matches.length !== 1) throw failure();
  return /^["']/.test(matches[0][1]) ? stringLiteral(matches[0][1]) : Number(matches[0][1]);
}
export function scripts(html: string) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(m => m[1]).join('\n');
}
export function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw failure();
  return Number(value);
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw failure();
  return value.trim();
}
export function entities(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, key: string) => {
    if (key[0] === '#') {
      const point = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return ({amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '} as Record<string, string>)[key.toLowerCase()] ?? whole;
  });
}
export const htmlText = (html: string) => entities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
export function attribute(tag: string, name: string) {
  const value = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*("[^"]*"|\x27[^\x27]*\x27)', 'i').exec(tag)?.[1];
  return value === undefined ? undefined : entities(value.slice(1, -1));
}
