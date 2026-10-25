import {afterEach, expect, it, vi} from 'vitest';
import {recoverImageHeaders,withImageHeaders} from '../src/sources/runtime/image-headers';

afterEach(()=>vi.unstubAllGlobals());

it.each([false,true])('supports Firefox without runtime enums and cleans up after read failure=%s',async(fail)=>{
  const unrelated={id:42} as chrome.declarativeNetRequest.Rule;
  let rules=[unrelated];
  vi.stubGlobal('navigator',{locks:{request:async(_name:string,options:unknown,callback?:()=>unknown)=>
    (callback??options as ()=>unknown)()}});
  vi.stubGlobal('chrome',{
    runtime:{getURL:()=> 'moz-extension://test-extension/'},
    declarativeNetRequest:{
      getSessionRules:async()=>rules,
      updateSessionRules:async({addRules=[],removeRuleIds=[]}:Parameters<typeof chrome.declarativeNetRequest.updateSessionRules>[0])=>{
        rules=rules.filter(rule=>!removeRuleIds.includes(rule.id)).concat(addRules);
      },
    },
  });
  const failure=new Error('image response failed');
  const read=vi.fn(async()=>{
    expect(rules).toHaveLength(2);
    const rule=rules.find(value=>value.id!==42)!;
    expect(rule.action).toEqual({type:'modifyHeaders',requestHeaders:[
      {header:'Referer',value:'https://example.com/chapter/1',operation:'set'},
    ]});
    expect(rule.condition).toEqual({initiatorDomains:['test-extension'],
      regexFilter:'^https://images\\.example\\.com/page\\.jpg\\?n=1$',isUrlFilterCaseSensitive:true,
      resourceTypes:['xmlhttprequest']});
    if(fail)throw failure;
    return 'image bytes';
  });
  const result=withImageHeaders('https://images.example.com/page.jpg?n=1#page',
    {Referer:'https://example.com/chapter/1'},undefined,read);
  if(fail)await expect(result).rejects.toBe(failure);
  else await expect(result).resolves.toBe('image bytes');
  expect(read).toHaveBeenCalledOnce();
  expect(rules).toEqual([unrelated]);
});

it('bounds Safari lock names for long URLs and uses the same lock during recovery',async()=>{
  const names:string[]=[];
  let rules:chrome.declarativeNetRequest.Rule[]=[];
  let live:string|undefined;
  vi.stubGlobal('navigator',{locks:{request:async(name:string,options:any,callback?:any)=>{
    expect(name.length).toBeLessThanOrEqual(1024);names.push(name);
    if(!callback)return options();
    if(options.ifAvailable)return callback(name===live?null:{});
    live=name;try{return await callback({});}finally{live=undefined;}
  }}});
  vi.stubGlobal('chrome',{runtime:{getURL:()=> 'safari-web-extension://fixture/'},declarativeNetRequest:{
    getSessionRules:async()=>rules,
    updateSessionRules:async({addRules=[],removeRuleIds=[]}:any)=>{rules=rules.filter(r=>!removeRuleIds.includes(r.id)).concat(addRules);},
  }});
  await withImageHeaders('https://cdn.test/image?ids='+('123456,'.repeat(1000)),{referer:'https://site.test/'},undefined,async()=>{
    expect(rules).toHaveLength(1);
    await recoverImageHeaders();
    expect(rules).toHaveLength(1); // recovery cannot remove the active reader's rule
  });
  expect(rules).toHaveLength(0);
  const imageNames=names.filter(n=>n.startsWith('nc-source-image:'));
  expect(imageNames).toHaveLength(2);expect(imageNames[0]).toBe(imageNames[1]);
});
