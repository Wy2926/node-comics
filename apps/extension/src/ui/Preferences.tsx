import {ChannelOptionsPanel} from './ChannelOptions';
import {Select} from './Select';
import {msg} from '../i18n/runtime';
import { type Dispatch, type SetStateAction, type ReactNode } from 'react';
import { type Capabilities, type Settings } from '../types';
import {InterfaceLanguage} from './InterfaceLanguage';
import {AutoTranslateSites} from './AutoTranslateSites';
import {TargetLanguage} from './TargetLanguage';
import { Icon } from '../icons';
import { AppearanceSettings } from './Appearance';
import { SettingRow } from './components';
import {TranslationChannels} from './TranslationChannels';
import {EnhancementSettings} from './EnhancementSettings';
import {normalizeReaderZoom} from '../reader/view';
import {ScaleControl} from './ScaleControl';
import {AnalyticsConsent} from '../analytics/AnalyticsConsent';
import {TranslationModelPicker} from './TranslationModelPicker';
import {TranslationFontPicker} from './TranslationFontPicker';
import type {ModelSelection,FontSelection} from '../translation/channels/contracts';
type Props = {
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  caps?: Capabilities;
  modelSelection?: ModelSelection;
  fontSelection?: FontSelection;
  channelOptions?: import('../translation/channels/contracts').ChannelOptions;
  children?: ReactNode;
  onOpenShortcuts?: () => void;
  onAutomaticTranslationSaved?: (settings:Settings) => void;
};
export function Preferences({ settings, setSettings, caps, modelSelection, fontSelection, channelOptions, children, onOpenShortcuts, onAutomaticTranslationSaved }: Props) {
  return <div className="nc-preferences" role="region" aria-label={msg('外观与偏好')}>
    <AppearanceSettings settings={settings} onChange={setSettings}>
      <InterfaceLanguage value={settings.uiLanguage} onChange={uiLanguage=>setSettings(s=>({...s,uiLanguage}))}/>
    </AppearanceSettings>
    <section className="settings-card">
      <h3>
        <Icon name="book" />{msg("阅读偏好")}</h3>
      <SettingRow title={msg("默认阅读布局")} description={msg("未单独设置布局的漫画使用此默认值。")}>
        <Select aria-label={msg("默认阅读布局")} value={settings.layout} onChange={e => {const layout=e.target.value as Settings['layout'];setSettings(s => ({...s,layout}));}}>
          <option value="continuous">{msg("连续")}</option>
          <option value="single">{msg("单页")}</option>
          <option value="double">{msg("双页")}</option>
        </Select>
      </SettingRow>
      <SettingRow title={msg('默认缩放')} description={msg('仅在首次阅读漫画时使用，已读漫画保留各自的缩放比例。')}>
        <ScaleControl label={msg('默认缩放')} value={normalizeReaderZoom(settings.readerZoom)} min={40} max={200} onChange={readerZoom=>setSettings(s=>({...s,readerZoom}))}/>
      </SettingRow>
      <SettingRow title={msg('翻页方向')} description={msg('翻页模式中的方向键遵循此设置。')}>
        <Select aria-label={msg('翻页方向')} value={settings.direction} onChange={e=>setSettings(s=>({...s,direction:e.target.value as Settings['direction']}))}>
          <option value="rtl">{msg('从右向左 · 日漫习惯')}</option><option value="ltr">{msg('从左向右')}</option>
        </Select>
      </SettingRow>
    </section>
    <TranslationChannels>
      <SettingRow title={msg('默认目标语言')} description={msg('可选语言由翻译渠道提供，已有译图版本保留。')}>
        <TargetLanguage value={settings.language} caps={caps} onChange={language=>setSettings(s=>({...s,language}))}/>
      </SettingRow>
      <TranslationModelPicker selection={modelSelection}/>
      <TranslationFontPicker selection={fontSelection} language={settings.language}/>
    <ChannelOptionsPanel options={channelOptions} language={settings.language}/>
      <div className="setting-row">
        <div><b>{msg('翻译书名与简介')}</b></div>
        <button type="button" className={'switch '+(settings.discoveryTextTranslation?'on':'')}
          role="switch" aria-label={msg('翻译书名与简介')} aria-checked={settings.discoveryTextTranslation}
          onClick={()=>setSettings(s=>({...s,discoveryTextTranslation:!s.discoveryTextTranslation}))}><i/></button>
      </div>
    </TranslationChannels>
    <AutoTranslateSites preferences={settings} onSaved={onAutomaticTranslationSaved??setSettings}/>
    <EnhancementSettings/>
    {onOpenShortcuts && <section className="settings-card">
      <h3><Icon name="keyboard"/>{msg('键盘快捷键')}</h3>
      <SettingRow title={msg('自定义快捷键')} description={msg('页面内快捷键保存在本机，按键盘位置识别；输入文字时不会触发。浏览器快捷键单独管理。')}>
        <button type="button" className="button secondary" aria-haspopup="dialog" onClick={onOpenShortcuts}><Icon name="keyboard"/>{msg('自定义快捷键')}</button>
      </SettingRow>
    </section>}
    <section className="settings-card">
      <h3>
        <Icon name="storage" />{msg("图片与隐私")}</h3>
      <SettingRow title={msg('译图缓存预算')} description={msg('仅限制本机译图。完整源文件、网站下载资料和原图缓存各自管理。')}>
        <Select value={settings.cacheLimitMb} onChange={e=>setSettings(s=>({...s,cacheLimitMb:Number(e.target.value)}))}>
          <option value="0">{msg('不保存译图缓存')}</option><option value="128">128 MB</option><option value="512">512 MB</option><option value="1024">{msg('1 GB（默认）')}</option><option value="10240">10 GB</option><option value="-1">{msg('受设备容量限制')}</option>
        </Select>
      </SettingRow>
      <div className="privacy-note">
        <Icon name="shield" />
        <p>{msg('图片仅发送至所选翻译或增强渠道；译图缓存保存在本机。本地服务的译图缓存清理后需要重新翻译。')}</p>
      </div>
      <AnalyticsConsent/>
    </section>
    {children}
  </div>;
}
