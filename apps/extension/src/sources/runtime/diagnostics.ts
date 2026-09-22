import { msg, type MessageKey } from '../../i18n/runtime';
import type { SourceDiagnosticCode } from '../contracts/diagnostics';
const diagnostics = {
  SOURCE_DATA_AMBIGUOUS: '来源图片数据不唯一，请刷新来源页面后重试。',
  SOURCE_DATA_FORMAT: '来源图片数据格式已变化，无法读取图片清单。',
  SOURCE_DATA_DECODE: '来源图片数据无法解码，请刷新来源页面后重试。',
  SOURCE_PAGES_INVALID: '来源图片清单不可用。',
  SOURCE_TOTAL_MISMATCH: '来源图片清单与网页总页数不一致，请刷新后重试。',
  SOURCE_IMAGE_URL_INVALID: '来源图片清单包含无效地址。',
  SOURCE_PAGE_COUNT_MISMATCH: '来源页面与图片清单不一致，请重新发现。',
  SOURCE_PAGE_ORDER_MISMATCH: '来源页面的图片顺序与清单不一致，请重新发现。',
} satisfies Record<SourceDiagnosticCode, MessageKey>;
/** Codes stay stable while extension-owned messages remain localized. */
export function sourceFailure(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  const code = /^[A-Z][A-Z_]+$/.test(detail) ? detail : undefined;
  const known =
    code && Object.hasOwn(diagnostics, code) ? diagnostics[code as SourceDiagnosticCode] : undefined;
  const message = known
    ? msg(known)
    : code === 'INVALID_SOURCE_CATALOG'
      ? msg('来源目录无效。')
      : code === 'SOURCE_SESSION_EXPIRED' || code === 'SOURCE_RESOURCE_EXPIRED'
        ? msg('图片来源已变化，请重新发现。')
        : code === 'WAITING_FOR_CATALOG' || code === 'CATALOG_DISCOVERY_FAILED'
          ? msg('目录未完整加载，请打开来源页处理后重试。')
          : code
            ? msg('来源图片清单读取失败。')
            : detail;
  return { error: message, ...(code ? { code } : {}) };
}
