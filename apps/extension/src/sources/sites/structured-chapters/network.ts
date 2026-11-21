import type {SourceNetwork} from '../../contracts/network';
import {safeImageUrl} from '../../shared/urls';
import {definition, matchLink} from './definition';
import {chapterList} from './chapter-list';
import {seriesList} from './series';
import {documentList,validImageList} from './document-list';
import {markup} from './catalog';
import {creatorPosts, postPages} from './kemono';
import {msg} from '../../../i18n/runtime';

export const network: SourceNetwork = {
  catalog(url, ctx) {
    const link=matchLink(new URL(url))!;
    if (link.layout==='series') return seriesList(link.location,ctx);
    if (link.layout==='list') return chapterList(link.location,ctx);
    if (link.layout==='kemono') return creatorPosts(link.location,ctx);
    return documentList(link,ctx);
  },
  async pages(url, ctx) {
    const link=matchLink(new URL(url))!, doc=markup(await ctx.request(url,{redirect:'error'}));
    if (link.layout==='kemono') return postPages(link.location,doc,ctx);
    const images = [...doc.querySelectorAll<HTMLImageElement>(link.selector)];
    const indexed=link.layout!=='series'&&link.layout!=='list';
    if (!images.length || images.length > 1500 || indexed&&!validImageList(link,doc,images))
      throw Error(msg('来源图片清单不可用。'));
    const items = images.map((image, order) => {
      const src = safeImageUrl(image.getAttribute('data-src') || image.getAttribute('src') || '', url);
      if (!src) throw Error(msg('来源图片清单包含无效地址。'));
      return {id:'page-' + (order + 1), order, width:Number(image.getAttribute('width')), height:Number(image.getAttribute('height')), resource:{kind:'http' as const, url:src}};
    });
    if (indexed && new Set(items.map(item=>item.resource.url)).size!==items.length) throw Error(msg('来源图片清单不可用。'));
    return {adapter:definition.id, url, title:doc.querySelector('h1')?.textContent?.trim() || new URL(url).pathname.split('/').pop()!,
      direction:'ltr', discoveryComplete:true, knownTotal:items.length, note:'', items};
  },
};
