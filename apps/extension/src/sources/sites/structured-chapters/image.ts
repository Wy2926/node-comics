import type {SourceImageAdapter} from '../../contracts/image';
import {msg} from '../../../i18n/runtime';

const chapters = new Map<string, Map<string,string>>();
export const image: SourceImageAdapter = {
  bindPages(snapshot) {
    const assets = new Map<string,string>();
    const items = snapshot.items.map(item => {
      if (item.resource.kind !== 'http') throw Error(msg('来源图片清单不可用。'));
      const locator = snapshot.url + '#' + item.id;
      assets.set(locator, item.resource.url);
      return {...item, contentKey:item.id, resource:{kind:'http' as const, url:locator}};
    });
    chapters.delete(snapshot.url);
    if (chapters.size >= 6) chapters.delete(chapters.keys().next().value!);
    chapters.set(snapshot.url, assets);
    return {...snapshot, items};
  },
  resolvePage(locator) {
    const url = chapters.get(locator.split('#')[0])?.get(locator);
    if (!url) throw Error(msg('图片来源已变化，请重新发现。'));
    return {url, headers:{}};
  },
};
