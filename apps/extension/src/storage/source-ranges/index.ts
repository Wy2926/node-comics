import { ByteCache } from '../cache';
export const sourceRangeCache = new ByteCache({ name: 'source-ranges', budgetBytes: 256 * 1024 ** 2 });
export const sourceRangeKey = (connectionId: string, bindingId: string, sourceVersion: string, offset: number, length: number) => JSON.stringify([connectionId, bindingId, sourceVersion, offset, length]);
