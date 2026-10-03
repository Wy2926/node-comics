import type { Locale } from './types';
export type { Locale } from './types';
export const locales: Locale[] = ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "es", "pt-BR", "de", "it", "ru", "pl", "uk", "tr", "vi", "id"];
export const prefixes: Record<Locale,string> = {"zh-CN": "", "zh-TW": "zh-tw", "en": "en", "ja": "ja", "ko": "ko", "fr": "fr", "es": "es", "pt-BR": "pt-br", "de": "de", "it": "it", "ru": "ru", "pl": "pl", "uk": "uk", "tr": "tr", "vi": "vi", "id": "id"};
export const languageNames: Record<Locale,string> = {"zh-CN": "简体中文", "zh-TW": "繁體中文", "en": "English", "ja": "日本語", "ko": "한국어", "fr": "Français", "es": "Español", "pt-BR": "Português (Brasil)", "de": "Deutsch", "it": "Italiano", "ru": "Русский", "pl": "Polski", "uk": "Українська", "tr": "Türkçe", "vi": "Tiếng Việt", "id": "Bahasa Indonesia"};
export function localeFromPath(path:string):Locale { return locales.find(locale => prefixes[locale] && path.split('/')[1] === prefixes[locale]) ?? 'zh-CN'; }
export function basePath(path:string) { const locale=localeFromPath(path); return prefixes[locale] ? path.replace(new RegExp(`^/${prefixes[locale]}(?=/|$)`),'') || '/' : path; }
export function localPath(path:string,locale:Locale) { return `${prefixes[locale] ? '/' + prefixes[locale] : ''}${basePath(path)}`; }
