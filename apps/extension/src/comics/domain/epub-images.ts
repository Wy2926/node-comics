import type {EpubIndex} from '../formats/contracts';
import type {PageDescriptor} from './index';

export const epubImageId = (href: string) => `epub-image:${href}`;

/** An image locator is valid only inside the current verified EPUB manifest. */
export function epubImageDescriptor(index: EpubIndex | undefined, contentId: string, pageId: string): PageDescriptor | undefined {
  if (!pageId.startsWith('epub-image:')) return;
  const href = pageId.slice('epub-image:'.length);
  const ordinal = index?.images?.findIndex(image => image.href === href) ?? -1;
  if (ordinal < 0) return;
  const locator = {epubImage: href};
  return {contentId, pageId, ordinal, name: href.split('/').at(-1)!, locator, formatLocator: JSON.stringify(locator)};
}
