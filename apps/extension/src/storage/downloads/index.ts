import { ByteCache } from '../cache';
/** Explicitly saved material. Only explicit delete/clear releases it; pressure and LRU never do. */
export const downloadStore = new ByteCache({ name: 'downloads', budgetBytes: Infinity, retained: true });
export const downloadKey = (contentId: string, pageId: string) => JSON.stringify([contentId, pageId]);
