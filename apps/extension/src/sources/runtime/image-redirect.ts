/** Fetch manual redirects conceal Location. Observe only this extension's exact request
 * while it runs; the caller checks permission before following the captured destination. */
export function observeImageRedirect(url:string){
  let location:string|undefined;
  const event=typeof chrome!=='undefined'?chrome.webRequest?.onHeadersReceived:undefined;
  if(!event)return {location:()=>location,dispose:()=>{}};
  const extensionOrigin=chrome.runtime.getURL('').replace(/\/$/,'');
  const listener=(details:chrome.webRequest.OnHeadersReceivedDetails):undefined=>{
    const origin=details.initiator??(details as typeof details&{originUrl?:string}).originUrl;
    if(details.url!==url||!origin)return;
    try{const source=new URL(origin);if(source.protocol+'//'+source.host!==extensionOrigin)return;}catch{return;}
    if(![301,302,303,307,308].includes(details.statusCode))return;
    location=details.responseHeaders?.find(header=>header.name.toLowerCase()==='location')?.value;
  };
  event.addListener(listener,{urls:[new URL(url).origin+'/*'],types:['xmlhttprequest']},['responseHeaders']);
  return {location:()=>location,dispose:()=>event.removeListener(listener)};
}
