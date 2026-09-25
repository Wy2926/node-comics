import type { SourceDefinition } from '../contracts/definition';
import type { SourceCatalogSnapshot } from '../contracts/source';
import { resolveSource } from './resolve';
import { safeImageUrl } from '../shared/urls';
/** Normalize source content labels without guessing the language from a title. */
function normalizeContentLanguage(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 80) return;
  try { return Intl.getCanonicalLocales(value)[0]; } catch { return; }
}
/** Validate observations, never accept library bindings as source authority. */
export function validateCatalog(
  input: unknown,
  definitions: readonly SourceDefinition[],
): SourceCatalogSnapshot {
  const c = input as SourceCatalogSnapshot;
  const invalid = () => {
    throw Error('INVALID_SOURCE_CATALOG');
  };
  const text = (s: unknown, max = 2048): s is string =>
    typeof s === 'string' && s.length > 0 && s.length <= max;
  if (
    !c ||
    !text(c.url) ||
    !text(c.id) ||
    !text(c.sourceId) ||
    !text(c.title) ||
    !Array.isArray(c.entries) ||
    !Array.isArray(c.groups) ||
    c.entries.length > 10000 ||
    c.groups.length > 1000 ||
    typeof c.complete !== 'boolean' ||
    !Number.isFinite(c.observedAt) ||
    typeof c.note !== 'string' ||
    c.note.length > 2048
  )
    return invalid();
  const { definition, location } = resolveSource(c.url, definitions);
  if (c.cover !== undefined && (!c.cover || !text(c.cover.url, 8192) || safeImageUrl(c.cover.url, c.url) !== c.cover.url)) return invalid();
  if (
    !definition.capabilities.catalog ||
    location.kind !== 'catalog' ||
    definition.id !== c.sourceId ||
    location.catalog?.key !== c.id
  )
    return invalid();
  const entries = new Map(c.entries.map((e) => [e?.id, e])),
    groups = new Map(c.groups.map((g) => [g?.id, g]));
  if (entries.size !== c.entries.length || groups.size !== c.groups.length) return invalid();
  const slotOrders = new Map<string, number>();
  for (const e of c.entries) {
    if (
      !e ||
      !text(e.id) ||
      !text(e.url) ||
      !text(e.title) ||
      !text(e.remoteId) ||
      e.catalogId !== c.id ||
      !Number.isInteger(e.order) ||
      e.order < 0 ||
      e.order > 10000 ||
      !Array.isArray(e.groupIds) ||
      !Array.isArray(e.rawTypes) ||
      e.groupIds.length > 1000 ||
      e.rawTypes.length > 100 ||
      e.rawTypes.some((t) => !text(t, 180)) ||
      typeof e.related !== 'boolean' ||
      (e.sequenceId !== undefined && !text(e.sequenceId)) ||
      (e.readingSlotId !== undefined && !text(e.readingSlotId)) ||
      (e.readable !== undefined && typeof e.readable !== 'boolean') ||
      (e.contentLanguage !== undefined && !normalizeContentLanguage(e.contentLanguage))
    )
      return invalid();
    if (e.readingSlotId) {
      const key = JSON.stringify([e.sequenceId ?? null, e.readingSlotId]);
      if (slotOrders.has(key) && slotOrders.get(key) !== e.order) return invalid();
      slotOrders.set(key, e.order);
    }
    const target = resolveSource(e.url, definitions).location;
    if (
      target.sourceId !== c.sourceId ||
      target.kind !== 'reader' ||
      target.catalog?.key !== c.id ||
      new Set(e.groupIds).size !== e.groupIds.length ||
      e.groupIds.some((id) => !groups.get(id)?.entryIds?.includes(e.id))
    )
      return invalid();
  }
  for (const g of c.groups) {
    if (
      !g ||
      !text(g.id) ||
      !text(g.title) ||
      typeof g.complete !== 'boolean' ||
      (g.parentId !== undefined && (!text(g.parentId) || !groups.has(g.parentId))) ||
      !Array.isArray(g.entryIds) ||
      g.entryIds.length > 10000 ||
      new Set(g.entryIds).size !== g.entryIds.length ||
      g.entryIds.some((id) => !entries.get(id)?.groupIds.includes(g.id))
    )
      return invalid();
    const orders = g.entryIds.map((id) => entries.get(id)!.order);
    if (orders.some((order, i) => i > 0 && order < orders[i - 1])) return invalid();
    const parents = new Set<string>([g.id]); let parent = g.parentId;
    while (parent) {if (parents.has(parent) || parents.size >= 8) return invalid(); parents.add(parent); parent = groups.get(parent)?.parentId;}
  }
  if (c.defaultEntryId !== undefined && (!entries.has(c.defaultEntryId) || entries.get(c.defaultEntryId)?.related)) return invalid();
  return {
    id: c.id,
    sourceId: c.sourceId,
    url: c.url,
    title: c.title,
    cover: c.cover ? {url: c.cover.url} : undefined,
    observedAt: c.observedAt,
    complete: c.complete,
    note: c.note,
    groups: c.groups,
    entries: c.entries.map(entry => entry.contentLanguage === undefined ? entry : {...entry, contentLanguage: normalizeContentLanguage(entry.contentLanguage)}),
    defaultEntryId: c.defaultEntryId,
  };
}
