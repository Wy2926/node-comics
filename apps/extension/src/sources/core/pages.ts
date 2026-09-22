import type { SourceLocation } from '../contracts/definition';
import type { SourceSnapshot } from '../contracts/source';
import { safeImageUrl } from '../shared/urls';
export function validatePages(snapshot: SourceSnapshot, location: SourceLocation) {
  const fail = () => {
    throw Error('INVALID_SOURCE_PAGES');
  };
  if (
    snapshot.adapter !== location.sourceId ||
    snapshot.url !== location.url ||
    !Array.isArray(snapshot.items) ||
    snapshot.items.length > 10000 ||
    !['ltr', 'rtl'].includes(snapshot.direction) ||
    typeof snapshot.title !== 'string' ||
    typeof snapshot.note !== 'string' ||
    snapshot.note.length > 2048 ||
    typeof snapshot.discoveryComplete !== 'boolean'
  )
    return fail();
  if (
    snapshot.knownTotal !== undefined &&
    (!Number.isInteger(snapshot.knownTotal) ||
      snapshot.knownTotal < snapshot.items.length ||
      snapshot.knownTotal > 10000)
  )
    return fail();
  const ids = new Set<string>(),
    orders = new Set<number>();
  for (const item of snapshot.items) {
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 2048 ||
      ids.has(item.id) ||
      !Number.isInteger(item.order) ||
      item.order < 0 ||
      item.order > 10000 ||
      orders.has(item.order) ||
      !Number.isFinite(item.width) ||
      !Number.isFinite(item.height) ||
      item.width < 0 ||
      item.height < 0
    )
      return fail();
    ids.add(item.id);
    orders.add(item.order);
    if (item.resource?.kind === 'http') {
      if (safeImageUrl(item.resource.url, snapshot.url) !== item.resource.url) return fail();
    } else if (
      item.resource?.kind !== 'page' ||
      typeof item.resource.resourceKey !== 'string' ||
      !item.resource.resourceKey ||
      item.resource.resourceKey.length > 2048
    )
      return fail();
  }
  if (
    snapshot.items.some((item, i) => i > 0 && item.order <= snapshot.items[i - 1].order) ||
    (snapshot.discoveryComplete && snapshot.knownTotal !== snapshot.items.length)
  )
    return fail();
  return snapshot;
}
