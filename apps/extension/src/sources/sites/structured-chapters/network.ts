import type {SourceNetwork} from '../../contracts/network';
import {safeImageUrl} from '../../shared/urls';
import {definition, identify} from './definition';
import {chapterList} from './chapter-list';
import {seriesList} from './series';
import {markup} from './catalog';
import {msg} from '../../../i18n/runtime';

export const network: SourceNetwork = {
  catalog(url, ctx) {
    const work = identify(new URL(url))!;
    return new URL(url).pathname.startsWith('/series/') ? seriesList(work, ctx) : chapterList(work, ctx);
  },
  async pages(url, ctx) {
    const chapter = identify(new URL(url))!, doc = markup(await ctx.request(url,{redirect:'error'}));
    const images = [...doc.querySelectorAll<HTMLImageElement>(definition.linkMatch(chapter))];
    if (!images.length || images.length > 1500) throw Error(msg('来源图片清单不可用。'));
    const items = images.map((image, order) => {
      const src = safeImageUrl(image.getAttribute('data-src') || image.getAttribute('src') || '', url);
      if (!src) throw Error(msg('来源图片清单包含无效地址。'));
      return {id:'page-' + (order + 1), order, width:Number(image.getAttribute('width')), height:Number(image.getAttribute('height')), resource:{kind:'http' as const, url:src}};
    });
    return {adapter:definition.id, url, title:doc.querySelector('h1')?.textContent?.trim() || new URL(url).pathname.split('/').pop()!,
      direction:'ltr', discoveryComplete:true, knownTotal:items.length, note:'', items};
  },
};
