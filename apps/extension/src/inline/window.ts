import { DECODED_PAGE_WINDOW } from '../image-resources';
import { MAX_READING_TARGETS } from '../translation/automatic';

type Positioned = { rect: { top: number; bottom: number; left: number; right: number } };
export const visibleImage = (item: Positioned, width: number, height: number) =>
  item.rect.bottom > 0 && item.rect.top < height && item.rect.right > 0 && item.rect.left < width;
const distance = ({ rect }: Positioned, width: number, height: number) => {
  const x = Math.max(0, rect.left - width, -rect.right), y = Math.max(0, rect.top - height, -rect.bottom);
  return x * x + y * y;
};

/** Screen geometry, not DOM adjacency, defines the reading surface and its lookahead. */
export function readingImages<T extends Positioned>(items: T[], width: number, height: number, direction: 'ltr' | 'rtl' = 'ltr') {
  const focus = Math.min(height * .3, 240);
  const order = (a: T, b: T) => a.rect.top - b.rect.top ||
    (direction === 'rtl' ? b.rect.right - a.rect.right : a.rect.left - b.rect.left);
  const visible = items.filter(i => visibleImage(i, width, height)).sort((a, b) =>
    Math.max(0, a.rect.top - focus, focus - a.rect.bottom) - Math.max(0, b.rect.top - focus, focus - b.rect.bottom) || order(a, b));
  if (!visible.length || visible.length >= MAX_READING_TARGETS) return visible;
  const ahead = items.filter(i => i.rect.top >= height || i.rect.bottom > 0 && i.rect.top < height &&
    (direction === 'rtl' ? i.rect.right <= 0 : i.rect.left >= width));
  ahead.sort((a, b) => distance(a, width, height) - distance(b, width, height) || order(a, b));
  return [...visible, ...ahead.slice(0, MAX_READING_TARGETS - visible.length)];
}

/** Visible slices own their displays; only spare nearby slots are a cache. */
export function retainedImages<T extends Positioned>(items: T[], width: number, height: number) {
  const visible = items.filter(i => visibleImage(i, width, height));
  const retained = new Set(visible);
  if (visible.length >= DECODED_PAGE_WINDOW) return retained;
  const nearby = items.filter(i => !retained.has(i)).sort((a, b) => distance(a, width, height) - distance(b, width, height));
  for (const item of nearby.slice(0, DECODED_PAGE_WINDOW - visible.length)) retained.add(item);
  return retained;
}

/** Completion frees a batch slot, never the on-screen display or the reading anchor. */
export function readingBatch<T extends { id: string; checked?: boolean; pending?: boolean }>(items: T[], retryId?: string) {
  const retry = items.find(i => i.id === retryId);
  // Manual requests submit only their target. Unchecked neighbours belong to the next automatic batch.
  if (retry) return [retry];
  return items.filter(i => !i.checked || i.pending).slice(0, MAX_READING_TARGETS);
}
