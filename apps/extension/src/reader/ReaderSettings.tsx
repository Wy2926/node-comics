import type {ReactNode} from 'react';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import {fallbackLanguages, type Capabilities, type Settings} from '../types';
import {LanguageFlag} from '../ui/LanguageFlag';
import {Select, SelectOption} from '../ui/Select';
import {TranslationModelPicker} from '../ui/TranslationModelPicker';
import {TranslationFontPicker} from '../ui/TranslationFontPicker';
import type {ModelSelection,FontSelection} from '../translation/channels/contracts';
import {EnhancementToggle} from '../ui/EnhancementSettings';
import {ReaderDisplaySettings} from './ReaderOptions';
export {ReaderChoice, ReaderScale} from './ReaderOptions';

export function ReaderTranslationSettings({settings, setSettings, caps, channelLabel, modelSelection, fontSelection, note}: {
  settings: Settings;
  setSettings(value: Settings | ((previous: Settings) => Settings)): void;
  caps?: Capabilities;
  channelLabel?: string;
  modelSelection?: ModelSelection;
  fontSelection?: FontSelection;
  note: string;
}) {
  const languages = caps?.languages ?? fallbackLanguages;
  return <>
    {channelLabel && <p className="nc-muted">{channelLabel}</p>}
    <label className="field">{msg('目标语言')}<Select aria-label={msg('翻译目标语言')} value={settings.language}
        onChange={event => setSettings(value => ({...value, language: event.target.value}))}>
        {languages.map(language => <SelectOption key={language.id} value={language.id} icon={<LanguageFlag language={language.id}/>}>{language.label}</SelectOption>)}
      </Select></label>
    <TranslationModelPicker selection={modelSelection}/>
    <TranslationFontPicker selection={fontSelection} language={settings.language}/>
    <p className="nc-muted nc-default-mode-note">{note}</p>
  </>;
}

/** Format-specific sizing and actions are slots, not a second settings implementation. */
export function ReaderSettings({settings, setSettings, layout, direction, onLayout, onDirection, sizing, animation, children, immersive, onImmersive, onFullscreen,
  onShortcuts, onReload, busy, extraActions, allowDouble = false}: {
  settings: Settings;
  setSettings(value: Settings | ((previous: Settings) => Settings)): void;
  layout?: Settings['layout'];
  direction: Settings['direction'];
  onLayout(layout: Settings['layout'] | undefined): void;
  onDirection(direction: Settings['direction']): void;
  sizing: ReactNode;
  animation?: ReactNode;
  children?: ReactNode;
  immersive: boolean;
  onImmersive(): void;
  onFullscreen(): void;
  onShortcuts(): void;
  onReload?: () => void;
  busy?: boolean;
  extraActions?: ReactNode;
  allowDouble?: boolean;
}) {
  return <>
    <ReaderDisplaySettings settings={settings} setSettings={setSettings} layout={layout} direction={direction} onLayout={onLayout} onDirection={onDirection} sizing={sizing} allowDouble={allowDouble}/>
    {animation}
    <div className="nc-reader-option"><div><b>{msg('沉浸阅读')}</b><p>{msg('空闲时收起工具，轻点空白处唤回。')}</p></div>
      <button className={`switch ${immersive ? 'on' : ''}`} role="switch" aria-label={msg('沉浸阅读')} aria-checked={immersive} onClick={onImmersive}><i/></button>
    </div>
    <div className="nc-reader-actions nc-reader-primary-actions">
      <button className="button secondary" onClick={onFullscreen}><Icon name="expand"/><span>{msg('全屏阅读')}</span></button>
    </div>
    <details className="nc-detail-more nc-reader-more">
      <summary data-shortcuts-ignore>{msg('更多操作 · {0}', {'0': msg('阅读器')})}</summary>
      {children}
      <EnhancementToggle configure/>
      <div className="nc-reader-actions">
        {extraActions}
        {onReload && <button className="button secondary" disabled={busy} onClick={onReload}><Icon name="refresh"/><span>{msg('重新载入')}</span></button>}
        <button className="button secondary" onClick={onShortcuts}><Icon name="keyboard"/><span>{msg('键盘快捷键')}</span></button>
      </div>
    </details>
  </>;
}
