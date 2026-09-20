import {Select} from './Select';
import {msg} from '../i18n/runtime';
import {useUiLocale} from '../i18n/react';
import {setUiLanguage} from '../i18n/load';
import {useEffect,type ReactNode} from 'react';
import type {Settings} from '../types';
import {Icon} from '../icons';
export function useAppearance(settings:Settings){
  useUiLocale();
  useEffect(()=>{const apply=()=>void setUiLanguage(settings.uiLanguage).catch(()=>{});apply();window.addEventListener('languagechange',apply);return()=>window.removeEventListener('languagechange',apply);},[settings.uiLanguage]);
  useEffect(()=>{const media=matchMedia('(prefers-color-scheme: dark)');const apply=()=>{document.documentElement.dataset.appearance=settings.appearance==='system'?(media.matches?'dark':'light'):settings.appearance;document.documentElement.dataset.accent=settings.accentTheme;document.documentElement.style.setProperty('--text-scale',String(settings.textScale));};apply();media.addEventListener('change',apply);return()=>media.removeEventListener('change',apply);},[settings.appearance,settings.accentTheme,settings.textScale]);
}
export function AppearanceSettings({settings,onChange,children}:{settings:Settings;onChange:(s:Settings)=>void;children?:ReactNode}){
  return <section className="settings-card"><h3><Icon name="sun"/>{msg("外观与主题")}</h3>{children}<div className="setting-row"><div><b>{msg("主题色")}</b><p>{msg("用于选中项、主操作和阅读进度。")}</p></div><div className="nc-theme-options">{([['sky',msg("晴空蓝")],['rose',msg("樱花粉")],['mint',msg("薄荷绿")],['iris',msg("鸢尾紫")]] as const).map(([value,label])=><button key={value} aria-pressed={settings.accentTheme===value} className={settings.accentTheme===value?'selected':''} onClick={()=>onChange({...settings,accentTheme:value})}><i data-color={value}/>{label}</button>)}</div></div><div className="setting-row"><div><b>{msg("亮暗外观")}</b><p>{msg("漫画保持原色，阅读背景可单独设置。")}</p></div><Select aria-label={msg("亮暗外观")} value={settings.appearance} onChange={e=>onChange({...settings,appearance:e.target.value as Settings['appearance']})}><option value="system">{msg("跟随系统")}</option><option value="light">{msg("浅色")}</option><option value="dark">{msg("深色")}</option></Select></div><div className="setting-row"><div><b>{msg("界面文字大小")}</b><p>{msg("标题、说明和按钮同步调整。")}</p></div><Select aria-label={msg("界面文字大小")} value={settings.textScale} onChange={e=>onChange({...settings,textScale:Number(e.target.value)})}><option value={1}>{msg("标准 · 16 px")}</option><option value={1.125}>{msg("大 · 18 px")}</option><option value={1.25}>{msg("更大 · 20 px")}</option></Select></div></section>;
}
