import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Mode, Page } from '../types';
import { Icon } from '../icons';
import { Thumbnail } from './Images';
import { thumbnailRows } from './geometry';
import { pageTranslation, taskText } from './presentation';
import { TaskActivity } from './TaskActivity';
export function ThumbnailDirectory({ pages, index, mode, language, ownerId, origin, selected, manage, onSelect, onJump, onMove, onRemove }: {
  pages: Page[];
  index: number;
  mode: Mode;
  language: string;
  ownerId?: string;
  origin: string;
  selected: Set<string>;
  manage: boolean;
  onSelect: (id: string) => void;
  onJump: (n: number) => void;
  onMove: (id: string, delta: number) => void;
  onRemove: (p: Page) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({ width: 320, height: 500 });
  const rows = useMemo(() => thumbnailRows(pages, size.width, manage), [pages, size.width, manage]);
  useLayoutEffect(() => {
    const el = ref.current; const row = rows[index]; if (!el || !row)
      return; if (row.top < el.scrollTop || row.top + row.height > el.scrollTop + el.clientHeight)
      el.scrollTop = row.top; setScrollTop(el.scrollTop);
  }, [index, size.width, manage, pages.length]);
  useEffect(() => {
    if (!ref.current)
      return; const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height })); observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  const visible = rows.map((row, n) => ({ ...row, n })).filter(row => row.top + row.height >= scrollTop - 400 && row.top <= scrollTop + size.height + 400);
  const total = rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0;
  return <div className="nc-thumb-list" ref={ref} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} data-thumbnail-count={visible.length}>
    <div style={{ height: total, position: 'relative' }}>{visible.map(({ n, top, height, pictureHeight }) => {
      const p = pages[n];
      const t = pageTranslation(p, mode, language, ownerId, origin);
      return <div className={`nc-thumb-row ${n === index ? 'current' : ''}`} style={{ position: 'absolute', top, height: height - 12 }} key={p.id}>
        <button className="nc-thumb-main" aria-current={n === index ? 'page' : undefined} onClick={() => onJump(n)}>
          <span className="nc-thumb-picture" style={{ height: pictureHeight }}>
            <Thumbnail blobKey={p.blobKey} alt={`第 ${n + 1} 页缩略图`} />
          </span>
          <span className="nc-thumb-info">
            <b>第 {n + 1} 页{n === index && <i>阅读中</i>}</b>
            <small>{t.pending && t.pending.status !== 'outcome_unknown' && <TaskActivity waiting={t.pending.status === 'queued'} />}{t.pending ? taskText(t.pending) : t.expired ? '译图已过期' : t.ready || t.result?.output_asset_id ? '已有译图' : t.latest ? taskText(t.latest) : p.blobKey ? '原图' : '原图待导入'}</small>
          </span>
        </button>{manage && <div className="nc-thumb-management">
          <label>
            <input type="checkbox" aria-label={`选择第 ${n + 1} 页`} checked={selected.has(p.id)} onChange={() => onSelect(p.id)} />选择此页</label>
          <div className="nc-page-order">
            <button aria-label={`上移第 ${n + 1} 页`} disabled={n === 0} onClick={() => onMove(p.id, -1)}>↑</button>
            <button aria-label={`下移第 ${n + 1} 页`} disabled={n === pages.length - 1} onClick={() => onMove(p.id, 1)}>↓</button>
            <button aria-label={`移除第 ${n + 1} 页`} onClick={() => onRemove(p)}>
              <Icon name="close" size={15} />
            </button>
          </div>
        </div>}</div>;
    })}</div>
  </div>;
}
