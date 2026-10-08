interface Chapter {
  id: string; contentId?: string; generation: number; pages: readonly {id: string}[];
}
interface Rectangle {top: number; bottom: number; left: number; right: number}
export const completionKey = (chapter: Pick<Chapter, 'id' | 'contentId' | 'generation'>) => JSON.stringify([chapter.id, chapter.contentId ?? null, chapter.generation]);
export const pageKey = (chapter: Pick<Chapter, 'id'>, pageId: string) => `${chapter.id}:${pageId}`;

/** Loaded images are not reading evidence until they intersect the foreground viewport. */
export class CompletionEvidence {
  private readonly loaded = new Map<string, {chapter: string; pageId: string}>();
  private readonly seen = new Map<string, Set<string>>();
  display(chapter: Chapter, pageId: string, ready: boolean) {
    const cell = pageKey(chapter, pageId), key = completionKey(chapter);
    if (ready) this.loaded.set(cell, {chapter: key, pageId});
    else if (this.loaded.get(cell)?.chapter === key) this.loaded.delete(cell);
  }
  observe(viewport: Rectangle, bounds: (cell: string) => Rectangle | undefined, foreground: boolean) {
    if (!foreground) return;
    // Only the finite mounted image window is inspected, never the whole chapter DOM.
    for (const [cell, page] of this.loaded) {
      const box = bounds(cell);
      if (!box || Math.min(box.bottom, viewport.bottom) <= Math.max(box.top, viewport.top) ||
          Math.min(box.right, viewport.right) <= Math.max(box.left, viewport.left)) continue;
      let pages = this.seen.get(page.chapter);
      if (!pages) this.seen.set(page.chapter, pages = new Set());
      pages.add(page.pageId);
    }
  }
  complete(chapter: Chapter) {
    const pages = this.seen.get(completionKey(chapter));
    return chapter.pages.length > 0 && chapter.pages.every(page => pages?.has(page.id));
  }
  /** A deliberate reread needs fresh visibility evidence, but not another image download. */
  reset(chapter: Chapter) { this.seen.delete(completionKey(chapter)); }
  retain(chapters: readonly Chapter[]) {
    const current = new Set(chapters.map(completionKey));
    for (const key of this.seen.keys()) if (!current.has(key)) this.seen.delete(key);
    for (const [cell, page] of this.loaded) if (!current.has(page.chapter)) this.loaded.delete(cell);
  }
}
