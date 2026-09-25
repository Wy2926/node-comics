import {msg} from '../i18n/runtime';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Mode, Page } from '../types';
import { Thumbnail } from './Images';
import { thumbnailRows } from './geometry';
import { pageTranslation, taskText } from './presentation';
import { TaskActivity } from './TaskActivity';
export function ThumbnailDirectory({ pages, index, mode, language, translationScope, onJump }: {
  pages: Page[];
  index: number;
  mode: Mode;
  language: string;
  translationScope?: string;
  onJump: (n: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({ width: 320, height: 500 });
  const rows = useMemo(() => thumbnailRows(pages, size.width), [pages, size.width]);
  const current = rows[index];
  useLayoutEffect(() => {
    const el = ref.current; const row = current; if (!el || !row)
      return; if (row.top < el.scrollTop || row.top + row.height > el.scrollTop + el.clientHeight)
      el.scrollTop = row.top - Math.max(0, (el.clientHeight - row.height) / 2); setScrollTop(el.scrollTop);
  }, [pages[index]?.id, index, current?.top, current?.height, size.height]);
  useEffect(() => {
    if (!ref.current)
      return; const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height })); observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  const visible = rows.map((row, n) => ({ ...row, n })).filter(row => row.top + row.height >= scrollTop - 400 && row.top <= scrollTop + size.height + 400);
  const total = rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0;
  return <div className="nc-thumb-list" ref={ref} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} data-thumbnail-count={visible.length}>
    <div style={{ height: total, position: 'relative' }}>{visible.map(({ n, top, height, pictureHeight }) => {
      const p = pages[n];
      const t = pageTranslation(p, mode, language, translationScope);
      return <div className={`nc-thumb-row ${n === index ? 'current' : ''}`} style={{ position: 'absolute', top, height: height - 12 }} key={p.id}>
        <button className="nc-thumb-main" aria-current={n === index ? 'page' : undefined} onClick={() => onJump(n)}>
          <span className="nc-thumb-picture" style={{ height: pictureHeight }}>
            <Thumbnail blobKey={p.blobKey} alt={msg("第 {0} 页缩略图", {"0": n + 1})} />
          </span>
          <span className="nc-thumb-info">
            <b>{msg("第 {0} 页", {"0": n + 1})}{n === index && <i>{msg("阅读中")}</i>}</b>
            <small>{t.pending && t.pending.status !== 'outcome_unknown' && <TaskActivity waiting={t.pending.status === 'queued'} />}{t.pending ? taskText(t.pending) : t.expired ? msg("译图已过期") : t.ready || t.result?.result ? msg("已有译图") : t.latest ? taskText(t.latest) : p.blobKey ? msg("原图") : msg("原图待导入")}</small>
          </span>
        </button></div>;
    })}</div>
  </div>;
}
