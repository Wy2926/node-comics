/** Explicit isolated fixture operations. Each page uses one durable operation key. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';

export async function submitImages({api,token,images,mode='redraw',language='zh-Hans',key=randomUUID()}) {
  const descriptors=images.map((image,index)=>({client_item_id:String(index),name:image.name??`${index}.png`,
    image_sha256:createHash('sha256').update(image.bytes).digest('hex'),byte_size:image.bytes.length,
    content_type:image.mime??'image/png',...(image.fileHash?{file_hash:image.fileHash,page_index:image.pageIndex}:{}),
    ...(image.assetId?{asset_id:image.assetId}:{})}));
  const items=[];
  for(const [index,image] of descriptors.entries()) {
    const response=await fetch(api+'/v1/translation-plans',{method:'POST',headers:{Authorization:`Bearer ${token}`,
      'Content-Type':'application/json'},body:JSON.stringify({trigger:'manual',items:[{
        page_key:String(index),operation_key:`${key}:${index}`,mode,target_language:language,max_quota_pages:1,image}]})});
    assert(response.ok,`Plan: ${response.status} ${await response.clone().text()}`);
    const item=(await response.json()).items[0];
    assert(['accepted','pending','ready'].includes(item.disposition),`Operation rejected: ${item.code??item.disposition}`);
    items.push(item);
    if(item.job.status!=='awaiting_upload')continue;
    assert(item.upload,'Awaiting original requires an upload receipt');
    const target=new URL(item.upload.url,api),headers={...item.upload.headers};
    if(item.upload.authorization_required){
      assert.equal(target.origin,new URL(api).origin,'Authenticated uploads must stay on the API origin');
      headers.Authorization=`Bearer ${token}`;
    }
    const uploaded=await fetch(target,{method:'PUT',headers,body:images[index].bytes,credentials:'omit',redirect:'error'});
    assert(uploaded.ok,`Upload: ${uploaded.status} ${await uploaded.clone().text()}`);
    const completed=await fetch(`${api}/v1/uploads/${encodeURIComponent(item.upload.id)}/complete`,{
      method:'POST',headers:{Authorization:`Bearer ${token}`}});
    assert(completed.ok,`Complete upload: ${completed.status} ${await completed.clone().text()}`);
    item.job=await completed.json();
  }
  return {items};
}
