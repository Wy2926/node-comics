import {useEffect, useRef, useState, type ReactNode} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import './notification.css';

/** Content and placement belong to callers; dismissal and active time have one owner. */
export function Notification({message, children, tone, onClose, action, duration = 12000, notificationKey = message, paused = false, className = '', icon}: {
  message?: string;
  children?: ReactNode;
  tone: 'info' | 'error' | 'success';
  onClose: () => void;
  action?: ReactNode;
  duration?: number | null;
  notificationKey?: unknown;
  paused?: boolean;
  className?: string;
  icon?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);close.current = onClose;
  const lifetime = useRef({key: notificationKey, duration, remaining: duration ?? 0, closed: false});
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  function dismiss() {
    if (lifetime.current.closed) return;
    lifetime.current.closed = true;
    close.current();
  }
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    if (!Object.is(lifetime.current.key, notificationKey) || lifetime.current.duration !== duration)
      lifetime.current = {key: notificationKey, duration, remaining: duration ?? 0, closed: false};
    // Replacing custom content can remove the focused action without a blur event.
    if (focused && root.current && !root.current.contains(document.activeElement)) {setFocused(false);return;}
    const current = lifetime.current;
    if (hovered || focused || hidden || paused || current.closed || duration === null) return;
    const started = performance.now(), timer = setTimeout(dismiss, Math.max(0, current.remaining));
    return () => {
      clearTimeout(timer);
      current.remaining = Math.max(0, current.remaining - (performance.now() - started));
    };
  }, [notificationKey, duration, hovered, focused, hidden, paused]);
  return <div ref={root} className={`nc-notification ${tone} ${className}`.trim()} role={tone === 'error' ? 'alert' : 'status'} aria-atomic="true"
    onPointerEnter={event => {if (event.pointerType !== 'touch') setHovered(true);}} onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => {if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);}}
    onKeyDown={event => {if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {event.preventDefault();event.stopPropagation();dismiss();}}}>
    {icon === undefined ? <Icon name={tone === 'success' ? 'check' : 'info'} size={20}/> : icon}
    <div className="nc-notification-content">{children ?? <p>{message}</p>}{action && <div className="nc-notification-actions">{action}</div>}</div>
    <button type="button" className="icon-button nc-notification-close" aria-label={msg('关闭提示')} onClick={dismiss}><Icon name="close" size={18}/></button>
  </div>;
}
