import type {SourceCatalogSnapshot} from '../../contracts/source';
import {SourceProtocolError} from '../../contracts/network';
import type {SourceLocation} from '../../contracts/definition';
import {identify} from './definition';
import {msg} from '../../../i18n/runtime';

export function incomplete(): never {throw new SourceProtocolError(msg('目录未完整加载，请打开来源页处理后重试。'));}
export function catalogData(raw:string) {
  try {return JSON.parse(raw);} catch {return incomplete();}
}
export function count(value: unknown): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 10000 ? n : incomplete();
}
/** Template contents have no browsing context: parsing a chapter never starts image requests. */
export function markup(html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}
export function directory(work: SourceLocation, title: string, total: number) {
  const owner = work.catalog!, rows = new Map<string, SourceCatalogSnapshot['entries'][number]>();
  if (typeof title !== 'string' || !title.trim()) incomplete();
  return {
    add(href: string, name: string, readable = true) {
      const url = new URL(href, work.url), chapter = identify(url);
      if (!chapter || chapter.catalog?.key !== owner.key || chapter.kind !== 'reader' ||
          typeof name !== 'string' || !name.trim() || rows.has(chapter.pageKey) || rows.size >= total) incomplete();
      rows.set(chapter.pageKey, {id:chapter.pageKey, catalogId:owner.key, remoteId:chapter.url.split('/').pop()!,
        title:name.trim(), url:chapter.url, readable, groupIds:[], rawTypes:[], related:false, sequenceId:owner.key, order:0});
    },
    finish(): SourceCatalogSnapshot {
      if (rows.size !== total) incomplete();
      const entries = [...rows.values()].reverse().map((entry, order) => ({...entry, order}));
      return {id:owner.key, sourceId:work.sourceId, url:owner.url, title:title.trim(), complete:true, entries, groups:[],
        observedAt:Date.now(), note:'', defaultEntryId:entries.find(entry => entry.readable)?.id};
    },
  };
}
