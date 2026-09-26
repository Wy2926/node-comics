import {useEffect, useState} from 'react';
import type {DiscoveryError} from '../../discovery/types';
import {msg} from '../../i18n/runtime';

export function DiscoveryNotice({error, cached = false, onRetry}: {error: DiscoveryError; cached?: boolean; onRetry: () => void}) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    setClock(Date.now());
    if (!error.retryAt) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [error]);
  const wait = Math.max(0, Math.ceil(((error.retryAt ?? 0) - clock) / 1000));
  return <div className="nc-discovery-notice" role="status">
    <span>{error.kind === 'rate-limit' ? msg('请求受限') : msg('AniList 暂不可用，请稍后重试。')}{cached && <> {msg('正在显示已缓存的结果。')}</>}</span>
    <button className="button secondary small" disabled={wait > 0} onClick={onRetry}>{wait ? msg('{0} 秒后重试', {'0': wait}) : msg('重试')}</button>
  </div>;
}
