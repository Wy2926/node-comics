import type {ReactNode} from 'react';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import {fallbackLanguages, type Capabilities, type Settings} from '../types';
import {LanguageFlag} from '../ui/LanguageFlag';
import {Select, SelectOption} from '../ui/Select';

export function ReaderTranslationSettings({settings, setSettings, caps, channelLabel, note}: {
  settings: Settings;
  setSettings(value: Settings | ((previous: Settings) => Settings)): void;
  caps?: Capabilities;
  channelLabel?: string;
  note: string;
}) {
  const languages = caps?.languages ?? fallbackLanguages;
  return <>
    {channelLabel && <p className="nc-muted">{channelLabel}</p>}
    {languages.length <= 4 ? <ReaderChoice label={msg('目标语言')} value={settings.language}
      options={languages.map(language => ({...language, icon: <LanguageFlag language={language.id}/>}))}
      onChange={language => setSettings(value => ({...value, language}))}/>
      : <label className="field">{msg('目标语言')}<Select aria-label={msg('翻译目标语言')} value={settings.language}
        onChange={event => setSettings(value => ({...value, language: event.target.value}))}>
        {languages.map(language => <SelectOption key={language.id} value={language.id} icon={<LanguageFlag language={language.id}/>}>{language.label}</SelectOption>)}
      </Select></label>}
    <p className="nc-muted nc-default-mode-note">{note}</p>
  </>;
}

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
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange(value: number): void;
}) {
  return <div className="nc-reader-option"><b>{label}</b><div className="nc-inline">
    <button className="icon-button" aria-label={msg('缩小')} disabled={disabled || value <= min} onClick={() => onChange(value - 10)}><Icon name="minus"/></button>
    <span>{value}%</span>
    <button className="icon-button" aria-label={msg('放大')} disabled={disabled || value >= max} onClick={() => onChange(value + 10)}><Icon name="plus"/></button>
  </div></div>;
}

/** Format-specific sizing and actions are slots, not a second settings implementation. */
export function ReaderSettings({settings, setSettings, onLayout, sizing, children, immersive, onImmersive, onFullscreen,
  onShortcuts, sourceUrl, onReload, busy, extraActions}: {
  settings: Settings;
  setSettings(value: Settings | ((previous: Settings) => Settings)): void;
  onLayout(layout: Settings['layout']): void;
  sizing: ReactNode;
  children?: ReactNode;
  immersive: boolean;
  onImmersive(): void;
  onFullscreen(): void;
  onShortcuts(): void;
  sourceUrl?: string;
  onReload?: () => void;
  busy?: boolean;
  extraActions?: ReactNode;
}) {
  return <>
    <ReaderChoice label={msg('阅读布局')} value={settings.layout}
      options={[{id: 'continuous', label: msg('连续阅读'), icon: <Icon name="list" size={16}/>}, {id: 'single', label: msg('单页阅读'), icon: <Icon name="page-unread" size={16}/>}]} onChange={onLayout}/>
    <ReaderChoice label={msg('阅读方向')} value={settings.direction}
      options={[{id: 'rtl', label: msg('从右向左'), icon: <Icon name="arrow" size={16} style={{transform: 'rotate(180deg)'}}/>}, {id: 'ltr', label: msg('从左向右'), icon: <Icon name="arrow" size={16}/>}]} onChange={direction => setSettings(value => ({...value, direction}))}/>
    {sizing}
    <ReaderChoice label={msg('阅读背景')} value={settings.readerBackground}
      options={[{id: 'gray', label: msg('浅灰')}, {id: 'paper', label: msg('纸白')}, {id: 'night', label: msg('夜色')}]} onChange={readerBackground => setSettings(value => ({...value, readerBackground}))}/>
    {children}
    <div className="nc-reader-option"><div><b>{msg('沉浸阅读')}</b><p>{msg('空闲时收起工具，轻点空白处唤回。')}</p></div>
      <button className={`switch ${immersive ? 'on' : ''}`} role="switch" aria-label={msg('沉浸阅读')} aria-checked={immersive} onClick={onImmersive}><i/></button>
    </div>
    <div className="nc-stack-actions">
      {extraActions}
      <button className="button secondary" onClick={onFullscreen}><Icon name="expand"/>{msg('全屏阅读')}</button>
      {onReload && <button className="button secondary" disabled={busy} onClick={onReload}><Icon name="refresh"/>{msg('重新载入')}</button>}
      {sourceUrl && <a className="button secondary" href={sourceUrl} target="_blank" rel="noreferrer">{msg('打开来源')}</a>}
      <button className="button secondary" onClick={onShortcuts}><Icon name="keyboard"/>{msg('键盘快捷键')}</button>
    </div>
  </>;
}
