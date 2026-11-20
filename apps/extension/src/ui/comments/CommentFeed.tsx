import {useCallback, useRef, useState, type ReactNode} from 'react';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {DiscoveryError} from '../../discovery/types';
import {DiscoveryNotice} from '../discovery/DiscoveryNotice';
import {useWorkRequest} from '../discovery/useWorkRequest';
import './comments.css';

interface CommentPage<T> {items: T[]; next?: string; source?: {title: string; url: string}}

/** Mounted for one work or release. Only the displayed page owns comment rows. */
export function CommentFeed<T extends {id: string}>({provider, read, action, children}: {
  provider: string; read: (cursor: string | undefined, signal: AbortSignal) => Promise<CommentPage<T>>; action?: ReactNode; children: (item: T) => ReactNode;
}) {
  const [trail, setTrail] = useState<(string | undefined)[]>([undefined]);
  const cursor = trail.at(-1), page = trail.length;
  const cache = useRef(new Map<string | undefined, CommentPage<T>>());
  const load = useCallback(async (signal: AbortSignal) => {
    let result = cache.current.get(cursor);
    if (!result) {
      result = await read(cursor, signal);
      signal.throwIfAborted();
      if (result.next && trail.includes(result.next)) throw new DiscoveryError('invalid');
      cache.current.set(cursor, result);
      if (cache.current.size > 6) cache.current.delete(cache.current.keys().next().value);
    }
    return {...result, page};
  }, [read, trail, cursor, page]);
  const {value: result, loading, error, retry} = useWorkRequest(load);
  const value = result?.page === page ? result : undefined;
  const list = useRef<HTMLDivElement>(null);
  const move = (next: (string | undefined)[]) => {setTrail(next); list.current?.scrollTo({top: 0});};
  return <>
    <div ref={list} className="nc-comment-scroll" tabIndex={0} aria-busy={loading} data-scrollbar-mode="reserved">
      {(value?.source || action) && <div className="nc-comment-source">
        <div><small>{provider} · {msg('作品评论')}</small>{value?.source && <a href={value.source.url} target="_blank" rel="noopener noreferrer">
          <b dir="auto">{value.source.title}</b><Icon name="external" size={12}/></a>}</div>{action}
      </div>}
      {!!value?.items.length && <ol className="nc-comment-list">{value.items.map(item => <li className="nc-comment" key={item.id}>{children(item)}</li>)}</ol>}
      {value && !value.items.length && <p className="nc-comment-empty" role="status">{msg('暂无公开评论')}</p>}
      {loading && <p className="nc-comment-status" role="status"><span className="spinner"/>{msg('加载中…')}</p>}
      {error && <DiscoveryNotice provider={provider} error={error} onRetry={retry}/>}
    </div>
    {(page > 1 || value?.next) && <nav className="nc-comment-pages" aria-label={msg('评论')}>
      <button className="text-link" disabled={page === 1} onClick={() => move(trail.slice(0, -1))}>{msg('上一页')}</button>
      <span>{msg('第 {0} 页', {'0': page})}</span>
      <button className="text-link" disabled={loading || !value?.next} onClick={() => move([...trail, value?.next])}>{msg('下一页')}</button>
    </nav>}
  </>;
}
