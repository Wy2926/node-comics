import {catalog, type CatalogMutation} from '../repositories';
import type {Document, ReadingPosition, ReadingUnit, Work} from '../domain';
import type {LibraryViewModel} from './types';

export type WorkUpdate = Partial<Pick<Work, 'title' | 'aliases' | 'description' | 'creators'>>;
export type ReadingUnitUpdate = Partial<Pick<ReadingUnit, 'title' | 'kind' | 'role'>>;
export type DocumentUpdate = Partial<Pick<Document, 'title' | 'language' | 'versionLabel'>>;
const all = Number.MAX_SAFE_INTEGER;
function text(value: unknown, name: string, limit: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim().length > limit || required && !value.trim()) throw Error(`${name}无效。`);
  return value.trim() || undefined;
}
function names(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw Error(`${name}无效。`);
  return [...new Set(value.map(item => text(item, name, 300)).filter((item): item is string => !!item))];
}
async function requireWork(records: CatalogMutation, id: string) {
  const work = await records.get('works', id); if (!work) throw Error('作品已移除。'); return work;
}
async function requireUnit(records: CatalogMutation, id: string) {
  const unit = await records.get('units', id); if (!unit) throw Error('阅读单元已移除。'); return unit;
}
async function requireDocument(records: CatalogMutation, id: string) {
  const document = await records.get('documents', id); if (!document) throw Error('文档已移除。'); return document;
}
const touchWork = (records: CatalogMutation, work: Work, now: number) => records.put('works', {...work, updatedAt: now});

export async function updateWork(id: string, changes: WorkUpdate): Promise<void> {
  const patch: WorkUpdate = {};
  if ('title' in changes) patch.title = text(changes.title, '作品标题', 300, true)!;
  if ('aliases' in changes) patch.aliases = names(changes.aliases, '别名');
  if ('description' in changes) patch.description = text(changes.description, '简介', 10000);
  if ('creators' in changes) patch.creators = names(changes.creators, '作者');
  await catalog.mutate(['works'], async records => {
    const work = await requireWork(records, id); await records.put('works', {...work, ...patch, updatedAt: Date.now()});
  });
}

export async function updateReadingUnit(id: string, changes: ReadingUnitUpdate): Promise<void> {
  const patch: ReadingUnitUpdate = {};
  if ('title' in changes) patch.title = text(changes.title, '阅读单元标题', 300, true)!;
  if ('kind' in changes) {
    if (!['chapter', 'volume', 'book', 'unclassified'].includes(changes.kind ?? '')) throw Error('阅读单元类型无效。');
    patch.kind = changes.kind;
  }
  if ('role' in changes) {
    if (!['main', 'extra', 'unknown'].includes(changes.role ?? '')) throw Error('阅读单元角色无效。');
    patch.role = changes.role;
  }
  await catalog.mutate(['works', 'units'], async records => {
    const unit = await requireUnit(records, id), work = await requireWork(records, unit.workId), now = Date.now();
    await records.put('units', {...unit, ...patch, updatedAt: now}); await touchWork(records, work, now);
  });
}

export async function setUnitRead(ids: string[], read: boolean): Promise<void> {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id) || typeof read !== 'boolean') throw Error('已读标记无效。');
  if (!ids.length) return;
  await catalog.mutate(['works', 'units'], async records => {
    const units = await Promise.all([...new Set(ids)].map(id => requireUnit(records, id)));
    const works = await Promise.all([...new Set(units.map(unit => unit.workId))].map(id => requireWork(records, id))), now = Date.now();
    for (const unit of units) await records.put('units', {...unit, readAt: read ? unit.readAt ?? now : undefined, updatedAt: now});
    for (const work of works) await touchWork(records, work, now);
  });
}

/** Reader completion is keyed by document, while the read marker belongs to its reading unit. */
export async function markDocumentRead(documentId: string): Promise<void> {
  await catalog.mutate(['documents', 'units', 'works'], async records => {
    const document = await records.get('documents', documentId); if (!document) return;
    const unit = await records.get('units', document.unitId); if (!unit || unit.readAt !== undefined) return;
    const work = await records.get('works', unit.workId); if (!work) return;
    const now = Date.now(); await records.put('units', {...unit, readAt: now, updatedAt: now}); await touchWork(records, work, now);
  });
}

export async function setPreferredDocument(unitId: string, documentId: string): Promise<void> {
  await catalog.mutate(['works', 'units', 'documents'], async records => {
    const unit = await requireUnit(records, unitId), document = await requireDocument(records, documentId), work = await requireWork(records, unit.workId);
    if (document.unitId !== unit.id) throw Error('首选文档不属于此阅读单元。');
    const now = Date.now(); await records.put('units', {...unit, preferredDocumentId: document.id, updatedAt: now}); await touchWork(records, work, now);
  });
}

export async function updateDocument(id: string, changes: DocumentUpdate): Promise<void> {
  const patch: DocumentUpdate = {};
  if ('title' in changes) patch.title = text(changes.title, '文档标题', 300, true)!;
  if ('language' in changes) patch.language = text(changes.language, '语言', 100);
  if ('versionLabel' in changes) patch.versionLabel = text(changes.versionLabel, '版本说明', 300);
  await catalog.mutate(['documents', 'units', 'works'], async records => {
    const document = await requireDocument(records, id), unit = await requireUnit(records, document.unitId), work = await requireWork(records, unit.workId), now = Date.now();
    await records.put('documents', {...document, ...patch, updatedAt: now}); await touchWork(records, work, now);
  });
}

export function preferredDocument(unit: ReadingUnit, documents: Document[], positions: ReadingPosition[] = [], currentDocumentId?: string): Document | undefined {
  const choices = documents.filter(document => document.unitId === unit.id);
  const current = currentDocumentId && choices.find(document => document.id === currentDocumentId); if (current) return current;
  const preferred = choices.find(document => document.id === unit.preferredDocumentId); if (preferred) return preferred;
  const recent = positions.filter(position => choices.some(document => document.id === position.documentId && document.revisionId === position.revisionId) && position.workId === unit.workId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return recent && choices.find(document => document.id === recent.documentId) || choices.find(document => document.indexState === 'ready') || choices[0];
}

export function continueDocument(workId: string, library: LibraryViewModel): Document | undefined {
  const units = library.units.filter(unit => unit.workId === workId).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const documents = library.documents.filter(document => units.some(unit => unit.id === document.unitId));
  const recent = (library.positions ?? []).filter(position => position.workId === workId && documents.some(document => document.id === position.documentId && document.revisionId === position.revisionId))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (recent) return documents.find(document => document.id === recent.documentId);
  const candidates = [...units.filter(unit => unit.readAt === undefined), ...units.filter(unit => unit.readAt !== undefined)];
  for (const unit of candidates) { const document = preferredDocument(unit, documents, library.positions); if (document) return document; }
  return undefined;
}

export async function moveDocument(documentId: string, targetUnitId: string): Promise<void> {
  await catalog.mutate(['works', 'units', 'documents'], async records => {
    const document = await requireDocument(records, documentId), previous = await requireUnit(records, document.unitId), target = await requireUnit(records, targetUnitId);
    if (previous.workId !== target.workId) throw Error('文档只能移动到同一作品的阅读单元。');
    const work = await requireWork(records, previous.workId); if (previous.id === target.id) return;
    const now = Date.now(); await records.put('documents', {...document, unitId: target.id, updatedAt: now});
    const remaining = await records.list('documents', {index: 'unitId', range: previous.id, limit: all});
    if (!remaining.length) await records.remove('units', previous.id);
    else if (previous.preferredDocumentId === document.id) {
      await records.put('units', {...previous, preferredDocumentId: preferredDocument({...previous, preferredDocumentId: undefined}, remaining)?.id, updatedAt: now});
    } else await records.put('units', {...previous, updatedAt: now});
    const preferred = target.preferredDocumentId && await records.get('documents', target.preferredDocumentId);
    await records.put('units', {...target, preferredDocumentId: preferred && preferred.unitId === target.id ? preferred.id : document.id, updatedAt: now});
    await touchWork(records, work, now);
  });
}

export async function reorderReadingUnits(workId: string, orderedIds: string[]): Promise<void> {
  if (!Array.isArray(orderedIds) || orderedIds.some(id => typeof id !== 'string' || !id) || new Set(orderedIds).size !== orderedIds.length) throw Error('阅读顺序必须是完整且不重复的单元列表。');
  await catalog.mutate(['works', 'units'], async records => {
    const work = await requireWork(records, workId), units = await records.list('units', {index: 'workId', range: workId, limit: all});
    if (units.length !== orderedIds.length || units.some(unit => !orderedIds.includes(unit.id))) throw Error('阅读单元已变化，请刷新后重新排序。');
    const now = Date.now(), byId = new Map(units.map(unit => [unit.id, unit]));
    for (const [order, id] of orderedIds.entries()) await records.put('units', {...byId.get(id)!, order, updatedAt: now});
    await touchWork(records, work, now);
  });
}

export async function setWorkCover(workId: string, documentId: string): Promise<void> {
  await catalog.mutate(['works', 'units', 'documents', 'revisions', 'pageDescriptors'], async records => {
    const work = await requireWork(records, workId), document = await requireDocument(records, documentId), unit = await requireUnit(records, document.unitId);
    if (unit.workId !== workId) throw Error('封面文档不属于此作品。');
    const revision = await records.get('revisions', document.revisionId);
    const page = document.coverPageId && await records.get('pageDescriptors', [document.revisionId, document.coverPageId]);
    if (revision?.documentId !== document.id || !page) throw Error('此文档尚无可用封面，请先建立页面目录。');
    await records.put('works', {...work, cover: {documentId, revisionId: document.revisionId, pageId: page.pageId}, updatedAt: Date.now()});
  });
}
