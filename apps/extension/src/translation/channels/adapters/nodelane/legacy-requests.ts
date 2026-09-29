import {Api, ApiError} from '../../../../api';
import {msg} from '../../../../i18n/runtime';
import {sourceDatabaseName, SourceDatabaseSchemaError} from '../../../../storage/database';
import type {TranslationSnapshot} from '../../../../types';
import type {ReadingTarget} from '../../../automatic';

interface StoredReceipt {
  scope: string;
  requestId: string;
  entryId: string;
  pageId: string;
  pageRef?: {contentId: string};
  mode: string;
  language: string;
  state: string;
  result?: {state: string};
}

interface Receipt {
  id: string;
  entryId: string;
  pageId: string;
  contentId?: string;
  mode: string;
  language: string;
  unresolvedRedraw: boolean;
}

/** Read receipt identities only. Never copy old requests, results or source references. */
async function readReceipts(origin: string, userId: string): Promise<Receipt[]> {
  const name = sourceDatabaseName('translation-requests');
  const database = await new Promise<IDBDatabase | undefined>((resolve, reject) => {
    let absent = false;
    const opening = indexedDB.open(name);
    opening.onupgradeneeded = () => { absent = true; opening.transaction!.abort(); };
    opening.onerror = () => absent ? resolve(undefined) : reject(opening.error);
    opening.onsuccess = () => resolve(opening.result);
  });
  if (!database) return [];
  try {
    if (!database.objectStoreNames.contains('operations')) throw new SourceDatabaseSchemaError(name, '缺少 operations');
    const scope = JSON.stringify([origin, userId]);
    return await new Promise<Receipt[]>((resolve, reject) => {
      const tx = database.transaction('operations', 'readonly');
      const rows: Receipt[] = [];
      const cursor = tx.objectStore('operations').openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        const value = current.value as StoredReceipt;
        if (value.scope === scope && typeof value.requestId === 'string') {
          rows.push({id: value.requestId, entryId: value.entryId, pageId: value.pageId,
            contentId: value.pageRef?.contentId, mode: value.mode, language: value.language,
            unresolvedRedraw: value.mode === 'redraw' && (value.state === 'uncertain' ||
              !!value.result && ['needs_input', 'queued', 'running', 'needs_attention'].includes(value.result.state))});
        }
        current.continue();
      };
      tx.oncomplete = () => resolve(rows);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally { database.close(); }
}

/** A page-local upgrade guard, not an old-protocol executor. Only explicit retries refresh it. */
export class LegacyRequestGuard {
  private receipts?: Promise<Receipt[]>;
  private verified = new Map<string, TranslationSnapshot['state'] | 'missing'>();
  constructor(private api: Api, private userId: string, private language: string) {}

  async check(target: ReadingTarget, manual = false): Promise<void> {
    const receipts = await (this.receipts ??= readReceipts(new URL(this.api.base).origin, this.userId));
    const matches = (receipt: Receipt) => receipt.entryId === target.entryId && receipt.pageId === target.page.id &&
      receipt.mode === target.mode && receipt.language === this.language &&
      (!receipt.contentId || receipt.contentId === target.page.contentId);
    // Normalization can change image hashes. Old uncertain redraws must be checked even then.
    const relevant = receipts.filter(receipt => matches(receipt) || target.mode === 'redraw' && receipt.unresolvedRedraw);
    const ids = [...new Set(relevant.filter(receipt => manual || !this.verified.has(receipt.id)).map(receipt => receipt.id))];
    for (let offset = 0; offset < ids.length; offset += 32) {
      const batch = ids.slice(offset, offset + 32);
      const response = await this.api.translations(batch);
      if (response.unchanged) throw new ApiError(msg('原请求结果待核实，暂不能重复翻译。'), 'LEGACY_REQUEST_PENDING');
      for (const id of batch) {
        const snapshot = response.items.find(item => item.id === id);
        if (snapshot) {
          const unresolved = relevant.some(receipt => receipt.id === id && receipt.unresolvedRedraw);
          // Revocation alone cannot resolve an uncertain call; require explicit server evidence.
          const unverifiedRevocation = unresolved && snapshot.error?.code === 'TRANSLATION_UNAVAILABLE' &&
            snapshot.execution_resolved !== true;
          this.verified.set(id, unverifiedRevocation ? 'needs_attention' : snapshot.state);
        }
        else if (response.missing_ids.includes(id)) this.verified.set(id, 'missing');
      }
    }
    if (relevant.some(receipt => !['missing', 'failed', 'succeeded'].includes(this.verified.get(receipt.id) ?? ''))) {
      throw new ApiError(msg('原请求结果待核实，暂不能重复翻译。'), 'LEGACY_REQUEST_PENDING');
    }
    if (!manual && relevant.some(receipt => matches(receipt) && this.verified.get(receipt.id) !== 'missing')) {
      throw new ApiError(msg('翻译协议已更新，请手动重新翻译此页。'), 'TRANSLATION_PROTOCOL_CHANGED');
    }
  }
}
