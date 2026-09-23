import { ByteCache } from '../cache';
export const thumbnailCache = new ByteCache({ name: 'thumbnails', budgetBytes: 64 * 1024 ** 2 });
