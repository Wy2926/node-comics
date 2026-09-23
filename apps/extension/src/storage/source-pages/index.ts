import { ByteCache } from '../cache';
export const sourcePageCache = new ByteCache({ name: 'source-pages', budgetBytes: 2 * 1024 ** 3 });
export const sourcePageKey = (connectionId: string, contentId: string, pageId: string, profile: string) => JSON.stringify([connectionId, contentId, pageId, profile]);
