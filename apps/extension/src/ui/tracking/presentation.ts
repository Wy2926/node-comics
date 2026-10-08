import {msg} from '../../i18n/runtime';

/** Only a manga URL or a positive AniList ID bypasses title search. Never forward arbitrary URLs. */
export function trackingSearchQuery(value: string): string | undefined {
  const query = value.trim();
  if (!query || query.length > 200) return undefined;
  if (/^\d+$/.test(query)) return Number.isSafeInteger(Number(query)) && Number(query) > 0 ? String(Number(query)) : undefined;
  if (/^https?:/i.test(query)) {
    try {
      const url = new URL(query), id = /^\/manga\/([1-9]\d*)(?:\/[^/]*)?\/?$/.exec(url.pathname)?.[1];
      return url.protocol === 'https:' && url.hostname === 'anilist.co' && !url.port && !url.username && !url.password && id && Number.isSafeInteger(Number(id)) ? id : undefined;
    } catch { return undefined; }
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(query) || /^(?:javascript|data|file|chrome|about):/i.test(query) || query.startsWith('//')) return undefined;
  return query;
}

export function trackingReason(reason?: string): string {
  switch (reason) {
    case 'auth': return msg('AniList 授权已失效，请在阅读追踪设置中重新连接。');
    case 'chapter-mapping': case 'invalid': return msg('章节无法可靠换算。小数章、番外、整卷和重置编号不会自动取整同步。');
    case 'protected-state': return msg('AniList 条目已暂停、弃读、完成或处于重读。请先在 AniList 调整状态，再重试。');
    case 'remote-reset': case 'remote-deleted': return msg('AniList 进度被重置或条目已删除。请确认远端记录，不会自动补回旧进度。');
    case 'total-mismatch': return msg('章节进度超出 AniList 已知总数，请核对作品关联与章节偏移量。');
    case 'identity': return msg('账号或作品身份已变化，请重新连接并确认关联。');
    case 'source-changed': return msg('来源内容已变化，请重新确认作品关联。');
    case 'configuration': return msg('此构建尚未配置 AniList 授权。');
    case 'authorization': return msg('AniList 授权未完成。请检查网络，以及 AniList 应用的 Client ID 和回调地址。');
    case 'cancelled': return msg('已取消 AniList 授权。');
    case 'paused': return msg('已暂停');
    case 'unavailable': case 'retry-exhausted': case 'rate-limit': return msg('AniList 暂时不可用或请求受限，请稍后重试。');
    default: return msg('阅读追踪操作失败，请刷新后重试。');
  }
}

export function trackingFailure(error: unknown): string {
  // Never display arbitrary provider text or a URL which could contain credentials.
  const reason = error && typeof error === 'object' && 'reason' in error ? error.reason
    : error && typeof error === 'object' && 'kind' in error ? error.kind
    : error instanceof Error ? error.message : undefined;
  return trackingReason(typeof reason === 'string' ? reason : undefined);
}
