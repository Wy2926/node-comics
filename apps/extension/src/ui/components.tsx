import {msg} from '../i18n/runtime';
import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../icons';
import './modal.css';
export function Modal({ title, subtitle, children, onClose, className='', closeLabel=msg("关闭弹窗") }: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  closeLabel?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({preventScroll: true});
    };
  }, []);
  return <dialog ref={ref} className={'modal nc-generic-modal '+className} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="nc-modal-controls">
      <span className="modal-spark"><Icon name="spark" size={24}/></span>
      <button type="button" className="modal-close icon-button" aria-label={closeLabel} onClick={onClose}><Icon name="close" /></button>
    </div>
    <div className="nc-modal-body" tabIndex={0}>
      <h2>{title}</h2>
      {subtitle && <p className="modal-subtitle">{subtitle}</p>}
      {children}
    </div>
  </dialog>;
}
export function PageTitle({ eyebrow, title, description, icon='spark' }: {
  icon?: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return <div className="page-title"><span className="eyebrow muted">{eyebrow}</span><h1>{title}</h1><p>{description}</p><span className="nc-heading-star"><Icon name={icon} size={48}/></span></div>;
}
export function Stat({ label, value, suffix }: {
  label: string;
  value: number | string;
  suffix?: string;
}) {
  return <div className="stat-card"><span>{label}</span><b>{value}<small>{suffix}</small></b><Icon name="spark" size={32} /></div>;
}
export function SettingRow({ title, description, children }: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return <div className="setting-row"><div><b>{title}</b><p>{description}</p></div>{children}</div>;
}
