import type {SourceNetwork} from '../../contracts/network';
import {origin} from './definition';
import {requireLocation, unavailable} from './html';

export const chapterComments: NonNullable<SourceNetwork['chapterComments']> = {
  headers: {'Service-Ticket-Id': 'epicom'},
  async read(url, cursor, get) {
    const {section, title, episode} = requireLocation(url);
    if (!episode) throw unavailable();
    const pageId = `${section === 'canvas' ? 'c' : 'w'}_${title}_${episode}`;
    const postId = new RegExp(`^GW-epicom:\\d+-${pageId}-[a-z0-9]+$`);
    const validId = (id: unknown): id is string => typeof id === 'string' && id.length <= 128 && postId.test(id);
    if (cursor !== undefined && !validId(cursor)) throw unavailable();
    const target = new URL('/p/api/community/v2/posts', origin);
    target.search = new URLSearchParams({pageId, pinRepresentation:'none', prevSize:'0', nextSize:'15', withCursor:'false', cursor:cursor ?? ''}).toString();
    const {status, result} = JSON.parse(await get(target.href));
    if (status !== 'success' || !Array.isArray(result?.posts) || result.posts.length > 15 || !result.pagination) throw unavailable();
    const next: unknown = result.pagination.next, ids = new Set<string>();
    if (next != null && (!validId(next) || next === cursor)) throw unavailable();
    const items = [];
    for (const post of result.posts) {
      if (post?.pageId !== pageId || !validId(post.id) || post.rootId !== post.id || ids.has(post.id)) throw unavailable();
      ids.add(post.id);
      // Deleted, moderated and media-only posts have no public text to show.
      if (post.status !== 'SERVICE' || post.bodyFormat?.type !== 'PLAIN' || !post.body) continue;
      if (typeof post.body !== 'string' || typeof post.createdBy?.name !== 'string' || !['ON','OFF'].includes(post.settings?.spoilerFilter)) throw unavailable();
      items.push({id:post.id, author:post.createdBy.name.slice(0, 120), body:post.body.trim().slice(0, 12_000),
        postedAt:Number.isSafeInteger(post.createdAt) && post.createdAt > 0 && post.createdAt <= 8.64e15 ? post.createdAt : undefined,
        spoiler:post.settings.spoilerFilter === 'ON'});
    }
    return {items, next:next ?? undefined};
  },
};
