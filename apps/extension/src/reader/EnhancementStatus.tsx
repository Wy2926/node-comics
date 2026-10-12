import {msg} from '../i18n/runtime';
import type {ProcessingState} from '../image-processing/contracts';
import './image-notices.css';

export function EnhancementStatus({state, onRetry}: {state?: ProcessingState; onRetry(): void}) {
  if (!state || state.phase === 'ready') return null;
  return <div className="nc-image-status-layer nc-enhancement-layer"><div className="nc-enhancement-status" role="status" data-enhancement-state={state.phase}>
    <span>{state.phase === 'error' ? state.message : state.phase === 'running' ? msg('增强中…') : msg('等待增强')}</span>
    {state.phase === 'error' && <button type="button" className="text-link" onClick={event => {event.stopPropagation(); onRetry();}}>{msg('重试增强')}</button>}
  </div></div>;
}
