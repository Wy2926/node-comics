import { ByteCache } from '../cache';
let overrideMb: number | undefined;
function budgetBytes(): number {
  if (overrideMb !== undefined) return overrideMb === -1 ? Infinity : overrideMb * 1024 ** 2;
  try { const value = JSON.parse(localStorage.getItem('nc-settings') ?? '{}').cacheLimitMb; if (value === -1) return Infinity; if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value * 1024 ** 2; } catch { /* Worker/no localStorage: use independent default. */ }
  return 1024 ** 3;
}
export const translationCache = new ByteCache({ name: 'translations', budgetBytes });
export async function setTranslationCacheLimitMb(mb: number): Promise<void> {
  if (!Number.isFinite(mb) || mb < 0 && mb !== -1) throw Error('Invalid translation cache budget');
  overrideMb = mb; await translationCache.enforceBudget();
}
export const translationKey = (apiOrigin: string, userId: string, resultVersion: string, outputAssetId: string) => JSON.stringify([apiOrigin, userId, resultVersion, outputAssetId]);
