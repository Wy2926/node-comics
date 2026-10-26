import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import type {TextTranslationError} from '../../text-translation';
import {useRetryClock} from '../useRetryClock';

export function TextTranslationStatus({pending, error, translated, original, onOriginal, onRetry, onTranslate}: {
  pending?: boolean; error?: TextTranslationError; translated: boolean; original: boolean;
  onOriginal: () => void; onRetry: () => void; onTranslate?: () => void;
}) {
  const clock = useRetryClock(error?.retryAt);
  const wait = Math.max(0, Math.ceil(((error?.retryAt ?? 0) - clock) / 1000));
  return <div className="nc-discovery-text-status">
    {!pending && !error && !translated && onTranslate && <button type="button" className="nc-discovery-inline-action" onClick={onTranslate}><Icon name="translate" size={14}/><span>{msg('翻译')}</span></button>}
    {pending && <span role="status"><span className="spinner"/>{msg('翻译中…')}</span>}
    {error && <><span role="status">{msg('文字翻译失败')}</span><button type="button" className="nc-search-text-button" disabled={wait > 0} onClick={onRetry}>{wait ? msg('{0} 秒后重试', {'0': wait}) : msg('重试')}</button></>}
    {translated && <button type="button" className="nc-discovery-inline-action" onClick={onOriginal}><Icon name={original ? 'translate' : 'layers'} size={14}/><span>{original ? msg('查看译文') : msg('查看原文')}</span></button>}
  </div>;
}
