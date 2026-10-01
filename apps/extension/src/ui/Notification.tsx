import {useEffect, useRef, useState} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import './notification.css';

export function Notification({message, tone, onClose, action, duration = 12000}: {
  message: string;
  tone: 'info' | 'error' | 'success';
  onClose: () => void;
  action?: {label: string; onClick: () => void};
  duration?: number;
}) {
  const close = useRef(onClose);close.current = onClose;
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    if (hovered || focused || hidden) return;
    const timer = setTimeout(() => close.current(), duration);
    return () => clearTimeout(timer);
  }, [message, duration, hovered, focused, hidden]);
  return <div className={`nc-notification ${tone}`} role={tone === 'error' ? 'alert' : 'status'} aria-atomic="true"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => {if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);}}
    onKeyDown={event => {if (event.key === 'Escape') {event.stopPropagation();onClose();}}}>
    <Icon name={tone === 'success' ? 'check' : 'info'} size={20}/>
    <div className="nc-notification-content"><p>{message}</p>{action && <button type="button" className="nc-notification-action" onClick={() => {onClose();action.onClick();}}>{action.label}<Icon name="arrow" size={14}/></button>}</div>
    <button type="button" className="icon-button nc-notification-close" aria-label={msg('关闭提示')} onClick={onClose}><Icon name="close" size={18}/></button>
  </div>;
}
