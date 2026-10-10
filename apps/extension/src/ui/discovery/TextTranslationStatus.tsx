import {useEffect, useState} from 'react';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import type {TextTranslationError} from '../../text-translation';

export function TextTranslationStatus({pending, error, translated, original, onOriginal, onRetry, onTranslate}: {
  pending?: boolean; error?: TextTranslationError; translated: boolean; original: boolean;
  onOriginal: () => void; onRetry: () => void; onTranslate?: () => void;
}) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!error?.retryAt) return;
    const deadline = error.retryAt;
    setClock(Date.now());
    if (Date.now() >= deadline) return;
    const timer = setInterval(() => {
      setClock(Date.now());
      if (Date.now() >= deadline) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [error]);
  const wait = Math.max(0, Math.ceil(((error?.retryAt ?? 0) - clock) / 1000));
  return <div className="nc-discovery-text-status">
    {!pending && !error && !translated && onTranslate && <button type="button" className="nc-discovery-inline-action" onClick={onTranslate}><Icon name="translate" size={14}/><span>{msg('翻译')}</span></button>}
    {pending && <span role="status"><span className="spinner"/>{msg('翻译中…')}</span>}
    {error && <><span role="status">{msg('文字翻译失败')}</span><button type="button" className="nc-search-text-button" disabled={wait > 0} onClick={onRetry}>{wait ? msg('{0} 秒后重试', {'0': wait}) : msg('重试')}</button></>}
    {translated && <button type="button" className="nc-discovery-inline-action" onClick={onOriginal}><Icon name={original ? 'translate' : 'layers'} size={14}/><span>{original ? msg('查看译文') : msg('查看原文')}</span></button>}
  </div>;
}
