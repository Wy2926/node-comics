import zhCN from './zh-CN';
import zhTW from './zh-TW';
import en from './en';
import ja from './ja';
import ko from './ko';
import type { Locale, Dictionary } from './types';
export type { Locale } from './types';
export const locales: Locale[] = ['zh-CN','zh-TW','en','ja','ko'];
export const prefixes: Record<Locale,string> = { 'zh-CN':'','zh-TW':'zh-tw',en:'en',ja:'ja',ko:'ko' };
export const languageNames: Record<Locale,string> = { 'zh-CN':'简体中文','zh-TW':'繁體中文',en:'English',ja:'日本語',ko:'한국어' };
export const dictionaries: Record<Locale,Dictionary> = { 'zh-CN':zhCN,'zh-TW':zhTW,en,ja,ko };
export function localeFromPath(path:string):Locale { return locales.find(locale => prefixes[locale] && path.split('/')[1] === prefixes[locale]) ?? 'zh-CN'; }
export function basePath(path:string) { const locale=localeFromPath(path); return prefixes[locale] ? path.replace(new RegExp(`^/${prefixes[locale]}(?=/|$)`),'') || '/' : path; }
export function localPath(path:string,locale:Locale) { return `${prefixes[locale] ? '/' + prefixes[locale] : ''}${basePath(path)}`; }
export const publicPaths=['/','/features/','/pricing/','/download/','/guides/','/faq/','/help/','/about/','/changelog/','/privacy/','/terms/','/refund/',...zhCN.documents.guides.map(guide=>`/guides/${guide.slug}/`)];
