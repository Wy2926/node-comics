import {attributes} from '../../shared/html';
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('瓜子漫画数据格式已变化。');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw Error('瓜子漫画文本字段无效。');
  return value.trim();
}
export function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw Error(`瓜子漫画${label}缺失或重复，请在源站确认。`);
  return values[0];
}
export function structuredData(html: string) {
  return [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(m => attributes(' ' + m[1]).type === 'application/ld+json')
    .flatMap(m => {
      const data = object(JSON.parse(m[2]));
      return Array.isArray(data['@graph']) ? data['@graph'].map(object) : [data];
    });
}
