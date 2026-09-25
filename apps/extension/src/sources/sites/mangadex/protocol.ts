import {isUuid} from './definition';

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('MangaDex 数据结构无效。');
  return value as JsonObject;
}
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error('MangaDex 数据列表无效。');
  return value;
}
export function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('MangaDex 文本数据无效。');
  return value.trim();
}
export function id(value: unknown): string {
  if (!isUuid(value)) throw Error('MangaDex 资源身份无效。');
  return value.toLowerCase();
}
export function count(value: unknown, max = 10000): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw Error('MangaDex 清单数量无效或超过读取上限。');
  return Number(value);
}
export function response(value: unknown): JsonObject {
  const result = object(value);
  if (result.result !== 'ok') throw Error('MangaDex 请求未成功，请稍后重试。');
  return result;
}
export function entity(value: unknown, type: string, expectedId: string): JsonObject {
  const result = response(value), data = object(result.data);
  if (result.response !== 'entity' || data.type !== type || id(data.id) !== expectedId) throw Error('MangaDex 资源归属已变化。');
  return data;
}
export function numberLabel(value: unknown): string | undefined {
  if (value === null || value === '') return;
  const result = text(value, 32);
  // Preserve source labels exactly. No title-based inference or decimal rounding for identities.
  if (!/^(0|[1-9]\d*)(?:\.\d+)?[a-z]*$/i.test(result)) throw Error('MangaDex 卷号或话号格式已变化。');
  return result;
}
export function compareLabel(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const parts = (value: string) => /^(\d+(?:\.\d+)?)([a-z]*)$/i.exec(value)!;
  const x = parts(a), y = parts(b);
  return Number(x[1]) - Number(y[1]) || x[2].localeCompare(y[2], 'en') || a.localeCompare(b, 'en');
}
export function contentLanguage(value: unknown): string {
  const language = text(value, 20).toLowerCase();
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/.test(language)) throw Error('MangaDex 章节语言无效。');
  // MangaDex's es-la means Latin America, not the BCP 47 country code LA (Laos).
  const mapped = ({'es-la': 'es-419', 'zh-hk': 'zh-HK', 'zh': 'zh-Hans', 'pt-br': 'pt-BR', 'ja-ro': 'ja-Latn', 'ko-ro': 'ko-Latn', 'zh-ro': 'zh-Latn'} as Record<string, string>)[language] ?? language;
  try {return Intl.getCanonicalLocales(mapped)[0];} catch {throw Error('MangaDex 章节语言无效。');}
}
export function relationships(data: JsonObject, type: string): JsonObject[] {
  return list(data.relationships).map(object).filter(row => row.type === type);
}
export interface Chapter {
  id: string;
  mangaId: string;
  volume?: string;
  chapter?: string;
  title: string;
  language: string;
  pages: number;
  unavailable: boolean;
  external: boolean;
  groups: string[];
}
export function chapterData(value: unknown, expectedManga?: string): Chapter {
  const data = object(value), attributes = object(data.attributes);
  if (data.type !== 'chapter') throw Error('MangaDex 章节类型无效。');
  const parents = relationships(data, 'manga');
  if (parents.length !== 1) throw Error('MangaDex 章节所属作品不明确。');
  const mangaId = id(parents[0].id);
  if (expectedManga && mangaId !== expectedManga) throw Error('MangaDex 章节不属于当前作品。');
  const external = attributes.externalUrl;
  if (external !== null && typeof external !== 'string' || typeof attributes.isUnavailable !== 'boolean') throw Error('MangaDex 章节可用状态无效。');
  return {id: id(data.id), mangaId, volume: numberLabel(attributes.volume), chapter: numberLabel(attributes.chapter),
    title: attributes.title === null || attributes.title === '' ? '' : text(attributes.title, 512), language: contentLanguage(attributes.translatedLanguage),
    pages: count(attributes.pages, 1500), unavailable: attributes.isUnavailable, external: !!external,
    groups: relationships(data, 'scanlation_group').map(group => group.attributes ? text(object(group.attributes).name, 180) : '').filter(Boolean)};
}
export function chapterTitle(chapter: Chapter): string {
  return [chapter.volume ? `Vol. ${chapter.volume}` : '', chapter.chapter ? `Ch. ${chapter.chapter}` : '', chapter.title].filter(Boolean).join(' · ') || '未标注话号';
}
