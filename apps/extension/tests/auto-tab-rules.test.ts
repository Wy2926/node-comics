import {describe,expect,it} from 'vitest';
import {automaticTabUrl,directoryPath,matchAutomaticTab,normalizeAutoTranslateSites,siteFromInput,tabDirectories,type AutoTranslateSite} from '../src/inline/auto-tab-rules';
const domain:AutoTranslateSite={hostname:'comics.example.com',enabled:true,scope:'domain',value:''};
const matches=(url:string,site=domain)=>matchAutomaticTab(site,new URL(url));
describe('automatic translation tab URL rules',()=>{
  it('matches exact hostnames across http/https, not subdomains, suffixes or URLs containing the host',()=>{
    expect(matches('https://comics.example.com/chapter')).toBe(true);
    expect(matches('http://comics.example.com:8080/')).toBe(true);
    for(const url of ['https://www.comics.example.com/','https://comics.example.com.other.test/','https://other.test/?next=https://comics.example.com'])expect(matches(url)).toBe(false);
    expect(matches('https://comics.example.com/',{...domain,enabled:false})).toBe(false);
  });
  it('uses directory segment boundaries and ignores search/hash',()=>{
    const site={...domain,scope:'directory' as const,value:'/manga/book/'};
    for(const path of ['/manga/book','/manga/book/','/manga/book/12?page=2#p3'])expect(matches('https://comics.example.com'+path,site)).toBe(true);
    for(const path of ['/manga/book-extra/12','/manga/books','/other?path=/manga/book/12'])expect(matches('https://comics.example.com'+path,site)).toBe(false);
  });
  it('checks the hostname before delegating a regular expression',()=>{
    const site={...domain,scope:'regex' as const,value:'.*'};
    expect(matches('https://comics.example.com/reader?id=12',site)).toBeUndefined();
    expect(matches('https://cdn.example.com/reader?id=12',site)).toBe(false);
  });
  it('normalizes saved rules, rejects wildcard hosts and deduplicates by hostname',()=>{
    expect(normalizeAutoTranslateSites(undefined)).toEqual([]);
    expect(normalizeAutoTranslateSites([{...domain,hostname:'*.example.com'}])).toEqual([]);
    expect(normalizeAutoTranslateSites([domain,{...domain,scope:'directory',value:'/manga/'}])).toEqual([{...domain,scope:'directory',value:'/manga'}]);
    expect(normalizeAutoTranslateSites([{...domain,scope:'regex',value:''},{...domain,hostname:'comics.example.com/path'}])).toEqual([]);
  });
  it('normalizes inputs and derives parent directories without guessing the last path component',()=>{
    expect(siteFromInput(' COMICS.example.com/manga/book/12 ')?.hostname).toBe('comics.example.com');
    expect(tabDirectories(new URL('https://comics.example.com/manga/book/12'))).toEqual(['/manga/book','/manga']);
    expect(tabDirectories(new URL('https://comics.example.com/manga/book/'))).toEqual(['/manga/book','/manga']);
    expect(directoryPath('/漫画/')).toBe('/%E6%BC%AB%E7%94%BB');
    for(const path of ['manga','//other.test/path','/manga?token=x','/manga#page','/manga\\page'])expect(directoryPath(path)).toBeUndefined();
    for(const url of ['chrome://settings','file:///tmp/test','https://user:secret@comics.example.com/'])expect(automaticTabUrl(url)).toBeUndefined();
  });
});
