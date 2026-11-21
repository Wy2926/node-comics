import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {validateSourceCatalog} from '../../../index';
import {definition} from '../definition';
import {image} from '../image';
import {network} from '../network';

const path = '/patreon/user/42', host = 'https://archive.example.test', work = host + path, reader = work + '/post/9';
const hash = 'ab'.repeat(32), file = {name:'page.jpg',path:`/1ab/ab/${hash}.jpg`};
const row = (id:number) => ({id:String(id),title:`Post ${id}`,service:'patreon',user:'42',file,attachments:[]});
const profile = {id:'42',service:'patreon',name:'Artist'};
beforeEach(() => vi.stubGlobal('document',parseHTML('<html></html>').document));
afterEach(() => vi.unstubAllGlobals());

it('imports the v1 creator directory across origins, without fetching individual posts or images', async () => {
  for (const origin of [host,'https://second.example.test']) {
    const base = origin + '/api/v1' + path;
    const request = vi.fn(async (url:string) => JSON.stringify(url === base + '/profile' ? profile : url === base + '/posts' ?
      Array.from({length:50},(_,i)=>row(51-i)) : url === base + '/posts?o=50' ? [{...row(1), file:{}, attachments:[{name:'clip.mp4',path:'/clip.mp4'}]}] : null));
    const book = validateSourceCatalog(await network.catalog!(origin + path + '?o=50',{request}));
    expect(book.url).toBe(origin + path);
    expect(book.entries.map(e=>e.remoteId)).toEqual(Array.from({length:51},(_,i)=>String(i+1)));
    expect(book.entries[0].readable).toBe(false);
    expect(book.defaultEntryId).toBe(book.entries[1].id);
    expect(book.id).toBe(definition.identify(new URL(book.entries[1].url))?.catalog?.key);
    expect(request).toHaveBeenCalledTimes(3);
  }
  expect(definition.identify(new URL(work+'?tag=filtered'))).toBeNull();
  expect(definition.identify(new URL(work))?.pageKey).not.toBe(definition.identify(new URL('https://second.example.test'+path))?.pageKey);
});

it('does not publish a repeated, failed, foreign or cancelled directory page', async () => {
  const batch = Array.from({length:50},(_,i)=>row(i+1));
  for (const last of [batch,[{...row(51),user:'99'}],{error:'unavailable'}]) {
    const request = vi.fn().mockResolvedValueOnce(JSON.stringify(profile)).mockResolvedValueOnce(JSON.stringify(batch)).mockResolvedValueOnce(JSON.stringify(last));
    await expect(network.catalog!(work,{request})).rejects.toThrow();
  }
  const controller = new AbortController();
  const request = vi.fn(async () => {controller.abort(); return JSON.stringify(profile);});
  await expect(network.catalog!(work,{request,signal:controller.signal})).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});

it('uses the older v1 list route only when the first posts endpoint is missing', async () => {
  const base = host + '/api/v1' + path;
  const missing = Object.assign(Error('not found'),{kind:'http',details:{status:404}});
  const request = vi.fn(async (url:string) => {
    if (url === base + '/profile') return JSON.stringify(profile);
    if (url === base + '/posts') throw missing;
    if (url === base) return JSON.stringify(Array.from({length:50},(_,i)=>row(i+1)));
    if (url === base + '?o=50') return '[]';
    throw Error('unexpected request');
  });
  expect((await network.catalog!(work,{request})).entries).toHaveLength(50);
  const denied = vi.fn().mockResolvedValueOnce(JSON.stringify(profile)).mockRejectedValueOnce(Object.assign(Error('denied'),{kind:'http',details:{status:403}}));
  await expect(network.catalog!(work,{request:denied})).rejects.toThrow('denied');
  expect(denied).toHaveBeenCalledTimes(2);
});

it('reads unlinked gallery previews and linked originals as published, without persisting signed URLs', async () => {
  const shown = `https://images.archive.example.test/thumbnail/data/ab/ab/${hash}.jpg`;
  const full = 'https://files.archive.example.test/f/example/page.png?signature=fixture';
  const box = (body:string) => `<div class="post__thumbnail"><figure>${body}</figure></div>`;
  const doc = `\n<!DOCTYPE html>\n<html><head><link rel="canonical" href="${reader}"></head><body><section class="site-section--post" data-id="9" data-user="42" data-service="patreon">
    <h1 class="post__title">Gallery</h1><img src="/avatar.jpg"><div class="post__files">
    ${box(`<img src="/loading.gif" data-src="${shown}">`)}${box(`<a class="fileThumb" href="${full}"><img src="${shown.replace(hash,'cd'.repeat(32))}"></a>`)}
    ${box(`<img src="${shown}">`)}</div></section></body></html>`;
  const request = vi.fn(async () => doc);
  const snapshot = await network.pages!(reader,{request});
  expect(request).toHaveBeenCalledTimes(1);
  expect(snapshot.items.map(p=>p.resource)).toEqual([{kind:'http',url:shown},{kind:'http',url:full}]);
  expect(snapshot).toMatchObject({knownTotal:2,discoveryComplete:true,note:expect.stringContaining('预览图')});
  const bound = image.bindPages!(snapshot);
  expect(JSON.stringify(bound)).not.toContain('signature');
  for (const [index,item] of bound.items.entries()) {
    expect(item.resource.kind==='http' && image.resolvePage!(item.resource.url).url).toBe([shown,full][index]);
  }
  for (const html of [doc.replace('data-user="42"','data-user="43"'), doc.replace('files.archive.example.test','unrelated.example.test')])
    await expect(network.pages!(reader,{request:async()=>html})).rejects.toThrow();
});

it('reads the v1 post on API-rendered instances and checks ownership and media origins', async () => {
  const get = (post:unknown) => vi.fn(async (url:string) => url===reader ? '<main id="app"></main>' :
    url===host+'/api/v1'+path+'/post/9' ? JSON.stringify({post}) : '');
  const snapshot = await network.pages!(reader,{request:get(row(9))});
  expect(snapshot.items.map(p=>p.resource)).toEqual([{kind:'http',url:host+'/data'+file.path}]);
  for (const post of [row(10),{...row(9),has_full:false},{...row(9),file:{...file,server:'https://unrelated.example.test'}}])
    await expect(network.pages!(reader,{request:get(post)})).rejects.toThrow();
});
