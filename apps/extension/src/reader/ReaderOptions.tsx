import type {ReactNode} from 'react';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import type {Settings} from '../types';

/** Shared display controls for image and EPUB readers. */
export function ReaderChoice<T extends string>({label, value, options, onChange}: {
  label: string;
  value: T;
  options: readonly {id: T; label: string; icon?: ReactNode}[];
  onChange(value: T): void;
}) {
  return <div className="field"><span>{label}</span><div className="segmented nc-reader-choices" role="group" aria-label={label}>
    {options.map(option => <button key={option.id} className={value === option.id ? 'active' : ''} aria-pressed={value === option.id}
      onClick={() => onChange(option.id)}>{option.icon}{option.label}</button>)}
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

export function ReaderDisplaySettings({settings, setSettings, onLayout, sizing, children}: {
  settings: Settings;
  setSettings(value: Settings | ((previous: Settings) => Settings)): void;
  onLayout(layout: Settings['layout']): void;
  sizing: ReactNode;
  children?: ReactNode;
}) {
  return <>
    <ReaderChoice label={msg('阅读布局')} value={settings.layout}
      options={[{id: 'continuous', label: msg('连续阅读'), icon: <Icon name="list" size={16}/>}, {id: 'single', label: msg('单页阅读'), icon: <Icon name="page-unread" size={16}/> }]} onChange={onLayout}/>
    <ReaderChoice label={msg('阅读方向')} value={settings.direction}
      options={[{id: 'rtl', label: msg('从右向左'), icon: <Icon name="arrow" size={16} style={{transform: 'rotate(180deg)'}}/>}, {id: 'ltr', label: msg('从左向右'), icon: <Icon name="arrow" size={16}/>}]} onChange={direction => setSettings(value => ({...value, direction}))}/>
    {sizing}
    <ReaderChoice label={msg('阅读背景')} value={settings.readerBackground}
      options={[{id: 'gray', label: msg('浅灰')}, {id: 'paper', label: msg('纸白')}, {id: 'night', label: msg('夜色')}]} onChange={readerBackground => setSettings(value => ({...value, readerBackground}))}/>
    {children}
  </>;
}
