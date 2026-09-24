import { useEffect, useRef, useState } from 'react';
import type { HomeCopy } from '../i18n/home/types';

type Example = { id: string; src: string; width: number; height: number; label: string };
export default function Compare({ examples, locale, copy }: { examples: Example[]; locale: string; copy: HomeCopy['comparison'] }) {
  const [selected, setSelected] = useState(locale === 'en' || locale === 'ko' ? locale : locale === 'ja' ? 'original' : 'zh');
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const imgRef = useRef<HTMLImageElement>(null);
  const current = examples.find(item => item.id === selected)!;
  useEffect(() => {
    let active = true;
    const img = imgRef.current!;
    const ready = async () => {
      try { await img.decode(); if (active) setStatus('ready'); }
      catch { if (active) setStatus('error'); }
    };
    const failed = () => { if (active) setStatus('error'); };
    img.addEventListener('load', ready);
    img.addEventListener('error', failed);
    if (img.complete) { if (img.naturalWidth) void ready(); else failed(); }
    return () => { active = false; img.removeEventListener('load', ready); img.removeEventListener('error', failed); };
  }, [selected, attempt]);
  return <div className="compare">
    <div className="compare-toolbar"><span>{copy.title}</span><div className="segmented" role="group" aria-label={copy.group}>{examples.map(item => <button key={item.id} type="button" aria-pressed={selected === item.id} onClick={() => { if (selected !== item.id) { setStatus('loading'); setSelected(item.id); } }}>{item.label}</button>)}</div></div>
    <div className="compare-art" aria-busy={status === 'loading'}>
      <img key={`${selected}-${attempt}`} ref={imgRef} src={current.src} width={current.width} height={current.height} loading="lazy" decoding="async" alt={current.label} style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }} />
      {status !== 'ready' && <div className="compare-feedback" role={status === 'error' ? 'alert' : 'status'}>{status === 'loading' ? <><span className="compare-spinner" aria-hidden="true"/><span>{copy.loading}</span></> : <><span>{copy.error}</span><button type="button" className="button compact secondary" onClick={() => { setStatus('loading'); setAttempt(value => value + 1); }}>{copy.retry}</button></>}</div>}
    </div>
    <p className="image-note">{copy.caption}</p>
  </div>;
}
