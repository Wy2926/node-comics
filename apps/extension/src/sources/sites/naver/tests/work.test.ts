import {describe,expect,it} from 'vitest';
import {createPage} from '../page';
import {definition} from '../definition';
const url='https://comic.naver.com/webtoon/list?titleId=123';
function work(target=url, include=true){
 const nodes:Record<string,unknown>={'link[rel="canonical"]':{href:'https://m.comic.naver.com/webtoon/list?titleId=123'},'meta[property="og:title"]':{content:'作品名'}};
 const document={title:'Chapter 99 - Browser title',querySelector:(selector:string)=>include?nodes[selector]??null:null} as unknown as Document;
 return createPage({document,location:definition.identify(new URL(target))!,signal:new AbortController().signal}).describeWork!();
}
describe('search work metadata',()=>{
 it('uses verified work metadata instead of document.title',()=>expect(work()).toMatchObject({status:'ready',value:{title:'作品名',catalogUrl:url}}));
 it('leaves unknown titles editable',()=>expect(work(url,false).status).toBe('not-ready'));
 it('never promotes a chapter title to a work title',()=>expect(work('https://comic.naver.com/webtoon/detail?titleId=123&no=1').status).toBe('not-ready'));
 it('rejects metadata from another work after navigation',()=>expect(work('https://comic.naver.com/webtoon/list?titleId=456').status).toBe('not-ready'));
});
