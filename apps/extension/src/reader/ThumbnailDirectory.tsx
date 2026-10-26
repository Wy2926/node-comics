import {msg} from '../i18n/runtime';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Mode, Page } from '../types';
import { Thumbnail } from './Images';
import { thumbnailRowHeight, thumbnailWindow } from './geometry';
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
  const [height, setHeight] = useState(0);
  const [range, setRange] = useState({start: 0, end: 0});
  function updateWindow(scrollTop: number) {
    const next = thumbnailWindow(pages.length, scrollTop, height);
    setRange(previous => previous.start === next.start && previous.end === next.end ? previous : next);
  }
  useLayoutEffect(() => {
    const el = ref.current; if (!el || !pages[index] || height <= 0) return;
    const top = index * thumbnailRowHeight, rowHeight = thumbnailRowHeight - 8;
    if (top < el.scrollTop || top + rowHeight > el.scrollTop + height)
      el.scrollTop = top - Math.max(0, (height - rowHeight) / 2);
    updateWindow(el.scrollTop);
  }, [pages.length, pages[index]?.id, index, height]);
  useEffect(() => {
    if (!ref.current)
      return; const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height)); observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  const visible = pages.slice(range.start, range.end);
  return <div className="nc-thumb-list" ref={ref} onScroll={e => updateWindow(e.currentTarget.scrollTop)} data-thumbnail-count={visible.length}>
    <div style={{ height: pages.length * thumbnailRowHeight, position: 'relative' }}>{visible.map((p, offset) => {
      const n = range.start + offset;
      const t = pageTranslation(p, mode, language, translationScope);
      const status = t.pending ? taskText(t.pending) : t.expired ? msg("译图已过期") : t.ready || t.result?.result ? msg("已有译图") : t.latest ? taskText(t.latest) : p.blobKey ? msg("原图") : msg("原图待导入");
      return <div className={`nc-thumb-row ${n === index ? 'current' : ''}`} style={{ position: 'absolute', top: n * thumbnailRowHeight, height: thumbnailRowHeight - 8 }} key={p.id}>
        <button className="nc-thumb-main" aria-current={n === index ? 'page' : undefined} onClick={() => onJump(n)}>
          <span className="nc-thumb-picture">
            <Thumbnail blobKey={p.blobKey} alt={msg("第 {0} 页缩略图", {"0": n + 1})} />
          </span>
          <span className="nc-thumb-info">
            <b>{msg("第 {0} 页", {"0": n + 1})}{n === index && <i>{msg("阅读中")}</i>}</b>
            <small title={status}>{t.pending && t.pending.status !== 'outcome_unknown' && <TaskActivity waiting={t.pending.status === 'queued'} />}<span>{status}</span></small>
          </span>
        </button></div>;
    })}</div>
  </div>;
}
