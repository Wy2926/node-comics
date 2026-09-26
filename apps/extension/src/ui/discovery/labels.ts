import {msg} from '../../i18n/runtime';
import type {DiscoveryFormat, DiscoveryRanking, PublicationStatus} from '../../discovery/types';

export const rankingLabels = (): Record<DiscoveryRanking, string> => ({
  trending: msg('趋势'), popular: msg('人气'), score: msg('高分'), newest: msg('新作'),
});
export const statusLabels = (): Record<PublicationStatus, string> => ({
  releasing: msg('连载中'), finished: msg('已完结'), upcoming: msg('未发行'), hiatus: msg('暂停连载'), cancelled: msg('已取消'),
});
export const formatLabels = (): Record<DiscoveryFormat, string> => ({manga: msg('漫画'), oneshot: msg('单篇')});
