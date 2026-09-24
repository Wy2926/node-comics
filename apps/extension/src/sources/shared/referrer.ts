const policies:readonly string[]=['no-referrer','no-referrer-when-downgrade','origin','origin-when-cross-origin','same-origin','strict-origin','strict-origin-when-cross-origin','unsafe-url'];
export const isImageReferrerPolicy=(value:unknown):value is ReferrerPolicy=>typeof value==='string'&&policies.includes(value);

/** Explicit DOM policy; the conservative browser default is used when none is available. */
export function pageImageReferrerPolicy(element:Element):ReferrerPolicy {
  const explicit=element.getAttribute('referrerpolicy')?.toLowerCase();
  if(isImageReferrerPolicy(explicit))return explicit;
  const metas=element.ownerDocument.querySelectorAll<HTMLMetaElement>('meta[name="referrer" i]');
  for(const meta of [...metas].reverse()){
    const value=meta.content.toLowerCase();if(isImageReferrerPolicy(value))return value;
  }
  return 'strict-origin-when-cross-origin';
}

export function imageReferer(pageUrl:string,imageUrl:string,policy:ReferrerPolicy='strict-origin-when-cross-origin'):string|undefined {
  const page=new URL(pageUrl),image=new URL(imageUrl);
  if(!['http:','https:'].includes(page.protocol)||page.username||page.password)return;
  page.hash='';
  const same=page.origin===image.origin,downgrade=page.protocol==='https:'&&image.protocol!=='https:';
  switch(policy){
    case 'no-referrer':return;
    case 'same-origin':return same?page.href:undefined;
    case 'origin':return page.origin+'/';
    case 'strict-origin':return downgrade?undefined:page.origin+'/';
    case 'origin-when-cross-origin':return same?page.href:page.origin+'/';
    case 'unsafe-url':return page.href;
    case 'no-referrer-when-downgrade':return downgrade?undefined:page.href;
    default:return downgrade?undefined:same?page.href:page.origin+'/';
  }
}
