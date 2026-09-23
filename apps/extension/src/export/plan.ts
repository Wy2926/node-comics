import type {Job, Mode, Page} from '../types';
import {catalog} from '../comics/repositories';
import {RENDER_PROFILE, type PageReference} from '../comics/pages/identity';
import {materializationId} from '../comics/pages/service';
import {pageTranslation} from '../reader/presentation';

export type ExportFormat = 'cbz' | 'zip' | 'pdf';
export interface ExportOptions {format: ExportFormat; images: 'original' | 'translation'; mode: Mode; language: string; allowIncomplete?: boolean}
export interface ExportPage {
  pageId: string; ordinal: number; name: string; reference: PageReference;
  kind: 'original' | 'translation' | 'fallback' | 'no_text';
  job?: Job; cacheKey?: string; reason?: string;
}
export interface ExportPlan {
  entryId: string; contentId: string; generation: number; title: string; createdAt: string;
  options: ExportOptions; pages: ExportPage[]; incomplete: boolean; expectedPages?: number;
  account?: {userId: string; origin: string};
}
export const MAX_EXPORT_BYTES = 128 * 1024 * 1024;
export function safeName(value: string): string {
  const name = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0,70).replace(/[. ]+$/g,'') || '未命名';
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) ? '_' + name : name;
}
export const exportName = (title: string, options: ExportOptions) => `${safeName(title)}-${options.images === 'original' ? '原图' : safeName(options.language)+'-'+options.mode}${options.allowIncomplete ? '-已发现页面' : ''}.${options.format}`;

/** Freeze metadata only. The explicit write command acquires one requested page at a time. */
export async function planExport(entryId: string, options: ExportOptions, account?: ExportPlan['account'], signal?: AbortSignal): Promise<ExportPlan> {
  signal?.throwIfAborted();
  const document = await catalog.get('entries',entryId);
  if (!document || document.indexState !== 'ready') throw new Error('文档尚未建立可读目录，请先完成索引。');
  if (options.images === 'translation' && !account) throw new Error('请先登录已有译图所属的账户。');
  const descriptors = [];
  for (let offset = 0;; offset += 100) {
    signal?.throwIfAborted();
    const batch = await catalog.listPages(document.contentId,{offset,limit:100}); descriptors.push(...batch);
    if (descriptors.length > 10000) throw new Error('单次导出最多支持 10000 页，请拆分文档。');
    if (batch.length < 100) break;
  }
  if (!descriptors.length) throw new Error('文档没有可导出的页面。');
  const expectedPages = document.knownTotal ?? document.pageCount;
  const incomplete = document.discoveryComplete === false || (expectedPages !== undefined && expectedPages !== descriptors.length);
  if (incomplete && !options.allowIncomplete) throw new Error('来源页面尚未全部发现，请先补齐目录或明确选择导出已发现页面。');
  const pages: ExportPage[] = [];
  for (const descriptor of descriptors) {
    signal?.throwIfAborted();
    const reference = {entryId,contentId:document.contentId,pageId:descriptor.pageId,renderProfileId:RENDER_PROFILE};
    const page: ExportPage = {pageId:descriptor.pageId,ordinal:descriptor.ordinal,name:descriptor.name,reference,kind:'original'};
    if (options.images === 'translation') {
      const identity = await catalog.get('materializations',materializationId(reference));
      const binding = identity && await catalog.get('translationBindings',JSON.stringify([account!.origin,account!.userId,identity.imageSha256]));
      const projection: Page = {id:descriptor.pageId,name:descriptor.name,width:identity?.width ?? 0,height:identity?.height ?? 0,jobs:[],outputBlobs:{},...(binding?.payload as Partial<Page> | undefined)};
      const translated = pageTranslation(projection,options.mode,options.language,account!.userId,account!.origin);
      if (translated.result && (translated.blobKey || !translated.expired)) Object.assign(page,{kind:'translation',job:structuredClone(translated.result),cacheKey:translated.blobKey});
      else if (translated.latest?.status === 'no_text') Object.assign(page,{kind:'no_text',reason:'未检测到文字，保留原图'});
      else Object.assign(page,{kind:'fallback',reason:'没有可用的已完成译图，保留原图'});
    }
    pages.push(page);
  }
  signal?.throwIfAborted();
  return {entryId,contentId:document.contentId,generation:document.generation,title:document.title,createdAt:new Date().toISOString(),options:{...options},pages,incomplete,expectedPages,account};
}
/** Explicit allowlist: no original URLs, account IDs, source locators, tokens or signed asset URLs. */
export function exportManifest(plan: ExportPlan) {
  return {schema:'node-comics-export/2',title:plan.title,createdAt:plan.createdAt,format:plan.options.format,images:plan.options.images,
    mode:plan.options.images==='translation'?plan.options.mode:undefined,language:plan.options.images==='translation'?plan.options.language:undefined,
    expectedPages:plan.expectedPages ?? null,complete:!plan.incomplete,
    pages:plan.pages.map(page=>({pageId:page.pageId,ordinal:page.ordinal+1,kind:page.kind,version:page.job?.version,reason:page.reason}))};
}
