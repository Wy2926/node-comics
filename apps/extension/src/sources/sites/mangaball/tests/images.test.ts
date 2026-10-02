import {describe, expect, it} from 'vitest';
import {imageUrl} from '../protocol';
import {parsePages} from '../network';
import {chapterUrl} from '../definition';

const titleId = '68515613702284f834178653', chapterId = '685341f06c8186610a00b5c0';
const base = `https://bulbasaur.poke-black-and-white.net/storage/${titleId}/0/1.1/mangadex/en/`;
const pages = Array.from({length: 10}, (_, index) => base + String(index + 1).padStart(3, '0') + '.webp');
const response = () => ({status: 'success', code: 200, data: {
  chapter: {id: chapterId, title_id: titleId, chapter_number: 1.1, number: 1.1, name: 'Return of the Prince', lang: 'en', pages},
  title: {id: titleId, name: 'Fights Break Sphere – Return of the Beasts'},
}});

describe('MangaBall migrated ordinal image filenames', () => {
  it('accepts the reported decimal chapter with ten ordered ordinal pages', () => {
    const manifest = parsePages(response(), chapterUrl(chapterId, titleId));
    expect(manifest).toMatchObject({knownTotal: 10, discoveryComplete: true});
    expect(manifest.items.map(item => item.resource)).toEqual(pages.map(url => ({kind: 'http', url})));
    expect(imageUrl(pages[0])).toBe(pages[0]);
  });
  it('accepts API addresses without inferring a chapter from the server or storage path', () => {
    const urls=['https://new-images.example.test/raw/signed-picture?expires=100',
      'http://images.example.test:8080/comic/one.png#view',pages[0].replace('/1.1/','/1.2/'),
      pages[0].replace('/001.webp','/different-filename.png')];
    const value=response();value.data.chapter.pages=urls;
    expect(parsePages(value,chapterUrl(chapterId)).items.map(item=>item.resource)).toEqual(urls.map(url=>({kind:'http',url})));
    const foreign = response(); foreign.data.chapter.id = titleId;
    expect(() => parsePages(foreign, chapterUrl(chapterId))).toThrow('不属于');
  });
  it('uses the existing public image URL rules for non-HTTP or embedded credential addresses', () => {
    for(const url of ['javascript:alert(1)','data:image/png;base64,AA','ftp://images.example.test/page.png','https://user:pass@images.example.test/page.png'])
      expect(()=>imageUrl(url)).toThrow('图片地址无效');
  });
});
