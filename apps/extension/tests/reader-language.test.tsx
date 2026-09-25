import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ComicDirectory,contentLanguageLabel,matchesDirectoryChapter} from '../src/reader/ComicDirectory';
import type {DirectoryEntry,ReadingDirectory} from '../src/comics/application/library-service';

const noop=()=>{};
const release=(id:string,language:string,current=false):DirectoryEntry=>({id,title:id,tags:[id+' team'],current,read:false,readable:true,status:'ready',contentLanguage:language});
const directory:ReadingDirectory={title:'Multilingual book',comicId:'comic',sourceUrl:'https://fixture.invalid/book',entries:[release('English 1 A','en',true),release('French 1 B','fr'),release('English 2','en')],chapters:[{id:'one',title:'Chapter 1',entryIds:['English 1 A','French 1 B'],selectedEntryId:'English 1 A',groupIds:['volume'],current:true,readable:true},{id:'two',title:'Chapter 2',entryIds:['English 2'],selectedEntryId:'English 2',groupIds:['volume'],current:false,readable:true}],groups:[{id:'volume',title:'Volume',entryIds:['English 1 A','French 1 B','English 2']}]};
const markup=(value:ReadingDirectory,pageCount=3)=>renderToStaticMarkup(<ComicDirectory directory={value} index={0} pageCount={pageCount} onNavigate={noop}/>);

describe('chapter-first directory',()=>{
 it('shows each chapter once and reveals language and group choices for the current chapter',()=>{
  const html=markup(directory);
  expect(html.match(/data-chapter-main="true"/g)).toHaveLength(2);
  expect(html.match(/data-release-choice="true"/g)).toHaveLength(2);
  expect(html).toContain('English 1 A team');expect(html).toContain('French 1 B team');
  expect(html.match(/<summary>(.*?)<\/summary>/)?.[1].replace(/<[^>]*>/g,'')).toBe('Volume2');
  expect(html).not.toContain('内容语言');expect(html).not.toContain('data-reading-boundary');
  expect(html.match(/aria-current="true"/g)).toHaveLength(1);expect(html).toContain('aria-pressed="true"');
  expect(html).not.toContain('ready');expect(html.match(/未读/g)).toHaveLength(1);
 });
 it('provides a separate expand control only when a chapter has multiple releases',()=>{
  const html=markup(directory);expect(html.match(/nc-chapter-expand/g)).toHaveLength(1);expect(html).toContain('aria-label="收起章节选项"');
  const closed=markup({...directory,entries:directory.entries.map(entry=>({...entry,current:false})),chapters:directory.chapters.map(chapter=>({...chapter,current:false}))});
  expect(closed).toContain('aria-label="展开章节选项"');expect(closed).not.toContain('data-release-choice="true"');
 });
 it('keeps a single chapter with multiple languages in the chapter view',()=>{
  const html=markup({...directory,entries:directory.entries.slice(0,2),chapters:directory.chapters.slice(0,1)});
  expect(html).toContain('data-reading-slot="one"');expect(html).toContain('data-release-choice="true"');
 });
 it('searches alternate titles and translator groups while returning whole chapters',()=>{
  const entries=new Map(directory.entries.map(entry=>[entry.id,entry]));
  expect(directory.chapters.filter(chapter=>matchesDirectoryChapter(chapter,entries,'French 1 B team')).map(chapter=>chapter.id)).toEqual(['one']);
  expect(directory.chapters.filter(chapter=>matchesDirectoryChapter(chapter,entries,'Chapter 2')).map(chapter=>chapter.id)).toEqual(['two']);
  expect(directory.entries).toHaveLength(3);
 });
 it('includes the current chapter beyond the first 200 rows and retains unreadable placeholders',()=>{
  const entries=Array.from({length:620},(_,index)=>release('entry-'+index,'en',index===250));
  const chapters=entries.map((entry,index)=>({id:'slot-'+index,title:'Chapter '+index,entryIds:[entry.id],selectedEntryId:entry.id,groupIds:[],current:entry.current,readable:index!==4}));
  const html=markup({...directory,entries,chapters,groups:[]});
  expect(html).toContain('data-reading-slot="slot-250"');expect(html).not.toContain('data-reading-slot="slot-500"');expect(html).toContain('data-entry-id="entry-4" disabled=""');
 });
 it('uses native language names and keeps unsupported language labels intact',()=>{
  expect(contentLanguageLabel('en')).toBe('English');expect(contentLanguageLabel('ja')).toContain('日本');expect(contentLanguageLabel('not_a_language')).toBe('not_a_language');
 });
});
