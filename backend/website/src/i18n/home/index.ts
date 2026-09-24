import type { Locale } from '../types';
import type { HomeCopy } from './types';
import en from './en';
import zhCN from './zh-CN';
import zhTW from './zh-TW';
import ja from './ja';
import ko from './ko';

export type { HomeCopy } from './types';
export const homeCopy: Record<Locale, HomeCopy> = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko };
