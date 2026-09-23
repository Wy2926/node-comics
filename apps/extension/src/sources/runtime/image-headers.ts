const firstId=800000,lastId=900000;
const own=(rule:chrome.declarativeNetRequest.Rule)=>rule.id>=firstId&&rule.id<lastId;
const pattern=(url:string)=>'^'+url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$';
const lockName=(expression:string)=>'nc-source-image:'+expression;
const mutate=<T>(run:()=>Promise<T>)=>navigator.locks.request('nc-source-image-rules',run);

async function remove(expression:string) {
  await mutate(async()=>{
    const ids=(await chrome.declarativeNetRequest.getSessionRules()).filter(rule=>own(rule)&&rule.condition.regexFilter===expression).map(rule=>rule.id);
    if(ids.length)await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:ids});
  });
}

/** Exact-resource rules live only while consuming the response. All extension image reads
 * share this lock, including reads without custom headers and from another extension page. */
export async function withImageHeaders<T>(url:string,headers:Readonly<Record<string,string>>|undefined,signal:AbortSignal|undefined,read:()=>Promise<T>):Promise<T> {
  const custom=!!headers&&Object.keys(headers).length>0;
  if(!/^https?:/.test(url)||typeof chrome==='undefined'||!chrome.declarativeNetRequest?.updateSessionRules){
    if(custom)throw Error('此环境不支持来源图片请求规则。');
    return read();
  }
  const normalized=new URL(url);normalized.hash='';
  const expression=pattern(normalized.href);
  return navigator.locks.request(lockName(expression),{signal},async()=>{
    signal?.throwIfAborted();
    await remove(expression);
    try {
      if(custom)await mutate(async()=>{
        const rules=(await chrome.declarativeNetRequest.getSessionRules()).filter(own);
        const used=new Set(rules.map(rule=>rule.id));let id=firstId;while(used.has(id)&&id<lastId)id++;
        if(id===lastId)throw Error('来源图片请求规则超过限制。');
        await chrome.declarativeNetRequest.updateSessionRules({addRules:[{
          id,priority:1,action:{type:chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders:Object.entries(headers!).map(([header,value])=>({header,value,operation:chrome.declarativeNetRequest.HeaderOperation.SET}))},
          condition:{initiatorDomains:[new URL(chrome.runtime.getURL('')).hostname],regexFilter:expression,isUrlFilterCaseSensitive:true,
            resourceTypes:[chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST]},
        }]});
      });
      signal?.throwIfAborted();
      return await read();
    } finally {await remove(expression);}
  });
}

/** Remove abandoned rules after a worker restart, leaving a live reader's lock alone. */
export async function recoverImageHeaders() {
  if(!chrome.declarativeNetRequest?.getSessionRules)return;
  for(const rule of (await chrome.declarativeNetRequest.getSessionRules()).filter(own)) {
    const expression=rule.condition.regexFilter;
    if(!expression)continue;
    await navigator.locks.request(lockName(expression),{ifAvailable:true},async lock=>{if(lock)await remove(expression);});
  }
}
