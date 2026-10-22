import type {ReactNode} from 'react';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import type {Settings} from '../types';

/** Shared display controls for image and EPUB readers. */
export function ReaderChoice<T extends string>({label, value, options, onChange, variant = 'segmented'}: {
  label: string;
  value: T;
  variant?: 'segmented' | 'cards';
  options: readonly {id: T; label: string; icon?: ReactNode}[];
  onChange(value: T): void;
}) {
  return <div className="field"><span>{label}</span><div className={`nc-reader-choices ${variant === 'cards' ? 'nc-reader-choice-cards' : 'segmented'}`} role="group" aria-label={label}>
    {options.map(option => <button key={option.id} className={`${variant === 'cards' ? 'button secondary ' : ''}${value === option.id ? 'active' : ''}`} aria-pressed={value === option.id}
      onClick={() => onChange(option.id)}>{option.icon}{variant === 'cards' ? <span>{option.label}</span> : option.label}</button>)}
  </div></div>;
}

export function ReaderScale({label, value, min, max, disabled, onChange}: {
  label: string; value: number; min: number; max: number; disabled?: boolean; onChange(value: number): void;
}) {
  return <div className="nc-reader-option"><b>{label}</b><div className="nc-inline">
    <button className="icon-button" aria-label={msg('缩小')} disabled={disabled || value <= min} onClick={() => onChange(value - 10)}><Icon name="minus"/></button>
    <span>{value}%</span>
    <button className="icon-button" aria-label={msg('放大')} disabled={disabled || value >= max} onClick={() => onChange(value + 10)}><Icon name="plus"/></button>
  </div></div>;
}

export function ReaderDisplaySettings({settings, setSettings, layout, direction, onLayout, onDirection, sizing, allowDouble = false}: {
  settings: Settings;
  setSettings(value: Settings | ((previous: Settings) => Settings)): void;
  layout?: Settings['layout'];
  direction: Settings['direction'];
  onLayout(layout: Settings['layout'] | undefined): void;
  onDirection(direction: Settings['direction']): void;
  sizing: ReactNode;
  allowDouble?: boolean;
}) {
  return <>
    {sizing && <div className="nc-reader-sizing">{sizing}</div>}
    <ReaderChoice<Settings['layout'] | 'default'> variant="cards" label={msg('阅读布局')} value={!allowDouble && layout === 'double' ? 'single' : layout ?? 'default'}
      options={[{id: 'default', label: msg('默认'), icon: <Icon name="settings"/>}, {id: 'continuous', label: msg('连续'), icon: <Icon name="list"/>}, {id: 'single', label: msg('单页'), icon: <Icon name="page-unread"/>},
        ...(allowDouble ? [{id: 'double' as const, label: msg('双页'), icon: <Icon name="book"/>}]: [])]} onChange={value => onLayout(value === 'default' ? undefined : value)}/>
    <p className="nc-muted">{msg('仅对此漫画生效；选择默认时跟随全局阅读布局。')}</p>
    <ReaderChoice label={msg('阅读方向')} value={direction}
      options={[{id: 'rtl', label: msg('从右向左'), icon: <Icon name="arrow" size={16} style={{transform: 'rotate(180deg)'}}/>}, {id: 'ltr', label: msg('从左向右'), icon: <Icon name="arrow" size={16}/>}]} onChange={onDirection}/>
    <ReaderChoice label={msg('阅读背景')} value={settings.readerBackground}
      options={[{id: 'gray', label: msg('浅灰')}, {id: 'paper', label: msg('纸白')}, {id: 'night', label: msg('夜色')}]} onChange={readerBackground => setSettings(value => ({...value, readerBackground}))}/>
  </>;
}
