import {describe, expect, it} from 'vitest';
import {validateSourceCatalog} from '../../../index';
import {discoverMangaCopyCatalog} from '../catalog';

type Category = {id:string; title:string; chapters:number[]; type?:string};
const url = 'https://www.copy4000.com/comic/sample';
const remoteId = (n:number) => `724f819b-5306-11ea-b7ea-${String(n).padStart(12, '0')}`;
function document(categories:Category[]):Document {
  const tables = categories.map(category => {
    const links = category.chapters.map(n => ({
      textContent:`条目 ${n}`,
      getAttribute:(name:string) => name === 'href' ? `/comic/sample/chapter/${remoteId(n)}` : null,
    }));
    const panels = ['全部', category.type ?? '話'].map(type => ({
      id:category.id + type, querySelectorAll:() => links,
    }));
    return {previousElementSibling:{textContent:category.title}, querySelectorAll:() => panels};
  });
  return {title:'Sample', querySelector:() => null, querySelectorAll:() => tables} as unknown as Document;
}
const discover = (categories:Category[]) => validateSourceCatalog(discoverMangaCopyCatalog(document(categories), url));

describe('MangaCopy source-defined categories', () => {
  it.each([
    [
      {id:'default', title:'默認', chapters:[1]},
      {id:'other_honyakuchimu', title:'其它汉化版', chapters:[2]},
      {id:'other_group', title:'其他系列', chapters:[3, 4]},
    ],
    [
      {id:'default', title:'默認', chapters:[1]},
      {id:'tankobon', title:'单行本', chapters:[2], type:'卷'},
      {id:'other_honyakuchimu', title:'其它汉化版', chapters:[3]},
      {id:'dojinshi', title:'同人漫画', chapters:[4, 5], type:'卷'},
    ],
  ])('keeps every source category as readable navigation (%j)', (...categories) => {
    const result = discover(categories);
    expect(result.complete).toBe(true);
    expect(result.groups.map(({id, title}) => ({id, title}))).toEqual(categories.map(({id, title}) => ({id, title})));
    expect(result.entries).toHaveLength(categories.flatMap(group => group.chapters).length);
    expect(result.entries.every(entry => !entry.related)).toBe(true);
    expect(result.defaultEntryId).toBe(result.entries[0].id);
    for (const group of result.groups) {
      const entries = result.entries.filter(entry => group.entryIds.includes(entry.id));
      expect(new Set(entries.map(entry => entry.sequenceId)).size).toBe(1);
      expect(entries[0].sequenceId?.startsWith(group.id + ':')).toBe(true);
    }
  });

  it('reads unknown IDs, renamed categories and arbitrary source tab labels without an allowlist', () => {
    const result = discover([
      {id:'custom_2026', title:'读者自定义 · 特别收录', chapters:[1], type:'彩色短篇'},
      {id:'default', title:'主目录（源站改名）', chapters:[2]},
    ]);
    expect(result.groups[0]).toMatchObject({id:'custom_2026', title:'读者自定义 · 特别收录', complete:true});
    expect(result.entries[0]).toMatchObject({related:false, rawTypes:['彩色短篇'], sequenceId:'custom_2026:彩色短篇'});
    expect(result.defaultEntryId).toBe(result.entries[1].id);
  });

  it('does not guess a default entry from a custom category title', () => {
    const result = discover([{id:'custom', title:'默认', chapters:[1, 2]}]);
    expect(result.defaultEntryId).toBeUndefined();
  });

  it('keeps repeated references as one entry without joining different reading sequences', () => {
    const result = discover([
      {id:'default', title:'默認', chapters:[1]},
      {id:'arbitrary', title:'同人精选', chapters:[1]},
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({groupIds:['default', 'arbitrary'], related:false});
    expect(result.entries[0].sequenceId).toBeUndefined();
  });

  it('waits for every dynamic category to finish loading', () => {
    const result = discover([
      {id:'default', title:'默認', chapters:[1]},
      {id:'new_group', title:'新增自定义分类', chapters:[]},
    ]);
    expect(result.complete).toBe(false);
    expect(result.groups[1].complete).toBe(false);
  });
});
