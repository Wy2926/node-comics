import { msg } from '../../i18n/runtime';
import type { PageImage } from '../contracts/page';
import type { PageSnapshot, SourceItem, SourceSnapshot } from '../contracts/source';
import { imageDataUrl } from '../shared/bytes';

const previewBudget = 2_000_000;
const maxPreviewBytes = 100_000;
interface ResourceEntry {
  handle: string;
  id: string;
  image: PageImage;
  width: number;
  height: number;
  pageUrl: string;
  preview?: string | null;
}

/** Handles and cached previews live only as long as the registered source version. */
export class PageImageRegistry {
  private entries = new Map<string, ResourceEntry>();
  private slots = new Map<string, ResourceEntry>();
  private previewBytes = 0;

  clear() {
    this.entries.clear();
    this.slots.clear();
    this.previewBytes = 0;
  }

  register(snapshot: SourceSnapshot, images: PageImage[]): PageSnapshot {
    const pages = new Map(snapshot.items.map((item) => [item.id, item]));
    const targets = new Map(images.map((image) => [image.url, image]));
    for (const [handle, entry] of this.entries) {
      const page = pages.get(entry.id);
      const image = page?.resource.kind === 'page' ? targets.get(page.resource.resourceKey) : undefined;
      if (
        entry.pageUrl === snapshot.url &&
        image?.element === entry.image.element &&
        image.key === entry.image.key &&
        image.url === entry.image.url &&
        page?.width === entry.width &&
        page.height === entry.height
      )
        continue;
      this.entries.delete(handle);
      this.slots.delete(entry.id);
      this.previewBytes -= entry.preview?.length ?? 0;
    }

    const items: SourceItem[] = [];
    for (const { resource, ...slot } of snapshot.items) {
      if (resource.kind === 'http') {
        items.push({ ...slot, url: resource.url });
        continue;
      }
      const image = targets.get(resource.resourceKey);
      if (!image?.read) continue;
      let entry = this.slots.get(slot.id);
      if (!entry) {
        entry = { ...slot, handle: 'page-image:' + crypto.randomUUID(), image, pageUrl: snapshot.url };
        this.slots.set(slot.id, entry);
        this.entries.set(entry.handle, entry);
      }
      // Reserve a complete per-image allowance before doing synchronous encoding.
      if (entry.preview === undefined && previewBudget - this.previewBytes >= maxPreviewBytes) {
        entry.preview = this.preview(entry);
        this.previewBytes += entry.preview?.length ?? 0;
      }
      items.push({ ...slot, kind: 'page', url: entry.handle, preview: entry.preview ?? undefined });
    }
    return { ...snapshot, items };
  }

  private preview(entry: ResourceEntry): string | null {
    const height = Math.round((180 * entry.height) / entry.width);
    if (!Number.isFinite(height) || height < 1 || height > 1000) return null;
    try {
      const canvas = entry.image.element.ownerDocument.createElement('canvas');
      canvas.width = 180;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(entry.image.element, 0, 0, canvas.width, canvas.height);
      const value = canvas.toDataURL('image/png');
      return value.length <= maxPreviewBytes ? value : null;
    } catch {
      // Acquisition reports unreadable canvas errors. A preview is optional.
      return null;
    }
  }

  async read(
    handle: string,
    pageUrl: string,
    id: string,
    getCurrent: () => PageImage[],
    signal?: AbortSignal,
  ) {
    const validate = () => {
      signal?.throwIfAborted();
      const entry = this.entries.get(handle);
      const image = getCurrent().find(
        (image) =>
          image.element === entry?.image.element &&
          image.key === entry.image.key &&
          image.url === entry.image.url,
      );
      if (
        !entry ||
        entry.id !== id ||
        entry.pageUrl !== pageUrl ||
        !image?.read ||
        !image.element.isConnected ||
        image.element.width !== entry.width ||
        image.element.height !== entry.height
      ) {
        throw Error(msg('图片来源已变化，请重新发现。'));
      }
      return image;
    };
    const timeout = AbortSignal.timeout(30000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let onAbort: () => void = () => {};
    try {
      const data = await Promise.race([
        validate().read!().then(imageDataUrl),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(Error('SOURCE_RESOURCE_EXPIRED'));
          combined.addEventListener('abort', onAbort, { once: true });
          if (combined.aborted) onAbort();
        }),
      ]);
      validate();
      combined.throwIfAborted();
      return data;
    } finally {
      combined.removeEventListener('abort', onAbort);
    }
  }
}
