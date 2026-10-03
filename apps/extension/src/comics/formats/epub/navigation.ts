import type Contents from 'epubjs/types/contents';
import type Rendition from 'epubjs/types/rendition';
import type {Location} from 'epubjs/types/rendition';
import type {EpubIndex, EpubTocItem} from '../contracts';

export function flattenEpubToc(items: EpubTocItem[], depth = 0): {href: string; label: string; depth: number}[] {
  return items.flatMap(item => [{href: item.href, label: item.label, depth}, ...flattenEpubToc(item.children ?? [], depth + 1)]);
}

/** Resolve only the current document's anchors, not the full book or a generated locations map. */
export class EpubNavigation {
  private byPath = new Map<string, EpubTocItem[]>();
  private fallback = new Map<string, string>();
  private anchors = new WeakMap<Document, {href: string; range: Range}[]>();

  constructor(index: EpubIndex) {
    for (const item of flattenEpubToc(index.toc.length ? index.toc : index.chapters)) {
      const path = item.href.split('#')[0];
      const items = this.byPath.get(path) ?? [];
      items.push(item);
      this.byPath.set(path, items);
    }
    let previous: string | undefined;
    for (const chapter of index.chapters) {
      const items = this.byPath.get(chapter.href);
      this.fallback.set(chapter.href, items?.[0]?.href ?? previous ?? chapter.href);
      previous = items?.at(-1)?.href ?? previous;
    }
  }

  current(rendition: Rendition, location: Location): string {
    const path = location.start.href.replace(/^\//, '');
    const fallback = this.fallback.get(path) ?? path;
    const contents = (rendition as unknown as {getContents(): Contents[]}).getContents()
      .find(content => content.sectionIndex === location.start.index);
    if (!contents) return fallback;
    let anchors = this.anchors.get(contents.document);
    if (!anchors) {
      anchors = (this.byPath.get(path) ?? []).flatMap(item => {
        const fragment = item.href.split('#').slice(1).join('#');
        let id: string;
        try {id = decodeURIComponent(fragment);} catch {id = fragment;}
        const element = fragment ? contents.document.getElementById(id) : contents.document.body;
        if (!element) return [];
        const range = contents.document.createRange();
        range.selectNodeContents(element); range.collapse(true);
        return [{href: item.href, range}];
      }).sort((a, b) => a.range.compareBoundaryPoints(0, b.range));
      this.anchors.set(contents.document, anchors);
    }
    try {
      const current = contents.range(location.start.cfi);
      let low = 0, high = anchors.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (anchors[middle].range.compareBoundaryPoints(0, current) <= 0) low = middle + 1;
        else high = middle;
      }
      return anchors[Math.max(0, low - 1)]?.href ?? fallback;
    } catch {return fallback;}
  }
}
