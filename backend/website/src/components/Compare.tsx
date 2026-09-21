import { useEffect, useRef, useState } from 'react';

type Example = { id: string; src: string; width: number; height: number; label: string };
export default function Compare({ examples, locale, copy = {} }: { examples: Example[]; locale: string; copy?: Record<string,string> }) {
  const t = (value: string) => copy[value] ?? value;
  const [selected, setSelected] = useState(locale === 'en' || locale === 'ko' ? locale : 'zh');
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
    <div className="compare-toolbar"><span>{t('一页，多种语言。')}</span><div className="segmented" role="group" aria-label={t('插画语言对照')}>{examples.map(item => <button key={item.id} type="button" aria-pressed={selected === item.id} onClick={() => { if (selected !== item.id) { setStatus('loading'); setSelected(item.id); } }}>{t(item.label)}</button>)}</div></div>
    <div className="compare-art" aria-busy={status === 'loading'}>
      <img key={`${selected}-${attempt}`} ref={imgRef} src={current.src} width={current.width} height={current.height} loading="lazy" decoding="async" alt={t(current.label)} style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }} />
      {status !== 'ready' && <div className="compare-feedback" role={status === 'error' ? 'alert' : 'status'}>{status === 'loading' ? <><span className="compare-spinner" aria-hidden="true"/><span>{t('正在加载图片…')}</span></> : <><span>{t('图片加载失败')}</span><button type="button" className="button compact secondary" onClick={() => { setStatus('loading'); setAttempt(value => value + 1); }}>{t('重新加载')}</button></>}</div>}
    </div>
    <p className="image-note" aria-live="polite">{t(current.label)}{t('· AI 生成的功能插画，非产品实测效果承诺')}</p>
  </div>;
}
