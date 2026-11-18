import type {ReactNode} from 'react';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import type {Settings} from '../types';
import {ScaleControl} from '../ui/ScaleControl';
import {ReaderProgress} from './ReaderProgress';

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

export function ReaderScale(props:Parameters<typeof ScaleControl>[0]) {
  return <div className="field"><span>{props.label}</span><ScaleControl {...props}/></div>;
}

export function ReaderGap({value, disabled, onChange}: {value: number; disabled?: boolean; onChange(value: number): void}) {
  const label = msg('双页间距');
  return <label className="field nc-reader-gap"><span>{label}</span><output>{value}%</output>
    <ReaderProgress label={label} value={value} min={0} max={100} disabled={disabled} percentage valueText={value => `${value}%`} onCommit={onChange}/>
  </label>;
}

export function ReaderDisplaySettings({settings, setSettings, layout, direction, onLayout, onDirection, sizing}: {
  settings: Settings;
  setSettings(value: Settings | ((previous: Settings) => Settings)): void;
  layout?: Settings['layout'];
  direction: Settings['direction'];
  onLayout(layout: Settings['layout'] | undefined): void;
  onDirection(direction: Settings['direction']): void;
  sizing: ReactNode;
}) {
  return <>
    <ReaderChoice<Settings['layout'] | 'default'> variant="cards" label={msg('阅读布局')} value={layout ?? 'default'}
      options={[{id: 'default', label: msg('默认'), icon: <Icon name="settings"/>}, {id: 'continuous', label: msg('连续'), icon: <Icon name="list"/>}, {id: 'single', label: msg('单页'), icon: <Icon name="page-unread"/>},
        {id: 'double', label: msg('双页'), icon: <Icon name="book"/>}]} onChange={value => onLayout(value === 'default' ? undefined : value)}/>
    <p className="nc-muted">{msg('仅对此漫画生效；选择默认时跟随全局阅读布局。')}</p>
    <ReaderChoice label={msg('阅读方向')} value={direction}
      options={[{id: 'rtl', label: msg('从右向左'), icon: <Icon name="arrow" size={16} style={{transform: 'rotate(180deg)'}}/>}, {id: 'ltr', label: msg('从左向右'), icon: <Icon name="arrow" size={16}/>}]} onChange={onDirection}/>
    {sizing}
    <ReaderChoice label={msg('阅读背景')} value={settings.readerBackground}
      options={[{id: 'gray', label: msg('浅灰')}, {id: 'paper', label: msg('纸白')}, {id: 'night', label: msg('夜色')}]} onChange={readerBackground => setSettings(value => ({...value, readerBackground}))}/>
  </>;
}
