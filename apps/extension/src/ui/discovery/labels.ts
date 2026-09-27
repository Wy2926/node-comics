import {msg, type MessageKey} from '../../i18n/runtime';
import type {DiscoveryFormat, DiscoveryRanking, PublicationStatus} from '../../discovery/types';

const genreMessages = {
  Action: '动作',
  Adventure: '冒险',
  Comedy: '喜剧',
  Drama: '剧情',
  Fantasy: '奇幻',
  Horror: '恐怖',
  'Mahou Shoujo': '魔法少女',
  Mecha: '机甲',
  Music: '音乐',
  Mystery: '悬疑',
  Psychological: '心理',
  Romance: '恋爱',
  'Sci-Fi': '科幻',
  'Slice of Life': '日常',
  Sports: '运动',
  Supernatural: '超自然',
  Thriller: '惊悚',
} as const satisfies Record<string, MessageKey>;

/** Localize known labels without treating arbitrary provider text as a message key. */
export function genreLabel(genre: string): string {
  return Object.hasOwn(genreMessages, genre) ? msg(genreMessages[genre as keyof typeof genreMessages]) : genre;
}

export const rankingLabels = (): Record<DiscoveryRanking, string> => ({
  trending: msg('趋势'), popular: msg('人气'), score: msg('高分'), newest: msg('新作'),
});
export const statusLabels = (): Record<PublicationStatus, string> => ({
  releasing: msg('连载中'), finished: msg('已完结'), upcoming: msg('未发行'), hiatus: msg('暂停连载'), cancelled: msg('已取消'),
});
export const formatLabels = (): Record<DiscoveryFormat, string> => ({manga: msg('漫画'), oneshot: msg('单篇')});
