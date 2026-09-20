import {Select} from './Select';
import {msg} from '../i18n/runtime';
import { type Dispatch, type SetStateAction } from 'react';
import { type Capabilities, type Settings } from '../types';
import {InterfaceLanguage} from './InterfaceLanguage';
import {AutoTranslateTabs} from './AutoTranslateTabs';
import {TargetLanguage,withTargetLanguage} from './TargetLanguage';
import { Icon } from '../icons';
import { AppearanceSettings } from './Appearance';
import { PageTitle, SettingRow } from './components';
type Props = {
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  caps?: Capabilities;
  cacheBytes: number;
  notify: (message: string) => void;
  onClearCache: () => void;
};
export function Preferences({ settings, setSettings, caps, cacheBytes, onClearCache }: Props) {
  return <div className="nc-preferences">
    <PageTitle eyebrow={msg("MAKE IT YOURS")} title={msg("外观与偏好")} description={msg("调成你喜欢的阅读节奏，偏好保存在本机。")} />
    <AppearanceSettings settings={settings} onChange={setSettings}>
      <InterfaceLanguage value={settings.uiLanguage} onChange={uiLanguage=>setSettings(s=>({...s,uiLanguage}))}/>
    </AppearanceSettings>
    <section className="settings-card">
      <h3>
        <Icon name="book" />{msg("阅读偏好")}</h3>
      <SettingRow title={msg("默认目标语言")} description={msg("常规翻译支持 16 个语言选项；新增语言会采用常规翻译，已有译图版本保留。")}>
        <TargetLanguage value={settings.language} caps={caps} onChange={language=>setSettings(s=>withTargetLanguage(s,language,caps))}/>
      </SettingRow>
      <AutoTranslateTabs enabled={settings.autoTranslateTabs} onSaved={setSettings}/>
      <SettingRow title={msg("翻页方向")} description={msg("单页模式中的方向键遵循此设置。")}>
        <Select aria-label={msg("翻页方向")} value={settings.direction} onChange={e => setSettings(s => ({ ...s, direction: e.target.value as Settings['direction'] }))}>
          <option value="rtl">{msg("从右向左 · 日漫习惯")}</option>
          <option value="ltr">{msg("从左向右")}</option>
        </Select>
      </SettingRow>
      <SettingRow title={msg("阅读方式")} description={msg("连续阅读仅解码当前页附近的有限图片窗口。")}>
        <Select aria-label={msg("阅读方式")} value={settings.layout} onChange={e => setSettings(s => ({ ...s, layout: e.target.value as Settings['layout'] }))}>
          <option value="continuous">{msg("连续纵向滚动")}</option>
          <option value="single">{msg("单页翻页")}</option>
        </Select>
      </SettingRow>

    </section>
    <section className="settings-card">
      <h3>
        <Icon name="storage" />{msg("图片与隐私")}</h3>
      <SettingRow title={msg("本地图片缓存")} description={msg("当前约 {0} MB。无限制仍受设备空间和浏览器存储配额限制；登录后只发送文件标识查找已有翻译；开始翻译时才上传缺失的选定原图。", {"0": (cacheBytes / 1024 / 1024).toFixed(1)})}>
        <Select aria-label={msg("本地图片缓存")} value={settings.cacheLimitMb} onChange={e => setSettings(s => ({ ...s, cacheLimitMb: Number(e.target.value) }))}>
          <option value="128">128 MB</option>
          <option value="512">512 MB</option>
          <option value="1024">1 GB</option>
          <option value="10240">{msg("10 GB（默认）")}</option>
          <option value="-1">{msg("无限制")}</option>
        </Select>
      </SettingRow>
      <SettingRow title={msg("清理本地译图")} description={msg("保留原图、书架与阅读位置；译图需要时重新下载。")}>
        <button className="button danger small" onClick={onClearCache}>{msg("清理译图缓存")}</button>
      </SettingRow>
      <div className="privacy-note">
        <Icon name="shield" />
        <p>{msg("原图与译图保存在私有对象存储；{0}。图片归你的账户私有，不接收源网站 Cookie，也不会公开分享；用户主动删除或未来清理策略仍可能使资源不可用。", {"0": caps?.retention_days?msg("当前服务设置 {0} 天保留期", {"0": caps.retention_days}):msg("当前长期保留，未设自动清理")})}</p>
      </div>
    </section>
  </div>;
}
