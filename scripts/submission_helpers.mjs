/** Submit isolated acceptance images through the same durable protocol as the reader. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';

export async function submitImages({api,token,images,mode='redraw',language='zh-Hans',key=randomUUID()}) {
  const items=images.map((image,index)=>({client_item_id:String(index),name:image.name??`${index}.png`,
    image_sha256:createHash('sha256').update(image.bytes).digest('hex'),byte_size:image.bytes.length,
    content_type:image.mime??'image/png',...(image.fileHash?{file_hash:image.fileHash,page_index:image.pageIndex}:{}),
    ...(image.assetId?{asset_id:image.assetId}:{})}));
  const response=await fetch(api+'/v1/translation-submissions',{method:'POST',headers:{Authorization:`Bearer ${token}`,
    'Content-Type':'application/json','Idempotency-Key':key},
    body:JSON.stringify({mode,target_language:language,max_quota_pages:items.length,items})});
  assert(response.ok,`Submission: ${response.status} ${await response.clone().text()}`);
  const receipt=await response.json();
  for(const item of receipt.items) {
    if(item.job.status!=='awaiting_upload')continue;
    assert(item.upload,'Awaiting original requires an upload receipt');
    const target=new URL(item.upload.url,api),headers={...item.upload.headers};
    if(item.upload.authorization_required){
      assert.equal(target.origin,new URL(api).origin,'Authenticated uploads must stay on the API origin');
      headers.Authorization=`Bearer ${token}`;
    }
    const uploaded=await fetch(target,{method:'PUT',headers,body:images[Number(item.client_item_id)].bytes,credentials:'omit',redirect:'error'});
    assert(uploaded.ok,`Upload: ${uploaded.status} ${await uploaded.clone().text()}`);
    const completed=await fetch(`${api}/v1/uploads/${encodeURIComponent(item.upload.id)}/complete`,{
      method:'POST',headers:{Authorization:`Bearer ${token}`}});
    assert(completed.ok,`Complete upload: ${completed.status} ${await completed.clone().text()}`);
    item.job=await completed.json();
  }
  return receipt;
}
