import {msg} from '../i18n/runtime';
import type {Mode, Page, ReadingCopy} from '../types';
import type {LibraryState} from '../library/types';
import {completePageList, copyPageTotal} from '../library/model';
import {pageTranslation} from '../reader/presentation';
import {languageLabel, modeLabels} from '../types';

export type ExportFormat = 'cbz' | 'zip' | 'pdf';
export interface ExportOptions {
  format: ExportFormat;
  images: 'original' | 'translation' | 'both';
  mode: Mode;
  language: string;
}
export interface ExportCopy {
  copy: ReadingCopy;
  group: string;
  groupKey: string;
  order: number;
  rank: number;
  coverage: string[];
  otherWorks: string[];
}
export interface ExportPage {
  id: string;
  ordinal: number;
  kind: 'original' | 'translation' | 'fallback' | 'no_text' | 'missing';
  blobKey?: string;
  assetId?: string;
  jobId?: string;
  version?: number;
  reason?: string;
  bytes: number;
}
export interface ExportBook {
  copyId: string;
  title: string;
  revision: number;
  group: string;
  coverage: string[];
  otherWorks: string[];
  edition: string;
  path: string;
  pages: ExportPage[];
  total?: number;
  incomplete: boolean;
}
export interface ExportPlan {
  title: string;
  createdAt: string;
  options: ExportOptions;
  books: ExportBook[];
  localBytes: number;
}
export const MAX_EXPORT_BYTES = 512 * 1024 * 1024;

/** Export actual copies once, not one copy per coverage or inferred inclusion. */
export function exportCopies(state: LibraryState, copies: ReadingCopy[], workId: string): ExportCopy[] {
  return copies.flatMap(copy => {
    const coverage = state.coverage.filter(c => c.copyId === copy.id && c.workId === workId);
    if (!coverage.length) return [];
    const targets = coverage.map(c => {
      const chapter = c.target.kind === 'chapter' && state.chapters.find(x => x.id === c.target.id);
      if (chapter) return {rank: chapter.role === 'extra' ? 1 : 0, group: chapter.role === 'extra' ? msg("番外") : msg("章节"), groupKey: 'chapter:' + chapter.role, order: chapter.order, title: chapter.title};
      const book = c.target.kind === 'publication' && state.publications.find(x => x.id === c.target.id);
      const series = book ? state.series.find(x => x.id === book.seriesId) : undefined;
      if (book) return {rank: 2, group: series?.title ?? msg("卷册"), groupKey: 'publication:' + (series?.id ?? ''), order: book.order, title: book.title};
      return {rank: 3, group: msg("整部与未分类"), groupKey: 'copies', order: 0, title: c.target.kind === 'work' ? msg("整部作品") : msg("未分类")};
    }).sort((a, b) => a.rank - b.rank || a.order - b.order);
    const otherIds = new Set(state.coverage.filter(c => c.copyId === copy.id && c.workId !== workId).map(c => c.workId));
    for (const item of coverage.filter(c => c.target.kind === 'publication')) {
      const book = state.publications.find(p => p.id === item.target.id);
      for (const id of book?.workIds ?? []) if (id !== workId) otherIds.add(id);
      for (const inclusion of state.inclusions.filter(i => i.publicationId === item.target.id)) {
        const id = inclusion.target.kind === 'work' ? inclusion.target.id : state.chapters.find(c => c.id === inclusion.target.id)?.workId;
        if (id && id !== workId) otherIds.add(id);
      }
    }
    return [{copy, ...targets[0], coverage: [...new Set(targets.map(t => t.title))], otherWorks: state.works.filter(w => otherIds.has(w.id)).map(w => w.title)}];
  }).sort((a, b) => a.rank - b.rank || a.groupKey.localeCompare(b.groupKey) || a.order - b.order || a.copy.title.localeCompare(b.copy.title, 'zh-CN', {numeric: true}) || a.copy.id.localeCompare(b.copy.id));
}

export function safeName(value: string): string {
  const name = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 70).replace(/[. ]+$/g, '') || msg("未命名");
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) ? '_' + name : name;
}

export async function planExport(title: string, entries: ExportCopy[], options: ExportOptions,
  getBlob: (key: string) => Promise<Blob | undefined>, ownerId?: string, origin?: string, signal?: AbortSignal): Promise<ExportPlan> {
  if (!entries.length) throw Error(msg("请先选择要导出的副本。"));
  if (options.images !== 'original' && !ownerId) throw Error(msg("请先登录已有译图所属的账户，或选择仅导出原图。"));
  // Do not retain all the source Blobs while inspecting a large library.
  const sizes = new Map<string, number | undefined>();
  const sizeOf = async (key?: string) => {
    signal?.throwIfAborted();
    if (!key) return undefined;
    if (!sizes.has(key)) sizes.set(key, (await getBlob(key))?.size);
    return sizes.get(key);
  };
  const books: ExportBook[] = [];
  const frozen = structuredClone(entries);
  for (const [index, entry] of frozen.entries()) {
    for (const translated of options.images === 'both' ? [false, true] : [options.images === 'translation']) {
      const pages: ExportPage[] = [];
      for (const [ordinal, page] of entry.copy.pages.entries()) {
        const originalSize = await sizeOf(page.blobKey);
        const original = originalSize ? {blobKey: page.blobKey, bytes: originalSize} : undefined;
        const base = {id: page.id, ordinal: ordinal + 1, bytes: 0};
        if (!translated) {
          pages.push(original ? {...base, ...original, kind: 'original'} : {...base, kind: 'missing', reason: msg("原图未保存或已清理")});
          continue;
        }
        const t = pageTranslation(page, options.mode, options.language, ownerId, origin);
        const localSize = await sizeOf(t.blobKey);
        const result = t.result;
        const identity = result ? {jobId: result.id, version: result.version} : {};
        if (localSize) pages.push({...base, ...identity, kind: 'translation', blobKey: t.blobKey, bytes: localSize});
        else if (result?.output_asset_id && !result.result_expired && result.result_available !== false) {
          pages.push({...base, ...identity, kind: 'translation', assetId: result.output_asset_id});
        } else {
          const noText = !result && t.latest?.status === 'no_text';
          const reason = noText ? msg("未检测到文字") : missingTranslation(page, options, ownerId, origin);
          pages.push(original ? {...base, ...original, kind: noText ? 'no_text' : 'fallback', reason}
            : {...base, kind: 'missing', reason: msg("{0}，且原图未保存", {"0": reason})});
        }
      }
      const edition = translated ? languageLabel(options.language) + '-' + modeLabels[options.mode] : msg("原图");
      const incomplete = !completePageList(entry.copy) || pages.some(p => p.kind === 'missing');
      const name = msg("{0}-{1}-修订{2}{3}", {"0": String(index + 1).padStart(4, '0'), "1": safeName(entry.copy.title), "2": entry.copy.manifestRevision, "3": (incomplete ? msg("-不完整") : '')});
      books.push({copyId: entry.copy.id, title: entry.copy.title, revision: entry.copy.manifestRevision, group: entry.group, coverage: entry.coverage,
        otherWorks: entry.otherWorks, edition, path: safeName(edition) + '/' + name, pages, incomplete, total: copyPageTotal(entry.copy)});
    }
  }
  signal?.throwIfAborted();
  return {title, createdAt: new Date().toISOString(), options: {...options}, books, localBytes: books.reduce((n, book) => n + book.pages.reduce((sum, p) => sum + p.bytes, 0), 0)};
}

function missingTranslation(page: Page, options: ExportOptions, ownerId?: string, origin?: string) {
  const t = pageTranslation(page, options.mode, options.language, ownerId, origin);
  if (t.result) return msg("最新成功译图已失效");
  if (t.pending) return msg("翻译处理中或待核实");
  if (t.latest?.status === 'failed') return msg("翻译失败");
  return msg("尚无此语言与模式的译图");
}

/** Allowlist: never serialize raw pages, credentials, asset URLs or the database. */
export function exportManifest(plan: ExportPlan, books = plan.books) {
  return {schema: 'node-comics-export/1', title: plan.title, createdAt: plan.createdAt, format: plan.options.format,
    books: books.map(b => ({title: b.title, copyId: b.copyId, revision: b.revision, group: b.group, coverage: b.coverage, otherWorks: b.otherWorks,
      edition: b.edition, path: b.path, expectedPages: b.total ?? null, complete: !b.incomplete,
      pages: b.pages.map(p => ({pageId: p.id, ordinal: p.ordinal, kind: p.kind, jobId: p.jobId, version: p.version, reason: p.reason}))}))};
}

export const countPages = (book: ExportBook, kind: ExportPage['kind']) => book.pages.filter(p => p.kind === kind).length;
