import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readImages, type RecordMeta } from '../lib/translation-store';
import { siteUi } from '../i18n/site-ui';
import { showcaseCopy } from '../i18n/home/showcase';
import type { Locale } from '../i18n/locales';
type View = 'source' | 'result';
export default function ImagePreview({ row, result, locale, downloadLabel, loadingLabel, downloading, onDownload, onClose }: {
  row: RecordMeta; result?: Blob; locale: Locale; downloadLabel: string; loadingLabel: string; downloading: boolean;
  onDownload: () => void; onClose: () => void;
}) {
  const t = siteUi[locale], labels = showcaseCopy[locale];
  const available = row.state === 'succeeded' || !!result;
  const [view, setView] = useState<View>(available ? 'result' : 'source');
  const [actual, setActual] = useState(false), [retry, setRetry] = useState(0);
  const [shown, setShown] = useState<{ url: string; view: View }>();
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), stage = useRef<HTMLDivElement>(null);
  const liveUrl = useRef<string | undefined>(undefined);
  const position = useRef({ x: 0, y: 0 });
  const remember = () => {
    const element = stage.current!;
    position.current = { x: element.scrollLeft / Math.max(1, element.scrollWidth), y: element.scrollTop / Math.max(1, element.scrollHeight) };
  };
  const restore = () => {
    const element = stage.current!;
    element.scrollLeft = position.current.x * element.scrollWidth;
    element.scrollTop = position.current.y * element.scrollHeight;
  };
  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element.showModal();
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      trigger?.focus({ preventScroll: true });
      if (liveUrl.current) URL.revokeObjectURL(liveUrl.current);
    };
  }, []);
  useEffect(() => {
    let cancelled = false, pendingUrl: string | undefined;
    let image: HTMLImageElement | undefined;
    setLoading(true); setError(false);
    void (async () => {
      const data = view === 'result' && result ? undefined : await readImages(row.id);
      const blob = view === 'source' ? data?.source : result ?? data?.result;
      if (cancelled) return;
      if (!blob) throw Error('IMAGE_MISSING');
      pendingUrl = URL.createObjectURL(blob);
      image = new Image(); image.src = pendingUrl;
      await image.decode();
      if (cancelled) return;
      remember();
      if (liveUrl.current) URL.revokeObjectURL(liveUrl.current);
      liveUrl.current = pendingUrl; pendingUrl = undefined;
      setShown({ url: liveUrl.current, view }); setLoading(false);
    })().catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; if (image) image.src = ''; if (pendingUrl) URL.revokeObjectURL(pendingUrl); };
  }, [row.id, available, result, view, retry]);
  useLayoutEffect(restore, [shown, actual]);
  function choose(next: View) {
    if (next === view && !error) return;
    remember(); setView(next); setRetry(value => value + 1);
  }
  return <dialog ref={dialog} className="image-preview" aria-labelledby="image-preview-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="image-preview-heading"><strong id="image-preview-title" title={row.name}>{row.name}</strong><button type="button" className="button secondary compact" onClick={onClose} aria-label={t.close}>×</button></header>
    <div className="image-preview-toolbar">
      <div className="image-preview-choices" role="group" aria-label={t.view}>
        <button className="button secondary compact" aria-pressed={(shown?.view ?? view) === 'source'} onClick={() => choose('source')}>{labels.original}</button>
        <button className="button secondary compact" disabled={!available} aria-pressed={(shown?.view ?? view) === 'result'} onClick={() => choose('result')}>{labels.translated}</button>
      </div>
      <div className="image-preview-choices">
        <button className="button secondary compact" aria-pressed={!actual} onClick={() => { remember(); setActual(false); }}>{t.fit}</button>
        <button className="button secondary compact" aria-pressed={actual} onClick={() => { remember(); setActual(true); }}>{t.actual}</button>
        {available && <button className="button compact" disabled={downloading} onClick={onDownload}>{downloadLabel}</button>}
      </div>
    </div>
    <div className="image-preview-status" role="status">{loading ? loadingLabel : error ? <>{t.unavailable} <button className="text-link" onClick={() => setRetry(value => value + 1)}>{t.retry}</button></> : shown?.view === 'source' ? labels.original : labels.translated}</div>
    <div ref={stage} className="image-preview-stage" data-actual={actual} aria-busy={loading} tabIndex={0}>
      {shown && <img src={shown.url} alt={`${row.name} · ${shown.view === 'source' ? labels.original : labels.translated}`} onLoad={restore}/>}
    </div>
  </dialog>;
}
